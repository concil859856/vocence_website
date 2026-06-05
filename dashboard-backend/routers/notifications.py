"""In-product notifications.

Read-state is tracked per row (one row per recipient even for
broadcasts) so the unread count is a cheap ``COUNT(*)`` and admins can
target arbitrary subsets without a separate join table.

Endpoints:
  * GET  /notifications               , list the caller's notifications (paginated)
  * GET  /notifications/unread-count  , quick unread count for the bell badge
  * POST /notifications/{id}/read     , mark one read
  * POST /notifications/read-all      , mark all read
  * POST /admin/notifications/send    , admin compose + broadcast/target

The admin send endpoint accepts either:
  * ``audience=all``                , every auth_users row
  * ``audience=user_ids``           , explicit list
  * ``audience=premium``            , every paid plan
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta, timezone
from io import BytesIO
from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from local_db import get_connection
from routers.auth import require_auth, require_admin_session


# Image-upload limits for the admin composer. Mirrors what the blog
# editor accepts, same MinIO/R2 bucket, same encoding pipeline.
MAX_IMAGE_BYTES = 4 * 1024 * 1024
IMAGE_TARGET_PX = 1200  # downscale the long edge to this; preserves aspect ratio
ALLOWED_IMAGE_MIMES = {"image/jpeg", "image/png", "image/webp", "image/gif"}


_log = logging.getLogger(__name__)


MAX_TITLE_CHARS = 120
MAX_BODY_CHARS = 1000
MAX_LINK_CHARS = 500
DEFAULT_PAGE_SIZE = 30
MAX_PAGE_SIZE = 100

_NOTIFICATION_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{8,64}$")


router = APIRouter(prefix="/notifications", tags=["notifications"])
admin_router = APIRouter(prefix="/admin/notifications", tags=["admin-notifications"])


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class NotificationOut(BaseModel):
    id: str
    kind: str
    title: str
    body: str
    link: str | None
    image_url: str | None
    sender: str | None
    read: bool
    created_at: str


class ListResponse(BaseModel):
    notifications: list[NotificationOut]
    unread_count: int
    has_more: bool


class UnreadCountResponse(BaseModel):
    unread_count: int


class AdminSendBody(BaseModel):
    title: str = Field(..., min_length=1, max_length=MAX_TITLE_CHARS)
    body: str = Field(default="", max_length=MAX_BODY_CHARS)
    link: str | None = Field(default=None, max_length=MAX_LINK_CHARS)
    image_url: str | None = Field(default=None, max_length=MAX_LINK_CHARS)
    audience: Literal["all", "user_ids", "premium"] = "all"
    user_ids: list[str] = Field(default_factory=list)
    kind: str = "admin_announcement"


class AdminSendResponse(BaseModel):
    sent: int


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _row_to_out(row: dict) -> NotificationOut:
    # ``image_url`` was added after the initial schema ship, sqlite
    # Row.get() doesn't exist, so we tolerate the key being absent
    # for callers that don't select it.
    try:
        image_url = row["image_url"]
    except (KeyError, IndexError):
        image_url = None
    return NotificationOut(
        id=row["id"],
        kind=row["kind"],
        title=row["title"],
        body=row["body"] or "",
        link=row["link"],
        image_url=image_url,
        sender=row["sender"],
        read=row["read_at"] is not None,
        created_at=row["created_at"],
    )


def _validate_id(nid: str) -> str:
    if not _NOTIFICATION_ID_RE.match(nid or ""):
        raise HTTPException(status_code=400, detail="invalid notification id")
    return nid


# ---------------------------------------------------------------------------
# User endpoints
# ---------------------------------------------------------------------------

@router.get("", response_model=ListResponse)
async def list_notifications(
    limit: int = DEFAULT_PAGE_SIZE,
    offset: int = 0,
    user_id: str = Depends(require_auth),
) -> ListResponse:
    limit = max(1, min(MAX_PAGE_SIZE, int(limit)))
    offset = max(0, int(offset))
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            """
            SELECT * FROM notifications
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
            """,
            (user_id, limit + 1, offset),  # +1 to detect has_more
        )).fetchall()
        unread = await (await conn.execute(
            "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL",
            (user_id,),
        )).fetchone()
    finally:
        await conn.close()
    has_more = len(rows) > limit
    page = rows[:limit]
    return ListResponse(
        notifications=[_row_to_out(dict(r)) for r in page],
        unread_count=int(unread["n"] or 0) if unread else 0,
        has_more=has_more,
    )


@router.get("/unread-count", response_model=UnreadCountResponse)
async def unread_count(user_id: str = Depends(require_auth)) -> UnreadCountResponse:
    """Cheap dedicated endpoint for the bell badge, one COUNT(*),
    indexed. Frontend polls this every 30 minutes."""
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL",
            (user_id,),
        )).fetchone()
    finally:
        await conn.close()
    return UnreadCountResponse(unread_count=int(row["n"] or 0) if row else 0)


@router.post("/{notification_id}/read")
async def mark_read(
    notification_id: str,
    user_id: str = Depends(require_auth),
) -> dict:
    nid = _validate_id(notification_id)
    conn = await get_connection()
    try:
        cur = await conn.execute(
            """
            UPDATE notifications SET read_at = datetime('now')
            WHERE id = ? AND user_id = ? AND read_at IS NULL
            """,
            (nid, user_id),
        )
        await conn.commit()
        return {"ok": True, "updated": cur.rowcount}
    finally:
        await conn.close()


@router.post("/read-all")
async def mark_all_read(user_id: str = Depends(require_auth)) -> dict:
    conn = await get_connection()
    try:
        cur = await conn.execute(
            "UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL",
            (user_id,),
        )
        await conn.commit()
        return {"ok": True, "updated": cur.rowcount}
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Admin endpoints
# ---------------------------------------------------------------------------

@admin_router.post("/upload-image")
async def admin_upload_image(
    image: UploadFile = File(...),
    _: str = Depends(require_admin_session),
) -> dict:
    """Upload an image for use as a notification banner. Re-encodes to
    WebP (long-edge max ``IMAGE_TARGET_PX``) and stores in the same
    object-storage bucket the blog covers use. Returns a publicly-
    readable URL the admin can drop straight into the ``image_url``
    field of an ``admin_send`` payload."""
    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty image")
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"image exceeds {MAX_IMAGE_BYTES // (1024*1024)}MB",
        )
    mime = (image.content_type or "").lower()
    if mime not in ALLOWED_IMAGE_MIMES:
        raise HTTPException(status_code=415, detail="image must be JPG, PNG, WebP, or GIF")

    # Downscale + re-encode to WebP so we don't ship multi-MB
    # originals to every recipient's browser.
    try:
        from PIL import Image  # type: ignore
    except ImportError:
        raise HTTPException(status_code=500, detail="server missing Pillow")
    try:
        with Image.open(BytesIO(raw)) as img:
            img = img.convert("RGB") if img.mode not in ("RGB", "RGBA") else img
            w, h = img.size
            scale = min(1.0, IMAGE_TARGET_PX / max(w, h))
            if scale < 1.0:
                img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)
            buf = BytesIO()
            img.save(buf, format="WEBP", quality=82, method=6)
            payload = buf.getvalue()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"could not process image: {exc}")

    # Push to object storage. Reuses the helpers playbooks.py +
    # voice_submissions.py use so the bucket selection (MinIO vs R2)
    # stays consistent.
    from studio_tts_service import (
        _active_bucket,
        _minio_client,
        BUCKET_PROVIDER,
        R2_PUBLIC_DOMAIN,
        get_presigned_url,
    )
    object_key = f"notifications/banners/{uuid.uuid4().hex}.webp"
    try:
        client = _minio_client()
        client.put_object(
            _active_bucket(),
            object_key,
            BytesIO(payload),
            length=len(payload),
            content_type="image/webp",
            metadata={"Cache-Control": "public, max-age=31536000, immutable"},
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"upload failed: {exc}")

    if BUCKET_PROVIDER == "r2" and R2_PUBLIC_DOMAIN:
        url = f"https://{R2_PUBLIC_DOMAIN}/{object_key}"
    else:
        url = get_presigned_url(
            _active_bucket(),
            object_key,
            datetime.now(timezone.utc) + timedelta(days=365 * 5),
        ) or ""
    return {"url": url}


@admin_router.post("/send", response_model=AdminSendResponse)
async def admin_send(
    body: AdminSendBody,
    admin_email: str = Depends(require_admin_session),
) -> AdminSendResponse:
    """Compose + broadcast / target a notification. Returns the count
    of recipients (= rows inserted). One row per recipient so read state
    is per-user, which keeps the unread-count query trivial."""
    conn = await get_connection()
    try:
        # Resolve recipient ids based on audience.
        if body.audience == "user_ids":
            ids = [uid.strip() for uid in body.user_ids if (uid or "").strip()]
            if not ids:
                raise HTTPException(status_code=400, detail="user_ids required for audience=user_ids")
            # Verify all exist (cheap COUNT) so a typo doesn't silently
            # send to zero people without the admin noticing.
            placeholders = ",".join("?" for _ in ids)
            rows = await (await conn.execute(
                f"SELECT id FROM auth_users WHERE id IN ({placeholders})",
                ids,
            )).fetchall()
            recipient_ids = [r["id"] for r in rows]
        elif body.audience == "premium":
            rows = await (await conn.execute(
                "SELECT id FROM auth_users WHERE LOWER(COALESCE(plan_code, '')) = 'premium'"
            )).fetchall()
            recipient_ids = [r["id"] for r in rows]
        else:  # all
            rows = await (await conn.execute("SELECT id FROM auth_users")).fetchall()
            recipient_ids = [r["id"] for r in rows]
        if not recipient_ids:
            return AdminSendResponse(sent=0)
        # Bulk insert. One transaction; SQLite handles 10k inserts in
        # ms scale, fine for our user count today and well-bounded.
        params = [
            (uuid.uuid4().hex, uid, body.kind, body.title, body.body, body.link, body.image_url, admin_email)
            for uid in recipient_ids
        ]
        await conn.executemany(
            """
            INSERT INTO notifications
              (id, user_id, kind, title, body, link, image_url, sender, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            """,
            params,
        )
        await conn.commit()
        return AdminSendResponse(sent=len(recipient_ids))
    finally:
        await conn.close()
