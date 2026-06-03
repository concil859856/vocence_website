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
import html
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

    Audit L44: enforce ``_MAX_PASSWORD_LEN`` here too (not just in the
    strength checker) so any code path that hashes a password without
    going through ``check_password_strength`` first — admin tools,
    migration scripts, future endpoints — can't be tricked into
    hashing a 10 MB string and pinning a worker on Argon2id for it.
    """
    if not password:
        raise ValueError("Password must not be empty")
    if len(password) > _MAX_PASSWORD_LEN:
        raise ValueError(f"Password exceeds {_MAX_PASSWORD_LEN}-character limit")
    return _HASHER.hash(password)


def verify_password(stored_hash: str, password: str) -> bool:
    """Verify ``password`` against ``stored_hash``. Returns False on
    mismatch, missing input, malformed hash, or any internal error —
    never raises.

    Audit M28: equalize timing on the ``InvalidHash`` path. Without
    this, a malformed ``stored_hash`` (corrupted column, legacy data,
    or a Google-only account whose ``password_hash`` slot was
    accidentally written as a non-Argon2 string) returns in
    microseconds while a real wrong-password takes ~50 ms — a timing
    oracle distinguishing "this row exists with a valid hash format"
    from other failure modes. We re-run verify against ``DUMMY_HASH``
    so the false branch always pays the full Argon2id cost.

    Audit L44: defense-in-depth length cap, same reasoning as
    ``hash_password``. An attacker can't tie up a worker on Argon2id
    verify by sending a huge "password" field.
    """
    if not stored_hash or not password:
        # Match the DUMMY_HASH timing for the "empty input" branch too,
        # so the existence of the row (vs missing input) can't be
        # distinguished by a fast vs slow no-op.
        try:
            _HASHER.verify(DUMMY_HASH, password or "x")
        except Exception:
            pass
        return False
    if len(password) > _MAX_PASSWORD_LEN:
        # Reject oversize input WITHOUT hashing it. The caller-supplied
        # value would never match anyway (since hash_password rejected
        # it at signup); short-circuiting here is safe and the timing
        # asymmetry against the verify path is acceptable — an attacker
        # who can detect "too long" learns only the max-length policy,
        # which is documented anyway.
        return False
    try:
        return _HASHER.verify(stored_hash, password)
    except VerifyMismatchError:
        return False
    except InvalidHash:
        # Hash is malformed — run a dummy verify to equalize timing
        # with the VerifyMismatchError branch above. Otherwise this
        # path returns in µs vs ~50 ms, leaking format-validity.
        try:
            _HASHER.verify(DUMMY_HASH, password)
        except Exception:
            pass
        return False
    except Exception:
        # Unexpected error (memory pressure, argon2 native crash, etc).
        # Best-effort timing equalization, then return False so the
        # endpoint doesn't surface infra problems as auth state.
        try:
            _HASHER.verify(DUMMY_HASH, password)
        except Exception:
            pass
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
# k-anonymity HIBP API check is a future addition; this catches the
# obvious lazy choices that no real user should be picking anyway.
#
# Audit M30: expanded to cover year-suffixed brand variants
# (vocence2024 etc) and a wider set of common-password roots. The
# previous list let "Vocence2026!" pass, which is exactly the kind
# of password a quick-thinking attacker tries first against a
# Vocence employee or partner.
_COMMON_PASSWORD_BLOCKLIST = frozenset(
    p.lower()
    for p in (
        "password", "password1", "password12", "password123", "password1234",
        "passw0rd", "p@ssw0rd", "p@ssword",
        "qwerty", "qwerty123", "qwertyuiop", "asdfgh", "asdfghjkl", "zxcvbn", "zxcvbnm",
        "abc123", "abcd1234", "abcdef123", "abcdefg",
        "letmein", "letmein123",
        "welcome", "welcome1", "welcome123",
        "admin", "admin123", "administrator", "root", "root123",
        "iloveyou", "iloveyou1", "iloveyou123",
        "monkey", "monkey123",
        "111111", "1111111", "11111111",
        "123123", "1234567", "12345678", "123456789", "1234567890",
        "vocence", "vocence1", "vocence12", "vocence123", "vocence1234",
        "vocence2023", "vocence2024", "vocence2025", "vocence2026", "vocence2027",
        "vocenceai", "voicechat", "voiceai", "voiceaiapp",
        "changeme", "changeme123",
        "default", "default123",
        "summer2024", "summer2025", "summer2026", "winter2024", "winter2025", "winter2026",
        "spring2024", "spring2025", "spring2026", "fall2024", "fall2025", "fall2026",
        "trustno1", "sunshine", "princess", "dragon", "shadow",
    )
)


# Keyboard-walk patterns we reject when they appear as a contiguous
# substring of the password (case-insensitive). Distinct from the
# blocklist because we want to catch e.g. "MyQwerty123!" too.
_KEYBOARD_WALKS = (
    "qwerty", "qwertyuiop", "asdfgh", "asdfghjkl", "zxcvbn", "zxcvbnm",
    "azerty", "qwertz",
    "1qaz2wsx", "1q2w3e4r", "1q2w3e",
)


def _has_long_repeat(password: str, run: int = 4) -> bool:
    """True when the same character appears ``run`` or more times in a row
    (case-insensitive). Catches ``aaaaaaaaaaaa`` and ``Llllllllllll1!``."""
    return re.search(r"(.)\1{" + str(run - 1) + r",}", password.lower()) is not None


def _has_long_sequence(password: str, run: int = 5) -> bool:
    """True when the password contains a monotonic run of ``run`` or more
    consecutive code points (case-insensitive). Catches ``abcdef``,
    ``123456``, ``zyxwv`` (reverse), and ``ABCDEFGHIJ1!``.
    """
    s = password.lower()
    for i in range(len(s) - run + 1):
        window = s[i : i + run]
        deltas = {ord(window[j + 1]) - ord(window[j]) for j in range(run - 1)}
        if deltas == {1} or deltas == {-1}:
            return True
    return False


def check_password_strength(
    password: str,
    *,
    user_context: tuple[str, ...] = (),
) -> str | None:
    """Validate ``password`` against the policy. Returns ``None`` if OK
    or a user-facing error string.

    ``user_context`` should contain identifiers the password MUST NOT
    contain — typically the email local-part and the user's display
    name at signup, plus the brand name. Each entry that's >= 4 chars
    is matched case-insensitively as a substring (audit M30:
    NIST 800-63B explicitly requires rejecting passwords that contain
    user-context terms; e.g. "alice" must not pass for alice@x.com).

    Audit M30 additions over the previous policy:
      * Long repeats (``aaaaaaaaaaa``) rejected via _has_long_repeat
      * Monotonic sequences (``abcdefgh``, ``876543``) rejected via
        _has_long_sequence
      * Keyboard walks (``qwerty``, ``asdfgh``, etc) rejected as
        substrings, not just exact matches
      * User-context substrings (email local-part, display name)
      * Expanded common-password blocklist with year-suffixed brand
        variants and season+year combos
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

    p_low = password.lower()
    if p_low in _COMMON_PASSWORD_BLOCKLIST:
        return "This password is too common. Please choose another."

    if _has_long_repeat(password):
        return "Password contains too many repeated characters."

    if _has_long_sequence(password):
        return "Password contains a sequential pattern. Please mix it up more."

    for walk in _KEYBOARD_WALKS:
        if walk in p_low:
            return "Password contains a common keyboard pattern. Please choose another."

    for ctx in user_context:
        ctx_low = (ctx or "").strip().lower()
        if len(ctx_low) >= 4 and ctx_low in p_low:
            return "Password must not contain your name or email."

    return None


