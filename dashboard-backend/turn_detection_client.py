"""Client for the ``vocence/turn-detection`` pod.

Wraps both WebSocket endpoints behind a tidy Python API:

  • ``SmartTurnStream`` — audio in, probability + end_of_turn events
    out. Used during a streaming-STT voice turn: every PCM frame is
    forwarded both to the STT pod AND to a SmartTurnStream so the
    turn-end ensembler in voicechat_service has the prosody signal.

  • ``TurnDetectorStream`` — text in (cumulative streaming transcript),
    probability + end_of_turn events out. Fed from the STT pod's
    partial transcripts.

Activation:
  This module is dormant until the streaming-STT path lands in
  voicechat_service.py. Until then, ``is_configured()`` returns False
  unless ``TD_API_KEY`` is explicitly set in the dashboard's env. The
  voicechat code checks ``is_configured()`` before opening these
  streams so we never block a turn on a pod that isn't deployed.

Failure semantics:
  Both streams are **best-effort** signals. If a stream errors or
  times out, the voicechat ensembler should fall back to the other
  signals (client-side Silero silence + STT pod's own VAD events).
  We never raise into the voice turn — we log + close.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any

import aiohttp


_log = logging.getLogger(__name__)


# The shared X-API-Key the turn-detection pod requires. Set on the pod
# via ``TD_API_KEY`` env var at deploy time. Unset = integration off.
TD_API_KEY = (os.environ.get("TD_API_KEY") or "").strip()

# Connection timeouts — turn detection is on the hot voice-turn path,
# so we cap both connect and inactivity tightly. Anything over 1s
# means the pod is too slow to be useful; better to skip the signal
# than block the turn.
_CONNECT_TIMEOUT_SEC = float(os.environ.get("TD_CLIENT_CONNECT_TIMEOUT_SEC") or "0.5")
_SOCK_READ_TIMEOUT_SEC = float(os.environ.get("TD_CLIENT_SOCK_READ_TIMEOUT_SEC") or "5.0")


def is_configured() -> bool:
    """True when an API key is set + at least one turn-detection pod
    can be picked up by the ops dispatcher."""
    return bool(TD_API_KEY)


async def _pick_base_ws_url() -> str | None:
    """Pick a healthy turn-detection pod for a streaming session.
    Returns a ``ws://host:port`` base URL or ``None`` if no pod is
    available — caller must handle ``None`` gracefully."""
    from ops import pool as ops_pool
    try:
        snap = ops_pool.snapshot()
    except Exception:  # noqa: BLE001
        return None
    svc = snap.get("turn_detection")
    if not svc:
        return None
    for p in svc.get("pods", []):
        if p.get("status") == "online":
            return f"ws://{p['host']}:{p['port']}"
    return None


# ---------------------------------------------------------------------------
# Smart Turn (audio) stream wrapper
# ---------------------------------------------------------------------------

class SmartTurnStream:
    """Async-context manager over a single Smart Turn WS session.

    Usage:

        async with SmartTurnStream(window_ms=4000) as st:
            await st.start()
            async for frame in audio_frames:
                await st.send_pcm(frame)
                if st.last_p_end_of_turn > 0.85:
                    break

    The stream owns its own background read task that drains events
    from the pod and keeps ``last_p_end_of_turn`` + ``last_event``
    fresh. Callers poll those properties from their own event loop.
    """

    def __init__(self, *, sample_rate: int = 16000, window_ms: int = 4000,
                 emit_every_ms: int = 150) -> None:
        self.sample_rate = sample_rate
        self.window_ms = window_ms
        self.emit_every_ms = emit_every_ms
        self._session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._reader_task: asyncio.Task | None = None
        self.last_p_end_of_turn: float = 0.0
        self.last_event: dict[str, Any] | None = None
        self.fired_end_of_turn: bool = False
        self._ready = asyncio.Event()

    async def __aenter__(self) -> "SmartTurnStream":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    async def start(self) -> bool:
        """Connect to a turn-detection pod and send the ``start`` frame.
        Returns ``True`` on success. Returns ``False`` when the pod is
        unavailable or the handshake fails — caller should treat the
        signal as unavailable and proceed without it."""
        if not is_configured():
            return False
        base = await _pick_base_ws_url()
        if not base:
            return False
        timeout = aiohttp.ClientTimeout(
            total=None,
            sock_connect=_CONNECT_TIMEOUT_SEC,
            sock_read=_SOCK_READ_TIMEOUT_SEC,
        )
        try:
            self._session = aiohttp.ClientSession(timeout=timeout)
            self._ws = await self._session.ws_connect(
                f"{base}/v1/smart-turn",
                headers={"X-API-Key": TD_API_KEY},
            )
            await self._ws.send_json({
                "type": "start",
                "sample_rate": self.sample_rate,
                "encoding": "pcm_s16le",
                "window_ms": self.window_ms,
                "emit_every_ms": self.emit_every_ms,
            })
            # Background reader keeps draining the pod's events until
            # close() or remote disconnect.
            self._reader_task = asyncio.create_task(self._reader_loop())
            return True
        except Exception as exc:  # noqa: BLE001
            _log.warning("smart_turn connect failed: %s", exc)
            await self.close()
            return False

    async def send_pcm(self, pcm16_bytes: bytes) -> None:
        """Forward one PCM chunk to the pod. Silently no-ops if the
        stream is closed — caller doesn't need to check."""
        ws = self._ws
        if ws is None or ws.closed:
            return
        try:
            await ws.send_bytes(pcm16_bytes)
        except Exception as exc:  # noqa: BLE001
            _log.warning("smart_turn send_pcm failed: %s", exc)
            await self.close()

    async def reset(self) -> None:
        """Clear the rolling window — call when a new utterance starts
        after a commit."""
        ws = self._ws
        if ws is None or ws.closed:
            return
        try:
            await ws.send_json({"type": "reset"})
            self.last_p_end_of_turn = 0.0
            self.fired_end_of_turn = False
        except Exception as exc:  # noqa: BLE001
            _log.warning("smart_turn reset failed: %s", exc)

    async def _reader_loop(self) -> None:
        ws = self._ws
        assert ws is not None
        try:
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    obj = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                t = obj.get("type")
                if t == "ready":
                    self._ready.set()
                elif t == "probability":
                    self.last_event = obj
                    self.last_p_end_of_turn = float(obj.get("p_end_of_turn", 0.0))
                elif t == "end_of_turn":
                    self.last_event = obj
                    self.last_p_end_of_turn = float(obj.get("p_end_of_turn", 0.0))
                    self.fired_end_of_turn = True
                # ``error`` events from the pod surface in the log so
                # operators can diagnose; we don't propagate to the
                # caller because best-effort = swallow.
                elif t == "error":
                    _log.warning("smart_turn pod error: %s", obj)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            _log.warning("smart_turn reader errored: %s", exc)

    async def close(self) -> None:
        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._reader_task = None
        if self._ws is not None:
            try:
                if not self._ws.closed:
                    await self._ws.send_json({"type": "close"})
                    await self._ws.close()
            except Exception:  # noqa: BLE001
                pass
            self._ws = None
        if self._session is not None:
            try:
                await self._session.close()
            except Exception:  # noqa: BLE001
                pass
            self._session = None


