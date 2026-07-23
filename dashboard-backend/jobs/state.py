"""DB read/write for `generation_jobs` table."""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from local_db import get_connection


JOB_STATUSES = {"pending", "processing", "completed", "failed", "timeout", "cancelled"}
JOB_TYPES = {"tts", "stt", "clone", "voice_design", "music", "video_dub"}


@dataclass
class Job:
    id: str
    user_id: str
    type: str
    status: str
    phase: str | None
    payload: dict
    result: dict | None
    error_message: str | None
    pod_url: str | None
    credits_charged: int
    created_at: str
    started_at: str | None
    finished_at: str | None

    def to_dict(self) -> dict[str, Any]:
        # The payload is echoed by the job-status endpoints; the callback
        # signing secret must never travel back out, even to the owner.
        payload = {k: v for k, v in (self.payload or {}).items() if k != "callback_secret"}
        return {
            "id": self.id,
            "user_id": self.user_id,
            "type": self.type,
            "status": self.status,
            "phase": self.phase,
            "payload": payload,
            "result": self.result,
            "error_message": self.error_message,
            "pod_url": self.pod_url,
            "credits_charged": self.credits_charged,
            "created_at": self.created_at,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }


def _row_to_job(row) -> Job:
    return Job(
        id=row["id"],
        user_id=row["user_id"],
        type=row["type"],
        status=row["status"],
        phase=row["phase"],
        payload=json.loads(row["payload_json"] or "{}"),
        result=json.loads(row["result_json"]) if row["result_json"] else None,
        error_message=row["error_message"],
        pod_url=row["pod_url"],
        credits_charged=int(row["credits_charged"] or 0),
        created_at=row["created_at"],
        started_at=row["started_at"],
        finished_at=row["finished_at"],
    )


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------


async def create_job(*, user_id: str, type: str, payload: dict, credits_charged: int) -> str:
    if type not in JOB_TYPES:
        raise ValueError(f"Bad job type: {type}")
    job_id = uuid.uuid4().hex
    conn = await get_connection()
    try:
        await conn.execute(
            """
            INSERT INTO generation_jobs
            (id, user_id, type, status, payload_json, credits_charged, created_at)
            VALUES (?, ?, ?, 'pending', ?, ?, datetime('now'))
            """,
            (job_id, user_id, type, json.dumps(payload), credits_charged),
        )
        await conn.commit()
    finally:
        await conn.close()
    return job_id


async def update_status(
    job_id: str,
    *,
    status: str | None = None,
    phase: str | None = None,
    pod_url: str | None = None,
    result: dict | None = None,
    error_message: str | None = None,
) -> None:
    if status and status not in JOB_STATUSES:
        raise ValueError(f"Bad status: {status}")
    sets: list[str] = []
    params: list[Any] = []
    if status is not None:
        sets.append("status = ?")
        params.append(status)
        if status == "processing":
            sets.append("started_at = datetime('now')")
        elif status in ("completed", "failed", "timeout", "cancelled"):
            sets.append("finished_at = datetime('now')")
    if phase is not None:
        sets.append("phase = ?")
        params.append(phase)
    if pod_url is not None:
        sets.append("pod_url = ?")
        params.append(pod_url)
    if result is not None:
        sets.append("result_json = ?")
        params.append(json.dumps(result))
    if error_message is not None:
        sets.append("error_message = ?")
        params.append(error_message)
    if not sets:
        return
    params.append(job_id)
    conn = await get_connection()
    try:
        await conn.execute(f"UPDATE generation_jobs SET {', '.join(sets)} WHERE id = ?", params)
        await conn.commit()
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


async def get_job(job_id: str) -> Job | None:
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT * FROM generation_jobs WHERE id = ?", (job_id,)
        )).fetchone()
    finally:
        await conn.close()
    return _row_to_job(row) if row else None


async def list_user_jobs(user_id: str, *, limit: int = 50) -> list[Job]:
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            "SELECT * FROM generation_jobs WHERE user_id = ? ORDER BY datetime(created_at) DESC LIMIT ?",
            (user_id, max(1, min(limit, 200))),
        )).fetchall()
    finally:
        await conn.close()
    return [_row_to_job(r) for r in rows]


async def queue_position(job_type: str, job_id: str) -> int:
    """Number of pending jobs of the same type that were created before this one (1-based; 0 if not pending)."""
    conn = await get_connection()
    try:
        own = await (await conn.execute(
            "SELECT created_at, status FROM generation_jobs WHERE id = ?", (job_id,)
        )).fetchone()
        if not own or own["status"] != "pending":
            return 0
        ahead = await (await conn.execute(
            "SELECT COUNT(*) AS n FROM generation_jobs WHERE type = ? AND status = 'pending' "
            "AND datetime(created_at) < datetime(?)",
            (job_type, own["created_at"]),
        )).fetchone()
    finally:
        await conn.close()
    return int(ahead["n"] or 0) + 1


async def find_orphans() -> list[Job]:
    """Jobs left in pending/processing across a server restart."""
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            "SELECT * FROM generation_jobs WHERE status IN ('pending', 'processing')"
        )).fetchall()
    finally:
        await conn.close()
    return [_row_to_job(r) for r in rows]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")
