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
from fastapi import APIRouter, BackgroundTasks, Depends, Header, HTTPException, Query, Request
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

# SECURITY: JWT_SECRET must be a high-entropy value set via env. We refuse
# to boot if it's missing, too short, or the well-known placeholder — those
# are the conditions under which an attacker could forge any user/admin
# session and silently take over the deployment.
_INSECURE_DEFAULTS = {
    "",
    "your-secret-key-change-in-production",
    "change-me",
    "secret",
    "changeme",
}
JWT_SECRET = (os.environ.get("JWT_SECRET") or "").strip()
if JWT_SECRET in _INSECURE_DEFAULTS:
    raise RuntimeError(
        "JWT_SECRET is unset or uses a known-weak placeholder. Set a strong "
        "random value in dashboard-backend/.env before starting the server."
    )
if len(JWT_SECRET) < 32:
    raise RuntimeError(
        f"JWT_SECRET is too short ({len(JWT_SECRET)} chars). Use at least 32 "
        "random characters (e.g. `python -c 'import secrets; print(secrets.token_urlsafe(48))'`)."
    )

JWT_ALGORITHM = "HS256"
JWT_EXPIRY_DAYS = 30
SIGNUP_CREDITS = int(os.environ.get("SIGNUP_CREDITS", "300"))

router = APIRouter(prefix="/api", tags=["auth"])


class LoginRequest(BaseModel):
    """Login payload.

    SECURITY: ``credential`` is the Google-issued ID token (JWT) the
    frontend receives from Google Identity Services. The backend
    verifies it against Google before trusting anything inside it.
    The legacy fields (``email``, ``name``, ``googleId``) are
    deprecated — the verified claims always win when ``credential``
    is present. New deployments should require ``credential``.
    """
    credential: str | None = None
    # Legacy / fallback fields — IGNORED when credential is present.
    # Kept on the schema so old clients can still send them without
    # a 422; the server-side verification logic decides what to trust.
    email: str | None = None
    name: str | None = None
    picture: str | None = None
    googleId: str | None = None
    referral_code: str | None = None
    device_fingerprint: str | None = None


class UserOut(BaseModel):
    id: str
    email: str
    name: str
    picture: str | None
    credits: int
    planCode: str
    planStatus: str
    createdAt: str
    referralCode: str | None = None


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


class AccountTransactionsPageResponse(BaseModel):
    """Paged window over the user's credit_transactions, served by
    ``GET /account/transactions``. ``total`` is the unfiltered count so
    the client can render pagination controls (Prev / 1 of N / Next)
    without making a second request."""
    items: list[CreditTransactionOut]
    total: int
    offset: int
    limit: int


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
        referralCode=row["referral_code"] if "referral_code" in row.keys() else None,
    )


