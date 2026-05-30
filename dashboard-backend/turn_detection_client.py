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
  ``is_configured()`` returns True iff at least one ``turn_detection``
  pod is currently online in the ops registry. The per-pod API key
  (the value set on the Ops admin form at deploy time, or the
  auto-generated one if the field was left blank) is read from the
  encrypted registry at call time — no dashboard-side env var is
  required to enable this integration. The voicechat code checks
  ``is_configured()`` before opening these streams so we never block
  a turn on a pod that isn't deployed.

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


# Connection timeouts — turn detection is on the hot voice-turn path,
# so we cap both connect and inactivity tightly. Anything over 1s
# means the pod is too slow to be useful; better to skip the signal
# than block the turn.
_CONNECT_TIMEOUT_SEC = float(os.environ.get("TD_CLIENT_CONNECT_TIMEOUT_SEC") or "0.5")
_SOCK_READ_TIMEOUT_SEC = float(os.environ.get("TD_CLIENT_SOCK_READ_TIMEOUT_SEC") or "5.0")


def is_configured() -> bool:
    """True when at least one turn-detection pod is registered + online.

    The per-pod API key is read from the encrypted ops registry at
    call time (see :func:`_pick_pod`) — no dashboard-side env var
    is required to enable the integration."""
    try:
        from ops import pool as ops_pool
        snap = ops_pool.snapshot()
    except Exception:  # noqa: BLE001
        return False
    svc = snap.get("turn_detection") or {}
    return any(p.get("status") == "online" for p in svc.get("pods", []))


async def _pick_pod() -> tuple[str, str] | None:
    """Pick a healthy turn-detection pod for a streaming session.

    Returns ``(ws_base_url, api_key)`` or ``None`` if no online pod is
    available — caller must handle ``None`` gracefully.

    The API key is the per-pod value the operator set on the Ops admin
    page at deploy time (or the auto-generated one if the field was
    blank), decrypted from the ops registry."""
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
            key = p.get("api_key") or ""
            return f"ws://{p['host']}:{p['port']}", key
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
        picked = await _pick_pod()
        if picked is None:
            return False
        base, api_key = picked
        timeout = aiohttp.ClientTimeout(
            total=None,
            sock_connect=_CONNECT_TIMEOUT_SEC,
            sock_read=_SOCK_READ_TIMEOUT_SEC,
        )
        try:
            self._session = aiohttp.ClientSession(timeout=timeout)
            self._ws = await self._session.ws_connect(
                f"{base}/v1/smart-turn",
                headers={"X-API-Key": api_key},
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
        picked = await _pick_pod()
        if picked is None:
            return False
        base, api_key = picked
        timeout = aiohttp.ClientTimeout(
            total=None,
            sock_connect=_CONNECT_TIMEOUT_SEC,
            sock_read=_SOCK_READ_TIMEOUT_SEC,
        )
        try:
            self._session = aiohttp.ClientSession(timeout=timeout)
            self._ws = await self._session.ws_connect(
                f"{base}/v1/turn-detector",
                headers={"X-API-Key": api_key},
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
    silence_ms: int,
    smart_turn_p: float,
    turn_detector_p: float,
    min_endpointing_delay_ms: int = 500,
    max_endpointing_delay_ms: int = 6000,
    eou_threshold: float = 0.5,
) -> tuple[bool, str]:
    """Decide whether the user's turn is over.

    Follows the well-established LiveKit / Pipecat pattern:
      * VAD silence is the trigger — never commit while the user is
        clearly still speaking (``silence_ms < min_endpointing_delay``).
      * Turn-detector probability modulates the wait window:
          - high EOU confidence (≥ ``eou_threshold``)  → commit at
            ``min_endpointing_delay`` (fast reply)
          - low EOU confidence                          → wait longer,
            linearly extending toward ``max_endpointing_delay``
      * Hard cap: commit at ``max_endpointing_delay`` regardless,
        so a hung detector never freezes the bot.

    ``silence_ms`` is the duration of contiguous silence since the
    user last spoke, measured by the STT pod's server-side VAD
    (``vad_silence`` events). Browser-side Silero is no longer the
    authoritative source — we use the STT pod's VAD so a single
    component owns the silence calculation.

    ``smart_turn_p`` is the latest probability from the audio EOU
    model (Pipecat Smart Turn v3, prosody / intonation).
    ``turn_detector_p`` is the latest probability from the text EOU
    model (LiveKit Turn Detector v2, semantic completeness).
    We take ``max(smart, td)`` as the combined EOU score — either
    model being confident is enough evidence.

    Default thresholds match LiveKit Agents' published values
    (``min_endpointing_delay=500ms``, ``max_endpointing_delay=6000ms``,
    ``eou_threshold=0.5``) and are documented to work well across
    OpenAI Realtime, LiveKit, and Pipecat reference deployments.

    Returns ``(should_commit, rule_fired)``. The second item is a
    short string identifying which rule fired — useful for logging
    when tuning the thresholds in production.
    """
    if silence_ms < min_endpointing_delay_ms:
        return False, ""
    if silence_ms >= max_endpointing_delay_ms:
        return True, "hard_cap"

    combined_eou = max(smart_turn_p, turn_detector_p)

    # Fast path: turn-detector is confident the user is done.
    if combined_eou >= eou_threshold:
        return True, "eou_confident"

    # Slow path: scale the required wait inversely with EOU
    # confidence — low confidence → wait closer to the max.
    span = max_endpointing_delay_ms - min_endpointing_delay_ms
    required_silence = min_endpointing_delay_ms + int(span * (1.0 - combined_eou))
    if silence_ms >= required_silence:
        return True, "eou_low_silence_extended"
    return False, ""
