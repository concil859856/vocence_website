"""Embed-token proxy routes."""

from __future__ import annotations


VALID_AGENT_ID = "ag_abcdefgh"


def test_create_default_body_uses_safe_defaults(client, mock_dashboard) -> None:
    """An empty POST body must reach the dashboard with the safe-by-
    default values our Pydantic model bakes in: empty origin list,
    30 rpm/IP, 5-minute session cap. These match the dashboard's own
    defaults so the two sides can't drift."""
    mock_dashboard.return_value = {
        "plaintext": "vet_secret", "token": {"id": "t1"}, "embed_snippet": "<x>",
    }
    resp = client.post(f"/v1/agents/{VALID_AGENT_ID}/embed-tokens", json={})
    assert resp.status_code == 201
    _, kwargs = mock_dashboard.await_args
    assert kwargs["json"] == {
        "label": "",
        "allowed_origins": [],
        "rate_limit_per_ip_per_hour": 30,
        "max_session_minutes": 5,
    }


def test_create_passes_explicit_fields(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"plaintext": "vet_secret"}
    body = {
        "label": "staging",
        "allowed_origins": ["https://staging.example.com"],
        "rate_limit_per_ip_per_hour": 60,
        "max_session_minutes": 10,
    }
    resp = client.post(f"/v1/agents/{VALID_AGENT_ID}/embed-tokens", json=body)
    assert resp.status_code == 201
    _, kwargs = mock_dashboard.await_args
    assert kwargs["json"] == body


def test_create_rejects_huge_rate_limit(client) -> None:
    """``rate_limit_per_ip_per_hour`` is bounded 1..10000 — outside
    range should 422 before hitting the dashboard."""
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/embed-tokens",
        json={"rate_limit_per_ip_per_hour": 999_999},
    )
    assert resp.status_code == 422


def test_list_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"tokens": [{"id": "t1", "label": "demo"}]}
    resp = client.get(f"/v1/agents/{VALID_AGENT_ID}/embed-tokens")
    assert resp.status_code == 200
    assert resp.json()["tokens"][0]["id"] == "t1"


def test_revoke_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"ok": True}
    resp = client.delete(f"/v1/agents/{VALID_AGENT_ID}/embed-tokens/t1")
    assert resp.status_code == 200
    args, _ = mock_dashboard.await_args
    assert args == ("DELETE", f"/api/dashboard/agents/{VALID_AGENT_ID}/embed-tokens/t1")
