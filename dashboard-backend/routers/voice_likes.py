"""Voice-likes router — aggregate + per-user toggle endpoints powering
the Community Voices page heart counter and popularity sort.

The catalog of voice ids lives in the frontend (app/src/data/sampleVoices.ts).
The backend stores a single row per (voice_id, user_id) like; aggregate
counts come from a GROUP BY.

Three endpoints:
  * GET  /public/voices/likes          — anonymous; returns ``{voice_id: count}``
                                         for every voice that has at least one
                                         like. Voices with zero likes are
                                         omitted (caller defaults to 0).
  * GET  /voices/likes/mine            — authed; returns ``[voice_id, ...]``
                                         for voices the caller has liked.
  * POST /voices/{voice_id}/like       — authed; toggles the caller's like for
                                         this voice. Returns ``{liked, count}``.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException

from local_db import get_connection
from routers.auth import require_auth


# Two routers so the public endpoint sits under ``/public`` and the
# authed endpoints sit under the normal authed prefix. main.py mounts
# both behind ``/api/dashboard``.
public_router = APIRouter(prefix="/public", tags=["public"])
authed_router = APIRouter(prefix="/voices", tags=["voices"])


# Catalog ids look like ``voc-atlas``, ``design-aria``, ``char-friendly-ai``
# — alphanumerics, dot, underscore, hyphen. Anything outside this set
# is either a typo or a fuzzer trying to wedge HTML/script payloads
# into the public counts JSON the frontend renders.
_VOICE_ID_RE = re.compile(r"^[a-zA-Z0-9._-]{1,64}$")


def _validate_voice_id(voice_id: str) -> str:
    vid = (voice_id or "").strip()
    if not _VOICE_ID_RE.match(vid):
        raise HTTPException(status_code=400, detail="invalid voice_id")
    return vid


@public_router.get("/voices/likes")
async def public_voice_like_counts() -> dict:
    """Anonymous aggregate counts. One round-trip, no auth — the
    Community Voices grid reads this on mount to sort + render heart
    badges before the user has authenticated (or for visitors)."""
    conn = await get_connection()
    try:
        cur = await conn.execute(
            "SELECT voice_id, COUNT(*) AS n "
            "FROM voice_likes "
            "GROUP BY voice_id"
        )
        rows = await cur.fetchall()
    finally:
        await conn.close()
    return {"counts": {r["voice_id"]: int(r["n"]) for r in rows}}


@authed_router.get("/likes/mine")
async def my_voice_likes(user_id: str = Depends(require_auth)) -> dict:
    """The signed-in user's like set, so the UI can render the heart
    button as filled-in for voices they've already liked."""
    conn = await get_connection()
    try:
        cur = await conn.execute(
            "SELECT voice_id FROM voice_likes WHERE user_id = ?",
            (user_id,),
        )
        rows = await cur.fetchall()
    finally:
        await conn.close()
    return {"voice_ids": [r["voice_id"] for r in rows]}


@authed_router.post("/{voice_id}/like")
async def toggle_voice_like(
    voice_id: str,
    user_id: str = Depends(require_auth),
) -> dict:
    """Toggle the caller's like for this voice. Returns the new state
    + the aggregate count so the UI can update both atomically."""
    vid = _validate_voice_id(voice_id)
    conn = await get_connection()
    try:
        # Atomic toggle: try to insert; if a row already exists the
        # UNIQUE PK turns the insert into a no-op (rowcount 0) and we
        # delete instead. Two concurrent requests can no longer race
        # past a stale SELECT and both hit IntegrityError.
        cur = await conn.execute(
            "INSERT OR IGNORE INTO voice_likes (voice_id, user_id) VALUES (?, ?)",
            (vid, user_id),
        )
        if cur.rowcount == 1:
            liked = True
        else:
            await conn.execute(
                "DELETE FROM voice_likes WHERE voice_id = ? AND user_id = ?",
                (vid, user_id),
            )
            liked = False
        await conn.commit()
        cur = await conn.execute(
            "SELECT COUNT(*) AS n FROM voice_likes WHERE voice_id = ?",
            (vid,),
        )
        row = await cur.fetchone()
        count = int(row["n"]) if row else 0
    finally:
        await conn.close()
    return {"voice_id": vid, "liked": liked, "count": count}
