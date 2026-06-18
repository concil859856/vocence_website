"""Agents REST router — CRUD + draft + run lifecycle.

Mounted at ``/api/dashboard/agents`` (prefix added in main.py).
All endpoints require JWT auth (same as the studio router).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse, StreamingResponse
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


from agent_limits import (
    AGENT_NAME_MAX_CHARS,
    AGENT_PURPOSE_MAX_CHARS,
    AGENT_FIRST_MESSAGE_MAX_CHARS,
    AGENT_SYSTEM_PROMPT_MAX_CHARS,
    AGENT_KNOWLEDGE_MAX_CHARS,
)


class AgentConfigIn(BaseModel):
    purpose: str = Field(default="", max_length=AGENT_PURPOSE_MAX_CHARS)
    system_prompt: str = Field(default="", max_length=AGENT_SYSTEM_PROMPT_MAX_CHARS)
    knowledge: str = Field(default="", max_length=AGENT_KNOWLEDGE_MAX_CHARS)
    # Free-form "what the agent says first" greeting. The voicechat
    # router speaks this before the user has said anything, so it
    # needs to be short — a multi-sentence greeting at most.
    first_message: Optional[str] = Field(default=None, max_length=AGENT_FIRST_MESSAGE_MAX_CHARS)
    # Default voice: must be a real sample-voice id from
    # sample_voices_data.py (NOT a display name). "Ryan" was the
    # historic default but didn't exist in the sample registry, so
    # every new agent routed to the dead /v1/tts/stream endpoint.
    # voc-sienna is friendly + versatile, a safe out-of-the-box pick.
    voice: str = "voc-sienna"
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
    # ── Voice pipeline knobs (per-agent) ─────────────────────────────
    # Whether to insert DeepFilterNet 3 denoise upstream of STT +
    # UltraVAD. Off by default — denoise adds ~200 ms passthrough
    # latency, only worth it for agents that expect noisy mics
    # (call-center, mobile-in-public). See DENOISER_STREAMING_POD_SPEC.md.
    denoise_enabled: bool = False
    # ``turn_decider`` removed in Phase C — the new pipeline uses
    # one turn detector (no user choice). The phase_c_drop_turn_decider
    # migration strips the field from existing config_json blobs.
    # Threshold the EOU-decider uses to fire commit. Range
    # [0, 1]; higher = more conservative (waits for stronger model
    # confidence, lets brief mid-sentence pauses through), lower =
    # more eager (snappier but more likely to cut mid-utterance).
    # 0.50 is the global default — biased slightly toward "wait for
    # the user to finish" over "snap fast at any pause."
    ultravad_threshold: float = Field(default=0.50, ge=0.0, le=1.0)
    # Minimum silence (ms) before the UltraVAD primary path is even
    # allowed to fire commit, regardless of model confidence. Bumping
    # this up gives the user a longer "is the next sentence coming?"
    # window before EOU. Falls through to the global ``MIN_DELAY_MS``
    # env-var default (500 ms) when omitted. Range 200–2000 — below
    # 200 ms is faster than human pause detection and above 2000 ms
    # makes the agent feel sluggish.
    min_delay_ms: Optional[int] = Field(default=None, ge=200, le=2000)
    # Per-agent recording opt-in. When true, the voicechat session
    # tees both legs (user + agent PCM) to a stereo WAV stored under
    # data/recordings/{user_id}/{session_id}.wav and writes the path
    # into voice_call_logs.recording_path so the Calls tab can
    # surface a download. Off by default for privacy — owners
    # explicitly turn it on in agent settings.
    record_enabled: bool = False
    # Speech-to-text provider for THIS agent. "vocence" routes audio
    # to our streaming pod (default — included in the per-minute rate
    # and consistent with cloning TTS); "deepgram" opts into hosted
    # Nova-3 at extra cost for accuracy-critical English agents.
    # Honored by the new voice pipeline (VOICE_PIPELINE=videosdk);
    # the legacy path follows the deployment-wide STT_PROVIDER env
    # so a per-agent override there is a future improvement.
    stt_provider: Literal["vocence", "deepgram"] = "vocence"


class AgentCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=AGENT_NAME_MAX_CHARS)
    type: str = Field(pattern="^(knowledge|goal)$")
    config: AgentConfigIn


class AgentPatchIn(BaseModel):
    name: Optional[str] = Field(default=None, max_length=AGENT_NAME_MAX_CHARS)
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
    # Running summary of what the model has learned about the user's
    # intent across the whole session. Maintained by the model via the
    # ``update_requirements`` tool; the frontend stores it locally and
    # re-sends it on each turn so it survives the 12-turn history cap.
    # Empty/None on the first turn of a session.
    requirements_summary: Optional[str] = Field(default=None, max_length=4000)


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
    (``CEREBRAS_API_KEYS`` set). Legacy agents whose ``llm_model`` is
    something else (Chutes default, Groq, OpenAI) still route correctly
    via llm_client — the picker just doesn't surface those for new
    agents."""
    models: list[dict[str, str]] = []

    # Cerebras currently serves two models on the account (verified
    # against /v1/models): ``gpt-oss-120b`` (the existing fast default)
    # and ``zai-glm-4.7`` (Z.AI's frontier model, supports
    # reasoning_effort=none for a clean non-reasoning path that fits
    # voice). Earlier labels referenced Qwen-3-235B and Llama-3.3-70B
    # which Cerebras doesn't actually expose on this account — picking
    # those would have failed at call time with a 404.
    if llm_client.cerebras_llm_configured():
        models.extend([
            {
                "id": "cerebras:gpt-oss-120b",
                "label": "Cerebras · GPT-OSS 120B (default, fast)",
            },
            {
                "id": "cerebras:zai-glm-4.7",
                "label": "Cerebras · GLM-4.7 (higher quality, slightly slower)",
            },
        ])

    # Gemini 3.5 Flash with reasoning disabled — sub-second TTFT
    # plus measurably higher general-knowledge quality than the
    # gpt-oss-120b baseline (Artificial Analysis Intelligence Index
    # 43 vs 33). The ``reasoning_effort="none"`` injection lives in
    # llm_client so a future caller can't accidentally turn thinking
    # back on and quietly regress voice TTFT to 5+ s.
    if llm_client.google_llm_configured():
        models.append({
            "id": "gemini:gemini-3.5-flash",
            "label": "Google · Gemini 3.5 Flash (high quality, sub-second TTFT)",
        })

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


