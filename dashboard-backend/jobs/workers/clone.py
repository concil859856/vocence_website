"""Voice clone worker — composite (auto-STT if no ref text, then clone)."""

from __future__ import annotations

import asyncio
import base64
import logging
import time

from local_db import get_connection
from studio_tts_service import (
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


async def process_clone(job: state.Job) -> dict:
    payload = job.payload
    if not CLONE_POOL.configured():
        raise RuntimeError("Voice clone pool is not configured")

    audio_b64 = payload.get("audio_b64") or ""
    if not audio_b64:
        raise RuntimeError("audio_b64 missing in payload")
    raw_ref = base64.b64decode(audio_b64)
    target = (payload.get("target_text") or "").strip()
    if not target:
        raise RuntimeError("target_text missing in payload")
    user_ref_text = (payload.get("reference_text") or "").strip()
    language = (payload.get("language") or "").strip() or None
    source_mode = (payload.get("ref_source") or "upload").strip().lower()
    source_filename = (payload.get("source_audio_filename") or "reference.wav")[:120]

    started_total = time.perf_counter()

    # ── Phase 1: STT (only if user didn't supply ref text) ─────────────────
    detected_language: str | None = language
    if user_ref_text:
        ref_text = user_ref_text
        stt_latency_ms = 0
    else:
        if not STT_POOL.configured():
            raise RuntimeError("Auto-transcription requires STT pool, which is not configured")
        await state.update_status(job.id, phase="transcribing reference")
        stt_started = time.perf_counter()
        async with STT_POOL.acquire() as stt_pod:
            await state.update_status(job.id, pod_url=stt_pod)
            try:
                data, err = await asyncio.wait_for(
                    transcribe_audio(audio_bytes=raw_ref, language=language, base_url=stt_pod),
                    timeout=PHASE_TIMEOUT_STT,
                )
            except asyncio.TimeoutError:
                STT_POOL.quarantine(stt_pod)
                raise
        if not data:
            if err and ("returned 5" in err or "timed out" in err or "connect" in err.lower()):
                STT_POOL.quarantine(stt_pod)
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
    async with CLONE_POOL.acquire() as clone_pod:
        await state.update_status(job.id, pod_url=clone_pod)
        try:
            wav_bytes, clone_err = await asyncio.wait_for(
                voice_clone_synthesize(
                    reference_audio_bytes=raw_ref,
                    reference_text=ref_text,
                    target_text=target,
                    base_url=clone_pod,
                ),
                timeout=PHASE_TIMEOUT_CLONE,
            )
        except asyncio.TimeoutError:
            CLONE_POOL.quarantine(clone_pod)
            raise
    if not wav_bytes:
        if clone_err and ("returned 5" in clone_err or "timed out" in clone_err.lower()):
            CLONE_POOL.quarantine(clone_pod)
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
             credits_used, latency_ms, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', datetime('now'))
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
                stt_latency_ms + clone_latency_ms,
            ),
        )
        history_id = int(cursor.lastrowid)
        await conn.commit()
    finally:
        await conn.close()

    audio_url = get_presigned_url(bucket, key, expires_at, public=False) or ""
    total_ms = int((time.perf_counter() - started_total) * 1000)
    return {
        "audio_url": audio_url,
        "history_id": history_id,
        "reference_text": ref_text,
        "detected_language": detected_language,
        "latency_ms": total_ms,
    }
