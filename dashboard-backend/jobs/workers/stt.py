"""STT job processor."""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from datetime import datetime, timezone

from local_db import get_connection
from studio_tts_service import (
    assert_user_owned_object,
    delete_object,
    download_object_bytes_capped,
    transcribe_audio,
)

from .. import state
from ..registry import STT_POOL
from ..timeouts import PHASE_TIMEOUT_STT


_log = logging.getLogger(__name__)


async def process_stt(job: state.Job) -> dict:
    payload = job.payload
    if not STT_POOL.configured():
        raise RuntimeError("STT pool is not configured")

    # Preferred path: ``audio_bucket`` + ``audio_key`` (browser uploads
    # via the presigned PUT URL to R2 directly; the job payload only
    # carries the key). Fallback: legacy ``audio_b64`` inline.
    audio_bucket = (payload.get("audio_bucket") or "").strip()
    audio_key = (payload.get("audio_key") or "").strip()
    if audio_bucket and audio_key:
        # SECURITY: the bucket+key came from the client. The backend has
        # full R2 credentials, so without this check a crafted payload
        # could read any other user's audio. We require the key to live
        # under ``{job.user_id}/stt-source/...`` — matching exactly what
        # /uploads/presign produces for this kind.
        assert_user_owned_object(audio_bucket, audio_key, job.user_id, allowed_subdir="stt-source")
        audio = download_object_bytes_capped(audio_bucket, audio_key)
        if not audio:
            raise RuntimeError(f"Could not fetch audio from bucket={audio_bucket} key={audio_key}")
    else:
        audio_b64 = (payload.get("audio_b64") or "")
        if not audio_b64:
            raise RuntimeError("audio is required (audio_bucket+audio_key or audio_b64)")
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

    # Source audio is no longer needed once transcription is done.
    # SECURITY: re-validate ownership before deleting (defence in depth —
    # the validation already ran before download, but cleanup is a
    # separate code path).
    if audio_bucket and audio_key:
        try:
            assert_user_owned_object(audio_bucket, audio_key, job.user_id, allowed_subdir="stt-source")
            delete_object(audio_bucket, audio_key)
        except RuntimeError as exc:
            _log.warning("[stt] refusing cleanup of unowned key: %s", exc)
        except Exception:
            _log.warning("[stt] failed to delete source audio bucket=%s key=%s", audio_bucket, audio_key)

    return {
        "text": text,
        "language": detected_lang,
        "history_id": history_id,
        "latency_ms": latency_ms,
    }
