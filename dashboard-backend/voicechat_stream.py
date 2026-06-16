"""Streaming voice-turn session: STT + turn-detection ensembler.

Direct port of the working stt-streaming demo (``examples/mic_proxy.py``)
into the voicechat WS path. The ensembler runs the SAME fusion the demo
uses — a text-weighted completeness score that sets an adaptive
required-silence in [MIN_DELAY_MS, MAX_DELAY_MS]. See
``turn_detection_client.py`` for the math + env knobs.

Per turn we open:

  * one WS to the STT pod (``/v1/stream``) for transcripts + VAD events
  * one WS to the Smart-Turn pod (``/v1/smart-turn``) for prosody p
  * one HTTP client to the Turn-Detector pod (``/v1/turn-detector/batch``)
    for fresh semantic confidence on every text change

…and run four concurrent loops:

  * ``_forward_frames`` — pull PCM from the client, tee to STT + Smart-Turn
                           (drops frames while the bot's TTS is playing so
                           the bot doesn't transcribe its own voice through
                           the user's speakers — see ``is_bot_speaking``)
  * ``_pump_stt``       — read STT events; update partial/finals; mark voice
  * ``_text_scorer``    — POST current text to TD batch when it changes
  * ``_decision_watch`` — tick at ENSEMBLER_TICK_MS; call decide_commit;
                           fire turn-end when the fusion says so

The caller (voicechat WS router) owns the client WS. This module never
calls the LLM — once a transcript commits, the caller runs the existing
LLM+TTS pipeline.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from dataclasses import dataclass, field
from contextlib import suppress
from typing import Any, Awaitable, Callable

import aiohttp

from turn_detection_client import (
    SmartTurnStream,
    TurnDetectorScorer,
    is_configured as turn_detection_available,
    decide_commit,
    completeness as fuse_completeness,
    MIN_DELAY_MS,
    MAX_DELAY_MS,
)
from ultravad_client import (
    UltraVADStream,
    is_configured as ultravad_available,
)
from denoiser_client import (
    DenoiserPipe,
    is_configured as denoiser_available,
)


_log = logging.getLogger(__name__)


# Ensembler tick. 120 ms matches the demo; well below MIN_DELAY_MS (500
# ms) so the decision is always fresh when the user actually pauses.
ENSEMBLER_TICK_MS = 120

# Inactivity guard — if the client stops sending frames AND the
# ensembler never commits, we bail rather than hang the WS forever.
SESSION_HARD_TIMEOUT_S = 30.0

# Frame size the client is expected to send. Currently unused (we
# accept whatever the client sends and tee it). Kept here for docs.
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
    turn_detector_confidence_at_commit: float
    rule_fired: str


@dataclass
class _SignalState:
    """Latest values from each upstream — read every ensembler tick.

    A turn can span multiple STT pod-side utterances. The pod auto-emits
    a ``final`` after its internal silence threshold (~800 ms) and resets
    its partial counter. We accumulate those finals so a long monologue
    with natural pauses doesn't end up as just the first segment. The
    ensembler — not the pod — decides when the turn is actually over.
    """
    smart_turn_p: float = 0.0
    turn_detector_p: float = 0.0
    turn_detector_confidence: float = 0.0
    partial_text: str = ""
    final_language: str | None = None
    history: list[dict] = field(default_factory=list)
    finals_accumulated: list[str] = field(default_factory=list)
    # Silence clock — wall-clock since the last speech evidence
    # (``partial`` or ``vad_speech``). A ``final`` deliberately does NOT
    # reset this: a final arrives ~800 ms AFTER the pause that produced
    # it, so counting it as voice would wrongly extend the turn.
    last_voice_at: float = field(default_factory=time.monotonic)
    turn_active: bool = False

    def running_transcript(self) -> str:
        parts = [seg for seg in self.finals_accumulated if seg]
        if self.partial_text:
            parts.append(self.partial_text)
        return " ".join(parts).strip()

    def silence_ms(self) -> int:
        return int((time.monotonic() - self.last_voice_at) * 1000)


class StreamingTurnSession:
    """One turn of streaming audio → committed transcript.

    The caller owns the browser/client WS. This class owns:
      * STT pod WS (``/v1/stream``)
      * Smart-Turn pod WS (``/v1/smart-turn``)
      * Turn-Detector HTTP client (``/v1/turn-detector/batch``)
      * the four concurrent loops above

    On commit, returns a :class:`StreamingSessionResult`. On client
    disconnect or all-upstreams-failed, returns ``None`` — the caller
    surfaces that as an error to the client and doesn't run LLM/TTS.
    """

    def __init__(
        self,
        *,
        client_ws,
        language: str | None,
        history: list[dict],
        receive_binary: Callable[[], Awaitable[bytes | None]],
        send_json: Callable[[dict], Awaitable[None]],
        user_id: str | None = None,
        client_hints: dict[str, bool] | None = None,
        is_bot_speaking: Callable[[], bool] | None = None,
        # Per-agent voice-pipeline config (see AgentConfigIn).
        denoise_enabled: bool = False,
        turn_decider: str = "fusion",
        ultravad_threshold: float = 0.55,
        # Optional STT pod WS prewarmed at session-open. When present,
        # _open_stt adopts it instead of cold-connecting — saves the
        # full TLS + WS handshake + STT-pod-ready round trip (~200–500
        # ms) on the user's first turn. Dict shape:
        # {"pod_cm", "session", "ws", "language"}.
        prewarmed_stt: dict | None = None,
        # Optional CallRecorder (from call_recorder.py). When set, the
        # user-leg PCM frames forwarded to STT are also teed into the
        # recorder's left channel. Mute-gate-dropped and pre-denoise
        # frames are NOT captured — the recording reflects what STT
        # actually heard.
        call_recorder: Any | None = None,
        # Optional list of recent client mic frames captured by the
        # voicechat router's top-level loop while no stream session
        # was active. We flush these into STT + Smart-Turn + UltraVAD
        # at startup so the user's first words of a barge-in (the ones
        # spoken BEFORE the client's ``cancel`` could reach the server
        # and a new session could be created) end up in the transcript
        # and the ensembler's turn-end probability — not silently
        # dropped. Each entry is 16 kHz mono s16le PCM, same shape STT
        # expects. See the router's ``preroll_buf`` for the source.
        preroll_frames: list[bytes] | None = None,
    ) -> None:
        self._client_ws = client_ws
        self._language = language or "auto"
        self._history = history
        self._receive_binary = receive_binary
        self._send_json = send_json
        self._user_id = user_id
        # Reserved for future client→server commit hints. The ensembler
        # is the sole authority on turn-end so the hint is informational
        # only; we leave the slot here for backwards compatibility.
        self._client_hints = client_hints if client_hints is not None else {}
        # Mic-mute gate: while True, DROP incoming PCM frames so the STT
        # pod doesn't transcribe bot TTS echoing through the user's
        # speakers. We still read frames from the client WS so its recv
        # buffer doesn't fill up — they're just discarded server-side.
        self._is_bot_speaking = is_bot_speaking
        self._muted_frames_dropped = 0
        self._last_muted_log_at = 0.0
        # Per-agent pipeline config — resolved at construction time so
        # config can't drift mid-turn (the dashboard reloads agent config
        # only between sessions).
        self._denoise_enabled = bool(denoise_enabled)
        self._turn_decider = turn_decider if turn_decider in ("ultravad", "fusion") else "fusion"
        self._ultravad_threshold = float(ultravad_threshold)

        self._session_id = uuid.uuid4().hex[:12]
        self._state = _SignalState(history=history)
        self._stt_session: aiohttp.ClientSession | None = None
        self._stt_ws: aiohttp.ClientWebSocketResponse | None = None
        # The fusion path (Smart Turn + LiveKit batch). Always opened
        # so it can serve as the fallback when UltraVAD is the primary
        # decider but the UltraVAD pod is unhealthy/offline; degrades
        # to "open but not consulted" otherwise — cheap.
        self._smart: SmartTurnStream | None = None
        self._td_scorer: TurnDetectorScorer | None = None
        # The UltraVAD path. ``None`` when the pod is offline or the
        # agent picked fusion; then we fall back to fusion's decide_commit.
        self._ultravad: UltraVADStream | None = None
        # Optional denoise pipe in front of STT + UltraVAD. ``None``
        # when off or pod offline → raw PCM forwarded as today.
        self._denoiser: DenoiserPipe | None = None
        self._started_at = 0.0
        self._commit_rule: str = "stream_ended"
        self._closed = asyncio.Event()
        # Stashed at construction, consumed (or discarded) in _open_stt.
        self._prewarmed_stt = prewarmed_stt
        # Recorder lives for the SESSION (multiple turns), so storing
        # by reference is intentional — multiple StreamingTurnSession
        # instances over one call all push into the same recorder.
        self._call_recorder = call_recorder
        # Frames captured by the router BEFORE this session existed
        # (between the end of the prior turn's commit and the
        # creation of this session). We flush them once at the top
        # of run() so STT sees the user's barge-in from its first
        # word, not from whenever the client managed to get
        # ``stream_start`` across the wire.
        self._preroll_frames = list(preroll_frames or [])

    # -----------------------------------------------------------------
    # Lifecycle
    # -----------------------------------------------------------------

    async def run(self) -> StreamingSessionResult | None:
        self._started_at = time.perf_counter()
        if not turn_detection_available():
            _log.info("[stream] turn-detection pod offline — silence-only mode")

        try:
            if not await self._open_upstreams():
                await self._send_json({
                    "type": "error",
                    "code": "stt_unavailable",
                    "message": "speech-to-text pod is not available",
                })
                return None

            # Flush any pre-roll the router captured while this session
            # was being created. Each frame is 16 kHz mono s16le, the
            # exact shape STT / Smart-Turn / UltraVAD expect. We push
            # them in order BEFORE _forward_frames starts so the
            # ensembler's silence clock and the STT pod's partials
            # already reflect the barge-in onset by the time the loop
            # spins up.
            #
            # We deliberately DO NOT push these to the call_recorder
            # here — the router's top-level binary-frame handler
            # already pushed every one of these frames to the recorder
            # when it received them from the client. Pushing again
            # would double-record on the user channel of the WAV.
            # _mark_voice is called once so the ensembler's silence
            # clock starts from "user is currently speaking", which
            # is accurate (pre-roll IS the leading edge of the user's
            # barge-in utterance).
            if self._preroll_frames:
                _log.info(
                    "[stream] trace session=%s phase=preroll_flush frames=%d ms~=%d",
                    self._session_id, len(self._preroll_frames),
                    sum(len(f) for f in self._preroll_frames) // 32,
                )
                self._mark_voice()
                for f in self._preroll_frames:
                    if self._stt_ws is not None and not self._stt_ws.closed:
                        try:
                            await self._stt_ws.send_bytes(f)
                        except Exception:
                            pass
                    if self._smart is not None:
                        try:
                            await self._smart.send_pcm(f)
                        except Exception:
                            pass
                    if self._ultravad is not None:
                        try:
                            await self._ultravad.send_pcm(f)
                        except Exception:
                            pass
                self._preroll_frames = []

            tasks = [
                asyncio.create_task(self._forward_frames(), name="forward"),
                asyncio.create_task(self._pump_stt(), name="pump_stt"),
                asyncio.create_task(self._text_scorer(), name="text_scorer"),
                asyncio.create_task(self._decision_watch(), name="decision_watch"),
            ]
            try:
                done, _pending = await asyncio.wait(
                    tasks,
                    timeout=SESSION_HARD_TIMEOUT_S,
                    return_when=asyncio.FIRST_COMPLETED,
                )
            finally:
                self._closed.set()
                for t in tasks:
                    if not t.done():
                        t.cancel()
                for t in tasks:
                    try:
                        await asyncio.wait_for(t, timeout=2.0)
                    except (asyncio.CancelledError, asyncio.TimeoutError):
                        pass
                    except Exception as exc:  # noqa: BLE001
                        _log.warning("[stream] task %s raised: %s", t.get_name(), exc)

            transcript = self._state.running_transcript()
            if not transcript:
                return None

            result = StreamingSessionResult(
                transcript=transcript,
                language=self._state.final_language or self._language,
                duration_ms=int((time.perf_counter() - self._started_at) * 1000),
                silence_at_commit_ms=self._state.silence_ms(),
                smart_turn_p_at_commit=self._state.smart_turn_p,
                turn_detector_p_at_commit=self._state.turn_detector_p,
                turn_detector_confidence_at_commit=self._state.turn_detector_confidence,
                rule_fired=self._commit_rule,
            )
            _log.info("[stream] turn_metrics %s", json.dumps({
                "session_id": self._session_id,
                "user_id": self._user_id,
                "rule": result.rule_fired,
                "silence_ms": result.silence_at_commit_ms,
                "smart_p": round(result.smart_turn_p_at_commit, 3),
                "td_p": round(result.turn_detector_p_at_commit, 4),
                "conf_text": round(result.turn_detector_confidence_at_commit, 2),
                "completeness": round(fuse_completeness(
                    p_audio=result.smart_turn_p_at_commit,
                    conf_text=result.turn_detector_confidence_at_commit,
                ), 3),
                "duration_ms": result.duration_ms,
                "language": result.language,
                "transcript": result.transcript,
            }))
            return result
        finally:
            await self._close_upstreams()

    # -----------------------------------------------------------------
    # Upstream setup / teardown
    # -----------------------------------------------------------------

    async def _open_upstreams(self) -> bool:
        if not await self._open_stt():
            return False

        # Up to 4 upstream connections per turn, all opened in parallel:
        #
        #   STT pod           — mandatory (already opened above)
        #   Smart Turn pod    — fusion-path prosody (best effort)
        #   TurnDetector pod  — fusion-path semantics (best effort)
        #   UltraVAD pod      — primary turn decider (best effort)
        #   Denoiser pod      — optional per-agent (off by default)
        #
        # Each "best effort" upstream degrades to ``None`` on failure;
        # the decider in ``_decision_watch`` knows which signal is live.
        # We always open BOTH the UltraVAD path and the fusion path so
        # we can fall back instantly if the primary goes unhealthy
        # mid-turn (no reconnect on the hot path).
        opens: list = []
        # Fusion path (existing).
        self._smart = SmartTurnStream(window_ms=4000, sample_rate=16000)
        self._td_scorer = TurnDetectorScorer()
        opens.extend([("smart", self._smart.start()), ("td", self._td_scorer.start())])
        # UltraVAD path (new). Always opened, regardless of decider
        # choice — it acts as the live observer in shadow mode when
        # the agent picked "fusion", or as the primary when "ultravad".
        if ultravad_available():
            self._ultravad = UltraVADStream(window_ms=4000, sample_rate=16000)
            opens.append(("ultravad", self._ultravad.start()))
        # Denoiser path (new, per-agent flag).
        if self._denoise_enabled and denoiser_available():
            self._denoiser = DenoiserPipe(block_ms=200)
            opens.append(("denoiser", self._denoiser.start()))

        names = [n for n, _ in opens]
        results = await asyncio.gather(
            *(coro for _, coro in opens), return_exceptions=True,
        )
        for name, res in zip(names, results):
            ok = isinstance(res, bool) and res
            if not ok:
                _log.info("[stream] %s unavailable; degrading", name)
                if name == "smart":
                    self._smart = None
                elif name == "td":
                    self._td_scorer = None
                elif name == "ultravad":
                    self._ultravad = None
                elif name == "denoiser":
                    self._denoiser = None
        return True

    async def _open_stt(self) -> bool:
        # Fast path: adopt a socket the session layer prewarmed during
        # the greeting. The prewarm already sent ``start`` and got
        # ``ready`` AND has been pumping silence frames to keep the
        # pod's inference path warm. By the time we get here, the
        # pod is hot — first partial / vad_speech event arrives in
        # tens of ms instead of seconds. We just take ownership; no
        # WS messages to send, no round-trip to wait on.
        pw = self._prewarmed_stt
        self._prewarmed_stt = None
        if pw is not None:
            pw_ws = pw.get("ws")
            pw_lang = pw.get("language")
            if (
                pw_ws is not None
                and not pw_ws.closed
                and pw_lang == self._language
            ):
                self._stt_pod_cm = pw["pod_cm"]
                self._stt_session = pw["session"]
                self._stt_ws = pw_ws
                _log.info(
                    "[stream] trace session=%s phase=stt_adopted_prewarm lang=%r",
                    self._session_id, self._language,
                )
                return True
            # Mismatch or socket died — release resources, then
            # cold-open. Logs the reason so we know which case fired.
            with suppress(Exception):
                if pw_ws is not None:
                    await pw_ws.close()
            with suppress(Exception):
                await pw["session"].close()
            with suppress(Exception):
                await pw["pod_cm"].__aexit__(None, None, None)
            _log.info(
                "[stream] trace session=%s phase=stt_prewarm_unused "
                "reason=%s pw_lang=%r want=%r",
                self._session_id,
                "lang_mismatch" if pw_lang != self._language else "socket_closed",
                pw_lang, self._language,
            )

        from ops import pool as gpu_pool
        try:
            if gpu_pool.online_pod_count("asr_streaming_rt") <= 0:
                return False
            pod_cm = gpu_pool.pick_pod("asr_streaming_rt")
        except Exception as exc:  # noqa: BLE001
            _log.warning("[stream] no STT pod: %s", exc)
            return False

        # pick_pod returns a context manager that tracks in_flight for
        # the dispatcher's cap accounting. We hold it open for the whole
        # turn — entered here, exited in _close_stt.
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
        for attr, name in (
            ("_smart", "smart-turn"),
            ("_td_scorer", "turn-detector"),
            ("_ultravad", "ultravad"),
            ("_denoiser", "denoiser"),
        ):
            obj = getattr(self, attr, None)
            if obj is None:
                continue
            try:
                await obj.close()
            except Exception:  # noqa: BLE001
                _log.debug("[stream] close %s raised", name, exc_info=True)
            setattr(self, attr, None)

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

    def _mark_voice(self) -> None:
        """Speech evidence arrived — reset the silence clock and mark
        the turn as active. Called on every ``partial`` and ``vad_speech``
        from the STT pod. A ``final`` deliberately does NOT call this:
        finals arrive after the pause that produced them, so they would
        wrongly extend the turn.
        """
        self._state.turn_active = True
        self._state.last_voice_at = time.monotonic()

    async def _forward_frames(self) -> None:
        """Pull binary frames from the client WS, optionally denoise,
        and tee them to STT + the audio-EOU paths (Smart-Turn for the
        fusion ensembler, UltraVAD for the primary decider).

        Mute-gate first: frames dropped here NEVER reach the denoiser
        either (cheaper to drop here than after a network hop), and
        they never reach UltraVAD (which would otherwise spend GPU
        cycles inferring on bot-TTS echo)."""
        while True:
            frame = await self._receive_binary()
            if frame is None:
                self._closed.set()
                return
            # Mic-mute gate — see __init__ docstring. Frames are
            # dropped from STT / Smart-Turn / UltraVAD so bot-TTS
            # echo leaking back into the mic doesn't trigger false
            # barge-ins or waste GPU cycles.
            #
            # BUT we still tee them to the recorder. Modern browsers
            # run acoustic echo cancellation before sending PCM, so
            # the residual echo on the recording is minimal — much
            # less of a problem than losing the first ~200-500 ms of
            # every barge-in utterance. Without this push, the user
            # channel of the WAV cuts off the leading edge of every
            # mid-bot-speech interruption: the recording felt like
            # "the start of what I said is missing, by 1-2 s".
            if self._is_bot_speaking is not None and self._is_bot_speaking():
                if self._call_recorder is not None:
                    self._call_recorder.push_user(frame)
                self._muted_frames_dropped += 1
                now = time.monotonic()
                if now - self._last_muted_log_at >= 1.0:
                    self._last_muted_log_at = now
                    _log.info(
                        "[stream] trace session=%s phase=mic_muted dropped=%d (bot speaking, recorder still capturing)",
                        self._session_id, self._muted_frames_dropped,
                    )
                continue

            # Compute the frames to forward downstream. With denoise
            # enabled, one input PCM chunk yields 0..N denoised output
            # chunks (the pod blocks at ~200 ms boundaries); without
            # denoise, it's 1:1.
            if self._denoiser is not None:
                try:
                    out_frames = await self._denoiser.process(frame)
                except Exception as exc:  # noqa: BLE001
                    _log.warning("[stream] denoiser process failed: %s", exc)
                    out_frames = [frame]  # fall back to raw on transient error
            else:
                out_frames = [frame]

            for f in out_frames:
                # Tee to the recorder FIRST (before STT) — captures the
                # exact bytes STT will see, including denoise output if
                # enabled. Cheap; the recorder's push_user is a list
                # append + counter bump.
                if self._call_recorder is not None:
                    self._call_recorder.push_user(f)
                if self._stt_ws is not None and not self._stt_ws.closed:
                    try:
                        await self._stt_ws.send_bytes(f)
                    except Exception as exc:  # noqa: BLE001
                        _log.warning("[stream] STT send_bytes failed: %s", exc)
                if self._smart is not None:
                    try:
                        await self._smart.send_pcm(f)
                    except Exception:
                        pass
                if self._ultravad is not None:
                    try:
                        await self._ultravad.send_pcm(f)
                    except Exception:
                        pass

    async def _pump_stt(self) -> None:
        """Read STT events; update partial/finals/silence clock."""
        ws = self._stt_ws
        if ws is None:
            return
        while True:
            try:
                msg = await ws.receive()
            except Exception:
                self._closed.set()
                return
            if msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.CLOSE):
                self._closed.set()
                return
            if msg.type == aiohttp.WSMsgType.ERROR:
                self._closed.set()
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
                if not text:
                    continue
                # Partials replace, not accumulate. STT pods routinely
                # emit hypotheses that grow AND shrink as the model
                # refines its transcription of the same utterance —
                # earlier attempts to detect "implicit utterance
                # boundary" from a shorter partial would commit those
                # rewrites as separate finals and the caption ended up
                # as 10 concatenated rewrites of one spoken sentence.
                # The pod is the authority on utterance boundaries; it
                # signals them via ``final``. Trust that.
                self._state.partial_text = text
                self._mark_voice()
                running = self._state.running_transcript()
                _log.info(
                    "[stream] trace session=%s phase=stt_partial text=%r running=%r",
                    self._session_id, text[:120], running[:120],
                )
                try:
                    await self._send_json({"type": "partial_transcript", "text": running})
                except Exception:
                    pass
            elif mtype == "final":
                text = (data.get("text") or "").strip()
                if text:
                    self._state.finals_accumulated.append(text)
                self._state.partial_text = ""
                lang = data.get("language_detected")
                if lang:
                    self._state.final_language = lang
                _log.info(
                    "[stream] trace session=%s phase=stt_final new=%r accumulator=%r",
                    self._session_id, text[:120],
                    [seg[:60] for seg in self._state.finals_accumulated],
                )
                try:
                    await self._send_json({
                        "type": "partial_transcript",
                        "text": self._state.running_transcript(),
                    })
                except Exception:
                    pass
            elif mtype == "vad_speech":
                self._mark_voice()
            elif mtype == "vad_silence":
                # The demo doesn't use the pod's silence_ms field — the
                # ensembler computes silence as wall-clock since the last
                # ``partial`` / ``vad_speech`` instead. We log the pod's
                # reading as a diagnostic only.
                pass
            elif mtype == "error":
                _log.warning(
                    "[stream] STT pod error: %s",
                    data.get("message") or data.get("code"),
                )
                self._closed.set()
                return

    async def _text_scorer(self) -> None:
        """Re-score the in-progress turn text whenever it changes.

        Polls the running transcript every 80 ms. Only fires an HTTP
        POST when the text actually changes — typically every ~150-300
        ms while the user is speaking. This is the BATCH path; see the
        module docstring on ``turn_detection_client`` for why we don't
        use the WS path (stale ``confidence`` bug).

        IMPORTANT: this coroutine MUST live as long as the session,
        even when there's no TD scorer to call. The session's
        ``asyncio.wait(..., return_when=FIRST_COMPLETED)`` tears down
        all four tasks the moment any one of them returns; an early
        return here would kill the session in ~0 ms before any voice
        could be committed. So when there's no scorer, idle on the
        ``_closed`` event instead of returning."""
        if self._td_scorer is None:
            await self._closed.wait()
            return
        last_scored: str | None = None
        while not self._closed.is_set():
            await asyncio.sleep(0.08)
            txt = self._state.running_transcript()
            if txt == last_scored:
                continue
            last_scored = txt
            if not txt:
                self._state.turn_detector_p = 0.0
                self._state.turn_detector_confidence = 0.0
                continue
            score = await self._td_scorer.score(txt)
            if score is not None:
                self._state.turn_detector_p = score.p_end_of_turn
                self._state.turn_detector_confidence = score.confidence

    async def _decision_watch(self) -> None:
        """Tick at ENSEMBLER_TICK_MS; fire commit when the fusion says so.

        Two deciders coexist on every tick:

          * **Primary**: the agent-configured ``turn_decider`` —
            ``ultravad`` if the UltraVAD pod is live, else ``fusion``.
            Its verdict is what actually commits the turn.
          * **Shadow**: the OTHER decider runs alongside, observed only.
            Its verdict is logged as ``shadow_*`` fields in the trace
            so we can audit drift in production logs.

        That gives the rollout a free dataset: switch an agent's
        decider in config, watch the trace, validate. No re-deploy
        cycle for A/B comparisons."""
        tick_s = ENSEMBLER_TICK_MS / 1000.0
        td_available = self._td_scorer is not None
        st_available = self._smart is not None
        uv_available = self._ultravad is not None
        # Effective decider — if the configured primary isn't live,
        # silently fall back to the other one. The trace records what
        # actually ran so this never goes unnoticed.
        # Auto-fallback: configured decider → whichever path is actually
        # available on this fleet. Both directions matter:
        #
        #   * Configured ultravad but pod offline → use fusion if its
        #     pods are up.
        #   * Configured fusion but neither smart-turn NOR td pods are
        #     up → use ultravad if its pod is up. (This is the common
        #     case on fleets where only UltraVAD is deployed — fusion
        #     is the AgentConfigIn default but the fusion pods may not
        #     exist yet.)
        #   * Nothing live at all → log + degrade to "fusion" so the
        #     fusion ensembler's silence-only path can at least time
        #     out at MAX_DELAY_MS. Better than hanging forever.
        effective_decider = self._turn_decider
        fusion_signals_live = td_available or st_available
        if effective_decider == "ultravad" and not uv_available:
            effective_decider = "fusion"
        elif effective_decider == "fusion" and not fusion_signals_live and uv_available:
            effective_decider = "ultravad"
        _log.info(
            "[stream] trace session=%s phase=ensembler_start "
            "decider=%s configured=%s td_available=%s smart_available=%s "
            "ultravad_available=%s denoise=%s lang=%s history=%d "
            "min_delay=%dms max_delay=%dms uv_threshold=%.2f",
            self._session_id, effective_decider, self._turn_decider,
            td_available, st_available, uv_available,
            self._denoiser is not None,
            self._language, len(self._history),
            MIN_DELAY_MS, MAX_DELAY_MS, self._ultravad_threshold,
        )

        last_log_at = 0.0
        while not self._closed.is_set():
            await asyncio.sleep(tick_s)
            if not self._state.turn_active:
                continue

            # Snapshot the latest signals (fusion + ultravad).
            if self._smart is not None:
                self._state.smart_turn_p = float(self._smart.last_p_end_of_turn)
            silence_ms = self._state.silence_ms()
            ultravad_p = (
                float(self._ultravad.last_p_end_of_turn)
                if self._ultravad is not None else 0.0
            )

            # Run BOTH deciders every tick — the shadow one is cheap
            # and gives us drift data for free.
            fusion_d = decide_commit(
                silence_ms=silence_ms,
                p_audio=self._state.smart_turn_p,
                conf_text=self._state.turn_detector_confidence,
            )
            # UltraVAD path: TWO commit conditions, like fusion has.
            #
            #   1. Threshold crossing — UltraVAD strongly says "done"
            #      (rule="ultravad"). This is the snappy path: short
            #      sentences typically cross 0.4 within ~400 ms of
            #      silence.
            #   2. Silence backstop — even if UltraVAD's probability
            #      never crosses the threshold (which we observed on
            #      short questions like "What do you mean?", where uv_p
            #      oscillated 0.04–0.35 for 12 s before crossing), we
            #      MUST eventually commit. MAX_DELAY_MS is the hard cap
            #      (rule="silence" so it's logged as different from a
            #      confident UltraVAD commit). Without this the turn
            #      hangs until SESSION_HARD_TIMEOUT_S kills the WS.
            uv_threshold_crossed = (
                uv_available
                and silence_ms >= MIN_DELAY_MS
                and ultravad_p >= self._ultravad_threshold
            )
            uv_backstop_hit = uv_available and silence_ms >= MAX_DELAY_MS
            ultravad_commits = uv_threshold_crossed or uv_backstop_hit

            if effective_decider == "ultravad":
                committed = ultravad_commits
                if committed:
                    rule = "ultravad" if uv_threshold_crossed else "silence"
                else:
                    rule = ""
                shadow_label = "fusion"
                shadow_committed = fusion_d.should_commit
                shadow_rule = fusion_d.rule if shadow_committed else ""
            else:
                committed = fusion_d.should_commit
                rule = fusion_d.rule if committed else ""
                shadow_label = "ultravad"
                shadow_committed = ultravad_commits
                shadow_rule = (
                    "ultravad" if uv_threshold_crossed
                    else "silence" if uv_backstop_hit else ""
                )

            # Throttled per-tick trace + always-on commit trace.
            now = time.monotonic()
            if silence_ms >= 150 and (now - last_log_at) > 0.4 or committed:
                last_log_at = now
                _log.info(
                    "[stream] trace session=%s tick silence=%dms/%dms "
                    "conf=%.2fx text_c=%.2f audio=%.2f complete=%.2f "
                    "uv_p=%.3f rule=%r shadow_%s_commit=%s shadow_rule=%r "
                    "partial=%r",
                    self._session_id, silence_ms, fusion_d.required_ms,
                    self._state.turn_detector_confidence, fusion_d.text_c,
                    fusion_d.audio_c, fusion_d.combined,
                    ultravad_p, rule, shadow_label, shadow_committed, shadow_rule,
                    self._state.running_transcript()[:80],
                )

            if not committed:
                continue

            self._commit_rule = rule
            _log.info(
                "[stream] commit decider=%s rule=%s silence=%dms smart=%.2f "
                "td_p=%.4f conf=%.2fx uv_p=%.3f shadow_%s_would=%s session=%s",
                effective_decider, rule, silence_ms, self._state.smart_turn_p,
                self._state.turn_detector_p, self._state.turn_detector_confidence,
                ultravad_p, shadow_label, shadow_committed, self._session_id,
            )
            await self._finalize_commit()
            # Reset both audio-EOU windows so the previous utterance's
            # tail doesn't bleed into the next turn.
            for closer in (self._smart, self._ultravad):
                if closer is not None:
                    try:
                        await closer.reset()
                    except Exception:
                        pass
            return

    async def _finalize_commit(self) -> None:
        """Tell STT to flush the in-progress utterance and wait briefly
        for the resulting ``final`` so the accumulator has the cleaned-up
        text rather than the last raw partial."""
        finals_before = len(self._state.finals_accumulated)
        if self._stt_ws is not None and not self._stt_ws.closed:
            try:
                await self._stt_ws.send_json({"type": "commit"})
            except Exception:
                pass
        deadline = time.perf_counter() + 1.0
        while (
            len(self._state.finals_accumulated) == finals_before
            and time.perf_counter() < deadline
        ):
            await asyncio.sleep(0.02)
