"""Studio TTS API: configured models (env), generate, history."""

import logging
import os
import re
import secrets
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile

from database import acquire
from local_db import get_connection, record_credit_transaction, refresh_daily_usage_for_day
from ranking import (
    RANKING_WINDOW_EVALS,
    get_ranked_miner_stats_for_validator,
    sort_miners_for_display,
)
from routers.auth import require_auth
from schemas import (
    StudioClonedVoiceSaveResponse,
    StudioCloneResponse,
    StudioDesignedVoiceItem,
    StudioDesignedVoiceSpeakRequest,
    StudioDesignedVoicesResponse,
    StudioGenerateRequest,
    StudioGenerateResponse,
    StudioTtsSampleVoiceRequest,
    StudioHistoryItemResponse,
    StudioHistoryResponse,
    StudioMusicGenerateResponse,
    StudioMusicLyricsRequest,
    StudioMusicLyricsResponse,
    StudioMusicHistoryItemResponse,
    StudioMusicHistoryResponse,
    StudioMusicText2MusicRequest,
    StudioTranscribeResponse,
    StudioTopModelResponse,
    StudioTopModelsResponse,
    StudioVoiceDesignConfigResponse,
    StudioVoiceDesignPreviewRequest,
    StudioVoiceDesignPreviewResponse,
    StudioVoiceDesignSaveRequest,
    StudioVoiceDesignSaveResponse,
)
from jobs.registry import MUSIC_POOL
from studio_music_service import (
    generate_audio2audio as music_audio2audio,
    generate_edit as music_edit,
    generate_extend as music_extend,
    generate_repaint as music_repaint,
    generate_retake as music_retake,
    generate_text2music as music_text2music,
    music_gen_configured,
)
from studio_tts_service import (
    VOICE_DESIGN_SAMPLE_WORDS_MAX,
    VOICE_DESIGN_SAMPLE_WORDS_MIN,
    copy_wav_in_bucket,
    delete_object,
    download_object_bytes,
    fetch_chute_slug,
    get_presigned_url,
    synthesize_speak,
    transcribe_audio,
    upload_wav_preview,
    upload_wav_to_hippius,
    voice_clone_chute_configured,
    voice_clone_endpoint_label,
    voice_clone_synthesize,
    voice_design_llm_configured,
    voice_design_llm_plan,
)

router = APIRouter(prefix="/studio", tags=["studio"])
logger = logging.getLogger(__name__)


async def _is_premium_user(user_id: str) -> bool:
    """Check if user has premium plan (paid premium at least once)."""
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            """
            SELECT COUNT(*) AS n FROM payments
            WHERE user_id = ? AND status IN ('paid', 'completed')
              AND credits_granted > 0
              AND LOWER(COALESCE(plan_code, '')) = 'premium'
            """,
            (user_id,),
        )).fetchone()
        return int(row["n"] or 0) > 0
    except Exception:
        return False
    finally:
        await conn.close()


def _main_validator_hotkey(validators_rows: list) -> str | None:
    main = (os.environ.get("LIVE_VALIDATION_MAIN_VALIDATOR_HOTKEY") or "").strip()
    if main:
        return main
    return validators_rows[0]["hotkey"] if validators_rows else None


def _model_display_name(model_name: str | None) -> str:
    """Repo name only: 'user/repo-name' -> 'repo-name'."""
    if not (model_name or "").strip():
        return "Unknown"
    if "/" in model_name:
        return model_name.split("/", 1)[1].strip() or model_name
    return model_name


def _configured_studio_models() -> list[StudioTopModelResponse]:
    """
    Read configured studio models from env variables:
      STUDIO_MODEL_<N>_NAME
      STUDIO_MODEL_<N>_CHUTE_SLUG
      STUDIO_MODEL_<N>_CHUTE_ID        (optional)
      STUDIO_MODEL_<N>_MINER_HOTKEY    (optional)
    """
    index_pattern = re.compile(r"^STUDIO_MODEL_(\d+)_NAME$")
    indices: list[int] = []
    for key in os.environ:
        m = index_pattern.match(key)
        if m:
            indices.append(int(m.group(1)))
    indices = sorted(set(indices))

    models: list[StudioTopModelResponse] = []
    for idx in indices:
        name = (os.environ.get(f"STUDIO_MODEL_{idx}_NAME") or "").strip()
        chute_slug = (os.environ.get(f"STUDIO_MODEL_{idx}_CHUTE_SLUG") or "").strip()
        if not name or not chute_slug:
            continue
        chute_id = (os.environ.get(f"STUDIO_MODEL_{idx}_CHUTE_ID") or "").strip()
        miner_hotkey = (os.environ.get(f"STUDIO_MODEL_{idx}_MINER_HOTKEY") or f"configured:{idx}").strip()
        models.append(
            StudioTopModelResponse(
                miner_hotkey=miner_hotkey,
                model_name=name,
                display_name=_model_display_name(name),
                chute_id=chute_id,
                chute_slug=chute_slug,
            )
        )
    return models


@router.get("/builtin-voices")
async def list_builtin_voices(_: str = Depends(require_auth)) -> dict:
    """Pre-defined sample voices users can pass to TTS. Stable ids + a
    short human-readable name/description.

    Only CDN-hosted voices are exposed via the public API for now —
    local-disk voices depend on the dashboard-backend process having
    fresh module state for ``SAMPLE_VOICE_LOCAL_FILES`` and are
    therefore unreliable to advertise. Studio's UI still uses the full
    catalog directly."""
    from sample_voices_data import SAMPLE_VOICE_METADATA, get_sample_url
    return {
        "voices": [
            {"id": vid, "name": meta["name"], "description": meta["description"]}
            for vid, meta in SAMPLE_VOICE_METADATA.items()
            if get_sample_url(vid)  # CDN-hosted only — local files are filtered out
        ]
    }


@router.get("/top-models", response_model=StudioTopModelsResponse)
async def get_top_models(limit: int = Query(3, ge=1, le=10)):
    """Studio models from env config; fallback to ranked miners if no config exists."""
    configured = _configured_studio_models()
    if configured:
        return StudioTopModelsResponse(models=configured[:limit])

    # Fallback behavior for backward compatibility when env config is not set.
    async with acquire() as conn:
        val_rows = await conn.fetch(
            "SELECT uid, hotkey FROM validator_registry ORDER BY uid ASC"
        )
    main_hotkey = _main_validator_hotkey(val_rows)
    if not main_hotkey:
        return StudioTopModelsResponse(models=[])

    async with acquire() as conn:
        stats = await get_ranked_miner_stats_for_validator(conn, main_hotkey, RANKING_WINDOW_EVALS)
        if not stats:
            return StudioTopModelsResponse(models=[])
        ordered = sort_miners_for_display(stats)
        hotkeys = [s["miner_hotkey"] for s in ordered]
        rows = await conn.fetch("""
            SELECT miner_hotkey, model_name, chute_id, chute_slug
            FROM registered_miners
            WHERE miner_hotkey = ANY($1::text[]) AND is_valid = true
        """, hotkeys)
        rm_by_hotkey = {r["miner_hotkey"]: r for r in rows}
    models = []
    for s in ordered:
        if len(models) >= limit:
            break
        if s["miner_hotkey"] not in rm_by_hotkey:
            continue
        r = rm_by_hotkey[s["miner_hotkey"]]
        models.append(
            StudioTopModelResponse(
                miner_hotkey=r["miner_hotkey"],
                model_name=r["model_name"] or "",
                display_name=_model_display_name(r["model_name"]),
                chute_id=r["chute_id"] or "",
                chute_slug=r["chute_slug"] or "",
            )
        )
    return StudioTopModelsResponse(models=models)


