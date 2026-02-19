"""
PostgreSQL connection pool for Vocence owner database.
Uses same DB as Vocence API (registered_miners, performance_metrics, etc.).
"""

import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator

import asyncpg


def _build_connection_params() -> dict:
    url = os.environ.get("DATABASE_URL")
    if url:
        if url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql://", 1)
        return {"dsn": url}
    return {
        "host": os.environ.get("POSTGRES_HOST", "localhost"),
        "port": int(os.environ.get("POSTGRES_PORT", "5432")),
        "user": os.environ.get("POSTGRES_USER", "vocence"),
        "password": os.environ.get("POSTGRES_PASSWORD", "vocence"),
        "database": os.environ.get("POSTGRES_DB", "vocence"),
    }


_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        params = _build_connection_params()
        _pool = await asyncpg.create_pool(
            **params,
            min_size=1,
            max_size=10,
            command_timeout=10,
        )
    return _pool


@asynccontextmanager
async def acquire() -> AsyncGenerator[asyncpg.Connection, None]:
    pool = await get_pool()
    async with pool.acquire() as conn:
        yield conn


async def close_pool() -> None:
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None


async def health_check() -> bool:
    try:
        async with acquire() as conn:
            await conn.fetchval("SELECT 1")
        return True
    except Exception:
        return False


BLOG_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS blog_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    excerpt TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Updates',
    date TEXT NOT NULL,
    read_time TEXT NOT NULL DEFAULT '5 min read',
    image TEXT NOT NULL,
    content TEXT NOT NULL,
    featured BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


async def ensure_blog_table() -> None:
    """Create blog_posts table if it does not exist."""
    async with acquire() as conn:
        await conn.execute(BLOG_TABLE_SQL)


async def ensure_evaluations_audio_columns() -> None:
    """Add original_audio_url and generated_audio_url to validator_evaluations if missing (e.g. existing DBs)."""
    async with acquire() as conn:
        try:
            await conn.execute(
                "ALTER TABLE validator_evaluations ADD COLUMN IF NOT EXISTS original_audio_url TEXT"
            )
            await conn.execute(
                "ALTER TABLE validator_evaluations ADD COLUMN IF NOT EXISTS generated_audio_url TEXT"
            )
        except Exception:
            pass  # Table might not exist yet


LIVE_EVALUATION_PENDING_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS live_evaluation_pending (
    id SERIAL PRIMARY KEY,
    validator_hotkey VARCHAR(64) NOT NULL,
    evaluation_id VARCHAR(64) NOT NULL,
    prompt_summary VARCHAR(512),
    miner_hotkeys TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_live_eval_pending_validator ON live_evaluation_pending (validator_hotkey);
CREATE INDEX IF NOT EXISTS idx_live_eval_pending_eval ON live_evaluation_pending (evaluation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_live_eval_pending_unique ON live_evaluation_pending (validator_hotkey, evaluation_id);
"""


async def ensure_live_evaluation_pending_table() -> None:
    """Create live_evaluation_pending table if it does not exist (dashboard status bar)."""
    async with acquire() as conn:
        try:
            await conn.execute(LIVE_EVALUATION_PENDING_TABLE_SQL)
        except Exception:
            pass
