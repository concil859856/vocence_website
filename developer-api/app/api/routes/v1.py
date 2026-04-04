from __future__ import annotations

import base64
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import require_api_key
from app.core.config import API_DEFAULT_STYLE, API_STT_CREDITS_COST, API_STT_MAX_AUDIO_BYTES
from app.db.connection import get_db, refresh_daily_usage_for_today
from app.schemas.api import (
    SttTranscribeRequest,
    SttTranscribeResponse,
    TtsGenerateRequest,
    TtsGenerateResponse,
)
from app.services.audio_provider import get_presigned_url, synthesize_speak, transcribe_audio, upload_wav_to_hippius
from app.services.providers import select_api_tts_provider
from app.services.usage import credits_for_chars, enforce_rate_limit, log_api_request

router = APIRouter()


async def _ensure_premium(conn, user_id: str) -> None:
    paid_row = await (
        await conn.execute(
            """
            SELECT COUNT(*) AS n
            FROM payments
            WHERE user_id = ?
              AND status IN ('paid', 'completed')
              AND credits_granted > 0
              AND LOWER(COALESCE(plan_code, '')) = 'premium'
            """,
            (user_id,),
        )
    ).fetchone()
    if int(paid_row["n"] or 0) <= 0:
        raise HTTPException(status_code=402, detail="Developer API requires a successful Premium plan purchase first.")


async def _get_user_credits(conn, user_id: str) -> int:
    user_row = await (await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))).fetchone()
    if user_row is None:
        raise HTTPException(status_code=404, detail="User not found")
    return int(user_row["credits"] or 0)


@router.get("/health")
async def health():
    return {"status": "ok", "service": "vocence-developer-api"}


@router.post("/v1/tts/generate", response_model=TtsGenerateResponse)
async def tts_generate(body: TtsGenerateRequest, auth_ctx: dict = Depends(require_api_key)):
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    provider_name, chute_slug = select_api_tts_provider(body.model)
    style_instruction = (body.style_instruction or API_DEFAULT_STYLE).strip() or API_DEFAULT_STYLE
    char_count = len(text) + len(style_instruction)
    credits_needed = credits_for_chars(char_count)
    started = time.perf_counter()
    request_id = uuid.uuid4().hex

    conn = await get_db()
    try:
        await _ensure_premium(conn, auth_ctx["user_id"])
        await enforce_rate_limit(conn, auth_ctx["api_key_id"], auth_ctx["rate_limit_rpm"])
        credits_before = await _get_user_credits(conn, auth_ctx["user_id"])
        if credits_before < credits_needed:
            await log_api_request(
                conn,
                request_id=request_id,
                user_id=auth_ctx["user_id"],
                api_key_id=auth_ctx["api_key_id"],
                endpoint="/v1/tts/generate",
                provider=provider_name,
                status="rejected",
                http_status=402,
                credits_used=0,
                request_chars=char_count,
                latency_ms=int((time.perf_counter() - started) * 1000),
                error_code="insufficient_credits",
                error_message=f"Need {credits_needed}, have {credits_before}",
            )
            await conn.commit()
            raise HTTPException(status_code=402, detail=f"Insufficient credits. Need {credits_needed}, have {credits_before}")

        wav_bytes, err = await synthesize_speak(chute_slug, text, style_instruction)
        if not wav_bytes:
            latency_ms = int((time.perf_counter() - started) * 1000)
            await log_api_request(
                conn,
                request_id=request_id,
                user_id=auth_ctx["user_id"],
                api_key_id=auth_ctx["api_key_id"],
                endpoint="/v1/tts/generate",
                provider=provider_name,
                status="error",
                http_status=502,
                credits_used=0,
                request_chars=char_count,
                latency_ms=latency_ms,
                error_code="provider_error",
                error_message=err or "provider failed",
            )
            await conn.commit()
            raise HTTPException(status_code=502, detail=f"TTS provider failed: {err or 'unknown'}")

        bucket, key, expires_at = upload_wav_to_hippius(auth_ctx["user_id"], wav_bytes)
        audio_url = get_presigned_url(bucket, key, expires_at) or ""
        new_credits = credits_before - credits_needed

        await conn.execute(
            "UPDATE auth_users SET credits = ?, updated_at = datetime('now') WHERE id = ?",
            (new_credits, auth_ctx["user_id"]),
        )
        await conn.execute(
            """
            INSERT INTO credit_transactions
            (id, user_id, transaction_type, amount, balance_after, description, reference_type, reference_id, metadata_json, created_at)
            VALUES (?, ?, 'api_tts_generation', ?, ?, ?, 'api_request', ?, ?, datetime('now'))
            """,
            (
                uuid.uuid4().hex,
                auth_ctx["user_id"],
                -credits_needed,
                new_credits,
                f"Developer API TTS via {provider_name}",
                request_id,
                '{"source":"developer-api"}',
            ),
        )
        await conn.execute(
            "UPDATE api_keys SET last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            (auth_ctx["api_key_id"],),
        )
        latency_ms = int((time.perf_counter() - started) * 1000)
        await log_api_request(
            conn,
            request_id=request_id,
            user_id=auth_ctx["user_id"],
            api_key_id=auth_ctx["api_key_id"],
            endpoint="/v1/tts/generate",
            provider=provider_name,
            status="success",
            http_status=200,
            credits_used=credits_needed,
            request_chars=char_count,
            latency_ms=latency_ms,
        )
        try:
            await refresh_daily_usage_for_today(conn)
        except Exception as e:
            print(f"[developer-api] daily usage refresh failed: {e}")
        await conn.commit()
        return TtsGenerateResponse(
            request_id=request_id,
            audio_url=audio_url,
            provider=provider_name,
            credits_remaining=new_credits,
            latency_ms=latency_ms,
            credits_used=credits_needed,
            request_chars=char_count,
        )
    finally:
        await conn.close()


