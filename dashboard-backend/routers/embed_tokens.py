"""Studio-facing API for managing embed tokens on an agent.

Mounted at ``/api/dashboard/agents/{agent_id}/embed-tokens``.

Every endpoint requires the JWT to OWN the agent — same IDOR pattern
as the rest of the dashboard.

The ``create`` endpoint returns the **plaintext** token exactly once
in the response — the caller must save it because subsequent reads
only return the prefix. This matches how every other API-key-style
issuance flow (api_keys, CLI auth) behaves in this codebase.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import embed_tokens
from local_db import get_connection
from routers.auth import require_auth


router = APIRouter(
    prefix="/agents/{agent_id}/embed-tokens",
    tags=["embed-tokens"],
)


async def _require_agent_owner(agent_id: str, user_id: str) -> None:
    """404 if the agent doesn't exist or the user doesn't own it.
    (Not 403 — we don't want to confirm an id's existence to a
    non-owner.)"""
    conn = await get_connection()
    try:
        cur = await conn.execute(
            "SELECT user_id FROM agents WHERE id = ?", (agent_id,),
        )
        row = await cur.fetchone()
    finally:
        await conn.close()
    if row is None or row["user_id"] != user_id:
        raise HTTPException(status_code=404, detail={"error": "agent not found"})


class CreateBody(BaseModel):
    label: str = Field(default="", max_length=120)
    allowed_origins: list[str] = Field(default_factory=list, max_length=20)
    rate_limit_per_ip_per_hour: int = Field(default=30, ge=1, le=10_000)
    max_session_minutes: int = Field(default=5, ge=1, le=60)


@router.post("")
async def create_embed_token(
    agent_id: str,
    body: CreateBody,
    user_id: str = Depends(require_auth),
) -> dict:
    """Mint a new embed token. The plaintext is returned ONCE in the
    response and never afterwards — the caller must save it."""
    await _require_agent_owner(agent_id, user_id)
    conn = await get_connection()
    try:
        plaintext, row = await embed_tokens.create_token(
            conn,
            agent_id=agent_id,
            owner_user_id=user_id,
            label=body.label,
            allowed_origins=body.allowed_origins,
            rate_limit_per_ip_per_hour=body.rate_limit_per_ip_per_hour,
            max_session_minutes=body.max_session_minutes,
        )
    finally:
        await conn.close()
    # Surface a ready-to-paste embed snippet for the most common case
    # (no custom server attribute). The Studio UI shows this verbatim
    # in a copy-button.
    snippet = (
        '<script src="https://widget.vocence.ai/v1/widget.js" defer></script>\n'
        f'<vocence-agent agent-id="{agent_id}" embed-token="{plaintext}"></vocence-agent>'
    )
    return {
        "token": row,
        "plaintext": plaintext,
        "embed_snippet": snippet,
    }


@router.get("")
async def list_embed_tokens(
    agent_id: str,
    user_id: str = Depends(require_auth),
) -> dict:
    await _require_agent_owner(agent_id, user_id)
    conn = await get_connection()
    try:
        tokens = await embed_tokens.list_tokens(conn, agent_id=agent_id)
    finally:
        await conn.close()
    return {"tokens": tokens}


@router.delete("/{token_id}")
async def revoke_embed_token(
    agent_id: str,
    token_id: str,
    user_id: str = Depends(require_auth),
) -> dict:
    await _require_agent_owner(agent_id, user_id)
    conn = await get_connection()
    try:
        changed = await embed_tokens.revoke_token(
            conn, token_id=token_id, agent_id=agent_id,
        )
    finally:
        await conn.close()
    if not changed:
        # 404 (not 409) for already-revoked or unknown — the operator
        # doesn't need to distinguish.
        raise HTTPException(
            status_code=404,
            detail={"error": "token not found or already revoked"},
        )
    return {"ok": True}
