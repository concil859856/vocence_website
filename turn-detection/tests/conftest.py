"""Pytest fixtures common to the whole suite.

We force ``TD_API_KEY`` to a known test value here so importing
``turn_detection.config`` (which fails-fast on missing keys) doesn't
crash test collection, and so the integration tests can hard-code the
key without picking up whatever the developer happens to have exported.
"""

from __future__ import annotations

import os

# Set BEFORE any turn_detection.* import lands. ``config.py`` reads
# the env at import time and raises SystemExit if the key is missing.
# Force-override any pre-existing TD_API_KEY so the integration tests'
# hard-coded ``test-suite-key`` matches the running app even when a
# developer ran ``TD_API_KEY=something pytest`` accidentally.
os.environ["TD_API_KEY"] = "test-suite-key"
# Send model downloads to a stable cache so re-runs don't re-download.
os.environ.setdefault("TD_MODELS_CACHE_DIR", "/tmp/td-models")
