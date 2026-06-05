"""Public, no-auth agent metadata endpoint for the embeddable widget.

The widget's panel header shows the agent's display name and avatar.
At mount time it doesn't have a JWT (the visitor isn't logged in), so
we expose a tiny read-only endpoint that returns just the public bits.

Discovery defense: an agent only appears here when at least one
non-revoked embed token has been issued for it. That way the
existence of an agent isn't pingable through this endpoint by
guessing IDs — the agent owner has to explicitly opt in by minting a
token they intended to distribute.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from local_db import get_connection


router = APIRouter(prefix="/public", tags=["public"])


@router.get("/agents/{agent_id}")
async def public_agent(agent_id: str) -> dict:
    conn = await get_connection()
    try:
        # Two-step: confirm an embed token exists, then read agent
        # name. Combining them in one JOIN would be marginally faster
        # but the two-step version is far easier to audit for "does
        # this leak anything beyond what's intended."
        cur = await conn.execute(
            "SELECT 1 FROM agent_embed_tokens "
            "WHERE agent_id = ? AND revoked_at IS NULL LIMIT 1",
            (agent_id,),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail={"error": "agent not found"})

        cur = await conn.execute(
            "SELECT id, name, type, status FROM agents WHERE id = ?",
            (agent_id,),
        )
        agent = await cur.fetchone()
    finally:
        await conn.close()
    if agent is None:
        # Defense in depth — the token row references a deleted agent.
        # Shouldn't happen because the agents → embed_tokens FK is ON
        # DELETE CASCADE, but if it does, fail closed.
        raise HTTPException(status_code=404, detail={"error": "agent not found"})
    return {
        "id": agent["id"],
        "name": agent["name"],
        "type": agent["type"],          # 'knowledge' | 'goal'
        "status": agent["status"],      # 'active' | 'paused' | 'draft' | 'archived'
    }


# Languages list is kept in sync with the Studio Speech-to-Text picker
# (app/src/pages/Studio.tsx · STT_LANGUAGES). When that array grows,
# bump the number here too — the Studio home spotlight card reads this
# value so it stays accurate without anyone having to remember.
_SUPPORTED_LANGUAGES_COUNT = 24


@router.get("/stats/voice")
async def voice_stats() -> dict:
    """Read-only platform stats for the Studio home spotlight card.

    Returns honest, measurable numbers — no marketing inflation:
      * ``calls_handled`` — distinct voice sessions completed against
        ANY agent (Logos / Vocence Assistant calls included — they
        share the same WS path). One WS open = one session_id =
        one call, regardless of how many turns happened within it.
        Old rows (pre-migration) had no session_id and are skipped.
      * ``languages``     — supported STT language count.
    """
    conn = await get_connection()
    try:
        # COUNT distinct sessions regardless of turn mode. A "call" is
        # one WS open → many turns; the turn shape (voice WAV upload,
        # streamed PCM, or text-only) doesn't change whether it counts
        # as a call. status filter lets failed handshakes drop out.
        cur = await conn.execute(
            "SELECT COUNT(DISTINCT session_id) AS n "
            "FROM studio_voicechat_history "
            "WHERE status = 'completed' "
            "  AND session_id IS NOT NULL"
        )
        row = await cur.fetchone()
        calls = int(row["n"] or 0) if row else 0

        # Total ACTIVE user-created agents across the network. We
        # restrict to ``active`` so the marquee number reflects what's
        # live on the platform — not drafts a user spun up and never
        # activated (which would also be a free counter to spam).
        cur = await conn.execute(
            "SELECT COUNT(*) AS n FROM agents WHERE status = 'active'"
        )
        row = await cur.fetchone()
        agents_created = int(row["n"] or 0) if row else 0
    finally:
        await conn.close()
    return {
        "calls_handled": calls,
        "languages": _SUPPORTED_LANGUAGES_COUNT,
        "agents_created": agents_created,
    }
