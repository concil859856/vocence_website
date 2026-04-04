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
API_STT_CREDITS_COST = int(os.environ.get("API_STT_CREDITS_COST", "2"))
API_STT_MAX_AUDIO_BYTES = int(os.environ.get("API_STT_MAX_AUDIO_BYTES", str(50 * 1024 * 1024)))