@router.post("/v1/stt/transcribe", response_model=SttTranscribeResponse)
async def stt_transcribe(body: SttTranscribeRequest, auth_ctx: dict = Depends(require_api_key)):
    audio_b64 = (body.audio_b64 or "").strip()
    if not audio_b64:
        raise HTTPException(status_code=400, detail="audio_b64 is required")
    try:
        audio_bytes = base64.b64decode(audio_b64, validate=False)
    except Exception:
        raise HTTPException(status_code=400, detail="audio_b64 must be valid base64")
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="audio_b64 decoded to empty bytes")
    if len(audio_bytes) > API_STT_MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail=f"Audio exceeds max size ({API_STT_MAX_AUDIO_BYTES} bytes)")

    provider_name = "Whisper Large v3"
    credits_needed = max(1, API_STT_CREDITS_COST)
    started = time.perf_counter()
    request_id = uuid.uuid4().hex

    conn = await get_db()
    try:
        await _ensure_premium(conn, auth_ctx["user_id"])
        await enforce_rate_limit(conn, auth_ctx["api_key_id"], auth_ctx["rate_limit_rpm"])
        credits_before = await _get_user_credits(conn, auth_ctx["user_id"])
        if credits_before < credits_needed:
            await log_api_request(
                conn,
                request_id=request_id,
                user_id=auth_ctx["user_id"],
                api_key_id=auth_ctx["api_key_id"],
                endpoint="/v1/stt/transcribe",
                provider=provider_name,
                status="rejected",
                http_status=402,
                credits_used=0,
                request_chars=0,
                latency_ms=int((time.perf_counter() - started) * 1000),
                error_code="insufficient_credits",
                error_message=f"Need {credits_needed}, have {credits_before}",
            )
            await conn.commit()
            raise HTTPException(status_code=402, detail=f"Insufficient credits. Need {credits_needed}, have {credits_before}")

        result, err = await transcribe_audio(audio_bytes=audio_bytes, language=(body.language or "").strip() or None)
        if not result:
            latency_ms = int((time.perf_counter() - started) * 1000)
            await log_api_request(
                conn,
                request_id=request_id,
                user_id=auth_ctx["user_id"],
                api_key_id=auth_ctx["api_key_id"],
                endpoint="/v1/stt/transcribe",
                provider=provider_name,
                status="error",
                http_status=502,
                credits_used=0,
                request_chars=0,
                latency_ms=latency_ms,
                error_code="provider_error",
                error_message=err or "provider failed",
            )
            await conn.commit()
            raise HTTPException(status_code=502, detail=f"STT provider failed: {err or 'unknown'}")

        text = str(result.get("text") or "").strip()
        if not text:
            latency_ms = int((time.perf_counter() - started) * 1000)
            await log_api_request(
                conn,
                request_id=request_id,
                user_id=auth_ctx["user_id"],
                api_key_id=auth_ctx["api_key_id"],
                endpoint="/v1/stt/transcribe",
                provider=provider_name,
                status="error",
                http_status=502,
                credits_used=0,
                request_chars=0,
                latency_ms=latency_ms,
                error_code="empty_transcription",
                error_message="provider returned empty text",
            )
            await conn.commit()
            raise HTTPException(status_code=502, detail="STT provider returned empty text")

        new_credits = credits_before - credits_needed
        await conn.execute(
            "UPDATE auth_users SET credits = ?, updated_at = datetime('now') WHERE id = ?",
            (new_credits, auth_ctx["user_id"]),
        )
        await conn.execute(
            """
            INSERT INTO credit_transactions
            (id, user_id, transaction_type, amount, balance_after, description, reference_type, reference_id, metadata_json, created_at)
            VALUES (?, ?, 'api_stt_transcription', ?, ?, ?, 'api_request', ?, ?, datetime('now'))
            """,
            (
                uuid.uuid4().hex,
                auth_ctx["user_id"],
                -credits_needed,
                new_credits,
                f"Developer API STT via {provider_name}",
                request_id,
                '{"source":"developer-api"}',
            ),
        )
        await conn.execute(
            "UPDATE api_keys SET last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            (auth_ctx["api_key_id"],),
        )
        latency_ms = int((time.perf_counter() - started) * 1000)
        await log_api_request(
            conn,
            request_id=request_id,
            user_id=auth_ctx["user_id"],
            api_key_id=auth_ctx["api_key_id"],
            endpoint="/v1/stt/transcribe",
            provider=provider_name,
            status="success",
            http_status=200,
            credits_used=credits_needed,
            request_chars=0,
            latency_ms=latency_ms,
        )
        await conn.commit()
        detected_language = result.get("language")
        return SttTranscribeResponse(
            request_id=request_id,
            text=text,
            language=(detected_language if isinstance(detected_language, str) else body.language),
            provider=provider_name,
            credits_remaining=new_credits,
            latency_ms=latency_ms,
            credits_used=credits_needed,
        )
    finally:
        await conn.close()

