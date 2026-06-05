"""Vocence Agents — orchestration helpers shared by the agents router.

- ``draft_agent_config`` calls the LLM with a fixed prompt template and
  returns a structured AgentConfig draft for the builder UI.
- ``run_goal_agent`` is the minimal real Goal-Agent loop: LLM-only,
  iterates up to N times, self-scores, returns iteration history. Designed
  to be launched as an asyncio Task; writes progress to the DB on each
  iteration so the UI can poll.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

import aiohttp

from local_db import get_connection
from studio_tts_service import CHUTES_AUTH_KEY, VOICE_DESIGN_LLM_BASE_URL


_log = logging.getLogger(__name__)


# Configurable LLM model and timeouts (mirror voicechat defaults)
import os
AGENTS_LLM_MODEL = (
    os.environ.get("AGENTS_LLM_MODEL")
    or os.environ.get("VOICECHAT_LLM_MODEL")
    or os.environ.get("VOICE_DESIGN_LLM_MODEL")
    or ""
).strip()
AGENTS_LLM_TIMEOUT_SEC = float(os.environ.get("AGENTS_LLM_TIMEOUT_SEC") or "120")
AGENTS_LOOP_MAX_ITERATIONS_HARD = int(os.environ.get("AGENTS_LOOP_MAX_ITERATIONS_HARD") or "20")
AGENTS_LOOP_TARGET_SCORE = float(os.environ.get("AGENTS_LOOP_TARGET_SCORE") or "0.9")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def llm_configured() -> bool:
    """Either local Qwen3-4B or Chutes is enough — llm_client decides."""
    from llm_client import llm_configured as _llm_configured
    return _llm_configured()


# ---------------------------------------------------------------------------
# LLM helpers
# ---------------------------------------------------------------------------


async def _chat_complete_json(
    *,
    system: str,
    user: str,
    history: Optional[list[dict]] = None,
    model: Optional[str] = None,
    temperature: float = 0.4,
    max_tokens: int = 1500,
    think: bool | None = None,
) -> dict:
    """One-shot chat completion expecting a JSON object back.

    Routes through the unified llm_client (local Qwen3-4B first, Chutes
    fallback). When ``model`` is explicitly provided, the call is forced
    to Chutes since model selection is meaningless on the single-model
    local endpoint.

    ``history`` lets the architect's conversational mode pass prior
    chat turns (last 12-ish messages) so it can answer follow-ups
    coherently. Each entry: ``{"role": "user"|"assistant", "content": str}``."""
    from llm_client import chat_complete_json as _llm_chat_json, llm_configured as _llm_configured
    if not _llm_configured():
        raise RuntimeError("no LLM configured (set LOCAL_LLM_BASE_URL or AGENTS_LLM_MODEL+CHUTES_AUTH_KEY)")
    msgs: list[dict] = [{"role": "system", "content": system}]
    for h in (history or []):
        # Defensive — only forward well-shaped turns. Skip empty/malformed
        # so a broken UI state can't poison the LLM context.
        role = h.get("role")
        content = h.get("content")
        if role in ("user", "assistant") and isinstance(content, str) and content.strip():
            msgs.append({"role": role, "content": content})
    msgs.append({"role": "user", "content": user})
    return await _llm_chat_json(
        messages=msgs,
        temperature=temperature,
        max_tokens=max_tokens,
        think=think,
        model=model or None,
        retries=1,
    )


# Kept for callers that previously imported _extract_json_object from this
# module. Forwards to the canonical implementation in llm_client.
def _extract_json_object(text: str) -> dict:
    from llm_client import extract_json_object
    return extract_json_object(text)


# ---------------------------------------------------------------------------
# Draft helper — used by builder
# ---------------------------------------------------------------------------


DRAFT_SYSTEM = """You are the Vocence Agent Architect. Given a description of an agent
the user wants, you produce a structured JSON config they can deploy.

Vocence Agents are voice-first: every agent has a sample voice. Two types:
- "knowledge" — answers questions / chats with users using injected knowledge.
- "goal" — runs autonomously, iterating toward a user-stated goal, self-scoring.

Output a SINGLE JSON object with this exact shape — no prose, no markdown fences:

