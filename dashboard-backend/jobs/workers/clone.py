"""Voice clone worker — composite (auto-STT if no ref text, then clone).

Two payload modes:
  1. Upload/record mode: client sends `audio_b64`. We optionally STT to derive
     the reference transcript, then call the clone API.
  2. Sample-voice mode: client sends `sample_voice_id` (an entry in
     sample_voices_data.SAMPLE_VOICE_AUDIO_URLS). We fetch the audio from the
     CDN and STT it once, caching both per process for subsequent calls. Used
     by the General TTS subpage.
"""

from __future__ import annotations

import asyncio
import base64
import logging
import time

from local_db import get_connection
from sample_voice_loader import load_sample_voice
from sample_voices_data import is_known_sample
from studio_tts_service import (
    assert_user_owned_object,
    delete_object,
    download_object_bytes,
    download_object_bytes_capped,
    get_presigned_url,
    transcribe_audio,
    upload_wav_to_hippius,
    voice_clone_synthesize,
    voice_clone_endpoint_label,
)

from .. import state
from ..registry import CLONE_POOL, STT_POOL
from ..timeouts import PHASE_TIMEOUT_CLONE, PHASE_TIMEOUT_STT


_log = logging.getLogger(__name__)


def _stt_available() -> bool:
    try:
        from ops import pool as gpu_pool
        if gpu_pool.online_pod_count("stt") > 0:
            return True
    except Exception:
        pass
    return STT_POOL.configured()


def _clone_available() -> bool:
    try:
        from ops import pool as gpu_pool
        if gpu_pool.online_pod_count("voice_clone") > 0:
            return True
    except Exception:
        pass
    return CLONE_POOL.configured()


async def process_clone(job: state.Job) -> dict:
    payload = job.payload
    if not _clone_available():
        raise RuntimeError("Voice clone pool is not configured (no ops pods online, STUDIO_VOICE_CLONE_URL not set)")

    target = (payload.get("target_text") or "").strip()
    if not target:
        raise RuntimeError("target_text missing in payload")
    user_ref_text = (payload.get("reference_text") or "").strip()
    language = (payload.get("language") or "").strip() or None
    source_mode = (payload.get("ref_source") or "upload").strip().lower()
    source_filename = (payload.get("source_audio_filename") or "reference.wav")[:120]

    sample_voice_id = (payload.get("sample_voice_id") or "").strip()
    audio_bucket = (payload.get("audio_bucket") or "").strip()
    audio_key = (payload.get("audio_key") or "").strip()
    audio_b64 = payload.get("audio_b64") or ""

    if sample_voice_id:
        if not is_known_sample(sample_voice_id):
            raise RuntimeError(f"unknown sample voice: {sample_voice_id}")
        await state.update_status(job.id, phase="loading sample voice")
        raw_ref, cached_ref_text = await load_sample_voice(
            sample_voice_id, language=language,
        )
        user_ref_text = cached_ref_text
        source_mode = "sample"
        source_filename = sample_voice_id[:120]
    elif audio_bucket and audio_key:
        assert_user_owned_object(audio_bucket, audio_key, job.user_id, allowed_subdir="voice-clone-ref")
        raw_ref = download_object_bytes_capped(audio_bucket, audio_key)
        if not raw_ref:
            raise RuntimeError(f"Could not fetch reference audio from bucket={audio_bucket} key={audio_key}")
    elif audio_b64:
        raw_ref = base64.b64decode(audio_b64)
    else:
        raise RuntimeError("payload requires audio_bucket+audio_key (upload mode), audio_b64 (legacy), or sample_voice_id (general TTS)")

    started_total = time.perf_counter()

    # ── Phase 1: STT (only if user didn't supply ref text) ─────────────────
    detected_language: str | None = language
    if user_ref_text:
        ref_text = user_ref_text
        stt_latency_ms = 0
    else:
        if not _stt_available():
            raise RuntimeError("Auto-transcription requires STT (no ops pods online, STUDIO_STT_URL not set)")
        await state.update_status(job.id, phase="transcribing reference")
        stt_started = time.perf_counter()
        # Let transcribe_audio handle pod selection — its internal
        # dispatcher picks stt pods with the correct per-pod API key.
        data, err = await asyncio.wait_for(
            transcribe_audio(audio_bytes=raw_ref, language=language),
            timeout=PHASE_TIMEOUT_STT,
        )
        if not data:
            raise RuntimeError(err or "Could not transcribe reference audio")
        ref_text = (data.get("text") or "").strip()
        if not ref_text:
            raise RuntimeError("Reference audio transcribed to empty text — try a clearer clip")
        if isinstance(data.get("language"), str):
            detected_language = data.get("language")
        stt_latency_ms = int((time.perf_counter() - stt_started) * 1000)

    # ── Phase 2: Clone ─────────────────────────────────────────────────────
    await state.update_status(job.id, phase="cloning voice")
    clone_started = time.perf_counter()
    # Let voice_clone_synthesize handle pod selection — its internal
    # dispatcher picks voice_clone pods with the correct per-pod API key.
    wav_bytes, clone_err = await asyncio.wait_for(
        voice_clone_synthesize(
            reference_audio_bytes=raw_ref,
            reference_text=ref_text,
            target_text=target,
        ),
        timeout=PHASE_TIMEOUT_CLONE,
    )
    if not wav_bytes:
        raise RuntimeError(clone_err or "Voice clone synthesis failed")
    clone_latency_ms = int((time.perf_counter() - clone_started) * 1000)

    # ── Storage + history insert ──────────────────────────────────────────
    await state.update_status(job.id, phase="storing audio")
    bucket, key, expires_at = upload_wav_to_hippius(job.user_id, wav_bytes, subdir="clone")

    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            INSERT INTO studio_clone_history
            (user_id, reference_text, target_text, source_mode, source_audio_filename,
             source_language, chute_slug, audio_s3_bucket, audio_s3_key, expires_at,
             credits_used, stt_latency_ms, clone_latency_ms, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', datetime('now'))
            """,
            (
                job.user_id,
                ref_text,
                target,
                source_mode,
                source_filename,
                detected_language,
                voice_clone_endpoint_label(),
                bucket,
                key,
                expires_at.isoformat() if expires_at else "",
                int(job.credits_charged or 0),
                stt_latency_ms,
                clone_latency_ms,
            ),
        )
        history_id = int(cursor.lastrowid)
        await conn.commit()
    finally:
        await conn.close()

    audio_url = get_presigned_url(bucket, key, expires_at, public=False) or ""
    total_ms = int((time.perf_counter() - started_total) * 1000)

    if audio_bucket and audio_key:
        try:
            assert_user_owned_object(audio_bucket, audio_key, job.user_id, allowed_subdir="voice-clone-ref")
            delete_object(audio_bucket, audio_key)
        except RuntimeError as exc:
            _log.warning("[clone] refusing cleanup of unowned key: %s", exc)
        except Exception:
            _log.warning("[clone] failed to delete reference audio bucket=%s key=%s", audio_bucket, audio_key)

    return {
        "audio_url": audio_url,
        "history_id": history_id,
        "reference_text": ref_text,
        "detected_language": detected_language,
        "latency_ms": total_ms,
    }
