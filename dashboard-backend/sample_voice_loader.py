"""Shared loader for sample-voice references — used by the clone worker
(General TTS subpage) and the voicechat router (agents).

Resolves a sample_voice_id → (audio_bytes, reference_text). Reference
text comes from a persisted ``sample_voice_transcripts.json`` file when
available (pre-computed by ``scripts/pretranscribe_sample_voices.py``);
falls back to a fresh STT call when a voice doesn't have a stored
transcript yet (e.g. you just added one).

Audio bytes are fetched lazily and cached per process. Transcripts are
loaded once at import time from the JSON manifest.
"""

from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path

import aiohttp

from sample_voices_data import (
    get_sample_url,
    is_known_sample,
    read_local_sample_bytes,
)
from studio_tts_service import transcribe_audio


_log = logging.getLogger(__name__)


# Persistent transcript manifest. Hand-editable JSON. Populate / refresh
# via ``scripts/pretranscribe_sample_voices.py``.
_TRANSCRIPTS_FILE = Path(__file__).resolve().parent / "sample_voice_transcripts.json"


def _load_persisted_transcripts() -> dict[str, str]:
    if not _TRANSCRIPTS_FILE.exists():
        return {}
    try:
        return json.loads(_TRANSCRIPTS_FILE.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        _log.warning("could not parse %s: %s — falling back to live STT",
                     _TRANSCRIPTS_FILE.name, exc)
        return {}


_PERSISTED_TRANSCRIPTS: dict[str, str] = _load_persisted_transcripts()
if _PERSISTED_TRANSCRIPTS:
    _log.info("loaded %d sample-voice transcripts from %s",
              len(_PERSISTED_TRANSCRIPTS), _TRANSCRIPTS_FILE.name)

_CACHE: dict[str, tuple[bytes, str]] = {}
_LOCK = asyncio.Lock()


async def _fetch(url: str) -> bytes:
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url) as resp:
            if resp.status != 200:
                raise RuntimeError(f"sample audio fetch failed ({resp.status})")
            return await resp.read()


async def load_sample_voice(
    voice_id: str,
    *,
    language: str | None = None,
    stt_pod_url: str | None = None,
) -> tuple[bytes, str]:
    """Resolve sample_voice_id → (audio_bytes, reference_text), cached.

    ``stt_pod_url``: optional STT base URL (callers running inside an
    STT_POOL slot can pass theirs). If omitted, falls back to direct STT.
    """
    if not is_known_sample(voice_id):
        raise RuntimeError(f"unknown sample voice: {voice_id}")
    cached = _CACHE.get(voice_id)
    if cached:
        return cached

    async with _LOCK:
        cached = _CACHE.get(voice_id)
        if cached:
            return cached

        # Prefer local disk; fall back to CDN
        audio = read_local_sample_bytes(voice_id)
        if audio is None:
            url = get_sample_url(voice_id)
            if not url:
                raise RuntimeError(f"unknown sample voice: {voice_id}")
            audio = await _fetch(url)

        # 1) Use the persisted transcript if we have one
        ref = (_PERSISTED_TRANSCRIPTS.get(voice_id) or "").strip()

        # 2) Otherwise fall back to live STT (for voices added since the
        #    pretranscribe script was last run)
        if not ref:
            _log.info("no persisted transcript for %s — running STT once", voice_id)
            data, err = await transcribe_audio(
                audio_bytes=audio,
                language=language,
                base_url=stt_pod_url,
            )
            if not data:
                raise RuntimeError(f"could not transcribe sample voice {voice_id}: {err or 'empty'}")
            ref = (data.get("text") or "").strip()
            if not ref:
                raise RuntimeError(f"sample voice {voice_id} transcribed to empty text")

        _CACHE[voice_id] = (audio, ref)
        return audio, ref


def is_sample_voice(voice_id: str | None) -> bool:
    """True if ``voice_id`` refers to a known sample voice (CDN or local)."""
    if not voice_id:
        return False
    return is_known_sample(voice_id)
