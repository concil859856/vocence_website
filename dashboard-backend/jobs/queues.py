"""In-memory queues, one per task type. Drained by per-type workers."""

from __future__ import annotations

import asyncio


_QUEUES: dict[str, asyncio.Queue[str]] = {
    "tts": asyncio.Queue(),
    "stt": asyncio.Queue(),
    "clone": asyncio.Queue(),
    "voice_design": asyncio.Queue(),
    "music": asyncio.Queue(),
    "video_dub": asyncio.Queue(),
}


def queue_for(task_type: str) -> asyncio.Queue[str]:
    if task_type not in _QUEUES:
        raise ValueError(f"Unknown task type: {task_type}")
    return _QUEUES[task_type]


def all_queues() -> dict[str, asyncio.Queue[str]]:
    return _QUEUES
