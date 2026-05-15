"""CLI device-code login flow (RFC 8628-style).

Three endpoints:

- ``POST /api/cli/device-code``      (PUBLIC)  — CLI starts the flow.
- ``GET  /api/cli/devices/{code}``   (PUBLIC)  — CLI polls; returns
    pending | approved (with one-time plain_key) | denied | expired.
- ``POST /api/cli/approve``          (SESSION) — logged-in user clicks
    "Authorize" on the website's /cli/authorize page; we mint a fresh
    API key and bind it to the device_code.
- ``POST /api/cli/deny``             (SESSION) — same page, "Deny" button.

The matching browser approval page is on the website (React route
``/cli/authorize?user_code=ABCD-1234``).

Security notes
--------------
- ``user_code``s have ~40 bits of entropy + a 10-minute TTL, drawn from a
  Crockford-style alphabet with no confusable characters.
- ``device_code``s are 128-bit (``uuid4().hex``). Knowing one lets you
  poll, so they MUST travel over TLS only — the public verification URL
  is HTTPS-only on prod.
- The plaintext API key is returned by ``GET /devices/{code}`` exactly
  once, then the row is marked ``consumed`` so a subsequent poll cannot
  retrieve the secret a second time.
- ``POST /device-code`` is rate-limited per source IP to stop a remote
  attacker from spraying codes (each pending code occupies a row + a
  user_code that needs to stay unique for 10 minutes).
- ``POST /approve`` requires a valid session JWT for the user the key is
  being minted for — so an attacker who steals a ``user_code`` from a
  user's screen still cannot mint the key without that user's session.
"""

from __future__ import annotations

import secrets
import time
import uuid
from collections import deque
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from local_db import generate_api_key, get_connection, hash_api_key
from routers.auth import require_auth

router = APIRouter(prefix="/api/cli", tags=["cli-auth"])

# How long a device_code is valid before the CLI must restart the flow.
_DEVICE_CODE_TTL = timedelta(minutes=10)
# Recommended poll interval (seconds) the CLI should respect.
_POLL_INTERVAL = 3
# How the website's approval page is reached. The CLI prints this URL.
_VERIFICATION_URL = "https://backend.vocence.ai/cli/authorize"


# --------------------------------------------------------------------- helpers


