"""Admin sudo-mode authentication.

Layered on top of the regular Google-OAuth JWT: even after logging in as
ADMIN_EMAIL, the admin must enter a *separate* admin password to access
sensitive surfaces (/api/dashboard/ops/*, /admin/*). Same pattern GitHub,
Stripe, AWS console use.

Two layers must both hold for an admin route to succeed:
  1. ``require_admin_session`` (existing) - JWT email == ADMIN_EMAIL
  2. ``require_admin_unlocked`` (this module) - valid X-Admin-Token header
                                                  minted by /unlock

Wire shape:
  POST /api/dashboard/auth/admin/unlock
    body:   {"password": "..."}
    200:    {"admin_token": "...", "expires_at": "2026-..."}
    401:    {"detail": "invalid admin password"}
    429:    {"detail": "too many attempts, try again at HH:MM"}
    503:    {"detail": "admin password not configured (set ADMIN_PASSWORD_HASH)"}

  POST /api/dashboard/auth/admin/lock
    headers: X-Admin-Token: <token>
    200:    {"ok": true}      (best-effort invalidate; tokens are stateless
                                so this just signals UI clearance)

  GET  /api/dashboard/auth/admin/status
    headers: X-Admin-Token: <token>  (optional)
    200:    {"unlocked": bool, "expires_at": "..." | null,
              "configured": bool, "session_ttl_hours": int}

The admin_token is an HMAC-signed compact string carrying ``exp`` so the
backend doesn't need server-side state. Same JWT_SECRET keys it; the
prefix ``adm.`` distinguishes it from regular auth JWTs to prevent
cross-use.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from collections import defaultdict, deque
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request

# Mirrors routers.auth.SESSION_COOKIE_NAME. Defined locally so this module's
# CLI helper (python -m routers.admin_auth --hash) doesn't trigger the
# import-time JWT_SECRET check in routers.auth.
SESSION_COOKIE_NAME = "vocence_session"
from pydantic import BaseModel

# NOTE: `from routers.auth import require_admin_session` is deferred to
# inside the functions/deps that actually need it. routers.auth validates
# JWT_SECRET at import time and raises if it's missing or weak — that's
# correct for the running server, but it makes the standalone CLI helper
# (`python -m routers.admin_auth --hash`) fail before it can even prompt
# for a password. Lazy-importing keeps the CLI usable when .env isn't
# loaded yet.

_log = logging.getLogger(__name__)
router = APIRouter(prefix="/auth/admin", tags=["admin-auth"])


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

ADMIN_PASSWORD_HASH = (os.environ.get("ADMIN_PASSWORD_HASH") or "").strip()
SESSION_TTL_HOURS = max(1, int(os.environ.get("ADMIN_SESSION_TTL_HOURS") or "4"))
SESSION_TTL_SECONDS = SESSION_TTL_HOURS * 3600

# Rate limit: max attempts per IP per window. Tight by design — admin password
# guessing should be punished quickly.
MAX_ATTEMPTS = int(os.environ.get("ADMIN_UNLOCK_MAX_ATTEMPTS") or "5")
ATTEMPT_WINDOW_SEC = int(os.environ.get("ADMIN_UNLOCK_WINDOW_SEC") or "300")  # 5 min

# Use the existing JWT_SECRET to HMAC the admin token. Same backend secret;
# the ``adm.`` prefix prevents a leaked admin token being mis-used as a JWT.
JWT_SECRET = (os.environ.get("JWT_SECRET") or "").strip()
if not JWT_SECRET:
    _log.warning("JWT_SECRET is unset — admin unlock signing will fail at request time")


# ---------------------------------------------------------------------------
# Hash backend (argon2id with bcrypt-style fallback)
# ---------------------------------------------------------------------------

def _verify_password(plaintext: str, stored_hash: str) -> bool:
    """Verify ``plaintext`` against ``stored_hash``. Supports argon2id
    (preferred) and bcrypt. Returns False on any error — never re-raises
    so a malformed hash never leaks via the error message."""
    if not plaintext or not stored_hash:
        return False
    try:
        if stored_hash.startswith("$argon2"):
            from argon2 import PasswordHasher
            from argon2.exceptions import VerifyMismatchError, InvalidHash
            ph = PasswordHasher()
            try:
                ph.verify(stored_hash, plaintext)
                return True
            except (VerifyMismatchError, InvalidHash):
                return False
        if stored_hash.startswith("$2"):
            try:
                import bcrypt
                return bcrypt.checkpw(plaintext.encode("utf-8"), stored_hash.encode("utf-8"))
            except Exception:
                return False
        _log.warning("ADMIN_PASSWORD_HASH uses an unsupported scheme; expected $argon2id$ or $2b$")
        return False
    except ImportError:
        _log.error("argon2-cffi not installed but ADMIN_PASSWORD_HASH expects it")
        return False


def hash_password(plaintext: str) -> str:
    """Generate an argon2id hash. Used by the CLI helper."""
    from argon2 import PasswordHasher
    return PasswordHasher().hash(plaintext)


# ---------------------------------------------------------------------------
# Admin token (HMAC-signed, stateless)
# ---------------------------------------------------------------------------

def _b64u_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64u_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode((s + pad).encode("ascii"))


def mint_admin_token(email: str, ttl_seconds: int = SESSION_TTL_SECONDS) -> tuple[str, int]:
    """Mint a stateless admin token. Returns (token, expires_at_epoch)."""
    if not JWT_SECRET:
        raise HTTPException(status_code=503, detail="JWT_SECRET not configured")
    exp = int(time.time()) + ttl_seconds
    payload = json.dumps({"e": email, "exp": exp, "nonce": secrets.token_hex(8)}, separators=(",", ":"))
    payload_b64 = _b64u_encode(payload.encode("utf-8"))
    sig = hmac.new(JWT_SECRET.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    sig_b64 = _b64u_encode(sig)
    return f"adm.{payload_b64}.{sig_b64}", exp


def verify_admin_token(token: str | None, expected_email: str) -> dict | None:
    """Return decoded payload if valid+unexpired+email matches, else None.
    Constant-time signature comparison."""
    if not token or not token.startswith("adm."):
        return None
    parts = token.split(".")
    if len(parts) != 3:
        return None
    _, payload_b64, sig_b64 = parts
    if not JWT_SECRET:
        return None
    expected_sig = hmac.new(JWT_SECRET.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).digest()
    try:
        given_sig = _b64u_decode(sig_b64)
    except Exception:
        return None
    if not hmac.compare_digest(expected_sig, given_sig):
        return None
    try:
        payload = json.loads(_b64u_decode(payload_b64))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    if int(payload.get("exp") or 0) < int(time.time()):
        return None
    if payload.get("e") != expected_email:
        return None
    return payload


# ---------------------------------------------------------------------------
# Rate limiting (in-memory; per-IP)
# ---------------------------------------------------------------------------

_attempts: dict[str, deque[float]] = defaultdict(deque)


def _client_ip(request: Request) -> str:
    # Honor X-Forwarded-For when behind a reverse proxy. Take the first
    # entry (closest to the client). Otherwise the raw remote address.
    fwd = request.headers.get("x-forwarded-for", "").split(",")
    if fwd and fwd[0].strip():
        return fwd[0].strip()
    return request.client.host if request.client else "unknown"


def _check_rate_limit(ip: str) -> tuple[bool, int]:
    """Returns (allowed, retry_after_seconds). Prunes expired entries."""
    now = time.time()
    bucket = _attempts[ip]
    cutoff = now - ATTEMPT_WINDOW_SEC
    while bucket and bucket[0] < cutoff:
        bucket.popleft()
    if len(bucket) >= MAX_ATTEMPTS:
        retry = int(bucket[0] + ATTEMPT_WINDOW_SEC - now) + 1
        return False, max(1, retry)
    return True, 0


def _record_attempt(ip: str) -> None:
    _attempts[ip].append(time.time())


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

class UnlockRequest(BaseModel):
    password: str


def _require_admin_session_dep(
    authorization: Optional[str] = Header(None, alias="Authorization"),
    vocence_session: Optional[str] = Cookie(None, alias=SESSION_COOKIE_NAME),
) -> str:
    """Lazy-import shim around routers.auth.require_admin_session.

    The deferred import keeps the CLI helper (``python -m routers.admin_auth
    --hash``) usable on a fresh checkout where .env hasn't been loaded yet —
    routers.auth raises at import time if JWT_SECRET is missing/weak, which
    is correct for the running server but blocks the CLI from prompting for
    a password. Importing inside the request-time body sidesteps that.

    Forwards both the ``Authorization`` header and the ``vocence_session``
    cookie so admin endpoints work under the cookie-only auth scheme.
    """
    from routers.auth import require_admin_session
    return require_admin_session(authorization=authorization, vocence_session=vocence_session)


@router.post("/unlock")
async def unlock(
    body: UnlockRequest,
    request: Request,
    email: str = Depends(_require_admin_session_dep),
):
    if not ADMIN_PASSWORD_HASH:
        raise HTTPException(
            status_code=503,
            detail="Admin password not configured. Set ADMIN_PASSWORD_HASH "
                   "(generate one with: python -m routers.admin_auth --hash).",
        )

    ip = _client_ip(request)
    allowed, retry = _check_rate_limit(ip)
    if not allowed:
        raise HTTPException(
            status_code=429,
            detail=f"Too many attempts. Try again in {retry}s.",
        )

    if not _verify_password(body.password, ADMIN_PASSWORD_HASH):
        _record_attempt(ip)
        _log.warning("admin/unlock: failed attempt from ip=%s email=%s", ip, email)
        raise HTTPException(status_code=401, detail="Invalid admin password")

    token, exp = mint_admin_token(email)
    expires_at = datetime.fromtimestamp(exp, tz=timezone.utc).isoformat().replace("+00:00", "Z")
    _log.info("admin/unlock: granted to email=%s ip=%s exp=%s", email, ip, expires_at)
    return {
        "admin_token": token,
        "expires_at": expires_at,
        "session_ttl_hours": SESSION_TTL_HOURS,
    }


@router.post("/lock")
async def lock(_: str = Depends(_require_admin_session_dep)):
    # Tokens are stateless (HMAC-signed); no server-side revocation list.
    # The 'lock' button on the UI just clears sessionStorage. Returning
    # 200 lets the frontend treat it as a successful sign-out signal.
    return {"ok": True}


@router.get("/status")
async def status(
    request: Request,
    email: str = Depends(_require_admin_session_dep),
    x_admin_token: Optional[str] = Header(None, alias="X-Admin-Token"),
):
    payload = verify_admin_token(x_admin_token, email)
    if payload is None:
        return {
            "unlocked": False,
            "expires_at": None,
            "configured": bool(ADMIN_PASSWORD_HASH),
            "session_ttl_hours": SESSION_TTL_HOURS,
        }
    expires_at = datetime.fromtimestamp(int(payload["exp"]), tz=timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "unlocked": True,
        "expires_at": expires_at,
        "configured": True,
        "session_ttl_hours": SESSION_TTL_HOURS,
    }


# ---------------------------------------------------------------------------
# Dependency to gate routes
# ---------------------------------------------------------------------------

def require_admin_unlocked(
    email: str = Depends(_require_admin_session_dep),
    x_admin_token: Optional[str] = Header(None, alias="X-Admin-Token"),
) -> str:
    """Adds the sudo-mode gate on top of require_admin_session. Raise 401
    with code='admin_unlock_required' so the frontend knows to prompt for
    the password (vs. a regular auth failure which means re-login)."""
    if not ADMIN_PASSWORD_HASH:
        raise HTTPException(
            status_code=503,
            detail="Admin password not configured. Set ADMIN_PASSWORD_HASH in .env.",
        )
    payload = verify_admin_token(x_admin_token, email)
    if payload is None:
        raise HTTPException(
            status_code=401,
            detail={"code": "admin_unlock_required", "message": "Admin password required"},
        )
    return email


# ---------------------------------------------------------------------------
# CLI helper: python -m routers.admin_auth --hash
# ---------------------------------------------------------------------------

def _cli_main() -> int:
    import argparse
    import getpass

    p = argparse.ArgumentParser(description="Admin password hash generator for ADMIN_PASSWORD_HASH")
    p.add_argument("--hash", action="store_true", help="Generate argon2id hash of a password (prompted)")
    p.add_argument("--password", help="Password to hash (DANGEROUS: appears in shell history; use --hash with prompt)")
    args = p.parse_args()

    if not args.hash and not args.password:
        p.print_help()
        return 1

    if args.password:
        pw = args.password
    else:
        pw = getpass.getpass("Admin password: ")
        confirm = getpass.getpass("Confirm: ")
        if pw != confirm:
            print("Passwords don't match.")
            return 1

    if len(pw) < 8:
        print("Password too short (min 8 chars).")
        return 1

    try:
        h = hash_password(pw)
    except ImportError:
        print("argon2-cffi not installed. Run: pip install argon2-cffi")
        return 1
    print()
    print("Add this line to dashboard-backend/.env:")
    print(f"ADMIN_PASSWORD_HASH={h}")
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli_main())
