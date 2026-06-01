"""Standalone streaming WS endpoints — TTS (pre-registered voice) +
STT (live PCM in / transcripts out).

Both proxy bidirectionally to the dashboard-backend's
``/api/dashboard/streaming/tts/{voice_id}`` and
``/api/dashboard/streaming/stt`` WS routes using the internal-trust
header pair. Wire protocol on the public side is the same as the
dashboard's — see ``dashboard-backend/routers/streaming.py``.

Auth: ``Authorization: Bearer voc_live_…`` on the WS upgrade (same
as ``/v1/agents/{id}/session``).
"""

from __future__ import annotations

import asyncio
import logging
import re
import time

import aiohttp
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.api.routes.agents import (
    INNER_WS_MAX_MSG_SIZE,
    MAX_CONCURRENT_SESSIONS_PER_ACCOUNT,
    MAX_SESSION_OPENS_PER_MINUTE_PER_ACCOUNT,
    WS_CLOSE_AUTH,
    WS_CLOSE_CONFIG,
    WS_CLOSE_NOT_FOUND,
    WS_CLOSE_RATE_LIMIT,
    WS_CLOSE_UPSTREAM,
    _check_open_rate,
    _concurrent_sessions,
    _resolve_api_key_user,
)
from app.core.config import DASHBOARD_VOICECHAT_WS_URL, INTERNAL_SERVICE_TOKEN

_log = logging.getLogger(__name__)
router = APIRouter()


# `voice_id` in the URL is the integer primary key from
# studio_user_designed_voices / cloned voices. Reject anything that
# isn't a positive int at the boundary.
_VOICE_ID_RE = re.compile(r"^[1-9][0-9]{0,15}$")


def _dashboard_ws_base() -> str:
    """Strip the voicechat WS path off the configured ws URL so we can
    compose other dashboard WS paths off the same origin."""
    base = DASHBOARD_VOICECHAT_WS_URL
    for suffix in ("/api/dashboard/voicechat/session", "/voicechat/session"):
        if base.endswith(suffix):
            base = base[: -len(suffix)]
            break
    return base.rstrip("/")


async def _send_error_safe(ws: WebSocket, code: str, message: str) -> None:
    try:
        await ws.send_json({"type": "error", "code": code, "message": message})
    except Exception:
        pass


async def _proxy_ws(
    ws: WebSocket,
    inner_url: str,
    *,
    headers: dict[str, str],
) -> None:
    """Bidirectional frame relay between an accepted client WS and an
    inner aiohttp ws. Returns when either side closes."""
    session: aiohttp.ClientSession | None = None
    inner_ws: aiohttp.ClientWebSocketResponse | None = None
    try:
        session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None))
        try:
            inner_ws = await session.ws_connect(
                inner_url,
                headers=headers,
                heartbeat=20,
                max_msg_size=INNER_WS_MAX_MSG_SIZE,
            )
        except aiohttp.ClientError as exc:
            _log.warning("streaming: inner ws_connect failed: %s", exc)
            await _send_error_safe(
                ws, "upstream_unavailable",
                "Streaming pipeline is temporarily unreachable. Please retry.",
            )
            await ws.close(code=WS_CLOSE_UPSTREAM)
            return

        async def _c2s() -> None:
            try:
                while True:
                    msg = await ws.receive()
                    msg_type = msg.get("type")
                    if msg_type == "websocket.disconnect":
                        return
                    if msg_type != "websocket.receive":
                        continue
                    if "text" in msg and msg["text"] is not None:
                        await inner_ws.send_str(msg["text"])
                    elif "bytes" in msg and msg["bytes"] is not None:
                        await inner_ws.send_bytes(msg["bytes"])
            except (WebSocketDisconnect, RuntimeError):
                return

        async def _s2c() -> None:
            try:
                async for m in inner_ws:
                    if m.type == aiohttp.WSMsgType.TEXT:
                        await ws.send_text(m.data)
                    elif m.type == aiohttp.WSMsgType.BINARY:
                        await ws.send_bytes(m.data)
                    elif m.type in (
                        aiohttp.WSMsgType.CLOSE,
                        aiohttp.WSMsgType.CLOSED,
                        aiohttp.WSMsgType.ERROR,
                    ):
                        return
            except (WebSocketDisconnect, RuntimeError):
                return

        c2s = asyncio.create_task(_c2s())
        s2c = asyncio.create_task(_s2c())
        _, pending = await asyncio.wait(
            {c2s, s2c}, return_when=asyncio.FIRST_COMPLETED,
        )
        for t in pending:
            t.cancel()
            try:
                await t
            except Exception:
                pass
        # Propagate the inner close code to the public WS so SDK
        # callers see typed errors (4408 = max duration, 4410 = idle,
        # 4402 = insufficient credits, …).
        try:
            inner_code = (
                inner_ws.close_code if inner_ws is not None else None
            )
        except Exception:
            inner_code = None
        try:
            await ws.close(code=int(inner_code) if inner_code else 1000)
        except Exception:
            pass
    finally:
        try:
            if inner_ws is not None and not inner_ws.closed:
                await inner_ws.close()
        except Exception:
            pass
        try:
            if session is not None:
                await session.close()
        except Exception:
            pass


# --------------------------------------------------------------------- common


