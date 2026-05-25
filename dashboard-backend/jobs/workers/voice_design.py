"""Voice design worker — handles two modes: 'preview' and 'speak'.

`preview` is composite (LLM + 2× sequential TTS calls). `speak` is a clone with a
stored reference. Both write to existing tables (studio_voice_design_previews and
studio_clone_history respectively).
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import logging
import secrets
import time

from local_db import get_connection
from studio_tts_service import (
    download_object_bytes,
    get_presigned_url,
    synthesize_speak,
    upload_wav_preview,
    upload_wav_to_hippius,
    voice_clone_endpoint_label,
    voice_clone_synthesize,
    voice_design_llm_plan,
)

from .. import state
from ..registry import CLONE_POOL, TTS_POOL
from ..timeouts import PHASE_TIMEOUT_CLONE, PHASE_TIMEOUT_LLM, PHASE_TIMEOUT_TTS


_log = logging.getLogger(__name__)


@asynccontextmanager
async def _pick_tts_pod():
    """Async context manager yielding a pod_url string.

    Tries the ops dispatcher first (least-loaded online tts_streaming pod),
    falls back to the static TTS_POOL (from env config).
    """
    try:
        from ops import pool as gpu_pool
        if gpu_pool.online_pod_count("tts_streaming") > 0:
            async with gpu_pool.pick_pod("tts_streaming") as pod:
                yield pod.url
                return
    except Exception as e:
        try:
            from ops.pool import NoCapacity
            if isinstance(e, NoCapacity):
                raise RuntimeError("TTS fleet busy (all pods at capacity)")
        except ImportError:
            pass
    if not TTS_POOL.configured():
        raise RuntimeError("TTS pool is not configured (no ops pods online, TTS env not set)")
    async with TTS_POOL.acquire() as pod_url:
        yield pod_url


@asynccontextmanager
async def _pick_clone_pod():
    """Async context manager yielding a pod_url string.

    Tries the ops dispatcher first (least-loaded online voice_clone pod),
    falls back to the static CLONE_POOL (from env config).
    """
    try:
        from ops import pool as gpu_pool
        if gpu_pool.online_pod_count("voice_clone") > 0:
            async with gpu_pool.pick_pod("voice_clone") as pod:
                yield pod.url
                return
    except Exception as e:
        try:
            from ops.pool import NoCapacity
            if isinstance(e, NoCapacity):
                raise RuntimeError("Voice clone fleet busy (all pods at capacity)")
        except ImportError:
            pass
    if not CLONE_POOL.configured():
        raise RuntimeError("Voice clone pool is not configured (no ops pods online, clone env not set)")
    async with CLONE_POOL.acquire() as pod_url:
        yield pod_url


async def process_voice_design(job: state.Job) -> dict:
    payload = job.payload
    mode = (payload.get("mode") or "preview").lower()
    if mode == "preview":
        return await _run_preview(job)
    if mode == "speak":
        return await _run_speak(job)
    raise RuntimeError(f"Unknown voice_design mode: {mode}")


# ── Preview branch ─────────────────────────────────────────────────────────


async def _run_preview(job: state.Job) -> dict:
    payload = job.payload
    voice_desc = (payload.get("voice_description") or "").strip()
    chute_slug = payload.get("chute_slug") or ""

    # Phase 1: LLM plan (no pool — Chutes auto-scales)
    await state.update_status(job.id, phase="refining description")
    plan, err = await asyncio.wait_for(
        voice_design_llm_plan(voice_description=voice_desc),
        timeout=PHASE_TIMEOUT_LLM,
    )
    if not plan:
        raise RuntimeError(err or "Voice design planning failed")
    sample_script = plan["sample_script"]
    revised_instruction = plan["revised_instruction"]

    # Phase 2: TTS variant A
    # Let synthesize_speak handle pod selection — its internal dispatcher
    # picks voice_design pods with the correct per-pod API key.
    await state.update_status(job.id, phase="synthesizing variant A")
    wav_a, err_a = await asyncio.wait_for(
        synthesize_speak(chute_slug, sample_script, voice_desc),
        timeout=PHASE_TIMEOUT_TTS,
    )
    if not wav_a:
        raise RuntimeError(f"Variant A failed: {err_a or 'unknown'}")

    # Phase 3: TTS variant B
    await state.update_status(job.id, phase="synthesizing variant B")
    wav_b, err_b = await asyncio.wait_for(
        synthesize_speak(chute_slug, sample_script, revised_instruction),
        timeout=PHASE_TIMEOUT_TTS,
    )
    if not wav_b:
        raise RuntimeError(f"Variant B failed: {err_b or 'unknown'}")

    # Storage + DB row
    await state.update_status(job.id, phase="storing previews")
    preview_token = secrets.token_hex(16)
    bucket_a, key_a, exp_a = upload_wav_preview(job.user_id, preview_token, "a", wav_a)
    bucket_b, key_b, exp_b = upload_wav_preview(job.user_id, preview_token, "b", wav_b)
    expires_at = exp_a if exp_a >= exp_b else exp_b

    conn = await get_connection()
    try:
        await conn.execute(
            """
            INSERT INTO studio_voice_design_previews
            (user_id, preview_token, voice_description, revised_instruction, sample_script,
             miner_hotkey, model_name, chute_slug, audio_a_bucket, audio_a_key,
             audio_b_bucket, audio_b_key, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            """,
            (
                job.user_id,
                preview_token,
                voice_desc,
                revised_instruction,
                sample_script,
                payload.get("miner_hotkey") or "",
                payload.get("model_name") or "",
                chute_slug,
                bucket_a,
                key_a,
                bucket_b,
                key_b,
                expires_at.isoformat() if expires_at else "",
            ),
        )
        await conn.commit()
    finally:
        await conn.close()

    url_a = get_presigned_url(bucket_a, key_a, expires_at, public=False) or ""
    url_b = get_presigned_url(bucket_b, key_b, expires_at, public=False) or ""
    return {
        "mode": "preview",
        "preview_token": preview_token,
        "sample_script": sample_script,
        "revised_instruction": revised_instruction,
        "audio_a_url": url_a,
        "audio_b_url": url_b,
        # Provide a default `audio_url` so the toast Play button gets variant A
        "audio_url": url_a,
    }


# ── Speak branch ───────────────────────────────────────────────────────────


async def _run_speak(job: state.Job) -> dict:
    payload = job.payload
    voice_id = payload.get("voice_id")
    target = (payload.get("target_text") or "").strip()
    if not target:
        raise RuntimeError("target_text missing in payload")
    if not voice_id:
        raise RuntimeError("voice_id missing in payload")

    # Look up saved voice reference
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT display_name, ref_script, audio_s3_bucket, audio_s3_key, expires_at "
            "FROM studio_user_designed_voices WHERE id = ? AND user_id = ?",
            (int(voice_id), job.user_id),
        )).fetchone()
    finally:
        await conn.close()
    if not row:
        raise RuntimeError("Designed voice not found")
    ref_script = (row["ref_script"] or "").strip()
    if not ref_script:
        raise RuntimeError("Stored reference script is empty")
    raw_ref = download_object_bytes(row["audio_s3_bucket"], row["audio_s3_key"])
    if not raw_ref:
        raise RuntimeError("Could not load reference audio from storage")

    await state.update_status(job.id, phase="cloning voice")
    started = time.perf_counter()
    # Let voice_clone_synthesize handle pod selection — its internal
    # dispatcher picks voice_clone pods with the correct per-pod API key.
    try:
        wav_bytes, clone_err = await asyncio.wait_for(
            voice_clone_synthesize(
                reference_audio_bytes=raw_ref,
                reference_text=ref_script,
                target_text=target,
            ),
            timeout=PHASE_TIMEOUT_CLONE,
        )
    except asyncio.TimeoutError:
        raise
    if not wav_bytes:
        raise RuntimeError(clone_err or "Voice clone synthesis failed")
    latency_ms = int((time.perf_counter() - started) * 1000)

    await state.update_status(job.id, phase="storing audio")
    bucket, key, expires_out = upload_wav_to_hippius(job.user_id, wav_bytes, subdir="voice-design/speak")

    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            INSERT INTO studio_clone_history
            (user_id, reference_text, target_text, source_mode, source_audio_filename, source_language,
             chute_slug, audio_s3_bucket, audio_s3_key, expires_at, credits_used,
             stt_latency_ms, clone_latency_ms, status, created_at)
            VALUES (?, ?, ?, 'designed_voice', ?, ?, ?, ?, ?, ?, ?, 0, ?, 'completed', datetime('now'))
            """,
            (
                job.user_id,
                ref_script,
                target,
                row["display_name"] or "My voice",
                None,
                voice_clone_endpoint_label(),
                bucket,
                key,
                expires_out.isoformat() if expires_out else "",
                int(job.credits_charged or 0),
                latency_ms,
            ),
        )
        history_id = int(cursor.lastrowid)
        await conn.commit()
    finally:
        await conn.close()

    audio_url = get_presigned_url(bucket, key, expires_out, public=False) or ""
    return {
        "mode": "speak",
        "audio_url": audio_url,
        "history_id": history_id,
        "latency_ms": latency_ms,
    }
