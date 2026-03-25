"""Studio TTS API: configured models (env), generate, history."""

import os
import re
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query

from database import acquire
from local_db import get_connection, record_credit_transaction, refresh_daily_usage_for_day
from ranking import (
    RANKING_WINDOW_EVALS,
    get_ranked_miner_stats_for_validator,
    sort_miners_for_display,
)
from routers.auth import require_auth
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


TTS_CREDITS_COST = 10


@router.post("/generate", response_model=StudioGenerateResponse)
async def generate_tts(body: StudioGenerateRequest, user_id: str = Depends(require_auth)):
    """Call miner's Chutes /speak, upload WAV to Hippius, store in website.db, deduct 10 credits."""
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
    configured_models = _configured_studio_models()
    configured_by_slug = {m.chute_slug: m for m in configured_models}

    effective_model_name = body.model_name
    effective_miner_hotkey = body.miner_hotkey
    chute_slug = body.chute_slug

    # If env models are configured, only allow requests that match configured entries.
    if configured_models:
        selected = configured_by_slug.get(chute_slug)
        if not selected:
            raise HTTPException(status_code=400, detail="Invalid studio model selection.")
        chute_slug = selected.chute_slug
        effective_model_name = selected.model_name
        effective_miner_hotkey = selected.miner_hotkey
    elif not chute_slug:
        # Legacy fallback when no env config exists.
        slug = await fetch_chute_slug(body.chute_id)
        if not slug:
            raise HTTPException(status_code=400, detail="Could not resolve chute; chute may be offline.")
        chute_slug = slug

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


@router.get("/history", response_model=StudioHistoryResponse)
async def get_history(user_id: str = Query(..., description="Website user id (e.g. from auth)")):
    """List TTS history for user; audio_url is presigned when not expired."""
    conn = await get_connection()
    try:
        rows = await (await conn.execute("""
            SELECT id, miner_hotkey, model_name, prompt_text, style_instruction,
                   audio_s3_bucket, audio_s3_key, expires_at, created_at
            FROM studio_tts_history
            WHERE user_id = ?
            ORDER BY datetime(created_at) DESC
            LIMIT 100
        """, (user_id,))).fetchall()
    finally:
        await conn.close()

    now = datetime.now(timezone.utc)
    items = []
    for r in rows:
        expires_at = datetime.fromisoformat(str(r["expires_at"]).replace("Z", "+00:00")) if r["expires_at"] else None
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
                created_at=str(r["created_at"] or ""),
                expired=expired,
            )
        )
    return StudioHistoryResponse(items=items)


@router.get("/history/{history_id}/audio-url")
async def get_history_audio_url(history_id: int, user_id: str = Query(...)):
    """Get a fresh presigned audio URL for a history entry (if not expired)."""
    conn = await get_connection()
    try:
        row = await (await conn.execute("""
            SELECT audio_s3_bucket, audio_s3_key, expires_at
            FROM studio_tts_history
            WHERE id = ? AND user_id = ?
        """, (history_id, user_id))).fetchone()
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