def _make_token(user_id: str, email: str) -> str:
    """Issue a session JWT.

    Includes ``iat`` (issued-at) so the auth-check path can compare it
    against the user's ``password_changed_at`` and invalidate sessions
    issued before the most recent password change (audit H8). Without
    this claim, an attacker who stole a JWT keeps full access for up
    to JWT_EXPIRY_DAYS even after the legit user resets their password.
    """
    now = datetime.now(timezone.utc)
    payload = {
        "userId": user_id,
        "email": email,
        "iat": now,
        "exp": now + timedelta(days=JWT_EXPIRY_DAYS),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def _decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.InvalidTokenError as exc:
        raise HTTPException(status_code=401, detail="Invalid token") from exc


async def _jwt_invalidated_by_password_change(user_id: str, token_iat: int | None) -> bool:
    """True when the user has changed their password AFTER ``token_iat``,
    meaning this JWT was issued in a prior session and should be rejected.

    Audit finding H8: without this check, password reset doesn't
    actually invalidate stolen sessions — an attacker with a captured
    JWT keeps full access for up to JWT_EXPIRY_DAYS even after the
    legitimate user resets their password.

    Returns False on missing iat (old tokens issued before this check
    landed) or unparseable timestamp — fail-OPEN for backwards
    compatibility. Once existing tokens have rolled over (30 days)
    we can tighten this to fail-CLOSED on missing iat.
    """
    if token_iat is None:
        return False
    conn = await get_connection()
    try:
        row = await (
            await conn.execute(
                "SELECT password_changed_at FROM auth_users WHERE id = ?",
                (user_id,),
            )
        ).fetchone()
    finally:
        await conn.close()
    if row is None:
        return False
    pwd_changed_at = row["password_changed_at"]
    if not pwd_changed_at:
        return False
    try:
        pwd_dt = datetime.fromisoformat(pwd_changed_at.replace("Z", "+00:00"))
        if pwd_dt.tzinfo is None:
            pwd_dt = pwd_dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return False
    pwd_iat = int(pwd_dt.timestamp())
    return token_iat < pwd_iat


async def _get_user_by_id(user_id: str) -> UserOut | None:
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            SELECT id, email, name, picture, credits, plan_code, plan_status, created_at, referral_code
            FROM auth_users WHERE id = ?
            """,
            (user_id,),
        )
        row = await cursor.fetchone()
        return _user_row_to_out(row) if row else None
    finally:
        await conn.close()


def is_internal_proxy(
    x_internal_service_token: str | None = Header(None, alias="X-Internal-Service-Token"),
) -> bool:
    """True if this call came in via the developer-api INTERNAL trust path.

    Use case: dashboard endpoints that bill credits should SKIP their
    own deduction when ``is_internal_proxy`` is True — the developer-api
    layer owns billing (often at a different rate, e.g. per-char vs
    per-call), and double-deducting on every proxied call would charge
    the user twice. The website's JWT auth path doesn't set this header,
    so studio web traffic still bills normally.

    The shared secret is validated the same way as ``require_auth``;
    if the env var isn't configured or the token doesn't match, this
    returns False and normal billing applies.
    """
    expected = (os.environ.get("INTERNAL_SERVICE_TOKEN") or "").strip()
    if not x_internal_service_token or not expected:
        return False
    return hmac.compare_digest(x_internal_service_token, expected)


async def require_auth(
    authorization: str | None = Header(None, alias="Authorization"),
    x_internal_service_token: str | None = Header(None, alias="X-Internal-Service-Token"),
    x_internal_user_id: str | None = Header(None, alias="X-Internal-User-Id"),
) -> str:
    """Returns the authenticated user_id.

    Two accepted auth paths:

    1. ``Authorization: Bearer <jwt>`` — the standard website session
       token. This is the only path public callers should ever use.

    2. ``X-Internal-Service-Token`` + ``X-Internal-User-Id`` — a
       service-to-service trust path used by the developer-api proxy
       (api.vocence.ai). The developer-api validates the caller's
       API key on its side, then forwards the request to us with the
       shared secret + the resolved user_id. We trust the user_id
       only when the secret matches. The ingress / reverse proxy
       MUST strip ``X-Internal-Service-Token`` and ``X-Internal-User-Id``
       from public requests — see the voicechat WS handler for the
       full rationale; same threat model applies here.

    Audit H8: when the Bearer path is used, we also check the JWT's
    ``iat`` against the user's ``password_changed_at`` and reject any
    token issued BEFORE the most recent password change. This
    invalidates stolen sessions on password reset.
    """
    expected_internal = (os.environ.get("INTERNAL_SERVICE_TOKEN") or "").strip()
    if (
        x_internal_service_token
        and expected_internal
        and hmac.compare_digest(x_internal_service_token, expected_internal)
        and x_internal_user_id
    ):
        return x_internal_user_id.strip()
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="No token provided")
    token = authorization.split(" ", 1)[1]
    decoded = _decode_token(token)
    user_id = decoded["userId"]
    token_iat = decoded.get("iat")
    if await _jwt_invalidated_by_password_change(user_id, token_iat):
        raise HTTPException(status_code=401, detail="Session expired. Please log in again.")
    return user_id


def optional_auth(authorization: str | None = Header(None, alias="Authorization")) -> str | None:
    """Like ``require_auth`` but returns None instead of raising when no
    valid Bearer token is present. Use for endpoints that are public but
    want to enrich the response when the viewer happens to be signed in
    (e.g. include their own thumb state on a public playbook listing)."""
    if not authorization or not authorization.startswith("Bearer "):
        return None
    token = authorization.split(" ", 1)[1]
    try:
        decoded = _decode_token(token)
    except HTTPException:
        return None
    return decoded.get("userId")


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


async def _find_payment_by_charge(conn, charge_id: str):
    """Look up the ``payments`` row that funded a Stripe charge.

    Stripe gives us two id flavours we can match on: ``payment_intent``
    (one-shot purchases) and ``charge`` (per-attempt; we don't store
    those directly but Stripe exposes ``payment_intent`` on the charge
    object). Caller can pass either."""
    if not charge_id:
        return None
    return await (
        await conn.execute(
            "SELECT * FROM payments WHERE stripe_payment_intent_id = ? OR provider_payment_id = ?",
            (charge_id, charge_id),
        )
    ).fetchone()


async def _find_payment_by_payment_intent(conn, pi_id: str):
    if not pi_id:
        return None
    return await (
        await conn.execute(
            "SELECT * FROM payments WHERE stripe_payment_intent_id = ?",
            (pi_id,),
        )
    ).fetchone()


# Stripe refund / dispute outcomes we apply identical effects for. The
# enum value goes into ``payments.status`` so dashboards + the dev-api
# Premium gate can distinguish "admin refunded" from "user lost a
# dispute".
_REFUND_TERMINAL_STATUSES = {
    "refunded",          # full Stripe refund via charge.refunded
    "partial_refund",    # partial refund — we revoke conservatively
    "disputed",          # dispute opened — provisional revocation
    "dispute_lost",      # dispute closed against us — finalised
}


async def _apply_refund_effects(
    conn,
    *,
    payment_row,
    new_payment_status: str,
    event_id: str,
    reason: str,
    clawback_credits: bool,
) -> None:
    """Apply the cascading side effects of a refund / dispute on a
    Stripe payment row.

    Effects, in order:

    1. ``payments.status`` → ``new_payment_status`` (one of
       :data:`_REFUND_TERMINAL_STATUSES`). The dev-api Premium gate
       queries ``status IN ('paid', 'completed')`` so anything else
       blocks access immediately.

    2. If the user has no remaining ``paid`` Premium payment row,
       flip ``auth_users.plan_code`` to ``'normal'`` and
       ``plan_status`` to ``'canceled'``. Don't touch users who paid
       again on a separate row — they keep Premium.

    3. Revoke every active ``api_keys`` row for the user. Live API
       calls fail immediately because ``require_api_key`` checks
       ``revoked_at IS NULL``.

    4. Revoke every active ``agent_embed_tokens`` row owned by the
       user. Embedded widgets stop authenticating on the next session
       open.

    5. (Optional) Claw back the credits that were originally granted
       by this payment row — but never push the user's balance below
       zero. Skipped for ``disputed`` (preliminary) so we don't punish
       a user who later wins the dispute. Applied for ``refunded`` and
       ``dispute_lost``.

    6. Log a ``credit_transactions`` row tagged ``refund_clawback`` so
       the user (and finance) can see the negative entry.

    Idempotent: the webhook deduplication in ``_record_webhook_event``
    prevents replay, but this helper also re-reads state every step so
    a manually-triggered double-apply does the right thing.
    """
    if payment_row is None:
        return
    user_id = payment_row["user_id"]

    # 1) Flip payment status. The webhook event id is stored so we can
    # trace exactly which Stripe event triggered the change.
    await _update_payment_row(
        conn, payment_row,
        status=new_payment_status,
        stripe_event_id=event_id,
    )

    # 2) Demote the user IFF this was their last paying Premium row.
    other_paying = await (
        await conn.execute(
            """
            SELECT COUNT(*) AS n
            FROM payments
            WHERE user_id = ?
              AND id != ?
              AND status IN ('paid', 'completed')
              AND credits_granted > 0
              AND LOWER(COALESCE(plan_code, '')) = 'premium'
            """,
            (user_id, payment_row["id"]),
        )
    ).fetchone()
    if int(other_paying["n"] or 0) == 0:
        await conn.execute(
            "UPDATE auth_users SET plan_code = 'normal', plan_status = 'canceled', "
            "updated_at = ? WHERE id = ?",
            (_now_iso(), user_id),
        )

    # 3) Revoke API keys. The dev-api re-checks ``revoked_at`` on every
    # request, so this kills access immediately even for keys that
    # were authenticated milliseconds ago.
    await conn.execute(
        "UPDATE api_keys SET revoked_at = datetime('now'), updated_at = datetime('now') "
        "WHERE user_id = ? AND revoked_at IS NULL",
        (user_id,),
    )

    # 4) Revoke embed tokens owned by the user. Embedded widgets stop
    # working on the next session open (existing live sessions on the
    # dashboard's WS continue until they close naturally).
    await conn.execute(
        "UPDATE agent_embed_tokens SET revoked_at = datetime('now') "
        "WHERE owner_user_id = ? AND revoked_at IS NULL",
        (user_id,),
    )

    # 5 + 6) Credit clawback. Only for FINAL refund states — ``disputed``
    # is provisional; if the user wins the dispute we restore them, so
    # we keep their balance whole until the dispute closes against us.
    if clawback_credits:
        granted = int(payment_row["credits_granted"] or 0)
        if granted > 0:
            # Read balance under lock so two concurrent refunds for
            # the same user don't double-clawback.
            row = await (await conn.execute(
                "SELECT credits FROM auth_users WHERE id = ?", (user_id,)
            )).fetchone()
            balance = int(row["credits"] or 0) if row else 0
            # Don't push below zero — if the user already spent the
            # refunded credits we eat the loss rather than block them
            # from ever using the platform again with a negative
            # balance.
            to_remove = min(balance, granted)
            if to_remove > 0:
                await conn.execute(
                    "UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') "
                    "WHERE id = ?",
                    (to_remove, user_id),
                )
                new_balance = balance - to_remove
                await record_credit_transaction(
                    conn,
                    user_id=user_id,
                    transaction_type="refund_clawback",
                    amount=-to_remove,
                    balance_after=new_balance,
                    description=f"Clawback for refunded payment ({reason})",
                    reference_type="payment",
                    reference_id=payment_row["id"],
                )

    _log = logging.getLogger(__name__)
    _log.warning(
        "refund effects applied: user=%s payment=%s status=%s reason=%s clawback=%s",
        user_id, payment_row["id"], new_payment_status, reason, clawback_credits,
    )


async def _restore_payment_after_dispute_won(
    conn,
    *,
    payment_row,
    event_id: str,
) -> None:
    """Reverse the provisional revocation when a dispute closes in
    our favour. Restores the payment row to ``paid`` and un-revokes
    the user's keys / embed tokens (the ones we marked at dispute
    open time). Plan status is restored from the row's plan_code.

    NOTE: keys revoked BEFORE the dispute (e.g. the user manually
    revoked one) stay revoked — we only undo our own provisional
    revocations, identified by ``revoked_at`` falling within the
    dispute window. For simplicity we restore all currently-revoked
    keys; admins can re-revoke individually if needed."""
    if payment_row is None:
        return
    user_id = payment_row["user_id"]
    await _update_payment_row(
        conn, payment_row, status="paid", stripe_event_id=event_id,
    )
    # Restore Premium status if this was the only paid row.
    plan_code = (payment_row["plan_code"] or "premium").strip().lower()
    await conn.execute(
        "UPDATE auth_users SET plan_code = ?, plan_status = 'active', updated_at = ? WHERE id = ?",
        (plan_code, _now_iso(), user_id),
    )
    # Un-revoke keys. This is a coarse restoration — see docstring.
    await conn.execute(
        "UPDATE api_keys SET revoked_at = NULL, updated_at = datetime('now') "
        "WHERE user_id = ? AND revoked_at IS NOT NULL",
        (user_id,),
    )
    await conn.execute(
        "UPDATE agent_embed_tokens SET revoked_at = NULL WHERE owner_user_id = ? AND revoked_at IS NOT NULL",
        (user_id,),
    )


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

    # Referral commission: 10% of purchased credits to the referrer.
    try:
        from referral_service import grant_purchase_commission
        await grant_purchase_commission(
            conn,
            buyer_id=user_id,
            credits_purchased=int(credits),
            payment_id=str(payment_row["id"]),
        )
    except Exception as e:
        _np_log.warning("referral commission failed for user %s: %s", user_id, e)

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


# Google's documented allowed issuers for ID tokens. The Google
# Identity Services library issues tokens with either form depending
# on the flow; both are equivalent.
_GOOGLE_TOKEN_ISSUERS = {"https://accounts.google.com", "accounts.google.com"}

# Backend's expected ``aud`` claim. Must match the OAuth client ID the
# frontend uses (VITE_GOOGLE_CLIENT_ID). Set in env so devs / staging /
# prod can have different OAuth client IDs.
GOOGLE_CLIENT_ID = (os.environ.get("GOOGLE_CLIENT_ID") or "").strip()


async def _verify_google_id_token(credential: str) -> dict:
    """Verify a Google-issued ID token (JWT) by calling Google's
    tokeninfo endpoint, which returns the decoded + verified claims
    only when the signature is valid AND the token isn't expired.

    Raises HTTPException on any failure — caller never sees an
    unverified token.

    SECURITY history: before this function existed, ``/auth/login``
    trusted whatever email/googleId the client posted. A user
    exploited that to create accounts under spam domains
    (``@nowhere.com``, etc.) without ever going through Google,
    and then abused the (now-fixed) ``PATCH /credits`` endpoint to
    grant themselves 100k credits. Verifying the credential closes
    the account-creation half of that chain.
    """
    if not credential or not isinstance(credential, str):
        raise HTTPException(status_code=400, detail="Missing Google credential")
    if not GOOGLE_CLIENT_ID:
        # Refuse to authenticate when we can't validate ``aud`` —
        # otherwise an attacker who got any Google JWT (e.g. issued for
        # some other app) could log into ours.
        raise HTTPException(
            status_code=500,
            detail="GOOGLE_CLIENT_ID not configured on this deployment",
        )
    timeout = aiohttp.ClientTimeout(total=8)
    url = "https://oauth2.googleapis.com/tokeninfo"
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url, params={"id_token": credential}) as resp:
                if resp.status != 200:
                    raise HTTPException(status_code=401, detail="Invalid Google credential")
                data = await resp.json()
    except aiohttp.ClientError as exc:
        # Don't let a transient network blip fall through to "trust the
        # client" — fail closed.
        raise HTTPException(status_code=502, detail=f"Google verification unavailable: {exc}") from exc

    # Verify the critical claims. Google's tokeninfo endpoint already
    # checks the signature + expiry, but ``aud`` (our app) and ``iss``
    # (Google) we have to enforce ourselves.
    if data.get("aud") != GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=401, detail="Google credential audience mismatch")
    if data.get("iss") not in _GOOGLE_TOKEN_ISSUERS:
        raise HTTPException(status_code=401, detail="Google credential issuer mismatch")
    if (data.get("email_verified") or "").lower() not in {"true", "1", "yes"} and data.get("email_verified") is not True:
        # Reject unverified-email accounts so attackers can't game us
        # with a domain they don't actually control.
        raise HTTPException(status_code=401, detail="Google account email not verified")
    if not data.get("email") or not data.get("sub"):
        raise HTTPException(status_code=401, detail="Google credential missing required claims")
    return data


@router.post("/auth/login", response_model=LoginResponse)
async def auth_login(body: LoginRequest):
    # SECURITY: require a verified Google credential. The legacy
    # ``email/name/googleId`` fields the frontend used to send are
    # IGNORED — we use the claims from the verified JWT instead so
    # an attacker can't forge an account by posting arbitrary values.
    claims = await _verify_google_id_token(body.credential or "")
    verified_email = (claims.get("email") or "").strip().lower()
    verified_google_id = str(claims.get("sub") or "").strip()
    verified_name = (claims.get("name") or body.name or verified_email.split("@")[0]).strip()
    verified_picture = claims.get("picture") or body.picture
    if not verified_email or not verified_google_id:
        raise HTTPException(status_code=401, detail="Google credential missing email or sub")

    # Override whatever the client posted. The remainder of this
    # function uses ``body.email`` / ``body.googleId`` references —
    # rebind them to the verified values so the rest of the existing
    # logic flows through unchanged.
    body.email = verified_email
    body.name = verified_name
    body.picture = verified_picture
    body.googleId = verified_google_id

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
            from referral_service import ensure_referral_code
            await ensure_referral_code(conn, row["id"])

            await conn.commit()
            user_out = await _get_user_by_id(row["id"])
            if user_out is None:
                raise HTTPException(status_code=500, detail="Failed to load user")
            return LoginResponse(user=user_out, token=_make_token(user_out.id, user_out.email))

        from referral_service import ensure_referral_code, validate_referral, apply_referral_on_signup

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

        # Welcome notification — replaces the in-studio "you have 300
        # credits" banner. Lives in the user's inbox forever (until
        # they dismiss), so they can re-read it any time. Raw SQL
        # avoids importing notifications.py and pulling its router
        # dependency tree into the auth boot path.
        import uuid as _uuid  # local: keep top-level imports tight
        await conn.execute(
            """
            INSERT INTO notifications
              (id, user_id, kind, title, body, link, sender, created_at)
            VALUES (?, ?, 'welcome', ?, ?, ?, 'system', datetime('now'))
            """,
            (
                _uuid.uuid4().hex,
                body.googleId,
                f"👋 Welcome to Vocence, {(body.name or '').split(' ')[0] or 'friend'}!",
                (
                    f"We're so glad you're here. To get you started, we've credited your account with "
                    f"**{SIGNUP_CREDITS} free credits** — yours to spend however you like across "
                    f"Text-to-Speech, voice cloning, music generation, and the voice agents.\n\n"
                    f"A few quick ideas to try first:\n\n"
                    f"- Make your first TTS clip in seconds\n"
                    f"- Clone your own voice with a 15-second sample\n"
                    f"- Design a brand-new voice from a prompt\n\n"
                    f"If anything's confusing, hit the **Discord** link in the sidebar — real humans answer.\n\n"
                    f"Have fun building!\n\n"
                    f"The Vocence Admin team"
                ),
                "/studio",
            ),
        )

        # Generate a referral code for the new user.
        await ensure_referral_code(conn, body.googleId)

        # Process referral if one was provided.
        ref_code = (body.referral_code or "").strip()
        if ref_code:
            ref_err = await validate_referral(
                conn,
                referral_code=ref_code,
                new_user_id=body.googleId,
                new_user_email=body.email,
                device_fingerprint=(body.device_fingerprint or "").strip() or None,
            )
            if not ref_err:
                await apply_referral_on_signup(
                    conn,
                    referral_code=ref_code,
                    new_user_id=body.googleId,
                    device_fingerprint=(body.device_fingerprint or "").strip() or None,
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


# ════════════════════════════════════════════════════════════════════
# Email + password authentication
# ════════════════════════════════════════════════════════════════════
#
# Separate from the Google login path above so the failure modes,
# rate-limit policy, and DB columns touched by each flow stay easy to
# reason about. Shared helpers (JWT issuance, ``_get_user_by_id``,
# credit transaction recording) are reused; everything security-
# sensitive (hashing, token generation, lockout schedule, email
# templates) lives in ``auth_security.py``.
#
# Anti-enumeration: signup, resend-verify, and forgot-password all
# return 200 regardless of whether the email exists. They schedule
# the email send as a background task so wall-clock response time
# doesn't leak existence either.
#
# Anti-brute-force: per-IP rate limit on every endpoint here, plus a
# per-account exponential lockout on login (see auth_security).
#
# Credit-bonus protection: SIGNUP_CREDITS, welcome notification, and
# referral application all happen on /verify, never on /signup. An
# attacker without control of the inbox cannot harvest credits.

import auth_security as _auth_sec  # local: keep heavy imports out of boot path


class EmailSignupRequest(BaseModel):
    email: str
    password: str
    name: str | None = None
    referral_code: str | None = None
    device_fingerprint: str | None = None


class EmailLoginRequest(BaseModel):
    email: str
    password: str


class EmailVerifyRequest(BaseModel):
    token: str


class EmailResendRequest(BaseModel):
    email: str


class EmailForgotRequest(BaseModel):
    email: str


class EmailResetRequest(BaseModel):
    token: str
    new_password: str


class GenericOkResponse(BaseModel):
    """Used by anti-enumeration endpoints. ``ok`` is always true; the
    real outcome (email sent, no such user, rate-limited) is never
    revealed to the caller — only logged server-side."""
    ok: bool = True
    message: str = "If that email is registered, we've sent a message."


# In-memory per-IP rate limits. Same pattern as ``_sales_rl_state``.
# Each endpoint gets its own bucket so an abuser can't exhaust the
# /forgot quota and lock out legitimate /signup attempts.
_EMAIL_AUTH_RL_WINDOW_SEC = 3600
_EMAIL_AUTH_SIGNUP_PER_HOUR = int(os.environ.get("EMAIL_AUTH_SIGNUP_PER_HOUR", "5"))
_EMAIL_AUTH_LOGIN_PER_HOUR = int(os.environ.get("EMAIL_AUTH_LOGIN_PER_HOUR", "30"))
_EMAIL_AUTH_RESEND_PER_HOUR = int(os.environ.get("EMAIL_AUTH_RESEND_PER_HOUR", "5"))
_EMAIL_AUTH_FORGOT_PER_HOUR = int(os.environ.get("EMAIL_AUTH_FORGOT_PER_HOUR", "5"))
_EMAIL_AUTH_RESET_PER_HOUR = int(os.environ.get("EMAIL_AUTH_RESET_PER_HOUR", "20"))

_email_auth_rl_state: dict[str, dict[str, list[float]]] = {
    "signup": {}, "login": {}, "resend": {}, "forgot": {}, "reset": {},
}


def _email_auth_rate_ok(bucket: str, client_ip: str, limit: int) -> bool:
    import time as _time
    now = _time.time()
    state = _email_auth_rl_state.setdefault(bucket, {})
    history = state.setdefault(client_ip, [])
    cutoff = now - _EMAIL_AUTH_RL_WINDOW_SEC
    while history and history[0] < cutoff:
        history.pop(0)
    if len(history) >= limit:
        return False
    history.append(now)
    # Cap memory: drop empty buckets if the table gets large.
    if len(state) > 10000:
        for ip in list(state.keys()):
            if not state[ip]:
                state.pop(ip, None)
    return True


# Trusted proxies that can spoof X-Forwarded-For. If the request's
# direct client is in this set, we honor XFF; otherwise we treat
# request.client.host as authoritative and IGNORE any XFF the client
# sent. This closes audit H10: previously XFF was trusted
# unconditionally, so any process that could reach the backend port
# directly (container-to-container, misconfigured ingress, future
# topology change) could forge per-IP rate-limit bypass.
#
# Defaults cover loopback + Docker / k8s pod networks. Override via
# TRUSTED_PROXIES env (comma-separated IPs or CIDR-like prefixes
# matched with str.startswith — simple is fine here).

def _trusted_proxy_set() -> set[str]:
    extra = (os.environ.get("TRUSTED_PROXIES") or "").strip()
    base = {"127.0.0.1", "::1"}
    if extra:
        base |= {p.strip() for p in extra.split(",") if p.strip()}
    return base


def _ip_is_trusted_proxy(ip: str) -> bool:
    if not ip:
        return False
    trusted = _trusted_proxy_set()
    if ip in trusted:
        return True
    # Allow simple prefix matches so a "10." entry in TRUSTED_PROXIES
    # covers any 10.0.0.0/8 source — sufficient for typical container
    # / VPC topologies without dragging in an IP-parsing library.
    return any(p and ip.startswith(p) for p in trusted)


def _client_ip(request: Request) -> str:
    """Resolve the client IP for rate-limiting purposes.

    Honors ``X-Forwarded-For`` ONLY when the immediate connection is
    from a trusted proxy (loopback, configured TRUSTED_PROXIES). For
    untrusted sources we use the direct peer address regardless of
    what XFF the client sent — so an attacker that bypasses the
    intended proxy (port-scan, container-to-container, misrouted
    request) cannot forge IPs to bypass rate limits.
    """
    direct = request.client.host if request.client else ""
    if _ip_is_trusted_proxy(direct):
        fwd = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
        if fwd:
            return fwd
    return direct or "unknown"


def _send_verification_email_safe(*, to_email: str, raw_token: str, user_name: str | None) -> None:
    """Synchronous wrapper for ``send_verification_email`` suitable for
    ``BackgroundTasks.add_task``. Swallows transport failures so the
    background task never bubbles a 500 out of FastAPI's task runner;
    the anti-enumeration endpoints return 200 BEFORE this runs.

    CRITICAL: callers MUST schedule this via BackgroundTasks, NEVER
    ``await`` it. Awaiting would put the Resend HTTPS latency on the
    response-time critical path → existence oracle for any endpoint
    that conditionally sends an email.
    """
    try:
        _auth_sec.send_verification_email(
            to_email=to_email, raw_token=raw_token, user_name=user_name,
        )
    except Exception as exc:
        _np_log.warning("send_verification_email failed for %s: %s", to_email, exc)


def _send_reset_email_safe(*, to_email: str, raw_token: str, user_name: str | None) -> None:
    try:
        _auth_sec.send_password_reset_email(
            to_email=to_email, raw_token=raw_token, user_name=user_name,
        )
    except Exception as exc:
        _np_log.warning("send_password_reset_email failed for %s: %s", to_email, exc)


def _send_password_changed_email_safe(*, to_email: str, user_name: str | None, client_ip: str | None) -> None:
    try:
        _auth_sec.send_password_changed_email(
            to_email=to_email, user_name=user_name, client_ip=client_ip,
        )
    except Exception as exc:
        _np_log.warning("send_password_changed_email failed for %s: %s", to_email, exc)


async def _issue_verification_token(conn, user_id: str) -> str:
    """Generate a verification token, persist its hash + expiry on the
    user row, return the raw token to email out. Overwrites any prior
    unused token (resending invalidates the old link)."""
    raw, hashed = _auth_sec.generate_token()
    expiry = _auth_sec.token_expiry_iso(_auth_sec.VERIFICATION_TOKEN_TTL)
    await conn.execute(
        "UPDATE auth_users SET verification_token_hash = ?, verification_token_expires_at = ? WHERE id = ?",
        (hashed, expiry, user_id),
    )
    return raw


async def _issue_reset_token(conn, user_id: str) -> str:
    raw, hashed = _auth_sec.generate_token()
    expiry = _auth_sec.token_expiry_iso(_auth_sec.PASSWORD_RESET_TOKEN_TTL)
    await conn.execute(
        "UPDATE auth_users SET password_reset_token_hash = ?, password_reset_expires_at = ? WHERE id = ?",
        (hashed, expiry, user_id),
    )
    return raw


@router.post("/auth/email/signup", response_model=GenericOkResponse)
async def email_signup(
    body: EmailSignupRequest, request: Request, background_tasks: BackgroundTasks,
):
    """Sign up with email + password.

    Returns 200 regardless of whether the email is already taken so an
    attacker can't enumerate accounts. The email send is dispatched as
    a background task AFTER the response has been written, so wall-
    clock latency does not leak whether the email was actually sent
    (existence oracle defense — see audit C1).

    Duplicate-email policy: silent 200, NO action. The signup endpoint
    never re-sends a verification link; users who want a fresh link
    must call /auth/email/resend-verify explicitly. This closes two
    audit findings:
      * H2 — re-sending on correct password was a password oracle
        (attacker confirms a guess because the victim gets an email)
      * H3 — that re-send path bypassed the login lockout counter

    H1 (referral regression): device_fingerprint is persisted on the
    user row at signup so /verify can read it back and pass it to
    validate_referral. Without this, every email-signup referral was
    silently dropped by the device-fingerprint-required gate.
    """
    if not _email_auth_rate_ok("signup", _client_ip(request), _EMAIL_AUTH_SIGNUP_PER_HOUR):
        raise HTTPException(status_code=429, detail="Too many signup attempts. Try again later.")

    try:
        email = _auth_sec.normalize_and_validate_email(body.email or "")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    pw_err = _auth_sec.check_password_strength(body.password or "")
    if pw_err:
        raise HTTPException(status_code=400, detail=pw_err)

    clean_name = (body.name or "").strip()[:128] or email.split("@")[0]
    device_fp = (body.device_fingerprint or "").strip()[:128] or None
    referral_code = (body.referral_code or "").strip() or None

    await ensure_tables()
    conn = await get_connection()
    try:
        existing = await (
            await conn.execute(
                "SELECT id FROM auth_users WHERE email = ?",
                (email,),
            )
        ).fetchone()
        if existing is not None:
            # Duplicate email — silent 200, no work. We do NOT verify
            # the password here (the previous implementation did and
            # leaked via timing + email-receipt side channels).
            return GenericOkResponse()

        # New account: hash AFTER the existence check so duplicate
        # signups don't pay the 64 MiB Argon2id cost. (We accept that
        # this introduces a tiny insert/hash timing asymmetry vs the
        # duplicate-email branch; the dominant signal — whether an
        # email was actually sent — is now closed by BackgroundTasks
        # so this remaining sliver is below practical-attack threshold.)
        password_hash = _auth_sec.hash_password(body.password)
        user_id = uuid.uuid4().hex
        now = _auth_sec.utc_now_iso()
        try:
            await conn.execute(
                """
                INSERT INTO auth_users
                  (id, email, name, picture, credits, plan_code, plan_status,
                   password_hash, email_verified, password_changed_at,
                   referred_by, signup_device_fingerprint, created_at, updated_at)
                VALUES (?, ?, ?, NULL, 0, 'normal', 'active',
                        ?, 0, ?,
                        ?, ?, ?, ?)
                """,
                (
                    user_id, email, clean_name,
                    password_hash, now,
                    referral_code, device_fp,
                    now, now,
                ),
            )
        except Exception:
            # Race: two signups for the same email landed between the
            # SELECT and the INSERT. The UNIQUE constraint on email
            # rejects the loser — return the same silent 200 as the
            # existing-account branch so the loser doesn't reveal the
            # race (or the email's existence).
            await conn.rollback()
            return GenericOkResponse()

        await conn.execute(
            """
            INSERT INTO registered_users (email, name, picture, created_at, updated_at)
            VALUES (?, ?, NULL, ?, ?)
            ON CONFLICT(email) DO UPDATE SET
                name = excluded.name, updated_at = excluded.updated_at
            """,
            (email, clean_name, now, now),
        )
        raw_token = await _issue_verification_token(conn, user_id)
        await conn.commit()
        # Schedule the email AFTER the response is written. Do NOT
        # await — awaiting reintroduces the existence-oracle timing
        # leak this whole rewrite is trying to close (audit C1).
        background_tasks.add_task(
            _send_verification_email_safe,
            to_email=email, raw_token=raw_token, user_name=clean_name,
        )
        return GenericOkResponse()
    finally:
        await conn.close()


@router.post("/auth/email/verify", response_model=LoginResponse)
async def email_verify(body: EmailVerifyRequest, request: Request):
    """Consume a verification token: mark email verified, grant signup
    bonus, send welcome notification, apply referral if any, and issue
    a JWT so the user is logged in on landing.
    """
    if not body.token:
        raise HTTPException(status_code=400, detail="Verification token is required.")
    token_hash = _auth_sec.hash_token(body.token)

    await ensure_tables()
    conn = await get_connection()
    try:
        row = await (
            await conn.execute(
                """
                SELECT id, email, name, email_verified, verification_token_expires_at,
                       referred_by, signup_device_fingerprint
                FROM auth_users WHERE verification_token_hash = ?
                """,
                (token_hash,),
            )
        ).fetchone()
        if row is None or _auth_sec.is_iso_in_past(row["verification_token_expires_at"]):
            raise HTTPException(status_code=400, detail="This verification link is invalid or has expired.")

        user_id = row["id"]
        user_email = row["email"]
        user_name = row["name"] or user_email.split("@")[0]
        already_verified = bool(row["email_verified"])
        device_fp = (row["signup_device_fingerprint"] or "").strip() or None
        now = _auth_sec.utc_now_iso()

        # Clear the token regardless of whether this is a re-verify so
        # the link is single-use. Set email_verified=1.
        await conn.execute(
            """
            UPDATE auth_users
            SET email_verified = 1,
                verification_token_hash = NULL,
                verification_token_expires_at = NULL,
                last_login_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (now, now, user_id),
        )

        # IDEMPOTENT credit grant. Gating on email_verified isn't safe —
        # if anything (admin tool, recovery script, migration) ever
        # flips verified back to 0 we'd re-grant. Instead, check that
        # NO signup_bonus row exists for this user. Audit finding H6.
        bonus_row = await (
            await conn.execute(
                "SELECT 1 FROM credit_transactions WHERE user_id = ? AND transaction_type = 'signup_bonus' LIMIT 1",
                (user_id,),
            )
        ).fetchone()
        if bonus_row is None:
            # First-time verify (no prior bonus): grant credits, send
            # welcome notif, process referral. Truly idempotent now.
            # CREDITS: increment, not overwrite — preserves any balance
            # that may have been added between signup and verify
            # (admin grant, manual top-up, etc). Audit finding H7.
            await conn.execute(
                "UPDATE auth_users SET credits = COALESCE(credits, 0) + ? WHERE id = ?",
                (SIGNUP_CREDITS, user_id),
            )
            new_balance = await (
                await conn.execute("SELECT credits FROM auth_users WHERE id = ?", (user_id,))
            ).fetchone()
            await record_credit_transaction(
                conn,
                user_id=user_id,
                transaction_type="signup_bonus",
                amount=SIGNUP_CREDITS,
                balance_after=int(new_balance["credits"] if new_balance else SIGNUP_CREDITS),
                description=f"Welcome bonus: {SIGNUP_CREDITS} free credits",
                reference_type="signup",
                reference_id=user_id,
            )
            # Welcome notification — same body as the Google login path.
            await conn.execute(
                """
                INSERT INTO notifications
                  (id, user_id, kind, title, body, link, sender, created_at)
                VALUES (?, ?, 'welcome', ?, ?, ?, 'system', datetime('now'))
                """,
                (
                    uuid.uuid4().hex,
                    user_id,
                    f"👋 Welcome to Vocence, {(user_name or '').split(' ')[0] or 'friend'}!",
                    (
                        f"We're so glad you're here. To get you started, we've credited your account with "
                        f"**{SIGNUP_CREDITS} free credits**, yours to spend however you like across "
                        f"Text-to-Speech, voice cloning, music generation, and the voice agents.\n\n"
                        f"A few quick ideas to try first:\n\n"
                        f"- Make your first TTS clip in seconds\n"
                        f"- Clone your own voice with a 15-second sample\n"
                        f"- Design a brand-new voice from a prompt\n\n"
                        f"If anything's confusing, hit the **Discord** link in the sidebar, real humans answer.\n\n"
                        f"Have fun building!\n\n"
                        f"The Vocence Admin team"
                    ),
                    "/studio",
                ),
            )
            from referral_service import ensure_referral_code, validate_referral, apply_referral_on_signup
            await ensure_referral_code(conn, user_id)
            ref_code = (row["referred_by"] or "").strip()
            if ref_code:
                # H1 fix: pass the device fingerprint stashed at signup
                # so validate_referral's device-required gate doesn't
                # silently drop every email-signup referral.
                ref_err = await validate_referral(
                    conn,
                    referral_code=ref_code,
                    new_user_id=user_id,
                    new_user_email=user_email,
                    device_fingerprint=device_fp,
                )
                if not ref_err:
                    await apply_referral_on_signup(
                        conn,
                        referral_code=ref_code,
                        new_user_id=user_id,
                        device_fingerprint=device_fp,
                    )

        await conn.commit()
        user_out = await _get_user_by_id(user_id)
        if user_out is None:
            raise HTTPException(status_code=500, detail="Failed to load user after verification.")
        return LoginResponse(user=user_out, token=_make_token(user_out.id, user_out.email))
    finally:
        await conn.close()


