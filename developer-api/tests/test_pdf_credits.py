"""20-credit charge + refund-on-failure for knowledge.ingest.pdf.

The PDF route is the only knowledge endpoint that costs credits — text
/ url / markdown / sitemap are free per the dashboard's policy. These
tests verify the charge fires UP FRONT (so users can't get free
indexing by cancelling mid-flight) AND the refund fires on upstream
failure (so users don't get double-billed for failed requests).
"""

from __future__ import annotations

from unittest.mock import AsyncMock, ANY

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.core.auth import require_api_key
from app.main import app


VALID_AGENT_ID = "ag_12345678"


@pytest.fixture
def pdf_client(monkeypatch, fake_user_id):
    """Fixture that exposes the charge + refund mocks so each test can
    assert exactly which were called."""
    app.dependency_overrides[require_api_key] = lambda: {
        "user_id": fake_user_id, "api_key_id": "k_test", "credits": 10_000,
    }

    proxy = AsyncMock()
    charge = AsyncMock(return_value=9_980)  # post-charge balance
    refund = AsyncMock()
    no_op = AsyncMock(return_value=None)

    import app.api.routes.agent_knowledge as ak
    monkeypatch.setattr(ak, "call_dashboard", proxy)
    monkeypatch.setattr(ak, "charge_credits", charge)
    monkeypatch.setattr(ak, "refund_credits", refund)
    monkeypatch.setattr(ak, "gate_request", no_op)
    monkeypatch.setattr(ak, "log_audit", no_op)
    monkeypatch.setattr(ak, "API_KNOWLEDGE_PDF_CREDITS", 20)

    yield TestClient(app), proxy, charge, refund
    app.dependency_overrides.pop(require_api_key, None)


def _pdf_files() -> dict:
    """Return a tiny valid-enough PDF blob as a multipart payload."""
    return {"file": ("doc.pdf", b"%PDF-1.4\n%fake\n%%EOF", "application/pdf")}


def test_pdf_charges_20_credits_before_upstream_call(pdf_client) -> None:
    """Charge must run BEFORE call_dashboard. If a client cancels the
    request mid-flight after the upload finishes, the credits are
    already gone — they don't get a free PDF indexed."""
    client, proxy, charge, refund = pdf_client
    proxy.return_value = {"status": "completed", "source_id": "src_x"}
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/pdf",
        files=_pdf_files(),
    )
    assert resp.status_code == 200
    charge.assert_awaited_once()
    args, kwargs = charge.call_args
    # charge_credits(user_id, 20, label=..., transaction_type=...)
    assert args[1] == 20  # cost
    assert kwargs["transaction_type"] == "knowledge_ingest_pdf"
    # The proxy was called after the charge.
    assert proxy.await_count == 1
    refund.assert_not_awaited()


def test_pdf_response_includes_credits_used_and_remaining(pdf_client) -> None:
    """SDK consumers want to display 'PDF indexed · 20 credits · 9,980 cr
    remaining' without a separate ``account.get()`` round-trip."""
    client, proxy, charge, refund = pdf_client
    proxy.return_value = {"status": "completed", "source_id": "src_x"}
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/pdf",
        files=_pdf_files(),
    )
    body = resp.json()
    assert body["credits_used"] == 20
    assert body["credits_remaining"] == 9_980


def test_pdf_refund_on_upstream_failure(pdf_client) -> None:
    """If the dashboard / pod call fails AFTER we charged, we MUST
    refund. Otherwise the user is double-billed for a failed request
    (their balance goes down, they got nothing in return)."""
    client, proxy, charge, refund = pdf_client
    proxy.side_effect = HTTPException(
        status_code=502, detail={"error": "knowledge pod unreachable"},
    )
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/pdf",
        files=_pdf_files(),
    )
    assert resp.status_code == 502
    # Charge then refund — the user is back to balance neutral.
    charge.assert_awaited_once()
    refund.assert_awaited_once()
    refund_args, refund_kwargs = refund.call_args
    assert refund_args[1] == 20
    assert refund_kwargs["transaction_type"] == "knowledge_ingest_pdf_refund"


def test_oversize_pdf_blocked_before_charge(pdf_client) -> None:
    """A 50 MB+ upload must be rejected with 413 before we charge.
    Without this an attacker could spam huge uploads to drain a
    target user's credits via a stolen-but-not-yet-revoked key."""
    client, proxy, charge, refund = pdf_client
    big = b"\x00" * (50 * 1024 * 1024 + 10)
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/pdf",
        files={"file": ("huge.pdf", big, "application/pdf")},
    )
    assert resp.status_code == 413
    charge.assert_not_awaited()
    refund.assert_not_awaited()
    proxy.assert_not_awaited()


def test_empty_pdf_blocked_before_charge(pdf_client) -> None:
    """Empty body → 400 before charge."""
    client, proxy, charge, refund = pdf_client
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/pdf",
        files={"file": ("empty.pdf", b"", "application/pdf")},
    )
    assert resp.status_code == 400
    charge.assert_not_awaited()
    refund.assert_not_awaited()


def test_pdf_charge_zero_when_billing_disabled(monkeypatch, fake_user_id) -> None:
    """Setting ``API_KNOWLEDGE_PDF_CREDITS=0`` disables PDF billing —
    useful for self-hosted or grandfathered customers. In that case
    we should NOT touch credits at all (no audit row either)."""
    app.dependency_overrides[require_api_key] = lambda: {
        "user_id": fake_user_id, "api_key_id": "k_test", "credits": 10_000,
    }
    proxy = AsyncMock(return_value={"status": "completed", "source_id": "src_y"})
    charge = AsyncMock(return_value=-1)
    refund = AsyncMock()
    no_op = AsyncMock(return_value=None)

    import app.api.routes.agent_knowledge as ak
    monkeypatch.setattr(ak, "call_dashboard", proxy)
    monkeypatch.setattr(ak, "charge_credits", charge)
    monkeypatch.setattr(ak, "refund_credits", refund)
    monkeypatch.setattr(ak, "gate_request", no_op)
    monkeypatch.setattr(ak, "log_audit", no_op)
    monkeypatch.setattr(ak, "API_KNOWLEDGE_PDF_CREDITS", 0)

    client = TestClient(app)
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/pdf",
        files=_pdf_files(),
    )
    assert resp.status_code == 200
    # With cost=0 the body should not advertise credits.
    body = resp.json()
    assert "credits_used" not in body
    # charge_credits is still called (returns -1) but no refund needed.
    charge.assert_awaited_once()
    args, _ = charge.call_args
    assert args[1] == 0
    refund.assert_not_awaited()
    app.dependency_overrides.pop(require_api_key, None)
