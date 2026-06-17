"""Graceful WebSocket session draining.

Holds a registry of every active long-lived WS session (voice agent,
streaming TTS, streaming STT). At process shutdown the lifespan handler
calls :func:`request_drain` which:

  1. Flips the ``shutting_down`` flag so new WS upgrades are rejected
     with code 4503 instead of being accepted onto a doomed process.
  2. Waits up to ``timeout`` seconds for the in-flight set to drain on
     its own as users hang up naturally.
  3. After the timeout, returns the count of stuck sessions — the
     lifespan logs a warning; the process exits anyway and the OS tears
     the remaining sockets down. This is strictly better than the
     current behaviour where every active call drops at exactly t=0
     of a restart.

Topology note: today every backend service (``backend.vocence.ai``,
``api.vocence.ai``, ``subnet.vocence.ai``) runs as a single FastAPI
process behind nginx with ``proxy_pass http://127.0.0.1:<port>`` (no
upstream pool, no LB). A process restart drops every WS by design.
Drain doesn't fix that wholly; it just buys time for clean teardown.
Once the backend goes multi-replica, the same registry + an `nginx
reload` instead of a process restart will fully prevent drops.
"""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

_log = logging.getLogger(__name__)


class _Registry:
    def __init__(self) -> None:
        self._active: set[asyncio.Task] = set()
        self._shutting_down: bool = False
        # Set when ``_active`` becomes empty AND we're shutting down.
        # Starts set (no active sessions, not shutting down yet) so an
        # immediate drain call with zero sessions returns instantly.
        self._drained = asyncio.Event()
        self._drained.set()

    @property
    def shutting_down(self) -> bool:
        return self._shutting_down

    @property
    def active_count(self) -> int:
        return len(self._active)

    def register(self, task: asyncio.Task) -> None:
        """Add a session task to the registry. Auto-unregisters on done."""
        if not self._active:
            # Going from 0 → 1 active session: clear the drained event so
            # any future drain() will actually wait.
            self._drained.clear()
        self._active.add(task)
        task.add_done_callback(self._on_session_done)

    def _on_session_done(self, task: asyncio.Task) -> None:
        self._active.discard(task)
        if self._shutting_down and not self._active:
            self._drained.set()

    async def request_drain(self, timeout: float = 30.0) -> int:
        """Flip the shutdown flag and wait for active sessions to finish.

        Returns the count of sessions still active when the timeout
        expires (0 on a clean drain).
        """
        self._shutting_down = True
        n = len(self._active)
        if n == 0:
            self._drained.set()
            return 0
        _log.info(
            "[drain] starting graceful drain — active=%d timeout=%.0fs",
            n, timeout,
        )
        try:
            await asyncio.wait_for(self._drained.wait(), timeout=timeout)
            _log.info("[drain] all sessions ended cleanly")
            return 0
        except asyncio.TimeoutError:
            remaining = len(self._active)
            _log.warning(
                "[drain] timeout reached — %d session(s) still active, "
                "process will exit anyway and the OS will tear them down",
                remaining,
            )
            return remaining


_REGISTRY = _Registry()


def registry() -> _Registry:
    """Process-wide registry of active long-lived WS sessions."""
    return _REGISTRY


@asynccontextmanager
async def track_session(label: str = "ws") -> AsyncIterator[None]:
    """Register the current task as an active WS session for the duration
    of the ``async with`` block. No-op if no current task (sync context)."""
    task = asyncio.current_task()
    if task is None:
        # Not inside an asyncio task — can't track. Yield and move on.
        yield
        return
    _REGISTRY.register(task)
    try:
        yield
    finally:
        # ``_on_session_done`` will fire when the task ends; explicit
        # discard here too in case the same task gets reused (it won't
        # in FastAPI's per-request model, but defensive).
        _REGISTRY._active.discard(task)
        if _REGISTRY._shutting_down and not _REGISTRY._active:
            _REGISTRY._drained.set()
        _log.debug("[drain] session ended (%s); active=%d", label, _REGISTRY.active_count)
