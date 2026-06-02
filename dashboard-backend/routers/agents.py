"""Agents REST router — CRUD + draft + run lifecycle.

Mounted at ``/api/dashboard/agents`` (prefix added in main.py).
All endpoints require JWT auth (same as the studio router).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import agent_knowledge
import agent_templates
import agents_service
import llm_client
from local_db import get_connection
from routers.auth import require_auth


_log = logging.getLogger(__name__)
router = APIRouter(prefix="/agents", tags=["agents"])


# ---------------------------------------------------------------------------
# Pydantic schemas (kept here — close to use)
# ---------------------------------------------------------------------------


class AgentConfigIn(BaseModel):
    purpose: str = ""
    system_prompt: str = ""
    knowledge: str = ""
    voice: str = "Ryan"
    language: str = "English"
    llm_model: str = ""
    temperature: float = 0.6
    goal: Optional[str] = None
    success_metric: Optional[str] = None
    max_iterations: Optional[int] = None
    # Built-in tools the agent is allowed to call. Names match
    # agent_tools_service registry keys (e.g. "web_search", "get_time").
    # Empty list = no tools. None (omitted from JSON) = "all available"
    # — the no-config default keeps Logos powered up across the full
    # built-in library without explicit setup.
    enabled_tools: Optional[list[str]] = None


class AgentCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    type: str = Field(pattern="^(knowledge|goal)$")
    config: AgentConfigIn


class AgentPatchIn(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None
    config: Optional[dict] = None  # partial — merged with stored config


class AgentDraftIn(BaseModel):
    description: str = Field(min_length=1, max_length=4000)
    type_hint: Optional[str] = Field(default=None, pattern="^(knowledge|goal)$")
    existing: Optional[dict] = None


class _ArchitectChatTurn(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(min_length=1, max_length=4000)


class AgentArchitectChatIn(BaseModel):
    """Conversational architect turn — the default architect entry
    point. The architect responds in plain English; only when the
    user explicitly asks for an edit does the response include
    ``proposed_changes`` for the UI to surface as an Apply button.
    Replaces the silent auto-rewrite behaviour the old /draft-only
    flow had: an off-hand question like "what can you help with?"
    now stays as conversation rather than mutating the agent."""
    message: str = Field(min_length=1, max_length=4000)
    history: list[_ArchitectChatTurn] = Field(default_factory=list, max_length=24)
    existing: Optional[dict] = None


# ---------------------------------------------------------------------------
# Row → JSON helpers
# ---------------------------------------------------------------------------


def _row_to_agent(row: Any) -> dict:
    return {
        "id": row["id"],
        "user_id": row["user_id"],
        "type": row["type"],
        "status": row["status"],
        "name": row["name"],
        "config": json.loads(row["config_json"] or "{}"),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_run_at": row["last_run_at"],
        "run_count": int(row["run_count"] or 0),
    }


def _row_to_run(row: Any) -> dict:
    return {
        "id": row["id"],
        "agent_id": row["agent_id"],
        "status": row["status"],
        "goal": row["goal"] or "",
        "success_metric": row["success_metric"] or "",
        "iterations": json.loads(row["iterations_json"] or "[]"),
        "best_output": row["best_output"],
        "best_score": row["best_score"],
        "error": row["error"],
        "started_at": row["started_at"],
        "finished_at": row["finished_at"],
    }


async def _ensure_agent_owned(agent_id: str, user_id: str) -> Any:
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT * FROM agents WHERE id = ? AND user_id = ?",
            (agent_id, user_id),
        )).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="agent not found")
        return row
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.get("")
async def list_agents(user_id: str = Depends(require_auth)) -> dict:
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            "SELECT * FROM agents WHERE user_id = ? ORDER BY updated_at DESC",
            (user_id,),
        )).fetchall()
        return {"agents": [_row_to_agent(r) for r in rows]}
    finally:
        await conn.close()


@router.get("/templates")
async def list_templates(user_id: str = Depends(require_auth)) -> dict:
    """Starter-template gallery for the agent-create UI. Lightweight summaries
    only — call ``GET /agents/templates/{id}`` for the full system_prompt +
    knowledge_starter body."""
    return {"templates": agent_templates.template_summaries()}


@router.get("/templates/{template_id}")
async def get_template(template_id: str, user_id: str = Depends(require_auth)) -> dict:
    """Full template body for pre-filling the agent-create form. Snapshot
    semantics: once the user saves an agent, their config owns its own
    copy — later changes to the template do NOT propagate automatically."""
    detail = agent_templates.template_detail(template_id)
    if detail is None:
        raise HTTPException(status_code=404, detail=f"unknown template: {template_id}")
    return detail


@router.get("/models")
async def list_models(user_id: str = Depends(require_auth)) -> dict:
    """Voice-agent LLM picker.

    Intentionally narrow — two Cerebras models, picked for the voice-chat
    sweet spot of ~150-300 ms TTFT with reliable tool calling:

      • ``cerebras:qwen-3-235b-a22b-instruct-2507`` — higher quality,
        recommended default. Bigger model, slightly slower per-token.
      • ``cerebras:llama-3.3-70b`` — faster, lower latency. Use for
        snappier turn-taking when raw quality matters less.

    Both options only appear when Cerebras is configured server-side
    (``CEREBRAS_API_KEY`` set). Legacy agents whose ``llm_model`` is
    something else (Chutes default, Groq, OpenAI) still route correctly
    via llm_client — the picker just doesn't surface those for new
    agents."""
    models: list[dict[str, str]] = []

    if llm_client.cerebras_llm_configured():
        models.extend([
            {
                "id": "cerebras:qwen-3-235b-a22b-instruct-2507",
                "label": "Cerebras · Qwen 3 235B (quality, recommended)",
            },
            {
                "id": "cerebras:llama-3.3-70b",
                "label": "Cerebras · Llama 3.3 70B (faster, lower latency)",
            },
        ])

    # Surface legacy default if Cerebras isn't configured — keeps the
    # picker non-empty in dev setups without a Cerebras key.
    if not models:
        default = agents_service.AGENTS_LLM_MODEL
        if default:
            models.append({"id": default, "label": f"Chutes · {default}"})

    return {"models": models}


@router.get("/tools/builtin")
async def list_builtin_tools(user_id: str = Depends(require_auth)) -> dict:
    """Catalog of built-in tools the voice agents can call.

    Each entry includes whether the tool is actually available on this
    deployment (some need API keys like Tavily/OpenWeatherMap). The
    frontend uses this to render checkboxes in the agent's Tools
    section and grey out the ones whose env keys aren't set."""
    import agent_tools_service
    return {"tools": agent_tools_service.tool_catalog()}


