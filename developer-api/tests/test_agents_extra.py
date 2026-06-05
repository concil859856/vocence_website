"""``/v1/agents/{templates,models,tools/builtin,draft,architect/chat}``
and ``/v1/agents/{id}/runs*`` — pure proxies to dashboard-backend.

All ten endpoints just forward to the dashboard with the same body /
path / query. Tests assert: routing works, schema rejects malformed
input, and ``call_dashboard`` is invoked with the expected URL.
"""

from __future__ import annotations


VALID_AGENT_ID = "ag_abcdefgh"
VALID_RUN_ID = "run_abcdefgh"
VALID_TEMPLATE_ID = "tmpl_abcdefgh"


# ---------------------------------------------------------------- Templates


def test_list_templates_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"templates": [{"id": "t1", "name": "Customer support"}]}
    resp = client.get("/v1/agents/templates")
    assert resp.status_code == 200
    args, _ = mock_dashboard.await_args
    assert args[0] == "GET"
    assert "templates" in args[1]


def test_get_template_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"id": VALID_TEMPLATE_ID, "system_prompt": "..."}
    resp = client.get(f"/v1/agents/templates/{VALID_TEMPLATE_ID}")
    assert resp.status_code == 200
    args, _ = mock_dashboard.await_args
    assert VALID_TEMPLATE_ID in args[1]


def test_get_template_rejects_uppercase_id(client) -> None:
    """Template ids match ``[a-z0-9_-]{1,64}`` — uppercase letters
    are explicitly rejected by ``_validate_template_id``."""
    resp = client.get("/v1/agents/templates/HAS_UPPER")
    assert resp.status_code == 400


# ---------------------------------------------------------------- Models


def test_list_models_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"models": [
        {"id": "openai/gpt-4o-mini", "context_window": 128000},
    ]}
    resp = client.get("/v1/agents/models")
    assert resp.status_code == 200


# ---------------------------------------------------------------- Built-in tools


def test_list_builtin_tools_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"tools": [
        {"id": "web_search", "name": "Web search"},
    ]}
    resp = client.get("/v1/agents/tools/builtin")
    assert resp.status_code == 200


# ---------------------------------------------------------------- Draft (one-shot agent gen)


def test_draft_agent_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"agent": {"name": "X", "config": {}}}
    resp = client.post("/v1/agents/draft", json={"description": "An agent that handles returns"})
    assert resp.status_code == 200


def test_draft_agent_rejects_empty_description(client) -> None:
    """The handler short-circuits empty descriptions."""
    resp = client.post("/v1/agents/draft", json={"description": ""})
    assert resp.status_code in (400, 422)


def test_draft_agent_rejects_missing_description(client) -> None:
    resp = client.post("/v1/agents/draft", json={})
    assert resp.status_code == 422


# ---------------------------------------------------------------- Architect chat


def test_architect_chat_proxies(client, mock_dashboard) -> None:
    """Architect-chat takes ``{message, history?, existing?}`` per the
    ``_AgentArchitectChatIn`` schema — not a generic ``messages`` array."""
    mock_dashboard.return_value = {"reply": "I suggest...", "proposed_changes": None}
    resp = client.post("/v1/agents/architect/chat", json={
        "message": "Build me a support agent",
    })
    assert resp.status_code == 200


def test_architect_chat_rejects_empty_message(client) -> None:
    resp = client.post("/v1/agents/architect/chat", json={"message": ""})
    assert resp.status_code in (400, 422)


def test_architect_chat_rejects_missing_message(client) -> None:
    resp = client.post("/v1/agents/architect/chat", json={})
    assert resp.status_code == 422


# ---------------------------------------------------------------- Runs


def test_list_runs_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"runs": []}
    resp = client.get(f"/v1/agents/{VALID_AGENT_ID}/runs")
    assert resp.status_code == 200
    args, _ = mock_dashboard.await_args
    assert VALID_AGENT_ID in args[1]


def test_start_run_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"run": {"id": VALID_RUN_ID, "status": "queued"}}
    resp = client.post(f"/v1/agents/{VALID_AGENT_ID}/runs", json={"input": "do the thing"})
    assert resp.status_code in (200, 201)


def test_get_run_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"run": {"id": VALID_RUN_ID, "status": "completed"}}
    resp = client.get(f"/v1/agents/{VALID_AGENT_ID}/runs/{VALID_RUN_ID}")
    assert resp.status_code == 200
    args, _ = mock_dashboard.await_args
    assert VALID_RUN_ID in args[1]


def test_cancel_run_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"ok": True}
    resp = client.post(f"/v1/agents/{VALID_AGENT_ID}/runs/{VALID_RUN_ID}/cancel")
    assert resp.status_code == 200


def test_runs_reject_malformed_agent_id(client) -> None:
    """Both list-runs and start-run guard agent_id with the regex.
    Bad shape should 400, not 200/500."""
    resp = client.get("/v1/agents/x/runs")
    assert resp.status_code in (400, 404, 422)


def test_runs_reject_malformed_run_id(client) -> None:
    resp = client.get(f"/v1/agents/{VALID_AGENT_ID}/runs/x")
    assert resp.status_code in (400, 404, 422)
