"""Voice submissions, user-contributed voices for the Community Voices
catalog.

Flow:

  1. User uploads audio (8-15 s) + avatar (square ≤ 1 MB) + name +
     description (≤ 30 chars) + reference-text + language via
     ``POST /voice-submissions``. Both files land in object storage
     (MinIO / R2), only URLs persist in SQLite.
  2. Status starts ``pending``. User can list their own submissions
     via ``GET /voice-submissions/mine``.
  3. Admin reviews via ``GET /admin/voice-submissions`` + the per-id
     drawer, then approves / rejects:
       * Approve → status flips, ``approved_voice_id`` populated, the
         submitter gets +``APPROVAL_CREDIT_BONUS`` credits + an
         ``submission_approved`` notification.
       * Reject  → status flips, ``reject_reason`` saved, submitter
         gets a ``submission_rejected`` notification carrying the reason.

Audio is re-checked server-side for duration (8-15 s), clients can
lie about ``duration_ms``. We trust mutagen if installed, otherwise
fall back to a simple PCM-frame estimate for WAV files.
"""

from __future__ import annotations

import json
import logging
import os
import re
import uuid
from datetime import datetime, timedelta, timezone
from io import BytesIO

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field

from local_db import atomic_deduct_credits, get_connection, record_credit_transaction
from routers.auth import require_auth, require_admin_session


_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Audio bounds, generous on the upper side so a complete two-sentence
# sample doesn't get rejected, tight on the lower so 4-second snippets
# (which the qwen3 clone struggles with) don't enter the queue.
MIN_AUDIO_DURATION_MS = 8_000
MAX_AUDIO_DURATION_MS = 15_000
MAX_AUDIO_BYTES = 5 * 1024 * 1024  # 5 MB hard cap on the upload
ALLOWED_AUDIO_MIMES = {
    "audio/wav", "audio/x-wav", "audio/wave",
    "audio/mpeg", "audio/mp3",
    "audio/webm", "audio/ogg",
    "audio/mp4", "audio/x-m4a", "audio/m4a",  # Safari MediaRecorder records to mp4/m4a
}

# Avatar, re-encoded to a canonical 512×512 WebP server-side regardless
# of what the user uploads. Generous accept set, strict canonical store.
MAX_AVATAR_BYTES = 1 * 1024 * 1024  # 1 MB pre-resize
AVATAR_TARGET_PX = 512
ALLOWED_AVATAR_MIMES = {"image/jpeg", "image/png", "image/webp"}

# Description is the one-line tagline shown under the voice name on
# the Community Voices grid. 30 chars matches the user spec.
MAX_DESCRIPTION_CHARS = 30
MAX_NAME_CHARS = 40
MAX_REF_TEXT_CHARS = 500

# Bonus credits granted on approval.
APPROVAL_CREDIT_BONUS = 300

# Auto-transcribe used by the Submit-Your-Voice modal. Charges less
# than the full Studio STT (15 cr) because the audio is hard-capped
# at 15 s, a short clip costs less compute than the up-to-5-min STT
# the studio page accepts.
SUBMISSION_TRANSCRIBE_COST = int(
    os.environ.get("VOICE_SUBMISSION_TRANSCRIBE_COST", "5")
)

# Allowed languages, must match what the qwen3-clone-streaming pod
# accepts. Source of truth is voicechat_service._CLONE_LANGUAGES; we
# duplicate the set here to avoid an import cycle.
ALLOWED_LANGUAGES = {
    "English", "Chinese", "Japanese", "Korean", "Spanish", "French",
    "German", "Portuguese", "Italian", "Russian", "Arabic",
}

# Validation regexes.
_SUBMISSION_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{8,64}$")


# ---------------------------------------------------------------------------
# Routers, user + admin scoped under /api/dashboard
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/voice-submissions", tags=["voice-submissions"])
admin_router = APIRouter(prefix="/admin/voice-submissions", tags=["admin-voice-submissions"])
# Anonymous-readable router for the Community Voices grid, only
# returns approved voices, never pending/rejected ones.
public_router = APIRouter(prefix="/public", tags=["public"])


# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------

