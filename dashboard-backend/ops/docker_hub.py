"""Docker Hub image-digest lookup.

Used by the update-detector poller: every few minutes we ask Docker Hub
for the current digest of each ``image:tag`` we have pods running. If
the upstream digest differs from the digest we recorded at deploy time,
the admin UI shows a "New image available" badge with a "Roll out
update" button.

Docker Hub's v2 API for public repos doesn't require auth:

    GET https://hub.docker.com/v2/repositories/{namespace}/{repo}/tags/{tag}
        -> {
            "name": "latest",
            "images": [
                {"digest": "sha256:...", "architecture": "amd64", ...},
                ...
            ],
            "last_updated": "2026-...",
            ...
        }

We cache results in-process for DIGEST_CACHE_TTL_S seconds to avoid
hitting Docker Hub on every dispatch (the rate limit is generous for
authenticated callers but stingy for anonymous, so caching matters).
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass

import aiohttp

_log = logging.getLogger(__name__)


DIGEST_CACHE_TTL_S = int(os.environ.get("OPS_DIGEST_CACHE_TTL_S") or "60")
DOCKER_HUB_API = "https://hub.docker.com/v2/repositories"
REQUEST_TIMEOUT_S = 8.0


@dataclass
class DigestInfo:
    digest: str
    last_updated: str  # ISO timestamp from Docker Hub
    architecture: str = "amd64"


_CACHE: dict[str, tuple[float, DigestInfo | None]] = {}
_LOCK = asyncio.Lock()


def _parse_image(image: str) -> tuple[str, str, str]:
    """Parse a Docker image reference into (namespace, repo, tag).

    Accepts:
        namespace/repo[:tag]
        docker.io/namespace/repo[:tag]
        registry-1.docker.io/namespace/repo[:tag]

    Library images (no namespace, e.g. ``nginx``) get the ``library`` namespace.
    Tag defaults to ``latest`` if missing. Anything pointing at a non-Docker-Hub
    registry raises — this module only knows Docker Hub.
    """
    ref = image.strip()
    # Strip explicit Docker Hub registry hostname.
    for prefix in ("docker.io/", "index.docker.io/", "registry-1.docker.io/"):
        if ref.startswith(prefix):
            ref = ref[len(prefix):]
            break
    # Reject anything that still looks like a non-Docker-Hub registry.
    # Heuristic: if the part before the first "/" contains a "." or ":",
    # it's a registry hostname (ghcr.io, registry.gitlab.com, etc.).
    if "/" in ref:
        first = ref.split("/", 1)[0]
        if "." in first or ":" in first:
            raise ValueError(
                f"image {image!r} is not on Docker Hub — only docker.io is supported"
            )

    # Split tag.
    if ":" in ref.rsplit("/", 1)[-1]:
        path, tag = ref.rsplit(":", 1)
    else:
        path, tag = ref, "latest"

    if "/" in path:
        namespace, repo = path.split("/", 1)
    else:
        # Bare image name — Docker Hub treats this as the "library" namespace.
        namespace, repo = "library", path

    return namespace, repo, tag


async def fetch_latest_digest(image: str) -> DigestInfo | None:
    """Return the current Docker Hub digest for ``image:tag``, or None if
    the repo / tag doesn't exist (or transient error). Results are cached
    in-process for DIGEST_CACHE_TTL_S seconds."""
    try:
        namespace, repo, tag = _parse_image(image)
    except ValueError as e:
        _log.debug("docker_hub: %s", e)
        return None

    cache_key = f"{namespace}/{repo}:{tag}"
    now = time.time()
    async with _LOCK:
        cached = _CACHE.get(cache_key)
        if cached and (now - cached[0]) < DIGEST_CACHE_TTL_S:
            return cached[1]

    url = f"{DOCKER_HUB_API}/{namespace}/{repo}/tags/{tag}"
    info: DigestInfo | None = None
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_S)) as session:
            async with session.get(url) as resp:
                if resp.status == 404:
                    _log.debug("docker_hub: %s not found (404)", cache_key)
                elif resp.status != 200:
                    _log.warning("docker_hub: %s returned %s", cache_key, resp.status)
                else:
                    data = await resp.json()
                    # Prefer amd64 manifest; fall back to first.
                    images = data.get("images") or []
                    amd64 = next((i for i in images if i.get("architecture") == "amd64"), None)
                    picked = amd64 or (images[0] if images else None)
                    if picked and picked.get("digest"):
                        info = DigestInfo(
                            digest=picked["digest"],
                            last_updated=str(data.get("last_updated") or ""),
                            architecture=str(picked.get("architecture") or "amd64"),
                        )
    except aiohttp.ClientError as e:
        _log.warning("docker_hub: %s request failed: %s", cache_key, e)
    except asyncio.TimeoutError:
        _log.warning("docker_hub: %s request timed out", cache_key)

    async with _LOCK:
        _CACHE[cache_key] = (now, info)
    return info


def invalidate_cache(image: str | None = None) -> None:
    """Drop cached digest(s). Pass ``image=None`` to wipe everything (used
    when the admin clicks 'Recheck for updates' to force a fresh fetch)."""
    if image is None:
        _CACHE.clear()
        return
    try:
        namespace, repo, tag = _parse_image(image)
        _CACHE.pop(f"{namespace}/{repo}:{tag}", None)
    except ValueError:
        pass