@router.post("/draft")
async def draft_agent(body: AgentDraftIn, user_id: str = Depends(require_auth)) -> dict:
    if not agents_service.llm_configured():
        raise HTTPException(status_code=503, detail="agents LLM not configured")
    try:
        result = await agents_service.draft_agent_config(
            description=body.description,
            type_hint=body.type_hint,
            existing=body.existing,
        )
    except Exception as exc:  # noqa: BLE001
        _log.exception("draft failed")
        raise HTTPException(status_code=502, detail=f"draft failed: {exc}")
    return result


@router.post("/architect/chat")
async def architect_chat(body: AgentArchitectChatIn, user_id: str = Depends(require_auth)) -> dict:
    """One conversational turn with the architect. Returns
    ``{reply, proposed_changes}``: the UI shows ``reply`` as a chat
    bubble, and only renders an "Apply" button when ``proposed_changes``
    is non-null (the architect's signal that the user clearly asked
    for an edit). The old ``/draft`` endpoint still works for code that
    wants the one-shot rewrite."""
    if not agents_service.llm_configured():
        raise HTTPException(status_code=503, detail="agents LLM not configured")
    try:
        result = await agents_service.chat_with_architect(
            user_message=body.message,
            history=[h.model_dump() for h in body.history],
            existing=body.existing,
        )
    except Exception as exc:  # noqa: BLE001
        _log.exception("architect chat failed")
        raise HTTPException(status_code=502, detail=f"architect chat failed: {exc}")
    return result


@router.post("")
async def create_agent(body: AgentCreateIn, user_id: str = Depends(require_auth)) -> dict:
    agent_id = agents_service.new_id()
    cfg_json = body.config.model_dump_json(exclude_none=True)
    conn = await get_connection()
    try:
        await conn.execute(
            """INSERT INTO agents (id, user_id, type, status, name, config_json)
               VALUES (?, ?, ?, 'draft', ?, ?)""",
            (agent_id, user_id, body.type, body.name.strip(), cfg_json),
        )
        await conn.commit()
        row = await (await conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,))).fetchone()
    finally:
        await conn.close()
    # Index knowledge for RAG (no-op when knowledge is short — falls through
    # to dump-in-prompt at runtime).
    await agent_knowledge.index_agent_knowledge(agent_id, body.config.knowledge or "")
    return {"agent": _row_to_agent(row)}


@router.get("/{agent_id}")
async def get_agent(agent_id: str, user_id: str = Depends(require_auth)) -> dict:
    row = await _ensure_agent_owned(agent_id, user_id)
    return {"agent": _row_to_agent(row)}


