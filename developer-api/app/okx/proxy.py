"""Fulfillment: run a tool by calling Vocence's own /v1 API with the system key.

Deliberately reuses the existing paid API rather than re-implementing any
generation logic. The OKX system account authenticates with a ``voc_live_``
key exactly like any developer, so the whole tested path — provider selection,
job queue, storage, response shape — is unchanged. The x402 payment gate on the
OKX route is the external revenue; the system account's credit metering is
internal accounting.

Most tool schemas match their /v1 request body 1:1 and forward verbatim. Video
dubbing is the exception: /v1/video/dub takes an uploaded object reference
(``src_bucket``/``src_key``), while a buyer agent only has a URL — so this
module bridges: download the source, presign an upload slot, PUT the bytes,
then submit the job. The job id it returns is polled on the free status route.
"""

from __future__ import annotations

import ipaddress
import logging
import re
import socket
import uuid
from urllib.parse import urlparse

import aiohttp

from . import config
from .tools import Tool

_log = logging.getLogger(__name__)

# Matches the dashboard's video-dub-source cap; downloads larger than this
# would be rejected at presign anyway, so stop pulling bytes early.
_MAX_VIDEO_BYTES = 200 * 1024 * 1024
_DOWNLOAD_TIMEOUT = 300  # big sources on slow hosts
_VIDEO_CONTENT_TYPES = {
    "video/mp4", "video/quicktime", "video/webm", "video/x-matroska", "video/x-msvideo",
}


