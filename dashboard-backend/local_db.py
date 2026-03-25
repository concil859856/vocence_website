"""
Local SQLite database for website-only data.

Owner / subnet state stays in PostgreSQL. Product and website data such as
users, plans, credits, blog posts, studio history, and payments live here.
"""

import json
import os
import uuid
import hashlib
import secrets
from pathlib import Path
from typing import Any

import aiosqlite
import asyncpg

# Default: data/website.db next to dashboard-backend
DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = os.environ.get("SQLITE_PATH", str(DATA_DIR / "website.db"))


async def get_connection() -> aiosqlite.Connection:
    conn = await aiosqlite.connect(DB_PATH)
    conn.row_factory = aiosqlite.Row
    await conn.execute("PRAGMA foreign_keys = ON")
    return conn


SCHEMA_SQL = [
    """
    CREATE TABLE IF NOT EXISTS registered_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL DEFAULT '',
        picture TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS auth_users (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        picture TEXT,
        credits INTEGER NOT NULL DEFAULT 50,
        plan_code TEXT NOT NULL DEFAULT 'normal',
        plan_status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_login_at TEXT
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS auth_history (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT,
        style_prompt TEXT,
        model TEXT,
        meta TEXT,
        duration TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS pricing_plans (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        price_usd REAL,
        billing_type TEXT NOT NULL,
        credits_included INTEGER NOT NULL DEFAULT 0,
        credits_per_pack INTEGER,
        price_subtitle TEXT,
        description TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_highlighted INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        features_json TEXT NOT NULL DEFAULT '[]',
        cta_label TEXT NOT NULL DEFAULT 'Select plan',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS credit_transactions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        transaction_type TEXT NOT NULL,
        amount INTEGER NOT NULL,
        balance_after INTEGER NOT NULL,
        description TEXT,
        reference_type TEXT,
        reference_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS blog_posts (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        excerpt TEXT NOT NULL,
        category TEXT NOT NULL DEFAULT 'Updates',
        date TEXT NOT NULL,
        read_time TEXT NOT NULL DEFAULT '5 min read',
        image TEXT NOT NULL,
        content TEXT NOT NULL,
        featured INTEGER NOT NULL DEFAULT 0,
        is_published INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS studio_tts_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        miner_hotkey TEXT NOT NULL,
        model_name TEXT NOT NULL,
        prompt_text TEXT NOT NULL,
        style_instruction TEXT NOT NULL DEFAULT 'neutral voice',
        audio_s3_bucket TEXT NOT NULL,
        audio_s3_key TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        credits_used INTEGER NOT NULL DEFAULT 10,
        latency_ms INTEGER,
        status TEXT NOT NULL DEFAULT 'completed',
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS payment_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        plan_code TEXT,
        mode TEXT,
        credits_requested INTEGER NOT NULL DEFAULT 0,
        amount_usd REAL NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'pending',
        checkout_url TEXT,
        reference TEXT,
        stripe_checkout_session_id TEXT,
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        expires_at TEXT,
        completed_at TEXT,
        canceled_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        plan_code TEXT,
        amount_usd REAL NOT NULL DEFAULT 0,
        credits_granted INTEGER NOT NULL DEFAULT 0,
        currency TEXT NOT NULL DEFAULT 'USD',
        status TEXT NOT NULL DEFAULT 'pending',
        provider_payment_id TEXT,
        stripe_checkout_session_id TEXT,
        stripe_payment_intent_id TEXT,
        stripe_invoice_id TEXT,
        stripe_subscription_id TEXT,
        stripe_customer_id TEXT,
        stripe_event_id TEXT,
        mode TEXT,
        wallet_address TEXT,
        billing_period_start TEXT,
        billing_period_end TEXT,
        credits_applied_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE,
        FOREIGN KEY (session_id) REFERENCES payment_sessions(id) ON DELETE SET NULL
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS stripe_webhook_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        object_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS daily_usage_stats (
        day TEXT PRIMARY KEY,
        tts_generation_count INTEGER NOT NULL DEFAULT 0,
        unique_users INTEGER NOT NULL DEFAULT 0,
        credits_used INTEGER NOT NULL DEFAULT 0,
        revenue_usd REAL NOT NULL DEFAULT 0,
        credits_purchased INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS admin_audit_log (
        id TEXT PRIMARY KEY,
        admin_email TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        tier TEXT NOT NULL DEFAULT 'normal',
        rate_limit_rpm INTEGER,
        last_used_at TEXT,
        revoked_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS api_request_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        api_key_id TEXT NOT NULL,
        endpoint TEXT NOT NULL,
        provider TEXT,
        status TEXT NOT NULL,
        http_status INTEGER NOT NULL,
        credits_used INTEGER NOT NULL DEFAULT 0,
        request_chars INTEGER,
        latency_ms INTEGER,
        error_code TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (user_id) REFERENCES auth_users(id) ON DELETE CASCADE,
        FOREIGN KEY (api_key_id) REFERENCES api_keys(id) ON DELETE CASCADE
    )
    """,
]


