"""Common per-type worker loop. One asyncio task per (type, worker_index)."""

from __future__ import annotations

import asyncio
import logging
from typing import Awaitable, Callable

from .. import api, state
from ..queues import queue_for
from ..registry import all_counters, required_pools
from ..timeouts import JOB_BUDGET


_log = logging.getLogger(__name__)


# Each handler: takes a Job, returns the result dict to write to result_json
HANDLERS: dict[str, Callable[[state.Job], Awaitable[dict]]] = {}


def register_handler(task_type: str, handler: Callable[[state.Job], Awaitable[dict]]) -> None:
    HANDLERS[task_type] = handler


async def worker_loop(task_type: str, worker_idx: int) -> None:
    """Pull jobs off the type's queue, process them, mark them done. Loops forever."""
    queue = queue_for(task_type)
    handler = HANDLERS.get(task_type)
    if handler is None:
        _log.warning("[jobs] no handler registered for %s; worker %d idle", task_type, worker_idx)
        return

    _log.info("[jobs] worker %s#%d started", task_type, worker_idx)
    while True:
        job_id = await queue.get()
        try:
            await _process_one(task_type, job_id, handler)
        except Exception:
            _log.exception("[jobs] %s#%d failed processing job %s", task_type, worker_idx, job_id)
        finally:
            queue.task_done()


async def _process_one(task_type: str, job_id: str, handler):
    job = await state.get_job(job_id)
    if job is None:
        _log.warning("[jobs] job %s vanished before worker picked it", job_id)
        return
    if job.status != "pending":
        # Already handled (cancelled, etc.)
        return

    await state.update_status(job_id, status="processing")
    job = await state.get_job(job_id) or job  # refresh

    try:
        result = await asyncio.wait_for(
            handler(job),
            timeout=JOB_BUDGET.get(task_type, 600),
        )
        await state.update_status(job_id, status="completed", phase=None, result=result)

        # Referral activation: first successful generation activates the
        # user's referral, granting credits to their referrer.
        try:
            from referral_service import try_activate_referral
            await try_activate_referral(job.user_id)
        except Exception:
            pass  # non-critical — don't fail the job

    except asyncio.TimeoutError:
        await state.update_status(
            job_id,
            status="timeout",
            phase=None,
            error_message="This generation took too long and was cancelled. Please try again.",
        )
        await api._refund_credits(job)
    except Exception as e:
        msg = str(e) or e.__class__.__name__
        # Hide raw stack info from the user; keep enough for debugging in DB.
        await state.update_status(
            job_id,
            status="failed",
            phase=None,
            error_message=_friendly_failure_message(task_type, msg),
        )
        _log.exception("[jobs] %s#%s failed", task_type, job_id)
        await api._refund_credits(job)
    finally:
        # Release pool reservations regardless of outcome
        _release_for_job(job)


def _release_for_job(job: state.Job) -> None:
    counters = all_counters()
    for pool_name, slots in required_pools(job.type, job.payload).items():
        cnt = counters.get(pool_name)
        if cnt is not None:
            cnt.release(slots)


def _friendly_failure_message(task_type: str, raw: str) -> str:
    label = {
        "tts": "Text-to-Speech",
        "stt": "Speech-to-Text",
        "clone": "Voice cloning",
        "voice_design": "Voice design",
        "music": "Music generation",
    }.get(task_type, task_type)

    raw_l = (raw or "").lower()

    # Common upstream patterns → friendly wording
    if "invalid duration" in raw_l:
        return f"Your text is too long for this {label.lower()} voice. Try a shorter clip."
    if "infrastructure is at maximum capacity" in raw_l or "rate limit" in raw_l or " 429" in raw_l or "returned 429" in raw_l:
        return "Our AI provider is busy right now. Please try again in a few minutes — sorry for the wait."
    if "no instances available" in raw_l or "no instance" in raw_l:
        return "The AI provider is starting up. Please try again in about a minute."
    if "quarantined" in raw_l or "all pods" in raw_l:
        return f"All {label.lower()} pods are temporarily unavailable. Please try again in a moment."
    if "miner returned 5" in raw_l or "returned 5" in raw_l:
        return f"{label} provider had a temporary error. Please try again."
    if "timed out" in raw_l or "timeout" in raw_l:
        return f"{label} took too long and was cancelled. Please try again."
    if "cannot connect" in raw_l or "connection refused" in raw_l or "couldn't reach" in raw_l:
        return f"Couldn't reach the {label.lower()} server. Please try again in a moment."
    if "transcribed to empty text" in raw_l:
        return "We couldn't make out any speech in the reference audio. Try a clearer clip."
    if "insufficient credits" in raw_l:
        return raw  # already user-facing

    # Hide tracebacks, super-long blobs, JSON wrappers we didn't understand
    if "Traceback" in raw or len(raw) > 200 or raw.startswith("{"):
        return f"{label} failed. Please try again — sorry for the trouble."
    return raw
