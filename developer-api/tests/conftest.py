"""Test fixtures.

We override ``require_api_key`` so the routes accept a fake auth
context without needing to seed an api_keys row, and we monkey-patch
``call_dashboard`` so requests never leave the test process.
"""

from __future__ import annotations

from typing import Any, Callable
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from app.core.auth import require_api_key
from app.main import app


@pytest.fixture
def fake_user_id() -> str:
    return "user_test_0001"


@pytest.fixture
def override_auth(fake_user_id: str):
    """Make every ``Depends(require_api_key)`` resolve to this user."""
    def _fake() -> dict:
        return {"user_id": fake_user_id, "key_id": "k_test", "credits": 10_000}
    app.dependency_overrides[require_api_key] = _fake
    yield
    app.dependency_overrides.pop(require_api_key, None)


@pytest.fixture
def mock_dashboard(monkeypatch) -> Callable[..., AsyncMock]:
    """Replace ``app.services.dashboard_proxy.call_dashboard`` with an
    ``AsyncMock``; tests stub the return value per-call. Returns the
    mock so tests can assert on the recorded args.

    Also stubs out :func:`gate_request` and :func:`log_audit` so tests
    don't need a real DB. They're tested separately."""
    mock = AsyncMock()
    no_op = AsyncMock(return_value=None)
    # ``charge_credits`` returns the new balance — 9_980 mirrors a
    # 10_000 starting balance minus the 20 cr PDF charge so any test
    # that doesn't override this still sees a sensible value.
    fake_charge = AsyncMock(return_value=9_980)
    import app.api.routes.agent_knowledge as ak_mod
    import app.api.routes.embed_tokens as et_mod
    monkeypatch.setattr(ak_mod, "call_dashboard", mock)
    monkeypatch.setattr(et_mod, "call_dashboard", mock)
    monkeypatch.setattr(ak_mod, "gate_request", no_op)
    monkeypatch.setattr(ak_mod, "log_audit", no_op)
    monkeypatch.setattr(ak_mod, "charge_credits", fake_charge)
    monkeypatch.setattr(ak_mod, "refund_credits", no_op)
    monkeypatch.setattr(et_mod, "gate_request", no_op)
    monkeypatch.setattr(et_mod, "log_audit", no_op)
    return mock


@pytest.fixture
def client(override_auth, mock_dashboard) -> TestClient:
    """FastAPI TestClient pre-configured with auth + proxy stubs."""
    return TestClient(app)


@pytest.fixture
def auth_headers() -> dict[str, str]:
    """Send any value — ``require_api_key`` is stubbed out, so the real
    key text doesn't matter, but the header still has to be present
    on routes that read it manually."""
    return {"Authorization": "Bearer voc_live_test_fake"}
