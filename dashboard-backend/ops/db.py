"""SQLite schema + accessor helpers for the ops module.

Tables live in the same ``website.db`` as the rest of dashboard-backend
(via local_db.get_connection). Schema is created idempotently from
``ensure_tables()`` — call once at backend startup, after local_db's own
ensure_tables() has run.

Storage shape:
  servers           — rented GPU boxes (host + SSH creds, encrypted)
  pods              — containers deployed on those servers
  pod_metric_cursors — last-seen monotonic counters (for delta computation)
  pod_metrics_minute — per-minute deltas (30-day retention)
  pod_uptime_daily  — per-day rollups (kept forever)
  pod_events        — append-only event log (restart, deploy, error, etc.)
"""
from __future__ import annotations

import json
import logging
from typing import Any

from local_db import get_connection

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------

# Service names the dispatcher knows about. Keep in sync with the actual
# service repos. Anything not in this set is rejected at deploy time so we
# don't end up with typos like "tts_streaming_v2" silently un-routable.
SERVICE_NAMES = (
    "tts_streaming",
    "voice_design",
    "music",
    "voice_clone",
    "stt",
    # "noise_remover" is the canonical name as of the Nov 2026 rename.
    # "dubbing" stays in the tuple as an alias so existing pod rows
    # (service='dubbing') still validate during the migration window;
    # admins can re-deploy under the new name when convenient.
    "noise_remover",
    "dubbing",
)

POD_STATUSES = (
    "deploying",   # docker run issued, waiting for first healthz
    "online",      # healthz passing, in the dispatcher pool
    "unhealthy",   # health-check failures exceeded threshold; auto-restarted
    "restarting",  # docker restart issued, waiting to come back
    "draining",    # admin asked to remove; finishing in-flight, no new traffic
    "stopped",     # docker stopped; not in the pool but row kept for history
    "removed",     # row tombstoned; kept so historical metrics still resolve
)

SERVER_STATUSES = ("pending", "ready", "unreachable", "removed")