async def _auth_and_reserve(
    ws: WebSocket,
) -> tuple[dict, callable] | None:
    """Mirror the auth + rate-limit + concurrency reservation pattern
    from /v1/agents/{id}/session. Returns (auth_ctx, release_slot)
    on success; sends an error JSON + closes the WS and returns None
    on any failure path.

    Pulled into a helper so both streaming routes share it byte-for-byte
    — keeps the auth surface auditable in one place."""
    auth_header = ws.headers.get("authorization") or ws.headers.get("Authorization") or ""
    raw_key = ""
    if auth_header.lower().startswith("bearer "):
        raw_key = auth_header.split(" ", 1)[1].strip()

    auth_ctx = await _resolve_api_key_user(raw_key) if raw_key else None
    await ws.accept()

    if auth_ctx is None:
        await _send_error_safe(
            ws, "auth_required",
            "Missing or invalid API key. Send 'Authorization: Bearer voc_live_...'",
        )
        await ws.close(code=WS_CLOSE_AUTH)
        return None

    if not INTERNAL_SERVICE_TOKEN:
        _log.error("INTERNAL_SERVICE_TOKEN not configured — streaming cannot proxy")
        await _send_error_safe(
            ws, "service_misconfigured",
            "Streaming API is not configured on this deployment.",
        )
        await ws.close(code=WS_CLOSE_CONFIG)
        return None

    user_id = str(auth_ctx["user_id"])

    if not _check_open_rate(user_id):
        await _send_error_safe(
            ws, "rate_limited",
            f"Too many sessions opened. Limit: "
            f"{MAX_SESSION_OPENS_PER_MINUTE_PER_ACCOUNT}/min per account.",
        )
        await ws.close(code=WS_CLOSE_RATE_LIMIT)
        return None

    if _concurrent_sessions.get(user_id, 0) >= MAX_CONCURRENT_SESSIONS_PER_ACCOUNT:
        await _send_error_safe(
            ws, "concurrent_limit",
            f"Too many concurrent sessions. Limit: "
            f"{MAX_CONCURRENT_SESSIONS_PER_ACCOUNT} per account.",
        )
        await ws.close(code=WS_CLOSE_RATE_LIMIT)
        return None

    _concurrent_sessions[user_id] = _concurrent_sessions.get(user_id, 0) + 1
    slot_reserved = {"v": True}

    def _release_slot() -> None:
        if not slot_reserved["v"]:
            return
        slot_reserved["v"] = False
        current = _concurrent_sessions.get(user_id, 0)
        if current > 1:
            _concurrent_sessions[user_id] = current - 1
        else:
            _concurrent_sessions.pop(user_id, None)

    return auth_ctx, _release_slot


# --------------------------------------------------------------------- TTS


@router.websocket("/v1/voices/{voice_id}/stream")
async def voices_stream(ws: WebSocket, voice_id: str) -> None:
    """Streaming TTS WS using a pre-registered voice.

    Public protocol (the dev-api just forwards this transparently to
    the dashboard-backend):

      C → S  JSON   {"type":"speak","text":"…","language":"English"}
      S → C  JSON   {"type":"meta","sample_rate":24000,"encoding":"pcm_s16le",...}
      S → C  bytes  raw PCM16LE @ 24 kHz frames
      S → C  JSON   {"type":"end"}
      C → S  JSON   {"type":"stop"}     # close cleanly

    Multiple speak turns can run on one connection — the server emits
    a fresh meta + audio + end sequence for each. ``voice_id`` is the
    integer id from ``GET /v1/voices`` (designed or cloned voice).
    """
    # Fast-fail on a non-int voice_id BEFORE accepting — saves an
    # accept+error JSON roundtrip on the obvious garbage case.
    if not _VOICE_ID_RE.match(voice_id):
        await ws.accept()
        await _send_error_safe(ws, "bad_request", "Malformed voice_id.")
        await ws.close(code=WS_CLOSE_NOT_FOUND)
        return

    auth = await _auth_and_reserve(ws)
    if auth is None:
        return
    auth_ctx, release_slot = auth
    user_id = str(auth_ctx["user_id"])

    try:
        base = _dashboard_ws_base()
        inner_url = (
            f"{base}/api/dashboard/streaming/tts/{voice_id}?user_id={user_id}"
        )
        headers = {"X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN}
        await _proxy_ws(ws, inner_url, headers=headers)
    finally:
        release_slot()


# --------------------------------------------------------------------- STT


@router.websocket("/v1/stt/stream")
async def stt_stream(ws: WebSocket) -> None:
    """Streaming STT WS — push PCM16LE @ 16 kHz, receive partial +
    final transcript events.

      C → S  JSON   {"type":"start","language":"English","sample_rate":16000,
                    "encoding":"pcm_s16le","enable_partials":true}
      S → C  JSON   {"type":"ready"}
      C → S  bytes  PCM frames
      S → C  JSON   {"type":"transcript","text":"…","is_final":false|true}
      C → S  JSON   {"type":"stop"}
      S → C  JSON   {"type":"end"}
    """
    auth = await _auth_and_reserve(ws)
    if auth is None:
        return
    auth_ctx, release_slot = auth
    user_id = str(auth_ctx["user_id"])

    try:
        base = _dashboard_ws_base()
        inner_url = f"{base}/api/dashboard/streaming/stt?user_id={user_id}"
        headers = {"X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN}
        await _proxy_ws(ws, inner_url, headers=headers)
    finally:
        release_slot()