INDEX_SQL = [
    "CREATE INDEX IF NOT EXISTS idx_auth_users_email ON auth_users (email)",
    "CREATE INDEX IF NOT EXISTS idx_credit_transactions_user_id ON credit_transactions (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_auth_history_user_id ON auth_history (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_blog_posts_created_at ON blog_posts (created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_studio_tts_history_user_id ON studio_tts_history (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_payment_sessions_user_id ON payment_sessions (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_payments_user_id ON payments (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_payment_sessions_stripe_checkout ON payment_sessions (stripe_checkout_session_id)",
    "CREATE INDEX IF NOT EXISTS idx_payment_sessions_stripe_subscription ON payment_sessions (stripe_subscription_id)",
    "CREATE INDEX IF NOT EXISTS idx_payments_stripe_invoice ON payments (stripe_invoice_id)",
    "CREATE INDEX IF NOT EXISTS idx_payments_stripe_subscription ON payments (stripe_subscription_id)",
    "CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys (user_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys (key_prefix)",
    "CREATE INDEX IF NOT EXISTS idx_api_request_logs_key_time ON api_request_logs (api_key_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_api_request_logs_user_time ON api_request_logs (user_id, created_at DESC)",
]


PLAN_SEEDS = [
    {
        "code": "normal",
        "name": "Normal",
        "price_usd": 12.0,
        "billing_type": "credits",
        "credits_included": 4000,
        "credits_per_pack": 4000,
        "price_subtitle": "one-time pack",
        "description": "Flexible starter credits for personal use.",
        "sort_order": 1,
        "is_highlighted": 0,
        "features_json": json.dumps(
            [
                "50 free credits when you register",
                "Can experiment with custom voices you describe",
                "Best for light usage and personal projects",
                "A simple way to explore prompt-controlled voice generation",
            ]
        ),
        "cta_label": "Buy credits",
        "crypto_price_usd": 20.0,
        "crypto_credits_included": 7000,
    },
    {
        "code": "premium",
        "name": "Premium",
        "price_usd": 24.0,
        "billing_type": "credits",
        "credits_included": 10000,
        "credits_per_pack": 10000,
        "price_subtitle": "one-time pack",
        "description": "High-volume credit pack for active creators.",
        "sort_order": 2,
        "is_highlighted": 1,
        "features_json": json.dumps(
            [
                "Best value for heavy Text-to-Speech usage",
                "Larger one-time balance for uninterrupted generation",
                "Ideal for teams, creators, and production workflows",
                "Required plan to unlock Developer API access",
            ]
        ),
        "cta_label": "Buy Premium Pack",
        "crypto_price_usd": 40.0,
        "crypto_credits_included": 16000,
    },
    {
        "code": "enterprise",
        "name": "Enterprise",
        "price_usd": None,
        "billing_type": "custom",
        "credits_included": 0,
        "credits_per_pack": None,
        "price_subtitle": "volume pricing",
        "description": "Custom commercial support and API access.",
        "sort_order": 3,
        "is_highlighted": 0,
        "features_json": json.dumps(
            [
                "Full API support for product and platform integration",
                "Dedicated onboarding and commercial support",
                "Private quotas and operational flexibility",
                "Built for teams, apps, and larger-scale deployment",
            ]
        ),
        "cta_label": "Talk to Sales",
    },
]


async def _ensure_column(conn: aiosqlite.Connection, table: str, column: str, ddl: str) -> None:
    cursor = await conn.execute(f"PRAGMA table_info({table})")
    rows = await cursor.fetchall()
    existing = {row["name"] for row in rows}
    if column not in existing:
        await conn.execute(f"ALTER TABLE {table} ADD COLUMN {ddl}")


