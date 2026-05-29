"""Generation feedback — user-facing thumbs-up / thumbs-down on a single
generation result (TTS / STT / clone / voice_design / music / noise_remover
/ agent call / agent message).

The thumbs UI in Studio + AgentChat posts here. Admin endpoints under
/admin/feedback aggregate the table for the Quality dashboard.

Schema details and the ``entry_type`` / ``entry_id`` rules live on the
``generation_feedback`` table in local_db.py.
"""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from local_db import get_connection
from routers.admin_auth import require_admin_unlocked
from routers.auth import require_auth


router = APIRouter(prefix="/feedback", tags=["feedback"])


# Mirrors StudioHistory categories + agent surfaces. Add new types here
# rather than letting clients send arbitrary strings — the admin
# Quality dashboard splits per-type so a typo would silently misclassify.
EntryType = Literal[
    "tts", "stt", "clone", "voice_design", "music", "noise_remover",
    "agent_call", "agent_message",
]


class FeedbackUpsert(BaseModel):
    entry_type: EntryType
    entry_id: str = Field(..., min_length=1, max_length=64)
    rating: int = Field(..., ge=-1, le=1)
    comment: str | None = Field(None, max_length=400)


@router.post("")
async def submit_feedback(
    body: FeedbackUpsert,
    user_id: str = Depends(require_auth),
) -> dict:
    """Upsert thumbs for the given (entry_type, entry_id). rating=0 is
    treated as "clear my vote" and deletes the row instead of writing it,
    so the user can un-vote by clicking the active thumb again."""
    conn = await get_connection()
    try:
        if body.rating == 0:
            await conn.execute(
                """
                DELETE FROM generation_feedback
                WHERE user_id = ? AND entry_type = ? AND entry_id = ?
                """,
                (user_id, body.entry_type, body.entry_id),
            )
            await conn.commit()
            return {"ok": True, "rating": 0}
        await conn.execute(
            """
            INSERT INTO generation_feedback
                (id, user_id, entry_type, entry_id, rating, comment, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT (user_id, entry_type, entry_id) DO UPDATE SET
                rating = excluded.rating,
                comment = excluded.comment,
                updated_at = datetime('now')
            """,
            (uuid.uuid4().hex, user_id, body.entry_type, body.entry_id,
             body.rating, body.comment),
        )
        await conn.commit()
        return {"ok": True, "rating": body.rating}
    finally:
        await conn.close()


@router.get("")
async def my_feedback(
    entry_type: EntryType,
    entry_id: str,
    user_id: str = Depends(require_auth),
) -> dict:
    """Look up the current user's vote for a single entry — used by the
    UI to pre-paint the thumb state when a result page loads."""
    conn = await get_connection()
    try:
        cur = await conn.execute(
            """
            SELECT rating, comment, created_at, updated_at
            FROM generation_feedback
            WHERE user_id = ? AND entry_type = ? AND entry_id = ?
            """,
            (user_id, entry_type, entry_id),
        )
        row = await cur.fetchone()
        if row is None:
            return {"rating": 0, "comment": None}
        return {
            "rating": int(row["rating"]),
            "comment": row["comment"],
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Admin: Quality dashboard aggregates
# ---------------------------------------------------------------------------

_VALID_RANGES = {"24h": "-1 days", "7d": "-7 days", "30d": "-30 days"}


@router.get("/admin/overview")
async def admin_feedback_overview(
    range: str = "7d",
    _: str = Depends(require_admin_unlocked),
) -> dict:
    """Aggregate satisfaction per entry_type: thumbs-up count, thumbs-
    down count, satisfaction % = up / (up + down). Excludes types
    with zero votes from the percentage but keeps them in the
    breakdown so the UI can show 'no data yet'."""
    modifier = _VALID_RANGES.get(range, "-7 days")
    conn = await get_connection()
    try:
        cur = await conn.execute(
            f"""
            SELECT
                entry_type,
                SUM(CASE WHEN rating = 1 THEN 1 ELSE 0 END)   AS up_count,
                SUM(CASE WHEN rating = -1 THEN 1 ELSE 0 END)  AS down_count,
                COUNT(*)                                       AS total
            FROM generation_feedback
            WHERE created_at >= datetime('now', '{modifier}')
            GROUP BY entry_type
            ORDER BY total DESC
            """
        )
        rows = []
        total_up = 0
        total_down = 0
        for r in await cur.fetchall():
            up = int(r["up_count"] or 0)
            down = int(r["down_count"] or 0)
            total = int(r["total"] or 0)
            sat = round(100.0 * up / (up + down), 1) if (up + down) > 0 else None
            rows.append({
                "entry_type": r["entry_type"],
                "up_count": up,
                "down_count": down,
                "total": total,
                "satisfaction_pct": sat,
            })
            total_up += up
            total_down += down
        overall_sat = (
            round(100.0 * total_up / (total_up + total_down), 1)
            if (total_up + total_down) > 0 else None
        )
        return {
            "range": range,
            "overall_satisfaction_pct": overall_sat,
            "rows": rows,
        }
    finally:
        await conn.close()


@router.get("/admin/recent-negative")
async def admin_recent_negative(
    range: str = "7d",
    limit: int = 100,
    _: str = Depends(require_admin_unlocked),
) -> dict:
    """Most-recent thumbs-down events with user + comment. Most
    actionable single view in the Quality tab — these are the users
    you'd reach out to or feed back to the model team."""
    modifier = _VALID_RANGES.get(range, "-7 days")
    limit = min(500, max(1, limit))
    conn = await get_connection()
    try:
        cur = await conn.execute(
            f"""
            SELECT f.id, f.user_id, f.entry_type, f.entry_id,
                   f.comment, f.created_at,
                   u.email AS user_email
            FROM generation_feedback f
            LEFT JOIN auth_users u ON u.id = f.user_id
            WHERE f.rating = -1
              AND f.created_at >= datetime('now', '{modifier}')
            ORDER BY f.created_at DESC
            LIMIT ?
            """,
            (limit,),
        )
        rows = [dict(r) for r in await cur.fetchall()]
        return {"range": range, "rows": rows}
    finally:
        await conn.close()