@router.patch("/{agent_id}")
async def update_agent(agent_id: str, body: AgentPatchIn, user_id: str = Depends(require_auth)) -> dict:
    row = await _ensure_agent_owned(agent_id, user_id)
    fields: list[str] = ["updated_at = datetime('now')"]
    values: list[Any] = []

    if body.name is not None:
        fields.append("name = ?")
        values.append(body.name.strip()[:120])

    if body.status is not None:
        if body.status not in ("draft", "active", "paused", "archived"):
            raise HTTPException(status_code=400, detail="invalid status")
        fields.append("status = ?")
        values.append(body.status)

    knowledge_changed = False
    new_knowledge: str = ""
    if body.config is not None:
        existing = json.loads(row["config_json"] or "{}")
        old_knowledge = (existing.get("knowledge") or "").strip()
        existing.update({k: v for k, v in body.config.items() if v is not None})
        # clamp temperature
        if "temperature" in existing:
            try: existing["temperature"] = max(0.0, min(2.0, float(existing["temperature"])))
            except Exception: existing["temperature"] = 0.6
        new_knowledge = (existing.get("knowledge") or "").strip()
        knowledge_changed = new_knowledge != old_knowledge
        fields.append("config_json = ?")
        values.append(json.dumps(existing, ensure_ascii=False))

    values.append(agent_id)

    conn = await get_connection()
    try:
        await conn.execute(f"UPDATE agents SET {', '.join(fields)} WHERE id = ?", tuple(values))
        await conn.commit()
        updated = await (await conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,))).fetchone()
    finally:
        await conn.close()
    # Re-index RAG chunks if knowledge text changed.
    if knowledge_changed:
        await agent_knowledge.index_agent_knowledge(agent_id, new_knowledge)
    return {"agent": _row_to_agent(updated)}


@router.delete("/{agent_id}")
async def delete_agent(agent_id: str, user_id: str = Depends(require_auth)) -> dict:
    await _ensure_agent_owned(agent_id, user_id)
    conn = await get_connection()
    try:
        await conn.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
        await conn.commit()
    finally:
        await conn.close()
    # FTS5 doesn't honour FK cascades — drop chunks ourselves.
    await agent_knowledge.delete_agent_knowledge(agent_id)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Runs
# ---------------------------------------------------------------------------


@router.get("/{agent_id}/runs")
async def list_runs(agent_id: str, user_id: str = Depends(require_auth)) -> dict:
    await _ensure_agent_owned(agent_id, user_id)
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            "SELECT * FROM agent_runs WHERE agent_id = ? ORDER BY started_at DESC LIMIT 50",
            (agent_id,),
        )).fetchall()
        return {"runs": [_row_to_run(r) for r in rows]}
    finally:
        await conn.close()


@router.post("/{agent_id}/runs")
async def start_run(agent_id: str, user_id: str = Depends(require_auth)) -> dict:
    row = await _ensure_agent_owned(agent_id, user_id)
    if row["type"] != "goal":
        raise HTTPException(status_code=400, detail="only goal agents can be run")
    # Gate on status — paused and archived agents can't kick off new runs.
    # Drafts can (so the user can test before activating). Mirrors the
    # voicechat gate at routers/voicechat.py for consistency.
    status = row["status"] or "active"
    if status in ("paused", "archived"):
        raise HTTPException(
            status_code=409,
            detail=(
                "agent is paused — resume it from settings to start runs"
                if status == "paused"
                else "agent is archived — restore it from settings to start runs"
            ),
        )
    cfg = json.loads(row["config_json"] or "{}")
    goal = (cfg.get("goal") or "").strip()
    if not goal:
        raise HTTPException(status_code=400, detail="agent has no goal configured")
    metric = (cfg.get("success_metric") or "").strip()

    run_id = agents_service.new_id()
    conn = await get_connection()
    try:
        await conn.execute(
            """INSERT INTO agent_runs (id, agent_id, user_id, status, goal, success_metric)
               VALUES (?, ?, ?, 'pending', ?, ?)""",
            (run_id, agent_id, user_id, goal, metric),
        )
        await conn.commit()
        new = await (await conn.execute("SELECT * FROM agent_runs WHERE id = ?", (run_id,))).fetchone()
    finally:
        await conn.close()

    # spawn the loop in the background
    asyncio.create_task(agents_service.start_goal_run(run_id=run_id))

    return {"run": _row_to_run(new)}


@router.get("/{agent_id}/runs/{run_id}")
async def get_run(agent_id: str, run_id: str, user_id: str = Depends(require_auth)) -> dict:
    await _ensure_agent_owned(agent_id, user_id)
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT * FROM agent_runs WHERE id = ? AND agent_id = ?",
            (run_id, agent_id),
        )).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="run not found")
        return {"run": _row_to_run(row)}
    finally:
        await conn.close()


@router.post("/{agent_id}/runs/{run_id}/cancel")
async def cancel_run(agent_id: str, run_id: str, user_id: str = Depends(require_auth)) -> dict:
    await _ensure_agent_owned(agent_id, user_id)
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT status FROM agent_runs WHERE id = ? AND agent_id = ?",
            (run_id, agent_id),
        )).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="run not found")
        if row["status"] not in ("pending", "running"):
            return {"ok": True}
        await conn.execute(
            "UPDATE agent_runs SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?",
            (run_id,),
        )
        await conn.commit()
        return {"ok": True}
    finally:
        await conn.close()
