"""
PostgreSQL connection pool for Vocence owner database.
Uses same DB as Vocence API (registered_miners, validator_evaluations,
validator_registry, global_scoring_snapshots, graph_activity_leases,
live_evaluation_pending, blocked_entities).
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
        "password": os.environ.get("POSTGRES_PASSWORD", ""),
        "database": os.environ.get("POSTGRES_DB", "vocence"),
    }


_pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    global _pool
    if _pool is None:
        params = _build_connection_params()
        _pool = await asyncpg.create_pool(
            **params,
            min_size=2,
            max_size=int(os.environ.get("POSTGRES_POOL_MAX_SIZE", "25")),
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


GLOBAL_SCORING_SNAPSHOTS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS global_scoring_snapshots (
    id SERIAL PRIMARY KEY,
    snapshot_hash VARCHAR(64) NOT NULL,
    winner_hotkey VARCHAR(64),
    is_latest BOOLEAN NOT NULL DEFAULT TRUE,
    snapshot_data TEXT NOT NULL,
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_global_scoring_snapshots_latest ON global_scoring_snapshots (is_latest);
CREATE INDEX IF NOT EXISTS idx_global_scoring_snapshots_generated_at ON global_scoring_snapshots (generated_at);
"""


async def ensure_global_scoring_snapshots_table() -> None:
    """Create global_scoring_snapshots table if it does not exist."""
    async with acquire() as conn:
        try:
            await conn.execute(GLOBAL_SCORING_SNAPSHOTS_TABLE_SQL)
        except Exception:
            pass


REGISTERED_MINERS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS registered_miners (
    id SERIAL PRIMARY KEY,
    uid INTEGER,
    miner_hotkey VARCHAR(64) NOT NULL,
    block INTEGER,
    model_name TEXT,
    model_revision TEXT,
    chute_id TEXT,
    chute_slug TEXT,
    is_valid BOOLEAN NOT NULL DEFAULT FALSE,
    invalid_reason TEXT,
    last_validated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_registered_miners_hotkey ON registered_miners (miner_hotkey);
CREATE INDEX IF NOT EXISTS idx_registered_miners_uid ON registered_miners (uid);
CREATE INDEX IF NOT EXISTS idx_registered_miners_is_valid ON registered_miners (is_valid);
"""

VALIDATOR_REGISTRY_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS validator_registry (
    uid INTEGER PRIMARY KEY,
    hotkey VARCHAR(64) NOT NULL UNIQUE,
    stake DOUBLE PRECISION DEFAULT 0,
    s3_bucket TEXT,
    last_seen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""

VALIDATOR_EVALUATIONS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS validator_evaluations (
    id SERIAL PRIMARY KEY,
    validator_hotkey VARCHAR(64) NOT NULL,
    evaluation_id VARCHAR(64) NOT NULL,
    miner_hotkey VARCHAR(64) NOT NULL,
    wins BOOLEAN NOT NULL DEFAULT FALSE,
    evaluated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    prompt TEXT,
    reasoning TEXT,
    original_audio_url TEXT,
    generated_audio_url TEXT,
    score DOUBLE PRECISION,
    element_scores TEXT
);
CREATE INDEX IF NOT EXISTS idx_validator_evaluations_validator ON validator_evaluations (validator_hotkey);
CREATE INDEX IF NOT EXISTS idx_validator_evaluations_miner ON validator_evaluations (miner_hotkey);
CREATE INDEX IF NOT EXISTS idx_validator_evaluations_eval_id ON validator_evaluations (evaluation_id);
CREATE INDEX IF NOT EXISTS idx_validator_evaluations_evaluated_at ON validator_evaluations (evaluated_at);
"""

BLOCKED_ENTITIES_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS blocked_entities (
    hotkey VARCHAR(64) PRIMARY KEY,
    reason TEXT,
    added_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
"""


async def ensure_core_tables() -> None:
    """Create the core subnet tables if they don't exist yet."""
    async with acquire() as conn:
        try:
            await conn.execute(REGISTERED_MINERS_TABLE_SQL)
        except Exception:
            pass
        try:
            await conn.execute(VALIDATOR_REGISTRY_TABLE_SQL)
        except Exception:
            pass
        try:
            await conn.execute(VALIDATOR_EVALUATIONS_TABLE_SQL)
        except Exception:
            pass
        try:
            await conn.execute(BLOCKED_ENTITIES_TABLE_SQL)
        except Exception:
            pass


GRAPH_ACTIVITY_LEASES_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS graph_activity_leases (
    id SERIAL PRIMARY KEY,
    activity_type VARCHAR(64) NOT NULL,
    activity_key VARCHAR(255) NOT NULL UNIQUE,
    validator_hotkey VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'active',
    payload_json TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_graph_activity_leases_status ON graph_activity_leases (status);
CREATE INDEX IF NOT EXISTS idx_graph_activity_leases_expires_at ON graph_activity_leases (expires_at);
CREATE INDEX IF NOT EXISTS idx_graph_activity_leases_validator ON graph_activity_leases (validator_hotkey);
"""


async def ensure_graph_activity_leases_table() -> None:
    """Create graph_activity_leases table if it does not exist."""
    async with acquire() as conn:
        try:
            await conn.execute(GRAPH_ACTIVITY_LEASES_TABLE_SQL)
        except Exception:
            pass
