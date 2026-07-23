"""Per-phase timeouts loaded from .env."""

import os


def _int_env(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, str(default)))
    except ValueError:
        return default


PHASE_TIMEOUT_TTS = _int_env("LB_PHASE_TIMEOUT_TTS", 60)
PHASE_TIMEOUT_STT = _int_env("LB_PHASE_TIMEOUT_STT", 90)
PHASE_TIMEOUT_CLONE = _int_env("LB_PHASE_TIMEOUT_CLONE", 240)
PHASE_TIMEOUT_MUSIC = _int_env("LB_PHASE_TIMEOUT_MUSIC", 600)
PHASE_TIMEOUT_LLM = _int_env("LB_PHASE_TIMEOUT_LLM", 30)
# Per-language wait on the upstream dubbing engine. Generous because the
# lip-sync tier re-renders every frame — a 10-minute source can legitimately
# take many minutes upstream.
PHASE_TIMEOUT_VIDEO_DUB = _int_env("LB_PHASE_TIMEOUT_VIDEO_DUB", 1800)

# Total budget per job type (worker wraps process_job in wait_for(this))
# voice_design uses max(preview, speak) since the same queue handles both:
#   preview  = LLM (30s) + 2 × TTS (60s each, sequential) + 15s overhead = 165s
#   speak    = CLONE (240s) + 15s overhead                                = 255s
JOB_BUDGET = {
    "tts": PHASE_TIMEOUT_TTS + 10,                              # +10s for upload/db
    "stt": PHASE_TIMEOUT_STT + 10,
    "clone": PHASE_TIMEOUT_STT + PHASE_TIMEOUT_CLONE + 15,
    "music": PHASE_TIMEOUT_MUSIC + 30,
    "voice_design": max(
        PHASE_TIMEOUT_LLM + (2 * PHASE_TIMEOUT_TTS) + 15,       # preview branch
        PHASE_TIMEOUT_CLONE + 15,                                # speak branch
    ),
    # Languages are dubbed sequentially, so the budget scales with the
    # per-language cap; +120s covers download, R2 upload and DB writes.
    "video_dub": (PHASE_TIMEOUT_VIDEO_DUB * _int_env("STUDIO_VIDEO_DUB_MAX_LANGUAGES", 3)) + 120,
}

# How long a job can sit in `pending` before we give up
QUEUE_TIMEOUT_SEC = _int_env("LB_QUEUE_TIMEOUT_SEC", 300)
