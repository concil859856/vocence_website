"""Shared premium + rate-limit + audit-log gating for work-doing routes.

Every developer-api endpoint that hits an upstream paid service or
performs a state-mutating action that would otherwise be cheap-to-spam
should pass through :func:`gate_request` at the top of the handler.

Three gates layered together (in order):

1. **Premium** — calling the API at all requires a successful Premium
   purchase. We re-check on every request (not just at key creation)
   so a refund / chargeback / subscription end gets the user locked
   out quickly without waiting for the key to be reissued.

2. **Rate limit** — per-user RPM cap pulled from the user's tier.
   Protects upstream pods from a single-key flood without needing a
   distributed Redis-backed counter (small enough scale that per-process
   counts are fine for now).

3. **Audit log** — best-effort row in ``api_request_logs`` so the user
   sees the request in their billing dashboard and operators can grep
   for abuse / debugging. Failure to log NEVER blocks the request.

``gate_request`` does steps 1 + 2. Call :func:`log_audit` after the
endpoint finishes so the log row reflects the actual HTTP status the
caller saw (success vs. upstream failure).

The implementation is intentionally a copy of the historic
``_ensure_premium`` + ``_gate_request`` pair from agent_mgmt.py —
extracted so the agent_knowledge / embed_tokens / future modules can
share it without cross-importing route files (which would create a
maintenance landmine the moment routes shuffle around).
"""

from __future__ import annotations

import json as _json
import logging
import uuid
from typing import Any

from fastapi import HTTPException

from app.db.connection import get_db
from app.services.usage import enforce_rate_limit, log_api_request


_log = logging.getLogger(__name__)


async def _ensure_premium(conn, user_id: str) -> None:
    """Re-check Premium status. Schema mirrors the historic
    ``_ensure_premium`` in agent_mgmt.py — kept identical so both
    surfaces gate the same set of users.

    Premium counts whether it was bought (a paid/completed payments row) or
    granted by staff (``auth_users.plan_code``). Checking payments alone left
    comped accounts reading "Premium" on the Account page while every gated
    route refused them. Demotion remains payment-driven and resets plan_code
    to 'normal', so lapsed subscribers still lose access.
    """
    paid_row = await (
        await conn.execute(
            """
            SELECT (
              EXISTS(
                SELECT 1 FROM payments
                WHERE user_id = ?
                  AND status IN ('paid', 'completed')
                  AND credits_granted > 0
                  AND LOWER(COALESCE(plan_code, '')) = 'premium'
              )
              OR EXISTS(
                SELECT 1 FROM auth_users
                WHERE id = ? AND LOWER(COALESCE(plan_code, '')) = 'premium'
              )
            ) AS n
            """,
            (user_id, user_id),
        )
    ).fetchone()
    if int(paid_row["n"] or 0) <= 0:
        raise HTTPException(
            status_code=402,
            detail="Developer API requires an active Premium plan.",
        )


async def gate_request(user_id: str) -> None:
    """Premium + rate-limit. Call at the top of any work-doing endpoint.

    Raises:
      * 402 if Premium isn't active for this user.
      * 429 if the per-user RPM cap is exceeded.
    """
    conn = await get_db()
    try:
        await _ensure_premium(conn, user_id)
        await enforce_rate_limit(conn, user_id, None)
    finally:
        await conn.close()


