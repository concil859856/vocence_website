"""Playbook API: create, list, detail, update, delete, add/remove/reorder tracks, upload."""

import os
import uuid
from datetime import datetime, timedelta, timezone
from io import BytesIO

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile
from pydantic import BaseModel, Field

from local_db import get_connection
from routers.auth import optional_auth, require_auth
from schemas import (
    PlaybookCreateRequest,
    PlaybookDetailResponse,
    PlaybookListResponse,
    PlaybookResponse,
    PlaybookTrackAddRequest,
    PlaybookTrackReorderRequest,
    PlaybookTrackResponse,
    PlaybookTracksAddRequest,
    PlaybookUpdateRequest,
    PublicPlaybookListResponse,
    PublicPlaybookResponse,
)
from studio_tts_service import get_presigned_url, upload_wav_to_hippius, _active_bucket, BUCKET_PROVIDER, R2_PUBLIC_DOMAIN

router = APIRouter(prefix="/playbooks", tags=["playbooks"])

MAX_PLAYBOOKS = int(os.environ.get("MAX_PLAYBOOKS_PER_USER", "50"))
MAX_TRACKS_PER_PLAYBOOK = int(os.environ.get("MAX_TRACKS_PER_PLAYBOOK", "200"))
MAX_UPLOAD_BYTES = int(os.environ.get("PLAYBOOK_MAX_UPLOAD_BYTES", str(50 * 1024 * 1024)))


def _playbook_response(
    row,
    track_count: int = 0,
    total_duration: float = 0,
    vote_count: int = 0,
    viewer_voted: bool = False,
) -> PlaybookResponse:
    return PlaybookResponse(
        id=int(row["id"]),
        title=row["title"] or "Untitled",
        description=row["description"] or "",
        cover_image_url=row["cover_image_url"],
        visibility=row["visibility"] or "private",
        track_count=track_count,
        total_duration=total_duration,
        # play_count lives on the row itself (denormalised counter on
        # the playbooks table), so we read it directly. Older rows that
        # missed the migration default to 0 via _ensure_column.
        play_count=int(row["play_count"]) if "play_count" in row.keys() and row["play_count"] is not None else 0,
        vote_count=vote_count,
        viewer_voted=viewer_voted,
        created_at=str(row["created_at"] or ""),
        updated_at=str(row["updated_at"] or ""),
    )


def _track_response(row) -> PlaybookTrackResponse:
    return PlaybookTrackResponse(
        id=int(row["id"]),
        position=int(row["position"]),
        title=row["title"] or "",
        subtitle=row["subtitle"] or "",
        audio_url=row["audio_url"] or "",
        image_url=row["image_url"],
        source_type=row["source_type"] or "generated",
        duration_seconds=float(row["duration_seconds"]) if row["duration_seconds"] is not None else None,
        added_at=str(row["added_at"] or ""),
    )


# ---- CRUD ----


@router.post("", response_model=PlaybookResponse)
async def create_playbook(body: PlaybookCreateRequest, user_id: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        # Check limit
        count_row = await (await conn.execute(
            "SELECT COUNT(*) AS n FROM playbooks WHERE user_id = ?", (user_id,)
        )).fetchone()
        if int(count_row["n"] or 0) >= MAX_PLAYBOOKS:
            raise HTTPException(status_code=400, detail=f"Maximum {MAX_PLAYBOOKS} playbooks allowed.")

        cursor = await conn.execute(
            """INSERT INTO playbooks (user_id, title, description, created_at, updated_at)
               VALUES (?, ?, ?, datetime('now'), datetime('now'))""",
            (user_id, body.title.strip() or "Untitled Playbook", body.description.strip()),
        )
        pb_id = int(cursor.lastrowid)
        await conn.commit()

        row = await (await conn.execute("SELECT * FROM playbooks WHERE id = ?", (pb_id,))).fetchone()
    finally:
        await conn.close()

    return _playbook_response(row)


@router.get("", response_model=PlaybookListResponse)
async def list_playbooks(user_id: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            """SELECT p.*,
                      (SELECT COUNT(*) FROM playbook_tracks WHERE playbook_id = p.id) AS track_count,
                      (SELECT COALESCE(SUM(duration_seconds), 0) FROM playbook_tracks WHERE playbook_id = p.id) AS total_duration,
                      (SELECT COUNT(*) FROM playbook_votes WHERE playbook_id = p.id) AS vote_count,
                      EXISTS(SELECT 1 FROM playbook_votes WHERE playbook_id = p.id AND user_id = ?) AS viewer_voted
               FROM playbooks p WHERE p.user_id = ? ORDER BY datetime(p.updated_at) DESC""",
            (user_id, user_id),
        )).fetchall()
    finally:
        await conn.close()

    return PlaybookListResponse(
        playbooks=[
            _playbook_response(
                r,
                int(r["track_count"] or 0),
                float(r["total_duration"] or 0),
                int(r["vote_count"] or 0),
                bool(r["viewer_voted"]),
            )
            for r in rows
        ]
    )


