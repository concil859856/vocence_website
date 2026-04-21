"""
Auth, account, pricing, and payment session APIs backed by website.db.
"""

import json
import logging
import os
import uuid
import asyncio
import smtplib
import hmac
import hashlib
import urllib.error
import urllib.request
from email.message import EmailMessage
from datetime import datetime, timedelta, timezone

import jwt
import aiohttp
from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request
from pydantic import BaseModel

from local_db import (
    ensure_tables,
    generate_api_key,
    get_connection,
    hash_api_key,
    record_credit_transaction,
    refresh_daily_usage_for_day,
)
from stripe_service import (
    create_checkout_session as create_stripe_checkout_session,
    get_cancel_url,
    get_stripe_price_id,
    get_success_url,
    verify_webhook_signature,
)

_np_log = logging.getLogger(__name__)

JWT_SECRET = os.environ.get("JWT_SECRET", "your-secret-key-change-in-production")
JWT_ALGORITHM = "HS256"
JWT_EXPIRY_DAYS = 30
SIGNUP_CREDITS = int(os.environ.get("SIGNUP_CREDITS", "300"))

router = APIRouter(prefix="/api", tags=["auth"])


class LoginRequest(BaseModel):
    email: str
    name: str
    picture: str | None = None
    googleId: str


class UserOut(BaseModel):
    id: str
    email: str
    name: str
    picture: str | None
    credits: int
    planCode: str
    planStatus: str
    createdAt: str


class LoginResponse(BaseModel):
    user: UserOut
    token: str


class VerifyRequest(BaseModel):
    token: str


class VerifyResponse(BaseModel):
    user: UserOut


class CreditsUpdateRequest(BaseModel):
    credits: int


class HistoryItemRequest(BaseModel):
    type: str
    content: str | None = None
    style_prompt: str | None = None
    model: str | None = None
    meta: str | None = None
    duration: str | None = None


class PricingPlanOut(BaseModel):
    code: str
    name: str
    priceUsd: float | None = None
    billingType: str
    creditsIncluded: int
    creditsPerPack: int | None = None
    cryptoPriceUsd: float | None = None
    cryptoCreditsIncluded: int | None = None
    priceSubtitle: str | None = None
    description: str | None = None
    highlighted: bool = False
    ctaLabel: str
    features: list[str]


class PricingPlansResponse(BaseModel):
    plans: list[PricingPlanOut]


class CreditTransactionOut(BaseModel):
    id: str
    transactionType: str
    amount: int
    balanceAfter: int
    description: str
    referenceType: str | None = None
    referenceId: str | None = None
    createdAt: str


class AccountSummaryResponse(BaseModel):
    user: UserOut
    plan: PricingPlanOut | None = None
    transactions: list[CreditTransactionOut]
    totalTtsGenerations: int
    totalCreditsUsed: int


class CheckoutSessionRequest(BaseModel):
    provider: str
    planCode: str
    payCurrency: str | None = None


class NowPaymentsPayCurrencyOptionOut(BaseModel):
    ticker: str
    label: str
    hint: str | None = None


class NowPaymentsPayCurrencyOptionsOut(BaseModel):
    planCode: str
    defaultTicker: str
    currencies: list[NowPaymentsPayCurrencyOptionOut]


class CheckoutSessionResponse(BaseModel):
    sessionId: str
    provider: str
    status: str
    checkoutUrl: str | None = None
    amountUsd: float
    creditsGranted: int
    message: str | None = None


class SalesContactRequest(BaseModel):
    name: str
    email: str
    company: str | None = None
    message: str


class DeveloperKeyCreateRequest(BaseModel):
    name: str


class DeveloperKeyOut(BaseModel):
    id: str
    name: str
    keyPrefix: str
    tier: str
    rateLimitRpm: int
    lastUsedAt: str | None = None
    revokedAt: str | None = None
    createdAt: str
    updatedAt: str


class DeveloperKeyCreateResponse(BaseModel):
    key: DeveloperKeyOut
    plainKey: str


class DeveloperKeysListResponse(BaseModel):
    keys: list[DeveloperKeyOut]


class DeveloperUsageLogOut(BaseModel):
    id: str
    endpoint: str
    provider: str | None = None
    status: str
    httpStatus: int
    creditsUsed: int
    requestChars: int | None = None
    latencyMs: int | None = None
    errorCode: str | None = None
    errorMessage: str | None = None
    createdAt: str


class DeveloperUsageResponse(BaseModel):
    logs: list[DeveloperUsageLogOut]


def _api_rate_limit_for_tier(tier: str) -> int:
    return int(os.environ.get("API_RATE_LIMIT_REQUESTS_PER_MINUTE", "4"))


def _developer_key_row_to_out(row) -> DeveloperKeyOut:
    rpm = int(row["rate_limit_rpm"]) if row["rate_limit_rpm"] is not None else _api_rate_limit_for_tier(row["tier"] or "normal")
    return DeveloperKeyOut(
        id=row["id"],
        name=row["name"],
        keyPrefix=row["key_prefix"],
        tier=row["tier"] or "normal",
        rateLimitRpm=rpm,
        lastUsedAt=row["last_used_at"],
        revokedAt=row["revoked_at"],
        createdAt=row["created_at"],
        updatedAt=row["updated_at"],
    )


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _user_row_to_out(row) -> UserOut:
    return UserOut(
        id=row["id"],
        email=row["email"],
        name=row["name"],
        picture=row["picture"],
        credits=int(row["credits"] or 0),
        planCode=row["plan_code"] or "normal",
        planStatus=row["plan_status"] or "active",
        createdAt=row["created_at"],
    )


