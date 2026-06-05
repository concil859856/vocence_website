"""Public developer-API surface for managing an agent's embed tokens.

Embed tokens let a developer drop the ``<vocence-agent>`` widget on any
website — the widget authenticates to dashboard-backend with the token
(not with the API key) so the key never reaches the browser. This
module forwards to ``dashboard-backend/routers/embed_tokens.py``; the
plaintext is returned ONCE on create, never afterwards.

Gate pattern:

* ``list`` (read-only): authenticated only, no gate.
* ``create`` / ``revoke`` (mutating): full Premium + rate-limit gate
  + audit log. ``create`` in particular is rate-limited to keep a
  compromised API key from spawning thousands of widget tokens before
  the user can rotate.
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.auth import require_api_key
from app.services.dashboard_proxy import call_dashboard
from app.services.gating import gate_request, log_audit


_log = logging.getLogger(__name__)
router = APIRouter()

_AGENT_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{8,64}$")


def _validate_agent_id(agent_id: str) -> None:
    if not _AGENT_ID_RE.match(agent_id):
        raise HTTPException(status_code=400, detail={"error": "malformed agent_id"})


async def _gated_dashboard_call(
    *,
    auth_ctx: dict[str, Any],
    endpoint_label: str,
    method: str,
    path: str,
    json: Any | None = None,
) -> dict:
    """Premium-gate + rate-limit + proxy + audit. Shared with
    knowledge.py's helper (re-implemented inline rather than pulled to
    a shared module because the surface is small enough that the
    duplication is cheaper than the indirection)."""
    await gate_request(auth_ctx["user_id"])
    t0 = time.perf_counter()
    try:
        result = await call_dashboard(
            method, path, user_id=auth_ctx["user_id"], json=json,
        )
    except HTTPException as exc:
        await log_audit(
            auth_ctx=auth_ctx, endpoint=endpoint_label,
            http_status=exc.status_code,
            error_message=str(exc.detail)[:200],
            latency_ms=int((time.perf_counter() - t0) * 1000),
        )
        raise
    await log_audit(
        auth_ctx=auth_ctx, endpoint=endpoint_label,
        http_status=200,
        latency_ms=int((time.perf_counter() - t0) * 1000),
    )
    return result


class CreateEmbedTokenRequest(BaseModel):
    """Minimal embed-token configuration.

    Defaults are deliberately conservative — a fresh token only allows
    5-minute sessions and 30 calls / IP / hour. Raise both for trusted
    customer-facing sites; leave them low for public landing pages."""

    label: str = Field(
        default="",
        max_length=120,
        description="Human label so you can recognise the token later (eg. 'staging-site').",
    )
    allowed_origins: list[str] = Field(
        default_factory=list,
        max_length=20,
        description=(
            "Comma-list of allowed origins (eg. ['https://example.com']). "
            "An empty list means any origin can use this token — generally "
            "you want this set in production."
        ),
    )
    rate_limit_per_ip_per_hour: int = Field(
        default=30,
        ge=1,
        le=10_000,
        description="Per-IP, per-hour cap on new sessions opened with this token.",
    )
    max_session_minutes: int = Field(
        default=5,
        ge=1,
        le=60,
        description="Hard cap on each WS session's duration.",
    )


@router.post(
    "/v1/agents/{agent_id}/embed-tokens",
    status_code=201,
    tags=["Embed Tokens"],
    summary="Mint a new embed token (plaintext returned ONCE)",
)
async def create_embed_token(
    agent_id: str,
    body: CreateEmbedTokenRequest,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Create a new embed token.

    The response includes ``plaintext`` (the secret), ``token`` (metadata
    the server stores), and ``embed_snippet`` (ready-to-paste HTML).
    SAVE the plaintext immediately — the server NEVER returns it again.
    Lose it and you have to mint a new one."""
    _validate_agent_id(agent_id)
    return await _gated_dashboard_call(
        auth_ctx=auth_ctx, endpoint_label="embed_tokens.create",
        method="POST",
        path=f"/api/dashboard/agents/{agent_id}/embed-tokens",
        json=body.model_dump(exclude_none=True),
    )


@router.get(
    "/v1/agents/{agent_id}/embed-tokens",
    tags=["Embed Tokens"],
    summary="List embed tokens (metadata only — never the plaintext)",
)
async def list_embed_tokens(
    agent_id: str,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Read-only — no Premium / rate gate. Lets a paused customer
    inspect what tokens they have without paying the API-call tax."""
    _validate_agent_id(agent_id)
    return await call_dashboard(
        "GET",
        f"/api/dashboard/agents/{agent_id}/embed-tokens",
        user_id=auth_ctx["user_id"],
    )


@router.delete(
    "/v1/agents/{agent_id}/embed-tokens/{token_id}",
    tags=["Embed Tokens"],
    summary="Revoke an embed token (live sessions immediately rejected)",
)
async def revoke_embed_token(
    agent_id: str,
    token_id: str,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    _validate_agent_id(agent_id)
    return await _gated_dashboard_call(
        auth_ctx=auth_ctx, endpoint_label="embed_tokens.revoke",
        method="DELETE",
        path=f"/api/dashboard/agents/{agent_id}/embed-tokens/{token_id}",
    )
