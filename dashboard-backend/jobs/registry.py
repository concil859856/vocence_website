"""Pool & counter registry — built from .env at module load.

For each underlying resource (TTS, STT, voice-clone, music) we build:
    - a PodPool (per-pod semaphores, picks which pod runs the job)
    - a PoolCounter (per-pool admission cap = 2 * N pods)

LLM has no pool — Chutes auto-scales it.

Environment (all comma-separated; back-compat with old single-URL form):
    STUDIO_TTS_URL=https://podA/speak,https://podB/speak           (or per-model below)
    STUDIO_STT_URL=http://stt-a/transcribe,http://stt-b/transcribe
    STUDIO_VOICE_CLONE_URL=http://clone-a/voice-clone,http://clone-b/voice-clone
    MUSIC_GEN_API_URL=http://music-a:8187,http://music-b:8187

For TTS, if STUDIO_TTS_URL is unset we fall back to building URLs from the
configured STUDIO_MODEL_<n>_CHUTE_SLUG values: https://{slug}.chutes.ai/speak.
"""

from __future__ import annotations

import os

from .pools import PodPool, PoolCounter, parse_urls


# ---------------------------------------------------------------------------
# Build pools from env
# ---------------------------------------------------------------------------


def _tts_urls_from_env() -> list[str]:
    """Either an explicit list, or derived from configured TTS model slugs."""
    explicit = parse_urls(os.environ.get("STUDIO_TTS_URL"))
    if explicit:
        return explicit
    # Fallback: enumerate STUDIO_MODEL_<n>_CHUTE_SLUG (1..10)
    slugs: list[str] = []
    for i in range(1, 11):
        slug = (os.environ.get(f"STUDIO_MODEL_{i}_CHUTE_SLUG") or "").strip()
        if slug:
            slugs.append(slug)
    return [f"https://{s}.chutes.ai/speak" for s in slugs]


TTS_POOL = PodPool("tts", _tts_urls_from_env())
STT_POOL = PodPool("stt", parse_urls(os.environ.get("STUDIO_STT_URL")))
CLONE_POOL = PodPool("clone", parse_urls(os.environ.get("STUDIO_VOICE_CLONE_URL")))
MUSIC_POOL = PodPool("music", parse_urls(os.environ.get("MUSIC_GEN_API_URL")))


TTS_CAP = PoolCounter("tts", TTS_POOL.size)
STT_CAP = PoolCounter("stt", STT_POOL.size)
CLONE_CAP = PoolCounter("clone", CLONE_POOL.size)
MUSIC_CAP = PoolCounter("music", MUSIC_POOL.size)

# Video dubbing runs upstream, not on our pods, so it has no PodPool — but it
# still needs an admission cap, because every concurrent job is real upstream
# spend. multiplier=1 makes the env value the literal max in-flight count.
# Set STUDIO_VIDEO_DUB_CONCURRENCY=0 to disable the feature entirely.
VIDEO_DUB_CONCURRENCY = int(os.environ.get("STUDIO_VIDEO_DUB_CONCURRENCY", "4"))
VIDEO_DUB_CAP = PoolCounter("video_dub", VIDEO_DUB_CONCURRENCY, multiplier=1)


def all_counters() -> dict[str, PoolCounter]:
    return {
        "tts": TTS_CAP,
        "stt": STT_CAP,
        "clone": CLONE_CAP,
        "music": MUSIC_CAP,
        "video_dub": VIDEO_DUB_CAP,
    }


def all_pools() -> dict[str, PodPool]:
    return {
        "tts": TTS_POOL,
        "stt": STT_POOL,
        "clone": CLONE_POOL,
        "music": MUSIC_POOL,
    }


# ---------------------------------------------------------------------------
# Per-job-type pool demand
# ---------------------------------------------------------------------------
#
# At admission time, each job declares which pools it needs and how many slots
# from each. The Pool counter is incremented at admission, decremented when the
# job completes / fails / times out.
#
# `voice_design` preview: 1 TTS slot held twice (sequential), so demand = 1.
# `clone` (auto-STT): peak is 1 of either stt OR clone (sequential, never both
#   simultaneously). We reserve both at admission to keep accounting simple +
#   guarantee both are available before queueing.
#

# (job_type, payload-derived hint) → {pool_name: slots}
def required_pools(job_type: str, payload: dict) -> dict[str, int]:
    if job_type == "tts":
        return {"tts": 1}
    if job_type == "stt":
        return {"stt": 1}
    if job_type == "clone":
        # Auto-STT only when caller didn't supply reference_text AND
        # isn't using a sample voice (sample voices have pre-transcribed text).
        has_ref_text = bool((payload.get("reference_text") or "").strip())
        has_sample = bool((payload.get("sample_voice_id") or "").strip())
        needs_stt = not has_ref_text and not has_sample
        return {"clone": 1, **({"stt": 1} if needs_stt else {})}
    if job_type == "music":
        return {"music": 1}
    if job_type == "video_dub":
        # No pod pool — the counter alone bounds concurrent upstream spend.
        return {"video_dub": 1}
    if job_type == "voice_design":
        mode = (payload.get("mode") or "preview").lower()
        if mode == "preview":
            # Sequential 2x TTS calls → counts as 1 in the cap (per user decision)
            return {"tts": 1}
        if mode == "speak":
            return {"clone": 1}
        return {"tts": 1}
    raise ValueError(f"Unknown job type: {job_type!r}")
