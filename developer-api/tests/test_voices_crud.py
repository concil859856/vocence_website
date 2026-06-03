"""``/v1/voices*`` CRUD endpoints — list, get, delete, builtin.

``GET /voices/builtin`` and ``DELETE /voices/{id}`` are pure proxies
(test the call-dashboard wiring). ``GET /voices`` and ``GET /voices/{id}``
hit the real DB to look up the user's saved voices — we stub
``get_db`` per-test to return a known row set.
"""

from __future__ import annotations


# ---------------------------------------------------------------- /v1/voices/builtin


def test_list_builtin_voices_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"voices": [
        {"id": "voc-atlas", "name": "Atlas"},
        {"id": "design-aria", "name": "Aria"},
    ]}
    resp = client.get("/v1/voices/builtin")
    assert resp.status_code == 200
    args, _ = mock_dashboard.await_args
    assert args == ("GET", "/api/dashboard/studio/builtin-voices")
    assert len(resp.json()["voices"]) == 2


# ---------------------------------------------------------------- /v1/voices (saved list)


class _FakeRow(dict):
    def keys(self):
        return super().keys()


def _stub_get_db(rows):
    """Return an async ``get_db`` shim whose ``execute`` returns the
    given list as fetchall result. Used by /v1/voices and
    /v1/voices/{id}."""
    async def _get_db():
        class FakeCursor:
            def __init__(self, _rows):
                self._rows = _rows
            async def fetchall(self):
                return self._rows
            async def fetchone(self):
                return self._rows[0] if self._rows else None

        class FakeConn:
            async def execute(self, *args, **kwargs):
                return FakeCursor(rows)
            async def close(self):
                return None

        return FakeConn()
    return _get_db


def test_list_voices_returns_user_saved_voices(client, monkeypatch, fake_user_id) -> None:
    import app.api.routes.agent_mgmt as am_mod
    rows = [
        _FakeRow(
            id=42, display_name="My Voice", voice_description="A test voice",
            ref_script=None, audio_s3_bucket="bk", audio_s3_key="k.wav",
            expires_at="2027-01-01T00:00:00Z", created_at="2026-01-01T00:00:00Z",
            source="cloned", source_language="English",
        ),
    ]
    monkeypatch.setattr(am_mod, "get_db", _stub_get_db(rows))
    resp = client.get("/v1/voices")
    assert resp.status_code == 200
    voices = resp.json()["voices"]
    assert len(voices) == 1
    assert voices[0]["id"] == 42
    assert voices[0]["display_name"] == "My Voice"


def test_list_voices_empty(client, monkeypatch) -> None:
    import app.api.routes.agent_mgmt as am_mod
    monkeypatch.setattr(am_mod, "get_db", _stub_get_db([]))
    resp = client.get("/v1/voices")
    assert resp.status_code == 200
    assert resp.json()["voices"] == []


# ---------------------------------------------------------------- /v1/voices/{id}


def test_get_voice_404_when_missing(client, monkeypatch) -> None:
    import app.api.routes.agent_mgmt as am_mod
    monkeypatch.setattr(am_mod, "get_db", _stub_get_db([]))
    resp = client.get("/v1/voices/9999")
    assert resp.status_code == 404


def test_get_voice_returns_single(client, monkeypatch) -> None:
    import app.api.routes.agent_mgmt as am_mod
    row = _FakeRow(
        id=7, display_name="Aria", voice_description="bright",
        ref_script=None, audio_s3_bucket="b", audio_s3_key="k",
        expires_at="2027-01-01T00:00:00Z", created_at="2026-01-01T00:00:00Z",
        source="designed", source_language="English",
    )
    monkeypatch.setattr(am_mod, "get_db", _stub_get_db([row]))
    resp = client.get("/v1/voices/7")
    assert resp.status_code == 200
    assert resp.json()["voice"]["id"] == 7


def test_get_voice_rejects_non_integer_id(client) -> None:
    """Path is typed as ``int`` — letters 422 at routing."""
    resp = client.get("/v1/voices/not-a-number")
    assert resp.status_code == 422


# ---------------------------------------------------------------- /v1/voices/{id} DELETE


def test_delete_voice_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"ok": True}
    resp = client.delete("/v1/voices/42")
    assert resp.status_code == 200
    args, _ = mock_dashboard.await_args
    assert args[0] == "DELETE"
    assert "/voices/42" in args[1]
