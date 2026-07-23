"""Route-level tests for routers/video_dub.py.

These exist because the pure-function pricing tests passed while
``/video-dub/start`` crashed with ``TypeError: string indices must be
integers`` — the router treated ``require_auth``'s return value as a dict
when it is a plain user-id string. Nothing that only tests helper functions
can catch a mistake in the endpoint signature, so this module drives the
actual ASGI app.

Coverage:
  * every endpoint returns its declared shape under a real request
  * the auth dependency's return value is consumed correctly
  * validation rejects (bad language / too many / no consent / over-length)
  * pricing returned by /quote matches credits_for
"""

from __future__ import annotations

import inspect
import os
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("JWT_SECRET", "test-jwt-secret-" + "x" * 40)
os.environ.setdefault("INTERNAL_SERVICE_TOKEN", "test-internal-" + "y" * 40)

_DB_FILE = tempfile.NamedTemporaryFile(delete=False, suffix="_video_dub.db")
_DB_FILE.close()
os.environ["SQLITE_PATH"] = _DB_FILE.name

# Both tiers configured so availability flags are True and /start gets past
# the tier gate; no upstream call happens because enqueue is stubbed.
os.environ["ELEVENLABS_API_KEY"] = "test-el-key"
os.environ["HEYGEN_API_KEY"] = "test-hg-key"

import local_db                                # noqa: E402
from jobs import api as jobs_api               # noqa: E402
from routers import video_dub as vd            # noqa: E402
from routers.auth import require_auth          # noqa: E402

TEST_USER_ID = "user-abc-123"


@pytest.fixture(scope="module", autouse=True)
def _schema():
    """Real schema + a funded test user.

    The start route reads auth_users.credits directly, so the row has to
    exist — faking the connection would stop exercising that query, which is
    the one guarding every free-tier request.
    """
    import asyncio

    async def setup():
        await local_db.ensure_tables()
        conn = await local_db.get_connection()
        try:
            await conn.execute(
                "INSERT OR REPLACE INTO auth_users (id, email, name, credits, created_at) "
                "VALUES (?, ?, ?, ?, datetime('now'))",
                (TEST_USER_ID, "dub-test@example.com", "Dub Test", 1_000_000),
            )
            await conn.commit()
        finally:
            await conn.close()

    asyncio.run(setup())


def _set_balance(credits: int) -> None:
    """Set the test user's balance for a single assertion."""
    import asyncio

    async def go():
        conn = await local_db.get_connection()
        try:
            await conn.execute("UPDATE auth_users SET credits = ? WHERE id = ?", (credits, TEST_USER_ID))
            await conn.commit()
        finally:
            await conn.close()

    asyncio.run(go())


@pytest.fixture
def client(monkeypatch):
    app = FastAPI()
    app.include_router(vd.router, prefix="/api/dashboard")
    # require_auth returns the user_id STRING — mirroring production exactly,
    # so a router that treats it as a dict fails here too.
    app.dependency_overrides[require_auth] = lambda: TEST_USER_ID

    captured = {}

    # The stub is bound to the REAL enqueue signature and returns the REAL
    # EnqueueResult type. A hand-written fake is worthless here: the first
    # version of this file invented `credits=` and `dict` returns, matching a
    # bug in the router instead of catching it. bind() raises TypeError on a
    # wrong keyword, and the dataclass raises AttributeError on `result["x"]`.
    real_sig = inspect.signature(jobs_api.enqueue)

    async def fake_enqueue(*args, **kwargs):
        real_sig.bind(*args, **kwargs)
        captured.update(kwargs)
        return jobs_api.EnqueueResult(
            job_id="job-1", queue_position=0, load_warning=False, pool_snapshots={}
        )

    monkeypatch.setattr(vd.jobs_api, "enqueue", fake_enqueue)
    c = TestClient(app)
    c.captured = captured
    return c


