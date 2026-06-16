"""Defense-in-depth sweeper for local-disk tempfiles outside R2.

Most persistent backend state lives in object storage (Cloudflare R2)
or SQLite (``data/website.db``, ``ops.db``). A few subsystems still
stage tempfiles on local disk and own their own cleanup at the call
site:

  * ``ops/ssh.py`` writes per-server SSH keys to ``/tmp/ops_ssh_*.key``
    so asyncssh can read them at connect time; the connect helper's
    ``finally`` unlinks immediately after.

The janitor catches stragglers that escaped the per-call cleanup
(process crash, kill -9, new code path that forgot to clean up).
Each pattern has its own TTL — files matching the pattern older than
that TTL get removed. The TTL is generous (1 h for SSH keys; an
in-flight connect lasts < 30 s) so we never race a live consumer.

Hooked into ``ops.pollers.cleanup_loop`` (runs hourly alongside metric
trim + recording sweep) and called once at startup so a freshly-
restarted server cleans up its own pre-crash stragglers immediately.
"""

from __future__ import annotations

import asyncio
import glob
import logging
import os
import time

_log = logging.getLogger(__name__)


# Pattern → TTL (seconds). Files matching the glob older than the TTL
# are deleted. Add new patterns here as subsystems start staging
# tempfiles — every entry is a contract that the producer ALSO cleans
# at the call site; the janitor is a backstop.
SWEEP_PATTERNS: list[tuple[str, int]] = [
    # ops/ssh.py temp PEM keys. Live connect takes < 30 s; 1 h TTL
    # is well clear of any in-flight handshake.
    ("/tmp/ops_ssh_*.key", 3600),
]


def _sweep_pattern_sync(pattern: str, ttl_s: int) -> tuple[int, int]:
    """Synchronous sweep of one pattern. Returns ``(removed, kept)``.
    Run from a thread so ``glob`` + ``os.unlink`` don't stall the loop
    on a slow filesystem."""
    now = time.time()
    removed = 0
    kept = 0
    for path in glob.glob(pattern):
        try:
            age = now - os.path.getmtime(path)
        except OSError:
            # File vanished between glob and stat — fine, count as removed.
            removed += 1
            continue
        if age < ttl_s:
            kept += 1
            continue
        try:
            os.unlink(path)
            removed += 1
        except OSError:
            # Permission / vanished. Skip without raising; the next
            # sweep retries. Don't let one bad file kill the whole pass.
            kept += 1
    return removed, kept


async def sweep_once() -> dict[str, tuple[int, int]]:
    """Run one pass of all configured patterns. Returns a per-pattern
    ``{pattern: (removed, kept)}`` map for the caller to log. Errors
    in any single pattern are caught — the janitor must never raise
    out of the cleanup loop or it kills the rest of the sweep."""
    results: dict[str, tuple[int, int]] = {}
    for pattern, ttl_s in SWEEP_PATTERNS:
        try:
            removed, kept = await asyncio.to_thread(
                _sweep_pattern_sync, pattern, ttl_s
            )
            results[pattern] = (removed, kept)
        except Exception:
            _log.exception(
                "local_storage_janitor: pattern %r raised — skipping this pass",
                pattern,
            )
            results[pattern] = (0, 0)
    return results


def log_sweep_results(results: dict[str, tuple[int, int]], *, source: str) -> None:
    """Log a one-line summary if anything was removed. Silent when
    there's nothing to do, so the steady-state hourly loop stays quiet."""
    total_removed = sum(r for r, _ in results.values())
    if total_removed == 0:
        return
    parts = [
        f"{pattern}={removed}"
        for pattern, (removed, _) in results.items() if removed > 0
    ]
    _log.info(
        "local_storage_janitor (%s): removed %d stragglers (%s)",
        source, total_removed, ", ".join(parts),
    )