# ---------------------------------------------------------------------------
# Turn Detector (text) stream wrapper — same shape, different inputs
# ---------------------------------------------------------------------------

class TurnDetectorStream:
    """Text-based EOU stream. Fed from STT partials.

    Same pattern as ``SmartTurnStream`` but with text tokens instead
    of audio frames. Pass the cumulative in-progress transcript to
    ``send_token`` each time a new partial arrives from the STT pod.
    """

    def __init__(self, *, history: list[dict[str, str]] | None = None,
                 language: str = "en") -> None:
        self.history = history or []
        self.language = language
        self._session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._reader_task: asyncio.Task | None = None
        self.last_p_end_of_turn: float = 0.0
        self.last_event: dict[str, Any] | None = None
        self.fired_end_of_turn: bool = False

    async def __aenter__(self) -> "TurnDetectorStream":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    async def start(self) -> bool:
        if not is_configured():
            return False
        base = await _pick_base_ws_url()
        if not base:
            return False
        timeout = aiohttp.ClientTimeout(
            total=None,
            sock_connect=_CONNECT_TIMEOUT_SEC,
            sock_read=_SOCK_READ_TIMEOUT_SEC,
        )
        try:
            self._session = aiohttp.ClientSession(timeout=timeout)
            self._ws = await self._session.ws_connect(
                f"{base}/v1/turn-detector",
                headers={"X-API-Key": TD_API_KEY},
            )
            await self._ws.send_json({
                "type": "start",
                "history": self.history,
                "language": self.language,
            })
            self._reader_task = asyncio.create_task(self._reader_loop())
            return True
        except Exception as exc:  # noqa: BLE001
            _log.warning("turn_detector connect failed: %s", exc)
            await self.close()
            return False

    async def send_token(self, cumulative_text: str, *, is_final: bool = False) -> None:
        """Forward the cumulative in-progress transcript. The pod's
        protocol expects ``text`` to be cumulative (not a delta) —
        replacing each time means the model always sees the full
        current state."""
        ws = self._ws
        if ws is None or ws.closed:
            return
        if not cumulative_text.strip():
            return
        try:
            await ws.send_json({
                "type": "token", "text": cumulative_text, "is_final": is_final,
            })
        except Exception as exc:  # noqa: BLE001
            _log.warning("turn_detector send_token failed: %s", exc)
            await self.close()

    async def commit(self, content: str) -> None:
        """Promote the current in-progress utterance to history; the
        next ``send_token`` starts a fresh utterance."""
        ws = self._ws
        if ws is None or ws.closed:
            return
        try:
            await ws.send_json({"type": "commit", "content": content})
            self.last_p_end_of_turn = 0.0
            self.fired_end_of_turn = False
        except Exception as exc:  # noqa: BLE001
            _log.warning("turn_detector commit failed: %s", exc)

    async def _reader_loop(self) -> None:
        ws = self._ws
        assert ws is not None
        try:
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    continue
                try:
                    obj = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                t = obj.get("type")
                if t == "probability":
                    self.last_event = obj
                    self.last_p_end_of_turn = float(obj.get("p_end_of_turn", 0.0))
                elif t == "end_of_turn":
                    self.last_event = obj
                    self.last_p_end_of_turn = float(obj.get("p_end_of_turn", 0.0))
                    self.fired_end_of_turn = True
                elif t == "error":
                    _log.warning("turn_detector pod error: %s", obj)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            _log.warning("turn_detector reader errored: %s", exc)

    async def close(self) -> None:
        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._reader_task = None
        if self._ws is not None:
            try:
                if not self._ws.closed:
                    await self._ws.send_json({"type": "close"})
                    await self._ws.close()
            except Exception:  # noqa: BLE001
                pass
            self._ws = None
        if self._session is not None:
            try:
                await self._session.close()
            except Exception:  # noqa: BLE001
                pass
            self._session = None