SCHEMA_SQL: list[str] = [
    # --- servers -------------------------------------------------------------
    """
    CREATE TABLE IF NOT EXISTS ops_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        host TEXT NOT NULL,
        ssh_user TEXT NOT NULL DEFAULT 'root',
        ssh_port INTEGER NOT NULL DEFAULT 22,
        ssh_private_key_enc TEXT,
        hourly_cost_usd REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        last_seen_at TEXT,
        docker_version TEXT,
        gpu_info_json TEXT,
        notes TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_ops_servers_status ON ops_servers (status)",

    # --- pods ----------------------------------------------------------------
    """
    CREATE TABLE IF NOT EXISTS ops_pods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL REFERENCES ops_servers(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        service TEXT NOT NULL,
        image TEXT NOT NULL,
        image_digest TEXT,
        container_id TEXT,
        port INTEGER NOT NULL,
        api_key_enc TEXT,
        extra_env_enc TEXT,
        status TEXT NOT NULL DEFAULT 'deploying',
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        drain_requested INTEGER NOT NULL DEFAULT 0,
        last_healthz_at TEXT,
        last_healthz_json TEXT,
        last_metrics_at TEXT,
        last_metrics_json TEXT,
        deployed_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_ops_pods_service_status ON ops_pods (service, status)",
    "CREATE INDEX IF NOT EXISTS idx_ops_pods_server ON ops_pods (server_id)",
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_pods_server_port ON ops_pods (server_id, port) WHERE status NOT IN ('removed', 'stopped')",

    # --- metric cursors -----------------------------------------------------
    # The pod's /metrics endpoint exposes monotonic counters. We poll, diff
    # against the last seen value, and append the delta to pod_metrics_minute.
    # When a counter goes DOWN (process restarted, counters reset), we treat
    # the new value as a fresh baseline instead of negative-delta-ing.
    """
    CREATE TABLE IF NOT EXISTS ops_pod_metric_cursors (
        pod_id INTEGER PRIMARY KEY REFERENCES ops_pods(id) ON DELETE CASCADE,
        last_uptime_seconds INTEGER NOT NULL DEFAULT 0,
        last_requests_ok INTEGER NOT NULL DEFAULT 0,
        last_requests_err_json TEXT NOT NULL DEFAULT '{}',
        last_duration_ms_sum REAL NOT NULL DEFAULT 0,
        last_duration_ms_count INTEGER NOT NULL DEFAULT 0,
        last_bytes_sent INTEGER NOT NULL DEFAULT 0,
        last_audio_ms INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,

    # --- per-minute rollup (30-day retention) -------------------------------
    """
    CREATE TABLE IF NOT EXISTS ops_pod_metrics_minute (
        pod_id INTEGER NOT NULL REFERENCES ops_pods(id) ON DELETE CASCADE,
        minute_ts INTEGER NOT NULL,
        requests_ok INTEGER NOT NULL DEFAULT 0,
        requests_err_json TEXT NOT NULL DEFAULT '{}',
        duration_ms_sum REAL NOT NULL DEFAULT 0,
        duration_ms_count INTEGER NOT NULL DEFAULT 0,
        duration_ms_p95 REAL NOT NULL DEFAULT 0,
        max_inflight INTEGER NOT NULL DEFAULT 0,
        bytes_sent INTEGER NOT NULL DEFAULT 0,
        audio_ms INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (pod_id, minute_ts)
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_ops_metrics_minute_ts ON ops_pod_metrics_minute (minute_ts)",

    # --- per-day rollup (kept forever) --------------------------------------
    """
    CREATE TABLE IF NOT EXISTS ops_pod_uptime_daily (
        pod_id INTEGER NOT NULL REFERENCES ops_pods(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        online_seconds INTEGER NOT NULL DEFAULT 0,
        requests_total INTEGER NOT NULL DEFAULT 0,
        errors_total INTEGER NOT NULL DEFAULT 0,
        audio_ms_total INTEGER NOT NULL DEFAULT 0,
        bytes_sent_total INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (pod_id, day)
    )
    """,

    # --- event log (append-only) --------------------------------------------
    # Tracks notable lifecycle moments per pod so the admin UI can render a
    # timeline: "deploy started", "first healthz ok", "auto-restart fired",
    # "marked unhealthy", "image update available", etc. Bounded by a TTL
    # via a nightly cleanup.
    """
    CREATE TABLE IF NOT EXISTS ops_pod_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pod_id INTEGER REFERENCES ops_pods(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        message TEXT,
        details_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_ops_pod_events_pod_created ON ops_pod_events (pod_id, created_at DESC)",
    "CREATE INDEX IF NOT EXISTS idx_ops_pod_events_kind ON ops_pod_events (kind)",
]


async def ensure_ops_tables() -> None:
    """Create all ops_* tables idempotently. Safe to call at every startup."""
    conn = await get_connection()
    try:
        for stmt in SCHEMA_SQL:
            await conn.execute(stmt)
        await conn.commit()
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Accessor helpers — thin wrappers around aiosqlite so callers don't write
# raw SQL inline. Returned dicts use the column names directly.
# ---------------------------------------------------------------------------

def _row_to_dict(row) -> dict[str, Any]:
    return {k: row[k] for k in row.keys()}


async def list_servers(*, include_removed: bool = False) -> list[dict]:
    conn = await get_connection()
    try:
        sql = "SELECT * FROM ops_servers"
        if not include_removed:
            sql += " WHERE status != 'removed'"
        sql += " ORDER BY created_at DESC"
        rows = await (await conn.execute(sql)).fetchall()
        return [_row_to_dict(r) for r in rows]
    finally:
        await conn.close()


async def get_server(server_id: int) -> dict | None:
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT * FROM ops_servers WHERE id = ?", (server_id,)
        )).fetchone()
        return _row_to_dict(row) if row else None
    finally:
        await conn.close()


async def insert_server(
    *,
    name: str,
    host: str,
    ssh_user: str,
    ssh_port: int,
    ssh_private_key_enc: str | None,
    hourly_cost_usd: float,
    notes: str | None,
) -> int:
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            INSERT INTO ops_servers
                (name, host, ssh_user, ssh_port, ssh_private_key_enc,
                 hourly_cost_usd, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (name, host, ssh_user, ssh_port, ssh_private_key_enc,
             hourly_cost_usd, notes),
        )
        await conn.commit()
        return cursor.lastrowid
    finally:
        await conn.close()


async def update_server_status(
    server_id: int,
    *,
    status: str | None = None,
    last_seen_at: str | None = None,
    docker_version: str | None = None,
    gpu_info_json: str | None = None,
) -> None:
    sets: list[str] = ["updated_at = datetime('now')"]
    args: list[Any] = []
    if status is not None:
        sets.append("status = ?")
        args.append(status)
    if last_seen_at is not None:
        sets.append("last_seen_at = ?")
        args.append(last_seen_at)
    if docker_version is not None:
        sets.append("docker_version = ?")
        args.append(docker_version)
    if gpu_info_json is not None:
        sets.append("gpu_info_json = ?")
        args.append(gpu_info_json)
    args.append(server_id)
    conn = await get_connection()
    try:
        await conn.execute(
            f"UPDATE ops_servers SET {', '.join(sets)} WHERE id = ?",
            args,
        )
        await conn.commit()
    finally:
        await conn.close()


async def soft_delete_server(server_id: int) -> None:
    """Mark server removed (also tombstones its pods)."""
    conn = await get_connection()
    try:
        await conn.execute(
            "UPDATE ops_servers SET status = 'removed', updated_at = datetime('now') WHERE id = ?",
            (server_id,),
        )
        await conn.execute(
            "UPDATE ops_pods SET status = 'removed', updated_at = datetime('now') "
            "WHERE server_id = ? AND status NOT IN ('removed', 'stopped')",
            (server_id,),
        )
        await conn.commit()
    finally:
        await conn.close()


async def list_pods(
    *,
    service: str | None = None,
    server_id: int | None = None,
    statuses: tuple[str, ...] | None = None,
) -> list[dict]:
    sql = "SELECT * FROM ops_pods WHERE 1=1"
    args: list[Any] = []
    if service is not None:
        sql += " AND service = ?"
        args.append(service)
    if server_id is not None:
        sql += " AND server_id = ?"
        args.append(server_id)
    if statuses is not None:
        placeholders = ",".join("?" * len(statuses))
        sql += f" AND status IN ({placeholders})"
        args.extend(statuses)
    sql += " ORDER BY deployed_at DESC"
    conn = await get_connection()
    try:
        rows = await (await conn.execute(sql, args)).fetchall()
        return [_row_to_dict(r) for r in rows]
    finally:
        await conn.close()


async def get_pod(pod_id: int) -> dict | None:
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT * FROM ops_pods WHERE id = ?", (pod_id,)
        )).fetchone()
        return _row_to_dict(row) if row else None
    finally:
        await conn.close()


async def insert_pod(
    *,
    server_id: int,
    name: str,
    service: str,
    image: str,
    port: int,
    api_key_enc: str,
    extra_env_enc: str,
) -> int:
    if service not in SERVICE_NAMES:
        raise ValueError(f"unknown service {service!r}; valid: {SERVICE_NAMES}")
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            """
            INSERT INTO ops_pods
                (server_id, name, service, image, port, api_key_enc, extra_env_enc, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'deploying')
            """,
            (server_id, name, service, image, port, api_key_enc, extra_env_enc),
        )
        await conn.commit()
        return cursor.lastrowid
    finally:
        await conn.close()


async def update_pod(
    pod_id: int,
    **fields: Any,
) -> None:
    """Generic pod row updater. Caller passes valid column names directly."""
    if not fields:
        return
    sets = [f"{k} = ?" for k in fields]
    sets.append("updated_at = datetime('now')")
    args = list(fields.values()) + [pod_id]
    conn = await get_connection()
    try:
        await conn.execute(
            f"UPDATE ops_pods SET {', '.join(sets)} WHERE id = ?",
            args,
        )
        await conn.commit()
    finally:
        await conn.close()


async def log_pod_event(
    pod_id: int | None,
    kind: str,
    message: str | None = None,
    details: dict | None = None,
) -> None:
    """Append a row to ops_pod_events. ``pod_id`` may be None for fleet-wide
    events that aren't pod-specific."""
    conn = await get_connection()
    try:
        await conn.execute(
            "INSERT INTO ops_pod_events (pod_id, kind, message, details_json) VALUES (?, ?, ?, ?)",
            (pod_id, kind, message, json.dumps(details) if details else None),
        )
        await conn.commit()
    finally:
        await conn.close()


async def get_metric_cursor(pod_id: int) -> dict | None:
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT * FROM ops_pod_metric_cursors WHERE pod_id = ?", (pod_id,)
        )).fetchone()
        return _row_to_dict(row) if row else None
    finally:
        await conn.close()


async def upsert_metric_cursor(pod_id: int, snapshot: dict) -> None:
    """Record the latest /metrics snapshot as the new baseline. Caller has
    already written the delta to pod_metrics_minute."""
    conn = await get_connection()
    try:
        await conn.execute(
            """
            INSERT INTO ops_pod_metric_cursors
                (pod_id, last_uptime_seconds, last_requests_ok, last_requests_err_json,
                 last_duration_ms_sum, last_duration_ms_count, last_bytes_sent, last_audio_ms,
                 updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(pod_id) DO UPDATE SET
                last_uptime_seconds = excluded.last_uptime_seconds,
                last_requests_ok = excluded.last_requests_ok,
                last_requests_err_json = excluded.last_requests_err_json,
                last_duration_ms_sum = excluded.last_duration_ms_sum,
                last_duration_ms_count = excluded.last_duration_ms_count,
                last_bytes_sent = excluded.last_bytes_sent,
                last_audio_ms = excluded.last_audio_ms,
                updated_at = excluded.updated_at
            """,
            (
                pod_id,
                int(snapshot.get("uptime_seconds") or 0),
                int(snapshot.get("requests_ok") or 0),
                json.dumps(snapshot.get("requests_err") or {}),
                float(snapshot.get("duration_ms_sum") or 0),
                int(snapshot.get("duration_ms_count") or 0),
                int(snapshot.get("bytes_sent_total") or 0),
                int(snapshot.get("audio_ms_total") or 0),
            ),
        )
        await conn.commit()
    finally:
        await conn.close()


async def add_minute_delta(
    pod_id: int,
    minute_ts: int,
    *,
    requests_ok: int,
    requests_err: dict,
    duration_ms_sum: float,
    duration_ms_count: int,
    duration_ms_p95: float,
    inflight: int,
    bytes_sent: int,
    audio_ms: int,
) -> None:
    """Merge into the row for (pod_id, minute_ts). Counters add; max_inflight
    is max(); p95 last-write-wins (good enough at minute granularity)."""
    conn = await get_connection()
    try:
        # Try to merge with existing row.
        row = await (await conn.execute(
            "SELECT requests_err_json, duration_ms_sum, duration_ms_count, max_inflight, "
            "bytes_sent, audio_ms, requests_ok FROM ops_pod_metrics_minute "
            "WHERE pod_id = ? AND minute_ts = ?",
            (pod_id, minute_ts),
        )).fetchone()
        if row is not None:
            prev_err = json.loads(row["requests_err_json"] or "{}")
            for k, v in requests_err.items():
                prev_err[k] = int(prev_err.get(k, 0)) + int(v)
            await conn.execute(
                """
                UPDATE ops_pod_metrics_minute
                SET requests_ok = requests_ok + ?,
                    requests_err_json = ?,
                    duration_ms_sum = duration_ms_sum + ?,
                    duration_ms_count = duration_ms_count + ?,
                    duration_ms_p95 = ?,
                    max_inflight = MAX(max_inflight, ?),
                    bytes_sent = bytes_sent + ?,
                    audio_ms = audio_ms + ?
                WHERE pod_id = ? AND minute_ts = ?
                """,
                (
                    requests_ok, json.dumps(prev_err),
                    duration_ms_sum, duration_ms_count, duration_ms_p95,
                    inflight, bytes_sent, audio_ms, pod_id, minute_ts,
                ),
            )
        else:
            await conn.execute(
                """
                INSERT INTO ops_pod_metrics_minute
                    (pod_id, minute_ts, requests_ok, requests_err_json,
                     duration_ms_sum, duration_ms_count, duration_ms_p95,
                     max_inflight, bytes_sent, audio_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    pod_id, minute_ts, requests_ok, json.dumps(requests_err),
                    duration_ms_sum, duration_ms_count, duration_ms_p95,
                    inflight, bytes_sent, audio_ms,
                ),
            )
        await conn.commit()
    finally:
        await conn.close()


async def add_uptime_seconds(pod_id: int, day: str, seconds: int) -> None:
    """Bump ops_pod_uptime_daily.online_seconds for the given (pod, day).
    Day is UTC YYYY-MM-DD."""
    if seconds <= 0:
        return
    conn = await get_connection()
    try:
        await conn.execute(
            """
            INSERT INTO ops_pod_uptime_daily (pod_id, day, online_seconds)
            VALUES (?, ?, ?)
            ON CONFLICT(pod_id, day) DO UPDATE SET
                online_seconds = online_seconds + excluded.online_seconds
            """,
            (pod_id, day, seconds),
        )
        await conn.commit()
    finally:
        await conn.close()


async def add_daily_request_totals(
    pod_id: int,
    day: str,
    *,
    requests_total: int,
    errors_total: int,
    audio_ms_total: int,
    bytes_sent_total: int,
) -> None:
    if not (requests_total or errors_total or audio_ms_total or bytes_sent_total):
        return
    conn = await get_connection()
    try:
        await conn.execute(
            """
            INSERT INTO ops_pod_uptime_daily
                (pod_id, day, requests_total, errors_total, audio_ms_total, bytes_sent_total)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(pod_id, day) DO UPDATE SET
                requests_total = requests_total + excluded.requests_total,
                errors_total = errors_total + excluded.errors_total,
                audio_ms_total = audio_ms_total + excluded.audio_ms_total,
                bytes_sent_total = bytes_sent_total + excluded.bytes_sent_total
            """,
            (pod_id, day, requests_total, errors_total, audio_ms_total, bytes_sent_total),
        )
        await conn.commit()
    finally:
        await conn.close()


async def trim_old_minute_metrics(retention_days: int = 30) -> int:
    """Drop ops_pod_metrics_minute rows older than retention_days. Returns
    number of rows deleted. The daily rollup table is kept forever."""
    if retention_days <= 0:
        return 0
    conn = await get_connection()
    try:
        cutoff_ts = int(__import__("time").time()) - retention_days * 86400
        cursor = await conn.execute(
            "DELETE FROM ops_pod_metrics_minute WHERE minute_ts < ?",
            (cutoff_ts // 60,),
        )
        await conn.commit()
        return cursor.rowcount or 0
    finally:
        await conn.close()