@router.post("/architect/chat/stream")
async def architect_chat_stream(
    body: AgentArchitectChatIn, user_id: str = Depends(require_auth)
) -> StreamingResponse:
    """Streaming counterpart to ``/architect/chat``. Returns
    ``text/event-stream`` with newline-delimited JSON events the
    frontend's ArchitectDrawer consumes incrementally:

      {"type":"token","delta":"Sure, I can"}     - streamed prose
      {"type":"proposed","data":{...}}           - propose_changes tool call
      {"type":"done"}                            - terminal
      {"type":"error","message":"..."}           - terminal, on failure

    Each event is one ``data: <json>\\n\\n`` SSE frame. The frontend
    reads with ``fetch`` + ``ReadableStream`` (NOT EventSource — needs
    an Authorization header)."""
    if not agents_service.llm_configured():
        raise HTTPException(status_code=503, detail="agents LLM not configured")

    async def gen():
        try:
            async for evt in agents_service.chat_with_architect_stream(
                user_message=body.message,
                history=[h.model_dump() for h in body.history],
                existing=body.existing,
                requirements_summary=body.requirements_summary,
            ):
                yield f"data: {json.dumps(evt, ensure_ascii=False)}\n\n"
        except Exception as exc:  # noqa: BLE001
            _log.exception("architect stream failed at SSE layer")
            err = {"type": "error", "message": str(exc) or "architect stream failed"}
            yield f"data: {json.dumps(err, ensure_ascii=False)}\n\n"

    # ``X-Accel-Buffering: no`` prevents nginx from buffering the
    # stream — otherwise tokens batch at the proxy and the UX feels
    # one-shot anyway. ``Cache-Control: no-cache`` is the standard
    # SSE escape hatch from CDN/intermediary caches.
    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


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
        # Pydantic already rejected > AGENT_NAME_MAX_CHARS; just strip.
        # (Previous code silently truncated at 120 — confusing for the
        # user; the validator now produces a proper 422 instead.)
        fields.append("name = ?")
        values.append(body.name.strip())

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
        # Patch payload uses ``config: dict`` (free-form merge) so the
        # AgentConfigIn validators don't fire on the inbound body. Re-
        # check the text-length limits explicitly on the post-merge
        # config so PATCH can't bypass what POST and AgentConfigIn
        # enforce. Same numeric thresholds; consistent 422 response.
        _PATCH_TEXT_LIMITS = {
            "purpose": AGENT_PURPOSE_MAX_CHARS,
            "system_prompt": AGENT_SYSTEM_PROMPT_MAX_CHARS,
            "knowledge": AGENT_KNOWLEDGE_MAX_CHARS,
            "first_message": AGENT_FIRST_MESSAGE_MAX_CHARS,
        }
        for field, cap in _PATCH_TEXT_LIMITS.items():
            val = existing.get(field)
            if isinstance(val, str) and len(val) > cap:
                raise HTTPException(
                    status_code=422,
                    detail=f"{field} too long: {len(val)} chars (max {cap})",
                )
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
# Call history + analytics — voice_call_logs is written at session
# close in routers/voicechat.py. Per-turn latency rows continue to
# live in studio_voicechat_history and are joined in here on demand.
# ---------------------------------------------------------------------------


