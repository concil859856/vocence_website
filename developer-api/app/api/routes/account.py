"""Account / key-management endpoints — ``/v1/account/*``.

These let an API-key holder inspect their own account (credits, plan) and
manage their other API keys WITHOUT needing a website session. Each route
proxies to the equivalent session-authed dashboard-backend endpoint via
the internal trust headers, mirroring how the rest of the dev-API does it.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.auth import require_api_key
from app.db.connection import get_db
from app.services.dashboard_proxy import call_dashboard

router = APIRouter()


# --------------------------------------------------------------------- account


@router.get(
    "/v1/account",
    tags=["Account"],
    summary="Get the current account snapshot (credits + plan + key count)",
)
async def get_account(auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Read-only view of the caller's account state.

    Returns ``user_id``, ``email``, ``name``, ``credits``, ``plan_code``,
    ``plan_status``, and ``api_keys_count``. Use this for SDK / CLI
    "show me my balance" flows."""
    user_id = auth_ctx["user_id"]
    user = await call_dashboard("GET", f"/api/users/{user_id}", user_id=user_id)
    # The dashboard's UserOut shape varies slightly; surface the fields we
    # care about with safe fallbacks.
    keys = await call_dashboard("GET", "/api/developer/keys", user_id=user_id)
    keys_count = len(keys.get("keys") or [])
    return {
        "user_id": user.get("id") or user_id,
        "email": user.get("email"),
        "name": user.get("name"),
        "credits": int(user.get("credits") or 0),
        "plan_code": user.get("planCode") or user.get("plan_code") or "normal",
        "plan_status": user.get("planStatus") or user.get("plan_status") or "active",
        "api_keys_count": keys_count,
    }


# ----------------------------------------------------------------- keys


class _CreateKeyIn(BaseModel):
    name: str = Field(min_length=1, max_length=64, description="Friendly label for the new key.")


def _key_row_to_response(row: dict[str, Any]) -> dict[str, Any]:
    """Normalize the dashboard's camelCase developer-key shape into
    snake_case for the public API surface. We never return key material."""
    return {
        "id": row.get("id"),
        "name": row.get("name") or "",
        "key_prefix": row.get("keyPrefix") or row.get("key_prefix") or "",
        "tier": row.get("tier") or "normal",
        "rate_limit_rpm": row.get("rateLimitRpm") or row.get("rate_limit_rpm"),
        "revoked_at": row.get("revokedAt") or row.get("revoked_at"),
        "last_used_at": row.get("lastUsedAt") or row.get("last_used_at"),
        "created_at": row.get("createdAt") or row.get("created_at"),
        "updated_at": row.get("updatedAt") or row.get("updated_at"),
    }


@router.get(
    "/v1/account/keys",
    tags=["Account"],
    summary="List your developer API keys (metadata only, no secrets)",
)
async def list_keys(auth_ctx: dict = Depends(require_api_key)) -> dict:
    user_id = auth_ctx["user_id"]
    data = await call_dashboard("GET", "/api/developer/keys", user_id=user_id)
    items = [_key_row_to_response(r) for r in (data.get("keys") or [])]
    return {"keys": items}


@router.post(
    "/v1/account/keys",
    status_code=201,
    tags=["Account"],
    summary="Create a new developer API key (plaintext returned ONCE)",
)
async def create_key(body: _CreateKeyIn, auth_ctx: dict = Depends(require_api_key)) -> dict:
    """The ``plain_key`` field in the response is the only time the
    secret will ever be available. Store it immediately — subsequent
    GETs return metadata only."""
    user_id = auth_ctx["user_id"]
    raw = await call_dashboard(
        "POST",
        "/api/developer/keys",
        user_id=user_id,
        json={"name": body.name},
    )
    key_obj = raw.get("key") or {}
    plain = raw.get("plainKey") or raw.get("plain_key") or ""
    if not plain:
        raise HTTPException(
            status_code=502,
            detail="Upstream did not return a plaintext key. The new key was probably not persisted.",
        )
    return {"key": _key_row_to_response(key_obj), "plain_key": plain}


@router.get(
    "/v1/account/usage",
    tags=["Account"],
    summary="Recent API requests for this account",
)
async def get_usage(
    limit: int = 50,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Return the most recent developer-API calls (any endpoint), with
    timestamp, HTTP status, credits used, latency, and error info. Use
    this to build a dashboard or audit log on your side.

    ``limit`` is capped at 200 by the dashboard backend; values above
    that are clamped silently."""
    user_id = auth_ctx["user_id"]
    limit = max(1, min(int(limit or 50), 200))
    data = await call_dashboard(
        "GET",
        f"/api/developer/usage?limit={limit}",
        user_id=user_id,
    )
    # Translate camelCase → snake_case for parity with the rest of the
    # public surface. Unknown keys are passed through verbatim.
    items: list[dict[str, Any]] = []
    for r in data.get("logs") or []:
        items.append({
            "id": r.get("id"),
            "endpoint": r.get("endpoint"),
            "provider": r.get("provider"),
            "status": r.get("status"),
            "http_status": r.get("httpStatus") or r.get("http_status"),
            "credits_used": r.get("creditsUsed") or r.get("credits_used") or 0,
            "request_chars": r.get("requestChars") or r.get("request_chars"),
            "latency_ms": r.get("latencyMs") or r.get("latency_ms"),
            "error_code": r.get("errorCode") or r.get("error_code"),
            "error_message": r.get("errorMessage") or r.get("error_message"),
            "created_at": r.get("createdAt") or r.get("created_at"),
        })
    return {"items": items}


@router.post(
    "/v1/account/keys/{key_id}/revoke",
    tags=["Account"],
    summary="Revoke a developer API key",
)
async def revoke_key(key_id: str, auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Revokes immediately. The key cannot be un-revoked; create a new
    one if you need access again."""
    user_id = auth_ctx["user_id"]
    # Guard: only let the caller revoke their OWN keys (the dashboard
    # check ultimately does this via session ownership, but with the
    # trust-token path we have to enforce it ourselves before forwarding).
    conn = await get_db()
    try:
        row = await (
            await conn.execute(
                "SELECT user_id FROM api_keys WHERE id = ?",
                (key_id,),
            )
        ).fetchone()
    finally:
        await conn.close()
    if not row or row["user_id"] != user_id:
        raise HTTPException(status_code=404, detail="API key not found")
    await call_dashboard("POST", f"/api/developer/keys/{key_id}/revoke", user_id=user_id)
    return {"ok": True}
