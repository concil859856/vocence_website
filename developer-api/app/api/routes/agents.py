"""
Public voice-agent WebSocket API.

A developer with an API key opens a WebSocket to:

    wss://api.vocence.ai/v1/agents/{agent_id}/session
    Authorization: Bearer voc_live_...

This service authenticates the caller, verifies that the agent is
owned by the API key's user, and proxies the connection through to
the dashboard-backend's voice pipeline using an internal trust token.

Wire protocol on the public side is identical to the internal WS
the website uses — see ``dashboard-backend/routers/voicechat.py``
for the canonical message reference. In short:

  Client → server (JSON):
    {"type":"text", "text":"..."}            # text-only turn
    {"type":"voice", "audio_b64":"...", "mime":"audio/wav"}
                                              # one-shot WAV upload
    {"type":"stream_start"}                   # open a live PCM turn
    {"type":"stream_commit"}                  # finalise the live turn
    {"type":"cancel"}                         # barge-in / abort

  Client → server (BINARY) — only inside an open stream turn:
    raw PCM16LE @ 16 kHz mono, 20 ms or 32 ms frames

  Server → client (JSON or binary):
    {"type":"ready", "session_id":"...",
     "capabilities":{"voice_stream":true|false,
                     "turn_detection":true|false,
                     "frame":{"sample_rate":16000,
                              "encoding":"pcm_s16le",
                              "frame_ms":20}}}
    {"type":"transcript", "text":"...", "language":"en"}
    {"type":"partial_transcript", "text":"..."}  # only in stream turns
    {"type":"token", "text":"..."}            # LLM delta
    {"type":"audio_meta", "sentence_id":N, "sample_rate":24000, ...}
    <binary>                                  # PCM16LE 24kHz frames
    {"type":"audio_end", "sentence_id":N}
    {"type":"turn_end"}
    {"type":"tool_call_started", "name":"web_search", ...}
    {"type":"tool_call_completed", "name":"...", "result_preview":"..."}
    {"type":"error", "code":"...", "message":"..."}
    {"type":"session_timeout", "code":"idle_timeout"|"max_duration"}
    {"type":"billing_exhausted", ...}
    {"type":"cancelled"}                      # ack of {"type":"cancel"}

Streaming voice (stream_start / binary PCM / stream_commit) is only
available when the server advertises ``capabilities.voice_stream=true``
in the ``ready`` event — that flag is true iff a streaming-STT pod is
online on the deployment. Capable clients should fall back to the
one-shot ``voice`` upload when the flag is false.

The frame relay is bidirectional and concurrent — text/JSON and audio
frames flow in both directions without blocking each other.

Auth: standard developer-api API key in ``Authorization: Bearer voc_live_...``.
We cannot use ``Depends(require_api_key)`` cleanly on WebSocket endpoints,
so we extract the header manually, validate against ``api_keys`` table,
and reject with a clean ``4401`` close code on failure (mirrors the
dashboard-backend's behavior).
"""

from __future__ import annotations

import asyncio
import logging
import re
import time

import aiohttp
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.core.auth import hash_api_key
from app.core.config import DASHBOARD_VOICECHAT_WS_URL, INTERNAL_SERVICE_TOKEN
from app.db.connection import get_db


_log = logging.getLogger(__name__)
router = APIRouter()

# Close codes the spec reserves for application use (4000-4999). We
# match the dashboard-backend so a SDK can use them consistently.
WS_CLOSE_AUTH = 4401
WS_CLOSE_NOT_FOUND = 4404
WS_CLOSE_RATE_LIMIT = 4429
WS_CLOSE_CONFIG = 4503
WS_CLOSE_UPSTREAM = 4502

# Bounded resource controls per ACCOUNT (Nov 2026 — was per-key).
# A user spinning up multiple keys can no longer multiply their voice-
# pipeline footprint. In-memory (per process); fine for a single
# dev-api instance, but a Redis-backed counter is needed when scaling
# horizontally so the counts stay consistent across replicas.
MAX_CONCURRENT_SESSIONS_PER_ACCOUNT = 5
MAX_SESSION_OPENS_PER_MINUTE_PER_ACCOUNT = 10
_concurrent_sessions: dict[str, int] = {}  # user_id → active count
_session_opens: dict[str, list[float]] = {}  # user_id → recent open timestamps