_RANGE_DAYS = {"24h": 1, "7d": 7, "30d": 30, "90d": 90}


def _range_clause(range_key: str) -> int:
    """Map the public range token to a day count. Defaults to 30d on
    anything unrecognized to keep dashboards from silently breaking
    when a typo'd query param arrives."""
    return _RANGE_DAYS.get(range_key, 30)


@router.get("/{agent_id}/calls")
async def list_agent_calls(
    agent_id: str,
    range: str = "30d",
    limit: int = 100,
    user_id: str = Depends(require_auth),
) -> dict:
    """Recent calls for one agent, newest first. Drives the Calls tab
    in the agent detail page. ``recording_path`` is exposed as a
    boolean ``has_recording`` (the actual file lives on disk; the
    frontend hits the dedicated audio endpoint to stream it)."""
    await _ensure_agent_owned(agent_id, user_id)
    days = _range_clause(range)
    limit = max(1, min(int(limit), 500))
    conn = await get_connection()
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
        return {"calls": calls, "range": range, "limit": limit}
    finally:
        await conn.close()


@router.get("/{agent_id}/calls.csv")
async def export_agent_calls_csv(
    agent_id: str,
    range: str = "30d",
    user_id: str = Depends(require_auth),
):
    """Streamed CSV of every call for one agent in the given range.

    Streaming write avoids materializing N rows × M columns in memory
    before sending — important when range=90d on a busy agent (could
    be tens of thousands of rows). Header line is yielded first, then
    we iterate row-by-row from the same query the JSON list endpoint
    uses, so behavior stays consistent.
    """
    await _ensure_agent_owned(agent_id, user_id)
    days = _range_clause(range)

    # Build the row generator. async generators work cleanly with
    # StreamingResponse — FastAPI iterates and pushes each chunk
    # without buffering the whole response.
    async def _row_stream():
        import csv
        import io
        # Use csv.writer against a tiny in-memory StringIO that we
        # truncate per row. Picking the stdlib writer (vs hand-
        # escaping) handles commas / quotes / newlines inside
        # transcript-derived fields correctly.
        buf = io.StringIO()
        writer = csv.writer(buf)
        # Header
        writer.writerow([
            "session_id", "started_at", "ended_at", "duration_ms",
            "end_reason", "turn_count", "user_chars", "agent_chars",
            "has_recording", "recording_bytes",
        ])
        yield buf.getvalue()
        buf.seek(0); buf.truncate(0)

        conn = await get_connection()
        try:
            cursor = await conn.execute(
                """
                SELECT session_id, started_at, ended_at, duration_ms, end_reason,
                       turn_count, user_chars, agent_chars, recording_path,
                       recording_bytes
                FROM voice_call_logs
                WHERE agent_id = ?
                  AND started_at >= datetime('now', ?)
                ORDER BY started_at DESC
                """,
                (agent_id, f"-{days} days"),
            )
            # Drain in batches so a multi-thousand-row export doesn't
            # turn into one yield per row (network overhead).
            BATCH = 200
            while True:
                rows = await cursor.fetchmany(BATCH)
                if not rows:
                    break
                for r in rows:
                    writer.writerow([
                        r[0],
                        r[1],
                        r[2],
                        int(r[3] or 0),
                        r[4] or "unknown",
                        int(r[5] or 0),
                        int(r[6] or 0),
                        int(r[7] or 0),
                        "true" if r[8] else "false",
                        int(r[9]) if r[9] is not None else "",
                    ])
                yield buf.getvalue()
                buf.seek(0); buf.truncate(0)
        finally:
            await conn.close()

    filename = f"agent-{agent_id}-calls-{range}.csv"
    return StreamingResponse(
        _row_stream(),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{agent_id}/analytics")
async def get_agent_analytics(
    agent_id: str,
    range: str = "30d",
    user_id: str = Depends(require_auth),
) -> dict:
    """Aggregate stats for the per-agent Analytics tab. Returns:

    - ``call_count``, ``total_duration_ms``, ``avg_duration_ms``
    - ``drop_rate`` — fraction of calls under 10 s OR zero user turns
      (the "user opened mic, said nothing" pattern). Surface metric
      for misconfigured / confusing agents.
    - End-reason breakdown (which watchdog ended sessions vs the
      user hanging up themselves).
    - Daily call count for the last N days (for a sparkline).
    - Median per-turn latencies (TTFT, TTFA) pulled from
      studio_voicechat_history.

    All scoped to the agent + date range. Empty result on an unused
    agent is normal (zero fields, empty arrays); the UI handles it.
    """
    await _ensure_agent_owned(agent_id, user_id)
    days = _range_clause(range)
    conn = await get_connection()
    try:
        # Headline metrics over the window.
        summary_row = await (await conn.execute(
            """
            SELECT
                COUNT(*) AS call_count,
                COALESCE(SUM(duration_ms), 0) AS total_duration_ms,
                COALESCE(AVG(duration_ms), 0) AS avg_duration_ms,
                COALESCE(SUM(CASE WHEN duration_ms < 10000 OR turn_count = 0
                                  THEN 1 ELSE 0 END), 0) AS dropped,
                COALESCE(SUM(user_chars), 0) AS user_chars,
                COALESCE(SUM(agent_chars), 0) AS agent_chars,
                COALESCE(SUM(turn_count), 0) AS turn_count
            FROM voice_call_logs
            WHERE agent_id = ?
              AND started_at >= datetime('now', ?)
            """,
            (agent_id, f"-{days} days"),
        )).fetchone()
        call_count = int(summary_row[0] or 0)
        total_duration_ms = int(summary_row[1] or 0)
        avg_duration_ms = int(summary_row[2] or 0)
        dropped = int(summary_row[3] or 0)
        drop_rate = (dropped / call_count) if call_count else 0.0

        # End-reason breakdown — gives an at-a-glance "where do sessions
        # go to die?" view. Iterating the rows is cheaper than seven
        # one-off SELECTs.
        end_rows = await (await conn.execute(
            """
            SELECT end_reason, COUNT(*) FROM voice_call_logs
            WHERE agent_id = ?
              AND started_at >= datetime('now', ?)
            GROUP BY end_reason
            """,
            (agent_id, f"-{days} days"),
        )).fetchall()
        end_reasons = {str(r[0] or "unknown"): int(r[1]) for r in end_rows}

        # Daily series for sparklines. SQLite returns YYYY-MM-DD from
        # date() — the frontend renders these as-is.
        daily_rows = await (await conn.execute(
            """
            SELECT date(started_at) AS day,
                   COUNT(*) AS calls,
                   COALESCE(AVG(duration_ms), 0) AS avg_dur
            FROM voice_call_logs
            WHERE agent_id = ?
              AND started_at >= datetime('now', ?)
            GROUP BY day
            ORDER BY day ASC
            """,
            (agent_id, f"-{days} days"),
        )).fetchall()
        daily = [
            {"day": r[0], "call_count": int(r[1]), "avg_duration_ms": int(r[2] or 0)}
            for r in daily_rows
        ]

        # Latency medians from per-turn rows. We compute median via the
        # window function so a single hour-long noisy session can't
        # warp the metric the way AVG would.
        latency_row = await (await conn.execute(
            """
            WITH turn_latencies AS (
                SELECT t.latency_ms, t.ttft_ms, t.ttfa_ms,
                       ROW_NUMBER() OVER (ORDER BY t.latency_ms) AS r_lat,
                       ROW_NUMBER() OVER (ORDER BY t.ttft_ms)    AS r_ttft,
                       ROW_NUMBER() OVER (ORDER BY t.ttfa_ms)    AS r_ttfa,
                       COUNT(*) OVER ()                          AS n
                FROM studio_voicechat_history t
                JOIN voice_call_logs c ON c.session_id = t.session_id
                WHERE c.agent_id = ?
                  AND c.started_at >= datetime('now', ?)
                  AND t.status = 'completed'
            )
            SELECT
                (SELECT latency_ms FROM turn_latencies WHERE r_lat IN (n / 2 + 1) LIMIT 1) AS p50_latency,
                (SELECT ttft_ms    FROM turn_latencies WHERE r_ttft IN (n / 2 + 1) LIMIT 1) AS p50_ttft,
                (SELECT ttfa_ms    FROM turn_latencies WHERE r_ttfa IN (n / 2 + 1)
                                                          AND ttfa_ms IS NOT NULL LIMIT 1) AS p50_ttfa
            """,
            (agent_id, f"-{days} days"),
        )).fetchone()
        p50_latency = int(latency_row[0]) if latency_row and latency_row[0] is not None else None
        p50_ttft = int(latency_row[1]) if latency_row and latency_row[1] is not None else None
        p50_ttfa = int(latency_row[2]) if latency_row and latency_row[2] is not None else None

        return {
            "range": range,
            "call_count": call_count,
            "total_duration_ms": total_duration_ms,
            "avg_duration_ms": avg_duration_ms,
            "drop_rate": drop_rate,
            "user_chars": int(summary_row[4] or 0),
            "agent_chars": int(summary_row[5] or 0),
            "turn_count": int(summary_row[6] or 0),
            "end_reasons": end_reasons,
            "daily": daily,
            "p50_turn_latency_ms": p50_latency,
            "p50_ttft_ms": p50_ttft,
            "p50_ttfa_ms": p50_ttfa,
        }
    finally:
        await conn.close()


@router.get("/{agent_id}/calls/search")
async def search_agent_calls(
    agent_id: str,
    q: str,
    range: str = "30d",
    limit: int = 50,
    user_id: str = Depends(require_auth),
) -> dict:
    """Full-text search over per-turn transcripts for one agent.
    Returns one row per matching call with the best-ranked
    snippet for that call. One round trip.

    Token cleanup:
      * keep alphanumerics + dashes, lowercase
      * drop runs shorter than 2 chars
      * dedup, cap at 12 tokens

    Each surviving token is wrapped in double quotes (FTS5 phrase
    syntax) and OR-joined so a stray AND/OR/NEAR in the user's
    query can't break the parser. Token order doesn't matter
    because the MATCH is an OR.

    Query shape — we use a CTE + ROW_NUMBER() instead of a bare
    GROUP BY because the documented "bare column with MIN/MAX
    aggregate" rule in SQLite is only reliable for stored columns
    — for function-call columns like ``snippet(...)`` the binding
    isn't guaranteed. ROW_NUMBER() picks exactly the row we want
    (lowest bm25 per session) and we take its snippet directly.
    """
    await _ensure_agent_owned(agent_id, user_id)
    days = _range_clause(range)
    limit = max(1, min(int(limit), 200))

    import re as _re
    tokens = [
        t.lower()
        for t in _re.findall(r"[A-Za-z][A-Za-z0-9_-]+", q or "")
        if len(t) >= 2
    ]
    seen: set[str] = set()
    uniq: list[str] = []
    for t in tokens:
        if t in seen:
            continue
        seen.add(t)
        uniq.append(t)
        if len(uniq) >= 12:
            break
    if not uniq:
        return {"query": q, "range": range, "results": []}
    match_expr = " OR ".join('"' + t.replace('"', '""') + '"' for t in uniq)
    _log.info(
        "[calls.search] agent=%s user=%s q=%r match=%r range=%dd",
        agent_id, user_id, q[:120], match_expr[:200], days,
    )

    conn = await get_connection()
    try:
        # Step 1 — raw FTS pass. bm25() and snippet() are FTS5
        # auxiliary functions that ONLY work when the query
        # references the FTS table directly with a MATCH constraint;
        # SQLite rejects them with "unable to use function bm25 in
        # the requested context" when they appear inside an OVER()
        # window or a sub-CTE that gets flattened. So we keep this
        # query flat: just MATCH + agent_id, ORDER BY bm25, LIMIT a
        # generous bucket. Per-session dedup happens in Python
        # (cheap; ranks come back sorted, first wins).
        cursor = await conn.execute(
            """
            SELECT
                session_id,
                bm25(studio_voicechat_history_fts) AS rank,
                snippet(
                    studio_voicechat_history_fts,
                    -1,
                    '<mark>',
                    '</mark>',
                    '…',
                    32
                ) AS hit
            FROM studio_voicechat_history_fts
            WHERE studio_voicechat_history_fts MATCH ?
              AND agent_id = ?
            ORDER BY rank ASC
            LIMIT 500
            """,
            (match_expr, agent_id),
        )
        raw_rows = await cursor.fetchall()

        # Dedup by session_id. Rows are sorted by rank ASC so the
        # first occurrence per session is the best match.
        per_session: dict[str, tuple[float, str]] = {}
        session_order: list[str] = []
        for r in raw_rows:
            sid = r[0]
            if sid in per_session:
                continue
            per_session[sid] = (float(r[1] or 0.0), r[2] or "")
            session_order.append(sid)
            if len(session_order) >= limit:
                break

        if not session_order:
            _log.info(
                "[calls.search] agent=%s match=%r → 0 results (fts raw=0)",
                agent_id, match_expr[:80],
            )
            return {"query": q, "range": range, "results": []}

        # Step 2 — pull voice_call_logs metadata for the matched
        # sessions with the ownership + range filter applied. One
        # IN clause; ordering preserved by rebuilding from
        # session_order after the fetch.
        placeholders = ",".join(["?"] * len(session_order))
        cursor = await conn.execute(
            f"""
            SELECT session_id, started_at, duration_ms, end_reason, turn_count
            FROM voice_call_logs
            WHERE session_id IN ({placeholders})
              AND agent_id = ?
              AND user_id = ?
              AND started_at >= datetime('now', ?)
            """,
            (*session_order, agent_id, user_id, f"-{days} days"),
        )
        meta_rows = await cursor.fetchall()
        meta_by_sid = {r[0]: r for r in meta_rows}

        # Diagnostic: the gap between raw FTS hits and final
        # results pinpoints whether 0 means "FTS didn't find it"
        # vs "voice_call_logs filter dropped it".
        results = []
        for sid in session_order:
            m = meta_by_sid.get(sid)
            if not m:
                continue
            rank, hit = per_session[sid]
            results.append(
                {
                    "session_id": m[0],
                    "started_at": m[1],
                    "duration_ms": int(m[2] or 0),
                    "end_reason": m[3] or "unknown",
                    "turn_count": int(m[4] or 0),
                    "snippet": hit,
                }
            )
        _log.info(
            "[calls.search] agent=%s match=%r → %d results "
            "(fts sessions=%d, post-filter=%d)",
            agent_id, match_expr[:80], len(results),
            len(session_order), len(results),
        )
        return {"query": q, "range": range, "results": results}
    finally:
        await conn.close()


@router.get("/{agent_id}/calls/{session_id}/audio")
async def download_call_audio(
    agent_id: str,
    session_id: str,
    download: bool = False,
    json: bool = False,
    user_id: str = Depends(require_auth),
):
    """Authorize the request, then either:

    - ``json=true`` → return ``{"url": "<presigned>"}`` so the
      frontend can fetch this endpoint with cookie auth, read the
      URL, and set it directly on ``<audio src>``. This is the
      path the in-page player uses — 302-redirecting an
      ``<audio crossOrigin="use-credentials">`` request to a
      different origin (R2) trips CORS-with-credentials because R2
      doesn't return our ``Access-Control-Allow-Origin`` headers
      on the redirect target. JSON sidesteps it: the audio loads
      anonymously from R2 with presigned-query-string auth.

    - default → 302 to the presigned URL. Used by the
      ``<a href download>`` link in the UI: full-page navigation
      sends cookies same-site / with the session cookie, the
      browser follows the redirect natively, and the
      ``Content-Disposition: attachment`` header (added when
      ``download=true``) triggers the save dialog.

    Both paths share the same auth + DB lookup; only the response
    representation differs.
    """
    await _ensure_agent_owned(agent_id, user_id)
    conn = await get_connection()
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
    from studio_tts_service import presigned_call_recording_url
    url = presigned_call_recording_url(
        bucket,
        key,
        download_filename=f"{session_id}.wav" if download else None,
    )
    if not url:
        raise HTTPException(status_code=502, detail="object store unavailable")
    if json:
        return {"url": url}
    return RedirectResponse(url=url, status_code=302)


@router.delete("/{agent_id}/calls/{session_id}/recording")
async def delete_call_recording(
    agent_id: str,
    session_id: str,
    user_id: str = Depends(require_auth),
) -> dict:
    """Immediately purge one call's recording object from the bucket
    and NULL the pointers on the voice_call_logs row. Owner-only,
    takes effect before the next retention sweep. The log row
    itself is preserved so analytics totals don't shift
    retroactively — same policy as the sweep. Idempotent: returns
    200 with ``deleted=False`` when the recording was already gone."""
    await _ensure_agent_owned(agent_id, user_id)
    conn = await get_connection()
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
                # Same trade-off the sweep makes: surface the failure
                # so the UI can retry rather than silently NULLing
                # while the object persists.
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


class WebhookCreateIn(BaseModel):
    url: str = Field(min_length=8, max_length=2048)
    events: Optional[list[str]] = None  # default in service layer: ["*"]


@router.get("/{agent_id}/webhooks")
async def list_agent_webhooks(
    agent_id: str,
    user_id: str = Depends(require_auth),
) -> dict:
    """All webhooks subscribed to events on this agent. Secrets are
    NOT returned — they're shown once at creation time."""
    await _ensure_agent_owned(agent_id, user_id)
    from webhooks_service import list_webhooks_for_agent
    return {"webhooks": await list_webhooks_for_agent(agent_id, user_id)}


@router.post("/{agent_id}/webhooks")
async def create_agent_webhook(
    agent_id: str,
    body: WebhookCreateIn,
    user_id: str = Depends(require_auth),
) -> dict:
    """Register a new webhook URL. Response includes the plaintext
    ``secret`` — the caller MUST show this to the user once and
    never again (subsequent list() calls omit it)."""
    await _ensure_agent_owned(agent_id, user_id)
    from webhooks_service import create_webhook
    try:
        wh = await create_webhook(
            agent_id=agent_id,
            user_id=user_id,
            url=body.url,
            events=body.events,
        )
    except ValueError as exc:
        # SSRF guard / bad scheme — surface the reason so the UI can
        # show "this URL was rejected because …".
        raise HTTPException(status_code=400, detail=str(exc))
    return {"webhook": wh}


@router.delete("/{agent_id}/webhooks/{webhook_id}")
async def delete_agent_webhook(
    agent_id: str,
    webhook_id: str,
    user_id: str = Depends(require_auth),
) -> dict:
    await _ensure_agent_owned(agent_id, user_id)
    from webhooks_service import delete_webhook
    ok = await delete_webhook(webhook_id, user_id)
    if not ok:
        raise HTTPException(status_code=404, detail="webhook not found")
    return {"ok": True}


@router.get("/{agent_id}/webhooks/{webhook_id}/deliveries")
async def list_agent_webhook_deliveries(
    agent_id: str,
    webhook_id: str,
    limit: int = 20,
    user_id: str = Depends(require_auth),
) -> dict:
    """Last N delivery attempts for one webhook. Surfaces status,
    HTTP code, and last error so the customer can debug their
    endpoint without reading our logs."""
    await _ensure_agent_owned(agent_id, user_id)
    # Owner check on the webhook itself — agent_owned + webhook
    # belongs-to-agent prevents IDOR on a webhook id guess.
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT 1 FROM agent_webhooks WHERE id = ? AND agent_id = ? AND user_id = ?",
            (webhook_id, agent_id, user_id),
        )).fetchone()
    finally:
        await conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="webhook not found")
    from webhooks_service import list_recent_deliveries
    return {"deliveries": await list_recent_deliveries(webhook_id, limit=limit)}


