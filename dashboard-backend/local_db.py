"""
Local SQLite database for website-only data (registered users, etc.).
Not used for validator/owner Postgres — that stays read-only for dashboard display
and write only for blocklist/validator registry (admin).
"""

import os
from pathlib import Path

import aiosqlite

# Default: data/website.db next to dashboard-backend
DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = os.environ.get("SQLITE_PATH", str(DATA_DIR / "website.db"))

REGISTERED_USERS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS registered_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    picture TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

# Auth (login, credits, history) — merged from backend-example
AUTH_USERS_TABLE_SQL = """
CREATE TABLE IF NOT EXISTS auth_users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    picture TEXT,
    credits INTEGER NOT NULL DEFAULT 100,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""

AUTH_HISTORY_TABLE_SQL = """
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
    FOREIGN KEY (user_id) REFERENCES auth_users(id)
);
"""


async def get_connection() -> aiosqlite.Connection:
    conn = await aiosqlite.connect(DB_PATH)
    conn.row_factory = aiosqlite.Row
    return conn


async def ensure_tables() -> None:
    conn = await get_connection()
    try:
        await conn.execute(REGISTERED_USERS_TABLE_SQL)
        await conn.execute(AUTH_USERS_TABLE_SQL)
        await conn.execute(AUTH_HISTORY_TABLE_SQL)
        await conn.commit()
    finally:
        await conn.close()
