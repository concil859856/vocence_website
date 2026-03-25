#!/usr/bin/env python3
"""
Comprehensive Developer API end-to-end test:
  1) Website login (JWT)
  2) Create Developer API key
  3) Call POST /v1/tts/generate (success)
  4) Verify credits decreased + usage log created
  5) Rate-limit check (rpm+1 calls, expect 429 on the last)
  6) Revoke key
  7) Verify revoked key returns 403
  8) A few extra contract checks: missing auth, invalid key, empty text payload (400)

Required for key creation:
  - The account must have a successful Premium purchase (otherwise the backend returns 402).

Edit the `CONFIG` dict below to set required values:
  - `WEBSITE_API_BASE` (dashboard API base)
  - `DEVELOPER_API_BASE` (developer API base)
  - Either dashboard auth (`AUTH_JWT`) OR login fields (`LOGIN_EMAIL`, `LOGIN_NAME`)
    (the script auto-fills `LOGIN_GOOGLE_ID` if blank)
  - TTS fields (`TTS_TEXT` and optional `TTS_STYLE_INSTRUCTION`, `TTS_MODEL`)
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import os
import sys
import time
from dataclasses import dataclass
from typing import Any


# Edit these values directly; this script intentionally does not read from environment variables.
CONFIG: dict[str, Any] = {
    # Website/dashboard backend (used to create/revoke developer keys and view usage logs)
    "WEBSITE_API_BASE": "https://backend.vocence.ai/api",
    # Developer API base (used to call POST /v1/tts/generate)
    "DEVELOPER_API_BASE": "https://subnet.vocence.ai",

    # Auth for dashboard endpoints:
    # Option A (recommended for end-to-end lifecycle test): provide login fields
    "LOGIN_EMAIL": "axe.vldk@gmail.com",
    "LOGIN_NAME": "David",
    # Backend requires googleId to be a non-empty field, but if the account already
    # exists (matched by email), the value is not actually used for identity.
    # You can leave this blank and the script will auto-fill a placeholder.
    "LOGIN_GOOGLE_ID": "",
    # Option B: provide an existing dashboard JWT token to skip login
    "AUTH_JWT": "",

    # Create key name (will be used when calling POST /developer/keys)
    "TEST_KEY_NAME": "",

    # TTS request fields
    "TTS_TEXT": "Hello from Vocence Developer API (e2e test)",
    "TTS_STYLE_INSTRUCTION": None,  # set to e.g. "neutral voice" or leave None for default
    "TTS_MODEL": None,  # set only if you want to pick a specific provider/model

    # Rate limit behavior
    "RATE_LIMIT_TEST": True,
    "MIN_CREDITS_FOR_RATE_LIMIT": 5,
    "USAGE_LIMIT": 20,
}


@dataclass
class TestConfig:
    website_api_base: str
    developer_api_base: str
    login_email: str
    login_name: str
    login_google_id: str
    auth_jwt: str | None

    test_key_name: str
    tts_text: str
    tts_style_instruction: str | None
    tts_model: str | None

    rate_limit_test: bool
    min_credits_for_rate_limit: int
    usage_limit: int


class E2EError(RuntimeError):
    pass


async def request_json(
    session: Any,
    *,
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    json_body: dict[str, Any] | None = None,
    expected: int | None = None,
    timeout_s: float = 40,
) -> tuple[int, dict[str, Any] | None]:
    req_headers = headers or {}
    async with session.request(
        method,
        url,
        headers=req_headers,
        json=json_body,
        timeout=timeout_s,
    ) as resp:
        status = resp.status
        text = await resp.text()
        if expected is not None and status != expected:
            raise E2EError(f"Expected {expected} from {url}, got {status}. Body: {text[:600]}")
        if not text:
            return status, None
        try:
            data = await resp.json()
            # Some JSON responses are not objects; normalize to {"raw": ...} in that case.
            if isinstance(data, dict):
                return status, data
            return status, {"raw": data}
        except Exception:
            # Some endpoints might return plain text.
            return status, {"raw": text}


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _fmt_url(base: str, path: str) -> str:
    return f"{base.rstrip('/')}{path}"


async def main() -> int:
    parser = argparse.ArgumentParser(description="Vocence Developer API end-to-end test.")
    parser.add_argument("--website-api-base", default=str(CONFIG["WEBSITE_API_BASE"]))
    parser.add_argument("--developer-api-base", default=str(CONFIG["DEVELOPER_API_BASE"]))

    parser.add_argument("--email", default=str(CONFIG.get("LOGIN_EMAIL") or ""))
    parser.add_argument("--name", default=str(CONFIG.get("LOGIN_NAME") or ""))
    parser.add_argument("--google-id", default=str(CONFIG.get("LOGIN_GOOGLE_ID") or ""))
    parser.add_argument("--jwt", default=str(CONFIG.get("AUTH_JWT") or "") or None)

    parser.add_argument("--key-name", default=str(CONFIG.get("TEST_KEY_NAME") or "") or None)
    parser.add_argument("--tts-text", default=str(CONFIG.get("TTS_TEXT") or "Hello from Vocence Developer API (e2e test)"))
    parser.add_argument("--tts-style", default=str(CONFIG.get("TTS_STYLE_INSTRUCTION") or "") or None)
    parser.add_argument("--tts-model", default=str(CONFIG.get("TTS_MODEL") or "") or None)

    parser.add_argument("--rate-limit-test", default=str(bool(CONFIG.get("RATE_LIMIT_TEST", True))).lower())
    parser.add_argument("--min-credits-for-rate-limit", default=int(CONFIG.get("MIN_CREDITS_FOR_RATE_LIMIT", 5)))
    parser.add_argument("--usage-limit", default=int(CONFIG.get("USAGE_LIMIT", 20)))

    args = parser.parse_args()

    website_api_base = str(args.website_api_base).strip()
    developer_api_base = str(args.developer_api_base).strip()

    rate_limit_test = str(args.rate_limit_test).strip().lower() in {"1", "true", "yes", "on"}

    if not args.jwt:
        if not args.email or not args.name:
            raise SystemExit(
                "Missing login fields. Provide --email and --name, or set AUTH_JWT to skip login."
            )

    # /auth/login requires googleId to be non-empty, but for existing accounts it is ignored
    # because the backend first looks up the user by email.
    if not args.google_id:
        args.google_id = hashlib.sha256(f"{args.email}|{args.name}".encode("utf-8")).hexdigest()[:16]

    cfg = TestConfig(
        website_api_base=website_api_base,
        developer_api_base=developer_api_base,
        login_email=str(args.email).strip(),
        login_name=str(args.name).strip(),
        login_google_id=str(args.google_id).strip(),
        auth_jwt=str(args.jwt).strip() if args.jwt else None,
        test_key_name=str(args.key_name).strip()
        if args.key_name
        else f"e2e-key-{int(time.time())}",
        tts_text=str(args.tts_text),
        tts_style_instruction=str(args.tts_style).strip() if args.tts_style else None,
        tts_model=str(args.tts_model).strip() if args.tts_model else None,
        rate_limit_test=rate_limit_test,
        min_credits_for_rate_limit=int(args.min_credits_for_rate_limit),
        usage_limit=int(args.usage_limit),
    )

    import aiohttp

    timeout = aiohttp.ClientTimeout(total=45)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        print("\n[1/9] Authenticate (website JWT)")
        jwt = cfg.auth_jwt
        if not jwt:
            login_url = _fmt_url(cfg.website_api_base, "/auth/login")
            login_payload: dict[str, Any] = {
                "email": cfg.login_email,
                "name": cfg.login_name,
                "googleId": cfg.login_google_id,
                "picture": None,
            }
            status, data = await request_json(
                session,
                method="POST",
                url=login_url,
                json_body=login_payload,
                expected=200,
            )
            assert data is not None
            jwt = data["token"]
            print(f"  JWT received. User credits: {data.get('user', {}).get('credits')}")
        else:
            print("  Using AUTH_JWT (login skipped).")

        headers_auth = _bearer(jwt)

        print("\n[2/9] Fetch account summary (credits before)")
        summary_url = _fmt_url(cfg.website_api_base, "/account/summary")
        _, summary = await request_json(
            session,
            method="GET",
            url=summary_url,
            headers=headers_auth,
            expected=200,
        )
        assert summary is not None
        user = summary.get("user") or {}
        credits_before = int(user.get("credits") or 0)
        plan_code = user.get("planCode") or user.get("plan_code")
        print(f"  credits_before={credits_before} plan={plan_code}")

        print("\n[3/9] Create Developer API key")
        create_key_url = _fmt_url(cfg.website_api_base, "/developer/keys")
        key_status, key_resp = await request_json(
            session,
            method="POST",
            url=create_key_url,
            headers={**headers_auth, "Content-Type": "application/json"},
            json_body={"name": cfg.test_key_name},
            expected=None,
        )
        if key_resp is None:
            raise E2EError("Create key returned empty response.")

        # Backend returns 402 if Premium purchase hasn't happened yet.
        # Our request_json doesn't know expected status here, so detect.
        # If it's a raw error response, it will be {"raw": "..."}.
        if key_status == 402:
            detail = None
            if isinstance(key_resp, dict):
                detail = key_resp.get("detail") or key_resp.get("raw")
            raise E2EError(
                f"Key creation failed with 402 (Premium required). Detail: {detail}\n"
                f"Fix: complete Premium plan checkout first, then re-run."
            )
        if key_status != 200:
            raise E2EError(f"Key creation failed with HTTP {key_status}. Response: {key_resp}")

        if isinstance(key_resp, dict) and "detail" in key_resp and "key" not in key_resp:
            raise E2EError(
                f"Key creation failed: {key_resp.get('detail')}\n"
                f"Fix: complete Premium plan checkout first, then re-run."
            )
        if "plainKey" not in key_resp:
            raise E2EError(f"Unexpected create key response: {key_resp}")

        plain_key = key_resp["plainKey"]
        key_meta = key_resp["key"]
        key_id = key_meta["id"]
        rate_limit_rpm = int(key_meta.get("rateLimitRpm") or 4)
        print(f"  key_id={key_id} rate_limit_rpm={rate_limit_rpm}")

        print("\n[4/9] List developer keys (sanity)")
        list_url = _fmt_url(cfg.website_api_base, "/developer/keys")
        _, list_resp = await request_json(
            session,
            method="GET",
            url=list_url,
            headers=headers_auth,
            expected=200,
        )
        assert list_resp is not None
        keys = list_resp.get("keys") or []
        created = None
        for k in keys:
            if k.get("id") == key_id:
                created = k
                break
        if not created:
            raise E2EError("Created developer key not found in /developer/keys list.")
        if created.get("revokedAt") is not None:
            raise E2EError(f"Newly created key is already revoked (revokedAt={created.get('revokedAt')}).")

        print("\n[5/9] Call POST /v1/tts/generate (success)")
        generate_url = _fmt_url(cfg.developer_api_base, "/v1/tts/generate")
        gen_headers = {
            "Authorization": f"Bearer {plain_key}",
            "Content-Type": "application/json",
        }
        gen_payload: dict[str, Any] = {"text": cfg.tts_text}
        if cfg.tts_style_instruction is not None:
            gen_payload["style_instruction"] = cfg.tts_style_instruction
        if cfg.tts_model is not None:
            gen_payload["model"] = cfg.tts_model

        _, gen_resp = await request_json(
            session,
            method="POST",
            url=generate_url,
            headers=gen_headers,
            json_body=gen_payload,
            expected=200,
        )
        assert gen_resp is not None
        audio_url = gen_resp.get("audio_url") or ""
        credits_used = int(gen_resp.get("credits_used") or 0)
        credits_remaining = int(gen_resp.get("credits_remaining") or 0)
        request_chars = int(gen_resp.get("request_chars") or 0)
        print(
            f"  success: request_id={gen_resp.get('request_id')} provider={gen_resp.get('provider')} "
            f"audio_url_len={len(audio_url)} credits_used={credits_used} credits_remaining={credits_remaining} "
            f"request_chars={request_chars} latency_ms={gen_resp.get('latency_ms')}"
        )
        if not audio_url:
            raise E2EError("audio_url was empty on successful response.")

        print("\n[6/9] Contract check: empty text payload (400)")
        async with session.post(
            generate_url,
            headers=gen_headers,
            json={"text": ""},
        ) as resp:
            raw = await resp.text()
            if resp.status != 400:
                raise E2EError(
                    f"Expected 400 for empty text, got {resp.status}. Body: {raw[:600]}"
                )
            if "text is required" not in raw:
                # The message may be JSON: {"detail":"text is required"}
                # so do a best-effort substring check.
                print("  Warning: empty-text error detail didn't match exactly.")
        print("  empty-text → 400 OK")

        print("\n[7/9] Verify credits decreased + fetch usage logs")
        _, summary_after = await request_json(
            session,
            method="GET",
            url=summary_url,
            headers=headers_auth,
            expected=200,
        )
        assert summary_after is not None
        credits_after = int((summary_after.get("user") or {}).get("credits") or 0)
        if credits_after != credits_before - credits_used:
            raise E2EError(
                f"Credits mismatch: expected {credits_before - credits_used}, got {credits_after}"
            )
        print(f"  credits_after={credits_after} (delta={credits_before - credits_after})")

        usage_url = _fmt_url(cfg.website_api_base, f"/developer/usage?limit={cfg.usage_limit}")
        _, usage = await request_json(
            session,
            method="GET",
            url=usage_url,
            headers=headers_auth,
            expected=200,
        )
        assert usage is not None
        logs = usage.get("logs") or []
        latest = logs[0] if logs else None
        latest_endpoint = latest.get("endpoint") if isinstance(latest, dict) else None
        print(f"  usage logs fetched: count={len(logs)} latest_endpoint={latest_endpoint}")

        match = None
        for item in logs:
            if item.get("endpoint") == "/v1/tts/generate" and int(item.get("creditsUsed") or 0) == credits_used:
                match = item
                break
        if not match:
            print("  Warning: could not find a matching usage log entry for this run.")
        else:
            print(f"  usage log match: httpStatus={match.get('httpStatus')} status={match.get('status')} errorCode={match.get('errorCode')}")

        # ---- Rate limit test ----
        if cfg.rate_limit_test:
            print("\n[8/9] Rate-limit test (rpm probes + expect at least one 429)")
            credits_now = credits_after
            if credits_now < cfg.min_credits_for_rate_limit:
                print(
                    f"  Skipping rate-limit test: credits_now={credits_now} < min_required={cfg.min_credits_for_rate_limit}"
                )
            else:
                calls = rate_limit_rpm + 1
                any_429 = False
                for i in range(calls):
                    payload = {"text": "rate limit probe"}
                    async with session.post(generate_url, headers=gen_headers, json=payload) as resp:
                        raw = await resp.text()
                        if resp.status == 200:
                            pass
                        elif resp.status == 429:
                            any_429 = True
                        else:
                            raise E2EError(
                                f"Rate-limit probe #{i+1} expected 200/429, got {resp.status}. Body: {raw[:600]}"
                            )
                if not any_429:
                    raise E2EError(
                        "Rate-limit probe did not receive 429. "
                        "This can happen if TTS calls take longer than the 60s window, "
                        "or if rate limiting is disabled."
                    )
                print("  Rate-limit test complete (429 observed).")

        # ---- Revoke ----
        print("\n[9/9] Revoke API key and verify revoked requests fail")
        revoke_url = _fmt_url(cfg.website_api_base, f"/developer/keys/{key_id}/revoke")
        _, revoke_resp = await request_json(
            session,
            method="POST",
            url=revoke_url,
            headers={**headers_auth, "Content-Type": "application/json"},
            json_body=None,
            expected=200,
        )
        if revoke_resp is None:
            print("  Revoke ok (empty response).")
        else:
            print(f"  Revoke response: {revoke_resp}")

        # revoked key should return 403
        async with session.post(
            generate_url,
            headers=gen_headers,
            json=gen_payload,
        ) as resp:
            raw = await resp.text()
            if resp.status != 403:
                raise E2EError(f"Expected 403 after revoke, got {resp.status}. Body: {raw[:600]}")
            print(f"  Revoked key blocked as expected (403). detail: {raw[:120]}")

        print("\n  Verifying key is revoked in /developer/keys")
        _, list_resp_after = await request_json(
            session,
            method="GET",
            url=list_url,
            headers=headers_auth,
            expected=200,
        )
        assert list_resp_after is not None
        keys_after = list_resp_after.get("keys") or []
        revoked_row = None
        for k in keys_after:
            if k.get("id") == key_id:
                revoked_row = k
                break
        if not revoked_row:
            raise E2EError("Key missing from /developer/keys after revoke.")
        if revoked_row.get("revokedAt") is None:
            raise E2EError("Key revokedAt is still null after revoke.")

        print("\n[9/9] Additional contract checks: missing auth and invalid key")
        # Missing auth
        async with session.post(generate_url, headers={"Content-Type": "application/json"}, json={"text": cfg.tts_text}) as resp:
            raw = await resp.text()
            if resp.status != 401:
                raise E2EError(f"Expected 401 for missing auth, got {resp.status}. Body: {raw[:600]}")
        print("  Missing auth → 401 OK")

        # Invalid key
        bad_headers = {"Authorization": "Bearer invalid_key", "Content-Type": "application/json"}
        async with session.post(generate_url, headers=bad_headers, json={"text": cfg.tts_text}) as resp:
            raw = await resp.text()
            if resp.status != 401:
                raise E2EError(f"Expected 401 for invalid key, got {resp.status}. Body: {raw[:600]}")
        print("  Invalid key → 401 OK")

        print("  (Empty-text=400 was already checked earlier with the valid key.)")

        print("\n✅ Developer API end-to-end test finished successfully.")
        return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except E2EError as e:
        print(f"\n[FAILED] {e}\n", file=sys.stderr)
        raise

