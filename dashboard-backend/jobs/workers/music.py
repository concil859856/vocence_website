"""Music task processor — full lifecycle inside the worker.

Flow:
    1. Acquire music pod
    2. Call ACE-Step
    3. Upload WAV to R2 (Hippius/R2 same helper)
    4. Insert into studio_music_history
    5. Return result dict (audio_url, history_id) — written to generation_jobs.result_json
"""

from __future__ import annotations

import asyncio
import json as _json
import logging
import time
from datetime import datetime, timezone

from local_db import get_connection
from studio_music_service import generate_text2music
from studio_tts_service import get_presigned_url, upload_wav_to_hippius

from .. import state
from ..registry import MUSIC_POOL
from ..timeouts import PHASE_TIMEOUT_MUSIC


_log = logging.getLogger(__name__)


async def process_music(job: state.Job) -> dict:
    payload = job.payload
    if not MUSIC_POOL.configured():
        raise RuntimeError("Music pool is not configured")

    await state.update_status(job.id, phase="generating music")
    started = time.perf_counter()

    async with MUSIC_POOL.acquire() as pod_url:
        await state.update_status(job.id, pod_url=pod_url)
        try:
            wav_bytes, audio_path, err = await asyncio.wait_for(
                generate_text2music(
                    base_url=pod_url,
                    prompt=payload.get("prompt", ""),
                    lyrics=payload.get("lyrics", ""),
                    audio_duration=float(payload.get("audio_duration") or 60.0),
                    format=payload.get("format") or "wav",
                    infer_step=int(payload.get("infer_step") or 60),
                    guidance_scale=float(payload.get("guidance_scale") or 15.0),
                    scheduler_type=payload.get("scheduler_type") or "euler",
                    cfg_type=payload.get("cfg_type") or "apg",
                    omega_scale=float(payload.get("omega_scale") or 10.0),
                    manual_seeds=payload.get("manual_seeds") or "",
                    guidance_interval=float(payload.get("guidance_interval") or 0.5),
                    guidance_interval_decay=float(payload.get("guidance_interval_decay") or 0.0),
                    min_guidance_scale=float(payload.get("min_guidance_scale") or 3.0),
                    use_erg_tag=bool(payload.get("use_erg_tag", True)),
                    use_erg_lyric=bool(payload.get("use_erg_lyric", False)),
                    use_erg_diffusion=bool(payload.get("use_erg_diffusion", True)),
                    oss_steps=payload.get("oss_steps") or "",
                    guidance_scale_text=float(payload.get("guidance_scale_text") or 0.0),
                    guidance_scale_lyric=float(payload.get("guidance_scale_lyric") or 0.0),
                    lora_name_or_path=payload.get("lora_name_or_path") or "none",
                ),
                timeout=PHASE_TIMEOUT_MUSIC,
            )
        except asyncio.TimeoutError:
            MUSIC_POOL.quarantine(pod_url)
            raise

    if not wav_bytes:
        if err and ("returned 5" in err or "timed out" in err or "connect" in err.lower()):
            MUSIC_POOL.quarantine(pod_url)
        raise RuntimeError(err or "Music generation failed")

    # Upload result
    await state.update_status(job.id, phase="storing audio")
    bucket, key, expires_at = upload_wav_to_hippius(job.user_id, wav_bytes, subdir="music")
    latency_ms = int((time.perf_counter() - started) * 1000)

    # Insert into studio_music_history (mirrors legacy handler)
    title = (payload.get("title") or payload.get("prompt") or "")[:120]
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            INSERT INTO studio_music_history
            (user_id, task, prompt_text, lyrics, audio_duration, audio_format,
             audio_s3_bucket, audio_s3_key, expires_at, credits_used, latency_ms, status, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, datetime('now'))
            """,
            (
                job.user_id,
                "text2music",
                title or payload.get("prompt", ""),
                payload.get("lyrics") or "",
                float(payload.get("audio_duration") or 60.0),
                payload.get("format") or "wav",
                bucket,
                key,
                expires_at.isoformat() if expires_at else "",
                int(job.credits_charged or 0),
                latency_ms,
                _json.dumps({"prompt": payload.get("prompt", ""), "title": title}),
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
        "expires_at": expires_at.isoformat() if expires_at else "",
        "latency_ms": latency_ms,
    }