async def charge_credits(
    user_id: str,
    cost: int,
    *,
    label: str,
    transaction_type: str,
) -> int:
    """Atomically deduct flat credits + write a ``credit_transactions``
    audit row. Returns the new balance, or ``-1`` if ``cost == 0``
    (billing disabled — useful for free endpoints kept on the same
    code path for consistency).

    Raises 402 on insufficient balance, never partially deducts.

    Pair with :func:`refund_credits` when the dashboard call AFTER
    this charge fails — we MUST refund or the user is double-billed
    (charged for a request that didn't complete).
    """
    if cost <= 0:
        return -1
    conn = await get_db()
    try:
        row = await (await conn.execute(
            "SELECT credits FROM auth_users WHERE id = ?", (user_id,)
        )).fetchone()
        balance = int(row["credits"] or 0) if row else 0
        if balance < cost:
            raise HTTPException(
                status_code=402,
                detail=f"{label} costs {cost} credits. You have {balance}.",
            )
        # Conditional UPDATE serialises against a parallel deduction
        # for the same user — even if two requests both pass the
        # balance check above, only one wins the row update.
        cur = await conn.execute(
            "UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') "
            "WHERE id = ? AND credits >= ?",
            (cost, user_id, cost),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=402, detail="Insufficient credits.")
        new_row = await (await conn.execute(
            "SELECT credits FROM auth_users WHERE id = ?", (user_id,)
        )).fetchone()
        new_balance = int(new_row["credits"] or 0) if new_row else 0
        await conn.execute(
            """
            INSERT INTO credit_transactions
            (id, user_id, transaction_type, amount, balance_after, description,
             reference_type, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'api_request', ?, datetime('now'))
            """,
            (
                uuid.uuid4().hex,
                user_id,
                transaction_type,
                -cost,
                new_balance,
                f"Developer API {label}",
                _json.dumps({"source": "developer-api"}),
            ),
        )
        await conn.commit()
        return new_balance
    finally:
        await conn.close()


async def refund_credits(
    user_id: str,
    amount: int,
    *,
    label: str,
    transaction_type: str,
) -> None:
    """Return previously-charged credits to the user when the upstream
    call fails. Logs a counterpart row in ``credit_transactions`` so
    the audit trail shows charge + refund + net = 0 on a failed
    request — supports proper billing reconciliation.

    Best-effort: failures here are logged but never re-raised, because
    by the time we call this we've already decided to return an error
    to the caller. Losing a refund row is recoverable from
    ``api_request_logs`` (the matching error row tells us what to
    return); losing the upstream error to a refund failure isn't.
    """
    if amount <= 0:
        return
    conn = await get_db()
    try:
        try:
            await conn.execute(
                "UPDATE auth_users SET credits = credits + ?, updated_at = datetime('now') "
                "WHERE id = ?",
                (amount, user_id),
            )
            row = await (await conn.execute(
                "SELECT credits FROM auth_users WHERE id = ?", (user_id,)
            )).fetchone()
            new_balance = int(row["credits"] or 0) if row else 0
            await conn.execute(
                """
                INSERT INTO credit_transactions
                (id, user_id, transaction_type, amount, balance_after, description,
                 reference_type, metadata_json, created_at)
                VALUES (?, ?, ?, ?, ?, ?, 'api_request', ?, datetime('now'))
                """,
                (
                    uuid.uuid4().hex,
                    user_id,
                    transaction_type,
                    amount,
                    new_balance,
                    f"Refund for failed Developer API {label}",
                    _json.dumps({"source": "developer-api", "refund": True}),
                ),
            )
            await conn.commit()
        except Exception as exc:  # noqa: BLE001 — refund failures shouldn't hide the real error
            _log.error("refund_credits failed for %s/%s: %s", user_id, label, exc)
    finally:
        await conn.close()


async def log_audit(
    *,
    auth_ctx: dict[str, Any],
    endpoint: str,
    http_status: int,
    latency_ms: int | None = None,
    error_code: str | None = None,
    error_message: str | None = None,
) -> None:
    """Best-effort audit row. Wraps ``log_api_request`` so callers don't
    have to mint a request_id themselves and exceptions never bubble.

    Free / read-only endpoints can skip this; work endpoints SHOULD
    call it after the handler resolves so the user sees the request in
    their billing dashboard."""
    conn = await get_db()
    try:
        try:
            await log_api_request(
                conn,
                request_id=uuid.uuid4().hex,
                user_id=auth_ctx["user_id"],
                api_key_id=auth_ctx.get("api_key_id", ""),
                endpoint=endpoint,
                provider=None,
                status="success" if http_status < 400 else "error",
                http_status=http_status,
                credits_used=0,  # current dashboard knowledge / embed-token paths are free
                request_chars=0,
                latency_ms=latency_ms,
                error_code=error_code,
                error_message=error_message,
            )
            await conn.commit()
        except Exception as exc:  # noqa: BLE001 — audit failures must not block
            _log.warning("audit log failed for %s: %s", endpoint, exc)
    finally:
        await conn.close()
