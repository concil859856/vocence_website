"""Request / response Pydantic models for the REST API.

These are the wire shapes the dashboard backend sends. Keeping them
strict (Literal source_types, length-validated strings) means a typo
on the calling side surfaces as a clear 422 rather than a silent
mis-route.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


# ---------------------------------------------------------------------------
# Ingest requests
# ---------------------------------------------------------------------------

class IngestUrlRequest(BaseModel):
    source_type: Literal["url"]
    agent_id: str = Field(..., min_length=1, max_length=120)
    url: str = Field(..., min_length=4, max_length=2048)
    title: str | None = Field(default=None, max_length=200)
    # v1: only 0 or 1. >1 returns 400.
    max_depth: int = Field(default=0, ge=0, le=1)


class IngestSitemapRequest(BaseModel):
    source_type: Literal["sitemap"]
    agent_id: str = Field(..., min_length=1, max_length=120)
    url: str = Field(..., min_length=4, max_length=2048)
    title: str | None = Field(default=None, max_length=200)
    include: list[str] | None = None
    exclude: list[str] | None = None
    max_pages: int = Field(default=500, ge=1, le=5000)


class IngestTextRequest(BaseModel):
    source_type: Literal["text"]
    agent_id: str = Field(..., min_length=1, max_length=120)
    title: str | None = Field(default=None, max_length=200)
    content: str = Field(..., min_length=1)


class IngestMarkdownRequest(BaseModel):
    source_type: Literal["markdown"]
    agent_id: str = Field(..., min_length=1, max_length=120)
    title: str | None = Field(default=None, max_length=200)
    content: str = Field(..., min_length=1)


# ---------------------------------------------------------------------------
# Query
# ---------------------------------------------------------------------------

class QueryRequest(BaseModel):
    agent_id: str = Field(..., min_length=1, max_length=120)
    text: str = Field(..., min_length=1, max_length=4000)
    top_k: int = Field(default=6, ge=1, le=50)
    min_score: float = Field(default=0.55, ge=0.0, le=1.0)


# ---------------------------------------------------------------------------
# Responses (used for documentation; we serialise plain dicts in handlers)
# ---------------------------------------------------------------------------

class IngestSyncResponse(BaseModel):
    status: Literal["completed"]
    source_id: str
    chunk_count: int
    tokens_indexed: int


class IngestAsyncResponse(BaseModel):
    status: Literal["pending"]
    job_id: str
    source_id: str


class JobStatusResponse(BaseModel):
    job_id: str
    source_id: str
    agent_id: str
    status: str
    phase: str | None = None
    chunks_so_far: int = 0
    started_at: str | None = None
    finished_at: str | None = None
    error: str | None = None


class ChunkResponse(BaseModel):
    text: str
    score: float
    source_id: str
    source_title: str
    metadata: dict[str, Any]


class QueryResponse(BaseModel):
    chunks: list[ChunkResponse]
    embedding_ms: int
    search_ms: int
    total_ms: int
