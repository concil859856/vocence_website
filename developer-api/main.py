"""
Vocence Developer API service.

Runs behind api.vocence.ai and authenticates with API keys created on
backend.vocence.ai.
"""

from __future__ import annotations

import hashlib
import math
import os
import random
import re
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

load_dotenv()

import aiosqlite

from studio_tts_service import synthesize_speak, upload_wav_to_hippius, get_presigned_url


DATA_DIR = Path(__file__).resolve().parent.parent / "dashboard-backend" / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = os.environ.get("SQLITE_PATH", str(DATA_DIR / "website.db"))

API_RATE_LIMIT_ENABLED = (os.environ.get("API_RATE_LIMIT_ENABLED", "true").strip().lower() in {"1", "true", "yes"})
API_RATE_LIMIT_REQUESTS_PER_MINUTE = int(os.environ.get("API_RATE_LIMIT_REQUESTS_PER_MINUTE", "4"))
API_CREDITS_PER_1M_CHARS = int(os.environ.get("API_CREDITS_PER_1M_CHARS", "2000"))
API_DEFAULT_MODEL_NAME = (os.environ.get("API_DEFAULT_MODEL_NAME") or "PromptTTS API").strip()
API_DEFAULT_STYLE = (os.environ.get("API_DEFAULT_STYLE_INSTRUCTION") or "neutral voice").strip()


class TtsGenerateRequest(BaseModel):
    text: str
    style_instruction: str | None = None
    model: str | None = None


class TtsGenerateResponse(BaseModel):
    request_id: str
    audio_url: str
    provider: str
    credits_remaining: int
    latency_ms: int
    credits_used: int
    request_chars: int


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


async def _db() -> aiosqlite.Connection:
    conn = await aiosqlite.connect(DB_PATH)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys = ON")
    return conn


async def _refresh_daily_usage_for_day(conn: aiosqlite.Connection, day: str) -> None:
    """
    Keep `daily_usage_stats` (used by the admin web-usage credits graph) up-to-date
    for Developer API credit consumption.
    """
    gen_row = await (await conn.execute(
            """
            SELECT COUNT(*) AS generation_count,
                   COUNT(DISTINCT user_id) AS unique_users
            FROM studio_tts_history
            WHERE date(created_at) = date(?)
              AND status = 'completed'
            """,
            (day,),
        )).fetchone()

    pay_row = await (await conn.execute(
            """
            SELECT COALESCE(SUM(amount_usd), 0) AS revenue_usd,
                   COALESCE(SUM(credits_granted), 0) AS credits_purchased
            FROM payments
            WHERE date(created_at) = date(?)
              AND status IN ('paid', 'completed')
            """,
            (day,),
        )).fetchone()

    credit_row = await (await conn.execute(
            """
            SELECT COALESCE(SUM(-amount), 0) AS credits_used
            FROM credit_transactions
            WHERE date(created_at) = date(?)
              AND amount < 0
            """,
            (day,),
        )).fetchone()

    await conn.execute(
            """
            INSERT INTO daily_usage_stats
            (day, tts_generation_count, unique_users, credits_used, revenue_usd, credits_purchased, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(day) DO UPDATE SET
                tts_generation_count = excluded.tts_generation_count,
                unique_users = excluded.unique_users,
                credits_used = excluded.credits_used,
                revenue_usd = excluded.revenue_usd,
                credits_purchased = excluded.credits_purchased,
                updated_at = datetime('now')
            """,
            (
                day,
                int(gen_row["generation_count"] or 0),
                int(gen_row["unique_users"] or 0),
                int(credit_row["credits_used"] or 0),
                float(pay_row["revenue_usd"] or 0),
                int(pay_row["credits_purchased"] or 0),
            ),
        )


def _hash_api_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _api_tts_env_prefix() -> str:
    """Prefer API_TTS_PROVIDER_* so API chutes stay separate from STUDIO_MODEL_*."""
    name_pat = re.compile(r"^API_TTS_PROVIDER_\d+_NAME$")
    for key in os.environ:
        if name_pat.match(key):
            return "API_TTS_PROVIDER"
    return "TTS_PROVIDER"


def _select_api_provider(model: str | None) -> tuple[str, str]:
    """
    Pick an API TTS chute via weighted random over all matching providers.

    Same code path for one or many chutes: a single enabled row always wins;
    when you add more rows (same or different NAME per `model`), traffic splits
    by WEIGHT. Studio env is never used here.
    """
    prefix = _api_tts_env_prefix()
    idx_pat = re.compile(rf"^{prefix}_(\d+)_NAME$")
    indices: list[int] = []
    for key in os.environ:
        m = idx_pat.match(key)
        if m:
            indices.append(int(m.group(1)))

    model_norm = (model or "").strip().lower()
    candidates: list[tuple[str, str, int]] = []
    for idx in sorted(set(indices)):
        enabled = (
            os.environ.get(f"{prefix}_{idx}_ENABLED", "true").strip().lower()
            in {"1", "true", "yes"}
        )
        name = (os.environ.get(f"{prefix}_{idx}_NAME") or "").strip()
        slug = (os.environ.get(f"{prefix}_{idx}_CHUTE_SLUG") or "").strip()
        if not enabled or not name or not slug:
            continue
        try:
            weight = int((os.environ.get(f"{prefix}_{idx}_WEIGHT") or "1").strip() or "1")
        except ValueError:
            weight = 1
        if weight < 1:
            weight = 1
        if not model_norm or model_norm == name.lower():
            candidates.append((name, slug, weight))

    if not candidates:
        raise HTTPException(
            status_code=503,
            detail="No API TTS provider configured (set API_TTS_PROVIDER_<N>_NAME and CHUTE_SLUG on developer-api)",
        )

    weights = [c[2] for c in candidates]
    chosen = random.choices(candidates, weights=weights, k=1)[0]
    return chosen[0], chosen[1]


