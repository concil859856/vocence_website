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
import json
import logging
import os
import time
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, WebSocket, WebSocketDisconnect

import json

import agent_knowledge
from assistant_knowledge_indexer import ASSISTANT_AGENT_ID
from local_db import get_connection
from routers.auth import _decode_token, _get_user_by_id  # type: ignore
from studio_tts_service import transcribe_audio
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
    sanitize_for_tts,
    stream_llm,
    stream_tts_for_voice,
    VOICECHAT_EXTRA_SYSTEM_PROMPT,
)


# Cumulative chars emitted to TTS via the per-sentence path before we flip
# to whole-tail mode. Short replies (≤ 300 chars) ride the fast,
# sentence-by-sentence path the entire turn — TTFA stays low. Longer
# replies switch to accumulating the rest into one final TTS call so the
# bulk of the answer keeps coherent prosody.
WHOLE_REPLY_CHUNK_THRESHOLD = int(os.environ.get("VOICECHAT_WHOLE_REPLY_THRESHOLD") or "300")

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
) -> None:
    try:
        conn = await get_connection()
        try:
            await conn.execute(
                """
                INSERT INTO studio_voicechat_history
                (user_id, mode, user_text, bot_text, latency_ms, ttft_ms, ttfa_ms, error,
                 status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                """,
                (
                    user_id,
                    mode,
                    user_text[:8000],
                    bot_text[:16000],
                    latency_ms,
                    ttft_ms,
                    ttfa_ms,
                    error[:500] if error else None,
                    "completed" if not error else "failed",
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


@router.websocket("/session")
async def voicechat_session(
    ws: WebSocket,
    token: str | None = Query(default=None),
    agent_id: str | None = Query(default=None),
) -> None:
    # Auth: query param first, then Authorization header
    auth_user_id: str | None = _decode_user_from_token(token)
    if not auth_user_id:
        auth_header = ws.headers.get("authorization") or ws.headers.get("Authorization")
        if auth_header and auth_header.lower().startswith("bearer "):
            auth_user_id = _decode_user_from_token(auth_header.split(" ", 1)[1])

    await ws.accept()
    if not auth_user_id:
        await ws.send_json({"type": "error", "code": "auth_required", "message": "missing or invalid token"})
        await ws.close(code=4401)
        return

    user = await _get_user_by_id(auth_user_id)
    if not user:
        await ws.send_json({"type": "error", "code": "user_not_found", "message": "user no longer exists"})
        await ws.close(code=4401)
        return

    if not llm_configured():
        await ws.send_json({"type": "error", "code": "llm_not_configured", "message": "assistant offline"})
        await ws.close(code=4503)
        return
    if not QWEN3_TTS_BASE_URL:
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

    session_id = f"vc-{int(time.time() * 1000)}-{auth_user_id[:6]}"
    # Send ready — client may have already disconnected (e.g., React.StrictMode
    # dev double-mount). Don't crash on that, the next mount will reconnect.
    try:
        await ws.send_json({"type": "ready", "session_id": session_id, "agent": agent_ctx and {"id": agent_id, "name": agent_ctx["name"]}})
    except WebSocketDisconnect:
        return
    except Exception:
        _log.debug("voicechat: client disconnected before ready ack", exc_info=False)
        return

    # Build the system prompt. Layered structure so the LLM has a clear
    # mental model of who it is, what it's for, what it knows, and how to
    # behave during the conversation. The previous version dropped the
    # agent's `purpose` field entirely and gave only minimal guidance.
    # ``knowledge_uses_rag`` is set inside the agent_ctx branch; default
    # False so the no-agent (Vocence Assistant) path is well-defined too.
    knowledge_uses_rag = False
    if agent_ctx:
        cfg = agent_ctx["config"]
        agent_name = agent_ctx["name"].strip() or "Assistant"
        purpose = (cfg.get("purpose") or "").strip()
        sp = (cfg.get("system_prompt") or "").strip()
        knowledge = (cfg.get("knowledge") or "").strip()

        sections: list[str] = [f"You are {agent_name}, a voice assistant."]

        if purpose:
            sections.append(f"# Your purpose\n{purpose}")

        if sp:
            sections.append(f"# How you behave\n{sp}")

        # Knowledge handling:
        #   - Short bodies (≤ RAG_DUMP_BELOW_CHARS): dump verbatim (current behaviour)
        #   - Larger bodies: skip the dump here; we'll retrieve relevant chunks
        #     per user turn via FTS5 and inject them just before the LLM call.
        knowledge_uses_rag = agent_knowledge.should_use_rag(knowledge)
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

        sections.append(
            "# Conversation guidelines\n"
            "- This is one continuous voice conversation with a single user. "
            "Remember everything they've told you so far in this session — "
            "their name, preferences, what you've already discussed, decisions "
            "you've made together. Reference earlier parts when relevant "
            "(\"you mentioned earlier…\", \"going back to your question about…\").\n"
            "- Stay in character as defined above. Don't break role to apologise "
            "for being an AI unless the user directly asks.\n"
            "- If something is outside your purpose or knowledge, say so plainly — "
            "do not invent facts, prices, names, or features.\n"
            "- Keep replies short and natural — usually 2–3 sentences. The user "
            "is listening, not reading. Long monologues are wrong here.\n"
            "- Use \"we\" / \"you\" — you're in conversation with them, not "
            "lecturing at them."
        )

        # Voice-chat format rules apply to EVERY agent regardless of how
        # the user wrote its system prompt — TTS quality depends on this.
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

    # Track current turn task so we can cancel on barge-in
    current_turn: asyncio.Task | None = None

    async def _cancel_current() -> None:
        nonlocal current_turn
        if current_turn and not current_turn.done():
            current_turn.cancel()
            try:
                await current_turn
            except (asyncio.CancelledError, Exception):
                pass
        current_turn = None

    try:
        while True:
            try:
                raw = await ws.receive_text()
            except WebSocketDisconnect:
                await _cancel_current()
                return
            except Exception:
                await _cancel_current()
                return

            try:
                payload = json.loads(raw)
            except Exception:
                await ws.send_json({"type": "error", "code": "bad_request", "message": "expected JSON"})
                continue

            mtype = payload.get("type")

            if mtype == "cancel":
                await _cancel_current()
                try:
                    await ws.send_json({"type": "cancelled"})
                except (WebSocketDisconnect, RuntimeError, Exception):
                    return
                continue

            if mtype not in {"voice", "text"}:
                await ws.send_json({"type": "error", "code": "bad_request", "message": f"unknown type: {mtype}"})
                continue

            # Cancel any in-flight turn before starting a new one
            await _cancel_current()

            # Per-user rate limit (no credits, but bound abuse)
            allowed, retry_after = await check_rate_limit(auth_user_id)
            if not allowed:
                await ws.send_json({
                    "type": "error",
                    "code": "rate_limited",
                    "message": f"too many turns; try again in {retry_after}s",
                    "retry_after": retry_after,
                })
                continue

            # RAG agent id selection:
            #   • real agent with large knowledge → that agent's id
            #   • Vocence Assistant (no agent_ctx) → synthetic assistant id,
            #     so search hits the in-product knowledge base we seed at
            #     startup from vocence_assistant_knowledge/*.md
            #   • real agent with small knowledge → no RAG (the body is
            #     already inlined into the system prompt).
            if agent_ctx and knowledge_uses_rag:
                rag_id: str | None = agent_id
            elif not agent_ctx:
                rag_id = ASSISTANT_AGENT_ID
            else:
                rag_id = None

            current_turn = asyncio.create_task(
                _run_turn(
                    ws=ws,
                    user_id=auth_user_id,
                    payload=payload,
                    conversation=conversation,
                    voice=agent_voice,
                    rag_agent_id=rag_id,
                )
            )
    finally:
        await _cancel_current()


async def _run_turn(
    *,
    ws: WebSocket,
    user_id: str,
    payload: dict,
    conversation: list[ChatMessage],
    voice: str | None = None,
    rag_agent_id: str | None = None,
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
        # ---------- 1) get user text (STT or direct) ----------
        if mode == "voice":
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
                if STT_POOL is not None and STT_POOL.configured():
                    # Pick a pod URL via the existing pool. acquire() is async ctx mgr —
                    # we need to hold it for the duration of the call.
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
            try:
                chunks = await agent_knowledge.search_agent_knowledge(
                    rag_agent_id, user_text_final, top_k=5,
                )
            except Exception:  # noqa: BLE001
                _log.exception("knowledge retrieval failed; continuing without it")
                chunks = []

            if chunks:
                chunks_text = agent_knowledge.format_chunks_for_prompt(chunks)
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
        sentence_q: asyncio.Queue[str | None] = asyncio.Queue(maxsize=8)

        async def llm_producer() -> None:
            nonlocal ttft_ms, ttfs_ms
            chunker = SentenceChunker()
            chunking_active = True
            emitted_chars = 0
            tail_buffer = ""
            try:
                async for delta in stream_llm(llm_messages):
                    if ttft_ms is None:
                        ttft_ms = int((time.perf_counter() - started) * 1000)
                    bot_text_full.append(delta)
                    try:
                        await ws.send_json({"type": "token", "text": delta})
                    except Exception:
                        return  # client disconnected — abort turn

                    if not VOICECHAT_TTS_ENABLED:
                        continue

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
                                    await sentence_q.put(spoken)
                                    emitted_chars += len(spoken)
                                    if emitted_chars >= WHOLE_REPLY_CHUNK_THRESHOLD:
                                        chunking_active = False
                                        leftover = (chunker.flush() or "").lstrip()
                                        if leftover:
                                            tail_buffer = leftover
                            else:
                                # Threshold just flipped mid-batch; fold
                                # remaining yielded sentences into tail.
                                tail_buffer = (
                                    (tail_buffer + " " + sentence).lstrip()
                                    if tail_buffer else sentence
                                )
                    else:
                        tail_buffer += delta

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
                            await sentence_q.put(spoken_tail)
            finally:
                # Sentinel to release the consumer no matter what.
                await sentence_q.put(None)

        async def tts_consumer() -> None:
            nonlocal ttfa_ms
            sentence_id = 0
            while True:
                spoken = await sentence_q.get()
                if spoken is None:
                    return
                sentence_id += 1
                sid = sentence_id
                frames = 0
                bytes_sent = 0
                try:
                    await ws.send_json({
                        "type": "audio_meta",
                        "sentence_id": sid,
                        "sample_rate": 24000,
                        "frame_ms": 40,
                        "encoding": "pcm16le",
                        "channels": 1,
                    })
                except Exception:
                    return
                try:
                    async for chunk in stream_tts_for_voice(spoken, voice, user_id=user_id):
                        if chunk.kind == "audio" and isinstance(chunk.payload, (bytes, bytearray)):
                            if ttfa_ms is None:
                                ttfa_ms = int((time.perf_counter() - started) * 1000)
                                _log.info("tts: TTFA=%d ms (chunk %d)", ttfa_ms, sid)
                            try:
                                # Avoid an extra ~2 KB copy when payload is
                                # already bytes — only convert if bytearray.
                                payload = chunk.payload if isinstance(chunk.payload, bytes) else bytes(chunk.payload)
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

        await asyncio.gather(llm_producer(), tts_consumer())

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
        )
