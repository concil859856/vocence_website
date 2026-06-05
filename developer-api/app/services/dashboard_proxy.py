"""
HTTP proxy helper for forwarding developer-api requests to the
dashboard-backend.

The agent / voice / TTS pipelines live inside dashboard-backend (they
need the LLM client, R2 client, Chutes integrations, etc.). Rather
than duplicating that code here, we forward JSON / multipart requests
to the same internal URL the website uses, with our service-to-service
trust headers so dashboard-backend's ``require_auth`` treats the
caller as the API key's owner.

Trust model
-----------
The dashboard-backend's auth gate accepts two headers in lieu of a JWT:

    X-Internal-Service-Token: <shared secret, same value as our INTERNAL_SERVICE_TOKEN>
    X-Internal-User-Id:       <user_id resolved from the API key>

These headers grant "act as this user" privileges, so:

  • They MUST never appear in a public request — the ingress strips
    them on the public path.
  • The shared secret must rotate together on both sides.
  • IP allowlist on dashboard-backend backs this up (loopback by default).

This helper is the only place developer-api should mint these headers.
"""

from __future__ import annotations

import logging
from typing import Any

import aiohttp
from fastapi import HTTPException

from app.core.config import (
    DASHBOARD_VOICECHAT_WS_URL,
    INTERNAL_SERVICE_TOKEN,
)


_log = logging.getLogger(__name__)


def _dashboard_base() -> str:
    """Derive the dashboard-backend HTTP base from the configured
    voicechat WS URL (they share the same origin)."""
    base = DASHBOARD_VOICECHAT_WS_URL
    # Strip the WS path/scheme to get just the origin.
    base = base.replace("ws://", "http://").replace("wss://", "https://")
    # Trim trailing "/api/dashboard/voicechat/session" if present.
    for suffix in ("/api/dashboard/voicechat/session", "/voicechat/session"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    return base.rstrip("/")


def _trust_headers(user_id: str) -> dict[str, str]:
    if not INTERNAL_SERVICE_TOKEN:
        raise HTTPException(
            status_code=503,
            detail="INTERNAL_SERVICE_TOKEN not configured on this deployment.",
        )
    return {
        "X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN,
        "X-Internal-User-Id": user_id,
    }


async def call_dashboard(
    method: str,
    path: str,
    *,
    user_id: str,
    json: Any | None = None,
    form: dict[str, str] | None = None,
    files: list[tuple[str, bytes, str, str]] | None = None,
    timeout_sec: float = 60.0,
) -> dict:
    """Make a JSON / form / multipart request to dashboard-backend.

    Returns the parsed JSON response body. Raises HTTPException with
    the upstream status code on any non-2xx so the developer-api
    caller sees the same status / detail the website would.

    ``files`` is a list of ``(field_name, bytes, filename, content_type)``
    tuples for multipart uploads (mirrors aiohttp.FormData.add_field).
    """
    url = _dashboard_base() + path
    headers = _trust_headers(user_id)
    timeout = aiohttp.ClientTimeout(total=timeout_sec)

    async with aiohttp.ClientSession(timeout=timeout) as session:
        if files:
            fd = aiohttp.FormData()
            for k, v in (form or {}).items():
                fd.add_field(k, v)
            for field, blob, fname, ctype in files:
                fd.add_field(field, blob, filename=fname, content_type=ctype)
            async with session.request(method, url, headers=headers, data=fd) as resp:
                return await _decode_response(resp)
        if form:
            fd = aiohttp.FormData()
            for k, v in form.items():
                fd.add_field(k, v)
            async with session.request(method, url, headers=headers, data=fd) as resp:
                return await _decode_response(resp)
        async with session.request(method, url, headers=headers, json=json) as resp:
            return await _decode_response(resp)


async def _decode_response(resp: aiohttp.ClientResponse) -> dict:
    body = await resp.text()
    try:
        data = await resp.json()
    except Exception:
        data = {"detail": body[:300] or "Upstream returned non-JSON response"}
    if resp.status >= 400:
        # Surface the upstream status + detail to the caller. Keeps the
        # error message useful (4xx tells the user what they did wrong)
        # while not leaking internal stack traces.
        detail = (
            data.get("detail") if isinstance(data, dict) else None
        ) or "Upstream request failed"
        _log.warning("dashboard proxy %s %s → %s: %s", resp.request_info.method, resp.url.path, resp.status, detail)
        raise HTTPException(status_code=resp.status, detail=str(detail))
    if not isinstance(data, dict):
        # Some endpoints return arrays — wrap so callers don't crash on
        # ``response["whatever"]``. They can pull from response["items"].
        return {"items": data}
    return data
