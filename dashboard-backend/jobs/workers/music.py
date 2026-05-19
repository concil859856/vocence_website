"""Music task processor — full lifecycle inside the worker.

Dispatches on ``payload['task']`` to one of the six ACE-Step operations.
All variants share the same pod pool (one job per pod at a time) and
the same per-phase timeout (PHASE_TIMEOUT_MUSIC), since they all run on
the same ACE-Step model on the same servers.

Flow per task:
    1. Acquire music pod (MUSIC_POOL.acquire)
    2. Decode source audio from payload.src_audio_b64 (if the task needs it)
    3. Call ACE-Step with asyncio.wait_for(timeout=PHASE_TIMEOUT_MUSIC)
    4. Upload result WAV to R2
    5. Insert studio_music_history row tagged with this task
    6. Return {audio_url, history_id, expires_at, latency_ms}
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json as _json
import logging
import time

from local_db import get_connection
from studio_music_service import (
    generate_audio2audio,
    generate_edit,
    generate_extend,
    generate_repaint,
    generate_retake,
    generate_text2music,
)
from studio_tts_service import get_presigned_url, upload_wav_to_hippius

from .. import state
from ..registry import MUSIC_POOL
from ..timeouts import PHASE_TIMEOUT_MUSIC


_log = logging.getLogger(__name__)


_VALID_TASKS = {"text2music", "audio2audio", "retake", "repaint", "edit", "extend"}
_AUDIO_REQUIRED_TASKS = {"audio2audio", "retake", "repaint", "edit", "extend"}


def _decode_source_audio(payload: dict) -> tuple[bytes, str]:
    """Pull base64-encoded source audio out of the payload."""
    b64 = payload.get("src_audio_b64") or ""
    if not b64:
        raise RuntimeError("src_audio_b64 is required for this task")
    try:
        raw = base64.b64decode(b64, validate=False)
    except (binascii.Error, ValueError) as e:
        raise RuntimeError(f"Invalid src_audio_b64: {e}") from e
    if not raw:
        raise RuntimeError("src_audio_b64 decoded to empty bytes")
    filename = payload.get("src_audio_filename") or "source.wav"
    return raw, filename


async def _run_task(task: str, payload: dict, pod_url: str):
    """Call the right generate_X for ``task``. Returns (wav_bytes, audio_path, err)."""
    if task == "text2music":
        return await generate_text2music(
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
        )

    src_bytes, src_name = _decode_source_audio(payload)

    if task == "audio2audio":
        return await generate_audio2audio(
            base_url=pod_url,
            ref_audio_bytes=src_bytes,
            ref_audio_filename=src_name,
            prompt=payload.get("prompt", ""),
            lyrics=payload.get("lyrics", ""),
            audio_duration=float(payload.get("audio_duration") or 60.0),
            ref_audio_strength=float(payload.get("ref_audio_strength") or 0.5),
            format=payload.get("format") or "wav",
            infer_step=int(payload.get("infer_step") or 60),
            guidance_scale=float(payload.get("guidance_scale") or 15.0),
        )

    if task == "retake":
        return await generate_retake(
            base_url=pod_url,
            src_audio_bytes=src_bytes,
            src_audio_filename=src_name,
            prompt=payload.get("prompt", ""),
            lyrics=payload.get("lyrics", ""),
            retake_variance=float(payload.get("retake_variance") or 0.2),
            retake_seeds=payload.get("retake_seeds") or "",
            format=payload.get("format") or "wav",
            infer_step=int(payload.get("infer_step") or 60),
            guidance_scale=float(payload.get("guidance_scale") or 15.0),
        )

    if task == "repaint":
        return await generate_repaint(
            base_url=pod_url,
            src_audio_bytes=src_bytes,
            src_audio_filename=src_name,
            prompt=payload.get("prompt", ""),
            lyrics=payload.get("lyrics", ""),
            repaint_start=float(payload.get("repaint_start") or 0.0),
            repaint_end=float(payload.get("repaint_end") or 30.0),
            retake_variance=float(payload.get("retake_variance") or 0.2),
            format=payload.get("format") or "wav",
            infer_step=int(payload.get("infer_step") or 60),
            guidance_scale=float(payload.get("guidance_scale") or 15.0),
        )

    if task == "edit":
        target_prompt = payload.get("edit_target_prompt") or ""
        if not target_prompt.strip():
            raise RuntimeError("edit_target_prompt is required for edit task")
        return await generate_edit(
            base_url=pod_url,
            src_audio_bytes=src_bytes,
            src_audio_filename=src_name,
            prompt=payload.get("prompt", ""),
            lyrics=payload.get("lyrics", ""),
            edit_target_prompt=target_prompt,
            edit_target_lyrics=payload.get("edit_target_lyrics") or "",
            edit_n_min=float(payload.get("edit_n_min") or 0.6),
            edit_n_max=float(payload.get("edit_n_max") or 1.0),
            retake_seeds=payload.get("retake_seeds") or "",
            format=payload.get("format") or "wav",
            infer_step=int(payload.get("infer_step") or 60),
            guidance_scale=float(payload.get("guidance_scale") or 15.0),
        )

    if task == "extend":
        return await generate_extend(
            base_url=pod_url,
            src_audio_bytes=src_bytes,
            src_audio_filename=src_name,
            prompt=payload.get("prompt", ""),
            lyrics=payload.get("lyrics", ""),
            left_extend_length=float(payload.get("left_extend_length") or 0.0),
            right_extend_length=float(payload.get("right_extend_length") or 30.0),
            extend_seeds=payload.get("extend_seeds") or "",
            format=payload.get("format") or "wav",
            infer_step=int(payload.get("infer_step") or 60),
            guidance_scale=float(payload.get("guidance_scale") or 15.0),
        )

    raise RuntimeError(f"Unknown music task: {task!r}")


def _history_metadata(task: str, payload: dict) -> dict:
    """Build the metadata_json blob mirroring the legacy per-task fields."""
    if task == "text2music":
        return {
            "prompt": payload.get("prompt", ""),
            "title": (payload.get("title") or "")[:120],
            "guidance_scale": payload.get("guidance_scale"),
            "scheduler_type": payload.get("scheduler_type"),
        }
    if task == "audio2audio":
        return {"ref_audio_strength": payload.get("ref_audio_strength")}
    if task == "retake":
        return {
            "retake_variance": payload.get("retake_variance"),
            "retake_seeds": payload.get("retake_seeds"),
            "infer_step": payload.get("infer_step"),
            "guidance_scale": payload.get("guidance_scale"),
        }
    if task == "repaint":
        return {
            "repaint_start": payload.get("repaint_start"),
            "repaint_end": payload.get("repaint_end"),
            "retake_variance": payload.get("retake_variance"),
            "infer_step": payload.get("infer_step"),
            "guidance_scale": payload.get("guidance_scale"),
        }
    if task == "edit":
        return {
            "edit_target_prompt": payload.get("edit_target_prompt"),
            "edit_target_lyrics": payload.get("edit_target_lyrics"),
            "edit_n_min": payload.get("edit_n_min"),
            "edit_n_max": payload.get("edit_n_max"),
            "retake_seeds": payload.get("retake_seeds"),
            "infer_step": payload.get("infer_step"),
            "guidance_scale": payload.get("guidance_scale"),
        }
    if task == "extend":
        return {
            "left_extend_length": payload.get("left_extend_length"),
            "right_extend_length": payload.get("right_extend_length"),
            "extend_seeds": payload.get("extend_seeds"),
            "infer_step": payload.get("infer_step"),
            "guidance_scale": payload.get("guidance_scale"),
        }
    return {}


async def process_music(job: state.Job) -> dict:
    payload = job.payload
    task = (payload.get("task") or "text2music").lower()
    if task not in _VALID_TASKS:
        raise RuntimeError(f"Unknown music task: {task!r}")
    if not MUSIC_POOL.configured():
        raise RuntimeError("Music pool is not configured")

    await state.update_status(job.id, phase=f"generating music ({task})")
    started = time.perf_counter()

    err: str | None = None
    async with MUSIC_POOL.acquire() as pod_url:
        await state.update_status(job.id, pod_url=pod_url)
        try:
            wav_bytes, audio_path, err = await asyncio.wait_for(
                _run_task(task, payload, pod_url),
                timeout=PHASE_TIMEOUT_MUSIC,
            )
        except asyncio.TimeoutError:
            MUSIC_POOL.quarantine(pod_url)
            raise

    if not wav_bytes:
        if err and ("returned 5" in err or "timed out" in err or "connect" in err.lower()):
            MUSIC_POOL.quarantine(pod_url)
        raise RuntimeError(err or "Music generation failed")

    await state.update_status(job.id, phase="storing audio")
    bucket, key, expires_at = upload_wav_to_hippius(job.user_id, wav_bytes, subdir="music")
    latency_ms = int((time.perf_counter() - started) * 1000)

    title = (payload.get("title") or payload.get("prompt") or "")[:120]
    metadata = _history_metadata(task, payload)
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
                task,
                title or payload.get("prompt", ""),
                payload.get("lyrics") or "",
                float(payload.get("audio_duration") or 0.0),
                payload.get("format") or "wav",
                bucket,
                key,
                expires_at.isoformat() if expires_at else "",
                int(job.credits_charged or 0),
                latency_ms,
                _json.dumps(metadata),
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
        "task": task,
    }