# ─────────────────────────────────────────────────────────────────────
# Email validation
# ─────────────────────────────────────────────────────────────────────

# Cap on raw email-length input. RFC 5321 allows up to 254 chars; we
# enforce that and reject upfront before any DNS lookup or hashing.
_MAX_EMAIL_LEN = 254


def normalize_and_validate_email(raw_email: str, *, check_deliverability: bool = False) -> str:
    """Return a normalised email or raise ``ValueError``.

    Audit M32: normalization uses ``casefold()`` + Unicode NFKC. The
    previous ``.lower()`` was locale-independent but not safe for
    full Unicode case folding (Turkish dotless ı vs i, German ß,
    full-width Latin). Two RFC-valid addresses that should be
    treated as the same identity must hash to the same string at
    BOTH signup and login — inconsistency here is an account-takeover
    primitive. We apply the same transform everywhere by routing
    every email through this single function.

    ``check_deliverability=True`` does a DNS MX lookup, which adds
    latency and can fail in CI / offline environments. Default off;
    enable per-route when you want the extra verification (signup
    only, never login).
    """
    import unicodedata
    if not raw_email:
        raise ValueError("Email is required.")
    raw = raw_email.strip()
    if len(raw) > _MAX_EMAIL_LEN:
        raise ValueError("Email is too long.")
    try:
        result = validate_email(raw, check_deliverability=check_deliverability)
    except EmailNotValidError as e:
        raise ValueError(str(e)) from e
    normalized = result.normalized
    # NFKC folds compatibility-equivalent characters (full-width 'A' →
    # 'A', etc) so visually-identical inputs hash to the same string.
    # casefold() is Unicode-aware lower-casing (treats e.g. 'ß' as
    # 'ss', Turkish 'İ' as 'i̇') — more aggressive than .lower().
    return unicodedata.normalize("NFKC", normalized).casefold()


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


