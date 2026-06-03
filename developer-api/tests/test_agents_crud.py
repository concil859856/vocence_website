"""``/v1/agents*`` CRUD + ``/v1/agent-tools*`` validation tests.

Most of these endpoints hit the real DB to look up / mutate the
``agents`` and ``agent_custom_tools`` tables. We test the Pydantic /
short-circuit validation paths that fire BEFORE the DB lookup, plus
the routing-shape (404 on bad ids).
"""

from __future__ import annotations


# ============================================================================
# /v1/agents CRUD
# ============================================================================


def _stub_empty_db(monkeypatch) -> None:
    """Make the agents module's ``get_db`` return a FakeConn whose
    fetchone/fetchall return None / []. Used to test 404 paths."""
    import app.api.routes.agent_mgmt as am_mod

    async def fake_get_db():
        class FakeCursor:
            async def fetchall(self): return []
            async def fetchone(self): return None

        class FakeConn:
            async def execute(self, *args, **kwargs): return FakeCursor()
            async def commit(self): return None
            async def close(self): return None
        return FakeConn()
    monkeypatch.setattr(am_mod, "get_db", fake_get_db)


def test_list_agents_empty(client, monkeypatch) -> None:
    _stub_empty_db(monkeypatch)
    resp = client.get("/v1/agents")
    assert resp.status_code == 200
    assert resp.json()["agents"] == []


def test_get_agent_404_on_missing(client, monkeypatch) -> None:
    """``_verify_agent_ownership`` returns None when row is missing →
    404 before the per-id tool lookup."""
    _stub_empty_db(monkeypatch)
    resp = client.get("/v1/agents/ag_doesnotexist")
    # 404 (not found) OR 400 (bad id shape) — both are valid short-circuits.
    assert resp.status_code in (400, 404)


def test_get_agent_400_on_malformed_id(client) -> None:
    """Agent id must match ``[a-zA-Z0-9_-]{8,64}`` per the regex
    guard in v1 / streaming routers. Way-too-short ids 400 at routing."""
    resp = client.get("/v1/agents/x")  # too short
    # 400 (malformed) or 404 (not found) — either is a hard reject.
    assert resp.status_code in (400, 404)


def test_create_agent_rejects_invalid_type(client) -> None:
    """``type`` must be 'knowledge' or 'goal'. Anything else 400s
    in the handler before any DB write."""
    resp = client.post("/v1/agents", json={
        "name": "Test", "type": "not_a_type",
    })
    assert resp.status_code in (400, 422)


def test_create_agent_rejects_empty_name(client) -> None:
    """Pydantic min_length on name → 422."""
    resp = client.post("/v1/agents", json={"name": "", "type": "knowledge"})
    assert resp.status_code == 422


def test_create_agent_rejects_missing_name(client) -> None:
    resp = client.post("/v1/agents", json={"type": "knowledge"})
    assert resp.status_code == 422


def test_create_agent_rejects_missing_type(client) -> None:
    resp = client.post("/v1/agents", json={"name": "Test"})
    assert resp.status_code == 422


def test_patch_agent_rejects_invalid_status(client, monkeypatch) -> None:
    """status must be one of draft/active/paused/archived. The handler
    400s on anything else AFTER the ownership check, so we stub the
    DB to make the row-exists branch succeed."""
    import app.api.routes.agent_mgmt as am_mod

    async def fake_verify(agent_id: str, user_id: str):
        return {"id": agent_id, "user_id": user_id, "config_json": "{}", "name": "x", "status": "draft"}

    monkeypatch.setattr(am_mod, "_verify_agent_ownership", fake_verify)
    resp = client.patch("/v1/agents/ag_abcdefgh", json={"status": "weird"})
    # Pydantic Literal["draft","active","paused","archived"] OR handler
    # 400 — either is acceptable rejection.
    assert resp.status_code in (400, 422)


# ============================================================================
# /v1/agent-tools CRUD (custom webhook tools)
# ============================================================================


def test_list_agent_tools_empty(client, monkeypatch) -> None:
    _stub_empty_db(monkeypatch)
    resp = client.get("/v1/agent-tools")
    assert resp.status_code == 200
    assert resp.json().get("tools") == [] or resp.json() == {"tools": []}


def test_create_agent_tool_rejects_empty_body(client) -> None:
    """Custom tool create requires name + endpoint url + parameters."""
    resp = client.post("/v1/agent-tools", json={})
    assert resp.status_code == 422


def test_create_agent_tool_rejects_invalid_url(client) -> None:
    """Endpoint URL must be a valid http(s):// — file:// / ftp:// /
    relative paths 422."""
    resp = client.post("/v1/agent-tools", json={
        "name": "test_tool",
        "description": "A test",
        "endpoint_url": "ftp://example.com/x",
        "http_method": "POST",
        "parameters_schema": {"type": "object", "properties": {}},
    })
    # 422 if pydantic catches it, 400 if handler catches it. Either OK.
    assert resp.status_code in (400, 422)


def test_get_agent_tool_404_when_missing(client, monkeypatch) -> None:
    _stub_empty_db(monkeypatch)
    resp = client.get("/v1/agent-tools/at_doesnotexist")
    assert resp.status_code in (400, 404)
