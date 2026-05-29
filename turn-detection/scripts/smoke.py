"""End-to-end smoke check against a running container.

Run after ``docker run`` to verify the pod is wired up correctly. Exits
0 if everything looks healthy; non-zero with a clear message otherwise.
Designed to be safe in CI — no model downloads on the client side.

Checks (in order — stops at the first failure):
  1. GET /healthz returns status=ok and both models loaded
  2. GET /metrics returns Prometheus text with the required asr_* counters
  3. POST /v1/turn-detector/batch with auth returns a probability
  4. POST same endpoint WITHOUT auth returns 401
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request


def fail(msg: str) -> None:
    print(f"\033[91mFAIL\033[0m {msg}")
    sys.exit(1)


def ok(msg: str) -> None:
    print(f"\033[92mOK\033[0m   {msg}")


def request(url: str, *, method: str = "GET",
            body: dict | None = None, headers: dict | None = None,
            expect_status: int = 200) -> tuple[int, bytes]:
    """Minimal HTTP helper using stdlib only — keeps the smoke script
    free of any pip-install steps so it works in fresh containers."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read() if hasattr(e, "read") else b""


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://localhost:8117",
                   help="Base URL of the running pod")
    p.add_argument("--api-key", required=True)
    p.add_argument("--wait", type=int, default=30,
                   help="Seconds to wait for /healthz to return status=ok before failing")
    args = p.parse_args()

    base = args.url.rstrip("/")

    # 1) Healthz, with a wait loop for the warming phase. The container
    # may have just started; the dispatcher does this same poll-and-wait
    # pattern.
    print(f"→ waiting up to {args.wait}s for {base}/healthz status=ok")
    t0 = time.time()
    last_body = b""
    while time.time() - t0 < args.wait:
        try:
            code, last_body = request(f"{base}/healthz")
            if code == 200:
                body = json.loads(last_body)
                if body.get("status") == "ok":
                    break
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.5)
    else:
        fail(f"/healthz never returned status=ok within {args.wait}s. Last body: {last_body!r}")
    body = json.loads(last_body)
    if not body.get("models", {}).get("smart_turn", {}).get("loaded"):
        fail(f"smart_turn not loaded: {body!r}")
    if not body.get("models", {}).get("turn_detector", {}).get("loaded"):
        fail(f"turn_detector not loaded: {body!r}")
    ok(f"/healthz status=ok, both models loaded (uptime={body.get('uptime_seconds')}s)")

    # 2) Metrics
    code, m_body = request(f"{base}/metrics")
    if code != 200:
        fail(f"/metrics returned {code}")
    m_text = m_body.decode("utf-8", errors="replace")
    for required in ("asr_requests_total", "asr_duration_ms_sum",
                     "asr_duration_ms_count", "asr_inflight"):
        if required not in m_text:
            fail(f"/metrics missing required counter {required!r}")
    ok("/metrics exposes all required asr_* counters")

    # 3) Batch with auth
    code, body_bytes = request(
        f"{base}/v1/turn-detector/batch",
        method="POST",
        headers={"X-API-Key": args.api_key},
        body={"in_progress": "hello"},
    )
    if code != 200:
        fail(f"batch with auth returned {code}, body={body_bytes!r}")
    body = json.loads(body_bytes)
    if not isinstance(body.get("p_end_of_turn"), (int, float)):
        fail(f"batch returned no p_end_of_turn: {body!r}")
    if not 0.0 <= body["p_end_of_turn"] <= 1.0:
        fail(f"p_end_of_turn out of range: {body!r}")
    ok(f"batch with auth → p_end_of_turn={body['p_end_of_turn']:.3f}, "
       f"inference_ms={body['inference_ms']}")

    # 4) Batch without auth
    code, _ = request(
        f"{base}/v1/turn-detector/batch",
        method="POST",
        body={"in_progress": "hello"},
        expect_status=401,
    )
    if code != 401:
        fail(f"batch without auth returned {code} (expected 401)")
    ok("batch without X-API-Key → 401")

    print()
    print("\033[92mAll smoke checks passed.\033[0m")
    return 0


if __name__ == "__main__":
    sys.exit(main())