TTS_CREDITS_COST = int(os.environ.get("STUDIO_TTS_CREDITS_COST", "25"))
STT_CREDITS_COST = int(os.environ.get("STUDIO_STT_CREDITS_COST", "20"))
STT_MAX_UPLOAD_BYTES = int(os.environ.get("STUDIO_STT_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))
CLONE_CREDITS_COST = int(os.environ.get("STUDIO_CLONE_CREDITS_COST", "50"))
CLONE_MAX_REF_AUDIO_BYTES = int(os.environ.get("STUDIO_CLONE_MAX_REF_AUDIO_BYTES", str(50 * 1024 * 1024)))
VOICE_DESIGN_PREVIEW_CREDITS = int(os.environ.get("STUDIO_VOICE_DESIGN_PREVIEW_CREDITS", "120"))
VOICE_DESIGN_SPEAK_CREDITS = int(os.environ.get("STUDIO_VOICE_DESIGN_SPEAK_CREDITS", "25"))
MUSIC_CREDITS_COST = int(os.environ.get("STUDIO_MUSIC_CREDITS_COST", "50"))
MUSIC_MAX_UPLOAD_BYTES = int(os.environ.get("STUDIO_MUSIC_MAX_UPLOAD_BYTES", str(100 * 1024 * 1024)))
# Tiered duration caps by inference quality.
#
# Higher infer_step values multiply the per-second compute cost. A 300 s
# Max-quality (120 steps) song already takes ~10 minutes on a single
# pod — right at the LB_PHASE_TIMEOUT_MUSIC ceiling — so we cap shorter
# the higher the quality. Fast jobs can run longer because they finish
# in roughly proportional wall-clock time.
#
# The ``infer_step`` thresholds match the frontend mode presets:
#     Fast      = 27   → up to FAST_MAX     (default 400 s)
#     Balanced  = 60   → up to BALANCED_MAX (default 300 s)
#     Max       = 120  → up to MAX_MAX      (default 200 s)
# Anything between tiers takes the next-stricter cap.
MUSIC_MAX_DURATION_FAST_SEC     = float(os.environ.get("MUSIC_MAX_DURATION_FAST_SEC",     "400"))
MUSIC_MAX_DURATION_BALANCED_SEC = float(os.environ.get("MUSIC_MAX_DURATION_BALANCED_SEC", "300"))
MUSIC_MAX_DURATION_MAX_SEC      = float(os.environ.get("MUSIC_MAX_DURATION_MAX_SEC",      "200"))
# Absolute hard ceiling — no combination of inputs may exceed this.
MUSIC_MAX_DURATION_SEC = max(
    MUSIC_MAX_DURATION_FAST_SEC,
    MUSIC_MAX_DURATION_BALANCED_SEC,
    MUSIC_MAX_DURATION_MAX_SEC,
)


def _max_music_duration_for_steps(infer_step: int) -> float:
    """Pick the tiered duration cap that matches the requested quality.
    Tiers are inclusive of their named step count; anything higher steps
    up to the stricter tier."""
    if infer_step <= 30:
        return MUSIC_MAX_DURATION_FAST_SEC
    if infer_step <= 70:
        return MUSIC_MAX_DURATION_BALANCED_SEC
    return MUSIC_MAX_DURATION_MAX_SEC


async def _resolve_studio_tts_chute(
    chute_slug: str,
    chute_id: str,
    model_name: str,
    miner_hotkey: str,
) -> tuple[str, str, str]:
    """Match generate_tts model selection: env-configured slugs or legacy chute_id lookup."""
    configured_models = _configured_studio_models()
    configured_by_slug = {m.chute_slug: m for m in configured_models}
    if configured_models:
        selected = configured_by_slug.get(chute_slug)
        if not selected:
            raise HTTPException(status_code=400, detail="Invalid studio model selection.")
        return selected.chute_slug, selected.model_name, selected.miner_hotkey
    slug = (chute_slug or "").strip()
    if not slug:
        slug_res = await fetch_chute_slug(chute_id)
        if not slug_res:
            raise HTTPException(status_code=400, detail="Could not resolve chute; chute may be offline.")
        slug = slug_res
    return slug, model_name, miner_hotkey


def _configured_stt_provider() -> str:
    """Returns provider display name for logs/history."""
    name = (os.environ.get("STUDIO_STT_PROVIDER_NAME") or "").strip()
    return name or "Whisper Large v3"


@router.post("/generate", response_model=StudioGenerateResponse)
async def generate_tts(body: StudioGenerateRequest, user_id: str = Depends(require_auth)):
    """Call miner's Chutes /speak, upload WAV to Hippius, store in website.db, deduct TTS credits."""
    if body.user_id != user_id:
        raise HTTPException(status_code=403, detail="user_id does not match authenticated user")

    conn = await get_connection()
    try:
        cursor = await conn.execute(
            "SELECT credits FROM auth_users WHERE id = ?",
            (user_id,),
        )
        row = await cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        credits = int(row["credits"])
        if credits < TTS_CREDITS_COST:
            raise HTTPException(
                status_code=402,
                detail=f"Insufficient credits. Need {TTS_CREDITS_COST} credits for TTS generation. You have {credits}.",
            )
    finally:
        await conn.close()

    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    instruction = (body.style_instruction or "").strip() or "neutral voice"
    chute_slug, effective_model_name, effective_miner_hotkey = await _resolve_studio_tts_chute(
        body.chute_slug,
        body.chute_id,
        body.model_name,
        body.miner_hotkey,
    )

    wav_bytes, err_msg = await synthesize_speak(chute_slug, text, instruction)
    if not wav_bytes:
        detail = "TTS request to miner failed or returned no audio."
        if err_msg:
            detail += f" ({err_msg})"
        raise HTTPException(status_code=502, detail=detail)

    bucket, key, expires_at = upload_wav_to_hippius(body.user_id, wav_bytes, subdir="tts")

    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            INSERT INTO studio_tts_history
            (user_id, miner_hotkey, model_name, prompt_text, style_instruction, audio_s3_bucket, audio_s3_key, expires_at, credits_used, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', datetime('now'))
            """,
            (
                body.user_id,
                effective_miner_hotkey,
                effective_model_name or "",
                text,
                instruction,
                bucket,
                key,
                expires_at.isoformat(),
                TTS_CREDITS_COST,
            ),
        )
        history_id = int(cursor.lastrowid)
        expires_at_val = expires_at
        await conn.execute(
            "UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') WHERE id = ?",
            (TTS_CREDITS_COST, user_id),
        )
        credit_cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        new_row = await credit_cursor.fetchone()
        new_credits = int(new_row["credits"]) if new_row else credits - TTS_CREDITS_COST
        await record_credit_transaction(
            conn,
            user_id=user_id,
            transaction_type="tts_generation",
            amount=-TTS_CREDITS_COST,
            balance_after=new_credits,
            description=f"TTS generation via {effective_model_name or effective_miner_hotkey}",
            reference_type="studio_tts_history",
            reference_id=str(history_id),
            metadata={"miner_hotkey": effective_miner_hotkey, "model_name": effective_model_name or ""},
        )
        await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())
        await conn.commit()
    finally:
        await conn.close()

    is_premium = await _is_premium_user(user_id)
    audio_url = get_presigned_url(bucket, key, expires_at_val, public=is_premium)
    if not audio_url:
        audio_url = ""

    return StudioGenerateResponse(
        id=history_id,
        audio_url=audio_url,
        expires_at=expires_at_val.isoformat() if expires_at_val else "",
        credits=new_credits,
    )


@router.post("/transcribe", response_model=StudioTranscribeResponse)
async def transcribe_stt(
    user_id_form: str = Form(..., alias="user_id"),
    language: str | None = Form(None),
    audio_file: UploadFile = File(...),
    user_id: str = Depends(require_auth),
):
    if user_id_form != user_id:
        raise HTTPException(status_code=403, detail="user_id does not match authenticated user")
    if not audio_file.filename:
        raise HTTPException(status_code=400, detail="audio_file is required")

    raw = await audio_file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty audio file")
    if len(raw) > STT_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"Audio exceeds max size ({STT_MAX_UPLOAD_BYTES} bytes)")

    provider_name = _configured_stt_provider()
    started = time.perf_counter()
    conn = await get_connection()
    try:
        cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        credits = int(row["credits"])
        if credits < STT_CREDITS_COST:
            raise HTTPException(
                status_code=402,
                detail=f"Insufficient credits. Need {STT_CREDITS_COST} credits for STT. You have {credits}.",
            )
    finally:
        await conn.close()

    lang = (language or "").strip() or None
    result, err_msg = await transcribe_audio(
        audio_bytes=raw,
        language=lang,
    )
    if not result:
        detail = "STT request to provider failed."
        if err_msg:
            detail += f" ({err_msg})"
        raise HTTPException(status_code=502, detail=detail)

    text = str(result.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=502, detail="STT provider returned empty text")

    detected_language = result.get("language")
    duration_seconds = result.get("duration_seconds")
    latency_ms = int((time.perf_counter() - started) * 1000)

    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            INSERT INTO studio_stt_history
            (user_id, provider_name, source_audio_filename, source_language, duration_seconds, transcribed_text,
             credits_used, latency_ms, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', datetime('now'))
            """,
            (
                user_id,
                provider_name,
                audio_file.filename,
                detected_language or lang,
                float(duration_seconds) if duration_seconds is not None else None,
                text,
                STT_CREDITS_COST,
                latency_ms,
            ),
        )
        history_id = int(cursor.lastrowid)
        await conn.execute(
            "UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') WHERE id = ?",
            (STT_CREDITS_COST, user_id),
        )
        credit_cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        new_row = await credit_cursor.fetchone()
        new_credits = int(new_row["credits"]) if new_row else credits - STT_CREDITS_COST
        await record_credit_transaction(
            conn,
            user_id=user_id,
            transaction_type="stt_transcription",
            amount=-STT_CREDITS_COST,
            balance_after=new_credits,
            description=f"STT transcription via {provider_name}",
            reference_type="studio_stt_history",
            reference_id=str(history_id),
            metadata={
                "provider_name": provider_name,
                "source_audio_filename": audio_file.filename,
                "language": detected_language or lang,
            },
        )
        await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())
        await conn.commit()
    finally:
        await conn.close()

    return StudioTranscribeResponse(
        id=history_id,
        text=text,
        language=(detected_language or lang),
        credits=new_credits,
        duration_seconds=float(duration_seconds) if duration_seconds is not None else None,
    )


@router.post("/clone", response_model=StudioCloneResponse)
async def clone_voice(
    user_id_form: str = Form(..., alias="user_id"),
    target_text: str = Form(...),
    ref_source: str = Form(..., description="upload or record"),
    language: str | None = Form(None),
    reference_text: str | None = Form(None, description="Optional manual transcript of the reference clip; skips STT when provided"),
    audio_file: UploadFile = File(...),
    user_id: str = Depends(require_auth),
):
    """Transcribe reference audio (STT), call voice-clone Chute, upload result to Hippius."""
    if user_id_form != user_id:
        raise HTTPException(status_code=403, detail="user_id does not match authenticated user")
    if not voice_clone_chute_configured():
        raise HTTPException(
            status_code=503,
            detail="Voice cloning is not configured (set STUDIO_VOICE_CLONE_URL or STUDIO_VOICE_CLONE_CHUTE_SLUG).",
        )

    mode = (ref_source or "").strip().lower()
    if mode not in ("upload", "record"):
        raise HTTPException(status_code=400, detail="ref_source must be upload or record")

    target = (target_text or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="target_text is required")

    if not audio_file.filename:
        raise HTTPException(status_code=400, detail="audio_file is required")
    raw_ref = await audio_file.read()
    if not raw_ref:
        raise HTTPException(status_code=400, detail="Empty reference audio")
    if len(raw_ref) > CLONE_MAX_REF_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail=f"Reference audio exceeds max size ({CLONE_MAX_REF_AUDIO_BYTES} bytes)")

    conn = await get_connection()
    try:
        cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        credits = int(row["credits"])
        if credits < CLONE_CREDITS_COST:
            raise HTTPException(
                status_code=402,
                detail=f"Insufficient credits. Need {CLONE_CREDITS_COST} credits for voice cloning. You have {credits}.",
            )
    finally:
        await conn.close()

    lang = (language or "").strip() or None
    clone_endpoint_label = voice_clone_endpoint_label()

    # If the user supplied an explicit reference transcript, skip STT entirely.
    user_supplied_ref = (reference_text or "").strip()
    detected_language: str | None = lang
    stt_latency_ms = 0
    if user_supplied_ref:
        ref_text = user_supplied_ref
    else:
        stt_started = time.perf_counter()
        stt_result, stt_err = await transcribe_audio(audio_bytes=raw_ref, language=lang)
        stt_latency_ms = int((time.perf_counter() - stt_started) * 1000)
        if not stt_result:
            detail = "Could not transcribe reference audio for cloning."
            if stt_err:
                detail += f" ({stt_err})"
            raise HTTPException(status_code=502, detail=detail)
        ref_text = str(stt_result.get("text") or "").strip()
        if not ref_text:
            raise HTTPException(
                status_code=400,
                detail="Reference audio transcribed to empty text; use clearer reference audio or check language.",
            )
        if isinstance(stt_result.get("language"), str):
            detected_language = stt_result.get("language")
    reference_text = ref_text

    clone_started = time.perf_counter()
    out_bytes, clone_err = await voice_clone_synthesize(
        reference_audio_bytes=raw_ref,
        reference_text=reference_text,
        target_text=target,
    )
    clone_latency_ms = int((time.perf_counter() - clone_started) * 1000)
    if not out_bytes:
        detail = "Voice clone request failed."
        if clone_err:
            detail += f" ({clone_err})"
        raise HTTPException(status_code=502, detail=detail)

    bucket, key, expires_at = upload_wav_to_hippius(user_id, out_bytes, subdir="clone")

    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            INSERT INTO studio_clone_history
            (user_id, reference_text, target_text, source_mode, source_audio_filename, source_language,
             chute_slug, audio_s3_bucket, audio_s3_key, expires_at, credits_used,
             stt_latency_ms, clone_latency_ms, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', datetime('now'))
            """,
            (
                user_id,
                reference_text,
                target,
                mode,
                audio_file.filename,
                detected_language,
                clone_endpoint_label,
                bucket,
                key,
                expires_at.isoformat(),
                CLONE_CREDITS_COST,
                stt_latency_ms,
                clone_latency_ms,
            ),
        )
        history_id = int(cursor.lastrowid)
        await conn.execute(
            "UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') WHERE id = ?",
            (CLONE_CREDITS_COST, user_id),
        )
        credit_cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        new_row = await credit_cursor.fetchone()
        new_credits = int(new_row["credits"]) if new_row else credits - CLONE_CREDITS_COST
        await record_credit_transaction(
            conn,
            user_id=user_id,
            transaction_type="voice_clone",
            amount=-CLONE_CREDITS_COST,
            balance_after=new_credits,
            description=f"Voice clone via {clone_endpoint_label}",
            reference_type="studio_clone_history",
            reference_id=str(history_id),
            metadata={"clone_endpoint": clone_endpoint_label, "ref_source": mode},
        )
        await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())
        await conn.commit()
    finally:
        await conn.close()

    is_premium = await _is_premium_user(user_id)
    audio_url = get_presigned_url(bucket, key, expires_at, public=is_premium) or ""
    return StudioCloneResponse(
        id=history_id,
        audio_url=audio_url,
        expires_at=expires_at.isoformat() if expires_at else "",
        credits=new_credits,
        reference_text=reference_text,
        detected_language=detected_language,
    )


# ----------------------------------------------------------------------------
# General TTS via sample voices — voice cloning under the hood, charged at
# TTS price. Reference clip lookup is server-side; client only sends the id.
# ----------------------------------------------------------------------------

import asyncio as _asyncio_general_tts  # local alias to avoid colliding with module-level imports
from sample_voices_data import is_known_sample, get_sample_url

# voice_id -> (audio_bytes, ref_text). Populated lazily per process so the
# first call pays the fetch+STT cost, subsequent calls don't.
_SAMPLE_VOICE_CACHE: dict[str, tuple[bytes, str]] = {}
_SAMPLE_VOICE_CACHE_LOCK = _asyncio_general_tts.Lock()


async def _fetch_sample_audio(url: str) -> bytes:
    import aiohttp
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url) as resp:
            if resp.status != 200:
                raise HTTPException(status_code=502, detail=f"sample audio fetch failed ({resp.status})")
            return await resp.read()


async def _load_sample_voice(voice_id: str) -> tuple[bytes, str]:
    """Return (audio_bytes, reference_text) for a sample voice, with a per-process cache."""
    cached = _SAMPLE_VOICE_CACHE.get(voice_id)
    if cached:
        return cached
    async with _SAMPLE_VOICE_CACHE_LOCK:
        cached = _SAMPLE_VOICE_CACHE.get(voice_id)
        if cached:
            return cached
        url = get_sample_url(voice_id)
        if not url:
            raise HTTPException(status_code=404, detail=f"unknown sample voice: {voice_id}")
        audio = await _fetch_sample_audio(url)
        # Transcribe to feed the voice-clone API (it requires a reference transcript)
        stt_result, stt_err = await transcribe_audio(audio_bytes=audio)
        ref_text = (stt_result or {}).get("text", "").strip() if stt_result else ""
        if not ref_text:
            raise HTTPException(
                status_code=502,
                detail=f"could not transcribe sample voice {voice_id}: {stt_err or 'empty transcript'}",
            )
        _SAMPLE_VOICE_CACHE[voice_id] = (audio, ref_text)
        return audio, ref_text


@router.post("/tts/voice-clone-sample", response_model=StudioCloneResponse)
async def tts_voice_clone_sample(
    body: StudioTtsSampleVoiceRequest,
    user_id: str = Depends(require_auth),
):
    """General TTS using a pre-stored sample voice as the cloning reference.
    Charged at TTS_CREDITS_COST (not the higher clone price) — backend cost
    of the clone call is absorbed."""
    if not voice_clone_chute_configured():
        raise HTTPException(status_code=503, detail="Voice cloning is not configured.")
    if not is_known_sample(body.sample_voice_id):
        raise HTTPException(status_code=404, detail=f"unknown sample voice: {body.sample_voice_id}")
    target = (body.target_text or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="target_text is required")

    # Credit check (TTS price, not clone price)
    conn = await get_connection()
    try:
        cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        credits = int(row["credits"])
        if credits < TTS_CREDITS_COST:
            raise HTTPException(
                status_code=402,
                detail=f"Insufficient credits. Need {TTS_CREDITS_COST} credits. You have {credits}.",
            )
    finally:
        await conn.close()

    # Load sample reference (cached per process)
    raw_ref, reference_text = await _load_sample_voice(body.sample_voice_id)

    # Clone synthesize
    clone_started = time.perf_counter()
    out_bytes, clone_err = await voice_clone_synthesize(
        reference_audio_bytes=raw_ref,
        reference_text=reference_text,
        target_text=target,
    )
    clone_latency_ms = int((time.perf_counter() - clone_started) * 1000)
    if not out_bytes:
        detail = "Voice clone request failed."
        if clone_err:
            detail += f" ({clone_err})"
        raise HTTPException(status_code=502, detail=detail)

    # Upload result
    bucket, key, expires_at = upload_wav_to_hippius(user_id, out_bytes, subdir="clone")
    clone_endpoint_label = voice_clone_endpoint_label()

    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            INSERT INTO studio_clone_history
            (user_id, reference_text, target_text, source_mode, source_audio_filename, source_language,
             chute_slug, audio_s3_bucket, audio_s3_key, expires_at, credits_used,
             stt_latency_ms, clone_latency_ms, status, created_at)
            VALUES (?, ?, ?, 'sample', ?, ?, ?, ?, ?, ?, ?, 0, ?, 'completed', datetime('now'))
            """,
            (
                user_id,
                reference_text,
                target,
                body.sample_voice_id,         # store sample id in filename slot for traceability
                body.target_language,
                clone_endpoint_label,
                bucket,
                key,
                expires_at.isoformat(),
                TTS_CREDITS_COST,             # charge TTS price, not clone price
                clone_latency_ms,
            ),
        )
        history_id = int(cursor.lastrowid)
        await conn.execute(
            "UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') WHERE id = ?",
            (TTS_CREDITS_COST, user_id),
        )
        credit_cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        new_row = await credit_cursor.fetchone()
        new_credits = int(new_row["credits"]) if new_row else credits - TTS_CREDITS_COST
        await record_credit_transaction(
            conn,
            user_id=user_id,
            transaction_type="tts_sample_voice",
            amount=-TTS_CREDITS_COST,
            balance_after=new_credits,
            description=f"General TTS · voice {body.sample_voice_id}",
            reference_type="studio_clone_history",
            reference_id=str(history_id),
            metadata={"sample_voice_id": body.sample_voice_id, "clone_endpoint": clone_endpoint_label},
        )
        await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())
        await conn.commit()
    finally:
        await conn.close()

    is_premium = await _is_premium_user(user_id)
    audio_url = get_presigned_url(bucket, key, expires_at, public=is_premium) or ""
    return StudioCloneResponse(
        id=history_id,
        audio_url=audio_url,
        expires_at=expires_at.isoformat() if expires_at else "",
        credits=new_credits,
        reference_text=reference_text,
        detected_language=body.target_language,
    )


