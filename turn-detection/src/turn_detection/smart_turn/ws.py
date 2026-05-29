"""WebSocket handler for ``/v1/smart-turn``.

Lifecycle:
  1. Client opens WS with X-API-Key header.
  2. Client sends ``{type:"start", sample_rate:16000, ...}``.
  3. Server replies ``{type:"ready", session_id, model, sample_rate}``.
  4. Client streams binary PCM frames (any size in [80, 1600] samples).
  5. Server emits ``{type:"probability", p_end_of_turn, ...}`` updates
     no faster than ``emit_every_ms`` AND when probability moves by
     ≥ 0.2 between calls.
  6. Server fires ``{type:"end_of_turn"}`` exactly once when p first
     crosses ``threshold_fire``; rearm when p drops below
     ``threshold_reset`` and crosses up again.
  7. Either side ``close`` ends the session.

The model inference is sync + CPU-bound. We run it on the asyncio
threadpool so the event loop stays responsive when multiple sessions
concurrently demand inference.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from typing import Final

from starlette.websockets import WebSocket, WebSocketDisconnect

from ..auth import check_ws_auth
from ..config import CONFIG
from ..metrics import (
    SMART_TURN,
    dec_inflight,
    inc_inflight,
    record_session,
)
from ..proto import (
    SmartTurnClose,
    SmartTurnReset,
    SmartTurnStart,
    parse_or_error,
)
from .buffer import RollingAudioBuffer
from .model import SAMPLE_RATE, infer, is_loaded


_log = logging.getLogger(__name__)


# Frame size policy — matches the platform spec §16.4 / §17.6:
# 80 samples = 5 ms; 1600 samples = 100 ms. Anything larger gets the
# 4413 close code.
_MIN_FRAME_SAMPLES: Final = 80
_MAX_FRAME_SAMPLES: Final = 1600
_BYTES_PER_SAMPLE: Final = 2  # int16


async def ws_smart_turn(ws: WebSocket) -> None:
    """ASGI route handler. Called by FastAPI for every WS upgrade."""
    if not await check_ws_auth(ws):
        return
    if not is_loaded():
        # The dispatcher should never route here in this state, but if
        # it does (e.g. we flipped to ``warming`` and the dispatcher's
        # poll is stale), give the client a clean rejection.
        await ws.accept()
        await ws.close(code=1011, reason="model not loaded")
        return
    # Concurrency cap. The semaphore lives on the app module; if it's
    # full we 4429 the client and let the dispatcher pick another pod.
    from ..server import session_semaphore
    if session_semaphore is None:
        await ws.accept()
        await ws.close(code=1011, reason="server not ready")
        return
    if session_semaphore.locked() and session_semaphore._value <= 0:  # type: ignore[attr-defined]
        # Don't await — if we're at the cap we want an immediate 4429
        # rather than queueing.
        await ws.accept()
        await ws.close(code=4429, reason="too many concurrent sessions")
        return

    await ws.accept()
    session_id = uuid.uuid4().hex
    inc_inflight(SMART_TURN)
    status_for_metric = "ok"
    t_session_start = time.perf_counter()

    try:
        async with session_semaphore:
            await _run_session(ws, session_id)
    except WebSocketDisconnect:
        # Normal — client closed. No special handling needed.
        pass
    except Exception:  # noqa: BLE001
        _log.exception("smart_turn ws session %s crashed", session_id)
        status_for_metric = "error"
        try:
            await ws.close(code=1011, reason="internal error")
        except Exception:  # noqa: BLE001
            pass
    finally:
        dec_inflight(SMART_TURN)
        record_session(
            model=SMART_TURN,
            status=status_for_metric,
            duration_ms=(time.perf_counter() - t_session_start) * 1000,
        )


async def _run_session(ws: WebSocket, session_id: str) -> None:
    # Phase 1 — start handshake. Bounded read timeout so a misbehaving
    # client can't tie up a slot forever waiting for ``start``.
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=10)
    except asyncio.TimeoutError:
        await _send_error(ws, "bad_request", "no start frame within 10s")
        return
    parsed = parse_or_error(raw, SmartTurnStart)
    if isinstance(parsed, dict):
        await ws.send_text(json.dumps(parsed))
        await ws.close(code=4400, reason="bad start")
        return
    start: SmartTurnStart = parsed  # type: ignore[assignment]

    buffer = RollingAudioBuffer(int(start.window_ms / 1000 * SAMPLE_RATE))
    last_emit_ts = 0.0
    last_emitted_p: float | None = None
    end_of_turn_armed = True  # True = can fire on next threshold crossing

    await ws.send_text(json.dumps({
        "type": "ready",
        "session_id": session_id,
        "model": f"{CONFIG.smart_turn_repo}/{CONFIG.smart_turn_file}",
        "sample_rate": SAMPLE_RATE,
    }))

    # Phase 2 — streaming loop. We accept either binary audio frames or
    # text control messages on the same socket. Idle-close after 60 s of
    # nothing-from-client.
    while True:
        try:
            msg = await asyncio.wait_for(ws.receive(), timeout=60)
        except asyncio.TimeoutError:
            _log.info("smart_turn session %s idle for 60s, closing", session_id)
            await ws.close(code=1000, reason="idle")
            return

        if msg.get("type") == "websocket.disconnect":
            return

        # Text frames: control messages
        if "text" in msg and msg["text"] is not None:
            text_payload = msg["text"]
            try:
                obj = json.loads(text_payload)
            except json.JSONDecodeError:
                await _send_error(ws, "bad_request", "control frame is not JSON")
                continue
            t = obj.get("type")
            if t == "reset":
                buffer.clear()
                last_emitted_p = None
                end_of_turn_armed = True
                continue
            if t == "close":
                await ws.close(code=1000, reason="client close")
                return
            if t == "ping":
                ts = obj.get("ts")
                await ws.send_text(json.dumps({"type": "pong", "ts": ts}))
                continue
            # Re-validate via Pydantic so unknown shapes get a real error.
            if t == "reset":
                parse_or_error(text_payload, SmartTurnReset)
            elif t == "close":
                parse_or_error(text_payload, SmartTurnClose)
            else:
                await _send_error(ws, "bad_request", f"unknown control type {t!r}")
            continue

        # Binary frames: audio
        payload = msg.get("bytes")
        if payload is None:
            # Could be a "websocket.receive" with no bytes/text (shouldn't
            # happen but starlette can return this). Just continue.
            continue
        samples = len(payload) // _BYTES_PER_SAMPLE
        if samples < _MIN_FRAME_SAMPLES:
            # Too small — could be a fragmentation pathology. Drop quietly.
            continue
        if samples > _MAX_FRAME_SAMPLES:
            await _send_error(ws, "bad_request", f"frame too large: {samples} samples")
            await ws.close(code=4413, reason="frame too large")
            return
        buffer.push_pcm16(payload)

        # Emit-throttle: never faster than emit_every_ms, but if we've
        # accumulated < window_ms of audio yet, also don't emit (the
        # model needs context to be meaningful).
        now = time.perf_counter()
        ms_since_emit = (now - last_emit_ts) * 1000
        if ms_since_emit < start.emit_every_ms:
            continue

        audio = buffer.snapshot()
        if audio.shape[0] < SAMPLE_RATE // 2:
            # Less than 500 ms accumulated — the model output would be
            # uninformative noise. Skip until we have more.
            continue

        # Run inference off the event loop so other sessions stay
        # responsive while ours is computing.
        p, infer_ms = await asyncio.to_thread(infer, audio)

        # Anti-chatter: emit on a meaningful change OR on the timer
        # interval. Even if probability is steady, send a heartbeat every
        # ~2× emit_every_ms so the client has a recent value.
        if (
            last_emitted_p is None
            or abs(p - last_emitted_p) >= 0.2
            or ms_since_emit >= start.emit_every_ms * 2
        ):
            await ws.send_text(json.dumps({
                "type": "probability",
                "p_end_of_turn": round(p, 4),
                "audio_ms_consumed": int(buffer.filled_samples / SAMPLE_RATE * 1000),
                "inference_ms": infer_ms,
            }))
            last_emitted_p = p
            last_emit_ts = now

        # Threshold-fire / re-arm logic. Fire when armed AND p > fire;
        # disarm. Re-arm when p drops below reset.
        if end_of_turn_armed and p >= CONFIG.threshold_fire:
            await ws.send_text(json.dumps({
                "type": "end_of_turn",
                "p_end_of_turn": round(p, 4),
                "audio_ms_consumed": int(buffer.filled_samples / SAMPLE_RATE * 1000),
            }))
            end_of_turn_armed = False
        elif not end_of_turn_armed and p < CONFIG.threshold_reset:
            end_of_turn_armed = True


async def _send_error(ws: WebSocket, code: str, message: str) -> None:
    try:
        await ws.send_text(json.dumps({"type": "error", "code": code, "message": message}))
    except Exception:  # noqa: BLE001
        pass
