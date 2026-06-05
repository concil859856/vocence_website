"""Pytest fixtures common to the whole suite.

Sets required env vars before any ``knowledge_ingestion.*`` import lands
so ``config.py``'s fail-fast doesn't crash collection. Uses a fresh
``tmpdir``-style data dir per test session to keep tests fully
isolated from any local dev state.
"""

from __future__ import annotations

import os
import shutil
import tempfile

_TEST_DATA_DIR = tempfile.mkdtemp(prefix="kn-tests-")
os.environ["KN_API_KEY"] = "test-suite-key"
os.environ["KN_DATA_DIR"] = _TEST_DATA_DIR
os.environ.setdefault("KN_MODELS_CACHE_DIR", "/tmp/kn-models")


def pytest_sessionfinish(session, exitstatus):  # noqa: ARG001
    """Wipe the per-session LanceDB store. We use mkdtemp + rmtree so
    multiple test runs never pollute each other."""
    shutil.rmtree(_TEST_DATA_DIR, ignore_errors=True)