def _make_token(user_id: str, email: str) -> str:
    payload = {
        "userId": user_id,
        "email": email,
        "exp": datetime.now(timezone.utc) + timedelta(days=JWT_EXPIRY_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc


async def _get_user_by_id(user_id: str) -> UserOut | None:
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            SELECT id, email, name, picture, credits, plan_code, plan_status, created_at
            FROM auth_users WHERE id = ?
            """,
            (user_id,),
        )
        row = await cursor.fetchone()
        return _user_row_to_out(row) if row else None
    finally:
        await conn.close()


def require_auth(authorization: str | None = Header(None, alias="Authorization")) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="No token provided")
    token = authorization.split(" ", 1)[1]
    decoded = _decode_token(token)
    return decoded["userId"]


def require_admin_session(authorization: str | None = Header(None, alias="Authorization")) -> str:
    """Session-backed admin guard.

    Requires a valid JWT issued by Google OAuth login AND that the decoded
    email matches ADMIN_EMAIL. Replaces the weak ``X-Admin-Email`` header check
    (anyone who knew the admin email could forge it).

    Returns the verified admin email.
    """
    admin_email = (os.environ.get("ADMIN_EMAIL") or "").strip().lower()
    if not admin_email:
        raise HTTPException(status_code=503, detail="Admin email not configured")
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="No token provided")
    token = authorization.split(" ", 1)[1]
    decoded = _decode_token(token)
    email = (decoded.get("email") or "").strip().lower()
    if not email or email != admin_email:
        raise HTTPException(status_code=403, detail="Admin access required")
    return email


async def _get_plan(conn, plan_code: str) -> PricingPlanOut | None:
    cursor = await conn.execute(
        """
        SELECT code, name, price_usd, billing_type, credits_included, credits_per_pack,
               crypto_price_usd, crypto_credits_included,
               price_subtitle, description, is_highlighted, cta_label, features_json
        FROM pricing_plans
        WHERE code = ? AND is_active = 1
        """,
        (plan_code,),
    )
    row = await cursor.fetchone()
    if not row:
        return None
    return PricingPlanOut(
        code=row["code"],
        name=row["name"],
        priceUsd=float(row["price_usd"]) if row["price_usd"] is not None else None,
        billingType=row["billing_type"],
        creditsIncluded=int(row["credits_included"] or 0),
        creditsPerPack=int(row["credits_per_pack"]) if row["credits_per_pack"] is not None else None,
        cryptoPriceUsd=float(row["crypto_price_usd"]) if row["crypto_price_usd"] is not None else None,
        cryptoCreditsIncluded=int(row["crypto_credits_included"])
        if row["crypto_credits_included"] is not None
        else None,
        priceSubtitle=row["price_subtitle"],
        description=row["description"],
        highlighted=bool(row["is_highlighted"]),
        ctaLabel=row["cta_label"] or "Select plan",
        features=json.loads(row["features_json"] or "[]"),
    )


def _plan_crypto_list_usd(plan: PricingPlanOut) -> float:
    if plan.cryptoPriceUsd is not None:
        return float(plan.cryptoPriceUsd)
    return float(plan.priceUsd or 0)


def _plan_crypto_credits(plan: PricingPlanOut) -> int:
    if plan.cryptoCreditsIncluded is not None:
        return int(plan.cryptoCreditsIncluded)
    return int(plan.creditsIncluded)


def _crypto_checkout_url(plan_code: str) -> str | None:
    return (os.environ.get(f"CRYPTO_CHECKOUT_URL_{plan_code.upper()}") or os.environ.get("CRYPTO_CHECKOUT_URL") or "").strip() or None


def _nowpayments_api_base() -> str:
    return (os.environ.get("NOWPAYMENTS_API_BASE") or "https://api.nowpayments.io/v1").strip().rstrip("/")


def _nowpayments_webhook_url() -> str:
    return (
        os.environ.get("NOWPAYMENTS_IPN_CALLBACK_URL")
        or "https://backend.vocence.ai/api/payments/nowpayments/webhook"
    ).strip()


def _nowpayments_success_url() -> str:
    return (
        os.environ.get("NOWPAYMENTS_SUCCESS_URL")
        or os.environ.get("STRIPE_SUCCESS_URL")
        or "https://www.vocence.ai/account?tab=credits&checkout=success"
    ).strip()


def _nowpayments_cancel_url() -> str:
    return (
        os.environ.get("NOWPAYMENTS_CANCEL_URL")
        or os.environ.get("STRIPE_CANCEL_URL")
        or "https://www.vocence.ai/pricing?checkout=cancel"
    ).strip()


def _nowpayments_pay_currency(plan_code: str) -> str:
    return (
        os.environ.get(f"NOWPAYMENTS_PAY_CURRENCY_{plan_code.upper()}")
        or os.environ.get("NOWPAYMENTS_PAY_CURRENCY_DEFAULT")
        or "usdttrc20"
    ).strip().lower()


_NP_PAY_CURRENCY_LABELS: dict[str, tuple[str, str | None]] = {
    "usdttrc20": ("USDT (Tron · TRC-20)", "Often the lowest USDT transfer fees."),
    "usdterc20": ("USDT (Ethereum · ERC-20)", "Higher gas than Tron; use if you only hold ERC-20 USDT."),
    "usdtmatic": ("USDT (Polygon)", "Usually cheaper than Ethereum mainnet."),
    "usdtarc20": ("USDT (Arbitrum One)", "Layer 2; typically lower cost than mainnet."),
    "usdtop": ("USDT (Optimism)", "Layer 2; competitive fees."),
    "usdtsol": ("USDT (Solana)", "Fast; network fees are often low."),
    "usdcbsc": ("USDC (BNB Smart Chain)", "Use if you prefer USDC on BSC."),
}


def _nowpayments_user_selectable_pay_currencies(plan_code: str) -> list[str]:
    """Currencies offered in checkout UI. Override with NOWPAYMENTS_SELECTABLE_PAY_CURRENCIES."""
    raw = (os.environ.get("NOWPAYMENTS_SELECTABLE_PAY_CURRENCIES") or "").strip()
    default_pc = _nowpayments_pay_currency(plan_code)
    if raw:
        return sorted({p.strip().lower() for p in raw.split(",") if p.strip()})
    return _nowpayments_pay_currencies_to_validate(default_pc)


def _nowpayments_pay_currency_option_row(ticker: str) -> NowPaymentsPayCurrencyOptionOut:
    t = ticker.strip().lower()
    label, hint = _NP_PAY_CURRENCY_LABELS.get(t, (t.upper(), None))
    return NowPaymentsPayCurrencyOptionOut(ticker=t, label=label, hint=hint)


def _resolve_checkout_pay_currency(plan_code: str, requested: str | None) -> str:
    allowed = _nowpayments_user_selectable_pay_currencies(plan_code)
    allowed_set = set(allowed)
    default_pc = _nowpayments_pay_currency(plan_code).strip().lower()
    if not requested or not str(requested).strip():
        return default_pc
    r = str(requested).strip().lower()
    if r not in allowed_set:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported pay currency '{requested}'. Allowed: {', '.join(allowed)}.",
        )
    return r


def _nowpayments_success_statuses() -> set[str]:
    raw = (os.environ.get("NOWPAYMENTS_SUCCESS_STATUSES") or "finished,confirmed").strip()
    return {s.strip().lower() for s in raw.split(",") if s.strip()}


def _verify_nowpayments_signature(payload: bytes, signature: str | None) -> bool:
    secret = (os.environ.get("NOWPAYMENTS_IPN_SECRET") or "").strip()
    if not secret or not signature:
        return False
    digest = hmac.new(secret.encode("utf-8"), payload, hashlib.sha512).hexdigest()
    return hmac.compare_digest(digest.lower(), signature.strip().lower())


def _nowpayments_env_bool(key: str, *, default: bool) -> bool:
    raw = (os.environ.get(key) or "").strip().lower()
    if raw in {"1", "true", "yes", "on"}:
        return True
    if raw in {"0", "false", "no", "off"}:
        return False
    return default


def _nowpayments_invoice_extra_usd() -> float:
    """Optional extra USD added after API-based minimum resolution (same credits). Default 0."""
    raw = os.environ.get("NOWPAYMENTS_INVOICE_BUFFER_USD")
    if raw is None or str(raw).strip() == "":
        return 0.0
    try:
        return max(0.0, float(str(raw).strip()))
    except ValueError:
        return 0.0


def _nowpayments_fallback_flat_buffer_usd() -> float:
    """Used only when dynamic resolution is off. Flat add to plan USD."""
    raw = os.environ.get("NOWPAYMENTS_LEGACY_FLAT_BUFFER_USD")
    if raw is None or str(raw).strip() == "":
        return 0.0
    try:
        return max(0.0, float(str(raw).strip()))
    except ValueError:
        return 0.0


def _nowpayments_pay_currencies_to_validate(pay_currency: str) -> list[str]:
    """Currencies to pre-validate so hosted UI coin switches (e.g. TRC→ERC) do not fail after invoice."""
    raw = os.environ.get("NOWPAYMENTS_VALIDATE_EXTRA_CURRENCIES")
    pc = pay_currency.strip().lower()
    if raw is not None and raw.strip() == "":
        return [pc]
    if raw and raw.strip():
        out = {pc}
        for part in raw.split(","):
            p = part.strip().lower()
            if p:
                out.add(p)
        return sorted(out)
    twins = {"usdttrc20", "usdterc20"}
    twins.add(pc)
    return sorted(twins)


async def _nowpayments_validate_crypto_amount(
    *,
    api_key: str,
    amount_usd: float,
    pay_currency: str,
    payout_currency: str,
) -> None:
    """Block checkout early if USD price converts to crypto below NOWPayments' pair minimum."""
    if _nowpayments_env_bool("NOWPAYMENTS_SKIP_MIN_AMOUNT_CHECK", default=False):
        return
    base = _nowpayments_api_base()
    headers = {"x-api-key": api_key}
    timeout = aiohttp.ClientTimeout(total=20)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(
                f"{base}/min-amount",
                params={"currency_from": pay_currency, "currency_to": payout_currency},
                headers=headers,
            ) as resp:
                text = await resp.text()
                if resp.status != 200:
                    _np_log.warning("NOWPayments min-amount HTTP %s: %s", resp.status, text[:400])
                    return
                min_data = json.loads(text)
            if min_data.get("status") is False or min_data.get("statusCode"):
                _np_log.warning("NOWPayments min-amount error payload: %s", text[:400])
                return
            raw_min = min_data.get("min_amount")
            if raw_min is None:
                return
            min_amt = float(raw_min)

            async with session.get(
                f"{base}/estimate",
                params={
                    "amount": f"{round(float(amount_usd), 2):.2f}",
                    "currency_from": "usd",
                    "currency_to": pay_currency,
                },
                headers=headers,
            ) as resp:
                text = await resp.text()
                if resp.status != 200:
                    _np_log.warning("NOWPayments estimate HTTP %s: %s", resp.status, text[:400])
                    return
                est_data = json.loads(text)
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, json.JSONDecodeError) as exc:
        _np_log.warning("NOWPayments pre-check skipped: %s", exc)
        return

    if est_data.get("status") is False or est_data.get("statusCode"):
        _np_log.warning("NOWPayments estimate error payload: %s", est_data)
        return

    est_raw = (
        est_data.get("estimated_amount")
        or est_data.get("estimated_amount_to")
        or est_data.get("estimatedAmount")
    )
    if est_raw is None:
        return
    est = float(est_raw)
    if min_amt > 0 and est + 1e-12 < min_amt:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Crypto amount is below NOWPayments minimum for {pay_currency} (payout {payout_currency}): "
                f"need at least {min_amt:g} {pay_currency}, this invoice is about {est:g} {pay_currency}. "
                f"Increase the plan price, pick another pay currency, or set NOWPAYMENTS_PAYOUT_CURRENCY to "
                f"your dashboard main wallet ticker (e.g. usdttrc20 vs usdterc20)."
            ),
        )


