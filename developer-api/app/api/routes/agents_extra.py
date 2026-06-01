"""Extra agent endpoints — ``/v1/agents/{templates,models,tools/builtin,
draft,architect/chat,{id}/runs/*}``.

Lives separately from agent_mgmt (CRUD) and agents (WebSocket session)
to keep each file focused. Everything here is a thin proxy to the
dashboard-backend equivalents — the logic (template gallery, model
picker, agent architect LLM, goal-agent runner) lives in the backend
and shouldn't be re-implemented in two places.

The split:
  - templates / models / tools.builtin  — discovery endpoints, useful
    for SDK consumers building their own agent-builder UI.
  - draft / architect/chat              — LLM-powered agent generation,
    same engine the website's Architect Drawer uses.
  - runs/* (goal-agent only)            — start / list / inspect /
    cancel autonomous goal-agent runs.
"""

from __future__ import annotations

import re
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.core.auth import require_api_key
from app.services.dashboard_proxy import call_dashboard
from app.services.gating import gate_request

router = APIRouter()


# Same shape as the agent_id used elsewhere — UUID hex / short slug.
# Matches agent_knowledge.py and embed_tokens.py so a typo in one
# place doesn't open a hole in another.
_AGENT_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{8,64}$")
# Template ids are static catalog keys (snake_case). Tight enough to
# reject path-traversal attempts at the dev-api boundary instead of
# trusting downstream lookup.
_TEMPLATE_ID_RE = re.compile(r"^[a-z0-9_-]{1,64}$")
# Goal-agent run ids — same format as agent_id.
_RUN_ID_RE = re.compile(r"^[a-zA-Z0-9_-]{8,64}$")


def _validate_agent_id(agent_id: str) -> None:
    if not _AGENT_ID_RE.match(agent_id):
        raise HTTPException(status_code=400, detail={"error": "malformed agent_id"})


def _validate_template_id(template_id: str) -> None:
    if not _TEMPLATE_ID_RE.match(template_id):
        raise HTTPException(status_code=400, detail={"error": "malformed template_id"})


def _validate_run_id(run_id: str) -> None:
    if not _RUN_ID_RE.match(run_id):
        raise HTTPException(status_code=400, detail={"error": "malformed run_id"})


# --------------------------------------------------------------------- discovery


