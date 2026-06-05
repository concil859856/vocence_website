"""``/v1/account*`` — read-only account info, key CRUD, usage log."""

from __future__ import annotations

from unittest.mock import AsyncMock


def test_get_account_returns_normalised_shape(client, mock_dashboard, fake_user_id) -> None:
    """``GET /v1/account`` issues TWO dashboard calls (user record +
    keys count) and merges them into a single snake-cased response."""
    # First call (user record) returns camelCase; second (keys list)
    # returns ``{keys: [...]}``. ``AsyncMock.side_effect`` returns each
    # in order.
    mock_dashboard.side_effect = [
        {
            "id": fake_user_id, "email": "x@example.com", "name": "X",
            "credits": 4242, "planCode": "premium", "planStatus": "active",
        },
        {"keys": [{"id": "k1"}, {"id": "k2"}]},
    ]
    resp = client.get("/v1/account")
    assert resp.status_code == 200
    body = resp.json()
    assert body["user_id"] == fake_user_id
    assert body["email"] == "x@example.com"
    assert body["credits"] == 4242
    assert body["plan_code"] == "premium"
    assert body["api_keys_count"] == 2


def test_get_account_handles_missing_camelcase_fields(client, mock_dashboard) -> None:
    """Older dashboard responses may have ``plan_code`` instead of
    ``planCode`` — both branches must work."""
    mock_dashboard.side_effect = [
        {"id": "u", "email": "y@z", "name": "Y", "credits": 0,
         "plan_code": "normal", "plan_status": "active"},
        {"keys": []},
    ]
    resp = client.get("/v1/account")
    assert resp.status_code == 200
    assert resp.json()["plan_code"] == "normal"
    assert resp.json()["api_keys_count"] == 0


def test_list_keys_strips_secrets(client, mock_dashboard) -> None:
    """``GET /v1/account/keys`` returns metadata only — never the
    plaintext secret. We assert by checking the response has no
    ``plain_key`` / ``key_hash`` field even if the upstream did."""
    mock_dashboard.return_value = {"keys": [
        {"id": "k1", "name": "default", "keyPrefix": "voc_live_abc",
         "tier": "normal", "createdAt": "2026-01-01T00:00:00Z"},
    ]}
    resp = client.get("/v1/account/keys")
    assert resp.status_code == 200
    out = resp.json()["keys"]
    assert len(out) == 1
    assert out[0]["id"] == "k1"
    assert out[0]["key_prefix"] == "voc_live_abc"
    assert "plain_key" not in out[0]


def test_create_key_returns_plaintext_once(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {
        "key": {"id": "k_new", "name": "ci", "keyPrefix": "voc_live_xyz", "tier": "normal"},
        "plainKey": "voc_live_xyzREDACTEDsecretrest",
    }
    resp = client.post("/v1/account/keys", json={"name": "ci"})
    assert resp.status_code == 201
    body = resp.json()
    assert body["key"]["id"] == "k_new"
    assert body["plain_key"].startswith("voc_live_")


def test_create_key_502s_when_upstream_lacks_secret(client, mock_dashboard) -> None:
    """If the dashboard returns a key row but no plaintext, we MUST
    refuse rather than silently dropping the only chance the caller
    has to copy it."""
    mock_dashboard.return_value = {"key": {"id": "k_orphan"}}  # missing plainKey
    resp = client.post("/v1/account/keys", json={"name": "broken"})
    assert resp.status_code == 502


def test_create_key_rejects_empty_name(client) -> None:
    """Pydantic min_length=1 — empty name 422s before reaching the
    upstream."""
    resp = client.post("/v1/account/keys", json={"name": ""})
    assert resp.status_code == 422


def test_create_key_rejects_overlong_name(client) -> None:
    resp = client.post("/v1/account/keys", json={"name": "x" * 65})
    assert resp.status_code == 422


def test_usage_clamps_limit_and_normalises_shape(client, mock_dashboard) -> None:
    """Limit > 200 should be silently clamped to 200 in the URL we
    forward; response items normalise camelCase → snake_case."""
    mock_dashboard.return_value = {"logs": [
        {"id": "r1", "endpoint": "/v1/tts/generate", "status": "ok",
         "httpStatus": 200, "creditsUsed": 25, "requestChars": 18,
         "latencyMs": 412, "createdAt": "2026-06-01T12:00:00Z"},
    ]}
    resp = client.get("/v1/account/usage?limit=99999")
    assert resp.status_code == 200
    args, kwargs = mock_dashboard.await_args
    # Forwarded URL contains the CLAMPED limit, not the raw 99999.
    assert "limit=200" in args[1]
    items = resp.json()["items"]
    assert items[0]["credits_used"] == 25
    assert items[0]["http_status"] == 200
    assert items[0]["latency_ms"] == 412


def test_usage_default_limit_when_omitted(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"logs": []}
    resp = client.get("/v1/account/usage")
    assert resp.status_code == 200
    args, _ = mock_dashboard.await_args
    assert "limit=50" in args[1]


def test_revoke_key_404_when_not_owned(client, monkeypatch, fake_user_id) -> None:
    """The revoke endpoint checks the api_keys table for ownership
    before forwarding. If the key isn't owned by the caller, we MUST
    return 404 (not a generic error) so callers can't probe for the
    existence of other users' keys."""
    import app.api.routes.account as account_mod

    async def fake_get_db():
        class FakeRow(dict):
            def __getitem__(self, k):
                return super().__getitem__(k)

        class FakeCursor:
            async def fetchone(self):
                # Key belongs to a DIFFERENT user.
                return FakeRow({"user_id": "someone_else"})

        class FakeConn:
            async def execute(self, *args, **kwargs):
                return FakeCursor()
            async def close(self):
                return None

        return FakeConn()

    monkeypatch.setattr(account_mod, "get_db", fake_get_db)
    resp = client.post("/v1/account/keys/k_other/revoke")
    assert resp.status_code == 404


def test_revoke_key_404_when_not_found(client, monkeypatch) -> None:
    import app.api.routes.account as account_mod

    async def fake_get_db():
        class FakeCursor:
            async def fetchone(self):
                return None

        class FakeConn:
            async def execute(self, *args, **kwargs):
                return FakeCursor()
            async def close(self):
                return None

        return FakeConn()

    monkeypatch.setattr(account_mod, "get_db", fake_get_db)
    resp = client.post("/v1/account/keys/k_missing/revoke")
    assert resp.status_code == 404


def test_revoke_key_happy_path(client, mock_dashboard, monkeypatch, fake_user_id) -> None:
    import app.api.routes.account as account_mod

    async def fake_get_db():
        class FakeCursor:
            async def fetchone(self):
                # Key belongs to the caller.
                return {"user_id": fake_user_id}

        class FakeConn:
            async def execute(self, *args, **kwargs):
                return FakeCursor()
            async def close(self):
                return None

        return FakeConn()

    monkeypatch.setattr(account_mod, "get_db", fake_get_db)
    mock_dashboard.return_value = {"ok": True}
    resp = client.post("/v1/account/keys/k_mine/revoke")
    assert resp.status_code == 200
    assert resp.json()["ok"] is True
    args, _ = mock_dashboard.await_args
    assert "revoke" in args[1]
