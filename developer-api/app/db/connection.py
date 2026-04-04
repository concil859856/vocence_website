from __future__ import annotations

from datetime import datetime, timezone

import aiosqlite

from app.core.config import DB_PATH


async def get_db() -> aiosqlite.Connection:
    conn = await aiosqlite.connect(DB_PATH)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys = ON")
    return conn


async def refresh_daily_usage_for_today(conn: aiosqlite.Connection) -> None:
    day = datetime.now(timezone.utc).date().isoformat()
    gen_row = await (
        await conn.execute(
            """
            SELECT COUNT(*) AS generation_count,
                   COUNT(DISTINCT user_id) AS unique_users
            FROM studio_tts_history
            WHERE date(created_at) = date(?)
              AND status = 'completed'
            """,
            (day,),
        )
    ).fetchone()
    pay_row = await (
        await conn.execute(
            """
            SELECT COALESCE(SUM(amount_usd), 0) AS revenue_usd,
                   COALESCE(SUM(credits_granted), 0) AS credits_purchased
            FROM payments
            WHERE date(created_at) = date(?)
              AND status IN ('paid', 'completed')
            """,
            (day,),
        )
    ).fetchone()
    credit_row = await (
        await conn.execute(
            """
            SELECT COALESCE(SUM(-amount), 0) AS credits_used
            FROM credit_transactions
            WHERE date(created_at) = date(?)
              AND amount < 0
            """,
            (day,),
        )
    ).fetchone()
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

