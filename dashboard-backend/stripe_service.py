"""Minimal Stripe service helpers for Checkout Sessions and webhooks."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
from typing import Any
from urllib.parse import urlencode

import aiohttp
from fastapi import HTTPException

STRIPE_API_BASE = "https://api.stripe.com/v1"
STRIPE_API_VERSION = "2025-02-24.acacia"

_log = logging.getLogger(__name__)


def _webhook_tolerance_seconds() -> int:
    try:
        return max(60, int(os.environ.get("STRIPE_WEBHOOK_TOLERANCE_SECONDS", "300")))
    except ValueError:
        return 300


def get_stripe_secret_key() -> str:
    key = (os.environ.get("STRIPE_SECRET_KEY") or "").strip()
    if not key:
        raise HTTPException(status_code=503, detail="Stripe secret key is not configured")
    return key


def get_stripe_webhook_secret() -> str:
    secret = (os.environ.get("STRIPE_WEBHOOK_SECRET") or "").strip()
    if not secret:
        raise HTTPException(status_code=503, detail="Stripe webhook secret is not configured")
    return secret


def get_stripe_price_id(plan_code: str) -> str:
    raw = (os.environ.get(f"STRIPE_PRICE_ID_{plan_code.upper()}") or "").strip()
    if not raw:
        raise HTTPException(status_code=503, detail=f"Stripe price id is not configured for plan '{plan_code}'")
    if not raw.startswith("price_"):
        raise HTTPException(
            status_code=500,
            detail=f"Configured Stripe id for plan '{plan_code}' must be a Stripe Price ID (price_...), not a product id",
        )
    return raw


def get_success_url() -> str:
    url = (os.environ.get("STRIPE_SUCCESS_URL") or "").strip()
    if not url:
        raise HTTPException(status_code=503, detail="Stripe success URL is not configured")
    return url


def get_cancel_url() -> str:
    url = (os.environ.get("STRIPE_CANCEL_URL") or "").strip()
    if not url:
        raise HTTPException(status_code=503, detail="Stripe cancel URL is not configured")
    return url


def _stripe_request_headers() -> dict[str, str]:
    return {
        "Authorization": f"Bearer {get_stripe_secret_key()}",
        "Stripe-Version": STRIPE_API_VERSION,
    }


async def retrieve_stripe_price(price_id: str) -> dict[str, Any]:
    """Optional: fetch a Price from Stripe (e.g. admin/debug). Checkout mode follows pricing_plans.billing_type."""
    headers = _stripe_request_headers()
    async with aiohttp.ClientSession(headers=headers) as session:
        async with session.get(f"{STRIPE_API_BASE}/prices/{price_id}") as response:
            text = await response.text()
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                payload = None
            if response.status >= 400:
                detail = payload.get("error", {}).get("message") if isinstance(payload, dict) else text
                raise HTTPException(status_code=502, detail=f"Stripe API error: {detail or response.reason}")
            return payload if isinstance(payload, dict) else {}


async def _post_form(endpoint: str, form: dict[str, str]) -> dict[str, Any]:
    headers = {
        **_stripe_request_headers(),
        "Content-Type": "application/x-www-form-urlencoded",
    }
    async with aiohttp.ClientSession(headers=headers) as session:
        async with session.post(f"{STRIPE_API_BASE}{endpoint}", data=urlencode(form)) as response:
            text = await response.text()
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                payload = None
            if response.status >= 400:
                detail = payload.get("error", {}).get("message") if isinstance(payload, dict) else text
                raise HTTPException(status_code=502, detail=f"Stripe API error: {detail or response.reason}")
            return payload if isinstance(payload, dict) else {}


def verify_webhook_signature(payload: bytes, stripe_signature: str | None) -> None:
    if not stripe_signature:
        _log.warning("Stripe webhook rejected: missing Stripe-Signature header")
        raise HTTPException(status_code=400, detail="Missing Stripe-Signature header")
    secret = get_stripe_webhook_secret()
    parts = {}
    for item in stripe_signature.split(","):
        if "=" not in item:
            continue
        key, value = item.split("=", 1)
        parts.setdefault(key, []).append(value)
    timestamp = parts.get("t", [None])[0]
    signatures = parts.get("v1", [])
    if not timestamp or not signatures:
        _log.warning("Stripe webhook rejected: could not parse Stripe-Signature header")
        raise HTTPException(status_code=400, detail="Invalid Stripe-Signature header")
    try:
        ts = int(timestamp)
    except ValueError as exc:
        _log.warning("Stripe webhook rejected: invalid timestamp in Stripe-Signature")
        raise HTTPException(status_code=400, detail="Invalid Stripe-Signature timestamp") from exc
    tol = _webhook_tolerance_seconds()
    if abs(int(time.time()) - ts) > tol:
        _log.warning(
            "Stripe webhook rejected: timestamp outside tolerance (%ss). Sync server time or set STRIPE_WEBHOOK_TOLERANCE_SECONDS.",
            tol,
        )
        raise HTTPException(status_code=400, detail="Stripe webhook timestamp is outside tolerance")
    signed_payload = f"{timestamp}.{payload.decode('utf-8')}".encode("utf-8")
    expected = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
    if not any(hmac.compare_digest(expected, signature) for signature in signatures):
        _log.warning(
            "Stripe webhook rejected: signature mismatch. Use the signing secret from Stripe Dashboard for "
            "this exact webhook URL (test vs live must match STRIPE_SECRET_KEY); value is whsec_..."
        )
        raise HTTPException(status_code=400, detail="Invalid Stripe webhook signature")


def build_checkout_form(
    *,
    mode: str,
    price_id: str,
    success_url: str,
    cancel_url: str,
    client_reference_id: str,
    customer_email: str,
    metadata: dict[str, str],
) -> dict[str, str]:
    form: dict[str, str] = {
        "mode": mode,
        "success_url": success_url,
        "cancel_url": cancel_url,
        "client_reference_id": client_reference_id,
        "customer_email": customer_email,
        "line_items[0][price]": price_id,
        "line_items[0][quantity]": "1",
        "allow_promotion_codes": "true",
    }
    for key, value in metadata.items():
        form[f"metadata[{key}]"] = value
    if mode == "subscription":
        form["subscription_data[metadata][user_id]"] = metadata["user_id"]
        form["subscription_data[metadata][plan_code]"] = metadata["plan_code"]
        form["subscription_data[metadata][payment_session_id]"] = metadata["payment_session_id"]
    return form


async def create_checkout_session(
    *,
    mode: str,
    price_id: str,
    success_url: str,
    cancel_url: str,
    client_reference_id: str,
    customer_email: str,
    metadata: dict[str, str],
) -> dict[str, Any]:
    form = build_checkout_form(
        mode=mode,
        price_id=price_id,
        success_url=success_url,
        cancel_url=cancel_url,
        client_reference_id=client_reference_id,
        customer_email=customer_email,
        metadata=metadata,
    )
    return await _post_form("/checkout/sessions", form)