# Bound the audio uplink to something reasonable. A 60s WAV at 24kHz/16-bit
# mono is ~3MB; base64-encoded, ~4MB. Anything beyond is almost certainly
# abuse, so we cap at 4MB. Note: this is the per-WS-message cap, not the
# whole session.
INNER_WS_MAX_MSG_SIZE = 4 * 1024 * 1024

# UUID-shaped agent_ids only (uuid4().hex form). The schema already enforces
# this on creation, but we sanity-check here so a malformed URL doesn't
# reach the DB lookup with weird characters in logs.
_AGENT_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{8,64}$")


async def _user_has_premium(user_id: str) -> bool:
    """True if the user has at least one successful Premium purchase.

    Voice agents are a Premium-only feature on the dev API. API key
    creation already requires Premium, but if Premium is ever revoked
    or expires the existing key keeps working — this re-check at
    connect time enforces the gate at the actual usage point."""
    conn = await get_db()
    try:
        row = await (
            await conn.execute(
                """
                SELECT COUNT(*) AS n
                FROM payments
                WHERE user_id = ?
                  AND status IN ('paid', 'completed')
                  AND credits_granted > 0
                  AND LOWER(COALESCE(plan_code, '')) = 'premium'
                """,
                (user_id,),
            )
        ).fetchone()
        return int(row["n"] or 0) > 0 if row else False
    finally:
        await conn.close()


async def _resolve_api_key_user(raw_key: str) -> dict | None:
    """Look up an API key in the SQLite ``api_keys`` table and return
    the owner row (``{id, user_id, tier, rate_limit_rpm}``) on success.

    Mirrors the verification logic in ``require_api_key`` but adapted
    for a WebSocket handler where we extract the header manually and
    don't raise HTTPException. Returns None on any failure so the
    caller can send a clean WS error frame."""
    if not raw_key or len(raw_key) < 16:
        return None
    prefix = raw_key[:16]
    conn = await get_db()
    try:
        row = await (
            await conn.execute("SELECT * FROM api_keys WHERE key_prefix = ?", (prefix,))
        ).fetchone()
        if row is None or row["revoked_at"]:
            return None
        import hmac

        if not hmac.compare_digest(hash_api_key(raw_key), row["key_hash"] or ""):
            return None
        return {
            "api_key_id": row["id"],
            "user_id": row["user_id"],
            "tier": row["tier"] or "normal",
            "rate_limit_rpm": int(row["rate_limit_rpm"]) if row["rate_limit_rpm"] is not None else None,
        }
    finally:
        await conn.close()


async def _agent_belongs_to_user(agent_id: str, user_id: str) -> bool:
    """Verify the requested agent is owned by the API-key holder.
    Public agents / shared agents are NOT supported in v1 — strict
    ownership only."""
    conn = await get_db()
    try:
        row = await (
            await conn.execute(
                "SELECT id FROM agents WHERE id = ? AND user_id = ?",
                (agent_id, user_id),
            )
        ).fetchone()
        return row is not None
    finally:
        await conn.close()


async def _relay_frames(
    direction: str,
    src_recv,
    dst_send_text,
    dst_send_bytes,
) -> None:
    """Pump JSON text frames and binary frames from src to dst until
    the source closes. ``direction`` is used only for log lines so we
    can tell client→server vs server→client streams apart."""
    try:
        while True:
            msg = await src_recv()
            if msg is None:
                return
            if isinstance(msg, (bytes, bytearray)):
                await dst_send_bytes(bytes(msg))
            else:
                # str — JSON event frame
                await dst_send_text(msg)
    except WebSocketDisconnect:
        return
    except Exception:
        _log.debug("relay %s ended with exception", direction, exc_info=True)
        return


def _check_open_rate(user_id: str) -> bool:
    """Cap how often a single account can open new sessions. Without
    this, a leaked key (or just multiple keys on one account) could
    flood our voice pipeline with new sessions, exhausting upstream
    slots. Per-account so additional keys can't multiply the budget."""
    now = time.time()
    bucket = _session_opens.setdefault(user_id, [])
    cutoff = now - 60.0
    while bucket and bucket[0] < cutoff:
        bucket.pop(0)
    if len(bucket) >= MAX_SESSION_OPENS_PER_MINUTE_PER_ACCOUNT:
        return False
    bucket.append(now)
    return True


