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
