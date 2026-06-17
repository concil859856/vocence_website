"""
Developer-API: agent management, custom tools, and saved voices.

All endpoints in this file are authenticated via ``require_api_key``
(Bearer ``voc_live_…``). Every operation is scoped to the API key's
owning user — there's no path for one user's key to read / mutate
another user's resources. Read paths use direct SQLite reads against
the same DB the website writes to; mutations that need server-side
business logic (LLM, R2, voice clone) proxy to dashboard-backend via
``dashboard_proxy.call_dashboard``.

Resource map
------------
``/v1/agents``                          CRUD on the user's agents
``/v1/agents/{id}/tools``               list / bind / unbind custom tools
``/v1/agent-tools``                     CRUD on user-defined webhook tools
``/v1/voices``                          list / get / delete saved voices
``/v1/voices/{id}/speak``               TTS using a saved voice (proxy)
``/v1/voice/design/preview``            generate Voice Design preview (proxy)
``/v1/voice/design/save``               persist a Voice Design preview (proxy)
``/v1/voice/clone/save``                upload audio + transcribe + save as a reusable voice (proxy)
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field


# Spoken language label accepted by the voice pipeline. Same set Studio
# uses in app/src/components/agents/AgentConfigForm.tsx — these are the
# canonical labels the TTS/STT/clone stack expects.
AGENT_LANGUAGE = Literal[
    "English", "Chinese", "Japanese", "Korean", "German", "French",
    "Russian", "Portuguese", "Spanish", "Italian",
]

# Built-in tool names the LLM can call. Discovered from
# dashboard-backend/agent_tools_service.py — keep in sync.
AGENT_TOOL = Literal[
    "web_search", "wikipedia_lookup", "get_weather", "get_time", "fetch_url",
]

from app.core.auth import require_api_key
from app.core.config import API_VOICE_SAVE_CREDITS
from app.db.connection import get_db
from app.services.dashboard_proxy import call_dashboard
from app.services.usage import enforce_rate_limit


async def _ensure_premium(conn, user_id: str) -> None:
    """Verify the caller has at least one successful Premium purchase.

    Mirrors ``_ensure_premium`` in v1.py. Duplicated here (instead of
    cross-importing) so this module stays self-contained — the v1.py
    helper is module-private and we don't want to leak that contract.
    """
    paid_row = await (
        await conn.execute(
            """
            SELECT COUNT(*) AS n
            FROM payments
            WHERE user_id = ?
              AND status IN ('paid', 'completed')
              AND credits_granted > 0
              AND LOWER(COALESCE(plan_code, '')) = 'premium'
            """,
            (user_id,),
        )
    ).fetchone()
    if int(paid_row["n"] or 0) <= 0:
        raise HTTPException(status_code=402, detail="Developer API requires a successful Premium plan purchase first.")


async def _gate_request(user_id: str) -> None:
    """Common premium + rate-limit gate for work-doing endpoints in
    this module. Call at the top of any endpoint that hits an upstream
    service or deducts credits."""
    conn = await get_db()
    try:
        await _ensure_premium(conn, user_id)
        await enforce_rate_limit(conn, user_id, None)
    finally:
        await conn.close()


async def _deduct_flat_credits(user_id: str, cost: int, label: str, transaction_type: str) -> int:
    """Atomic flat-rate deduction used by per-call API endpoints.

    Returns the new balance, or -1 if billing is disabled (cost == 0).
    Raises 402 on insufficient balance. Logs one ``credit_transactions``
    row so the user sees the charge in their billing history.
    """
    if cost <= 0:
        return -1
    conn = await get_db()
    try:
        row = await (await conn.execute(
            "SELECT credits FROM auth_users WHERE id = ?", (user_id,)
        )).fetchone()
        balance = int(row["credits"] or 0) if row else 0
        if balance < cost:
            raise HTTPException(
                status_code=402,
                detail=f"{label.capitalize()} costs {cost} credits. You have {balance}.",
            )
        cur = await conn.execute(
            "UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') "
            "WHERE id = ? AND credits >= ?",
            (cost, user_id, cost),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=402, detail="Insufficient credits.")
        new_row = await (await conn.execute(
            "SELECT credits FROM auth_users WHERE id = ?", (user_id,)
        )).fetchone()
        new_balance = int(new_row["credits"] or 0) if new_row else 0
        await conn.execute(
            """
            INSERT INTO credit_transactions
            (id, user_id, transaction_type, amount, balance_after, description, reference_type, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'api_request', ?, datetime('now'))
            """,
            (
                uuid.uuid4().hex,
                user_id,
                transaction_type,
                -cost,
                new_balance,
                f"Developer API {label}",
                '{"source":"developer-api"}',
            ),
        )
        await conn.commit()
        return new_balance
    finally:
        await conn.close()


async def _deduct_voice_save_credits(user_id: str, label: str) -> int:
    """Deduct the per-save voice fee atomically.

    Voice saves are free on the website. Charging via the API (20 cr)
    keeps script-spam saves from polluting users' voice lists. Returns
    the new balance; raises 402 with current balance if insufficient.
    """
    cost = max(0, int(API_VOICE_SAVE_CREDITS))
    if cost == 0:
        return -1  # billing disabled
    conn = await get_db()
    try:
        row = await (await conn.execute(
            "SELECT credits FROM auth_users WHERE id = ?", (user_id,)
        )).fetchone()
        balance = int(row["credits"] or 0) if row else 0
        if balance < cost:
            raise HTTPException(
                status_code=402,
                detail=f"Saving a voice via the API costs {cost} credits. You have {balance}.",
            )
        cur = await conn.execute(
            "UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') "
            "WHERE id = ? AND credits >= ?",
            (cost, user_id, cost),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=402, detail="Insufficient credits.")
        new_row = await (await conn.execute(
            "SELECT credits FROM auth_users WHERE id = ?", (user_id,)
        )).fetchone()
        new_balance = int(new_row["credits"] or 0) if new_row else 0
        # Record a transaction row so the user sees this in their billing
        # history. Reference type matches the table the voice lands in.
        await conn.execute(
            """
            INSERT INTO credit_transactions
            (id, user_id, transaction_type, amount, balance_after, description, reference_type, metadata_json, created_at)
            VALUES (?, ?, 'api_voice_save', ?, ?, ?, 'studio_user_designed_voices', ?, datetime('now'))
            """,
            (
                uuid.uuid4().hex,
                user_id,
                -cost,
                new_balance,
                f"Developer API voice save ({label})",
                '{"source":"developer-api"}',
            ),
        )
        await conn.commit()
        return new_balance
    finally:
        await conn.close()


router = APIRouter()


async def _reindex_agent_knowledge(agent_id: str, knowledge: str) -> None:
    """Trigger RAG re-indexing for an agent's knowledge field.

    Imports the dashboard-backend's ``agent_knowledge`` module on
    first call. Both services share the same SQLite DB and live on
    the same box, so an in-process call is correct and avoids a
    double-write or a brand-new HTTP endpoint just for this.
    """
    import sys
    from pathlib import Path

    dashboard_root = Path(__file__).resolve().parents[3].parent / "dashboard-backend"
    if str(dashboard_root) not in sys.path:
        sys.path.insert(0, str(dashboard_root))
    import agent_knowledge  # type: ignore
    await agent_knowledge.index_agent_knowledge(agent_id, knowledge)


# Default tags for the entire file's routes; individual routes override
# below where they belong to a different group (voices vs agents vs tools).


# ============================================================================
# Helpers
# ============================================================================


async def _verify_agent_ownership(agent_id: str, user_id: str) -> dict:
    """Return the agent row or raise 404 if missing / not owned."""
    conn = await get_db()
    try:
        row = await (
            await conn.execute(
                "SELECT * FROM agents WHERE id = ? AND user_id = ?",
                (agent_id, user_id),
            )
        ).fetchone()
    finally:
        await conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Agent not found")
    return dict(row)


def _agent_row_to_response(row: dict) -> dict:
    """Project a DB row into the public agent shape."""
    try:
        cfg = json.loads(row["config_json"] or "{}")
    except json.JSONDecodeError:
        cfg = {}
    return {
        "id": row["id"],
        "type": row["type"],
        "status": row["status"] or "draft",
        "name": row["name"] or "",
        "config": {
            "purpose": cfg.get("purpose") or "",
            "system_prompt": cfg.get("system_prompt") or "",
            "knowledge": cfg.get("knowledge") or "",
            "voice": cfg.get("voice") or None,
            "language": cfg.get("language") or None,
            "llm_model": cfg.get("llm_model") or None,
            "temperature": cfg.get("temperature") if cfg.get("temperature") is not None else 0.6,
            "enabled_tools": cfg.get("enabled_tools") or None,
            "first_message": cfg.get("first_message") if isinstance(cfg.get("first_message"), str) else None,
            "goal": cfg.get("goal") or None,
            "success_metric": cfg.get("success_metric") or None,
            "max_iterations": cfg.get("max_iterations") or None,
            # Voice-pipeline knobs.
            "denoise_enabled": bool(cfg.get("denoise_enabled", False)),
            "turn_decider": cfg.get("turn_decider") or "ultravad",
            "ultravad_threshold": (
                float(cfg.get("ultravad_threshold"))
                if cfg.get("ultravad_threshold") is not None else 0.50
            ),
            "min_delay_ms": cfg.get("min_delay_ms"),
            "record_enabled": bool(cfg.get("record_enabled", False)),
        },
        "created_at": row["created_at"] or "",
        "updated_at": row["updated_at"] or "",
        "last_run_at": row["last_run_at"],
        "run_count": int(row["run_count"] or 0),
    }


# ============================================================================
# Schemas
# ============================================================================


class AgentCreateIn(BaseModel):
    """Create a new agent. The minimum is ``name`` + ``type``;
    everything else can be PATCHed later."""

    name: str = Field(
        min_length=1,
        max_length=120,
        description="Display name. 1–120 chars.",
    )
    type: Literal["knowledge", "goal"] = Field(
        description=(
            "`knowledge` for a voice-chat agent (responds to user turns) "
            "or `goal` for an autonomous run loop (drives toward a stated "
            "goal until success_metric is met or max_iterations is hit)."
        ),
    )
    purpose: Optional[str] = Field(
        default=None,
        max_length=1000,
        description="Short one-line purpose, surfaced in the LLM system prompt.",
    )
    system_prompt: Optional[str] = Field(
        default=None,
        max_length=12000,
        description="Full system prompt. Up to 12,000 characters.",
    )
    knowledge: Optional[str] = Field(
        default=None,
        max_length=200_000,
        description=(
            "Free-form knowledge text indexed for RAG retrieval. Up to "
            "200,000 characters. Re-indexed on every change."
        ),
    )
    voice: Optional[str] = Field(
        default=None,
        max_length=64,
        description=(
            "Sample voice id (e.g. `voc-atlas`), designed-voice id "
            "(`dv:<id>`), or `null` to use the platform default. See "
            "GET /v1/voices/builtin and GET /v1/voices."
        ),
    )
    language: Optional[AGENT_LANGUAGE] = Field(
        default=None,
        description="Spoken language. Must be one of the canonical names below.",
    )
    llm_model: Optional[str] = Field(
        default=None,
        max_length=128,
        description=(
            "Provider-prefixed model id (e.g. `groq:llama-3.3-70b-versatile`). "
            "Omit for the default model."
        ),
    )
    temperature: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=2.0,
        description="LLM sampling temperature. 0.0–2.0. Defaults to 0.6 server-side.",
    )
    enabled_tools: Optional[list[AGENT_TOOL]] = Field(
        default=None,
        max_length=16,
        description=(
            "Built-in tools the agent is allowed to call. Pass `null` "
            "(omit) for ALL available tools; pass an empty `[]` to "
            "disable tool use entirely."
        ),
    )
    first_message: Optional[str] = Field(
        default=None,
        max_length=500,
        description=(
            "Greeting the agent speaks when a session opens, before the "
            "user has said anything. Empty string or null = silent start. "
            "Max 500 characters. Industry pattern: matches Vapi "
            "`firstMessage`, Retell `begin_message`, Eleven `first_message`."
        ),
    )
    # Goal-agent fields. Ignored for type='knowledge'.
    goal: Optional[str] = Field(
        default=None,
        max_length=2000,
        description="What the agent should achieve. Only used for `type='goal'`.",
    )
    success_metric: Optional[str] = Field(
        default=None,
        max_length=2000,
        description="How the agent knows it succeeded. Only used for `type='goal'`.",
    )
    max_iterations: Optional[int] = Field(
        default=None,
        ge=1,
        le=50,
        description="Hard upper bound on agent loop iterations (1–50).",
    )
    # ── Voice-pipeline knobs ─────────────────────────────────────────
    denoise_enabled: Optional[bool] = Field(
        default=None,
        description=(
            "Insert DeepFilterNet 3 denoise upstream of STT + UltraVAD. "
            "Off by default (adds ~200 ms passthrough latency). Turn on "
            "for agents that expect noisy mics (call-center, mobile-in-public)."
        ),
    )
    turn_decider: Optional[Literal["ultravad", "fusion"]] = Field(
        default=None,
        description=(
            "Primary end-of-turn detector. `ultravad` (default) uses the "
            "UltraVAD pod's prosody model; `fusion` uses Smart-Turn + "
            "LiveKit. Falls back automatically when the configured pod "
            "is offline."
        ),
    )
    ultravad_threshold: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description=(
            "UltraVAD end-of-turn probability threshold (0.0–1.0). "
            "Lower = snappier turn-taking; higher = more patient. "
            "Default 0.50."
        ),
    )
    min_delay_ms: Optional[int] = Field(
        default=None,
        ge=200,
        le=2000,
        description=(
            "Minimum silence (ms) before commit, regardless of model "
            "confidence. Default 500 (server). Bump to 800–1000 for "
            "agents whose users pause mid-thought a lot."
        ),
    )
    record_enabled: Optional[bool] = Field(
        default=None,
        description=(
            "Record both legs of every call to a stereo WAV "
            "(left=user, right=agent). Off by default. When on, "
            "recordings appear under GET /v1/agents/{id}/calls."
        ),
    )


class AgentPatchIn(BaseModel):
    """Partial update. Any omitted field is left as-is. Pass ``null``
    on an explicit field to clear it (e.g. unset the agent's voice)."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    status: Optional[Literal["draft", "active", "paused", "archived"]] = Field(
        default=None,
        description="Lifecycle state. One of: draft, active, paused, archived.",
    )
    purpose: Optional[str] = Field(default=None, max_length=1000)
    system_prompt: Optional[str] = Field(default=None, max_length=12000)
    knowledge: Optional[str] = Field(default=None, max_length=200_000, description="Re-indexed for RAG when changed.")
    voice: Optional[str] = Field(default=None, max_length=64)
    language: Optional[AGENT_LANGUAGE] = Field(default=None)
    llm_model: Optional[str] = Field(default=None, max_length=128)
    temperature: Optional[float] = Field(default=None, ge=0.0, le=2.0)
    enabled_tools: Optional[list[AGENT_TOOL]] = Field(
        default=None,
        max_length=16,
        description="`null` = all tools, `[]` = no tools, otherwise the subset to allow.",
    )
    first_message: Optional[str] = Field(
        default=None,
        max_length=500,
        description=(
            "Greeting the agent speaks at session start. "
            "Pass empty string `\"\"` to clear and start silent."
        ),
    )
    goal: Optional[str] = Field(default=None, max_length=2000)
    success_metric: Optional[str] = Field(default=None, max_length=2000)
    max_iterations: Optional[int] = Field(default=None, ge=1, le=50)
    # Voice-pipeline knobs (see AgentCreateIn for descriptions).
    denoise_enabled: Optional[bool] = Field(default=None)
    turn_decider: Optional[Literal["ultravad", "fusion"]] = Field(default=None)
    ultravad_threshold: Optional[float] = Field(default=None, ge=0.0, le=1.0)
    min_delay_ms: Optional[int] = Field(default=None, ge=200, le=2000)
    record_enabled: Optional[bool] = Field(default=None)


class CustomToolCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=64, pattern=r"^[a-zA-Z0-9_-]+$")
    description: str = Field(min_length=1, max_length=2000)
    parameters: dict = Field(description="JSON Schema for the tool's arguments. Use {type:'object',properties:{}} for no args.")
    endpoint_url: str = Field(min_length=8, max_length=2048)
    method: str = Field(default="POST", description="HTTP method.")
    auth_type: str = Field(default="none", description="'none' | 'bearer' | 'header'")
    auth_header_name: Optional[str] = Field(default=None, max_length=128)
    auth_secret: Optional[str] = Field(default=None, max_length=4096)
    timeout_ms: int = Field(default=5000, ge=1000, le=30000)


class CustomToolPatchIn(BaseModel):
    description: Optional[str] = Field(default=None, max_length=2000)
    parameters: Optional[dict] = None
    endpoint_url: Optional[str] = Field(default=None, max_length=2048)
    method: Optional[str] = None
    auth_type: Optional[str] = None
    auth_header_name: Optional[str] = Field(default=None, max_length=128)
    auth_secret: Optional[str] = Field(default=None, max_length=4096)
    timeout_ms: Optional[int] = Field(default=None, ge=1000, le=30000)


class VoiceDesignPreviewIn(BaseModel):
    voice_description: str = Field(
        min_length=4,
        max_length=600,
        description=(
            "Describe the voice you want — tone, age, accent, mood. "
            "The server runs an LLM that drafts a short sample script "
            "and synthesizes TWO variants ('original' uses your "
            "description verbatim; 'revised' uses the LLM's polished "
            "version). Pick the one you like and POST to "
            "/v1/voice/design/save with the returned `preview_token`."
        ),
    )


