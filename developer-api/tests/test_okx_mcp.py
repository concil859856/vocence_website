"""Tests for the OKX MCP merchant surface.

The x402 SDK and OKX creds are absent in CI, so these cover everything that
does NOT require live settlement: discovery, schemas, pricing math, argument
validation, and the fail-closed behaviour when the payment layer is off.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("JWT_SECRET", "x" * 48)
os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "y" * 48)

from app.main import app  # noqa: E402
from app.okx import config, payments  # noqa: E402
from app.okx.tools import TOOLS, TOOLS_BY_NAME  # noqa: E402

client = TestClient(app)


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def test_manifest_lists_all_six_tools():
    m = client.get("/okx/manifest").json()
    assert m["provider"] == "Vocence"
    names = {t["name"] for t in m["tools"]}
    assert names == {
        "vocence_text_to_speech",
        "vocence_speech_to_text",
        "vocence_voice_design",
        "vocence_voice_clone",
        "vocence_noise_remover",
        "vocence_video_dub",
    }


def test_manifest_reports_not_ready_without_config():
    assert client.get("/okx/manifest").json()["payments_ready"] is False


def test_every_flat_tool_has_a_per_call_price():
    m = client.get("/okx/manifest").json()
    for t in m["tools"]:
        if t["name"] == "vocence_video_dub":
            assert t["pricing"]["model"] == "per_minute_per_language"
        else:
            assert t["pricing"]["model"] == "per_call"
            assert t["pricing"]["usd"].startswith("$")


def test_manifest_never_leaks_the_system_key_or_creds():
    body = client.get("/okx/manifest").text.lower()
    for secret in ("voc_live", "secret", "passphrase", "okx_api_key"):
        assert secret not in body


# ---------------------------------------------------------------------------
# MCP JSON-RPC
# ---------------------------------------------------------------------------


def test_tools_list_matches_registry():
    r = client.post("/okx/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"}).json()
    assert {t["name"] for t in r["result"]["tools"]} == set(TOOLS_BY_NAME)


def test_unknown_method_is_rpc_error():
    r = client.post("/okx/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "nope"}).json()
    assert r["error"]["code"] == -32601


def test_tools_call_unknown_tool_is_rpc_error():
    r = client.post(
        "/okx/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "x", "arguments": {}}},
    ).json()
    assert r["error"]["code"] == -32602


# ---------------------------------------------------------------------------
# Execution gating
# ---------------------------------------------------------------------------


def test_unknown_tool_endpoint_404():
    assert client.post("/okx/tools/does_not_exist", json={}).status_code == 404


def test_paid_tool_fails_closed_when_disabled():
    # No wallet / key / x402 → the surface must refuse, never serve for free.
    assert config.okx_enabled() is False
    assert client.post("/okx/tools/vocence_text_to_speech", json={"text": "hi"}).status_code == 503


def test_arguments_are_validated_when_enabled(monkeypatch):
    # Force the gate open but stub fulfillment, to reach the validation layer.
    monkeypatch.setattr(config, "okx_enabled", lambda: True)

    async def fake_exec(tool, arguments):
        return {"ok": True, "echo": arguments}

    monkeypatch.setattr("app.okx.routes.execute_tool", fake_exec)

    # Missing required "text" → 400 from schema validation.
    bad = client.post("/okx/tools/vocence_text_to_speech", json={})
    assert bad.status_code == 400

    # Valid → reaches (stubbed) fulfillment.
    ok = client.post("/okx/tools/vocence_text_to_speech", json={"text": "hello"})
    assert ok.status_code == 200
    assert ok.json()["result"]["echo"]["text"] == "hello"


# ---------------------------------------------------------------------------
# Pricing math
# ---------------------------------------------------------------------------


def test_flat_price_is_the_tool_price():
    tts = TOOLS_BY_NAME["vocence_text_to_speech"]
    assert payments.price_for(tts) == tts.price


@pytest.mark.parametrize("duration,minutes", [(1, 1), (59, 1), (60, 1), (61, 2), (600, 10)])
def test_metered_price_rounds_up_to_the_minute(duration, minutes):
    dub = TOOLS_BY_NAME["vocence_video_dub"]
    got = payments.price_for(dub, {"duration_sec": duration, "target_languages": ["ja"]})
    base = float(config.PRICE_VIDEO_DUB_PER_MIN.lstrip("$"))
    assert got == f"${base * minutes:.2f}"


def test_metered_price_multiplies_languages_and_lipsync():
    dub = TOOLS_BY_NAME["vocence_video_dub"]
    # 10 min x 2 languages, lip-sync rate: $2.40 * 10 * 2 = $48.00
    got = payments.price_for(
        dub, {"duration_sec": 600, "target_languages": ["ja", "es"], "lipsync": True}
    )
    rate = float(config.PRICE_VIDEO_DUB_LIPSYNC_PER_MIN.lstrip("$"))
    assert got == f"${rate * 10 * 2:.2f}"


def test_metered_price_bad_arguments_fall_back_to_minimum():
    dub = TOOLS_BY_NAME["vocence_video_dub"]
    assert payments.price_for(dub, {}) == config.PRICE_VIDEO_DUB_PER_MIN
    assert payments.price_for(dub, {"duration_sec": "nonsense"}) == config.PRICE_VIDEO_DUB_PER_MIN


def test_route_key_shape():
    dub = TOOLS_BY_NAME["vocence_video_dub"]
    assert payments.route_key(dub) == "POST /okx/tools/vocence_video_dub"


# ---------------------------------------------------------------------------
# Video dubbing specifics
# ---------------------------------------------------------------------------


def test_dub_requires_consent_attestation(monkeypatch):
    monkeypatch.setattr(config, "okx_enabled", lambda: True)

    async def fake_exec(tool, arguments):
        return {"job_id": "j1"}

    monkeypatch.setattr("app.okx.routes.execute_tool", fake_exec)
    body = {
        "video_url": "https://example.com/v.mp4",
        "target_languages": ["ja"],
        "duration_sec": 30,
    }
    # No attestation → schema rejects before any fulfillment.
    assert client.post("/okx/tools/vocence_video_dub", json=body).status_code == 400
    assert (
        client.post("/okx/tools/vocence_video_dub", json={**body, "consent_attested": False}).status_code
        == 400
    )
    ok = client.post("/okx/tools/vocence_video_dub", json={**body, "consent_attested": True})
    assert ok.status_code == 200


def test_dub_status_route_is_free_and_fails_closed(monkeypatch):
    # Disabled surface → 503, never a foreign fetch.
    r = client.get("/okx/tools/vocence_video_dub/jobs/abc123")
    assert r.status_code == 503

    monkeypatch.setattr(config, "okx_enabled", lambda: True)

    async def fake_status(job_id):
        return {"job_id": job_id, "status": "completed"}

    monkeypatch.setattr("app.okx.routes.fetch_dub_status", fake_status)
    r = client.get("/okx/tools/vocence_video_dub/jobs/abc123")
    assert r.status_code == 200
    assert r.json()["status"] == "completed"


def test_dub_status_rejects_malformed_job_ids(monkeypatch):
    from app.okx import proxy

    monkeypatch.setattr(config, "OKX_SYSTEM_API_KEY", "voc_live_x")
    import asyncio

    with pytest.raises(proxy.ToolExecutionError) as exc:
        asyncio.get_event_loop().run_until_complete(proxy.fetch_dub_status("../../etc/passwd"))
    assert exc.value.status == 400


def test_dub_source_filename_sanitized():
    from app.okx.proxy import _source_filename

    assert _source_filename("https://cdn.example.com/media/clip.mp4?sig=x") == "clip.mp4"
    weird = _source_filename("https://x/..%2F..%2Fetc%2Fpasswd")
    assert weird.endswith(".mp4") and "/" not in weird and "%" not in weird


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/v.mp4",
        "http://localhost/v.mp4",
        "http://10.0.0.5/v.mp4",
        "http://192.168.1.1/v.mp4",
        "http://169.254.169.254/latest/meta-data/",
        "http://[::1]/v.mp4",
        "ftp://example.com/v.mp4",
        "http://example.com:8031/v.mp4",  # non-standard port → our own API
    ],
)
def test_video_download_blocks_ssrf_targets(url):
    from app.okx.proxy import ToolExecutionError, _assert_public_url

    with pytest.raises(ToolExecutionError) as exc:
        _assert_public_url(url)
    assert exc.value.status == 400


def test_video_download_allows_public_hosts():
    from app.okx.proxy import _assert_public_url

    # Literal public IP → no DNS needed in CI.
    _assert_public_url("https://93.184.216.34/video.mp4")


def test_uploads_presign_route_exists():
    # The public dub flow depends on this route; it must 401 (auth), never 404.
    r = client.post("/v1/uploads/presign", json={})
    assert r.status_code != 404
