"""Studio-facing API for managing agents' external knowledge sources.

The Studio agent-settings UI uploads PDFs, URLs, sitemaps, etc. through
this router; we proxy each call to the ``vocence/knowledge-ingestion``
pod with the dashboard's shared API key. The dashboard user never sees
the pod URL — they authenticate against the dashboard's normal JWT.

All endpoints require the requesting JWT to OWN the agent. We re-check
ownership on every call to defend against IDOR — a user can't list or
mutate another user's agent's sources just by guessing the agent_id.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

import knowledge_client
from local_db import get_connection
from routers.auth import require_auth


_log = logging.getLogger(__name__)
router = APIRouter(prefix="/agents/{agent_id}/knowledge", tags=["agent-knowledge"])


async def _require_agent_owner(agent_id: str, user_id: str) -> dict[str, Any]:
    """Look up the agent and verify the JWT's ``user_id`` owns it.
    Raises 404 (NOT 403) for someone-else's-agent so we don't leak
    "this id exists but isn't yours" — same IDOR defense pattern the
    rest of the dashboard uses."""
    conn = await get_connection()
    try:
        cur = await conn.execute(
            "SELECT id, user_id, name FROM agents WHERE id = ?", (agent_id,),
        )
        row = await cur.fetchone()
    finally:
        await conn.close()
    if row is None or row["user_id"] != user_id:
        raise HTTPException(status_code=404, detail={"error": "agent not found"})
    return {"id": row["id"], "user_id": row["user_id"], "name": row["name"]}


def _ensure_kn_available() -> None:
    """Bail with a clear 503 when the knowledge-ingestion pod isn't
    configured. The Studio UI hides the knowledge tab in this case but
    a direct API caller might still hit us."""
    if not knowledge_client.is_configured():
        raise HTTPException(
            status_code=503,
            detail={
                "error": "knowledge_unconfigured",
                "message": "External knowledge ingestion is not configured on this deployment.",
            },
        )


# ---------------------------------------------------------------------------
# List + delete + job-status — used by the UI to render attached sources
# ---------------------------------------------------------------------------

@router.get("/sources")
async def list_sources(agent_id: str, user_id: str = Depends(require_auth)) -> dict:
    """List ingested knowledge sources for one agent. When the
    knowledge ingestion pod isn't configured on this deployment we
    return an EMPTY LIST (200) rather than 503. Reasons:

    1. The UI polls this endpoint on every settings page open, so
       a 503 floods the error log with the same line per render
       (visible in the user's deployment log spam).
    2. "Feature not configured" and "configured but the user has
       no sources yet" produce the same UX — empty section. The
       UI shouldn't have to special-case the 503.

    Mutating endpoints (ingest_*, delete_source) still 503 so the
    user gets a clear error if they actually try to USE the
    feature when it's unconfigured.
    """
    await _require_agent_owner(agent_id, user_id)
    if not knowledge_client.is_configured():
        return {"sources": []}
    try:
        return await knowledge_client.list_sources(agent_id)
    except Exception as exc:  # noqa: BLE001
        _log.warning("list sources failed for %s: %s", agent_id, exc)
        raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc


@router.delete("/sources/{source_id}")
async def delete_source(
    agent_id: str, source_id: str,
    user_id: str = Depends(require_auth),
) -> dict:
    await _require_agent_owner(agent_id, user_id)
    _ensure_kn_available()
    try:
        return await knowledge_client.delete_source(agent_id, source_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc


@router.get("/jobs/{job_id}")
async def get_job(
    agent_id: str, job_id: str,
    user_id: str = Depends(require_auth),
) -> dict:
    """Poll for ingest job progress. We check agent ownership; the
    knowledge pod itself doesn't enforce per-agent-per-user gating
    because the dashboard-backend is the only client it trusts."""
    await _require_agent_owner(agent_id, user_id)
    _ensure_kn_available()
    try:
        return await knowledge_client.get_job(job_id)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc


# ---------------------------------------------------------------------------
# Ingest endpoints
# ---------------------------------------------------------------------------

from agent_limits import (
    INGEST_TEXT_MAX_CHARS,
    INGEST_TITLE_MAX_CHARS,
    INGEST_URL_MAX_CHARS,
)


class IngestTextBody(BaseModel):
    title: str | None = Field(default=None, max_length=INGEST_TITLE_MAX_CHARS)
    # Per-call ceiling on raw text. Above this users should split into
    # multiple ingestions or use the URL/sitemap path. The RAG index has
    # no total-corpus cap so multi-ingest stacks fine; this is just to
    # prevent a single API call from OOMing the chunker.
    content: str = Field(..., min_length=1, max_length=INGEST_TEXT_MAX_CHARS)


class IngestUrlBody(BaseModel):
    url: str = Field(..., min_length=4, max_length=INGEST_URL_MAX_CHARS)
    title: str | None = Field(default=None, max_length=INGEST_TITLE_MAX_CHARS)
    max_depth: int = Field(default=0, ge=0, le=1)


class IngestSitemapBody(BaseModel):
    url: str = Field(..., min_length=4, max_length=INGEST_URL_MAX_CHARS)
    title: str | None = Field(default=None, max_length=INGEST_TITLE_MAX_CHARS)
    include: list[str] | None = None
    exclude: list[str] | None = None
    max_pages: int = Field(default=500, ge=1, le=5000)


@router.post("/ingest/text")
async def ingest_text(
    agent_id: str, body: IngestTextBody,
    user_id: str = Depends(require_auth),
) -> dict:
    await _require_agent_owner(agent_id, user_id)
    _ensure_kn_available()
    try:
        return await knowledge_client.ingest_text(
            agent_id, content=body.content, title=body.title,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc


@router.post("/ingest/markdown")
async def ingest_markdown(
    agent_id: str, body: IngestTextBody,
    user_id: str = Depends(require_auth),
) -> dict:
    await _require_agent_owner(agent_id, user_id)
    _ensure_kn_available()
    try:
        return await knowledge_client.ingest_markdown(
            agent_id, content=body.content, title=body.title,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc


@router.post("/ingest/url")
async def ingest_url(
    agent_id: str, body: IngestUrlBody,
    user_id: str = Depends(require_auth),
) -> dict:
    await _require_agent_owner(agent_id, user_id)
    _ensure_kn_available()
    try:
        return await knowledge_client.ingest_url(
            agent_id, url=body.url, title=body.title, max_depth=body.max_depth,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc


@router.post("/ingest/sitemap")
async def ingest_sitemap(
    agent_id: str, body: IngestSitemapBody,
    user_id: str = Depends(require_auth),
) -> dict:
    await _require_agent_owner(agent_id, user_id)
    _ensure_kn_available()
    try:
        return await knowledge_client.ingest_sitemap(
            agent_id,
            url=body.url, title=body.title,
            include=body.include, exclude=body.exclude,
            max_pages=body.max_pages,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc


# Hard ceiling on a single PDF upload. The knowledge pod's downstream
# limits are stricter; this is the dashboard's first line of defense
# against a signed-in user OOM'ing this process with a multi-GB PDF.
_MAX_PDF_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB


@router.post("/ingest/pdf")
async def ingest_pdf(
    agent_id: str,
    file: UploadFile = File(...),
    title: str | None = Form(default=None),
    user_id: str = Depends(require_auth),
) -> dict:
    await _require_agent_owner(agent_id, user_id)
    _ensure_kn_available()
    # Cheap pre-check from the multipart header before we buffer
    # anything. Catches the common case of an oversize upload without
    # paying the cost of reading it.
    declared = getattr(file, "size", None)
    if isinstance(declared, int) and declared > _MAX_PDF_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail={"error": f"PDF exceeds {_MAX_PDF_UPLOAD_BYTES // (1024 * 1024)} MB limit"},
        )
    # Bounded read: pull at most cap+1 bytes; if we see cap+1 the file
    # is definitely too big. This avoids loading a multi-GB upload
    # entirely into memory when the client lies about Content-Length.
    content = await file.read(_MAX_PDF_UPLOAD_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail={"error": "empty file"})
    if len(content) > _MAX_PDF_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail={"error": f"PDF exceeds {_MAX_PDF_UPLOAD_BYTES // (1024 * 1024)} MB limit"},
        )
    try:
        return await knowledge_client.ingest_pdf(
            agent_id,
            file_bytes=content,
            filename=file.filename or "document.pdf",
            title=title,
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={"error": str(exc)}) from exc
