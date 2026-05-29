"""Public job API: enqueue, get_job, cancel_job, list_jobs.

Routers call these. They handle:
    - admission control (per-pool cap = 2 * N pods, reject with 503-able exception)
    - DB row creation (status=pending)
    - queue push so workers pick it up
    - status / position lookups
    - cancel-while-pending refund
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

from local_db import atomic_deduct_credits, get_connection, record_credit_transaction

from . import state
from .queues import queue_for
from .registry import all_counters, required_pools


_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------


class JobError(Exception):
    """Base for jobs/ errors that callers (routers) translate to HTTP."""


class JobAdmissionRejected(JobError):
    """Raised when a pool is at capacity. Includes a friendly message."""

    def __init__(self, message: str, *, retry_after_seconds: int = 60):
        super().__init__(message)
        self.message = message
        self.retry_after_seconds = retry_after_seconds


# ---------------------------------------------------------------------------
# Enqueue (admission + DB + push)
# ---------------------------------------------------------------------------


@dataclass
class EnqueueResult:
    job_id: str
    queue_position: int
    load_warning: bool
    pool_snapshots: dict = field(default_factory=dict)


async def enqueue(
    *,
    user_id: str,
    type: str,
    payload: dict,
    credits_to_charge: int = 0,
) -> EnqueueResult:
    """Admit, persist, and push. Raises `JobAdmissionRejected` if any required pool is full
    (no DB row, no charge). Caller is responsible for verifying credits/auth before calling.

    `credits_to_charge`: deducted from auth_users.credits inside this call. Refunded if
    the job later fails / times out / is cancelled.
    """
    counters = all_counters()
    demand = required_pools(type, payload)

    # 1. Verify every required pool is configured and would not exceed cap.
    #    Reserve atomically: if any one fails, roll back earlier reservations.
    #    A pool counts as "configured" if EITHER the static env-based pool has
    #    URLs OR the ops dispatcher has online pods for that service.
    _POOL_TO_OPS_SERVICE = {"tts": "tts_streaming", "stt": "stt", "clone": "voice_clone", "music": "music", "noise_remover": "noise_remover"}

    def _pool_available(pool_name: str, cnt) -> bool:
        if cnt is not None and cnt.configured:
            return True
        ops_service = _POOL_TO_OPS_SERVICE.get(pool_name)
        if ops_service:
            try:
                from ops import pool as gpu_pool
                return gpu_pool.online_pod_count(ops_service) > 0
            except Exception:
                pass
        return False

    reserved: list[tuple[str, int]] = []
    try:
        for pool_name, slots in demand.items():
            cnt = counters.get(pool_name)
            if not _pool_available(pool_name, cnt):
                raise JobAdmissionRejected(
                    f"{_human_pool(pool_name)} is not configured. Please contact support.",
                    retry_after_seconds=300,
                )
            # When the static pool has capacity counters, use them.
            # When only ops pods are available (cnt.cap == 0), skip the
            # static admission — the ops dispatcher enforces its own
            # 2×N cap inside pick_pod() at execution time.
            if cnt is not None and cnt.cap > 0:
                if not cnt.try_admit(slots):
                    raise JobAdmissionRejected(
                        _capacity_message(type, cnt.cap),
                        retry_after_seconds=60,
                    )
                reserved.append((pool_name, slots))
            else:
                reserved.append((pool_name, 0))

        # 2. Charge credits up front (refund on failure).
        if credits_to_charge > 0:
            await _charge_credits(user_id, type, credits_to_charge)

        # 3. Persist job row.
        job_id = await state.create_job(
            user_id=user_id,
            type=type,
            payload=payload,
            credits_charged=credits_to_charge,
        )

        # 4. Push to in-memory queue.
        queue_for(type).put_nowait(job_id)

        # 5. Build response.
        load_warning = any(counters[p].is_heavy for p in demand)
        position = await state.queue_position(type, job_id)
        snapshots = {p: counters[p].snapshot() for p in demand}
        return EnqueueResult(
            job_id=job_id,
            queue_position=position,
            load_warning=load_warning,
            pool_snapshots=snapshots,
        )

    except JobAdmissionRejected:
        # roll back any reservations we made before failing
        for pool_name, slots in reserved:
            counters[pool_name].release(slots)
        raise
    except Exception:
        # release reservations + rethrow (worker won't run, no risk of double-release)
        for pool_name, slots in reserved:
            counters[pool_name].release(slots)
        raise


# ---------------------------------------------------------------------------
# Cancel (pending only; refund credits + free pool slots)
# ---------------------------------------------------------------------------


async def cancel_job(*, job_id: str, user_id: str) -> bool:
    """Cancel a still-pending job. Refunds credits + releases pool reservations.
    Returns True if cancelled, False if not pending (already processing/done)."""
    job = await state.get_job(job_id)
    if not job or job.user_id != user_id:
        raise JobError("Job not found")
    if job.status != "pending":
        return False
    await state.update_status(job_id, status="cancelled", error_message="Cancelled by user")
    await _refund_credits(job)
    _release_pools(job)
    return True


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


async def get_job(*, job_id: str, user_id: str) -> dict:
    job = await state.get_job(job_id)
    if not job or job.user_id != user_id:
        raise JobError("Job not found")
    position = 0
    if job.status == "pending":
        position = await state.queue_position(job.type, job_id)
    return {
        **job.to_dict(),
        "queue_position": position,
    }


async def list_jobs(*, user_id: str, limit: int = 50) -> list[dict]:
    rows = await state.list_user_jobs(user_id, limit=limit)
    return [r.to_dict() for r in rows]


# ---------------------------------------------------------------------------
# Internal
# ---------------------------------------------------------------------------


_HUMAN_POOL = {
    "tts": "Text-to-Speech",
    "stt": "Speech-to-Text",
    "clone": "Voice cloning",
    "music": "Music generation",
}


def _human_pool(name: str) -> str:
    return _HUMAN_POOL.get(name, name)


def _capacity_message(task_type: str, cap: int) -> str:
    label = {
        "tts": "Text-to-Speech",
        "stt": "Speech-to-Text",
        "clone": "voice cloning",
        "voice_design": "voice design",
        "music": "music",
    }.get(task_type, task_type)
    return (
        f"We're at capacity right now — Vocence is processing the maximum "
        f"number of {label} requests we can. Please try again in a minute. "
        f"Sorry for the wait!"
    )


async def _charge_credits(user_id: str, task_type: str, amount: int) -> None:
    """Deduct credits + write a credit_transactions row. Raises if user has insufficient balance."""
    if amount <= 0:
        return
    conn = await get_connection()
    try:
        new_balance = await atomic_deduct_credits(conn, user_id=user_id, cost=amount)
        if new_balance is None:
            row = await (await conn.execute(
                "SELECT credits FROM auth_users WHERE id = ?", (user_id,)
            )).fetchone()
            current = int(row["credits"] or 0) if row else 0
            raise JobAdmissionRejected(
                f"Insufficient credits. This job costs {amount} credits — you have {current}.",
                retry_after_seconds=0,
            )
        await record_credit_transaction(
            conn,
            user_id=user_id,
            transaction_type=f"{task_type}_charge",
            amount=-amount,
            balance_after=new_balance,
            description=f"{task_type} job submitted",
            reference_type="generation_jobs",
            reference_id="pending",
        )
        await conn.commit()
    finally:
        await conn.close()


async def _refund_credits(job: state.Job) -> None:
    """Refund a previously charged amount to the user."""
    if job.credits_charged <= 0:
        return
    conn = await get_connection()
    try:
        await conn.execute(
            "UPDATE auth_users SET credits = credits + ?, updated_at = datetime('now') WHERE id = ?",
            (job.credits_charged, job.user_id),
        )
        row = await (await conn.execute(
            "SELECT credits FROM auth_users WHERE id = ?", (job.user_id,)
        )).fetchone()
        new_balance = int(row["credits"]) if row else 0
        await record_credit_transaction(
            conn,
            user_id=job.user_id,
            transaction_type=f"{job.type}_refund",
            amount=job.credits_charged,
            balance_after=new_balance,
            description=f"Refund for {job.type} job {job.id} ({job.status})",
            reference_type="generation_jobs",
            reference_id=job.id,
        )
        await conn.commit()
    finally:
        await conn.close()


def _release_pools(job: state.Job) -> None:
    """Release the pool reservations made at enqueue time."""
    counters = all_counters()
    demand = required_pools(job.type, job.payload)
    for pool_name, slots in demand.items():
        cnt = counters.get(pool_name)
        if cnt is not None:
            cnt.release(slots)
