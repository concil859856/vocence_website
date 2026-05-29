"""End-to-end smoke check against a running knowledge-ingestion container.

Run after ``docker run`` to verify the pod is wired up correctly. Exits
0 on success, non-zero with a clear message otherwise.

Checks:
  1. GET /healthz returns status=ok with the expected fields
  2. GET /metrics exposes the required kn_* counters
  3. POST /v1/ingest/text without auth → 401
  4. POST /v1/ingest/text with auth → completes inline (sync path)
  5. POST /v1/query returns the ingested chunk with a sensible score
  6. DELETE /v1/sources/{id} removes the chunk
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request


def fail(msg: str) -> None:
    print(f"\033[91mFAIL\033[0m {msg}")
    sys.exit(1)


def ok(msg: str) -> None:
    print(f"\033[92mOK\033[0m   {msg}")


def request(
    url: str,
    *,
    method: str = "GET",
    body: dict | None = None,
    headers: dict | None = None,
) -> tuple[int, bytes]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json", **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read() if hasattr(e, "read") else b""


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://localhost:8118",
                   help="Base URL of the running pod")
    p.add_argument("--api-key", required=True)
    p.add_argument("--agent-id", default="ag_smoke")
    p.add_argument("--wait", type=int, default=30)
    args = p.parse_args()

    base = args.url.rstrip("/")

    # 1) Healthz w/ wait loop
    print(f"→ waiting up to {args.wait}s for {base}/healthz status=ok")
    t0 = time.time()
    last_body = b""
    while time.time() - t0 < args.wait:
        try:
            code, last_body = request(f"{base}/healthz")
            if code == 200 and json.loads(last_body).get("status") == "ok":
                break
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.5)
    else:
        fail(f"/healthz never status=ok in {args.wait}s. Last: {last_body!r}")
    body = json.loads(last_body)
    if body.get("embedding_dim") != 384:
        fail(f"embedding_dim != 384 (default BGE-small): {body!r}")
    ok(f"/healthz status=ok (embedding_dim={body['embedding_dim']}, "
       f"uptime={body['uptime_seconds']}s)")

    # 2) Metrics
    code, m_body = request(f"{base}/metrics")
    if code != 200:
        fail(f"/metrics returned {code}")
    m_text = m_body.decode("utf-8", errors="replace")
    for required in (
        "kn_ingest_jobs_total", "kn_query_total",
        "kn_query_duration_ms_sum", "kn_inflight_ingests",
    ):
        if required not in m_text:
            fail(f"/metrics missing {required!r}")
    ok("/metrics exposes required kn_* counters")

    # 3) No auth → 401
    code, _ = request(
        f"{base}/v1/ingest/text",
        method="POST",
        body={"source_type": "text", "agent_id": args.agent_id,
              "content": "x"},
    )
    if code != 401:
        fail(f"/v1/ingest/text without auth: expected 401, got {code}")
    ok("ingest without X-API-Key → 401")

    # 4) Sync text ingest
    code, ing_body = request(
        f"{base}/v1/ingest/text",
        method="POST",
        headers={"X-API-Key": args.api_key},
        body={
            "source_type": "text",
            "agent_id": args.agent_id,
            "title": "Smoke FAQ",
            "content": "To cancel a subscription, visit Account > Subscription > Cancel.",
        },
    )
    if code != 200:
        fail(f"/v1/ingest/text returned {code}: {ing_body!r}")
    ing = json.loads(ing_body)
    if ing.get("status") != "completed":
        fail(f"sync ingest didn't complete: {ing!r}")
    source_id = ing["source_id"]
    ok(f"sync ingest completed → source_id={source_id}, chunks={ing['chunk_count']}")

    # 5) Query returns the ingested chunk
    code, q_body = request(
        f"{base}/v1/query",
        method="POST",
        headers={"X-API-Key": args.api_key},
        body={
            "agent_id": args.agent_id,
            "text": "how do I cancel my subscription",
            "top_k": 3,
            "min_score": 0.3,
        },
    )
    if code != 200:
        fail(f"/v1/query returned {code}: {q_body!r}")
    q = json.loads(q_body)
    if not q.get("chunks"):
        fail(f"query returned no chunks: {q!r}")
    top = q["chunks"][0]
    if "cancel" not in top["text"].lower():
        fail(f"top chunk doesn't mention cancel: {top!r}")
    ok(f"query returned {len(q['chunks'])} chunks, top score={top['score']}, "
       f"total_ms={q['total_ms']}")

    # 6) Delete + verify
    code, d_body = request(
        f"{base}/v1/sources/{source_id}?agent_id={args.agent_id}",
        method="DELETE",
        headers={"X-API-Key": args.api_key},
    )
    if code != 200:
        fail(f"DELETE returned {code}: {d_body!r}")
    d = json.loads(d_body)
    if d.get("chunks_removed", 0) < 1:
        fail(f"delete didn't remove any chunks: {d!r}")
    ok(f"delete removed {d['chunks_removed']} chunk(s)")

    print()
    print("\033[92mAll smoke checks passed.\033[0m")
    return 0


if __name__ == "__main__":
    sys.exit(main())