@router.get("/voice-design/config", response_model=StudioVoiceDesignConfigResponse)
async def voice_design_config():
    return StudioVoiceDesignConfigResponse(
        llm_configured=voice_design_llm_configured(),
        preview_credits=VOICE_DESIGN_PREVIEW_CREDITS,
        sample_words_min=VOICE_DESIGN_SAMPLE_WORDS_MIN,
        sample_words_max=VOICE_DESIGN_SAMPLE_WORDS_MAX,
    )


@router.post("/voice-design/preview", response_model=StudioVoiceDesignPreviewResponse)
async def voice_design_preview(body: StudioVoiceDesignPreviewRequest, user_id: str = Depends(require_auth)):
    """LLM proposes a 6–7 word sample line + revised instruction; two TTS previews; charge credits only on success."""
    if body.user_id != user_id:
        raise HTTPException(status_code=403, detail="user_id does not match authenticated user")
    if not voice_design_llm_configured():
        raise HTTPException(
            status_code=503,
            detail=(
                "Voice design LLM is not configured. Set VOICE_DESIGN_LLM_MODEL and CHUTES_API_KEY "
                "(optional VOICE_DESIGN_LLM_BASE_URL defaults to https://llm.chutes.ai/v1 per Chutes docs)."
            ),
        )

    voice_desc = (body.voice_description or "").strip()
    if len(voice_desc) < 4:
        raise HTTPException(status_code=400, detail="Describe the voice in a bit more detail (at least a few words).")

    plan, llm_err = await voice_design_llm_plan(voice_description=voice_desc)
    if not plan:
        detail = llm_err or "Voice design planning failed"
        logger.error(
            "voice_design_preview failed stage=llm_plan user_id=%s desc_len=%s error=%s",
            user_id,
            len(voice_desc),
            detail,
        )
        raise HTTPException(status_code=502, detail=detail)

    sample_script = plan["sample_script"]
    revised_instruction = plan["revised_instruction"]

    conn = await get_connection()
    try:
        cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        credits = int(row["credits"])
        if credits < VOICE_DESIGN_PREVIEW_CREDITS:
            raise HTTPException(
                status_code=402,
                detail=f"Insufficient credits. Voice design preview (voice creation) needs {VOICE_DESIGN_PREVIEW_CREDITS} credits. You have {credits}.",
            )
    finally:
        await conn.close()

    chute_slug, effective_model_name, effective_miner_hotkey = await _resolve_studio_tts_chute(
        body.chute_slug,
        body.chute_id,
        body.model_name,
        body.miner_hotkey,
    )

    wav_a, err_a = await synthesize_speak(chute_slug, sample_script, voice_desc)
    wav_b, err_b = await synthesize_speak(chute_slug, sample_script, revised_instruction)
    if not wav_a or not wav_b:
        parts = []
        if not wav_a:
            parts.append(f"Your description preview failed: {err_a or 'unknown'}")
        if not wav_b:
            parts.append(f"Revised instruction preview failed: {err_b or 'unknown'}")
        detail = " ".join(parts)
        logger.error(
            "voice_design_preview failed stage=tts user_id=%s chute_slug=%s sample_script_len=%s "
            "wav_a_ok=%s err_a=%r wav_b_ok=%s err_b=%r detail=%s",
            user_id,
            chute_slug,
            len(sample_script or ""),
            wav_a is not None,
            err_a,
            wav_b is not None,
            err_b,
            detail,
        )
        raise HTTPException(status_code=502, detail=detail)

    preview_token = secrets.token_hex(16)
    bucket_a, key_a, exp_a = upload_wav_preview(user_id, preview_token, "a", wav_a)
    bucket_b, key_b, exp_b = upload_wav_preview(user_id, preview_token, "b", wav_b)
    expires_at = exp_a if exp_a >= exp_b else exp_b

    conn = await get_connection()
    try:
        await conn.execute(
            """
            INSERT INTO studio_voice_design_previews
            (user_id, preview_token, voice_description, revised_instruction, sample_script,
             miner_hotkey, model_name, chute_slug, audio_a_bucket, audio_a_key, audio_b_bucket, audio_b_key, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            """,
            (
                user_id,
                preview_token,
                voice_desc,
                revised_instruction,
                sample_script,
                effective_miner_hotkey,
                effective_model_name or "",
                chute_slug,
                bucket_a,
                key_a,
                bucket_b,
                key_b,
                expires_at.isoformat(),
            ),
        )
        await conn.execute(
            "UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') WHERE id = ?",
            (VOICE_DESIGN_PREVIEW_CREDITS, user_id),
        )
        credit_cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        new_row = await credit_cursor.fetchone()
        new_credits = int(new_row["credits"]) if new_row else credits - VOICE_DESIGN_PREVIEW_CREDITS
        await record_credit_transaction(
            conn,
            user_id=user_id,
            transaction_type="voice_design_preview",
            amount=-VOICE_DESIGN_PREVIEW_CREDITS,
            balance_after=new_credits,
            description="Voice design A/B preview (2× short TTS)",
            reference_type="studio_voice_design_preview",
            reference_id=preview_token,
            metadata={"chute_slug": chute_slug, "model": effective_model_name or ""},
        )
        await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())
        await conn.commit()
    finally:
        await conn.close()

    url_a = get_presigned_url(bucket_a, key_a, expires_at, public=True) or ""
    url_b = get_presigned_url(bucket_b, key_b, expires_at, public=True) or ""
    return StudioVoiceDesignPreviewResponse(
        preview_token=preview_token,
        sample_script=sample_script,
        voice_description=voice_desc,
        revised_instruction=revised_instruction,
        audio_a_url=url_a,
        audio_b_url=url_b,
        expires_at=expires_at.isoformat(),
        credits=new_credits,
        miner_hotkey=effective_miner_hotkey,
        model_name=effective_model_name or "",
        chute_slug=chute_slug,
    )