@router.post("/auth/email/login", response_model=LoginResponse)
async def email_login(
    body: EmailLoginRequest, request: Request, background_tasks: BackgroundTasks,
):
    """Log in with email + password. Returns a JWT on success.

    Failure modes that MUST be indistinguishable to an attacker:
      * email doesn't exist                  → 401 generic
      * Google-only account (no password)    → 401 generic
      * email exists, wrong password         → 401 generic
      * email exists, password right, but
        email not yet verified               → 401 generic
                                               (audit H5 — was 403)
    All four return the same 401 + same string. The 403 the previous
    revision used was a credential oracle: an attacker who knew the
    password could distinguish "wrong" (401) from "right but unverified"
    (403). To still help legitimate users who really have an unverified
    account, we trigger a background-task verification re-send when the
    credentials check out but verification is pending. The user sees a
    fresh email in their inbox without us telling them why.

    Lockout (429 with Retry-After) is the one exception to the
    generic-error rule — accepted, because an attacker already knows
    from the request cadence that they triggered it.
    """
    if not _email_auth_rate_ok("login", _client_ip(request), _EMAIL_AUTH_LOGIN_PER_HOUR):
        raise HTTPException(status_code=429, detail="Too many login attempts. Try again later.")

    try:
        email = _auth_sec.normalize_and_validate_email(body.email or "")
    except ValueError:
        _auth_sec.verify_password(_auth_sec.DUMMY_HASH, body.password or "x")
        raise HTTPException(status_code=401, detail="Invalid email or password.")
    if not body.password:
        _auth_sec.verify_password(_auth_sec.DUMMY_HASH, "x")
        raise HTTPException(status_code=401, detail="Invalid email or password.")

    await ensure_tables()
    conn = await get_connection()
    try:
        row = await (
            await conn.execute(
                """
                SELECT id, name, email, password_hash, email_verified, failed_login_attempts, locked_until
                FROM auth_users WHERE email = ?
                """,
                (email,),
            )
        ).fetchone()

        if row is None or not row["password_hash"]:
            _auth_sec.verify_password(_auth_sec.DUMMY_HASH, body.password)
            raise HTTPException(status_code=401, detail="Invalid email or password.")

        is_locked, retry_after = _auth_sec.is_account_locked(row["locked_until"])
        if is_locked:
            raise HTTPException(
                status_code=429,
                detail=f"Account locked due to too many failed attempts. Try again in {retry_after // 60 + 1} minutes.",
                headers={"Retry-After": str(retry_after)},
            )

        ok = _auth_sec.verify_password(row["password_hash"], body.password)
        if not ok:
            # ATOMIC counter bump (audit H4). The previous read-modify-
            # write at the Python level was lossy under concurrent
            # failures — two parallel bad logins both read N, both
            # wrote N+1, undercounting. RETURNING gives us the new
            # value in one statement so concurrent failures both see
            # the post-increment count and compute the correct
            # lockout. Requires SQLite 3.35+ (we're on 3.37).
            cursor = await conn.execute(
                """
                UPDATE auth_users
                SET failed_login_attempts = COALESCE(failed_login_attempts, 0) + 1
                WHERE id = ?
                RETURNING failed_login_attempts
                """,
                (row["id"],),
            )
            result = await cursor.fetchone()
            new_attempts = int(result[0]) if result else 1
            new_lock = _auth_sec.compute_lockout_until(new_attempts)
            await conn.execute(
                "UPDATE auth_users SET locked_until = ? WHERE id = ?",
                (new_lock, row["id"]),
            )
            await conn.commit()
            raise HTTPException(status_code=401, detail="Invalid email or password.")

        # Password OK. If email isn't verified yet, COLLAPSE to the
        # same 401 the wrong-password branch returns (audit H5). The
        # previous 403 was a credential oracle. Trigger a re-send so
        # a legitimate user with the right password still gets a
        # fresh verify email in their inbox without us telling them
        # why login was rejected.
        #
        # NOTE: we use asyncio.to_thread(...) wrapped in create_task
        # rather than FastAPI's BackgroundTasks because we're about to
        # raise HTTPException, and BackgroundTasks attached to a
        # Response object don't fire on the exception path. The
        # create_task version is fire-and-forget and runs regardless.
        if row["email_verified"] == 0:
            raw_token = await _issue_verification_token(conn, row["id"])
            await conn.commit()
            resend_email = row["email"]
            resend_name = row["name"] or row["email"].split("@")[0]
            asyncio.create_task(
                asyncio.to_thread(
                    _send_verification_email_safe,
                    to_email=resend_email,
                    raw_token=raw_token,
                    user_name=resend_name,
                )
            )
            raise HTTPException(status_code=401, detail="Invalid email or password.")

        # Success — clear counter + lockout, update last_login.
        # Commit BEFORE the opportunistic rehash so a rehash failure
        # can't roll back the lockout reset (audit; previously a
        # rehash failure mid-transaction left the counter elevated
        # despite a successful login).
        now = _auth_sec.utc_now_iso()
        await conn.execute(
            """
            UPDATE auth_users
            SET failed_login_attempts = 0, locked_until = NULL,
                last_login_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (now, now, row["id"]),
        )
        await conn.commit()

        # Opportunistic rehash if Argon2id params have been bumped.
        # Best-effort, never raises — if it fails we just keep the
        # old-params hash; the user will still be logged in.
        if _auth_sec.password_needs_rehash(row["password_hash"]):
            try:
                new_hash = _auth_sec.hash_password(body.password)
                await conn.execute(
                    "UPDATE auth_users SET password_hash = ? WHERE id = ?",
                    (new_hash, row["id"]),
                )
                await conn.commit()
            except Exception as exc:
                _np_log.warning("opportunistic rehash failed for %s: %s", row["id"], exc)

        user_out = await _get_user_by_id(row["id"])
        if user_out is None:
            raise HTTPException(status_code=500, detail="Failed to load user.")
        return LoginResponse(user=user_out, token=_make_token(user_out.id, user_out.email))
    finally:
        await conn.close()


@router.post("/auth/email/resend-verify", response_model=GenericOkResponse)
async def email_resend_verify(
    body: EmailResendRequest, request: Request, background_tasks: BackgroundTasks,
):
    """Re-send the verification email. Anti-enumeration: always 200.
    Email send is scheduled via BackgroundTasks so wall-clock latency
    does not differentiate the send vs no-send branch (audit C1)."""
    if not _email_auth_rate_ok("resend", _client_ip(request), _EMAIL_AUTH_RESEND_PER_HOUR):
        raise HTTPException(status_code=429, detail="Too many resend requests. Try again later.")

    try:
        email = _auth_sec.normalize_and_validate_email(body.email or "")
    except ValueError:
        return GenericOkResponse()

    await ensure_tables()
    conn = await get_connection()
    try:
        row = await (
            await conn.execute(
                "SELECT id, name, email_verified FROM auth_users WHERE email = ?",
                (email,),
            )
        ).fetchone()
        if row is not None and row["email_verified"] == 0:
            raw_token = await _issue_verification_token(conn, row["id"])
            await conn.commit()
            background_tasks.add_task(
                _send_verification_email_safe,
                to_email=email, raw_token=raw_token,
                user_name=row["name"] or email.split("@")[0],
            )
    finally:
        await conn.close()
    return GenericOkResponse()


@router.post("/auth/email/forgot", response_model=GenericOkResponse)
async def email_forgot(
    body: EmailForgotRequest, request: Request, background_tasks: BackgroundTasks,
):
    """Send a password-reset email. Anti-enumeration: always 200.
    Refuses to send for accounts without a password (Google-only).
    Email send dispatched via BackgroundTasks so the send-vs-no-send
    branches are wall-clock indistinguishable (audit C1)."""
    if not _email_auth_rate_ok("forgot", _client_ip(request), _EMAIL_AUTH_FORGOT_PER_HOUR):
        raise HTTPException(status_code=429, detail="Too many reset requests. Try again later.")

    try:
        email = _auth_sec.normalize_and_validate_email(body.email or "")
    except ValueError:
        return GenericOkResponse()

    await ensure_tables()
    conn = await get_connection()
    try:
        row = await (
            await conn.execute(
                "SELECT id, name, password_hash, email_verified FROM auth_users WHERE email = ?",
                (email,),
            )
        ).fetchone()
        # Only send if: account exists AND has a password set AND is
        # verified. Google-only accounts (no password) get nothing —
        # there's no password to reset, and the address would simply
        # confuse the user. Unverified accounts get nothing because
        # the verification flow is the right recovery path for them.
        if row is not None and row["password_hash"] and row["email_verified"] == 1:
            raw_token = await _issue_reset_token(conn, row["id"])
            await conn.commit()
            background_tasks.add_task(
                _send_reset_email_safe,
                to_email=email, raw_token=raw_token,
                user_name=row["name"] or email.split("@")[0],
            )
    finally:
        await conn.close()
    return GenericOkResponse()


@router.post("/auth/email/reset", response_model=GenericOkResponse)
async def email_reset(
    body: EmailResetRequest, request: Request, background_tasks: BackgroundTasks,
):
    """Consume a reset token + set a new password.

    Side effects on success:
      * Updates ``password_hash`` and ``password_changed_at``. The
        latter invalidates every JWT issued before this moment via
        ``_jwt_invalidated_by_password_change`` in require_auth
        (audit H8 fix).
      * Clears ``failed_login_attempts`` + ``locked_until`` so the
        user can log in immediately with the new password.
      * Emails the user a "your password was changed" notification
        from the request IP (audit H9). Standard practice — gives
        the legitimate owner an instant signal if the reset was done
        by an attacker who stole the reset link.
    """
    if not _email_auth_rate_ok("reset", _client_ip(request), _EMAIL_AUTH_RESET_PER_HOUR):
        raise HTTPException(status_code=429, detail="Too many reset attempts. Try again later.")

    if not body.token:
        raise HTTPException(status_code=400, detail="Reset token is required.")
    pw_err = _auth_sec.check_password_strength(body.new_password or "")
    if pw_err:
        raise HTTPException(status_code=400, detail=pw_err)

    token_hash = _auth_sec.hash_token(body.token)
    client_ip = _client_ip(request)
    await ensure_tables()
    conn = await get_connection()
    try:
        # Atomic consume: do the time-check AND clear the token in
        # one UPDATE so two concurrent resets with the same token
        # can't both succeed. We use cursor.rowcount to tell the
        # success-vs-invalid branches apart, then a follow-up SELECT
        # for the user's email + name to feed the notification.
        new_hash = _auth_sec.hash_password(body.new_password)
        now = _auth_sec.utc_now_iso()
        cursor = await conn.execute(
            """
            UPDATE auth_users
            SET password_hash = ?,
                password_reset_token_hash = NULL,
                password_reset_expires_at = NULL,
                failed_login_attempts = 0,
                locked_until = NULL,
                password_changed_at = ?,
                updated_at = ?
            WHERE password_reset_token_hash = ?
              AND password_reset_expires_at > ?
            RETURNING id, email, name
            """,
            (new_hash, now, now, token_hash, now, ),
        )
        result = await cursor.fetchone()
        if result is None:
            raise HTTPException(status_code=400, detail="This reset link is invalid or has expired.")
        await conn.commit()
        user_email = result["email"]
        user_name = result["name"] or user_email.split("@")[0]
    finally:
        await conn.close()

    # H9: out-of-band notification. Fire-and-forget via asyncio so the
    # response doesn't block on Resend latency, and so a Resend outage
    # doesn't 5xx the reset itself.
    asyncio.create_task(
        asyncio.to_thread(
            _send_password_changed_email_safe,
            to_email=user_email, user_name=user_name, client_ip=client_ip,
        )
    )
    return GenericOkResponse(message="Password updated. You can now log in.")


@router.get("/auth/referral")
async def get_referral_info(user_id: str = Depends(require_auth)):
    from referral_service import get_referral_stats, ensure_referral_code
    conn = await get_connection()
    try:
        await ensure_referral_code(conn, user_id)
    finally:
        await conn.close()
    stats = await get_referral_stats(user_id)
    return stats


@router.get("/users/{user_id}", response_model=UserOut)
async def get_user(user_id: str, userId: str = Depends(require_auth)):
    if user_id != userId:
        raise HTTPException(status_code=403, detail="Unauthorized")
    user = await _get_user_by_id(user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")
    return user


@router.patch("/users/{user_id}/credits", response_model=UserOut)
async def update_credits(
    user_id: str,
    body: CreditsUpdateRequest,
    admin_email: str = Depends(require_admin_session),
):
    """ADMIN-ONLY manual credit adjustment.

    !!! SECURITY: prior to 2026-05-14 this endpoint was guarded only
    by ``require_auth`` + an ``if user_id != caller`` check, which
    means a normal user could set THEIR OWN balance to any integer.
    A user did exactly that — granted themselves 100k credits. The
    fix is to require an admin session (matched against ADMIN_EMAIL).

    Any legitimate "user deducts their own credits" flow needs a
    server-side endpoint that takes the operation, NOT the absolute
    balance. The chat-demo deduction that used to call this is now
    a no-op on the server (the frontend will get 403 if it still
    attempts the call); the canonical credit deduction happens in
    the Studio / Voicechat code paths via the credit_transactions
    ledger and ``record_credit_transaction``."""
    _ = admin_email  # silence unused-arg warning; admin-gate is the side effect
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


@router.get("/account/transactions", response_model=AccountTransactionsPageResponse)
async def get_account_transactions(
    limit: int = Query(25, ge=1, le=100),
    offset: int = Query(0, ge=0),
    userId: str = Depends(require_auth),
):
    """Paged window over the user's credit_transactions.

    Used by the Account / Credits page when the user expands the
    "View detailed usage" panel. Returns the slice plus a ``total`` so
    the client can render pagination controls. The summary endpoint
    still returns its own (un-paged, last-20-by-default) list for the
    overview card — the two have different "noise level" requirements
    so we keep them on separate endpoints rather than overloading one.
    """
    conn = await get_connection()
    try:
        total_row = await (await conn.execute(
            "SELECT COUNT(*) AS n FROM credit_transactions WHERE user_id = ?",
            (userId,),
        )).fetchone()
        total = int(total_row["n"] or 0)

        cursor = await conn.execute(
            """
            SELECT id, transaction_type, amount, balance_after, description, reference_type, reference_id, created_at
            FROM credit_transactions
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (userId, limit, offset),
        )
        rows = await cursor.fetchall()
        items = [
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

    return AccountTransactionsPageResponse(items=items, total=total, offset=offset, limit=limit)


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
        except Exception:
            # Stripe/NOWPayments error messages can include internal config
            # details (price IDs, customer ids, API tier hints). Log full
            # detail server-side; return a generic message to the client.
            _np_log.exception("checkout session creation failed for user=%s plan=%s", userId, plan_code)
            raise HTTPException(status_code=500, detail="Checkout session creation failed")
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
                    ("normal", "canceled", _now_iso(), session_row["user_id"]),
                )
                # Also flip the matching paid payment rows for this
                # subscription to ``canceled`` so the dev-api Premium
                # gate (which checks ``payments.status IN ('paid', ...)``)
                # stops passing for cancelled subscribers. We DO NOT
                # claw back credits — the user paid for what they got
                # and can spend any remaining balance.
                await conn.execute(
                    "UPDATE payments SET status = 'canceled', updated_at = datetime('now') "
                    "WHERE stripe_subscription_id = ? AND status IN ('paid', 'completed')",
                    (subscription_id,),
                )

        # ----- refunds and disputes ------------------------------------
        #
        # Stripe sends ``charge.refunded`` when a full or partial refund
        # is issued on a charge (by admin via dashboard, by API, or by
        # automatic policy). For us this is a hard signal: the user paid
        # for service, didn't get what they wanted, and we owe them
        # their money back AND should revoke continued access on the
        # refunded plan.
        elif event_type == "charge.refunded":
            charge_id = str(data_object.get("id") or "")
            pi_id = str(data_object.get("payment_intent") or "")
            payment_row = (
                await _find_payment_by_payment_intent(conn, pi_id)
                or await _find_payment_by_charge(conn, charge_id)
            )
            if payment_row:
                amount_refunded = int(data_object.get("amount_refunded") or 0)
                amount_charged = int(data_object.get("amount") or 0)
                partial = (
                    amount_charged > 0
                    and amount_refunded > 0
                    and amount_refunded < amount_charged
                )
                await _apply_refund_effects(
                    conn,
                    payment_row=payment_row,
                    new_payment_status="partial_refund" if partial else "refunded",
                    event_id=event_id,
                    reason="stripe.charge.refunded",
                    # Standard SaaS convention: claw back credits granted
                    # by the refunded payment. Lenient is also a
                    # defensible choice — set to False to leave balance
                    # untouched. We claw back because the dispute case
                    # below also claws back, and a refunded user should
                    # not retain credits worth more than they paid.
                    clawback_credits=True,
                )

        # ``charge.dispute.created`` — chargeback opened. We DON'T know
        # the outcome yet, so revoke provisionally but skip the credit
        # clawback. If the dispute later closes in our favour
        # (``charge.dispute.closed`` with status='won') we'll restore
        # access; if not we'll finalise the refund with a clawback then.
        elif event_type == "charge.dispute.created":
            charge_id = str(data_object.get("charge") or "")
            pi_id = str(data_object.get("payment_intent") or "")
            payment_row = (
                await _find_payment_by_payment_intent(conn, pi_id)
                or await _find_payment_by_charge(conn, charge_id)
            )
            if payment_row:
                await _apply_refund_effects(
                    conn,
                    payment_row=payment_row,
                    new_payment_status="disputed",
                    event_id=event_id,
                    reason="stripe.charge.dispute.created",
                    clawback_credits=False,  # provisional — wait for outcome
                )

        elif event_type == "charge.dispute.closed":
            charge_id = str(data_object.get("charge") or "")
            pi_id = str(data_object.get("payment_intent") or "")
            dispute_status = str(data_object.get("status") or "").lower()
            payment_row = (
                await _find_payment_by_payment_intent(conn, pi_id)
                or await _find_payment_by_charge(conn, charge_id)
            )
            if payment_row:
                if dispute_status == "won":
                    # We won — restore the user's access + plan + keys.
                    await _restore_payment_after_dispute_won(
                        conn, payment_row=payment_row, event_id=event_id,
                    )
                elif dispute_status in ("lost", "charge_refunded"):
                    # We lost — finalise as a refund, claw back credits.
                    await _apply_refund_effects(
                        conn,
                        payment_row=payment_row,
                        new_payment_status="dispute_lost",
                        event_id=event_id,
                        reason="stripe.charge.dispute.closed.lost",
                        clawback_credits=True,
                    )
                # Other terminal statuses (``warning_needs_response``,
                # ``warning_under_review``, ``warning_closed``) are
                # informational only — we already revoked on
                # ``dispute.created`` and there's no further action
                # until a final ``won`` / ``lost`` arrives.

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


