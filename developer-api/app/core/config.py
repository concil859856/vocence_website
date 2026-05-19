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
API_CREDITS_PER_1M_CHARS = int(os.environ.get("API_CREDITS_PER_1M_CHARS", "2000"))
API_DEFAULT_STYLE = (os.environ.get("API_DEFAULT_STYLE_INSTRUCTION") or "neutral voice").strip()
# Flat credits per TTS request (aligns with Studio). Set to 0 to use character-based metering only.
API_TTS_CREDITS_PER_REQUEST = int(os.environ.get("API_TTS_CREDITS_PER_REQUEST", "25"))
API_STT_CREDITS_COST = int(os.environ.get("API_STT_CREDITS_COST", "20"))
API_STT_MAX_AUDIO_BYTES = int(os.environ.get("API_STT_MAX_AUDIO_BYTES", str(50 * 1024 * 1024)))
API_VOICE_CLONE_CREDITS = int(os.environ.get("API_VOICE_CLONE_CREDITS", "50"))
API_CLONE_MAX_REF_AUDIO_BYTES = int(
    os.environ.get("API_CLONE_MAX_REF_AUDIO_BYTES", str(50 * 1024 * 1024))
)

# Music generation (ACE-Step proxy)
API_MUSIC_CREDITS_PER_REQUEST = int(os.environ.get("API_MUSIC_CREDITS_PER_REQUEST", "50"))
MUSIC_GEN_API_URL = (os.environ.get("MUSIC_GEN_API_URL") or "").strip()
MUSIC_GEN_TIMEOUT_SEC = int(os.environ.get("MUSIC_GEN_TIMEOUT_SEC", "300"))

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