class VoiceSubmissionOut(BaseModel):
    id: str
    name: str
    description: str
    ref_text: str
    language: str
    audio_url: str
    audio_duration_ms: int
    avatar_url: str
    status: str
    reject_reason: str | None = None
    reviewed_at: str | None = None
    approved_voice_id: str | None = None
    created_at: str


class VoiceSubmissionAdminOut(VoiceSubmissionOut):
    user_id: str
    user_email: str | None = None
    user_name: str | None = None
    reviewed_by: str | None = None


class RejectBody(BaseModel):
    reason: str = Field(default="", max_length=500)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _validate_id(submission_id: str) -> str:
    if not _SUBMISSION_ID_RE.match(submission_id or ""):
        raise HTTPException(status_code=400, detail="invalid submission id")
    return submission_id


def _row_to_out(row: dict) -> VoiceSubmissionOut:
    return VoiceSubmissionOut(
        id=row["id"],
        name=row["name"],
        description=row["description"],
        ref_text=row["ref_text"],
        language=row["language"],
        audio_url=row["audio_url"],
        audio_duration_ms=int(row["audio_duration_ms"] or 0),
        avatar_url=row["avatar_url"],
        status=row["status"],
        reject_reason=row["reject_reason"],
        reviewed_at=row["reviewed_at"],
        approved_voice_id=row["approved_voice_id"],
        created_at=row["created_at"],
    )


def _row_to_admin_out(row: dict) -> VoiceSubmissionAdminOut:
    base = _row_to_out(row).model_dump()
    return VoiceSubmissionAdminOut(
        **base,
        user_id=row["user_id"],
        user_email=row.get("user_email") if isinstance(row, dict) else row["user_email"],
        user_name=row.get("user_name") if isinstance(row, dict) else row["user_name"],
        reviewed_by=row["reviewed_by"],
    )


def _measure_audio_duration_ms(raw: bytes, mime: str) -> int:
    """Best-effort duration probe. Tries three sources in order of
    reliability:

      1. **ffprobe** (via :func:`audio_probe.probe_audio_duration_seconds`)
        , the same path Studio STT uses. Handles every format we
         accept (WAV, MP3, WebM, OGG). Requires the ``ffprobe`` binary
         on PATH; in production it always is.
      2. **mutagen**, Python-only fallback for hosts without ffprobe.
         Handles MP3 / WebM / OGG containers correctly. Requires the
         ``mutagen`` pip package.
      3. **WAV header parse**, last-ditch handler so we can at least
         validate WAVs even when neither ffprobe nor mutagen is
         available.

    Returns ``0`` on total failure, caller treats 0 as "cannot
    determine, reject".
    """
    # 1) ffprobe, same path Studio STT uses for reliable duration.
    try:
        from audio_probe import probe_audio_duration_seconds
        # Filename hint helps ffprobe pick the demuxer when the
        # uploaded extension is ambiguous. We don't have the original
        # filename here, so synthesise one from the mime so e.g. an
        # "audio/mpeg" upload reads as ``audio.mp3``.
        ext = (
            "mp3" if "mp3" in mime or "mpeg" in mime
            else "wav" if "wav" in mime
            else "webm" if "webm" in mime
            else "ogg" if "ogg" in mime
            else ""
        )
        hint = f"audio.{ext}" if ext else None
        dur = probe_audio_duration_seconds(raw, hint)
        if dur is not None and dur > 0:
            return int(dur * 1000)
    except Exception:
        pass

    # 2) mutagen, Python-side fallback.
    try:
        from mutagen import File as MutagenFile  # type: ignore
        mf = MutagenFile(BytesIO(raw))
        if mf is not None and mf.info is not None:
            return int(float(mf.info.length) * 1000)
    except Exception:
        pass

    # 3) WAV header, always works for WAV without external deps.
    if "wav" in mime and raw[:4] == b"RIFF" and raw[8:12] == b"WAVE":
        try:
            byte_rate = int.from_bytes(raw[28:32], "little")
            i = 12
            while i < len(raw) - 8:
                chunk_id = raw[i:i+4]
                chunk_size = int.from_bytes(raw[i+4:i+8], "little")
                if chunk_id == b"data":
                    if byte_rate > 0:
                        return int(chunk_size / byte_rate * 1000)
                    return 0
                i += 8 + chunk_size
        except Exception:
            return 0
    return 0