@router.post("/voice-design/save", response_model=StudioVoiceDesignSaveResponse)
async def voice_design_save(body: StudioVoiceDesignSaveRequest, user_id: str = Depends(require_auth)):
    """Persist chosen preview variant as a reusable designed voice (7-day ref audio retention like Studio TTS)."""
    if body.user_id != user_id:
        raise HTTPException(status_code=403, detail="user_id does not match authenticated user")
    variant = (body.chosen_variant or "").strip().lower()
    if variant not in ("original", "revised"):
        raise HTTPException(status_code=400, detail='chosen_variant must be "original" or "revised"')
    display_name = (body.display_name or "").strip()
    if not display_name:
        raise HTTPException(status_code=400, detail="display_name is required")
    if len(display_name) > 20:
        raise HTTPException(status_code=400, detail="display_name must be at most 20 characters")
    token = (body.preview_token or "").strip()
    if not token:
        raise HTTPException(status_code=400, detail="preview_token is required")

    # Normal users: max 5 saved voices. Premium: unlimited.
    NORMAL_VOICE_LIMIT = int(os.environ.get("STUDIO_NORMAL_VOICE_LIMIT", "5"))
    is_premium = await _is_premium_user(user_id)
    if not is_premium:
        conn = await get_connection()
        try:
            count_row = await (await conn.execute(
                "SELECT COUNT(*) AS n FROM studio_user_designed_voices WHERE user_id = ?",
                (user_id,),
            )).fetchone()
            voice_count = int(count_row["n"] or 0) if count_row else 0
            if voice_count >= NORMAL_VOICE_LIMIT:
                raise HTTPException(
                    status_code=403,
                    detail=f"Normal plan allows up to {NORMAL_VOICE_LIMIT} saved voices. "
                           f"Upgrade to Premium for unlimited voices, or delete an existing voice to save a new one.",
                )
        finally:
            await conn.close()

    conn = await get_connection()
    try:
        row = await (
            await conn.execute(
                """
                SELECT voice_description, revised_instruction, sample_script, miner_hotkey, model_name, chute_slug,
                       audio_a_bucket, audio_a_key, audio_b_bucket, audio_b_key, expires_at
                FROM studio_voice_design_previews
                WHERE preview_token = ? AND user_id = ?
                """,
                (token, user_id),
            )
        ).fetchone()
    finally:
        await conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Preview not found or already saved")
    exp = datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00")) if row["expires_at"] else None
    if exp and exp <= datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="This preview has expired. Generate a new one.")

    if variant == "original":
        src_bucket, src_key = row["audio_a_bucket"], row["audio_a_key"]
    else:
        src_bucket, src_key = row["audio_b_bucket"], row["audio_b_key"]

    copied = copy_wav_in_bucket(user_id, src_bucket, src_key)
    if not copied:
        raise HTTPException(status_code=502, detail="Could not copy preview audio to saved storage")
    new_bucket, new_key, saved_expires = copied

    conn = await get_connection()
    try:
        cur = await conn.execute(
            """
            INSERT INTO studio_user_designed_voices
            (user_id, display_name, voice_description, revised_instruction, chosen_variant, ref_script,
             miner_hotkey, model_name, chute_slug, audio_s3_bucket, audio_s3_key, expires_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            """,
            (
                user_id,
                display_name,
                row["voice_description"],
                row["revised_instruction"],
                variant,
                row["sample_script"],
                row["miner_hotkey"],
                row["model_name"],
                row["chute_slug"],
                new_bucket,
                new_key,
                saved_expires.isoformat(),
            ),
        )
        voice_id = int(cur.lastrowid)
        await conn.execute(
            "DELETE FROM studio_voice_design_previews WHERE preview_token = ? AND user_id = ?",
            (token, user_id),
        )
        credit_row = await (await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))).fetchone()
        new_credits = int(credit_row["credits"]) if credit_row else 0
        await conn.commit()
    finally:
        await conn.close()

    delete_object(row["audio_a_bucket"], row["audio_a_key"])
    delete_object(row["audio_b_bucket"], row["audio_b_key"])

    is_premium = await _is_premium_user(user_id)
    audio_url = get_presigned_url(new_bucket, new_key, saved_expires, public=is_premium) or ""
    return StudioVoiceDesignSaveResponse(
        voice_id=voice_id,
        audio_url=audio_url,
        expires_at=saved_expires.isoformat(),
        credits=new_credits,
        ref_script=row["sample_script"],
    )


@router.get("/voice-design/voices", response_model=StudioDesignedVoicesResponse)
async def list_designed_voices(user_id: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        rows = await (
            await conn.execute(
                """
                SELECT id, display_name, voice_description, revised_instruction, chosen_variant, ref_script,
                       miner_hotkey, model_name, chute_slug, audio_s3_bucket, audio_s3_key, expires_at, created_at,
                       COALESCE(source, 'designed') AS source, source_language
                FROM studio_user_designed_voices
                WHERE user_id = ?
                ORDER BY datetime(created_at) DESC
                LIMIT 200
                """,
                (user_id,),
            )
        ).fetchall()
    finally:
        await conn.close()

    now = datetime.now(timezone.utc)
    is_premium = await _is_premium_user(user_id)
    voices: list[StudioDesignedVoiceItem] = []
    for r in rows:
        exp = datetime.fromisoformat(str(r["expires_at"]).replace("Z", "+00:00")) if r["expires_at"] else None
        expired = exp is not None and exp <= now if not is_premium else False
        url = None
        if not expired and r["audio_s3_bucket"] and r["audio_s3_key"]:
            url = get_presigned_url(r["audio_s3_bucket"], r["audio_s3_key"], exp, public=is_premium)
        voices.append(
            StudioDesignedVoiceItem(
                id=int(r["id"]),
                display_name=r["display_name"] or "",
                voice_description=r["voice_description"] or "",
                revised_instruction=r["revised_instruction"] or "",
                chosen_variant=r["chosen_variant"] or "",
                ref_script=r["ref_script"] or "",
                miner_hotkey=r["miner_hotkey"] or "",
                model_name=r["model_name"] or "",
                chute_slug=r["chute_slug"] or "",
                audio_url=url,
                expires_at=exp.isoformat() if exp else "",
                created_at=str(r["created_at"] or ""),
                expired=expired,
                source=(r["source"] if "source" in r.keys() else "designed") or "designed",
                source_language=(r["source_language"] if "source_language" in r.keys() else None),
            )
        )
    return StudioDesignedVoicesResponse(voices=voices)


@router.delete("/voice-design/voices/{voice_id}")
async def delete_designed_voice(voice_id: int, user_id: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        row = await (
            await conn.execute(
                """
                SELECT audio_s3_bucket, audio_s3_key FROM studio_user_designed_voices
                WHERE id = ? AND user_id = ?
                """,
                (voice_id, user_id),
            )
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Voice not found")
        await conn.execute(
            "DELETE FROM studio_user_designed_voices WHERE id = ? AND user_id = ?",
            (voice_id, user_id),
        )
        await conn.commit()
    finally:
        await conn.close()
    delete_object(row["audio_s3_bucket"], row["audio_s3_key"])
    return {"ok": True}


# ---------------------------------------------------------------------------
# Cloned voices — user uploads a real-voice reference clip once, we transcribe
# it once, and save both so the user can pick this voice anywhere (Studio,
# voice agents, designed-voice speak) without re-uploading. Reuses the
# ``studio_user_designed_voices`` table with ``source='cloned'`` so the
# existing dv:<id> voice routing keeps working out of the box.
# ---------------------------------------------------------------------------

# Saved cloned voices retain their reference audio for the long haul (5 years).
# Designed-voice rows ride the 7-day STUDIO_TTS_EXPIRY_DAYS retention because
# their R2 file is in the same "/voice-design/preview" subfolder that the
# preview cleanup job sweeps. Cloned voices land under "/voice-design/cloned"
# and never get swept — they're explicit user uploads, not cheap LLM
# previews, so deletion is user-initiated only.
_CLONED_VOICE_RETENTION_DAYS = 365 * 5


@router.post("/voice-design/cloned-voices", response_model=StudioClonedVoiceSaveResponse)
async def save_cloned_voice(
    display_name: str = Form(...),
    audio_file: UploadFile = File(...),
    language: str | None = Form(None),
    reference_text: str | None = Form(None, description="Optional manual transcript; skips STT when provided."),
    user_id: str = Depends(require_auth),
):
    """Upload a voice clip, transcribe it once, and save it as a reusable
    voice in the user's My Voices. After saving, the voice is addressable
    as ``dv:<voice_id>`` from anywhere voices are selected (agents, Studio
    clone target, designed-voice speak)."""
    name = (display_name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="display_name is required")
    if len(name) > 40:
        raise HTTPException(status_code=400, detail="display_name must be at most 40 characters")

    if not audio_file.filename:
        raise HTTPException(status_code=400, detail="audio_file is required")
    raw = await audio_file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty audio file")
    # Same size cap the regular /clone endpoint uses — keeps the contract
    # consistent and protects us from a user trying to save a 500MB clip.
    if len(raw) > CLONE_MAX_REF_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Audio exceeds max size ({CLONE_MAX_REF_AUDIO_BYTES} bytes)",
        )

    # Enforce the same Normal/Premium tier limit Voice Design uses, since
    # cloned voices share the same My Voices list. Counts BOTH designed
    # and cloned together to keep the limit meaningful.
    NORMAL_VOICE_LIMIT = int(os.environ.get("STUDIO_NORMAL_VOICE_LIMIT", "5"))
    is_premium = await _is_premium_user(user_id)
    if not is_premium:
        conn = await get_connection()
        try:
            count_row = await (await conn.execute(
                "SELECT COUNT(*) AS n FROM studio_user_designed_voices WHERE user_id = ?",
                (user_id,),
            )).fetchone()
            voice_count = int(count_row["n"] or 0) if count_row else 0
            if voice_count >= NORMAL_VOICE_LIMIT:
                raise HTTPException(
                    status_code=403,
                    detail=f"Normal plan allows up to {NORMAL_VOICE_LIMIT} saved voices. "
                           f"Upgrade to Premium for unlimited, or delete an existing voice.",
                )
        finally:
            await conn.close()

    # Transcribe once. If the user provided a manual transcript, trust it
    # (faster + lets users override a flaky STT result for niche accents).
    lang = (language or "").strip() or None
    user_ref = (reference_text or "").strip()
    detected_language: str | None = lang
    if user_ref:
        ref_text = user_ref
    else:
        stt_result, stt_err = await transcribe_audio(audio_bytes=raw, language=lang)
        if not stt_result:
            detail = "Could not transcribe the audio."
            if stt_err:
                detail += f" ({stt_err})"
            raise HTTPException(status_code=502, detail=detail)
        ref_text = str(stt_result.get("text") or "").strip()
        if not ref_text:
            raise HTTPException(
                status_code=400,
                detail="Transcription returned empty text — try a clearer clip or set the language.",
            )
        if isinstance(stt_result.get("language"), str):
            detected_language = stt_result.get("language")

    # Upload to permanent storage. ``upload_wav_to_hippius`` writes
    # under ``{user_id}/{subdir}/{uuid}.wav`` and returns the bucket+key.
    # The default ``STUDIO_TTS_EXPIRY_DAYS`` it stamps is too short for
    # a "save for forever" voice — we override below.
    bucket, key, _short_expiry = upload_wav_to_hippius(user_id, raw, subdir="voice-design/cloned")
    long_expires = datetime.now(timezone.utc) + timedelta(days=_CLONED_VOICE_RETENTION_DAYS)

    conn = await get_connection()
    try:
        cur = await conn.execute(
            """
            INSERT INTO studio_user_designed_voices
            (user_id, display_name, voice_description, revised_instruction, chosen_variant,
             ref_script, miner_hotkey, model_name, chute_slug,
             audio_s3_bucket, audio_s3_key, expires_at, source, source_language, created_at)
            VALUES (?, ?, '', '', '', ?, '', '', '', ?, ?, ?, 'cloned', ?, datetime('now'))
            """,
            (
                user_id,
                name,
                ref_text,
                bucket,
                key,
                long_expires.isoformat(),
                detected_language,
            ),
        )
        voice_id = int(cur.lastrowid)
        credit_row = await (await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))).fetchone()
        new_credits = int(credit_row["credits"]) if credit_row else 0
        await conn.commit()
    finally:
        await conn.close()

    audio_url = get_presigned_url(bucket, key, long_expires, public=is_premium) or ""
    return StudioClonedVoiceSaveResponse(
        voice_id=voice_id,
        display_name=name,
        ref_script=ref_text,
        source_language=detected_language,
        audio_url=audio_url,
        expires_at=long_expires.isoformat(),
        credits=new_credits,
    )


