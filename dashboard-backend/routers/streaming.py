"""Public streaming endpoints — low-latency TTS + STT WebSockets.

These are the standalone equivalents of the streaming pieces inside
the voice-agent pipeline. Two endpoints:

  • ``WS /api/dashboard/streaming/tts/{voice_id}``
      The client picks a pre-registered voice (cloned or designed via
      ``/v1/voices/clone/save`` or ``/v1/voice/design/save``), opens the
      WS, sends ``{"type":"speak","text":"..."}``, and receives binary
      PCM16LE @ 24 kHz frames followed by a ``{"type":"end"}`` JSON.
      The client can send multiple ``speak`` frames on one connection;
      each is an independent synthesis turn.

  • ``WS /api/dashboard/streaming/stt``
      The client sends ``{"type":"start","language":"English",...}``,
      then streams binary PCM16LE @ 16 kHz frames, and receives JSON
      ``transcript`` events (interim + final). Sending
      ``{"type":"stop"}`` flushes the final transcript and closes.

Both routes accept the same two auth paths as the rest of the
dashboard surface:

  1. ``Authorization: Bearer <jwt>`` — website session, or
     ``?token=<jwt>`` query param for browsers that can't send headers
     on the WS upgrade.
  2. ``X-Internal-Service-Token`` + ``X-Internal-User-Id`` headers
     from the developer-api, gated on the loopback / dev-api source
     IP allowlist (same as voicechat).

Billing on this layer is intentionally pay-as-you-go and only kicks
in for the JWT session path (web Studio + CLI). The developer-api
side has its own per-character / per-second billing math so we skip
double-charging there — same convention as ``/voice-design/speak``.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import time
from typing import Any, AsyncIterator, Optional

import aiohttp
from fastapi import APIRouter, Query, WebSocket, WebSocketDisconnect

from local_db import atomic_deduct_credits, get_connection, record_credit_transaction
from routers.auth import _decode_token


def _decode_user_from_token(token: str | None) -> str | None:
    """Lifted from ``routers/voicechat.py`` so this module doesn't
    import-cycle through the agent pipeline. Returns the user_id on a
    valid JWT, None on anything else (expired, malformed, signature)."""
    if not token:
        return None
    try:
        decoded = _decode_token(token)
        return decoded.get("userId")
    except Exception:
        return None


router = APIRouter(prefix="/streaming", tags=["streaming"])
_log = logging.getLogger(__name__)


# --------------------------------------------------------------------- consts


# Close codes mirror the agent-session set so SDK callers see a
# consistent code map across all three streaming endpoints.
WS_CLOSE_AUTH = 4401
WS_CLOSE_INSUFFICIENT_CREDITS = 4402
WS_CLOSE_NOT_FOUND = 4404
WS_CLOSE_BAD_REQUEST = 4400
WS_CLOSE_RATE_LIMIT = 4429
WS_CLOSE_UPSTREAM = 4503

# Per-second STT rate matches the existing batch STT API rate so
# operators pricing the dev-api can stay consistent across the two
# paths. Both are configurable via env.
STT_CREDITS_PER_MIN = int(os.environ.get("STT_STREAMING_CREDITS_PER_MIN", "20"))
# Per-character TTS rate (4000 cr / 1M chars = $10 / 1M chars at our
# $0.0025 / credit). Mirrors the API_CREDITS_PER_1M_CHARS in dev-api.
TTS_CREDITS_PER_1M_CHARS = int(os.environ.get("TTS_STREAMING_CREDITS_PER_1M_CHARS", "4000"))


# --------------------------------------------------------------------- auth


def _resolve_ws_auth(
    ws: WebSocket,
    token: Optional[str],
    user_id_override: Optional[str],
) -> tuple[Optional[str], bool]:
    """Return (user_id, is_internal_proxy).

    Mirrors ``routers/voicechat.py``'s auth block exactly:
      1. Internal trust header pair, gated by source-IP allowlist.
      2. JWT in the ``token`` query param.
      3. JWT in the ``Authorization: Bearer …`` header.

    Returns (None, False) on no valid auth — caller closes 4401."""
    internal_token = ws.headers.get("x-internal-service-token") or ws.headers.get(
        "X-Internal-Service-Token"
    )
    expected_internal_token = (os.environ.get("INTERNAL_SERVICE_TOKEN") or "").strip()
    allowed_internal_ips = {
        ip.strip()
        for ip in (
            os.environ.get("INTERNAL_TRUST_ALLOWED_IPS") or "127.0.0.1,::1"
        ).split(",")
        if ip.strip()
    }
    client_host = (ws.client.host if ws.client else "") or ""
    if (
        internal_token
        and expected_internal_token
        and hmac.compare_digest(internal_token, expected_internal_token)
        and user_id_override
        and client_host in allowed_internal_ips
    ):
        return (user_id_override.strip() or None), True
    if internal_token and client_host not in allowed_internal_ips:
        _log.warning(
            "streaming: rejected internal-trust header from untrusted host=%s", client_host,
        )
        return None, False

    uid = _decode_user_from_token(token) if token else None
    if not uid:
        auth_header = ws.headers.get("authorization") or ws.headers.get("Authorization")
        if auth_header and auth_header.lower().startswith("bearer "):
            uid = _decode_user_from_token(auth_header.split(" ", 1)[1])
    return uid, False


async def _send_error(ws: WebSocket, code: str, message: str) -> None:
    """Best-effort error JSON before close. Swallows exceptions because
    the WS may already be half-closed by the time we hit this."""
    try:
        await ws.send_json({"type": "error", "code": code, "message": message})
    except Exception:
        pass


# --------------------------------------------------------------------- TTS


@router.websocket("/tts/{voice_id}")
async def streaming_tts(
    ws: WebSocket,
    voice_id: int,
    token: Optional[str] = Query(None),
    user_id_override: Optional[str] = Query(None, alias="user_id"),
    language: Optional[str] = Query(None),
) -> None:
    """Bidirectional WS for low-latency TTS using a pre-registered voice.

    Protocol (after ``ready``):
      C → S  JSON  {"type": "speak", "text": "...", "language": "English"}
      S → C  JSON  {"type": "meta", "sample_rate": 24000, "encoding": "pcm_s16le", "channels": 1}
      S → C  bytes raw PCM16LE frames
      S → C  JSON  {"type": "end"}            (single utterance done)
      C → S  JSON  {"type": "stop"}            (close cleanly)
    """
    auth_user_id, is_internal = _resolve_ws_auth(ws, token, user_id_override)
    await ws.accept()
    if not auth_user_id:
        await _send_error(ws, "auth_required", "Missing or invalid auth.")
        await ws.close(code=WS_CLOSE_AUTH)
        return

    # Pre-fetch voice metadata once so a non-existent / non-owned voice
    # 404s before we send "ready" — clients can distinguish from
    # transient pod failures during synthesis.
    try:
        ref_audio, ref_text = await _resolve_designed_voice(auth_user_id, voice_id)
    except FileNotFoundError as exc:
        await _send_error(ws, "voice_not_found", str(exc))
        await ws.close(code=WS_CLOSE_NOT_FOUND)
        return
    except Exception as exc:  # noqa: BLE001 — auth/IO failure
        await _send_error(ws, "voice_load_failed", str(exc)[:200])
        await ws.close(code=WS_CLOSE_UPSTREAM)
        return

    await ws.send_json({"type": "ready", "voice_id": voice_id})

    # One connection can serve many speak turns. Loop until the client
    # sends "stop" or disconnects.
    try:
        while True:
            try:
                msg = await ws.receive_json()
            except WebSocketDisconnect:
                return
            except json.JSONDecodeError:
                await _send_error(ws, "bad_request", "Expected JSON frame.")
                continue

            kind = (msg.get("type") or "").lower()
            if kind == "stop":
                return
            if kind != "speak":
                await _send_error(ws, "bad_request", f"Unknown frame type: {kind!r}")
                continue

            text = (msg.get("text") or "").strip()
            if not text:
                await _send_error(ws, "bad_request", "speak.text is required and non-empty.")
                continue
            if len(text) > 4000:
                await _send_error(ws, "bad_request", "speak.text exceeds 4000 chars per turn.")
                continue

            # JWT path bills per-character HERE; the developer-api proxy
            # owns its own billing math and sets ``is_internal``=True to
            # signal "skip the deduction".
            if not is_internal:
                cost = max(
                    1,
                    (len(text) * max(1, TTS_CREDITS_PER_1M_CHARS) + 999_999) // 1_000_000,
                )
                conn = await get_connection()
                try:
                    new_balance = await atomic_deduct_credits(
                        conn, user_id=auth_user_id, cost=cost,
                    )
                    if new_balance is None:
                        await _send_error(
                            ws, "insufficient_credits",
                            f"Need {cost} credits for {len(text)} chars.",
                        )
                        await ws.close(code=WS_CLOSE_INSUFFICIENT_CREDITS)
                        return
                    await record_credit_transaction(
                        conn,
                        user_id=auth_user_id,
                        transaction_type="tts_streaming",
                        amount=-cost,
                        balance_after=new_balance,
                        description=f"streaming TTS ({len(text)} chars, voice {voice_id})",
                    )
                    await conn.commit()
                finally:
                    await conn.close()

            req_language = (msg.get("language") or language or None)
            await _pump_tts(ws, text, ref_audio, ref_text, req_language)
            # Sub-loop returns to ``while True``: the client can fire
            # another speak frame on the same connection.
    except WebSocketDisconnect:
        return


async def _pump_tts(
    ws: WebSocket,
    text: str,
    ref_audio: bytes,
    ref_text: str,
    language: Optional[str],
) -> None:
    """Drive one speak turn end-to-end. Yields meta → audio frames →
    end (or error) and returns. Never closes the outer WS — the loop
    in ``streaming_tts`` owns that."""
    # Local import to keep streaming_service deps out of module import.
    from voicechat_service import _stream_clone_with_refs

    sent_meta = False
    try:
        async for chunk in _stream_clone_with_refs(text, ref_audio, ref_text, language):
            if chunk.kind == "meta":
                payload = chunk.payload if isinstance(chunk.payload, dict) else {}
                await ws.send_json({
                    "type": "meta",
                    "sample_rate": payload.get("sample_rate", 24000),
                    "encoding": payload.get("encoding", "pcm_s16le"),
                    "channels": payload.get("channels", 1),
                    "frame_ms": payload.get("frame_ms"),
                })
                sent_meta = True
            elif chunk.kind == "audio":
                if not sent_meta:
                    # Some pods emit audio without a preceding meta —
                    # synthesize one with our defaults so the client's
                    # decoder has the rate/encoding it needs.
                    await ws.send_json({
                        "type": "meta",
                        "sample_rate": 24000,
                        "encoding": "pcm_s16le",
                        "channels": 1,
                    })
                    sent_meta = True
                if isinstance(chunk.payload, (bytes, bytearray)):
                    await ws.send_bytes(bytes(chunk.payload))
            elif chunk.kind == "end":
                await ws.send_json({"type": "end"})
                return
            elif chunk.kind == "error":
                err = chunk.payload if isinstance(chunk.payload, dict) else {}
                await _send_error(
                    ws,
                    str(err.get("code") or "tts_failed"),
                    str(err.get("message") or "TTS turn failed"),
                )
                return
    except Exception as exc:  # noqa: BLE001
        _log.exception("streaming_tts pump failed")
        await _send_error(ws, "tts_failed", f"{type(exc).__name__}: {exc}")


# --------------------------------------------------------------------- STT


@router.websocket("/stt")
async def streaming_stt(
    ws: WebSocket,
    token: Optional[str] = Query(None),
    user_id_override: Optional[str] = Query(None, alias="user_id"),
) -> None:
    """Live STT WebSocket. Push PCM16LE @ 16 kHz, receive partial +
    final transcript events.

    Protocol:
      C → S  JSON   {"type":"start","language":"English","sample_rate":16000,
                    "encoding":"pcm_s16le","enable_partials":true}
      S → C  JSON   {"type":"ready"}
      C → S  bytes  PCM frames
      S → C  JSON   {"type":"transcript","text":"…","is_final":false}
      S → C  JSON   {"type":"transcript","text":"…","is_final":true}
      C → S  JSON   {"type":"stop"}        (flushes + closes)
      S → C  JSON   {"type":"end"}
    """
    auth_user_id, is_internal = _resolve_ws_auth(ws, token, user_id_override)
    await ws.accept()
    if not auth_user_id:
        await _send_error(ws, "auth_required", "Missing or invalid auth.")
        await ws.close(code=WS_CLOSE_AUTH)
        return

    # Expect a "start" frame before opening the inner WS — clients
    # need to declare sample rate / language up-front anyway, and
    # we don't want to allocate a pod slot for a session that's
    # going to be misconfigured.
    try:
        start = await asyncio.wait_for(ws.receive_json(), timeout=10.0)
    except asyncio.TimeoutError:
        await _send_error(ws, "bad_request", "Expected a 'start' frame within 10 s.")
        await ws.close(code=WS_CLOSE_BAD_REQUEST)
        return
    except WebSocketDisconnect:
        return
    if (start.get("type") or "").lower() != "start":
        await _send_error(ws, "bad_request", "First frame must be type=start.")
        await ws.close(code=WS_CLOSE_BAD_REQUEST)
        return

    # Allocate a streaming-STT pod from the dispatcher; bail with a
    # 503-equivalent if none are online.
    try:
        from ops import pool as gpu_pool
    except Exception:  # noqa: BLE001
        gpu_pool = None  # type: ignore
    if gpu_pool is None or gpu_pool.online_pod_count("asr_streaming_rt") <= 0:
        await _send_error(
            ws, "service_unavailable",
            "Streaming STT is not available on this deployment.",
        )
        await ws.close(code=WS_CLOSE_UPSTREAM)
        return

    pod_cm = gpu_pool.pick_pod("asr_streaming_rt")
    started_at = time.monotonic()
    try:
        pod = await pod_cm.__aenter__()
        base = pod.url.rstrip("/")
        ws_url = (
            "wss://" + base[len("https://"):] + "/v1/stream"
            if base.startswith("https://")
            else "ws://" + base[len("http://"):] + "/v1/stream"
        )
        headers = {"X-API-Key": pod.api_key} if pod.api_key else {}

        async with aiohttp.ClientSession() as http:
            try:
                inner_ws = await http.ws_connect(
                    ws_url,
                    headers=headers,
                    heartbeat=20,
                    max_msg_size=2 * 1024 * 1024,
                )
            except Exception as exc:  # noqa: BLE001
                await _send_error(ws, "upstream_unavailable", f"STT pod ws_connect: {exc}")
                await ws.close(code=WS_CLOSE_UPSTREAM)
                return

            async with inner_ws:
                # Forward (sanitized) start frame to the pod. We only
                # pass through fields the pod's protocol documents — a
                # client can't smuggle arbitrary kv to the pod.
                await inner_ws.send_json({
                    "type": "start",
                    "language": (start.get("language") or "English"),
                    "sample_rate": int(start.get("sample_rate") or 16000),
                    "encoding": (start.get("encoding") or "pcm_s16le"),
                    "enable_partials": bool(start.get("enable_partials", True)),
                    "vad_events": bool(start.get("vad_events", False)),
                })
                # Wait for ready from pod, then tell the client.
                try:
                    ready_msg = await asyncio.wait_for(
                        inner_ws.receive(), timeout=10.0,
                    )
                except asyncio.TimeoutError:
                    await _send_error(ws, "upstream_timeout", "STT pod did not ready.")
                    await ws.close(code=WS_CLOSE_UPSTREAM)
                    return
                if ready_msg.type != aiohttp.WSMsgType.TEXT:
                    await _send_error(ws, "upstream_protocol", "STT pod sent non-text ready.")
                    await ws.close(code=WS_CLOSE_UPSTREAM)
                    return
                await ws.send_json({"type": "ready"})

                # Bidirectional pump.
                async def _c2s() -> None:
                    try:
                        while True:
                            msg = await ws.receive()
                            if msg.get("type") == "websocket.disconnect":
                                return
                            if msg.get("type") != "websocket.receive":
                                continue
                            if msg.get("bytes") is not None:
                                await inner_ws.send_bytes(msg["bytes"])
                            elif msg.get("text") is not None:
                                # Only "stop" is meaningful from the
                                # client on the JSON side after start.
                                try:
                                    payload = json.loads(msg["text"])
                                except json.JSONDecodeError:
                                    continue
                                if (payload.get("type") or "").lower() == "stop":
                                    # Tell the pod we're done so it
                                    # flushes a final transcript.
                                    try:
                                        await inner_ws.send_json({"type": "stop"})
                                    except Exception:
                                        pass
                                    return
                    except (WebSocketDisconnect, RuntimeError):
                        return

                async def _s2c() -> None:
                    try:
                        async for m in inner_ws:
                            if m.type == aiohttp.WSMsgType.TEXT:
                                await ws.send_text(m.data)
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

                # Bill on the JWT path. Per-second math; the pod can
                # also report duration in its final frame, but we
                # measure wall-clock here for simplicity. Internal
                # proxy path bills separately on the dev-api side.
                if not is_internal:
                    seconds = max(1, int(time.monotonic() - started_at))
                    cost = max(
                        1, (seconds * max(1, STT_CREDITS_PER_MIN) + 59) // 60,
                    )
                    conn = await get_connection()
                    try:
                        new_balance = await atomic_deduct_credits(
                            conn, user_id=auth_user_id, cost=cost,
                        )
                        if new_balance is not None:
                            await record_credit_transaction(
                                conn,
                                user_id=auth_user_id,
                                transaction_type="stt_streaming",
                                amount=-cost,
                                balance_after=new_balance,
                                description=f"streaming STT ({seconds}s)",
                            )
                            await conn.commit()
                    finally:
                        await conn.close()

                # End event for the client. The pod already sent its
                # final transcript before its close; we tag the session
                # boundary explicitly so the SDK iterator terminates.
                try:
                    await ws.send_json({"type": "end"})
                except Exception:
                    pass
    finally:
        try:
            await pod_cm.__aexit__(None, None, None)
        except Exception:
            pass


# --------------------------------------------------------------------- helpers


async def _resolve_designed_voice(user_id: str, voice_id: int) -> tuple[bytes, str]:
    """Wrapper around ``voicechat_service._resolve_designed_voice`` —
    the helper already does ownership-gated lookup + S3 fetch + a
    process-local LRU cache, so we just delegate. Imported lazily so
    this router can be imported before voicechat_service initializes."""
    from voicechat_service import _resolve_designed_voice as _impl
    return await _impl(user_id, voice_id)