def _resize_avatar_to_square_webp(raw: bytes) -> bytes:
    """Center-crop to square, downscale to AVATAR_TARGET_PX, encode WebP.
    Raises HTTPException(400) on decode failure."""
    try:
        from PIL import Image  # type: ignore
    except ImportError:
        raise HTTPException(status_code=500, detail="server missing Pillow")
    try:
        with Image.open(BytesIO(raw)) as img:
            img = img.convert("RGB") if img.mode not in ("RGB", "RGBA") else img
            w, h = img.size
            side = min(w, h)
            left = (w - side) // 2
            top = (h - side) // 2
            img = img.crop((left, top, left + side, top + side))
            if side > AVATAR_TARGET_PX:
                img = img.resize((AVATAR_TARGET_PX, AVATAR_TARGET_PX), Image.LANCZOS)
            buf = BytesIO()
            img.save(buf, format="WEBP", quality=82, method=6)
            return buf.getvalue()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"could not process image: {exc}")


def _put_object(payload: bytes, key: str, content_type: str) -> str:
    """Push bytes to the active bucket and return a publicly-readable
    URL. Uses the same R2-vs-MinIO selection that playbooks.py uses."""
    from studio_tts_service import (
        _active_bucket,
        _minio_client,
        BUCKET_PROVIDER,
        R2_PUBLIC_DOMAIN,
        get_presigned_url,
    )
    client = _minio_client()
    client.put_object(
        _active_bucket(),
        key,
        BytesIO(payload),
        length=len(payload),
        content_type=content_type,
        metadata={"Cache-Control": "public, max-age=31536000, immutable"},
    )
    if BUCKET_PROVIDER == "r2" and R2_PUBLIC_DOMAIN:
        return f"https://{R2_PUBLIC_DOMAIN}/{key}"
    # Long-lived presign for MinIO (5 years).
    return get_presigned_url(
        _active_bucket(),
        key,
        datetime.now(timezone.utc) + timedelta(days=365 * 5),
    ) or ""


async def _create_notification(
    conn,
    *,
    user_id: str,
    kind: str,
    title: str,
    body: str = "",
    link: str | None = None,
    image_url: str | None = None,
    sender: str = "system",
) -> str:
    """Insert a notifications row. Caller owns the connection + commit.
    ``image_url`` shows as a banner atop the user's detail modal when
    set; pass ``None`` (default) for a plain text-only notification."""
    nid = uuid.uuid4().hex
    await conn.execute(
        """
        INSERT INTO notifications (id, user_id, kind, title, body, link, image_url, sender, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        """,
        (nid, user_id, kind, title, body, link, image_url, sender),
    )
    return nid


# ---------------------------------------------------------------------------
# User endpoints
# ---------------------------------------------------------------------------

