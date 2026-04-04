from __future__ import annotations

import hashlib

from fastapi import Header, HTTPException

from app.db.connection import get_db


def hash_api_key(raw: str) -> str:
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


async def require_api_key(authorization: str | None = Header(None, alias="Authorization")) -> dict:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing API key")
    raw_key = authorization.split(" ", 1)[1].strip()
    if not raw_key:
        raise HTTPException(status_code=401, detail="Missing API key")
    prefix = raw_key[:16]
    conn = await get_db()
    try:
        row = await (await conn.execute("SELECT * FROM api_keys WHERE key_prefix = ?", (prefix,))).fetchone()
        if row is None:
            raise HTTPException(status_code=401, detail="Invalid API key")
        if row["revoked_at"]:
            raise HTTPException(status_code=403, detail="API key has been revoked")
        if hash_api_key(raw_key) != row["key_hash"]:
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