{
  "name": "Short Title-Case name (3-5 words)",
  "type": "knowledge" | "goal",
  "config": {
    "purpose": "1-2 sentences — what it does and for whom",
    "system_prompt": "The instruction block the LLM sees on every turn. Concrete behavior, tone, refusals. Multi-paragraph is fine.",
    "knowledge": "Reference text. Empty string is OK if user didn't provide any.",
    "voice": "<sample voice id from the gallery — see list below>",
    "language": "English",
    "llm_model": "",
    "temperature": 0.6,
    "goal": "(only for type=goal) the user-stated goal",
    "success_metric": "(only for type=goal) plain-English description of done",
    "max_iterations": 5
  },
  "note": "1-2 friendly sentences explaining the choices you made — shown in the chat."
}

Voice id must be one of these gallery entries (pick the one whose vibe best fits the persona):

  Male:
    voc-atlas   — deep, commanding
    voc-roman   — rich, classical
    voc-vincent — refined, baritone
    voc-maximus — bold, authoritative
    voc-chase   — energetic podcast host
    voc-lyle    — smooth, easy-listening
    voc-theo    — thoughtful, measured
    voc-jasper  — warm storyteller
    voc-owen    — clear, professional
    design-dante  — deep, confident
    design-kai    — smooth, friendly
    design-marcus — authoritative, mature
    design-rafael — charismatic, expressive
    char-epic-warrior      — heroic, booming
    char-friendly-ai-assistant — pleasant, helpful
    char-military-commander — stern, commanding
    char-neutral-male      — clear narrator

  Female:
    voc-iris    — bright, articulate
    voc-camille — smooth, polished
    voc-harper  — warm, conversational podcast
    design-aria   — bright, energetic
    design-aurora — soft, dreamy
    design-ember  — warm, soulful
    design-luna   — mysterious, ethereal
    design-yuki   — calm, gentle
    real-sophia   — warm, expressive
    char-happy-female — cheerful, upbeat
    char-little-girl  — young, playful

Rules:
- For knowledge agents, omit goal/success_metric/max_iterations from config.
- The voice id MUST be from the list above — don't invent ids or use Qwen3 speaker names.
- Keep system_prompt focused. Include a 'don't pretend to act on the user's account' rule when relevant.
- If the user gave a hint (existing draft), preserve fields they already customized unless their new message contradicts them.
"""


async def draft_agent_config(
    *,
    description: str,
    type_hint: Optional[str] = None,
    existing: Optional[dict] = None,
) -> dict:
    """Returns {name, type, config, note}. Raises on failure."""
    user_msg_parts: list[str] = [f"User description:\n{description.strip()}"]
    if type_hint:
        user_msg_parts.append(f"\nPreferred type: {type_hint}")
    if existing:
        user_msg_parts.append(f"\nCurrent draft (refine — don't overwrite preserved fields unnecessarily):\n{json.dumps(existing, ensure_ascii=False)[:4000]}")

    obj = await _chat_complete_json(
        system=DRAFT_SYSTEM,
        user="\n".join(user_msg_parts),
        temperature=0.4,
        max_tokens=1800,
    )
    return _normalize_draft(obj)


# ---------------------------------------------------------------------------
# Conversational architect
#
# Until 2026-06 the architect was strictly a one-shot "describe → get JSON
# config" endpoint. Any chat-style input ("what can you help with?")
# silently rewrote the user's agent because every message hit
# ``draft_agent_config``. The architect now defaults to plain
# conversation and only emits structured ``proposed_changes`` when the
# user signals intent (asks for an edit, says "go ahead", etc.).
# The frontend renders the conversational reply normally and shows
# an "Apply" button when ``proposed_changes`` is non-null.
# ---------------------------------------------------------------------------


CHAT_SYSTEM = """You are the Vocence Agent Architect — a conversational copilot that
helps people design and refine their voice-first AI agents.

Vocence Agents come in two flavours:
  • "knowledge" — answers questions / has conversations, fed by knowledge.
  • "goal"      — runs autonomously, iterating toward a stated goal.

DEFAULT BEHAVIOUR: have a normal conversation. Ask clarifying questions
when the user is vague. Make recommendations. Explain trade-offs. Be
warm and concise. NEVER unilaterally rewrite their agent.