async def seed_pricing_plans(conn: aiosqlite.Connection) -> None:
    for plan in PLAN_SEEDS:
        await conn.execute(
            """
            INSERT INTO pricing_plans
            (code, name, price_usd, billing_type, credits_included, credits_per_pack, price_subtitle,
             description, sort_order, is_highlighted, is_active, features_json, cta_label,
             crypto_price_usd, crypto_credits_included, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(code) DO UPDATE SET
                name = excluded.name,
                price_usd = excluded.price_usd,
                billing_type = excluded.billing_type,
                credits_included = excluded.credits_included,
                credits_per_pack = excluded.credits_per_pack,
                price_subtitle = excluded.price_subtitle,
                description = excluded.description,
                sort_order = excluded.sort_order,
                is_highlighted = excluded.is_highlighted,
                features_json = excluded.features_json,
                cta_label = excluded.cta_label,
                crypto_price_usd = excluded.crypto_price_usd,
                crypto_credits_included = excluded.crypto_credits_included,
                updated_at = datetime('now')
            """,
            (
                plan["code"],
                plan["name"],
                plan["price_usd"],
                plan["billing_type"],
                plan["credits_included"],
                plan["credits_per_pack"],
                plan["price_subtitle"],
                plan["description"],
                plan["sort_order"],
                plan["is_highlighted"],
                plan["features_json"],
                plan["cta_label"],
                plan.get("crypto_price_usd"),
                plan.get("crypto_credits_included"),
            ),
        )


async def ensure_tables() -> None:
    conn = await get_connection()
    try:
        for statement in SCHEMA_SQL:
            await conn.execute(statement)

        await _ensure_column(conn, "auth_users", "plan_code", "plan_code TEXT")
        await _ensure_column(conn, "auth_users", "plan_status", "plan_status TEXT")
        await _ensure_column(conn, "auth_users", "updated_at", "updated_at TEXT")
        await _ensure_column(conn, "auth_users", "last_login_at", "last_login_at TEXT")
        await conn.execute("UPDATE auth_users SET plan_code = COALESCE(plan_code, 'normal')")
        await conn.execute("UPDATE auth_users SET plan_status = COALESCE(plan_status, 'active')")
        await conn.execute("UPDATE auth_users SET updated_at = COALESCE(updated_at, created_at, datetime('now'))")
        await _ensure_column(conn, "pricing_plans", "crypto_price_usd", "crypto_price_usd REAL")
        await _ensure_column(conn, "pricing_plans", "crypto_credits_included", "crypto_credits_included INTEGER")
        await _ensure_column(conn, "payment_sessions", "mode", "mode TEXT")
        await _ensure_column(conn, "payment_sessions", "stripe_checkout_session_id", "stripe_checkout_session_id TEXT")
        await _ensure_column(conn, "payment_sessions", "stripe_customer_id", "stripe_customer_id TEXT")
        await _ensure_column(conn, "payment_sessions", "stripe_subscription_id", "stripe_subscription_id TEXT")
        await _ensure_column(conn, "payment_sessions", "completed_at", "completed_at TEXT")
        await _ensure_column(conn, "payment_sessions", "canceled_at", "canceled_at TEXT")
        await _ensure_column(conn, "payments", "stripe_checkout_session_id", "stripe_checkout_session_id TEXT")
        await _ensure_column(conn, "payments", "stripe_payment_intent_id", "stripe_payment_intent_id TEXT")
        await _ensure_column(conn, "payments", "stripe_invoice_id", "stripe_invoice_id TEXT")
        await _ensure_column(conn, "payments", "stripe_subscription_id", "stripe_subscription_id TEXT")
        await _ensure_column(conn, "payments", "stripe_customer_id", "stripe_customer_id TEXT")
        await _ensure_column(conn, "payments", "stripe_event_id", "stripe_event_id TEXT")
        await _ensure_column(conn, "payments", "mode", "mode TEXT")
        await _ensure_column(conn, "payments", "billing_period_start", "billing_period_start TEXT")
        await _ensure_column(conn, "payments", "billing_period_end", "billing_period_end TEXT")
        await _ensure_column(conn, "payments", "credits_applied_at", "credits_applied_at TEXT")
        await _ensure_column(conn, "api_keys", "tier", "tier TEXT")
        await _ensure_column(conn, "api_keys", "rate_limit_rpm", "rate_limit_rpm INTEGER")

        for statement in INDEX_SQL:
            await conn.execute(statement)

        await seed_pricing_plans(conn)
        await conn.commit()
    finally:
        await conn.close()


