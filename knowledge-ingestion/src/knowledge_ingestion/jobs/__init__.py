"""In-process background job queue for ingest operations.

Why not Celery / Redis Q / Dramatiq?
  • All of those bring an external broker dependency. For a single-pod
    deployment they're overkill — the pod already owns its disk and
    we can't horizontally-split work without horizontally-splitting
    the LanceDB store too (which we don't want in v1).
  • In-process asyncio with a bounded semaphore + dict-of-job-state
    gives us 100% of what we need: submit a job, poll its status,
    survive crashes by failing the job (no resume).
  • Workers run on the same event loop as the FastAPI app — no
    pickling, no IPC, no cross-process state.

Job state lives in memory only. If the pod restarts mid-ingest, the
in-flight job is lost — the client should see status=running, poll
again after restart, get a 404, and re-submit. That's the explicit
v1 tradeoff. Persisting job state to disk is a future enhancement.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from collections.abc import Awaitable
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Literal

from .. import metrics


_log = logging.getLogger(__name__)


JobStatus = Literal["pending", "running", "completed", "failed"]


@dataclass
class JobRecord:
    job_id: str
    source_id: str
    agent_id: str
    status: JobStatus = "pending"
    phase: str | None = None         # human-readable progress ("parsing PDF (page 17/240)")
    chunks_so_far: int = 0
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None
    # Internal — not serialised over the wire.
    _started_monotonic: float = 0.0


# In-memory store of every job we've seen this process lifetime. Keyed
# by job_id. Bounded by ``_MAX_RECENT_JOBS`` so a long-running pod
# doesn't accumulate state forever.
_jobs: dict[str, JobRecord] = {}
_jobs_lock = asyncio.Lock()
_MAX_RECENT_JOBS = 2000


# Worker semaphore — caps concurrent ingests.
_worker_sem: asyncio.Semaphore | None = None


def configure(max_concurrent: int) -> None:
    """Initialise the worker pool size. Called once from the FastAPI
    lifespan; subsequent calls update the cap (use for live retuning,
    if we ever expose that)."""
    global _worker_sem
    _worker_sem = asyncio.Semaphore(max_concurrent)


# Type alias for the work function: an async callable that receives
# the job record (so it can update phase + chunks_so_far) and returns
# the final chunk count.
WorkFn = Callable[["JobRecord"], Awaitable[int]]


async def submit(
    *, source_id: str, agent_id: str, work: WorkFn,
) -> JobRecord:
    """Register a new job and schedule its work coroutine to run on the
    current event loop.

    Returns the JobRecord immediately — the actual work is enqueued
    behind the worker semaphore.
    """
    if _worker_sem is None:
        raise RuntimeError("jobs.configure() must be called first")

    job = JobRecord(
        job_id=f"job_{uuid.uuid4().hex[:16]}",
        source_id=source_id,
        agent_id=agent_id,
        status="pending",
    )
    async with _jobs_lock:
        _jobs[job.job_id] = job
        _evict_if_needed()

    # Schedule on the loop without blocking the caller. The runner
    # picks up the semaphore inside _run, so submission is constant-
    # time even when the worker pool is saturated.
    asyncio.create_task(_run(job, work))
    return job


async def get(job_id: str) -> JobRecord | None:
    async with _jobs_lock:
        return _jobs.get(job_id)


def serialise(job: JobRecord) -> dict[str, Any]:
    """JSON-shaped dict for the public ``GET /v1/jobs/{job_id}``."""
    d = asdict(job)
    # Drop internal fields prefixed with underscore.
    return {k: v for k, v in d.items() if not k.startswith("_")}


async def _run(job: JobRecord, work: WorkFn) -> None:
    assert _worker_sem is not None
    metrics.inc_ingest_inflight()
    try:
        async with _worker_sem:
            job.status = "running"
            job.started_at = _now_iso()
            job._started_monotonic = time.monotonic()
            _log.info("job %s starting (agent=%s, source=%s)",
                      job.job_id, job.agent_id, job.source_id)
            try:
                chunk_count = await work(job)
                job.chunks_so_far = chunk_count
                job.status = "completed"
                metrics.record_job("completed")
            except Exception as exc:  # noqa: BLE001
                job.status = "failed"
                job.error = _short_error(exc)
                _log.exception("job %s failed", job.job_id)
                metrics.record_job("failed")
            job.finished_at = _now_iso()
            _log.info(
                "job %s done status=%s chunks=%d duration=%.1fs",
                job.job_id, job.status, job.chunks_so_far,
                time.monotonic() - job._started_monotonic,
            )
    finally:
        metrics.dec_ingest_inflight()


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _short_error(exc: BaseException) -> str:
    s = str(exc)
    return s if len(s) <= 400 else (s[:397] + "...")


def _evict_if_needed() -> None:
    """Keep the in-memory job map bounded. Evict the oldest completed/
    failed entries first; never evict pending/running."""
    if len(_jobs) <= _MAX_RECENT_JOBS:
        return
    # Sort completed/failed by finished_at, drop oldest until we're
    # back under the cap.
    completed = sorted(
        (j for j in _jobs.values() if j.status in ("completed", "failed")),
        key=lambda j: j.finished_at or "",
    )
    over = len(_jobs) - _MAX_RECENT_JOBS
    for j in completed[:over]:
        _jobs.pop(j.job_id, None)


# Test hook only — production code never resets the job map.
def _reset_for_tests() -> None:  # pragma: no cover
    global _worker_sem
    _jobs.clear()
    _worker_sem = None