You can READ the user's current draft (handed to you in context). You
may NOT modify it unless the user clearly asks for a change:
  ✓ "make the tone more formal"            → modify
  ✓ "rename it to Atlas"                   → modify
  ✓ "add a system prompt that says X"      → modify
  ✓ "draft an agent for customer support"  → modify
  ✗ "what can you help with?"              → just chat
  ✗ "tell me what this agent does"         → just chat
  ✗ "what voice should I use?"             → recommend, don't auto-apply
  ✗ "can you check my prompt?"             → review + suggest, don't apply

ALWAYS respond as a SINGLE JSON object — but the user only sees
``reply``. ``proposed_changes`` is the structured edit, present ONLY
when the user has clearly asked you to make a change AND you have
enough information to make it. When it's present the UI shows an
"Apply" button. When it's not, the UI shows only your text reply.

Output shape (no markdown fences, no prose outside the JSON):

{
  "reply": "Your conversational reply, plain text, 1-4 sentences. End with a question if you need more info.",
  "proposed_changes": null   OR   {
    "name": "...",
    "type": "knowledge" | "goal",
    "config": {
      "purpose": "...",
      "system_prompt": "...",
      "knowledge": "...",
      "voice": "<sample voice id, see picker>",
      "language": "English",
      "llm_model": "",
      "temperature": 0.6,
      "goal": "(only if type=goal)",
      "success_metric": "(only if type=goal)",
      "max_iterations": 5
    },
    "summary": "1 sentence — what changed vs the current draft, for the Apply button tooltip."
  }
}

Rules for ``proposed_changes``:
  - If the user asked to change one field (e.g. just the name), include
    THE WHOLE config — copy current values for fields you aren't
    changing. The Apply button replaces the whole draft at once.
  - Pick a voice id from the gallery list when proposing a new agent
    OR when the user explicitly asks for a voice change.
  - Set proposed_changes to null when in doubt. Better to ask one
    more question than to silently overwrite their work.
