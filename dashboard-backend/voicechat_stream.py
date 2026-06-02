"""Streaming voice-turn session: fan-out audio to STT + turn-detection
pods and commit the turn using a server-side ensembler.

The voicechat WS router calls into this module when a client opens a
``stream_start`` turn. From there:

  client (WS, binary PCM @ 16 kHz mono s16le 20 ms frames)
                              │
                              ▼
                ┌─────────────────────────────┐
                │   StreamingTurnSession      │
                │                             │
                │   forward each frame to:    │
                │     ├─ STT pod /v1/stream   │
                │     │   (partials  ──► UI)  │
                │     │   (vad_silence_ms ──► ensembler)
                │     │   (final transcript)  │
                │     ├─ Smart Turn pod       │
                │     │   (smart_p ──► ensembler)
                │     └─ Turn Detector pod    │
                │         fed from partials   │
                │         (text_p ──► ensembler)
                │                             │
                │   tick → should_commit_turn │
                │   ↓ True                    │
                │   return final transcript   │
                └─────────────────────────────┘

The session is a one-turn lifecycle — call ``run()``, get back the
final transcript, then dispose. The caller (voicechat router) takes
the transcript and runs the same LLM+TTS pipeline as the one-shot
voice mode, so we don't duplicate any of that logic here.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

import aiohttp

from turn_detection_client import (
    SmartTurnStream,
    TurnDetectorStream,
    combine_eou,
    is_configured as turn_detection_available,
    should_commit_turn,
)


_log = logging.getLogger(__name__)


# Tick rate for the ensembler. 50 ms is fine — well below the 500 ms
# min endpointing delay so we always have a fresh decision when the
# user pauses.
ENSEMBLER_TICK_MS = 50

# Inactivity guard — if the client stops sending frames AND the
# ensembler never commits, we bail rather than hang the WS.
SESSION_HARD_TIMEOUT_S = 30.0

# When the client signals end-of-audio (its local Silero hit
# ``endSilenceMs``) we DO NOT immediately commit. If the EOU models
# aren't confident the user is done — e.g. their last partial ended on
# "em" / "uh" / a conjunction — we hold the turn open for up to this
# many additional ms before forcing a commit. The grace scales with
# how far below ``eou_threshold`` we are, capped at this value.
# Patient default: 6 s. Users hitting natural thinking-pauses ("hmm…
# what was I saying… oh right…") need real time to recover; 3 s wasn't
# enough. The fast path still commits in 0.6-1 s when EOU agrees, so
# this only adds latency to ambiguous turns where we'd rather wait.
DEFER_GRACE_BASE_MS = 6000

# Same threshold as ``should_commit_turn`` — kept in sync explicitly
# so the two decision points use identical EOU semantics. Raised to
# 0.75 alongside the longer grace so a borderline 0.65 Turn-Detector
# score (which fires often on partial-but-grammatical fragments like
# "I want to go to the store") no longer triggers fast-commit.
DEFER_EOU_THRESHOLD = 0.75

# Frame size the client is expected to send.
EXPECTED_FRAME_BYTES = 640  # 20 ms @ 16 kHz mono s16le


@dataclass
class StreamingSessionResult:
    """What the session returns when a turn commits."""
    transcript: str
    language: str | None
    duration_ms: int
    silence_at_commit_ms: int
    smart_turn_p_at_commit: float
    turn_detector_p_at_commit: float
    rule_fired: str


@dataclass
class _SignalState:
    """Latest values from each upstream — read every tick.

    A turn can span multiple pod-side utterances. The pod auto-emits a
    ``final`` after its internal silence threshold (default 800 ms per
    the STT spec), which resets its partial counter. We accumulate
    those finals into ``finals_accumulated`` so a long monologue with
    natural pauses doesn't end up as just the first segment. The
    ensembler — NOT the pod — decides when the turn is actually over.
    """
    smart_turn_p: float = 0.0
    turn_detector_p: float = 0.0
    silence_ms: int = 0
    last_speech_at_ms: int = 0
    partial_text: str = ""
    final_text: str = ""
    final_language: str | None = None
    history: list[dict] = field(default_factory=list)
    finals_accumulated: list[str] = field(default_factory=list)

    def running_transcript(self) -> str:
        """Composed text the client should see right now: every
        committed utterance from this turn plus the still-growing
        partial. Empty parts are skipped so we don't insert double
        spaces."""
        parts = [seg for seg in self.finals_accumulated if seg]
        if self.partial_text:
            parts.append(self.partial_text)
        return " ".join(parts).strip()


class StreamingTurnSession:
    """One turn of streaming audio → committed transcript.

    Caller (voicechat WS router) owns the client WS. This class only
    owns the three upstream pod WSs and the ensembler loop. It does
    NOT call the LLM — once a transcript commits, the caller runs the
    existing LLM+TTS pipeline.

    Usage:

        session = StreamingTurnSession(
            client_ws=client_ws,
            language=language_hint,
            history=conversation_history,
        )
        result = await session.run()
        if result is None:
            # Client gave up / disconnected
            return
        user_text_final = result.transcript
        ... (existing LLM+TTS pipeline)

    The session forwards STT partial transcripts to the client as
    ``{type: "partial_transcript", text: ...}`` messages — same shape
    the one-shot voice mode already emits, so existing UIs work
    unchanged.
    """

    def __init__(
        self,
        *,
        client_ws,
        language: str | None,
        history: list[dict],
        receive_binary: Callable[[], Awaitable[bytes | None]],
        send_json: Callable[[dict], Awaitable[None]],
    ) -> None:
        self._client_ws = client_ws
        self._language = language or "auto"
        self._history = history
        self._receive_binary = receive_binary
        self._send_json = send_json

        self._state = _SignalState(history=history)
        self._stt_session: aiohttp.ClientSession | None = None
        self._stt_ws: aiohttp.ClientWebSocketResponse | None = None
        self._smart: SmartTurnStream | None = None
        self._detector: TurnDetectorStream | None = None
        self._started_at = 0.0

    async def run(self) -> StreamingSessionResult | None:
        """Drive the turn end-to-end. Returns the committed transcript
        on success, or ``None`` if the session aborted (client
        disconnect, all upstream pods failed, etc.)."""
        self._started_at = time.perf_counter()
        # If no turn-detection pod is online, the ensembler degrades
        # to "silence-only" — caller could still get a useful turn
        # via STT alone, just without the EOU intelligence.
        if not turn_detection_available():
            _log.info("[stream] turn-detection pod offline — silence-only mode")

        try:
            ok = await self._open_upstreams()
            if not ok:
                await self._send_json({
                    "type": "error",
                    "code": "stt_unavailable",
                    "message": "speech-to-text pod is not available",
                })
                return None

            # Three concurrent tasks drive the session:
            #   * forward client frames to STT + Smart Turn
            #   * pump STT events (partials, vad, final)
            #   * tick the ensembler periodically
            # SmartTurnStream + TurnDetectorStream maintain their own
            # background readers, so we just poll their ``last_p_end_of_turn``
            # attribute from the ensembler — no extra pumps here.
            tasks = [
                asyncio.create_task(self._forward_frames(), name="forward"),
                asyncio.create_task(self._pump_stt(), name="pump_stt"),
                asyncio.create_task(self._ensembler_loop(), name="ensembler"),
            ]
            try:
                done, pending = await asyncio.wait(
                    tasks,
                    timeout=SESSION_HARD_TIMEOUT_S,
                    return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                for t in tasks:
                    if not t.done():
                        t.cancel()
                # Drain cancellations.
                for t in tasks:
                    try:
                        await asyncio.wait_for(t, timeout=2.0)
                    except (asyncio.CancelledError, asyncio.TimeoutError):
                        pass
                    except Exception as exc:  # noqa: BLE001
                        _log.warning("[stream] task %s raised: %s", t.get_name(), exc)

            # Compose from accumulator + last partial. Falls back to
            # ``final_text`` (which is the same join) or ``partial_text``
            # if no final ever arrived (super-short utterance committed
            # by the client before the pod auto-finalised).
            transcript = self._state.running_transcript()
            if not transcript:
                transcript = (self._state.final_text or self._state.partial_text).strip()
            if not transcript:
                return None

            return StreamingSessionResult(
                transcript=transcript,
                language=self._state.final_language or self._language,
                duration_ms=int((time.perf_counter() - self._started_at) * 1000),
                silence_at_commit_ms=self._state.silence_ms,
                smart_turn_p_at_commit=self._state.smart_turn_p,
                turn_detector_p_at_commit=self._state.turn_detector_p,
                rule_fired=getattr(self, "_commit_rule", "stream_ended"),
            )
        finally:
            await self._close_upstreams()

    # -----------------------------------------------------------------
    # Upstream setup / teardown
    # -----------------------------------------------------------------

    async def _open_upstreams(self) -> bool:
        """Open STT, Smart Turn, Turn Detector WSs in parallel.

        STT failure is fatal (no transcript = nothing to commit).
        Smart Turn / Turn Detector failures are tolerated — the
        ensembler degrades to silence-only on a missing signal.
        """
        # STT first — its handshake is the only one we can't degrade past.
        stt_ok = await self._open_stt()
        if not stt_ok:
            return False

        # The two turn-detection streams are best-effort.
        self._smart = SmartTurnStream(window_ms=4000, sample_rate=16000)
        self._detector = TurnDetectorStream(
            history=self._history,
            language=self._language if self._language != "auto" else "en",
        )
        results = await asyncio.gather(
            self._smart.start(), self._detector.start(),
            return_exceptions=True,
        )
        if not (isinstance(results[0], bool) and results[0]):
            _log.info("[stream] Smart Turn unavailable; degrading")
            self._smart = None
        if not (isinstance(results[1], bool) and results[1]):
            _log.info("[stream] Turn Detector unavailable; degrading")
            self._detector = None
        return True

    async def _open_stt(self) -> bool:
        """Open the streaming-STT WS with ``vad_events: true`` so the
        ensembler can use the pod's server-side VAD as the silence
        source of truth."""
        from ops import pool as gpu_pool
        try:
            if gpu_pool.online_pod_count("asr_streaming_rt") <= 0:
                return False
            pod_cm = gpu_pool.pick_pod("asr_streaming_rt")
        except Exception as exc:  # noqa: BLE001
            _log.warning("[stream] no STT pod: %s", exc)
            return False

        # NOTE: pick_pod returns a context manager that tracks in_flight
        # for the dispatcher's cap accounting. We need to keep it open
        # for the whole turn, so we enter it here and exit in close.
        try:
            self._stt_pod_cm = pod_cm
            pod = await pod_cm.__aenter__()
            base = pod.url.rstrip("/")
            ws_url = (
                "wss://" + base[len("https://"):] + "/v1/stream"
                if base.startswith("https://")
                else "ws://" + base[len("http://"):] + "/v1/stream"
            )
            headers = {"X-API-Key": pod.api_key} if pod.api_key else {}
            self._stt_session = aiohttp.ClientSession(headers=headers)
            self._stt_ws = await self._stt_session.ws_connect(
                ws_url,
                timeout=aiohttp.ClientWSTimeout(ws_close=15),
                max_msg_size=2 * 1024 * 1024,
            )
            await self._stt_ws.send_json({
                "type": "start",
                "language": self._language,
                "sample_rate": 16000,
                "encoding": "pcm_s16le",
                "enable_partials": True,
                "vad_events": True,
            })
            # Wait for ready.
            ready_msg = await asyncio.wait_for(self._stt_ws.receive(), timeout=10.0)
            if ready_msg.type != aiohttp.WSMsgType.TEXT:
                _log.warning("[stream] STT ready missing")
                return False
            data = json.loads(ready_msg.data)
            if data.get("type") != "ready":
                _log.warning("[stream] STT first msg not ready: %s", data)
                return False
            return True
        except Exception as exc:  # noqa: BLE001
            _log.warning("[stream] STT connect failed: %s", exc)
            await self._close_stt()
            return False

    async def _close_upstreams(self) -> None:
        await self._close_stt()
        if self._smart is not None:
            try:
                await self._smart.close()
            except Exception:
                pass
            self._smart = None
        if self._detector is not None:
            try:
                await self._detector.close()
            except Exception:
                pass
            self._detector = None

    async def _close_stt(self) -> None:
        if self._stt_ws is not None:
            try:
                if not self._stt_ws.closed:
                    await self._stt_ws.send_json({"type": "close"})
                await self._stt_ws.close()
            except Exception:
                pass
            self._stt_ws = None
        if self._stt_session is not None:
            try:
                await self._stt_session.close()
            except Exception:
                pass
            self._stt_session = None
        pod_cm = getattr(self, "_stt_pod_cm", None)
        if pod_cm is not None:
            try:
                await pod_cm.__aexit__(None, None, None)
            except Exception:
                pass
            self._stt_pod_cm = None

    # -----------------------------------------------------------------
    # Concurrent loops
    # -----------------------------------------------------------------

    async def _forward_frames(self) -> None:
        """Pull binary frames from the client WS and tee them to STT
        (mandatory) + Smart Turn (best-effort).

        On client-initiated commit, the client's local Silero VAD has
        merely *guessed* the user is done. We treat that as a hint:
          * EOU models confident → finalize immediately (fast reply).
          * EOU models unconfident → defer for ``DEFER_GRACE_BASE_MS``
            (scaled by how far below threshold). If PCM arrives during
            the defer the user has resumed — re-enter the forwarding
            loop. If the ensembler commits during the defer, we exit
            via the FIRST_COMPLETED cancellation. Otherwise force a
            commit when the grace expires.

        After finalize, BLOCK until the pod returns a final — without
        this wait, ``run()``'s ``FIRST_COMPLETED`` semantics fire as
        soon as this coroutine returns and cancel ``_pump_stt`` before
        it can read the final, leaving ``state.final_text`` empty and
        the turn committing with no transcript.
        """
        frames_in = 0
        bytes_in = 0
        while True:
            frame = await self._receive_binary()
            if frame is None:
                # Client signalled end of audio. Decide whether the
                # EOU models agree, or whether to defer.
                eou = combine_eou(
                    self._state.smart_turn_p,
                    self._state.turn_detector_p,
                )
                if eou >= DEFER_EOU_THRESHOLD:
                    _log.info(
                        "[stream] client commit honored (eou=%.2f >= %.2f) after %d frames / %d bytes",
                        eou, DEFER_EOU_THRESHOLD, frames_in, bytes_in,
                    )
                    await self._finalize_commit()
                    return

                resumed = await self._defer_commit(eou)
                if resumed is not None:
                    # User resumed speaking during the grace window —
                    # ``resumed`` is the next PCM frame; forward it and
                    # continue the main loop.
                    frame = resumed
                    frames_in += 1
                    bytes_in += len(frame)
                    if self._stt_ws is not None and not self._stt_ws.closed:
                        try:
                            await self._stt_ws.send_bytes(frame)
                        except Exception as exc:  # noqa: BLE001
                            _log.warning("[stream] STT send_bytes failed: %s", exc)
                    if self._smart is not None:
                        try:
                            await self._smart.send_pcm(frame)
                        except Exception:
                            pass
                    continue

                # Defer expired without resumption. Commit now even
                # though EOU never reached the threshold.
                _log.info(
                    "[stream] defer expired, forcing commit (eou=%.2f) after %d frames / %d bytes",
                    eou, frames_in, bytes_in,
                )
                await self._finalize_commit()
                return
            frames_in += 1
            bytes_in += len(frame)
            # Forward.
            if self._stt_ws is not None and not self._stt_ws.closed:
                try:
                    await self._stt_ws.send_bytes(frame)
                except Exception as exc:  # noqa: BLE001
                    _log.warning("[stream] STT send_bytes failed: %s", exc)
            if self._smart is not None:
                try:
                    await self._smart.send_pcm(frame)
                except Exception:
                    pass

    async def _defer_commit(self, eou_at_commit: float) -> bytes | None:
        """Hold the turn open after a low-EOU client commit. Scales the
        grace window with the EOU gap so a borderline commit (e.g. 0.6
        vs threshold 0.65) waits a brief moment while a clearly
        mid-thought commit (e.g. 0.1) waits the full base.

        Returns the next PCM frame if the user resumed speaking, or
        ``None`` if the grace expired or another commit arrived.
        """
        gap = max(0.0, DEFER_EOU_THRESHOLD - eou_at_commit)
        scale = gap / DEFER_EOU_THRESHOLD if DEFER_EOU_THRESHOLD > 0 else 1.0
        grace_ms = int(DEFER_GRACE_BASE_MS * scale)
        deadline = time.perf_counter() + (grace_ms / 1000.0)
        _log.info(
            "[stream] client commit deferred (eou=%.2f, grace=%dms)",
            eou_at_commit, grace_ms,
        )
        while True:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                return None
            # If the ensembler already produced a final transcript in
            # the background we don't need to keep waiting.
            if self._state.final_text:
                return None
            try:
                next_msg = await asyncio.wait_for(
                    self._receive_binary(), timeout=remaining,
                )
            except asyncio.TimeoutError:
                return None
            if next_msg is None:
                # Another commit during defer — keep waiting; the
                # client probably re-triggered after a tiny blip.
                continue
            _log.info("[stream] resumption detected during defer")
            return next_msg

    async def _finalize_commit(self) -> None:
        """Tell STT to flush the in-progress utterance and wait up to
        1.5 s for the pod to emit a NEW ``final`` (i.e. the accumulator
        must grow). Waiting on ``final_text`` non-emptiness would be
        wrong now that the accumulator persists across pod auto-finals
        — earlier finals would short-circuit the wait and the latest
        partial would never get flushed."""
        finals_before = len(self._state.finals_accumulated)
        if self._stt_ws is not None and not self._stt_ws.closed:
            try:
                await self._stt_ws.send_json({"type": "commit"})
            except Exception:
                pass
        deadline = time.perf_counter() + 1.5
        while (
            len(self._state.finals_accumulated) == finals_before
            and time.perf_counter() < deadline
        ):
            await asyncio.sleep(0.02)
        _log.info(
            "[stream] after finalize: running=%r segments=%d partial=%r",
            self._state.running_transcript()[:120],
            len(self._state.finals_accumulated),
            self._state.partial_text[:80],
        )

    async def _pump_stt(self) -> None:
        """Read events from STT — partials → client + detector,
        vad_silence → ensembler, final → accumulator.

        A pod ``final`` is NOT turn-end any more. The pod auto-commits
        a final after its internal silence threshold (~800 ms per the
        STT spec) and resets its partial counter; treating that as
        turn-end made any mid-utterance pause (a filler word, a breath)
        truncate everything that followed. We accumulate finals into
        ``finals_accumulated`` and the ensembler is the sole authority
        on when the turn actually ends.
        """
        ws = self._stt_ws
        if ws is None:
            return
        while True:
            try:
                msg = await ws.receive()
            except Exception:
                return
            if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSE):
                return
            if msg.type == aiohttp.WSMsgType.ERROR:
                return
            if msg.type != aiohttp.WSMsgType.TEXT:
                continue
            try:
                data = json.loads(msg.data)
            except Exception:
                continue
            mtype = data.get("type")
            if mtype == "partial":
                text = (data.get("text") or "").strip()
                if text:
                    self._state.partial_text = text
                    running = self._state.running_transcript()
                    _log.debug("[stream] STT partial: %r running=%r", text[:80], running[:80])
                    # Surface the COMPOSED transcript so the client
                    # sees a stable, monotonically-growing string even
                    # when the pod resets partials after auto-finals.
                    try:
                        await self._send_json({"type": "partial_transcript", "text": running})
                    except Exception:
                        pass
                    # Feed text-EOU with the FULL running transcript —
                    # otherwise it'd be deciding "is this complete?" on
                    # just the last segment instead of the whole turn.
                    if self._detector is not None:
                        try:
                            await self._detector.send_token(running)
                        except Exception:
                            pass
            elif mtype == "final":
                text = (data.get("text") or "").strip()
                if text:
                    self._state.finals_accumulated.append(text)
                    # ``final_text`` stays meaningful for the commit
                    # waiters — it's the composed running transcript.
                    self._state.final_text = " ".join(
                        seg for seg in self._state.finals_accumulated if seg
                    ).strip()
                lang = data.get("language_detected")
                if lang:
                    self._state.final_language = lang
                _log.info(
                    "[stream] STT pod final: %r (segments=%d)",
                    text[:120], len(self._state.finals_accumulated),
                )
                # Pod resets its partial counter after a final, so we
                # reset ours too. Crucially we DON'T return / DON'T set
                # silence_ms — the ensembler decides turn-end.
                self._state.partial_text = ""
                # Push the updated running transcript to the client so
                # the bubble doesn't flicker to empty between utterances.
                try:
                    await self._send_json({
                        "type": "partial_transcript",
                        "text": self._state.running_transcript(),
                    })
                except Exception:
                    pass
            elif mtype == "vad_speech":
                if self._state.silence_ms != 0:
                    _log.debug("[stream] vad_speech (was silent %dms)", self._state.silence_ms)
                self._state.silence_ms = 0
            elif mtype == "vad_silence":
                # Pod gives us cumulative silence_ms since last speech.
                self._state.silence_ms = int(data.get("silence_ms") or 0)
            elif mtype == "error":
                _log.warning(
                    "[stream] STT pod error: %s",
                    data.get("message") or data.get("code"),
                )
                return
            else:
                _log.debug("[stream] STT msg type=%r data=%r", mtype, str(data)[:200])

    async def _ensembler_loop(self) -> None:
        """Tick every ENSEMBLER_TICK_MS and decide whether to commit.

        Reads the latest probabilities from each turn-detection stream's
        ``last_p_end_of_turn`` attribute (kept fresh by each stream's
        own background reader task)."""
        tick_s = ENSEMBLER_TICK_MS / 1000.0
        while True:
            await asyncio.sleep(tick_s)
            if self._smart is not None:
                self._state.smart_turn_p = float(self._smart.last_p_end_of_turn)
            if self._detector is not None:
                self._state.turn_detector_p = float(self._detector.last_p_end_of_turn)
            commit, rule = should_commit_turn(
                silence_ms=self._state.silence_ms,
                smart_turn_p=self._state.smart_turn_p,
                turn_detector_p=self._state.turn_detector_p,
            )
            if commit:
                self._commit_rule = rule
                _log.info(
                    "[stream] commit rule=%s silence=%dms smart=%.2f td=%.2f",
                    rule, self._state.silence_ms,
                    self._state.smart_turn_p, self._state.turn_detector_p,
                )
                # Tell STT to commit so we get the cleaned-up final
                # rather than relying on the last partial.
                finals_before = len(self._state.finals_accumulated)
                if self._stt_ws is not None and not self._stt_ws.closed:
                    try:
                        await self._stt_ws.send_json({"type": "commit"})
                    except Exception:
                        pass
                # Wait for the accumulator to grow by one — older finals
                # from mid-turn auto-commits already populate it, so a
                # bare ``final_text`` check would short-circuit before
                # the current segment gets flushed.
                deadline = time.perf_counter() + 1.0
                while (
                    len(self._state.finals_accumulated) == finals_before
                    and time.perf_counter() < deadline
                ):
                    await asyncio.sleep(0.02)
                return
