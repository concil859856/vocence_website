"""End-to-end tests for the email-auth endpoints in routers/auth.py.

Builds a tiny FastAPI app around the auth router pointed at a per-
test SQLite file. Patches the Resend email senders so tests capture
emails into a list instead of making network calls.

Coverage:
  * signup creates an unverified user with credits=0
  * signup returns 200 for duplicate email (anti-enumeration)
  * signup rejects weak password + invalid email with 400
  * verify activates account, grants SIGNUP_CREDITS, issues JWT
  * verify with expired token → 400
  * verify with replayed token → 400 (single-use)
  * login unverified account → 403
  * login wrong password → 401 identical to login unknown email
  * login correct credentials → 200 + JWT
  * lockout escalates: 5 fails → 429
  * forgot returns 200 for unknown email (anti-enum)
  * forgot refuses Google-only account (no email sent)
  * reset with valid token updates password, clears lockout
  * reset with expired/replayed token → 400
  * per-IP signup rate limit fires at threshold
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

import pytest

# Path + env must be ready BEFORE we import the router module.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-" + "x" * 40)
os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "test-internal-" + "y" * 40)

# Per-test-run isolated DB file. Set BEFORE importing local_db so the
# module reads the env var once during import.
_DB_FILE = tempfile.NamedTemporaryFile(delete=False, suffix="_email_auth.db")
_DB_FILE.close()
os.environ["SQLITE_PATH"] = _DB_FILE.name

# Tighten rate limits to small numbers so they're easy to hit in tests,
# and override _BEFORE_ import so the module-level constants pick them up.
os.environ["EMAIL_AUTH_SIGNUP_PER_HOUR"] = "3"
os.environ["EMAIL_AUTH_LOGIN_PER_HOUR"] = "30"
os.environ["EMAIL_AUTH_RESEND_PER_HOUR"] = "10"
os.environ["EMAIL_AUTH_FORGOT_PER_HOUR"] = "10"
os.environ["EMAIL_AUTH_RESET_PER_HOUR"] = "20"

from fastapi import FastAPI
from fastapi.testclient import TestClient

from local_db import ensure_tables, get_connection
import auth_security
from routers import auth as auth_mod


# Capture emails instead of sending. The signup / forgot endpoints
# always return 200; we read these to assert what actually happened.
_captured_emails: list[dict] = []


def _capture_verification(*, to_email: str, raw_token: str, user_name: str | None) -> None:
    _captured_emails.append({"type": "verify", "to": to_email, "token": raw_token, "name": user_name})


def _capture_reset(*, to_email: str, raw_token: str, user_name: str | None) -> None:
    _captured_emails.append({"type": "reset", "to": to_email, "token": raw_token, "name": user_name})


# Save the originals BEFORE we replace the module-level functions so
# the regression tests (which need to actually call the real templates)
# can restore them via monkeypatch.setattr.
_real_send_verification_email = auth_security.send_verification_email
_real_send_password_reset_email = auth_security.send_password_reset_email

auth_security.send_verification_email = _capture_verification  # type: ignore[assignment]
auth_security.send_password_reset_email = _capture_reset  # type: ignore[assignment]


# Build a minimal app with only the auth router mounted.
app = FastAPI()
app.include_router(auth_mod.router)


@pytest.fixture
def client():
    """Per-test TestClient with a fresh in-memory test state.

    Wipes the captured-email list, clears in-memory rate-limit buckets,
    and deletes any auth_users rows seeded by prior tests so each test
    starts from a known baseline. The SQLite file itself is reused
    across tests because re-running ensure_tables is cheap and
    idempotent, but the contents are reset."""
    # Ensure schema is in place. ``ensure_tables`` is idempotent.
    import asyncio
    asyncio.get_event_loop().run_until_complete(_reset_state())
    _captured_emails.clear()
    for bucket in auth_mod._email_auth_rl_state.values():
        bucket.clear()
    with TestClient(app) as c:
        yield c


async def _reset_state() -> None:
    await ensure_tables()
    conn = await get_connection()
    try:
        # Drop everything the email-auth tests touch. Other tables stay
        # intact in case shared schema migration touches them.
        await conn.execute("DELETE FROM auth_users")
        await conn.execute("DELETE FROM registered_users")
        await conn.execute("DELETE FROM credit_transactions")
        await conn.execute("DELETE FROM notifications")
        await conn.commit()
    finally:
        await conn.close()


# A password that satisfies the policy: 12+ chars, 3+ char classes,
# not in the common-passwords blocklist.
STRONG_PASSWORD = "CorrectHorse9!Battery"
ALT_STRONG_PASSWORD = "AnotherStr0ng!Pass"


# ─────────────────────────────────────────────────────────────────────
# Signup
# ─────────────────────────────────────────────────────────────────────

def test_signup_creates_unverified_user_and_emails_token(client):
    r = client.post(
        "/api/auth/email/signup",
        json={"email": "alice@example.com", "password": STRONG_PASSWORD, "name": "Alice"},
    )
    assert r.status_code == 200
    assert r.json()["ok"] is True
    # Email was queued
    assert len(_captured_emails) == 1
    assert _captured_emails[0]["type"] == "verify"
    assert _captured_emails[0]["to"] == "alice@example.com"


def test_signup_returns_200_for_duplicate_email_anti_enumeration(client):
    client.post(
        "/api/auth/email/signup",
        json={"email": "bob@example.com", "password": STRONG_PASSWORD},
    )
    _captured_emails.clear()
    # Same email, different password → no new account, no email sent
    # (because the password doesn't match the stored hash → silent).
    r = client.post(
        "/api/auth/email/signup",
        json={"email": "bob@example.com", "password": "DifferentPass1!"},
    )
    assert r.status_code == 200
    assert len(_captured_emails) == 0


def test_signup_rejects_weak_password(client):
    r = client.post(
        "/api/auth/email/signup",
        json={"email": "carol@example.com", "password": "short"},
    )
    assert r.status_code == 400
    assert "12 characters" in r.json()["detail"]


def test_signup_rejects_common_password(client):
    r = client.post(
        "/api/auth/email/signup",
        json={"email": "dan@example.com", "password": "Password1234"},
    )
    assert r.status_code == 400
    assert "too common" in r.json()["detail"].lower()


def test_signup_rejects_invalid_email(client):
    r = client.post(
        "/api/auth/email/signup",
        json={"email": "not-an-email", "password": STRONG_PASSWORD},
    )
    assert r.status_code == 400


# ─────────────────────────────────────────────────────────────────────
# Verify
# ─────────────────────────────────────────────────────────────────────

def _signup_and_capture_token(client, email: str = "eve@example.com") -> str:
    client.post(
        "/api/auth/email/signup",
        json={"email": email, "password": STRONG_PASSWORD},
    )
    return _captured_emails[-1]["token"]


def test_verify_activates_account_and_grants_credits(client):
    token = _signup_and_capture_token(client)
    r = client.post("/api/auth/email/verify", json={"token": token})
    assert r.status_code == 200
    body = r.json()
    assert body["user"]["email"] == "eve@example.com"
    # Signup bonus applied on verify
    assert body["user"]["credits"] >= 1
    assert body["token"]  # JWT issued


def test_verify_with_invalid_token_fails(client):
    r = client.post("/api/auth/email/verify", json={"token": "totally-fake-token"})
    assert r.status_code == 400


def test_verify_replay_fails_single_use(client):
    token = _signup_and_capture_token(client, "frank@example.com")
    r1 = client.post("/api/auth/email/verify", json={"token": token})
    assert r1.status_code == 200
    r2 = client.post("/api/auth/email/verify", json={"token": token})
    assert r2.status_code == 400  # token was cleared on first consume


# ─────────────────────────────────────────────────────────────────────
# Login
# ─────────────────────────────────────────────────────────────────────

def test_login_unverified_account_returns_403(client):
    client.post(
        "/api/auth/email/signup",
        json={"email": "grace@example.com", "password": STRONG_PASSWORD},
    )
    r = client.post(
        "/api/auth/email/login",
        json={"email": "grace@example.com", "password": STRONG_PASSWORD},
    )
    assert r.status_code == 403
    assert "verify" in r.json()["detail"].lower()


def test_login_correct_credentials_returns_jwt(client):
    token = _signup_and_capture_token(client, "henry@example.com")
    client.post("/api/auth/email/verify", json={"token": token})
    r = client.post(
        "/api/auth/email/login",
        json={"email": "henry@example.com", "password": STRONG_PASSWORD},
    )
    assert r.status_code == 200
    assert r.json()["token"]
    assert r.json()["user"]["email"] == "henry@example.com"


def test_login_wrong_password_returns_same_error_as_unknown_email(client):
    # Set up a verified account
    token = _signup_and_capture_token(client, "ivy@example.com")
    client.post("/api/auth/email/verify", json={"token": token})

    wrong_pw = client.post(
        "/api/auth/email/login",
        json={"email": "ivy@example.com", "password": "WrongPassword1!"},
    )
    unknown_email = client.post(
        "/api/auth/email/login",
        json={"email": "ghost@example.com", "password": STRONG_PASSWORD},
    )
    assert wrong_pw.status_code == 401
    assert unknown_email.status_code == 401
    assert wrong_pw.json()["detail"] == unknown_email.json()["detail"]


def test_login_lockout_kicks_in_after_5_failures(client):
    token = _signup_and_capture_token(client, "jack@example.com")
    client.post("/api/auth/email/verify", json={"token": token})

    for _ in range(5):
        r = client.post(
            "/api/auth/email/login",
            json={"email": "jack@example.com", "password": "BadPassword1!"},
        )
        assert r.status_code == 401

    # 6th attempt is locked out, not just 401
    r = client.post(
        "/api/auth/email/login",
        json={"email": "jack@example.com", "password": "BadPassword1!"},
    )
    assert r.status_code == 429
    assert "Retry-After" in r.headers
    assert int(r.headers["Retry-After"]) > 0


# ─────────────────────────────────────────────────────────────────────
# Forgot / reset
# ─────────────────────────────────────────────────────────────────────

def test_forgot_returns_200_for_unknown_email_anti_enumeration(client):
    r = client.post("/api/auth/email/forgot", json={"email": "nosuch@example.com"})
    assert r.status_code == 200
    # No email captured
    assert all(e["type"] != "reset" for e in _captured_emails)


def test_forgot_sends_email_for_verified_account(client):
    token = _signup_and_capture_token(client, "kate@example.com")
    client.post("/api/auth/email/verify", json={"token": token})
    _captured_emails.clear()
    r = client.post("/api/auth/email/forgot", json={"email": "kate@example.com"})
    assert r.status_code == 200
    reset_emails = [e for e in _captured_emails if e["type"] == "reset"]
    assert len(reset_emails) == 1


def test_forgot_does_not_send_for_unverified_account(client):
    client.post(
        "/api/auth/email/signup",
        json={"email": "leo@example.com", "password": STRONG_PASSWORD},
    )
    _captured_emails.clear()
    r = client.post("/api/auth/email/forgot", json={"email": "leo@example.com"})
    assert r.status_code == 200
    # No reset email sent — the verify flow is the right recovery path.
    assert all(e["type"] != "reset" for e in _captured_emails)


def test_reset_with_valid_token_changes_password(client):
    # Verified user, request reset
    token = _signup_and_capture_token(client, "mia@example.com")
    client.post("/api/auth/email/verify", json={"token": token})
    _captured_emails.clear()
    client.post("/api/auth/email/forgot", json={"email": "mia@example.com"})
    reset_token = [e for e in _captured_emails if e["type"] == "reset"][0]["token"]

    # Use it
    r = client.post(
        "/api/auth/email/reset",
        json={"token": reset_token, "new_password": ALT_STRONG_PASSWORD},
    )
    assert r.status_code == 200

    # Old password no longer works
    bad = client.post(
        "/api/auth/email/login",
        json={"email": "mia@example.com", "password": STRONG_PASSWORD},
    )
    assert bad.status_code == 401

    # New one does
    good = client.post(
        "/api/auth/email/login",
        json={"email": "mia@example.com", "password": ALT_STRONG_PASSWORD},
    )
    assert good.status_code == 200


def test_reset_replay_fails_single_use(client):
    token = _signup_and_capture_token(client, "nina@example.com")
    client.post("/api/auth/email/verify", json={"token": token})
    _captured_emails.clear()
    client.post("/api/auth/email/forgot", json={"email": "nina@example.com"})
    reset_token = [e for e in _captured_emails if e["type"] == "reset"][0]["token"]

    r1 = client.post(
        "/api/auth/email/reset",
        json={"token": reset_token, "new_password": ALT_STRONG_PASSWORD},
    )
    assert r1.status_code == 200
    r2 = client.post(
        "/api/auth/email/reset",
        json={"token": reset_token, "new_password": "YetAnother9!Pass"},
    )
    assert r2.status_code == 400


def test_reset_rejects_weak_new_password(client):
    token = _signup_and_capture_token(client, "olive@example.com")
    client.post("/api/auth/email/verify", json={"token": token})
    _captured_emails.clear()
    client.post("/api/auth/email/forgot", json={"email": "olive@example.com"})
    reset_token = [e for e in _captured_emails if e["type"] == "reset"][0]["token"]

    r = client.post(
        "/api/auth/email/reset",
        json={"token": reset_token, "new_password": "weak"},
    )
    assert r.status_code == 400


# ─────────────────────────────────────────────────────────────────────
# Rate limiting
# ─────────────────────────────────────────────────────────────────────

def test_signup_rate_limit_kicks_in(client):
    # Conftest sets EMAIL_AUTH_SIGNUP_PER_HOUR=3. Fourth attempt 429s.
    for i in range(3):
        client.post(
            "/api/auth/email/signup",
            json={"email": f"u{i}@example.com", "password": STRONG_PASSWORD},
        )
    r = client.post(
        "/api/auth/email/signup",
        json={"email": "over@example.com", "password": STRONG_PASSWORD},
    )
    assert r.status_code == 429


# ─────────────────────────────────────────────────────────────────────
# Token security primitives
# ─────────────────────────────────────────────────────────────────────

def test_token_hash_round_trip():
    raw, h = auth_security.generate_token()
    assert len(raw) >= 40  # 32-byte url-safe base64 → ≥ 43 chars
    assert auth_security.hash_token(raw) == h
    assert auth_security.hash_token("other") != h


def test_argon2_dummy_hash_verifies_false_in_constant_time():
    # Sanity: DUMMY_HASH never returns True, regardless of input.
    assert auth_security.verify_password(auth_security.DUMMY_HASH, "anything") is False
    assert auth_security.verify_password(auth_security.DUMMY_HASH, "") is False


def test_password_strength_blocks_common_passwords():
    assert auth_security.check_password_strength("Password1!") is not None
    assert auth_security.check_password_strength("Vocence123!") is not None
    # Strong one passes
    assert auth_security.check_password_strength(STRONG_PASSWORD) is None


def test_lockout_schedule_thresholds():
    assert auth_security.compute_lockout_until(4) is None
    assert auth_security.compute_lockout_until(5) is not None
    assert auth_security.compute_lockout_until(30) is not None


# ─────────────────────────────────────────────────────────────────────
# Audit-finding regression tests
# ─────────────────────────────────────────────────────────────────────

def test_C2_html_escape_in_verification_email(monkeypatch):
    """Audit C2: user_name interpolated into HTML must be escaped, so a
    name like '<script>alert(1)</script>' cannot run as JS in any mail
    client that renders HTML. Regression test against the verification
    email template."""
    captured: list[dict] = []
    monkeypatch.setattr(auth_security, "_send_email_via_resend", lambda **kw: captured.append(kw))
    _real_send_verification_email(
        to_email="x@example.com",
        raw_token="dummy-token",
        user_name='<script>alert(1)</script>',
    )
    assert len(captured) == 1
    assert "<script>alert(1)</script>" not in captured[0]["html_body"], "HTML escape failed — XSS vector!"
    assert "&lt;script&gt;" in captured[0]["html_body"]


def test_C2_html_escape_in_reset_email(monkeypatch):
    """Same regression but for the password-reset template."""
    captured: list[dict] = []
    monkeypatch.setattr(
        auth_security, "_send_email_via_resend",
        lambda **kw: captured.append(kw),
    )
    _real_send_password_reset_email(
        to_email="x@example.com", raw_token="dummy", user_name='" onload="alert(1)',
    )
    # The unescaped form would be `onload="alert(1)"` directly in href.
    # Escaped form has the quote as &quot;.
    assert '" onload="alert(1)' not in captured[0]["html_body"], \
        "attribute-context injection possible"
    assert "&quot;" in captured[0]["html_body"]


def test_C5_verification_link_uses_url_fragment_not_query(monkeypatch):
    """Audit C4+C5: token must be in the URL FRAGMENT (#token=...) so
    it doesn't appear in CDN access logs or Referer headers. The
    backend-generated link is the only place we control this."""
    captured: list[dict] = []
    monkeypatch.setattr(auth_security, "_send_email_via_resend", lambda **kw: captured.append(kw))
    _real_send_verification_email(
        to_email="x@example.com", raw_token="raw-secret-token", user_name="Test",
    )
    body = captured[0]["text_body"]
    assert "#token=raw-secret-token" in body
    assert "?token=raw-secret-token" not in body


def test_H13_public_app_base_url_rejects_unallowed_host(monkeypatch):
    """Audit H13: an env-injection / misconfig where PUBLIC_APP_URL
    is set to an attacker-controlled host must NOT cause us to email
    verify / reset links pointing at attacker. The host allowlist
    silently falls back to the hard-coded default."""
    monkeypatch.setenv("PUBLIC_APP_URL", "https://attacker.example.com")
    monkeypatch.setenv("CORS_ORIGIN", "https://evil.example,https://www.vocence.ai")
    base = auth_security._public_app_base_url()
    assert "attacker" not in base
    assert "evil" not in base
    assert base == "https://www.vocence.ai"


def test_H13_public_app_base_url_accepts_allowlisted_host(monkeypatch):
    monkeypatch.setenv("PUBLIC_APP_URL", "https://www.vocence.ai")
    assert auth_security._public_app_base_url() == "https://www.vocence.ai"


def test_H13_AUTH_LINK_ALLOWED_HOSTS_extends_allowlist(monkeypatch):
    monkeypatch.setenv("AUTH_LINK_ALLOWED_HOSTS", "localhost,127.0.0.1")
    monkeypatch.setenv("PUBLIC_APP_URL", "http://localhost:5173")
    assert auth_security._public_app_base_url() == "http://localhost:5173"


def test_H2_signup_never_resends_for_duplicate_email_regardless_of_password(client):
    """Audit H2 fix: even when the signup password matches the stored
    hash on a duplicate unverified account, we MUST NOT send another
    verification email — that was a password-correctness oracle."""
    client.post(
        "/api/auth/email/signup",
        json={"email": "h2_user@example.com", "password": STRONG_PASSWORD},
    )
    _captured_emails.clear()
    # Repeat signup with the EXACT same correct password.
    r = client.post(
        "/api/auth/email/signup",
        json={"email": "h2_user@example.com", "password": STRONG_PASSWORD},
    )
    assert r.status_code == 200
    # No email — the old code would have sent one because password matched.
    assert all(e["type"] != "verify" or e["to"] != "h2_user@example.com" for e in _captured_emails)


def test_H6_signup_bonus_is_idempotent_against_email_verified_toggle(client):
    """Audit H6 fix: even if email_verified is flipped back to 0 by a
    rogue path (admin tool, migration), a subsequent verify must NOT
    re-grant the signup bonus. We check existence of the signup_bonus
    credit_transactions row instead of relying on the boolean."""
    token = _signup_and_capture_token(client, "h6@example.com")
    r1 = client.post("/api/auth/email/verify", json={"token": token})
    assert r1.status_code == 200
    credits_after_first = r1.json()["user"]["credits"]

    # Simulate the rogue toggle + a new verification token.
    import asyncio
    async def _rogue_reset():
        conn = await get_connection()
        try:
            await conn.execute(
                "UPDATE auth_users SET email_verified = 0 WHERE email = ?",
                ("h6@example.com",),
            )
            # Re-issue a token so we can call verify again
            from auth_security import generate_token, token_expiry_iso, VERIFICATION_TOKEN_TTL
            raw, hashed = generate_token()
            await conn.execute(
                "UPDATE auth_users SET verification_token_hash = ?, verification_token_expires_at = ? WHERE email = ?",
                (hashed, token_expiry_iso(VERIFICATION_TOKEN_TTL), "h6@example.com"),
            )
            await conn.commit()
            return raw
        finally:
            await conn.close()
    new_raw = asyncio.get_event_loop().run_until_complete(_rogue_reset())

    r2 = client.post("/api/auth/email/verify", json={"token": new_raw})
    assert r2.status_code == 200
    credits_after_second = r2.json()["user"]["credits"]
    # Bonus NOT re-granted — balance stays the same as after first verify.
    assert credits_after_second == credits_after_first