@router.get("/public/browse", response_model=PublicPlaybookListResponse)
async def list_public_playbooks(
    limit: int = Query(20, ge=1, le=50),
    viewer_id: str | None = Depends(optional_auth),
):
    """Browse public playbooks from all users.

    Sorted by thumb-up vote_count DESC (most loved first), then by recency
    as a tiebreaker. Auth is optional: when the request includes a valid
    Bearer token, each item's ``viewer_voted`` reflects whether the
    signed-in user has already thumbed it; otherwise it's False.
    """
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            """SELECT p.*, u.name AS user_name, u.picture AS user_picture,
                      (SELECT COUNT(*) FROM playbook_tracks WHERE playbook_id = p.id) AS track_count,
                      (SELECT COALESCE(SUM(duration_seconds), 0) FROM playbook_tracks WHERE playbook_id = p.id) AS total_duration,
                      (SELECT COUNT(*) FROM playbook_votes WHERE playbook_id = p.id) AS vote_count,
                      CASE WHEN ? IS NULL THEN 0
                           ELSE EXISTS(SELECT 1 FROM playbook_votes WHERE playbook_id = p.id AND user_id = ?)
                      END AS viewer_voted
               FROM playbooks p
               JOIN auth_users u ON u.id = p.user_id
               WHERE p.visibility = 'public'
               ORDER BY vote_count DESC, datetime(p.updated_at) DESC
               LIMIT ?""",
            (viewer_id, viewer_id, limit),
        )).fetchall()
    finally:
        await conn.close()

    return PublicPlaybookListResponse(
        playbooks=[
            PublicPlaybookResponse(
                id=int(r["id"]),
                title=r["title"] or "Untitled",
                description=r["description"] or "",
                cover_image_url=r["cover_image_url"],
                visibility="public",
                track_count=int(r["track_count"] or 0),
                total_duration=float(r["total_duration"] or 0),
                play_count=int(r["play_count"] or 0),
                vote_count=int(r["vote_count"] or 0),
                viewer_voted=bool(r["viewer_voted"]),
                created_at=str(r["created_at"] or ""),
                updated_at=str(r["updated_at"] or ""),
                user_name=r["user_name"] or "Anonymous",
                user_picture=r["user_picture"],
            )
            for r in rows
        ]
    )