@router.post("/voice-design/speak", response_model=StudioCloneResponse)
async def designed_voice_speak(body: StudioDesignedVoiceSpeakRequest, user_id: str = Depends(require_auth)):
    """Clone target text using saved designed-voice reference (no STT on reference)."""
    if body.user_id != user_id:
        raise HTTPException(status_code=403, detail="user_id does not match authenticated user")
    if not voice_clone_chute_configured():
        raise HTTPException(
            status_code=503,
            detail="Voice cloning is not configured (set STUDIO_VOICE_CLONE_URL or STUDIO_VOICE_CLONE_CHUTE_SLUG).",
        )

    target = (body.target_text or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="target_text is required")

    conn = await get_connection()
    try:
        cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        row_c = await cursor.fetchone()
        if row_c is None:
            raise HTTPException(status_code=404, detail="User not found")
        credits = int(row_c["credits"])
        if credits < VOICE_DESIGN_SPEAK_CREDITS:
            raise HTTPException(
                status_code=402,
                detail=f"Insufficient credits. Need {VOICE_DESIGN_SPEAK_CREDITS} credits to generate with this voice. You have {credits}.",
            )
        row = await (
            await conn.execute(
                """
                SELECT display_name, ref_script, audio_s3_bucket, audio_s3_key, expires_at
                FROM studio_user_designed_voices
                WHERE id = ? AND user_id = ?
                """,
                (body.voice_id, user_id),
            )
        ).fetchone()
    finally:
        await conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Designed voice not found")
    exp = datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00")) if row["expires_at"] else None
    if exp and exp <= datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="Reference audio for this voice has expired.")

    ref_script = (row["ref_script"] or "").strip()
    if not ref_script:
        raise HTTPException(status_code=400, detail="Stored reference script is empty")

    raw_ref = download_object_bytes(row["audio_s3_bucket"], row["audio_s3_key"])
    if not raw_ref:
        raise HTTPException(status_code=502, detail="Could not load reference audio from storage")

    clone_endpoint_label = voice_clone_endpoint_label()
    clone_started = time.perf_counter()
    out_bytes, clone_err = await voice_clone_synthesize(
        reference_audio_bytes=raw_ref,
        reference_text=ref_script,
        target_text=target,
    )
    clone_latency_ms = int((time.perf_counter() - clone_started) * 1000)
    if not out_bytes:
        detail = "Voice clone request failed."
        if clone_err:
            detail += f" ({clone_err})"
        raise HTTPException(status_code=502, detail=detail)

    bucket, key, expires_out = upload_wav_to_hippius(user_id, out_bytes, subdir="voice-design/speak")

    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            INSERT INTO studio_clone_history
            (user_id, reference_text, target_text, source_mode, source_audio_filename, source_language,
             chute_slug, audio_s3_bucket, audio_s3_key, expires_at, credits_used,
             stt_latency_ms, clone_latency_ms, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'completed', datetime('now'))
            """,
            (
                user_id,
                ref_script,
                target,
                "designed_voice",
                row["display_name"] or "Designed voice",
                None,
                clone_endpoint_label,
                bucket,
                key,
                expires_out.isoformat(),
                VOICE_DESIGN_SPEAK_CREDITS,
                clone_latency_ms,
            ),
        )
        history_id = int(cursor.lastrowid)
        await conn.execute(
            "UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') WHERE id = ?",
            (VOICE_DESIGN_SPEAK_CREDITS, user_id),
        )
        credit_cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        new_row = await credit_cursor.fetchone()
        new_credits = int(new_row["credits"]) if new_row else credits - VOICE_DESIGN_SPEAK_CREDITS
        await record_credit_transaction(
            conn,
            user_id=user_id,
            transaction_type="voice_clone",
            amount=-VOICE_DESIGN_SPEAK_CREDITS,
            balance_after=new_credits,
            description=f"My voice (designed): {row['display_name']}",
            reference_type="studio_clone_history",
            reference_id=str(history_id),
            metadata={
                "clone_endpoint": clone_endpoint_label,
                "ref_source": "designed_voice",
                "voice_id": body.voice_id,
            },
        )
        await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())
        await conn.commit()
    finally:
        await conn.close()

    is_premium = await _is_premium_user(user_id)
    audio_url = get_presigned_url(bucket, key, expires_out, public=is_premium) or ""
    return StudioCloneResponse(
        id=history_id,
        audio_url=audio_url,
        expires_at=expires_out.isoformat() if expires_out else "",
        credits=new_credits,
        reference_text=ref_script,
        detected_language=None,
    )


@router.get("/history", response_model=StudioHistoryResponse)
async def get_history(
    user_id: str = Query(..., description="Must match the authenticated user"),
    auth_user_id: str = Depends(require_auth),
):
    """List Studio history for user (TTS + STT).

    SECURITY (2026-05-14): prior to this patch the endpoint had NO auth
    and trusted the ``user_id`` query param, so anyone could read any
    user's Studio history (TTS prompts, STT transcribed text, clone
    samples) just by guessing user ids. Now requires a valid Bearer
    JWT and rejects requests where ``user_id`` doesn't match the
    authenticated user."""
    if user_id != auth_user_id:
        raise HTTPException(status_code=403, detail="user_id does not match authenticated user")
    conn = await get_connection()
    try:
        tts_rows = await (await conn.execute("""
            SELECT id, miner_hotkey, model_name, prompt_text, style_instruction,
                   audio_s3_bucket, audio_s3_key, expires_at, created_at
            FROM studio_tts_history
            WHERE user_id = ?
            ORDER BY datetime(created_at) DESC
            LIMIT 100
        """, (user_id,))).fetchall()
        stt_rows = await (await conn.execute("""
            SELECT id, provider_name, source_audio_filename, source_language, duration_seconds,
                   transcribed_text, created_at
            FROM studio_stt_history
            WHERE user_id = ?
            ORDER BY datetime(created_at) DESC
            LIMIT 100
        """, (user_id,))).fetchall()
        clone_rows = await (await conn.execute("""
            SELECT id, reference_text, target_text, source_mode, source_audio_filename, source_language,
                   audio_s3_bucket, audio_s3_key, expires_at, created_at
            FROM studio_clone_history
            WHERE user_id = ?
            ORDER BY datetime(created_at) DESC
            LIMIT 100
        """, (user_id,))).fetchall()
        music_rows = await (await conn.execute("""
            SELECT id, task, prompt_text, lyrics, audio_duration, metadata_json,
                   audio_s3_bucket, audio_s3_key, expires_at, created_at
            FROM studio_music_history
            WHERE user_id = ?
            ORDER BY datetime(created_at) DESC
            LIMIT 100
        """, (user_id,))).fetchall()
    finally:
        await conn.close()

    is_premium = await _is_premium_user(user_id)
    now = datetime.now(timezone.utc)
    items: list[StudioHistoryItemResponse] = []
    for r in tts_rows:
        expires_at = datetime.fromisoformat(str(r["expires_at"]).replace("Z", "+00:00")) if r["expires_at"] else None
        expired = expires_at is not None and expires_at <= now if not is_premium else False
        audio_url = None
        if not expired and r["audio_s3_bucket"] and r["audio_s3_key"]:
            audio_url = get_presigned_url(r["audio_s3_bucket"], r["audio_s3_key"], expires_at, public=is_premium)

        items.append(
            StudioHistoryItemResponse(
                id=r["id"],
                entry_type="tts",
                miner_hotkey=r["miner_hotkey"],
                model_name=r["model_name"] or "",
                display_name=_model_display_name(r["model_name"]),
                prompt_text=r["prompt_text"] or "",
                style_instruction=r["style_instruction"] or "neutral voice",
                audio_url=audio_url,
                expires_at=expires_at.isoformat() if expires_at else "",
                created_at=str(r["created_at"] or ""),
                expired=expired,
            )
        )
    for r in stt_rows:
        items.append(
            StudioHistoryItemResponse(
                id=int(r["id"]),
                entry_type="stt",
                miner_hotkey="",
                model_name=r["provider_name"] or "STT",
                display_name=r["provider_name"] or "Speech-to-Text",
                prompt_text=None,
                style_instruction="",
                audio_url=None,
                expires_at="",
                created_at=str(r["created_at"] or ""),
                expired=False,
                transcribed_text=r["transcribed_text"] or "",
                source_audio_filename=r["source_audio_filename"] or "",
                source_language=r["source_language"] or None,
                duration_seconds=float(r["duration_seconds"]) if r["duration_seconds"] is not None else None,
            )
        )
    for r in clone_rows:
        expires_at = datetime.fromisoformat(str(r["expires_at"]).replace("Z", "+00:00")) if r["expires_at"] else None
        expired = expires_at is not None and expires_at <= now if not is_premium else False
        audio_url = None
        if not expired and r["audio_s3_bucket"] and r["audio_s3_key"]:
            audio_url = get_presigned_url(r["audio_s3_bucket"], r["audio_s3_key"], expires_at, public=is_premium)
        source_mode = (r["source_mode"] or "").strip().lower()
        if source_mode == "designed_voice":
            items.append(
                StudioHistoryItemResponse(
                    id=int(r["id"]),
                    entry_type="voice_design",
                    miner_hotkey="",
                    model_name="Voice Design",
                    display_name=r["source_audio_filename"] or "My voice",
                    prompt_text=r["target_text"] or "",
                    style_instruction="Designed voice · reference script",
                    audio_url=audio_url,
                    expires_at=expires_at.isoformat() if expires_at else "",
                    created_at=str(r["created_at"] or ""),
                    expired=expired,
                    transcribed_text=r["reference_text"] or "",
                    source_audio_filename=r["source_audio_filename"] or "",
                    source_language=r["source_language"] or None,
                    reference_text=r["reference_text"] or "",
                    target_text=r["target_text"] or "",
                    clone_source="designed_voice",
                )
            )
        else:
            items.append(
                StudioHistoryItemResponse(
                    id=int(r["id"]),
                    entry_type="clone",
                    miner_hotkey="",
                    model_name="Voice Clone",
                    display_name="Voice Clone",
                    prompt_text=r["target_text"] or "",
                    style_instruction="Voice cloning",
                    audio_url=audio_url,
                    expires_at=expires_at.isoformat() if expires_at else "",
                    created_at=str(r["created_at"] or ""),
                    expired=expired,
                    transcribed_text=r["reference_text"] or "",
                    source_audio_filename=r["source_audio_filename"] or "",
                    source_language=r["source_language"] or None,
                    reference_text=r["reference_text"] or "",
                    target_text=r["target_text"] or "",
                    clone_source=r["source_mode"] or "",
                )
            )
    for r in music_rows:
        expires_at = datetime.fromisoformat(str(r["expires_at"]).replace("Z", "+00:00")) if r["expires_at"] else None
        expired = expires_at is not None and expires_at <= now if not is_premium else False
        audio_url = None
        if not expired and r["audio_s3_bucket"] and r["audio_s3_key"]:
            audio_url = get_presigned_url(r["audio_s3_bucket"], r["audio_s3_key"], expires_at, public=is_premium)
        task_label = (r["task"] or "text2music").replace("2", " to ").replace("_", " ").title()
        items.append(
            StudioHistoryItemResponse(
                id=int(r["id"]),
                entry_type="music",
                miner_hotkey="",
                model_name="Music Generation",
                display_name=f"Music · {task_label}",
                prompt_text=r["prompt_text"] or "",
                style_instruction=r["task"] or "text2music",
                audio_url=audio_url,
                expires_at=expires_at.isoformat() if expires_at else "",
                created_at=str(r["created_at"] or ""),
                expired=expired,
                # New: surface the lyrics + the raw task + the mode-specific
                # metadata blob to the frontend, so the history card can show
                # everything that went into this generation and let the user
                # copy / rerun.
                lyrics=r["lyrics"] or "",
                music_task=r["task"] or "text2music",
                music_metadata_json=(r["metadata_json"] if "metadata_json" in r.keys() else None) or "{}",
            )
        )
    items.sort(key=lambda x: x.created_at, reverse=True)
    items = items[:100]
    return StudioHistoryResponse(items=items)


@router.post("/history/delete")
async def delete_history_items(
    body: dict,
    user_id: str = Depends(require_auth),
):
    """Bulk-delete user's own studio history rows.

    Body: {items: [{type: 'tts'|'stt'|'clone'|'voice_design'|'music', id: int}, ...]}
    Owner-scoped: only deletes rows whose user_id matches the authenticated user.
    """
    raw_items = body.get("items") if isinstance(body, dict) else None
    if not isinstance(raw_items, list) or not raw_items:
        raise HTTPException(status_code=400, detail="items is required")
    table_for = {
        "tts": "studio_tts_history",
        "stt": "studio_stt_history",
        "clone": "studio_clone_history",
        "voice_design": "studio_clone_history",  # voice_design rows live here too
        "music": "studio_music_history",
    }
    conn = await get_connection()
    deleted = 0
    try:
        for it in raw_items:
            if not isinstance(it, dict):
                continue
            t = str(it.get("type") or "").lower()
            tbl = table_for.get(t)
            try:
                hid = int(it.get("id"))
            except (TypeError, ValueError):
                continue
            if not tbl or hid <= 0:
                continue
            cur = await conn.execute(
                f"DELETE FROM {tbl} WHERE id = ? AND user_id = ?",
                (hid, user_id),
            )
            deleted += cur.rowcount or 0
        await conn.commit()
    finally:
        await conn.close()
    return {"deleted": deleted}


@router.get("/history/{history_id}/audio-url")
async def get_history_audio_url(
    history_id: int,
    user_id: str = Query(...),
    entry_type: str = Query("tts", description="tts, clone, or voice_design (latter two use clone history table)"),
    auth_user_id: str = Depends(require_auth),
):
    """Get a fresh presigned audio URL for a history entry (if not expired).

    SECURITY (2026-05-14): require auth and reject mismatched user_id —
    the WHERE filter on user_id alone is not enough since an attacker
    could brute force history_ids against guessed user_ids."""
    if user_id != auth_user_id:
        raise HTTPException(status_code=403, detail="user_id does not match authenticated user")
    kind = (entry_type or "tts").strip().lower()
    if kind in ("clone", "voice_design", "designed_voice"):
        table = "studio_clone_history"
    elif kind == "music":
        table = "studio_music_history"
    else:
        table = "studio_tts_history"
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            f"""
            SELECT audio_s3_bucket, audio_s3_key, expires_at
            FROM {table}
            WHERE id = ? AND user_id = ?
            """,
            (history_id, user_id),
        )).fetchone()
    finally:
        await conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    is_premium = await _is_premium_user(user_id)
    expires_at = datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00")) if row["expires_at"] else None
    if not is_premium and expires_at and expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="Audio has expired (7-day retention).")
    url = get_presigned_url(row["audio_s3_bucket"], row["audio_s3_key"], expires_at, public=is_premium)
    if not url:
        raise HTTPException(status_code=410, detail="Audio expired.")
    return {"audio_url": url}


# ---------------------------------------------------------------------------
# Music Generation (ACE-Step proxy)
# ---------------------------------------------------------------------------


# System prompt for the AI lyric writer. Compact and prescriptive — small
# models follow concrete examples better than abstract instructions.
_LYRIC_SYSTEM_PROMPT = """You write song lyrics in the ACE-Step structure-tag format.

