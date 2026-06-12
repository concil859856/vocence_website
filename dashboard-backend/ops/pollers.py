"""Background pollers that keep the ops registry in sync with reality.

Four asyncio tasks, all started from main.py's lifespan:

  health_poller    — every ~100s: GET /healthz on each pod, mark status,
                     auto-restart after consecutive failures, count uptime
  metrics_poller   — every ~300s: GET /metrics, compute deltas vs the cursor,
                     write per-minute rollup, bump daily totals
  update_detector  — every ~1h: compare each pod's image digest against
                     Docker Hub; log an event when a newer image exists
  cleanup_loop     — every hour: trim per-minute rows older than 30 days

Auto-restart contract (per user spec):
  * 3 consecutive failed health checks  ->  ``docker restart``
  * After a restart we enter ``grace_period_s`` quiet time (default 60 s):
    no further failure counting until grace expires
  * If 3 more failures happen AFTER the grace -> mark status='unhealthy',
    log an event, and STOP auto-restarting (avoids restart loops).
    Admin sees a red badge in the UI and must intervene.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone

import aiohttp

from . import db
from . import docker_hub
from . import pool
from . import ssh

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

HEALTH_INTERVAL_S = float(os.environ.get("OPS_HEALTH_INTERVAL_S") or "100")
METRICS_INTERVAL_S = float(os.environ.get("OPS_METRICS_INTERVAL_S") or "300")
UPDATE_DETECTOR_INTERVAL_S = float(os.environ.get("OPS_UPDATE_DETECTOR_INTERVAL_S") or "3600")
CLEANUP_INTERVAL_S = float(os.environ.get("OPS_CLEANUP_INTERVAL_S") or "3600")

HEALTH_REQUEST_TIMEOUT_S = float(os.environ.get("OPS_HEALTH_TIMEOUT_S") or "5")
METRICS_REQUEST_TIMEOUT_S = float(os.environ.get("OPS_METRICS_TIMEOUT_S") or "10")

FAILURES_BEFORE_RESTART = int(os.environ.get("OPS_HEALTHCHECK_FAILURES_BEFORE_RESTART") or "3")
RESTART_GRACE_S = float(os.environ.get("OPS_RESTART_GRACE_S") or "60")
DEPLOY_GRACE_S = float(os.environ.get("OPS_DEPLOY_GRACE_S") or "300")

METRIC_RETENTION_DAYS = int(os.environ.get("OPS_METRIC_RETENTION_DAYS") or "30")
# How long to keep voice-call recordings on disk. After this, the
# cleanup_loop unlinks the WAV and NULLs recording_path/recording_bytes
# on the voice_call_logs row (the log row itself stays — analytics are
# computed from those, not the audio). Default 30 days.
CALL_RECORDING_RETENTION_DAYS = int(
    os.environ.get("OPS_CALL_RECORDING_RETENTION_DAYS") or "30"
)
# Webhook delivery loop poll interval. Short by default so call.ended
# events surface to customer endpoints within a few seconds of the
# call ending. Tunable per deployment — bump up if you operate
# thousands of agents and need to control DB load.
WEBHOOK_DELIVERY_INTERVAL_S = float(
    os.environ.get("OPS_WEBHOOK_DELIVERY_INTERVAL_S") or "3"
)
WEBHOOK_DELIVERY_BATCH_SIZE = int(
    os.environ.get("OPS_WEBHOOK_DELIVERY_BATCH_SIZE") or "32"
)


# ---------------------------------------------------------------------------
# In-process state (small; transient)
# ---------------------------------------------------------------------------

# Per-pod "restart grace expires at unix-ts". While now() < this value we
# skip health checks for the pod (it just got auto-restarted and needs time
# to come back). Cleared on first successful healthz post-grace.
_RESTART_GRACE_UNTIL: dict[int, float] = {}

# Did we already auto-restart this pod since the last manual intervention?
# True means: if it fails 3 more times we go straight to 'unhealthy' instead
# of restarting again (avoids restart loops). Cleared by manual restart/redeploy.
_ALREADY_AUTO_RESTARTED: set[int] = set()

# Per-pod last successful healthz unix-ts — used to compute uptime delta
# attributed to each daily bucket.
_LAST_OK_TS: dict[int, float] = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now() -> float:
    return time.time()


def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


async def _http_get(url: str, *, bearer: str | None, timeout: float) -> tuple[int, dict | None, str | None]:
    """Return (status, json_body, error_msg). Never raises.

    We send the pod's API key under BOTH ``Authorization: Bearer`` and
    ``X-API-Key`` because the fleet has two auth conventions live:

    * Legacy pods (TTS, batch STT, music, ...) expect ``Bearer``.
    * The new asr_streaming_rt / turn_detection / knowledge_ingestion
      pods follow the per-spec ``X-API-Key`` convention.

    Each pod ignores the header it doesn't recognise, so dual-sending
    keeps a single poller working across both generations of images
    without per-service branching.
    """
    headers: dict[str, str] = {}
    if bearer:
        headers["Authorization"] = f"Bearer {bearer}"
        headers["X-API-Key"] = bearer
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
            async with session.get(url, headers=headers) as resp:
                if resp.content_type and "json" in resp.content_type:
                    try:
                        return resp.status, await resp.json(), None
                    except Exception:
                        return resp.status, None, f"non-JSON body (status={resp.status})"
                # Treat plain text as success if 200, otherwise read body for error message.
                body = (await resp.text())[:300]
                if resp.status == 200:
                    return resp.status, {}, None
                return resp.status, None, f"http {resp.status}: {body}"
    except asyncio.TimeoutError:
        return 0, None, "timeout"
    except aiohttp.ClientError as e:
        return 0, None, f"transport: {e}"
    except Exception as e:
        return 0, None, f"{type(e).__name__}: {e}"


def _decrypt_api_key(pod: dict) -> str | None:
    enc = pod.get("api_key_enc")
    if not enc:
        return None
    try:
        from . import crypto
        return crypto.decrypt(enc)
    except Exception as e:
        _log.warning("pod %s: api_key decrypt failed (%s)", pod["id"], e)
        return None


async def _trigger_auto_restart(pod: dict, server: dict, reason: str) -> None:
    """Issue docker restart over SSH and update pod state. Caller decides
    whether to actually trigger (based on consecutive_failures + already-
    restarted state)."""
    pod_id = int(pod["id"])
    cid = pod.get("container_id") or ""
    await db.log_pod_event(pod_id, "auto_restart", reason, {"container_id": cid})
    _log.warning("pod %s: auto-restarting (%s)", pod["name"], reason)
    if not cid:
        # No container to restart — pod row exists but its initial docker_run
        # never produced a container (failed deploy, manual db insert, etc.).
        # Previously this just logged and fell through, so next health cycle
        # the pod hit threshold again and we'd loop "no container_id; cannot
        # restart" forever. Mark it stopped + guard so the poller leaves it
        # alone until the admin redeploys.
        _log.error("pod %s has no container_id; marking stopped (admin must redeploy)", pod_id)
        await db.log_pod_event(pod_id, "auto_restart_failed", "no container_id; marked stopped")
        await db.update_pod(pod_id, status="stopped", consecutive_failures=0)
        _ALREADY_AUTO_RESTARTED.add(pod_id)
        return
    try:
        await ssh.docker_restart(server, cid)
    except ssh.SshError as e:
        _log.error("pod %s: docker restart failed: %s", pod_id, e)
        await db.log_pod_event(pod_id, "auto_restart_failed", str(e))
        await db.update_pod(pod_id, status="unhealthy", consecutive_failures=0)
        _ALREADY_AUTO_RESTARTED.add(pod_id)
        return

    _ALREADY_AUTO_RESTARTED.add(pod_id)
    _RESTART_GRACE_UNTIL[pod_id] = _now() + RESTART_GRACE_S
    await db.update_pod(
        pod_id,
        status="restarting",
        consecutive_failures=0,  # reset; we'll re-evaluate after grace
    )


# ---------------------------------------------------------------------------
# Health poller
# ---------------------------------------------------------------------------

async def health_poller() -> None:
    """Forever-loop: poll /healthz on every active pod, manage status
    transitions, and trigger auto-restart on persistent failure."""
    _log.info("ops.health_poller: starting (interval=%ds)", HEALTH_INTERVAL_S)
    cycle = 0
    while True:
        try:
            await _health_poll_once(cycle)
        except asyncio.CancelledError:
            raise
        except Exception:
            _log.exception("health_poller: unhandled error in cycle %d", cycle)
        cycle += 1
        await asyncio.sleep(HEALTH_INTERVAL_S)


async def _health_poll_once(cycle: int) -> None:
    pods = await db.list_pods(statuses=(
        "deploying", "online", "unhealthy", "restarting", "draining",
    ))
    if not pods:
        # Still refresh pool — it might be empty now.
        await pool.reload_pool()
        return

    # Materialize servers once per server_id for this cycle.
    server_cache: dict[int, dict | None] = {}

    poll_start = _now()
    today = _today_utc()
    for p in pods:
        pod_id = int(p["id"])

        # Honor restart grace.
        grace_until = _RESTART_GRACE_UNTIL.get(pod_id)
        if grace_until is not None:
            if _now() < grace_until:
                continue
            _RESTART_GRACE_UNTIL.pop(pod_id, None)

        sid = int(p["server_id"])
        if sid not in server_cache:
            server_cache[sid] = await db.get_server(sid)
        server = server_cache[sid]
        if not server or server.get("status") == "removed":
            await db.update_pod(pod_id, status="stopped")
            continue

        host = server["host"]
        port = int(p["port"])
        api_key = _decrypt_api_key(p)
        url = f"http://{host}:{port}/healthz"

        status_code, body, err = await _http_get(url, bearer=api_key, timeout=HEALTH_REQUEST_TIMEOUT_S)

        if status_code == 200 and isinstance(body, dict):
            # Healthy — clear failures, mark online, attribute uptime.
            await db.update_pod(
                pod_id,
                status="online",
                consecutive_failures=0,
                last_healthz_at=_iso_now(),
                last_healthz_json=json.dumps(body),
            )
            # Reset the "already auto-restarted" guard so future failures are
            # treated as a fresh incident, not a relapse.
            _ALREADY_AUTO_RESTARTED.discard(pod_id)

            # Uptime accounting: attribute the time-since-last-OK (capped at
            # 2× the poll interval to avoid huge jumps after a sleep/pause).
            last = _LAST_OK_TS.get(pod_id)
            if last is not None:
                elapsed = min(_now() - last, HEALTH_INTERVAL_S * 2)
                if elapsed > 0:
                    await db.add_uptime_seconds(pod_id, today, int(elapsed))
            _LAST_OK_TS[pod_id] = _now()
            continue

        # Failure path — increment counter, decide on action.
        fails = int(p.get("consecutive_failures") or 0) + 1
        _LAST_OK_TS.pop(pod_id, None)

        # Deploy grace: pods in "deploying" status get up to DEPLOY_GRACE_S
        # (default 300s) before failures count toward auto-restart. This
        # covers the first-boot model download (can be 7+ GB / 60-300s).
        # Still poll (so they flip to "online" on first success), but don't
        # escalate failures. Docker's HEALTHCHECK --start-period does the
        # same thing for the container-level health — this is the ops-layer
        # equivalent.
        if p.get("status") == "deploying":
            updated = p.get("updated_at") or ""
            try:
                deploy_ts = datetime.fromisoformat(updated.replace("Z", "+00:00")).timestamp()
            except (ValueError, AttributeError):
                deploy_ts = 0
            if _now() - deploy_ts < DEPLOY_GRACE_S:
                await db.update_pod(pod_id, consecutive_failures=fails)
                if fails == 1 or fails % 10 == 0:
                    _log.info(
                        "pod %s health-check failed (%d) during deploy grace (%.0fs left): %s",
                        p["name"], fails, DEPLOY_GRACE_S - (_now() - deploy_ts),
                        err or f"http {status_code}",
                    )
                continue

        if fails < FAILURES_BEFORE_RESTART:
            await db.update_pod(pod_id, consecutive_failures=fails)
            _log.info(
                "pod %s health-check failed (%d/%d): %s",
                p["name"], fails, FAILURES_BEFORE_RESTART, err or f"http {status_code}",
            )
            continue

        # Threshold crossed.
        if pod_id in _ALREADY_AUTO_RESTARTED:
            # Restart already happened — escalate to permanent unhealthy.
            await db.update_pod(pod_id, status="unhealthy", consecutive_failures=0)
            await db.log_pod_event(
                pod_id, "marked_unhealthy",
                f"{fails} health-check failures AFTER auto-restart; admin intervention required",
                {"last_error": err},
            )
            _log.error(
                "pod %s: marked UNHEALTHY (3 failures post-restart). Last error: %s",
                p["name"], err,
            )
        else:
            await _trigger_auto_restart(p, server, f"{fails} consecutive failures: {err or status_code}")


# ---------------------------------------------------------------------------
# Metrics poller
# ---------------------------------------------------------------------------

async def metrics_poller() -> None:
    _log.info("ops.metrics_poller: starting (interval=%ds)", METRICS_INTERVAL_S)
    while True:
        try:
            await _metrics_poll_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            _log.exception("metrics_poller: unhandled error")
        await asyncio.sleep(METRICS_INTERVAL_S)


async def _metrics_poll_once() -> None:
    # Only scrape pods we believe are reachable.
    pods = await db.list_pods(statuses=("online", "draining"))
    if not pods:
        # After processing health changes, refresh the dispatcher pool.
        await pool.reload_pool()
        return

    server_cache: dict[int, dict | None] = {}
    today = _today_utc()

    for p in pods:
        pod_id = int(p["id"])
        sid = int(p["server_id"])
        if sid not in server_cache:
            server_cache[sid] = await db.get_server(sid)
        server = server_cache[sid]
        if not server:
            continue

        base = f"http://{server['host']}:{int(p['port'])}"
        api_key = _decrypt_api_key(p)

        # Try /metrics.json first (newer pods that expose a JSON-shaped
        # dashboard snapshot — knowledge_ingestion, turn_detection, the
        # newer asr_streaming_rt). Fall back to legacy /metrics for
        # older TTS/STT pods that already returned JSON on the bare
        # /metrics endpoint. Pods that ONLY expose Prometheus text on
        # /metrics would otherwise silently report all-zeros because
        # ``_http_get`` returns an empty dict for non-JSON bodies.
        status_code, body, err = await _http_get(
            f"{base}/metrics.json", bearer=api_key, timeout=METRICS_REQUEST_TIMEOUT_S,
        )
        if status_code != 200 or not isinstance(body, dict) or not body:
            # 404 (older pod) / 200 with empty dict (legacy JSON path)
            # → retry the bare /metrics endpoint.
            status_code, body, err = await _http_get(
                f"{base}/metrics", bearer=api_key, timeout=METRICS_REQUEST_TIMEOUT_S,
            )
        if status_code != 200 or not isinstance(body, dict):
            _log.debug("pod %s: /metrics scrape failed: %s", p["name"], err or f"http {status_code}")
            continue

        # Cache the raw snapshot for the per-pod detail view.
        await db.update_pod(pod_id, last_metrics_at=_iso_now(), last_metrics_json=json.dumps(body))

        # Compute deltas vs the cursor.
        cursor = await db.get_metric_cursor(pod_id)
        cur_uptime = int(body.get("uptime_seconds") or 0)
        cur_ok = int(body.get("requests_ok") or 0)
        cur_err = body.get("requests_err") or {}
        cur_dsum = float(body.get("duration_ms_sum") or 0)
        cur_dcount = int(body.get("duration_ms_count") or 0)
        cur_bytes = int(body.get("bytes_sent_total") or 0)
        cur_audio = int(body.get("audio_ms_total") or 0)
        cur_p95 = float(body.get("duration_ms_p95") or 0)
        cur_inflight = int(body.get("inflight") or 0)

        if cursor is None or cur_uptime < int(cursor.get("last_uptime_seconds") or 0):
            # Either first scrape ever OR the process restarted (uptime went
            # DOWN). Treat current values as the new baseline; record no
            # delta for this minute (we'd otherwise spike on restart noise).
            await db.upsert_metric_cursor(pod_id, body)
            continue

        d_ok = max(0, cur_ok - int(cursor["last_requests_ok"]))
        prev_err = json.loads(cursor["last_requests_err_json"] or "{}")
        delta_err: dict[str, int] = {}
        for code, count in cur_err.items():
            d = max(0, int(count) - int(prev_err.get(code, 0)))
            if d:
                delta_err[code] = d
        d_dsum = max(0.0, cur_dsum - float(cursor["last_duration_ms_sum"]))
        d_dcount = max(0, cur_dcount - int(cursor["last_duration_ms_count"]))
        d_bytes = max(0, cur_bytes - int(cursor["last_bytes_sent"]))
        d_audio = max(0, cur_audio - int(cursor["last_audio_ms"]))

        # Bucket by current wall-minute. Slight skew (poll cycle ~30s vs
        # 60s buckets) is fine — counters merge into whichever minute we hit.
        minute_ts = int(_now() // 60)
        await db.add_minute_delta(
            pod_id, minute_ts,
            requests_ok=d_ok,
            requests_err=delta_err,
            duration_ms_sum=d_dsum,
            duration_ms_count=d_dcount,
            duration_ms_p95=cur_p95,
            inflight=cur_inflight,
            bytes_sent=d_bytes,
            audio_ms=d_audio,
        )
        # Daily rollup totals (cheap incremental bump).
        d_err_total = sum(delta_err.values())
        await db.add_daily_request_totals(
            pod_id, today,
            requests_total=d_ok + d_err_total,
            errors_total=d_err_total,
            audio_ms_total=d_audio,
            bytes_sent_total=d_bytes,
        )

        # Advance cursor.
        await db.upsert_metric_cursor(pod_id, body)

    # After each metrics cycle, push the latest healthz-derived cap/state
    # into the dispatcher in-memory cache.
    await pool.reload_pool()


# ---------------------------------------------------------------------------
# Image-update detector
# ---------------------------------------------------------------------------

async def update_detector_loop() -> None:
    _log.info("ops.update_detector: starting (interval=%ds)", UPDATE_DETECTOR_INTERVAL_S)
    while True:
        try:
            await _update_detector_once()
        except asyncio.CancelledError:
            raise
        except Exception:
            _log.exception("update_detector: unhandled error")
        await asyncio.sleep(UPDATE_DETECTOR_INTERVAL_S)


async def _update_detector_once() -> None:
    """For each unique image:tag across active pods, fetch the upstream
    digest from Docker Hub and log an event for any pod running an older
    one. Dedupe so the same pod doesn't get repeated 'update_available'
    events — we only log when the upstream digest CHANGES."""
    pods = await db.list_pods(statuses=("online", "deploying", "draining", "unhealthy"))
    if not pods:
        return

    # Group pods by image:tag so we hit Docker Hub once per unique image.
    by_image: dict[str, list[dict]] = {}
    for p in pods:
        by_image.setdefault(p["image"], []).append(p)

    for image, group in by_image.items():
        upstream = await docker_hub.fetch_latest_digest(image)
        if upstream is None:
            continue
        for p in group:
            current = (p.get("image_digest") or "").strip()
            if current == upstream.digest:
                continue
            if not current:
                # We never recorded a digest for this pod — populate from
                # the upstream value as the implicit baseline (avoids spam
                # on the first detector run after a deploy).
                await db.update_pod(int(p["id"]), image_digest=upstream.digest)
                continue
            # Real update available.
            await db.log_pod_event(
                int(p["id"]),
                "update_available",
                f"{image} has a new digest upstream",
                {"current": current, "upstream": upstream.digest, "last_updated": upstream.last_updated},
            )
            _log.info("pod %s: update available for %s", p["name"], image)


# ---------------------------------------------------------------------------
# Cleanup loop (retention of per-minute metrics)
# ---------------------------------------------------------------------------

async def webhook_delivery_loop() -> None:
    """Drain ``webhook_deliveries`` rows on a tight cadence. Lighter
    than the cleanup loop because each tick may do real HTTP work —
    the function inside handles its own backoff per delivery, so
    repeated empty ticks are cheap (one SELECT each)."""
    _log.info(
        "ops.webhook_delivery_loop: starting (interval=%ss batch=%d)",
        WEBHOOK_DELIVERY_INTERVAL_S, WEBHOOK_DELIVERY_BATCH_SIZE,
    )
    # Import inside the loop so the rest of ops/pollers stays light
    # and unit tests that don't touch webhooks don't drag in aiohttp.
    from webhooks_service import deliver_pending_webhooks
    while True:
        try:
            attempted, delivered, failed = await deliver_pending_webhooks(
                WEBHOOK_DELIVERY_BATCH_SIZE
            )
            if attempted:
                _log.info(
                    "ops.webhook_delivery_loop: attempted=%d delivered=%d failed=%d",
                    attempted, delivered, failed,
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            _log.exception("webhook_delivery_loop: unhandled error")
        await asyncio.sleep(WEBHOOK_DELIVERY_INTERVAL_S)


async def cleanup_loop() -> None:
    _log.info(
        "ops.cleanup_loop: starting (interval=%ds, metric_retention=%dd, recording_retention=%dd)",
        CLEANUP_INTERVAL_S, METRIC_RETENTION_DAYS, CALL_RECORDING_RETENTION_DAYS,
    )
    while True:
        try:
            deleted = await db.trim_old_minute_metrics(METRIC_RETENTION_DAYS)
            if deleted:
                _log.info("ops.cleanup_loop: trimmed %d old minute-metric rows", deleted)
        except asyncio.CancelledError:
            raise
        except Exception:
            _log.exception("cleanup_loop: unhandled error (metric trim)")

        # Voice-call recording retention. The call log row itself
        # stays (analytics rely on it); only the WAV file + the
        # path/bytes columns are cleared. Local import so this
        # module's startup cost stays the same when recordings are
        # never used.
        try:
            from call_recorder import sweep_expired_recordings
            files_unlinked, rows_updated = await sweep_expired_recordings(
                CALL_RECORDING_RETENTION_DAYS
            )
            if files_unlinked or rows_updated:
                _log.info(
                    "ops.cleanup_loop: swept %d recording files (%d row updates) "
                    "older than %d days",
                    files_unlinked, rows_updated, CALL_RECORDING_RETENTION_DAYS,
                )
        except asyncio.CancelledError:
            raise
        except Exception:
            _log.exception("cleanup_loop: unhandled error (recording sweep)")

        await asyncio.sleep(CLEANUP_INTERVAL_S)


# ---------------------------------------------------------------------------
# Lifecycle (called from main.py lifespan)
# ---------------------------------------------------------------------------

_TASKS: list[asyncio.Task] = []


async def start_pollers() -> None:
    """Launch all background pollers. Idempotent."""
    if _TASKS:
        return
    # Prime the dispatcher cache so /studio/ops doesn't see an empty pool
    # while waiting for the first health-poll cycle to land.
    try:
        await pool.reload_pool()
    except Exception:
        _log.exception("ops.start_pollers: initial reload_pool failed (non-fatal)")
    _TASKS.append(asyncio.create_task(health_poller(), name="ops.health_poller"))
    _TASKS.append(asyncio.create_task(metrics_poller(), name="ops.metrics_poller"))
    _TASKS.append(asyncio.create_task(update_detector_loop(), name="ops.update_detector"))
    _TASKS.append(asyncio.create_task(cleanup_loop(), name="ops.cleanup_loop"))
    _TASKS.append(asyncio.create_task(webhook_delivery_loop(), name="ops.webhook_delivery_loop"))
    _log.info("ops: started %d background pollers", len(_TASKS))


async def stop_pollers() -> None:
    """Cancel all background pollers and the SSH connection cache. Safe to
    call multiple times."""
    for t in _TASKS:
        t.cancel()
    for t in _TASKS:
        try:
            await t
        except (asyncio.CancelledError, Exception):
            pass
    _TASKS.clear()
    try:
        await ssh.close_all()
    except Exception:
        _log.exception("ops.stop_pollers: ssh.close_all error")
