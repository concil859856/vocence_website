from __future__ import annotations

import base64
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException

from app.core.auth import require_api_key
from app.core.config import (
    API_CLONE_MAX_REF_AUDIO_BYTES,
    API_DEFAULT_STYLE,
    API_NOISE_REMOVER_CREDITS_COST,
    API_NOISE_REMOVER_MAX_AUDIO_BYTES,
    API_NOISE_REMOVER_MAX_DURATION_SEC,
    API_STT_CREDITS_COST,
    API_STT_CREDITS_PER_MIN,
    API_STT_MAX_DURATION_SEC,
    API_STT_MAX_AUDIO_BYTES,
    API_TTS_CREDITS_PER_REQUEST,
    API_VOICE_CLONE_CREDITS,
    API_CLONE_CREDITS_PER_1M_CHARS,
)
from app.db.connection import get_db, refresh_daily_usage_for_today
from app.schemas.api import (
    DubbingEnhanceRequest,
    DubbingEnhanceResponse,
    SttTranscribeRequest,
    SttTranscribeResponse,
    TtsGenerateRequest,
    TtsGenerateResponse,
    TtsSpeakRequest,
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


# Public-facing brand for the ``provider`` field across every TTS / STT /
# clone response. The internal name (from API_TTS_PROVIDER_*_NAME or the
# clone label) is still used for logging + analytics; we just don't leak
# implementation detail to API consumers.
BRAND = "Vocence API"


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


async def _atomic_deduct(conn, user_id: str, cost: int) -> int | None:
    """Atomically deduct credits. Returns new balance, or None if insufficient."""
    cursor = await conn.execute(
        "UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') "
        "WHERE id = ? AND credits >= ?",
        (cost, user_id, cost),
    )
    if cursor.rowcount == 0:
        return None
    row = await (await conn.execute(
        "SELECT credits FROM auth_users WHERE id = ?", (user_id,)
    )).fetchone()
    return int(row["credits"]) if row else 0


@router.get("/health")
async def health():
    return {"status": "ok", "service": "vocence-developer-api"}


@router.post("/v1/tts/generate", response_model=TtsGenerateResponse, tags=["TTS"], summary="Generate speech from a text description of the voice (PromptTTS)")
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
        await enforce_rate_limit(conn, auth_ctx["user_id"], auth_ctx["rate_limit_rpm"])
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

        bucket, key, expires_at = upload_wav_to_hippius(auth_ctx["user_id"], wav_bytes, subdir="tts")
        audio_url = get_presigned_url(bucket, key, expires_at) or ""
        new_credits = await _atomic_deduct(conn, auth_ctx["user_id"], credits_needed)
        if new_credits is None:
            raise HTTPException(status_code=402, detail="Insufficient credits.")

        await conn.execute(
            """
            INSERT INTO credit_transactions
            (id, user_id, transaction_type, amount, balance_after, description, reference_type, reference_id, metadata_json, created_at)
            VALUES (?, ?, 'api_tts_generation', ?, ?, ?, 'api_request', ?, ?, datetime('now'))
            """,
            (uuid.uuid4().hex, auth_ctx["user_id"], -credits_needed, new_credits,
             f"Developer API TTS via {provider_name}", request_id, '{"source":"developer-api"}'),
        )
        await conn.execute(
            "UPDATE api_keys SET last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            (auth_ctx["api_key_id"],),
        )
        latency_ms = int((time.perf_counter() - started) * 1000)
        await log_api_request(
            conn, request_id=request_id, user_id=auth_ctx["user_id"],
            api_key_id=auth_ctx["api_key_id"], endpoint="/v1/tts/generate",
            provider=provider_name, status="success", http_status=200,
            credits_used=credits_needed, request_chars=char_count, latency_ms=latency_ms,
        )
        try:
            await refresh_daily_usage_for_today(conn)
        except Exception as e:
            print(f"[developer-api] daily usage refresh failed: {e}")
        await conn.commit()
        return TtsGenerateResponse(
            request_id=request_id, audio_url=audio_url, provider=BRAND,
            credits_remaining=new_credits, latency_ms=latency_ms,
            credits_used=credits_needed, request_chars=char_count,
        )
    finally:
        await conn.close()


@router.post("/v1/tts/speak", response_model=TtsGenerateResponse, tags=["TTS"], summary="Synthesize text in a pre-defined speaker's voice")
async def tts_speak(body: TtsSpeakRequest, auth_ctx: dict = Depends(require_api_key)):
    """Speak ``text`` in the voice of a pre-defined speaker. Pick a
    speaker id from ``GET /v1/voices/builtin`` (e.g. ``voc-atlas``,
    ``design-aria``). For describing a voice in free-form prose use
    ``POST /v1/tts/generate`` instead — the two modes are mutually
    exclusive on purpose."""
    text = (body.text or "").strip()
    voice = (body.voice or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")
    if not voice:
        raise HTTPException(status_code=400, detail="voice is required (see GET /v1/voices/builtin)")

    # Per-char billing (4,000 cr / 1M chars by default = $10 / 1M).
    # ``API_TTS_CREDITS_PER_REQUEST`` is a legacy flat-rate fallback —
    # set > 0 only if an operator wants per-call pricing instead.
    if API_TTS_CREDITS_PER_REQUEST > 0:
        credits_needed = max(1, int(API_TTS_CREDITS_PER_REQUEST))
    else:
        credits_needed = credits_for_chars(len(text))
    started = time.perf_counter()
    request_id = uuid.uuid4().hex

    conn = await get_db()
    try:
        await _ensure_premium(conn, auth_ctx["user_id"])
        await enforce_rate_limit(conn, auth_ctx["user_id"], auth_ctx["rate_limit_rpm"])
        credits_before = await _get_user_credits(conn, auth_ctx["user_id"])
        if credits_before < credits_needed:
            await log_api_request(
                conn, request_id=request_id, user_id=auth_ctx["user_id"],
                api_key_id=auth_ctx["api_key_id"], endpoint="/v1/tts/speak",
                provider=BRAND, status="rejected", http_status=402,
                credits_used=0, request_chars=len(text),
                latency_ms=int((time.perf_counter() - started) * 1000),
                error_code="insufficient_credits",
                error_message=f"Need {credits_needed}, have {credits_before}",
            )
            await conn.commit()
            raise HTTPException(status_code=402, detail=f"Insufficient credits. Need {credits_needed}, have {credits_before}")

        from app.services.dashboard_proxy import call_dashboard
        result = await call_dashboard(
            "POST",
            "/api/dashboard/studio/tts/voice-clone-sample",
            user_id=auth_ctx["user_id"],
            json={"sample_voice_id": voice, "target_text": text},
            timeout_sec=120.0,
        )

        new_balance = await _atomic_deduct(conn, auth_ctx["user_id"], credits_needed)
        if new_balance is None:
            raise HTTPException(status_code=402, detail="Insufficient credits.")
        await conn.execute(
            """
            INSERT INTO credit_transactions
            (id, user_id, transaction_type, amount, balance_after, description, reference_type, reference_id, metadata_json, created_at)
            VALUES (?, ?, 'api_tts_speak', ?, ?, ?, 'api_request', ?, ?, datetime('now'))
            """,
            (uuid.uuid4().hex, auth_ctx["user_id"], -credits_needed, new_balance,
             f"Developer API TTS speak · {voice}", request_id, '{"source":"developer-api"}'),
        )
        await conn.execute(
            "UPDATE api_keys SET last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            (auth_ctx["api_key_id"],),
        )
        latency_ms = int((time.perf_counter() - started) * 1000)
        await log_api_request(
            conn, request_id=request_id, user_id=auth_ctx["user_id"],
            api_key_id=auth_ctx["api_key_id"], endpoint="/v1/tts/speak",
            provider=BRAND, status="success", http_status=200,
            credits_used=credits_needed, request_chars=len(text), latency_ms=latency_ms,
        )
        try:
            await refresh_daily_usage_for_today(conn)
        except Exception as e:
            print(f"[developer-api] daily usage refresh failed: {e}")
        await conn.commit()
        return TtsGenerateResponse(
            request_id=request_id,
            audio_url=result.get("audio_url") or "",
            provider=BRAND,
            credits_remaining=new_balance,
            latency_ms=latency_ms,
            credits_used=credits_needed,
            request_chars=len(text),
        )
    finally:
        await conn.close()


@router.post("/v1/stt/transcribe", response_model=SttTranscribeResponse, tags=["STT"], summary="Transcribe audio to text")
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
    # STT bills per-minute (rounded up). Until we have the transcribed
    # duration we use the worst-case cost (5 min × per-min rate) for the
    # pre-flight balance check, then deduct the actual amount once the
    # provider returns. ``API_STT_CREDITS_COST`` is a legacy fallback
    # for the rare op who pins a flat per-call price.
    per_min = max(0, int(API_STT_CREDITS_PER_MIN))
    legacy_flat = max(0, int(API_STT_CREDITS_COST))
    max_credits_per_call = (
        legacy_flat
        if legacy_flat > 0
        else max(1, per_min * ((API_STT_MAX_DURATION_SEC + 59) // 60))
    )
    started = time.perf_counter()
    request_id = uuid.uuid4().hex

    conn = await get_db()
    try:
        await _ensure_premium(conn, auth_ctx["user_id"])
        await enforce_rate_limit(conn, auth_ctx["user_id"], auth_ctx["rate_limit_rpm"])
        credits_before = await _get_user_credits(conn, auth_ctx["user_id"])
        if credits_before < max_credits_per_call:
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
                error_message=f"Need up to {max_credits_per_call}, have {credits_before}",
            )
            await conn.commit()
            raise HTTPException(
                status_code=402,
                detail=f"Insufficient credits. STT may cost up to {max_credits_per_call} credits per call, you have {credits_before}.",
            )

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

        # Compute actual credits from the audio duration the provider
        # reported. Round up to the next minute. Reject if it came back
        # over the cap (provider should have already failed, but defense
        # in depth — we don't want to bill for over-cap audio).
        actual_duration_sec = float(result.get("duration_seconds") or 0.0)
        if actual_duration_sec > API_STT_MAX_DURATION_SEC:
            raise HTTPException(
                status_code=413,
                detail=f"Audio is {actual_duration_sec:.1f}s — STT is limited to {API_STT_MAX_DURATION_SEC}s ({API_STT_MAX_DURATION_SEC // 60} min).",
            )
        if legacy_flat > 0:
            credits_needed = legacy_flat
        else:
            minutes_rounded_up = max(1, int((actual_duration_sec + 59.999) // 60))
            credits_needed = max(1, per_min * minutes_rounded_up)
        new_credits = await _atomic_deduct(conn, auth_ctx["user_id"], credits_needed)
        if new_credits is None:
            raise HTTPException(status_code=402, detail="Insufficient credits.")
        await conn.execute(
            """
            INSERT INTO credit_transactions
            (id, user_id, transaction_type, amount, balance_after, description, reference_type, reference_id, metadata_json, created_at)
            VALUES (?, ?, 'api_stt_transcription', ?, ?, ?, 'api_request', ?, ?, datetime('now'))
            """,
            (uuid.uuid4().hex, auth_ctx["user_id"], -credits_needed, new_credits,
             f"Developer API STT via {provider_name} ({actual_duration_sec:.1f}s)", request_id, '{"source":"developer-api"}'),
        )
        await conn.execute(
            "UPDATE api_keys SET last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            (auth_ctx["api_key_id"],),
        )
        latency_ms = int((time.perf_counter() - started) * 1000)
        await log_api_request(
            conn, request_id=request_id, user_id=auth_ctx["user_id"],
            api_key_id=auth_ctx["api_key_id"], endpoint="/v1/stt/transcribe",
            provider=provider_name, status="success", http_status=200,
            credits_used=credits_needed, request_chars=0, latency_ms=latency_ms,
        )
        try:
            await refresh_daily_usage_for_today(conn)
        except Exception as e:
            print(f"[developer-api] daily usage refresh failed: {e}")
        await conn.commit()
        detected_language = result.get("language")
        return SttTranscribeResponse(
            request_id=request_id,
            text=text,
            language=(detected_language if isinstance(detected_language, str) else body.language),
            provider=BRAND,
            credits_remaining=new_credits,
            latency_ms=latency_ms,
            credits_used=credits_needed,
        )
    finally:
        await conn.close()


@router.post("/v1/voice/clone", response_model=VoiceCloneResponse, tags=["Voice Clone"], summary="One-shot voice cloning from a reference clip")
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
    # Voice cloning bills per-character at the same rate as TTS
    # ($10 / 1M chars). The legacy flat ``API_VOICE_CLONE_CREDITS``
    # is honored when explicitly set > 0 by operators who want a
    # fixed per-call price.
    legacy_clone_flat = max(0, int(API_VOICE_CLONE_CREDITS))
    if legacy_clone_flat > 0:
        credits_needed = legacy_clone_flat
    else:
        per_million = max(1, int(API_CLONE_CREDITS_PER_1M_CHARS))
        # round-up division — even 1 char costs at least 1 credit.
        credits_needed = max(1, (len(target) * per_million + 999_999) // 1_000_000)
    started = time.perf_counter()
    request_id = uuid.uuid4().hex

    conn = await get_db()
    try:
        await _ensure_premium(conn, auth_ctx["user_id"])
        await enforce_rate_limit(conn, auth_ctx["user_id"], auth_ctx["rate_limit_rpm"])
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

        bucket, key, expires_at = upload_wav_to_hippius(auth_ctx["user_id"], out_bytes, subdir="clone")
        audio_url = get_presigned_url(bucket, key, expires_at) or ""
        new_credits = await _atomic_deduct(conn, auth_ctx["user_id"], credits_needed)
        if new_credits is None:
            raise HTTPException(status_code=402, detail="Insufficient credits.")

        await conn.execute(
            """
            INSERT INTO credit_transactions
            (id, user_id, transaction_type, amount, balance_after, description, reference_type, reference_id, metadata_json, created_at)
            VALUES (?, ?, 'api_voice_clone', ?, ?, ?, 'api_request', ?, ?, datetime('now'))
            """,
            (uuid.uuid4().hex, auth_ctx["user_id"], -credits_needed, new_credits,
             f"Developer API voice clone via {provider_label}", request_id, '{"source":"developer-api"}'),
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
            provider=BRAND,
            credits_remaining=new_credits,
            latency_ms=latency_ms,
            credits_used=credits_needed,
        )
    finally:
        await conn.close()


@router.post("/v1/audio/noise-remover", response_model=DubbingEnhanceResponse, tags=["Audio"], summary="Remove background noise from audio")
async def noise_remover_enhance(body: DubbingEnhanceRequest, auth_ctx: dict = Depends(require_api_key)):
    """Upload noisy audio (base64-encoded) and receive an enhanced version
    with background noise removed. Max 5 minutes, 50 MB."""
    audio_b64 = (body.audio_b64 or "").strip()
    if not audio_b64:
        raise HTTPException(status_code=400, detail="audio_b64 is required")
    try:
        audio_bytes = base64.b64decode(audio_b64, validate=False)
    except Exception:
        raise HTTPException(status_code=400, detail="audio_b64 must be valid base64")
    if not audio_bytes:
        raise HTTPException(status_code=400, detail="audio_b64 decoded to empty bytes")
    if len(audio_bytes) > API_NOISE_REMOVER_MAX_AUDIO_BYTES:
        max_mb = API_NOISE_REMOVER_MAX_AUDIO_BYTES / (1024 * 1024)
        raise HTTPException(status_code=413, detail=f"Audio exceeds {max_mb:.0f} MB limit.")

    # Probe duration up front. ffprobe is fast; failure → fall back to
    # worst-case bill (5 min × per-min rate). We need the duration BOTH
    # for the cap check (reject > 5 min before calling the pod) AND
    # for per-minute billing.
    import asyncio as _asyncio
    from app.services.audio_probe import probe_audio_duration_seconds
    probed_dur = await _asyncio.to_thread(probe_audio_duration_seconds, audio_bytes, "input.wav")
    if probed_dur is not None and probed_dur > API_NOISE_REMOVER_MAX_DURATION_SEC:
        raise HTTPException(
            status_code=413,
            detail=f"Audio is {probed_dur:.1f}s — Noise Remover is limited to {API_NOISE_REMOVER_MAX_DURATION_SEC}s ({API_NOISE_REMOVER_MAX_DURATION_SEC // 60} min).",
        )

    # Per-minute billing. ``API_NOISE_REMOVER_CREDITS_COST`` (default 5)
    # is now interpreted as "max credits for a full-length 5-min call",
    # broken down to 1 cr/min so a 30-sec call only costs 1 cr instead
    # of 5. Round up to the next whole minute (industry standard).
    per_min_rate = max(1, int(API_NOISE_REMOVER_CREDITS_COST) // max(1, (API_NOISE_REMOVER_MAX_DURATION_SEC // 60)))
    if probed_dur is None:
        # Couldn't probe — bill the worst-case so the user doesn't get
        # a free ride on un-parseable audio. They can fix their input
        # if they care about the price.
        billed_min = API_NOISE_REMOVER_MAX_DURATION_SEC // 60
    else:
        billed_min = max(1, int((probed_dur + 59.999) // 60))
    credits_needed = max(1, per_min_rate * billed_min)
    max_possible = max(1, per_min_rate * (API_NOISE_REMOVER_MAX_DURATION_SEC // 60))
    started = time.perf_counter()
    request_id = uuid.uuid4().hex

    conn = await get_db()
    try:
        await _ensure_premium(conn, auth_ctx["user_id"])
        await enforce_rate_limit(conn, auth_ctx["user_id"], auth_ctx["rate_limit_rpm"])
        credits_before = await _get_user_credits(conn, auth_ctx["user_id"])
        if credits_before < max_possible:
            await log_api_request(
                conn, request_id=request_id, user_id=auth_ctx["user_id"],
                api_key_id=auth_ctx["api_key_id"], endpoint="/v1/audio/noise-remover",
                provider=BRAND, status="rejected", http_status=402,
                credits_used=0, request_chars=0,
                latency_ms=int((time.perf_counter() - started) * 1000),
                error_code="insufficient_credits",
                error_message=f"Need up to {max_possible}, have {credits_before}",
            )
            await conn.commit()
            raise HTTPException(
                status_code=402,
                detail=f"Insufficient credits. Noise remover may cost up to {max_possible} credits per call, you have {credits_before}.",
            )

        from app.services.dashboard_proxy import call_dashboard
        result = await call_dashboard(
            "POST",
            "/api/dashboard/studio/noise-remover/enhance",
            user_id=auth_ctx["user_id"],
            form={"user_id": auth_ctx["user_id"]},
            files=[("audio_file", audio_bytes, "input.wav", "audio/wav")],
            timeout_sec=120.0,
        )

        new_balance = await _atomic_deduct(conn, auth_ctx["user_id"], credits_needed)
        if new_balance is None:
            raise HTTPException(status_code=402, detail="Insufficient credits.")
        await conn.execute(
            """
            INSERT INTO credit_transactions
            (id, user_id, transaction_type, amount, balance_after, description, reference_type, reference_id, metadata_json, created_at)
            VALUES (?, ?, 'api_noise_remover', ?, ?, ?, 'api_request', ?, ?, datetime('now'))
            """,
            (uuid.uuid4().hex, auth_ctx["user_id"], -credits_needed, new_balance,
             f"Developer API noise remover ({billed_min} min)", request_id, '{"source":"developer-api"}'),
        )
        await conn.execute(
            "UPDATE api_keys SET last_used_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
            (auth_ctx["api_key_id"],),
        )
        latency_ms = int((time.perf_counter() - started) * 1000)
        await log_api_request(
            conn, request_id=request_id, user_id=auth_ctx["user_id"],
            api_key_id=auth_ctx["api_key_id"], endpoint="/v1/audio/noise-remover",
            provider=BRAND, status="success", http_status=200,
            credits_used=credits_needed, request_chars=0, latency_ms=latency_ms,
        )
        try:
            await refresh_daily_usage_for_today(conn)
        except Exception as e:
            print(f"[developer-api] daily usage refresh failed: {e}")
        await conn.commit()
        return DubbingEnhanceResponse(
            request_id=request_id,
            audio_url=result.get("audio_url") or "",
            provider=BRAND,
            credits_remaining=new_balance,
            latency_ms=latency_ms,
            credits_used=credits_needed,
        )
    finally:
        await conn.close()


