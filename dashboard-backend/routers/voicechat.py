"""Voice-chat WebSocket endpoint for the in-Studio assistant bot.

Wire protocol — client ↔ server, all control via JSON text frames, audio
back to client as raw binary PCM16 LE frames.

Client → Server (text frames):
  - {"type":"voice", "audio_b64":"<base64 webm/wav/etc>", "language":"en", "filename":"clip.webm"}
  - {"type":"text",  "text":"hello"}                          # text-only turn
  - {"type":"cancel"}                                          # barge-in / abort current turn

Server → Client (text frames):
  - {"type":"ready",      "session_id":"..."}
  - {"type":"transcript", "text":"...", "language":"en"}
  - {"type":"token",      "text":"..."}                        # LLM delta
  - {"type":"audio_meta", "sentence_id":N, "sample_rate":24000,"frame_ms":40}
  - <binary>  PCM16LE frames belonging to the most recent audio_meta
  - {"type":"audio_end",  "sentence_id":N}
  - {"type":"turn_end"}
  - {"type":"error",      "code":"...", "message":"..."}

Auth: JWT in `?token=...` query param (browsers can't set Authorization on
WS upgrade easily). Falls back to `Authorization: Bearer ...` header for
non-browser callers.
"""

from __future__ import annotations

import asyncio
import base64
import hmac
import json
import logging
import os
import random
import time
from datetime import datetime, timezone


def _utcnow_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
import uuid

import embed_tokens
from contextlib import suppress
from typing import Any, Callable, Optional

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect

import json

import agent_knowledge
import agent_templates
from assistant_knowledge_indexer import ASSISTANT_AGENT_ID
from local_db import get_connection
from routers.auth import _decode_token, _get_user_by_id  # type: ignore
from studio_tts_service import transcribe_audio, transcribe_audio_streaming
from voicechat_knowledge import VOICE_CHAT_FORMAT_RULES, get_system_prompt
from voicechat_service import (
    QWEN3_TTS_BASE_URL,
    VOCENCE_ASSISTANT_VOICE,
    VOICECHAT_TTS_ENABLED,
    ChatMessage,
    SentenceChunker,
    check_rate_limit,
    llm_configured,
    maybe_summarize_conversation,
    JsonLeakFilter,
    NarrationPrefixScrubber,
    sanitize_for_tts,
    stream_llm,
    stream_tts_for_voice,
    VOICECHAT_EXTRA_SYSTEM_PROMPT,
)
import agent_tools_service
from call_recorder import CallRecorder
from llm_client import stream_chat_with_tools

# Tool calling: cap how many LLM↔tool round-trips a single turn can do.
# Most legit queries finish in 1 tool call ("what's the weather in Tokyo");
# pathological loops (LLM keeps re-calling the same tool) are stopped here.
MAX_TOOL_DEPTH = int(os.environ.get("VOICECHAT_MAX_TOOL_DEPTH") or "2")


# Cumulative chars emitted to TTS via the per-sentence path before we flip
# to whole-tail mode. Short replies (≤ 300 chars) ride the fast,
# sentence-by-sentence path the entire turn — TTFA stays low. Longer
# replies switch to accumulating the rest into one final TTS call so the
# bulk of the answer keeps coherent prosody.
WHOLE_REPLY_CHUNK_THRESHOLD = int(os.environ.get("VOICECHAT_WHOLE_REPLY_THRESHOLD") or "300")


# -----------------------------------------------------------------------
# Filler audio ("Hmm, let me check…") — fired when the LLM is going to
# take a perceptible amount of time to produce its first content token.
# The goal is perceived responsiveness: even when real TTFT is 800ms,
# the user hears something natural-sounding within ~400ms so it feels
# instant. The filler is synthesised through the same TTS path as the
# real reply (same voice), queued ahead of real audio, and shown in
# the chat bubble so text + audio stay in lockstep. If the LLM is fast
# enough that real content arrives before the filler timer fires, no
# filler is emitted at all and the turn behaves exactly as before.
# Fillers ("Hmm,", "Okay,") are DISABLED by default.
# Reason: Qwen3-TTS voice cloning needs ~100-200 ms of acoustic frames to
# settle into the target voice. For ≤8-char fillers (~300 ms audio) the
# entire utterance falls inside that unsettled prefix — the user hears the
# filler in a noticeably off voice. With the new qwen3-tts-streaming server
# hitting ~200 ms TTFA, the filler doesn't meaningfully mask LLM latency
# anyway. Set VOICECHAT_FILLERS_ENABLED=1 to re-enable for experimentation.
VOICECHAT_FILLERS_ENABLED = os.environ.get("VOICECHAT_FILLERS_ENABLED", "0").strip().lower() in {"1", "true", "yes"}
# How long to wait for the first real LLM content token before kicking off
# a filler. Tightened from 350 → 250 ms now that the frontend bypasses the
# prebuffer for filler audio (audio_meta.is_filler=true → 80 ms prebuffer
# instead of 1500 ms). With fast LLMs (Cerebras TTFT ~150 ms) the filler
# still never fires; with slow LLMs (OpenAI 500+ ms) it fires ~100 ms
# sooner so the user hears something sooner.
VOICECHAT_FILLER_DELAY_MS = int(os.environ.get("VOICECHAT_FILLER_DELAY_MS") or "250")

# Filler phrases — kept short (≤ 8 chars / ~400 ms of audio) so the audio
# stops by the time real reply audio arrives. Longer fillers (e.g.
# "Hmm, let me think.") just delay the real answer without adding
# perceived responsiveness. Round 0 = pre-content; later rounds = post-tool.
_FILLER_PHRASES_INITIAL: tuple[str, ...] = (
    "Hmm,",
    "Okay,",
    "Right,",
    "Sure,",
    "Mm-hmm,",
    "One sec,",
)
_FILLER_PHRASES_AFTER_TOOL: tuple[str, ...] = (
    "Got it.",
    "Right, so",
    "Okay,",
    "Alright,",
)


def _pick_filler(round_depth: int) -> str:
    pool = _FILLER_PHRASES_AFTER_TOOL if round_depth > 0 else _FILLER_PHRASES_INITIAL
    return random.choice(pool)

# Optional: STT capacity gate (lazy import — fall back to None if jobs system unavailable)
try:
    from jobs.registry import STT_CAP, STT_POOL  # type: ignore
except Exception:  # pragma: no cover
    STT_CAP = None
    STT_POOL = None

_log = logging.getLogger(__name__)
router = APIRouter(prefix="/voicechat", tags=["voicechat"])


MAX_HISTORY_TURNS = 20  # cap conversation context to keep latency low
MAX_USER_MESSAGE_CHARS = 4000


# Universal tool-call hygiene rules. Some open-weight models (Cerebras
# gpt-oss variants) bypass the structured tool-call protocol and emit
# inline JSON / chain-of-thought narration that leaks to the chat UI.
# We patch their behaviour with a hard-rule block that goes into every
# agent's system prompt regardless of which prompt-assembly path runs.
TOOL_CALL_HYGIENE_RULES = (
    "# Tool-call hygiene (HARD RULES)\n"
    "- Invoke tools through the structured tool-call mechanism only. "
    "NEVER write tool calls as JSON in your message text (no `{\"tool\":...}`, "
    "no `{\"name\":...,\"arguments\":...}`, no `{\"response\":\"pending\"}`).\n"
    "- **NEVER announce what you're ABOUT to do.** Decide internally and "
    "fire the tool call SILENTLY. The user sees a tool indicator chip "
    "from the UI on their own — they don't need a sentence about it.\n"
    "  FORBIDDEN pre-call phrases (and any rewording of these):\n"
    "    ✗ \"Let me search for that…\"\n"
    "    ✗ \"I'll look that up.\"\n"
    "    ✗ \"Attempting web search for…\"\n"
    "    ✗ \"I'm pulling up the latest…\"\n"
    "    ✗ \"One moment / one sec / give me a moment…\"\n"
    "    ✗ \"Hold on while I…\"\n"
    "    ✗ \"Let me check…\"\n"
    "    ✗ \"Calling X now…\"\n"
    "    ✗ \"Searching now…\"\n"
    "  The correct behaviour: if you need a tool, output ONLY the tool "
    "call — zero text content tokens before it.\n"
    "- Do NOT narrate the tool lifecycle mid-call either. Don't say "
    "\"we need to wait for the tool to return\", \"no result yet\", "
    "\"the response is pending\", or any equivalent.\n"
    "- After a tool result arrives, jump straight into the answer as if "
    "you always knew it. Don't preface with \"based on the search "
    "results\" / \"according to my search\" / \"I found that\" — just "
    "answer the question naturally."
)


def _decode_user_from_token(token: str | None) -> str | None:
    if not token:
        return None
    try:
        decoded = _decode_token(token)
        return decoded.get("userId")
    except HTTPException:
        return None
    except Exception:
        return None


