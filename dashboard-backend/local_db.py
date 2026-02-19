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


async def get_connection() -> aiosqlite.Connection:
    conn = await aiosqlite.connect(DB_PATH)
    conn.row_factory = aiosqlite.Row
    return conn


async def ensure_tables() -> None:
    conn = await get_connection()
    try:
        await conn.execute(REGISTERED_USERS_TABLE_SQL)
        await conn.commit()
    finally:
        await conn.close()