@router.post("", response_model=VoiceSubmissionOut)
async def submit_voice(
    name: str = Form(...),
    description: str = Form(...),
    ref_text: str = Form(...),
    language: str = Form(...),
    audio: UploadFile = File(...),
    avatar: UploadFile = File(...),
    user_id: str = Depends(require_auth),
) -> VoiceSubmissionOut:
    """Submit a voice for catalog inclusion. Both files are validated +
    stored in object storage; only URLs land in SQLite. Status starts
    ``pending``, an admin must approve before it appears in the
    Community Voices grid."""
    # ---- Text field validation ---------------------------------------
    name = (name or "").strip()
    description = (description or "").strip()
    ref_text = (ref_text or "").strip()
    language = (language or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    if len(name) > MAX_NAME_CHARS:
        raise HTTPException(status_code=400, detail=f"name must be ≤ {MAX_NAME_CHARS} chars")
    if not description:
        raise HTTPException(status_code=400, detail="description is required")
    if len(description) > MAX_DESCRIPTION_CHARS:
        raise HTTPException(status_code=400, detail=f"description must be ≤ {MAX_DESCRIPTION_CHARS} chars")
    if not ref_text:
        raise HTTPException(status_code=400, detail="ref_text (what the audio says) is required")
    if len(ref_text) > MAX_REF_TEXT_CHARS:
        raise HTTPException(status_code=400, detail=f"ref_text must be ≤ {MAX_REF_TEXT_CHARS} chars")
    if language not in ALLOWED_LANGUAGES:
        raise HTTPException(
            status_code=400,
            detail=f"language must be one of {sorted(ALLOWED_LANGUAGES)}",
        )

    # ---- Audio validation --------------------------------------------
    audio_raw = await audio.read()
    if not audio_raw:
        raise HTTPException(status_code=400, detail="empty audio file")
    if len(audio_raw) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail=f"audio exceeds {MAX_AUDIO_BYTES // (1024*1024)}MB")
    # Strip any codecs parameter: MediaRecorder reports e.g.
    # "audio/webm;codecs=opus", which an exact-set check would reject.
    audio_mime = (audio.content_type or "").split(";")[0].strip().lower()
    if audio_mime not in ALLOWED_AUDIO_MIMES:
        raise HTTPException(status_code=415, detail="audio must be WAV, MP3, WebM, OGG, or M4A")
    duration_ms = _measure_audio_duration_ms(audio_raw, audio_mime)
    if duration_ms == 0:
        raise HTTPException(status_code=400, detail="could not read audio duration")
    if duration_ms < MIN_AUDIO_DURATION_MS or duration_ms > MAX_AUDIO_DURATION_MS:
        raise HTTPException(
            status_code=400,
            detail=f"audio must be {MIN_AUDIO_DURATION_MS//1000}-{MAX_AUDIO_DURATION_MS//1000} seconds (got {duration_ms/1000:.1f}s)",
        )

    # ---- Avatar validation + normalize -------------------------------
    avatar_raw = await avatar.read()
    if not avatar_raw:
        raise HTTPException(status_code=400, detail="empty avatar file")
    if len(avatar_raw) > MAX_AVATAR_BYTES:
        raise HTTPException(status_code=413, detail=f"avatar exceeds {MAX_AVATAR_BYTES // (1024*1024)}MB")
    avatar_mime = (avatar.content_type or "").lower()
    if avatar_mime not in ALLOWED_AVATAR_MIMES:
        raise HTTPException(status_code=415, detail="avatar must be JPG, PNG, or WebP")
    avatar_webp = _resize_avatar_to_square_webp(avatar_raw)

    # ---- Upload to bucket --------------------------------------------
    submission_id = uuid.uuid4().hex
    audio_ext = "wav" if "wav" in audio_mime else "mp3" if "mp3" in audio_mime or "mpeg" in audio_mime else "webm" if "webm" in audio_mime else "ogg"
    try:
        audio_url = _put_object(
            audio_raw,
            key=f"voice-submissions/{user_id}/{submission_id}/audio.{audio_ext}",
            content_type=audio_mime,
        )
        avatar_url = _put_object(
            avatar_webp,
            key=f"voice-submissions/{user_id}/{submission_id}/avatar.webp",
            content_type="image/webp",
        )
    except Exception as exc:  # noqa: BLE001
        _log.warning("voice_submissions upload failed: %s", exc, exc_info=True)
        raise HTTPException(status_code=502, detail="object-storage upload failed")

    # ---- Persist ------------------------------------------------------
    conn = await get_connection()
    try:
        await conn.execute(
            """
            INSERT INTO voice_submissions
              (id, user_id, name, description, ref_text, language,
               audio_url, audio_duration_ms, avatar_url, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'))
            """,
            (
                submission_id, user_id, name, description, ref_text, language,
                audio_url, duration_ms, avatar_url,
            ),
        )
        # Notify the admin(s), anyone whose email matches the
        # configured ADMIN_EMAIL gets a row. Body carries BOTH the
        # submitter's display name AND their stable id so we can
        # cross-reference straight from the inbox without opening
        # the queue.
        submitter_row = await (await conn.execute(
            "SELECT name, email FROM auth_users WHERE id = ?", (user_id,)
        )).fetchone()
        submitter_name = (submitter_row["name"] if submitter_row else "") or "Unknown user"
        submitter_email = submitter_row["email"] if submitter_row else ""

        admin_email = (os.environ.get("ADMIN_EMAIL") or "").strip().lower()
        if admin_email:
            admin_rows = await (await conn.execute(
                "SELECT id FROM auth_users WHERE LOWER(email) = ?", (admin_email,)
            )).fetchall()
            for ar in admin_rows:
                await _create_notification(
                    conn,
                    user_id=ar["id"],
                    kind="voice_submission_received",
                    title=f"New voice submission: “{name}”",
                    body=(
                        f"From {submitter_name}\n"
                        f"User id: {user_id}\n"
                        + (f"Email: {submitter_email}\n" if submitter_email else "")
                        + f"Language: {language} · Duration: {duration_ms/1000:.1f}s"
                    ),
                    link="/admin",
                    image_url=avatar_url,
                    sender="system",
                )
        await conn.commit()
        row = await (await conn.execute(
            "SELECT * FROM voice_submissions WHERE id = ?", (submission_id,)
        )).fetchone()
    finally:
        await conn.close()
    return _row_to_out(dict(row))


