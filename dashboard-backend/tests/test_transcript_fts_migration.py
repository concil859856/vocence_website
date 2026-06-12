"""Reproduce the user's broken FTS state end-to-end and verify the
migration recovers it.

The user's last failing log showed:
    ensure_tables: rebuilding studio_voicechat_history_fts (stale: fts=0 src=885)
    ensure_tables: transcript-fts backfill failed (non-fatal)
    sqlite3.OperationalError: no such table: studio_voicechat_history_fts

Translation: the previous-build's FTS table existed in sqlite_master,
was empty, the migration dropped it, then SCHEMA_SQL's CREATE
VIRTUAL TABLE IF NOT EXISTS silently no-op'd in the same implicit
transaction, then backfill couldn't find the table.

This test recreates that state on a temp DB (source has rows, FTS
has 0) and exercises ``_ensure_transcript_fts`` to confirm the
4-transaction split actually recovers the index and a MATCH
returns the expected hits.
"""

from __future__ import annotations

import aiosqlite
import pytest

import local_db


SOURCE_DDL = """
CREATE TABLE IF NOT EXISTS studio_voicechat_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    mode TEXT NOT NULL,
    user_text TEXT,
    bot_text TEXT,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    ttft_ms INTEGER NOT NULL DEFAULT 0,
    ttfa_ms INTEGER,
    error TEXT,
    status TEXT NOT NULL DEFAULT 'completed',
    session_id TEXT,
    agent_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
)
"""

# What 2fdb2da actually created. We pre-create this so the
# migration sees the broken layout the user had.
BROKEN_EXTERNAL_CONTENT_FTS_DDL = """
CREATE VIRTUAL TABLE studio_voicechat_history_fts
USING fts5(
    user_text,
    bot_text,
    agent_id UNINDEXED,
    session_id UNINDEXED,
    content='studio_voicechat_history',
    content_rowid='id',
    tokenize='porter unicode61'
)
"""


# Mimics the user's transcript verbatim — "love" / "chutes" /
# "websearch" all appear so the same queries that failed in
# production are exercised here.
SAMPLE_ROWS = [
    ("user_x", "voice", "today i will go to you",
     "I'm so excited, love. Let me know when you're on your way.",
     "agent_X", "vc-test-001"),
    ("user_x", "voice", "do you know what's bittensor?",
     "Yeah, Bittensor's a decentralized network for AI models.",
     "agent_X", "vc-test-001"),
    ("user_x", "voice", "what's the chutes subnet uid?",
     "I'm not finding that subnet UID, love.",
     "agent_X", "vc-test-001"),
    ("user_x", "voice", "websearch",
     "love—what should I look up for you?",
     "agent_X", "vc-test-001"),
    ("user_x", "voice", "chutes subnet uid",
     "Chutes runs as subnet 64 on the Bittensor network.",
     "agent_X", "vc-test-001"),
]


