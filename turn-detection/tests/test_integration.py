"""Integration tests against a live FastAPI app.

Boots the real app — models are loaded for real. The first run after a
fresh cache takes a few seconds for the HF downloads; subsequent runs
are instant because ``TD_MODELS_CACHE_DIR`` lives across sessions.

The CI runner should pre-populate the cache (or accept the one-time
~3 s warmup).
"""

from __future__ import annotations

import json
import os

import httpx
import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def app_client():
    # The conftest.py has already set TD_API_KEY. Ensure cache dir is
    # consistent so we don't pay download cost in CI.
    os.environ.setdefault("TD_LOG_LEVEL", "warning")
    # Import lazily so the app starts up inside the fixture rather than
    # at collection time.
    from turn_detection import server
    # TestClient triggers lifespan on enter / exit. Use the
    # context-manager form so models actually load.
    with TestClient(server.app) as client:
        yield client


class TestHealthz:
    def test_returns_ok_after_lifespan(self, app_client: TestClient) -> None:
        r = app_client.get("/healthz")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["service"] == "turn-detection"
        assert body["models"]["smart_turn"]["loaded"] is True
        assert body["models"]["turn_detector"]["loaded"] is True
        # Required spec fields
        assert "in_flight" in body
        assert "max_concurrent_streams" in body
        assert body["max_concurrent_streams"] > 0

    def test_status_field_present(self, app_client: TestClient) -> None:
        """Dispatcher reads ``status``, not the HTTP code."""
        r = app_client.get("/healthz")
        assert "status" in r.json()


class TestMetrics:
    def test_returns_prometheus_text(self, app_client: TestClient) -> None:
        r = app_client.get("/metrics")
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/plain")
        # Required counter names from the Vocence pod spec.
        body = r.text
        assert "asr_requests_total" in body
        assert "asr_duration_ms_sum" in body
        assert "asr_duration_ms_count" in body
        assert "asr_inflight" in body


class TestAuth:
    def test_batch_requires_api_key(self, app_client: TestClient) -> None:
        r = app_client.post(
            "/v1/turn-detector/batch",
            json={"in_progress": "hello"},
        )
        assert r.status_code == 401
        assert r.json() == {"detail": {"error": "unauthorized"}}

    def test_batch_with_correct_key_works(self, app_client: TestClient) -> None:
        r = app_client.post(
            "/v1/turn-detector/batch",
            headers={"X-API-Key": "test-suite-key"},
            json={"in_progress": "hello"},
        )
        assert r.status_code == 200
        body = r.json()
        assert "p_end_of_turn" in body
        assert 0.0 <= body["p_end_of_turn"] <= 1.0
        assert body["tokens_seen"] > 0

    def test_batch_with_wrong_key_rejected(self, app_client: TestClient) -> None:
        r = app_client.post(
            "/v1/turn-detector/batch",
            headers={"X-API-Key": "wrong-key"},
            json={"in_progress": "hello"},
        )
        assert r.status_code == 401


class TestTurnDetectorBatch:
    HEADERS = {"X-API-Key": "test-suite-key"}

    def test_complete_utterance_scores_high(self, app_client: TestClient) -> None:
        """A clearly-finished short utterance should score above the
        typical mid-sentence baseline."""
        r = app_client.post(
            "/v1/turn-detector/batch",
            headers=self.HEADERS,
            json={"in_progress": "hello"},
        )
        assert r.status_code == 200
        # Empirically, "hello" alone scores ~0.97 — well above 0.5
        assert r.json()["p_end_of_turn"] > 0.5

    def test_mid_sentence_scores_low(self, app_client: TestClient) -> None:
        """An incomplete fragment should clearly NOT cross the fire
        threshold."""
        r = app_client.post(
            "/v1/turn-detector/batch",
            headers=self.HEADERS,
            json={"in_progress": "what time does"},
        )
        assert r.status_code == 200
        assert r.json()["p_end_of_turn"] < 0.3

    def test_empty_in_progress_rejected(self, app_client: TestClient) -> None:
        r = app_client.post(
            "/v1/turn-detector/batch",
            headers=self.HEADERS,
            json={"in_progress": "   "},
        )
        assert r.status_code == 400

    def test_history_is_optional(self, app_client: TestClient) -> None:
        """No history field at all should still work — defaults to []."""
        r = app_client.post(
            "/v1/turn-detector/batch",
            headers=self.HEADERS,
            json={"in_progress": "thanks"},
        )
        assert r.status_code == 200


class TestSmartTurnBatch:
    HEADERS = {"X-API-Key": "test-suite-key"}

    def test_rejects_wrong_sample_rate_wav(
        self, app_client: TestClient, tmp_path
    ) -> None:
        """A WAV at the wrong sample rate should 400, not silently
        produce a wrong score."""
        import wave

        wav_path = tmp_path / "wrong_sr.wav"
        with wave.open(str(wav_path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(8000)  # NOT 16000
            wf.writeframes(b"\x00\x00" * 8000)  # 1 s of silence

        with open(wav_path, "rb") as fh:
            r = app_client.post(
                "/v1/smart-turn/batch",
                headers=self.HEADERS,
                files={"audio": ("wrong.wav", fh, "audio/wav")},
            )
        assert r.status_code == 400
        # Specifically about sample rate, not a generic 400
        assert "sample rate" in str(r.json())

    def test_rejects_stereo_wav(self, app_client: TestClient, tmp_path) -> None:
        import wave

        wav_path = tmp_path / "stereo.wav"
        with wave.open(str(wav_path), "wb") as wf:
            wf.setnchannels(2)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            wf.writeframes(b"\x00\x00\x00\x00" * 16000)
        with open(wav_path, "rb") as fh:
            r = app_client.post(
                "/v1/smart-turn/batch",
                headers=self.HEADERS,
                files={"audio": ("stereo.wav", fh, "audio/wav")},
            )
        assert r.status_code == 400
        assert "mono" in str(r.json())

    def test_valid_mono_16k_wav_works(
        self, app_client: TestClient, tmp_path
    ) -> None:
        """A correctly-formed silent WAV should produce a probability
        in [0, 1] and not crash."""
        import wave
        import numpy as np

        # 2 seconds of pure silence
        wav_path = tmp_path / "silence.wav"
        with wave.open(str(wav_path), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            samples = np.zeros(16000 * 2, dtype="<i2").tobytes()
            wf.writeframes(samples)

        with open(wav_path, "rb") as fh:
            r = app_client.post(
                "/v1/smart-turn/batch",
                headers=self.HEADERS,
                files={"audio": ("silence.wav", fh, "audio/wav")},
            )
        assert r.status_code == 200
        body = r.json()
        assert 0.0 <= body["p_end_of_turn"] <= 1.0
        assert body["audio_ms"] == 2000
        assert body["inference_ms"] >= 0
