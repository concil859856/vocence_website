"""Playbook API: create, list, detail, update, delete, add/remove/reorder tracks, upload."""

import os
import uuid
from datetime import datetime, timedelta, timezone
from io import BytesIO

from fastapi import APIRouter, Depends, File, Form, HTTPException, Query, UploadFile

from local_db import get_connection
from routers.auth import require_auth
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


def _playbook_response(row, track_count: int = 0, total_duration: float = 0) -> PlaybookResponse:
    return PlaybookResponse(
        id=int(row["id"]),
        title=row["title"] or "Untitled",
        description=row["description"] or "",
        cover_image_url=row["cover_image_url"],
        visibility=row["visibility"] or "private",
        track_count=track_count,
        total_duration=total_duration,
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
                      (SELECT COALESCE(SUM(duration_seconds), 0) FROM playbook_tracks WHERE playbook_id = p.id) AS total_duration
               FROM playbooks p WHERE p.user_id = ? ORDER BY datetime(p.updated_at) DESC""",
            (user_id,),
        )).fetchall()
    finally:
        await conn.close()

    return PlaybookListResponse(
        playbooks=[_playbook_response(r, int(r["track_count"] or 0), float(r["total_duration"] or 0)) for r in rows]
    )


@router.get("/public/browse", response_model=PublicPlaybookListResponse)
async def list_public_playbooks(limit: int = Query(20, ge=1, le=50)):
    """Browse public playbooks from all users."""
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            """SELECT p.*, u.name AS user_name, u.picture AS user_picture,
                      (SELECT COUNT(*) FROM playbook_tracks WHERE playbook_id = p.id) AS track_count,
                      (SELECT COALESCE(SUM(duration_seconds), 0) FROM playbook_tracks WHERE playbook_id = p.id) AS total_duration
               FROM playbooks p
               JOIN auth_users u ON u.id = p.user_id
               WHERE p.visibility = 'public'
               ORDER BY datetime(p.updated_at) DESC
               LIMIT ?""",
            (limit,),
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
        pb = await (await conn.execute(
            "SELECT * FROM playbooks WHERE id = ? AND user_id = ?", (playbook_id, user_id)
        )).fetchone()
        if not pb:
            raise HTTPException(status_code=404, detail="Playbook not found")

        track_rows = await (await conn.execute(
            "SELECT * FROM playbook_tracks WHERE playbook_id = ? ORDER BY position ASC",
            (playbook_id,),
        )).fetchall()
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
        created_at=str(pb["created_at"] or ""),
        updated_at=str(pb["updated_at"] or ""),
        tracks=tracks,
    )


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
    finally:
        await conn.close()

    return _playbook_response(row, int(count_row["n"] or 0), float(count_row["dur"] or 0))


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
