"""Public developer-API surface for per-agent knowledge ingestion.

The dashboard-backend's ``routers/agent_knowledge`` module owns the
authoritative implementation — these endpoints just forward to it
with the caller's internal-trust headers attached, after applying
the standard developer-api gates (Premium + per-user rate limit) and
recording an audit row so the user sees the request in their billing
dashboard.

Gate pattern matches the rest of the dev-api:

* Read endpoints (`sources`, `jobs/{id}`): authenticated only, no
  gate / no audit — they're cheap and read-only.
* Mutating endpoints (`ingest/*`, `delete_source`): full
  :func:`gate_request` (Premium re-check + RPM) + :func:`log_audit`.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from app.core.auth import require_api_key
from app.core.config import API_KNOWLEDGE_PDF_CREDITS
from app.services.dashboard_proxy import call_dashboard
from app.services.gating import (
    charge_credits,
    gate_request,
    log_audit,
    refund_credits,
)


_log = logging.getLogger(__name__)
router = APIRouter()


_AGENT_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{8,64}$")
# Ingest jobs + sources use the same id shape (uuid hex / short slug).
# Keep them as separate constants so a future format change for one
# doesn't accidentally loosen the other.
_SOURCE_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{8,64}$")
_JOB_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{8,64}$")


def _validate_agent_id(agent_id: str) -> None:
    """Reject obviously-malformed agent ids before paying the upstream
    round-trip. The dashboard ALSO validates — this is a fast-fail."""
    if not _AGENT_ID_RE.match(agent_id):
        raise HTTPException(status_code=400, detail={"error": "malformed agent_id"})


def _validate_source_id(source_id: str) -> None:
    if not _SOURCE_ID_RE.match(source_id):
        raise HTTPException(status_code=400, detail={"error": "malformed source_id"})


def _validate_job_id(job_id: str) -> None:
    if not _JOB_ID_RE.match(job_id):
        raise HTTPException(status_code=400, detail={"error": "malformed job_id"})


def _validate_ingest_url(url: str) -> None:
    """SSRF guard. The knowledge crawler runs server-side and would
    happily fetch anything httpx.AsyncClient can dial — including
    cloud metadata endpoints (169.254.169.254), private/internal
    services (10/8, 172.16/12, 192.168/16, 169.254/16, loopback),
    and exotic schemes (file:// gopher:// ftp://). All of those are
    sources for either credential theft (IMDS) or internal-recon
    via the agent's RAG. The backend ALSO validates as defense in
    depth; this is the fail-fast boundary.

    Allows: http:// and https:// on public hostnames + public IPs only.
    """
    import ipaddress
    import socket
    from urllib.parse import urlparse

    try:
        parsed = urlparse(url)
    except Exception:
        raise HTTPException(status_code=400, detail={"error": "malformed url"})

    if parsed.scheme not in ("http", "https"):
        raise HTTPException(
            status_code=400,
            detail={"error": f"url scheme must be http or https, got {parsed.scheme!r}"},
        )
    host = (parsed.hostname or "").strip()
    if not host:
        raise HTTPException(status_code=400, detail={"error": "url missing hostname"})
    # Block literal-IP private/loopback/link-local + cloud metadata.
    # If the host is a name, resolve once and check every A/AAAA result —
    # otherwise an attacker could point a name like ``ssrf.evil.example.com``
    # at 169.254.169.254 to bypass a name-only check.
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        # DNS failure — let the upstream fail naturally with a clearer
        # error. Don't pre-emptively 400 since DNS can be flaky.
        return
    for fam, _stype, _proto, _canon, sockaddr in infos:
        ip_str = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            continue
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            raise HTTPException(
                status_code=400,
                detail={"error": "url resolves to a non-public address (SSRF blocked)"},
            )


async def _gated_dashboard_call(
    *,
    auth_ctx: dict[str, Any],
    endpoint_label: str,
    method: str,
    path: str,
    json: Any | None = None,
    form: dict[str, str] | None = None,
    files: list[tuple[str, bytes, str, str]] | None = None,
) -> dict:
    """Shared envelope for the write endpoints: premium-gate, rate-
    limit, proxy, audit. ALL ingest/delete endpoints route through
    here so the gating logic is impossible to forget on a new route."""
    await gate_request(auth_ctx["user_id"])
    t0 = time.perf_counter()
    try:
        result = await call_dashboard(
            method, path,
            user_id=auth_ctx["user_id"],
            json=json, form=form, files=files,
        )
    except HTTPException as exc:
        await log_audit(
            auth_ctx=auth_ctx, endpoint=endpoint_label,
            http_status=exc.status_code,
            error_message=str(exc.detail)[:200],
            latency_ms=int((time.perf_counter() - t0) * 1000),
        )
        raise
    await log_audit(
        auth_ctx=auth_ctx, endpoint=endpoint_label,
        http_status=200,
        latency_ms=int((time.perf_counter() - t0) * 1000),
    )
    return result


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class IngestTextRequest(BaseModel):
    """Ingest a plain-text or markdown blob into the agent's knowledge."""

    title: Optional[str] = Field(
        default=None,
        max_length=200,
        description="Optional human-readable label for this source.",
    )
    content: str = Field(
        ...,
        min_length=1,
        description="The raw text or markdown to index. Up to ~500k chars.",
    )


class IngestUrlRequest(BaseModel):
    """Ingest a single page (or one page + one hop of internal links)."""

    url: str = Field(
        ...,
        min_length=4,
        max_length=2048,
        description="The page URL to fetch and index.",
    )
    title: Optional[str] = Field(default=None, max_length=200)
    max_depth: int = Field(
        default=0,
        ge=0,
        le=1,
        description="0 = the page only. 1 = page + same-origin links it directly references.",
    )


class IngestSitemapRequest(BaseModel):
    """Ingest a sitemap.xml — every URL in it (subject to filters)."""

    url: str = Field(
        ...,
        min_length=4,
        max_length=2048,
        description="URL of a sitemap.xml or sitemap index.",
    )
    title: Optional[str] = Field(default=None, max_length=200)
    include: Optional[list[str]] = Field(
        default=None,
        description="Regex include filters applied to each URL in the sitemap.",
    )
    exclude: Optional[list[str]] = Field(
        default=None,
        description="Regex exclude filters applied to each URL in the sitemap.",
    )
    max_pages: int = Field(
        default=500,
        ge=1,
        le=5000,
        description="Safety cap on total pages to crawl from the sitemap.",
    )


# ---------------------------------------------------------------------------
# Read endpoints — auth-only, no gate (matches dev-api CRUD pattern)
# ---------------------------------------------------------------------------

@router.get(
    "/v1/agents/{agent_id}/knowledge/sources",
    tags=["Knowledge"],
    summary="List ingested knowledge sources for an agent",
)
async def list_sources(
    agent_id: str,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    _validate_agent_id(agent_id)
    return await call_dashboard(
        "GET",
        f"/api/dashboard/agents/{agent_id}/knowledge/sources",
        user_id=auth_ctx["user_id"],
    )


@router.get(
    "/v1/agents/{agent_id}/knowledge/jobs/{job_id}",
    tags=["Knowledge"],
    summary="Poll an in-progress ingest job",
)
async def get_job(
    agent_id: str,
    job_id: str,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Status / progress for a long-running ingest job (URL crawl,
    sitemap, PDF). Poll every few seconds until ``status`` is
    ``done`` or ``failed``."""
    _validate_agent_id(agent_id)
    _validate_job_id(job_id)
    return await call_dashboard(
        "GET",
        f"/api/dashboard/agents/{agent_id}/knowledge/jobs/{job_id}",
        user_id=auth_ctx["user_id"],
    )


# ---------------------------------------------------------------------------
# Mutating endpoints — gated + audited
# ---------------------------------------------------------------------------

@router.delete(
    "/v1/agents/{agent_id}/knowledge/sources/{source_id}",
    tags=["Knowledge"],
    summary="Remove an ingested source from an agent's knowledge",
)
async def delete_source(
    agent_id: str,
    source_id: str,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    _validate_agent_id(agent_id)
    _validate_source_id(source_id)
    return await _gated_dashboard_call(
        auth_ctx=auth_ctx, endpoint_label="knowledge.delete_source",
        method="DELETE",
        path=f"/api/dashboard/agents/{agent_id}/knowledge/sources/{source_id}",
    )


@router.post(
    "/v1/agents/{agent_id}/knowledge/ingest/text",
    tags=["Knowledge"],
    summary="Ingest a plain-text blob into the agent's knowledge",
)
async def ingest_text(
    agent_id: str,
    body: IngestTextRequest,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    _validate_agent_id(agent_id)
    return await _gated_dashboard_call(
        auth_ctx=auth_ctx, endpoint_label="knowledge.ingest.text",
        method="POST",
        path=f"/api/dashboard/agents/{agent_id}/knowledge/ingest/text",
        json=body.model_dump(exclude_none=True),
    )


@router.post(
    "/v1/agents/{agent_id}/knowledge/ingest/markdown",
    tags=["Knowledge"],
    summary="Ingest a markdown blob (preserves structure for retrieval)",
)
async def ingest_markdown(
    agent_id: str,
    body: IngestTextRequest,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    _validate_agent_id(agent_id)
    return await _gated_dashboard_call(
        auth_ctx=auth_ctx, endpoint_label="knowledge.ingest.markdown",
        method="POST",
        path=f"/api/dashboard/agents/{agent_id}/knowledge/ingest/markdown",
        json=body.model_dump(exclude_none=True),
    )


@router.post(
    "/v1/agents/{agent_id}/knowledge/ingest/url",
    tags=["Knowledge"],
    summary="Fetch and ingest a web page (optionally one link-hop)",
)
async def ingest_url(
    agent_id: str,
    body: IngestUrlRequest,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    _validate_agent_id(agent_id)
    _validate_ingest_url(body.url)
    return await _gated_dashboard_call(
        auth_ctx=auth_ctx, endpoint_label="knowledge.ingest.url",
        method="POST",
        path=f"/api/dashboard/agents/{agent_id}/knowledge/ingest/url",
        json=body.model_dump(exclude_none=True),
    )


@router.post(
    "/v1/agents/{agent_id}/knowledge/ingest/sitemap",
    tags=["Knowledge"],
    summary="Crawl a sitemap.xml and ingest every page (capped at 5000)",
)
async def ingest_sitemap(
    agent_id: str,
    body: IngestSitemapRequest,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    _validate_agent_id(agent_id)
    _validate_ingest_url(body.url)
    return await _gated_dashboard_call(
        auth_ctx=auth_ctx, endpoint_label="knowledge.ingest.sitemap",
        method="POST",
        path=f"/api/dashboard/agents/{agent_id}/knowledge/ingest/sitemap",
        json=body.model_dump(exclude_none=True),
    )


# Public docs surface this number to API users. Keep in lockstep with
# ``dashboard-backend/routers/agent_knowledge._MAX_PDF_UPLOAD_BYTES``.
PDF_UPLOAD_MAX_BYTES = 50 * 1024 * 1024


@router.post(
    "/v1/agents/{agent_id}/knowledge/ingest/pdf",
    tags=["Knowledge"],
    summary="Upload a PDF (≤ 50 MB) for OCR/parse and ingest",
)
async def ingest_pdf(
    agent_id: str,
    file: UploadFile = File(..., description="PDF file (≤ 50 MB)."),
    title: Optional[str] = Form(default=None, max_length=200),
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    _validate_agent_id(agent_id)
    # Bounded read identical to the dashboard's defence: pull cap+1
    # bytes to detect oversize without buffering a multi-GB upload.
    # NOTE: we do this check BEFORE gate_request so an oversize upload
    # doesn't burn the user's rate-limit quota.
    declared = getattr(file, "size", None)
    if isinstance(declared, int) and declared > PDF_UPLOAD_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail={"error": f"PDF exceeds {PDF_UPLOAD_MAX_BYTES // (1024 * 1024)} MB limit"},
        )
    content = await file.read(PDF_UPLOAD_MAX_BYTES + 1)
    if not content:
        raise HTTPException(status_code=400, detail={"error": "empty file"})
    if len(content) > PDF_UPLOAD_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail={"error": f"PDF exceeds {PDF_UPLOAD_MAX_BYTES // (1024 * 1024)} MB limit"},
        )
    form: dict[str, str] = {}
    if title:
        form["title"] = title

    # Apply the same gate as the other write endpoints before charging.
    await gate_request(auth_ctx["user_id"])

    # 20 cr per PDF — covers OCR + embedding GPU time downstream. Charged
    # UP-FRONT (not on success) so the user can't get free indexing by
    # cancelling the request mid-flight after the pod has done the work.
    # If the dashboard call subsequently fails we refund the same amount
    # so users only pay for completed ingests.
    cost = API_KNOWLEDGE_PDF_CREDITS
    new_balance = await charge_credits(
        auth_ctx["user_id"], cost,
        label="knowledge PDF ingest",
        transaction_type="knowledge_ingest_pdf",
    )

    import time as _t
    t0 = _t.perf_counter()
    try:
        result = await call_dashboard(
            "POST",
            f"/api/dashboard/agents/{agent_id}/knowledge/ingest/pdf",
            user_id=auth_ctx["user_id"],
            form=form or None,
            files=[("file", content, file.filename or "document.pdf", "application/pdf")],
        )
    except HTTPException as exc:
        # Upstream failed → return the credits we just deducted. The
        # audit row records the failure so the user sees BOTH the
        # charge and the refund in their billing history (net = 0).
        await refund_credits(
            auth_ctx["user_id"], cost,
            label="knowledge PDF ingest",
            transaction_type="knowledge_ingest_pdf_refund",
        )
        await log_audit(
            auth_ctx=auth_ctx, endpoint="knowledge.ingest.pdf",
            http_status=exc.status_code,
            error_message=str(exc.detail)[:200],
            latency_ms=int((_t.perf_counter() - t0) * 1000),
        )
        raise

    # Surface the charge in the response so SDK callers can show "PDF
    # indexed · 20 credits · 12,450 cr remaining" without an extra
    # account.get() round-trip.
    if new_balance >= 0:
        result.setdefault("credits_used", cost)
        result.setdefault("credits_remaining", new_balance)
    await log_audit(
        auth_ctx=auth_ctx, endpoint="knowledge.ingest.pdf",
        http_status=200,
        latency_ms=int((_t.perf_counter() - t0) * 1000),
    )
    return result