# ---------------------------------------------------------------------------
# Ensembler — pure helper, no I/O
# ---------------------------------------------------------------------------

def should_commit_turn(
    *,
    client_vad_silence: bool,
    server_vad_silence_ms: int,
    smart_turn_p: float,
    turn_detector_p: float,
    silence_continuous_ms: int,
    strong_threshold: float = 0.85,
    weak_threshold: float = 0.70,
    vad_silence_threshold_ms: int = 800,
    hard_cap_ms: int = 5000,
) -> tuple[bool, str]:
    """Decide whether the user's turn is over given the four signals
    available during a streaming voice session.

    Returns ``(should_commit, rule_fired)``. The second item is a
    short string identifying which rule fired — useful for logging
    when tuning the thresholds in production.

    Rules (in priority order):

      1. Both strong models say end-of-turn → commit.
      2. Client VAD silence + either strong model > weak threshold → commit.
      3. Client VAD silence + sustained server VAD silence → commit.
      4. Hard cap: silence > 5s → commit no matter what.
    """
    if smart_turn_p > strong_threshold and turn_detector_p > strong_threshold:
        return True, "both_models_strong"
    if client_vad_silence and (
        smart_turn_p > weak_threshold or turn_detector_p > weak_threshold
    ):
        return True, "vad_silence_plus_model_weak"
    if client_vad_silence and server_vad_silence_ms > vad_silence_threshold_ms:
        return True, "vad_silence_plus_server_vad"
    if silence_continuous_ms > hard_cap_ms:
        return True, "hard_cap_silence"
    return False, ""