@router.post("/transcribe")
async def submission_lite_transcribe(
    audio: UploadFile = File(...),
    language: str | None = Form(None),
    user_id: str = Depends(require_auth),
) -> dict:
    """Lite transcribe just for the Submit-Your-Voice modal's
    auto-transcribe button. Same STT pipeline as Studio's
    ``/transcribe``, but charges ``SUBMISSION_TRANSCRIBE_COST`` (5 cr)
    instead of the full ``STT_CREDITS_COST`` (15 cr), the audio is
    capped at ``MAX_AUDIO_DURATION_MS`` (15 s) by the modal validation,
    much smaller compute footprint than the up-to-5-min Studio STT."""
    raw = await audio.read()
    if not raw:
        raise HTTPException(status_code=400, detail="empty audio")
    if len(raw) > MAX_AUDIO_BYTES:
        raise HTTPException(status_code=413, detail=f"audio exceeds {MAX_AUDIO_BYTES // (1024*1024)}MB")
    # Strip any codecs parameter (e.g. "audio/webm;codecs=opus" from
    # MediaRecorder) so the exact-set membership check matches.
    mime = (audio.content_type or "").split(";")[0].strip().lower()
    if mime not in ALLOWED_AUDIO_MIMES:
        raise HTTPException(status_code=415, detail="audio must be WAV, MP3, WebM, OGG, or M4A")
    # Server re-checks duration so a client that calls this endpoint
    # outside the modal can't bypass the cap.
    duration_ms = _measure_audio_duration_ms(raw, mime)
    if duration_ms > MAX_AUDIO_DURATION_MS:
        raise HTTPException(
            status_code=413,
            detail=f"audio is {duration_ms/1000:.1f}s, lite transcribe is limited to {MAX_AUDIO_DURATION_MS//1000}s",
        )

    # Credit pre-check (atomic deduct also enforces this; fail fast
    # before spending compute).
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT credits FROM auth_users WHERE id = ?", (user_id,)
        )).fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="user not found")
        if int(row["credits"]) < SUBMISSION_TRANSCRIBE_COST:
            raise HTTPException(
                status_code=402,
                detail=f"insufficient credits: need {SUBMISSION_TRANSCRIBE_COST}, have {row['credits']}",
            )
    finally:
        await conn.close()

    # Call the same STT backend the Studio page uses.
    from studio_tts_service import transcribe_audio
    lang = (language or "").strip() or None
    result, err_msg = await transcribe_audio(audio_bytes=raw, language=lang)
    if not result:
        raise HTTPException(status_code=502, detail=err_msg or "STT provider failed")
    text = str(result.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=502, detail="STT returned empty text")

    # Bill on success.
    conn = await get_connection()
    try:
        new_credits = await atomic_deduct_credits(
            conn, user_id=user_id, cost=SUBMISSION_TRANSCRIBE_COST,
        )
        if new_credits is None:
            raise HTTPException(status_code=402, detail="insufficient credits (raced)")
        await record_credit_transaction(
            conn,
            user_id=user_id,
            transaction_type="charge",
            amount=-SUBMISSION_TRANSCRIBE_COST,
            balance_after=new_credits,
            description="Voice-submission auto-transcribe",
            reference_type="voice_submission_transcribe",
        )
        await conn.commit()
    finally:
        await conn.close()
    return {
        "text": text,
        "language": result.get("language"),
        "credits_used": SUBMISSION_TRANSCRIBE_COST,
        "credits_remaining": new_credits,
    }


