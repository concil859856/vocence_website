"""Internal TTS adapter for the new voice pipeline.

The public ``vocence_plugins.VocenceTTS`` speaks a simple
``{"type":"speak","text":...}`` protocol against the public
``api.vocence.ai`` gateway. That gateway translates to the internal
voice-cloning pod protocol (ref_audio_b64 / ref_text /
ref_audio_sha256). For backend use we skip the gateway entirely and
talk to the cloning pod through the existing
``voicechat_service.stream_tts_for_voice`` entry point, which already
handles voice-id resolution (sample voice / designed voice / fallback),
pod selection through gpu_pool, and ref-audio hash dedup.

Audio output: PCM16LE @ 24 kHz mono — pushed directly to the
framework's ``audio_track`` for transport delivery.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import suppress
from typing import Any, AsyncIterator, Optional, Union

from videosdk.agents import TTS, FlushMarker  # type: ignore[import-not-found]

_log = logging.getLogger(__name__)

_DEFAULT_SAMPLE_RATE = 24_000
_DEFAULT_CHANNELS = 1
# Hard cap per ``speak`` frame on the pod side: the cloning service
# rejects any start.text over 1000 chars with bad_request. We chunk
# anything longer onto sentence boundaries (see _chunk_for_speak)
# and send each piece as a separate speak — the pod plays them
# back-to-back so the listener hears continuous speech.
_MAX_TEXT_CHARS_PER_SPEAK = 900
# Sentence-end punctuation we split on. Keeps the chunker simple
# while handling ~99% of natural speech text. Question marks and
# exclamation marks join the period to handle "Sure thing! Here's…"
# style replies without losing the boundary.
_SENTENCE_TERMINATORS = ".!?\n"
# Fallback terminators when a single sentence already exceeds the
# cap — split on clause boundaries so we don't break a word.
_CLAUSE_TERMINATORS = ",;:"


def _chunk_for_speak(text: str) -> list[str]:
    """Pack ``text`` into chunks each ≤ ``_MAX_TEXT_CHARS_PER_SPEAK``.

    Priority order:
      1. Split on sentence terminators (. ! ? newline). Pack adjacent
         sentences into a single chunk while it stays under the cap.
      2. If one sentence is itself over the cap, split it on clause
         terminators (, ; :) and pack the same way.
      3. Last resort: hard-cut at the cap. Rare in practice — would
         only happen for a single 900+ char run with no punctuation
         (URLs, code blocks, etc.).
    """
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= _MAX_TEXT_CHARS_PER_SPEAK:
        return [text]
    sentences = _split_keeping_delim(text, _SENTENCE_TERMINATORS)
    out: list[str] = []
    buf = ""
    for s in sentences:
        s = s.strip()
        if not s:
            continue
        if len(s) > _MAX_TEXT_CHARS_PER_SPEAK:
            if buf:
                out.append(buf)
                buf = ""
            out.extend(_split_oversize_sentence(s))
            continue
        candidate = (buf + " " + s).strip() if buf else s
        if len(candidate) > _MAX_TEXT_CHARS_PER_SPEAK:
            if buf:
                out.append(buf)
            buf = s
        else:
            buf = candidate
    if buf:
        out.append(buf)
    return out


def _split_oversize_sentence(sentence: str) -> list[str]:
    """A single sentence over the cap — split on clauses, fallback to
    a hard char cut."""
    parts = _split_keeping_delim(sentence, _CLAUSE_TERMINATORS)
    out: list[str] = []
    buf = ""
    for p in parts:
        p = p.strip()
        if not p:
            continue
        if len(p) > _MAX_TEXT_CHARS_PER_SPEAK:
            if buf:
                out.append(buf)
                buf = ""
            for i in range(0, len(p), _MAX_TEXT_CHARS_PER_SPEAK):
                out.append(p[i:i + _MAX_TEXT_CHARS_PER_SPEAK])
            continue
        candidate = (buf + " " + p).strip() if buf else p
        if len(candidate) > _MAX_TEXT_CHARS_PER_SPEAK:
            if buf:
                out.append(buf)
            buf = p
        else:
            buf = candidate
    if buf:
        out.append(buf)
    return out


def _split_keeping_delim(text: str, delims: str) -> list[str]:
    """Split ``text`` on any character in ``delims``, keeping the
    delimiter attached to the preceding piece (so we don't lose
    end-of-sentence punctuation in the output)."""
    out: list[str] = []
    start = 0
    for i, ch in enumerate(text):
        if ch in delims:
            out.append(text[start:i + 1])
            start = i + 1
    if start < len(text):
        out.append(text[start:])
    return out


class InternalVocenceTTS(TTS):
    """Streaming TTS bound to the internal voice-cloning pod.

    Parameters
    ----------
    voice:
        Voice identifier — sample voice id (``"voc-sienna"``), designed
        voice (``"dv:<id>"``), or any string ``stream_tts_for_voice``
        will resolve.
    language:
        Optional language hint passed through to the synthesis call.
    user_id:
        Required only when ``voice`` is a ``dv:<id>`` designed voice —
        enforces per-user ownership in the resolver.
    """

    def __init__(
        self,
        *,
        voice: Union[str, int],
        language: Optional[str] = None,
        user_id: Optional[str] = None,
        sample_rate: int = _DEFAULT_SAMPLE_RATE,
        **_: Any,
    ) -> None:
        super().__init__(sample_rate=sample_rate, num_channels=_DEFAULT_CHANNELS)
        self.voice = str(voice)
        self.language = language
        self.user_id = user_id

        # Per-synthesize state, reset at the top of each call.
        self._interrupted = False
        self._first_chunk_sent = False
        # Reused across segments inside a single ``synthesize()`` call to
        # keep all sentences of one reply on the same TTS pod.
        self._pod_pin: Any | None = None
        # Set once per session; persists across many synthesize() calls.
        self._warmer: Any | None = None

    # ----- abstract overrides ---------------------------------------------

    async def synthesize(
        self,
        text: AsyncIterator[Union[str, FlushMarker]] | str,
        voice_id: Optional[str] = None,
        **kwargs: Any,
    ) -> None:
        """Synthesize ``text`` and push 24 kHz mono PCM16LE frames to
        ``self.audio_track``. ``voice_id`` is accepted for API symmetry
        but ignored — voice is bound at construction. Construct a new
        ``InternalVocenceTTS`` for a different voice.
        """
        self._interrupted = False
        self._first_chunk_sent = False

        # Resolve voice warmer / pod pin lazily — both are optional but
        # save the per-turn handshake cost when present. The pin keeps
        # multi-sentence replies on a single pod (consistent voice tone).
        await self._ensure_session_state()

        if isinstance(text, str):
            await self._speak_once(text)
            return

        # Async iterator: collect into segments separated by FlushMarker.
        buf: list[str] = []
        async for chunk in text:
            if self._interrupted:
                return
            if isinstance(chunk, FlushMarker):
                segment = "".join(buf).strip()
                buf = []
                if segment:
                    await self._speak_once(segment)
                    if self._interrupted:
                        return
                continue
            if chunk:
                buf.append(chunk)
        tail = "".join(buf).strip()
        if tail and not self._interrupted:
            await self._speak_once(tail)

    async def interrupt(self) -> None:
        """Stop the in-flight synthesis. The TtsChunk iterator checks
        ``self._interrupted`` between chunks and bails out — the
        underlying WS stays warm via the pod pin."""
        self._interrupted = True

    async def prewarm(self) -> None:
        """Pre-establish a clone-pod WS so the first ``synthesize()``
        call skips the handshake. Idempotent — safe to call multiple
        times. No-op if ``stream_tts_for_voice`` is unavailable for
        any reason (the synthesize call will fall back to per-call pod
        selection)."""
        try:
            await self._ensure_session_state()
        except Exception as exc:  # noqa: BLE001
            _log.debug("[voice_pipeline_next_tts] prewarm failed: %s", exc)

    async def aclose(self) -> None:
        self._interrupted = True
        if self._warmer is not None:
            with suppress(Exception):
                await self._warmer.aclose()
            self._warmer = None
        if self._pod_pin is not None:
            with suppress(Exception):
                await self._pod_pin.release()
            self._pod_pin = None

    def reset_first_audio_tracking(self) -> None:
        self._first_chunk_sent = False

    # ----- internals ------------------------------------------------------

    async def _ensure_session_state(self) -> None:
        """Lazy-build the session-scoped warmer + pod pin. Both are
        optional optimizations — the synthesis call will work even if
        either is None (it just pays a fresh handshake)."""
        if self._warmer is not None and self._pod_pin is not None:
            return
        # Local import — keeps cold-start light and avoids a circular
        # import when voicechat_service is the one that bootstraps the
        # pipeline factory.
        from voicechat_service import (  # type: ignore[import-not-found]
            TurnTtsPodPin,
            make_tts_warmer_for_voice,
        )

        if self._pod_pin is None:
            with suppress(Exception):
                self._pod_pin = TurnTtsPodPin()
        if self._warmer is None:
            with suppress(Exception):
                self._warmer = make_tts_warmer_for_voice(self.voice)

    async def _speak_once(self, text: str) -> None:
        """Synthesize ``text``. If it exceeds the pod's per-frame cap,
        chunk on sentence boundaries and feed the pod one piece at a
        time — the pod-side pin keeps all chunks of one reply on the
        same model instance so the listener hears continuous speech,
        not piecewise re-warm.
        """
        if not text:
            return
        for piece in _chunk_for_speak(text):
            if self._interrupted:
                return
            await self._speak_piece(piece)

    async def _speak_piece(self, text: str) -> None:
        """Single pod ``speak`` round-trip. Pre-condition: ``text`` is
        already ≤ ``_MAX_TEXT_CHARS_PER_SPEAK``."""
        from voicechat_service import stream_tts_for_voice  # type: ignore[import-not-found]

        try:
            async for chunk in stream_tts_for_voice(
                text,
                self.voice,
                language=self.language,
                user_id=self.user_id,
                warmer=self._warmer,
                pod_pin=self._pod_pin,
            ):
                if self._interrupted:
                    return
                kind = getattr(chunk, "kind", None)
                payload = getattr(chunk, "payload", None)
                if kind == "audio":
                    if not payload:
                        continue
                    if not self._first_chunk_sent:
                        self._first_chunk_sent = True
                        if self._first_audio_callback is not None:
                            with suppress(Exception):
                                await self._first_audio_callback()
                    if self.audio_track is not None:
                        with suppress(Exception):
                            await self.audio_track.add_new_bytes(payload)
                    continue
                if kind == "end":
                    return
                if kind == "error":
                    code = (payload or {}).get("code") if isinstance(payload, dict) else None
                    message = (payload or {}).get("message") if isinstance(payload, dict) else None
                    _log.warning(
                        "[voice_pipeline_next_tts] pod error %s: %s",
                        code, message,
                    )
                    self.emit("error", str(message or code or "tts failed"))
                    return
                # meta + anything else: drop — sample-rate/channels are
                # already pinned at the framework base class.
        except asyncio.CancelledError:
            self._interrupted = True
            raise
        except Exception as exc:  # noqa: BLE001
            _log.warning("[voice_pipeline_next_tts] synthesize failed: %s", exc)
            self.emit("error", str(exc))
