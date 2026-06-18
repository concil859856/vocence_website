"""Server-side barge-in detection during agent reply.

Bridges the architectural gap with the framework's
``pipeline_orchestrator._monitor_interruption_duration``: their pipeline
runs continuous VAD over the audio stream and fires
``_interrupt_pipeline()`` when sustained user speech is detected during
the agent's reply. Our per-turn ``StreamingTurnSession`` closes at
commit, so during the agent's reply NO server-side audio processing is
running. The user has to trigger a fresh ``stream_start`` from the
client to interrupt — which fails when their speech is continuous
(client-side Silero never sees a fresh speech_start event).

This module fills the gap. It is fed PCM audio frames between turns
(the same frames the outer voicechat WS handler routes into the
recorder + preroll buffer) and watches for sustained energy above a
threshold. When detected, it fires ``on_barge_in`` exactly once per
arming, and the caller is responsible for tearing down the in-flight
LLM/TTS task and signalling the client.

Why RMS energy instead of vad_speech:
    The design recommendation was to reuse the STT pod's vad_speech
    event. On closer inspection that requires keeping an STT WS open
    just to listen for VAD events — paying full transcription compute
    we never consume. UltraVAD only exposes ``p_end_of_turn`` (a
    turn-end probability), not a speech-present probability, so it
    doesn't help either. RMS over the same audio frames the recorder
    and preroll buffer already see is the cheapest signal that
    behaves the same way Silero does (energy-based VAD with smoothing
    + threshold).

Echo handling:
    When the agent's TTS plays through user's speakers, the mic picks
    up the bot's voice. Two guards keep us from firing on the echo:

      1. ``ignore_window_ms`` — drop the first N ms of arming. The
         loudest part of agent TTS is the speaking-onset transient
         (~200-500 ms). Most echo false-positives land there.
      2. ``required_consecutive_frames`` — require the signal to
         exceed threshold for N consecutive frames before firing.
         A single energy spike (mic bump, room reflection) doesn't
         survive.

    These are starting values; real-world tuning happens in
    production behind the feature flag.
"""
from __future__ import annotations

import asyncio
import logging
import math
import struct
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Optional

_log = logging.getLogger(__name__)


# Default RMS threshold (linear, 0.0-1.0 normalized). Anything above
# this on a 16-bit PCM frame is treated as a "loud" frame. Tuned for
# a typical mic gain — speech is usually 0.05-0.30 RMS, ambient noise
# 0.005-0.02, room silence 0.001-0.005. Override per-deployment via
# the env var so noisy environments don't have to recompile.
import os
_DEFAULT_RMS_THRESHOLD = float(os.environ.get("BARGE_IN_RMS_THRESHOLD") or "0.04")

# How many consecutive frames must exceed the threshold before we
# fire. 20 ms PCM frame * 6 frames = 120 ms of sustained speech. Long
# enough to filter taps / coughs / single-syllable backchannels;
# short enough that real speech crosses it well before any human
# perceives the agent is being slow to stop.
_REQUIRED_CONSECUTIVE_FRAMES = int(os.environ.get("BARGE_IN_REQUIRED_FRAMES") or "6")

# How long after the agent starts speaking before we begin watching
# for barge-in. Skips the agent-TTS attack transient (which is the
# loudest part) so echo of the bot's "Sure," doesn't trip the gate.
_IGNORE_WINDOW_MS = int(os.environ.get("BARGE_IN_IGNORE_WINDOW_MS") or "400")


def _rms_linear(pcm16le_bytes: bytes) -> float:
    """RMS of a PCM16LE little-endian mono frame, normalized to [0,1]
    against the int16 range. Empty frame → 0.0. Returns ``0.0`` if the
    frame length isn't an even number of bytes (malformed)."""
    n = len(pcm16le_bytes) // 2
    if n == 0:
        return 0.0
    samples = struct.unpack(f"<{n}h", pcm16le_bytes[: n * 2])
    sq_sum = 0.0
    for s in samples:
        sq_sum += (s / 32768.0) ** 2
    return math.sqrt(sq_sum / n)


@dataclass
class _ArmedState:
    """Per-arming state. Cleared on pause() and reset on each arm."""
    armed_at: float
    consecutive_loud: int = 0
    fired: bool = False