@router.get("/{playbook_id}", response_model=PlaybookDetailResponse)
async def get_playbook(playbook_id: int, user_id: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        # Try owned first, then public
        pb = await (await conn.execute(
            "SELECT * FROM playbooks WHERE id = ? AND user_id = ?", (playbook_id, user_id)
        )).fetchone()
        if not pb:
            pb = await (await conn.execute(
                "SELECT * FROM playbooks WHERE id = ? AND visibility = 'public'", (playbook_id,)
            )).fetchone()
        if not pb:
            raise HTTPException(status_code=404, detail="Playbook not found")

        track_rows = await (await conn.execute(
            "SELECT * FROM playbook_tracks WHERE playbook_id = ? ORDER BY position ASC",
            (playbook_id,),
        )).fetchall()

        vote_row = await (await conn.execute(
            """SELECT (SELECT COUNT(*) FROM playbook_votes WHERE playbook_id = ?) AS vote_count,
                      EXISTS(SELECT 1 FROM playbook_votes WHERE playbook_id = ? AND user_id = ?) AS viewer_voted""",
            (playbook_id, playbook_id, user_id),
        )).fetchone()
    finally:
        await conn.close()

    tracks = [_track_response(r) for r in track_rows]
    total_dur = sum(t.duration_seconds or 0 for t in tracks)

    return PlaybookDetailResponse(
        id=int(pb["id"]),
        title=pb["title"] or "Untitled",
        description=pb["description"] or "",
        cover_image_url=pb["cover_image_url"],
        visibility=pb["visibility"] or "private",
        track_count=len(tracks),
        total_duration=total_dur,
        play_count=int(pb["play_count"]) if "play_count" in pb.keys() and pb["play_count"] is not None else 0,
        vote_count=int(vote_row["vote_count"] or 0),
        viewer_voted=bool(vote_row["viewer_voted"]),
        created_at=str(pb["created_at"] or ""),
        updated_at=str(pb["updated_at"] or ""),
        tracks=tracks,
        is_owner=(pb["user_id"] == user_id),
    )


# ---- Votes (thumb-up) ----


@router.post("/{playbook_id}/vote")
async def vote_playbook(playbook_id: int, user_id: str = Depends(require_auth)):
    """Cast a thumb-up on a public playbook. Idempotent: voting twice is
    a no-op and returns the current count. Voting on a private playbook
    (one the viewer doesn't own and isn't public) returns 404 so we don't
    leak its existence."""
    conn = await get_connection()
    try:
        pb = await (await conn.execute(
            "SELECT id, visibility, user_id FROM playbooks WHERE id = ?",
            (playbook_id,),
        )).fetchone()
        # Only public playbooks accept votes. The owner can't see a vote
        # surface on their own private playbook (it isn't shown publicly),
        # so 404 is the right response.
        if not pb or (pb["visibility"] or "private") != "public":
            raise HTTPException(status_code=404, detail="Playbook not found")

        await conn.execute(
            "INSERT OR IGNORE INTO playbook_votes (playbook_id, user_id) VALUES (?, ?)",
            (playbook_id, user_id),
        )
        await conn.commit()

        count_row = await (await conn.execute(
            "SELECT COUNT(*) AS n FROM playbook_votes WHERE playbook_id = ?",
            (playbook_id,),
        )).fetchone()
    finally:
        await conn.close()

    return {"vote_count": int(count_row["n"] or 0), "viewer_voted": True}


@router.delete("/{playbook_id}/vote")
async def unvote_playbook(playbook_id: int, user_id: str = Depends(require_auth)):
    """Remove the viewer's thumb-up. Idempotent."""
    conn = await get_connection()
    try:
        pb = await (await conn.execute(
            "SELECT id, visibility FROM playbooks WHERE id = ?",
            (playbook_id,),
        )).fetchone()
        if not pb or (pb["visibility"] or "private") != "public":
            raise HTTPException(status_code=404, detail="Playbook not found")

        await conn.execute(
            "DELETE FROM playbook_votes WHERE playbook_id = ? AND user_id = ?",
            (playbook_id, user_id),
        )
        await conn.commit()

        count_row = await (await conn.execute(
            "SELECT COUNT(*) AS n FROM playbook_votes WHERE playbook_id = ?",
            (playbook_id,),
        )).fetchone()
    finally:
        await conn.close()

    return {"vote_count": int(count_row["n"] or 0), "viewer_voted": False}


# ---- Plays ----


@router.post("/{playbook_id}/play")
async def record_play(playbook_id: int, _viewer: str | None = Depends(optional_auth)):
    """Bump the play counter when someone presses Play on a public
    playbook. Auth is optional so anonymous viewers (via shared links)
    are counted too — community signal we'd otherwise lose.

    Private playbooks silently no-op so the count stays meaningful when
    a playbook flips public → private → public (we don't want owner
    rehearsals to inflate the visible number).

    No dedup yet — that's a known limitation. Bots can inflate by
    hammering this endpoint; if it becomes a problem we'll add per-IP
    /per-user rate limiting before introducing 24-hour unique dedup."""
    conn = await get_connection()
    try:
        pb = await (await conn.execute(
            "SELECT id, visibility, play_count FROM playbooks WHERE id = ?",
            (playbook_id,),
        )).fetchone()
        if not pb:
            raise HTTPException(status_code=404, detail="Playbook not found")
        if (pb["visibility"] or "private") != "public":
            # Silent no-op — don't reveal whether the playbook exists as
            # private, just report the current (zero-ish) count.
            return {"play_count": int(pb["play_count"] or 0)}

        await conn.execute(
            "UPDATE playbooks SET play_count = play_count + 1 WHERE id = ?",
            (playbook_id,),
        )
        await conn.commit()

        row = await (await conn.execute(
            "SELECT play_count FROM playbooks WHERE id = ?", (playbook_id,)
        )).fetchone()
    finally:
        await conn.close()

    return {"play_count": int(row["play_count"] or 0)}


@router.patch("/{playbook_id}", response_model=PlaybookResponse)
async def update_playbook(playbook_id: int, body: PlaybookUpdateRequest, user_id: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        pb = await (await conn.execute(
            "SELECT * FROM playbooks WHERE id = ? AND user_id = ?", (playbook_id, user_id)
        )).fetchone()
        if not pb:
            raise HTTPException(status_code=404, detail="Playbook not found")

        updates = []
        params = []
        if body.title is not None:
            updates.append("title = ?")
            params.append(body.title.strip())
        if body.description is not None:
            updates.append("description = ?")
            params.append(body.description.strip())
        if body.visibility is not None and body.visibility in ("private", "public"):
            updates.append("visibility = ?")
            params.append(body.visibility)
        if body.cover_image_url is not None:
            updates.append("cover_image_url = ?")
            params.append(body.cover_image_url)

        if updates:
            updates.append("updated_at = datetime('now')")
            params.append(playbook_id)
            await conn.execute(f"UPDATE playbooks SET {', '.join(updates)} WHERE id = ?", params)
            await conn.commit()

        row = await (await conn.execute("SELECT * FROM playbooks WHERE id = ?", (playbook_id,))).fetchone()
        count_row = await (await conn.execute(
            "SELECT COUNT(*) AS n, COALESCE(SUM(duration_seconds), 0) AS dur FROM playbook_tracks WHERE playbook_id = ?",
            (playbook_id,),
        )).fetchone()
        vote_row = await (await conn.execute(
            """SELECT (SELECT COUNT(*) FROM playbook_votes WHERE playbook_id = ?) AS vote_count,
                      EXISTS(SELECT 1 FROM playbook_votes WHERE playbook_id = ? AND user_id = ?) AS viewer_voted""",
            (playbook_id, playbook_id, user_id),
        )).fetchone()
    finally:
        await conn.close()

    return _playbook_response(
        row,
        int(count_row["n"] or 0),
        float(count_row["dur"] or 0),
        int(vote_row["vote_count"] or 0),
        bool(vote_row["viewer_voted"]),
    )


@router.delete("/{playbook_id}")
async def delete_playbook(playbook_id: int, user_id: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        pb = await (await conn.execute(
            "SELECT id FROM playbooks WHERE id = ? AND user_id = ?", (playbook_id, user_id)
        )).fetchone()
        if not pb:
            raise HTTPException(status_code=404, detail="Playbook not found")
        await conn.execute("DELETE FROM playbook_tracks WHERE playbook_id = ?", (playbook_id,))
        await conn.execute("DELETE FROM playbooks WHERE id = ?", (playbook_id,))
        await conn.commit()
    finally:
        await conn.close()
    return {"ok": True}


# ---- Tracks ----


@router.post("/{playbook_id}/tracks", response_model=PlaybookDetailResponse)
async def add_tracks(playbook_id: int, body: PlaybookTracksAddRequest, user_id: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        pb = await (await conn.execute(
            "SELECT id FROM playbooks WHERE id = ? AND user_id = ?", (playbook_id, user_id)
        )).fetchone()
        if not pb:
            raise HTTPException(status_code=404, detail="Playbook not found")

        # Get current max position
        max_row = await (await conn.execute(
            "SELECT COALESCE(MAX(position), -1) AS mx FROM playbook_tracks WHERE playbook_id = ?",
            (playbook_id,),
        )).fetchone()
        pos = int(max_row["mx"] or -1) + 1

        # Check track limit
        count_row = await (await conn.execute(
            "SELECT COUNT(*) AS n FROM playbook_tracks WHERE playbook_id = ?", (playbook_id,)
        )).fetchone()
        current_count = int(count_row["n"] or 0)
        if current_count + len(body.tracks) > MAX_TRACKS_PER_PLAYBOOK:
            raise HTTPException(status_code=400, detail=f"Maximum {MAX_TRACKS_PER_PLAYBOOK} tracks per playbook.")

        for t in body.tracks:
            await conn.execute(
                """INSERT INTO playbook_tracks
                   (playbook_id, position, title, subtitle, audio_url, image_url, source_type, duration_seconds, added_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))""",
                (playbook_id, pos, t.title.strip(), t.subtitle.strip(), t.audio_url, t.image_url, t.source_type, t.duration_seconds),
            )
            pos += 1

        await conn.execute("UPDATE playbooks SET updated_at = datetime('now') WHERE id = ?", (playbook_id,))
        await conn.commit()
    finally:
        await conn.close()

    return await get_playbook(playbook_id, user_id)


@router.delete("/{playbook_id}/tracks/{track_id}")
async def remove_track(playbook_id: int, track_id: int, user_id: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        pb = await (await conn.execute(
            "SELECT id FROM playbooks WHERE id = ? AND user_id = ?", (playbook_id, user_id)
        )).fetchone()
        if not pb:
            raise HTTPException(status_code=404, detail="Playbook not found")

        await conn.execute(
            "DELETE FROM playbook_tracks WHERE id = ? AND playbook_id = ?", (track_id, playbook_id)
        )
        # Re-number positions
        rows = await (await conn.execute(
            "SELECT id FROM playbook_tracks WHERE playbook_id = ? ORDER BY position ASC", (playbook_id,)
        )).fetchall()
        for i, r in enumerate(rows):
            await conn.execute("UPDATE playbook_tracks SET position = ? WHERE id = ?", (i, r["id"]))
        await conn.execute("UPDATE playbooks SET updated_at = datetime('now') WHERE id = ?", (playbook_id,))
        await conn.commit()
    finally:
        await conn.close()
    return {"ok": True}


@router.patch("/{playbook_id}/tracks/reorder")
async def reorder_tracks(playbook_id: int, body: PlaybookTrackReorderRequest, user_id: str = Depends(require_auth)):
    conn = await get_connection()
    try:
        pb = await (await conn.execute(
            "SELECT id FROM playbooks WHERE id = ? AND user_id = ?", (playbook_id, user_id)
        )).fetchone()
        if not pb:
            raise HTTPException(status_code=404, detail="Playbook not found")

        for i, tid in enumerate(body.track_ids):
            await conn.execute(
                "UPDATE playbook_tracks SET position = ? WHERE id = ? AND playbook_id = ?",
                (i, tid, playbook_id),
            )
        await conn.execute("UPDATE playbooks SET updated_at = datetime('now') WHERE id = ?", (playbook_id,))
        await conn.commit()
    finally:
        await conn.close()
    return {"ok": True}


@router.post("/{playbook_id}/upload", response_model=PlaybookDetailResponse)
async def upload_track(
    playbook_id: int,
    title: str = Form("Uploaded Track"),
    audio_file: UploadFile = File(...),
    user_id: str = Depends(require_auth),
):
    """Upload a local audio file and add it to the playbook."""
    pb_conn = await get_connection()
    try:
        pb = await (await pb_conn.execute(
            "SELECT id FROM playbooks WHERE id = ? AND user_id = ?", (playbook_id, user_id)
        )).fetchone()
        if not pb:
            raise HTTPException(status_code=404, detail="Playbook not found")
    finally:
        await pb_conn.close()

    raw = await audio_file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail=f"File exceeds {MAX_UPLOAD_BYTES // (1024*1024)}MB limit")

    # Upload to bucket
    bucket, key, expires_at = upload_wav_to_hippius(user_id, raw, subdir="playbook")

    # Generate URL
    if BUCKET_PROVIDER == "r2" and R2_PUBLIC_DOMAIN:
        audio_url = f"https://{R2_PUBLIC_DOMAIN}/{key}"
    else:
        audio_url = get_presigned_url(bucket, key, expires_at) or ""

    # Add track
    track = PlaybookTrackAddRequest(
        title=title.strip() or audio_file.filename or "Uploaded Track",
        subtitle="Uploaded",
        audio_url=audio_url,
        source_type="uploaded",
    )
    return await add_tracks(
        playbook_id,
        PlaybookTracksAddRequest(tracks=[track]),
        user_id,
    )


class PlaybookUploadFromR2Request(BaseModel):
    """Register a track that the browser already PUT directly to R2 via a
    presigned URL (see /uploads/presign). Avoids passing the audio bytes
    through your API's Cloudflare proxy — works for files much larger
    than the proxy's per-request body limit.
    """

    title: str = Field("", max_length=200)
    bucket: str = Field(..., min_length=1, max_length=200)
    key: str = Field(..., min_length=1, max_length=512)
    filename: str = Field("Uploaded Track", max_length=255)


@router.post("/{playbook_id}/upload-from-r2", response_model=PlaybookDetailResponse)
async def upload_track_from_r2(
    playbook_id: int,
    body: PlaybookUploadFromR2Request,
    user_id: str = Depends(require_auth),
):
    """Register a track whose audio has already been uploaded to R2.
    The caller must have used /uploads/presign with kind='playbook-audio'
    so the key is namespaced under the same user.
    """
    pb_conn = await get_connection()
    try:
        pb = await (await pb_conn.execute(
            "SELECT id FROM playbooks WHERE id = ? AND user_id = ?", (playbook_id, user_id)
        )).fetchone()
        if not pb:
            raise HTTPException(status_code=404, detail="Playbook not found")
    finally:
        await pb_conn.close()

    # The presigned upload places keys under ``{user_id}/playbook/...`` —
    # validate both the user prefix and the subdir so a crafted call
    # can't register, say, another user's music output as their own
    # playbook track.
    from studio_tts_service import assert_user_owned_object
    try:
        assert_user_owned_object(body.bucket, body.key, user_id, allowed_subdir="playbook")
    except RuntimeError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    # Build the audio URL the same way upload_track() does.
    if BUCKET_PROVIDER == "r2" and R2_PUBLIC_DOMAIN:
        audio_url = f"https://{R2_PUBLIC_DOMAIN}/{body.key}"
    else:
        expires_at = datetime.now(timezone.utc) + timedelta(days=7)
        audio_url = get_presigned_url(body.bucket, body.key, expires_at) or ""

    track = PlaybookTrackAddRequest(
        title=body.title.strip() or body.filename or "Uploaded Track",
        subtitle="Uploaded",
        audio_url=audio_url,
        source_type="uploaded",
    )
    return await add_tracks(
        playbook_id,
        PlaybookTracksAddRequest(tracks=[track]),
        user_id,
    )


# ---- Cover image upload ----

MAX_COVER_BYTES = int(os.environ.get("PLAYBOOK_COVER_MAX_BYTES", str(2 * 1024 * 1024)))
COVER_TARGET_PX = 1024
ALLOWED_COVER_MIMES = {"image/png", "image/jpeg", "image/jpg", "image/webp"}


@router.post("/{playbook_id}/cover", response_model=PlaybookResponse)
async def upload_cover(
    playbook_id: int,
    image: UploadFile = File(...),
    user_id: str = Depends(require_auth),
):
    """Upload a custom cover image for a playbook. Re-encodes to square WebP and stores on R2."""
    raw = await image.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty file")
    if len(raw) > MAX_COVER_BYTES:
        raise HTTPException(status_code=413, detail=f"Image exceeds {MAX_COVER_BYTES // (1024*1024)}MB limit")
    mime = (image.content_type or "").lower()
    if mime not in ALLOWED_COVER_MIMES:
        raise HTTPException(status_code=415, detail="Use PNG, JPEG, or WebP")

    pb_conn = await get_connection()
    try:
        pb = await (await pb_conn.execute(
            "SELECT id FROM playbooks WHERE id = ? AND user_id = ?", (playbook_id, user_id)
        )).fetchone()
        if not pb:
            raise HTTPException(status_code=404, detail="Playbook not found")
    finally:
        await pb_conn.close()

    try:
        from PIL import Image  # Pillow is already a dep (see scripts/upload_static_assets.py)
    except ImportError:
        raise HTTPException(status_code=500, detail="Server missing Pillow; install python image library")

    try:
        with Image.open(BytesIO(raw)) as img:
            img = img.convert("RGB") if img.mode not in ("RGB", "RGBA") else img
            w, h = img.size
            side = min(w, h)
            left = (w - side) // 2
            top = (h - side) // 2
            img = img.crop((left, top, left + side, top + side))
            if side > COVER_TARGET_PX:
                img = img.resize((COVER_TARGET_PX, COVER_TARGET_PX), Image.LANCZOS)
            out = BytesIO()
            img.save(out, format="WEBP", quality=82, method=6)
            payload = out.getvalue()
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not process image: {e}")

    from studio_tts_service import _minio_client  # local import: avoids hard dep at module load

    object_key = f"static/playbook-covers/user/{user_id}/{uuid.uuid4().hex}.webp"
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
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Could not upload to storage: {e}")

    if BUCKET_PROVIDER == "r2" and R2_PUBLIC_DOMAIN:
        public_url = f"https://{R2_PUBLIC_DOMAIN}/{object_key}"
    else:
        public_url = get_presigned_url(_active_bucket(), object_key, datetime.now(timezone.utc) + timedelta(days=365 * 5)) or ""

    conn = await get_connection()
    try:
        await conn.execute(
            "UPDATE playbooks SET cover_image_url = ?, updated_at = datetime('now') WHERE id = ?",
            (public_url, playbook_id),
        )
        await conn.commit()
        row = await (await conn.execute("SELECT * FROM playbooks WHERE id = ?", (playbook_id,))).fetchone()
        count_row = await (await conn.execute(
            "SELECT COUNT(*) AS n, COALESCE(SUM(duration_seconds), 0) AS dur FROM playbook_tracks WHERE playbook_id = ?",
            (playbook_id,),
        )).fetchone()
        vote_row = await (await conn.execute(
            """SELECT (SELECT COUNT(*) FROM playbook_votes WHERE playbook_id = ?) AS vote_count,
                      EXISTS(SELECT 1 FROM playbook_votes WHERE playbook_id = ? AND user_id = ?) AS viewer_voted""",
            (playbook_id, playbook_id, user_id),
        )).fetchone()
    finally:
        await conn.close()

    return _playbook_response(
        row,
        int(count_row["n"] or 0),
        float(count_row["dur"] or 0),
        int(vote_row["vote_count"] or 0),
        bool(vote_row["viewer_voted"]),
    )
