"""Healthz state — same contract as every Vocence pod.

The dispatcher polls ``/healthz`` every ~10 s and routes traffic only
to pods reporting ``status: ok``. We start in ``warming`` while the
embedding model loads, then flip to ``ok``.
"""

from __future__ import annotations

import threading
import time
from typing import Literal

import psutil


Status = Literal["warming", "ok", "degraded", "error"]


_started_at = time.time()
_status: Status = "warming"
_status_lock = threading.Lock()


def set_status(new: Status) -> None:
    global _status
    with _status_lock:
        _status = new


def get_status() -> Status:
    return _status


def uptime_seconds() -> int:
    return int(time.time() - _started_at)


def _ram_info() -> dict[str, int]:
    try:
        vm = psutil.virtual_memory()
        return {
            "ram_used_mib": int((vm.total - vm.available) / (1024 * 1024)),
            "ram_total_mib": int(vm.total / (1024 * 1024)),
        }
    except Exception:  # noqa: BLE001
        return {"ram_used_mib": 0, "ram_total_mib": 0}
