"""Pytest fixtures common to the whole suite.

We set ``TD_API_KEY`` here so importing ``turn_detection.config`` (which
fails-fast on missing keys) doesn't crash test collection.
"""

from __future__ import annotations

import os

# Set BEFORE any turn_detection.* import lands. ``config.py`` reads
# the env at import time and raises SystemExit if the key is missing.
os.environ.setdefault("TD_API_KEY", "test-suite-key")
# Send model downloads to a stable cache so re-runs don't re-download.
os.environ.setdefault("TD_MODELS_CACHE_DIR", "/tmp/td-models")