def _start_body(**over):
    body = {
        "src_bucket": "product",
        "src_key": f"{TEST_USER_ID}/video-dub-source/abc.mp4",
        "src_filename": "clip.mp4",
        "duration_sec": 6.0,
        "size_bytes": 1_700_000,
        "width": 1280,
        "height": 720,
        "source_language": "auto",
        "target_languages": ["ja"],
        "lipsync": False,
        "num_speakers": 1,
        "consent_attested": True,
    }
    body.update(over)
    return body


# ---------------------------------------------------------------------------
# The regression this module exists for
# ---------------------------------------------------------------------------


def test_start_consumes_auth_dependency_correctly(client):
    """``require_auth`` yields a str; indexing it as a dict is a 500."""
    r = client.post("/api/dashboard/video-dub/start", json=_start_body())
    assert r.status_code == 200, r.text
    assert client.captured["user_id"] == TEST_USER_ID


def test_history_consumes_auth_dependency_correctly(client):
    r = client.get("/api/dashboard/video-dub/history")
    assert r.status_code == 200, r.text
    assert r.json()["items"] == []


# ---------------------------------------------------------------------------
# Endpoint shapes
# ---------------------------------------------------------------------------


def test_languages_shape(client):
    r = client.get("/api/dashboard/video-dub/languages")
    assert r.status_code == 200
    d = r.json()
    assert d["standard_available"] is True and d["lipsync_available"] is True
    assert len(d["languages"]) == len(vd.SUPPORTED_LANGUAGES)
    for lang in d["languages"]:
        assert set(lang) == {"code", "label", "lipsync"}, "lipsync_label must not leak"


def test_quote_matches_pricing_function(client):
    from video_dub_service import TIER_LIPSYNC, credits_for
    r = client.post("/api/dashboard/video-dub/quote",
                    json={"duration_sec": 6.0, "target_languages": ["ja", "es"], "lipsync": True})
    assert r.status_code == 200, r.text
    assert r.json()["credits"] == credits_for(TIER_LIPSYNC, 6.0, 2)


def test_start_charges_server_computed_price_not_client_value(client):
    """The client never supplies a price; the server derives it."""
    from video_dub_service import TIER_STANDARD, credits_for
    client.post("/api/dashboard/video-dub/start", json=_start_body())
    assert client.captured["credits_to_charge"] == credits_for(TIER_STANDARD, 6.0, 1)


def test_start_maps_language_codes_per_tier(client):
    """Standard gets ISO codes; lip-sync gets the engine's display names."""
    client.post("/api/dashboard/video-dub/start", json=_start_body())
    assert client.captured["payload"]["target_languages"] == ["ja"]

    client.post("/api/dashboard/video-dub/start", json=_start_body(lipsync=True))
    assert client.captured["payload"]["target_languages"] == ["Japanese"]
    assert client.captured["payload"]["target_language_codes"] == ["ja"]


def test_corrected_labels_are_used(client):
    """Norwegian/Hungarian were wrong and 400'd upstream after charging."""
    client.post("/api/dashboard/video-dub/start",
                json=_start_body(lipsync=True, target_languages=["no", "hu"]))
    assert client.captured["payload"]["target_languages"] == [
        "Norwegian Bokmål (Norway)", "Hungarian (Hungary)",
    ]


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def test_start_requires_consent(client):
    r = client.post("/api/dashboard/video-dub/start", json=_start_body(consent_attested=False))
    assert r.status_code == 400
    assert "rights" in r.json()["detail"].lower()


def test_start_rejects_unknown_language(client):
    r = client.post("/api/dashboard/video-dub/start", json=_start_body(target_languages=["xx"]))
    assert r.status_code == 400


def test_start_rejects_too_many_languages(client):
    r = client.post("/api/dashboard/video-dub/start",
                    json=_start_body(target_languages=["ja", "es", "fr", "de"]))
    assert r.status_code == 400


def test_start_rejects_over_length_video(client):
    r = client.post("/api/dashboard/video-dub/start", json=_start_body(duration_sec=99999))
    assert r.status_code == 400