@router.get(
    "/v1/agents/templates",
    tags=["Agents"],
    summary="List starter agent templates (compact summaries)",
)
async def list_templates(auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Lightweight gallery for an agent-builder UI. Returns one entry
    per template with ``id``, ``name``, ``summary``, ``type``. Call
    ``GET /v1/agents/templates/{id}`` for the full body."""
    user_id = auth_ctx["user_id"]
    return await call_dashboard(
        "GET",
        "/api/dashboard/agents/templates",
        user_id=user_id,
    )


@router.get(
    "/v1/agents/templates/{template_id}",
    tags=["Agents"],
    summary="Get a template's full body (system_prompt + knowledge_starter)",
)
async def get_template(
    template_id: str,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Snapshot semantics: once you create an agent from a template,
    the agent owns its own copy and later template tweaks do NOT
    propagate. Treat the response as a one-time seed."""
    _validate_template_id(template_id)
    user_id = auth_ctx["user_id"]
    return await call_dashboard(
        "GET",
        f"/api/dashboard/agents/templates/{template_id}",
        user_id=user_id,
    )


@router.get(
    "/v1/agents/models",
    tags=["Agents"],
    summary="List voice-agent LLM models available on this deployment",
)
async def list_models(auth_ctx: dict = Depends(require_api_key)) -> dict:
    """The voice-agent picker. Intentionally narrow (low-latency
    Cerebras options). The set depends on what's configured server-
    side — if Cerebras isn't wired up you'll see the Chutes default
    only. Pass any returned ``id`` as ``llm_model`` when creating /
    patching an agent."""
    user_id = auth_ctx["user_id"]
    return await call_dashboard(
        "GET",
        "/api/dashboard/agents/models",
        user_id=user_id,
    )


@router.get(
    "/v1/agents/tools/builtin",
    tags=["Agents"],
    summary="List built-in tools (web search, weather, datetime, etc.)",
)
async def list_builtin_tools(auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Catalog of the built-in tools an agent can be configured to use.
    Each entry tells you whether the tool is actually available on this
    deployment — some (e.g. Tavily, OpenWeatherMap) need extra API
    keys set server-side. To enable a tool on an agent, list its ``id``
    in ``enabled_tools`` on agent create/patch."""
    user_id = auth_ctx["user_id"]
    return await call_dashboard(
        "GET",
        "/api/dashboard/agents/tools/builtin",
        user_id=user_id,
    )


# --------------------------------------------------------------------- draft + architect


class _AgentDraftIn(BaseModel):
    description: str = Field(
        min_length=1, max_length=4000,
        description="Plain-English description of the agent you want — "
        "the same prompt you'd type into the website's Architect "
        "Drawer.",
    )
    type_hint: Optional[str] = Field(
        default=None,
        description="'knowledge' (chat-style RAG) or 'goal' (autonomous "
        "loop). Omit to let the architect infer.",
    )
    existing: Optional[dict] = Field(
        default=None,
        description="Optional existing agent config — when present, the "
        "architect tries to PATCH it rather than create from scratch.",
    )


@router.post(
    "/v1/agents/draft",
    tags=["Agents"],
    summary="One-shot: generate a complete agent spec from a description",
)
async def draft_agent(
    body: _AgentDraftIn,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """LLM-powered agent generator. Returns a complete agent config
    (name, purpose, system_prompt, knowledge starter, voice, language,
    suggested tools). Use this as a one-shot path; for an iterative
    conversational flow, use ``/v1/agents/architect/chat`` instead."""
    user_id = auth_ctx["user_id"]
    # Gate before the proxy hop — this endpoint hits the LLM provider
    # (OpenAI / Chutes) and bills our account per token. A loose
    # caller could burn cost in seconds without the rate-limit ceiling.
    await gate_request(user_id)
    return await call_dashboard(
        "POST",
        "/api/dashboard/agents/draft",
        user_id=user_id,
        json=body.model_dump(exclude_none=True),
    )


class _ArchitectChatTurn(BaseModel):
    role: str = Field(description="'user' or 'assistant'.")
    content: str = Field(min_length=1, max_length=4000)


class _AgentArchitectChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=4000)
    history: List[_ArchitectChatTurn] = Field(default_factory=list, max_length=24)
    existing: Optional[dict] = None


@router.post(
    "/v1/agents/architect/chat",
    tags=["Agents"],
    summary="Conversational agent architect — one turn of back-and-forth",
)
async def architect_chat(
    body: _AgentArchitectChatIn,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Conversational alternative to ``/draft``. Returns
    ``{reply, proposed_changes}``: ``reply`` is plain English to show
    the user; ``proposed_changes`` is non-null only when the architect
    decided the user is explicitly asking for an edit (i.e. don't
    auto-apply on casual questions like "what can you help with?")."""
    if body.message and not body.message.strip():
        raise HTTPException(status_code=400, detail="message is empty")
    user_id = auth_ctx["user_id"]
    # Same LLM-cost concern as draft_agent — gate before the upstream
    # call so the per-account RPM ceiling applies.
    await gate_request(user_id)
    return await call_dashboard(
        "POST",
        "/api/dashboard/agents/architect/chat",
        user_id=user_id,
        json=body.model_dump(exclude_none=True),
    )


# --------------------------------------------------------------------- goal-agent runs


@router.get(
    "/v1/agents/{agent_id}/runs",
    tags=["Agents"],
    summary="List recent goal-agent runs (most recent first, max 50)",
)
async def list_runs(
    agent_id: str,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Returns ``{runs: [...]}`` ordered by ``started_at`` DESC.
    Only relevant for agents with ``type == 'goal'``. Returns an empty
    list (NOT a 400) when called on a knowledge-style agent — easier
    for clients to handle uniformly."""
    _validate_agent_id(agent_id)
    user_id = auth_ctx["user_id"]
    # Cheap DB read, but the per-account RPM gate still applies — a
    # poll-in-a-tight-loop pattern shouldn't go unbounded just because
    # the underlying query is fast.
    await gate_request(user_id)
    return await call_dashboard(
        "GET",
        f"/api/dashboard/agents/{agent_id}/runs",
        user_id=user_id,
    )


@router.post(
    "/v1/agents/{agent_id}/runs",
    status_code=201,
    tags=["Agents"],
    summary="Start a new goal-agent run (kicks off the autonomous loop)",
)
async def start_run(
    agent_id: str,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Boots a new autonomous run against this agent's configured goal.
    Returns the freshly-created run row in ``pending`` state — the
    actual work happens asynchronously on the server. Poll
    ``GET /v1/agents/{agent_id}/runs/{run_id}`` for progress."""
    _validate_agent_id(agent_id)
    user_id = auth_ctx["user_id"]
    # Gate: a goal run spawns an async LLM loop on the server. Without
    # an RPM ceiling here, a caller could create thousands of pending
    # runs, filling the job queue + LLM bill before anyone notices.
    await gate_request(user_id)
    return await call_dashboard(
        "POST",
        f"/api/dashboard/agents/{agent_id}/runs",
        user_id=user_id,
        json={},
    )


@router.get(
    "/v1/agents/{agent_id}/runs/{run_id}",
    tags=["Agents"],
    summary="Fetch a single run's status + transcript",
)
async def get_run(
    agent_id: str,
    run_id: str,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Returns ``{run: {...}}``. ``run.status`` is one of pending,
    running, completed, failed, cancelled. The transcript (every
    step the agent took) is in ``run.transcript_json`` as an array."""
    _validate_agent_id(agent_id)
    _validate_run_id(run_id)
    user_id = auth_ctx["user_id"]
    # Same poll-loop guardrail as list_runs.
    await gate_request(user_id)
    return await call_dashboard(
        "GET",
        f"/api/dashboard/agents/{agent_id}/runs/{run_id}",
        user_id=user_id,
    )


@router.post(
    "/v1/agents/{agent_id}/runs/{run_id}/cancel",
    tags=["Agents"],
    summary="Cancel a pending or running goal-agent run",
)
async def cancel_run(
    agent_id: str,
    run_id: str,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Idempotent — returns ``{ok: true}`` whether or not there was
    anything to cancel. Runs already in a terminal state (completed,
    failed, cancelled) are left alone."""
    _validate_agent_id(agent_id)
    _validate_run_id(run_id)
    user_id = auth_ctx["user_id"]
    await gate_request(user_id)
    return await call_dashboard(
        "POST",
        f"/api/dashboard/agents/{agent_id}/runs/{run_id}/cancel",
        user_id=user_id,
        json={},
    )
