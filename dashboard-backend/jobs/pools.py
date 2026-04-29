"""Per-pod resource pools + per-pool admission counters.

Two layers, one purpose:
    - PodPool: which pod runs each accepted job (round-robin + FIFO when busy).
    - PoolCounter: whether a job is even admitted (cap = 2 * N pods).

Usage:
    pool = PodPool('voice_clone', urls=['http://a/clone', 'http://b/clone'])
    counter = PoolCounter(cap=2 * len(pool.urls))

    if not counter.try_admit(demand=1):
        raise JobAdmissionRejected(...)
    try:
        async with pool.acquire() as pod_url:
            await call_pod(pod_url, ...)
    finally:
        counter.release(demand=1)
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import AsyncIterator

_log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tunables (env)
# ---------------------------------------------------------------------------

LB_CAP_MULTIPLIER = int(os.environ.get("LB_CAP_MULTIPLIER", "2"))
LB_LOAD_WARNING_THRESHOLD_PCT = int(os.environ.get("LB_LOAD_WARNING_THRESHOLD_PCT", "50"))
LB_POD_QUARANTINE_SEC = int(os.environ.get("LB_POD_QUARANTINE_SEC", "60"))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def parse_urls(env_value: str | None) -> list[str]:
    """Parse a comma-separated list of URLs from an env var. Empty/None → []."""
    if not env_value:
        return []
    return [u.strip() for u in env_value.split(",") if u.strip()]


# ---------------------------------------------------------------------------
# PodPool: pick a pod, hold its slot for the duration of a phase
# ---------------------------------------------------------------------------


@dataclass
class _PodSlot:
    url: str
    sem: asyncio.Semaphore = field(default_factory=lambda: asyncio.Semaphore(1))
    quarantine_until: float = 0.0  # epoch seconds


class PodPool:
    """A set of pods; each can do exactly one task at a time.

    `acquire()` yields a healthy pod URL — round-robin among free pods,
    or FIFO wait if all are busy. Quarantined pods are skipped.
    """

    def __init__(self, name: str, urls: list[str]):
        self.name = name
        self.urls = list(urls)
        self._slots: list[_PodSlot] = [_PodSlot(url=u) for u in self.urls]
        self._next_idx = 0
        # one cross-pod waiter event so `acquire()` can wake when ANY pod frees
        self._free_event = asyncio.Event()
        self._free_event.set()

    @property
    def size(self) -> int:
        return len(self._slots)

    def configured(self) -> bool:
        return self.size > 0

    def quarantine(self, url: str, seconds: int = LB_POD_QUARANTINE_SEC) -> None:
        for s in self._slots:
            if s.url == url:
                s.quarantine_until = time.time() + seconds
                _log.warning("[lb] pool=%s pod=%s quarantined for %ds", self.name, url, seconds)
                return

    def _healthy_slots(self) -> list[_PodSlot]:
        now = time.time()
        return [s for s in self._slots if s.quarantine_until <= now]

    @asynccontextmanager
    async def acquire(self) -> AsyncIterator[str]:
        """Pick a free, healthy pod. Block FIFO if all busy. Yield pod URL."""
        if not self._slots:
            raise RuntimeError(f"pool {self.name!r} has no pods configured")

        chosen: _PodSlot | None = None
        # Try non-blocking acquire round-robin among healthy pods first
        healthy = self._healthy_slots()
        if not healthy:
            # everything is quarantined — wait for the soonest one to recover
            wait_for = min(s.quarantine_until for s in self._slots) - time.time()
            if wait_for > 0:
                await asyncio.sleep(min(wait_for, 5))
            healthy = self._healthy_slots() or self._slots  # bail out anyway

        n = len(healthy)
        # Round-robin starting at _next_idx
        for offset in range(n):
            slot = healthy[(self._next_idx + offset) % n]
            if slot.sem.locked() is False and slot.sem._value > 0:  # cheap, racy peek
                if slot.sem.locked() is False:
                    try:
                        await asyncio.wait_for(slot.sem.acquire(), timeout=0.001)
                        chosen = slot
                        self._next_idx = (self._next_idx + offset + 1) % n
                        break
                    except asyncio.TimeoutError:
                        continue

        if chosen is None:
            # Everything is busy — wait FIFO on whichever pod frees first.
            tasks = [asyncio.create_task(s.sem.acquire()) for s in healthy]
            try:
                done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for t in pending:
                    t.cancel()
                # Find which slot completed
                for slot, task in zip(healthy, tasks):
                    if task in done and not task.cancelled():
                        chosen = slot
                        break
            except asyncio.CancelledError:
                for t in tasks:
                    t.cancel()
                raise
            if chosen is None:
                raise RuntimeError(f"pool {self.name!r} acquire failed unexpectedly")

        try:
            yield chosen.url
        finally:
            chosen.sem.release()


# ---------------------------------------------------------------------------
# PoolCounter: per-pool admission control (cap = LB_CAP_MULTIPLIER * pods)
# ---------------------------------------------------------------------------


class PoolCounter:
    """Tracks `inflight` (= processing + queued) for a pool, enforces cap.

    Atomic try_admit / release. Used at /jobs/start time to reject early.
    """

    def __init__(self, name: str, pool_size: int, multiplier: int = LB_CAP_MULTIPLIER):
        self.name = name
        self.pool_size = pool_size
        self.multiplier = multiplier
        self.cap = max(0, pool_size * multiplier)
        self.inflight = 0
        self._lock = asyncio.Lock()  # not strictly needed in single-threaded asyncio, but explicit

    @property
    def configured(self) -> bool:
        return self.pool_size > 0

    @property
    def utilization_pct(self) -> int:
        if self.cap <= 0:
            return 100
        return int(self.inflight * 100 / self.cap)

    @property
    def is_heavy(self) -> bool:
        return self.utilization_pct >= LB_LOAD_WARNING_THRESHOLD_PCT

    def try_admit(self, demand: int) -> bool:
        """Atomically reserve `demand` slots. Returns True on success, False if would exceed cap."""
        if self.cap <= 0:
            return False
        if self.inflight + demand > self.cap:
            return False
        self.inflight += demand
        return True

    def release(self, demand: int) -> None:
        self.inflight = max(0, self.inflight - demand)

    def snapshot(self) -> dict:
        return {
            "name": self.name,
            "pods": self.pool_size,
            "cap": self.cap,
            "inflight": self.inflight,
            "utilization_pct": self.utilization_pct,
            "heavy": self.is_heavy,
        }