def _token_hmac_key() -> bytes:
    """Server-side secret keying for the verify / reset token HMAC.

    Reuses ``JWT_SECRET`` so we don't add another secret to manage;
    both have the same security envelope (server-side, never to a
    client) so this is fine. If ``AUTH_TOKEN_HMAC_KEY`` is set
    explicitly, that wins — useful when rotating JWT_SECRET without
    invalidating every outstanding verify / reset token at once.

    Audit L46: storing bare SHA-256(token) means anyone with WRITE
    access to ``verification_token_hash`` / ``password_reset_token_hash``
    (DB compromise, SQL-injection bug, rogue admin) can compute
    sha256(any_token) and inject a valid hash to forge a token.
    HMAC with a server-only key defeats this — write access alone
    is insufficient; the attacker also needs the HMAC key.
    """
    explicit = (os.environ.get("AUTH_TOKEN_HMAC_KEY") or "").strip()
    if explicit:
        return explicit.encode("utf-8")
    jwt_secret = (os.environ.get("JWT_SECRET") or "").strip()
    if not jwt_secret:
        # Fail-loud rather than fall back to no-HMAC — the whole point
        # is that the key must exist. Mirrors routers/auth.py's
        # JWT_SECRET refusal-to-boot.
        raise RuntimeError(
            "AUTH_TOKEN_HMAC_KEY or JWT_SECRET must be set for token hashing"
        )
    return jwt_secret.encode("utf-8")


def hash_token(raw_token: str) -> str:
    """Hash an incoming token for storage / lookup.

    Uses HMAC-SHA-256 with a server-side secret (``_token_hmac_key``)
    rather than bare SHA-256 — see audit L46. The result is 64-char
    hex, safe to store in a TEXT column and to use as a SQL index key.
    """
    return hmac.new(_token_hmac_key(), raw_token.encode("utf-8"), hashlib.sha256).hexdigest()