class VoiceDesignSaveIn(BaseModel):
    preview_token: str
    # The API only ever returns the "original" preview variant (see
    # /v1/voice/design/preview) so this defaults to 'original' and is
    # safe to omit. Field kept for forward-compat in case a multi-
    # variant API surface is added later.
    chosen_variant: str = Field(default="original", description="'original' (default) or 'revised'")
    display_name: str = Field(min_length=1, max_length=20)


class VoiceSpeakIn(BaseModel):
    text: str = Field(
        min_length=1,
        max_length=2000,
        description="Text to speak in the saved voice. Up to 2,000 characters.",
    )
    language: Optional[str] = Field(
        default=None,
        description="Language hint for synthesis. Auto-detected when omitted.",
    )


# ============================================================================
# Agent CRUD
# ============================================================================


@router.get("/v1/agents", tags=["Agents"], summary="List your agents (id + name only)")
async def list_agents(auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Compact index of every agent owned by the API key's user. Returns
    only ``id`` and ``name`` so the list stays small. Call
    ``GET /v1/agents/{id}`` for the full spec of a specific agent."""
    user_id = auth_ctx["user_id"]
    conn = await get_db()
    try:
        rows = await (
            await conn.execute(
                "SELECT id, name FROM agents WHERE user_id = ? ORDER BY datetime(updated_at) DESC LIMIT 200",
                (user_id,),
            )
        ).fetchall()
    finally:
        await conn.close()
    return {"agents": [{"id": r["id"], "name": r["name"] or ""} for r in rows]}


@router.get("/v1/agents/{agent_id}", tags=["Agents"], summary="Get an agent by id (full spec incl. bound tools)")
async def get_agent(agent_id: str, auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Full agent spec. Returns:
    - All ``config`` fields (purpose, system prompt, knowledge, voice,
      language, model, temperature, enabled built-in tools, goal-mode
      params).
    - ``custom_tools``: every user-defined webhook tool bound to this
      agent, with its full definition (URL, method, JSON-schema
      parameters, auth header, timeout) so a single call gives a
      caller everything they need to know about how this agent
      behaves at runtime.
    """
    user_id = auth_ctx["user_id"]
    row = await _verify_agent_ownership(agent_id, user_id)
    conn = await get_db()
    try:
        tool_rows = await (
            await conn.execute(
                """
                SELECT t.* FROM agent_custom_tool_bindings b
                JOIN agent_custom_tools t ON t.id = b.tool_id
                WHERE b.agent_id = ? AND t.user_id = ?
                ORDER BY t.name ASC
                """,
                (agent_id, user_id),
            )
        ).fetchall()
    finally:
        await conn.close()
    agent = _agent_row_to_response(row)
    agent["custom_tools"] = [_tool_row_to_response(dict(t)) for t in tool_rows]
    return {"agent": agent}


@router.post("/v1/agents", status_code=201, tags=["Agents"], summary="Create a new agent")
async def create_agent(body: AgentCreateIn, auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Create a new agent. ``type`` must be 'knowledge' or 'goal'."""
    if body.type not in ("knowledge", "goal"):
        raise HTTPException(status_code=400, detail="type must be 'knowledge' or 'goal'")
    user_id = auth_ctx["user_id"]
    cfg = {
        "purpose": body.purpose or "",
        "system_prompt": body.system_prompt or "",
        "knowledge": body.knowledge or "",
        "voice": body.voice,
        "language": body.language,
        "llm_model": body.llm_model,
        "temperature": body.temperature if body.temperature is not None else 0.6,
        "enabled_tools": body.enabled_tools,
        "first_message": body.first_message if body.first_message is not None else "",
        "goal": body.goal,
        "success_metric": body.success_metric,
        "max_iterations": body.max_iterations,
        # Voice-pipeline knobs. Omitted ⇒ defaults applied by the
        # voicechat router at session-open time.
        "denoise_enabled": bool(body.denoise_enabled) if body.denoise_enabled is not None else False,
        "turn_decider": body.turn_decider or "ultravad",
        "ultravad_threshold": (
            float(body.ultravad_threshold) if body.ultravad_threshold is not None else 0.50
        ),
        "min_delay_ms": body.min_delay_ms,
        "record_enabled": bool(body.record_enabled) if body.record_enabled is not None else False,
    }
    agent_id = uuid.uuid4().hex
    conn = await get_db()
    try:
        await conn.execute(
            """
            INSERT INTO agents (id, user_id, type, status, name, config_json, created_at, updated_at, run_count)
            VALUES (?, ?, ?, 'draft', ?, ?, datetime('now'), datetime('now'), 0)
            """,
            (agent_id, user_id, body.type, body.name.strip(), json.dumps(cfg)),
        )
        await conn.commit()
        row = await (await conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,))).fetchone()
    finally:
        await conn.close()

    # Index knowledge on create so retrieval works on the very first call.
    if (body.knowledge or "").strip():
        try:
            await _reindex_agent_knowledge(agent_id, body.knowledge or "")
        except Exception:
            pass

    return {"agent": _agent_row_to_response(dict(row))}


@router.patch("/v1/agents/{agent_id}", tags=["Agents"], summary="Update agent fields (name / status / voice / model / knowledge / tools / goal)")
async def patch_agent(agent_id: str, body: AgentPatchIn, auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Update one or more agent fields. Omitted fields stay as-is.
    ``status`` accepts 'draft' | 'active' | 'paused' | 'archived'."""
    row = await _verify_agent_ownership(agent_id, auth_ctx["user_id"])
    try:
        cfg = json.loads(row["config_json"] or "{}")
    except json.JSONDecodeError:
        cfg = {}
    if body.status is not None and body.status not in ("draft", "active", "paused", "archived"):
        raise HTTPException(status_code=400, detail="invalid status")

    old_knowledge = (cfg.get("knowledge") or "").strip()

    config_fields = {
        "purpose": body.purpose,
        "system_prompt": body.system_prompt,
        "knowledge": body.knowledge,
        "voice": body.voice,
        "language": body.language,
        "llm_model": body.llm_model,
        "temperature": body.temperature,
        "enabled_tools": body.enabled_tools,
        "first_message": body.first_message,
        "goal": body.goal,
        "success_metric": body.success_metric,
        "max_iterations": body.max_iterations,
        # Voice-pipeline knobs.
        "denoise_enabled": body.denoise_enabled,
        "turn_decider": body.turn_decider,
        "ultravad_threshold": body.ultravad_threshold,
        "min_delay_ms": body.min_delay_ms,
        "record_enabled": body.record_enabled,
    }
    # ``first_message`` is special: callers pass an empty string to
    # clear the greeting (start silent) and ``null`` to leave it
    # alone. The ``v is not None`` filter below correctly preserves
    # that semantic — empty string passes through.
    for k, v in config_fields.items():
        if v is not None:
            cfg[k] = v

    new_knowledge = (cfg.get("knowledge") or "").strip()
    knowledge_changed = new_knowledge != old_knowledge

    sets: list[str] = ["config_json = ?", "updated_at = datetime('now')"]
    params: list[Any] = [json.dumps(cfg)]
    if body.name is not None:
        sets.append("name = ?")
        params.append(body.name.strip())
    if body.status is not None:
        sets.append("status = ?")
        params.append(body.status)
    params.append(agent_id)

    conn = await get_db()
    try:
        await conn.execute(f"UPDATE agents SET {', '.join(sets)} WHERE id = ?", params)
        await conn.commit()
        updated = await (await conn.execute("SELECT * FROM agents WHERE id = ?", (agent_id,))).fetchone()
    finally:
        await conn.close()

    # Re-index RAG chunks when knowledge text changes so retrieval
    # stays in sync. Studio's PATCH does the same — without this, an
    # API caller's knowledge update is saved but not searchable.
    if knowledge_changed:
        try:
            await _reindex_agent_knowledge(agent_id, new_knowledge)
        except Exception:
            # Re-index is best-effort — agent is still saved and usable.
            pass

    return {"agent": _agent_row_to_response(dict(updated))}


@router.delete("/v1/agents/{agent_id}", tags=["Agents"], summary="Delete an agent")
async def delete_agent(agent_id: str, auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Delete an agent. Cascades to its bound tools and run history."""
    await _verify_agent_ownership(agent_id, auth_ctx["user_id"])
    conn = await get_db()
    try:
        await conn.execute("DELETE FROM agents WHERE id = ? AND user_id = ?", (agent_id, auth_ctx["user_id"]))
        await conn.commit()
    finally:
        await conn.close()
    return {"ok": True}


# ============================================================================
# Call history (recordings + transcripts for one agent's past calls)
# ============================================================================


def _range_to_days(spec: str) -> int:
    """Parse `7d`, `30d`, `90d` etc. into integer days. Defaults to 30
    on malformed input. Mirrors the dashboard route's parser so the
    behavior is identical."""
    s = (spec or "30d").strip().lower()
    if s.endswith("d") and s[:-1].isdigit():
        days = int(s[:-1])
    elif s.isdigit():
        days = int(s)
    else:
        days = 30
    return max(1, min(days, 365))


@router.get(
    "/v1/agents/{agent_id}/calls",
    tags=["Call History"],
    summary="List recent voice calls for an agent",
)
async def list_agent_calls(
    agent_id: str,
    range: str = "30d",
    limit: int = 100,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Recent calls for one agent, newest first. `range` accepts
    `7d` / `30d` / `90d` (max `365d`). `limit` is capped at 500.

    Each call row carries `has_recording`; if true, fetch the audio
    via `GET /v1/agents/{agent_id}/calls/{session_id}/recording`
    (returns a presigned URL) and the turn-by-turn transcript via
    `GET /v1/agents/{agent_id}/calls/{session_id}/transcript`.

    Recording availability requires the agent's `record_enabled` was
    on for the call. Recordings are retained 30 days by default,
    after which `has_recording` flips to false even though the
    `voice_call_logs` row stays for analytics."""
    user_id = auth_ctx["user_id"]
    await _verify_agent_ownership(agent_id, user_id)
    days = _range_to_days(range)
    limit = max(1, min(int(limit), 500))
    conn = await get_db()
    try:
        rows = await (await conn.execute(
            """
            SELECT session_id, started_at, ended_at, duration_ms, end_reason,
                   turn_count, user_chars, agent_chars, recording_path,
                   recording_bytes
            FROM voice_call_logs
            WHERE agent_id = ?
              AND started_at >= datetime('now', ?)
            ORDER BY started_at DESC
            LIMIT ?
            """,
            (agent_id, f"-{days} days", limit),
        )).fetchall()
    finally:
        await conn.close()
    calls = [
        {
            "session_id": r[0],
            "started_at": r[1],
            "ended_at": r[2],
            "duration_ms": int(r[3] or 0),
            "end_reason": r[4] or "unknown",
            "turn_count": int(r[5] or 0),
            "user_chars": int(r[6] or 0),
            "agent_chars": int(r[7] or 0),
            "has_recording": bool(r[8]),
            "recording_bytes": int(r[9]) if r[9] is not None else None,
        }
        for r in rows
    ]
    return {"calls": calls, "range": f"{days}d", "limit": limit}


@router.get(
    "/v1/agents/{agent_id}/calls/{session_id}/transcript",
    tags=["Call History"],
    summary="Get the per-turn transcript for one call",
)
async def get_call_transcript(
    agent_id: str,
    session_id: str,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Per-turn transcript for one call. Each turn carries an
    `at_ms` offset relative to the call's `started_at`, so a player
    UI can seek to the exact moment of a turn.

    Response shape:
        {
          "session_id": "...",
          "agent_id": "...",
          "turns": [
            {"role": "user", "text": "...", "at_ms": 1230},
            {"role": "assistant", "text": "...", "at_ms": 1230},
            ...
          ]
        }
    """
    user_id = auth_ctx["user_id"]
    await _verify_agent_ownership(agent_id, user_id)
    conn = await get_db()
    try:
        rows = await (await conn.execute(
            """
            SELECT
                t.user_text,
                t.bot_text,
                CAST(
                    (julianday(t.created_at) - julianday(c.started_at)) * 86400000
                    AS INTEGER
                ) AS at_ms
            FROM voice_call_logs c
            JOIN studio_voicechat_history t ON t.session_id = c.session_id
            WHERE c.session_id = ? AND c.agent_id = ? AND c.user_id = ?
            ORDER BY t.id ASC
            """,
            (session_id, agent_id, user_id),
        )).fetchall()
        if not rows:
            owned = await (await conn.execute(
                "SELECT 1 FROM voice_call_logs "
                "WHERE session_id = ? AND agent_id = ? AND user_id = ?",
                (session_id, agent_id, user_id),
            )).fetchone()
            if not owned:
                raise HTTPException(status_code=404, detail="call not found")
    finally:
        await conn.close()
    turns: list[dict] = []
    for r in rows:
        user_text = (r[0] or "").strip()
        bot_text = (r[1] or "").strip()
        at_ms = int(r[2] or 0)
        if user_text:
            turns.append({"role": "user", "text": user_text, "at_ms": at_ms})
        if bot_text:
            turns.append({"role": "assistant", "text": bot_text, "at_ms": at_ms})
    return {"session_id": session_id, "agent_id": agent_id, "turns": turns}


@router.get(
    "/v1/agents/{agent_id}/calls/{session_id}/recording",
    tags=["Call History"],
    summary="Get a presigned URL for one call's stereo WAV recording",
)
async def get_call_recording_url(
    agent_id: str,
    session_id: str,
    download: bool = False,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Returns `{"url": "<presigned R2 URL>", "expires_in": 3600}`.
    The URL is signed for 1 hour. Stream the WAV directly from R2;
    no auth needed on that GET.

    The WAV is stereo 16 kHz s16le: left channel = user mic post-
    denoise (the bytes STT actually heard), right channel = agent
    TTS output. Both channels share a single timeline so playback
    aligns 1:1 with what each side experienced.

    Set `download=true` to get a URL with a
    `Content-Disposition: attachment; filename={session_id}.wav`
    response header (triggers the save dialog instead of inline
    playback). 404 if the call has no recording (either the
    agent's `record_enabled` was off, or the 30-day retention
    sweep already removed it).
    """
    user_id = auth_ctx["user_id"]
    await _verify_agent_ownership(agent_id, user_id)
    conn = await get_db()
    try:
        row = await (await conn.execute(
            """
            SELECT recording_bucket, recording_path
            FROM voice_call_logs
            WHERE session_id = ? AND agent_id = ? AND user_id = ?
            """,
            (session_id, agent_id, user_id),
        )).fetchone()
    finally:
        await conn.close()
    if not row or not row[0] or not row[1]:
        raise HTTPException(status_code=404, detail="recording not found")
    bucket, key = str(row[0]), str(row[1])
    # Late import — keeps the developer-api cold-start lean for
    # deployments that don't use call recordings.
    from studio_tts_service import presigned_call_recording_url
    url = presigned_call_recording_url(
        bucket,
        key,
        expires_seconds=3600,
        download_filename=f"{session_id}.wav" if download else None,
    )
    if not url:
        raise HTTPException(status_code=502, detail="object store unavailable")
    return {"url": url, "expires_in": 3600}


@router.delete(
    "/v1/agents/{agent_id}/calls/{session_id}/recording",
    tags=["Call History"],
    summary="Delete one call's recording",
)
async def delete_call_recording(
    agent_id: str,
    session_id: str,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Immediately purge a call's recording object from object storage
    and NULL the `recording_path` / `recording_bucket` / `recording_bytes`
    columns on its `voice_call_logs` row. The log row itself stays so
    aggregate analytics don't shift retroactively.

    Idempotent: returns `{"deleted": false}` when the recording was
    already gone (never created or already swept)."""
    import asyncio
    user_id = auth_ctx["user_id"]
    await _verify_agent_ownership(agent_id, user_id)
    conn = await get_db()
    try:
        row = await (await conn.execute(
            """
            SELECT recording_bucket, recording_path FROM voice_call_logs
            WHERE session_id = ? AND agent_id = ? AND user_id = ?
            """,
            (session_id, agent_id, user_id),
        )).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="call not found")
        bucket = row[0]
        key = row[1]
        already_gone = bucket is None or key is None
        if not already_gone:
            from studio_tts_service import delete_call_recording_object
            ok = await asyncio.to_thread(
                delete_call_recording_object, str(bucket), str(key),
            )
            if not ok:
                raise HTTPException(
                    status_code=502,
                    detail="object store unavailable; try again",
                )
            await conn.execute(
                """
                UPDATE voice_call_logs
                SET recording_path = NULL,
                    recording_bucket = NULL,
                    recording_bytes = NULL
                WHERE session_id = ?
                """,
                (session_id,),
            )
            await conn.commit()
        return {"deleted": not already_gone}
    finally:
        await conn.close()


# ============================================================================
# Agent ⇄ tools (binding only; tool CRUD is below)
# ============================================================================


@router.get("/v1/agents/{agent_id}/tools", tags=["Custom Tools"], summary="List tools bound to this agent")
async def list_agent_tools(agent_id: str, auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Custom tools currently bound to this agent. The LLM sees these
    in addition to any built-ins the agent has enabled."""
    user_id = auth_ctx["user_id"]
    await _verify_agent_ownership(agent_id, user_id)
    conn = await get_db()
    try:
        rows = await (
            await conn.execute(
                """
                SELECT t.* FROM agent_custom_tool_bindings b
                JOIN agent_custom_tools t ON t.id = b.tool_id
                WHERE b.agent_id = ? AND t.user_id = ?
                ORDER BY t.name ASC
                """,
                (agent_id, user_id),
            )
        ).fetchall()
    finally:
        await conn.close()
    return {"tools": [_tool_row_to_response(dict(r)) for r in rows]}


@router.post("/v1/agents/{agent_id}/tools/{tool_id}", status_code=201, tags=["Custom Tools"], summary="Bind a custom tool to an agent (idempotent)")
async def bind_tool_to_agent(agent_id: str, tool_id: str, auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Make a custom tool callable by this agent. Idempotent."""
    user_id = auth_ctx["user_id"]
    await _verify_agent_ownership(agent_id, user_id)
    conn = await get_db()
    try:
        tool = await (
            await conn.execute(
                "SELECT id FROM agent_custom_tools WHERE id = ? AND user_id = ?", (tool_id, user_id)
            )
        ).fetchone()
        if not tool:
            raise HTTPException(status_code=404, detail="Custom tool not found")
        await conn.execute(
            "INSERT OR IGNORE INTO agent_custom_tool_bindings (agent_id, tool_id) VALUES (?, ?)",
            (agent_id, tool_id),
        )
        await conn.commit()
    finally:
        await conn.close()
    return {"ok": True}


@router.delete("/v1/agents/{agent_id}/tools/{tool_id}", tags=["Custom Tools"], summary="Unbind a custom tool from an agent")
async def unbind_tool_from_agent(agent_id: str, tool_id: str, auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Detach a custom tool from this agent. The tool itself is not deleted."""
    user_id = auth_ctx["user_id"]
    await _verify_agent_ownership(agent_id, user_id)
    conn = await get_db()
    try:
        await conn.execute(
            "DELETE FROM agent_custom_tool_bindings WHERE agent_id = ? AND tool_id = ?",
            (agent_id, tool_id),
        )
        await conn.commit()
    finally:
        await conn.close()
    return {"ok": True}


# ============================================================================
# Custom tools (user-defined webhook tools)
# ============================================================================


def _tool_row_to_response(row: dict) -> dict:
    """Project the DB row. ``auth_secret`` is redacted — once set, the
    server-stored value never round-trips back to clients."""
    try:
        params = json.loads(row["parameters_json"] or "{}")
    except json.JSONDecodeError:
        params = {"type": "object", "properties": {}}
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"] or "",
        "parameters": params,
        "endpoint_url": row["endpoint_url"],
        "method": row["method"] or "POST",
        "auth_type": row["auth_type"] or "none",
        "auth_header_name": row["auth_header_name"],
        "has_secret": bool(row["auth_secret"]),
        "timeout_ms": int(row["timeout_ms"] or 5000),
        "created_at": row["created_at"] or "",
        "updated_at": row["updated_at"] or "",
    }


@router.get("/v1/agent-tools", tags=["Custom Tools"], summary="List your custom webhook tools")
async def list_custom_tools(auth_ctx: dict = Depends(require_api_key)) -> dict:
    """List every custom webhook tool the user has created."""
    conn = await get_db()
    try:
        rows = await (
            await conn.execute(
                "SELECT * FROM agent_custom_tools WHERE user_id = ? ORDER BY datetime(created_at) DESC LIMIT 200",
                (auth_ctx["user_id"],),
            )
        ).fetchall()
    finally:
        await conn.close()
    return {"tools": [_tool_row_to_response(dict(r)) for r in rows]}


@router.get("/v1/agent-tools/{tool_id}", tags=["Custom Tools"], summary="Get a custom tool by id")
async def get_custom_tool(tool_id: str, auth_ctx: dict = Depends(require_api_key)) -> dict:
    conn = await get_db()
    try:
        row = await (
            await conn.execute(
                "SELECT * FROM agent_custom_tools WHERE id = ? AND user_id = ?",
                (tool_id, auth_ctx["user_id"]),
            )
        ).fetchone()
    finally:
        await conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Custom tool not found")
    return {"tool": _tool_row_to_response(dict(row))}


@router.post("/v1/agent-tools", status_code=201, tags=["Custom Tools"], summary="Register a custom webhook tool")
async def create_custom_tool(body: CustomToolCreateIn, auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Register a webhook tool. The agent calls your endpoint with
    ``{ "arguments": <validated args> }`` as the POST body (or query
    params for GET). Use ``auth_type='bearer'`` + ``auth_secret`` to
    have us inject ``Authorization: Bearer <secret>``."""
    if body.method.upper() not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
        raise HTTPException(status_code=400, detail="Unsupported HTTP method")
    if body.auth_type not in ("none", "bearer", "header"):
        raise HTTPException(status_code=400, detail="auth_type must be none/bearer/header")
    # SSRF gate is enforced server-side; we let the dashboard-backend
    # validator do the heavy lifting on a `test` call rather than
    # duplicating the network checks here. Schema sanity is enough on save.
    tool_id = uuid.uuid4().hex
    conn = await get_db()
    try:
        try:
            await conn.execute(
                """
                INSERT INTO agent_custom_tools
                  (id, user_id, name, description, parameters_json, endpoint_url, method,
                   auth_type, auth_header_name, auth_secret, timeout_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tool_id,
                    auth_ctx["user_id"],
                    body.name.strip(),
                    body.description.strip(),
                    json.dumps(body.parameters),
                    body.endpoint_url.strip(),
                    body.method.upper(),
                    body.auth_type,
                    body.auth_header_name,
                    body.auth_secret,
                    body.timeout_ms,
                ),
            )
            await conn.commit()
        except Exception as exc:
            if "UNIQUE" in str(exc).upper():
                raise HTTPException(status_code=409, detail=f"You already have a tool named '{body.name}'")
            raise
        row = await (await conn.execute("SELECT * FROM agent_custom_tools WHERE id = ?", (tool_id,))).fetchone()
    finally:
        await conn.close()
    return {"tool": _tool_row_to_response(dict(row))}


@router.patch("/v1/agent-tools/{tool_id}", tags=["Custom Tools"], summary="Update a custom tool (URL, schema, auth, etc.)")
async def patch_custom_tool(
    tool_id: str, body: CustomToolPatchIn, auth_ctx: dict = Depends(require_api_key)
) -> dict:
    """Partial update. Pass empty string in ``auth_secret`` to clear it."""
    user_id = auth_ctx["user_id"]
    conn = await get_db()
    try:
        row = await (
            await conn.execute(
                "SELECT id FROM agent_custom_tools WHERE id = ? AND user_id = ?",
                (tool_id, user_id),
            )
        ).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Custom tool not found")

        sets: list[str] = []
        params: list[Any] = []
        if body.description is not None:
            sets.append("description = ?")
            params.append(body.description.strip())
        if body.parameters is not None:
            sets.append("parameters_json = ?")
            params.append(json.dumps(body.parameters))
        if body.endpoint_url is not None:
            sets.append("endpoint_url = ?")
            params.append(body.endpoint_url.strip())
        if body.method is not None:
            if body.method.upper() not in ("GET", "POST", "PUT", "PATCH", "DELETE"):
                raise HTTPException(status_code=400, detail="Unsupported HTTP method")
            sets.append("method = ?")
            params.append(body.method.upper())
        if body.auth_type is not None:
            if body.auth_type not in ("none", "bearer", "header"):
                raise HTTPException(status_code=400, detail="auth_type must be none/bearer/header")
            sets.append("auth_type = ?")
            params.append(body.auth_type)
        if body.auth_header_name is not None:
            sets.append("auth_header_name = ?")
            params.append(body.auth_header_name)
        if body.auth_secret is not None:
            # Empty string = clear, non-empty = replace.
            sets.append("auth_secret = ?")
            params.append(body.auth_secret or None)
        if body.timeout_ms is not None:
            sets.append("timeout_ms = ?")
            params.append(body.timeout_ms)
        if sets:
            sets.append("updated_at = datetime('now')")
            params.append(tool_id)
            await conn.execute(
                f"UPDATE agent_custom_tools SET {', '.join(sets)} WHERE id = ?",
                params,
            )
            await conn.commit()
        updated = await (
            await conn.execute("SELECT * FROM agent_custom_tools WHERE id = ?", (tool_id,))
        ).fetchone()
    finally:
        await conn.close()
    return {"tool": _tool_row_to_response(dict(updated))}


@router.delete("/v1/agent-tools/{tool_id}", tags=["Custom Tools"], summary="Delete a custom tool")
async def delete_custom_tool(tool_id: str, auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Delete a custom tool. Cascades to any agent bindings."""
    conn = await get_db()
    try:
        cur = await conn.execute(
            "DELETE FROM agent_custom_tools WHERE id = ? AND user_id = ?",
            (tool_id, auth_ctx["user_id"]),
        )
        await conn.commit()
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="Custom tool not found")
    finally:
        await conn.close()
    return {"ok": True}


# ============================================================================
# Saved voices (designed + cloned, both live in studio_user_designed_voices)
# ============================================================================


def _voice_row_to_response(row: dict) -> dict:
    return {
        "id": int(row["id"]),
        "display_name": row["display_name"] or "",
        "source": (row["source"] if "source" in row.keys() else "designed") or "designed",
        "ref_script": row["ref_script"] or "",
        "voice_description": row["voice_description"] or "",
        "source_language": (row["source_language"] if "source_language" in row.keys() else None),
        "created_at": row["created_at"] or "",
        "expires_at": row["expires_at"] or "",
    }


@router.get("/v1/voices/builtin", tags=["Voices"], summary="List built-in sample voices")
async def list_builtin_voices(auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Pre-defined voices anyone can use without uploading reference audio.
    Pass any returned ``id`` (e.g. ``voc-atlas``, ``design-aria``) as the
    ``voice`` field on ``POST /v1/tts/generate`` to synthesize in that
    speaker's voice. Catalog is stable; safe to cache client-side."""
    return await call_dashboard(
        "GET",
        "/api/dashboard/studio/builtin-voices",
        user_id=auth_ctx["user_id"],
    )


@router.get("/v1/voices", tags=["Voices"], summary="List your saved voices (designed + cloned)")
async def list_voices(auth_ctx: dict = Depends(require_api_key)) -> dict:
    """List every saved voice (both designed via prompt and uploaded clone references)."""
    conn = await get_db()
    try:
        rows = await (
            await conn.execute(
                """
                SELECT id, display_name, voice_description, ref_script, audio_s3_bucket,
                       audio_s3_key, expires_at, created_at,
                       COALESCE(source, 'designed') AS source, source_language
                FROM studio_user_designed_voices
                WHERE user_id = ?
                ORDER BY datetime(created_at) DESC
                LIMIT 200
                """,
                (auth_ctx["user_id"],),
            )
        ).fetchall()
    finally:
        await conn.close()
    return {"voices": [_voice_row_to_response(dict(r)) for r in rows]}


@router.get("/v1/voices/{voice_id}", tags=["Voices"], summary="Get a saved voice by id")
async def get_voice(voice_id: int, auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Get a single saved voice by id. Use ``id`` (or ``dv:<id>``) as the
    ``voice`` field on agents to make them speak with this voice."""
    conn = await get_db()
    try:
        row = await (
            await conn.execute(
                """
                SELECT id, display_name, voice_description, ref_script, audio_s3_bucket,
                       audio_s3_key, expires_at, created_at,
                       COALESCE(source, 'designed') AS source, source_language
                FROM studio_user_designed_voices
                WHERE id = ? AND user_id = ?
                """,
                (voice_id, auth_ctx["user_id"]),
            )
        ).fetchone()
    finally:
        await conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="Voice not found")
    return {"voice": _voice_row_to_response(dict(row))}


@router.delete("/v1/voices/{voice_id}", tags=["Voices"], summary="Delete a saved voice")
async def delete_voice(voice_id: int, auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Delete a saved voice. The reference audio is removed from storage
    too, so any agent still pointing at this voice will fall back to the
    default at next session."""
    return await call_dashboard(
        "DELETE",
        f"/api/dashboard/studio/voice-design/voices/{voice_id}",
        user_id=auth_ctx["user_id"],
    )


# ============================================================================
# Voice Design — preview + save + clone-save (proxy to dashboard-backend)
# ============================================================================


@router.post("/v1/voice/design/preview", tags=["Voices"], summary="Generate a Voice-Design preview from a text description")
async def voice_design_preview(body: VoiceDesignPreviewIn, auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Generate a voice preview from a text description.

    The pipeline generates two variants internally (one matching the
    exact prompt, one with an LLM-revised version) — but the API only
    returns the FIRST one (``variant_a`` / "original"). That gives
    deterministic API behavior: the same prompt → the same audio
    surfaces, no surprises. Website users see both variants so they
    can A/B test; API consumers don't need that UX, they need a
    predictable single result.

    Returns ``preview_token`` + ``audio_url`` (the first variant) +
    ``voice_description``. Pass the token to ``/v1/voice/design/save``
    to persist this voice for re-use.

    Costs ``API_VOICE_DESIGN_CREDITS`` (default 70) per call. The
    dashboard endpoint detects the internal-trust proxy header and
    skips its own billing, so this is the sole deduction point."""
    from app.core.config import API_VOICE_DESIGN_CREDITS
    await _gate_request(auth_ctx["user_id"])
    # Service-readiness check FIRST so we don't deduct credits on a
    # request we can't fulfill. The previous order pre-charged then
    # 503'd if no model was configured, leaving the user out 70 cr
    # for an outage that wasn't their fault.
    top = await call_dashboard(
        "GET",
        "/api/dashboard/studio/top-models?limit=1",
        user_id=auth_ctx["user_id"],
    )
    models = top.get("models") or top.get("items") or []
    if not models:
        raise HTTPException(status_code=503, detail="No TTS model configured for Voice Design.")
    m = models[0]

    # Now safe to deduct. Once we've confirmed a model is online and
    # have its routing details, the upstream call is highly likely to
    # produce real work.
    cost = max(0, int(API_VOICE_DESIGN_CREDITS))
    new_balance = await _deduct_flat_credits(
        auth_ctx["user_id"], cost, "voice-design preview", "api_voice_design_preview"
    )
    raw = await call_dashboard(
        "POST",
        "/api/dashboard/studio/voice-design/preview",
        user_id=auth_ctx["user_id"],
        json={
            "user_id": auth_ctx["user_id"],
            "voice_description": body.voice_description,
            "miner_hotkey": m.get("miner_hotkey") or "",
            "model_name": m.get("model_name") or "",
            "chute_id": m.get("chute_id") or "",
            "chute_slug": m.get("chute_slug") or "",
        },
        timeout_sec=120.0,
    )
    # Collapse the two-variant response down to a single audio URL —
    # the "original" / variant_a one, matching the user's prompt
    # exactly. The variant key naming is dashboard-side; we accept
    # both ``variant_a`` and a flat ``audio_url`` so this still works
    # if the upstream response shape evolves.
    original_url = (
        raw.get("variant_a")
        or (raw.get("original") or {}).get("audio_url")
        or raw.get("audio_url")
        or ""
    )
    return {
        "preview_token": raw.get("preview_token") or "",
        "audio_url": original_url,
        "voice_description": raw.get("voice_description") or body.voice_description,
        "revised_instruction": raw.get("revised_instruction") or "",
        "credits_used": cost,
        "credits_remaining": new_balance if new_balance >= 0 else raw.get("credits_remaining"),
    }


@router.post("/v1/voice/design/save", status_code=201, tags=["Voices"], summary="Save a Voice-Design preview as a reusable voice")
async def voice_design_save(body: VoiceDesignSaveIn, auth_ctx: dict = Depends(require_api_key)) -> dict:
    """Persist a Voice Design preview into the user's voices.

    Costs an additional save fee (in addition to the preview cost) —
    same fee as the upload-voice flow. The resulting ``voice_id`` is
    then usable on agents and via ``/v1/voices/{id}/speak``."""
    await _gate_request(auth_ctx["user_id"])
    if body.chosen_variant not in ("original", "revised"):
        raise HTTPException(status_code=400, detail="chosen_variant must be 'original' or 'revised'")
    # Charge the save fee BEFORE the proxy call. If the upstream save
    # fails we don't refund — saves are cheap and effectively succeed
    # in practice; building a refund flow for a 20-cr edge case is more
    # mechanism than the cost justifies.
    new_balance = await _deduct_voice_save_credits(auth_ctx["user_id"], "voice-design")
    result = await call_dashboard(
        "POST",
        "/api/dashboard/studio/voice-design/save",
        user_id=auth_ctx["user_id"],
        json={
            "user_id": auth_ctx["user_id"],
            "preview_token": body.preview_token,
            "chosen_variant": body.chosen_variant,
            "display_name": body.display_name,
        },
        timeout_sec=30.0,
    )
    if isinstance(result, dict):
        result["credits_used"] = int(API_VOICE_SAVE_CREDITS)
        if new_balance >= 0:
            result["credits_remaining"] = new_balance
    return result


@router.post("/v1/voice/clone/save", status_code=201, tags=["Voices"], summary="Upload an audio clip, transcribe it, and save as a reusable voice")
async def voice_clone_save(
    display_name: str = Form(
        ...,
        min_length=1,
        max_length=40,
        description="Friendly label for the saved voice. 1–40 chars.",
    ),
    audio_file: UploadFile = File(
        ...,
        description=(
            "Reference audio clip (WAV / MP3 / WebM / M4A / Opus / FLAC). "
            "5–30 s gives best results; hard cap 50 MB."
        ),
    ),
    language: Optional[str] = Form(
        default=None,
        description="Language hint for the reference transcription. Auto-detected if omitted.",
    ),
    reference_text: Optional[str] = Form(
        default=None,
        description=(
            "Optional pre-known transcript of the clip. When provided "
            "the server skips the STT step (faster save, no STT credits)."
        ),
    ),
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Upload a real-voice clip and save it as a reusable voice. We
    transcribe the clip once at save time and store both the audio
    (long retention) and the transcription. Use the returned
    ``voice_id`` anywhere on agents / TTS to speak in this voice."""
    await _gate_request(auth_ctx["user_id"])
    if not audio_file.filename:
        raise HTTPException(status_code=400, detail="audio_file is required")
    raw = await audio_file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Empty audio file")
    form: dict[str, str] = {"display_name": display_name}
    if language:
        form["language"] = language
    if reference_text:
        form["reference_text"] = reference_text
    # Charge the save fee up front (same 20-cr policy as voice-design
    # save). If STT-on-save is needed and runs upstream that's billed
    # separately by the dashboard.
    new_balance = await _deduct_voice_save_credits(auth_ctx["user_id"], "voice-clone")
    result = await call_dashboard(
        "POST",
        "/api/dashboard/studio/voice-design/cloned-voices",
        user_id=auth_ctx["user_id"],
        form=form,
        files=[("audio_file", raw, audio_file.filename, audio_file.content_type or "audio/wav")],
        timeout_sec=90.0,
    )
    if isinstance(result, dict):
        result["credits_used"] = int(API_VOICE_SAVE_CREDITS)
        if new_balance >= 0:
            result["credits_remaining"] = new_balance
    return result


# ============================================================================
# TTS with a saved voice id (proxy to designed-voice/speak)
# ============================================================================


@router.post("/v1/voices/{voice_id}/speak", tags=["Voices"], summary="Synthesize speech using a saved voice id")
async def voice_speak(
    voice_id: int,
    body: VoiceSpeakIn,
    auth_ctx: dict = Depends(require_api_key),
) -> dict:
    """Synthesize ``text`` using a saved voice (either designed or cloned).
    Returns the generated audio URL + presigned expiry.

    Billed per-character at the TTS rate ($10 / 1M chars = 4,000 credits
    / 1M). The dashboard endpoint detects the internal-trust proxy
    header and skips its own (flat per-call) billing, so this is the
    sole deduction point.
    """
    from app.core.config import API_CREDITS_PER_1M_CHARS, API_TTS_CREDITS_PER_REQUEST
    await _gate_request(auth_ctx["user_id"])
    text = (body.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    # Same per-char math as /v1/tts/generate. Operators can pin a flat
    # per-call price via ``API_TTS_CREDITS_PER_REQUEST`` if preferred.
    if int(API_TTS_CREDITS_PER_REQUEST) > 0:
        credits_needed = int(API_TTS_CREDITS_PER_REQUEST)
    else:
        per_million = max(1, int(API_CREDITS_PER_1M_CHARS))
        credits_needed = max(1, (len(text) * per_million + 999_999) // 1_000_000)

    new_balance = await _deduct_voice_speak_credits(auth_ctx["user_id"], credits_needed, voice_id)
    result = await call_dashboard(
        "POST",
        "/api/dashboard/studio/voice-design/speak",
        user_id=auth_ctx["user_id"],
        json={
            "user_id": auth_ctx["user_id"],
            "voice_id": voice_id,
            "target_text": text,
        },
        timeout_sec=60.0,
    )
    if isinstance(result, dict):
        result["credits_used"] = credits_needed
        if new_balance >= 0:
            result["credits_remaining"] = new_balance
    return result


async def _deduct_voice_speak_credits(user_id: str, cost: int, voice_id: int) -> int:
    """Atomic credit deduction for /v1/voices/{id}/speak. Returns the
    new balance; raises 402 if insufficient."""
    if cost <= 0:
        return -1
    conn = await get_db()
    try:
        row = await (await conn.execute(
            "SELECT credits FROM auth_users WHERE id = ?", (user_id,)
        )).fetchone()
        balance = int(row["credits"] or 0) if row else 0
        if balance < cost:
            raise HTTPException(
                status_code=402,
                detail=f"Insufficient credits. /v1/voices/{voice_id}/speak needs {cost} credits, you have {balance}.",
            )
        cur = await conn.execute(
            "UPDATE auth_users SET credits = credits - ?, updated_at = datetime('now') "
            "WHERE id = ? AND credits >= ?",
            (cost, user_id, cost),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=402, detail="Insufficient credits.")
        new_row = await (await conn.execute(
            "SELECT credits FROM auth_users WHERE id = ?", (user_id,)
        )).fetchone()
        new_balance = int(new_row["credits"] or 0) if new_row else 0
        await conn.execute(
            """
            INSERT INTO credit_transactions
            (id, user_id, transaction_type, amount, balance_after, description, reference_type, reference_id, metadata_json, created_at)
            VALUES (?, ?, 'api_voice_speak', ?, ?, ?, 'api_request', ?, ?, datetime('now'))
            """,
            (
                uuid.uuid4().hex,
                user_id,
                -cost,
                new_balance,
                f"Developer API voice speak · voice {voice_id}",
                f"voice:{voice_id}",
                '{"source":"developer-api"}',
            ),
        )
        await conn.commit()
        return new_balance
    finally:
        await conn.close()
