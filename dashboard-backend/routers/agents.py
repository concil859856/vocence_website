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
import agents_service
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


@router.get("/models")
async def list_models(user_id: str = Depends(require_auth)) -> dict:
    """Available LLM models. v1: returns the configured default; later wire to
    a real Chutes model-discovery endpoint."""
    default = agents_service.AGENTS_LLM_MODEL
    models = []
    if default:
        models.append({"id": default, "label": default})
    return {"models": models}


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
