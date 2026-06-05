"""WebSocket handler for ``/v1/turn-detector``.

Lifecycle:
  1. Client opens WS with X-API-Key.
  2. Client sends ``{type:"start", history:[...], language}``.
  3. Server replies ``{type:"ready"}``.
  4. Client streams ``{type:"token", text:"<cumulative partial>"}``
     each time the streaming STT promotes a new partial.
  5. Server runs the model on each token event and emits
     ``{type:"probability", p_end_of_turn, tokens_seen}``.
  6. Server fires ``end_of_turn`` exactly once when p crosses
     ``threshold_fire``; rearms when p drops below ``threshold_reset``.
  7. Client may send ``{type:"commit", content}`` to promote the
     in-progress utterance to history and reset the in-progress state.
  8. Either side ``close`` ends the session.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid

from starlette.websockets import WebSocket, WebSocketDisconnect

from ..auth import check_ws_auth
from ..config import CONFIG
from ..metrics import (
    TURN_DETECTOR,
    dec_inflight,
    inc_inflight,
    record_session,
)
from ..proto import (
    TurnDetectorClose,
    TurnDetectorCommit,
    TurnDetectorStart,
    TurnDetectorToken,
    parse_or_error,
)
from .model import infer, is_loaded


_log = logging.getLogger(__name__)


async def ws_turn_detector(ws: WebSocket) -> None:
    if not await check_ws_auth(ws):
        return
    if not is_loaded():
        await ws.accept()
        await ws.close(code=1011, reason="model not loaded")
        return
    from ..server import session_semaphore
    if session_semaphore is None:
        await ws.accept()
        await ws.close(code=1011, reason="server not ready")
        return
    if session_semaphore.locked() and session_semaphore._value <= 0:  # type: ignore[attr-defined]
        await ws.accept()
        await ws.close(code=4429, reason="too many concurrent sessions")
        return

    await ws.accept()
    session_id = uuid.uuid4().hex
    inc_inflight(TURN_DETECTOR)
    status_for_metric = "ok"
    t_session_start = time.perf_counter()

    try:
        async with session_semaphore:
            await _run_session(ws, session_id)
    except WebSocketDisconnect:
        pass
    except Exception:  # noqa: BLE001
        _log.exception("turn_detector ws session %s crashed", session_id)
        status_for_metric = "error"
        try:
            await ws.close(code=1011, reason="internal error")
        except Exception:  # noqa: BLE001
            pass
    finally:
        dec_inflight(TURN_DETECTOR)
        record_session(
            model=TURN_DETECTOR,
            status=status_for_metric,
            duration_ms=(time.perf_counter() - t_session_start) * 1000,
        )


async def _run_session(ws: WebSocket, session_id: str) -> None:
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=10)
    except asyncio.TimeoutError:
        await _send_error(ws, "bad_request", "no start frame within 10s")
        return
    parsed = parse_or_error(raw, TurnDetectorStart)
    if isinstance(parsed, dict):
        await ws.send_text(json.dumps(parsed))
        await ws.close(code=4400, reason="bad start")
        return
    start: TurnDetectorStart = parsed  # type: ignore[assignment]

    # Convert Pydantic history models → plain dicts the inference function
    # expects.
    history: list[dict[str, str]] = [
        {"role": t.role, "content": t.content} for t in start.history
    ]
    in_progress: str = ""
    last_p: float | None = None
    end_of_turn_armed = True

    await ws.send_text(json.dumps({
        "type": "ready",
        "session_id": session_id,
        "model": CONFIG.turn_detector_repo,
        "language": start.language,
    }))

    while True:
        try:
            raw = await asyncio.wait_for(ws.receive_text(), timeout=60)
        except asyncio.TimeoutError:
            _log.info("turn_detector session %s idle for 60s, closing", session_id)
            await ws.close(code=1000, reason="idle")
            return
        try:
            obj = json.loads(raw)
        except json.JSONDecodeError:
            await _send_error(ws, "bad_request", "frame is not JSON")
            continue

        t = obj.get("type")
        if t == "close":
            parse_or_error(raw, TurnDetectorClose)
            await ws.close(code=1000, reason="client close")
            return

        if t == "commit":
            parsed_commit = parse_or_error(raw, TurnDetectorCommit)
            if isinstance(parsed_commit, dict):
                await ws.send_text(json.dumps(parsed_commit))
                continue
            commit: TurnDetectorCommit = parsed_commit  # type: ignore[assignment]
            # Promote the committed text to history, drop the older end
            # of the buffer so we never grow past MAX_HISTORY_TURNS — the
            # inference call also truncates but we keep our own buffer
            # bounded too so memory doesn't pile up.
            history.append({"role": "user", "content": commit.content})
            history = history[-8:]  # keep some slack above MAX_HISTORY_TURNS
            in_progress = ""
            last_p = None
            end_of_turn_armed = True
            continue

        if t == "ping":
            ts = obj.get("ts")
            await ws.send_text(json.dumps({"type": "pong", "ts": ts}))
            continue

        if t != "token":
            await _send_error(ws, "bad_request", f"unknown type {t!r}")
            continue

        parsed_tok = parse_or_error(raw, TurnDetectorToken)
        if isinstance(parsed_tok, dict):
            await ws.send_text(json.dumps(parsed_tok))
            continue
        tok: TurnDetectorToken = parsed_tok  # type: ignore[assignment]

        if not tok.text.strip():
            # Empty token — no point running inference.
            continue

        # The text field is cumulative, so just replace.
        in_progress = tok.text

        p, tokens_seen, infer_ms = await asyncio.to_thread(
            infer, history, in_progress
        )

        # Emit on first sample or change ≥ 0.05 (text scoring is more
        # stable than audio so we can be more sensitive without flooding
        # the wire).
        if last_p is None or abs(p - last_p) >= 0.05:
            await ws.send_text(json.dumps({
                "type": "probability",
                "p_end_of_turn": round(p, 4),
                "tokens_seen": tokens_seen,
                "inference_ms": infer_ms,
            }))
            last_p = p

        if end_of_turn_armed and p >= CONFIG.threshold_fire:
            await ws.send_text(json.dumps({
                "type": "end_of_turn",
                "p_end_of_turn": round(p, 4),
                "tokens_seen": tokens_seen,
            }))
            end_of_turn_armed = False
        elif not end_of_turn_armed and p < CONFIG.threshold_reset:
            end_of_turn_armed = True


async def _send_error(ws: WebSocket, code: str, message: str) -> None:
    try:
        await ws.send_text(json.dumps({"type": "error", "code": code, "message": message}))
    except Exception:  # noqa: BLE001
        pass