def hash_api_key(raw_key: str) -> str:
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def generate_api_key() -> tuple[str, str]:
    """
    Generate API key in format voc_live_<token>.
    Returns (plain_key, prefix).
    """
    token = secrets.token_urlsafe(32).replace("-", "").replace("_", "")
    plain = f"voc_live_{token}"
    return plain, plain[:16]


async def record_credit_transaction(
    conn: aiosqlite.Connection,
    *,
    user_id: str,
    transaction_type: str,
    amount: int,
    balance_after: int,
    description: str,
    reference_type: str | None = None,
    reference_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> str:
    transaction_id = uuid.uuid4().hex
    await conn.execute(
        """
        INSERT INTO credit_transactions
        (id, user_id, transaction_type, amount, balance_after, description, reference_type, reference_id, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        """,
        (
            transaction_id,
            user_id,
            transaction_type,
            amount,
            balance_after,
            description,
            reference_type,
            reference_id,
            json.dumps(metadata or {}),
        ),
    )
    return transaction_id


async def refresh_daily_usage_for_day(conn: aiosqlite.Connection, day: str) -> None:
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


async def log_admin_action(
    conn: aiosqlite.Connection,
    *,
    admin_email: str,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    await conn.execute(
        """
        INSERT INTO admin_audit_log (id, admin_email, action, target_type, target_id, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
        """,
        (
            uuid.uuid4().hex,
            admin_email,
            action,
            target_type,
            target_id,
            json.dumps(metadata or {}),
        ),
    )


async def migrate_legacy_website_data(pg_conn: asyncpg.Connection) -> None:
    """
    Best-effort migration of website-owned legacy tables from PostgreSQL into
    website.db. Safe to run repeatedly.
    """
    conn = await get_connection()
    try:
        blog_count = await (await conn.execute("SELECT COUNT(*) AS n FROM blog_posts")).fetchone()
        if int(blog_count["n"] or 0) == 0:
            try:
                blog_rows = await pg_conn.fetch(
                    """
                    SELECT id, title, excerpt, category, date, read_time, image, content, featured, created_at
                    FROM blog_posts
                    ORDER BY created_at ASC
                    """
                )
            except Exception:
                blog_rows = []
            for row in blog_rows:
                await conn.execute(
                    """
                    INSERT OR IGNORE INTO blog_posts
                    (id, title, excerpt, category, date, read_time, image, content, featured, is_published, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                    """,
                    (
                        str(row["id"]),
                        row["title"],
                        row["excerpt"],
                        row["category"],
                        row["date"],
                        row["read_time"] or "5 min read",
                        row["image"],
                        row["content"],
                        int(bool(row["featured"])),
                        row["created_at"].isoformat() if row["created_at"] else None,
                        row["created_at"].isoformat() if row["created_at"] else None,
                    ),
                )

        studio_count = await (await conn.execute("SELECT COUNT(*) AS n FROM studio_tts_history")).fetchone()
        if int(studio_count["n"] or 0) == 0:
            try:
                studio_rows = await pg_conn.fetch(
                    """
                    SELECT id, user_id, miner_hotkey, model_name, prompt_text, style_instruction,
                           audio_s3_bucket, audio_s3_key, expires_at, created_at
                    FROM studio_tts_history
                    ORDER BY created_at ASC
                    """
                )
            except Exception:
                studio_rows = []
            for row in studio_rows:
                await conn.execute(
                    """
                    INSERT OR IGNORE INTO studio_tts_history
                    (id, user_id, miner_hotkey, model_name, prompt_text, style_instruction,
                     audio_s3_bucket, audio_s3_key, expires_at, credits_used, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 10, 'completed', ?)
                    """,
                    (
                        int(row["id"]),
                        row["user_id"],
                        row["miner_hotkey"],
                        row["model_name"],
                        row["prompt_text"],
                        row["style_instruction"] or "neutral voice",
                        row["audio_s3_bucket"],
                        row["audio_s3_key"],
                        row["expires_at"].isoformat() if row["expires_at"] else None,
                        row["created_at"].isoformat() if row["created_at"] else None,
                    ),
                )
        await conn.commit()
    finally:
        await conn.close()