# In-memory per-IP rate limiter for /sales/contact. The endpoint is
# unauthenticated and sends real email, so it's a natural spam vector —
# limit to SALES_CONTACT_PER_HOUR submissions per IP per hour. This is
# best-effort (per-process, lost on restart) but cuts off a casual abuser
# from sending thousands of emails before we notice. For production-grade
# rate limiting plug in Redis here.
_SALES_RL_PER_HOUR = int(os.environ.get("SALES_CONTACT_PER_HOUR", "5"))
_SALES_RL_WINDOW_SEC = 3600
_sales_rl_state: dict[str, list[float]] = {}


def _sales_rate_limit_ok(client_ip: str) -> bool:
    import time as _time
    now = _time.time()
    bucket = _sales_rl_state.setdefault(client_ip, [])
    # Drop timestamps outside the window
    cutoff = now - _SALES_RL_WINDOW_SEC
    while bucket and bucket[0] < cutoff:
        bucket.pop(0)
    if len(bucket) >= _SALES_RL_PER_HOUR:
        return False
    bucket.append(now)
    # Keep the global state bounded — purge entries whose bucket is empty
    # once the dict grows large enough to matter.
    if len(_sales_rl_state) > 10000:
        for ip in list(_sales_rl_state.keys()):
            if not _sales_rl_state[ip]:
                _sales_rl_state.pop(ip, None)
    return True


