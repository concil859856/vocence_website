"""Presigned-URL upload endpoint.

Browsers POST a small JSON describing the file they want to upload and
get back a presigned PUT URL pointing directly at R2. The browser then
PUTs the bytes straight to R2 (``*.r2.cloudflarestorage.com``) — the
transfer never traverses your domain's Cloudflare proxy, so you avoid
the per-request body limits and large-body HTTP/2 stream stalls that
plague big multipart POSTs through the API gateway.

After the upload finishes, the caller submits the job (via /jobs/start
or any other endpoint) using the returned ``bucket`` + ``key``. Workers
fetch the bytes from R2 directly.

One generic endpoint covers every upload feature on the site — music,
playbook audio, voice-clone reference audio, STT source, etc. Each
``kind`` has its own size cap, content-type allowlist, and subdir.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from routers.auth import require_auth
from studio_tts_service import _active_bucket, presigned_put_url


router = APIRouter(prefix="/uploads", tags=["uploads"])


# ---------------------------------------------------------------------------
# Per-kind config. Adding a new upload feature = one line here.
# ---------------------------------------------------------------------------

# Default presigned-URL TTL. Browsers must finish the PUT within this window
# or the upload errors with 403 and the user retries (regenerates URL).
PRESIGN_TTL_SECONDS = int(os.environ.get("UPLOAD_PRESIGN_TTL_SECONDS", "1800"))

# 300 MB by default — generous for full-length music sources or long
# voice recordings. Override per-deployment via env (per-kind overrides
# below also apply).
_DEFAULT_MAX_BYTES = int(os.environ.get("UPLOAD_DEFAULT_MAX_BYTES", str(300 * 1024 * 1024)))

_AUDIO_MIMES = {
    "audio/mpeg", "audio/mp3",
    "audio/wav", "audio/x-wav", "audio/wave",
    "audio/ogg", "audio/opus",
    "audio/webm",
    "audio/flac", "audio/x-flac",
    "audio/mp4", "audio/m4a", "audio/x-m4a", "audio/aac",
    "application/octet-stream",  # browsers sometimes send this for audio
}

# Video dubbing sources. Kept separate from _AUDIO_MIMES so an audio-only
# feature can never be handed a 200 MB video by mistake.
_VIDEO_MIMES = {
    "video/mp4",
    "video/quicktime",       # .mov
    "video/webm",
    "video/x-matroska",      # .mkv
    "video/x-msvideo",       # .avi
    "application/octet-stream",
}

UPLOAD_KINDS: dict[str, dict] = {
    "video-dub-source": {
        "subdir": "video-dub-source",
        # Larger than the audio default: dubbing sources are real video.
        # The per-tier engine caps (and the duration ceiling enforced in
        # video_dub_service) are the binding limits, not this one.
        "max_bytes": int(os.environ.get("UPLOAD_VIDEO_DUB_SOURCE_MAX_BYTES", str(200 * 1024 * 1024))),
        "allowed_mimes": _VIDEO_MIMES,
    },
    "music-source": {
        "subdir": "music-source",
        "max_bytes": int(os.environ.get("UPLOAD_MUSIC_SOURCE_MAX_BYTES", str(_DEFAULT_MAX_BYTES))),
        "allowed_mimes": _AUDIO_MIMES,
    },
    "playbook-audio": {
        "subdir": "playbook",
        "max_bytes": int(os.environ.get("UPLOAD_PLAYBOOK_AUDIO_MAX_BYTES", str(_DEFAULT_MAX_BYTES))),
        "allowed_mimes": _AUDIO_MIMES,
    },
    "voice-clone-ref": {
        "subdir": "voice-clone-ref",
        "max_bytes": int(os.environ.get("UPLOAD_VOICE_CLONE_REF_MAX_BYTES", str(_DEFAULT_MAX_BYTES))),
        "allowed_mimes": _AUDIO_MIMES,
    },
    "stt-source": {
        "subdir": "stt-source",
        "max_bytes": int(os.environ.get("UPLOAD_STT_SOURCE_MAX_BYTES", str(_DEFAULT_MAX_BYTES))),
        "allowed_mimes": _AUDIO_MIMES,
    },
}


# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------


class PresignRequest(BaseModel):
    kind: str = Field(..., description="Upload kind, e.g. 'music-source'")
    filename: str = Field(..., min_length=1, max_length=255)
    content_type: str | None = Field(None, description="MIME type the browser will send")
    size: int = Field(..., ge=1, description="File size in bytes (used to early-reject too-large uploads)")


class PresignResponse(BaseModel):
    put_url: str
    bucket: str
    key: str
    filename: str
    expires_at: str
    max_bytes: int


# ---------------------------------------------------------------------------
# Endpoint
# ---------------------------------------------------------------------------


def _safe_extension(filename: str) -> str:
    name = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
    dot = name.rfind(".")
    if dot < 0 or dot >= len(name) - 1:
        return "bin"
    ext = name[dot + 1:].lower()
    # Keep it simple — only allow plain alphanumerics. Anything weird
    # falls back to ``bin`` so we never write a key with a path-traversal
    # or odd-character extension.
    return "".join(ch for ch in ext if ch.isalnum())[:8] or "bin"


@router.post("/presign", response_model=PresignResponse)
async def presign_upload(
    body: PresignRequest,
    user_id: str = Depends(require_auth),
) -> PresignResponse:
    """Return a presigned PUT URL pointing directly at R2 for the browser
    to upload to. Validates ``kind``, ``size``, and ``content_type`` so we
    never hand out URLs for things we don't intend to accept.
    """
    cfg = UPLOAD_KINDS.get(body.kind)
    if cfg is None:
        raise HTTPException(status_code=400, detail=f"Unknown upload kind: {body.kind!r}")

    if body.size > cfg["max_bytes"]:
        raise HTTPException(
            status_code=413,
            detail=f"File too large for {body.kind}: max {cfg['max_bytes'] // (1024*1024)}MB",
        )

    if body.content_type:
        ct = body.content_type.lower().split(";")[0].strip()
        if ct not in cfg["allowed_mimes"]:
            raise HTTPException(status_code=415, detail=f"Unsupported content type: {body.content_type!r}")

    ext = _safe_extension(body.filename)
    key = f"{user_id}/{cfg['subdir']}/{uuid.uuid4().hex}.{ext}"
    bucket = _active_bucket()

    try:
        url = presigned_put_url(bucket, key, expires_seconds=PRESIGN_TTL_SECONDS)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"Could not generate upload URL: {exc}") from exc

    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=PRESIGN_TTL_SECONDS)).isoformat()
    return PresignResponse(
        put_url=url,
        bucket=bucket,
        key=key,
        filename=body.filename,
        expires_at=expires_at,
        max_bytes=cfg["max_bytes"],
    )
