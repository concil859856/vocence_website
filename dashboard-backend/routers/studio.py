"""Studio TTS API: configured models (env), generate, history."""

import logging
import os
import re
import secrets
import time
from datetime import datetime, timezone

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
    StudioCloneResponse,
    StudioDesignedVoiceItem,
    StudioDesignedVoiceSpeakRequest,
    StudioDesignedVoicesResponse,
    StudioGenerateRequest,
    StudioGenerateResponse,
    StudioHistoryItemResponse,
    StudioHistoryResponse,
    StudioTranscribeResponse,
    StudioTopModelResponse,
    StudioTopModelsResponse,
    StudioVoiceDesignConfigResponse,
    StudioVoiceDesignPreviewRequest,
    StudioVoiceDesignPreviewResponse,
    StudioVoiceDesignSaveRequest,
    StudioVoiceDesignSaveResponse,
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

    bucket, key, expires_at = upload_wav_to_hippius(body.user_id, wav_bytes)

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

    audio_url = get_presigned_url(bucket, key, expires_at_val)
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

    stt_started = time.perf_counter()
    stt_result, stt_err = await transcribe_audio(audio_bytes=raw_ref, language=lang)
    stt_latency_ms = int((time.perf_counter() - stt_started) * 1000)
    if not stt_result:
        detail = "Could not transcribe reference audio for cloning."
        if stt_err:
            detail += f" ({stt_err})"
        raise HTTPException(status_code=502, detail=detail)

    reference_text = str(stt_result.get("text") or "").strip()
    if not reference_text:
        raise HTTPException(
            status_code=400,
            detail="Reference audio transcribed to empty text; use clearer reference audio or check language.",
        )
    detected_language = stt_result.get("language")
    if not isinstance(detected_language, str):
        detected_language = lang

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

    bucket, key, expires_at = upload_wav_to_hippius(user_id, out_bytes)

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

    audio_url = get_presigned_url(bucket, key, expires_at) or ""
    return StudioCloneResponse(
        id=history_id,
        audio_url=audio_url,
        expires_at=expires_at.isoformat() if expires_at else "",
        credits=new_credits,
        reference_text=reference_text,
        detected_language=detected_language,
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

    url_a = get_presigned_url(bucket_a, key_a, expires_at) or ""
    url_b = get_presigned_url(bucket_b, key_b, expires_at) or ""
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

    audio_url = get_presigned_url(new_bucket, new_key, saved_expires) or ""
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
                       miner_hotkey, model_name, chute_slug, audio_s3_bucket, audio_s3_key, expires_at, created_at
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
    voices: list[StudioDesignedVoiceItem] = []
    for r in rows:
        exp = datetime.fromisoformat(str(r["expires_at"]).replace("Z", "+00:00")) if r["expires_at"] else None
        expired = exp is not None and exp <= now
        url = None
        if not expired and r["audio_s3_bucket"] and r["audio_s3_key"]:
            url = get_presigned_url(r["audio_s3_bucket"], r["audio_s3_key"], exp)
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

    bucket, key, expires_out = upload_wav_to_hippius(user_id, out_bytes)

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

    audio_url = get_presigned_url(bucket, key, expires_out) or ""
    return StudioCloneResponse(
        id=history_id,
        audio_url=audio_url,
        expires_at=expires_out.isoformat() if expires_out else "",
        credits=new_credits,
        reference_text=ref_script,
        detected_language=None,
    )


@router.get("/history", response_model=StudioHistoryResponse)
async def get_history(user_id: str = Query(..., description="Website user id (e.g. from auth)")):
    """List Studio history for user (TTS + STT)."""
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
    finally:
        await conn.close()

    now = datetime.now(timezone.utc)
    items: list[StudioHistoryItemResponse] = []
    for r in tts_rows:
        expires_at = datetime.fromisoformat(str(r["expires_at"]).replace("Z", "+00:00")) if r["expires_at"] else None
        expired = expires_at is not None and expires_at <= now
        audio_url = None
        if not expired and r["audio_s3_bucket"] and r["audio_s3_key"]:
            audio_url = get_presigned_url(r["audio_s3_bucket"], r["audio_s3_key"], expires_at)

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
        expired = expires_at is not None and expires_at <= now
        audio_url = None
        if not expired and r["audio_s3_bucket"] and r["audio_s3_key"]:
            audio_url = get_presigned_url(r["audio_s3_bucket"], r["audio_s3_key"], expires_at)
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
    items.sort(key=lambda x: x.created_at, reverse=True)
    items = items[:100]
    return StudioHistoryResponse(items=items)


@router.get("/history/{history_id}/audio-url")
async def get_history_audio_url(
    history_id: int,
    user_id: str = Query(...),
    entry_type: str = Query("tts", description="tts, clone, or voice_design (latter two use clone history table)"),
):
    """Get a fresh presigned audio URL for a history entry (if not expired)."""
    kind = (entry_type or "tts").strip().lower()
    if kind in ("clone", "voice_design", "designed_voice"):
        table = "studio_clone_history"
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
    expires_at = datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00")) if row["expires_at"] else None
    if expires_at and expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="Audio has expired (7-day retention).")
    url = get_presigned_url(row["audio_s3_bucket"], row["audio_s3_key"], expires_at)
    if not url:
        raise HTTPException(status_code=410, detail="Audio expired.")
    return {"audio_url": url}