@router.get("/mine")
async def list_my_submissions(user_id: str = Depends(require_auth)) -> dict:
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            "SELECT * FROM voice_submissions WHERE user_id = ? ORDER BY created_at DESC",
            (user_id,),
        )).fetchall()
    finally:
        await conn.close()
    return {"submissions": [_row_to_out(dict(r)).model_dump() for r in rows]}


# ---------------------------------------------------------------------------
# Admin endpoints
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Public endpoint, feeds the Community Voices grid
# ---------------------------------------------------------------------------

class CommunityVoiceOut(BaseModel):
    """Shape consumed by the frontend Community Voices grid for an
    approved community-contributed voice. Mirrors enough of the static
    ``SampleVoice`` shape that the grid can render both side-by-side
    with one render path, plus a ``submitter`` block so we can show
    the submitter's avatar + name on the card."""
    id: str                            # ``community-<submission_prefix>``
    name: str
    description: str
    language: str
    audio_url: str                     # direct URL, bypasses CDN asset lookup
    avatar_url: str                    # direct URL, bypasses gradient placeholder
    submitter_name: str | None
    submitter_picture: str | None


@public_router.get("/voices/community")
async def public_community_voices() -> dict:
    """List every approved community-contributed voice. No auth, this
    feeds the public Community Voices grid which is itself rendered
    for logged-out visitors."""
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            """
            SELECT s.approved_voice_id AS id, s.name, s.description, s.language,
                   s.audio_url, s.avatar_url,
                   u.name AS submitter_name, u.picture AS submitter_picture
            FROM voice_submissions s
            LEFT JOIN auth_users u ON u.id = s.user_id
            WHERE s.status = 'approved' AND s.approved_voice_id IS NOT NULL
            ORDER BY s.reviewed_at DESC
            """
        )).fetchall()
    finally:
        await conn.close()
    return {
        "voices": [
            CommunityVoiceOut(
                id=r["id"],
                name=r["name"],
                description=r["description"],
                language=r["language"],
                audio_url=r["audio_url"],
                avatar_url=r["avatar_url"],
                submitter_name=r["submitter_name"],
                submitter_picture=r["submitter_picture"],
            ).model_dump()
            for r in rows
        ],
    }


@admin_router.get("")
async def admin_list_submissions(
    status_filter: str = "all",
    _: str = Depends(require_admin_session),
) -> dict:
    """List all submissions, optionally filtered by status. Pending
    first so the admin queue shows actionable work at the top."""
    if status_filter not in ("all", "pending", "approved", "rejected"):
        raise HTTPException(status_code=400, detail="status_filter must be one of all/pending/approved/rejected")
    conn = await get_connection()
    try:
        if status_filter == "all":
            rows = await (await conn.execute(
                """
                SELECT s.*, u.email AS user_email, u.name AS user_name
                FROM voice_submissions s
                LEFT JOIN auth_users u ON u.id = s.user_id
                ORDER BY
                  CASE s.status WHEN 'pending' THEN 0 ELSE 1 END,
                  s.created_at DESC
                """
            )).fetchall()
        else:
            rows = await (await conn.execute(
                """
                SELECT s.*, u.email AS user_email, u.name AS user_name
                FROM voice_submissions s
                LEFT JOIN auth_users u ON u.id = s.user_id
                WHERE s.status = ?
                ORDER BY s.created_at DESC
                """,
                (status_filter,),
            )).fetchall()
        pending_count_row = await (await conn.execute(
            "SELECT COUNT(*) AS n FROM voice_submissions WHERE status = 'pending'"
        )).fetchone()
    finally:
        await conn.close()
    return {
        "submissions": [_row_to_admin_out(dict(r)).model_dump() for r in rows],
        "pending_count": int(pending_count_row["n"] or 0) if pending_count_row else 0,
    }


