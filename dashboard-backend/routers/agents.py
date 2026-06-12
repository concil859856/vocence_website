"""Agents REST router — CRUD + draft + run lifecycle.

Mounted at ``/api/dashboard/agents`` (prefix added in main.py).
All endpoints require JWT auth (same as the studio router).
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, Optional

import os

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
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
    # Which end-of-turn detector to use as PRIMARY. Both paths share
    # the same fallback story: if the primary pod is unhealthy, the
    # other path takes over. Default "ultravad" once that pod is
    # deployed and validated; "fusion" routes to the existing Smart
    # Turn + LiveKit ensembler. See ULTRAVAD_POD_SPEC.md.
    turn_decider: str = "ultravad"  # "ultravad" | "fusion"
    # Threshold the UltraVAD primary path uses to fire commit. Range
    # [0, 1]; higher = more conservative (waits for stronger model
    # confidence, lets brief mid-sentence pauses through), lower =
    # more eager (snappier but more likely to cut mid-utterance).
    # 0.55 trades ~200 ms of end-of-turn latency for noticeably
    # fewer "agent cut me off mid-sentence" complaints.
    ultravad_threshold: float = 0.55
    # Per-agent recording opt-in. When true, the voicechat session
    # tees both legs (user + agent PCM) to a stereo WAV stored under
    # data/recordings/{user_id}/{session_id}.wav and writes the path
    # into voice_call_logs.recording_path so the Calls tab can
    # surface a download. Off by default for privacy — owners
    # explicitly turn it on in agent settings.
    record_enabled: bool = False


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


@router.get("/{agent_id}/calls/{session_id}/audio")
async def download_call_audio(
    agent_id: str,
    session_id: str,
    user_id: str = Depends(require_auth),
):
    """Stream the stereo WAV (left=user, right=agent) for a recorded
    call. 404 when recording was disabled / failed, 403 when the call
    belongs to a different agent (i.e. wrong URL — defense-in-depth
    against the session_id being treated as a bearer)."""
    await _ensure_agent_owned(agent_id, user_id)
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            """
            SELECT recording_path
            FROM voice_call_logs
            WHERE session_id = ? AND agent_id = ? AND user_id = ?
            """,
            (session_id, agent_id, user_id),
        )).fetchone()
    finally:
        await conn.close()
    if not row or not row[0]:
        raise HTTPException(status_code=404, detail="recording not found")
    path = str(row[0])
    if not os.path.exists(path):
        # The DB row lied — file deleted out-of-band. Return 404 so
        # the UI can hide the download button on next refresh.
        raise HTTPException(status_code=404, detail="recording file missing")
    # FileResponse handles HEAD + Range requests so the browser's
    # <audio> element can seek through long calls without
    # downloading the whole file.
    return FileResponse(
        path,
        media_type="audio/wav",
        filename=f"{session_id}.wav",
    )


@router.get("/{agent_id}/calls/{session_id}/transcript")
async def download_call_transcript(
    agent_id: str,
    session_id: str,
    user_id: str = Depends(require_auth),
) -> dict:
    """Per-turn transcript for one call, derived from the per-turn
    rows in studio_voicechat_history. Returned as JSON so the
    Calls tab can render a Discord-style chat view inline; the
    caller can also stringify it and Save As .json to download."""
    await _ensure_agent_owned(agent_id, user_id)
    conn = await get_connection()
    try:
        # Ownership pinning: the session_id MUST belong to this
        # agent + user. Otherwise return 404 (not 403) so we don't
        # leak existence of someone else's session_id.
        owned = await (await conn.execute(
            """
            SELECT 1 FROM voice_call_logs
            WHERE session_id = ? AND agent_id = ? AND user_id = ?
            """,
            (session_id, agent_id, user_id),
        )).fetchone()
        if not owned:
            raise HTTPException(status_code=404, detail="call not found")
        rows = await (await conn.execute(
            """
            SELECT user_text, bot_text, latency_ms, ttft_ms, ttfa_ms,
                   created_at, error
            FROM studio_voicechat_history
            WHERE session_id = ?
            ORDER BY id ASC
            """,
            (session_id,),
        )).fetchall()
        turns = []
        for r in rows:
            user_text = (r[0] or "").strip()
            bot_text = (r[1] or "").strip()
            if user_text:
                turns.append({"role": "user", "text": user_text})
            if bot_text:
                turns.append({"role": "assistant", "text": bot_text})
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
