"""Agent-knowledge proxy routes.

These tests exercise the developer-api side ONLY — the dashboard
``call_dashboard`` function is replaced with an ``AsyncMock``. We
assert:

- the URL the proxy hits on the dashboard side
- the body shape forwarded
- the file content survives the multipart pipe
- the 50 MB PDF cap rejects oversize uploads BEFORE the proxy hop
"""

from __future__ import annotations

from typing import Any


VALID_AGENT_ID = "ag_12345678"  # 12 chars — passes the [a-zA-Z0-9_-]{8,64} regex


def test_ingest_text_forwards_body(client, mock_dashboard, fake_user_id) -> None:
    mock_dashboard.return_value = {"job_id": "j1"}
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/text",
        json={"content": "hello world", "title": "doc"},
    )
    assert resp.status_code == 200
    assert resp.json() == {"job_id": "j1"}
    # Proxy was invoked once with the right path + body shape.
    assert mock_dashboard.await_count == 1
    args, kwargs = mock_dashboard.await_args
    assert args == ("POST", f"/api/dashboard/agents/{VALID_AGENT_ID}/knowledge/ingest/text")
    assert kwargs["user_id"] == fake_user_id
    assert kwargs["json"] == {"content": "hello world", "title": "doc"}


def test_ingest_text_drops_unset_title(client, mock_dashboard) -> None:
    """If the caller omits title, we MUST NOT forward ``title: None``
    — the upstream Pydantic model uses ``None`` as the actual sentinel
    for ``no title set``, but its OpenAPI clients see ``null`` and get
    weird coercion. Strip on this side, server applies its default."""
    mock_dashboard.return_value = {"job_id": "j1"}
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/text",
        json={"content": "x"},
    )
    assert resp.status_code == 200
    _, kwargs = mock_dashboard.await_args
    assert "title" not in kwargs["json"]


def test_ingest_url_passes_max_depth(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"job_id": "j2"}
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/url",
        json={"url": "https://example.com/docs", "max_depth": 1},
    )
    assert resp.status_code == 200
    _, kwargs = mock_dashboard.await_args
    assert kwargs["json"]["max_depth"] == 1


def test_ingest_url_rejects_max_depth_2(client) -> None:
    """``max_depth`` is bounded 0..1; depth=2 must 422 BEFORE we burn
    a dashboard round-trip."""
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/url",
        json={"url": "https://example.com", "max_depth": 2},
    )
    assert resp.status_code == 422


def test_ingest_sitemap_filter_arrays_forwarded(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"job_id": "j3"}
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/sitemap",
        json={
            "url": "https://example.com/sitemap.xml",
            "include": [r"^https://example\.com/docs/"],
            "exclude": [r"\.pdf$"],
            "max_pages": 50,
        },
    )
    assert resp.status_code == 200
    _, kwargs = mock_dashboard.await_args
    assert kwargs["json"]["include"] == [r"^https://example\.com/docs/"]
    assert kwargs["json"]["exclude"] == [r"\.pdf$"]
    assert kwargs["json"]["max_pages"] == 50


def test_ingest_pdf_forwards_file(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"job_id": "j4"}
    pdf_bytes = b"%PDF-1.4\n%fake pdf body\n%%EOF\n"
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/pdf",
        files={"file": ("doc.pdf", pdf_bytes, "application/pdf")},
        data={"title": "My PDF"},
    )
    assert resp.status_code == 200
    _, kwargs = mock_dashboard.await_args
    # Files were re-packaged for the dashboard call.
    assert kwargs["files"] is not None
    files_payload = kwargs["files"]
    assert files_payload[0][0] == "file"
    assert files_payload[0][1] == pdf_bytes
    assert files_payload[0][3] == "application/pdf"
    assert kwargs["form"] == {"title": "My PDF"}


def test_ingest_pdf_rejects_oversize_upload(client) -> None:
    """A PDF over the 50 MB cap must be rejected with 413, fast, with
    no dashboard call attempted."""
    big = b"\x00" * (50 * 1024 * 1024 + 10)
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/pdf",
        files={"file": ("huge.pdf", big, "application/pdf")},
    )
    assert resp.status_code == 413


def test_ingest_pdf_rejects_empty(client) -> None:
    resp = client.post(
        f"/v1/agents/{VALID_AGENT_ID}/knowledge/ingest/pdf",
        files={"file": ("empty.pdf", b"", "application/pdf")},
    )
    assert resp.status_code == 400


def test_list_sources_hits_dashboard(client, mock_dashboard, fake_user_id) -> None:
    mock_dashboard.return_value = {"sources": [{"id": "s1"}]}
    resp = client.get(f"/v1/agents/{VALID_AGENT_ID}/knowledge/sources")
    assert resp.status_code == 200
    assert resp.json() == {"sources": [{"id": "s1"}]}
    args, kwargs = mock_dashboard.await_args
    assert args == ("GET", f"/api/dashboard/agents/{VALID_AGENT_ID}/knowledge/sources")
    assert kwargs["user_id"] == fake_user_id


def test_delete_source_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"ok": True}
    resp = client.delete(f"/v1/agents/{VALID_AGENT_ID}/knowledge/sources/s1")
    assert resp.status_code == 200
    args, _ = mock_dashboard.await_args
    assert args == ("DELETE", f"/api/dashboard/agents/{VALID_AGENT_ID}/knowledge/sources/s1")


def test_get_job_proxies(client, mock_dashboard) -> None:
    mock_dashboard.return_value = {"status": "done", "progress": 1.0}
    resp = client.get(f"/v1/agents/{VALID_AGENT_ID}/knowledge/jobs/job_xyz")
    assert resp.status_code == 200
    assert resp.json()["status"] == "done"


def test_malformed_agent_id_rejected_fast(client, mock_dashboard) -> None:
    """An agent id that doesn't match the schema regex 400s before any
    dashboard call. Defence-in-depth — the dashboard ALSO rejects, but
    we don't want garbage chars showing up in our access logs."""
    resp = client.get("/v1/agents/!bad/knowledge/sources")
    # Either 400 (our fast-fail) or 404 (FastAPI's path won't match).
    # The fast-fail path requires the regex {8,64} length, so `!bad`
    # is too short → 400.
    assert resp.status_code == 400
    assert mock_dashboard.await_count == 0
