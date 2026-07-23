"""Public upload presigning (``api.vocence.ai``).

Async media endpoints (video dubbing today) take an object reference —
``src_bucket``/``src_key`` — rather than raw bytes, so large files go straight
to object storage instead of through two proxy hops. This route hands out the
presigned PUT URL that makes that possible:

    POST /v1/uploads/presign  → {put_url, bucket, key, ...}
    PUT  <put_url>            → (client uploads the file directly)
    POST /v1/video/dub        → {src_bucket, src_key, ...}

The dashboard owns kind validation, size caps, MIME allow-lists and key
layout; this module handles API-key auth and rate limiting, then forwards.
Only kinds that a public /v1 endpoint actually consumes are exposed.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.auth import require_api_key
from app.services.dashboard_proxy import call_dashboard
from app.services.gating import gate_request


_log = logging.getLogger(__name__)

router = APIRouter(prefix="/v1/uploads", tags=["Uploads"])

# Kinds with a public consumer endpoint. The dashboard knows more kinds
# (music, playbooks) but nothing on /v1 accepts those references, so handing
# out URLs for them would only create orphaned objects.
_PUBLIC_KINDS = {"video-dub-source"}

_PRESIGN_TIMEOUT = 30.0


class PresignRequest(BaseModel):
    kind: str = Field(..., description="What the upload is for. Currently: 'video-dub-source'.")
    filename: str = Field(..., min_length=1, max_length=255)
    content_type: str | None = Field(None, description="MIME type you will send in the PUT")
    size: int = Field(..., ge=1, description="File size in bytes")


@router.post(
    "/presign",
    summary="Get a presigned PUT URL for a media upload",
    description=(
        "Returns a short-lived URL to upload a file directly to storage, plus the "
        "`bucket`/`key` pair to reference it from other endpoints (e.g. POST /v1/video/dub). "
        "Upload with a plain HTTP PUT of the raw bytes."
    ),
)
async def presign_upload(req: PresignRequest, auth=Depends(require_api_key)) -> dict:
    user_id = auth["user_id"]
    await gate_request(user_id)

    if req.kind not in _PUBLIC_KINDS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown upload kind: {req.kind!r}. Supported: {sorted(_PUBLIC_KINDS)}",
        )

    return await call_dashboard(
        "POST", "/api/dashboard/uploads/presign",
        user_id=user_id, json=req.model_dump(), timeout_sec=_PRESIGN_TIMEOUT,
    )
