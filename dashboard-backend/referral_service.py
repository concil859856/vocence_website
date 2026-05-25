"""Referral system — invite friends, earn credits.

Rules:
  - Each user gets a unique 8-char referral code on signup.
  - New user signs up with a referral code → linked via ``referred_by``.
  - Referrer gets 500 credits when the invited user is "activated"
    (completes at least one generation on any feature).
  - Referrer gets 10% of credits from every purchase the invited user makes.
  - 3 activated referrals → referrer upgraded to premium + 1,000 bonus credits.

Anti-abuse:
  - One referral per device fingerprint.
  - Credits granted only after invited user actually uses the platform.
  - No self-referral.
"""

from __future__ import annotations

import logging
import secrets
import string

from local_db import get_connection, record_credit_transaction

_log = logging.getLogger(__name__)

REFERRAL_SIGNUP_BONUS = 500
REFERRAL_COMMISSION_PCT = 0.10
MILESTONE_COUNT = 3
MILESTONE_PLAN = "premium"
MILESTONE_BONUS_CREDITS = 1000


def generate_referral_code() -> str:
    alphabet = string.ascii_lowercase + string.digits
    return "".join(secrets.choice(alphabet) for _ in range(8))


async def ensure_referral_code(conn, user_id: str) -> str:
    """Return the user's referral code, generating one if missing."""
    row = await (await conn.execute(
        "SELECT referral_code FROM auth_users WHERE id = ?", (user_id,)
    )).fetchone()
    if row and row["referral_code"]:
        return row["referral_code"]
    for _ in range(10):
        code = generate_referral_code()
        try:
            await conn.execute(
                "UPDATE auth_users SET referral_code = ? WHERE id = ? AND (referral_code IS NULL OR referral_code = '')",
                (code, user_id),
            )
            await conn.commit()
            return code
        except Exception:
            continue
    raise RuntimeError("could not generate unique referral code")


async def validate_referral(
    conn,
    *,
    referral_code: str,
    new_user_id: str,
    new_user_email: str,
    device_fingerprint: str | None,
) -> str | None:
    """Validate a referral code for a new signup. Returns error string or None on success."""
    if not referral_code:
        return "empty referral code"

    referrer = await (await conn.execute(
        "SELECT id, email, referral_code FROM auth_users WHERE referral_code = ?",
        (referral_code,),
    )).fetchone()
    if not referrer:
        return "invalid referral code"

    if referrer["id"] == new_user_id or referrer["email"] == new_user_email:
        return "cannot refer yourself"

    if device_fingerprint:
        existing = await (await conn.execute(
            "SELECT referral_code FROM referral_devices WHERE device_fingerprint = ?",
            (device_fingerprint,),
        )).fetchone()
        if existing:
            return "device already used a referral"

    return None


async def apply_referral_on_signup(
    conn,
    *,
    referral_code: str,
    new_user_id: str,
    device_fingerprint: str | None,
) -> None:
    """Link the new user to the referrer. Credits are granted later on activation."""
    await conn.execute(
        "UPDATE auth_users SET referred_by = ? WHERE id = ?",
        (referral_code, new_user_id),
    )
    if device_fingerprint:
        await conn.execute(
            "INSERT OR IGNORE INTO referral_devices (device_fingerprint, referral_code, user_id) VALUES (?, ?, ?)",
            (device_fingerprint, referral_code, new_user_id),
        )


async def try_activate_referral(user_id: str) -> None:
    """Called after a user's first successful generation. Grants referrer credits
    and checks the 3-invite milestone. Safe to call multiple times — no-ops if
    already activated."""
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT referred_by, referral_activated FROM auth_users WHERE id = ?",
            (user_id,),
        )).fetchone()
        if not row or not row["referred_by"] or row["referral_activated"]:
            return

        referral_code = row["referred_by"]
        await conn.execute(
            "UPDATE auth_users SET referral_activated = 1, updated_at = datetime('now') WHERE id = ?",
            (user_id,),
        )

        referrer = await (await conn.execute(
            "SELECT id, credits, plan_code FROM auth_users WHERE referral_code = ?",
            (referral_code,),
        )).fetchone()
        if not referrer:
            await conn.commit()
            return

        referrer_id = referrer["id"]
        new_balance = referrer["credits"] + REFERRAL_SIGNUP_BONUS
        await conn.execute(
            "UPDATE auth_users SET credits = ?, updated_at = datetime('now') WHERE id = ?",
            (new_balance, referrer_id),
        )
        await record_credit_transaction(
            conn,
            user_id=referrer_id,
            transaction_type="referral_signup_bonus",
            amount=REFERRAL_SIGNUP_BONUS,
            balance_after=new_balance,
            description=f"Referral bonus: invited user activated",
            reference_type="referral",
            reference_id=user_id,
            metadata={"referred_user_id": user_id},
        )

        await _check_milestone(conn, referrer_id, referrer)
        await conn.commit()
        _log.info("referral activated: user %s → referrer %s (+%d credits)",
                   user_id, referrer_id, REFERRAL_SIGNUP_BONUS)
    finally:
        await conn.close()


