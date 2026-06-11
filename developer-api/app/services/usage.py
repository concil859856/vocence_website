from __future__ import annotations

import math

import aiosqlite
from fastapi import HTTPException

from app.core.config import API_CREDITS_PER_1M_CHARS, API_RATE_LIMIT_ENABLED, API_RATE_LIMIT_REQUESTS_PER_MINUTE


def credits_for_chars(char_count: int) -> int:
    raw = (char_count * API_CREDITS_PER_1M_CHARS) / 1_000_000
    return max(1, int(math.ceil(raw)))


async def enforce_rate_limit(conn: aiosqlite.Connection, user_id: str, _legacy_override_rpm: int | None = None) -> None:
    """Per-ACCOUNT rate limit (Nov 2026 — was per-key).

    Counts requests across ALL of the user's API keys in a sliding
    60-second window. The effective per-minute cap is the MAX
    ``rate_limit_rpm`` across the user's keys (so any admin-bumped
    key raises the ceiling for the whole account); otherwise the
    global ``API_RATE_LIMIT_REQUESTS_PER_MINUTE`` default applies.

    Background: previously a user could trivially bypass the limit by
    spinning up additional keys, since each key had its own bucket.
    Per-account closes that loophole — the limit reflects what we
    really care about (compute cost per customer), not a per-credential
    accounting detail.

    ``_legacy_override_rpm`` is the old per-key override the caller
    used to pass; kept for signature compatibility but ignored. The
    DB lookup is the source of truth now.
    """
    if not API_RATE_LIMIT_ENABLED:
        return

    # Admin override at the USER level (Jun 2026 — for enterprise /
    # sales accounts). When set on auth_users.api_rate_limit_rpm,
    # this WINS over per-key rate_limit_rpm and the env default.
    #   * non-NULL > 0  → exact cap for the whole account
    #   * non-NULL = 0  → uncapped (skip bucket bookkeeping)
    #   * NULL          → fall through to the per-key resolution below
    user_override_row = await (
        await conn.execute(
            "SELECT api_rate_limit_rpm FROM auth_users WHERE id = ?",
            (user_id,),
        )
    ).fetchone()
    if user_override_row is not None and user_override_row["api_rate_limit_rpm"] is not None:
        override = int(user_override_row["api_rate_limit_rpm"])
        if override <= 0:
            return  # admin-granted uncapped
        rpm = override
    else:
        # Per-user exemption: any non-revoked key with rate_limit_rpm = NULL
        # opts the whole account out of the per-minute cap. Use this for
        # trusted accounts where the operator has explicitly removed the
        # limit from the DB rather than picking a numeric ceiling.
        exempt_row = await (
            await conn.execute(
                """
                SELECT 1
                FROM api_keys
                WHERE user_id = ?
                  AND revoked_at IS NULL
                  AND rate_limit_rpm IS NULL
                LIMIT 1
                """,
                (user_id,),
            )
        ).fetchone()
        if exempt_row is not None:
            return

        # Effective cap = max(rate_limit_rpm) across the user's non-revoked
        # keys, falling back to the global default when no key has an
        # explicit override. One short SELECT per call; SQLite eats it.
        cap_row = await (
            await conn.execute(
                """
                SELECT MAX(rate_limit_rpm) AS rpm
                FROM api_keys
                WHERE user_id = ?
                  AND revoked_at IS NULL
                  AND rate_limit_rpm IS NOT NULL
                """,
                (user_id,),
            )
        ).fetchone()
        rpm = int(cap_row["rpm"]) if cap_row and cap_row["rpm"] is not None else API_RATE_LIMIT_REQUESTS_PER_MINUTE

    row = await (
        await conn.execute(
            """
            SELECT COUNT(*) AS n
            FROM api_request_logs
            WHERE user_id = ?
              AND created_at >= datetime('now', '-60 seconds')
            """,
            (user_id,),
        )
    ).fetchone()
    if int(row["n"] or 0) >= rpm:
        raise HTTPException(status_code=429, detail=f"Rate limit exceeded ({rpm} req/min per account)")


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