async def _np_min_amount_pair(
    session: aiohttp.ClientSession,
    base: str,
    headers: dict[str, str],
    pay_cur: str,
    payout_cur: str,
) -> float | None:
    async with session.get(
        f"{base}/min-amount",
        params={"currency_from": pay_cur, "currency_to": payout_cur},
        headers=headers,
    ) as resp:
        text = await resp.text()
        if resp.status != 200:
            return None
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return None
    if data.get("status") is False or data.get("statusCode"):
        return None
    raw = data.get("min_amount")
    if raw is None:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


async def _np_estimate_usd_to_coin(
    session: aiohttp.ClientSession,
    base: str,
    headers: dict[str, str],
    usd: float,
    pay_cur: str,
) -> float | None:
    async with session.get(
        f"{base}/estimate",
        params={
            "amount": f"{round(float(usd), 2):.2f}",
            "currency_from": "usd",
            "currency_to": pay_cur,
        },
        headers=headers,
    ) as resp:
        text = await resp.text()
        if resp.status != 200:
            return None
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return None
    if data.get("status") is False or data.get("statusCode"):
        return None
    raw = data.get("estimated_amount") or data.get("estimated_amount_to") or data.get("estimatedAmount")
    if raw is None:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        return None


async def _nowpayments_resolve_invoice_usd(
    *,
    api_key: str,
    plan_price: float,
    payout_currency: str,
    currencies: list[str],
) -> float:
    """
    Pick the smallest invoice USD (>= list price) so NP estimate meets /min-amount for each
    validated pay currency—avoids a fixed $6 markup when only ~$1–2 is needed.
    """
    if not _nowpayments_env_bool("NOWPAYMENTS_USE_DYNAMIC_INVOICE_USD", default=True):
        return round(float(plan_price), 2)

    base = _nowpayments_api_base()
    headers = {"x-api-key": api_key}
    timeout = aiohttp.ClientTimeout(total=35)
    plan_price = round(float(plan_price), 2)
    needed = plan_price
    try:
        fudge = max(1.0, float(os.environ.get("NOWPAYMENTS_DYNAMIC_RESOLVE_FUDGE", "1.02") or 1.02))
    except ValueError:
        fudge = 1.02

    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            for _ in range(12):
                max_scale = 1.0
                any_ok = False
                any_short = False
                for pay_cur in currencies:
                    min_amt = await _np_min_amount_pair(session, base, headers, pay_cur, payout_currency)
                    est = await _np_estimate_usd_to_coin(session, base, headers, needed, pay_cur)
                    if min_amt is None or est is None or min_amt <= 0 or est <= 0:
                        continue
                    any_ok = True
                    if est + 1e-12 < min_amt:
                        any_short = True
                        max_scale = max(max_scale, min_amt / est)
                if not any_short or not any_ok:
                    break
                needed = round(needed * max_scale * fudge, 2)
                if needed > plan_price * 100:
                    break
    except (aiohttp.ClientError, asyncio.TimeoutError, ValueError, json.JSONDecodeError) as exc:
        _np_log.warning("NOWPayments dynamic invoice USD failed: %s", exc)
        return plan_price

    return round(max(plan_price, needed), 2)


async def _create_nowpayments_invoice(
    *,
    session_id: str,
    plan_code: str,
    amount_usd: float,
    user_id: str,
    user_email: str | None,
    credits_granted: int,
    pay_currency: str,
) -> tuple[dict, float]:
    api_key = (os.environ.get("NOWPAYMENTS_API_KEY") or "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="NOWPAYMENTS_API_KEY is not configured")

    pay_currency = pay_currency.strip().lower()
    payout_currency = (os.environ.get("NOWPAYMENTS_PAYOUT_CURRENCY") or pay_currency).strip().lower()
    plan_price = round(float(amount_usd), 2)
    try:
        floor = max(0.0, float(os.environ.get("NOWPAYMENTS_MIN_INVOICE_USD", "0") or 0))
    except ValueError:
        floor = 0.0

    currencies = [pay_currency]
    if _nowpayments_env_bool("NOWPAYMENTS_USE_DYNAMIC_INVOICE_USD", default=True):
        price_for_np = await _nowpayments_resolve_invoice_usd(
            api_key=api_key,
            plan_price=plan_price,
            payout_currency=payout_currency,
            currencies=currencies,
        )
        price_for_np = round(max(price_for_np, floor), 2)
    else:
        price_for_np = round(max(plan_price + _nowpayments_fallback_flat_buffer_usd(), floor), 2)
    price_for_np = round(price_for_np + _nowpayments_invoice_extra_usd(), 2)

    for cur in currencies:
        await _nowpayments_validate_crypto_amount(
            api_key=api_key,
            amount_usd=price_for_np,
            pay_currency=cur,
            payout_currency=payout_currency,
        )

    payload: dict = {
        "price_amount": price_for_np,
        "price_currency": "usd",
        "order_id": session_id,
        "order_description": f"Vocence {plan_code} plan ({credits_granted} credits)",
        "ipn_callback_url": _nowpayments_webhook_url(),
        "success_url": _nowpayments_success_url(),
        "cancel_url": _nowpayments_cancel_url(),
        # Floating rate often avoids "currency unavailable" / fixed-quote failures on NP hosted checkout.
        "is_fixed_rate": _nowpayments_env_bool("NOWPAYMENTS_IS_FIXED_RATE", default=False),
        # Customer pays network/service fees so the amount credited to your wallet ("amountTo") stays viable.
        "is_fee_paid_by_user": _nowpayments_env_bool("NOWPAYMENTS_IS_FEE_PAID_BY_USER", default=True),
        "customer_email": user_email or "",
    }
    if not _nowpayments_env_bool("NOWPAYMENTS_INVOICE_OMIT_PAY_CURRENCY", default=False):
        payload["pay_currency"] = pay_currency

    url = f"{_nowpayments_api_base()}/invoice"
    headers = {
        "x-api-key": api_key,
        "Content-Type": "application/json",
    }
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url, json=payload, headers=headers) as resp:
            text = await resp.text()
            if resp.status >= 400:
                raise HTTPException(status_code=502, detail=f"NOWPayments invoice error {resp.status}: {text[:500]}")
            try:
                parsed = json.loads(text)
            except json.JSONDecodeError as exc:
                raise HTTPException(status_code=502, detail=f"NOWPayments invalid JSON response: {text[:300]}") from exc
            return parsed, price_for_np


def _sales_inquiry_body(*, name: str, email: str, company: str | None, message: str) -> str:
    return (
        f"Name: {name}\n"
        f"Email: {email}\n"
        f"Company: {company or '-'}\n\n"
        f"Message:\n{message}\n"
    )


def _send_sales_via_resend_sync(*, name: str, email: str, company: str | None, message: str) -> None:
    """Send via Resend HTTPS API (works when Microsoft 365 disables SMTP AUTH)."""
    api_key = (os.environ.get("RESEND_API_KEY") or "").strip()
    if not api_key:
        raise HTTPException(status_code=503, detail="RESEND_API_KEY is not configured")

    from_header = (os.environ.get("RESEND_FROM") or os.environ.get("SMTP_FROM") or "").strip()
    if not from_header:
        raise HTTPException(
            status_code=503,
            detail=(
                "RESEND_FROM is not configured. Example: Vocence <onboarding@resend.dev> "
                "(testing) or your domain after verifying it in Resend."
            ),
        )

    to_email = (os.environ.get("SALES_EMAIL_TO") or "space@vocence.ai").strip()
    subject = f"Vocence Enterprise Inquiry - {name}"
    text = _sales_inquiry_body(name=name, email=email, company=company, message=message)

    payload = {
        "from": from_header,
        "to": [to_email],
        "reply_to": email,
        "subject": subject,
        "text": text,
    }
    req = urllib.request.Request(
        "https://api.resend.com/emails",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            # Resend returns 403 / error 1010 if User-Agent is missing (urllib may omit it).
            "User-Agent": "VocenceDashboard/1.0 (+https://vocence.ai)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Resend HTTP {e.code}: {err_body}") from e