async def grant_purchase_commission(
    conn,
    *,
    buyer_id: str,
    credits_purchased: int,
    payment_id: str,
) -> None:
    """Grant 10% commission to the referrer when the referred user purchases credits."""
    row = await (await conn.execute(
        "SELECT referred_by FROM auth_users WHERE id = ?", (buyer_id,),
    )).fetchone()
    if not row or not row["referred_by"]:
        return

    referrer = await (await conn.execute(
        "SELECT id, credits FROM auth_users WHERE referral_code = ?",
        (row["referred_by"],),
    )).fetchone()
    if not referrer:
        return

    commission = max(1, int(credits_purchased * REFERRAL_COMMISSION_PCT))
    referrer_id = referrer["id"]
    new_balance = referrer["credits"] + commission
    await conn.execute(
        "UPDATE auth_users SET credits = ?, updated_at = datetime('now') WHERE id = ?",
        (new_balance, referrer_id),
    )
    await record_credit_transaction(
        conn,
        user_id=referrer_id,
        transaction_type="referral_commission",
        amount=commission,
        balance_after=new_balance,
        description=f"10% referral commission on purchase of {credits_purchased} credits",
        reference_type="payment",
        reference_id=payment_id,
        metadata={"buyer_id": buyer_id, "credits_purchased": credits_purchased},
    )
    _log.info("referral commission: buyer %s purchased %d → referrer %s +%d",
              buyer_id, credits_purchased, referrer_id, commission)


async def _check_milestone(conn, referrer_id: str, referrer_row) -> None:
    """If referrer has 3+ activated referrals and isn't already premium, upgrade."""
    if referrer_row["plan_code"] == MILESTONE_PLAN:
        return

    count = await (await conn.execute(
        "SELECT COUNT(*) as cnt FROM auth_users WHERE referred_by = (SELECT referral_code FROM auth_users WHERE id = ?) AND referral_activated = 1",
        (referrer_id,),
    )).fetchone()
    if not count or count["cnt"] < MILESTONE_COUNT:
        return

    new_balance = referrer_row["credits"] + MILESTONE_BONUS_CREDITS
    await conn.execute(
        "UPDATE auth_users SET plan_code = ?, credits = ?, updated_at = datetime('now') WHERE id = ?",
        (MILESTONE_PLAN, new_balance, referrer_id),
    )
    await record_credit_transaction(
        conn,
        user_id=referrer_id,
        transaction_type="referral_milestone",
        amount=MILESTONE_BONUS_CREDITS,
        balance_after=new_balance,
        description=f"Referral milestone: {MILESTONE_COUNT} activated invites → premium + {MILESTONE_BONUS_CREDITS} credits",
        reference_type="referral_milestone",
        reference_id=str(MILESTONE_COUNT),
        metadata={"milestone": MILESTONE_COUNT, "plan_upgrade": MILESTONE_PLAN},
    )
    _log.info("referral milestone: user %s → premium + %d credits", referrer_id, MILESTONE_BONUS_CREDITS)


async def get_referral_stats(user_id: str) -> dict:
    """Get referral stats for the user's referral dashboard."""
    conn = await get_connection()
    try:
        user = await (await conn.execute(
            "SELECT referral_code, referred_by FROM auth_users WHERE id = ?", (user_id,),
        )).fetchone()
        if not user:
            return {}

        code = user["referral_code"] or ""

        total = await (await conn.execute(
            "SELECT COUNT(*) as cnt FROM auth_users WHERE referred_by = ?", (code,),
        )).fetchone()

        activated = await (await conn.execute(
            "SELECT COUNT(*) as cnt FROM auth_users WHERE referred_by = ? AND referral_activated = 1", (code,),
        )).fetchone()

        earned = await (await conn.execute(
            "SELECT COALESCE(SUM(amount), 0) as total FROM credit_transactions WHERE user_id = ? AND transaction_type IN ('referral_signup_bonus', 'referral_commission', 'referral_milestone')",
            (user_id,),
        )).fetchone()

        return {
            "referral_code": code,
            "total_invites": total["cnt"] if total else 0,
            "activated_invites": activated["cnt"] if activated else 0,
            "credits_earned": earned["total"] if earned else 0,
            "milestone_target": MILESTONE_COUNT,
            "referred_by": user["referred_by"] or None,
        }
    finally:
        await conn.close()