Output format (HARD RULES — the music engine will reject anything else):

- Use ONLY these structure tags, each on its own line, with a blank line
  between sections:
    [intro]  [verse]  [chorus]  [bridge]  [pre-chorus]  [hook]
    [solo]   [break]  [outro]   [end]     [inst]
- Tags are lowercase, in square brackets, on their own line.
- NEVER invent tags. NO [verse 1], NO [guitar], NO [piano], NO [Verse],
  NO numbered tags. Anything other than the tags above will be sung out
  loud and break the song.
- Plain text only inside sections. NO markdown, NO asterisks, NO
  parentheticals like "(repeat)", NO stage directions, NO emoji.
- 4 lines per [verse] / [chorus] is a good default. Bridges can be
  shorter. Choruses repeat — write each chorus identically unless the
  user asks for variation.
- Match the genre / mood / vocal style hints from the prompt the user
  passes in (e.g. if they say "rock, gritty, male vocals" the lyrics
  should feel that way — punchy, direct, urban grit; not soft).

Canonical structure: [verse] → [chorus] → [verse] → [bridge] → [chorus] → [outro]

Output ONLY the lyrics — no preamble like "Here are your lyrics:", no
explanations, no markdown fences."""


def _strip_lyric_artifacts(s: str) -> str:
    """Belt-and-suspenders cleanup. The system prompt forbids these,
    but small models slip — strip stray markdown fences, leading
    "Here is..." preambles, and ``**`` markers if they leak through."""
    s = s.strip()
    # Drop leading "Here is..." / "Sure!" / "Here are the lyrics..." lines
    lines = s.splitlines()
    while lines and not lines[0].lstrip().startswith("[") and len(lines) > 5:
        # If first non-empty line isn't a structure tag and we have plenty
        # of lines below, drop it as preamble
        head = lines[0].strip()
        if head and not head.startswith("[") and (
            head.lower().startswith(("here", "sure", "okay", "let me", "let's"))
            or head.endswith(":")
        ):
            lines = lines[1:]
            continue
        break
    s = "\n".join(lines).strip()
    # Strip code-fence wrapping if any
    if s.startswith("```"):
        s = s.split("\n", 1)[1] if "\n" in s else s[3:]
        if s.endswith("```"):
            s = s[: -3]
    s = s.strip()
    # Remove **bold** markers if present
    s = re.sub(r"\*\*([^*\n]+)\*\*", r"\1", s)
    return s


@router.post("/music/generate-lyrics", response_model=StudioMusicLyricsResponse)
async def music_generate_lyrics(
    body: StudioMusicLyricsRequest,
    user_id: str = Depends(require_auth),
):
    """Generate structured song lyrics from a topic + style prompt.
    Uses the same LLM router as agents (Chutes by default; local if set).
    Free — no credits charged. Output is plain lyric text with proper
    [verse]/[chorus]/[bridge] tags, ready to drop into the music
    generation form."""
    from llm_client import (  # local import to avoid cycles
        chat_complete_with_fallback,
        llm_configured,
    )
    _ = user_id  # auth-only; no per-user state

    topic = (body.topic or "").strip()
    if not topic:
        raise HTTPException(status_code=400, detail="topic is required")
    if len(topic) > 500:
        topic = topic[:500]

    if not llm_configured():
        raise HTTPException(status_code=503, detail="lyric LLM is not configured")

    style = (body.prompt or "").strip()
    sections = max(3, min(8, body.section_count or 5))

    user_msg = (
        f"Write song lyrics about: {topic}\n\n"
        + (f"Style hints (from the music prompt): {style}\n\n" if style else "")
        + f"Aim for around {sections} sections total. "
        "Use the canonical structure: verse, chorus, verse, bridge, chorus, outro. "
        "Make the chorus catchy and repeat it identically. Output only the lyrics."
    )

    # Try every Chutes model in the configured fallback list. Some
    # reasoning models (e.g. R1 variants) occasionally return empty
    # ``content`` for creative-writing prompts because their reasoning
    # eats the budget; falling through to the next model in the list
    # almost always works. Cleanup runs against each candidate so we
    # never return raw "Here is your song:" preambles.
    try:
        raw = await chat_complete_with_fallback(
            [
                {"role": "system", "content": _LYRIC_SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.85,   # let it be a little playful
            max_tokens=1500,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"lyric generation failed: {exc}") from exc

    cleaned = _strip_lyric_artifacts(raw or "")
    if not cleaned:
        raise HTTPException(status_code=502, detail="lyric generation returned empty")
    return StudioMusicLyricsResponse(lyrics=cleaned)


@router.post("/music/text2music", response_model=StudioMusicGenerateResponse)
async def music_generate_text2music(body: StudioMusicText2MusicRequest, user_id: str = Depends(require_auth)):
    """Generate music from text prompt + lyrics via ACE-Step API."""
    if body.user_id != user_id:
        raise HTTPException(status_code=403, detail="user_id does not match authenticated user")
    if not music_gen_configured():
        raise HTTPException(status_code=503, detail="Music generation is not configured (MUSIC_GEN_API_URL).")

    prompt = (body.prompt or "").strip()
    if not prompt:
        raise HTTPException(status_code=400, detail="prompt is required")
    # Tiered duration cap by quality. ``-1`` is a sentinel for "random"
    # supported by the underlying engine; the engine clamps internally
    # so we let it through.
    if body.audio_duration != -1:
        cap = _max_music_duration_for_steps(int(body.infer_step or 60))
        if body.audio_duration > cap:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"audio_duration must be ≤ {int(cap)} seconds at this quality "
                    f"(infer_step={body.infer_step}). Pick a faster quality or a shorter song."
                ),
            )

    conn = await get_connection()
    try:
        cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        credits = int(row["credits"])
        if credits < MUSIC_CREDITS_COST:
            raise HTTPException(
                status_code=402,
                detail=f"Insufficient credits. Need {MUSIC_CREDITS_COST} for music generation. You have {credits}.",
            )
    finally:
        await conn.close()

    started = time.perf_counter()
    async with MUSIC_POOL.acquire() as pod_url:
        wav_bytes, audio_path, err_msg = await music_text2music(
            base_url=pod_url,
            prompt=prompt,
            lyrics=body.lyrics,
            audio_duration=body.audio_duration,
            format=body.format,
            infer_step=body.infer_step,
            guidance_scale=body.guidance_scale,
            scheduler_type=body.scheduler_type,
            cfg_type=body.cfg_type,
            omega_scale=body.omega_scale,
            manual_seeds=body.manual_seeds,
            guidance_interval=body.guidance_interval,
            guidance_interval_decay=body.guidance_interval_decay,
            min_guidance_scale=body.min_guidance_scale,
            use_erg_tag=body.use_erg_tag,
            use_erg_lyric=body.use_erg_lyric,
            use_erg_diffusion=body.use_erg_diffusion,
            oss_steps=body.oss_steps,
            guidance_scale_text=body.guidance_scale_text,
            guidance_scale_lyric=body.guidance_scale_lyric,
            lora_name_or_path=body.lora_name_or_path,
        )
        if not wav_bytes and err_msg and ("returned 5" in err_msg or "timed out" in err_msg or "connect" in err_msg.lower()):
            MUSIC_POOL.quarantine(pod_url)
    latency_ms = int((time.perf_counter() - started) * 1000)

    if not wav_bytes:
        detail = "Music generation failed."
        if err_msg:
            detail += f" ({err_msg})"
        raise HTTPException(status_code=502, detail=detail)

    bucket, key, expires_at = upload_wav_to_hippius(user_id, wav_bytes, subdir="music")

    import json as _json

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
                user_id,
                "text2music",
                prompt,
                body.lyrics,
                body.audio_duration,
                body.format,
                bucket,
                key,
                expires_at.isoformat(),
                MUSIC_CREDITS_COST,
                latency_ms,
                _json.dumps({"guidance_scale": body.guidance_scale, "scheduler_type": body.scheduler_type}),
            ),
        )
        history_id = int(cursor.lastrowid)
        await conn.execute(
            "UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') WHERE id = ?",
            (MUSIC_CREDITS_COST, user_id),
        )
        credit_cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        new_row = await credit_cursor.fetchone()
        new_credits = int(new_row["credits"]) if new_row else credits - MUSIC_CREDITS_COST
        await record_credit_transaction(
            conn,
            user_id=user_id,
            transaction_type="music_generation",
            amount=-MUSIC_CREDITS_COST,
            balance_after=new_credits,
            description=f"Music generation (text2music)",
            reference_type="studio_music_history",
            reference_id=str(history_id),
            metadata={"task": "text2music", "prompt_length": len(prompt)},
        )
        await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())
        await conn.commit()
    finally:
        await conn.close()

    is_premium = await _is_premium_user(user_id)
    audio_url = get_presigned_url(bucket, key, expires_at, public=is_premium) or ""
    return StudioMusicGenerateResponse(
        id=history_id,
        audio_url=audio_url,
        expires_at=expires_at.isoformat() if expires_at else "",
        credits=new_credits,
        task="text2music",
    )


@router.post("/music/audio2audio", response_model=StudioMusicGenerateResponse)
async def music_generate_audio2audio(
    user_id_form: str = Form(..., alias="user_id"),
    prompt: str = Form(...),
    lyrics: str = Form(""),
    audio_duration: float = Form(60.0),
    ref_audio_strength: float = Form(0.5),
    format: str = Form("wav"),
    infer_step: int = Form(60),
    guidance_scale: float = Form(15.0),
    ref_audio: UploadFile = File(...),
    user_id: str = Depends(require_auth),
):
    """Audio-to-Audio style transfer via ACE-Step."""
    if user_id_form != user_id:
        raise HTTPException(status_code=403, detail="user_id does not match authenticated user")
    if not music_gen_configured():
        raise HTTPException(status_code=503, detail="Music generation is not configured.")
    if audio_duration != -1:
        cap = _max_music_duration_for_steps(int(infer_step or 60))
        if audio_duration > cap:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"audio_duration must be ≤ {int(cap)} seconds at this quality "
                    f"(infer_step={infer_step}). Pick a faster quality or a shorter song."
                ),
            )

    raw = await ref_audio.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty audio file")
    if len(raw) > MUSIC_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Audio file too large")

    conn = await get_connection()
    try:
        cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        credits = int(row["credits"])
        if credits < MUSIC_CREDITS_COST:
            raise HTTPException(status_code=402, detail=f"Need {MUSIC_CREDITS_COST} credits. Have {credits}.")
    finally:
        await conn.close()

    started = time.perf_counter()
    async with MUSIC_POOL.acquire() as pod_url:
        wav_bytes, audio_path, err_msg = await music_audio2audio(
            base_url=pod_url,
            ref_audio_bytes=raw,
            ref_audio_filename=ref_audio.filename or "reference.wav",
            prompt=prompt,
            lyrics=lyrics,
            audio_duration=audio_duration,
            ref_audio_strength=ref_audio_strength,
            format=format,
            infer_step=infer_step,
            guidance_scale=guidance_scale,
        )
        if not wav_bytes and err_msg and ("returned 5" in err_msg or "timed out" in err_msg or "connect" in err_msg.lower()):
            MUSIC_POOL.quarantine(pod_url)
    latency_ms = int((time.perf_counter() - started) * 1000)

    if not wav_bytes:
        raise HTTPException(status_code=502, detail=f"Audio2Audio failed: {err_msg or 'unknown'}")

    bucket, key, expires_at = upload_wav_to_hippius(user_id, wav_bytes, subdir="music")

    import json as _json

    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            INSERT INTO studio_music_history
            (user_id, task, prompt_text, lyrics, audio_duration, audio_format,
             audio_s3_bucket, audio_s3_key, expires_at, credits_used, latency_ms, status, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, datetime('now'))
            """,
            (user_id, "audio2audio", prompt, lyrics, audio_duration, format,
             bucket, key, expires_at.isoformat(), MUSIC_CREDITS_COST, latency_ms,
             _json.dumps({"ref_audio_strength": ref_audio_strength})),
        )
        history_id = int(cursor.lastrowid)
        await conn.execute(
            "UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') WHERE id = ?",
            (MUSIC_CREDITS_COST, user_id),
        )
        credit_cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        new_row = await credit_cursor.fetchone()
        new_credits = int(new_row["credits"]) if new_row else credits - MUSIC_CREDITS_COST
        await record_credit_transaction(
            conn, user_id=user_id, transaction_type="music_generation",
            amount=-MUSIC_CREDITS_COST, balance_after=new_credits,
            description="Music generation (audio2audio)",
            reference_type="studio_music_history", reference_id=str(history_id),
            metadata={"task": "audio2audio"},
        )
        await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())
        await conn.commit()
    finally:
        await conn.close()

    is_premium = await _is_premium_user(user_id)
    audio_url = get_presigned_url(bucket, key, expires_at, public=is_premium) or ""
    return StudioMusicGenerateResponse(
        id=history_id, audio_url=audio_url,
        expires_at=expires_at.isoformat() if expires_at else "",
        credits=new_credits, task="audio2audio",
    )


