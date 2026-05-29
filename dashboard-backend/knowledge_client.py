"""Client for the ``vocence/knowledge-ingestion`` pod.

The dashboard-backend talks to the knowledge-ingestion service in two
places:

  • **Setup time** (agent settings UI): upload PDF/URL/sitemap/text,
    list sources, delete a source. We proxy the dashboard user's
    request through this client to the pod.

  • **Per-turn voice runtime** (voicechat_service.py): ``query`` the
    pod for top-K relevant chunks given the user's transcript, inject
    them into the LLM system prompt.

Pod dispatch:
  We use the ops dispatcher to pick a healthy ``knowledge_ingestion``
  pod for each call. There's typically only one pod (it owns the
  persistent volume) but the dispatcher pattern keeps the code
  consistent with how we talk to every other service.

Failures are non-fatal at the call site:
  • Setup operations bubble exceptions up so the UI shows them.
  • Runtime ``query`` swallows errors and returns an empty list so a
    knowledge-pod outage gracefully degrades to "agent answers without
    retrieved knowledge" rather than failing the entire voice turn.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import aiohttp


_log = logging.getLogger(__name__)


# How long to wait on the pod before bailing. Setup calls (ingest,
# list) can be slow; the runtime ``query`` call MUST be quick or we
# silently delay every voice turn.
_SETUP_TIMEOUT_SEC = float(os.environ.get("KN_CLIENT_SETUP_TIMEOUT_SEC") or "60")
_QUERY_TIMEOUT_SEC = float(os.environ.get("KN_CLIENT_QUERY_TIMEOUT_SEC") or "1.5")


def is_configured() -> bool:
    """True when at least one knowledge_ingestion pod is online.

    The per-pod API key (set on the Ops admin form at deploy time —
    auto-generated if left blank) is read from the encrypted ops
    registry at call time, so no dashboard-side env var is required
    to enable the integration. Deployments without a pod registered
    simply skip retrieval at runtime."""
    try:
        from ops import pool as ops_pool
        snap = ops_pool.snapshot()
    except Exception:  # noqa: BLE001
        return False
    svc = snap.get("knowledge_ingestion") or {}
    return any(p.get("status") == "online" for p in svc.get("pods", []))


async def _pick_pod() -> tuple[str, str] | None:
    """Resolve a healthy knowledge_ingestion pod.

    Returns ``(base_url, api_key)`` from the per-pod encrypted ops
    registry entry, or ``None`` if nothing is online — callers must
    handle that explicitly. First-fit selection is fine here since
    knowledge calls are infrequent compared to TTS/STT."""
    # Late import — ops.pool is loaded at app start and we don't want
    # a circular import at module load time.
    from ops import pool as ops_pool
    try:
        snap = ops_pool.snapshot()
    except Exception:  # noqa: BLE001
        return None
    svc = snap.get("knowledge_ingestion")
    if not svc:
        return None
    for p in svc.get("pods", []):
        if p.get("status") == "online":
            key = p.get("api_key") or ""
            return f"http://{p['host']}:{p['port']}", key
    return None


# ---------------------------------------------------------------------------
# Setup-time operations
# ---------------------------------------------------------------------------

async def ingest_text(
    agent_id: str, *, content: str, title: str | None = None,
) -> dict[str, Any]:
    """Ingest a plain-text knowledge source. Returns the pod's response
    JSON unchanged. Raises if the pod is unreachable or returns 4xx/5xx
    so the calling endpoint can surface a clear error to the operator."""
    return await _post_json("/v1/ingest/text", {
        "source_type": "text",
        "agent_id": agent_id,
        "title": title,
        "content": content,
    })


async def ingest_markdown(
    agent_id: str, *, content: str, title: str | None = None,
) -> dict[str, Any]:
    return await _post_json("/v1/ingest/markdown", {
        "source_type": "markdown",
        "agent_id": agent_id,
        "title": title,
        "content": content,
    })


async def ingest_url(
    agent_id: str, *, url: str, title: str | None = None, max_depth: int = 0,
) -> dict[str, Any]:
    return await _post_json("/v1/ingest/url", {
        "source_type": "url",
        "agent_id": agent_id,
        "title": title,
        "url": url,
        "max_depth": max_depth,
    })


async def ingest_sitemap(
    agent_id: str, *, url: str, title: str | None = None,
    include: list[str] | None = None, exclude: list[str] | None = None,
    max_pages: int = 500,
) -> dict[str, Any]:
    return await _post_json("/v1/ingest/sitemap", {
        "source_type": "sitemap",
        "agent_id": agent_id,
        "title": title,
        "url": url,
        "include": include,
        "exclude": exclude,
        "max_pages": max_pages,
    })


async def ingest_pdf(
    agent_id: str, *, file_bytes: bytes, filename: str,
    title: str | None = None,
) -> dict[str, Any]:
    """PDF goes through multipart. We use ``aiohttp.FormData`` rather
    than hand-rolling the boundary so binary content is encoded safely."""
    picked = await _pick_pod()
    if picked is None:
        raise RuntimeError("no knowledge_ingestion pod available")
    base_url, api_key = picked
    form = aiohttp.FormData()
    form.add_field("source_type", "pdf")
    form.add_field("agent_id", agent_id)
    if title:
        form.add_field("title", title)
    form.add_field("file", file_bytes, filename=filename, content_type="application/pdf")
    timeout = aiohttp.ClientTimeout(total=_SETUP_TIMEOUT_SEC)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(
            f"{base_url}/v1/ingest",
            data=form,
            headers={"X-API-Key": api_key},
        ) as resp:
            return await _parse_or_raise(resp)


async def get_job(job_id: str) -> dict[str, Any]:
    return await _get_json(f"/v1/jobs/{job_id}")


async def list_sources(agent_id: str) -> dict[str, Any]:
    return await _get_json(f"/v1/agents/{agent_id}/sources")


async def delete_source(agent_id: str, source_id: str) -> dict[str, Any]:
    return await _delete_json(f"/v1/sources/{source_id}", params={"agent_id": agent_id})


# ---------------------------------------------------------------------------
# Per-turn runtime query — the hot path
# ---------------------------------------------------------------------------

async def query(
    agent_id: str, *, text: str, top_k: int = 6, min_score: float = 0.55,
) -> list[dict[str, Any]]:
    """Top-K retrieval for one voice-agent turn.

    NEVER raises. On any failure (no pod registered, pod unreachable,
    HTTP error, timeout, JSON parse fail) returns ``[]`` and logs at
    WARN. The voice turn proceeds without retrieved knowledge — much
    better than dropping the turn because the knowledge pod is down.
    """
    picked = await _pick_pod()
    if picked is None:
        return []
    base_url, api_key = picked
    timeout = aiohttp.ClientTimeout(total=_QUERY_TIMEOUT_SEC)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(
                f"{base_url}/v1/query",
                json={
                    "agent_id": agent_id,
                    "text": text,
                    "top_k": top_k,
                    "min_score": min_score,
                },
                headers={"X-API-Key": api_key},
            ) as resp:
                if resp.status != 200:
                    _log.warning(
                        "knowledge query: pod returned %d for agent=%s",
                        resp.status, agent_id,
                    )
                    return []
                body = await resp.json()
                return body.get("chunks") or []
    except Exception as exc:  # noqa: BLE001
        _log.warning("knowledge query failed for agent=%s: %s", agent_id, exc)
        return []


# ---------------------------------------------------------------------------
# Plumbing
# ---------------------------------------------------------------------------

async def _post_json(path: str, body: dict[str, Any]) -> dict[str, Any]:
    picked = await _pick_pod()
    if picked is None:
        raise RuntimeError("no knowledge_ingestion pod available")
    base_url, api_key = picked
    timeout = aiohttp.ClientTimeout(total=_SETUP_TIMEOUT_SEC)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(
            f"{base_url}{path}", json=body,
            headers={"X-API-Key": api_key, "Content-Type": "application/json"},
        ) as resp:
            return await _parse_or_raise(resp)


async def _get_json(path: str) -> dict[str, Any]:
    picked = await _pick_pod()
    if picked is None:
        raise RuntimeError("no knowledge_ingestion pod available")
    base_url, api_key = picked
    timeout = aiohttp.ClientTimeout(total=_SETUP_TIMEOUT_SEC)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(
            f"{base_url}{path}",
            headers={"X-API-Key": api_key},
        ) as resp:
            return await _parse_or_raise(resp)


async def _delete_json(path: str, *, params: dict[str, str]) -> dict[str, Any]:
    picked = await _pick_pod()
    if picked is None:
        raise RuntimeError("no knowledge_ingestion pod available")
    base_url, api_key = picked
    timeout = aiohttp.ClientTimeout(total=_SETUP_TIMEOUT_SEC)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.delete(
            f"{base_url}{path}", params=params,
            headers={"X-API-Key": api_key},
        ) as resp:
            return await _parse_or_raise(resp)


async def _parse_or_raise(resp: aiohttp.ClientResponse) -> dict[str, Any]:
    if resp.status >= 400:
        # Surface the pod's error body if it's JSON; otherwise fall
        # back to the status code so we don't try to JSON-parse a 502
        # HTML page from a reverse proxy.
        try:
            body = await resp.json()
        except Exception:  # noqa: BLE001
            text = (await resp.text())[:400]
            raise RuntimeError(f"knowledge pod returned {resp.status}: {text}")
        raise RuntimeError(f"knowledge pod returned {resp.status}: {body!r}")
    return await resp.json()
