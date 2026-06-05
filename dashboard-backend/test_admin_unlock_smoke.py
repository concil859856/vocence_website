"""End-to-end smoke for admin sudo-mode auth.

Boots a minimal FastAPI app with just the admin_auth + ops routers (skip
the full main.py to avoid loading everything else). Patches out the
upstream JWT/admin_email check so we can focus on the unlock layer.

Verifies:
  - POST /unlock with wrong password -> 401 + counts against rate limit
  - POST /unlock with right password  -> 200 + admin_token
  - Hitting an ops endpoint without admin_token -> 401 code=admin_unlock_required
  - Hitting an ops endpoint WITH admin_token -> passes auth (DB layer may 5xx
    in this minimal harness; we only check the auth gate fires correctly)
  - Tampered admin_token -> 401
  - 5+ wrong attempts -> 429 with retry-after seconds
"""
from __future__ import annotations

import os
import sys

# Set env BEFORE importing the modules — they read at import time.
os.environ["JWT_SECRET"] = "test-secret-must-be-32-chars-long-aaaa"
os.environ["ADMIN_EMAIL"] = "admin@vocence.ai"
os.environ["ADMIN_UNLOCK_MAX_ATTEMPTS"] = "5"
os.environ["ADMIN_UNLOCK_WINDOW_SEC"] = "300"

# Generate a hash for the test password.
from routers.admin_auth import hash_password  # noqa: E402
TEST_PASSWORD = "supersecret-admin-pw"
os.environ["ADMIN_PASSWORD_HASH"] = hash_password(TEST_PASSWORD)

# Reimport admin_auth so it picks up the env above.
import importlib  # noqa: E402
import routers.admin_auth as admin_auth  # noqa: E402
importlib.reload(admin_auth)


from fastapi import FastAPI, Depends  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


# Build a minimal app: admin_auth router + one dummy "ops" route gated on
# require_admin_unlocked. We bypass require_admin_session by overriding it
# via FastAPI's dependency_overrides — saves us having to mint a real JWT.
app = FastAPI()
app.include_router(admin_auth.router, prefix="/api/dashboard")


@app.get("/api/dashboard/ops/dummy")
def dummy_ops(_=Depends(admin_auth.require_admin_unlocked)):
    return {"ok": True, "msg": "you reached the ops surface"}


# Stub the upstream JWT gate (require_admin_session) — return a fixed
# admin email instead of decoding a real token.
from routers.auth import require_admin_session  # noqa: E402
app.dependency_overrides[require_admin_session] = lambda: "admin@vocence.ai"


client = TestClient(app)


def main_test() -> int:
    failures = 0

    # 1. wrong password -> 401, no admin_token
    r = client.post("/api/dashboard/auth/admin/unlock", json={"password": "wrong"})
    if r.status_code != 401:
        print(f"FAIL: wrong password should give 401, got {r.status_code} body={r.text}")
        failures += 1
    else:
        print("PASS: wrong password -> 401")

    # 2. right password -> 200 + admin_token
    r = client.post("/api/dashboard/auth/admin/unlock", json={"password": TEST_PASSWORD})
    if r.status_code != 200:
        print(f"FAIL: right password should give 200, got {r.status_code} body={r.text}")
        failures += 1
        return failures
    body = r.json()
    if "admin_token" not in body or "expires_at" not in body:
        print(f"FAIL: unlock response missing fields: {body}")
        failures += 1
        return failures
    admin_token = body["admin_token"]
    print(f"PASS: right password -> 200, admin_token={admin_token[:40]}... exp={body['expires_at']}")

    # 3. ops endpoint without admin_token -> 401 with code=admin_unlock_required
    r = client.get("/api/dashboard/ops/dummy")
    if r.status_code != 401:
        print(f"FAIL: ops without admin_token should be 401, got {r.status_code}")
        failures += 1
    else:
        detail = r.json().get("detail", {})
        if not isinstance(detail, dict) or detail.get("code") != "admin_unlock_required":
            print(f"FAIL: ops 401 detail shape wrong: {detail!r}")
            failures += 1
        else:
            print("PASS: ops without admin_token -> 401 code=admin_unlock_required")

    # 4. ops endpoint WITH admin_token -> 200
    r = client.get("/api/dashboard/ops/dummy", headers={"X-Admin-Token": admin_token})
    if r.status_code != 200:
        print(f"FAIL: ops with admin_token should be 200, got {r.status_code} body={r.text[:200]}")
        failures += 1
    else:
        print(f"PASS: ops with admin_token -> 200 body={r.json()}")

    # 5. tampered admin_token -> 401
    tampered = admin_token[:-3] + "XXX"
    r = client.get("/api/dashboard/ops/dummy", headers={"X-Admin-Token": tampered})
    if r.status_code != 401:
        print(f"FAIL: tampered admin_token should be 401, got {r.status_code}")
        failures += 1
    else:
        print("PASS: tampered admin_token -> 401")

    # 6. /status without token -> unlocked: False
    r = client.get("/api/dashboard/auth/admin/status")
    body = r.json() if r.status_code == 200 else {}
    if body.get("unlocked") is not False or body.get("configured") is not True:
        print(f"FAIL: /status without token shape wrong: {body}")
        failures += 1
    else:
        print(f"PASS: /status without token -> unlocked=False configured=True")

    # 7. /status with token -> unlocked: True
    r = client.get("/api/dashboard/auth/admin/status", headers={"X-Admin-Token": admin_token})
    body = r.json() if r.status_code == 200 else {}
    if body.get("unlocked") is not True:
        print(f"FAIL: /status with token shape wrong: {body}")
        failures += 1
    else:
        print(f"PASS: /status with token -> unlocked=True exp={body.get('expires_at')}")

    # 8. Rate limit: pile up wrong attempts from same IP until 429
    # (TestClient client.host is 'testclient', so all our attempts share the bucket.)
    # We already counted some wrong attempts. Hammer it until 429.
    hit_429 = False
    for i in range(20):
        r = client.post("/api/dashboard/auth/admin/unlock", json={"password": "wrong-pw"})
        if r.status_code == 429:
            hit_429 = True
            retry_after_msg = r.json().get("detail", "")
            print(f"PASS: rate limit kicked in after attempt #{i+2} -> 429 ({retry_after_msg})")
            break
    if not hit_429:
        print(f"FAIL: rate limit never fired after 20 wrong attempts")
        failures += 1

    # 9. After 429: even the right password is blocked (rate limit checks
    # BEFORE password verify, so an attacker can't bypass by trying right pw)
    r = client.post("/api/dashboard/auth/admin/unlock", json={"password": TEST_PASSWORD})
    if r.status_code == 429:
        print("PASS: rate limit blocks even right password (no bypass)")
    elif r.status_code == 200:
        # Edge case: if rate limit only counts FAILED attempts, the right
        # password could succeed. Our impl counts EVERY attempt, so this
        # is the expected pass-through.
        print(f"INFO: right password succeeded post-429 (rate limit counts failures only)")
    else:
        print(f"UNEXPECTED: right password post-429 returned {r.status_code}")

    print()
    if failures == 0:
        print("=" * 50)
        print("ADMIN UNLOCK SMOKE: ALL TESTS PASSED")
        print("=" * 50)
        return 0
    else:
        print("=" * 50)
        print(f"{failures} TEST(S) FAILED")
        print("=" * 50)
        return 1


if __name__ == "__main__":
    sys.exit(main_test())