@router.post("/music/retake", response_model=StudioMusicGenerateResponse)
async def music_generate_retake(
    user_id_form: str = Form(..., alias="user_id"),
    prompt: str = Form(...),
    lyrics: str = Form(""),
    retake_variance: float = Form(0.2),
    retake_seeds: str = Form(""),
    format: str = Form("wav"),
    infer_step: int = Form(60),
    guidance_scale: float = Form(15.0),
    src_audio: UploadFile = File(...),
    user_id: str = Depends(require_auth),
):
    """Generate variation of existing audio via ACE-Step retake."""
    if user_id_form != user_id:
        raise HTTPException(status_code=403, detail="user_id mismatch")
    if not music_gen_configured():
        raise HTTPException(status_code=503, detail="Music generation is not configured.")

    raw = await src_audio.read()
    if not raw or len(raw) > MUSIC_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="Invalid audio file")

    conn = await get_connection()
    try:
        cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        credits = int(row["credits"])
        if credits < MUSIC_CREDITS_COST:
            raise HTTPException(status_code=402, detail=f"Need {MUSIC_CREDITS_COST} credits. Have {credits}.")
    finally:
        await conn.close()

    started = time.perf_counter()
    async with MUSIC_POOL.acquire() as pod_url:
        wav_bytes, _, err_msg = await music_retake(
            base_url=pod_url,
            src_audio_bytes=raw, src_audio_filename=src_audio.filename or "source.wav",
            prompt=prompt, lyrics=lyrics, retake_variance=retake_variance,
            retake_seeds=retake_seeds, format=format, infer_step=infer_step, guidance_scale=guidance_scale,
        )
        if not wav_bytes and err_msg and ("returned 5" in err_msg or "timed out" in err_msg or "connect" in err_msg.lower()):
            MUSIC_POOL.quarantine(pod_url)
    latency_ms = int((time.perf_counter() - started) * 1000)

    if not wav_bytes:
        raise HTTPException(status_code=502, detail=f"Retake failed: {err_msg or 'unknown'}")

    bucket, key, expires_at = upload_wav_to_hippius(user_id, wav_bytes, subdir="music")

    import json as _json
    conn = await get_connection()
    try:
        # Persist mode-specific params so the History page can show
        # the user EXACTLY how this track was generated and let them
        # rerun / tweak / copy. Without this the user only sees the
        # prompt + lyrics and forgets that variance=0.7 was the magic.
        meta = {
            "retake_variance": retake_variance,
            "retake_seeds": retake_seeds,
            "infer_step": infer_step,
            "guidance_scale": guidance_scale,
        }
        cursor = await conn.execute(
            """INSERT INTO studio_music_history
            (user_id, task, prompt_text, lyrics, audio_duration, audio_format,
             audio_s3_bucket, audio_s3_key, expires_at, credits_used, latency_ms, status, metadata_json, created_at)
            VALUES (?, 'retake', ?, ?, 0, ?, ?, ?, ?, ?, ?, 'completed', ?, datetime('now'))""",
            (user_id, prompt, lyrics, format, bucket, key, expires_at.isoformat(), MUSIC_CREDITS_COST, latency_ms, _json.dumps(meta)),
        )
        history_id = int(cursor.lastrowid)
        await conn.execute("UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') WHERE id = ?",
                           (MUSIC_CREDITS_COST, user_id))
        credit_cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        new_row = await credit_cursor.fetchone()
        new_credits = int(new_row["credits"]) if new_row else credits - MUSIC_CREDITS_COST
        await record_credit_transaction(conn, user_id=user_id, transaction_type="music_generation",
                                        amount=-MUSIC_CREDITS_COST, balance_after=new_credits,
                                        description="Music generation (retake)",
                                        reference_type="studio_music_history", reference_id=str(history_id),
                                        metadata={"task": "retake"})
        await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())
        await conn.commit()
    finally:
        await conn.close()

    is_premium = await _is_premium_user(user_id)
    audio_url = get_presigned_url(bucket, key, expires_at, public=is_premium) or ""
    return StudioMusicGenerateResponse(
        id=history_id, audio_url=audio_url, expires_at=expires_at.isoformat() if expires_at else "",
        credits=new_credits, task="retake",
    )


@router.post("/music/repaint", response_model=StudioMusicGenerateResponse)
async def music_generate_repaint(
    user_id_form: str = Form(..., alias="user_id"),
    prompt: str = Form(...),
    lyrics: str = Form(""),
    repaint_start: float = Form(0.0),
    repaint_end: float = Form(30.0),
    retake_variance: float = Form(0.2),
    format: str = Form("wav"),
    infer_step: int = Form(60),
    guidance_scale: float = Form(15.0),
    src_audio: UploadFile = File(...),
    user_id: str = Depends(require_auth),
):
    """Regenerate a region of audio via ACE-Step repaint."""
    if user_id_form != user_id:
        raise HTTPException(status_code=403, detail="user_id mismatch")
    if not music_gen_configured():
        raise HTTPException(status_code=503, detail="Music generation is not configured.")

    raw = await src_audio.read()
    if not raw or len(raw) > MUSIC_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="Invalid audio file")

    conn = await get_connection()
    try:
        cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        credits = int(row["credits"])
        if credits < MUSIC_CREDITS_COST:
            raise HTTPException(status_code=402, detail=f"Need {MUSIC_CREDITS_COST} credits. Have {credits}.")
    finally:
        await conn.close()

    started = time.perf_counter()
    async with MUSIC_POOL.acquire() as pod_url:
        wav_bytes, _, err_msg = await music_repaint(
            base_url=pod_url,
            src_audio_bytes=raw, src_audio_filename=src_audio.filename or "source.wav",
            prompt=prompt, lyrics=lyrics, repaint_start=repaint_start, repaint_end=repaint_end,
            retake_variance=retake_variance, format=format, infer_step=infer_step, guidance_scale=guidance_scale,
        )
        if not wav_bytes and err_msg and ("returned 5" in err_msg or "timed out" in err_msg or "connect" in err_msg.lower()):
            MUSIC_POOL.quarantine(pod_url)
    latency_ms = int((time.perf_counter() - started) * 1000)

    if not wav_bytes:
        raise HTTPException(status_code=502, detail=f"Repaint failed: {err_msg or 'unknown'}")

    bucket, key, expires_at = upload_wav_to_hippius(user_id, wav_bytes, subdir="music")

    import json as _json
    conn = await get_connection()
    try:
        meta = {
            "repaint_start": repaint_start,
            "repaint_end": repaint_end,
            "retake_variance": retake_variance,
            "infer_step": infer_step,
            "guidance_scale": guidance_scale,
        }
        cursor = await conn.execute(
            """INSERT INTO studio_music_history
            (user_id, task, prompt_text, lyrics, audio_duration, audio_format,
             audio_s3_bucket, audio_s3_key, expires_at, credits_used, latency_ms, status, metadata_json, created_at)
            VALUES (?, 'repaint', ?, ?, 0, ?, ?, ?, ?, ?, ?, 'completed', ?, datetime('now'))""",
            (user_id, prompt, lyrics, format, bucket, key, expires_at.isoformat(), MUSIC_CREDITS_COST, latency_ms, _json.dumps(meta)),
        )
        history_id = int(cursor.lastrowid)
        await conn.execute("UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') WHERE id = ?",
                           (MUSIC_CREDITS_COST, user_id))
        credit_cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        new_row = await credit_cursor.fetchone()
        new_credits = int(new_row["credits"]) if new_row else credits - MUSIC_CREDITS_COST
        await record_credit_transaction(conn, user_id=user_id, transaction_type="music_generation",
                                        amount=-MUSIC_CREDITS_COST, balance_after=new_credits,
                                        description="Music generation (repaint)",
                                        reference_type="studio_music_history", reference_id=str(history_id),
                                        metadata={"task": "repaint"})
        await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())
        await conn.commit()
    finally:
        await conn.close()

    is_premium = await _is_premium_user(user_id)
    audio_url = get_presigned_url(bucket, key, expires_at, public=is_premium) or ""
    return StudioMusicGenerateResponse(
        id=history_id, audio_url=audio_url, expires_at=expires_at.isoformat() if expires_at else "",
        credits=new_credits, task="repaint",
    )