def test_start_rejects_4k_when_lipsync_enabled(client):
    r = client.post("/api/dashboard/video-dub/start",
                    json=_start_body(lipsync=True, width=3840, height=2160))
    assert r.status_code == 400
    assert "2048" in r.json()["detail"]


def test_start_allows_4k_without_lipsync(client):
    r = client.post("/api/dashboard/video-dub/start", json=_start_body(width=3840, height=2160))
    assert r.status_code == 200, r.text


def test_start_rejects_oversize_for_lipsync_tier(client):
    r = client.post("/api/dashboard/video-dub/start",
                    json=_start_body(lipsync=True, size_bytes=150 * 1024 * 1024))
    assert r.status_code == 400


def test_start_dedupes_repeated_languages(client):
    client.post("/api/dashboard/video-dub/start", json=_start_body(target_languages=["ja", "ja"]))
    assert client.captured["payload"]["target_language_codes"] == ["ja"]


def test_error_details_never_name_a_vendor(client):
    vendors = ("elevenlabs", "heygen")
    for body in (
        _start_body(consent_attested=False),
        _start_body(target_languages=["xx"]),
        _start_body(lipsync=True, width=3840, height=2160),
        _start_body(duration_sec=99999),
    ):
        r = client.post("/api/dashboard/video-dub/start", json=body)
        detail = str(r.json().get("detail", "")).lower()
        assert not any(v in detail for v in vendors)


# ---------------------------------------------------------------------------
# Source URL presigning
# ---------------------------------------------------------------------------


def test_source_url_ttl_outlives_the_job_budget():
    """The lip-sync engine fetches the source partway through a render.

    Regression: the worker presigned with ``expires_at = now``, giving a
    zero-second window. get_presigned_url returns None for any non-positive
    window, so every lip-sync job died with "could not presign source video"
    after the user had already been charged.
    """
    from jobs.timeouts import JOB_BUDGET
    from jobs.workers.video_dub import SOURCE_URL_TTL_SEC

    assert SOURCE_URL_TTL_SEC > 0
    assert SOURCE_URL_TTL_SEC >= JOB_BUDGET["video_dub"] - 600


def test_presign_returns_none_for_a_non_positive_window():
    """Documents the behaviour the bug tripped over, so the pairing between
    a future expiry and a usable URL stays explicit."""
    from datetime import datetime, timezone

    from studio_tts_service import get_presigned_url

    now = datetime.now(timezone.utc)
    assert get_presigned_url("product", "u/video-dub-source/x.mp4", now) is None


# ---------------------------------------------------------------------------
# Free-tier access: no plan gate, only a balance check
# ---------------------------------------------------------------------------


def test_no_premium_gate_on_dubbing(client):
    """Dubbing is available on every plan; only credits gate it."""
    _set_balance(1_000_000)
    r = client.post("/api/dashboard/video-dub/start", json=_start_body())
    assert r.status_code == 200, r.text


def test_insufficient_credits_is_402_not_503(client):
    """A low balance must not read as "server busy, retry".

    enqueue() raises JobAdmissionRejected for both a full queue and an empty
    wallet; mapping that to 503 tells the user to retry, which never helps.
    The balance is checked first so the response is 402 with the real numbers.
    """
    _set_balance(5)
    try:
        r = client.post("/api/dashboard/video-dub/start", json=_start_body())
        assert r.status_code == 402, r.text
        assert "credits" in r.json()["detail"]
    finally:
        _set_balance(1_000_000)


def test_insufficient_credits_message_mentions_lipsync_only_when_on(client):
    _set_balance(0)
    try:
        off = client.post("/api/dashboard/video-dub/start", json=_start_body()).json()["detail"]
        on = client.post("/api/dashboard/video-dub/start", json=_start_body(lipsync=True)).json()["detail"]
        assert "lip-sync" not in off
        assert "lip-sync" in on
    finally:
        _set_balance(1_000_000)


