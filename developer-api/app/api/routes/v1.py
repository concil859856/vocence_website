from __future__ import annotations

import base64
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import require_api_key
from app.core.config import (
    API_CLONE_MAX_REF_AUDIO_BYTES,
    API_DEFAULT_STYLE,
    API_STT_CREDITS_COST,
    API_STT_MAX_AUDIO_BYTES,
    API_TTS_CREDITS_PER_REQUEST,
    API_VOICE_CLONE_CREDITS,
)
from app.db.connection import get_db, refresh_daily_usage_for_today
from app.schemas.api import (
    SttTranscribeRequest,
    SttTranscribeResponse,
    TtsGenerateRequest,
    TtsGenerateResponse,
    VoiceCloneRequest,
    VoiceCloneResponse,
)
from app.services.audio_provider import get_presigned_url, synthesize_speak, transcribe_audio, upload_wav_to_hippius
from app.services.providers import select_api_tts_provider
from app.services.usage import credits_for_chars, enforce_rate_limit, log_api_request
from app.services.voice_clone_client import (
    voice_clone_chute_configured,
    voice_clone_endpoint_label,
    voice_clone_synthesize,
)

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
    if API_TTS_CREDITS_PER_REQUEST > 0:
        credits_needed = API_TTS_CREDITS_PER_REQUEST
    else:
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
    credits_needed = max(1, int(API_STT_CREDITS_COST))
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


@router.post("/v1/voice/clone", response_model=VoiceCloneResponse)
async def voice_clone(body: VoiceCloneRequest, auth_ctx: dict = Depends(require_api_key)):
    """Clone target speech from reference audio (STT on reference, then voice-clone synthesis)."""
    if not voice_clone_chute_configured():
        raise HTTPException(
            status_code=503,
            detail="Voice cloning is not configured on this API (set STUDIO_VOICE_CLONE_URL or STUDIO_VOICE_CLONE_CHUTE_SLUG).",
        )

    ref_b64 = (body.reference_audio_b64 or "").strip()
    if not ref_b64:
        raise HTTPException(status_code=400, detail="reference_audio_b64 is required")
    try:
        ref_bytes = base64.b64decode(ref_b64, validate=False)
    except Exception:
        raise HTTPException(status_code=400, detail="reference_audio_b64 must be valid base64")
    if not ref_bytes:
        raise HTTPException(status_code=400, detail="reference audio decoded to empty bytes")
    if len(ref_bytes) > API_CLONE_MAX_REF_AUDIO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Reference audio exceeds max size ({API_CLONE_MAX_REF_AUDIO_BYTES} bytes)",
        )

    target = (body.target_text or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="target_text is required")

    lang = (body.language or "").strip() or None
    provider_label = voice_clone_endpoint_label()
    credits_needed = max(1, int(API_VOICE_CLONE_CREDITS))
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
                endpoint="/v1/voice/clone",
                provider=provider_label,
                status="rejected",
                http_status=402,
                credits_used=0,
                request_chars=len(target),
                latency_ms=int((time.perf_counter() - started) * 1000),
                error_code="insufficient_credits",
                error_message=f"Need {credits_needed}, have {credits_before}",
            )
            await conn.commit()
            raise HTTPException(status_code=402, detail=f"Insufficient credits. Need {credits_needed}, have {credits_before}")

        stt_result, stt_err = await transcribe_audio(audio_bytes=ref_bytes, language=lang)
        if not stt_result:
            latency_ms = int((time.perf_counter() - started) * 1000)
            await log_api_request(
                conn,
                request_id=request_id,
                user_id=auth_ctx["user_id"],
                api_key_id=auth_ctx["api_key_id"],
                endpoint="/v1/voice/clone",
                provider=provider_label,
                status="error",
                http_status=502,
                credits_used=0,
                request_chars=len(target),
                latency_ms=latency_ms,
                error_code="stt_error",
                error_message=stt_err or "reference transcription failed",
            )
            await conn.commit()
            raise HTTPException(
                status_code=502,
                detail=f"Could not transcribe reference audio: {stt_err or 'unknown'}",
            )

        reference_text = str(stt_result.get("text") or "").strip()
        if not reference_text:
            latency_ms = int((time.perf_counter() - started) * 1000)
            await log_api_request(
                conn,
                request_id=request_id,
                user_id=auth_ctx["user_id"],
                api_key_id=auth_ctx["api_key_id"],
                endpoint="/v1/voice/clone",
                provider=provider_label,
                status="error",
                http_status=400,
                credits_used=0,
                request_chars=len(target),
                latency_ms=latency_ms,
                error_code="empty_reference_transcription",
                error_message="reference audio transcribed to empty text",
            )
            await conn.commit()
            raise HTTPException(
                status_code=400,
                detail="Reference audio transcribed to empty text; use clearer audio or set language.",
            )

        detected_language = stt_result.get("language")
        if not isinstance(detected_language, str):
            detected_language = lang

        out_bytes, clone_err = await voice_clone_synthesize(
            reference_audio_bytes=ref_bytes,
            reference_text=reference_text,
            target_text=target,
        )
        if not out_bytes:
            latency_ms = int((time.perf_counter() - started) * 1000)
            await log_api_request(
                conn,
                request_id=request_id,
                user_id=auth_ctx["user_id"],
                api_key_id=auth_ctx["api_key_id"],
                endpoint="/v1/voice/clone",
                provider=provider_label,
                status="error",
                http_status=502,
                credits_used=0,
                request_chars=len(target),
                latency_ms=latency_ms,
                error_code="clone_error",
                error_message=clone_err or "clone failed",
            )
            await conn.commit()
            raise HTTPException(status_code=502, detail=f"Voice clone failed: {clone_err or 'unknown'}")

        bucket, key, expires_at = upload_wav_to_hippius(auth_ctx["user_id"], out_bytes)
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
            VALUES (?, ?, 'api_voice_clone', ?, ?, ?, 'api_request', ?, ?, datetime('now'))
            """,
            (
                uuid.uuid4().hex,
                auth_ctx["user_id"],
                -credits_needed,
                new_credits,
                f"Developer API voice clone via {provider_label}",
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
            endpoint="/v1/voice/clone",
            provider=provider_label,
            status="success",
            http_status=200,
            credits_used=credits_needed,
            request_chars=len(reference_text) + len(target),
            latency_ms=latency_ms,
        )
        try:
            await refresh_daily_usage_for_today(conn)
        except Exception as e:
            print(f"[developer-api] daily usage refresh failed: {e}")
        await conn.commit()
        return VoiceCloneResponse(
            request_id=request_id,
            audio_url=audio_url,
            reference_text=reference_text,
            language=detected_language,
            provider=provider_label,
            credits_remaining=new_credits,
            latency_ms=latency_ms,
            credits_used=credits_needed,
        )
    finally:
        await conn.close()

