"""Internal STT adapter for the new voice pipeline.

The public ``vocence_plugins.VocenceSTT`` connects through
``api.vocence.ai`` with a bearer API key — the right design for SDK
users, but wasteful for the backend (which would round-trip through
the public gateway just to reach its own STT pod). This adapter
subclasses the framework's ``STT`` base class and talks directly to
the ``asr_streaming_rt`` pod through the existing ``gpu_pool``
dispatcher — the same path the legacy ``voicechat_stream.py`` uses.

Wire format matches the streaming_stt pod spec: PCM16LE @ 16 kHz mono
in, JSON ``start`` frame opens the session, partial/final/vad_speech/
vad_silence events translate to the framework's ``STTResponse`` shape.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import suppress
from typing import Any, Optional

import aiohttp
from videosdk.agents import (  # type: ignore[import-not-found]
    STT,
    STTResponse,
    SpeechData,
    SpeechEventType,
)

_log = logging.getLogger(__name__)

_DEFAULT_SAMPLE_RATE = 16_000
_CONNECT_TIMEOUT_SEC = 10.0
_READY_TIMEOUT_SEC = 10.0
# Suppress interim events that arrive within this window after a final.
# The pod sometimes emits echo / next-utterance partials immediately
# after a final, and the framework's speech_understanding cancels its
# EOU wait timer on ANY stt event but only re-schedules it on FINALs —
# so an unfortunate echo partial kills the wait without restart, the
# accumulated transcript is stranded in memory, and the agent never
# replies. The grace lets the wait timer settle naturally; new
# utterances after this window still flow through.
#
# Lowered 1.0 → 0.5: the original 1s window was generous enough that
# real barge-in attempts during the next turn's first second got
# suppressed (HYBRID interrupt mode triggers on STT INTERIMs as well
# as VAD, so suppressing interims hurts barge-in responsiveness).
# 500ms is enough to absorb the pod's echo while leaving the rest
# of the turn responsive.
_POST_FINAL_INTERIM_GRACE_SEC = 0.5

# ISO-639-1 mapping mirrors voicechat_stream._stt_language_code so the
# new pipeline behaves identically to legacy on agent-config strings.
_LANG_TO_ISO = {
    "English": "en", "Spanish": "es", "French": "fr", "German": "de",
    "Italian": "it", "Portuguese": "pt", "Japanese": "ja", "Korean": "ko",
    "Chinese": "zh", "Russian": "ru",
}


def _to_iso_639_1(language: str | None) -> str:
    if not language:
        return "auto"
    s = language.strip()
    if s.lower() == "auto":
        return "auto"
    if s in _LANG_TO_ISO:
        return _LANG_TO_ISO[s]
    if len(s) == 2 and s.isalpha():
        return s.lower()
    return "auto"


class InternalVocenceSTT(STT):
    """Streaming STT bound to an ``asr_streaming_rt`` pod from gpu_pool.

    Parameters
    ----------
    language:
        Agent-config language ("English", "auto", or an ISO code).
        Normalized to ISO upfront; pinned for the WS lifetime (the pod
        binds language in its ``start`` frame).
    sample_rate:
        Audio sample rate the pod will receive. Today only 16 kHz is
        supported — kept as a constructor knob for forward-compat.
    enable_partials / vad_events:
        Both default-on. Partials drive the live-caption UI, VAD events
        drive the EOU ensembler.
    """

    def __init__(
        self,
        *,
        language: str = "auto",
        sample_rate: int = _DEFAULT_SAMPLE_RATE,
        enable_partials: bool = True,
        vad_events: bool = True,
        forward_interim_transcripts: bool = False,
        **_: Any,
    ) -> None:
        super().__init__(forward_interim_transcripts=forward_interim_transcripts)
        self.language = language
        self.sample_rate = sample_rate
        self.enable_partials = enable_partials
        self.vad_events = vad_events

        self._session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._pod_cm: Any | None = None
        self._reader_task: asyncio.Task | None = None
        self._connect_lock = asyncio.Lock()
        self._closed = False
        # Echo-suppression state. The pod sometimes re-emits a partial
        # right after a final whose text matches (or is a prefix of)
        # the final — that's the echo we want to drop. Anything with
        # genuinely new text is real next-utterance speech and must
        # flow through unchanged so HYBRID-mode barge-in fires fast.
        self._last_final_text: str = ""
        self._last_final_at: float | None = None

    # ----- abstract overrides ---------------------------------------------

    async def process_audio(
        self,
        audio_frames: bytes,
        language: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        if self._closed:
            return
        if self._ws is None:
            await self._ensure_connection()
        ws = self._ws
        if ws is None or ws.closed:
            return
        try:
            await ws.send_bytes(audio_frames)
        except Exception as exc:  # noqa: BLE001
            _log.warning("[voice_pipeline_next_stt] send_bytes failed: %s", exc)
            await self._teardown_ws()

    async def flush(self) -> None:
        """Ask the pod to finalize the current partial. Used at EOU to
        get a final transcript without waiting for the pod's own silence
        timer."""
        ws = self._ws
        if ws is None or ws.closed:
            return
        with suppress(Exception):
            await ws.send_str(json.dumps({"type": "commit"}))

    async def aclose(self) -> None:
        self._closed = True
        if self._reader_task is not None and not self._reader_task.done():
            self._reader_task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await self._reader_task
            self._reader_task = None
        await self._teardown_ws()

    # ----- internals ------------------------------------------------------

    async def _ensure_connection(self) -> None:
        async with self._connect_lock:
            if self._ws is not None and not self._ws.closed:
                return
            from ops import pool as gpu_pool  # local: avoid import at module load

            if gpu_pool.online_pod_count("asr_streaming_rt") <= 0:
                raise RuntimeError("no asr_streaming_rt pod online")

            pod_cm = gpu_pool.pick_pod("asr_streaming_rt")
            pod = await pod_cm.__aenter__()
            self._pod_cm = pod_cm

            base = pod.url.rstrip("/")
            if base.startswith("https://"):
                ws_url = "wss://" + base[len("https://"):] + "/v1/stream"
            elif base.startswith("http://"):
                ws_url = "ws://" + base[len("http://"):] + "/v1/stream"
            else:
                ws_url = base + "/v1/stream"

            headers: dict[str, str] = {}
            if pod.api_key:
                headers["X-API-Key"] = pod.api_key

            try:
                self._session = aiohttp.ClientSession(
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=_CONNECT_TIMEOUT_SEC),
                )
                self._ws = await self._session.ws_connect(
                    ws_url,
                    timeout=aiohttp.ClientWSTimeout(ws_close=15),
                    max_msg_size=2 * 1024 * 1024,
                )
                await self._ws.send_json({
                    "type": "start",
                    "language": _to_iso_639_1(self.language),
                    "sample_rate": self.sample_rate,
                    "encoding": "pcm_s16le",
                    "enable_partials": self.enable_partials,
                    "vad_events": self.vad_events,
                })
                ready = await asyncio.wait_for(
                    self._ws.receive(), timeout=_READY_TIMEOUT_SEC,
                )
                if ready.type != aiohttp.WSMsgType.TEXT:
                    raise RuntimeError(
                        f"STT ready frame missing (got {ready.type})"
                    )
                data = json.loads(ready.data)
                mtype = (data.get("type") or "").lower()
                if mtype == "error":
                    raise RuntimeError(
                        f"STT pod rejected start: {data.get('code')}: "
                        f"{data.get('message')}"
                    )
                if mtype != "ready":
                    raise RuntimeError(f"STT pod unexpected first frame {mtype!r}")
                self._reader_task = asyncio.create_task(
                    self._read_loop(), name="internal_vocence_stt_reader",
                )
            except Exception:
                # Release the pod slot if we never reached "ready".
                if self._pod_cm is not None:
                    with suppress(Exception):
                        await self._pod_cm.__aexit__(None, None, None)
                    self._pod_cm = None
                raise

    async def _read_loop(self) -> None:
        ws = self._ws
        if ws is None:
            return
        try:
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    if msg.type in (
                        aiohttp.WSMsgType.CLOSED,
                        aiohttp.WSMsgType.CLOSE,
                        aiohttp.WSMsgType.ERROR,
                    ):
                        return
                    continue
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue
                response = self._translate_event(data)
                if response is None:
                    continue
                cb = self._transcript_callback
                if cb is None:
                    continue
                try:
                    await cb(response)
                except Exception as exc:  # noqa: BLE001
                    _log.warning("[voice_pipeline_next_stt] callback raised: %s", exc)
        except asyncio.CancelledError:
            return
        except Exception as exc:  # noqa: BLE001
            _log.warning("[voice_pipeline_next_stt] reader crashed: %s", exc)
            self.emit("error", str(exc))

    def _translate_event(self, data: dict) -> STTResponse | None:
        mtype = (data.get("type") or "").lower()
        if mtype == "partial":
            text = (data.get("text") or "").strip()
            if not text:
                return None
            # Echo-suppression. The pod can re-emit a partial right
            # after a final whose text matches or is a prefix of the
            # just-emitted final — that's the echo (same utterance,
            # repeated). Drop ONLY those, and only within the grace
            # window. Anything with new text (a different prefix, or
            # text longer than the previous final) is real
            # next-utterance speech and must flow through immediately
            # so HYBRID-mode interrupt monitoring sees it. This is
            # what made voice_agent/agent.py feel responsive to
            # brief barge-ins — Deepgram doesn't emit echo partials,
            # so it doesn't need any suppression at all.
            if (
                self._last_final_at is not None
                and self._last_final_text
                and (time.monotonic() - self._last_final_at
                     < _POST_FINAL_INTERIM_GRACE_SEC)
                and self._last_final_text.startswith(text)
            ):
                return None
            return STTResponse(
                event_type=SpeechEventType.INTERIM,
                data=SpeechData(text=text, language=self.language),
            )
        if mtype == "final":
            text = (data.get("text") or "").strip()
            if not text:
                return None
            self._last_final_at = time.monotonic()
            self._last_final_text = text
            return STTResponse(
                event_type=SpeechEventType.FINAL,
                data=SpeechData(
                    text=text,
                    language=data.get("language_detected") or self.language,
                ),
            )
        # Pod VAD events (vad_speech / vad_silence) are intentionally
        # dropped here. The framework runs its OWN SileroVAD locally
        # for turn-taking, and routes ALL STT events — including START
        # / END — through speech_understanding._on_stt_transcript,
        # which cancels its EOU wait timer on any event but only
        # reschedules on FINALs. Forwarding pod VAD events would
        # therefore strand the accumulated transcript and kill the
        # turn (this was the symptom: VAD detected speech, pod
        # returned text, EOU computed, wait scheduled, agent silent).
        # Local SileroVAD already drives speech_started/stopped, so
        # nothing is lost.
        if mtype in ("vad_speech", "vad_silence"):
            return None
        if mtype == "error":
            _log.warning(
                "[voice_pipeline_next_stt] pod error: %s: %s",
                data.get("code"), data.get("message"),
            )
            self.emit("error", str(data.get("message") or data.get("code")))
        return None

    async def _teardown_ws(self) -> None:
        ws = self._ws
        if ws is not None and not ws.closed:
            with suppress(Exception):
                await ws.send_str(json.dumps({"type": "close"}))
            with suppress(Exception):
                await ws.close(code=1000)
        self._ws = None
        if self._session is not None and not self._session.closed:
            with suppress(Exception):
                await self._session.close()
        self._session = None
        if self._pod_cm is not None:
            with suppress(Exception):
                await self._pod_cm.__aexit__(None, None, None)
            self._pod_cm = None