def test_free_user_lipsync_over_cap_is_403(client):
    """A free account dubbing a long clip WITH lip-sync is refused up front.

    No payments row exists for the test user, so _is_premium_user returns
    False — the production free-tier path.
    """
    from video_dub_service import VIDEO_DUB_LIPSYNC_FREE_MAX_SEC as CAP
    r = client.post(
        "/api/dashboard/video-dub/start",
        json=_start_body(lipsync=True, duration_sec=CAP + 30),
    )
    assert r.status_code == 403, r.text
    assert str(CAP) in r.json()["detail"]


def test_free_user_standard_long_video_is_allowed(client):
    """Standard dubbing has no plan cap — length is gated only by credits."""
    _set_balance(1_000_000)
    r = client.post(
        "/api/dashboard/video-dub/start",
        json=_start_body(lipsync=False, duration_sec=300),
    )
    assert r.status_code == 200, r.text


def test_free_user_short_lipsync_is_allowed(client):
    from video_dub_service import VIDEO_DUB_LIPSYNC_FREE_MAX_SEC as CAP
    _set_balance(1_000_000)
    r = client.post(
        "/api/dashboard/video-dub/start",
        json=_start_body(lipsync=True, duration_sec=CAP),
    )
    assert r.status_code == 200, r.text


# ---------------------------------------------------------------------------
# Completion callbacks (callback_url / callback_secret)
# ---------------------------------------------------------------------------


def test_start_rejects_private_callback_url_before_charge(client):
    """SSRF guard runs pre-charge: an internal callback target is a 400."""
    for bad in (
        "https://127.0.0.1/hook",
        "https://169.254.169.254/latest/meta-data/",
        "https://192.168.0.10/hook",
        "ftp://example.com/hook",
    ):
        r = client.post(
            "/api/dashboard/video-dub/start",
            json=_start_body(callback_url=bad),
        )
        assert r.status_code == 400, (bad, r.text)
        assert "callback_url" in r.json()["detail"]


def test_start_stores_callback_in_payload(client, monkeypatch):
    import job_callbacks

    monkeypatch.setattr(job_callbacks, "validate_callback_url", lambda url: None)
    r = client.post(
        "/api/dashboard/video-dub/start",
        json=_start_body(callback_url="https://hooks.example.com/dub", callback_secret="s3cret"),
    )
    assert r.status_code == 200, r.text
    assert client.captured["payload"]["callback_url"] == "https://hooks.example.com/dub"
    assert client.captured["payload"]["callback_secret"] == "s3cret"


def test_callback_secret_never_echoes_from_job_status():
    """to_dict() is what every job-status endpoint returns — the signing
    secret must be scrubbed there, not per-route."""
    from jobs.state import Job

    job = Job(
        id="j1", user_id="u1", type="video_dub", status="completed", phase=None,
        payload={"callback_url": "https://x.example/h", "callback_secret": "top"},
        result={}, error_message=None, pod_url=None, credits_charged=1,
        created_at="now", started_at=None, finished_at=None,
    )
    d = job.to_dict()
    assert "callback_secret" not in d["payload"]
    assert d["payload"]["callback_url"] == "https://x.example/h"


def test_callback_signature_matches_sdk_format():
    """job_callbacks signs exactly like webhooks_service so the SDK's
    webhooks.verify() works on both."""
    import base64
    import hashlib
    import hmac as hmac_mod

    from webhooks_service import _sign_body

    body = b'{"event":"video_dub.completed"}'
    sig = _sign_body(body, "abc", timestamp=1700000000)
    mac = hmac_mod.new(b"abc", b"v1.1700000000." + body, hashlib.sha256).digest()
    assert sig == "v1=" + base64.b64encode(mac).decode()


def test_fire_and_forget_without_callback_is_noop():
    """Jobs without callback_url must not schedule anything (no loop needed)."""
    from jobs.state import Job

    import job_callbacks

    job = Job(
        id="j2", user_id="u1", type="video_dub", status="completed", phase=None,
        payload={}, result={}, error_message=None, pod_url=None, credits_charged=1,
        created_at="now", started_at=None, finished_at=None,
    )
    # No running loop here — would raise if it tried to schedule.
    job_callbacks.fire_and_forget(job, "completed", {}, None)