def _gen_user_code() -> str:
    """Short, human-friendly code shown on screen and typed back if
    needed: ``ABCD-1234``. 32 bits of entropy — fine for a 10-minute
    window with one approval slot."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/1/I/O confusion
    pick = lambda n: "".join(secrets.choice(alphabet) for _ in range(n))  # noqa: E731
    return f"{pick(4)}-{pick(4)}"


def _gen_device_code() -> str:
    return uuid.uuid4().hex


# --------------------------------------------------------------------- schemas


class DeviceCodeResponse(BaseModel):
    device_code: str = Field(description="Long opaque code the CLI uses to poll.")
    user_code: str = Field(description="Short code shown to the user for approval.")
    verification_url: str = Field(description="URL the CLI tells the user to open.")
    expires_in: int = Field(description="Seconds until this device_code expires.")
    interval: int = Field(description="Recommended poll interval in seconds.")


class DeviceStatusResponse(BaseModel):
    status: str = Field(description="pending | approved | denied | expired")
    # Returned exactly once on the first poll that reports ``approved``.
    api_key: str | None = None


class ApproveRequest(BaseModel):
    user_code: str
    key_name: str = Field(default="cli", min_length=1, max_length=40)


# --------------------------------------------------------------------- routes


# Simple in-memory IP → recent-timestamp rate limiter. We don't need
# Redis for this — even a hot attacker burns through 10 codes/min and
# the rest get a 429. Restarting the dashboard resets the window, which
# is fine because each code only lives 10 minutes anyway.
_DEVICE_CODE_PER_IP_PER_MIN = 10
_recent_ip_hits: dict[str, deque[float]] = {}


def _enforce_ip_rate_limit(req: Request) -> None:
    """Drop the request with 429 if this client IP is over the per-minute
    quota. Trust the loopback ``X-Forwarded-For`` from the reverse proxy
    in prod; fall back to the raw socket address otherwise."""
    forwarded = (req.headers.get("x-forwarded-for") or "").split(",")[0].strip()
    ip = forwarded or (req.client.host if req.client else "unknown")
    now = time.monotonic()
    bucket = _recent_ip_hits.setdefault(ip, deque())
    cutoff = now - 60.0
    while bucket and bucket[0] < cutoff:
        bucket.popleft()
    if len(bucket) >= _DEVICE_CODE_PER_IP_PER_MIN:
        raise HTTPException(status_code=429, detail="Too many CLI login attempts. Wait a minute.")
    bucket.append(now)


@router.post("/device-code", response_model=DeviceCodeResponse)
async def issue_device_code(request: Request) -> DeviceCodeResponse:
    """Public: start a new CLI login flow."""
    _enforce_ip_rate_limit(request)
    device_code = _gen_device_code()
    user_code = _gen_user_code()
    expires_at = (datetime.now(timezone.utc) + _DEVICE_CODE_TTL).isoformat()
    conn = await get_connection()
    try:
        await conn.execute(
            """
            INSERT INTO cli_auth_codes (device_code, user_code, status, expires_at)
            VALUES (?, ?, 'pending', ?)
            """,
            (device_code, user_code, expires_at),
        )
        await conn.commit()
    finally:
        await conn.close()
    return DeviceCodeResponse(
        device_code=device_code,
        user_code=user_code,
        verification_url=_VERIFICATION_URL,
        expires_in=int(_DEVICE_CODE_TTL.total_seconds()),
        interval=_POLL_INTERVAL,
    )


@router.get("/devices/{device_code}", response_model=DeviceStatusResponse)
async def poll_device_code(device_code: str) -> DeviceStatusResponse:
    """Public: CLI polls until the user approves on the website.

    On the FIRST successful poll after approval we return the plaintext
    API key and mark the row ``consumed`` — subsequent polls return
    ``approved`` with ``api_key=None`` so the secret can never be
    retrieved twice."""
    conn = await get_connection()
    try:
        row = await (
            await conn.execute(
                "SELECT status, api_key_plain, expires_at FROM cli_auth_codes WHERE device_code = ?",
                (device_code,),
            )
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Unknown device_code")
        # Lazy expiry — easier than running a sweeper job.
        try:
            exp = datetime.fromisoformat(row["expires_at"].replace("Z", "+00:00"))
        except Exception:
            exp = None
        if exp and datetime.now(timezone.utc) > exp and row["status"] == "pending":
            await conn.execute(
                "UPDATE cli_auth_codes SET status='expired' WHERE device_code = ?",
                (device_code,),
            )
            await conn.commit()
            return DeviceStatusResponse(status="expired")

        if row["status"] == "approved" and row["api_key_plain"]:
            plain = row["api_key_plain"]
            # Burn after read.
            await conn.execute(
                "UPDATE cli_auth_codes SET status='consumed', api_key_plain=NULL WHERE device_code = ?",
                (device_code,),
            )
            await conn.commit()
            return DeviceStatusResponse(status="approved", api_key=plain)
        return DeviceStatusResponse(status=row["status"])
    finally:
        await conn.close()


@router.post("/approve")
async def approve_device(
    body: ApproveRequest,
    user_id: str = Depends(require_auth),
) -> dict:
    """Authenticated: user clicks "Authorize this CLI" on /cli/authorize.

    We mint a fresh API key for this user and pin it to the device code
    so the polling CLI gets exactly that key (and no other key the user
    has)."""
    user_code = body.user_code.strip().upper()
    conn = await get_connection()
    try:
        row = await (
            await conn.execute(
                "SELECT device_code, status, expires_at FROM cli_auth_codes WHERE user_code = ?",
                (user_code,),
            )
        ).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="Unknown or expired user_code")
        if row["status"] != "pending":
            raise HTTPException(
                status_code=409,
                detail=f"This code is already {row['status']}.",
            )
        try:
            exp = datetime.fromisoformat(row["expires_at"].replace("Z", "+00:00"))
        except Exception:
            exp = None
        if exp and datetime.now(timezone.utc) > exp:
            await conn.execute(
                "UPDATE cli_auth_codes SET status='expired' WHERE device_code = ?",
                (row["device_code"],),
            )
            await conn.commit()
            raise HTTPException(status_code=410, detail="Code has expired. Restart `vocence login`.")

        # Mint the API key.
        plain, prefix = generate_api_key()
        key_id = uuid.uuid4().hex
        await conn.execute(
            """
            INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash, tier, rate_limit_rpm)
            VALUES (?, ?, ?, ?, ?, 'normal', NULL)
            """,
            (key_id, user_id, body.key_name, prefix, hash_api_key(plain)),
        )
        await conn.execute(
            """
            UPDATE cli_auth_codes
               SET status='approved',
                   user_id=?, api_key_id=?, api_key_plain=?,
                   approved_at=datetime('now')
             WHERE device_code=?
            """,
            (user_id, key_id, plain, row["device_code"]),
        )
        await conn.commit()
    finally:
        await conn.close()
    return {"ok": True}


@router.post("/deny")
async def deny_device(
    body: ApproveRequest,
    _user_id: str = Depends(require_auth),
) -> dict:
    """Authenticated: user clicks "Deny" on /cli/authorize."""
    user_code = body.user_code.strip().upper()
    conn = await get_connection()
    try:
        await conn.execute(
            "UPDATE cli_auth_codes SET status='denied' WHERE user_code = ? AND status='pending'",
            (user_code,),
        )
        await conn.commit()
    finally:
        await conn.close()
    return {"ok": True}
