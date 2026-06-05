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
        # Cross-language-comparable signal from the pod: confidence =
        # p_end_of_turn / language_threshold. ``>= 1.0`` means "the
        # model thinks the turn is over for this language." Older pod
        # images (pre-multilingual switch) don't send this field — we
        # store ``0.0`` then so the ensembler can detect "no signal" and
        # fall back to raw ``p_end_of_turn`` comparisons.
        self.last_confidence: float = 0.0
        # Per-language threshold the pod used to compute ``last_confidence``.
        # Surfaced for diagnostics; the ensembler uses ``last_confidence``
        # directly rather than re-applying the threshold itself.
        self.last_language_threshold: float = 0.0
        self.last_event: dict[str, Any] | None = None
        self.fired_end_of_turn: bool = False
        self._prob_wait: asyncio.Event | None = None

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
            self.last_confidence = 0.0
            self.fired_end_of_turn = False
        except Exception as exc:  # noqa: BLE001
            _log.warning("turn_detector commit failed: %s", exc)

    async def refresh_probability(
        self,
        cumulative_text: str,
        *,
        timeout: float = 0.12,
    ) -> float | None:
        """Re-score the current transcript after a pause.

        Streaming partials stop while the user is silent, so the last
        cached ``last_p_end_of_turn`` can be stale. LiveKit's agents
        framework runs a fresh ``predict_end_of_turn`` at each VAD
        silence boundary — we mirror that by pushing the frozen
        transcript and waiting for the next ``probability`` event.
        """
        ws = self._ws
        if ws is None or ws.closed or not cumulative_text.strip():
            return None
        self._prob_wait = asyncio.Event()
        await self.send_token(cumulative_text)
        try:
            await asyncio.wait_for(self._prob_wait.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass
        finally:
            self._prob_wait = None
        return self.last_p_end_of_turn

    def _notify_probability(self) -> None:
        if self._prob_wait is not None:
            self._prob_wait.set()

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
                    # ``confidence`` + ``language_threshold`` are only
                    # emitted by the multilingual pod. Old pod images
                    # omit them → fall back to 0.0 (ensembler interprets
                    # 0.0 as "no signal" and uses raw ``p`` instead).
                    self.last_confidence = float(obj.get("confidence", 0.0))
                    self.last_language_threshold = float(
                        obj.get("language_threshold", 0.0)
                    )
                    self._notify_probability()
                elif t == "end_of_turn":
                    self.last_event = obj
                    self.last_p_end_of_turn = float(obj.get("p_end_of_turn", 0.0))
                    self.last_confidence = float(obj.get("confidence", 0.0))
                    self.last_language_threshold = float(
                        obj.get("language_threshold", 0.0)
                    )
                    self.fired_end_of_turn = True
                    self._notify_probability()
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

# Default weights for ``combine_eou``. Text/semantic completeness is a
# stronger signal than audio prosody for distinguishing "user paused
# mid-thought" from "user finished" — a confident text-EOU is hard to
# fake, while prosody alone fires on every breath. So we lean on
# turn-detector heavier than smart-turn.
_DEFAULT_SMART_WEIGHT = 0.35
_DEFAULT_TD_WEIGHT = 0.65


def combine_eou(
    smart_turn_p: float,
    turn_detector_p: float,
    *,
    smart_weight: float = _DEFAULT_SMART_WEIGHT,
    td_weight: float = _DEFAULT_TD_WEIGHT,
) -> float:
    """Weighted blend of the two EOU signals. Returns a probability
    in [0, 1]. ``smart_weight + td_weight`` should equal 1.0 — pass
    different values to tune which model dominates."""
    return smart_weight * float(smart_turn_p) + td_weight * float(turn_detector_p)


# Thresholds for the LEGACY raw-probability code path (when the pod
# image is the old English-only build that doesn't emit ``confidence``).
# These are interpreted against the raw model output and only make sense
# for the English-only SmolLM model, which has its uniform 0..1 scale.
_TD_UNLIKELY = float(os.environ.get("VOC_TD_UNLIKELY_THRESHOLD", "0.55"))
_TD_HIGH = float(os.environ.get("VOC_TD_HIGH_THRESHOLD", "0.85"))
# Thresholds for the MULTILINGUAL pod's ``confidence`` field. Confidence
# is normalized as ``p_eou / per_language_threshold``, so ``>= 1.0`` is
# "model fires" for that language regardless of which one. Empirically
# (characterization across 14 langs):
#   * "Confident EOU" (text_confident path) starts around 5× threshold.
#     Complete sentences typically land at 15-200× threshold.
#   * "Definitely not done" stays at < 1× threshold (raw p below the
#     calibration point). Trail-offs / dangling preps cluster at <0.5×.
_TD_CONF_UNLIKELY = float(os.environ.get("VOC_TD_CONF_UNLIKELY", "1.0"))
_TD_CONF_HIGH = float(os.environ.get("VOC_TD_CONF_HIGH", "5.0"))
_PROSODY_ASSIST_MIN_TD = float(os.environ.get("VOC_PROSODY_ASSIST_MIN_TD", "0.10"))
_PROSODY_ASSIST_SHAVE_MS = int(os.environ.get("VOC_PROSODY_ASSIST_SHAVE_MS", "200"))


def compute_required_silence_ms(
    *,
    turn_detector_p: float,
    smart_turn_p: float = 0.0,
    text_eou_available: bool = True,
    min_endpointing_delay_ms: int = 500,
    max_endpointing_delay_ms: int = 6000,
    unlikely_threshold: float | None = None,
    high_threshold: float | None = None,
    turn_detector_confidence: float = 0.0,
) -> tuple[int, str]:
    """How much post-speech silence is required before committing.

    When ``turn_detector_confidence`` is > 0 (the multilingual pod
    emits it), we use that instead of raw ``turn_detector_p``. The raw
    value is calibrated per-language on the multilingual model — DE
    "complete" scores ~0.09 while EN "complete" scores ~0.93 — so a
    global threshold against raw ``p`` would silently break non-English.
    Confidence (= p / per-language threshold) normalises this so a
    single set of cutoffs works for all 14 supported languages.

    When confidence is 0 (old pod image, or no language metadata
    available), we fall back to the raw-``p`` thresholds for backwards
    compatibility.
    """
    use_confidence = turn_detector_confidence > 0.0
    if use_confidence:
        unlikely = _TD_CONF_UNLIKELY
        high = _TD_CONF_HIGH
        td_signal = turn_detector_confidence
    else:
        unlikely = _TD_UNLIKELY if unlikely_threshold is None else unlikely_threshold
        high = _TD_HIGH if high_threshold is None else high_threshold
        td_signal = turn_detector_p

    if not text_eou_available:
        span = max_endpointing_delay_ms - min_endpointing_delay_ms
        required = min_endpointing_delay_ms + int(span * (1.0 - float(smart_turn_p)))
        rule = "prosody_scaled"
        if smart_turn_p >= 0.85:
            required = min(required, min_endpointing_delay_ms + 400)
            rule = "prosody_only_confident"
        return required, rule

    if td_signal < unlikely:
        return max_endpointing_delay_ms, "text_unlikely"

    if td_signal >= high:
        required = min_endpointing_delay_ms
        rule = "text_confident"
    else:
        span = max_endpointing_delay_ms - min_endpointing_delay_ms
        t = (td_signal - unlikely) / max(high - unlikely, 1e-6)
        t = max(0.0, min(1.0, t))
        required = int(max_endpointing_delay_ms - t * span)
        rule = "text_scaled"

    if (
        smart_turn_p >= 0.85
        and td_signal >= unlikely + _PROSODY_ASSIST_MIN_TD
    ):
        required = max(min_endpointing_delay_ms, required - _PROSODY_ASSIST_SHAVE_MS)
        if rule == "text_scaled":
            rule = "text_scaled_prosody_assist"

    return required, rule


def should_commit_turn(
    *,
    silence_ms: int,
    smart_turn_p: float,
    turn_detector_p: float,
    min_endpointing_delay_ms: int = 500,
    max_endpointing_delay_ms: int = 6000,
    text_eou_available: bool = True,
    unlikely_threshold: float | None = None,
    high_threshold: float | None = None,
    turn_detector_confidence: float = 0.0,
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
    Combined via :func:`combine_eou` (weighted blend that favours
    text-EOU; ``max()`` was too liberal — either model firing was
    enough to commit, even when the other strongly disagreed, so
    a noisy prosody read on a mid-thought pause would interrupt).

    ``eou_threshold`` defaults to 0.75 (up from LiveKit's 0.5; we
    started at 0.65 and raised it again after observing the Turn
    Detector returning 0.6-0.7 on grammatical-but-incomplete partials
    like "I want to go to the store" — high enough to fast-commit
    even though the user wasn't done). With weighted blending and a
    0.75 threshold, BOTH signals have to be reasonably confident
    before we cut off.

    ``max_endpointing_delay_ms`` defaults to 6 s (matching LiveKit's
    default). Earlier we ran at 12 s on the theory that long thinking
    pauses shouldn't get cut off, but in practice users have already
    given up by the 5-second mark — a hung TD pod or a truly silent
    text_unlikely partial that sits there for 12 s reads as "the bot
    froze." 6 s is the longest worst-case wait that still feels alive.
    The fast paths (text_confident, text_scaled) already commit much
    sooner when the signal is clear, so the cap only matters in the
    pathological case.

    Returns ``(should_commit, rule_fired)``. The second item is a
    short string identifying which rule fired — useful for logging
    when tuning the thresholds in production.
    """
    if silence_ms < min_endpointing_delay_ms:
        return False, ""
    if silence_ms >= max_endpointing_delay_ms:
        return True, "hard_cap"

    required, rule = compute_required_silence_ms(
        turn_detector_p=turn_detector_p,
        smart_turn_p=smart_turn_p,
        text_eou_available=text_eou_available,
        min_endpointing_delay_ms=min_endpointing_delay_ms,
        max_endpointing_delay_ms=max_endpointing_delay_ms,
        unlikely_threshold=unlikely_threshold,
        high_threshold=high_threshold,
        turn_detector_confidence=turn_detector_confidence,
    )
    if silence_ms >= required:
        return True, rule
    return False, ""
