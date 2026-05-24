"""TTS task processor."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import logging
import time

from local_db import get_connection
from studio_tts_service import get_presigned_url, synthesize_speak, upload_wav_to_hippius

from .. import state
from ..registry import TTS_POOL
from ..timeouts import PHASE_TIMEOUT_TTS


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


def _humanize_miner_error(err: str) -> str:
    """Map known miner failure patterns to user-facing messages. Falls back to the raw error.
    Surfaces in the failed-job error_message → toast/UI notice on the frontend."""
    if not err:
        return ""
    low = err.lower()
    if "invalid duration" in low:
        return (
            "This text would produce audio longer than the model supports. "
            "Try shorter text or a faster style."
        )
    return err


async def process_tts(job: state.Job) -> dict:
    payload = job.payload
    text = (payload.get("text") or "").strip()
    if not text:
        raise RuntimeError("text missing in payload")
    instruction = (payload.get("style_instruction") or "neutral voice").strip()
    chute_slug = payload.get("chute_slug") or ""
    miner_hotkey = payload.get("miner_hotkey") or ""
    model_name = payload.get("model_name") or ""

    await state.update_status(job.id, phase="generating speech")
    started = time.perf_counter()

    async with _pick_tts_pod() as pod:
        await state.update_status(job.id, pod_url=pod)
        try:
            wav_bytes, err = await asyncio.wait_for(
                synthesize_speak(chute_slug, text, instruction, base_url=pod),
                timeout=PHASE_TIMEOUT_TTS,
            )
        except asyncio.TimeoutError:
            TTS_POOL.quarantine(pod)
            raise
    if not wav_bytes:
        if err and ("returned 5" in err or "timed out" in err.lower()):
            TTS_POOL.quarantine(pod)
        raise RuntimeError(_humanize_miner_error(err) or "TTS synthesis failed")
    latency_ms = int((time.perf_counter() - started) * 1000)

    await state.update_status(job.id, phase="storing audio")
    bucket, key, expires_at = upload_wav_to_hippius(job.user_id, wav_bytes, subdir="tts")

    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            INSERT INTO studio_tts_history
            (user_id, miner_hotkey, model_name, prompt_text, style_instruction,
             audio_s3_bucket, audio_s3_key, expires_at, credits_used, latency_ms, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', datetime('now'))
            """,
            (
                job.user_id,
                miner_hotkey,
                model_name,
                text,
                instruction,
                bucket,
                key,
                expires_at.isoformat() if expires_at else "",
                int(job.credits_charged or 0),
                latency_ms,
            ),
        )
        history_id = int(cursor.lastrowid)
        await conn.commit()
    finally:
        await conn.close()

    audio_url = get_presigned_url(bucket, key, expires_at, public=False) or ""
    return {
        "audio_url": audio_url,
        "history_id": history_id,
        "latency_ms": latency_ms,
    }
