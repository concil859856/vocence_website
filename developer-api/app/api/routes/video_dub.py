"""Public video-dubbing API (``api.vocence.ai``).

Thin proxy over the dashboard's dubbing pipeline. The dashboard owns pricing,
credit charging, the queue and the upstream calls; this module handles API-key
auth, Premium gating, rate limiting and request logging, then forwards with the
internal-service headers.

Because dubbing is asynchronous, the surface is submit + poll:

    POST /v1/video/dub          → {job_id, credits_charged, ...}
    GET  /v1/video/dub/{id}     → {status, phase, results: [...]}
    GET  /v1/video/dub/languages
    POST /v1/video/dub/quote

Credits are charged inside the dashboard's enqueue (and refunded there on
failure), so this module deliberately does NOT call gating.charge_credits —
doing so would double-bill. It only meters the request for usage reporting.
"""

from __future__ import annotations

import logging
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.auth import require_api_key
from app.db.connection import get_db
from app.services.dashboard_proxy import call_dashboard
from app.services.gating import gate_request
from app.services.usage import log_api_request


_log = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/video", tags=["video"])

# Video renders can take a while upstream; the submit call itself is quick,
# but the dashboard validates and enqueues synchronously.
_SUBMIT_TIMEOUT = 120.0
_POLL_TIMEOUT = 30.0


class DubRequest(BaseModel):
    src_bucket: str = Field(..., description="Bucket returned by /v1/uploads/presign")
    src_key: str = Field(..., description="Object key returned by /v1/uploads/presign")
    src_filename: str = Field("source.mp4", max_length=255)
    duration_sec: float = Field(..., gt=0, description="Source video length in seconds")
    target_languages: list[str] = Field(..., min_length=1, description="ISO codes, e.g. ['ja','es']")
    source_language: str = Field("auto", max_length=16)
    lipsync: bool = Field(False, description="Re-render the speaker's mouth to match the new audio")
    num_speakers: int = Field(1, ge=1, le=8)
    consent_attested: bool = Field(
        False,
        description=(
            "Required. Confirms you hold the rights and consent for every person "
            "appearing or speaking in the uploaded video."
        ),
    )
    callback_url: str = Field(
        "",
        max_length=2000,
        description=(
            "Optional public HTTPS URL we POST once when the job finishes "
            "(event video_dub.completed / video_dub.failed). Best-effort with "
            "retries; poll GET /v1/video/dub/{job_id} as the source of truth."
        ),
    )
    callback_secret: str = Field(
        "",
        max_length=128,
        description=(
            "Optional secret to HMAC-sign the callback (X-Vocence-Signature, "
            "same format as agent webhooks / vocence-sdk webhooks.verify())."
        ),
    )


class QuoteRequest(BaseModel):
    duration_sec: float = Field(..., gt=0)
    target_languages: list[str] = Field(..., min_length=1)
    lipsync: bool = False


@router.get("/dub/languages", summary="List supported dubbing languages")
async def dub_languages(auth=Depends(require_api_key)) -> dict:
    user_id = auth["user_id"]
    await gate_request(user_id)
    return await call_dashboard(
        "GET", "/api/dashboard/video-dub/languages",
        user_id=user_id, timeout_sec=_POLL_TIMEOUT,
    )


@router.post("/dub/quote", summary="Price a dubbing job before submitting it")
async def dub_quote(req: QuoteRequest, auth=Depends(require_api_key)) -> dict:
    user_id = auth["user_id"]
    await gate_request(user_id)
    return await call_dashboard(
        "POST", "/api/dashboard/video-dub/quote",
        user_id=user_id, json=req.model_dump(), timeout_sec=_POLL_TIMEOUT,
    )


@router.post(
    "/dub",
    summary="Dub a video into one or more languages",
    description=(
        "Translate a video into up to 3 languages, keeping the original speaker's voice, "
        "optionally with lip-sync. Async — returns a job_id to poll via GET /v1/video/dub/{job_id}.\n\n"
        "**Pricing** (billed per second, per output language): standard 200 credits/min ($0.50); "
        "lip-sync 800 credits/min ($2.00). Call POST /v1/video/dub/quote for an exact figure. "
        "Limits: 10 min, 200 MB (100 MB with lip-sync), ≤3 languages. Requires consent_attested=true."
    ),
)
async def create_dub(req: DubRequest, auth=Depends(require_api_key)) -> dict:
    user_id = auth["user_id"]
    await gate_request(user_id)

    if not req.consent_attested:
        raise HTTPException(
            status_code=400,
            detail=(
                "consent_attested must be true. You must confirm you hold the rights "
                "and consent for every person appearing in the uploaded video."
            ),
        )

    started = time.perf_counter()
    result = await call_dashboard(
        "POST", "/api/dashboard/video-dub/start",
        user_id=user_id, json=req.model_dump(), timeout_sec=_SUBMIT_TIMEOUT,
    )

    # Credits were charged by the dashboard's enqueue — meter only.
    try:
        conn = await get_db()
        try:
            await log_api_request(
                conn,
                request_id=uuid.uuid4().hex,
                user_id=user_id,
                api_key_id=auth["api_key_id"],
                endpoint="/v1/video/dub",
                provider="video_dub",
                status="ok",
                http_status=200,
                credits_used=int(result.get("credits_charged") or 0),
                request_chars=0,
                latency_ms=int((time.perf_counter() - started) * 1000),
            )
            await conn.commit()
        finally:
            await conn.close()
    except Exception:
        _log.warning("[video_dub] usage logging failed for user=%s", user_id, exc_info=True)

    return result


@router.get("/dub/{job_id}", summary="Check the status of a dubbing job")
async def get_dub(job_id: str, auth=Depends(require_api_key)) -> dict:
    user_id = auth["user_id"]
    await gate_request(user_id)
    # The shared jobs endpoint scopes by user, so a foreign job id 404s there.
    return await call_dashboard(
        "GET", f"/api/dashboard/jobs/{job_id}",
        user_id=user_id, timeout_sec=_POLL_TIMEOUT,
    )