@pytest.mark.asyncio
async def test_migration_recovers_broken_external_content_state(tmp_path):
    """User's failure mode: old external-content FTS shape + empty
    index + populated source. Migration must drop, recreate, and
    backfill — and search MATCH must find the seeded terms."""
    db_path = str(tmp_path / "website.db")
    conn = await aiosqlite.connect(db_path)
    conn.row_factory = aiosqlite.Row
    try:
        # 1) Pre-seed the broken state the user had on production.
        await conn.execute(SOURCE_DDL)
        await conn.execute(BROKEN_EXTERNAL_CONTENT_FTS_DDL)
        await conn.commit()

        # 2) Insert source rows. Commit before the migration so
        #    they exist on disk when its COUNT(*) runs.
        for row in SAMPLE_ROWS:
            await conn.execute(
                """
                INSERT INTO studio_voicechat_history
                    (user_id, mode, user_text, bot_text, agent_id, session_id)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                row,
            )
        await conn.commit()

        # 3) Sanity: external-content FTS index is NOT searchable
        #    even though COUNT(*) lies and reports source rows.
        #    That's exactly why the user couldn't find "love" before
        #    the migration ran — the index never got populated.
        cur = await conn.execute(
            "SELECT COUNT(*) FROM studio_voicechat_history_fts "
            "WHERE studio_voicechat_history_fts MATCH '\"love\"'"
        )
        match_pre = (await cur.fetchone())[0]
        assert match_pre == 0, (
            "external-content FTS shouldn't return MATCH hits before "
            f"explicit indexing, got {match_pre}"
        )

        # 4) Run the migration. It should detect the
        #    external-content layout from sqlite_master and rebuild
        #    as a regular FTS table.
        await local_db._ensure_transcript_fts(conn)

        # Verify the table shape is the new regular layout, NOT
        # external content. The stored CREATE SQL must no longer
        # contain ``content=`` after migration.
        cur = await conn.execute(
            "SELECT sql FROM sqlite_master "
            "WHERE type='table' AND name='studio_voicechat_history_fts'"
        )
        new_sql = (await cur.fetchone())["sql"] or ""
        assert "content=" not in new_sql.lower(), (
            "post-migration table is still external content"
        )

        # FTS row count must now match the source row count.
        cur = await conn.execute("SELECT COUNT(*) FROM studio_voicechat_history_fts")
        fts_post = (await cur.fetchone())[0]
        cur = await conn.execute("SELECT COUNT(*) FROM studio_voicechat_history")
        src_post = (await cur.fetchone())[0]
        assert fts_post == src_post, (
            f"backfill didn't populate FTS — src={src_post} fts={fts_post}"
        )

        # The exact queries the user tried in production must hit.
        for term in ("love", "chutes", "websearch"):
            cur = await conn.execute(
                "SELECT COUNT(*) FROM studio_voicechat_history_fts "
                "WHERE studio_voicechat_history_fts MATCH ?",
                (f'"{term}"',),
            )
            hits = (await cur.fetchone())[0]
            assert hits > 0, f"search for {term!r} returned 0 hits"

        # Triggers fire on a fresh INSERT so future per-turn writes
        # from _record_turn land in the index without another
        # migration pass.
        await conn.execute(
            """
            INSERT INTO studio_voicechat_history
                (user_id, mode, user_text, bot_text, agent_id, session_id)
            VALUES ('user_y', 'voice', 'new turn',
                    'this contains the word avocado',
                    'agent_Y', 'vc-test-002')
            """,
        )
        await conn.commit()
        cur = await conn.execute(
            "SELECT COUNT(*) FROM studio_voicechat_history_fts "
            "WHERE studio_voicechat_history_fts MATCH ?",
            ('"avocado"',),
        )
        assert (await cur.fetchone())[0] > 0, "trigger didn't index the new INSERT"

        # Idempotency: running the migration again should no-op.
        await local_db._ensure_transcript_fts(conn)
        cur = await conn.execute("SELECT COUNT(*) FROM studio_voicechat_history_fts")
        fts_after = (await cur.fetchone())[0]
        cur = await conn.execute("SELECT COUNT(*) FROM studio_voicechat_history")
        src_after = (await cur.fetchone())[0]
        assert fts_after == src_after, (
            f"idempotency check: fts={fts_after} src={src_after}"
        )
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_migration_handles_missing_table(tmp_path):
    """Fresh install path: no FTS table at all. Helper should
    create it + backfill any pre-existing source rows."""
    db_path = str(tmp_path / "website.db")
    conn = await aiosqlite.connect(db_path)
    conn.row_factory = aiosqlite.Row
    try:
        await conn.execute(SOURCE_DDL)
        await conn.execute(
            """
            INSERT INTO studio_voicechat_history
                (user_id, mode, user_text, bot_text, agent_id, session_id)
            VALUES ('u', 'voice', 'hello', 'world', 'a', 's')
            """
        )
        await conn.commit()

        await local_db._ensure_transcript_fts(conn)

        cur = await conn.execute(
            "SELECT COUNT(*) FROM studio_voicechat_history_fts WHERE "
            "studio_voicechat_history_fts MATCH '\"world\"'"
        )
        assert (await cur.fetchone())[0] == 1
    finally:
        await conn.close()


@pytest.mark.asyncio
async def test_migration_noop_when_up_to_date(tmp_path):
    """Second-startup path: table already exists with correct
    shape and matching row count. Helper should detect up-to-date
    and skip the rebuild — no errors, no data loss."""
    db_path = str(tmp_path / "website.db")
    conn = await aiosqlite.connect(db_path)
    conn.row_factory = aiosqlite.Row
    try:
        await conn.execute(SOURCE_DDL)
        for i in range(10):
            await conn.execute(
                "INSERT INTO studio_voicechat_history "
                "(user_id, mode, user_text, bot_text, agent_id, session_id) "
                "VALUES ('u', 'voice', ?, ?, 'a', 's')",
                (f"q{i}", f"a{i}"),
            )
        await conn.commit()

        await local_db._ensure_transcript_fts(conn)
        await local_db._ensure_transcript_fts(conn)

        cur = await conn.execute("SELECT COUNT(*) FROM studio_voicechat_history_fts")
        assert (await cur.fetchone())[0] == 10
    finally:
        await conn.close()