class ToolExecutionError(RuntimeError):
    """A tool call could not be fulfilled. Carries an HTTP status for the route."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status
        self.message = message


async def execute_tool(tool: Tool, arguments: dict) -> dict:
    """Fulfill one validated tool call; return the /v1 JSON result."""
    if not config.OKX_SYSTEM_API_KEY:
        raise ToolExecutionError(503, "Tool fulfillment is not configured.")
    if tool.name == "vocence_video_dub":
        return await _fulfill_video_dub(arguments)
    return await _call_v1("POST", tool.v1_path, json=arguments)


async def fetch_dub_status(job_id: str) -> dict:
    """Poll a dubbing job on behalf of the buyer (free — no payment gate)."""
    if not config.OKX_SYSTEM_API_KEY:
        raise ToolExecutionError(503, "Tool fulfillment is not configured.")
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,64}", job_id):
        raise ToolExecutionError(400, "Invalid job id.")
    return await _call_v1("GET", f"/v1/video/dub/{job_id}")


# ---------------------------------------------------------------------------
# Video dubbing: URL → storage → job
# ---------------------------------------------------------------------------


async def _fulfill_video_dub(arguments: dict) -> dict:
    video_url = str(arguments.get("video_url") or "")
    if not video_url.lower().startswith(("https://", "http://")):
        raise ToolExecutionError(400, "video_url must be an HTTP(S) URL.")

    data, content_type = await _download_video(video_url)
    filename = _source_filename(video_url)

    presign = await _call_v1(
        "POST", "/v1/uploads/presign",
        json={
            "kind": "video-dub-source",
            "filename": filename,
            "content_type": content_type,
            "size": len(data),
        },
    )
    put_url = presign.get("put_url")
    bucket, key = presign.get("bucket"), presign.get("key")
    if not (put_url and bucket and key):
        raise ToolExecutionError(502, "Could not prepare storage for the source video.")

    await _upload_bytes(put_url, data, content_type)

    submit_body = {
        "src_bucket": bucket,
        "src_key": key,
        "src_filename": filename,
        "duration_sec": arguments["duration_sec"],
        "target_languages": arguments["target_languages"],
        "source_language": arguments.get("source_language") or "auto",
        "lipsync": bool(arguments.get("lipsync")),
        "consent_attested": bool(arguments.get("consent_attested")),
    }
    if arguments.get("callback_url"):
        submit_body["callback_url"] = str(arguments["callback_url"])
    submit = await _call_v1("POST", "/v1/video/dub", json=submit_body, timeout=180)
    job_id = submit.get("job_id")
    if job_id:
        # Free polling endpoint — dubbing runs async and can take minutes.
        submit["status_endpoint"] = f"/okx/tools/vocence_video_dub/jobs/{job_id}"
    return submit


def _assert_public_url(url: str) -> None:
    """SSRF guard: only fetch public HTTP(S) hosts on standard ports.

    The buyer controls ``video_url`` and this server sits next to internal
    services, so refuse anything that resolves to loopback / RFC1918 /
    link-local (cloud metadata) / other non-global address space. Applied to
    every redirect hop, since a public URL can redirect inward.
    """
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise ToolExecutionError(400, "video_url must be an HTTP(S) URL.")
    if parsed.port not in (None, 80, 443):
        raise ToolExecutionError(400, "video_url must use the standard HTTP(S) port.")
    host = parsed.hostname or ""
    if not host:
        raise ToolExecutionError(400, "video_url has no host.")
    try:
        infos = socket.getaddrinfo(host, parsed.port or 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise ToolExecutionError(400, "video_url host could not be resolved.") from exc
    for info in infos:
        addr = ipaddress.ip_address(info[4][0])
        if not addr.is_global:
            raise ToolExecutionError(400, "video_url must point at a public host.")


async def _download_video(url: str) -> tuple[bytes, str]:
    timeout = aiohttp.ClientTimeout(total=_DOWNLOAD_TIMEOUT)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            # Follow redirects by hand so every hop passes the SSRF guard.
            for _hop in range(4):
                _assert_public_url(url)
                async with session.get(url, allow_redirects=False) as resp:
                    if resp.status in {301, 302, 303, 307, 308}:
                        location = resp.headers.get("Location")
                        if not location:
                            raise ToolExecutionError(400, "video_url redirect had no target.")
                        url = str(resp.url.join(aiohttp.client.URL(location)))
                        continue
                    if resp.status >= 400:
                        raise ToolExecutionError(400, f"video_url returned HTTP {resp.status}.")
                    declared = resp.content_length
                    if declared and declared > _MAX_VIDEO_BYTES:
                        raise ToolExecutionError(413, "Source video exceeds the 200 MB limit.")
                    chunks: list[bytes] = []
                    total = 0
                    async for chunk in resp.content.iter_chunked(1 << 20):
                        total += len(chunk)
                        if total > _MAX_VIDEO_BYTES:
                            raise ToolExecutionError(413, "Source video exceeds the 200 MB limit.")
                        chunks.append(chunk)
                    if total == 0:
                        raise ToolExecutionError(400, "video_url returned an empty body.")
                    ct = (resp.content_type or "").lower()
                    content_type = ct if ct in _VIDEO_CONTENT_TYPES else "application/octet-stream"
                    return b"".join(chunks), content_type
            raise ToolExecutionError(400, "video_url redirected too many times.")
    except ToolExecutionError:
        raise
    except aiohttp.ClientError as exc:
        _log.warning("[okx] video download failed: %s", exc)
        raise ToolExecutionError(400, "Could not download video_url.") from exc


async def _upload_bytes(put_url: str, data: bytes, content_type: str) -> None:
    timeout = aiohttp.ClientTimeout(total=_DOWNLOAD_TIMEOUT)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.put(put_url, data=data, headers={"Content-Type": content_type}) as resp:
                if resp.status >= 400:
                    _log.warning("[okx] source upload -> %s", resp.status)
                    raise ToolExecutionError(502, "Could not store the source video.")
    except aiohttp.ClientError as exc:
        _log.error("[okx] source upload transport error: %s", exc)
        raise ToolExecutionError(502, "Could not store the source video.") from exc


def _source_filename(url: str) -> str:
    name = url.split("?", 1)[0].rsplit("/", 1)[-1][-80:]
    if not re.fullmatch(r"[\w .()-]+\.\w{1,8}", name or ""):
        name = f"source-{uuid.uuid4().hex[:8]}.mp4"
    return name


# ---------------------------------------------------------------------------
# /v1 transport
# ---------------------------------------------------------------------------


async def _call_v1(method: str, path: str, *, json: dict | None = None, timeout: int = 180) -> dict:
    """Call our own /v1 API with the system key; return its JSON.

    Raises ToolExecutionError with a user-safe message on any failure — never
    leaks the system key path or upstream internals.
    """
    url = config.OKX_SELF_API_BASE.rstrip("/") + path
    headers = {"Authorization": f"Bearer {config.OKX_SYSTEM_API_KEY}"}
    client_timeout = aiohttp.ClientTimeout(total=timeout)

    try:
        async with aiohttp.ClientSession(timeout=client_timeout) as session:
            async with session.request(method, url, headers=headers, json=json) as resp:
                body = await resp.text()
                if resp.status >= 400:
                    _log.warning("[okx] %s %s -> %s: %s", method, path, resp.status, body[:300])
                    detail = _safe_detail(body) or "The tool could not complete this request."
                    raise ToolExecutionError(resp.status if resp.status < 500 else 502, detail)
                return _as_json(body)
    except aiohttp.ClientError as exc:
        _log.error("[okx] transport error calling %s: %s", path, exc)
        raise ToolExecutionError(503, "The service is temporarily unavailable.") from exc


def _as_json(body: str) -> dict:
    import json

    try:
        data = json.loads(body)
    except ValueError:
        return {"result": body}
    return data if isinstance(data, dict) else {"result": data}


def _safe_detail(body: str) -> str:
    """Pull a user-safe message out of a /v1 error body, if present."""
    import json

    try:
        data = json.loads(body)
    except ValueError:
        return ""
    if isinstance(data, dict):
        d = data.get("detail")
        if isinstance(d, str):
            return d
    return ""
