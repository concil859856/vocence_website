"""Healthz state — surfaces what the Vocence ops dispatcher reads.

The dispatcher polls ``GET /healthz`` every ~10 s and looks at the
``status`` field (not the HTTP status code) to decide whether to send
new sessions to this pod.

Status state machine:
  warming   — startup, models loading. No new sessions.
  ok        — fully ready. Accept sessions.
  degraded  — running but in some kind of trouble. No new sessions,
              existing ones can drain.
  error     — broken. No new sessions; reported in /admin/ops.

We start in ``warming`` and flip to ``ok`` once both models are loaded.
Any unhandled exception in the lifespan flips us to ``error``.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Literal

import psutil


Status = Literal["warming", "ok", "degraded", "error"]


_started_at = time.time()
_status: Status = "warming"
_status_lock = threading.Lock()


def set_status(new: Status) -> None:
    """Flip the global pod status. Called by the lifespan handler when
    models finish loading or when something goes wrong."""
    global _status
    with _status_lock:
        _status = new


def get_status() -> Status:
    return _status


def uptime_seconds() -> int:
    return int(time.time() - _started_at)


def _ram_info() -> dict[str, int]:
    """Best-effort RAM stats. We use ``psutil`` so this works on any
    OS that runs the container; if psutil is unavailable we return
    zeros rather than failing the whole healthz response."""
    try:
        vm = psutil.virtual_memory()
        return {
            "ram_used_mib": int((vm.total - vm.available) / (1024 * 1024)),
            "ram_total_mib": int(vm.total / (1024 * 1024)),
        }
    except Exception:  # noqa: BLE001
        return {"ram_used_mib": 0, "ram_total_mib": 0}


def _cpu_count() -> int:
    try:
        return os.cpu_count() or 0
    except Exception:  # noqa: BLE001
        return 0


def render(
    *,
    smart_turn_loaded: bool,
    turn_detector_loaded: bool,
    smart_turn_model: str,
    turn_detector_model: str,
    in_flight: int,
    max_concurrent: int,
) -> dict:
    """Render the /healthz JSON body. Field names + nesting MUST match
    the platform spec §17.3 exactly — the Vocence dispatcher reads
    specific keys and silently ignores rows it can't parse."""
    return {
        "status": _status,
        "service": "turn-detection",
        "models": {
            "smart_turn": {
                "name": smart_turn_model,
                "loaded": smart_turn_loaded,
                "license": "BSD-3-Clause",
            },
            "turn_detector": {
                "name": turn_detector_model,
                "loaded": turn_detector_loaded,
                "license": "Apache-2.0",
            },
        },
        "version": "0.1.0",
        "uptime_seconds": uptime_seconds(),
        "in_flight": in_flight,
        "max_concurrent_streams": max_concurrent,
        "cpu_count": _cpu_count(),
        **_ram_info(),
    }
