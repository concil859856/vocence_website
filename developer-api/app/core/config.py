from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

PROJECT_ROOT = Path(__file__).resolve().parents[2]
WEBSITE_ROOT = PROJECT_ROOT.parent

DATA_DIR = WEBSITE_ROOT / "dashboard-backend" / "data"
DATA_DIR.mkdir(exist_ok=True)

DB_PATH = os.environ.get("SQLITE_PATH", str(DATA_DIR / "website.db"))

API_RATE_LIMIT_ENABLED = (
    os.environ.get("API_RATE_LIMIT_ENABLED", "true").strip().lower() in {"1", "true", "yes"}
)
API_RATE_LIMIT_REQUESTS_PER_MINUTE = int(os.environ.get("API_RATE_LIMIT_REQUESTS_PER_MINUTE", "4"))

# ── Pricing (Nov 2026 redesign) ───────────────────────────────────────────
# All $-quoted values below are derived from the crypto credit rate
# (400 cr/$). Card buyers effectively pay 20% more per unit; the credit
# numbers stay the same.

# TTS: $10 per 1,000,000 chars = 4,000 credits / 1M chars = 0.004 cr/char.
# Frozen here AND on the voice-cloning path (clone is also char-priced via TTS).
API_CREDITS_PER_1M_CHARS = int(os.environ.get("API_CREDITS_PER_1M_CHARS", "4000"))
API_DEFAULT_STYLE = (os.environ.get("API_DEFAULT_STYLE_INSTRUCTION") or "neutral voice").strip()
# Flat credits per TTS request (set 0 to use char-based metering only).
# Kept for the legacy code path; defaults to 0 so all billing is per-char.
API_TTS_CREDITS_PER_REQUEST = int(os.environ.get("API_TTS_CREDITS_PER_REQUEST", "0"))

# STT: $0.0075/min = 3 credits/min at the crypto rate.
# Per-minute billing — backend rounds the actual audio duration UP to the
# nearest minute. Hard cap = 5 min per request, 50 MB upload.
API_STT_CREDITS_PER_MIN = int(os.environ.get("API_STT_CREDITS_PER_MIN", "3"))
API_STT_MAX_AUDIO_BYTES = int(os.environ.get("API_STT_MAX_AUDIO_BYTES", str(50 * 1024 * 1024)))
API_STT_MAX_DURATION_SEC = int(os.environ.get("API_STT_MAX_DURATION_SEC", str(5 * 60)))
# Legacy flat-rate fallback; not used unless API_STT_CREDITS_PER_MIN == 0.
API_STT_CREDITS_COST = int(os.environ.get("API_STT_CREDITS_COST", "0"))

# Voice cloning (single-call clone+TTS): char-based, same rate as TTS.
# Devs pay the same per character whether they're using a built-in voice
# or a clone reference upload.
API_CLONE_CREDITS_PER_1M_CHARS = int(os.environ.get("API_CLONE_CREDITS_PER_1M_CHARS", "4000"))
API_CLONE_MAX_REF_AUDIO_BYTES = int(
    os.environ.get("API_CLONE_MAX_REF_AUDIO_BYTES", str(50 * 1024 * 1024))
)
# Legacy flat fallback; kept for compatibility.
API_VOICE_CLONE_CREDITS = int(os.environ.get("API_VOICE_CLONE_CREDITS", "0"))

# Noise Remover (was "Dubbing" — DeepFilterNet enhancement).
# Same flat-per-gen model as the Studio path: 5 credits per call, max 5 min.
API_NOISE_REMOVER_CREDITS_COST = int(os.environ.get("API_NOISE_REMOVER_CREDITS_COST", "5"))
API_NOISE_REMOVER_MAX_AUDIO_BYTES = int(
    os.environ.get("API_NOISE_REMOVER_MAX_AUDIO_BYTES", str(50 * 1024 * 1024))
)
API_NOISE_REMOVER_MAX_DURATION_SEC = int(
    os.environ.get("API_NOISE_REMOVER_MAX_DURATION_SEC", str(5 * 60))
)
# Back-compat aliases (old "dubbing" env var names still honored).
API_DUBBING_CREDITS_COST = int(os.environ.get("API_DUBBING_CREDITS_COST", str(API_NOISE_REMOVER_CREDITS_COST)))
API_DUBBING_MAX_AUDIO_BYTES = int(os.environ.get("API_DUBBING_MAX_AUDIO_BYTES", str(API_NOISE_REMOVER_MAX_AUDIO_BYTES)))

# Music generation (ACE-Step proxy): $0.075/song = 30 credits/song.
API_MUSIC_CREDITS_PER_REQUEST = int(os.environ.get("API_MUSIC_CREDITS_PER_REQUEST", "30"))
MUSIC_GEN_API_URL = (os.environ.get("MUSIC_GEN_API_URL") or "").strip()
MUSIC_GEN_TIMEOUT_SEC = int(os.environ.get("MUSIC_GEN_TIMEOUT_SEC", "300"))

# Voice Design (text → custom voice): $0.175/voice = 70 credits/voice.
# Generates two samples internally; API always returns the FIRST (the one
# matching the exact user instruction prompt) for deterministic behavior.
API_VOICE_DESIGN_CREDITS = int(os.environ.get("API_VOICE_DESIGN_CREDITS", "70"))
# Saving a designed voice via API (mirrors the "Upload voice" UI on the
# My Voices page). Free on the website; 20 cr on the API to discourage
# script-spam saves.
API_VOICE_SAVE_CREDITS = int(os.environ.get("API_VOICE_SAVE_CREDITS", "20"))

# Voice agents are billed by ``dashboard-backend/voice_agent_billing.py``
# (the billing loop runs on the dashboard side of the WS proxy, not
# here). The actual tunables are ``VOICE_AGENT_CREDITS_PER_MIN``,
# ``VOICE_AGENT_INCREMENT_SEC``, and ``VOICE_AGENT_MIN_CHARGE_SEC``
# in the dashboard's environment — NOT API_VOICE_AGENT_* on the
# developer-api service. Setting API_VOICE_AGENT_* here has no effect.
# Documented as 40 cr/min, 6-sec increments, 30-sec minimum charge.

# Voice-agent WS API. Public callers hit developer-api at
# ``/v1/agents/{id}/session`` (this service). We then open an inner WS
# to the dashboard-backend voice pipeline at ``DASHBOARD_VOICECHAT_WS_URL``
# authenticated with ``INTERNAL_SERVICE_TOKEN`` (a shared secret that
# must match the value on the dashboard-backend side). For local dev
# the default points at the on-box dashboard-backend on :8085.
DASHBOARD_VOICECHAT_WS_URL = (
    os.environ.get("DASHBOARD_VOICECHAT_WS_URL")
    or "ws://127.0.0.1:8085/api/dashboard/voicechat/session"
).strip()
INTERNAL_SERVICE_TOKEN = (os.environ.get("INTERNAL_SERVICE_TOKEN") or "").strip()
