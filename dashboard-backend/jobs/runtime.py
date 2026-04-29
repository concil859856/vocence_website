"""Runtime supervisor — start/stop workers, recover orphans, sweep timeouts.

Wired into FastAPI's lifespan in main.py.
"""

from __future__ import annotations

import asyncio
import logging

from . import api, state
from .registry import all_pools
from .timeouts import QUEUE_TIMEOUT_SEC
from .workers import dispatch
from .workers.clone import process_clone
from .workers.music import process_music
from .workers.stt import process_stt
from .workers.tts import process_tts
from .workers.voice_design import process_voice_design


_log = logging.getLogger(__name__)
_tasks: list[asyncio.Task] = []
_stopping = False


def _register_handlers() -> None:
    """Map task types → processors."""
    dispatch.register_handler("tts", process_tts)
    dispatch.register_handler("stt", process_stt)
    dispatch.register_handler("clone", process_clone)
    dispatch.register_handler("voice_design", process_voice_design)
    dispatch.register_handler("music", process_music)


async def _recover_orphans() -> None:
    """On restart, mark `pending`/`processing` jobs as failed (we lost them)."""
    orphans = await state.find_orphans()
    if not orphans:
        return
    _log.warning("[jobs] recovering %d orphan jobs from previous run", len(orphans))
    for job in orphans:
        await state.update_status(
            job.id,
            status="failed",
            phase=None,
            error_message="Server restarted while this job was running. Please try again.",
        )
        await api._refund_credits(job)


async def _queue_timeout_sweeper() -> None:
    """Background task: fail any `pending` jobs older than QUEUE_TIMEOUT_SEC."""
    while not _stopping:
        try:
            from local_db import get_connection
            conn = await get_connection()
            try:
                rows = await (await conn.execute(
                    "SELECT id FROM generation_jobs WHERE status = 'pending' "
                    f"AND datetime(created_at) < datetime('now', '-{int(QUEUE_TIMEOUT_SEC)} seconds')"
                )).fetchall()
            finally:
                await conn.close()
            for r in rows:
                job = await state.get_job(r["id"])
                if not job or job.status != "pending":
                    continue
                await state.update_status(
                    job.id,
                    status="timeout",
                    error_message="We were too busy to start your generation in time. Please try again — sorry!",
                )
                await api._refund_credits(job)
                # release pool reservation
                from .registry import all_counters, required_pools
                counters = all_counters()
                for pool_name, slots in required_pools(job.type, job.payload).items():
                    cnt = counters.get(pool_name)
                    if cnt is not None:
                        cnt.release(slots)
                _log.warning("[jobs] queue-timeout: aborted job %s (type=%s)", job.id, job.type)
        except Exception:
            _log.exception("[jobs] queue timeout sweep failed")
        await asyncio.sleep(15)


async def start_workers() -> None:
    """Boot worker tasks. Call from FastAPI lifespan."""
    global _stopping
    _stopping = False
    _register_handlers()

    # Recover orphans before starting workers (so we don't fight ourselves)
    try:
        await _recover_orphans()
    except Exception:
        _log.exception("[jobs] orphan recovery failed; continuing anyway")

    # Spawn workers — N per type (= pool size), so concurrency matches pod count.
    pools = all_pools()
    for type_name, pool in pools.items():
        worker_count = max(1, pool.size)
        for i in range(worker_count):
            _tasks.append(asyncio.create_task(dispatch.worker_loop(type_name, i)))
    # voice_design has no pool of its own; it uses tts/clone pools internally.
    # Spawn workers based on the LARGER of (tts pool size, clone pool size) so
    # multiple voice_design jobs can interleave. Default 1 if both are zero.
    vd_workers = max(1, pools["tts"].size, pools["clone"].size)
    for i in range(vd_workers):
        _tasks.append(asyncio.create_task(dispatch.worker_loop("voice_design", i)))

    _tasks.append(asyncio.create_task(_queue_timeout_sweeper()))
    _log.info("[jobs] started %d worker tasks (counts per type: tts=%d stt=%d clone=%d music=%d voice_design=%d)",
              len(_tasks),
              pools["tts"].size, pools["stt"].size, pools["clone"].size, pools["music"].size,
              vd_workers)


async def stop_workers() -> None:
    """Cancel all worker tasks. Call from FastAPI lifespan shutdown."""
    global _stopping
    _stopping = True
    for t in _tasks:
        t.cancel()
    if _tasks:
        await asyncio.gather(*_tasks, return_exceptions=True)
    _tasks.clear()
    _log.info("[jobs] all workers stopped")