def _send_sales_via_smtp_sync(*, name: str, email: str, company: str | None, message: str) -> None:
    smtp_host = (os.environ.get("SMTP_HOST") or "").strip()
    smtp_user = (os.environ.get("SMTP_USERNAME") or "").strip()
    smtp_password = (os.environ.get("SMTP_PASSWORD") or "").strip()
    if not smtp_host:
        raise HTTPException(status_code=503, detail="SMTP_HOST is not configured")
    if not smtp_user or not smtp_password:
        raise HTTPException(status_code=503, detail="SMTP credentials are not configured")

    smtp_port = int((os.environ.get("SMTP_PORT") or "587").strip())
    use_tls = (os.environ.get("SMTP_USE_TLS", "true").strip().lower() in {"1", "true", "yes"})
    from_email = (os.environ.get("SMTP_FROM") or smtp_user).strip()
    to_email = (os.environ.get("SALES_EMAIL_TO") or "space@vocence.ai").strip()

    email_msg = EmailMessage()
    email_msg["Subject"] = f"Vocence Enterprise Inquiry - {name}"
    email_msg["From"] = from_email
    email_msg["To"] = to_email
    email_msg["Reply-To"] = email
    email_msg.set_content(_sales_inquiry_body(name=name, email=email, company=company, message=message))

    with smtplib.SMTP(smtp_host, smtp_port, timeout=20) as server:
        if use_tls:
            server.starttls()
        server.login(smtp_user, smtp_password)
        server.send_message(email_msg)


def _send_sales_email_sync(*, name: str, email: str, company: str | None, message: str) -> None:
    """Prefer Resend when RESEND_API_KEY is set; otherwise use SMTP."""
    if (os.environ.get("RESEND_API_KEY") or "").strip():
        _send_sales_via_resend_sync(name=name, email=email, company=company, message=message)
    else:
        _send_sales_via_smtp_sync(name=name, email=email, company=company, message=message)


async def _get_user_row(conn, user_id: str):
    return await (
        await conn.execute(
            """
            SELECT id, email, name, picture, credits, plan_code, plan_status, created_at
            FROM auth_users
            WHERE id = ?
            """,
            (user_id,),
        )
    ).fetchone()


async def _record_webhook_event(conn, event_id: str, event_type: str, object_id: str | None) -> bool:
    existing = await (
        await conn.execute("SELECT event_id FROM stripe_webhook_events WHERE event_id = ?", (event_id,))
    ).fetchone()
    if existing:
        return False
    await conn.execute(
        """
        INSERT INTO stripe_webhook_events (event_id, event_type, object_id, created_at, processed_at)
        VALUES (?, ?, ?, datetime('now'), datetime('now'))
        """,
        (event_id, event_type, object_id),
    )
    return True


async def _apply_credits_once(
    conn,
    *,
    payment_row,
    user_id: str,
    credits: int,
    description: str,
    reference_type: str,
    reference_id: str,
    plan_code: str | None,
) -> bool:
    if payment_row["credits_applied_at"]:
        return False
    user_row = await _get_user_row(conn, user_id)
    if user_row is None:
        raise HTTPException(status_code=404, detail="User not found for payment")
    new_balance = int(user_row["credits"] or 0) + int(credits)
    updates = [
        "credits = ?",
        "updated_at = ?",
    ]
    params: list[object] = [new_balance, _now_iso()]
    if plan_code == "premium":
        updates.extend(["plan_code = ?", "plan_status = ?"])
        params.extend(["premium", "active"])
    await conn.execute(
        f"UPDATE auth_users SET {', '.join(updates)} WHERE id = ?",
        (*params, user_id),
    )
    await record_credit_transaction(
        conn,
        user_id=user_id,
        transaction_type="payment_credit",
        amount=int(credits),
        balance_after=new_balance,
        description=description,
        reference_type=reference_type,
        reference_id=reference_id,
        metadata={"plan_code": plan_code},
    )
    await conn.execute(
        "UPDATE payments SET credits_applied_at = ?, updated_at = ? WHERE id = ?",
        (_now_iso(), _now_iso(), payment_row["id"]),
    )
    return True


async def _find_payment_by_invoice(conn, invoice_id: str):
    return await (
        await conn.execute("SELECT * FROM payments WHERE stripe_invoice_id = ?", (invoice_id,))
    ).fetchone()


async def _find_payment_by_checkout_session(conn, checkout_session_id: str):
    return await (
        await conn.execute("SELECT * FROM payments WHERE stripe_checkout_session_id = ?", (checkout_session_id,))
    ).fetchone()


async def _find_payment_by_provider_payment_id(conn, provider_payment_id: str):
    return await (
        await conn.execute("SELECT * FROM payments WHERE provider_payment_id = ?", (provider_payment_id,))
    ).fetchone()


async def _find_payment_session_by_checkout(conn, checkout_session_id: str):
    return await (
        await conn.execute("SELECT * FROM payment_sessions WHERE stripe_checkout_session_id = ?", (checkout_session_id,))
    ).fetchone()


async def _find_payment_session_by_subscription(conn, subscription_id: str):
    return await (
        await conn.execute("SELECT * FROM payment_sessions WHERE stripe_subscription_id = ?", (subscription_id,))
    ).fetchone()


async def _find_payment_session_by_id(conn, session_id: str):
    return await (
        await conn.execute("SELECT * FROM payment_sessions WHERE id = ?", (session_id,))
    ).fetchone()


def _nested_get(payload: dict, *path, default=None):
    current = payload
    for key in path:
        if not isinstance(current, dict):
            return default
        current = current.get(key)
        if current is None:
            return default
    return current


def _extract_invoice_period(invoice: dict) -> tuple[str | None, str | None]:
    lines = _nested_get(invoice, "lines", "data", default=[])
    if isinstance(lines, list):
        for line in lines:
            period = line.get("period") if isinstance(line, dict) else None
            if isinstance(period, dict):
                start = period.get("start")
                end = period.get("end")
                start_iso = datetime.fromtimestamp(start, timezone.utc).isoformat().replace("+00:00", "Z") if isinstance(start, int) else None
                end_iso = datetime.fromtimestamp(end, timezone.utc).isoformat().replace("+00:00", "Z") if isinstance(end, int) else None
                if start_iso or end_iso:
                    return start_iso, end_iso
    return None, None


def _invoice_metadata(invoice: dict) -> dict[str, str]:
    candidates = [
        invoice.get("metadata"),
        _nested_get(invoice, "parent", "subscription_details", "metadata"),
        _nested_get(invoice, "subscription_details", "metadata"),
    ]
    for candidate in candidates:
        if isinstance(candidate, dict) and candidate:
            return {str(k): str(v) for k, v in candidate.items() if v is not None}
    return {}


async def _mark_session_status(conn, session_row, status: str, **extra_fields) -> None:
    updates = ["status = ?", "updated_at = ?"]
    params: list[object] = [status, _now_iso()]
    for key, value in extra_fields.items():
        updates.append(f"{key} = ?")
        params.append(value)
    params.append(session_row["id"])
    await conn.execute(
        f"UPDATE payment_sessions SET {', '.join(updates)} WHERE id = ?",
        tuple(params),
    )


async def _update_payment_row(conn, payment_row, **fields) -> None:
    updates = ["updated_at = ?"]
    params: list[object] = [_now_iso()]
    for key, value in fields.items():
        updates.append(f"{key} = ?")
        params.append(value)
    params.append(payment_row["id"])
    await conn.execute(
        f"UPDATE payments SET {', '.join(updates)} WHERE id = ?",
        tuple(params),
    )


async def _create_subscription_payment(
    conn,
    *,
    session_row,
    invoice_id: str,
    payment_intent_id: str | None,
    customer_id: str | None,
    subscription_id: str,
    amount_usd: float,
    credits_granted: int,
    billing_period_start: str | None,
    billing_period_end: str | None,
    event_id: str,
) :
    payment_id = uuid.uuid4().hex
    await conn.execute(
        """
        INSERT INTO payments
        (id, session_id, user_id, provider, plan_code, amount_usd, credits_granted, currency, status,
         stripe_invoice_id, stripe_payment_intent_id, stripe_subscription_id, stripe_customer_id, stripe_event_id,
         mode, billing_period_start, billing_period_end, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, 'stripe', ?, ?, ?, 'USD', 'paid', ?, ?, ?, ?, ?, 'subscription', ?, ?, ?, datetime('now'), datetime('now'))
        """,
        (
            payment_id,
            session_row["id"],
            session_row["user_id"],
            session_row["plan_code"],
            amount_usd,
            credits_granted,
            invoice_id,
            payment_intent_id,
            subscription_id,
            customer_id,
            event_id,
            billing_period_start,
            billing_period_end,
            session_row["metadata_json"] or "{}",
        ),
    )
    return await (await conn.execute("SELECT * FROM payments WHERE id = ?", (payment_id,))).fetchone()


