from __future__ import annotations

import math

import aiosqlite
from fastapi import HTTPException

from app.core.config import API_CREDITS_PER_1M_CHARS, API_RATE_LIMIT_ENABLED, API_RATE_LIMIT_REQUESTS_PER_MINUTE


def credits_for_chars(char_count: int) -> int:
    raw = (char_count * API_CREDITS_PER_1M_CHARS) / 1_000_000
    return max(1, int(math.ceil(raw)))


async def enforce_rate_limit(conn: aiosqlite.Connection, api_key_id: str, override_rpm: int | None) -> None:
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


async def log_api_request(
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