@router.post("/music/edit", response_model=StudioMusicGenerateResponse)
async def music_generate_edit(
    user_id_form: str = Form(..., alias="user_id"),
    prompt: str = Form(...),
    lyrics: str = Form(""),
    edit_target_prompt: str = Form(...),
    edit_target_lyrics: str = Form(""),
    edit_n_min: float = Form(0.6),
    edit_n_max: float = Form(1.0),
    retake_seeds: str = Form(""),
    format: str = Form("wav"),
    infer_step: int = Form(60),
    guidance_scale: float = Form(15.0),
    src_audio: UploadFile = File(...),
    user_id: str = Depends(require_auth),
):
    """Edit lyrics/tags of existing audio via ACE-Step."""
    if user_id_form != user_id:
        raise HTTPException(status_code=403, detail="user_id mismatch")
    if not music_gen_configured():
        raise HTTPException(status_code=503, detail="Music generation is not configured.")

    raw = await src_audio.read()
    if not raw or len(raw) > MUSIC_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="Invalid audio file")

    conn = await get_connection()
    try:
        cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        credits = int(row["credits"])
        if credits < MUSIC_CREDITS_COST:
            raise HTTPException(status_code=402, detail=f"Need {MUSIC_CREDITS_COST} credits. Have {credits}.")
    finally:
        await conn.close()

    started = time.perf_counter()
    async with MUSIC_POOL.acquire() as pod_url:
        wav_bytes, _, err_msg = await music_edit(
            base_url=pod_url,
            src_audio_bytes=raw, src_audio_filename=src_audio.filename or "source.wav",
            prompt=prompt, lyrics=lyrics, edit_target_prompt=edit_target_prompt,
            edit_target_lyrics=edit_target_lyrics, edit_n_min=edit_n_min, edit_n_max=edit_n_max,
            retake_seeds=retake_seeds, format=format, infer_step=infer_step, guidance_scale=guidance_scale,
        )
        if not wav_bytes and err_msg and ("returned 5" in err_msg or "timed out" in err_msg or "connect" in err_msg.lower()):
            MUSIC_POOL.quarantine(pod_url)
    latency_ms = int((time.perf_counter() - started) * 1000)

    if not wav_bytes:
        raise HTTPException(status_code=502, detail=f"Edit failed: {err_msg or 'unknown'}")

    bucket, key, expires_at = upload_wav_to_hippius(user_id, wav_bytes, subdir="music")

    import json as _json
    conn = await get_connection()
    try:
        meta = {
            "edit_target_prompt": edit_target_prompt,
            "edit_target_lyrics": edit_target_lyrics,
            "edit_n_min": edit_n_min,
            "edit_n_max": edit_n_max,
            "retake_seeds": retake_seeds,
            "infer_step": infer_step,
            "guidance_scale": guidance_scale,
        }
        cursor = await conn.execute(
            """INSERT INTO studio_music_history
            (user_id, task, prompt_text, lyrics, audio_duration, audio_format,
             audio_s3_bucket, audio_s3_key, expires_at, credits_used, latency_ms, status, metadata_json, created_at)
            VALUES (?, 'edit', ?, ?, 0, ?, ?, ?, ?, ?, ?, 'completed', ?, datetime('now'))""",
            (user_id, prompt, lyrics, format, bucket, key, expires_at.isoformat(), MUSIC_CREDITS_COST, latency_ms, _json.dumps(meta)),
        )
        history_id = int(cursor.lastrowid)
        await conn.execute("UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') WHERE id = ?",
                           (MUSIC_CREDITS_COST, user_id))
        credit_cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        new_row = await credit_cursor.fetchone()
        new_credits = int(new_row["credits"]) if new_row else credits - MUSIC_CREDITS_COST
        await record_credit_transaction(conn, user_id=user_id, transaction_type="music_generation",
                                        amount=-MUSIC_CREDITS_COST, balance_after=new_credits,
                                        description="Music generation (edit)",
                                        reference_type="studio_music_history", reference_id=str(history_id),
                                        metadata={"task": "edit"})
        await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())
        await conn.commit()
    finally:
        await conn.close()

    is_premium = await _is_premium_user(user_id)
    audio_url = get_presigned_url(bucket, key, expires_at, public=is_premium) or ""
    return StudioMusicGenerateResponse(
        id=history_id, audio_url=audio_url, expires_at=expires_at.isoformat() if expires_at else "",
        credits=new_credits, task="edit",
    )


@router.post("/music/extend", response_model=StudioMusicGenerateResponse)
async def music_generate_extend(
    user_id_form: str = Form(..., alias="user_id"),
    prompt: str = Form(...),
    lyrics: str = Form(""),
    left_extend_length: float = Form(0.0),
    right_extend_length: float = Form(30.0),
    extend_seeds: str = Form(""),
    format: str = Form("wav"),
    infer_step: int = Form(60),
    guidance_scale: float = Form(15.0),
    src_audio: UploadFile = File(...),
    user_id: str = Depends(require_auth),
):
    """Extend/lengthen audio via ACE-Step."""
    if user_id_form != user_id:
        raise HTTPException(status_code=403, detail="user_id mismatch")
    if not music_gen_configured():
        raise HTTPException(status_code=503, detail="Music generation is not configured.")

    raw = await src_audio.read()
    if not raw or len(raw) > MUSIC_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=400, detail="Invalid audio file")

    conn = await get_connection()
    try:
        cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        credits = int(row["credits"])
        if credits < MUSIC_CREDITS_COST:
            raise HTTPException(status_code=402, detail=f"Need {MUSIC_CREDITS_COST} credits. Have {credits}.")
    finally:
        await conn.close()

    started = time.perf_counter()
    async with MUSIC_POOL.acquire() as pod_url:
        wav_bytes, _, err_msg = await music_extend(
            base_url=pod_url,
            src_audio_bytes=raw, src_audio_filename=src_audio.filename or "source.wav",
            prompt=prompt, lyrics=lyrics, left_extend_length=left_extend_length,
            right_extend_length=right_extend_length, extend_seeds=extend_seeds,
            format=format, infer_step=infer_step, guidance_scale=guidance_scale,
        )
        if not wav_bytes and err_msg and ("returned 5" in err_msg or "timed out" in err_msg or "connect" in err_msg.lower()):
            MUSIC_POOL.quarantine(pod_url)
    latency_ms = int((time.perf_counter() - started) * 1000)

    if not wav_bytes:
        raise HTTPException(status_code=502, detail=f"Extend failed: {err_msg or 'unknown'}")

    bucket, key, expires_at = upload_wav_to_hippius(user_id, wav_bytes, subdir="music")

    import json as _json
    conn = await get_connection()
    try:
        meta = {
            "left_extend_length": left_extend_length,
            "right_extend_length": right_extend_length,
            "extend_seeds": extend_seeds,
            "infer_step": infer_step,
            "guidance_scale": guidance_scale,
        }
        cursor = await conn.execute(
            """INSERT INTO studio_music_history
            (user_id, task, prompt_text, lyrics, audio_duration, audio_format,
             audio_s3_bucket, audio_s3_key, expires_at, credits_used, latency_ms, status, metadata_json, created_at)
            VALUES (?, 'extend', ?, ?, 0, ?, ?, ?, ?, ?, ?, 'completed', ?, datetime('now'))""",
            (user_id, prompt, lyrics, format, bucket, key, expires_at.isoformat(), MUSIC_CREDITS_COST, latency_ms, _json.dumps(meta)),
        )
        history_id = int(cursor.lastrowid)
        await conn.execute("UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') WHERE id = ?",
                           (MUSIC_CREDITS_COST, user_id))
        credit_cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        new_row = await credit_cursor.fetchone()
        new_credits = int(new_row["credits"]) if new_row else credits - MUSIC_CREDITS_COST
        await record_credit_transaction(conn, user_id=user_id, transaction_type="music_generation",
                                        amount=-MUSIC_CREDITS_COST, balance_after=new_credits,
                                        description="Music generation (extend)",
                                        reference_type="studio_music_history", reference_id=str(history_id),
                                        metadata={"task": "extend"})
        await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())
        await conn.commit()
    finally:
        await conn.close()

    is_premium = await _is_premium_user(user_id)
    audio_url = get_presigned_url(bucket, key, expires_at, public=is_premium) or ""
    return StudioMusicGenerateResponse(
        id=history_id, audio_url=audio_url, expires_at=expires_at.isoformat() if expires_at else "",
        credits=new_credits, task="extend",
    )


@router.get("/music/history", response_model=StudioMusicHistoryResponse)
async def get_music_history(
    user_id: str = Query(...),
    auth_user_id: str = Depends(require_auth),
):
    """List music generation history for a user.

    SECURITY (2026-05-14): require auth + user_id match. See note on
    ``get_history`` above — the same IDOR existed here."""
    if user_id != auth_user_id:
        raise HTTPException(status_code=403, detail="user_id does not match authenticated user")
    conn = await get_connection()
    try:
        rows = await (await conn.execute("""
            SELECT id, task, prompt_text, lyrics, audio_duration, audio_format,
                   audio_s3_bucket, audio_s3_key, expires_at, metadata_json, created_at
            FROM studio_music_history
            WHERE user_id = ?
            ORDER BY datetime(created_at) DESC
            LIMIT 100
        """, (user_id,))).fetchall()
    finally:
        await conn.close()

    is_premium = await _is_premium_user(user_id)
    now = datetime.now(timezone.utc)
    items: list[StudioMusicHistoryItemResponse] = []
    for r in rows:
        expires_at = datetime.fromisoformat(str(r["expires_at"]).replace("Z", "+00:00")) if r["expires_at"] else None
        expired = expires_at is not None and expires_at <= now if not is_premium else False
        audio_url = None
        if not expired and r["audio_s3_bucket"] and r["audio_s3_key"]:
            audio_url = get_presigned_url(r["audio_s3_bucket"], r["audio_s3_key"], expires_at, public=is_premium)
        items.append(StudioMusicHistoryItemResponse(
            id=int(r["id"]),
            entry_type="music",
            task=r["task"] or "text2music",
            prompt_text=r["prompt_text"] or "",
            lyrics=r["lyrics"] or "",
            audio_duration=float(r["audio_duration"]) if r["audio_duration"] else 0,
            audio_url=audio_url,
            expires_at=expires_at.isoformat() if expires_at else "",
            created_at=str(r["created_at"] or ""),
            expired=expired,
            metadata_json=r["metadata_json"] or "{}",
        ))
    return StudioMusicHistoryResponse(items=items)


@router.get("/music/history/{history_id}/audio-url")
async def get_music_history_audio_url(
    history_id: int,
    user_id: str = Query(...),
    auth_user_id: str = Depends(require_auth),
):
    """Get a fresh presigned audio URL for a music history entry.

    SECURITY (2026-05-14): require auth + user_id match. Same IDOR as
    the TTS/STT history endpoint above."""
    if user_id != auth_user_id:
        raise HTTPException(status_code=403, detail="user_id does not match authenticated user")
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT audio_s3_bucket, audio_s3_key, expires_at FROM studio_music_history WHERE id = ? AND user_id = ?",
            (history_id, user_id),
        )).fetchone()
    finally:
        await conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    is_premium = await _is_premium_user(user_id)
    expires_at = datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00")) if row["expires_at"] else None
    if not is_premium and expires_at and expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="Audio has expired.")
    url = get_presigned_url(row["audio_s3_bucket"], row["audio_s3_key"], expires_at, public=is_premium)
    if not url:
        raise HTTPException(status_code=410, detail="Audio expired.")
    return {"audio_url": url}
