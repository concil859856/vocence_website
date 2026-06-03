"""Email-auth security primitives.

Centralises the security-sensitive helpers used by the email-auth
endpoints in ``routers/auth.py`` so the same defaults — Argon2id
parameters, token sizes, lockout schedule, dummy verify hash, anti-
enumeration timing — are applied everywhere. Keeping these in one
file makes them easy to audit and bump (OWASP refreshes the Argon2id
parameter recommendations roughly yearly).

Threat model and the defenses applied here:

* **Password cracking / DB leak**: Argon2id with memory_cost=64 MiB
  (OWASP 2024 baseline). Memory-hard → GPU-resistant. Each user gets
  a unique salt baked into the encoded hash.
* **Weak passwords**: ``check_password_strength`` enforces a 12-char
  minimum, 3-of-4 character classes, and a built-in blocklist of the
  most common passwords (subset of HIBP top-N). Reject before hash.
* **Brute force**: ``compute_lockout_until`` returns an exponentially
  increasing lockout window based on cumulative failed attempts.
* **Credential enumeration**: ``DUMMY_HASH`` lets ``verify_password``
  be called even when the user doesn't exist, so login response time
  is constant regardless of whether the email is in the DB.
* **Token theft / replay**: tokens are 256-bit random; only their
  SHA-256 hashes are stored. Single-use (caller clears on consume).
  Expiry enforced in SQL with a UTC ISO timestamp.
* **Timing leaks on email lookups**: ``constant_time_compare`` for
  hash comparisons, ``DUMMY_HASH`` for non-existent users.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError, InvalidHash
from email_validator import EmailNotValidError, validate_email


# ─────────────────────────────────────────────────────────────────────
# Argon2id configuration
# ─────────────────────────────────────────────────────────────────────
#
# OWASP 2024 baseline for Argon2id: m=64 MiB, t=3, p=4. These map to
# argon2-cffi as memory_cost (KiB), time_cost (iterations), parallelism.
# On a modern server CPU one verify takes ~50 ms — slow enough to
# punish brute force, fast enough to stay invisible at login latency.
#
# Bump these values (and only these) when CPUs get faster; the encoded
# hash stores the parameters used, so old hashes still verify.

_HASHER = PasswordHasher(
    time_cost=3,
    memory_cost=64 * 1024,   # 64 MiB
    parallelism=4,
    hash_len=32,
    salt_len=16,
)

# A pre-computed Argon2id hash of a random throwaway password, used
# when we want to spend the verify time on a request for a user that
# doesn't exist. Without this, ``login`` would return faster for
# unknown emails than for known ones — a textbook timing oracle.
#
# The actual plaintext is irrelevant; what matters is that
# ``verify_password(DUMMY_HASH, anything)`` always returns False and
# always takes the same wall-clock time as a real verify.
DUMMY_HASH = _HASHER.hash(secrets.token_hex(32))


def hash_password(password: str) -> str:
    """Return the PHC-encoded Argon2id hash of ``password``.

    The output is a single string (``$argon2id$v=19$m=...$<salt>$<hash>``)
    that encodes the algorithm, version, parameters, salt, and digest.
    Store it directly in ``auth_users.password_hash``; no separate
    salt column needed.
    """
    if not password:
        raise ValueError("Password must not be empty")
    return _HASHER.hash(password)


def verify_password(stored_hash: str, password: str) -> bool:
    """Verify ``password`` against ``stored_hash``. Returns False on
    mismatch, missing input, malformed hash, or any internal error —
    never raises. The caller cannot tell *why* verification failed,
    which is what we want for a login endpoint.
    """
    if not stored_hash or not password:
        return False
    try:
        return _HASHER.verify(stored_hash, password)
    except (VerifyMismatchError, InvalidHash, Exception):
        return False


def password_needs_rehash(stored_hash: str) -> bool:
    """True when ``stored_hash`` was computed with parameters weaker
    than the current ones. Caller should hash the plaintext fresh
    (in the same request, while it's still in memory) and overwrite
    ``password_hash``. Lets us raise the bar without forcing existing
    users to reset their passwords.
    """
    if not stored_hash:
        return False
    try:
        return _HASHER.check_needs_rehash(stored_hash)
    except (InvalidHash, Exception):
        return False


# ─────────────────────────────────────────────────────────────────────
# Password strength
# ─────────────────────────────────────────────────────────────────────

_MIN_PASSWORD_LEN = 12
_MAX_PASSWORD_LEN = 128  # argon2 inputs longer than this are silently
                         # hashed by argon2-cffi but provide no extra
                         # security; reject them as likely paste errors.

# Subset of the top-N most common breached passwords (HIBP / RockYou).
# Kept small + hard-coded so we don't ship a 1 MB wordlist. The full
# k-anonymity HIBP API check can be added later; this catches the
# obvious lazy choices that no real user should be picking anyway.
_COMMON_PASSWORD_BLOCKLIST = frozenset(
    p.lower()
    for p in (
        "password", "password1", "password12", "password123", "password1234",
        "passw0rd", "qwerty", "qwerty123", "qwertyuiop",
        "abc123", "abcd1234", "abcdef123",
        "letmein", "letmein123",
        "welcome", "welcome1", "welcome123",
        "admin", "admin123", "administrator",
        "iloveyou", "iloveyou1", "iloveyou123",
        "monkey", "monkey123",
        "111111", "1111111", "11111111",
        "123123", "1234567", "12345678", "123456789", "1234567890",
        "vocence", "vocence123", "vocence1",
        "voicechat", "voiceai", "voiceaiapp",
        "changeme", "changeme123",
        "default", "default123",
    )
)


def check_password_strength(password: str) -> str | None:
    """Validate ``password`` against the policy. Returns ``None`` if OK
    or a user-facing error string. The caller should pass the returned
    message to the user verbatim — it's worded as a single sentence
    that fits a form-validation toast.
    """
    if not password:
        return "Password is required."
    if len(password) < _MIN_PASSWORD_LEN:
        return f"Password must be at least {_MIN_PASSWORD_LEN} characters."
    if len(password) > _MAX_PASSWORD_LEN:
        return f"Password must be {_MAX_PASSWORD_LEN} characters or fewer."

    classes = 0
    if re.search(r"[a-z]", password): classes += 1
    if re.search(r"[A-Z]", password): classes += 1
    if re.search(r"\d", password): classes += 1
    if re.search(r"[^a-zA-Z0-9]", password): classes += 1
    if classes < 3:
        return (
            "Password must contain at least 3 of: lowercase, uppercase, "
            "digit, special character."
        )

    if password.lower() in _COMMON_PASSWORD_BLOCKLIST:
        return "This password is too common. Please choose another."

    return None


# ─────────────────────────────────────────────────────────────────────
# Email validation
# ─────────────────────────────────────────────────────────────────────

# Cap on raw email-length input. RFC 5321 allows up to 254 chars; we
# enforce that and reject upfront before any DNS lookup or hashing.
_MAX_EMAIL_LEN = 254


def normalize_and_validate_email(raw_email: str, *, check_deliverability: bool = False) -> str:
    """Return a normalised lowercase email or raise ``ValueError``.

    ``check_deliverability=True`` does a DNS MX lookup, which adds
    latency and can fail in CI / offline environments. Default off;
    enable per-route when you want the extra verification (signup
    only, never login).
    """
    if not raw_email:
        raise ValueError("Email is required.")
    raw = raw_email.strip()
    if len(raw) > _MAX_EMAIL_LEN:
        raise ValueError("Email is too long.")
    try:
        result = validate_email(raw, check_deliverability=check_deliverability)
    except EmailNotValidError as e:
        raise ValueError(str(e)) from e
    # ``normalized`` is the canonical lowercase IDNA-encoded form.
    return result.normalized.lower()


# ─────────────────────────────────────────────────────────────────────
# Tokens (email verification, password reset)
# ─────────────────────────────────────────────────────────────────────

# 32 random bytes → 43-char base64url string. URL-safe so we can email
# the raw token in a clickable link without further encoding.
_TOKEN_BYTES = 32


def generate_token() -> tuple[str, str]:
    """Return ``(raw_token, sha256_hex)``.

    Email/store the raw token; persist only the hash. On verification
    we hash the incoming token and compare server-side. A stolen DB
    cannot be used to forge active verification or reset links.
    """
    raw = secrets.token_urlsafe(_TOKEN_BYTES)
    return raw, hash_token(raw)


def hash_token(raw_token: str) -> str:
    """Hash an incoming token for storage / lookup. Uses SHA-256, not
    Argon2id, because tokens are already 256 bits of entropy — there's
    no value in slowing down the verify path. The hash is hex-encoded
    so it's safe to store in a TEXT column and use as a SQL index key.
    """
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def constant_time_compare(a: str, b: str) -> bool:
    """``hmac.compare_digest`` over two strings. Use this anywhere you
    compare a user-supplied secret to a stored value, even when the
    stored value is a hash — short-circuit comparison leaks length.
    """
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


# Expiry windows — keep these short. Users who actually wanted to
# verify or reset will click within minutes; anything stale is more
# likely to be replay or a leaked link.
VERIFICATION_TOKEN_TTL = timedelta(hours=24)
PASSWORD_RESET_TOKEN_TTL = timedelta(minutes=15)


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def token_expiry_iso(ttl: timedelta) -> str:
    return (datetime.now(timezone.utc) + ttl).isoformat().replace("+00:00", "Z")


def is_iso_in_past(iso_ts: str | None) -> bool:
    """True when ``iso_ts`` parses as a UTC timestamp earlier than now,
    OR when it's missing / unparseable (= treat as expired, fail-safe).
    """
    if not iso_ts:
        return True
    try:
        dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt < datetime.now(timezone.utc)
    except (ValueError, TypeError):
        return True


# ─────────────────────────────────────────────────────────────────────
# Account lockout schedule
# ─────────────────────────────────────────────────────────────────────
#
# Failed-attempt count → lockout duration. Exponential schedule so a
# brute-forcer pays geometrically more for each subsequent batch of
# attempts, while a real user fat-fingering their password gets at
# most a 1-minute timeout.
#
# Tier boundaries:
#   <  5 attempts → no lockout (just increment counter)
#   ≥  5 attempts → 1 minute
#   ≥ 10 attempts → 5 minutes
#   ≥ 15 attempts → 30 minutes
#   ≥ 20 attempts → 6 hours
#   ≥ 30 attempts → 24 hours (cap)
#
# Successful login zeros the counter; admin reset bypasses entirely.

_LOCKOUT_TIERS: list[tuple[int, timedelta]] = [
    (30, timedelta(hours=24)),
    (20, timedelta(hours=6)),
    (15, timedelta(minutes=30)),
    (10, timedelta(minutes=5)),
    (5,  timedelta(minutes=1)),
]


def compute_lockout_until(attempts: int) -> str | None:
    """Given the cumulative failed-attempt count *including the one
    that just failed*, return the ISO timestamp the account should be
    locked until — or ``None`` if no lockout applies yet.
    """
    for threshold, duration in _LOCKOUT_TIERS:
        if attempts >= threshold:
            return (datetime.now(timezone.utc) + duration).isoformat().replace("+00:00", "Z")
    return None


def is_account_locked(locked_until_iso: str | None) -> tuple[bool, int]:
    """Return ``(is_locked, retry_after_seconds)``.

    The integer is suitable for a ``Retry-After`` response header so
    well-behaved clients (and our own UI) can stop hammering the
    endpoint until the lock clears.
    """
    if not locked_until_iso:
        return False, 0
    try:
        dt = datetime.fromisoformat(locked_until_iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        return False, 0
    now = datetime.now(timezone.utc)
    if dt <= now:
        return False, 0
    return True, int((dt - now).total_seconds())


# ─────────────────────────────────────────────────────────────────────
# Email sender (verification + reset links)
# ─────────────────────────────────────────────────────────────────────
#
# Reuses the existing Resend integration pattern from
# ``routers/auth.py:_send_sales_via_resend_sync``. Kept here so the
# auth-email templates live next to the security primitives that
# generated their tokens — easy to audit that the link in the email
# matches what we hashed.

_RESEND_ENDPOINT = "https://api.resend.com/emails"


def _public_app_base_url() -> str:
    """The base URL the verification / reset links should point at.

    Reads ``PUBLIC_APP_URL`` (preferred) then falls back to the first
    entry in ``CORS_ORIGIN`` — that's where the frontend lives, so
    it's a safe default in dev. Production should set PUBLIC_APP_URL
    explicitly to avoid emailing links that point at localhost when
    a dev server is briefly first in the CORS list.
    """
    explicit = (os.environ.get("PUBLIC_APP_URL") or "").strip().rstrip("/")
    if explicit:
        return explicit
    cors = (os.environ.get("CORS_ORIGIN") or "").strip()
    if cors:
        first = cors.split(",")[0].strip().rstrip("/")
        if first:
            return first
    return "https://www.vocence.ai"


def _send_email_via_resend(
    *,
    to_email: str,
    subject: str,
    html: str,
    text: str,
) -> None:
    """Synchronous Resend send. Raises ``RuntimeError`` on transport /
    HTTP failure so callers can decide whether to surface a 5xx or
    swallow (anti-enumeration endpoints swallow and still return 200).
    """
    api_key = (os.environ.get("RESEND_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("RESEND_API_KEY is not configured")
    from_header = (os.environ.get("RESEND_FROM") or os.environ.get("SMTP_FROM") or "").strip()
    if not from_header:
        raise RuntimeError("RESEND_FROM is not configured")

    payload = {
        "from": from_header,
        "to": [to_email],
        "subject": subject,
        "html": html,
        "text": text,
    }
    req = urllib.request.Request(
        _RESEND_ENDPOINT,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": "VocenceDashboard/1.0 (+https://vocence.ai)",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Resend HTTP {e.code}: {body}") from e


def send_verification_email(*, to_email: str, raw_token: str, user_name: str | None) -> None:
    """Email the user a one-click verification link. The link target is
    a frontend route that POSTs the token to /api/auth/email/verify so
    we never expose the raw token in server logs / Referer headers.

    Swallows transport errors at the caller level — anti-enumeration.
    """
    base = _public_app_base_url()
    verify_url = f"{base}/auth/verify?token={raw_token}"
    name = (user_name or "").strip() or "there"
    subject = "Verify your Vocence email"
    text = (
        f"Hi {name},\n\n"
        f"Welcome to Vocence! Confirm your email by clicking the link below:\n\n"
        f"{verify_url}\n\n"
        f"The link expires in 24 hours. If you didn't sign up, you can ignore "
        f"this email.\n\n"
        f"— The Vocence team"
    )
    html = (
        f"<div style='font-family:-apple-system,Segoe UI,sans-serif;line-height:1.55;color:#111'>"
        f"<p>Hi {name},</p>"
        f"<p>Welcome to Vocence! Confirm your email by clicking the button below:</p>"
        f"<p style='margin:24px 0'>"
        f"<a href='{verify_url}' style='display:inline-block;padding:12px 24px;background:#0a0a0a;color:#DFFF00;text-decoration:none;border-radius:8px;font-weight:600'>Verify email</a>"
        f"</p>"
        f"<p style='font-size:13px;color:#666'>Or copy this link into your browser:<br>{verify_url}</p>"
        f"<p style='font-size:13px;color:#666'>The link expires in 24 hours. If you didn't sign up, you can ignore this email.</p>"
        f"<p style='font-size:13px;color:#666'>— The Vocence team</p>"
        f"</div>"
    )
    _send_email_via_resend(to_email=to_email, subject=subject, html=html, text=text)


def send_password_reset_email(*, to_email: str, raw_token: str, user_name: str | None) -> None:
    """Email the user a one-click password-reset link. Same security
    treatment as the verification email.
    """
    base = _public_app_base_url()
    reset_url = f"{base}/auth/reset?token={raw_token}"
    name = (user_name or "").strip() or "there"
    subject = "Reset your Vocence password"
    text = (
        f"Hi {name},\n\n"
        f"We received a request to reset your Vocence password. Click the link "
        f"below to choose a new one:\n\n"
        f"{reset_url}\n\n"
        f"The link expires in 15 minutes. If you didn't request a reset, you "
        f"can safely ignore this email — your password won't change.\n\n"
        f"— The Vocence team"
    )
    html = (
        f"<div style='font-family:-apple-system,Segoe UI,sans-serif;line-height:1.55;color:#111'>"
        f"<p>Hi {name},</p>"
        f"<p>We received a request to reset your Vocence password. Click the button below to choose a new one:</p>"
        f"<p style='margin:24px 0'>"
        f"<a href='{reset_url}' style='display:inline-block;padding:12px 24px;background:#0a0a0a;color:#DFFF00;text-decoration:none;border-radius:8px;font-weight:600'>Reset password</a>"
        f"</p>"
        f"<p style='font-size:13px;color:#666'>Or copy this link into your browser:<br>{reset_url}</p>"
        f"<p style='font-size:13px;color:#666'>The link expires in 15 minutes. If you didn't request a reset, you can safely ignore this email — your password won't change.</p>"
        f"<p style='font-size:13px;color:#666'>— The Vocence team</p>"
        f"</div>"
    )
    _send_email_via_resend(to_email=to_email, subject=subject, html=html, text=text)