@router.post("/{agent_id}/webhooks/{webhook_id}/test")
async def test_agent_webhook(
    agent_id: str,
    webhook_id: str,
    user_id: str = Depends(require_auth),
) -> dict:
    """Enqueue a synthetic ``webhook.test`` event so the customer
    can verify wiring + signature handling without waiting for a
    real call. Delivery happens on the next poller tick."""
    await _ensure_agent_owned(agent_id, user_id)
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT 1 FROM agent_webhooks WHERE id = ? AND agent_id = ? AND user_id = ?",
            (webhook_id, agent_id, user_id),
        )).fetchone()
    finally:
        await conn.close()
    if not row:
        raise HTTPException(status_code=404, detail="webhook not found")
    # Insert one delivery row directly for this single webhook
    # (vs the agent fan-out path) — test events shouldn't reach
    # OTHER webhooks on the same agent.
    import json as _json
    body = _json.dumps({
        "event": "webhook.test",
        "agent_id": agent_id,
        "webhook_id": webhook_id,
        "message": "If you can read this, signature verification passed.",
    }, separators=(",", ":"))
    conn = await get_connection()
    try:
        await conn.execute(
            "INSERT INTO webhook_deliveries (webhook_id, event_type, payload_json) "
            "VALUES (?, ?, ?)",
            (webhook_id, "webhook.test", body),
        )
        await conn.commit()
    finally:
        await conn.close()
    return {"ok": True}


