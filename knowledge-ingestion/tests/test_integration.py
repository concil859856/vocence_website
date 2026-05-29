"""Integration tests against a live FastAPI app + real embedding model
+ a fresh LanceDB store.

The conftest.py sets ``KN_DATA_DIR`` to a temp directory per session
so we never pollute a developer's local store.
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def app_client():
    os.environ.setdefault("KN_LOG_LEVEL", "warning")
    from knowledge_ingestion import server
    with TestClient(server.app) as client:
        yield client


HEADERS = {"X-API-Key": "test-suite-key"}


class TestHealthz:
    def test_status_ok(self, app_client: TestClient) -> None:
        r = app_client.get("/healthz")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["service"] == "knowledge-ingestion"
        assert body["embedding_dim"] == 384
        assert "store" in body
        assert body["store"]["engine"] == "lancedb"


class TestMetrics:
    def test_required_counters_present(self, app_client: TestClient) -> None:
        r = app_client.get("/metrics")
        assert r.status_code == 200
        text = r.text
        for name in (
            "kn_ingest_jobs_total",
            "kn_ingest_chunks_total",
            "kn_query_total",
            "kn_query_duration_ms_sum",
            "kn_query_duration_ms_count",
            "kn_inflight_ingests",
        ):
            assert name in text, f"missing required metric {name}"


class TestAuth:
    def test_query_requires_key(self, app_client: TestClient) -> None:
        r = app_client.post("/v1/query", json={"agent_id": "a", "text": "x"})
        assert r.status_code == 401

    def test_wrong_key_rejected(self, app_client: TestClient) -> None:
        r = app_client.post(
            "/v1/query",
            headers={"X-API-Key": "wrong"},
            json={"agent_id": "a", "text": "x"},
        )
        assert r.status_code == 401


class TestEndToEnd:
    AGENT = "ag_integration_test"

    def test_ingest_text_then_query_returns_match(
        self, app_client: TestClient,
    ) -> None:
        # Ingest two distinct sources
        r1 = app_client.post(
            "/v1/ingest/text", headers=HEADERS,
            json={
                "source_type": "text",
                "agent_id": self.AGENT,
                "title": "Cancel FAQ",
                "content": "To cancel a subscription, visit Account > Subscription > Cancel.",
            },
        )
        assert r1.status_code == 200, r1.text
        assert r1.json()["status"] == "completed"
        assert r1.json()["chunk_count"] == 1

        r2 = app_client.post(
            "/v1/ingest/text", headers=HEADERS,
            json={
                "source_type": "text",
                "agent_id": self.AGENT,
                "title": "Refund Policy",
                "content": "Full refunds are available within 7 days of purchase.",
            },
        )
        assert r2.status_code == 200

        # Query for "how to cancel" should rank the cancellation chunk
        # above the refund chunk.
        r = app_client.post(
            "/v1/query", headers=HEADERS,
            json={
                "agent_id": self.AGENT,
                "text": "how do I cancel my subscription",
                "top_k": 5,
                "min_score": 0.3,
            },
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert len(body["chunks"]) >= 1
        # Best match should be the Cancel FAQ
        assert "cancel" in body["chunks"][0]["text"].lower()
        assert body["chunks"][0]["score"] > 0.5
        # Latency reporting
        assert body["embedding_ms"] >= 0
        assert body["search_ms"] >= 0
        assert body["total_ms"] >= 0

    def test_per_agent_isolation(self, app_client: TestClient) -> None:
        # Query an agent that never ingested anything → empty result
        r = app_client.post(
            "/v1/query", headers=HEADERS,
            json={
                "agent_id": "never_existed",
                "text": "how to cancel",
                "top_k": 5,
                "min_score": 0.1,
            },
        )
        assert r.status_code == 200
        assert r.json()["chunks"] == []

    def test_list_sources(self, app_client: TestClient) -> None:
        r = app_client.get(
            f"/v1/agents/{self.AGENT}/sources", headers=HEADERS,
        )
        assert r.status_code == 200
        sources = r.json()["sources"]
        assert len(sources) >= 2  # ingested in test above

    def test_delete_source_removes_chunks(
        self, app_client: TestClient,
    ) -> None:
        # First create a fresh source we can delete without polluting
        # the other tests.
        r = app_client.post(
            "/v1/ingest/text", headers=HEADERS,
            json={
                "source_type": "text",
                "agent_id": self.AGENT,
                "title": "Throwaway",
                "content": "Ephemeral note, soon to be deleted.",
            },
        )
        sid = r.json()["source_id"]

        # Delete it
        rd = app_client.delete(
            f"/v1/sources/{sid}?agent_id={self.AGENT}", headers=HEADERS,
        )
        assert rd.status_code == 200
        assert rd.json()["deleted"] is True
        assert rd.json()["chunks_removed"] >= 1

        # Sources list should no longer contain it
        r = app_client.get(
            f"/v1/agents/{self.AGENT}/sources", headers=HEADERS,
        )
        ids = [s["source_id"] for s in r.json()["sources"]]
        assert sid not in ids


class TestIngestValidation:
    def test_short_url_rejected(self, app_client: TestClient) -> None:
        r = app_client.post(
            "/v1/ingest/url", headers=HEADERS,
            json={"source_type": "url", "agent_id": "x", "url": "x"},
        )
        assert r.status_code == 422

    def test_depth_2_rejected(self, app_client: TestClient) -> None:
        r = app_client.post(
            "/v1/ingest/url", headers=HEADERS,
            json={
                "source_type": "url", "agent_id": "x",
                "url": "https://example.com", "max_depth": 2,
            },
        )
        assert r.status_code == 422

    def test_query_top_k_capped(self, app_client: TestClient) -> None:
        r = app_client.post(
            "/v1/query", headers=HEADERS,
            json={"agent_id": "x", "text": "hello", "top_k": 9999},
        )
        assert r.status_code == 422
