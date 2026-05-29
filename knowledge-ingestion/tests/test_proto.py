"""Request-schema validation tests."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from knowledge_ingestion.proto import (
    IngestSitemapRequest,
    IngestTextRequest,
    IngestUrlRequest,
    QueryRequest,
)


class TestIngestUrlRequest:
    def test_minimal(self) -> None:
        req = IngestUrlRequest(
            source_type="url", agent_id="ag_a", url="https://example.com",
        )
        assert req.max_depth == 0
        assert req.title is None

    def test_depth_capped(self) -> None:
        with pytest.raises(ValidationError):
            IngestUrlRequest(
                source_type="url", agent_id="ag_a",
                url="https://example.com", max_depth=2,
            )

    def test_short_url_rejected(self) -> None:
        with pytest.raises(ValidationError):
            IngestUrlRequest(source_type="url", agent_id="ag_a", url="x")


class TestIngestSitemapRequest:
    def test_max_pages_capped(self) -> None:
        with pytest.raises(ValidationError):
            IngestSitemapRequest(
                source_type="sitemap", agent_id="ag_a",
                url="https://example.com/sitemap.xml", max_pages=99999,
            )

    def test_include_exclude_optional(self) -> None:
        req = IngestSitemapRequest(
            source_type="sitemap", agent_id="ag_a",
            url="https://example.com/sitemap.xml",
        )
        assert req.include is None
        assert req.exclude is None


class TestIngestTextRequest:
    def test_empty_content_rejected(self) -> None:
        with pytest.raises(ValidationError):
            IngestTextRequest(source_type="text", agent_id="ag_a", content="")


class TestQueryRequest:
    def test_top_k_defaults(self) -> None:
        req = QueryRequest(agent_id="ag_a", text="hi")
        assert req.top_k == 6
        assert req.min_score == 0.55

    def test_top_k_capped(self) -> None:
        with pytest.raises(ValidationError):
            QueryRequest(agent_id="ag_a", text="hi", top_k=999)

    def test_min_score_in_unit_interval(self) -> None:
        with pytest.raises(ValidationError):
            QueryRequest(agent_id="ag_a", text="hi", min_score=-0.1)
        with pytest.raises(ValidationError):
            QueryRequest(agent_id="ag_a", text="hi", min_score=1.5)

    def test_empty_text_rejected(self) -> None:
        with pytest.raises(ValidationError):
            QueryRequest(agent_id="ag_a", text="")