def constant_time_compare(a: str, b: str) -> bool:
    """``hmac.compare_digest`` over two strings.

    NOTE: ``.encode("utf-8")`` allocation time scales with input
    length, so callers MUST pass fixed-length inputs (e.g. 64-char
    hex hashes). Short-circuiting on length is fine, since
    compare_digest itself does so for unequal lengths — the leak
    here is purely the encode-allocation cost, which only matters
    if you're comparing variable-length user-supplied strings.
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

    Audit M31: this used to fail OPEN on a malformed timestamp (=
    treat as not-locked) — inconsistent with ``is_iso_in_past``
    which fails CLOSED, and the wrong direction for a security
    primitive. A corrupted ``locked_until`` column would silently
    let a brute-forcer bypass lockout. Now fails CLOSED: any
    unparseable value returns ``(True, 60)`` so the request is
    rejected, a 60-second cool-down is suggested, and operators get
    a server-side log line to investigate.
    """
    if not locked_until_iso:
        return False, 0
    try:
        dt = datetime.fromisoformat(locked_until_iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
    except (ValueError, TypeError):
        import logging
        logging.getLogger(__name__).warning(
            "is_account_locked: unparseable locked_until value %r — failing closed", locked_until_iso,
        )
        return True, 60
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

# Hosts allowed as ``_public_app_base_url`` output. Verification and
# password-reset links generated for outbound email MUST resolve to one
# of these — otherwise we'd be emailing bearer tokens at attacker-
# controlled URLs whenever PUBLIC_APP_URL / CORS_ORIGIN got misconfigured.
# Use ``AUTH_LINK_ALLOWED_HOSTS`` (comma-separated) to extend in dev.
_DEFAULT_ALLOWED_HOSTS = ("vocence.ai", "www.vocence.ai")


def _allowed_host_set() -> set[str]:
    extra = (os.environ.get("AUTH_LINK_ALLOWED_HOSTS") or "").strip()
    extra_hosts = [h.strip().lower() for h in extra.split(",") if h.strip()]
    return set(_DEFAULT_ALLOWED_HOSTS) | set(extra_hosts)


def _host_of(url: str) -> str:
    from urllib.parse import urlparse
    return (urlparse(url).hostname or "").lower()


def _public_app_base_url() -> str:
    """The base URL the verification / reset links should point at.

    Resolution order:
      1. ``PUBLIC_APP_URL`` if set AND host is in the allowlist.
      2. First ``CORS_ORIGIN`` entry IF its host is in the allowlist
         (covers localhost dev when AUTH_LINK_ALLOWED_HOSTS includes
         ``localhost`` / ``127.0.0.1``).
      3. Hard-coded ``https://www.vocence.ai``.

    We never silently fall back to an attacker-controllable value. A
    misconfigured ``CORS_ORIGIN`` (or env-injection bug elsewhere) that
    starts with ``https://evil.example`` is REFUSED — we use the
    hard-coded default instead so password-reset links cannot be
    redirected by env tampering.
    """
    allowed = _allowed_host_set()
    explicit = (os.environ.get("PUBLIC_APP_URL") or "").strip().rstrip("/")
    if explicit and _host_of(explicit) in allowed:
        return explicit
    cors = (os.environ.get("CORS_ORIGIN") or "").strip()
    if cors:
        first = cors.split(",")[0].strip().rstrip("/")
        if first and _host_of(first) in allowed:
            return first
    return "https://www.vocence.ai"


def _send_email_via_resend(
    *,
    to_email: str,
    subject: str,
    html_body: str,
    text_body: str,
) -> None:
    """Synchronous Resend send. Raises ``RuntimeError`` on transport /
    HTTP failure so callers can decide whether to surface a 5xx or
    swallow (anti-enumeration endpoints swallow and still return 200).

    NOTE: we strip the Resend response body from any raised exception
    so a 4xx response containing the raw token (which Resend may echo
    back in error messages) doesn't get logged to SIEM.
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
        "html": html_body,
        "text": text_body,
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
        with urllib.request.urlopen(req, timeout=15) as resp:
            resp.read()
    except urllib.error.HTTPError as e:
        # Drop the response body — Resend error responses can echo the
        # request payload, which contains the raw verify / reset token.
        # We do NOT want that string in exception messages or logs.
        raise RuntimeError(f"Resend HTTP {e.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise RuntimeError(f"Resend transport error: {type(e).__name__}") from None


# Token-bearing URLs put the token in the URL FRAGMENT (``#token=...``)
# rather than the query string. Fragments are NOT sent to servers and
# do NOT appear in CDN / proxy access logs, closing one of the major
# leak vectors for bearer-token email links. The frontend reads
# window.location.hash to extract the token, then immediately strips
# it via history.replaceState. Even if someone copies the URL out of
# their address bar, the token stops appearing in Referer headers as
# soon as the page is loaded once.
def _verify_link(base: str, raw_token: str) -> str:
    from urllib.parse import quote
    return f"{base}/auth/verify#token={quote(raw_token, safe='')}"


def _reset_link(base: str, raw_token: str) -> str:
    from urllib.parse import quote
    return f"{base}/auth/reset#token={quote(raw_token, safe='')}"


def _esc(s: str) -> str:
    """Shorthand for HTML-attribute-safe escape. ``quote=True`` ensures
    `"`, `'`, `<`, `>`, `&` are all encoded so user-controlled values
    (e.g. ``user_name``) cannot break out of attribute or element
    context in any HTML-rendering mail client. CRITICAL — without this
    a name like ``</p><script>...`` runs JS in Outlook/Gmail."""
    return html.escape(s, quote=True)


def send_verification_email(*, to_email: str, raw_token: str, user_name: str | None) -> None:
    """Email the user a one-click verification link.

    Swallows transport errors at the caller level — anti-enumeration.
    """
    base = _public_app_base_url()
    verify_url = _verify_link(base, raw_token)
    name = (user_name or "").strip() or "there"
    safe_name = _esc(name)
    safe_url = _esc(verify_url)
    subject = "Verify your Vocence email"
    text_body = (
        f"Hi {name},\n\n"
        f"Welcome to Vocence! Confirm your email by clicking the link below:\n\n"
        f"{verify_url}\n\n"
        f"The link expires in 24 hours. If you didn't sign up, you can ignore "
        f"this email.\n\n"
        f"— The Vocence team"
    )
    html_body = (
        f"<div style=\"font-family:-apple-system,Segoe UI,sans-serif;line-height:1.55;color:#111\">"
        f"<p>Hi {safe_name},</p>"
        f"<p>Welcome to Vocence! Confirm your email by clicking the button below:</p>"
        f"<p style=\"margin:24px 0\">"
        f"<a href=\"{safe_url}\" style=\"display:inline-block;padding:12px 24px;background:#0a0a0a;color:#DFFF00;text-decoration:none;border-radius:8px;font-weight:600\">Verify email</a>"
        f"</p>"
        f"<p style=\"font-size:13px;color:#666\">Or copy this link into your browser:<br>{safe_url}</p>"
        f"<p style=\"font-size:13px;color:#666\">The link expires in 24 hours. If you didn't sign up, you can ignore this email.</p>"
        f"<p style=\"font-size:13px;color:#666\">— The Vocence team</p>"
        f"</div>"
    )
    _send_email_via_resend(to_email=to_email, subject=subject, html_body=html_body, text_body=text_body)


def send_password_reset_email(*, to_email: str, raw_token: str, user_name: str | None) -> None:
    """Email the user a one-click password-reset link. Same security
    treatment as the verification email.
    """
    base = _public_app_base_url()
    reset_url = _reset_link(base, raw_token)
    name = (user_name or "").strip() or "there"
    safe_name = _esc(name)
    safe_url = _esc(reset_url)
    subject = "Reset your Vocence password"
    text_body = (
        f"Hi {name},\n\n"
        f"We received a request to reset your Vocence password. Click the link "
        f"below to choose a new one:\n\n"
        f"{reset_url}\n\n"
        f"The link expires in 15 minutes. If you didn't request a reset, you "
        f"can safely ignore this email — your password won't change.\n\n"
        f"— The Vocence team"
    )
    html_body = (
        f"<div style=\"font-family:-apple-system,Segoe UI,sans-serif;line-height:1.55;color:#111\">"
        f"<p>Hi {safe_name},</p>"
        f"<p>We received a request to reset your Vocence password. Click the button below to choose a new one:</p>"
        f"<p style=\"margin:24px 0\">"
        f"<a href=\"{safe_url}\" style=\"display:inline-block;padding:12px 24px;background:#0a0a0a;color:#DFFF00;text-decoration:none;border-radius:8px;font-weight:600\">Reset password</a>"
        f"</p>"
        f"<p style=\"font-size:13px;color:#666\">Or copy this link into your browser:<br>{safe_url}</p>"
        f"<p style=\"font-size:13px;color:#666\">The link expires in 15 minutes. If you didn't request a reset, you can safely ignore this email — your password won't change.</p>"
        f"<p style=\"font-size:13px;color:#666\">— The Vocence team</p>"
        f"</div>"
    )
    _send_email_via_resend(to_email=to_email, subject=subject, html_body=html_body, text_body=text_body)


def send_password_changed_email(*, to_email: str, user_name: str | None, client_ip: str | None = None) -> None:
    """Out-of-band notification that the user's password was just changed.

    Standard practice — gives the legitimate owner an instant signal
    if an attacker reset their password via a stolen reset token. If
    they didn't initiate the change, the email tells them to contact
    support and reset the password themselves (which will invalidate
    the attacker's session via the JWT ``iat`` check).
    """
    name = (user_name or "").strip() or "there"
    safe_name = _esc(name)
    where = f" from {_esc(client_ip)}" if client_ip else ""
    subject = "Your Vocence password was changed"
    text_body = (
        f"Hi {name},\n\n"
        f"Your Vocence password was just changed{(' from ' + client_ip) if client_ip else ''}. "
        f"If this was you, you can ignore this email.\n\n"
        f"If you did NOT change your password, your account may be compromised. "
        f"Reset your password immediately at https://www.vocence.ai/auth/reset "
        f"and contact space@vocence.ai with the time and IP above.\n\n"
        f"— The Vocence team"
    )
    html_body = (
        f"<div style=\"font-family:-apple-system,Segoe UI,sans-serif;line-height:1.55;color:#111\">"
        f"<p>Hi {safe_name},</p>"
        f"<p>Your Vocence password was just changed{where}. If this was you, you can ignore this email.</p>"
        f"<p style=\"padding:12px;background:#fff3cd;border-left:3px solid #f59e0b;font-size:14px\">"
        f"If you did <strong>not</strong> change your password, your account may be compromised. "
        f"Reset your password immediately and contact "
        f"<a href=\"mailto:space@vocence.ai\">space@vocence.ai</a> with the time and details above."
        f"</p>"
        f"<p style=\"font-size:13px;color:#666\">— The Vocence team</p>"
        f"</div>"
    )
    _send_email_via_resend(to_email=to_email, subject=subject, html_body=html_body, text_body=text_body)