async def _log_call_session(
    *,
    session_id: str,
    user_id: str,
    agent_id: str | None,
    agent_name: str | None,
    started_at_iso: str,
    ended_at_iso: str,
    duration_ms: int,
    end_reason: str,
    recording_path: str | None = None,
    recording_bucket: str | None = None,
    recording_bytes: int | None = None,
) -> None:
    """Persist a session-level row to ``voice_call_logs`` once a voice
    call ends. Turn count + char totals are derived from the per-turn
    rows in ``studio_voicechat_history`` that already share this
    session_id, so the row stays consistent with the existing
    per-turn history without duplicating data.

    Idempotent on session_id (INSERT OR REPLACE) so a reconnect
    storm or a retried close path can't fail the write.

    Non-fatal — analytics aren't user-visible during the call, and
    we don't want a SQLite hiccup to spam errors in the WS log.
    """
    try:
        conn = await get_connection()
        try:
            row = await (await conn.execute(
                """
                SELECT
                    COALESCE(SUM(LENGTH(COALESCE(user_text, ''))), 0) AS user_chars,
                    COALESCE(SUM(LENGTH(COALESCE(bot_text, ''))), 0) AS agent_chars,
                    COUNT(*) AS turn_count
                FROM studio_voicechat_history
                WHERE session_id = ?
                """,
                (session_id,),
            )).fetchone()
            user_chars = int(row[0]) if row else 0
            agent_chars = int(row[1]) if row else 0
            turn_count = int(row[2]) if row else 0
            await conn.execute(
                """
                INSERT OR REPLACE INTO voice_call_logs
                (session_id, user_id, agent_id, agent_name, started_at, ended_at,
                 duration_ms, end_reason, turn_count, user_chars, agent_chars,
                 recording_path, recording_bucket, recording_bytes)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    user_id,
                    agent_id,
                    agent_name,
                    started_at_iso,
                    ended_at_iso,
                    duration_ms,
                    end_reason,
                    turn_count,
                    user_chars,
                    agent_chars,
                    recording_path,
                    recording_bucket,
                    recording_bytes,
                ),
            )
            await conn.commit()
        finally:
            await conn.close()
    except Exception:
        _log.exception("failed to log voice call session (non-fatal)")


async def _record_turn(
    *,
    user_id: str,
    user_text: str,
    bot_text: str,
    mode: str,
    latency_ms: int,
    ttft_ms: int,
    ttfa_ms: int | None,
    error: str | None,
    session_id: str | None = None,
    agent_id: str | None = None,
) -> None:
    # Apply PII redaction at the storage boundary. The in-memory
    # ``conversation`` passed to the LLM is NOT touched — the agent
    # still reacts to what was actually said. Only the durable
    # transcript surfaces (transcript modal, session replay,
    # transcript search) see the redacted form. No-op when
    # VOCENCE_PII_REDACTION is off.
    from pii_redaction import redact_pii_text
    safe_user = redact_pii_text(user_text)
    safe_bot = redact_pii_text(bot_text)
    try:
        conn = await get_connection()
        try:
            await conn.execute(
                """
                INSERT INTO studio_voicechat_history
                (user_id, mode, user_text, bot_text, latency_ms, ttft_ms, ttfa_ms, error,
                 status, session_id, agent_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                """,
                (
                    user_id,
                    mode,
                    safe_user[:8000],
                    safe_bot[:16000],
                    latency_ms,
                    ttft_ms,
                    ttfa_ms,
                    error[:500] if error else None,
                    "completed" if not error else "failed",
                    session_id,
                    agent_id,
                ),
            )
            await conn.commit()
        finally:
            await conn.close()
    except Exception:
        _log.exception("failed to record voicechat turn (non-fatal)")


async def _load_agent_for_user(agent_id: str, user_id: str) -> dict | None:
    """Return the agent's stored config (with name and status) if it
    exists and is owned by this user. Returns None if not found or
    owned by someone else."""
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT name, type, status, config_json FROM agents WHERE id = ? AND user_id = ?",
            (agent_id, user_id),
        )).fetchone()
        if not row:
            return None
        cfg = json.loads(row["config_json"] or "{}")
        return {
            "name": row["name"],
            "type": row["type"],
            "status": row["status"] or "active",
            "config": cfg,
        }
    finally:
        await conn.close()


async def _load_custom_tools_for_agent(
    agent_id: str, user_id: str,
) -> list[agent_tools_service.CustomToolDef]:
    """Load every custom tool currently bound to this agent. Filtered
    by ``user_id`` on the tool definition as a double-check: a binding
    row alone isn't enough to authorize execution — the tool's owner
    must match the caller. This matters when an agent gets transferred
    or copied across users in the future."""
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            """
            SELECT t.id, t.user_id, t.name, t.description, t.parameters_json,
                   t.endpoint_url, t.method, t.auth_type, t.auth_header_name,
                   t.auth_secret, t.timeout_ms
            FROM agent_custom_tool_bindings b
            JOIN agent_custom_tools t ON t.id = b.tool_id
            WHERE b.agent_id = ? AND t.user_id = ?
            """,
            (agent_id, user_id),
        )).fetchall()
    finally:
        await conn.close()
    out: list[agent_tools_service.CustomToolDef] = []
    for r in rows:
        try:
            params = json.loads(r["parameters_json"] or "{}")
        except json.JSONDecodeError:
            params = {"type": "object", "properties": {}}
        out.append(agent_tools_service.CustomToolDef(
            id=r["id"],
            user_id=r["user_id"],
            name=r["name"],
            description=r["description"] or "",
            parameters=params,
            endpoint_url=r["endpoint_url"],
            method=r["method"] or "POST",
            auth_type=r["auth_type"] or "none",
            auth_header_name=r["auth_header_name"],
            auth_secret=r["auth_secret"],
            timeout_ms=int(r["timeout_ms"] or 5000),
        ))
    return out


@router.websocket("/session")
async def voicechat_session(
    ws: WebSocket,
    token: str | None = Query(default=None),
    agent_id: str | None = Query(default=None),
    user_id_override: str | None = Query(default=None, alias="user_id"),
) -> None:
    # Auth — three accepted paths, in priority order:
    #   1. INTERNAL: service-to-service. The developer-api service
    #      (the public agent API) authenticates the API-key caller on
    #      its side, then proxies into us with an ``X-Internal-Service-Token``
    #      header + an explicit ``user_id`` query param. We trust the
    #      user_id only when (a) the shared secret matches AND (b) the
    #      source IP is in INTERNAL_TRUST_ALLOWED_IPS (defaults to
    #      loopback only). If the token were to leak, this IP check
    #      still prevents public abuse — an attacker would also need to
    #      get a request to arrive from a trusted source IP, which
    #      requires either compromising the box or finding a SSRF in
    #      a trusted neighbor.
    #   2. JWT via ``token`` query param (the website's voice chat flow,
    #      where the JWT can't easily ride in headers from a browser WS).
    #   3. JWT via ``Authorization: Bearer ...`` header (fallback for
    #      non-browser clients).
    auth_user_id: str | None = None
    internal_token = ws.headers.get("x-internal-service-token") or ws.headers.get(
        "X-Internal-Service-Token"
    )
    expected_internal_token = (os.environ.get("INTERNAL_SERVICE_TOKEN") or "").strip()
    # Comma-separated list of source IPs allowed to use the internal-trust
    # path. Defaults to loopback. Add the developer-api's IP if it runs on
    # a separate box (or use a private subnet CIDR via a real ACL).
    allowed_internal_ips = {
        ip.strip()
        for ip in (os.environ.get("INTERNAL_TRUST_ALLOWED_IPS") or "127.0.0.1,::1").split(",")
        if ip.strip()
    }
    client_host = (ws.client.host if ws.client else "") or ""
    if (
        internal_token
        and expected_internal_token
        and hmac.compare_digest(internal_token, expected_internal_token)
        and user_id_override
        and client_host in allowed_internal_ips
    ):
        auth_user_id = user_id_override.strip() or None
    elif internal_token and (client_host not in allowed_internal_ips):
        # Someone is sending the internal-trust header from an untrusted
        # source IP. Either a misconfigured proxy or an attacker probing.
        # Log so operators see this; do NOT honor the header.
        _log.warning(
            "voicechat: rejected internal-trust header from untrusted client_host=%s",
            client_host,
        )
        auth_user_id = None
    else:
        # Cookie path (preferred for browser sessions, post-migration).
        # Starlette parses cookies from the WebSocket handshake the same
        # way it parses them for HTTP requests. The session cookie is
        # HttpOnly so JS can't read it, but the browser still sends it
        # on the WS upgrade. This replaces the ?token=... query param
        # for browser flows once localStorage is dropped (phase 4).
        from routers.auth import SESSION_COOKIE_NAME
        cookie_token = ws.cookies.get(SESSION_COOKIE_NAME)
        if cookie_token:
            auth_user_id = _decode_user_from_token(cookie_token)
        # Query-param fallback for backwards compat during migration.
        if not auth_user_id:
            auth_user_id = _decode_user_from_token(token)
        if not auth_user_id:
            auth_header = ws.headers.get("authorization") or ws.headers.get("Authorization")
            if auth_header and auth_header.lower().startswith("bearer "):
                auth_user_id = _decode_user_from_token(auth_header.split(" ", 1)[1])

    # Embed-token path: anonymous visitors on customer sites present
    # ``?token=vet_...`` instead of a JWT. The widget reads the agent
    # owner's stored token; if it validates we treat the session as
    # owned-by + billed-to the agent owner. The agent_id from the
    # token wins over any caller-supplied agent_id query param.
    embed_ctx = None
    if not auth_user_id and embed_tokens.looks_like_embed_token(token):
        from local_db import get_connection
        conn = await get_connection()
        try:
            try:
                embed_ctx = await embed_tokens.validate_embed_token(
                    conn,
                    plaintext=token or "",
                    origin=ws.headers.get("origin"),
                    ip=client_host,
                )
                auth_user_id = embed_ctx.owner_user_id
                # The widget never sees agent_id query — the token IS
                # the binding. Override any caller-supplied value so
                # malicious request crafting can't redirect to a
                # different agent.
                agent_id = embed_ctx.agent_id
            except embed_tokens.EmbedTokenError as exc:
                await ws.accept()
                await ws.send_json({
                    "type": "error",
                    "code": exc.code,
                    "message": exc.message,
                })
                await ws.close(code=4401)
                return
        finally:
            await conn.close()

    if not auth_user_id and embed_ctx is None:
        await ws.accept()
        # Surface this loudly — silently closing on auth-fail was hiding
        # the COOKIE_SECURE=true-on-http misconfig that broke local dev.
        # Caller can correlate the client port from uvicorn's WS accept line.
        cookie_names = list(ws.cookies.keys())
        _log.info(
            "voicechat: AUTH FAILED on WS connect — no valid token. "
            "client_host=%s cookies_present=%s query_token=%s (likely a "
            "missing/expired session cookie; on HTTP localhost ensure "
            "COOKIE_SECURE=false in the backend .env)",
            client_host, cookie_names, "yes" if token else "no",
        )
        await ws.send_json({"type": "error", "code": "auth_required", "message": "missing or invalid token"})
        await ws.close(code=4401)
        return

    if embed_ctx is None:
        await ws.accept()

    user = await _get_user_by_id(auth_user_id)
    if not user:
        _log.info("voicechat: AUTH FAILED — user_id=%s not found in DB", auth_user_id)
        await ws.send_json({"type": "error", "code": "user_not_found", "message": "user no longer exists"})
        await ws.close(code=4401)
        return

    if not llm_configured():
        await ws.send_json({"type": "error", "code": "llm_not_configured", "message": "assistant offline"})
        await ws.close(code=4503)
        return
    # TTS is reachable iff (a) the legacy direct URL is set OR (b) at
    # least one streaming-TTS ops pod is online. The legacy env-var
    # path is deprecated (see dashboard-backend/.env) — most deploys
    # rely entirely on the ops dispatcher now.
    tts_via_ops = False
    try:
        from ops import pool as _gpu_pool
        tts_via_ops = _gpu_pool.online_pod_count("tts_streaming") > 0
    except Exception:
        tts_via_ops = False
    if not (QWEN3_TTS_BASE_URL or tts_via_ops):
        _log.warning(
            "voicechat: closing WS — TTS not configured "
            "(QWEN3_TTS_BASE_URL set=%s, tts_streaming pod online=%s)",
            bool(QWEN3_TTS_BASE_URL), tts_via_ops,
        )
        await ws.send_json({"type": "error", "code": "tts_not_configured", "message": "assistant offline"})
        await ws.close(code=4503)
        return

    # If an agent_id was provided, load that agent's config so we can talk
    # AS that agent (system prompt + voice override). Otherwise fall back to
    # the default Vocence Assistant.
    agent_ctx: dict | None = None
    if agent_id:
        agent_ctx = await _load_agent_for_user(agent_id, auth_user_id)
        if not agent_ctx:
            await ws.send_json({"type": "error", "code": "agent_not_found", "message": "agent not found"})
            await ws.close(code=4404)
            return
        # Gate on agent status. ``draft`` is allowed so users can test an
        # agent before activating; ``paused`` and ``archived`` block chat
        # so the status indicator finally has teeth.
        agent_status = agent_ctx.get("status") or "active"
        if agent_status in {"paused", "archived"}:
            await ws.send_json({
                "type": "error",
                "code": f"agent_{agent_status}",
                "message": (
                    "this agent is paused — resume it from settings to chat"
                    if agent_status == "paused"
                    else "this agent is archived — restore it from settings to chat"
                ),
            })
            await ws.close(code=4423)
            return

    # UUID4 hex — collision-safe across users + time. Used as the
    # ``reference_id`` on the billing transaction row so the prior
    # ``vc-<millis>-<user_prefix>`` pattern's same-millisecond collision
    # risk is gone.
    session_id = f"vc-{uuid.uuid4().hex[:16]}"
    _session_open_perf = time.perf_counter()
    _session_started_iso = _utcnow_iso()
    _log.info(
        "[stream] trace session=%s phase=session_open auth_user_id=%s agent_id=%s",
        session_id, auth_user_id, agent_id,
    )
    # Session-end metadata accumulated across the call lifetime and
    # flushed to voice_call_logs in the session_close finally block.
    # ``reason`` reflects the LAST signal we saw: client disconnect
    # (= user_hangup), watchdog auto-end (max_duration / idle_timeout
    # / free_time_up), billing exhausted, or error. Default
    # "user_hangup" because if nothing else fires before the WS
    # closes, the user closed it themselves.
    _session_end_reason = "user_hangup"
    _session_turn_count = 0

    # Optional stereo recording. Started here so push_user from
    # the streaming session and push_agent from _speak_pretext /
    # TTS path can both tee frames into the same recorder. Gated
    # on the agent's record_enabled flag — Logos (no agent_ctx)
    # never records. The session-close finally block awaits its
    # close() and uses the returned (path, bytes) for the call log.
    call_recorder: CallRecorder | None = None

    # ── Session watchdog + (paid agents only) per-minute billing ──────
    # A ``VoiceAgentBilling`` instance always exists for every session —
    # paid voice agents get the real billing loop; the free Vocence
    # Assistant gets ``free_mode=True`` so the max-duration + idle
    # watchdogs still close runaway sessions, but no credits are
    # deducted and no transaction row is written.
    from voice_agent_billing import (
        VoiceAgentBilling,
        precheck_balance,
        credits_for_seconds,
        VOICE_AGENT_CREDITS_PER_MIN,
        MIN_CHARGE_SEC,
        MAX_SESSION_SEC,
        IDLE_TIMEOUT_SEC,
        INCREMENT_SEC,
        LOGOS_FREE_MAX_SESSION_SEC,
    )

    paid_agent = bool(agent_id)
    if paid_agent:
        ok, balance = await precheck_balance(auth_user_id)
        if not ok:
            min_charge = credits_for_seconds(MIN_CHARGE_SEC)
            await ws.send_json({
                "type": "error",
                "code": "insufficient_credits",
                "message": (
                    f"Voice agents cost {VOICE_AGENT_CREDITS_PER_MIN} credits/min. "
                    f"You need at least {min_charge} credits to start a session — you have {balance}."
                ),
            })
            await ws.close(code=4402)
            return

    async def _on_session_end(reason: str) -> None:
        """Routes the billing-loop's auto-end reason to the right WS
        close code + message. Centralized here so all auto-end paths
        (balance exhausted, max duration, idle, free-time-up) share
        one handler. REASON_EXHAUSTED can't fire in free mode (no
        deductions)."""
        nonlocal _session_end_reason
        # Stash the auto-end reason for the session-close logger to
        # persist into voice_call_logs. ``reason`` from the billing
        # loop is one of the REASON_* constants (free_time_up,
        # max_duration, idle_timeout, exhausted); we map exhausted →
        # billing_exhausted to match the visible code on the wire.
        if reason == VoiceAgentBilling.REASON_EXHAUSTED:
            _session_end_reason = "billing_exhausted"
        else:
            _session_end_reason = reason

        # Logos (free) hit its free-time cap. Special-case: interrupt
        # whatever's happening, have the assistant SPEAK a farewell
        # (so the user hears it rather than just seeing a close
        # banner), then close cleanly. The visible system-message
        # payload carries a code/message the UI can render alongside
        # the chat bubble.
        if reason == VoiceAgentBilling.REASON_FREE_TIME_UP:
            farewell = LOGOS_FAREWELL_MESSAGE
            # 1. Tear down any in-flight turn (TTS mid-stream, LLM
            #    mid-call, user mid-utterance). _cancel_current is
            #    defined later in voicechat_session — referenced here
            #    via Python's late-binding closure, which resolves at
            #    call time.
            with suppress(Exception):
                await _cancel_current()
            # 2. Reset the client's per-turn state with an explicit
            #    ``cancelled`` envelope. Without this the previous
            #    turn's ``audioStartedForTurnRef`` may still be true
            #    (no turn_end fired, the agent was barge-in'd mid-
            #    speech), and when the farewell's binary frames
            #    arrive the player's "first audio of turn" branch
            #    won't trigger ``startRevealTimer()`` — symptom: the
            #    farewell plays but no text appears in the chat
            #    bubble. The cancelled handler clears
            #    audioStartedForTurnRef, revealStateRef, and
            #    currentBotMsgIdRef, so the farewell paces correctly.
            with suppress(Exception):
                await ws.send_json({"type": "cancelled"})
            # 3. Speak the farewell as a NORMAL assistant turn:
            #    token → audio_meta → audio bytes. The chat bubble
            #    paces with the audio (no early flash) and there's
            #    exactly one bubble.
            with suppress(Exception):
                await _speak_pretext(farewell)
            with suppress(Exception):
                await ws.send_json({"type": "turn_end"})
            # 4. Now signal teardown. No ``message`` field — the
            #    farewell already showed up as the assistant turn
            #    above; this event just tells the UI to close the
            #    call (drop the mic / flip the button back to Start).
            with suppress(Exception):
                await ws.send_json({
                    "type": "session_timeout",
                    "code": "free_time_up",
                })
            # 5. Close the WS gracefully. 4408 (same code paid agents
            #    use for max_duration) signals "policy ended this
            #    session" — the frontend already handles 4408 as a
            #    natural-end, not an error.
            with suppress(Exception):
                await ws.close(code=4408)
            return

        if reason == VoiceAgentBilling.REASON_EXHAUSTED:
            payload = {
                "type": "billing_exhausted",
                "message": "Voice agent session ended — credit balance reached zero.",
            }
            close_code = 4402
        elif reason == VoiceAgentBilling.REASON_MAX_DURATION:
            payload = {
                "type": "session_timeout",
                "code": "max_duration",
                "message": f"Session ended — reached the {MAX_SESSION_SEC // 60} min maximum length.",
            }
            close_code = 4408
        elif reason == VoiceAgentBilling.REASON_IDLE_TIMEOUT:
            payload = {
                "type": "session_timeout",
                "code": "idle_timeout",
                "message": f"Session ended — no activity for {IDLE_TIMEOUT_SEC}s.",
            }
            close_code = 4410
        else:
            payload = {"type": "error", "code": "session_ended", "message": reason}
            close_code = 4500
        with suppress(Exception):
            await ws.send_json(payload)
        with suppress(Exception):
            await ws.close(code=close_code)


    # Spoken when a Logos session hits the free-time cap. Written in
    # Logos's voice style (warm, contractions, short sentences — see
    # voicechat_knowledge.SYSTEM_PROMPT). Reads naturally when the
    # TTS pipeline reads it aloud.
    LOGOS_FAREWELL_MESSAGE = (
        "Alright, the time's up. To keep chatting, sign in and grab "
        "some credits, then create your own agent — you'll be able to "
        "talk with it for up to thirty minutes per session. Thanks for "
        "visiting — bye!"
    )

    async def _on_billing_deduct(new_balance: int) -> None:
        """After every per-minute deduction (and the final
        reconciliation), push the live balance to the client so the
        sidebar credits counter updates without a page reload. Free
        sessions never deduct → this never fires for the Vocence
        Assistant."""
        with suppress(Exception):
            await ws.send_json({
                "type": "billing_update",
                "credits_remaining": new_balance,
            })

    billing = VoiceAgentBilling(
        user_id=auth_user_id,
        session_id=session_id,
        agent_id=agent_id or "_assistant",
        on_session_end=_on_session_end,
        on_deduct=_on_billing_deduct,
        free_mode=not paid_agent,
        # Logos (free) sessions get a tight free-time cap. Paid agents
        # ignore this — None means "no extra limit, just use the
        # platform MAX_SESSION_SEC of 30 min".
        free_max_sec=float(LOGOS_FREE_MAX_SESSION_SEC) if not paid_agent else None,
    )

    # Send ready — client may have already disconnected (e.g., React.StrictMode
    # dev double-mount). Don't crash on that, the next mount will reconnect.
    try:
        ready_payload: dict[str, object] = {
            "type": "ready",
            "session_id": session_id,
            "agent": agent_ctx and {"id": agent_id, "name": agent_ctx["name"]},
            "session": {
                "max_duration_sec": MAX_SESSION_SEC,
                "idle_timeout_sec": IDLE_TIMEOUT_SEC,
            },
        }
        if paid_agent:
            ready_payload["billing"] = {
                "credits_per_min": VOICE_AGENT_CREDITS_PER_MIN,
                "increment_sec": INCREMENT_SEC,
                "min_charge_sec": MIN_CHARGE_SEC,
            }
        # Advertise the streaming-voice path so capable clients can opt
        # into it (PCM frames over WS + server-side ensembler turn-end).
        # Streaming requires a streaming-STT pod to be online; without
        # one, clients should fall back to one-shot ``voice`` uploads.
        #
        # KILL SWITCH: set ``VOICECHAT_DISABLE_STREAM=1`` to force every
        # client onto the segment (WAV upload) path even when the pod
        # is online. We use this when the live-PCM → /v1/stream path is
        # returning empty transcripts that the equivalent WAV upload
        # transcribes correctly — same audio, same pod, different wire
        # format. Defaults to OFF (set the env var to opt out of stream).
        force_segment_only = (os.environ.get("VOICECHAT_DISABLE_STREAM") or "").strip() in {"1", "true", "yes"}
        try:
            from ops import pool as _gpu_pool
            streaming_stt_online = _gpu_pool.online_pod_count("asr_streaming_rt") > 0
            turn_detection_online = _gpu_pool.online_pod_count("turn_detection") > 0
        except Exception:
            streaming_stt_online = False
            turn_detection_online = False
        ready_payload["capabilities"] = {
            "voice_stream": streaming_stt_online and not force_segment_only,
            "turn_detection": turn_detection_online,
            "frame": {"sample_rate": 16000, "encoding": "pcm_s16le", "frame_ms": 20},
        }
        await ws.send_json(ready_payload)
    except WebSocketDisconnect:
        return
    except Exception:
        _log.debug("voicechat: client disconnected before ready ack", exc_info=False)
        return

    # Start the watchdog/billing loop AFTER the ready ack so setup
    # time doesn't get billed (and on the free path, doesn't get
    # included in the idle countdown).
    billing.start()

    # Resolve which tools this agent can call this session — we need
    # this BOTH for the per-turn tool_specs (further down) AND for the
    # system prompt so the LLM is explicitly told to USE the tools when
    # it doesn't know something, rather than just saying "I don't know".
    # Without this nudge, models like gpt-4o-mini wait to be told
    # "search the web" before they ever fire a tool — by the time the
    # user has to ask twice, the latency advantage of having tools is
    # gone. ``None`` means "every available tool" (Logos / no-agent).
    agent_enabled_tools_cfg = (agent_ctx and (agent_ctx.get("config") or {}).get("enabled_tools"))
    if isinstance(agent_enabled_tools_cfg, list):
        enabled_tools_set: set[str] | None = {str(t) for t in agent_enabled_tools_cfg if isinstance(t, str)}
    else:
        enabled_tools_set = None  # None means "all available"

    # Start the call recorder if the agent has it enabled. Logos
    # (no agent_ctx → free assistant, no privacy contract with the
    # caller) never records. Recorder is best-effort: any error
    # during capture is swallowed and recording_path stays NULL on
    # the call log row.
    record_enabled_for_session = bool(
        agent_ctx
        and isinstance(agent_ctx.get("config"), dict)
        and agent_ctx["config"].get("record_enabled")
    )
    if record_enabled_for_session:
        call_recorder = CallRecorder(
            user_id=auth_user_id,
            session_id=session_id,
        )
        call_recorder.start()
        _log.info(
            "[stream] trace session=%s phase=recording_started destination=object_store",
            session_id,
        )
    # Compute the builtin spec list once. Custom tools are loaded
    # per-turn (the user can rebind them mid-session), but their
    # purpose hints are added below if any are bound at session-start.
    session_builtin_specs = agent_tools_service.tool_specs(enabled=enabled_tools_set)
    session_custom_tools: list[agent_tools_service.CustomToolDef] = []
    if agent_ctx and agent_id:
        try:
            session_custom_tools = await _load_custom_tools_for_agent(agent_id, auth_user_id)
        except Exception:
            session_custom_tools = []

    def _tool_one_liner(name: str, description: str) -> str:
        # Trim long tool descriptions to a single line for the prompt —
        # the LLM has the full spec separately when it decides to call.
        first = (description or "").strip().split("\n", 1)[0]
        if len(first) > 140:
            first = first[:137].rstrip() + "…"
        return f"- `{name}` — {first}" if first else f"- `{name}`"

    tool_hints: list[str] = []
    for spec in session_builtin_specs:
        fn = spec.get("function") or {}
        tool_hints.append(_tool_one_liner(fn.get("name") or "", fn.get("description") or ""))
    for t in session_custom_tools:
        tool_hints.append(_tool_one_liner(t.name, t.description))
    has_research_tool = any(
        name in (enabled_tools_set or {"web_search", "fetch_url", "wikipedia_lookup"})
        for name in ("web_search", "fetch_url", "wikipedia_lookup")
    ) if session_builtin_specs else False

    # Build the system prompt. Strategy:
    #
    #   • Modern agents (created via the template gallery) already contain a
    #     complete, sectioned system_prompt in cfg.system_prompt. We use it
    #     AS-IS and prepend agent_templates.SAFETY_PREAMBLE for non-overridable
    #     TTS-format rules. What the user sees in the Studio editor is exactly
    #     what runs — no hidden section assembly.
    #
    #   • Legacy agents (created before templates existed) have an empty
    #     cfg.system_prompt. For those we fall through to the old layered
    #     assembly so they keep working without a migration.
    #
    #   • The standalone Vocence Assistant uses its own get_system_prompt().
    #
    # Knowledge is still injected per-turn via RAG below (no change).
    agent_language: str | None = None
    if agent_ctx and (agent_ctx["config"].get("language") or "").strip().lower() not in ("", "auto"):
        agent_language = (agent_ctx["config"]["language"]).strip()
    knowledge_uses_rag = False
    if agent_ctx:
        cfg = agent_ctx["config"]
        agent_name = agent_ctx["name"].strip() or "Assistant"
        purpose = (cfg.get("purpose") or "").strip()
        sp = (cfg.get("system_prompt") or "").strip()
        knowledge = (cfg.get("knowledge") or "").strip()
        knowledge_uses_rag = agent_knowledge.should_use_rag(knowledge)

        if sp:
            # Modern path — the agent owns its full prompt.
            sections: list[str] = [agent_templates.SAFETY_PREAMBLE.strip()]
            # Stamp the agent's display name + purpose so the LLM has the
            # frame even when the user's prompt template doesn't include it
            # verbatim. Cheap, ~30 tokens.
            header = f"You are {agent_name}."
            if purpose:
                header += f" {purpose}"
            sections.append(header)
            # Language hint — separate from the user-editable system prompt so
            # changing the agent's language in Studio takes effect immediately
            # without the user re-editing their prompt. Omitted when the agent
            # is set to "Auto" (= match whatever language the user speaks).
            if agent_language:
                sections.append(f"Always reply in {agent_language}, regardless of what language the user writes in.")
            sections.append(sp)

            if knowledge and not knowledge_uses_rag:
                sections.append(
                    "# Reference knowledge\n"
                    "Treat the following as your source of truth.\n\n"
                    f"---\n{knowledge}\n---"
                )
            elif knowledge_uses_rag:
                sections.append(
                    "# Reference knowledge\n"
                    "Relevant excerpts from your knowledge base will be injected "
                    "before each user message — treat them as authoritative."
                )

            if tool_hints:
                sections.append(
                    "# Available tools\n" + "\n".join(tool_hints)
                    + "\n\n" + TOOL_CALL_HYGIENE_RULES
                )

            system_prompt_text = "\n\n".join(sections)
        else:
            # Legacy path — agent saved before templates. Keep the old
            # layered assembly so existing agents keep responding the same way.
            sections = [f"You are {agent_name}, a voice assistant."]
            if purpose:
                sections.append(f"# Your purpose\n{purpose}")

            if knowledge and not knowledge_uses_rag:
                sections.append(
                    "# Reference knowledge (your authority on this topic)\n"
                    "Use this knowledge as your source of truth. If a user asks "
                    "something outside it, say you don't know rather than guess.\n\n"
                    f"---\n{knowledge}\n---"
                )
            elif knowledge_uses_rag:
                sections.append(
                    "# Reference knowledge\n"
                    "You have access to a larger knowledge base. The most relevant "
                    "excerpts will be injected just before each user message — treat "
                    "those excerpts as your authority. If something the user asks "
                    "isn't covered in the excerpts, say you don't know rather than "
                    "guess from training data."
                )

            if tool_hints:
                tool_block_lines = [
                    "# Your tools",
                    "Call a tool when the user asks for something you don't already "
                    "know — live data, recent facts, a specific URL, or anything "
                    "your training wouldn't cover. Don't announce \"I'm going to "
                    "search\" first; just call it and answer.",
                    "",
                    TOOL_CALL_HYGIENE_RULES.split("\n", 1)[1].rstrip(),
                    "",
                    "When the tool returns:",
                    "- Quick-data tools (weather, time, prices): one short sentence "
                    "with the fact and a tiny bit of context. Like \"It's 19 in "
                    "Tokyo right now, pretty mild.\"",
                    "- Research tools (web_search, wikipedia_lookup, fetch_url) "
                    "that returned real content: give a substantive answer — lead "
                    "with the direct answer, then the specifics (names, numbers, "
                    "dates), then the why if it matters. Skip filler. The user "
                    "waited for you to look it up, so deliver.",
                    "- Never read JSON, raw URLs, or source code aloud. Refer to "
                    "sources by name (\"per Reuters\", \"the Wikipedia article\").",
                    "- If two tools ran together, weave the answers into one reply.",
                    "",
                    "Available tools:",
                    *tool_hints,
                ]
                sections.append("\n".join(tool_block_lines))

            unknown_rule = (
                "- If something is outside your purpose and none of your tools can answer it, "
                "say so plainly — do not invent facts, prices, names, or features.\n"
                if has_research_tool
                else
                "- If something is outside your purpose or knowledge, say so plainly — "
                "do not invent facts, prices, names, or features.\n"
            )
            sections.append(
                "# Conversation guidelines\n"
                "- One continuous voice conversation with one user. Remember what "
                "they've told you — name, preferences, what's already been "
                "discussed. Reference it when it fits (\"you mentioned earlier…\").\n"
                "- Stay in character. Don't break role to apologise for being an AI.\n"
                + unknown_rule
            )

            sections.append(VOICE_CHAT_FORMAT_RULES)
            system_prompt_text = "\n\n".join(sections)
    else:
        system_prompt_text = get_system_prompt(VOICECHAT_EXTRA_SYSTEM_PROMPT)

    # Per-session conversation history (in-memory; lost on disconnect — that's fine for v1)
    conversation: list[ChatMessage] = [
        ChatMessage(role="system", content=system_prompt_text),
    ]
    # Voice for TTS:
    #   • agent chat → use the agent's configured voice
    #   • Vocence Assistant (no agent_id) → use VOCENCE_ASSISTANT_VOICE
    # Both flow through the same TTS dispatcher; sample-voice ids end up
    # at the clone-streaming server, Qwen3 speaker names (legacy) end up
    # at the local qwen3_streaming service.
    agent_voice: str | None = None
    if agent_ctx:
        v = (agent_ctx["config"].get("voice") or "").strip()
        if v:
            agent_voice = v
    else:
        v = (VOCENCE_ASSISTANT_VOICE or "").strip()
        if v:
            agent_voice = v

    # Agent's configured TTS / LLM language. Forwarded to the clone-streaming
    # agent_language is resolved above (before system prompt assembly).

    # Track current turn task so we can cancel on barge-in
    current_turn: asyncio.Task | None = None

    # Session-scoped TTS WS warmer. The voice is fixed for the lifetime
    # of this session (one agent, one voice), so we build a single
    # warmer at session-open and reuse it across every turn instead of
    # constructing one per ``_run_turn`` invocation. The OLD per-turn
    # warmer paid the full ~500 ms WS handshake on chunk 1 of EVERY
    # turn because the warm WS from the previous turn was closed when
    # the previous ``_run_turn`` exited. By promoting it to session
    # scope, chunk 1 of each turn (including the FIRST turn after
    # connect, thanks to the immediate ``schedule_prewarm()`` below)
    # gets the warm WS that was opened in the background while the
    # user was speaking. Cuts ~500 ms off TTS time-to-first-audio per
    # turn — your single biggest fixed latency floor.
    from voicechat_service import make_tts_warmer_for_voice  # local: keep cold-start lean
    session_tts_warmer = make_tts_warmer_for_voice(agent_voice)
    if session_tts_warmer is not None:
        # Open the first WS in the background NOW so it's ready by
        # the time the user finishes their first turn.
        session_tts_warmer.schedule_prewarm()

    # ── STT pod prewarm (silence-pump) ────────────────────────────────
    # Two observed truths drive this design:
    #   1. The pod has a server-side "waiting for ``start``" timeout
    #      (~10 s). We can't open the WS and stall — the pod errors
    #      out with bad_request:start_message_timeout.
    #   2. Even after a successful cold-open, the FIRST inference
    #      against a cold pod is slow enough that the partial /
    #      vad_speech events arrive after the silence backstop has
    #      already fired. Result: a sentence the user spoke in full
    #      gets transcribed as the first two words ("What is the
    #      voice design" → "What is").
    #
    # Fix: send ``start`` immediately (so the pod doesn't time out),
    # then pump 20 ms silence frames continuously until the first
    # user turn arrives. The pod sees a steady stream of "silence
    # speech" — its model weights are loaded, its inference path is
    # warm, its VAD is running. When real frames arrive (after
    # adoption) the pipeline is already hot and partials emit
    # immediately, the way they do on the 2nd+ turns today.
    #
    # The prewarm task and the StreamingTurnSession coordinate via
    # ``prewarm_adopt_event``: the main loop sets it on stream_start,
    # the pump loop sees it and exits, then the bundle is handed off
    # for adoption with no concurrent writers.
    prewarmed_stt: dict[str, Any] | None = None
    prewarm_stt_task: asyncio.Task | None = None
    prewarm_adopt_event = asyncio.Event()
    # The pod's ``start.language`` is set HERE during prewarm. For
    # the adoption to be safe, the per-turn language has to match;
    # _open_stt's adopt path falls back to a cold-open on mismatch.
    # Logos → "auto"; paid agent → its configured language. Either
    # way it's stable for the session.
    prewarm_stt_language = agent_language if agent_language else "auto"

    async def _prewarm_stt() -> None:
        nonlocal prewarmed_stt
        import aiohttp
        from ops import pool as gpu_pool
        pod_cm = None
        sess: aiohttp.ClientSession | None = None
        ws: aiohttp.ClientWebSocketResponse | None = None
        try:
            if gpu_pool.online_pod_count("asr_streaming_rt") <= 0:
                return
            pod_cm = gpu_pool.pick_pod("asr_streaming_rt")
            pod = await pod_cm.__aenter__()
            base = pod.url.rstrip("/")
            ws_url = (
                "wss://" + base[len("https://"):] + "/v1/stream"
                if base.startswith("https://")
                else "ws://" + base[len("http://"):] + "/v1/stream"
            )
            headers = {"X-API-Key": pod.api_key} if pod.api_key else {}
            sess = aiohttp.ClientSession(headers=headers)
            ws = await sess.ws_connect(
                ws_url,
                timeout=aiohttp.ClientWSTimeout(ws_close=15),
                max_msg_size=2 * 1024 * 1024,
            )
            # Send ``start`` immediately so the pod doesn't time out.
            await ws.send_json({
                "type": "start",
                "language": prewarm_stt_language,
                "sample_rate": 16000,
                "encoding": "pcm_s16le",
                "enable_partials": True,
                "vad_events": True,
            })
            ready_msg = await asyncio.wait_for(ws.receive(), timeout=10.0)
            if ready_msg.type != aiohttp.WSMsgType.TEXT:
                raise RuntimeError("STT prewarm: ready missing")
            data = json.loads(ready_msg.data)
            if data.get("type") != "ready":
                raise RuntimeError(f"STT prewarm: first msg not ready: {data}")
            _log.info(
                "[stream] trace session=%s phase=stt_prewarmed lang=%r",
                session_id, prewarm_stt_language,
            )

            # Silence-pump loop. 20 ms frame @ 16 kHz mono s16le =
            # 640 zero bytes. Pumping at ~20 ms wall-clock keeps the
            # pod's inference path active (and its server-side idle
            # timer reset) until adoption fires. We periodically
            # await the adopt event so the loop exits promptly.
            silence_frame = bytes(640)
            while not prewarm_adopt_event.is_set():
                if ws.closed:
                    return
                try:
                    await ws.send_bytes(silence_frame)
                except Exception:
                    return
                try:
                    await asyncio.wait_for(
                        prewarm_adopt_event.wait(), timeout=0.02
                    )
                    break  # adoption signal — fall through to hand off
                except asyncio.TimeoutError:
                    continue

            # Hand off the warm WS. From here on, the StreamingTurnSession
            # owns the WS; this task exits without touching it.
            if not ws.closed:
                prewarmed_stt = {
                    "pod_cm": pod_cm,
                    "session": sess,
                    "ws": ws,
                    "language": prewarm_stt_language,
                }
                pod_cm = sess = ws = None  # ownership transferred
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            _log.info(
                "[stream] trace session=%s phase=stt_prewarm_failed reason=%s "
                "(first turn will cold-open instead)",
                session_id, exc,
            )
        finally:
            if ws is not None:
                with suppress(Exception):
                    await ws.close()
            if sess is not None:
                with suppress(Exception):
                    await sess.close()
            if pod_cm is not None:
                with suppress(Exception):
                    await pod_cm.__aexit__(None, None, None)

    if streaming_stt_online and not force_segment_only:
        prewarm_stt_task = asyncio.create_task(_prewarm_stt(), name="prewarm_stt")

    # ``bot_speaking_evt`` is the mic-mute gate. While set, the next
    # turn's StreamingTurnSession DROPS incoming PCM frames so the STT
    # pod doesn't transcribe the bot's own voice leaking through the
    # user's speakers (the classic "Yeah / Mm-hmm / Thank you" Parakeet
    # hallucinations on echo).
    #
    # The gate is driven entirely by the CLIENT now. Two mtypes:
    #   * ``client_audio_started``   → set() — first sample reached speakers
    #   * ``client_audio_settled``   → clear() — queue drained OR barge-in
    #                                   fade completed (speakers silent)
    #
    # This replaced an older heuristic that estimated playback tail from
    # byte counts on the server side. The estimate was always wrong by
    # several seconds because the client's prebuffer and OS audio output
    # are out of the server's view. The client owns the speakers — it's
    # the only thing that actually knows when the tail is gone — so we
    # trust its events instead of guessing.
    #
    # Two safeties keep the gate from getting stuck:
    #   1. ``GATE_MAX_HOLD_S`` auto-clear if ``started`` arrived but
    #      ``settled`` never did (client crash mid-playback).
    #   2. New ``client_audio_started`` arrivals re-arm the safety timer.
    #
    # Was 30 s — too long. By the time the safety fired, the user had
    # given up. 6 s is enough for a healthy settled to always arrive
    # first (network jitter + fade-out completion typically lands in
    # <500 ms), but short enough that a missed settled doesn't kill a
    # conversation. Combined with the explicit gate-clear on
    # cancel/stream_start (below), this is now a backstop, not the
    # primary recovery path.
    GATE_MAX_HOLD_S = 6.0
    bot_speaking_evt: asyncio.Event = asyncio.Event()
    gate_safety_task: asyncio.Task | None = None

    def _gate_set_from_client() -> None:
        """Latch the mute gate. Triggered by ``client_audio_started``."""
        nonlocal gate_safety_task
        bot_speaking_evt.set()
        if gate_safety_task and not gate_safety_task.done():
            gate_safety_task.cancel()

        async def _safety() -> None:
            try:
                await asyncio.sleep(GATE_MAX_HOLD_S)
                # If we got here the client never sent ``settled``
                # within MAX_HOLD — assume it crashed or the WS broke
                # mid-playback. Release rather than lock the mic
                # forever.
                _log.warning(
                    "[gate] safety release after %.0fs without client_audio_settled "
                    "(session=%s, likely client crash mid-playback)",
                    GATE_MAX_HOLD_S, session_id,
                )
                bot_speaking_evt.clear()
            except asyncio.CancelledError:
                pass

        gate_safety_task = asyncio.create_task(_safety(), name="gate_safety")

    def _gate_clear_from_client() -> None:
        """Release the mute gate. Triggered by ``client_audio_settled``."""
        nonlocal gate_safety_task
        bot_speaking_evt.clear()
        if gate_safety_task and not gate_safety_task.done():
            gate_safety_task.cancel()
            gate_safety_task = None

    async def _cancel_current() -> None:
        """Cancel the in-flight turn and wait for it to tear down — but
        DON'T wait forever. The TTS streamers maintain a WebSocket to
        the clone-streaming service whose default close-ACK timeout is
        10 seconds. If we await the cancelled task unbounded, a barge-in
        will appear stuck for up to 10s before the next turn can start.

        After this timeout we return regardless and let the old task
        finish in the background. The streamers themselves (patched in
        voicechat_service.py) cap their own WS close to ~300ms so the
        old task usually exits well before this outer timeout fires.

        Note: this function does NOT touch the mic-mute gate. The
        client's ``audioPlayer.flush()`` (which it calls in lockstep
        with sending the ``cancel`` mtype) fires ``onSettled`` at the
        end of its 150 ms fade, and the resulting
        ``client_audio_settled`` clears the gate naturally. Putting
        gate logic here would double-control it and reintroduce the
        timing races we just deleted.
        """
        nonlocal current_turn
        if current_turn and not current_turn.done():
            current_turn.cancel()
            try:
                await asyncio.wait_for(current_turn, timeout=1.0)
            except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
                pass
        current_turn = None

    # First-message greeting — agent speaks this immediately on
    # connect, before the user has said anything. Industry standard
    # pattern (Vapi ``firstMessage``, Retell ``begin_message``, Eleven
    # ``first_message``). We push it into ``conversation`` as a
    # synthetic assistant turn so the LLM sees its own greeting on
    # the user's first reply and doesn't re-introduce itself.
    #
    # Three-way semantic:
    #   • key MISSING (legacy agent saved before this feature shipped)
    #       → use a sensible default greeting so the agent isn't mute
    #   • key present but empty string
    #       → user EXPLICITLY chose silent start; honor it
    #   • non-empty string
    #       → speak it verbatim
    DEFAULT_FIRST_MESSAGE = "Hello, how may I assist you today?"
    # Logos (the in-product Vocence Assistant) has no ``agent_ctx`` —
    # it's not a row in the agents table. Without an explicit greeting
    # here it would stay mute on connect (the Studio home spotlight
    # paints a static text bubble for it, but the user expects to
    # actually HEAR Logos say hello). Match the wording the spotlight
    # UI shows so what the user reads and what they hear line up.
    LOGOS_FIRST_MESSAGE = (
        "Hey, I'm Logos — Vocence's assistant. "
        "Ask me anything about Studio, agents, or how to ship voice."
    )
    agent_first_message = ""
    if agent_ctx:
        cfg = agent_ctx.get("config") or {}
        if "first_message" not in cfg:
            agent_first_message = DEFAULT_FIRST_MESSAGE
        else:
            fm = cfg.get("first_message")
            if isinstance(fm, str):
                agent_first_message = fm.strip()
    else:
        # No agent → this is the Logos / Vocence Assistant session.
        agent_first_message = LOGOS_FIRST_MESSAGE

    async def _speak_pretext(text: str) -> None:
        """Run a pre-written assistant utterance through the chat
        token stream + TTS path WITHOUT calling the LLM. Used for
        the first_message greeting. Cancellable like any normal turn
        so user barge-in tears it down cleanly via ``_cancel_current``."""
        from voicechat_service import stream_tts_for_voice, TurnTtsPodPin
        # Greeting is one utterance so pinning is less critical here,
        # but use the same shape as regular turns for consistency and
        # so a future multi-sentence greeting wouldn't regress.
        greeting_pod_pin = TurnTtsPodPin()
        # 1. Emit the chat token so the UI shows the greeting.
        with suppress(Exception):
            await ws.send_json({"type": "token", "text": text})
        if not VOICECHAT_TTS_ENABLED:
            return
        # 2. Send the audio_meta envelope, then stream TTS bytes.
        sid = 0  # only one chunk for the greeting; sid is monotonic per turn
        spoken = sanitize_for_tts(text)
        if not spoken:
            return
        with suppress(Exception):
            await ws.send_json({
                "type": "audio_meta",
                "sentence_id": sid,
                "sample_rate": 24000,
                "frame_ms": 40,
                "encoding": "pcm16le",
                "channels": 1,
            })
        # No server-side gate bookkeeping. The client latches the gate
        # when its first audio sample plays (``client_audio_started``)
        # and releases it when the queue drains or the barge-in fade
        # completes (``client_audio_settled``). See the comments on
        # ``bot_speaking_evt`` for the rationale.
        try:
            async for chunk in stream_tts_for_voice(
                spoken,
                agent_voice,
                user_id=auth_user_id,
                language=agent_language,
                pod_pin=greeting_pod_pin,
            ):
                if chunk.kind == "audio" and isinstance(chunk.payload, (bytes, bytearray)):
                    payload = chunk.payload if isinstance(chunk.payload, bytes) else bytes(chunk.payload)
                    if call_recorder is not None:
                        call_recorder.push_agent(payload)
                    with suppress(Exception):
                        await ws.send_bytes(payload)
                elif chunk.kind == "error":
                    err = chunk.payload if isinstance(chunk.payload, dict) else {}
                    _log.warning("first_message tts error: %s", err)
                    break
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            _log.warning("first_message stream failed: %s", exc, exc_info=False)
        finally:
            # Greeting TTS done — see the same comment in tts_consumer
            # below. Without this the greeting's audio sits in the
            # recorder buffer until the user's first turn pushes more.
            if call_recorder is not None:
                call_recorder.notify_agent_tts_done()
            with suppress(Exception):
                await greeting_pod_pin.release()

    if agent_first_message:
        # Append BEFORE kicking off TTS so a fast user barge-in
        # (cancelling the speak task) doesn't lose the conversation
        # marker — the LLM still sees the greeting on the next turn.
        conversation.append(
            ChatMessage(role="assistant", content=agent_first_message)
        )
        # Record the greeting as a synthetic per-turn row so it
        # appears in the call transcript + session replay alongside
        # real turns. Without this the greeting is in the LLM's
        # context but invisible to the user reviewing the call
        # after the fact ("did my agent actually say hello?").
        # user_text is empty because the greeting precedes any
        # user speech; mode='greeting' distinguishes it from
        # voice/text turns in case anyone queries by mode later.
        # SKIP for Logos (agent_id=None) — the Calls/Replay
        # surfaces don't render Logos sessions anyway.
        if agent_id:
            with suppress(Exception):
                await _record_turn(
                    user_id=auth_user_id,
                    user_text="",
                    bot_text=agent_first_message,
                    mode="greeting",
                    latency_ms=0,
                    ttft_ms=0,
                    ttfa_ms=None,
                    error=None,
                    session_id=session_id,
                    agent_id=agent_id,
                )
        current_turn = asyncio.create_task(
            _speak_pretext(agent_first_message), name="first_message"
        )
        # The idle clock starts ticking the moment the greeting ENDS —
        # not when it begins. ``mark_turn_started`` keeps the watchdog
        # quiet while the greeting plays; ``mark_turn_ended`` (in the
        # done-callback) reset _last_activity_at to "now" exactly when
        # the agent stops talking.
        billing.mark_turn_started()
        current_turn.add_done_callback(
            lambda _t, b=billing: b.mark_turn_ended()
        )

    try:
        while True:
            try:
                # Use receive() (not receive_text()) so the loop tolerates
                # binary frames arriving outside an active stream session.
                # Without this, a stray PCM frame from a client whose VAD
                # started before the server saw ``stream_start`` raises
                # RuntimeError inside Starlette's receive_text(), the bare
                # except below kills the WS (code 1006), and the client
                # sees ``connection error`` for what should be benign.
                msg = await ws.receive()
            except WebSocketDisconnect:
                await _cancel_current()
                return
            except Exception:
                await _cancel_current()
                return

            mtype_raw = msg.get("type")
            if mtype_raw == "websocket.disconnect":
                await _cancel_current()
                return
            # Binary frame arriving at the top-level loop: no stream
            # session is active, so just drop it. Stream sessions consume
            # binary frames inside their own ``ws.receive()`` loop.
            if msg.get("bytes") is not None:
                continue
            raw = msg.get("text")
            if raw is None:
                continue

            try:
                payload = json.loads(raw)
            except Exception:
                await ws.send_json({"type": "error", "code": "bad_request", "message": "expected JSON"})
                continue

            mtype = payload.get("type")
            # Log every client→server message at INFO so we can replay
            # the exact protocol order: ready, stream_start, cancel,
            # text, voice. The "only last sentence" bug shows up here
            # as cancel-followed-by-stream_start in quick succession
            # (barge-in cascade) — visible only with this log.
            _log.info(
                "[stream] trace session=%s phase=client_msg type=%r "
                "current_turn_active=%s payload_preview=%r",
                session_id, mtype,
                bool(current_turn and not current_turn.done()),
                {k: (v[:60] if isinstance(v, str) else v)
                 for k, v in payload.items() if k != "audio_b64"},
            )

            if mtype == "cancel":
                _log.info(
                    "[stream] trace session=%s phase=barge_in_received "
                    "(client cancelled in-flight turn — likely the chunking-then-user-keeps-talking pattern)",
                    session_id,
                )
                # User intent: take the floor. Don't wait for the
                # client_audio_settled round-trip to clear the gate.
                _gate_clear_from_client()
                # Close the recorder's agent turn NOW so the right
                # channel stops at the moment the user barged in.
                # The recorder trims the buffered TTS down to
                # wall-clock elapsed (= upper bound on what the user
                # could have heard) and discards the rest.
                if call_recorder is not None:
                    call_recorder.mark_agent_barge_in()
                await _cancel_current()
                try:
                    await ws.send_json({"type": "cancelled"})
                except (WebSocketDisconnect, RuntimeError, Exception):
                    return
                continue

            # Mic-mute gate control — driven by the client now (replaces
            # the old server-side byte-count tail estimator). The client
            # sends ``client_audio_started`` when its audio worklet's
            # first sample reaches the speakers, and
            # ``client_audio_settled`` when the queue drains naturally
            # or the barge-in fade completes. We never get the gate
            # timing wrong now because we aren't guessing it.
            #
            # The same signals also drive the recorder's
            # agent-playback window: started/settled bracket the
            # time the user heard audio, so the recorder can keep
            # only the bytes that fit in that window and drop
            # whatever the TTS pod synthesised ahead but never
            # reached the speakers.
            if mtype == "client_audio_started":
                _gate_set_from_client()
                # No recorder hook: the recorder opens its turn on the
                # first push_agent (server-side, no RTT) so it never
                # depends on the client signal arriving.
                continue
            if mtype == "client_audio_settled":
                _gate_clear_from_client()
                # Tell the recorder the client's queue drained. If TTS
                # is also done pushing for the turn, the recorder commits
                # the whole buffer (the user heard it all). If TTS is
                # still streaming for the turn (this settled fired
                # between sentences while a gap let the queue drain),
                # the recorder ignores it — a later settled after TTS
                # finishes will be the one that completes the turn.
                if call_recorder is not None:
                    call_recorder.notify_agent_client_settled()
                continue

            # ``stream_commit`` belongs INSIDE an active stream session
            # (consumed by StreamingTurnSession._recv_next_audio). If one
            # slips through to here it means the session ended early
            # (e.g. STT pod unavailable) and the client's commit message
            # raced past the cleanup. Treat as a benign no-op rather
            # than surfacing ``unknown type: stream_commit`` to the user
            # — the actual error (stt_empty / stt_unavailable) was
            # already sent during the stream turn.
            if mtype == "stream_commit":
                continue

            if mtype not in {"voice", "text", "stream_start"}:
                await ws.send_json({"type": "error", "code": "bad_request", "message": f"unknown type: {mtype}"})
                continue

            # User intent: take the floor with a new turn. ``stream_start``
            # is only emitted by the frontend on VAD-detected speech, and
            # ``voice``/``text`` are explicit submissions — all three mean
            # the user wants to be heard NOW. Don't wait for a possibly-
            # lost ``client_audio_settled`` to clear the gate; clear it
            # unconditionally here so any echo PCM from the cancelled
            # turn's audio tail can be ignored at the source, not by
            # rejecting the user's mic frames downstream.
            _gate_clear_from_client()
            # Cancel any in-flight turn before starting a new one
            await _cancel_current()

            # Per-user rate limit (no credits, but bound abuse).
            # Checked BEFORE marking activity so a flood of rejected
            # spam doesn't keep an idle session alive.
            allowed, retry_after = await check_rate_limit(auth_user_id)
            if not allowed:
                await ws.send_json({
                    "type": "error",
                    "code": "rate_limited",
                    "message": f"too many turns; try again in {retry_after}s",
                    "retry_after": retry_after,
                })
                continue

            # NOTE: we intentionally do NOT reset the idle watchdog on
            # the user sending a turn. The idle timer is anchored to
            # "60 s after the agent stops talking" — the user typing or
            # speaking is not what makes a session "active", only the
            # agent actually replying. The turn's done-callback below
            # calls ``mark_turn_ended`` which resets the clock at the
            # right moment.

            # RAG agent id selection:
            #   • real agent with large knowledge → that agent's id
            #   • Vocence Assistant (no agent_ctx) → synthetic assistant id,
            #     so search hits the in-product knowledge base we seed at
            #     startup from vocence_assistant_knowledge/*.md
            #   • real agent with small knowledge → no RAG (the body is
            #     already inlined into the system prompt).
            # RAG routing: always try retrieval when we have an agent
            # context. Previously we gated on ``knowledge_uses_rag``,
            # which only checks the text-knowledge field (the Studio
            # textarea) — so an agent whose ONLY knowledge was uploaded
            # via the ingest API (PDF / URL / sitemap) silently got NO
            # retrieval at runtime. ``search_agent_knowledge`` is safe
            # to call unconditionally: it queries both FTS5 (text
            # field) AND the vector pod (uploaded sources) and returns
            # an empty list if neither has matches, so the cost of
            # always running it is one cheap SQLite + one cheap LanceDB
            # query per turn.
            if agent_ctx:
                rag_id: str | None = agent_id
            elif not agent_ctx:
                rag_id = ASSISTANT_AGENT_ID
            else:
                rag_id = None

            # Routing priority for voicechat LLM:
            #   1. ``VOICECHAT_FORCE_MODEL`` — emergency override that wins
            #      over EVERYTHING including the agent's stored model.
            #      Use during outages: set it to ``openai:gpt-4o-mini`` and
            #      every voice chat routes there. Unset to restore normal.
            #   2. Agent's stored ``config.llm_model`` (per-agent customization).
            #   3. ``VOICECHAT_DEFAULT_MODEL`` — applies only when the agent's
            #      slot is blank; useful for picking a "default for new
            #      agents" without touching saved ones.
            #   4. Cerebras if configured (the normal fast path; OpenAI
            #      is the automatic stream-failure fallback inside
            #      stream_chat_with_tools).
            #   5. Fall through to global default routing in llm_client.
            force_model = (os.environ.get("VOICECHAT_FORCE_MODEL") or "").strip()
            if force_model:
                agent_llm_model = force_model
            else:
                agent_llm_model = (agent_ctx and (agent_ctx.get("config") or {}).get("llm_model")) or None
                if not agent_llm_model:
                    default_model = (os.environ.get("VOICECHAT_DEFAULT_MODEL") or "").strip()
                    if default_model:
                        agent_llm_model = default_model
                    else:
                        from llm_client import cerebras_llm_configured
                        if cerebras_llm_configured():
                            agent_llm_model = f"cerebras:{os.environ.get('CEREBRAS_VOICECHAT_MODEL') or 'gpt-oss-120b'}"

            # ``enabled_tools_set`` was resolved once at session start
            # (used by both the system prompt and the tool-spec list) —
            # we reuse it here instead of recomputing per turn.
            # Resolve voice-pipeline knobs from the agent's config —
            # agent_ctx IS in scope here (outer voicechat_session
            # function). Defaults match AgentConfigIn so an unconfigured
            # agent keeps current production behavior.
            _agent_cfg = (agent_ctx and agent_ctx.get("config")) or {}
            # Consume the prewarmed STT slot only on stream_start.
            # The prewarm task is pumping silence into the WS to keep
            # the pod's inference path warm; we MUST signal it to stop
            # before adopting the WS, otherwise the silence pump and
            # the new turn's _forward_frames would race for write
            # ownership of the same socket.
            #
            # Protocol:
            #   1. Set ``prewarm_adopt_event`` — pump loop breaks.
            #   2. Await ``prewarm_stt_task`` so the slot is filled and
            #      the silence-pump task has actually exited (no more
            #      writes will land on this WS from the prewarm side).
            #   3. Read + clear ``prewarmed_stt``.
            # We cap the wait so a stuck prewarm task can't block
            # turn-start; on timeout we discard and cold-open.
            adopted_prewarm_stt: dict | None = None
            if payload.get("type") == "stream_start":
                if prewarm_stt_task is not None and not prewarm_stt_task.done():
                    prewarm_adopt_event.set()
                    try:
                        await asyncio.wait_for(
                            asyncio.shield(prewarm_stt_task), timeout=0.5
                        )
                    except asyncio.TimeoutError:
                        _log.info(
                            "[stream] trace session=%s phase=stt_prewarm_handoff_timeout "
                            "(falling back to cold-open)", session_id,
                        )
                        # Don't cancel — let the task finish naturally
                        # and clean up its own resources; we just
                        # won't adopt.
                        prewarmed_stt = None
                adopted_prewarm_stt = prewarmed_stt
                prewarmed_stt = None
            current_turn = asyncio.create_task(
                _run_turn(
                    ws=ws,
                    user_id=auth_user_id,
                    payload=payload,
                    conversation=conversation,
                    voice=agent_voice,
                    language=agent_language,
                    rag_agent_id=rag_id,
                    agent_id=agent_id,
                    session_id=session_id,
                    llm_model=agent_llm_model,
                    enabled_tools=enabled_tools_set,
                    bot_speaking_evt=bot_speaking_evt,
                    tts_warmer=session_tts_warmer,
                    denoise_enabled=bool(_agent_cfg.get("denoise_enabled", False)),
                    turn_decider=str(_agent_cfg.get("turn_decider", "fusion")),
                    ultravad_threshold=float(_agent_cfg.get("ultravad_threshold", 0.55)),
                    prewarmed_stt=adopted_prewarm_stt,
                    call_recorder=call_recorder,
                )
            )
            # The idle clock is anchored to "agent stopped talking".
            # ``mark_turn_started`` keeps the watchdog quiet while the
            # LLM + TTS run, and the done-callback fires
            # ``mark_turn_ended`` on any termination (success / cancel /
            # exception) — at which point _last_activity_at is set to
            # "now" and the 60-second countdown begins.
            billing.mark_turn_started()
            current_turn.add_done_callback(
                lambda _t, b=billing: b.mark_turn_ended()
            )

            # Stream-mode turns own the WS for their lifetime — their
            # internal loop calls ``ws.receive()`` to consume PCM frames.
            # The main loop must NOT iterate back to its own
            # ``ws.receive()`` in parallel, or Starlette raises
            # ``cannot call recv while another coroutine is already
            # waiting for the next message``. Block here until the
            # stream session ends (its own loop handles ``stream_commit``
            # / ``cancel`` text messages so cancellation still works).
            if mtype == "stream_start":
                try:
                    await current_turn
                except asyncio.CancelledError:
                    pass
                current_turn = None
    finally:
        # ── Session-close cleanup ─────────────────────────────────────
        # CRITICAL: ``asyncio.CancelledError`` is a ``BaseException``,
        # NOT an ``Exception``, so plain ``suppress(Exception)`` does
        # NOT catch it. When Starlette cancels the WS task (normal
        # client disconnect during long-running cleanup, server
        # shutdown, etc.), the first awaiting line below would raise
        # CancelledError and EVERY subsequent step — including the
        # call-log persistence — would silently skip. That's exactly
        # how the Calls + Analytics tabs ended up empty after real
        # sessions: voice_call_logs row never written.
        #
        # Every ``await`` in this finally now suppresses both
        # Exception AND CancelledError so cleanup completes even
        # under aggressive cancellation. Python 3.10 doesn't
        # re-raise cancellation on subsequent awaits once it's
        # been caught, so a single suppress per await is sufficient.
        with suppress(Exception, asyncio.CancelledError):
            await _cancel_current()
        _log.info(
            "[stream] trace session=%s phase=session_close duration=%dms",
            session_id, int((time.perf_counter() - _session_open_perf) * 1000),
        )
        # Release the session-scoped TTS warmer (closes any pre-opened
        # WS so we don't leak a connection against the pod's cap).
        if session_tts_warmer is not None:
            with suppress(Exception, asyncio.CancelledError):
                await session_tts_warmer.close()
        # Release any unconsumed STT prewarm — happens when the user
        # disconnects before their first stream_start (greeting then
        # close), or when the prewarm task is still mid-handshake.
        if prewarm_stt_task is not None and not prewarm_stt_task.done():
            prewarm_stt_task.cancel()
            with suppress(Exception, asyncio.CancelledError):
                await asyncio.wait_for(prewarm_stt_task, timeout=1.0)
        if prewarmed_stt is not None:
            pw = prewarmed_stt
            prewarmed_stt = None
            with suppress(Exception, asyncio.CancelledError):
                await pw["ws"].close()
            with suppress(Exception, asyncio.CancelledError):
                await pw["session"].close()
            with suppress(Exception, asyncio.CancelledError):
                await pw["pod_cm"].__aexit__(None, None, None)
        # Stop the watchdog/billing loop. Runs even on
        # WebSocketDisconnect / cancellation so the user gets
        # correctly charged for the time they actually used (paid
        # agents) or no-op'd cleanly (free Assistant). The
        # MIN_CHARGE_SEC floor is enforced inside stop().
        with suppress(Exception, asyncio.CancelledError):
            await billing.stop()

        # Flush the call recorder to the object store (if any).
        # Best-effort — helper swallows errors and returns
        # (None, None, 0), which we persist as NULL columns on the
        # log row. Done BEFORE _log_call_session so bucket + key
        # land in the same INSERT, not a follow-up UPDATE.
        recording_bucket_persisted: str | None = None
        recording_path_persisted: str | None = None
        recording_bytes_persisted: int | None = None
        if call_recorder is not None:
            try:
                _rec_bucket, _rec_key, _rec_bytes = await call_recorder.close()
                if _rec_key and _rec_bytes > 0:
                    recording_bucket_persisted = _rec_bucket
                    recording_path_persisted = _rec_key
                    recording_bytes_persisted = _rec_bytes
                    _log.info(
                        "[stream] trace session=%s phase=recording_uploaded "
                        "bucket=%s key=%s bytes=%d",
                        session_id, _rec_bucket, _rec_key, _rec_bytes,
                    )
            except (Exception, asyncio.CancelledError):
                # Same reason as the other suppress sites in this
                # finally — CancelledError isn't an Exception in 3.10+.
                _log.debug("recorder close raised (non-fatal)", exc_info=False)

        # Persist a session-level row to voice_call_logs. Drives the
        # per-agent Analytics + Calls dashboard. Aggregated metrics
        # (turn count, char totals) are derived from
        # studio_voicechat_history rows that the per-turn _record_turn
        # already wrote — by the time we get here, _cancel_current()
        # above has awaited all in-flight turns, so those writes are
        # durable.
        #
        # SKIP for Logos (agent_id is None). Logos is the free
        # in-product assistant — it has no owner, so there's no
        # Calls / Analytics surface to populate, and we don't want
        # to retain transcripts of those throwaway sessions for
        # privacy. The per-turn rows in studio_voicechat_history
        # are still written (used for billing reconciliation /
        # debugging logs), but the session-level row is not.
        _agent_name_snapshot = (
            agent_ctx.get("name") if isinstance(agent_ctx, dict) else None
        )
        _call_ended_at_iso = _utcnow_iso()
        _call_duration_ms = int((time.perf_counter() - _session_open_perf) * 1000)
        if agent_id:
            # Persist the call-log row under asyncio.shield so a parent
            # cancellation can't kill the INSERT half-way. The DB write
            # is fast (single SQLite INSERT OR REPLACE) and idempotent,
            # so even under WS-disconnect storms it completes cleanly.
            # Combined with the broader suppress() we still tolerate
            # a true crash here — the void is the Calls/Analytics row,
            # which we'd rather not lose.
            with suppress(Exception, asyncio.CancelledError):
                await asyncio.shield(_log_call_session(
                    session_id=session_id,
                    user_id=auth_user_id,
                    agent_id=agent_id,
                    agent_name=_agent_name_snapshot,
                    started_at_iso=_session_started_iso,
                    ended_at_iso=_call_ended_at_iso,
                    duration_ms=_call_duration_ms,
                    end_reason=_session_end_reason,
                    recording_path=recording_path_persisted,
                    recording_bucket=recording_bucket_persisted,
                    recording_bytes=recording_bytes_persisted,
                ))

        # Fan-out a ``call.ended`` event to every webhook registered
        # on this agent. No-op for Logos (agent_id None — Logos
        # has no owner, can't subscribe to its own events) and for
        # agents with zero webhooks. The delivery happens out-of-
        # band on the webhook poller; this enqueue is just an
        # INSERT, so it never blocks the WS close path.
        if agent_id:
            from webhooks_service import enqueue_event
            with suppress(Exception, asyncio.CancelledError):
                await asyncio.shield(enqueue_event(
                    agent_id=agent_id,
                    event_type="call.ended",
                    payload={
                        "event": "call.ended",
                        "session_id": session_id,
                        "agent_id": agent_id,
                        "agent_name": _agent_name_snapshot,
                        "started_at": _session_started_iso,
                        "ended_at": _call_ended_at_iso,
                        "duration_ms": _call_duration_ms,
                        "end_reason": _session_end_reason,
                        "recording": (
                            {
                                "bucket": recording_bucket_persisted,
                                "key": recording_path_persisted,
                                "bytes": recording_bytes_persisted,
                            }
                            if recording_path_persisted
                            else None
                        ),
                    },
                ))


async def _run_turn(
    *,
    ws: WebSocket,
    user_id: str,
    payload: dict,
    conversation: list[ChatMessage],
    voice: str | None = None,
    language: str | None = None,
    rag_agent_id: str | None = None,
    agent_id: str | None = None,
    session_id: str | None = None,
    llm_model: str | None = None,
    enabled_tools: set[str] | None = None,
    bot_speaking_evt: asyncio.Event | None = None,
    tts_warmer: Any | None = None,
    # Voice-pipeline knobs from agent.config — see AgentConfigIn,
    # ULTRAVAD_POD_SPEC.md, DENOISER_STREAMING_POD_SPEC.md. Defaults
    # match the AgentConfigIn defaults so existing agents keep their
    # current behavior until explicitly opted in.
    denoise_enabled: bool = False,
    turn_decider: str = "fusion",
    ultravad_threshold: float = 0.55,
    # First-turn STT pod prewarm from the session layer (None on later
    # turns). Forwarded to StreamingTurnSession, which adopts or
    # discards in _open_stt depending on language match. Ignored for
    # text/voice modes (segmented STT, no upstream WS to adopt) —
    # caller closes it in that case.
    prewarmed_stt: dict | None = None,
    # Optional stereo recorder. When non-None, every TTS PCM chunk
    # we ship to the client is also teed to the recorder's agent
    # leg. User leg is captured one layer up in
    # StreamingTurnSession._forward_frames (post-mute-gate,
    # post-denoise) — the recorder threads through there too.
    call_recorder: CallRecorder | None = None,
) -> None:
    mode = payload.get("type")
    started = time.perf_counter()
    ttft_ms: int | None = None
    ttfs_ms: int | None = None  # time-to-first-sentence sent to TTS
    ttfa_ms: int | None = None
    bot_text_full: list[str] = []
    user_text_final = ""
    error_str: str | None = None

    try:
        # ---------- 1) get user text (STT, streaming, or direct) ----------
        if mode == "stream_start":
            # Streaming voice turn: client sends a continuous flow of
            # 20 ms PCM frames (binary WS frames) plus an optional
            # ``stream_commit`` text message to signal end of audio.
            # We fan-out to STT + Smart Turn + Turn Detector pods and
            # let the server-side ensembler decide turn-end. See
            # voicechat_stream.StreamingTurnSession for the details.
            from voicechat_stream import StreamingTurnSession  # local import; module pulls in ops.pool

            language = (payload.get("language") or "").strip() or None
            history_for_detector = [
                {"role": m.role, "content": m.content}
                for m in conversation[-8:]
                if m.role in ("user", "assistant")
            ]

            # ``stream_commit`` is a client-side VAD hint only — the
            # server ensembler decides turn-end from STT silence + EOU.
            stream_client_hints: dict[str, bool] = {}

            async def _recv_next_audio() -> bytes | None:
                """Pull the next binary frame from the client WS.
                Returns ``None`` on disconnect/cancel only."""
                while True:
                    try:
                        msg = await ws.receive()
                    except WebSocketDisconnect:
                        return None
                    if msg.get("type") == "websocket.disconnect":
                        return None
                    if "bytes" in msg and msg["bytes"] is not None:
                        return msg["bytes"]
                    if "text" in msg and msg["text"] is not None:
                        try:
                            p = json.loads(msg["text"])
                        except Exception:
                            continue
                        ctype = p.get("type")
                        if ctype == "stream_commit":
                            stream_client_hints["commit"] = True
                            continue
                        if ctype == "cancel":
                            return None
                        # Ignore other control messages mid-stream.

            # Voice-pipeline knobs come in as ``_run_turn`` parameters
            # (resolved from agent.config in the outer
            # voicechat_session function where agent_ctx IS in scope).
            # See ULTRAVAD_POD_SPEC.md, DENOISER_STREAMING_POD_SPEC.md,
            # AgentConfigIn.
            session = StreamingTurnSession(
                client_ws=ws,
                language=language,
                history=history_for_detector,
                receive_binary=_recv_next_audio,
                send_json=ws.send_json,
                user_id=user_id,
                client_hints=stream_client_hints,
                is_bot_speaking=(
                    bot_speaking_evt.is_set if bot_speaking_evt is not None else None
                ),
                denoise_enabled=denoise_enabled,
                turn_decider=turn_decider,
                ultravad_threshold=ultravad_threshold,
                prewarmed_stt=prewarmed_stt,
                call_recorder=call_recorder,
            )
            _t_session_start = time.perf_counter()
            _log.info(
                "[stream] trace session=%s phase=turn_start mode=stream lang=%r",
                session_id, language,
            )
            result = await session.run()
            if result is None:
                await ws.send_json({
                    "type": "error",
                    "code": "stt_empty",
                    "message": "couldn't hear anything",
                })
                error_str = "stt_empty"
                _log.info(
                    "[stream] trace session=%s phase=turn_end_no_transcript total=%dms",
                    session_id, int((time.perf_counter() - _t_session_start) * 1000),
                )
                return

            user_text_final = result.transcript
            _t_eou_done = time.perf_counter()
            _eou_ms = int((_t_eou_done - _t_session_start) * 1000)
            _log.info(
                "[stream] trace session=%s phase=eou_committed eou_total=%dms "
                "rule=%s silence_at_commit=%dms td_p=%.4f conf=%.2fx smart=%.2f "
                "transcript=%r",
                session_id, _eou_ms,
                result.rule_fired, result.silence_at_commit_ms,
                result.turn_detector_p_at_commit,
                # confidence isn't on the result dataclass yet; compute
                # from raw_p + threshold-equivalent later if needed
                0.0,
                result.smart_turn_p_at_commit,
                user_text_final[:120],
            )
            _log.info(
                "[stream] turn committed: %dms text=%r silence=%dms smart=%.2f td=%.2f rule=%s",
                result.duration_ms, user_text_final[:80],
                result.silence_at_commit_ms,
                result.smart_turn_p_at_commit,
                result.turn_detector_p_at_commit,
                result.rule_fired,
            )
            await ws.send_json({
                "type": "transcript",
                "text": user_text_final,
                "language": result.language,
            })
        elif mode == "voice":
            audio_b64 = payload.get("audio_b64") or ""
            language = (payload.get("language") or "").strip() or None
            if not audio_b64:
                await ws.send_json({"type": "error", "code": "bad_request", "message": "audio_b64 required"})
                return

            # STT capacity gate — fail fast if heavy
            admitted = False
            if STT_CAP is not None and STT_CAP.configured:
                admitted = STT_CAP.try_admit(1)
                if not admitted:
                    await ws.send_json({
                        "type": "error",
                        "code": "stt_busy",
                        "message": "speech-to-text is under heavy load — please try again",
                    })
                    return

            try:
                audio_bytes = base64.b64decode(audio_b64)
                base_url: Optional[str] = None
                data: Optional[dict] = None
                err: str = ""

                # Streaming path first — when a modern asr_streaming_rt
                # pod is online and we're NOT routing through the legacy
                # STT_POOL override, replay the audio into /v1/stream so
                # the client gets partial_transcript events while STT is
                # still in flight. Falls back to batch on any failure.
                streaming_attempted = False
                try:
                    from ops import pool as gpu_pool
                    if (
                        STT_POOL is None or not STT_POOL.configured()
                    ) and gpu_pool.online_pod_count("asr_streaming_rt") > 0:
                        streaming_attempted = True

                        async def _forward_partial(text: str):
                            try:
                                await ws.send_json({
                                    "type": "partial_transcript",
                                    "text": text,
                                })
                            except Exception:
                                # Client gone or socket dead — let the
                                # streaming task error out naturally.
                                pass

                        data, err = await transcribe_audio_streaming(
                            audio_bytes=audio_bytes,
                            language=language,
                            on_partial=_forward_partial,
                        )
                except Exception as e:
                    # Any unexpected explosion in the streaming path
                    # falls through to batch — never block STT on it.
                    err = err or f"streaming path failed: {e}"
                    data = None

                if not data:
                    if streaming_attempted:
                        # Surface a hint in logs so an operator can spot
                        # repeated streaming failures (capacity, broken
                        # pod, etc.) without losing the user's turn.
                        _log.info("voicechat stt streaming fell back to batch: %s", err)
                    if STT_POOL is not None and STT_POOL.configured():
                        async with STT_POOL.acquire() as pod_url:
                            data, err = await transcribe_audio(
                                audio_bytes=audio_bytes, language=language, base_url=pod_url
                            )
                    else:
                        data, err = await transcribe_audio(audio_bytes=audio_bytes, language=language)
            finally:
                if admitted and STT_CAP is not None:
                    STT_CAP.release(1)

            if not data:
                await ws.send_json({"type": "error", "code": "stt_failed", "message": err or "transcription failed"})
                error_str = err or "stt_failed"
                return

            user_text_final = (data.get("text") or "").strip()
            if not user_text_final:
                await ws.send_json({"type": "error", "code": "stt_empty", "message": "couldn't hear anything"})
                error_str = "stt_empty"
                return
            await ws.send_json({
                "type": "transcript",
                "text": user_text_final,
                "language": data.get("language") or language,
            })
        else:  # text
            user_text_final = (payload.get("text") or "").strip()
            if not user_text_final:
                await ws.send_json({"type": "error", "code": "bad_request", "message": "text required"})
                return
            user_text_final = user_text_final[:MAX_USER_MESSAGE_CHARS]

        # ---------- 2) append to conversation, stream LLM, sentence-pipeline TTS ----------
        conversation.append(ChatMessage(role="user", content=user_text_final))

        # Hard cap as a safety net — the rolling-summary path below is the
        # primary mechanism for keeping context fresh past MAX_HISTORY_TURNS.
        if len(conversation) > 1 + MAX_HISTORY_TURNS * 2 + 4:
            keep_tail = conversation[-(MAX_HISTORY_TURNS * 2):]
            conversation[:] = [conversation[0]] + keep_tail

        # ---------- per-turn injection ----------
        # We always inject ONE consolidated system message right before
        # the user's latest turn. It sits in the strongest attention
        # slot for small models (Qwen3-4B) and carries:
        #   1) RAG excerpts (when the bot has a knowledge base attached)
        #   2) The voice-chat format rules (always — even for agents
        #      with simple system prompts that didn't include them)
        #
        # Without (2), agents emit headings, bullet lists, and
        # parentheticals because their user-supplied system prompt has
        # nothing forbidding it.
        llm_messages: list[ChatMessage] = list(conversation)
        turn_block_parts: list[str] = []

        if rag_agent_id:
            # Build a topic-aware retrieval query.
            #
            # The naive "embed just user_text_final" approach broke any
            # multi-turn conversation that established a topic:
            # "how much does it cost?" three turns into a Bittensor
            # chat embeds against the literal four words and recalls
            # nothing about Bittensor. The conversation history HAS the
            # topic words ("TAO", "Bittensor", "subnet") — we just
            # weren't using them at retrieval time.
            #
            # Fix: ALWAYS prepend the last user+assistant exchange (or
            # two) to the embedding query. The current user message is
            # appended last so it dominates the BM25 match. Cheap (no
            # extra LLM call), and dramatically lifts recall on
            # follow-ups. Capped at ~600 chars total so the embedding
            # stays focused on topic words.
            #
            # Also: SKIP retrieval entirely on conversational closers
            # (thanks / ok / yeah). These never need facts and the
            # empty retrieval was just adding ~30 ms latency.
            chunks: list[str] = []
            user_text_trim = user_text_final.strip().lower().rstrip("!?.,")
            _CLOSERS = {
                "thanks", "thank you", "thx", "ty", "ok", "okay", "alright",
                "got it", "great", "cool", "nice", "sure", "yeah", "yep",
                "yes", "no", "nope", "mmhmm", "uh huh",
            }
            if user_text_trim and user_text_trim not in _CLOSERS:
                # Walk history newest → oldest, gather up to 4 most
                # recent user/assistant messages. We do this even on
                # long queries because a long query about "pricing"
                # still benefits from knowing the topic is "Bittensor".
                context_msgs: list[str] = []
                budget = 480  # chars of context preamble
                for m in reversed(conversation):
                    if m.role not in ("user", "assistant"):
                        continue
                    if m.content is user_text_final or not (m.content or "").strip():
                        continue
                    snippet = m.content.strip()
                    take = snippet[: max(0, budget)]
                    if not take:
                        break
                    context_msgs.append(take)
                    budget -= len(take)
                    if budget <= 0 or len(context_msgs) >= 4:
                        break
                # Order: oldest context first, current user text last.
                # BM25 still ranks based on term frequency so the user's
                # words contribute most; embedding sees the full topic
                # mass for semantic recall.
                if context_msgs:
                    context_msgs.reverse()
                    retrieval_query = " ".join(context_msgs) + " " + user_text_final
                    _log.info(
                        "[voicechat] rag query enriched with %d prior turns: %r -> %r",
                        len(context_msgs), user_text_final[:50], retrieval_query[:160],
                    )
                else:
                    retrieval_query = user_text_final
                try:
                    chunks = await agent_knowledge.search_agent_knowledge(
                        rag_agent_id, retrieval_query, top_k=5,
                    )
                except Exception:  # noqa: BLE001
                    _log.exception("knowledge retrieval failed; continuing without it")
                    chunks = []

            if chunks:
                chunks_text = agent_knowledge.format_chunks_for_prompt(chunks)
                # Two variants of the framing depending on which agent
                # is talking. The Logos branch stays as-is (it always
                # talks about Vocence). For user-created agents we put
                # an EXPLICIT "don't call web_search if these chunks
                # answer the question" because the LLM otherwise sees
                # web_search in its tool list and picks it for "general
                # knowledge" questions even when the agent's PDF /
                # uploaded docs would have answered.
                if rag_agent_id == ASSISTANT_AGENT_ID:
                    turn_block_parts.append(
                        "# Knowledge-base excerpts for this turn (your authority)\n"
                        "These were retrieved from the Vocence knowledge base based on "
                        "the user's question. Answer ONLY from these excerpts. If they "
                        "don't cover the question, say so plainly and point the user to "
                        "vocence.ai/docs or space@vocence.ai — do NOT guess from training "
                        "data.\n\n"
                        f"---\n{chunks_text}\n---"
                    )
                else:
                    turn_block_parts.append(
                        "# Knowledge-base excerpts for this turn (your authority)\n"
                        "These were retrieved from the agent's own knowledge base "
                        "(uploaded PDFs / pages / text) using the user's question. "
                        "PREFER answering from these excerpts over any tool call — "
                        "specifically, DO NOT call ``web_search`` when the answer is "
                        "already in the excerpts below. Treat the excerpts as the "
                        "agent's authority on this topic. If they don't cover the "
                        "question, then you may either fall back to general knowledge "
                        "(if the topic is within the agent's role) or call a tool — "
                        "but say so honestly rather than blending guessed info with "
                        "the excerpts.\n\n"
                        f"---\n{chunks_text}\n---"
                    )
            else:
                # Empty retrieval. The wording depends on which bot is
                # talking. Logos is the Vocence-only assistant, so
                # off-topic questions get a warm "I only handle Vocence
                # stuff" redirect. Custom agents may legitimately talk
                # about anything in their domain, so they get a softer
                # "be curious, not robotic" hint.
                if rag_agent_id == ASSISTANT_AGENT_ID:
                    turn_block_parts.append(
                        "# This question is outside Vocence's scope\n"
                        "Nothing matched in the Vocence knowledge base — the user is "
                        "asking about something outside Vocence (general world "
                        "knowledge, other products, math, code, etc.). Don't fake an "
                        "answer; gently explain you're built to help with Vocence "
                        "stuff and offer to talk about Studio, pricing, or the "
                        "subnet. Keep it ONE warm conversational sentence in the "
                        "user's tone — no corporate apology, no help-desk script."
                    )
                else:
                    turn_block_parts.append(
                        "# No knowledge-base match for this turn\n"
                        "Nothing matched the user's question in your knowledge base. "
                        "Don't invent specifics. If the question is on-topic for "
                        "your role but not in the knowledge, react like a curious "
                        "person, not a database — \"hmm, that's new to me, fill me "
                        "in?\" or \"haven't come across that one — point me "
                        "somewhere?\" — and offer to help with what you do know. "
                        "If it's small-talk or clearly off-topic, answer briefly "
                        "and naturally."
                    )

        # Always include the format rules — agents and Logos alike.
        turn_block_parts.append(VOICE_CHAT_FORMAT_RULES)

        # Final clarifier — sits last in the per-turn block, just before
        # the user message arrives. Prevents the model from accidentally
        # responding to an earlier turn in long histories or echoing
        # something from the conversation summary.
        turn_block_parts.append(
            "# What to reply to\n"
            "Reply ONLY to the user's next message (the one immediately "
            "after this system message). Earlier turns above are context, "
            "not active questions — don't restate them, don't answer them "
            "again. The user's most recent words are the only thing that "
            "needs a response right now."
        )

        turn_block = "\n\n".join(turn_block_parts)
        rag_msg = ChatMessage(role="system", content=turn_block)
        # Insert just before the last user message (which is the new turn)
        llm_messages = conversation[:-1] + [rag_msg, conversation[-1]]

        # Hybrid TTS pacing:
        #   • Sentence-by-sentence until cumulative chars sent to TTS
        #     reaches WHOLE_REPLY_CHUNK_THRESHOLD (default 300). This
        #     gives short replies a fast TTFA — first audio frame goes
        #     out as soon as the first sentence is ready.
        #   • Once the threshold is crossed, stop chunking. Whatever is
        #     still in the chunker's buffer + every subsequent delta is
        #     accumulated into one tail string and sent to TTS as one
        #     final call after the LLM stream ends. The bulk of a long
        #     answer plays back with coherent cross-sentence prosody.
        # Producer/consumer pipeline (parallel via asyncio.gather):
        #   • llm_producer pulls LLM deltas, streams text tokens to the
        #     chat UI, feeds the chunker, and pushes ready-to-speak
        #     chunks onto sentence_q.
        #   • tts_consumer pulls chunks off sentence_q and dispatches
        #     them to the TTS service one by one, streaming audio frames
        #     back to the client.
        #
        # The two run concurrently. While TTS is synthesising chunk N,
        # the LLM keeps producing text and queueing chunk N+1, so by
        # the time the audio for chunk N drains, chunk N+1 is ready
        # to dispatch with little or no inter-chunk gap.
        #
        # Sequential dispatch was the regression that caused frequent
        # mid-reply stops — we'd block the LLM stream while awaiting
        # each TTS round-trip, the audio queue would underrun, and the
        # player would enter rebuffering.
        # Items are (text, is_filler) tuples; sentinel None marks end-of-turn.
        # The is_filler flag rides through audio_meta so the frontend can
        # bypass its 1500 ms prebuffer for filler audio — otherwise the
        # filler is buffered alongside real reply audio and the user hears
        # both together AFTER the LLM is done, defeating the latency-masking
        # intent.
        sentence_q: asyncio.Queue[tuple[str, bool] | None] = asyncio.Queue(maxsize=8)

        # Build the tool specs the LLM is allowed to call this turn.
        # Built-ins come from the global registry (filtered to the
        # agent's enabled list); custom user-defined tools come from
        # the DB for this specific agent (Phase 3). Custom tool names
        # take precedence over built-ins when there's a collision —
        # the user explicitly registered their version, they probably
        # mean it.
        builtin_specs = agent_tools_service.tool_specs(enabled=enabled_tools)
        custom_tools: list[agent_tools_service.CustomToolDef] = []
        if agent_id:
            try:
                custom_tools = await _load_custom_tools_for_agent(agent_id, user_id)
            except Exception:
                _log.exception("failed to load custom tools for agent %s; continuing without them", agent_id)
        custom_specs = [ct.as_spec() for ct in custom_tools]
        # Custom-first so collisions resolve to the user's version.
        custom_names = {ct.name for ct in custom_tools}
        turn_tool_specs = custom_specs + [
            spec for spec in builtin_specs
            if spec["function"]["name"] not in custom_names
        ]
        custom_tools_by_name = {ct.name: ct for ct in custom_tools}

        async def llm_producer() -> None:
            """Streams LLM output to TTS, with a tool-call loop.

            One turn can span multiple LLM round-trips: if the LLM asks
            for a tool call, we dispatch it, append the result to the
            message list, and call the LLM again. Content tokens from
            every round of the loop feed into the same SentenceChunker
            so the user hears one continuous reply (the model usually
            stays silent during tool-call rounds and only speaks once
            it has the result).

            Bounded by MAX_TOOL_DEPTH to stop runaway loops.
            """
            nonlocal ttft_ms, ttfs_ms
            chunker = SentenceChunker()
            chunking_active = True
            emitted_chars = 0
            tail_buffer = ""

            # The tool loop mutates its own working list of dict messages
            # (not ChatMessage) so we can attach OpenAI-format tool_calls
            # + tool result messages, which ChatMessage doesn't model.
            working_messages: list[dict] = [
                {"role": m.role, "content": m.content} for m in llm_messages
            ]

            # Two filters guard the content stream against tool-call
            # leakage from open-weight models (gpt-oss-120b on Cerebras
            # is the chronic offender):
            #   * JsonLeakFilter — drops inline JSON blobs that look
            #     like raw tool calls / tool results.
            #   * NarrationPrefixScrubber — drops the plain-prose
            #     narration sentences ("we need to wait for web_search
            #     to return", "no result yet") that some models emit
            #     before the actual answer. Only inspects the opening
            #     ~240 chars of each response, then becomes pass-through.
            json_leak_filter = JsonLeakFilter()
            narration_scrubber = NarrationPrefixScrubber()

            async def _feed_content_to_tts(delta: str) -> bool:
                """Reuse of the existing chunker/TTS flow for a single
                content delta. Returns False if the client has hung up
                (so the caller breaks out of the loop)."""
                nonlocal ttft_ms, ttfs_ms, chunking_active, emitted_chars, tail_buffer
                # Pre-filter: strip inline tool-call JSON leakage, then
                # strip any opening tool-narration prose.
                delta = json_leak_filter.feed(delta)
                if delta:
                    delta = narration_scrubber.feed(delta)
                if not delta:
                    return True
                if ttft_ms is None:
                    ttft_ms = int((time.perf_counter() - started) * 1000)
                    _log.info(
                        "[stream] trace session=%s phase=llm_first_token ttft=%dms",
                        session_id, ttft_ms,
                    )
                bot_text_full.append(delta)
                try:
                    await ws.send_json({"type": "token", "text": delta})
                except Exception:
                    return False
                if not VOICECHAT_TTS_ENABLED:
                    return True
                if chunking_active:
                    for sentence in chunker.feed(delta):
                        if chunking_active:
                            spoken = sanitize_for_tts(sentence)
                            if spoken:
                                if ttfs_ms is None:
                                    ttfs_ms = int((time.perf_counter() - started) * 1000)
                                    _log.info(
                                        "voicechat: TTFT=%dms TTFS=%dms first chunk (%d chars) voice=%s: %r",
                                        ttft_ms or 0, ttfs_ms, len(spoken),
                                        voice or "default", spoken[:120],
                                    )
                                await sentence_q.put((spoken, False))
                                emitted_chars += len(spoken)
                                if emitted_chars >= WHOLE_REPLY_CHUNK_THRESHOLD:
                                    chunking_active = False
                                    leftover = (chunker.flush() or "").lstrip()
                                    if leftover:
                                        tail_buffer = leftover
                        else:
                            tail_buffer = (
                                (tail_buffer + " " + sentence).lstrip()
                                if tail_buffer else sentence
                            )
                else:
                    tail_buffer += delta
                return True

            # Track filler emission across the whole turn (NOT per round)
            # so we don't say "Hmm…" then "Okay…" back-to-back if the
                #  user asked a tool-using question. One filler per turn
            # maximum — any more starts to feel chatty / artificial.
            filler_emitted_this_turn = False

            try:
                for depth in range(MAX_TOOL_DEPTH):
                    accumulated_tool_calls: list[dict] = []
                    round_assistant_content: list[str] = []
                    aborted = False

                    # On the final allowed round, force ``tool_choice="none"``
                    # so the LLM MUST produce content rather than queue up
                    # yet another tool call we'd never get to dispatch.
                    # Without this, a model stuck in tool-loop behaviour
                    # (some reasoning models do this) burns through all
                    # depth slots and the user hears silence.
                    is_last_round = depth == MAX_TOOL_DEPTH - 1
                    tool_choice = "none" if is_last_round else "auto"

                    # Schedule a filler synth in the background. It only
                    # fires if no real content has arrived within the
                    # delay window AND we haven't already emitted one
                    # this turn. The task is cancelled the moment the
                    # first content token streams in. The filler is
                    # pushed straight into ``sentence_q`` ahead of real
                    # audio so playback order is: filler → real reply.
                    filler_task: asyncio.Task | None = None
                    round_first_content_seen = False

                    async def _maybe_emit_filler(round_depth: int) -> None:
                        nonlocal filler_emitted_this_turn
                        try:
                            await asyncio.sleep(VOICECHAT_FILLER_DELAY_MS / 1000.0)
                        except asyncio.CancelledError:
                            return
                        if (
                            round_first_content_seen
                            or filler_emitted_this_turn
                            or not VOICECHAT_TTS_ENABLED
                            or not VOICECHAT_FILLERS_ENABLED
                        ):
                            return
                        phrase = _pick_filler(round_depth)
                        filler_emitted_this_turn = True
                        # ORDERING IS CRITICAL: put the filler into the
                        # TTS queue SYNCHRONOUSLY (put_nowait) BEFORE any
                        # await. Previously this used `await sentence_q.put`
                        # AFTER `await ws.send_json` — both awaits yield
                        # control, and during those yields the LLM stream
                        # could push its first real sentence onto sentence_q
                        # ahead of the filler. The TTS consumer then played
                        # the real answer first and the filler last (i.e.
                        # "Hmm, let me think" came AFTER the answer audio).
                        # put_nowait is non-blocking; the queue's maxsize=8
                        # means it never raises QueueFull at this point
                        # because no other producer has run yet for this
                        # round.
                        try:
                            sentence_q.put_nowait((phrase, True))  # True = is_filler
                        except asyncio.QueueFull:
                            return
                        # Now the queue order is locked in. The chat-bubble
                        # token send can take its time without affecting
                        # audio ordering.
                        try:
                            await ws.send_json({"type": "token", "text": phrase + " "})
                        except Exception:
                            pass

                    if VOICECHAT_FILLERS_ENABLED and VOICECHAT_TTS_ENABLED and not filler_emitted_this_turn:
                        filler_task = asyncio.create_task(_maybe_emit_filler(depth))

                    try:
                        async for event in stream_chat_with_tools(
                            working_messages,
                            tools=turn_tool_specs or None,
                            tool_choice=tool_choice,
                            model=llm_model,
                        ):
                            et = event.get("type")
                            if et == "content":
                                txt = event.get("text") or ""
                                if txt:
                                    # First real content for this round —
                                    # kill the pending filler so we don't
                                    # speak "Hmm…" when the LLM was fast.
                                    if not round_first_content_seen:
                                        round_first_content_seen = True
                                        if filler_task and not filler_task.done():
                                            filler_task.cancel()
                                    round_assistant_content.append(txt)
                                    if not await _feed_content_to_tts(txt):
                                        aborted = True
                                        break
                            elif et == "tool_call":
                                accumulated_tool_calls.append(event["tool_call"])
                            elif et == "done":
                                # Stream finished — exit the inner SSE loop and
                                # decide below whether to dispatch tools and
                                # recall, or finish the turn.
                                pass
                    finally:
                        # Guarantee the filler task doesn't outlive its
                        # round — if the LLM stream errored or returned
                        # only tool_calls (no content), cancel now so we
                        # don't double-fire on the next round.
                        if filler_task and not filler_task.done():
                            filler_task.cancel()

                    if aborted:
                        return

                    # No tool calls? The LLM is done — content (if any)
                    # is already streaming to TTS. Break out, flush the
                    # tail, end the turn.
                    if not accumulated_tool_calls:
                        break

                    # The LLM wants tools. Append its assistant message
                    # (with the tool_calls) to working_messages so the
                    # next LLM call sees the chain, then dispatch.
                    asst_msg: dict = {
                        "role": "assistant",
                        "content": "".join(round_assistant_content) or None,
                        "tool_calls": [
                            {
                                "id": tc["id"],
                                "type": "function",
                                "function": {"name": tc["name"], "arguments": tc["arguments"]},
                            }
                            for tc in accumulated_tool_calls
                        ],
                    }
                    working_messages.append(asst_msg)

                    # Run all tool calls in parallel — Groq can emit
                    # multiple in one turn (e.g. weather AND time) and
                    # serializing them would blow our latency budget.
                    async def _run_one(tc: dict) -> tuple[dict, str]:
                        # Notify the frontend so it can render a
                        # "Searching the web…" chip in the chat bubble.
                        tc_name = tc.get("name") or ""
                        try:
                            await ws.send_json({
                                "type": "tool_call_started",
                                "id": tc.get("id"),
                                "name": tc_name,
                                "arguments": tc.get("arguments"),
                                # Tag the source so the UI can differentiate
                                # "🔧 Custom: my_webhook" from "🔍 web_search".
                                "kind": "custom" if tc_name in custom_tools_by_name else "builtin",
                            })
                        except Exception:
                            pass
                        # Custom tools (user-defined webhooks) get dispatched
                        # via the SSRF-safe HTTP executor; everything else
                        # goes through the built-in registry.
                        custom_def = custom_tools_by_name.get(tc_name)
                        if custom_def is not None:
                            result_str = await agent_tools_service.dispatch_custom_tool(
                                custom_def, tc.get("arguments") or "{}",
                            )
                        else:
                            result_str = await agent_tools_service.dispatch_tool_call(
                                tc_name, tc.get("arguments") or "{}",
                            )
                        try:
                            await ws.send_json({
                                "type": "tool_call_completed",
                                "id": tc.get("id"),
                                "name": tc.get("name"),
                                # Trim the preview so the WS frame stays small;
                                # full result still goes back to the LLM.
                                "result_preview": result_str[:280],
                            })
                        except Exception:
                            pass
                        return tc, result_str

                    results = await asyncio.gather(*(_run_one(tc) for tc in accumulated_tool_calls))

                    for tc, res in results:
                        working_messages.append({
                            "role": "tool",
                            "tool_call_id": tc.get("id") or "",
                            "name": tc.get("name") or "",
                            "content": res,
                        })

                    # Loop continues: next LLM call sees the tool results.
                else:
                    # Exited the for-loop without break → hit MAX_TOOL_DEPTH.
                    # Surface this as a user-visible warning so they know
                    # the agent gave up rather than just going silent.
                    _log.warning(
                        "voicechat: tool depth cap hit (%d) — abandoning further tool calls",
                        MAX_TOOL_DEPTH,
                    )
                    try:
                        await ws.send_json({
                            "type": "warning",
                            "code": "tool_depth_exceeded",
                            "message": f"agent exceeded {MAX_TOOL_DEPTH} tool calls in one turn",
                        })
                    except Exception:
                        pass

                # Drain any in-flight JSON the filter was buffering,
                # then any prose still held by the narration scrubber.
                # If the stream ended mid-JSON (rare) and the partial
                # blob looks non-leaky, treat it as real content. The
                # filter handles the leak-detection internally so we
                # don't have to second-guess here.
                leftover = json_leak_filter.flush()
                if leftover:
                    leftover = narration_scrubber.feed(leftover)
                if not leftover:
                    leftover = narration_scrubber.flush()
                if leftover:
                    bot_text_full.append(leftover)
                    with suppress(Exception):
                        await ws.send_json({"type": "token", "text": leftover})
                    if VOICECHAT_TTS_ENABLED and chunking_active:
                        for sentence in chunker.feed(leftover):
                            spoken = sanitize_for_tts(sentence)
                            if spoken:
                                await sentence_q.put((spoken, False))
                    else:
                        tail_buffer += leftover

                # LLM stream ended. Emit whatever's left as one final chunk:
                #   • sentence mode: chunker buffer with no terminator yet
                #   • tail mode:     tail_buffer accumulated after flip
                if VOICECHAT_TTS_ENABLED:
                    if chunking_active:
                        tail = (chunker.flush() or "").strip()
                    else:
                        tail = tail_buffer.strip()
                    if tail:
                        spoken_tail = sanitize_for_tts(tail)
                        if spoken_tail:
                            await sentence_q.put((spoken_tail, False))
            finally:
                # Sentinel to release the consumer no matter what.
                await sentence_q.put(None)

        # TTS WS warmer is now SESSION-scoped (built once in
        # ``voicechat_session`` and passed in here as ``tts_warmer``).
        # That means chunk 1 of EVERY turn — not just chunks 2..N
        # within a turn — gets the pre-warmed WS, saving ~500 ms of
        # handshake per turn. The first warmup is kicked off
        # immediately on WS connect so it's ready by the time the
        # user finishes their first sentence. Each chunk's streamer
        # additionally schedules a background prewarm for the NEXT
        # WS, keeping the warmer pipeline full.

        # Mic-mute gate is now driven by the client's ``client_audio_started``
        # / ``client_audio_settled`` events — see ``bot_speaking_evt``
        # docstring in ``voicechat_session``. No server-side byte-count
        # bookkeeping here.

        # Per-turn pod pin: every sentence in this turn lands on the
        # SAME tts_streaming pod so the voice doesn't change between
        # sentences. The pin acquires one dispatcher slot at first use
        # (inside stream_tts_for_voice) and holds it until release()
        # below — closing it on natural turn end AND on exception so
        # we never leak the slot.
        from voicechat_service import TurnTtsPodPin
        turn_pod_pin = TurnTtsPodPin()

        async def tts_consumer() -> None:
            nonlocal ttfa_ms
            sentence_id = 0
            while True:
                item = await sentence_q.get()
                if item is None:
                    return
                spoken, is_filler = item
                sentence_id += 1
                sid = sentence_id
                frames = 0
                bytes_sent = 0
                # `is_filler=true` tells the frontend audio player to start
                # playback as soon as the first frame arrives, bypassing the
                # 1500 ms prebuffer. Without this the filler is hidden inside
                # the prebuffer and the user hears it AFTER the LLM has
                # already finished — defeating the latency-masking intent.
                meta = {
                    "type": "audio_meta",
                    "sentence_id": sid,
                    "sample_rate": 24000,
                    "frame_ms": 40,
                    "encoding": "pcm16le",
                    "channels": 1,
                }
                if is_filler:
                    meta["is_filler"] = True
                try:
                    await ws.send_json(meta)
                except Exception:
                    return
                try:
                    async for chunk in stream_tts_for_voice(
                        spoken, voice, user_id=user_id, language=language,
                        warmer=tts_warmer, pod_pin=turn_pod_pin,
                    ):
                        if chunk.kind == "audio" and isinstance(chunk.payload, (bytes, bytearray)):
                            if ttfa_ms is None:
                                ttfa_ms = int((time.perf_counter() - started) * 1000)
                                _log.info("tts: TTFA=%d ms (chunk %d)", ttfa_ms, sid)
                                _log.info(
                                    "[stream] trace session=%s phase=tts_first_audio ttfa=%dms ttft=%dms",
                                    session_id, ttfa_ms, ttft_ms or 0,
                                )
                            try:
                                # Avoid an extra ~2 KB copy when payload is
                                # already bytes — only convert if bytearray.
                                payload = chunk.payload if isinstance(chunk.payload, bytes) else bytes(chunk.payload)
                                if call_recorder is not None:
                                    call_recorder.push_agent(payload)
                                await ws.send_bytes(payload)
                                frames += 1
                                bytes_sent += len(payload)
                            except Exception:
                                _log.warning("tts: client ws closed mid-stream")
                                return
                        elif chunk.kind == "error":
                            err = chunk.payload if isinstance(chunk.payload, dict) else {}
                            _log.error("tts: upstream error: %s", err)
                            try:
                                await ws.send_json({
                                    "type": "error",
                                    "code": "tts_failed",
                                    "message": err.get("message") or "tts engine failed",
                                })
                            except Exception:
                                pass
                            return
                    _log.info("tts: chunk %d done frames=%d bytes=%d (%d chars)",
                              sid, frames, bytes_sent, len(spoken))
                    try:
                        await ws.send_json({"type": "audio_end", "sentence_id": sid})
                    except Exception:
                        return
                except Exception:
                    _log.exception("tts pipeline error")
                    try:
                        await ws.send_json({"type": "error", "code": "tts_failed", "message": "tts pipeline error"})
                    except Exception:
                        pass
                    return

        try:
            await asyncio.gather(llm_producer(), tts_consumer())
        finally:
            # Do NOT close ``tts_warmer`` here — it's session-scoped
            # now and closed once on WS disconnect (in
            # ``voicechat_session``'s outer finally). Closing it
            # per-turn would defeat the cross-turn pre-warming and
            # put us back to the ~500 ms-per-turn WS handshake cost.
            # Mic-mute gate release happens when the client posts
            # ``client_audio_settled`` (audio queue drained OR barge-in
            # fade finished). No server-side scheduling needed.
            #
            # Tell the recorder this turn's TTS is done pushing. If
            # ``client_audio_settled`` has already fired for this turn,
            # the recorder commits the whole buffer here. Otherwise it
            # waits for the settled signal — either order completes the
            # turn. Without this hook the recorder would wait forever
            # for a "settled after TTS done" pair that never explicitly
            # exists in the wire protocol.
            if call_recorder is not None:
                call_recorder.notify_agent_tts_done()
            # Release the per-turn pinned pod (drops the dispatcher
            # slot it held for this turn). Runs whether the gather
            # ended normally or via a barge-in cancel.
            with suppress(Exception):
                await turn_pod_pin.release()

        bot_text_joined = "".join(bot_text_full).strip()
        if bot_text_joined:
            conversation.append(ChatMessage(role="assistant", content=bot_text_joined))

        await ws.send_json({"type": "turn_end"})

        # ---------- 3) opportunistic summarization ----------
        # Once the dialogue exceeds the trigger we collapse the oldest turns
        # into a rolling summary message. Runs synchronously between turns
        # (not concurrent with another turn), which keeps mutation of
        # ``conversation`` race-free without locks. Adds ~1–2 s every ~12
        # turns of conversation, then the bot keeps full grounding.
        try:
            await maybe_summarize_conversation(conversation)
        except Exception:  # noqa: BLE001
            _log.exception("summarization step failed (non-fatal)")

    except asyncio.CancelledError:
        # barge-in: fine, just bail out cleanly
        try:
            await ws.send_json({"type": "cancelled"})
        except Exception:
            pass
        error_str = "cancelled"
        raise
    except Exception as exc:  # noqa: BLE001
        _log.exception("voicechat turn failed")
        try:
            await ws.send_json({"type": "error", "code": "turn_failed", "message": str(exc)[:200]})
        except Exception:
            pass
        error_str = str(exc)[:300]
    finally:
        latency_ms = int((time.perf_counter() - started) * 1000)
        await _record_turn(
            user_id=user_id,
            user_text=user_text_final,
            bot_text="".join(bot_text_full),
            mode=mode or "unknown",
            latency_ms=latency_ms,
            ttft_ms=ttft_ms or 0,
            ttfa_ms=ttfa_ms,
            error=error_str,
            session_id=session_id,
            agent_id=agent_id,
        )