# Note: WebSocket endpoints don't render with a Try-It-Out button in
# Swagger UI (HTTP/REST only). Documented inline below + on the docs page.
@router.websocket("/v1/agents/{agent_id}/session")
async def agent_session(ws: WebSocket, agent_id: str) -> None:
    """Public voice-agent WS endpoint. See module docstring for the
    protocol; this function only handles auth + proxying."""
    # 0. Cheap input validation — bail before doing anything expensive.
    if not _AGENT_ID_RE.match(agent_id):
        await ws.accept()
        await ws.send_json({
            "type": "error",
            "code": "bad_request",
            "message": "Malformed agent_id.",
        })
        await ws.close(code=WS_CLOSE_NOT_FOUND)
        return

    # 1. Extract API key from Authorization header BEFORE accepting,
    #    so an unauth'd client gets rejected without an open WS.
    auth_header = ws.headers.get("authorization") or ws.headers.get("Authorization") or ""
    raw_key = ""
    if auth_header.lower().startswith("bearer "):
        raw_key = auth_header.split(" ", 1)[1].strip()

    auth_ctx = await _resolve_api_key_user(raw_key) if raw_key else None

    # We have to accept before we can send a structured error JSON.
    # Clients should treat 4401 as "auth failed", 4404 as "agent missing",
    # 4429 as "rate limited", 4502/4503 as "service-side issue".
    await ws.accept()

    if auth_ctx is None:
        await ws.send_json({
            "type": "error",
            "code": "auth_required",
            "message": "Missing or invalid API key. Send 'Authorization: Bearer voc_live_...'",
        })
        await ws.close(code=WS_CLOSE_AUTH)
        return

    if not INTERNAL_SERVICE_TOKEN:
        _log.error("INTERNAL_SERVICE_TOKEN not configured — agent API cannot proxy")
        await ws.send_json({
            "type": "error",
            "code": "service_misconfigured",
            "message": "Voice-agent API is not configured on this deployment.",
        })
        await ws.close(code=WS_CLOSE_CONFIG)
        return

    api_key_id = str(auth_ctx["api_key_id"])
    user_id = str(auth_ctx["user_id"])

    # 2. Re-verify Premium at connect time. API keys are gated to
    #    Premium at creation, but if Premium was revoked since then
    #    the key would still work for everything else; voice agents
    #    in particular need the explicit re-check.
    if not await _user_has_premium(user_id):
        await ws.send_json({
            "type": "error",
            "code": "premium_required",
            "message": "Voice agents require an active Premium plan. Purchase Premium to enable.",
        })
        # 4402 (insufficient credits / payment required) is the closest
        # WS analog; we don't have a dedicated Premium-required code.
        await ws.close(code=4402)
        return

    # 3. Rate limit: per-ACCOUNT open-rate AND concurrent-session cap.
    #    Per-account (not per-key) so a user can't multiply their quota
    #    by spinning up extra keys.
    if not _check_open_rate(user_id):
        await ws.send_json({
            "type": "error",
            "code": "rate_limited",
            "message": f"Too many sessions opened. Limit: {MAX_SESSION_OPENS_PER_MINUTE_PER_ACCOUNT}/min per account.",
        })
        await ws.close(code=WS_CLOSE_RATE_LIMIT)
        return

    # Atomic check-and-reserve for the concurrent-session cap. Done
    # BEFORE the agent-ownership lookup (which is an async DB call
    # and would yield to other coroutines) — otherwise 5+ concurrent
    # connects can all pass the check while awaiting ownership, then
    # all bump the counter past the cap. With the reserve-first
    # pattern we release the slot on any subsequent failure path.
    if _concurrent_sessions.get(user_id, 0) >= MAX_CONCURRENT_SESSIONS_PER_ACCOUNT:
        await ws.send_json({
            "type": "error",
            "code": "concurrent_limit",
            "message": f"Too many concurrent sessions. Limit: {MAX_CONCURRENT_SESSIONS_PER_ACCOUNT} per account.",
        })
        await ws.close(code=WS_CLOSE_RATE_LIMIT)
        return
    _concurrent_sessions[user_id] = _concurrent_sessions.get(user_id, 0) + 1
    slot_reserved = True

    def _release_slot() -> None:
        nonlocal slot_reserved
        if not slot_reserved:
            return
        slot_reserved = False
        current = _concurrent_sessions.get(user_id, 0)
        if current > 1:
            _concurrent_sessions[user_id] = current - 1
        else:
            _concurrent_sessions.pop(user_id, None)

    # 3. Verify agent ownership. We never proxy a connection for an
    #    agent the caller doesn't own — that would let a key holder
    #    drive another user's agent. Release the slot we just reserved
    #    if ownership fails so it doesn't leak.
    if not await _agent_belongs_to_user(agent_id, user_id):
        _release_slot()
        await ws.send_json({
            "type": "error",
            "code": "agent_not_found",
            "message": "agent not found or not owned by this API key's user",
        })
        await ws.close(code=WS_CLOSE_NOT_FOUND)
        return

    # 5. Open the inner WS to dashboard-backend with the service-token
    #    auth and explicit user_id / agent_id query params.
    inner_url = (
        f"{DASHBOARD_VOICECHAT_WS_URL}?agent_id={agent_id}&user_id={user_id}"
    )
    headers = {"X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN}

    session: aiohttp.ClientSession | None = None
    inner_ws: aiohttp.ClientWebSocketResponse | None = None
    try:
        # No cap on session timeout — voice sessions can be long-lived.
        # Heartbeat keeps the inner WS alive through idle gaps.
        session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None))
        try:
            inner_ws = await session.ws_connect(
                inner_url,
                headers=headers,
                heartbeat=20,
                max_msg_size=INNER_WS_MAX_MSG_SIZE,
            )
        except aiohttp.ClientError as exc:
            _log.warning("agent API: inner ws_connect failed: %s", exc)
            await ws.send_json({
                "type": "error",
                "code": "upstream_unavailable",
                "message": "Voice pipeline is temporarily unreachable. Please retry.",
            })
            await ws.close(code=WS_CLOSE_UPSTREAM)
            return

        # 4. Bidirectional frame relay until either side closes.
        async def _client_to_server() -> None:
            """Pump frames from external client (text JSON / cancel) into
            the inner WS. Exits when the client disconnects."""
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

        async def _server_to_client() -> None:
            """Pump JSON events and binary PCM frames from the inner WS
            back to the external client. Exits when inner WS closes."""
            try:
                async for inner_msg in inner_ws:
                    if inner_msg.type == aiohttp.WSMsgType.TEXT:
                        await ws.send_text(inner_msg.data)
                    elif inner_msg.type == aiohttp.WSMsgType.BINARY:
                        await ws.send_bytes(inner_msg.data)
                    elif inner_msg.type in (
                        aiohttp.WSMsgType.CLOSE,
                        aiohttp.WSMsgType.CLOSED,
                        aiohttp.WSMsgType.ERROR,
                    ):
                        return
            except (WebSocketDisconnect, RuntimeError):
                return

        # Use gather so the first task that finishes (client disconnect
        # or upstream close) tears down the other one cleanly.
        c2s = asyncio.create_task(_client_to_server())
        s2c = asyncio.create_task(_server_to_client())
        done, pending = await asyncio.wait(
            {c2s, s2c}, return_when=asyncio.FIRST_COMPLETED
        )
        for t in pending:
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass

    finally:
        # Release the concurrent-session slot no matter how we exit
        # (graceful close, client disconnect, upstream error, exception
        # during proxy setup). ``_release_slot`` is idempotent — safe
        # to call even if an earlier failure path already released it.
        try:
            _release_slot()
        except Exception:
            pass
        if inner_ws is not None and not inner_ws.closed:
            try:
                await asyncio.wait_for(inner_ws.close(code=1000), timeout=0.5)
            except (asyncio.TimeoutError, Exception):
                pass
        if session is not None:
            try:
                await asyncio.wait_for(session.close(), timeout=0.5)
            except (asyncio.TimeoutError, Exception):
                pass
        try:
            await ws.close()
        except Exception:
            pass