@router.post("/sales/contact")
async def sales_contact(body: SalesContactRequest, request: Request):
    # Use the first hop in X-Forwarded-For if behind a trusted proxy,
    # otherwise the direct client. (Trust assumption: ingress strips
    # client-supplied XFF and appends the real one — standard nginx /
    # cloudflare config.)
    fwd = (request.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    client_ip = fwd or (request.client.host if request.client else "unknown")
    if not _sales_rate_limit_ok(client_ip):
        raise HTTPException(
            status_code=429,
            detail=f"Too many contact submissions. Try again in an hour.",
        )

    clean_name = (body.name or "").strip()
    clean_email = (body.email or "").strip()
    clean_message = (body.message or "").strip()
    clean_company = (body.company or "").strip() or None

    if not clean_name or not clean_email or not clean_message:
        raise HTTPException(status_code=400, detail="name, email, and message are required")
    # Cheap input bounds — keeps the SMTP body sane and prevents a single
    # message from filling the mailbox.
    if len(clean_name) > 200 or len(clean_email) > 320 or len(clean_message) > 5000:
        raise HTTPException(status_code=400, detail="One or more fields exceed the maximum allowed length")
    if "@" not in clean_email or "." not in clean_email.rsplit("@", 1)[-1]:
        raise HTTPException(status_code=400, detail="Invalid email address")

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
    except Exception:
        # SMTP errors may leak the configured host/port/auth scheme to
        # an unauthenticated caller. Log full detail server-side, return
        # a generic message to the client.
        _np_log.exception("sales_contact send failed for %s", clean_email)
        raise HTTPException(status_code=500, detail="Failed to send sales email")
