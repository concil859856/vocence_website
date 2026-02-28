"""Studio TTS API: top models (main validator), generate, history."""

import os
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Query

from database import acquire
from schemas import (
    StudioGenerateRequest,
    StudioGenerateResponse,
    StudioHistoryItemResponse,
    StudioHistoryResponse,
    StudioTopModelResponse,
    StudioTopModelsResponse,
)
from studio_tts_service import (
    fetch_chute_slug,
    get_presigned_url,
    synthesize_speak,
    upload_wav_to_hippius,
)

router = APIRouter(prefix="/studio", tags=["studio"])


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


@router.get("/top-models", response_model=StudioTopModelsResponse)
async def get_top_models(limit: int = Query(3, ge=1, le=10)):
    """Top miners ranked by main validator; returns up to `limit` (default 3). Display name = HF repo name only."""
    async with acquire() as conn:
        val_rows = await conn.fetch(
            "SELECT uid, hotkey FROM validator_registry ORDER BY uid ASC"
        )
    main_hotkey = _main_validator_hotkey(val_rows)
    if not main_hotkey:
        return StudioTopModelsResponse(models=[])

    async with acquire() as conn:
        rows = await conn.fetch("""
            SELECT rm.miner_hotkey, rm.model_name, rm.chute_id, rm.chute_slug
            FROM registered_miners rm
            INNER JOIN performance_metrics pm
              ON pm.miner_hotkey = rm.miner_hotkey AND pm.validator_hotkey = $1
            WHERE rm.is_valid = true
            ORDER BY pm.win_rate DESC, rm.uid ASC
            LIMIT $2
        """, main_hotkey, limit)

    models = [
        StudioTopModelResponse(
            miner_hotkey=r["miner_hotkey"],
            model_name=r["model_name"] or "",
            display_name=_model_display_name(r["model_name"]),
            chute_id=r["chute_id"] or "",
            chute_slug=r["chute_slug"] or "",
        )
        for r in rows
    ]
    return StudioTopModelsResponse(models=models)


@router.post("/generate", response_model=StudioGenerateResponse)
async def generate_tts(body: StudioGenerateRequest):
    """Call miner's Chutes /speak, upload WAV to Hippius (7-day expiry), store in owner DB, return audio URL."""
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    instruction = (body.style_instruction or "").strip() or "neutral voice"
    chute_slug = body.chute_slug

    if not chute_slug:
        slug = await fetch_chute_slug(body.chute_id)
        if not slug:
            raise HTTPException(status_code=400, detail="Could not resolve chute; chute may be offline.")
        chute_slug = slug

    wav_bytes = await synthesize_speak(chute_slug, text, instruction)
    if not wav_bytes:
        raise HTTPException(
            status_code=502,
            detail="TTS request to miner failed or returned no audio.",
        )

    bucket, key, expires_at = upload_wav_to_hippius(body.user_id, wav_bytes)

    async with acquire() as conn:
        row = await conn.fetchrow("""
            INSERT INTO studio_tts_history
            (user_id, miner_hotkey, model_name, prompt_text, style_instruction, audio_s3_bucket, audio_s3_key, expires_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, expires_at
        """,
            body.user_id,
            body.miner_hotkey,
            body.model_name or "",
            text,
            instruction,
            bucket,
            key,
            expires_at,
        )
    history_id = row["id"]
    expires_at_val = row["expires_at"]

    audio_url = get_presigned_url(bucket, key, expires_at_val)
    if not audio_url:
        audio_url = ""

    return StudioGenerateResponse(
        id=history_id,
        audio_url=audio_url,
        expires_at=expires_at_val.isoformat() if expires_at_val else "",
    )


@router.get("/history", response_model=StudioHistoryResponse)
async def get_history(user_id: str = Query(..., description="Website user id (e.g. from auth)")):
    """List TTS history for user; audio_url is presigned when not expired."""
    async with acquire() as conn:
        rows = await conn.fetch("""
            SELECT id, miner_hotkey, model_name, prompt_text, style_instruction,
                   audio_s3_bucket, audio_s3_key, expires_at, created_at
            FROM studio_tts_history
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 100
        """, user_id)

    now = datetime.now(timezone.utc)
    items = []
    for r in rows:
        expires_at = r["expires_at"]
        expired = expires_at is not None and expires_at <= now
        audio_url = None
        if not expired and r["audio_s3_bucket"] and r["audio_s3_key"]:
            audio_url = get_presigned_url(r["audio_s3_bucket"], r["audio_s3_key"], expires_at)

        items.append(
            StudioHistoryItemResponse(
                id=r["id"],
                miner_hotkey=r["miner_hotkey"],
                model_name=r["model_name"] or "",
                display_name=_model_display_name(r["model_name"]),
                prompt_text=r["prompt_text"] or "",
                style_instruction=r["style_instruction"] or "neutral voice",
                audio_url=audio_url,
                expires_at=expires_at.isoformat() if expires_at else "",
                created_at=r["created_at"].isoformat() if r["created_at"] else "",
                expired=expired,
            )
        )
    return StudioHistoryResponse(items=items)


@router.get("/history/{history_id}/audio-url")
async def get_history_audio_url(history_id: int, user_id: str = Query(...)):
    """Get a fresh presigned audio URL for a history entry (if not expired)."""
    async with acquire() as conn:
        row = await conn.fetchrow("""
            SELECT audio_s3_bucket, audio_s3_key, expires_at
            FROM studio_tts_history
            WHERE id = $1 AND user_id = $2
        """, history_id, user_id)
    if not row:
        raise HTTPException(status_code=404, detail="Not found")
    expires_at = row["expires_at"]
    if expires_at and expires_at <= datetime.now(timezone.utc):
        raise HTTPException(status_code=410, detail="Audio has expired (7-day retention).")
    url = get_presigned_url(row["audio_s3_bucket"], row["audio_s3_key"], expires_at)
    if not url:
        raise HTTPException(status_code=410, detail="Audio expired.")
    return {"audio_url": url}
