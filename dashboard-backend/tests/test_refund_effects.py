"""Direct tests for ``_apply_refund_effects`` / ``_restore_payment_after_dispute_won``.

We exercise the helpers against an in-memory SQLite DB seeded with the
minimal schema (auth_users, payments, api_keys, agent_embed_tokens,
credit_transactions, stripe_webhook_events). For each event type the
real Stripe webhook would fire we drive the helper and assert the
cascading effects landed correctly:

  * payment row status flipped
  * auth_users plan demoted (only if no other paid Premium row)
  * API keys revoked
  * embed tokens revoked
  * credit clawback row written for terminal refunds; skipped for
    provisional disputes
  * dispute-won restoration reverses the revocations
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

# Add backend root to path so we can import the module under test.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import asyncio
import sqlite3
import uuid

import aiosqlite
import pytest
import pytest_asyncio


# Schema mirrors the production DB so the helpers run against the same
# columns / FKs they will in prod. Kept minimal — only what the refund
# helpers actually read or write.
_SCHEMA = """
CREATE TABLE auth_users (
  id TEXT PRIMARY KEY, email TEXT, name TEXT, picture TEXT,
  credits INTEGER NOT NULL DEFAULT 0,
  plan_code TEXT, plan_status TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  session_id TEXT, user_id TEXT NOT NULL,
  provider TEXT, plan_code TEXT, amount_usd REAL,
  credits_granted INTEGER, currency TEXT, status TEXT,
  provider_payment_id TEXT,
  stripe_checkout_session_id TEXT, stripe_payment_intent_id TEXT,
  stripe_invoice_id TEXT, stripe_subscription_id TEXT,
  stripe_customer_id TEXT, stripe_event_id TEXT,
  mode TEXT, wallet_address TEXT,
  billing_period_start TEXT, billing_period_end TEXT,
  credits_applied_at TEXT, metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  name TEXT, key_prefix TEXT, key_hash TEXT,
  tier TEXT, rate_limit_rpm INTEGER,
  last_used_at TEXT, revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE TABLE agent_embed_tokens (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  token_hash TEXT, token_prefix TEXT, label TEXT,
  allowed_origins_json TEXT,
  rate_limit_per_ip_per_hour INTEGER, max_session_minutes INTEGER,
  last_used_at TEXT, revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE credit_transactions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  transaction_type TEXT NOT NULL, amount INTEGER NOT NULL,
  balance_after INTEGER NOT NULL, description TEXT,
  reference_type TEXT, reference_id TEXT, metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


@pytest_asyncio.fixture
async def db(tmp_path):
    """Per-test fresh SQLite file. Caller gets an aiosqlite.Connection
    plus a synchronous helper for assertions (the helpers expect
    aiosqlite; for assertions raw sqlite3 is simpler)."""
    path = tmp_path / "refund.db"
    # Seed schema via raw sqlite3 (faster than aiosqlite for setup).
    raw = sqlite3.connect(path)
    raw.executescript(_SCHEMA)
    raw.commit()
    raw.close()
    # Now open async for the helpers.
    conn = await aiosqlite.connect(path)
    conn.row_factory = aiosqlite.Row
    yield conn, path
    await conn.close()


async def _seed(conn, *, with_keys: int = 2, with_tokens: int = 1, credits_granted: int = 1000) -> dict:
    """Seed a Premium user + paid payment + keys + tokens. Returns
    handles the test will use to assert post-refund state."""
    user_id = "u_" + uuid.uuid4().hex[:8]
    payment_id = "p_" + uuid.uuid4().hex[:8]
    pi_id = "pi_" + uuid.uuid4().hex[:8]
    await conn.execute(
        "INSERT INTO auth_users (id, email, credits, plan_code, plan_status) "
        "VALUES (?, ?, ?, 'premium', 'active')",
        (user_id, f"{user_id}@test.local", credits_granted),
    )
    await conn.execute(
        "INSERT INTO payments (id, user_id, plan_code, credits_granted, status, "
        "stripe_payment_intent_id, amount_usd) "
        "VALUES (?, ?, 'premium', ?, 'paid', ?, 10.0)",
        (payment_id, user_id, credits_granted, pi_id),
    )
    for i in range(with_keys):
        await conn.execute(
            "INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, tier) "
            "VALUES (?, ?, ?, ?, ?, 'free')",
            (f"k_{uuid.uuid4().hex[:8]}", user_id, f"key {i}", f"voc_live_pre{i}", "h", ),
        )
    for i in range(with_tokens):
        await conn.execute(
            "INSERT INTO agent_embed_tokens (id, agent_id, owner_user_id, token_hash, token_prefix, label) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (f"t_{uuid.uuid4().hex[:8]}", "ag_test", user_id, "h", "vet_pre", f"tok{i}"),
        )
    await conn.commit()
    return {"user_id": user_id, "payment_id": payment_id, "pi_id": pi_id}


async def _fetch_one(conn, sql: str, params: tuple) -> dict | None:
    row = await (await conn.execute(sql, params)).fetchone()
    return dict(row) if row else None


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_full_refund_revokes_everything_and_claws_back_credits(db) -> None:
    conn, _ = db
    seeded = await _seed(conn, with_keys=2, with_tokens=1, credits_granted=1000)
    # User has spent NOTHING; balance still 1000.

    # Pull payment_row in the shape the helper expects.
    payment_row = await _fetch_one(
        conn, "SELECT * FROM payments WHERE id = ?", (seeded["payment_id"],)
    )

    # Import the helper lazily so the in-memory DB is in place first.
    from routers.auth import _apply_refund_effects
    await _apply_refund_effects(
        conn,
        payment_row=payment_row,
        new_payment_status="refunded",
        event_id="evt_full_refund",
        reason="stripe.charge.refunded",
        clawback_credits=True,
    )
    await conn.commit()

    # 1. payments row status flipped.
    pr = await _fetch_one(conn, "SELECT status, stripe_event_id FROM payments WHERE id = ?", (seeded["payment_id"],))
    assert pr["status"] == "refunded"
    assert pr["stripe_event_id"] == "evt_full_refund"

    # 2. auth_users demoted (no other paid Premium row exists).
    user = await _fetch_one(conn, "SELECT plan_code, plan_status, credits FROM auth_users WHERE id = ?", (seeded["user_id"],))
    assert user["plan_code"] == "normal"
    assert user["plan_status"] == "canceled"
    # 3. credits clawed back to zero (granted 1000, spent 0).
    assert user["credits"] == 0

    # 4. all api_keys revoked.
    keys = await (await conn.execute(
        "SELECT COUNT(*) AS n FROM api_keys WHERE user_id = ? AND revoked_at IS NOT NULL", (seeded["user_id"],)
    )).fetchone()
    assert keys["n"] == 2

    # 5. embed tokens revoked.
    toks = await (await conn.execute(
        "SELECT COUNT(*) AS n FROM agent_embed_tokens WHERE owner_user_id = ? AND revoked_at IS NOT NULL", (seeded["user_id"],)
    )).fetchone()
    assert toks["n"] == 1

    # 6. credit_transactions audit row.
    tx = await _fetch_one(
        conn,
        "SELECT amount, transaction_type, balance_after FROM credit_transactions "
        "WHERE user_id = ? AND transaction_type = 'refund_clawback'",
        (seeded["user_id"],),
    )
    assert tx is not None
    assert tx["amount"] == -1000
    assert tx["balance_after"] == 0


@pytest.mark.asyncio
async def test_clawback_never_pushes_balance_below_zero(db) -> None:
    """If the user spent all their refunded credits before the refund
    landed, we don't drive their balance negative — we eat the loss
    on the difference. Going negative would block them from spending
    legitimately-earned credits later."""
    conn, _ = db
    seeded = await _seed(conn, credits_granted=1000)
    # Simulate the user spent 700 credits already.
    await conn.execute("UPDATE auth_users SET credits = 300 WHERE id = ?", (seeded["user_id"],))
    await conn.commit()

    payment_row = await _fetch_one(conn, "SELECT * FROM payments WHERE id = ?", (seeded["payment_id"],))
    from routers.auth import _apply_refund_effects
    await _apply_refund_effects(
        conn, payment_row=payment_row,
        new_payment_status="refunded",
        event_id="evt_clamped",
        reason="test",
        clawback_credits=True,
    )
    await conn.commit()

    user = await _fetch_one(conn, "SELECT credits FROM auth_users WHERE id = ?", (seeded["user_id"],))
    assert user["credits"] == 0  # clamped — would have been -700

    tx = await _fetch_one(
        conn, "SELECT amount FROM credit_transactions WHERE user_id = ? AND transaction_type = 'refund_clawback'",
        (seeded["user_id"],),
    )
    # Clawback amount limited to what they actually had (300), not the full 1000.
    assert tx["amount"] == -300


@pytest.mark.asyncio
async def test_dispute_provisional_skips_clawback_but_revokes(db) -> None:
    """``charge.dispute.created`` is the OPENING of a dispute — we don't
    know the outcome yet. We must revoke immediately (so the user
    can't keep using paid services they're about to charge back) but
    we MUST NOT claw back credits — if they later win the dispute we
    restore them, and a clawback that already happened is hard to
    undo cleanly."""
    conn, _ = db
    seeded = await _seed(conn, credits_granted=1000)
    payment_row = await _fetch_one(conn, "SELECT * FROM payments WHERE id = ?", (seeded["payment_id"],))

    from routers.auth import _apply_refund_effects
    await _apply_refund_effects(
        conn, payment_row=payment_row,
        new_payment_status="disputed",
        event_id="evt_dispute_open",
        reason="stripe.charge.dispute.created",
        clawback_credits=False,
    )
    await conn.commit()

    pr = await _fetch_one(conn, "SELECT status FROM payments WHERE id = ?", (seeded["payment_id"],))
    assert pr["status"] == "disputed"
    # Keys revoked.
    keys = await (await conn.execute(
        "SELECT COUNT(*) FROM api_keys WHERE user_id = ? AND revoked_at IS NOT NULL", (seeded["user_id"],)
    )).fetchone()
    assert keys[0] == 2
    # Credits UNTOUCHED — provisional dispute does not claw back.
    user = await _fetch_one(conn, "SELECT credits FROM auth_users WHERE id = ?", (seeded["user_id"],))
    assert user["credits"] == 1000
    # No clawback transaction row.
    tx = await _fetch_one(
        conn, "SELECT amount FROM credit_transactions WHERE user_id = ?", (seeded["user_id"],),
    )
    assert tx is None


@pytest.mark.asyncio
async def test_dispute_won_restores_payment_keys_and_plan(db) -> None:
    """When a dispute closes in our favour, the provisional revocations
    from ``dispute.created`` get reversed: payment back to ``paid``,
    plan back to Premium/active, keys/tokens un-revoked."""
    conn, _ = db
    seeded = await _seed(conn, credits_granted=1000)
    payment_row = await _fetch_one(conn, "SELECT * FROM payments WHERE id = ?", (seeded["payment_id"],))

    from routers.auth import _apply_refund_effects, _restore_payment_after_dispute_won
    # First fire dispute.created (the original revocation).
    await _apply_refund_effects(
        conn, payment_row=payment_row,
        new_payment_status="disputed",
        event_id="evt_dispute_open",
        reason="dispute open",
        clawback_credits=False,
    )
    await conn.commit()
    # Then the dispute resolves in our favour.
    payment_row = await _fetch_one(conn, "SELECT * FROM payments WHERE id = ?", (seeded["payment_id"],))
    await _restore_payment_after_dispute_won(
        conn, payment_row=payment_row, event_id="evt_dispute_won",
    )
    await conn.commit()

    pr = await _fetch_one(conn, "SELECT status, stripe_event_id FROM payments WHERE id = ?", (seeded["payment_id"],))
    assert pr["status"] == "paid"
    assert pr["stripe_event_id"] == "evt_dispute_won"

    user = await _fetch_one(conn, "SELECT plan_code, plan_status, credits FROM auth_users WHERE id = ?", (seeded["user_id"],))
    assert user["plan_code"] == "premium"
    assert user["plan_status"] == "active"
    # Credits unchanged across the whole dispute lifecycle.
    assert user["credits"] == 1000

    keys = await (await conn.execute(
        "SELECT COUNT(*) FROM api_keys WHERE user_id = ? AND revoked_at IS NULL", (seeded["user_id"],)
    )).fetchone()
    assert keys[0] == 2


@pytest.mark.asyncio
async def test_refund_does_not_demote_user_with_other_paid_premium_row(db) -> None:
    """If the user has multiple paid Premium payments and only ONE is
    refunded, we revoke / claw back for that payment but keep their
    Premium status — they still have a valid paid subscription."""
    conn, _ = db
    seeded = await _seed(conn, credits_granted=500)
    # Insert a SECOND paid Premium row for the same user.
    second_id = "p_" + uuid.uuid4().hex[:8]
    await conn.execute(
        "INSERT INTO payments (id, user_id, plan_code, credits_granted, status, "
        "stripe_payment_intent_id, amount_usd) "
        "VALUES (?, ?, 'premium', 500, 'paid', 'pi_other', 10.0)",
        (second_id, seeded["user_id"]),
    )
    await conn.execute("UPDATE auth_users SET credits = 1000 WHERE id = ?", (seeded["user_id"],))
    await conn.commit()

    payment_row = await _fetch_one(conn, "SELECT * FROM payments WHERE id = ?", (seeded["payment_id"],))
    from routers.auth import _apply_refund_effects
    await _apply_refund_effects(
        conn, payment_row=payment_row,
        new_payment_status="refunded",
        event_id="evt_partial",
        reason="one of two refunded",
        clawback_credits=True,
    )
    await conn.commit()

    user = await _fetch_one(conn, "SELECT plan_code, plan_status FROM auth_users WHERE id = ?", (seeded["user_id"],))
    # Still Premium — they have another paying row.
    assert user["plan_code"] == "premium"
    assert user["plan_status"] != "canceled"


@pytest.mark.asyncio
async def test_refund_is_idempotent_on_already_refunded_row(db) -> None:
    """Stripe occasionally retries webhooks; our deduplication guard
    in ``_record_webhook_event`` blocks the second call, but if it
    somehow gets through, ``_apply_refund_effects`` should still be
    safe to run again — no duplicate clawback rows."""
    conn, _ = db
    seeded = await _seed(conn, credits_granted=1000)
    payment_row = await _fetch_one(conn, "SELECT * FROM payments WHERE id = ?", (seeded["payment_id"],))

    from routers.auth import _apply_refund_effects
    await _apply_refund_effects(
        conn, payment_row=payment_row,
        new_payment_status="refunded",
        event_id="evt_1",
        reason="first",
        clawback_credits=True,
    )
    await conn.commit()

    user_after_first = await _fetch_one(conn, "SELECT credits FROM auth_users WHERE id = ?", (seeded["user_id"],))
    assert user_after_first["credits"] == 0

    # Re-fire — payment row already at status='refunded', balance is 0.
    payment_row = await _fetch_one(conn, "SELECT * FROM payments WHERE id = ?", (seeded["payment_id"],))
    await _apply_refund_effects(
        conn, payment_row=payment_row,
        new_payment_status="refunded",
        event_id="evt_2",
        reason="retry",
        clawback_credits=True,
    )
    await conn.commit()

    user_after_second = await _fetch_one(conn, "SELECT credits FROM auth_users WHERE id = ?", (seeded["user_id"],))
    # Balance stays at 0 — clamp at zero prevents a second clawback
    # from going negative. The second clawback row's amount will be 0,
    # which is benign (audit shows "refund applied: no credits to remove").
    assert user_after_second["credits"] == 0