@router.get("/{agent_id}/calls/{session_id}/transcript")
async def download_call_transcript(
    agent_id: str,
    session_id: str,
    user_id: str = Depends(require_auth),
) -> dict:
    """Per-turn transcript for one call, derived from the per-turn
    rows in studio_voicechat_history. Each turn carries an ``at_ms``
    offset relative to the call's ``started_at`` so the session
    replay UI can seek the audio to the exact spot a turn happened
    rather than estimating proportionally.

    ``at_ms`` semantics:
      * user turn → ms between call start and when the per-turn row
        was written (= when STT committed). This is the moment the
        user finished speaking, which is the natural "play from
        here" anchor.
      * assistant turn → same row, same created_at — we don't yet
        capture a separate "agent started speaking" timestamp at
        per-turn granularity, so we re-use the user-turn timestamp
        for the assistant reply sequenced after it. Good enough
        for ±1s seek precision; can be tightened later by capturing
        TTS first-frame timestamp in the rows.

    One query joins voice_call_logs and studio_voicechat_history so
    we don't make a round trip per turn — the join lets SQLite
    compute the ms offset directly via strftime.
    """
    await _ensure_agent_owned(agent_id, user_id)
    conn = await get_connection()
    try:
        # Ownership pinning + per-turn rows fetched in one query.
        # COALESCE(strftime, 0) guards against NULL created_at on
        # pre-migration rows (returns at_ms=0 instead of NULL so the
        # frontend can use a simple number type).
        rows = await (await conn.execute(
            """
            SELECT
                t.user_text,
                t.bot_text,
                CAST(
                    (julianday(t.created_at) - julianday(c.started_at)) * 86400000
                    AS INTEGER
                ) AS at_ms,
                t.latency_ms,
                t.ttft_ms,
                t.ttfa_ms,
                t.mode
            FROM voice_call_logs c
            JOIN studio_voicechat_history t ON t.session_id = c.session_id
            WHERE c.session_id = ? AND c.agent_id = ? AND c.user_id = ?
            ORDER BY t.id ASC
            """,
            (session_id, agent_id, user_id),
        )).fetchall()
        if not rows:
            # Empty result could mean missing call OR missing per-turn
            # rows; either way the UX is "nothing to show", so we
            # can't distinguish. Run a cheap existence check so we
            # return 404 only when the CALL is missing.
            owned = await (await conn.execute(
                "SELECT 1 FROM voice_call_logs "
                "WHERE session_id = ? AND agent_id = ? AND user_id = ?",
                (session_id, agent_id, user_id),
            )).fetchone()
            if not owned:
                raise HTTPException(status_code=404, detail="call not found")
        turns = []
        for r in rows:
            user_text = (r[0] or "").strip()
            bot_text = (r[1] or "").strip()
            at_ms = int(r[2] or 0)
            if user_text:
                turns.append({"role": "user", "text": user_text, "at_ms": at_ms})
            if bot_text:
                turns.append({"role": "assistant", "text": bot_text, "at_ms": at_ms})
        return {
            "session_id": session_id,
            "agent_id": agent_id,
            "turns": turns,
        }
    finally:
        await conn.close()


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
