"""Voice-chat orchestration: LLM streaming + Qwen3 TTS streaming + sentence chunking.

Pipeline (one user turn):
    user audio → STT → text → LLM stream → sentence chunker → Qwen3 TTS stream → audio frames
    user text  →               LLM stream → sentence chunker → Qwen3 TTS stream → audio frames

Sentences are flushed to TTS as soon as a punctuation boundary or max-chars
threshold is hit, so the first audio packet can leave the server long before
the LLM finishes generating. Multiple sentences are pipelined sequentially
(strict order on the wire) so the client just plays as it arrives.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from collections import deque
from dataclasses import dataclass
from time import time
from typing import AsyncIterator, Optional

import base64
import hashlib
import io
import wave

import aiohttp
import numpy as np

from sample_voice_loader import is_sample_voice, load_sample_voice
from studio_tts_service import (
    CHUTES_AUTH_KEY,
    VOICE_DESIGN_LLM_BASE_URL,
    voice_clone_synthesize,
)


_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

VOICECHAT_LLM_MODEL = (os.environ.get("VOICECHAT_LLM_MODEL") or os.environ.get("VOICE_DESIGN_LLM_MODEL") or "").strip()
VOICECHAT_LLM_TEMPERATURE = float(os.environ.get("VOICECHAT_LLM_TEMPERATURE") or "0.6")
# Hard ceiling on LLM output tokens for voice-chat replies. 2000 tokens
# is roughly 1400 English words / 10–15 paragraphs — generous headroom
# for an in-depth answer when the user explicitly asks for one
# ("explain in detail", "whole history", etc.). Brevity is still the
# default — enforced by the system prompt — this is a ceiling, not a
# target.
VOICECHAT_LLM_MAX_TOKENS = int(os.environ.get("VOICECHAT_LLM_MAX_TOKENS") or "2000")
VOICECHAT_LLM_TIMEOUT_SEC = float(os.environ.get("VOICECHAT_LLM_TIMEOUT_SEC") or "60")
VOICECHAT_EXTRA_SYSTEM_PROMPT = os.environ.get("VOICECHAT_SYSTEM_PROMPT")  # optional operator note

# Master kill-switch for synthesizing audio in voicechat sessions. When
# disabled (VOICECHAT_TTS_ENABLED=0), the router still streams LLM tokens
# to the client (so users see text appear in real time) but skips every
# TTS / clone-streaming call. Useful for isolating LLM behaviour.
VOICECHAT_TTS_ENABLED = (
    (os.environ.get("VOICECHAT_TTS_ENABLED") or "1").strip().lower()
    not in ("0", "false", "no", "off")
)

QWEN3_TTS_BASE_URL = (os.environ.get("QWEN3_TTS_BASE_URL") or "http://localhost:8111").strip().rstrip("/")
QWEN3_TTS_API_KEY = (os.environ.get("QWEN3_TTS_API_KEY") or "").strip()
QWEN3_TTS_VOICE = (os.environ.get("QWEN3_TTS_VOICE") or "default").strip()
QWEN3_TTS_TIMEOUT_SEC = float(os.environ.get("QWEN3_TTS_TIMEOUT_SEC") or "60")

# Default voice for the Vocence Assistant (the floating bot in Studio when
# no agent_id is set). Must be a sample voice id (see frontend
# /src/data/sampleVoices.ts and backend sample_voices_data.py) so it
# routes through the clone-streaming service — same TTS path as agents.
# Setting it to a Qwen3 speaker name (e.g. "Ryan") would route through the
# now-unused local qwen3_streaming service and is no longer supported.
VOCENCE_ASSISTANT_VOICE = (
    os.environ.get("VOCENCE_ASSISTANT_VOICE") or "char-friendly-ai-assistant"
).strip()

# Streaming voice-clone service (qwen3-clone-streaming). When set, agents
# with a sample voice id route through this service for true low-latency
# clone streaming. Falls back to one-shot voice_clone_synthesize if unset
# or unreachable.
QWEN3_CLONE_BASE_URL = (os.environ.get("QWEN3_CLONE_BASE_URL") or "").strip().rstrip("/")
QWEN3_CLONE_API_KEY = (os.environ.get("QWEN3_CLONE_API_KEY") or "").strip()
QWEN3_CLONE_TIMEOUT_SEC = float(os.environ.get("QWEN3_CLONE_TIMEOUT_SEC") or "120")

# In-session summarization. When the conversation has more than
# SUMMARIZE_TRIGGER user/assistant turns since the last summary, fold the
# oldest (count - KEEP_RECENT) turns into a single "Earlier in this
# conversation:" system message. Keeps the bot grounded in the whole
# session without blowing past context limits or paying for huge prompts.
SUMMARIZE_TRIGGER_TURNS = int(os.environ.get("VOICECHAT_SUMMARIZE_TRIGGER") or "24")
SUMMARIZE_KEEP_RECENT = int(os.environ.get("VOICECHAT_SUMMARIZE_KEEP_RECENT") or "10")


# Sentence boundary detection — covers Western and CJK punctuation.
#
# A boundary is one of:
#   • Western: one or more ``. ! ?`` immediately preceded by non-whitespace
#     AND followed by whitespace. The trailing-whitespace requirement is
#     what protects us from splitting mid-acronym ("U.S." stays whole until
#     a space follows it).
#   • CJK: ``。 ！ ？`` (full-width Chinese/Japanese terminators).
#     Whitespace after isn't required — the character itself terminates
#     the sentence in writing systems that don't use spaces between words.
#   • A line break (``\n+``).
#
# Edge cases the chunker's skip-too-short logic handles for us:
#   - "U.S. citizen lives here." → "U.S." is too short, skipped,
#     emitted as one sentence at the final period.
#   - "1. First item." → "1." is too short, absorbed.
#
# Two-phase chunker tuned for the qwen3-tts-streaming server (1000-char hard cap).
#
# Phase 1 — first chunk of a reply (TTFA-critical, kept small):
#   Emit at the FIRST sentence boundary once at least FIRST_CHUNK_MIN chars
#   are buffered, up to FIRST_CHUNK_MAX. The user perceives this chunk's
#   latency as "how long until the agent starts speaking", so we trade a
#   tiny prosody hit for ~2× faster TTFA.
#
# Phase 2 — subsequent chunks (throughput-optimized, packed):
#   Accumulate up to PACK_TARGET chars, then cut at the LAST sentence
#   boundary within that window. Drastically fewer chunks → fewer WS
#   handshakes, less ref-audio re-upload, and the frontend's 1500 ms
#   prebuffer easily masks the per-chunk gaps. If no sentence boundary
#   appears by PACK_HARD_FLOOR (rare runaway no-punctuation text), we
#   hard-cut at the last word.
#
# All thresholds stay safely under the server's MAX_TEXT_CHARS=1000.
SENTENCE_END_PATTERN = re.compile(r"(?<=\S)[\.!\?]+\s+|[。！？]+|\n+")
FIRST_CHUNK_MIN = int(os.environ.get("VOICECHAT_FIRST_CHUNK_MIN") or "30")
FIRST_CHUNK_MAX = int(os.environ.get("VOICECHAT_FIRST_CHUNK_MAX") or "200")
PACK_TARGET = int(os.environ.get("VOICECHAT_PACK_TARGET") or "700")
PACK_HARD_FLOOR = int(os.environ.get("VOICECHAT_PACK_HARD_FLOOR") or "900")
# Kept for backward compat with any external import; no longer used internally.
SENTENCE_MAX_CHARS = PACK_HARD_FLOOR
SENTENCE_MIN_CHARS = FIRST_CHUNK_MIN

# Abbreviations whose trailing period must NOT be treated as sentence end.
# Lowercase, no trailing dot. We check the word immediately before the
# matched punctuation against this set; if it matches, the chunker skips
# that boundary and continues scanning. Without this guard, "Hi Mr. Smith
# and Dr. Jones." would split mid-sentence at "Mr." — the user hears an
# audible gap inside what should be one continuous breath.
_SENTENCE_ABBREVIATIONS = frozenset({
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr",
    "st", "mt", "ave", "blvd", "rd",
    "vs", "etc", "ie", "eg", "no",
    "inc", "ltd", "co", "corp",
    "sgt", "col", "gen", "lt", "capt", "cmdr",
    "u.s", "u.k", "e.g", "i.e",
})


def _word_before(buf: str, end_pos: int) -> str:
    """Return the lowercase word immediately preceding ``end_pos`` in
    ``buf``. Walks back over alphanumerics AND embedded periods (so we
    can match acronyms like ``U.S`` whose internal period is part of
    the abbreviation, not a sentence end)."""
    i = end_pos
    while i > 0 and (buf[i - 1].isalnum() or buf[i - 1] == "."):
        i -= 1
    return buf[i:end_pos].lower().rstrip(".")

# Per-user rate limit (in-memory; resets on restart)
RATE_LIMIT_TURNS = int(os.environ.get("VOICECHAT_RATE_LIMIT_TURNS") or "30")
RATE_LIMIT_WINDOW_SEC = int(os.environ.get("VOICECHAT_RATE_LIMIT_WINDOW_SEC") or "3600")

_rate_lock = asyncio.Lock()
_rate_buckets: dict[str, deque[float]] = {}


async def check_rate_limit(user_id: str) -> tuple[bool, int]:
    """Return (allowed, retry_after_seconds_if_blocked).

    Sliding window, in-memory. Good enough for v1; swap to Redis/SQLite when
    we run multiple backend instances.
    """
    now = time()
    cutoff = now - RATE_LIMIT_WINDOW_SEC
    async with _rate_lock:
        bucket = _rate_buckets.setdefault(user_id, deque())
        while bucket and bucket[0] < cutoff:
            bucket.popleft()
        if len(bucket) >= RATE_LIMIT_TURNS:
            retry = max(1, int(bucket[0] + RATE_LIMIT_WINDOW_SEC - now))
            return False, retry
        bucket.append(now)
        return True, 0


# ---------------------------------------------------------------------------
# Sentence chunker
# ---------------------------------------------------------------------------


class SentenceChunker:
    """Two-phase chunker for the voice-agent TTS pipeline.

    Phase 1 (first chunk): emit at the first sentence boundary once the
    buffer crosses FIRST_CHUNK_MIN, up to FIRST_CHUNK_MAX. Optimized for
    fast TTFA so the agent starts talking sooner.

    Phase 2 (chunks 2..N): pack up to PACK_TARGET chars, cut at the LAST
    sentence boundary in that window. If no boundary appears by
    PACK_HARD_FLOOR we hard-cut at the last word. Optimized for throughput
    so a typical reply uses 2-3 chunks instead of one-per-sentence.

    Trailing fragment is flushed via ``flush()`` at end-of-stream.
    """

    def __init__(self) -> None:
        self._buf = ""
        self._first_emitted = False

    def feed(self, text: str) -> list[str]:
        if not text:
            return []
        self._buf += text
        out: list[str] = []
        # Keep extracting until no more chunks are ready. A single feed()
        # can legitimately emit multiple chunks if the LLM delivers a big
        # burst (e.g. a short reply arriving in one delta).
        while True:
            chunk = self._try_extract()
            if chunk is None:
                break
            out.append(chunk)
        return out

    def flush(self) -> str | None:
        tail = self._buf.strip()
        self._buf = ""
        # Mark phase 2 active going forward — next reply's first chunk
        # restarts with a fresh chunker instance, so this is just for
        # safety inside one chunker's lifecycle.
        self._first_emitted = True
        if tail and len(tail) >= 2:
            return tail
        return None

    # ---- internals -------------------------------------------------------

    def _try_extract(self) -> str | None:
        if not self._first_emitted:
            return self._extract_first()
        return self._extract_packed()

    def _extract_first(self) -> str | None:
        # Earliest sentence boundary whose preceding content is at least
        # FIRST_CHUNK_MIN chars AND isn't an abbreviation. Anything shorter
        # is skipped, scanning continues forward — so "Sure." followed by
        # the real sentence becomes one chunk, not a stilted "Sure." alone.
        for m in SENTENCE_END_PATTERN.finditer(self._buf):
            if m.end() > FIRST_CHUNK_MAX:
                break
            stripped_len = len(self._buf[:m.end()].strip())
            if stripped_len < FIRST_CHUNK_MIN:
                continue
            if self._is_abbreviation_boundary(m):
                continue
            chunk = self._buf[:m.end()].strip()
            self._buf = self._buf[m.end():].lstrip()
            self._first_emitted = True
            return chunk

        # No usable sentence boundary in the FIRST_CHUNK_MAX window yet.
        # If we already have ≥ FIRST_CHUNK_MAX chars buffered, the LLM is
        # producing a very long opening sentence (or no punctuation at all).
        # Cut at the last word so TTFA doesn't drift further.
        if len(self._buf) >= FIRST_CHUNK_MAX:
            cut = self._buf.rfind(" ", 0, FIRST_CHUNK_MAX)
            if cut <= 0:
                cut = FIRST_CHUNK_MAX
            chunk = self._buf[:cut].strip()
            self._buf = self._buf[cut:].lstrip()
            self._first_emitted = True
            if chunk:
                _log.info(
                    "SentenceChunker: phase-1 word-cut at %d chars (no .!?。！？\\n yet); "
                    "head=%r", cut, chunk[:80],
                )
                return chunk

        return None  # wait for more text

    def _extract_packed(self) -> str | None:
        # Hold off until we have at least PACK_TARGET buffered — emitting
        # earlier would fragment the reply into more chunks than needed.
        # The frontend's prebuffer hides the wait.
        if len(self._buf) < PACK_TARGET:
            return None

        # Last sentence boundary at or before PACK_TARGET. Pack tight.
        chosen_end = self._last_boundary_at_or_before(PACK_TARGET)
        if chosen_end is not None:
            chunk = self._buf[:chosen_end].strip()
            self._buf = self._buf[chosen_end:].lstrip()
            return chunk

        # No boundary in 0..PACK_TARGET. Allow scanning further up to
        # PACK_HARD_FLOOR before giving up on natural prosody — gives the
        # LLM a chance to land a period in the gap window.
        if len(self._buf) < PACK_HARD_FLOOR:
            return None

        chosen_end = self._last_boundary_at_or_before(PACK_HARD_FLOOR)
        if chosen_end is not None:
            chunk = self._buf[:chosen_end].strip()
            self._buf = self._buf[chosen_end:].lstrip()
            return chunk

        # Runaway no-punctuation text. Hard-cut at the last word boundary.
        cut = self._buf.rfind(" ", 0, PACK_HARD_FLOOR)
        if cut <= 0:
            cut = PACK_HARD_FLOOR
        chunk = self._buf[:cut].strip()
        self._buf = self._buf[cut:].lstrip()
        if chunk:
            _log.warning(
                "SentenceChunker: phase-2 hard-cut at %d chars (no .!?。！？\\n in window); "
                "head=%r", cut, chunk[:80],
            )
            return chunk
        return None

    def _last_boundary_at_or_before(self, max_pos: int) -> int | None:
        """Return the end-position of the LAST sentence boundary at or before
        ``max_pos`` in the current buffer, skipping abbreviation false
        positives. None if there is no usable boundary in that range."""
        last: int | None = None
        for m in SENTENCE_END_PATTERN.finditer(self._buf):
            if m.end() > max_pos:
                break
            if self._is_abbreviation_boundary(m):
                continue
            last = m.end()
        return last

    def _is_abbreviation_boundary(self, m: "re.Match[str]") -> bool:
        # Only Western .!? matches can be abbreviation false-positives — the
        # CJK punctuation matches are full sentence-stops by definition.
        if m.start() >= len(self._buf):
            return False
        if self._buf[m.start()] not in ".!?":
            return False
        word = _word_before(self._buf, m.start())
        return bool(word) and word in _SENTENCE_ABBREVIATIONS


# ---------------------------------------------------------------------------
# LLM streaming (OpenAI-compatible /chat/completions with stream=true)
# ---------------------------------------------------------------------------


@dataclass
class ChatMessage:
    role: str  # "system" | "user" | "assistant"
    content: str


# ---------------------------------------------------------------------------
# In-session conversation summarization
# ---------------------------------------------------------------------------


_EARLIER_PREFIX = "Earlier in this conversation: "


def _is_rolling_summary(msg: ChatMessage) -> bool:
    return msg.role == "system" and msg.content.startswith(_EARLIER_PREFIX)


def _count_dialogue_turns(conv: list[ChatMessage]) -> int:
    """How many user+assistant messages are present (ignores system)."""
    return sum(1 for m in conv if m.role in ("user", "assistant"))


async def maybe_summarize_conversation(conversation: list[ChatMessage]) -> bool:
    """If the dialogue has grown past SUMMARIZE_TRIGGER_TURNS, fold the oldest
    (total − SUMMARIZE_KEEP_RECENT) user/assistant turns into a single
    "Earlier in this conversation:" system message. Mutates ``conversation``
    in place. Returns True if a summary was produced and the list rewritten.

    Layout invariants — preserved across calls:
      conversation[0]            = original system prompt
      conversation[1] (optional) = rolling summary system message
      conversation[2..]          = recent user/assistant turns
    """
    # Avoid circular import — llm_client is loaded lazily.
    from llm_client import chat_complete

    turns = [m for m in conversation if m.role in ("user", "assistant")]
    if len(turns) <= SUMMARIZE_TRIGGER_TURNS:
        return False
    if SUMMARIZE_KEEP_RECENT >= len(turns):
        return False

    to_summarize = turns[: len(turns) - SUMMARIZE_KEEP_RECENT]
    keep_recent = turns[len(turns) - SUMMARIZE_KEEP_RECENT :]

    # Find an existing rolling summary, if any.
    existing_summary: str | None = None
    for m in conversation:
        if _is_rolling_summary(m):
            existing_summary = m.content[len(_EARLIER_PREFIX):].strip()
            break

    transcript = "\n".join(
        f"{'User' if m.role == 'user' else 'Assistant'}: {m.content}"
        for m in to_summarize
    )

    sum_system = (
        "You are a conversation-summarization helper. Given a conversation "
        "excerpt (and optionally a prior summary), produce a single concise "
        "summary in 1–3 short paragraphs. Focus on durable, useful facts: "
        "the user's name, preferences, decisions made, what's been answered, "
        "what's still open, and the topic. Skip pleasantries and verbatim "
        "quotes. Plain prose, no bullets, no preamble — just the summary."
    )
    if existing_summary:
        sum_user = (
            f"Existing summary so far:\n{existing_summary}\n\n"
            f"New excerpt to fold in:\n{transcript}\n\n"
            f"Produce the updated combined summary."
        )
    else:
        sum_user = f"Conversation excerpt:\n{transcript}\n\nProduce the summary."

    # Summarization runs during voice chat (blocks the turn while we
    # compress old history), so latency matters. Groq's small/fast
    # 8B-instant is ideal — compression doesn't need a 70B model and
    # the 8B is ~3× cheaper + ~2× faster. Falls through to the global
    # default when Groq isn't configured.
    from llm_client import groq_llm_configured
    summary_model: str | None = None
    if groq_llm_configured():
        summary_model = f"groq:{os.environ.get('GROQ_SUMMARY_MODEL') or 'llama-3.1-8b-instant'}"

    try:
        new_summary = await chat_complete(
            messages=[
                {"role": "system", "content": sum_system},
                {"role": "user", "content": sum_user},
            ],
            temperature=0.3,
            max_tokens=400,
            model=summary_model,
        )
    except Exception as exc:  # noqa: BLE001
        _log.warning("conversation summarization failed; leaving history as-is: %s", exc)
        return False

    new_summary = (new_summary or "").strip()
    if not new_summary:
        return False

    # Rebuild: keep system prompts that are NOT the rolling summary, then a
    # fresh single rolling-summary message, then the recent turns.
    preserved = [m for m in conversation if m.role == "system" and not _is_rolling_summary(m)]
    rebuilt: list[ChatMessage] = list(preserved)
    rebuilt.append(ChatMessage(role="system", content=_EARLIER_PREFIX + new_summary))
    rebuilt.extend(keep_recent)

    conversation.clear()
    conversation.extend(rebuilt)
    _log.info(
        "summarized %d turns into rolling summary (kept %d recent; summary=%d chars)",
        len(to_summarize), len(keep_recent), len(new_summary),
    )
    return True


def llm_configured() -> bool:
    """Either local Qwen3-4B or Chutes — the unified llm_client picks."""
    from llm_client import llm_configured as _ll_configured  # local import: avoid early circular
    return _ll_configured()


# Longest opening / closing think marker we need to retain when buffering
# across deltas. ``</think>`` is 8 chars; keeping 8 always works for both.
_THINK_BUFFER_RETAIN = 8


async def _strip_think_blocks(stream: AsyncIterator[str]) -> AsyncIterator[str]:
    """Filter ``<think>...</think>`` regions out of a streaming LLM response
    in real time.

    Some local Qwen3-4B endpoints emit chain-of-thought wrapped in
    ``<think>`` tags before the final answer. Those tokens MUST NOT reach
    the chat UI or the TTS pipeline — the model speaking its own
    reasoning out loud is the bug the user just hit.

    The state machine handles tags split arbitrarily across deltas: we
    retain the last 8 chars of the buffer between iterations so a tag
    landing at the boundary of two deltas (e.g. ``"<thi"`` + ``"nk>"``)
    is still detected.
    """
    state = "outside"  # or "inside"
    buffer = ""
    async for delta in stream:
        if not delta:
            continue
        buffer += delta
        while True:
            if state == "outside":
                idx = buffer.find("<think>")
                if idx == -1:
                    # No opening tag in sight → emit everything except a
                    # trailing tail that might still be a partial "<think>".
                    if len(buffer) > _THINK_BUFFER_RETAIN:
                        yield buffer[:-_THINK_BUFFER_RETAIN]
                        buffer = buffer[-_THINK_BUFFER_RETAIN:]
                    break
                # Emit anything before the opening tag, then enter think mode.
                if idx > 0:
                    yield buffer[:idx]
                buffer = buffer[idx + len("<think>"):]
                state = "inside"
                continue
            # inside <think>...</think>
            idx = buffer.find("</think>")
            if idx == -1:
                # No closing tag yet → drop everything except a partial-tag tail.
                if len(buffer) > _THINK_BUFFER_RETAIN:
                    buffer = buffer[-_THINK_BUFFER_RETAIN:]
                break
            buffer = buffer[idx + len("</think>"):]
            state = "outside"
            continue
    # End of stream — flush whatever is left in "outside" state.
    if state == "outside" and buffer:
        yield buffer


async def stream_llm(
    messages: list[ChatMessage],
    *,
    temperature: float | None = None,
    max_tokens: int | None = None,
    model: str | None = None,
) -> AsyncIterator[str]:
    """Yield incremental assistant content deltas.

    Provider routing priority:
      1. Caller-supplied ``model`` with a provider prefix (e.g.
         ``cerebras:llama-3.3-70b``) — always wins.
      2. **Cerebras default for voicechat** — if no model is supplied
         and CEREBRAS_API_KEYS is configured, we force
         ``cerebras:qwen-3-235b-a22b-instruct-2507`` (Qwen 3 235B MoE,
         22B active params, served on Cerebras WSE at sub-30ms first-
         token latency with reliable tool calling and — crucially — no
         hidden reasoning phase that would block content streaming).
         On any stream failure before first delta,
         ``stream_chat_with_tools`` retries against OpenAI automatically
         (see VOICECHAT_LLM_FALLBACK_TO_OPENAI).
      3. Otherwise the global ``llm_client`` default (Chutes/OpenAI/local).

    The output is filtered of ``<think>...</think>`` reasoning blocks so
    neither the chat UI nor the TTS pipeline ever sees the model's
    internal monologue.
    """
    from llm_client import cerebras_llm_configured, stream_chat as _ll_stream  # local import: avoid early circular

    msgs = [{"role": m.role, "content": m.content} for m in messages]
    # Voice chat hits /v1/stream/no-think regardless of LOCAL_LLM_USE_THINK.
    # Reason: the thinking phase generates 500–2000 ms of <think>…</think>
    # tokens before any user-visible content can flow to the chunker, so
    # TTFA suffers badly. The post-think answer quality on conversational
    # Studio/subnet questions is already strong because RAG excerpts do
    # most of the heavy lifting. Override per-call via VOICECHAT_USE_THINK
    # if you want to A/B test thinking on a specific deploy.
    use_think = (os.environ.get("VOICECHAT_USE_THINK") or "").strip().lower() in {"1", "true", "yes"}

    # Voicechat routing (mirrors the priority in routers/voicechat.py):
    #   1. ``VOICECHAT_FORCE_MODEL`` — emergency override (wins over
    #      everything including caller-supplied model).
    #   2. Caller-supplied ``model`` (agent.config.llm_model).
    #   3. ``VOICECHAT_DEFAULT_MODEL`` env var when slot is empty.
    #   4. Cerebras if configured (the normal fast path; OpenAI is the
    #      automatic stream-failure fallback in stream_chat_with_tools).
    #   5. Fall through to global llm_provider() default.
    force_model = (os.environ.get("VOICECHAT_FORCE_MODEL") or "").strip()
    if force_model:
        effective_model = force_model
    else:
        effective_model = model
        if effective_model is None:
            override = (os.environ.get("VOICECHAT_DEFAULT_MODEL") or "").strip()
            if override:
                effective_model = override
            elif cerebras_llm_configured():
                effective_model = f"cerebras:{os.environ.get('CEREBRAS_VOICECHAT_MODEL') or 'qwen-3-235b-a22b-instruct-2507'}"

    upstream = _ll_stream(
        msgs,
        temperature=temperature if temperature is not None else VOICECHAT_LLM_TEMPERATURE,
        max_tokens=max_tokens or VOICECHAT_LLM_MAX_TOKENS,
        think=use_think,
        model=effective_model,
    )
    async for delta in _strip_think_blocks(upstream):
        yield delta


# Markdown / decoration patterns that turn into mouthfuls when fed to TTS.
# This is intentionally conservative — leaves prose intact, only strips the
# wrappers that confuse a speech model.
_MD_FENCED_CODE = re.compile(r"```[^`]*```", re.DOTALL)
_MD_INLINE_CODE = re.compile(r"`([^`\n]+)`")
_MD_LINK = re.compile(r"\[([^\]\n]+)\]\([^)\n]+\)")
_MD_BOLD_STAR = re.compile(r"\*\*([^*\n]+)\*\*")
_MD_BOLD_UND = re.compile(r"__([^_\n]+)__")
_MD_ITALIC_STAR = re.compile(r"\*([^*\n]+)\*")
_MD_ITALIC_UND = re.compile(r"(?<!\w)_([^_\n]+)_(?!\w)")
_MD_STRIKE = re.compile(r"~~([^~\n]+)~~")
_MD_HEADING = re.compile(r"^[ \t]*#{1,6}[ \t]+", re.MULTILINE)
_MD_BULLET = re.compile(r"^[ \t]*[-*+][ \t]+", re.MULTILINE)
_MD_ORDERED = re.compile(r"^[ \t]*\d+\.[ \t]+", re.MULTILINE)
_MD_HRULE = re.compile(r"^[ \t]*-{3,}[ \t]*$", re.MULTILINE)
_BARE_URL = re.compile(r"\bhttps?://\S+", re.IGNORECASE)
_WS_COLLAPSE = re.compile(r"[ \t]+")


class JsonLeakFilter:
    """Strip inline JSON tool-call leakage from LLM content streams.

    Some open-weight models (notably gpt-oss-120b on Cerebras) emit
    tool calls and tool-call results AS PLAIN CONTENT instead of via
    the OpenAI ``delta.tool_calls`` field. The result: garbage like
    ``{"query": "..."}{"query": "...", "results": []}`` ends up in
    the chat bubble AND gets spoken by TTS.

    This filter watches the streamed content, balances braces, and
    when a complete top-level ``{...}`` block looks like a tool-call
    or tool-result envelope (keys: query/answer/results/name/
    arguments), it discards the whole block. Non-tool-looking JSON
    (e.g. someone asking about JSON syntax) passes through.

    State carries across ``feed()`` calls because OpenAI-style SSE
    fragments content into small deltas — a single JSON blob arrives
    as many separate chunks.

    Edge cases handled:
      - Strings containing braces don't confuse the depth counter
      - Escape sequences inside strings
      - Unterminated JSON at end of stream (flushed as content)
      - Mixed content + JSON in the same delta
    """

    # Key sets that mark a JSON object as a leaked tool call / result.
    # Conservative on purpose — we'd rather pass a borderline blob than
    # eat legitimate JSON the user asked about.
    _TOOL_LEAK_INDICATORS = (
        frozenset({"query"}),                           # web_search args
        frozenset({"query", "results"}),                # web_search result
        frozenset({"query", "answer"}),                 # web_search w/ answer
        frozenset({"query", "answer", "results"}),
        frozenset({"name", "arguments"}),               # raw OpenAI tool-call shape
        frozenset({"tool_call"}),
        frozenset({"function"}),
        # Newer Cerebras-served gpt-oss variants emit a different
        # inline shape: ``{"tool":"web_search","input":"..."}`` for the
        # call and ``{"response":"pending"}`` / ``{"response": {...}}``
        # for the wait/result. Both leak straight into chat without
        # these indicators.
        frozenset({"tool"}),
        frozenset({"tool", "input"}),
        frozenset({"tool", "arguments"}),
        frozenset({"tool", "args"}),
        frozenset({"response"}),
        frozenset({"status"}),                          # ``{"status":"pending"}``
        frozenset({"url"}),                             # fetch_url args
        frozenset({"location"}),                        # get_weather args
        frozenset({"city"}),
        frozenset({"timezone"}),                        # get_time args
        frozenset({"title"}),                           # wikipedia_lookup args
    )

    def __init__(self) -> None:
        self._buffer = ""
        self._brace_depth = 0
        self._in_string = False
        self._escape_next = False

    @property
    def in_json(self) -> bool:
        return self._brace_depth > 0

    def feed(self, delta: str) -> str:
        """Consume a content delta, return whatever's safe to emit.
        May return empty if the entire delta was buffered as in-flight JSON."""
        if not delta:
            return ""
        output = []
        for ch in delta:
            if self._brace_depth > 0:
                # Inside a buffered JSON object.
                self._buffer += ch
                if self._escape_next:
                    self._escape_next = False
                elif self._in_string:
                    if ch == "\\":
                        self._escape_next = True
                    elif ch == '"':
                        self._in_string = False
                else:
                    if ch == '"':
                        self._in_string = True
                    elif ch == "{":
                        self._brace_depth += 1
                    elif ch == "}":
                        self._brace_depth -= 1
                        if self._brace_depth == 0:
                            # JSON object closed — decide.
                            blob = self._buffer
                            self._buffer = ""
                            if not self._looks_like_tool_leak(blob):
                                output.append(blob)
            else:
                if ch == "{":
                    # Enter buffering mode.
                    self._brace_depth = 1
                    self._in_string = False
                    self._escape_next = False
                    self._buffer = "{"
                elif ch == "}":
                    # Stray closing brace at top level — almost
                    # certainly debris from a malformed tool-call leak
                    # the LLM emitted (we saw ``}Taomind is …`` in
                    # production after the inner JSON was filtered
                    # but an extra ``}`` carried through). Real prose
                    # never legitimately starts a sentence with ``}``.
                    # We don't drop ``]`` similarly because real text
                    # uses ``[examples like this]`` and losing the
                    # closing bracket would corrupt the message.
                    continue
                else:
                    output.append(ch)
        return "".join(output)

    def flush(self) -> str:
        """Drain any unterminated buffer as content (graceful fallback
        when the LLM ends a stream mid-JSON — better to leak a partial
        than to eat it silently)."""
        if self._brace_depth == 0:
            return ""
        out = self._buffer
        self._buffer = ""
        self._brace_depth = 0
        self._in_string = False
        self._escape_next = False
        # Don't risk emitting a partial tool-call leak either. If it
        # looks like one (incomplete but recognizable), drop it.
        if self._looks_partial_tool_leak(out):
            return ""
        return out

    @classmethod
    def _looks_like_tool_leak(cls, blob: str) -> bool:
        try:
            obj = json.loads(blob)
        except Exception:
            return False
        if not isinstance(obj, dict):
            return False
        keys = frozenset(obj.keys())
        for indicator in cls._TOOL_LEAK_INDICATORS:
            if indicator.issubset(keys):
                return True
        return False

    # Tool-narration prefix patterns the model still emits as plain prose
    # even after we tell it not to. These ALWAYS sit at the very start of
    # the response (before the real answer), so we only check the opening
    # window of each turn — once we've flushed real content, the scrubber
    # goes into pass-through and never inspects later text. Each pattern
    # matches a full sentence terminated by ``.`` / ``!`` / ``?`` / EOL.
    _NARRATION_SENTENCE = re.compile(
        r"""^\s*(?:
            we[ ']ll\s+(?:wait|need\s+to\s+wait)\b[^.!?\n]*[.!?]?
          | we\s+(?:need|have)\s+to\s+wait\b[^.!?\n]*[.!?]?
          | we\s+have\s+no\s+result(?:s)?(?:\s+yet|\s+returned)?\b[^.!?\n]*[.!?]?
          | (?:no|the)\s+result(?:s)?\s+(?:yet|pending|so\s+far)\b[^.!?\n]*[.!?]?
          | (?:i'?m|i\s+am|i'?ll|let\s+me)\s+(?:going\s+to\s+|gonna\s+)?
                (?:search|look\s+up|fetch|call\s+the\s+tool|use\s+the\s+tool)\b[^.!?\n]*[.!?]?
          | calling\s+(?:the\s+)?(?:tool|web[_\s-]?search|fetch[_\s-]?url|wikipedia)\b[^.!?\n]*[.!?]?
          | (?:the\s+)?(?:tool|web[_\s-]?search|response)\s+is\s+(?:pending|loading|running)\b[^.!?\n]*[.!?]?
          | sure\s+thing\b[\s,.!?]*
              (?=(?:[A-Z]|i\b))     # only strip leading filler if followed by real answer
          | based\s+on\s+(?:the\s+)?(?:search|tool)\s+results?\b[^.!?\n]*[,.!?]?
        )\s*""",
        re.IGNORECASE | re.VERBOSE,
    )

    @classmethod
    def _looks_partial_tool_leak(cls, partial: str) -> bool:
        """Heuristic for unterminated JSON. If the prefix matches a
        recognized tool-call key, treat it as a leak."""
        head = partial.lstrip("{").lstrip().lstrip('"')
        for indicator in cls._TOOL_LEAK_INDICATORS:
            for key in indicator:
                if head.startswith(key + '"') or head.startswith(key):
                    return True
        return False


class NarrationPrefixScrubber:
    """Strip tool-call-narration sentences from the start of an LLM stream.

    The JSON leak filter handles structured tool-call leakage; this
    handles the OTHER half — plain-prose narration like ``"we need to
    wait for web_search to return"`` that some models emit before the
    actual answer. The narration only ever appears at the very start
    of a response, so once we've flushed real content we flip to
    pass-through and stop inspecting.

    Stateful: buffers up to ``MAX_BUFFER_CHARS`` of opening text or
    until a sentence boundary, whichever comes first. On flush, runs
    the buffer against the narration regex repeatedly to drop one or
    more leading narration sentences, then emits whatever real prose
    remains. Subsequent ``feed()`` calls bypass the buffer entirely.
    """

    MAX_BUFFER_CHARS = 240   # ~3 short sentences — generous safety margin

    def __init__(self) -> None:
        self._buffer = ""
        self._passthrough = False

    def feed(self, delta: str) -> str:
        if self._passthrough:
            return delta
        if not delta:
            return ""
        self._buffer += delta
        # Always try to strip narration sentences from the front of the
        # buffer. We only emit (and flip to passthrough) once a sentence
        # SURVIVES the strip — i.e. real content has arrived. If the
        # buffer keeps matching narration we keep eating it and stay
        # buffered until a real sentence comes.
        return self._try_emit(final=False)

    def flush(self) -> str:
        if self._passthrough:
            return ""
        # Drain whatever's left, even if it has no sentence terminator.
        return self._try_emit(final=True)

    def _try_emit(self, *, final: bool) -> str:
        # Eat any leading narration sentences (the model often stacks
        # several: "We'll wait. No result yet. Calling the tool.").
        for _ in range(6):
            m = JsonLeakFilter._NARRATION_SENTENCE.match(self._buffer)
            if not m or m.end() == 0:
                break
            self._buffer = self._buffer[m.end():]
        if not self._buffer:
            return ""
        # If we don't have a sentence boundary yet AND haven't blown
        # the buffer cap AND we're not at end-of-stream, hold the
        # remaining text — the next delta may complete a sentence
        # that's actually narration.
        has_boundary = bool(re.search(r"[.!?\n]", self._buffer))
        if not final and not has_boundary and len(self._buffer) < self.MAX_BUFFER_CHARS:
            return ""
        out = self._buffer
        self._buffer = ""
        self._passthrough = True
        return out


def sanitize_for_tts(text: str) -> str:
    """Strip markdown decorations and inline URLs before sending text to
    the TTS engine. The frontend chat bubbles still receive the original
    tokens (and render markdown there), but the speech path gets clean
    prose so the bot doesn't say "asterisk asterisk Vocence asterisk
    asterisk" or read out a 60-character URL.
    """
    if not text:
        return text
    s = text
    s = _MD_FENCED_CODE.sub("", s)
    s = _MD_LINK.sub(r"\1", s)            # [label](url) → label
    s = _MD_INLINE_CODE.sub(r"\1", s)     # `code` → code
    s = _MD_BOLD_STAR.sub(r"\1", s)
    s = _MD_BOLD_UND.sub(r"\1", s)
    s = _MD_ITALIC_STAR.sub(r"\1", s)
    s = _MD_ITALIC_UND.sub(r"\1", s)
    s = _MD_STRIKE.sub(r"\1", s)
    s = _MD_HEADING.sub("", s)
    s = _MD_HRULE.sub("", s)
    s = _MD_BULLET.sub("", s)
    s = _MD_ORDERED.sub("", s)
    s = _BARE_URL.sub("", s)              # don't read raw URLs out loud
    s = _WS_COLLAPSE.sub(" ", s)
    return s.strip()


# ---------------------------------------------------------------------------
# Qwen3 TTS WS client
# ---------------------------------------------------------------------------


@dataclass
class TtsChunk:
    """Either a binary PCM frame or an end-of-sentence marker."""
    kind: str  # "meta" | "audio" | "end" | "error"
    payload: dict | bytes | None = None


class TtsWsWarmer:
    """Pre-opens TTS WebSocket connections so chunks 2..N skip the
    TCP + WS-upgrade handshake.

    The TTS protocol is one-shot per WS (start → audio → end → close), so
    we can't reuse a WS for multiple sentences. Instead, while chunk N is
    streaming audio, we open the WS for chunk N+1 in the background; when
    chunk N+1's text is ready to send, the connection is already there.

    Lifecycle: one warmer per voice-chat turn. The router instantiates it
    knowing which TTS service URL it'll hit (clone vs qwen3), passes it
    into ``stream_tts_for_voice``, and calls ``close()`` on cleanup.

    Saves ~30-80ms per chunk after the first (TCP handshake + HTTP
    Upgrade RTT). On a 4-chunk reply that compounds to ~90-240ms of
    inter-chunk dead time eliminated.
    """

    def __init__(self, ws_url: str, headers: dict, timeout_sec: float) -> None:
        self._ws_url = ws_url
        self._headers = headers
        self._timeout_sec = timeout_sec
        self._warm_session: aiohttp.ClientSession | None = None
        self._warm_ws: aiohttp.ClientWebSocketResponse | None = None
        self._prewarm_task: asyncio.Task | None = None
        self._closed = False

    async def acquire(self) -> tuple[aiohttp.ClientSession, aiohttp.ClientWebSocketResponse]:
        """Return an open (session, ws) — the pre-warmed one if ready,
        else open a fresh one synchronously. Caller owns both and must
        close them when done."""
        # If a prewarm is in flight, wait briefly for it. Capping at
        # 500ms guarantees we don't pay MORE than a normal open if
        # prewarm is slow — we just open synchronously instead.
        if self._prewarm_task is not None and not self._prewarm_task.done():
            try:
                await asyncio.wait_for(asyncio.shield(self._prewarm_task), timeout=0.5)
            except (asyncio.TimeoutError, Exception):
                pass

        if self._warm_ws is not None and not self._warm_ws.closed and self._warm_session is not None:
            session, ws = self._warm_session, self._warm_ws
            self._warm_session = None
            self._warm_ws = None
            return session, ws

        # No warm WS available — open one now.
        timeout = aiohttp.ClientTimeout(total=self._timeout_sec)
        session = aiohttp.ClientSession(timeout=timeout)
        try:
            ws = await session.ws_connect(self._ws_url, headers=self._headers, heartbeat=20)
            return session, ws
        except Exception:
            try:
                await session.close()
            except Exception:
                pass
            raise

    def schedule_prewarm(self) -> None:
        """Open the next WS in the background. Safe to call multiple
        times — only one prewarm runs at a time."""
        if self._closed:
            return
        if self._warm_ws is not None and not self._warm_ws.closed:
            return
        if self._prewarm_task is not None and not self._prewarm_task.done():
            return
        self._prewarm_task = asyncio.create_task(self._prewarm())

    async def _prewarm(self) -> None:
        if self._closed:
            return
        timeout = aiohttp.ClientTimeout(total=self._timeout_sec)
        session = aiohttp.ClientSession(timeout=timeout)
        try:
            ws = await session.ws_connect(self._ws_url, headers=self._headers, heartbeat=20)
        except Exception as exc:
            _log.debug("tts prewarm failed (%s) — fresh open will happen on next chunk", exc)
            try:
                await session.close()
            except Exception:
                pass
            return
        # Race with close(): if the warmer was closed while we were
        # opening, throw the connection away rather than leaking it.
        if self._closed:
            try:
                await asyncio.wait_for(ws.close(code=1000), timeout=0.3)
            except Exception:
                pass
            try:
                await session.close()
            except Exception:
                pass
            return
        self._warm_session = session
        self._warm_ws = ws

    async def close(self) -> None:
        """Tear down the warmer and any pre-opened connection."""
        self._closed = True
        if self._prewarm_task is not None and not self._prewarm_task.done():
            self._prewarm_task.cancel()
            try:
                await self._prewarm_task
            except (asyncio.CancelledError, Exception):
                pass
        if self._warm_ws is not None and not self._warm_ws.closed:
            try:
                await asyncio.wait_for(self._warm_ws.close(code=1000), timeout=0.3)
            except (asyncio.TimeoutError, Exception):
                pass
        if self._warm_session is not None:
            try:
                await asyncio.wait_for(self._warm_session.close(), timeout=0.5)
            except (asyncio.TimeoutError, Exception):
                pass
        self._warm_ws = None
        self._warm_session = None


# ---------------------------------------------------------------------------
# Voice-cloned TTS streaming (for agents with a sample voice id)
# ---------------------------------------------------------------------------


# Output rate the frontend audio player expects. Cloned WAV may come back at
# any rate (typically 22050 or 24000); we resample to this.
TARGET_SAMPLE_RATE = 24000
TARGET_FRAME_MS = 40


def _parse_wav_to_pcm16_mono(wav_bytes: bytes) -> tuple[int, bytes]:
    """Return (sample_rate, pcm16_le_mono_bytes) from a WAV blob."""
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        sr = w.getframerate()
        nch = w.getnchannels()
        sw = w.getsampwidth()
        frames = w.readframes(w.getnframes())
    if sw != 2:
        # Convert to int16 if needed (rare — clone returns 16-bit PCM)
        arr = np.frombuffer(frames, dtype=np.int8 if sw == 1 else np.int32)
        if sw == 1:
            arr = (arr.astype(np.int16) - 128) * 256
        else:
            arr = (arr // (1 << (8 * (sw - 2)))).astype(np.int16)
        frames = arr.tobytes()
    if nch > 1:
        # Downmix to mono
        i16 = np.frombuffer(frames, dtype=np.int16).reshape(-1, nch)
        mono = i16.mean(axis=1).astype(np.int16)
        frames = mono.tobytes()
    return sr, frames


def _resample_pcm16(pcm: bytes, src_rate: int, dst_rate: int) -> bytes:
    if src_rate == dst_rate or not pcm:
        return pcm
    src = np.frombuffer(pcm, dtype=np.int16)
    duration = len(src) / src_rate
    n_dst = int(round(duration * dst_rate))
    if n_dst <= 0:
        return b""
    src_idx = np.linspace(0, len(src) - 1, n_dst)
    dst = np.interp(src_idx, np.arange(len(src)), src.astype(np.float32)).astype(np.int16)
    return dst.tobytes()


def _chunk_to_frames(pcm: bytes, frame_bytes: int) -> list[bytes]:
    """Split PCM bytes into fixed-size frames. The trailing remainder is
    zero-padded to the same frame size (silence) so the player doesn't
    glitch on non-multiple lengths."""
    out: list[bytes] = []
    for i in range(0, len(pcm), frame_bytes):
        chunk = pcm[i : i + frame_bytes]
        if len(chunk) < frame_bytes:
            chunk = chunk + b"\x00" * (frame_bytes - len(chunk))
        out.append(chunk)
    return out


# Languages the qwen3-clone-streaming service accepts (per its README).
# Anything outside this set is sent through as-is — the service decides.
_CLONE_LANGUAGES = {
    "Auto", "English", "Chinese", "Japanese", "Korean", "Spanish", "French",
    "German", "Portuguese", "Italian", "Russian", "Arabic",
}


# Hashes the backend believes the TTS server currently has cached. Lets chunks
# 2..N of a reply (same voice) send a 32-byte sha256 instead of the full ~540 KB
# base64 ref_audio. The new qwen3-tts-streaming server honors this via
# `ref_audio_sha256`. On `ref_not_cached` (e.g. server LRU evicted, or the
# server restarted) we discard the entry and retry once with the full bytes.
_REF_HASH_SEEN: set[str] = set()


class _RefNotCachedRetry(Exception):
    """Sentinel raised by the attempt helper when the server reports
    ref_not_cached and the call was hash-only. Triggers a single retry with
    the full ref bytes."""


def _clone_ws_url_and_headers(pod_url: str | None = None, pod_api_key: str | None = None) -> tuple[str, dict]:
    """Return (ws_url, headers) for voice-clone streaming.

    The qwen3-tts-streaming server exposes ``/v1/voice-clone/stream``
    for ref-audio clone requests (separate from ``/v1/tts/stream`` for
    built-in speaker names). Both live on the same server / ops service
    (``tts_streaming``).

    When ``pod_url``/``pod_api_key`` are provided (dispatcher path), build
    from those. Otherwise fall back to QWEN3_CLONE_BASE_URL + QWEN3_CLONE_API_KEY."""
    base = (pod_url or QWEN3_CLONE_BASE_URL).rstrip("/")
    ws_url = (
        base.replace("http://", "ws://").replace("https://", "wss://")
        + "/v1/voice-clone/stream"
    )
    key = pod_api_key if pod_api_key is not None else QWEN3_CLONE_API_KEY
    headers: dict = {}
    if key:
        headers["Authorization"] = f"Bearer {key}"
    return ws_url, headers


async def _stream_clone_via_service(
    text: str,
    ref_audio_bytes: bytes,
    ref_text: str,
    language: str | None,
    *,
    warmer: TtsWsWarmer | None = None,
) -> AsyncIterator[TtsChunk]:
    """Open WS to the qwen3-tts-streaming server and forward meta/binary/end
    frames as TtsChunks. Wire format follows
    ``dashboard-backend/docs/tts_server_spec.md`` (auth via Authorization
    header, JSON ``start`` frame, binary PCM16LE @ 24 kHz, terminal ``end``
    or ``error`` JSON).

    Ref-audio dedup: chunks 2..N of a reply send only ``ref_audio_sha256``
    (32 bytes) instead of the full ~540 KB base64 payload. If the server
    LRU-evicted (or restarted), it returns ``error{ref_not_cached}`` and we
    retry once with the full bytes, repopulating the cache.

    Transport errors raise — the caller falls back to direct synthesis.
    Protocol errors (auth, bad_request, server_busy, engine_failed) are
    yielded as TtsChunk(kind='error') with the service's code preserved
    so the voicechat router can surface a useful message.

    When a ``warmer`` is provided, we use its pre-opened WS if available
    (saving the handshake) and schedule a background prewarm of the next
    WS as soon as our first audio frame arrives.
    """
    hash_hex = hashlib.sha256(ref_audio_bytes).hexdigest()

    # Dispatcher: pick a tts_streaming pod from the ops gpu_pool if any
    # are registered. Falls back to the static QWEN3_TTS_BASE_URL env
    # when no pods exist (single-server setups still work).
    pod_cm = None
    pod_url: str | None = None
    pod_api_key: str | None = None
    try:
        from ops import pool as gpu_pool
        if gpu_pool.online_pod_count("tts_streaming") > 0:
            pod_cm = gpu_pool.pick_pod("tts_streaming")
            pod = await pod_cm.__aenter__()
            pod_url = pod.url
            pod_api_key = pod.api_key or None
    except Exception:
        pod_cm = None

    try:
        # Build a hash-only `start` payload first if we believe the server has
        # the voice cached. The warmer pre-opens a WS that we want to use, so
        # the hash-only path applies whether or not we have a warmer.
        if hash_hex in _REF_HASH_SEEN:
            try:
                async for chunk in _clone_attempt(
                    text=text,
                    ref_audio_bytes=None,   # send hash-only
                    ref_hash=hash_hex,
                    ref_text=ref_text,
                    language=language,
                    warmer=warmer,
                    pod_url=pod_url,
                    pod_api_key=pod_api_key,
                ):
                    yield chunk
                return
            except _RefNotCachedRetry:
                # Server doesn't have the cache entry we thought it did
                # (LRU evicted, server restarted, etc.). Drop our belief and
                # fall through to a fresh attempt with the full bytes. The
                # warmer's pre-opened WS was consumed by the failed attempt;
                # the retry opens a new one.
                _REF_HASH_SEEN.discard(hash_hex)
                _log.info("clone service: ref_not_cached for %s — retrying with full bytes", hash_hex[:12])
                warmer = None

        async for chunk in _clone_attempt(
            text=text,
            ref_audio_bytes=ref_audio_bytes,  # send full bytes + hash
            ref_hash=hash_hex,
            ref_text=ref_text,
            language=language,
            warmer=warmer,
            pod_url=pod_url,
            pod_api_key=pod_api_key,
        ):
            yield chunk
    finally:
        # Release the dispatcher slot regardless of how the generator exited
        # (normal end, error chunk, client barge-in, or exception).
        if pod_cm is not None:
            try:
                await pod_cm.__aexit__(None, None, None)
            except Exception:
                pass
    # If we got here without raising or yielding an error chunk, the
    # server now has this voice cached. (We add eagerly — even if the WS
    # ended early via cancel, the server cache was populated by the
    # `start` frame before any audio came out.)
    _REF_HASH_SEEN.add(hash_hex)


async def _clone_attempt(
    *,
    text: str,
    ref_audio_bytes: bytes | None,
    ref_hash: str,
    ref_text: str,
    language: str | None,
    warmer: TtsWsWarmer | None,
    pod_url: str | None = None,
    pod_api_key: str | None = None,
) -> AsyncIterator[TtsChunk]:
    """Single WS round-trip to the clone server. Raises _RefNotCachedRetry
    when the server reports ref_not_cached AND ref_audio_bytes was None
    (hash-only mode) — the outer caller catches and retries with full bytes.

    ``pod_url``/``pod_api_key`` override the static QWEN3_CLONE_BASE_URL
    when provided (dispatcher path). When None, falls back to env config."""
    ws_url, headers = _clone_ws_url_and_headers(pod_url=pod_url, pod_api_key=pod_api_key)

    start: dict = {
        "type": "start",
        "text": text,
        "ref_text": ref_text,
        "ref_audio_sha256": ref_hash,
    }
    if ref_audio_bytes is not None:
        start["ref_audio_b64"] = base64.b64encode(ref_audio_bytes).decode("ascii")
    lang = (language or "").strip()
    if lang:
        if lang not in _CLONE_LANGUAGES:
            _log.debug("clone service: unrecognised language %r — passing through", lang)
        start["language"] = lang

    # CANCEL SAFETY: when a barge-in cancels the turn, this generator is
    # closed mid-stream. We MUST tear down the WS promptly or the upstream
    # server keeps the GPU slot busy and the next turn's WS hangs. Two pieces:
    #   1. Explicit acquire/release instead of `async with session.ws_connect`
    #      (the latter's default close timeout is 10s — far too long for
    #      barge-in).
    #   2. The finally block closes the WS with a TIGHT 300 ms cap. If the
    #      server doesn't ACK in time, we move on and let TCP close handle
    #      the rest.
    if warmer is not None:
        session, ws = await warmer.acquire()
    else:
        timeout = aiohttp.ClientTimeout(total=QWEN3_CLONE_TIMEOUT_SEC)
        session = aiohttp.ClientSession(timeout=timeout)
        try:
            ws = await session.ws_connect(ws_url, headers=headers, heartbeat=20)
        except Exception:
            try:
                await session.close()
            except Exception:
                pass
            raise

    first_audio_seen = False
    try:
        await ws.send_str(json.dumps(start))
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    obj = json.loads(msg.data)
                except Exception:
                    continue
                mtype = obj.get("type")
                if mtype == "meta":
                    yield TtsChunk(kind="meta", payload=obj)
                elif mtype == "end":
                    yield TtsChunk(kind="end", payload=obj)
                    return
                elif mtype == "error":
                    code = obj.get("code") or "unknown"
                    m = (obj.get("message") or "")[:200]
                    # `ref_not_cached` is only retryable when we sent hash-only.
                    # If the client already included full bytes, retrying won't
                    # help — surface the error as-is.
                    if code == "ref_not_cached" and ref_audio_bytes is None:
                        raise _RefNotCachedRetry()
                    _log.warning("clone service error code=%s message=%s", code, m)
                    yield TtsChunk(kind="error", payload=obj)
                    return
            elif msg.type == aiohttp.WSMsgType.BINARY:
                if not first_audio_seen and warmer is not None:
                    # Kick off the next chunk's WS now — synthesis usually runs
                    # another 100-500 ms before `end`, plenty of time to open
                    # the next connection in the background.
                    first_audio_seen = True
                    warmer.schedule_prewarm()
                yield TtsChunk(kind="audio", payload=msg.data)
            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                return
    finally:
        if ws is not None and not ws.closed:
            try:
                await asyncio.wait_for(ws.close(code=1000), timeout=0.3)
            except (asyncio.TimeoutError, Exception):
                pass
        try:
            await asyncio.wait_for(session.close(), timeout=0.5)
        except (asyncio.TimeoutError, Exception):
            pass


async def _stream_clone_direct(
    text: str,
    ref_audio_bytes: bytes,
    ref_text: str,
) -> AsyncIterator[TtsChunk]:
    """Fallback: one-shot voice_clone_synthesize, then frame the WAV out."""
    wav_bytes, err = await voice_clone_synthesize(
        reference_audio_bytes=ref_audio_bytes,
        reference_text=ref_text,
        target_text=text,
    )
    if not wav_bytes:
        yield TtsChunk(kind="error", payload={"message": err or "voice clone failed"})
        return
    src_rate, pcm = _parse_wav_to_pcm16_mono(wav_bytes)
    if src_rate != TARGET_SAMPLE_RATE:
        pcm = _resample_pcm16(pcm, src_rate, TARGET_SAMPLE_RATE)
    yield TtsChunk(
        kind="meta",
        payload={
            "sample_rate": TARGET_SAMPLE_RATE,
            "frame_ms": TARGET_FRAME_MS,
            "encoding": "pcm16le",
            "channels": 1,
        },
    )
    frame_samples = TARGET_SAMPLE_RATE * TARGET_FRAME_MS // 1000
    frame_bytes = frame_samples * 2
    for frame in _chunk_to_frames(pcm, frame_bytes):
        yield TtsChunk(kind="audio", payload=frame)
    yield TtsChunk(
        kind="end",
        payload={"duration_ms": int(len(pcm) / 2 / TARGET_SAMPLE_RATE * 1000)},
    )


async def _stream_clone_with_refs(
    text: str,
    ref_audio: bytes,
    ref_text: str,
    language: str | None = None,
    *,
    warmer: TtsWsWarmer | None = None,
) -> AsyncIterator[TtsChunk]:
    """Clone-based TTS given raw reference audio bytes + transcript.
    Uses the ``/v1/voice-clone/stream`` endpoint on the tts_streaming
    server; falls back to direct one-shot synth on transport error."""
    has_streaming = bool(QWEN3_CLONE_BASE_URL)
    if not has_streaming:
        try:
            from ops import pool as gpu_pool
            has_streaming = gpu_pool.online_pod_count("tts_streaming") > 0
        except Exception:
            pass
    if has_streaming:
        try:
            async for chunk in _stream_clone_via_service(text, ref_audio, ref_text, language, warmer=warmer):
                yield chunk
            return
        except Exception as exc:  # noqa: BLE001
            _log.warning("clone service failed (%s); falling back to direct synthesis", exc)
    async for chunk in _stream_clone_direct(text, ref_audio, ref_text):
        yield chunk


async def stream_voice_clone_tts(
    text: str,
    sample_voice_id: str,
    *,
    language: str | None = None,
    warmer: TtsWsWarmer | None = None,
) -> AsyncIterator[TtsChunk]:
    """Voice-cloned TTS for one sample-voice id. Yields the same TtsChunk
    shape as ``stream_qwen3_tts`` so the voicechat router can switch
    between paths."""
    ref_audio, ref_text = await load_sample_voice(sample_voice_id, language=language)
    async for chunk in _stream_clone_with_refs(text, ref_audio, ref_text, language, warmer=warmer):
        yield chunk


# ---------------------------------------------------------------------------
# Designed-voice (My Voices) resolver — user-created voices saved via the
# Voice Design A/B preview flow live in studio_user_designed_voices.
# We address them by ``dv:<id>`` in the voice config so they're easy to
# distinguish from sample voices and from raw Qwen3 speaker names.
# ---------------------------------------------------------------------------


# Per-process cache of (audio_bytes, ref_text) keyed by designed-voice DB id.
# Designed-voice rows are immutable once saved (the user can only delete
# them), so caching is safe for the lifetime of a backend process.
_DESIGNED_VOICE_CACHE: dict[int, tuple[bytes, str]] = {}
_DESIGNED_VOICE_LOCK = asyncio.Lock()


def parse_designed_voice_id(voice: str | None) -> int | None:
    """Return the integer voice id if ``voice`` is in ``dv:<int>`` form,
    otherwise None. Used as the cheap dispatch check at the top of
    ``stream_tts_for_voice``."""
    if not voice or not voice.startswith("dv:"):
        return None
    try:
        return int(voice.split(":", 1)[1])
    except (ValueError, IndexError):
        return None


async def _resolve_designed_voice(user_id: str, voice_id: int) -> tuple[bytes, str]:
    """Fetch (ref_audio_bytes, ref_text) for a user-owned designed voice.
    Raises on missing / expired / IO failure."""
    cached = _DESIGNED_VOICE_CACHE.get(voice_id)
    if cached:
        return cached

    # Local imports — these modules pull in studio-side dependencies that
    # we don't want loaded at voicechat_service import time.
    from datetime import datetime, timezone
    from local_db import get_connection
    from studio_tts_service import download_object_bytes

    async with _DESIGNED_VOICE_LOCK:
        cached = _DESIGNED_VOICE_CACHE.get(voice_id)
        if cached:
            return cached
        conn = await get_connection()
        try:
            cursor = await conn.execute(
                """
                SELECT ref_script, audio_s3_bucket, audio_s3_key, expires_at
                FROM studio_user_designed_voices
                WHERE id = ? AND user_id = ?
                """,
                (voice_id, user_id),
            )
            row = await cursor.fetchone()
        finally:
            await conn.close()

        if row is None:
            raise RuntimeError(f"designed voice {voice_id} not found for user")
        ref_script = (row["ref_script"] or "").strip()
        if not ref_script:
            raise RuntimeError(f"designed voice {voice_id} has empty ref_script")

        # Honor reference-audio expiry exactly like designed_voice_speak does.
        expires_at_raw = row["expires_at"]
        if expires_at_raw:
            try:
                exp = datetime.fromisoformat(str(expires_at_raw).replace("Z", "+00:00"))
                if exp <= datetime.now(timezone.utc):
                    raise RuntimeError(
                        f"designed voice {voice_id}: reference audio has expired"
                    )
            except ValueError:
                pass

        bucket = row["audio_s3_bucket"]
        key = row["audio_s3_key"]
        if not bucket or not key:
            raise RuntimeError(f"designed voice {voice_id} has no stored audio")
        audio_bytes = download_object_bytes(bucket, key)
        if not audio_bytes:
            raise RuntimeError(f"could not download ref audio for voice {voice_id}")

        _DESIGNED_VOICE_CACHE[voice_id] = (audio_bytes, ref_script)
        return audio_bytes, ref_script


async def stream_designed_voice_tts(
    text: str,
    voice_id: int,
    *,
    user_id: str,
    language: str | None = None,
    warmer: TtsWsWarmer | None = None,
) -> AsyncIterator[TtsChunk]:
    """Voice-cloned TTS using a user's saved 'My Voice'. ``user_id`` is
    required so we don't leak voices across users."""
    ref_audio, ref_text = await _resolve_designed_voice(user_id, voice_id)
    async for chunk in _stream_clone_with_refs(text, ref_audio, ref_text, language, warmer=warmer):
        yield chunk


def voice_uses_clone_service(voice: str | None) -> bool:
    """Whether a voice value will route to the cloned-voice service
    (qwen3-clone-streaming) vs the qwen3 built-in TTS. Used by the
    router so it can spin up the right kind of TtsWsWarmer before any
    chunk is dispatched."""
    return parse_designed_voice_id(voice) is not None or is_sample_voice(voice)


# Kill-switch for the TTS pre-warmer. Default ON (=1) so the latency
# optimisation stays active. Set to 0 to disable when diagnosing audio-
# quality regressions — with the warmer off, every chunk opens a fresh
# WS, which is slower but matches the pre-warmer-era behaviour exactly.
TTS_PREWARM_ENABLED = (os.environ.get("TTS_PREWARM_ENABLED") or "1").strip() not in (
    "0", "false", "no", "",
)


def make_tts_warmer_for_voice(voice: str | None) -> TtsWsWarmer | None:
    """Build a TtsWsWarmer for pre-opening WS connections.

    Only works with a single known endpoint (static env var). With
    multiple ops pods the dispatcher picks dynamically per chunk, so
    pre-warming a specific pod would cause ref-audio cache misses on
    the other — skip the warmer and let each chunk connect fresh."""
    if not TTS_PREWARM_ENABLED:
        return None
    # Multiple ops pods → no warmer (dispatcher picks per-chunk)
    try:
        from ops import pool as gpu_pool
        if gpu_pool.online_pod_count("tts_streaming") > 1:
            return None
        if gpu_pool.online_pod_count("tts_streaming") == 1:
            from ops.pool import _routable_pods
            p = _routable_pods("tts_streaming")[0]
            base = p.url
            key = p.api_key or None
            endpoint = "/v1/voice-clone/stream" if voice_uses_clone_service(voice) else "/v1/tts/stream"
            ws_url = base.replace("http://", "ws://").replace("https://", "wss://") + endpoint
            headers: dict = {}
            if key:
                headers["Authorization"] = f"Bearer {key}"
            return TtsWsWarmer(ws_url, headers, QWEN3_CLONE_TIMEOUT_SEC)
    except Exception:
        pass
    # No ops pods — fall back to static env vars
    if voice_uses_clone_service(voice):
        if not QWEN3_CLONE_BASE_URL:
            return None
        ws_url, headers = _clone_ws_url_and_headers()
        return TtsWsWarmer(ws_url, headers, QWEN3_CLONE_TIMEOUT_SEC)
    if QWEN3_TTS_BASE_URL:
        ws_url, headers = _qwen3_tts_ws_url_and_headers()
        return TtsWsWarmer(ws_url, headers, QWEN3_TTS_TIMEOUT_SEC)
    return None


async def stream_tts_for_voice(
    text: str,
    voice: str | None,
    *,
    language: str | None = None,
    user_id: str | None = None,
    warmer: TtsWsWarmer | None = None,
) -> AsyncIterator[TtsChunk]:
    """Pick the right TTS backend for ``voice``:
       • ``dv:<id>``     → user-owned designed voice (My Voices)
       • sample voice id → cloned synthesis with a pre-cached reference
       • anything else   → Qwen3-TTS speaker name (legacy/default)

    ``user_id`` is required for the dv:<id> path so a user can only
    address their own saved voices.

    ``warmer`` (optional) provides pre-opened WS connections so chunks
    2..N skip the handshake. The router should build one with
    ``make_tts_warmer_for_voice()`` at turn start and close it at
    turn end.
    """
    dv_id = parse_designed_voice_id(voice)
    if dv_id is not None:
        if not user_id:
            _log.warning("dv:%d voice requested without user_id — falling back to default", dv_id)
            async for chunk in stream_qwen3_tts(text, voice=None, warmer=warmer):
                yield chunk
            return
        try:
            async for chunk in stream_designed_voice_tts(text, dv_id, user_id=user_id, language=language, warmer=warmer):
                yield chunk
            return
        except Exception as exc:  # noqa: BLE001
            _log.warning("designed voice dv:%d failed (%s); falling back to default voice", dv_id, exc)
            # Default fallback uses qwen3, not clone — warmer is wrong
            # shape, so don't pass it. Worst case: chunk pays a fresh
            # handshake on the fallback.
            async for chunk in stream_qwen3_tts(text, voice=None):
                yield chunk
            return

    if is_sample_voice(voice):
        async for chunk in stream_voice_clone_tts(text, voice or "", language=language, warmer=warmer):
            yield chunk
    else:
        async for chunk in stream_qwen3_tts(text, voice=voice, warmer=warmer):
            yield chunk


def _qwen3_tts_ws_url_and_headers() -> tuple[str, dict]:
    """Return (ws_url, headers) for the qwen3 built-in TTS service."""
    if not QWEN3_TTS_BASE_URL:
        raise RuntimeError("QWEN3_TTS_BASE_URL not configured")
    ws_url = QWEN3_TTS_BASE_URL.replace("http://", "ws://").replace("https://", "wss://") + "/v1/tts/stream"
    headers: dict = {}
    if QWEN3_TTS_API_KEY:
        headers["Authorization"] = f"Bearer {QWEN3_TTS_API_KEY}"
    return ws_url, headers


async def stream_qwen3_tts(
    text: str,
    voice: str | None = None,
    *,
    warmer: TtsWsWarmer | None = None,
) -> AsyncIterator[TtsChunk]:
    """Open a WS to qwen3_streaming, yield meta + binary frames + end.

    When ``warmer`` is provided, use its pre-opened WS if ready and kick
    off the next chunk's prewarm on first audio — same pattern as the
    clone path.

    Pod selection: if a ``tts_streaming`` pod is registered via the
    ops dispatcher we ALWAYS go through it (via ``pick_pod`` context
    manager) so the per-pod in-flight counter ticks and the Ops admin
    graph shows real traffic during agent speech. Without this the
    default Qwen3-voice path bypassed the dispatcher entirely —
    connections went straight to ``QWEN3_TTS_BASE_URL`` and the pod's
    in-flight stayed at 0 even during sustained speech. Fall back to
    the env-var URL only when no pods are registered (single-server
    dev setups)."""
    # Acquire a dispatcher slot when possible. The slot is held for
    # the full WS lifetime so in_flight reflects active synthesis.
    pod_cm = None
    pod_url_override: str | None = None
    pod_api_key_override: str | None = None
    try:
        from ops import pool as _gpu_pool
        if _gpu_pool.online_pod_count("tts_streaming") > 0:
            pod_cm = _gpu_pool.pick_pod("tts_streaming")
            pod = await pod_cm.__aenter__()
            pod_url_override = pod.url
            pod_api_key_override = pod.api_key or None
    except Exception:
        pod_cm = None

    if pod_url_override:
        ws_url = pod_url_override.replace("http://", "ws://").replace("https://", "wss://") + "/v1/tts/stream"
        headers: dict = {}
        if pod_api_key_override:
            headers["Authorization"] = f"Bearer {pod_api_key_override}"
            headers["X-API-Key"] = pod_api_key_override
    else:
        ws_url, headers = _qwen3_tts_ws_url_and_headers()

    # Same cancel-safety treatment as _stream_clone_via_service: explicit
    # WS acquire + bounded close so a barge-in mid-synthesis doesn't sit
    # waiting for the upstream server's CLOSE ACK (default 10s).
    if warmer is not None:
        session, ws = await warmer.acquire()
    else:
        timeout = aiohttp.ClientTimeout(total=QWEN3_TTS_TIMEOUT_SEC)
        session = aiohttp.ClientSession(timeout=timeout)
        try:
            ws = await session.ws_connect(ws_url, headers=headers, heartbeat=20)
        except Exception:
            try:
                await session.close()
            except Exception:
                pass
            if pod_cm is not None:
                try:
                    await pod_cm.__aexit__(None, None, None)
                except Exception:
                    pass
            raise

    first_audio_seen = False
    try:
        await ws.send_str(json.dumps({
            "type": "start",
            "text": text,
            "voice": voice or QWEN3_TTS_VOICE,
        }))
        async for msg in ws:
            if msg.type == aiohttp.WSMsgType.TEXT:
                try:
                    obj = json.loads(msg.data)
                except Exception:
                    continue
                mtype = obj.get("type")
                if mtype == "meta":
                    yield TtsChunk(kind="meta", payload=obj)
                elif mtype == "end":
                    yield TtsChunk(kind="end", payload=obj)
                    return
                elif mtype == "error":
                    yield TtsChunk(kind="error", payload=obj)
                    return
            elif msg.type == aiohttp.WSMsgType.BINARY:
                if not first_audio_seen and warmer is not None:
                    first_audio_seen = True
                    warmer.schedule_prewarm()
                yield TtsChunk(kind="audio", payload=msg.data)
            elif msg.type in (aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                return
    finally:
        if ws is not None and not ws.closed:
            try:
                await asyncio.wait_for(ws.close(code=1000), timeout=0.3)
            except (asyncio.TimeoutError, Exception):
                pass
        try:
            await asyncio.wait_for(session.close(), timeout=0.5)
        except (asyncio.TimeoutError, Exception):
            pass
        # Release the dispatcher slot acquired at the top so the
        # in_flight counter goes back down. Without this every TTS
        # turn would permanently consume one pod slot.
        if pod_cm is not None:
            try:
                await pod_cm.__aexit__(None, None, None)
            except Exception:
                pass