class BargeInListener:
    """Watches PCM audio between agent reply turns for sustained
    user speech. See module docstring for the full picture.

    Lifecycle (per call):
        listener = BargeInListener()
        # Session start: nothing yet — listener is idle.
        # When agent reply begins (LLM/TTS task created):
        listener.arm(on_barge_in)
        # Audio frames flow in via push_audio() — listener evaluates
        # each frame's RMS, increments / resets the sustained-loud
        # counter, fires the callback when threshold met.
        # When user actually interrupts (or agent finishes reply):
        listener.pause()
        # Repeat per turn. close() at session teardown.

    All public methods are safe to call from any task — the listener
    is event-driven, not its own coroutine, so no task management is
    needed.
    """

    def __init__(
        self,
        rms_threshold: float = _DEFAULT_RMS_THRESHOLD,
        required_consecutive_frames: int = _REQUIRED_CONSECUTIVE_FRAMES,
        ignore_window_ms: int = _IGNORE_WINDOW_MS,
    ) -> None:
        self.rms_threshold = rms_threshold
        self.required_frames = required_consecutive_frames
        self.ignore_window_ms = ignore_window_ms
        self._armed: _ArmedState | None = None
        self._on_barge_in: Optional[Callable[[], Awaitable[None]]] = None
        # Diagnostics — read by the voicechat trace logger.
        self._frames_seen: int = 0
        self._loud_frames_seen: int = 0
        self._last_rms: float = 0.0

    def arm(self, on_barge_in: Callable[[], Awaitable[None]]) -> None:
        """Begin watching for sustained loud audio. ``on_barge_in``
        is called exactly once if/when the signal crosses the threshold
        AFTER the ``ignore_window_ms`` warm-up period. Re-arming
        without an intervening ``pause()`` is a no-op (we don't reset
        the counter or change the callback)."""
        if self._armed is not None:
            return
        self._on_barge_in = on_barge_in
        self._armed = _ArmedState(armed_at=time.monotonic())
        self._frames_seen = 0
        self._loud_frames_seen = 0
        _log.debug("[barge_in] armed")

    def pause(self) -> None:
        """Stop watching. ``push_audio`` becomes a no-op until the
        next ``arm()``. Drops any in-progress sustained-loud counter
        so the next arming starts fresh."""
        if self._armed is None:
            return
        _log.debug(
            "[barge_in] paused (frames_seen=%d loud=%d fired=%s)",
            self._frames_seen, self._loud_frames_seen, self._armed.fired,
        )
        self._armed = None
        self._on_barge_in = None

    @property
    def is_armed(self) -> bool:
        return self._armed is not None

    @property
    def last_rms(self) -> float:
        """Most-recent frame's RMS, for telemetry / debug logs."""
        return self._last_rms

    def push_audio(self, pcm16le_frame: bytes) -> None:
        """Feed one PCM16LE mono frame. No-op when paused or already
        fired. Cheap — single RMS compute + counter update."""
        st = self._armed
        if st is None or st.fired:
            return
        self._frames_seen += 1
        rms = _rms_linear(pcm16le_frame)
        self._last_rms = rms
        if rms < self.rms_threshold:
            st.consecutive_loud = 0
            return
        self._loud_frames_seen += 1
        # Ignore-window guard: even loud frames in the first N ms
        # after arming don't count. This is where most agent-TTS
        # attack-transient false-positives land.
        elapsed_ms = (time.monotonic() - st.armed_at) * 1000.0
        if elapsed_ms < self.ignore_window_ms:
            return
        st.consecutive_loud += 1
        if st.consecutive_loud < self.required_frames:
            return
        # Threshold crossed — fire exactly once per arming.
        st.fired = True
        cb = self._on_barge_in
        _log.info(
            "[barge_in] FIRED rms=%.4f loud_streak=%d frames_seen=%d "
            "elapsed_ms=%.0f threshold=%.3f required=%d",
            rms, st.consecutive_loud, self._frames_seen, elapsed_ms,
            self.rms_threshold, self.required_frames,
        )
        if cb is not None:
            # Schedule the callback on the current loop. Caller is
            # responsible for whatever cancel + flush sequence
            # belongs to a barge-in.
            try:
                asyncio.get_event_loop().create_task(cb(), name="barge_in_cb")
            except RuntimeError:
                # No running loop in this thread — caller invoked
                # push_audio from a sync context. Skip; the next
                # frame on the loop will catch up.
                _log.warning("[barge_in] no running event loop; callback dropped")
