"""``/v1/feedback`` — thumbs on a single generation."""

from __future__ import annotations


def test_submit_thumbs_up_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"ok": True, "rating": 1}
    resp = client.post("/v1/feedback", json={
        "entry_type": "tts", "entry_id": "job_abc", "rating": 1,
    })
    assert resp.status_code == 200
    args, kwargs = mock_dashboard.await_args
    assert args == ("POST", "/api/dashboard/feedback")
    assert kwargs["json"]["entry_type"] == "tts"
    assert kwargs["json"]["rating"] == 1


def test_submit_thumbs_down_with_comment(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"ok": True, "rating": -1}
    resp = client.post("/v1/feedback", json={
        "entry_type": "voice_clone", "entry_id": "clone_42",
        "rating": -1, "comment": "Sounded robotic",
    })
    assert resp.status_code == 200
    _, kwargs = mock_dashboard.await_args
    assert kwargs["json"]["comment"] == "Sounded robotic"


def test_submit_clear_rating_with_zero(client, mock_dashboard) -> None:
    """rating=0 is the "un-vote" sentinel, must reach the dashboard."""
    mock_dashboard.return_value = {"ok": True, "rating": 0}
    resp = client.post("/v1/feedback", json={
        "entry_type": "tts", "entry_id": "x", "rating": 0,
    })
    assert resp.status_code == 200
    _, kwargs = mock_dashboard.await_args
    assert kwargs["json"]["rating"] == 0


def test_submit_rejects_unknown_entry_type(client) -> None:
    """Unknown ``entry_type`` is caught here, not at the dashboard,
    so the response is 400 (not 502) and includes the allowed list."""
    resp = client.post("/v1/feedback", json={
        "entry_type": "not_a_thing", "entry_id": "x", "rating": 1,
    })
    assert resp.status_code == 400
    assert "entry_type" in resp.json()["detail"]


def test_submit_rejects_out_of_range_rating(client) -> None:
    """Pydantic ge=-1 / le=1 — anything outside 422s before our handler."""
    resp = client.post("/v1/feedback", json={
        "entry_type": "tts", "entry_id": "x", "rating": 5,
    })
    assert resp.status_code == 422


def test_submit_rejects_empty_entry_id(client) -> None:
    resp = client.post("/v1/feedback", json={
        "entry_type": "tts", "entry_id": "", "rating": 1,
    })
    assert resp.status_code == 422


def test_get_feedback_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"rating": 1, "comment": None}
    resp = client.get("/v1/feedback?entry_type=stt&entry_id=trans_99")
    assert resp.status_code == 200
    args, _ = mock_dashboard.await_args
    assert args[0] == "GET"
    assert "entry_type=stt" in args[1]
    assert "entry_id=trans_99" in args[1]


def test_get_feedback_rejects_unknown_entry_type(client) -> None:
    resp = client.get("/v1/feedback?entry_type=not_a_thing&entry_id=x")
    assert resp.status_code == 400


def test_get_feedback_url_encodes_special_chars(client, mock_dashboard) -> None:
    """``entry_id`` is quoted with urllib's default safe set before
    being concatenated into the path — chars like spaces / ``&`` / ``#``
    must be encoded so the dashboard's query parser sees the literal
    value. (Slash isn't encoded since urllib treats it as safe by
    default; entry_ids in practice are slug-like and don't contain it.)"""
    mock_dashboard.return_value = {"rating": 0}
    resp = client.get("/v1/feedback?entry_type=tts&entry_id=has%20space")
    assert resp.status_code == 200
    args, _ = mock_dashboard.await_args
    # Space must be encoded — either %20 or + is acceptable.
    assert "has%20space" in args[1] or "has+space" in args[1]