@admin_router.post("/{submission_id}/approve")
async def admin_approve(
    submission_id: str,
    admin_email: str = Depends(require_admin_session),
) -> dict:
    """Approve a submission. Side-effects:
      * status → approved
      * approved_voice_id populated (community-<id>)
      * +APPROVAL_CREDIT_BONUS credits to submitter (via record_credit_transaction)
      * notification fires
    """
    submission_id = _validate_id(submission_id)
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT * FROM voice_submissions WHERE id = ?", (submission_id,)
        )).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="submission not found")
        if row["status"] != "pending":
            raise HTTPException(status_code=409, detail=f"submission is {row['status']}, only pending can be approved")
        approved_voice_id = f"community-{submission_id[:12]}"
        await conn.execute(
            """
            UPDATE voice_submissions
            SET status = 'approved',
                approved_voice_id = ?,
                reviewed_at = datetime('now'),
                reviewed_by = ?,
                updated_at = datetime('now')
            WHERE id = ?
            """,
            (approved_voice_id, admin_email, submission_id),
        )
        # Credit bonus.
        await conn.execute(
            "UPDATE auth_users SET credits = credits + ?, updated_at = datetime('now') WHERE id = ?",
            (APPROVAL_CREDIT_BONUS, row["user_id"]),
        )
        balance_after_row = await (await conn.execute(
            "SELECT credits FROM auth_users WHERE id = ?", (row["user_id"],)
        )).fetchone()
        balance_after = int(balance_after_row["credits"]) if balance_after_row else APPROVAL_CREDIT_BONUS
        await record_credit_transaction(
            conn,
            user_id=row["user_id"],
            transaction_type="bonus",
            amount=APPROVAL_CREDIT_BONUS,
            balance_after=balance_after,
            description=f"Voice submission approved: {row['name']}",
            reference_type="voice_submission",
            reference_id=submission_id,
        )
        # Lead with thanks, then status, then reward, the order users
        # asked for. Short paragraphs because long-form is overkill for
        # an approval ping (the user already knew they submitted).
        await _create_notification(
            conn,
            user_id=row["user_id"],
            kind="submission_approved",
            title=f"🎉 Thanks for your contribution, “{row['name']}” is live!",
            body=(
                f"Thanks, we really appreciate your contribution!\n\n"
                f"Your voice **{row['name']}** has been approved and is now live on **Community Voices** "
                f"for everyone on Vocence to use.\n\n"
                f"You've also earned **+{APPROVAL_CREDIT_BONUS} bonus credits** as our thank-you. "
                f"Enjoy creating!\n\n"
                f"The Vocence Admin team"
            ),
            link="/studio/community-voices",
            image_url=row["avatar_url"],
            sender=admin_email,
        )
        await conn.commit()
    finally:
        await conn.close()
    return {"ok": True, "approved_voice_id": approved_voice_id, "credits_granted": APPROVAL_CREDIT_BONUS}


@admin_router.post("/{submission_id}/reject")
async def admin_reject(
    submission_id: str,
    body: RejectBody,
    admin_email: str = Depends(require_admin_session),
) -> dict:
    submission_id = _validate_id(submission_id)
    reason = (body.reason or "").strip()
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT * FROM voice_submissions WHERE id = ?", (submission_id,)
        )).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="submission not found")
        if row["status"] != "pending":
            raise HTTPException(status_code=409, detail=f"submission is {row['status']}, only pending can be rejected")
        await conn.execute(
            """
            UPDATE voice_submissions
            SET status = 'rejected',
                reject_reason = ?,
                reviewed_at = datetime('now'),
                reviewed_by = ?,
                updated_at = datetime('now')
            WHERE id = ?
            """,
            (reason or None, admin_email, submission_id),
        )
        await _create_notification(
            conn,
            user_id=row["user_id"],
            kind="submission_rejected",
            title=f"Update on your “{row['name']}” submission",
            body=(
                f"Thanks for taking the time to submit **{row['name']}** to the Vocence catalog. "
                f"Unfortunately we weren't able to approve this one for the community.\n\n"
                + (f"**Reason:** {reason}\n\n" if reason else "")
                + "Please feel free to submit a new version anytime, we'd love to see another take.\n\n"
                + "The Vocence Admin team"
            ),
            link="/studio/community-voices",
            sender=admin_email,
        )
        await conn.commit()
    finally:
        await conn.close()
    return {"ok": True}