@router.post("/auth/login", response_model=LoginResponse)
async def auth_login(body: LoginRequest):
    if not body.email or not body.name or not body.googleId:
        raise HTTPException(status_code=400, detail="Missing required fields")
    await ensure_tables()
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            SELECT id, email, name, picture, credits, plan_code, plan_status, created_at
            FROM auth_users WHERE email = ?
            """,
            (body.email,),
        )
        row = await cursor.fetchone()
        now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        if row is not None:
            await conn.execute(
                """
                UPDATE auth_users
                SET name = ?, picture = ?, updated_at = ?, last_login_at = ?
                WHERE id = ?
                """,
                (body.name, body.picture or None, now, now, row["id"]),
            )
            await conn.execute(
                """
                INSERT INTO registered_users (email, name, picture, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET
                    name = excluded.name,
                    picture = excluded.picture,
                    updated_at = excluded.updated_at
                """,
                (body.email, body.name, body.picture or None, row["created_at"], now),
            )
            await conn.commit()
            user_out = await _get_user_by_id(row["id"])
            if user_out is None:
                raise HTTPException(status_code=500, detail="Failed to load user")
            return LoginResponse(user=user_out, token=_make_token(user_out.id, user_out.email))

        await conn.execute(
            """
            INSERT INTO auth_users
            (id, email, name, picture, credits, plan_code, plan_status, created_at, updated_at, last_login_at)
            VALUES (?, ?, ?, ?, ?, 'normal', 'active', ?, ?, ?)
            """,
            (body.googleId, body.email, body.name, body.picture or None, SIGNUP_CREDITS, now, now, now),
        )
        await conn.execute(
            """
            INSERT INTO registered_users (email, name, picture, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET
                name = excluded.name,
                picture = excluded.picture,
                updated_at = excluded.updated_at
            """,
            (body.email, body.name, body.picture or None, now, now),
        )
        await record_credit_transaction(
            conn,
            user_id=body.googleId,
            transaction_type="signup_bonus",
            amount=SIGNUP_CREDITS,
            balance_after=SIGNUP_CREDITS,
            description=f"Welcome bonus: {SIGNUP_CREDITS} free credits",
            reference_type="signup",
            reference_id=body.googleId,
        )
        await conn.commit()
        user_out = await _get_user_by_id(body.googleId)
        if user_out is None:
            raise HTTPException(status_code=500, detail="Failed to create user")
        return LoginResponse(user=user_out, token=_make_token(user_out.id, user_out.email))
    finally:
        await conn.close()


@router.post("/auth/verify", response_model=VerifyResponse)
async def auth_verify(body: VerifyRequest):
    if not body.token:
        raise HTTPException(status_code=400, detail="No token provided")
    decoded = _decode_token(body.token)
    user = await _get_user_by_id(decoded["userId"])
    if user is None:
        raise HTTPException(status_code=401, detail="User not found")
    return VerifyResponse(user=user)


@router.get("/users/{user_id}", response_model=UserOut)
async def get_user(user_id: str, userId: str = Depends(require_auth)):
    if user_id != userId:
        raise HTTPException(status_code=403, detail="Unauthorized")
    user = await _get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.patch("/users/{user_id}/credits", response_model=UserOut)
async def update_credits(user_id: str, body: CreditsUpdateRequest, userId: str = Depends(require_auth)):
    if user_id != userId:
        raise HTTPException(status_code=403, detail="Unauthorized")
    conn = await get_connection()
    try:
        cursor = await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
        row = await cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        previous = int(row["credits"] or 0)
        await conn.execute(
            "UPDATE auth_users SET credits = ?, updated_at = datetime('now') WHERE id = ?",
            (body.credits, user_id),
        )
        await record_credit_transaction(
            conn,
            user_id=user_id,
            transaction_type="manual_adjustment",
            amount=body.credits - previous,
            balance_after=body.credits,
            description="Manual credit adjustment",
            reference_type="user",
            reference_id=user_id,
        )
        # Keep the website usage credit graph up-to-date for manual credit deductions
        # (e.g. chat demo in the frontend).
        await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())
        await conn.commit()
    finally:
        await conn.close()
    user = await _get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=500, detail="Failed to fetch updated user")
    return user


class DailyCreditsDayResponse(BaseModel):
    day: str
    creditsUsed: int


class DailyCreditsUsageResponse(BaseModel):
    days: list[DailyCreditsDayResponse]
    totalCreditsUsed: int


@router.get("/account/credits/usage/daily", response_model=DailyCreditsUsageResponse)
async def get_daily_credits_usage(
    days: int = Query(14, ge=1, le=60),
    userId: str = Depends(require_auth),
):
    """
    Daily credits consumed by the current user.
    Includes all credit-consuming flows recorded in `credit_transactions` (studio TTS, Developer API, and manual adjustments like chat demo).
    """
    await ensure_tables()
    conn = await get_connection()
    try:
        end = datetime.now(timezone.utc).date()
        start = end - timedelta(days=days - 1)
        start_iso = start.isoformat()

        rows = await (
            await conn.execute(
                """
                SELECT date(created_at) AS day,
                       COALESCE(SUM(-amount), 0) AS credits_used
                FROM credit_transactions
                WHERE user_id = ?
                  AND amount < 0
                  AND date(created_at) >= date(?)
                GROUP BY date(created_at)
                ORDER BY date(created_at) ASC
                """,
                (userId, start_iso),
            )
        ).fetchall()

        by_day: dict[str, int] = {}
        for r in rows:
            by_day[str(r["day"])] = int(r["credits_used"] or 0)

        day_items: list[DailyCreditsDayResponse] = []
        total = 0
        for i in range(days):
            d = (start + timedelta(days=i)).isoformat()
            v = by_day.get(d, 0)
            total += v
            day_items.append(DailyCreditsDayResponse(day=d, creditsUsed=v))

        return DailyCreditsUsageResponse(days=day_items, totalCreditsUsed=total)
    finally:
        await conn.close()


@router.post("/history")
async def post_history(body: HistoryItemRequest, userId: str = Depends(require_auth)):
    history_id = str(int(datetime.now(timezone.utc).timestamp() * 1000))
    conn = await get_connection()
    try:
        await conn.execute(
            """
            INSERT INTO auth_history (id, user_id, type, content, style_prompt, model, meta, duration, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            """,
            (
                history_id,
                userId,
                body.type,
                body.content,
                body.style_prompt,
                body.model,
                body.meta,
                body.duration,
            ),
        )
        await conn.commit()
        return {"id": history_id, "success": True}
    finally:
        await conn.close()


@router.get("/history")
async def get_history(userId: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            SELECT id, user_id, type, content, style_prompt, model, meta, duration, created_at
            FROM auth_history WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
            """,
            (userId,),
        )
        rows = await cursor.fetchall()
        return [
            {
                "id": r["id"],
                "user_id": r["user_id"],
                "type": r["type"],
                "content": r["content"],
                "style_prompt": r["style_prompt"],
                "model": r["model"],
                "meta": r["meta"],
                "duration": r["duration"],
                "created_at": r["created_at"],
            }
            for r in rows
        ]
    finally:
        await conn.close()


@router.get("/pricing/plans", response_model=PricingPlansResponse)
async def get_pricing_plans():
    await ensure_tables()
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            SELECT code, name, price_usd, billing_type, credits_included, credits_per_pack,
                   crypto_price_usd, crypto_credits_included,
                   price_subtitle, description, is_highlighted, cta_label, features_json
            FROM pricing_plans
            WHERE is_active = 1
            ORDER BY sort_order ASC, name ASC
            """
        )
        rows = await cursor.fetchall()
        plans = [
            PricingPlanOut(
                code=row["code"],
                name=row["name"],
                priceUsd=float(row["price_usd"]) if row["price_usd"] is not None else None,
                billingType=row["billing_type"],
                creditsIncluded=int(row["credits_included"] or 0),
                creditsPerPack=int(row["credits_per_pack"]) if row["credits_per_pack"] is not None else None,
                cryptoPriceUsd=float(row["crypto_price_usd"]) if row["crypto_price_usd"] is not None else None,
                cryptoCreditsIncluded=int(row["crypto_credits_included"])
                if row["crypto_credits_included"] is not None
                else None,
                priceSubtitle=row["price_subtitle"],
                description=row["description"],
                highlighted=bool(row["is_highlighted"]),
                ctaLabel=row["cta_label"] or "Select plan",
                features=json.loads(row["features_json"] or "[]"),
            )
            for row in rows
        ]
        return PricingPlansResponse(plans=plans)
    finally:
        await conn.close()


@router.get("/payments/nowpayments/pay-currency-options", response_model=NowPaymentsPayCurrencyOptionsOut)
async def nowpayments_pay_currency_options(planCode: str = Query(..., min_length=1)):
    """Tickers the user may pick before creating a NOWPayments invoice (must match your NP account)."""
    code = planCode.strip().lower()
    tickers = _nowpayments_user_selectable_pay_currencies(code)
    default_pc = _nowpayments_pay_currency(code)
    return NowPaymentsPayCurrencyOptionsOut(
        planCode=code,
        defaultTicker=default_pc,
        currencies=[_nowpayments_pay_currency_option_row(t) for t in tickers],
    )


@router.get("/account/summary", response_model=AccountSummaryResponse)
async def get_account_summary(userId: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            SELECT id, email, name, picture, credits, plan_code, plan_status, created_at
            FROM auth_users
            WHERE id = ?
            """,
            (userId,),
        )
        row = await cursor.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="User not found")
        user = _user_row_to_out(row)
        plan = await _get_plan(conn, user.planCode)

        tx_cursor = await conn.execute(
            """
            SELECT id, transaction_type, amount, balance_after, description, reference_type, reference_id, created_at
            FROM credit_transactions
            WHERE user_id = ?
              AND transaction_type NOT IN ('tts_generation', 'api_tts_generation')
            ORDER BY created_at DESC
            LIMIT 20
            """,
            (userId,),
        )
        transactions = [
            CreditTransactionOut(
                id=r["id"],
                transactionType=r["transaction_type"],
                amount=int(r["amount"] or 0),
                balanceAfter=int(r["balance_after"] or 0),
                description=r["description"] or "",
                referenceType=r["reference_type"],
                referenceId=r["reference_id"],
                createdAt=r["created_at"],
            )
            for r in await tx_cursor.fetchall()
        ]

        stats_row = await (await conn.execute(
            """
            SELECT
              (SELECT COUNT(*) FROM studio_tts_history WHERE user_id = ? AND status = 'completed') AS total_generations,
              COALESCE((SELECT SUM(-amount) FROM credit_transactions WHERE user_id = ? AND amount < 0), 0) AS credits_used
            """,
            (userId, userId),
        )).fetchone()
        return AccountSummaryResponse(
            user=user,
            plan=plan,
            transactions=transactions,
            totalTtsGenerations=int(stats_row["total_generations"] or 0),
            totalCreditsUsed=int(stats_row["credits_used"] or 0),
        )
    finally:
        await conn.close()


