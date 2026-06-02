"""Shared pytest config — sets asyncio mode + path + dummy env."""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Tests don't need the real secrets — give the import-time validators
# something strong-looking so the modules import cleanly. Real prod
# secrets stay in dashboard-backend/.env and never touch tests.
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-" + "x" * 40)
os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "test-internal-" + "y" * 40)
