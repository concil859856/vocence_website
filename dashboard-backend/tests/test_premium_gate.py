"""Premium gating: bought OR granted.

Premium used to be decided purely by "is there a paid Premium row in
``payments``". The Account page, however, renders from ``auth_users`` — so an
account comped by staff (``UPDATE auth_users SET plan_code='premium'``) showed
"Premium" everywhere while every gated route still refused it: developer API
keys 402'd, and video dubbing applied the free-tier lip-sync cap.

The gates now accept either signal. These tests pin that behaviour, and pin
that demotion stays payment-driven — the refund path must not consult
``auth_users.plan_code``, or a demoted user would keep re-qualifying via the
very column the demotion just wrote.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[1]
_REPO = _ROOT.parent
sys.path.insert(0, str(_ROOT))

import aiosqlite  # noqa: E402


_SCHEMA = """
CREATE TABLE auth_users (
  id TEXT PRIMARY KEY, email TEXT,
  credits INTEGER NOT NULL DEFAULT 0,
  plan_code TEXT, plan_status TEXT
);
CREATE TABLE payments (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
  provider TEXT, plan_code TEXT, amount_usd REAL,
  credits_granted INTEGER, status TEXT
);
"""

# The predicate every gate shares. Kept here verbatim so a change to the
# production copies without a matching change here fails loudly.
_GATE_SQL = """
SELECT (
  EXISTS(
    SELECT 1 FROM payments
    WHERE user_id = ? AND status IN ('paid', 'completed')
      AND credits_granted > 0
      AND LOWER(COALESCE(plan_code, '')) = 'premium'
  )
  OR EXISTS(
    SELECT 1 FROM auth_users
    WHERE id = ? AND LOWER(COALESCE(plan_code, '')) = 'premium'
  )
) AS n
"""


async def _is_premium(conn, user_id: str) -> bool:
    row = await (await conn.execute(_GATE_SQL, (user_id, user_id))).fetchone()
    return int(row[0] or 0) > 0


async def _seed(conn, user_id: str, *, plan_code: str | None, payment: tuple | None) -> None:
    await conn.execute(
        "INSERT INTO auth_users (id, email, plan_code) VALUES (?, ?, ?)",
        (user_id, f"{user_id}@example.com", plan_code),
    )
    if payment is not None:
        pay_plan, status, credits = payment
        await conn.execute(
            "INSERT INTO payments (id, user_id, provider, plan_code, amount_usd, credits_granted, status)"
            " VALUES (?, ?, 'stripe', ?, 10.0, ?, ?)",
            (f"p-{user_id}", user_id, pay_plan, credits, status),
        )
    await conn.commit()


@pytest.mark.asyncio
async def test_paying_user_is_premium():
    async with aiosqlite.connect(":memory:") as conn:
        await conn.executescript(_SCHEMA)
        await _seed(conn, "paid", plan_code="premium", payment=("premium", "paid", 5000))
        assert await _is_premium(conn, "paid") is True


@pytest.mark.asyncio
async def test_comped_user_is_premium_without_any_payment():
    """The regression this module exists for: staff-granted Premium."""
    async with aiosqlite.connect(":memory:") as conn:
        await conn.executescript(_SCHEMA)
        await _seed(conn, "comped", plan_code="premium", payment=None)
        assert await _is_premium(conn, "comped") is True


@pytest.mark.asyncio
async def test_free_user_is_not_premium():
    async with aiosqlite.connect(":memory:") as conn:
        await conn.executescript(_SCHEMA)
        await _seed(conn, "free", plan_code="normal", payment=None)
        assert await _is_premium(conn, "free") is False


@pytest.mark.asyncio
async def test_demoted_user_loses_premium():
    """Refund demotion sets plan_code='normal' and flips the payment status.
    Neither signal remains, so access is gone."""
    async with aiosqlite.connect(":memory:") as conn:
        await conn.executescript(_SCHEMA)
        await _seed(conn, "refunded", plan_code="normal", payment=("premium", "refunded", 5000))
        assert await _is_premium(conn, "refunded") is False


@pytest.mark.asyncio
async def test_plan_code_matching_is_case_insensitive():
    async with aiosqlite.connect(":memory:") as conn:
        await conn.executescript(_SCHEMA)
        await _seed(conn, "shouty", plan_code="PREMIUM", payment=None)
        assert await _is_premium(conn, "shouty") is True


@pytest.mark.asyncio
async def test_zero_credit_payment_does_not_grant_premium():
    """A payments row that granted nothing is not a purchase."""
    async with aiosqlite.connect(":memory:") as conn:
        await conn.executescript(_SCHEMA)
        await _seed(conn, "zero", plan_code="normal", payment=("premium", "paid", 0))
        assert await _is_premium(conn, "zero") is False


# ---------------------------------------------------------------------------
# Source guards — every gate must consult auth_users, demotion must not.
# ---------------------------------------------------------------------------

_GATE_SITES = [
    "dashboard-backend/routers/studio.py",              # _is_premium_user
    "dashboard-backend/routers/auth.py",                # create_developer_key
    "developer-api/app/services/gating.py",             # _ensure_premium
    "developer-api/app/api/routes/agent_mgmt.py",
    "developer-api/app/api/routes/v1.py",
    "developer-api/app/api/routes/agents.py",
]


@pytest.mark.parametrize("rel", _GATE_SITES)
def test_every_gate_site_checks_auth_users_plan_code(rel):
    src = (_REPO / rel).read_text()
    premium_blocks = src.count("LOWER(COALESCE(plan_code, '')) = 'premium'")
    assert premium_blocks, f"{rel}: no premium predicate found — did the query move?"
    assert "FROM auth_users" in src and "EXISTS(" in src, (
        f"{rel}: premium gate no longer falls back to auth_users.plan_code; "
        "staff-granted Premium accounts would be refused again."
    )


def test_refund_demotion_does_not_consult_plan_code():
    """The demotion query must count OTHER paying rows only. If it ever gained
    an auth_users.plan_code fallback it would be circular: the user is Premium
    because plan_code says so, so we would never write plan_code='normal'."""
    src = (_REPO / "dashboard-backend/routers/auth.py").read_text()
    m = re.search(r"other_paying = await \(.*?\)\.fetchone\(\)", src, re.S)
    assert m, "demotion query not found — did _apply_refund_effects change shape?"
    block = m.group(0)
    assert "FROM payments" in block
    assert "auth_users" not in block, (
        "refund demotion must stay payment-driven; consulting auth_users.plan_code "
        "here would make demotion circular and users could never be demoted."
    )