async def require_api_key(authorization: str | None = Header(None, alias="Authorization")) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing API key")
    raw_key = authorization.split(" ", 1)[1].strip()
    if not raw_key:
        raise HTTPException(status_code=401, detail="Missing API key")
    prefix = raw_key[:16]
    conn = await _db()
    try:
        row = await (await conn.execute("SELECT * FROM api_keys WHERE key_prefix = ?", (prefix,))).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="Invalid API key")
        if row["revoked_at"]:
            raise HTTPException(status_code=403, detail="API key has been revoked")
        if _hash_api_key(raw_key) != row["key_hash"]:
            raise HTTPException(status_code=401, detail="Invalid API key")
        user = await (await conn.execute("SELECT id, credits FROM auth_users WHERE id = ?", (row["user_id"],))).fetchone()
        if user is None:
            raise HTTPException(status_code=401, detail="User not found for API key")
        return {
            "api_key_id": row["id"],
            "user_id": row["user_id"],
            "tier": row["tier"] or "normal",
            "rate_limit_rpm": int(row["rate_limit_rpm"]) if row["rate_limit_rpm"] is not None else None,
            "credits": int(user["credits"] or 0),
        }
    finally:
        await conn.close()


async def _enforce_rate_limit(conn: aiosqlite.Connection, api_key_id: str, tier: str, override_rpm: int | None) -> None:
    if not API_RATE_LIMIT_ENABLED:
        return
    rpm = override_rpm if override_rpm is not None else API_RATE_LIMIT_REQUESTS_PER_MINUTE
    row = await (
        await conn.execute(
            """
            SELECT COUNT(*) AS n
            FROM api_request_logs
            WHERE api_key_id = ?
              AND created_at >= datetime('now', '-60 seconds')
            """,
            (api_key_id,),
        )
    ).fetchone()
    if int(row["n"] or 0) >= rpm:
        raise HTTPException(status_code=429, detail=f"Rate limit exceeded ({rpm} req/min)")


def _credits_for_chars(char_count: int) -> int:
    raw = (char_count * API_CREDITS_PER_1M_CHARS) / 1_000_000
    return max(1, int(math.ceil(raw)))


async def _log_api_request(
    conn: aiosqlite.Connection,
    *,
    request_id: str,
    user_id: str,
    api_key_id: str,
    endpoint: str,
    provider: str | None,
    status: str,
    http_status: int,
    credits_used: int,
    request_chars: int,
    latency_ms: int | None,
    error_code: str | None = None,
    error_message: str | None = None,
) -> None:
    await conn.execute(
        """
        INSERT INTO api_request_logs
        (id, user_id, api_key_id, endpoint, provider, status, http_status, credits_used,
         request_chars, latency_ms, error_code, error_message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        """,
        (
            request_id,
            user_id,
            api_key_id,
            endpoint,
            provider,
            status,
            http_status,
            credits_used,
            request_chars,
            latency_ms,
            error_code,
            error_message,
        ),
    )


app = FastAPI(title="Vocence Developer API", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "vocence-developer-api"}


@app.post("/v1/tts/generate", response_model=TtsGenerateResponse)
async def tts_generate(body: TtsGenerateRequest, auth_ctx: dict = Depends(require_api_key)):
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    provider_name, chute_slug = _select_api_provider(body.model)
    style_instruction = (body.style_instruction or API_DEFAULT_STYLE).strip() or API_DEFAULT_STYLE
    char_count = len(text) + len(style_instruction)
    credits_needed = _credits_for_chars(char_count)
    started = time.perf_counter()
    request_id = uuid.uuid4().hex

    conn = await _db()
    try:
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
                (auth_ctx["user_id"],),
            )
        ).fetchone()
        if int(paid_row["n"] or 0) <= 0:
            raise HTTPException(status_code=402, detail="Developer API requires a successful Premium plan purchase first.")
        await _enforce_rate_limit(conn, auth_ctx["api_key_id"], auth_ctx["tier"], auth_ctx["rate_limit_rpm"])
        user_row = await (await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (auth_ctx["user_id"],))).fetchone()
        if user_row is None:
            raise HTTPException(status_code=404, detail="User not found")
        credits_before = int(user_row["credits"] or 0)
        if credits_before < credits_needed:
            await _log_api_request(
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
            await _log_api_request(
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
        await _log_api_request(
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
        # Update admin web-usage credits graph for today's date.
        today_iso = datetime.now(timezone.utc).date().isoformat()
        try:
            # Best-effort: if this fails, TTS generation should still succeed.
            await _refresh_daily_usage_for_day(conn, today_iso)
        except Exception as e:
            # Avoid failing the API response; but make the issue visible in logs.
            print(f"[developer-api] daily usage refresh failed for day={today_iso}: {e}")

        # Ensure the rollup is written after all writes are committed.
        try:
            await conn.commit()
            conn2 = await _db()
            try:
                await _refresh_daily_usage_for_day(conn2, today_iso)
                await conn2.commit()
            finally:
                await conn2.close()
        except Exception as e:
            print(f"[developer-api] daily usage refresh (post-commit) failed for day={today_iso}: {e}")
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


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=int(os.environ.get("PORT", "8063")),
        reload=os.environ.get("RELOAD", "").lower() == "true",
    )
