"""Verify Premium-gate + rate-limit are enforced on the new endpoints.

We patch ``gate_request`` at the route module level (the import the
route file actually uses) to raise the same HTTPException the real
gate would raise, then assert the request fails fast with the right
status code AND no upstream dashboard call is attempted.

This is the regression test for ``everything looking good?`` — without
it, a future refactor could silently strip the gate from a work
endpoint and we'd never notice in CI.
"""

from __future__ import annotations

from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.core.auth import require_api_key
from app.main import app


VALID_AGENT_ID = "ag_12345678"


@pytest.fixture
def gated_client(monkeypatch, fake_user_id):
    """Like the standard ``client`` fixture but with ``gate_request``
    raising 402 (Premium required) so we can verify the gate fires."""
    app.dependency_overrides[require_api_key] = lambda: {
        "user_id": fake_user_id, "api_key_id": "k_test", "credits": 10_000,
    }
    proxy = AsyncMock()
    async def raise_402(_uid):
        raise HTTPException(status_code=402, detail="Premium required")
    no_op = AsyncMock(return_value=None)

    import app.api.routes.agent_knowledge as ak
    import app.api.routes.embed_tokens as et
    monkeypatch.setattr(ak, "call_dashboard", proxy)
    monkeypatch.setattr(ak, "gate_request", raise_402)
    monkeypatch.setattr(ak, "log_audit", no_op)
    monkeypatch.setattr(et, "call_dashboard", proxy)
    monkeypatch.setattr(et, "gate_request", raise_402)
    monkeypatch.setattr(et, "log_audit", no_op)
    yield TestClient(app), proxy
    app.dependency_overrides.pop(require_api_key, None)


@pytest.fixture
def rate_limited_client(monkeypatch, fake_user_id):
    """Same as ``gated_client`` but the gate raises 429 (rate limit)."""
    app.dependency_overrides[require_api_key] = lambda: {
        "user_id": fake_user_id, "api_key_id": "k_test", "credits": 10_000,
    }
    proxy = AsyncMock()
    async def raise_429(_uid):
        raise HTTPException(status_code=429, detail="Rate limit exceeded")
    no_op = AsyncMock(return_value=None)

    import app.api.routes.agent_knowledge as ak
    import app.api.routes.embed_tokens as et
    monkeypatch.setattr(ak, "call_dashboard", proxy)
    monkeypatch.setattr(ak, "gate_request", raise_429)
    monkeypatch.setattr(ak, "log_audit", no_op)
    monkeypatch.setattr(et, "call_dashboard", proxy)
    monkeypatch.setattr(et, "gate_request", raise_429)
    monkeypatch.setattr(et, "log_audit", no_op)
    yield TestClient(app), proxy
    app.dependency_overrides.pop(require_api_key, None)


# ----- knowledge: write endpoints MUST be gated -----------------------


@pytest.mark.parametrize("method,path,kwargs", [
    ("POST", f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/text",
     {"json": {"content": "x"}}),
    ("POST", f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/markdown",
     {"json": {"content": "x"}}),
    ("POST", f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/url",
     {"json": {"url": "https://example.com"}}),
    ("POST", f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/sitemap",
     {"json": {"url": "https://example.com/sitemap.xml"}}),
    ("POST", f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/pdf",
     {"files": {"file": ("x.pdf", b"%PDF-1.4\n%%EOF", "application/pdf")}}),
    ("DELETE", f"/v1/agents/{VALID_AGENT_ID}/knowledge/sources/s1", {}),
])
def test_knowledge_write_endpoints_enforce_premium(gated_client, method, path, kwargs) -> None:
    client, proxy = gated_client
    resp = client.request(method, path, **kwargs)
    assert resp.status_code == 402, f"{method} {path} should 402, got {resp.status_code}"
    assert proxy.await_count == 0, (
        f"{method} {path} called the dashboard despite the gate firing "
        "— the gate is being skipped"
    )


@pytest.mark.parametrize("method,path,kwargs", [
    ("POST", f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/text",
     {"json": {"content": "x"}}),
    ("DELETE", f"/v1/agents/{VALID_AGENT_ID}/knowledge/sources/s1", {}),
])
def test_knowledge_write_endpoints_enforce_rate_limit(rate_limited_client, method, path, kwargs) -> None:
    client, proxy = rate_limited_client
    resp = client.request(method, path, **kwargs)
    assert resp.status_code == 429
    assert proxy.await_count == 0


# ----- knowledge: read endpoints stay OPEN (no gate) -------------------


@pytest.mark.parametrize("path", [
    f"/v1/agents/{VALID_AGENT_ID}/knowledge/sources",
    f"/v1/agents/{VALID_AGENT_ID}/knowledge/jobs/j1",
])
def test_knowledge_read_endpoints_skip_gate(gated_client, path) -> None:
    """Read endpoints intentionally bypass the gate — even a paused-
    Premium user can still inspect what they have. They hit the
    dashboard regardless of the gate state."""
    client, proxy = gated_client
    proxy.return_value = {"sources": []} if "sources" in path else {"status": "done"}
    resp = client.get(path)
    assert resp.status_code == 200
    assert proxy.await_count == 1


# ----- embed_tokens: create + revoke gated, list open ------------------


def test_embed_tokens_create_is_gated(gated_client) -> None:
    """Create mints a real credential — a compromised key being able to
    spam thousands of these would be very bad. Must gate."""
    client, proxy = gated_client
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/embed-tokens",
        json={"label": "spam"},
    )
    assert resp.status_code == 402
    assert proxy.await_count == 0


def test_embed_tokens_revoke_is_gated(rate_limited_client) -> None:
    client, proxy = rate_limited_client
    resp = client.delete(f"/v1/agents/{VALID_AGENT_ID}/embed-tokens/t1")
    assert resp.status_code == 429
    assert proxy.await_count == 0


def test_embed_tokens_list_skips_gate(gated_client) -> None:
    """List is read-only and stays open even when the gate would fire,
    so a downgraded customer can still see what tokens they have."""
    client, proxy = gated_client
    proxy.return_value = {"tokens": []}
    resp = client.get(f"/v1/agents/{VALID_AGENT_ID}/embed-tokens")
    assert resp.status_code == 200
    assert proxy.await_count == 1


# ----- PDF oversize check fires BEFORE the gate ------------------------


def test_oversize_pdf_rejected_before_gate(gated_client) -> None:
    """A 50 MB+ upload must 413 fast, BEFORE we charge the user's rate
    limit. Otherwise a malicious caller could burn rate quota with
    huge garbage uploads that the gate would have otherwise blocked."""
    client, proxy = gated_client
    big = b"\x00" * (50 * 1024 * 1024 + 10)
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/pdf",
        files={"file": ("huge.pdf", big, "application/pdf")},
    )
    assert resp.status_code == 413
    assert proxy.await_count == 0
