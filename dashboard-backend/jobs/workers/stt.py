"""STT job processor."""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from datetime import datetime, timezone

from local_db import get_connection
from studio_tts_service import transcribe_audio

from .. import state
from ..registry import STT_POOL
from ..timeouts import PHASE_TIMEOUT_STT


_log = logging.getLogger(__name__)


async def process_stt(job: state.Job) -> dict:
    payload = job.payload
    if not STT_POOL.configured():
        raise RuntimeError("STT pool is not configured")

    audio_b64 = (payload.get("audio_b64") or "")
    if not audio_b64:
        raise RuntimeError("audio_b64 missing in payload")
    audio = base64.b64decode(audio_b64)
    language = (payload.get("language") or "").strip() or None
    filename = (payload.get("filename") or "audio.wav")[:120]

    await state.update_status(job.id, phase="transcribing")
    started = time.perf_counter()

    async with STT_POOL.acquire() as pod_url:
        await state.update_status(job.id, pod_url=pod_url)
        try:
            data, err = await asyncio.wait_for(
                transcribe_audio(audio_bytes=audio, language=language, base_url=pod_url),
                timeout=PHASE_TIMEOUT_STT,
            )
        except asyncio.TimeoutError:
            STT_POOL.quarantine(pod_url)
            raise

    if not data:
        if err and ("returned 5" in err or "timed out" in err or "connect" in err.lower()):
            STT_POOL.quarantine(pod_url)
        raise RuntimeError(err or "Transcription failed")

    text = (data.get("text") or "").strip()
    detected_lang = data.get("language") if isinstance(data.get("language"), str) else language
    latency_ms = int((time.perf_counter() - started) * 1000)

    # Insert into studio_stt_history (mirrors legacy handler)
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            INSERT INTO studio_stt_history
            (user_id, provider_name, source_audio_filename, source_language, transcribed_text,
             credits_used, latency_ms, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', datetime('now'))
            """,
            (
                job.user_id,
                "Speech-to-Text",
                filename,
                detected_lang,
                text,
                int(job.credits_charged or 0),
                latency_ms,
            ),
        )
        history_id = int(cursor.lastrowid)
        await conn.commit()
    finally:
        await conn.close()

    return {
        "text": text,
        "language": detected_lang,
        "history_id": history_id,
        "latency_ms": latency_ms,
    }