"""


async def chat_with_architect(
    *,
    user_message: str,
    history: Optional[list[dict]] = None,
    existing: Optional[dict] = None,
) -> dict:
    """One conversational turn with the architect.

    Returns ``{reply: str, proposed_changes: dict | None}``. Caller
    renders ``reply`` as the assistant's chat bubble; if
    ``proposed_changes`` is non-null, also show an Apply button that
    POSTs through to the existing draft-apply flow.

    ``history`` is the prior chat as a list of ``{role, content}``
    pairs — same shape llm_client uses. We cap at the last 12 turns to
    keep latency tight (architect chat doesn't need long-term memory)."""
    history = list(history or [])[-12:]

    # Stitch the existing draft into a user-visible system addendum so
    # the LLM doesn't have to be told about it every turn.
    user_blocks: list[str] = []
    if existing:
        user_blocks.append(
            "Current agent draft (read-only context):\n"
            + json.dumps(existing, ensure_ascii=False)[:3500]
        )
    user_blocks.append(user_message.strip())
    final_user = "\n\n".join(user_blocks)

    obj = await _chat_complete_json(
        system=CHAT_SYSTEM,
        user=final_user,
        history=history,
        temperature=0.5,
        max_tokens=1400,
    )
    reply = str(obj.get("reply") or "").strip()[:2000]
    proposed = obj.get("proposed_changes")
    normalized: dict | None = None
    if isinstance(proposed, dict):
        # Reuse the existing normalizer so the shape matches the
        # /draft endpoint — the apply path then works unchanged.
        try:
            normalized = _normalize_draft(proposed)
            # Carry the architect's human summary through to the UI so
            # the Apply button can show "what will change".
            summary = str(proposed.get("summary") or "").strip()[:300]
            if summary:
                normalized["summary"] = summary
        except Exception as exc:  # noqa: BLE001
            _log.warning("architect: proposed_changes normalize failed: %s", exc)
            normalized = None
    if not reply:
        reply = "Got it. Want me to make any specific changes?"
    return {"reply": reply, "proposed_changes": normalized}


def _normalize_draft(obj: dict) -> dict:
    """Coerce the LLM output into our expected shape, filling defaults."""
    name = str(obj.get("name") or "Untitled Agent").strip()[:120]
    atype = str(obj.get("type") or "knowledge").lower().strip()
    if atype not in ("knowledge", "goal"):
        atype = "knowledge"
    cfg = obj.get("config") or {}
    out_cfg = {
        "purpose": str(cfg.get("purpose") or "").strip()[:2000],
        "system_prompt": str(cfg.get("system_prompt") or "").strip()[:8000],
        "knowledge": str(cfg.get("knowledge") or "").strip()[:16000],
        "voice": str(cfg.get("voice") or "Ryan").strip()[:32] or "Ryan",
        "language": str(cfg.get("language") or "English").strip()[:32] or "English",
        "llm_model": str(cfg.get("llm_model") or "").strip()[:160],
        "temperature": float(cfg.get("temperature") or 0.6),
    }
    out_cfg["temperature"] = max(0.0, min(2.0, out_cfg["temperature"]))
    if atype == "goal":
        out_cfg["goal"] = str(cfg.get("goal") or "").strip()[:2000]
        out_cfg["success_metric"] = str(cfg.get("success_metric") or "").strip()[:2000]
        try:
            it = int(cfg.get("max_iterations") or 5)
        except Exception:
            it = 5
        out_cfg["max_iterations"] = max(1, min(AGENTS_LOOP_MAX_ITERATIONS_HARD, it))
    return {
        "name": name,
        "type": atype,
        "config": out_cfg,
        "note": str(obj.get("note") or "Draft updated.").strip()[:600],
    }


# ---------------------------------------------------------------------------
# Goal Agent loop runner (minimal real)
# ---------------------------------------------------------------------------


_running_runs: set[str] = set()  # in-memory guard against double-spawning a run


async def start_goal_run(*, run_id: str) -> None:
    """Background task entry. Loads the run + agent from DB and iterates."""
    if run_id in _running_runs:
        _log.warning("run %s already running; skipping spawn", run_id)
        return
    _running_runs.add(run_id)
    try:
        await _run_loop(run_id)
    except Exception as exc:  # noqa: BLE001
        _log.exception("goal run %s crashed: %s", run_id, exc)
        await _finalize_run(run_id, status="failed", error=str(exc)[:600])
    finally:
        _running_runs.discard(run_id)


async def _run_loop(run_id: str) -> None:
    conn = await get_connection()
    try:
        run_row = await (await conn.execute(
            "SELECT * FROM agent_runs WHERE id = ?", (run_id,)
        )).fetchone()
        if not run_row:
            return
        if run_row["status"] not in ("pending", "running"):
            return
        agent_row = await (await conn.execute(
            "SELECT * FROM agents WHERE id = ?", (run_row["agent_id"],)
        )).fetchone()
        if not agent_row:
            await _finalize_run(run_id, status="failed", error="agent missing", conn=conn)
            return
        cfg = json.loads(agent_row["config_json"])
        goal = run_row["goal"] or cfg.get("goal") or ""
        metric = run_row["success_metric"] or cfg.get("success_metric") or ""
        max_it = int(cfg.get("max_iterations") or 5)
        max_it = max(1, min(AGENTS_LOOP_MAX_ITERATIONS_HARD, max_it))
        system_prompt = cfg.get("system_prompt") or ""
        knowledge = cfg.get("knowledge") or ""
        temperature = float(cfg.get("temperature") or 0.6)

        await conn.execute(
            "UPDATE agent_runs SET status = ? WHERE id = ?",
            ("running", run_id),
        )
        await conn.commit()
    finally:
        await conn.close()

    iterations: list[dict] = []
    best_output: str | None = None
    best_score: float = -1.0

    for index in range(1, max_it + 1):
        # 1) check cancellation
        cancelled = await _check_cancelled(run_id)
        if cancelled:
            await _finalize_run(run_id, status="cancelled", best_output=best_output, best_score=best_score)
            return

        # 2) build the iteration prompt — show prior iterations so it can refine
        prior_summary = "\n\n".join(
            f"Iteration {it['index']} (score {it['score']:.2f}):\n{it['output'][:1000]}"
            for it in iterations[-3:]  # last 3 only, to keep context bounded
        ) or "(no prior iterations — this is the first attempt)"

        sys = (
            (system_prompt or "You are an autonomous agent that produces high-quality output toward a user goal.").strip()
            + "\n\nReply ONLY with a JSON object — no markdown, no prose outside the JSON. "
            + 'Shape: {"thought": "...", "output": "...", "score": 0.0-1.0, "rationale": "why that score"}'
        )
        usr_parts = [
            f"GOAL:\n{goal}",
            f"SUCCESS METRIC:\n{metric}" if metric else "",
            f"\nKNOWLEDGE:\n{knowledge}" if knowledge else "",
            f"\nPRIOR ITERATIONS:\n{prior_summary}",
            f"\nProduce iteration {index}/{max_it}. Improve on prior attempts (or produce your best first try). "
            "Be concrete — your 'output' is the deliverable. Be honest about 'score' (0-1) against the success metric.",
        ]
        usr = "\n".join(p for p in usr_parts if p)

        try:
            obj = await _chat_complete_json(
                system=sys,
                user=usr,
                temperature=temperature,
                max_tokens=2400,
            )
        except Exception as exc:  # noqa: BLE001
            _log.exception("iteration %d LLM call failed", index)
            await _finalize_run(run_id, status="failed", error=str(exc)[:600], best_output=best_output, best_score=best_score)
            return

        thought = str(obj.get("thought") or "").strip()[:4000]
        output = str(obj.get("output") or "").strip()[:8000]
        try:
            score = float(obj.get("score") or 0.0)
        except Exception:
            score = 0.0
        score = max(0.0, min(1.0, score))
        rationale = str(obj.get("rationale") or "").strip()[:2000]

        it_record = {
            "index": index,
            "thought": thought,
            "output": output,
            "score": score,
            "rationale": rationale,
            "created_at": _now_iso(),
        }
        iterations.append(it_record)

        if score > best_score and output:
            best_score = score
            best_output = output

        # 3) persist progress so the UI can poll
        await _persist_iterations(run_id, iterations, best_output, best_score)

        # 4) early exit on target
        if score >= AGENTS_LOOP_TARGET_SCORE:
            break

    await _finalize_run(run_id, status="completed", best_output=best_output, best_score=best_score)


async def _check_cancelled(run_id: str) -> bool:
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT status FROM agent_runs WHERE id = ?", (run_id,)
        )).fetchone()
        return bool(row and row["status"] == "cancelled")
    finally:
        await conn.close()


