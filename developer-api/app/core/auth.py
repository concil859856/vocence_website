from __future__ import annotations

import hashlib
import hmac

from fastapi import Header, HTTPException

from app.db.connection import get_db


def hash_api_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


# Surfaces the API key as an explicit ``Authorization`` parameter on
# every operation in the OpenAPI spec — i.e. each endpoint's docs
# page lists its own auth header alongside the body fields. This is
# deliberate: the API reference is read both by humans and by LLM
# agents scraping for client codegen, so making every operation
# self-contained (no global "Authorize once" state to remember)
# means a single endpoint snippet is enough to call it correctly.
#
# Accepted formats:
#   ``Bearer voc_live_...``  (preferred — matches RFC 6750)
#   ``voc_live_...``         (also accepted for convenience)
async def require_api_key(
    authorization: str | None = Header(
        default=None,
        alias="Authorization",
        description="`Bearer voc_live_...`",
    ),
) -> dict:
    if not authorization or not authorization.strip():
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    raw = authorization.strip()
    # Strip the "Bearer " scheme if present. Permissive on case.
    if raw.lower().startswith("bearer "):
        raw_key = raw[7:].strip()
    else:
        raw_key = raw
    if not raw_key:
        raise HTTPException(status_code=401, detail="Empty API key")

    prefix = raw_key[:16]
    conn = await get_db()
    try:
        row = await (await conn.execute("SELECT * FROM api_keys WHERE key_prefix = ?", (prefix,))).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="Invalid API key")
        if row["revoked_at"]:
            raise HTTPException(status_code=403, detail="API key has been revoked")
        # Constant-time comparison so the response timing doesn't leak
        # which bytes of the hash matched. With sha256 of high-entropy
        # secrets this is overkill, but it costs nothing.
        if not hmac.compare_digest(hash_api_key(raw_key), row["key_hash"] or ""):
            raise HTTPException(status_code=401, detail="Invalid API key")
        user = await (await conn.execute("SELECT id, credits FROM auth_users WHERE id = ?", (row["user_id"],))).fetchone()
        if user is None:
            raise HTTPException(status_code=401, detail="User not found for API key")
        return {
            "api_key_id": row["id"],
            "user_id": row["user_id"],
            "tier": row["tier"] or "normal",
            "rate_limit_rpm": int(row["rate_limit_rpm"]) if row["rate_limit_rpm"] is not None else None,
            "credits": int(user["credits"] or 0),
        }
    finally:
        await conn.close()