@router.get("/account/transactions", response_model=list[CreditTransactionOut])
async def get_account_transactions(
    limit: int = Query(50, ge=1, le=200),
    userId: str = Depends(require_auth),
):
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            SELECT id, transaction_type, amount, balance_after, description, reference_type, reference_id, created_at
            FROM credit_transactions
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ?
            """,
            (userId, limit),
        )
        rows = await cursor.fetchall()
        return [
            CreditTransactionOut(
                id=r["id"],
                transactionType=r["transaction_type"],
                amount=int(r["amount"] or 0),
                balanceAfter=int(r["balance_after"] or 0),
                description=r["description"] or "",
                referenceType=r["reference_type"],
                referenceId=r["reference_id"],
                createdAt=r["created_at"],
            )
            for r in rows
        ]
    finally:
        await conn.close()


@router.post("/developer/keys", response_model=DeveloperKeyCreateResponse)
async def create_developer_key(body: DeveloperKeyCreateRequest, userId: str = Depends(require_auth)):
    await ensure_tables()
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    tier = "normal"
    plain_key, prefix = generate_api_key()
    key_id = uuid.uuid4().hex
    key_hash = hash_api_key(plain_key)
    rate_limit_rpm = _api_rate_limit_for_tier(tier)
    conn = await get_connection()
    try:
        paid_row = await (
            await conn.execute(
                """
                SELECT COUNT(*) AS n
                FROM payments
                WHERE user_id = ?
                  AND status IN ('paid', 'completed')
                  AND credits_granted > 0
                  AND LOWER(COALESCE(plan_code, '')) = 'premium'
                """,
                (userId,),
            )
        ).fetchone()
        if int(paid_row["n"] or 0) <= 0:
            raise HTTPException(
                status_code=402,
                detail="Developer API requires a successful Premium plan purchase first.",
            )
        await conn.execute(
            """
            INSERT INTO api_keys
            (id, user_id, name, key_prefix, key_hash, tier, rate_limit_rpm, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            """,
            (key_id, userId, name, prefix, key_hash, tier, rate_limit_rpm),
        )
        await conn.commit()
        row = await (await conn.execute("SELECT * FROM api_keys WHERE id = ?", (key_id,))).fetchone()
        return DeveloperKeyCreateResponse(key=_developer_key_row_to_out(row), plainKey=plain_key)
    finally:
        await conn.close()


@router.get("/developer/keys", response_model=DeveloperKeysListResponse)
async def list_developer_keys(userId: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        rows = await (
            await conn.execute(
                """
                SELECT * FROM api_keys
                WHERE user_id = ?
                ORDER BY datetime(created_at) DESC
                """,
                (userId,),
            )
        ).fetchall()
        return DeveloperKeysListResponse(keys=[_developer_key_row_to_out(r) for r in rows])
    finally:
        await conn.close()


@router.post("/developer/keys/{key_id}/revoke")
async def revoke_developer_key(key_id: str, userId: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        row = await (await conn.execute("SELECT * FROM api_keys WHERE id = ? AND user_id = ?", (key_id, userId))).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="API key not found")
        await conn.execute(
            "UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?), updated_at = ? WHERE id = ?",
            (_now_iso(), _now_iso(), key_id),
        )
        await conn.commit()
        return {"ok": True}
    finally:
        await conn.close()


@router.get("/developer/usage", response_model=DeveloperUsageResponse)
async def developer_usage(limit: int = Query(50, ge=1, le=200), userId: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        rows = await (
            await conn.execute(
                """
                SELECT id, endpoint, provider, status, http_status, credits_used,
                       request_chars, latency_ms, error_code, error_message, created_at
                FROM api_request_logs
                WHERE user_id = ?
                ORDER BY datetime(created_at) DESC
                LIMIT ?
                """,
                (userId, limit),
            )
        ).fetchall()
        logs = [
            DeveloperUsageLogOut(
                id=r["id"],
                endpoint=r["endpoint"],
                provider=r["provider"],
                status=r["status"],
                httpStatus=int(r["http_status"] or 0),
                creditsUsed=int(r["credits_used"] or 0),
                requestChars=int(r["request_chars"]) if r["request_chars"] is not None else None,
                latencyMs=int(r["latency_ms"]) if r["latency_ms"] is not None else None,
                errorCode=r["error_code"],
                errorMessage=r["error_message"],
                createdAt=r["created_at"],
            )
            for r in rows
        ]
        return DeveloperUsageResponse(logs=logs)
    finally:
        await conn.close()


@router.post("/payments/checkout-session", response_model=CheckoutSessionResponse)
async def create_checkout_session(body: CheckoutSessionRequest, userId: str = Depends(require_auth)):
    provider = (body.provider or "").strip().lower()
    plan_code = (body.planCode or "").strip().lower()
    if provider not in {"stripe", "crypto"}:
        raise HTTPException(status_code=400, detail="provider must be stripe or crypto")
    await ensure_tables()
    conn = await get_connection()
    try:
        try:
            plan = await _get_plan(conn, plan_code)
            if plan is None:
                raise HTTPException(status_code=404, detail="Plan not found")
            user_row = await _get_user_row(conn, userId)
            if user_row is None:
                raise HTTPException(status_code=404, detail="User not found")

            session_id = uuid.uuid4().hex
            payment_id = uuid.uuid4().hex
            now = datetime.now(timezone.utc)
            expires_at = (now + timedelta(hours=1)).isoformat().replace("+00:00", "Z")
            # Stripe: one-time credit packs use Checkout `payment` + one-time Prices (STRIPE_PRICE_ID_*).
            # Only pricing_plans.billing_type == subscription uses `subscription` mode + recurring Prices.
            mode = "payment"
            if provider == "stripe":
                mode = "subscription" if (plan.billingType or "").lower() == "subscription" else "payment"
            checkout_url = None
            status = "ready" if checkout_url else "pending_configuration"
            message = None
            reference = None
            stripe_checkout_session_id = None
            stripe_customer_id = None
            stripe_subscription_id = None
            credits_for_session = plan.creditsIncluded
            crypto_list_usd = _plan_crypto_list_usd(plan)
            if provider == "crypto":
                credits_for_session = _plan_crypto_credits(plan)
            metadata = {
                "user_id": userId,
                "plan_code": plan.code,
                "credits_granted": str(credits_for_session),
                "payment_session_id": session_id,
            }
            session_amount_usd = float(plan.priceUsd or 0)
            if provider == "stripe":
                stripe_payload = await create_stripe_checkout_session(
                    mode=mode,
                    price_id=get_stripe_price_id(plan_code),
                    success_url=get_success_url(),
                    cancel_url=get_cancel_url(),
                    client_reference_id=userId,
                    customer_email=user_row["email"],
                    metadata=metadata,
                )
                checkout_url = stripe_payload.get("url")
                stripe_checkout_session_id = stripe_payload.get("id")
                stripe_customer_id = stripe_payload.get("customer")
                stripe_subscription_id = stripe_payload.get("subscription")
                reference = stripe_checkout_session_id
                status = "ready"
            else:
                # Preferred: dynamic NOWPayments invoice per session.
                now_api_key = (os.environ.get("NOWPAYMENTS_API_KEY") or "").strip()
                if now_api_key:
                    pay_cur = _resolve_checkout_pay_currency(plan_code, body.payCurrency)
                    now_invoice, np_price_usd = await _create_nowpayments_invoice(
                        session_id=session_id,
                        plan_code=plan.code,
                        amount_usd=crypto_list_usd,
                        user_id=userId,
                        user_email=user_row["email"],
                        credits_granted=credits_for_session,
                        pay_currency=pay_cur,
                    )
                    session_amount_usd = np_price_usd
                    metadata["nowpayments_invoice_usd"] = str(np_price_usd)
                    metadata["plan_list_price_usd"] = str(crypto_list_usd)
                    metadata["nowpayments_pay_currency"] = pay_cur
                    checkout_url = (
                        now_invoice.get("invoice_url")
                        or now_invoice.get("pay_url")
                        or now_invoice.get("url")
                    )
                    now_payment_id = str(now_invoice.get("id") or "")
                    reference = now_payment_id or str(now_invoice.get("order_id") or session_id)
                    status = "ready" if checkout_url else "pending_configuration"
                    if not checkout_url:
                        message = "NOWPayments invoice created but no checkout URL was returned."
                    elif np_price_usd > crypto_list_usd + 0.009:
                        message = (
                            f"Crypto checkout is billed at ${np_price_usd:.2f} USD "
                            f"(list price ${crypto_list_usd:.2f} + NOWPayments minimum/network adjustment). "
                            f"You still receive {credits_for_session:,} credits."
                        )
                else:
                    # Backward-compatible static URL fallback.
                    checkout_url = _crypto_checkout_url(plan_code)
                    status = "ready" if checkout_url else "pending_configuration"
                    if not checkout_url:
                        message = "Crypto checkout is not configured on this backend yet."
                    reference = checkout_url

            await conn.execute(
                """
                INSERT INTO payment_sessions
                (id, user_id, provider, plan_code, mode, credits_requested, amount_usd, currency, status, checkout_url, reference,
                 stripe_checkout_session_id, stripe_customer_id, stripe_subscription_id, metadata_json, expires_at, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                """,
                (
                    session_id,
                    userId,
                    provider,
                    plan.code,
                    mode,
                    credits_for_session,
                    session_amount_usd,
                    status,
                    checkout_url,
                    reference,
                    stripe_checkout_session_id,
                    stripe_customer_id,
                    stripe_subscription_id,
                    json.dumps(metadata),
                    expires_at,
                ),
            )
            await conn.execute(
                """
                INSERT INTO payments
                (id, session_id, user_id, provider, plan_code, amount_usd, credits_granted, currency, status,
                 provider_payment_id, stripe_checkout_session_id, stripe_subscription_id, stripe_customer_id, mode, metadata_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 'USD', ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                """,
                (
                    payment_id,
                    session_id,
                    userId,
                    provider,
                    plan.code,
                    session_amount_usd,
                    credits_for_session,
                    "pending",
                    (reference if provider == "crypto" else None),
                    stripe_checkout_session_id,
                    stripe_subscription_id,
                    stripe_customer_id,
                    mode,
                    json.dumps({"planName": plan.name, **metadata}),
                ),
            )
            await conn.commit()
            return CheckoutSessionResponse(
                sessionId=session_id,
                provider=provider,
                status=status,
                checkoutUrl=checkout_url,
                amountUsd=session_amount_usd,
                creditsGranted=credits_for_session,
                message=message,
            )
        except HTTPException:
            raise
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Checkout session creation failed: {exc}") from exc
    finally:
        await conn.close()


@router.post("/payments/stripe/webhook")
async def stripe_webhook(request: Request):
    payload = await request.body()
    verify_webhook_signature(payload, request.headers.get("Stripe-Signature"))
    try:
        event = json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid Stripe webhook payload") from exc

    event_id = str(event.get("id") or "")
    event_type = str(event.get("type") or "")
    data_object = _nested_get(event, "data", "object", default={})
    object_id = data_object.get("id") if isinstance(data_object, dict) else None
    if not event_id or not event_type or not isinstance(data_object, dict):
        raise HTTPException(status_code=400, detail="Invalid Stripe webhook event")

    conn = await get_connection()
    try:
        should_process = await _record_webhook_event(conn, event_id, event_type, object_id)
        if not should_process:
            await conn.commit()
            return {"ok": True, "duplicate": True}

        if event_type == "checkout.session.completed":
            checkout_id = str(data_object.get("id") or "")
            session_row = await _find_payment_session_by_checkout(conn, checkout_id)
            if session_row:
                await _mark_session_status(
                    conn,
                    session_row,
                    "completed",
                    checkout_url=data_object.get("url") or session_row["checkout_url"],
                    stripe_customer_id=data_object.get("customer") or session_row["stripe_customer_id"],
                    stripe_subscription_id=data_object.get("subscription") or session_row["stripe_subscription_id"],
                    completed_at=_now_iso(),
                )
                payment_row = await _find_payment_by_checkout_session(conn, checkout_id)
                if payment_row:
                    await _update_payment_row(
                        conn,
                        payment_row,
                        status="paid" if session_row["mode"] == "payment" else "checkout_completed",
                        stripe_checkout_session_id=checkout_id,
                        stripe_payment_intent_id=data_object.get("payment_intent"),
                        stripe_subscription_id=data_object.get("subscription"),
                        stripe_customer_id=data_object.get("customer"),
                        stripe_event_id=event_id,
                        amount_usd=(data_object.get("amount_total") or payment_row["amount_usd"] * 100) / 100 if data_object.get("amount_total") is not None else payment_row["amount_usd"],
                    )
                    if session_row["mode"] == "payment":
                        updated_payment = await _find_payment_by_checkout_session(conn, checkout_id)
                        sess_plan = (session_row["plan_code"] or "").strip().lower()
                        applied = await _apply_credits_once(
                            conn,
                            payment_row=updated_payment,
                            user_id=session_row["user_id"],
                            credits=int(updated_payment["credits_granted"] or 0),
                            description=f"{(session_row['plan_code'] or 'plan').title()} credit pack purchase",
                            reference_type="payment",
                            reference_id=updated_payment["id"],
                            plan_code="premium" if sess_plan == "premium" else None,
                        )
                        if applied:
                            await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())

        elif event_type == "invoice.paid":
            subscription_id = str(data_object.get("subscription") or "")
            invoice_id = str(data_object.get("id") or "")
            metadata = _invoice_metadata(data_object)
            session_row = None
            if subscription_id:
                session_row = await _find_payment_session_by_subscription(conn, subscription_id)
            if session_row is None and metadata.get("payment_session_id"):
                session_row = await (
                    await conn.execute("SELECT * FROM payment_sessions WHERE id = ?", (metadata["payment_session_id"],))
                ).fetchone()
            if session_row:
                await _mark_session_status(
                    conn,
                    session_row,
                    "active",
                    stripe_customer_id=data_object.get("customer") or session_row["stripe_customer_id"],
                    stripe_subscription_id=subscription_id or session_row["stripe_subscription_id"],
                    completed_at=session_row["completed_at"] or _now_iso(),
                )
                payment_row = await _find_payment_by_invoice(conn, invoice_id)
                period_start, period_end = _extract_invoice_period(data_object)
                if payment_row is None:
                    payment_row = await _create_subscription_payment(
                        conn,
                        session_row=session_row,
                        invoice_id=invoice_id,
                        payment_intent_id=data_object.get("payment_intent"),
                        customer_id=data_object.get("customer"),
                        subscription_id=subscription_id or session_row["stripe_subscription_id"],
                        amount_usd=float((data_object.get("amount_paid") or 0) / 100),
                        credits_granted=int(session_row["credits_requested"] or 0),
                        billing_period_start=period_start,
                        billing_period_end=period_end,
                        event_id=event_id,
                    )
                else:
                    await _update_payment_row(
                        conn,
                        payment_row,
                        status="paid",
                        stripe_payment_intent_id=data_object.get("payment_intent"),
                        stripe_subscription_id=subscription_id or payment_row["stripe_subscription_id"],
                        stripe_customer_id=data_object.get("customer"),
                        stripe_event_id=event_id,
                        amount_usd=float((data_object.get("amount_paid") or 0) / 100),
                        billing_period_start=period_start,
                        billing_period_end=period_end,
                    )
                    payment_row = await _find_payment_by_invoice(conn, invoice_id)

                inv_plan = (session_row["plan_code"] or "").strip().lower()
                applied = await _apply_credits_once(
                    conn,
                    payment_row=payment_row,
                    user_id=session_row["user_id"],
                    credits=int(payment_row["credits_granted"] or session_row["credits_requested"] or 0),
                    description=f"{(session_row['plan_code'] or 'Subscription').title()} subscription credit grant",
                    reference_type="payment",
                    reference_id=payment_row["id"],
                    plan_code="premium" if inv_plan == "premium" else None,
                )
                if applied:
                    await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())

        elif event_type == "customer.subscription.updated":
            subscription_id = str(data_object.get("id") or "")
            session_row = await _find_payment_session_by_subscription(conn, subscription_id) if subscription_id else None
            if session_row:
                cancel_at_period_end = bool(data_object.get("cancel_at_period_end"))
                status = "canceling" if cancel_at_period_end else "active"
                await _mark_session_status(
                    conn,
                    session_row,
                    status,
                    stripe_customer_id=data_object.get("customer") or session_row["stripe_customer_id"],
                    stripe_subscription_id=subscription_id,
                )
                sub_plan = (session_row["plan_code"] or "premium").strip().lower()
                await conn.execute(
                    "UPDATE auth_users SET plan_code = ?, plan_status = ?, updated_at = ? WHERE id = ?",
                    (sub_plan, status, _now_iso(), session_row["user_id"]),
                )

        elif event_type == "customer.subscription.deleted":
            subscription_id = str(data_object.get("id") or "")
            session_row = await _find_payment_session_by_subscription(conn, subscription_id) if subscription_id else None
            if session_row:
                await _mark_session_status(conn, session_row, "canceled", canceled_at=_now_iso())
                await conn.execute(
                    "UPDATE auth_users SET plan_code = ?, plan_status = ?, updated_at = ? WHERE id = ?",
                    ("normal", "active", _now_iso(), session_row["user_id"]),
                )

        elif event_type == "checkout.session.expired":
            checkout_id = str(data_object.get("id") or "")
            session_row = await _find_payment_session_by_checkout(conn, checkout_id)
            if session_row:
                await _mark_session_status(conn, session_row, "expired", canceled_at=_now_iso())
                payment_row = await _find_payment_by_checkout_session(conn, checkout_id)
                if payment_row:
                    await _update_payment_row(conn, payment_row, status="expired", stripe_event_id=event_id)

        await conn.commit()
        return {"ok": True}
    finally:
        await conn.close()


@router.post("/payments/nowpayments/webhook")
async def nowpayments_webhook(request: Request):
    payload = await request.body()
    signature = request.headers.get("x-nowpayments-sig")
    if not _verify_nowpayments_signature(payload, signature):
        raise HTTPException(status_code=401, detail="Invalid NOWPayments IPN signature")

    try:
        data = json.loads(payload.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid NOWPayments webhook payload") from exc

    payment_status = str(data.get("payment_status") or "").strip().lower()
    payment_id = str(data.get("payment_id") or data.get("id") or "").strip()
    order_id = str(data.get("order_id") or "").strip()
    if not payment_status:
        raise HTTPException(status_code=400, detail="NOWPayments webhook missing payment_status")
    if not payment_id and not order_id:
        raise HTTPException(status_code=400, detail="NOWPayments webhook missing payment_id/order_id")

    conn = await get_connection()
    try:
        session_row = await _find_payment_session_by_id(conn, order_id) if order_id else None
        payment_row = await _find_payment_by_provider_payment_id(conn, payment_id) if payment_id else None
        if payment_row is None and session_row:
            payment_row = await (
                await conn.execute(
                    "SELECT * FROM payments WHERE session_id = ? AND provider = 'crypto' ORDER BY datetime(created_at) DESC LIMIT 1",
                    (session_row["id"],),
                )
            ).fetchone()
        if session_row is None and payment_row and payment_row["session_id"]:
            session_row = await _find_payment_session_by_id(conn, str(payment_row["session_id"]))

        # If we cannot correlate this event, acknowledge to stop retries but do nothing.
        if payment_row is None and session_row is None:
            await conn.commit()
            return {"ok": True, "ignored": "unknown_session"}

        success_statuses = _nowpayments_success_statuses()
        if payment_status in success_statuses:
            if session_row:
                await _mark_session_status(
                    conn,
                    session_row,
                    "completed",
                    completed_at=session_row["completed_at"] or _now_iso(),
                    checkout_url=(data.get("invoice_url") or data.get("pay_address") or session_row["checkout_url"]),
                )
            if payment_row:
                await _update_payment_row(
                    conn,
                    payment_row,
                    status="paid",
                    provider_payment_id=payment_id or payment_row["provider_payment_id"],
                    wallet_address=(data.get("pay_address") or payment_row["wallet_address"]),
                    amount_usd=float(data.get("price_amount") or payment_row["amount_usd"] or 0),
                )
                payment_row = await (
                    await conn.execute("SELECT * FROM payments WHERE id = ?", (payment_row["id"],))
                ).fetchone()
                target_session = session_row
                if target_session is None and payment_row and payment_row["session_id"]:
                    target_session = await _find_payment_session_by_id(conn, str(payment_row["session_id"]))
                if payment_row and target_session:
                    applied = await _apply_credits_once(
                        conn,
                        payment_row=payment_row,
                        user_id=target_session["user_id"],
                        credits=int(payment_row["credits_granted"] or target_session["credits_requested"] or 0),
                        description=f"Crypto credit purchase ({data.get('pay_currency') or 'crypto'})",
                        reference_type="payment",
                        reference_id=payment_row["id"],
                        plan_code="premium" if (target_session["plan_code"] or "").lower() == "premium" else None,
                    )
                    if applied:
                        await refresh_daily_usage_for_day(conn, datetime.now(timezone.utc).date().isoformat())
        elif payment_status in {"failed", "expired", "refunded"}:
            if session_row:
                await _mark_session_status(conn, session_row, "canceled", canceled_at=_now_iso())
            if payment_row:
                await _update_payment_row(
                    conn,
                    payment_row,
                    status=payment_status,
                    provider_payment_id=payment_id or payment_row["provider_payment_id"],
                )
        else:
            # pending statuses: waiting, confirming, sending, etc.
            if session_row:
                await _mark_session_status(conn, session_row, "processing")
            if payment_row:
                await _update_payment_row(
                    conn,
                    payment_row,
                    status=payment_status,
                    provider_payment_id=payment_id or payment_row["provider_payment_id"],
                )

        await conn.commit()
        return {"ok": True}
    finally:
        await conn.close()


@router.post("/sales/contact")
async def sales_contact(body: SalesContactRequest):
    clean_name = (body.name or "").strip()
    clean_email = (body.email or "").strip()
    clean_message = (body.message or "").strip()
    clean_company = (body.company or "").strip() or None

    if not clean_name or not clean_email or not clean_message:
        raise HTTPException(status_code=400, detail="name, email, and message are required")

    try:
        await asyncio.to_thread(
            _send_sales_email_sync,
            name=clean_name,
            email=clean_email,
            company=clean_company,
            message=clean_message,
        )
        return {"success": True, "message": "Message sent to sales successfully."}
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to send sales email: {exc}") from exc