async def _persist_iterations(
    run_id: str,
    iterations: list[dict],
    best_output: Optional[str],
    best_score: float,
) -> None:
    conn = await get_connection()
    try:
        await conn.execute(
            """UPDATE agent_runs
               SET iterations_json = ?, best_output = ?, best_score = ?
               WHERE id = ?""",
            (
                json.dumps(iterations, ensure_ascii=False),
                best_output,
                None if best_score < 0 else best_score,
                run_id,
            ),
        )
        await conn.commit()
    finally:
        await conn.close()


async def _finalize_run(
    run_id: str,
    *,
    status: str,
    best_output: Optional[str] = None,
    best_score: Optional[float] = None,
    error: Optional[str] = None,
    conn: Any = None,
) -> None:
    own = conn is None
    if own:
        conn = await get_connection()
    try:
        # Build SET clause dynamically so we don't blat fields that are None
        fields = ["status = ?", "finished_at = datetime('now')"]
        values: list[Any] = [status]
        if best_output is not None:
            fields.append("best_output = ?")
            values.append(best_output)
        if best_score is not None and best_score >= 0:
            fields.append("best_score = ?")
            values.append(best_score)
        if error is not None:
            fields.append("error = ?")
            values.append(error)
        values.append(run_id)
        await conn.execute(f"UPDATE agent_runs SET {', '.join(fields)} WHERE id = ?", tuple(values))
        # bump agent run_count + last_run_at
        run_row = await (await conn.execute("SELECT agent_id FROM agent_runs WHERE id = ?", (run_id,))).fetchone()
        if run_row:
            await conn.execute(
                "UPDATE agents SET run_count = run_count + 1, last_run_at = datetime('now') WHERE id = ?",
                (run_row["agent_id"],),
            )
        await conn.commit()
    finally:
        if own:
            await conn.close()


def new_id() -> str:
    return uuid.uuid4().hex
