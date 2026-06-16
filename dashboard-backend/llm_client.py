"""Unified LLM client for the dashboard backend.

Routes every LLM call to one of three providers, picked by the
``LLM_PROVIDER`` env var (``openai`` | ``local`` | ``chutes``).

  1. **OpenAI** — when ``OPENAI_API_KEY`` is set. Standard OpenAI-compatible
     POST {OPENAI_BASE_URL}/chat/completions with ``OPENAI_MODEL``. Fastest
     option for hosted inference; recommended for production voice chat.

  2. **Local Qwen3-4B service** — when ``LOCAL_LLM_BASE_URL`` is set.
     Uses the four-route contract documented in
     /workspace/qwen-8m-streaming-llm/small/README.md:
         POST /v1/no-think          (non-streaming, fast)
         POST /v1/think             (non-streaming, with chain-of-thought)
         POST /v1/stream/no-think   (SSE streaming, fast)
         POST /v1/stream/think      (SSE streaming, with chain-of-thought)

  3. **Chutes hosted LLM** — when ``VOICE_DESIGN_LLM_MODEL`` +
     ``CHUTES_AUTH_KEY`` are set. Uses the OpenAI-compatible
     {VOICE_DESIGN_LLM_BASE_URL}/chat/completions.

Provider selection:

  - ``LLM_PROVIDER=openai|local|chutes`` picks the primary explicitly.
  - When unset, auto-detect priority: **openai > local > chutes**. OpenAI
    is the default primary because it's the fastest hosted option with
    the strongest instruction-following at the small-model tier (gpt-5-mini).
  - Per-call ``model="..."`` override forces the Chutes path (agent
    config uses specific Chutes model ids).

Fallback: when the primary provider errors *before yielding any output*
the client retries against **Chutes** (universal fallback). Set
``LLM_FALLBACK=0`` to disable. Local is never used as a fallback because
its non-OpenAI wire shape differs from the other two.

Public API (provider-agnostic):

    chat_complete(messages, *, temperature, max_tokens, think=None, model=None) -> str
    chat_complete_json(messages, ...) -> dict   (parses JSON from the content)
    stream_chat(messages, ...) -> AsyncIterator[str]   (yields content deltas)
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from typing import AsyncIterator, Optional

import aiohttp

from studio_tts_service import CHUTES_AUTH_KEY, VOICE_DESIGN_LLM_BASE_URL
from llm_logging import record_call as _record_llm_call


_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Local LLM endpoint (Qwen3-4B).
LOCAL_LLM_BASE_URL = (os.environ.get("LOCAL_LLM_BASE_URL") or "").strip().rstrip("/")
LOCAL_LLM_API_KEY = (os.environ.get("LOCAL_LLM_API_KEY") or "").strip()
LOCAL_LLM_TIMEOUT_SEC = float(os.environ.get("LOCAL_LLM_TIMEOUT_SEC") or "120")
# Default to no-think for speed; flip to 1 if you want chain-of-thought everywhere.
_LOCAL_LLM_USE_THINK_DEFAULT = (os.environ.get("LOCAL_LLM_USE_THINK") or "").strip().lower() in (
    "1", "true", "yes", "on",
)

# OpenAI endpoint (or any OpenAI-compatible service like Together,
# Fireworks — just point OPENAI_BASE_URL at their /v1).
OPENAI_API_KEY = (os.environ.get("OPENAI_API_KEY") or "").strip()
OPENAI_BASE_URL = (os.environ.get("OPENAI_BASE_URL") or "https://api.openai.com/v1").strip().rstrip("/")
OPENAI_MODEL = (os.environ.get("OPENAI_MODEL") or "gpt-4.1").strip()

# Groq endpoint — purpose-built for low-latency voice agents. The Groq
# API is OpenAI-compatible (same /chat/completions shape, same tool-call
# JSON), so the streaming/tool plumbing below is shared. We keep Groq
# distinct from OpenAI so per-agent selection can target it explicitly
# via a ``groq:<model>`` prefix in agent.config.llm_model — and so a
# missing GROQ_API_KEY doesn't silently fall back to OpenAI.
GROQ_API_KEY = (os.environ.get("GROQ_API_KEY") or "").strip()
GROQ_BASE_URL = (os.environ.get("GROQ_BASE_URL") or "https://api.groq.com/openai/v1").strip().rstrip("/")
GROQ_MODEL = (os.environ.get("GROQ_MODEL") or "llama-3.3-70b-versatile").strip()

# Cerebras endpoint, primary LLM for voice chat. Same OpenAI-compatible
# wire shape as Groq/OpenAI; we keep it as its own provider so per-agent
# overrides via ``cerebras:<model>`` and the voice-chat fallback ladder
# stay explicit (Cerebras → OpenAI on stream failure).
#
# ``CEREBRAS_API_KEYS`` is a comma-separated list of keys belonging to
# different Cerebras accounts. The rotation picks the next key per call
# (round-robin), cycles through the rest on 429/5xx, and falls back to
# Grok once every key is saturated. Two keys means we tolerate one
# account being rate-limited before Grok ever sees traffic.
CEREBRAS_API_KEYS: list[str] = [
    k.strip() for k in (os.environ.get("CEREBRAS_API_KEYS") or "").split(",") if k.strip()
]
CEREBRAS_BASE_URL = (os.environ.get("CEREBRAS_BASE_URL") or "https://api.cerebras.ai/v1").strip().rstrip("/")
CEREBRAS_MODEL = (os.environ.get("CEREBRAS_MODEL") or "gpt-oss-120b").strip()


# Round-robin counter for picking the next Cerebras key. Increment is
# atomic under asyncio's single-threaded loop (no awaits between read
# and write), so no asyncio.Lock needed. Under multi-worker uvicorn
# each worker keeps its own counter — slight skew on tiny pools (2-3
# keys) but still meaningfully fair compared to random.
_cerebras_key_rr_counter = 0


# Per-key cooldown cache. When a key returns 429 we mark it as
# cooling-off for ``_CEREBRAS_COOLDOWN_SEC`` seconds; the rotation
# loop skips it for that window. Most Cerebras rate limits reset on
# per-minute boundaries, so 30 s sits in the sweet spot: long enough
# to skip several saturated calls, short enough to recover quickly.
# Key is the raw API key string; value is the monotonic-time epoch
# the cooldown expires at. Per-process state (each uvicorn worker has
# its own dict), which is fine — independent skips don't conflict.
_CEREBRAS_COOLDOWN_SEC = float(os.environ.get("CEREBRAS_KEY_COOLDOWN_SEC") or "30")
_cerebras_key_cooldown_until: dict[str, float] = {}


def _is_cerebras_key_cooling(key: str) -> bool:
    """True if this key is currently in its post-429 cooldown window."""
    if not key:
        return False
    expiry = _cerebras_key_cooldown_until.get(key)
    return expiry is not None and time.monotonic() < expiry


def _mark_cerebras_key_cooling(key: str) -> None:
    """Mark a key as rate-limited; the rotation skips it for
    ``_CEREBRAS_COOLDOWN_SEC`` seconds. Caller invokes this when a
    Cerebras attempt errored with a 429-style message."""
    if not key:
        return
    _cerebras_key_cooldown_until[key] = time.monotonic() + _CEREBRAS_COOLDOWN_SEC


def _is_rate_limit_error(exc: BaseException) -> bool:
    """Match the same heuristic the fallback ladder uses to tag
    ``fallback_reason = cerebras_429`` — keeps cooldown triggers + log
    tags in lockstep."""
    msg = str(exc).lower()
    return "429" in msg or "rate limit" in msg or "rate_limit" in msg


def _next_cerebras_key_index() -> int:
    """Advance the round-robin counter and return the next key's index.
    Returns 0 if no keys configured (caller checks ``CEREBRAS_API_KEYS``
    separately before using the index)."""
    global _cerebras_key_rr_counter
    if not CEREBRAS_API_KEYS:
        return 0
    idx = _cerebras_key_rr_counter % len(CEREBRAS_API_KEYS)
    _cerebras_key_rr_counter += 1
    return idx


def _pick_cerebras_key() -> str:
    """Next key in round-robin order. Used by the non-streaming
    ``_cerebras_chat_complete`` and by callers that just need a single
    key (no fallback rotation). For the streaming path with rotation,
    see the loop in ``stream_chat_with_tools`` which uses
    ``_next_cerebras_key_index`` to build the full attempt order."""
    if not CEREBRAS_API_KEYS:
        return ""
    return CEREBRAS_API_KEYS[_next_cerebras_key_index()]

# Voice-chat fallback: if the primary stream (Cerebras) fails before
# emitting any tokens, retry once against xAI's Grok. Only kicks in
# for ``stream_chat_with_tools`` and only when this flag is on, so
# other callers (voice design, summaries, etc.) keep their existing
# behaviour.
VOICECHAT_LLM_FALLBACK_ENABLED = (
    os.environ.get("VOICECHAT_LLM_FALLBACK_ENABLED")
    or os.environ.get("VOICECHAT_LLM_FALLBACK_TO_OPENAI")  # back-compat alias
    or "1"
).strip() not in ("0", "false", "no", "")

# xAI / Grok endpoint — used as the voice-chat fallback when Cerebras
# 429s. OpenAI-compatible wire shape (api.x.ai/v1/chat/completions).
# Grok 3 Mini Fast is non-reasoning, supports tool calls, and TTFT is
# ~150-300ms — fast enough that the user shouldn't notice the swap.
XAI_API_KEY = (os.environ.get("XAI_API_KEY") or "").strip()
XAI_BASE_URL = (os.environ.get("XAI_BASE_URL") or "https://api.x.ai/v1").strip().rstrip("/")
VOICECHAT_GROK_FALLBACK_MODEL = (
    os.environ.get("VOICECHAT_GROK_FALLBACK_MODEL") or "grok-4.20-0309-non-reasoning"
).strip()

# Google Gemini — voice-agent third LLM choice (alongside the two
# Cerebras options). Uses Gemini's OpenAI-compatible endpoint so the
# wire shape, streaming protocol, and tool-call schema are identical
# to the other providers — only the URL, auth header, and the
# ``reasoning_effort="none"`` injection differ.
#
# ``reasoning_effort="none"`` is CRITICAL for voice: Gemini 2.5/3.x
# Flash default to thinking-on, which pushes TTFT from ~0.9 s to 5+ s
# (unusable for a voice agent). With "none" the model skips the
# thinking pass entirely — measured Intelligence Index 43 vs 33 for
# gpt-oss-120b, at sub-second TTFT (per Artificial Analysis P50). The
# injection lives in ``_stream_chat_with_tools_once`` so any model
# routed via ``gemini:`` prefix gets it automatically.
#
# Multi-key rotation parallels the Cerebras setup: ``GOOGLE_API_KEYS``
# (plural, comma-separated) is the primary source. ``GOOGLE_API_KEY``
# (singular) is honoured for back-compat as a single-key shortcut.
GOOGLE_API_KEYS: list[str] = [
    k.strip() for k in (
        os.environ.get("GOOGLE_API_KEYS")
        or os.environ.get("GOOGLE_API_KEY")
        or ""
    ).split(",") if k.strip()
]
GOOGLE_BASE_URL = (
    os.environ.get("GOOGLE_BASE_URL")
    or "https://generativelanguage.googleapis.com/v1beta/openai"
).strip().rstrip("/")
GOOGLE_MODEL = (os.environ.get("GOOGLE_MODEL") or "gemini-3.5-flash").strip()


_google_key_rr_counter = 0
_GOOGLE_COOLDOWN_SEC = float(os.environ.get("GOOGLE_KEY_COOLDOWN_SEC") or "30")
_google_key_cooldown_until: dict[str, float] = {}


def _is_google_key_cooling(key: str) -> bool:
    if not key:
        return False
    expiry = _google_key_cooldown_until.get(key)
    return expiry is not None and time.monotonic() < expiry


def _mark_google_key_cooling(key: str) -> None:
    if not key:
        return
    _google_key_cooldown_until[key] = time.monotonic() + _GOOGLE_COOLDOWN_SEC


def _next_google_key_index() -> int:
    global _google_key_rr_counter
    if not GOOGLE_API_KEYS:
        return 0
    idx = _google_key_rr_counter % len(GOOGLE_API_KEYS)
    _google_key_rr_counter += 1
    return idx


def google_llm_configured() -> bool:
    """True when at least one GOOGLE_API_KEYS entry is set — controls
    whether the Gemini option appears in the agent-settings model
    picker and whether ``gemini:`` prefixed model ids resolve at
    routing time."""
    return bool(GOOGLE_API_KEYS)


def _google_headers(api_key: str | None = None) -> dict:
    """Bearer auth + JSON. The OpenAI-compatible endpoint accepts the
    standard ``Authorization: Bearer <key>`` shape — same code path
    as every other provider, no Google-specific SDK required."""
    key = api_key
    if key is None:
        idx = _next_google_key_index()
        key = GOOGLE_API_KEYS[idx] if GOOGLE_API_KEYS else ""
    return {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }

# Provider selection: explicit override via env, else auto-detect.
# Accepts: "openai" | "local" | "chutes" | "" (auto).
_LLM_PROVIDER_OVERRIDE = (os.environ.get("LLM_PROVIDER") or "").strip().lower()

# When the primary provider fails before yielding any output, automatically
# retry against Chutes. Legacy var name kept for back-compat; the new name
# is LLM_FALLBACK.
LLM_FALLBACK_TO_CHUTES = (
    os.environ.get("LLM_FALLBACK") or os.environ.get("LLM_FALLBACK_TO_CHUTES") or "1"
).strip().lower() in ("1", "true", "yes", "on")

def _split_chutes_models(raw: str) -> list[str]:
    """Parse a comma-separated VOICE_DESIGN_LLM_MODEL list into individual
    model ids, dropping empties."""
    if not raw:
        return []
    return [p.strip() for p in raw.split(",") if p.strip()]


def _first_chutes_model(raw: str) -> str:
    """The env vars allow a comma-separated list of model ids for the
    voice-design fallback chain. Chutes' chat/completions takes a SINGLE
    model id per call, so we just take the first non-empty entry here."""
    parts = _split_chutes_models(raw)
    return parts[0] if parts else ""


_CHUTES_MODELS_RAW = (
    os.environ.get("VOICECHAT_LLM_MODEL")
    or os.environ.get("VOICE_DESIGN_LLM_MODEL")
    or os.environ.get("AGENTS_LLM_MODEL")
    or ""
)

# Default Chutes model (used when local isn't configured, or as the explicit fallback)
DEFAULT_CHUTES_MODEL = _first_chutes_model(_CHUTES_MODELS_RAW)


def all_chutes_models() -> list[str]:
    """Every Chutes model id in the configured fallback list. Used by
    callers that want to retry across models when one returns empty
    content or 5xx (e.g. AI lyric generation, agent draft)."""
    return _split_chutes_models(_CHUTES_MODELS_RAW)


async def chat_complete_with_fallback(
    messages: list[dict],
    *,
    temperature: float = 0.4,
    max_tokens: int = 1500,
    models: list[str] | None = None,
) -> str:
    """Try ``chat_complete`` once per model id in ``models`` (or every
    Chutes model from env if ``models`` is None). Returns the first
    non-empty completion. Raises ``RuntimeError`` only if every model
    in the chain failed or returned empty content.

    This is the right helper for tasks where a specific model's empty
    response or 5xx isn't worth surfacing to the user — try the next
    one instead."""
    candidates = list(models or all_chutes_models())
    if not candidates:
        # No fallback list — fall through to the default routing.
        return await chat_complete(messages, temperature=temperature, max_tokens=max_tokens, retries=1)
    last_err: Exception | None = None
    for m in candidates:
        try:
            out = await chat_complete(
                messages,
                temperature=temperature,
                max_tokens=max_tokens,
                model=m,
                retries=0,  # outer loop is the retry — don't double up
            )
            if out and out.strip():
                return out
            last_err = RuntimeError(f"{m}: empty content")
        except Exception as exc:  # noqa: BLE001
            last_err = exc
            continue
    raise RuntimeError(
        f"all {len(candidates)} Chutes models failed; last error: {last_err}"
    )


def local_llm_configured() -> bool:
    return bool(LOCAL_LLM_BASE_URL)


def chutes_llm_configured() -> bool:
    return bool(DEFAULT_CHUTES_MODEL and CHUTES_AUTH_KEY)


def openai_llm_configured() -> bool:
    return bool(OPENAI_API_KEY and OPENAI_MODEL)


def groq_llm_configured() -> bool:
    return bool(GROQ_API_KEY and GROQ_MODEL)


def cerebras_llm_configured() -> bool:
    return bool(CEREBRAS_API_KEYS and CEREBRAS_MODEL)


def llm_configured() -> bool:
    return (
        local_llm_configured()
        or openai_llm_configured()
        or groq_llm_configured()
        or cerebras_llm_configured()
        or chutes_llm_configured()
    )


# Model-prefix routing. Agent configs use ``groq:<model>`` to force a
# specific provider regardless of the system-wide default. This keeps
# per-agent routing explicit and lets callers mix providers within one
# deployment (Logos on Claude/Chutes, voice agents on Groq for speed).
_PROVIDER_PREFIXES = {"groq:", "openai:", "chutes:", "anthropic:", "cerebras:", "xai:", "grok:", "gemini:", "google:"}


def split_provider_prefix(model: str | None) -> tuple[str | None, str | None]:
    """Parse ``provider:model`` into ``(provider, model)``. Returns
    ``(None, model)`` when no recognised prefix is present so callers
    fall back to default routing. ``anthropic:`` is treated as Chutes
    since Claude on this stack is served via Chutes. ``grok:`` is
    treated as ``xai`` so both spellings route the same way."""
    if not model:
        return None, None
    s = model.strip()
    for pref in _PROVIDER_PREFIXES:
        if s.lower().startswith(pref):
            prov = pref[:-1]
            if prov == "anthropic":
                prov = "chutes"
            elif prov == "grok":
                prov = "xai"
            elif prov == "google":
                prov = "gemini"
            return prov, s[len(pref):].strip() or None
    return None, s


def llm_provider() -> str:
    """The provider the next default-routed call will hit. Honors the
    ``LLM_PROVIDER`` env override when it's both set AND configured; falls
    back to auto-detect priority openai > local > chutes.

    OpenAI is the default primary because it's the fastest hosted option
    with the strongest instruction-following at the small-model tier.
    Chutes is the universal fallback (anything primary that fails before
    yielding output retries against Chutes if it's configured)."""
    if _LLM_PROVIDER_OVERRIDE == "openai" and openai_llm_configured():
        return "openai"
    if _LLM_PROVIDER_OVERRIDE == "local" and local_llm_configured():
        return "local"
    if _LLM_PROVIDER_OVERRIDE == "chutes" and chutes_llm_configured():
        return "chutes"
    # Auto / unconfigured-override → first available in priority order.
    if openai_llm_configured():
        return "openai"
    if local_llm_configured():
        return "local"
    if chutes_llm_configured():
        return "chutes"
    return "none"


# ---------------------------------------------------------------------------
# Headers / response shape helpers
# ---------------------------------------------------------------------------


def _local_headers() -> dict:
    h = {"Content-Type": "application/json"}
    if LOCAL_LLM_API_KEY:
        h["Authorization"] = f"Bearer {LOCAL_LLM_API_KEY}"
    return h


def _chutes_headers() -> dict:
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {CHUTES_AUTH_KEY}",
    }


def _openai_headers() -> dict:
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {OPENAI_API_KEY}",
    }


def _groq_headers() -> dict:
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {GROQ_API_KEY}",
    }


def _cerebras_headers(api_key: str | None = None) -> dict:
    """Cerebras auth headers. Pass ``api_key`` to use a specific key
    from the multi-key pool (used by the rotation logic in
    ``stream_chat_with_tools``); omit to advance the round-robin
    counter and pick the next key in the pool."""
    key = api_key or _pick_cerebras_key()
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {key}",
    }


def _xai_headers() -> dict:
    return {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {XAI_API_KEY}",
    }


def xai_llm_configured() -> bool:
    return bool(XAI_API_KEY)


def _extract_content(obj: dict) -> str:
    """Pull the assistant text out of a chat-completion response, tolerant of
    multiple schemas:

      • OpenAI (Chutes) non-stream:  choices[0].message.content
      • OpenAI (Chutes) stream:      choices[0].delta.content
      • Local Qwen3-4B non-stream:   { "content": "...", "thinking": null }
      • Local Qwen3-4B stream:       { "event": "content", "delta": "..." }

    Returns "" when the frame carries no content (e.g. event=done, or a
    thinking-mode delta we want to suppress)."""
    # Local LLM streaming: only emit deltas tagged as "content" — drop
    # "thinking" deltas (chain-of-thought scratch) and "done" sentinels.
    event = obj.get("event")
    if event == "content":
        d = obj.get("delta")
        return d if isinstance(d, str) else ""
    if event in ("done", "thinking", "tool"):
        return ""

    # OpenAI choices[]
    choices = obj.get("choices") or []
    if choices:
        c0 = choices[0] or {}
        for key in ("message", "delta"):
            m = c0.get(key)
            if isinstance(m, dict):
                content = m.get("content")
                if isinstance(content, str):
                    return content
        text = c0.get("text")
        if isinstance(text, str):
            return text

    # Local LLM non-streaming top-level fields
    for key in ("content", "text", "output"):
        v = obj.get(key)
        if isinstance(v, str):
            return v
    return ""


def extract_json_object(text: str) -> dict:
    """Strip ``` fences and parse the first JSON object found. Forgiving."""
    s = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", s, re.DOTALL | re.IGNORECASE)
    if fence:
        s = fence.group(1)
    else:
        first = s.find("{")
        last = s.rfind("}")
        if first >= 0 and last > first:
            s = s[first : last + 1]
    return json.loads(s)


# ---------------------------------------------------------------------------
# Non-streaming
# ---------------------------------------------------------------------------


def _usage_from(obj: dict) -> tuple[int | None, int | None, int | None]:
    """Extract OpenAI-compatible ``usage`` fields from a chat-completions
    response payload. All providers we target (OpenAI/Groq/Cerebras/
    Chutes) return the same shape; local Qwen3 currently does not, so
    this returns (None, None, None) when no usage block is present."""
    usage = obj.get("usage") if isinstance(obj, dict) else None
    if not isinstance(usage, dict):
        return None, None, None
    return (
        usage.get("prompt_tokens"),
        usage.get("completion_tokens"),
        usage.get("total_tokens"),
    )


async def _local_chat_complete(
    messages: list[dict],
    *,
    temperature: float,
    max_tokens: int,
    think: bool,
) -> str:
    path = "/v1/think" if think else "/v1/no-think"
    url = LOCAL_LLM_BASE_URL + path
    body = {
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    timeout = aiohttp.ClientTimeout(total=LOCAL_LLM_TIMEOUT_SEC)
    t0 = time.monotonic()
    http_status: int | None = None
    status = "error"
    err: str | None = None
    p_tok = c_tok = tot_tok = None
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=_local_headers(), json=body) as resp:
                http_status = resp.status
                raw = await resp.read()
                if resp.status != 200:
                    snippet = raw[:400].decode("utf-8", errors="replace")
                    raise RuntimeError(f"local LLM returned {resp.status}: {snippet}")
                try:
                    obj = json.loads(raw.decode("utf-8"))
                except Exception as exc:
                    raise RuntimeError(f"local LLM returned non-JSON: {exc}")
                p_tok, c_tok, tot_tok = _usage_from(obj)
                content = _extract_content(obj)
                if not content:
                    status = "empty"
                    raise RuntimeError(f"local LLM returned empty content; payload={str(obj)[:300]}")
                status = "ok"
                return content
    except Exception as exc:  # noqa: BLE001 — re-raised below; we just capture for telemetry
        err = str(exc)
        raise
    finally:
        _record_llm_call(
            provider="local", model="qwen3-4b" if not think else "qwen3-4b-think",
            mode="chat", status=status, http_status=http_status,
            latency_ms=int((time.monotonic() - t0) * 1000),
            prompt_tokens=p_tok, completion_tokens=c_tok, total_tokens=tot_tok,
            error_message=err,
        )


async def _openai_chat_complete(
    messages: list[dict],
    *,
    temperature: float,
    max_tokens: int,
    reasoning_effort: str | None = None,
    timeout_sec: float | None = None,
) -> str:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY not set")
    url = f"{OPENAI_BASE_URL}/chat/completions"
    # gpt-5* / o-series: ``max_tokens`` is renamed to
    # ``max_completion_tokens`` (the old name 400s) and custom
    # ``temperature`` is rejected entirely (only default 1 is allowed
    # for reasoning models). Both quirks: just omit temperature and
    # use the new max-token field. Older OpenAI models still accept
    # this shape — default temperature is 1, which is fine.
    body: dict = {
        "model": OPENAI_MODEL,
        "messages": messages,
        "max_completion_tokens": max_tokens,
    }
    # ``reasoning_effort`` controls thinking depth on gpt-5 / o-series
    # ("minimal" | "low" | "medium" | "high"). When set, the model
    # spends extra hidden tokens reasoning before producing visible
    # output. Higher = better answers, longer latency (and cost). Only
    # forward when the caller explicitly opted in — older OpenAI
    # models reject this field.
    if reasoning_effort:
        body["reasoning_effort"] = reasoning_effort
    # Reasoning models can run for tens of seconds at high effort. Let
    # the caller override the default 120 s timeout so the architect
    # endpoint can wait 3-4 minutes for a deep gpt-5-high response
    # without blocking the rest of the system on the same value.
    timeout = aiohttp.ClientTimeout(total=timeout_sec or LOCAL_LLM_TIMEOUT_SEC)
    t0 = time.monotonic()
    http_status: int | None = None
    status = "error"
    err: str | None = None
    p_tok = c_tok = tot_tok = None
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=_openai_headers(), json=body) as resp:
                http_status = resp.status
                raw = await resp.read()
                if resp.status != 200:
                    snippet = raw[:400].decode("utf-8", errors="replace")
                    raise RuntimeError(f"openai LLM returned {resp.status}: {snippet}")
                try:
                    obj = json.loads(raw.decode("utf-8"))
                except Exception as exc:
                    raise RuntimeError(f"openai LLM returned non-JSON: {exc}")
                p_tok, c_tok, tot_tok = _usage_from(obj)
                content = _extract_content(obj)
                if not content:
                    status = "empty"
                    raise RuntimeError("openai LLM returned empty content")
                status = "ok"
                return content
    except Exception as exc:
        err = str(exc)
        raise
    finally:
        _record_llm_call(
            provider="openai", model=OPENAI_MODEL, mode="chat",
            status=status, http_status=http_status,
            latency_ms=int((time.monotonic() - t0) * 1000),
            prompt_tokens=p_tok, completion_tokens=c_tok, total_tokens=tot_tok,
            error_message=err,
        )


async def _groq_chat_complete(
    messages: list[dict],
    *,
    temperature: float,
    max_tokens: int,
    model: str | None,
) -> str:
    """Non-streaming Groq chat completion. Same OpenAI-compatible
    wire shape; we keep it on a separate function so per-provider
    error surfaces and headers stay decoupled."""
    if not GROQ_API_KEY:
        raise RuntimeError("GROQ_API_KEY not set")
    use_model = (model or GROQ_MODEL).strip()
    if not use_model:
        raise RuntimeError("No Groq model configured")
    url = f"{GROQ_BASE_URL}/chat/completions"
    body = {
        "model": use_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    timeout = aiohttp.ClientTimeout(total=LOCAL_LLM_TIMEOUT_SEC)
    t0 = time.monotonic()
    http_status: int | None = None
    status = "error"
    err: str | None = None
    p_tok = c_tok = tot_tok = None
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=_groq_headers(), json=body) as resp:
                http_status = resp.status
                raw = await resp.read()
                if resp.status != 200:
                    snippet = raw[:400].decode("utf-8", errors="replace")
                    raise RuntimeError(f"groq LLM returned {resp.status}: {snippet}")
                try:
                    obj = json.loads(raw.decode("utf-8"))
                except Exception as exc:
                    raise RuntimeError(f"groq LLM returned non-JSON: {exc}")
                p_tok, c_tok, tot_tok = _usage_from(obj)
                content = _extract_content(obj)
                if not content:
                    status = "empty"
                    raise RuntimeError("groq LLM returned empty content")
                status = "ok"
                return content
    except Exception as exc:
        err = str(exc)
        raise
    finally:
        _record_llm_call(
            provider="groq", model=use_model, mode="chat",
            status=status, http_status=http_status,
            latency_ms=int((time.monotonic() - t0) * 1000),
            prompt_tokens=p_tok, completion_tokens=c_tok, total_tokens=tot_tok,
            error_message=err,
        )


async def _cerebras_chat_complete(
    messages: list[dict],
    *,
    temperature: float,
    max_tokens: int,
    model: str | None,
    api_key: str | None = None,
) -> str:
    """Non-streaming Cerebras chat completion. OpenAI-compatible wire
    shape; isolated function so error surfaces / headers stay decoupled
    from the other providers.

    Pass ``api_key`` to pin a specific key from the multi-key pool. Omit
    to advance the round-robin counter (basic load-balance across accounts)."""
    if not CEREBRAS_API_KEYS:
        raise RuntimeError("CEREBRAS_API_KEYS not set")
    use_model = (model or CEREBRAS_MODEL).strip()
    if not use_model:
        raise RuntimeError("No Cerebras model configured")
    url = f"{CEREBRAS_BASE_URL}/chat/completions"
    body = {
        "model": use_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    timeout = aiohttp.ClientTimeout(total=LOCAL_LLM_TIMEOUT_SEC)
    t0 = time.monotonic()
    http_status: int | None = None
    status = "error"
    err: str | None = None
    p_tok = c_tok = tot_tok = None
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=_cerebras_headers(api_key), json=body) as resp:
                http_status = resp.status
                raw = await resp.read()
                if resp.status != 200:
                    snippet = raw[:400].decode("utf-8", errors="replace")
                    raise RuntimeError(f"cerebras LLM returned {resp.status}: {snippet}")
                try:
                    obj = json.loads(raw.decode("utf-8"))
                except Exception as exc:
                    raise RuntimeError(f"cerebras LLM returned non-JSON: {exc}")
                p_tok, c_tok, tot_tok = _usage_from(obj)
                content = _extract_content(obj)
                if not content:
                    status = "empty"
                    raise RuntimeError("cerebras LLM returned empty content")
                status = "ok"
                return content
    except Exception as exc:
        err = str(exc)
        raise
    finally:
        _record_llm_call(
            provider="cerebras", model=use_model, mode="chat",
            status=status, http_status=http_status,
            latency_ms=int((time.monotonic() - t0) * 1000),
            prompt_tokens=p_tok, completion_tokens=c_tok, total_tokens=tot_tok,
            error_message=err,
        )


async def _gemini_chat_complete(
    messages: list[dict],
    *,
    temperature: float,
    max_tokens: int,
    model: str | None,
    api_key: str | None = None,
) -> str:
    """Non-streaming Gemini chat completion. OpenAI-compatible endpoint
    at generativelanguage.googleapis.com/v1beta/openai/chat/completions.
    ``reasoning_effort="none"`` is forced on every call so Gemini 3.x
    Flash doesn't burn 5 s in the thinking pass (see comment on
    ``GOOGLE_API_KEYS`` for the full rationale)."""
    if not GOOGLE_API_KEYS:
        raise RuntimeError("GOOGLE_API_KEYS not set")
    use_model = (model or GOOGLE_MODEL).strip()
    if not use_model:
        raise RuntimeError("No Gemini model configured")
    url = f"{GOOGLE_BASE_URL}/chat/completions"
    body = {
        "model": use_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "reasoning_effort": "none",
    }
    timeout = aiohttp.ClientTimeout(total=LOCAL_LLM_TIMEOUT_SEC)
    t0 = time.monotonic()
    http_status: int | None = None
    status = "error"
    err: str | None = None
    p_tok = c_tok = tot_tok = None
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=_google_headers(api_key), json=body) as resp:
                http_status = resp.status
                raw = await resp.read()
                if resp.status != 200:
                    snippet = raw[:400].decode("utf-8", errors="replace")
                    raise RuntimeError(f"gemini LLM returned {resp.status}: {snippet}")
                try:
                    obj = json.loads(raw.decode("utf-8"))
                except Exception as exc:
                    raise RuntimeError(f"gemini LLM returned non-JSON: {exc}")
                p_tok, c_tok, tot_tok = _usage_from(obj)
                content = _extract_content(obj)
                if not content:
                    status = "empty"
                    raise RuntimeError("gemini LLM returned empty content")
                status = "ok"
                return content
    except Exception as exc:
        err = str(exc)
        raise
    finally:
        _record_llm_call(
            provider="gemini", model=use_model, mode="chat",
            status=status, http_status=http_status,
            latency_ms=int((time.monotonic() - t0) * 1000),
            prompt_tokens=p_tok, completion_tokens=c_tok, total_tokens=tot_tok,
            error_message=err,
        )


async def _xai_chat_complete(
    messages: list[dict],
    *,
    temperature: float,
    max_tokens: int,
    model: str | None,
) -> str:
    """Non-streaming xAI (Grok) chat completion. OpenAI-compatible
    wire shape. Used as the fallback target when the primary Cerebras
    call fails (in chat_complete's per-call try/except path) AND as a
    first-class provider via the ``xai:`` / ``grok:`` model prefix.

    Model defaults to ``VOICECHAT_GROK_FALLBACK_MODEL`` (currently the
    fastest non-reasoning Grok variant) — pass an explicit model id to
    override per-call."""
    if not XAI_API_KEY:
        raise RuntimeError("XAI_API_KEY not set")
    use_model = (model or VOICECHAT_GROK_FALLBACK_MODEL).strip()
    if not use_model:
        raise RuntimeError("No xAI model configured")
    url = f"{XAI_BASE_URL}/chat/completions"
    body = {
        "model": use_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    timeout = aiohttp.ClientTimeout(total=LOCAL_LLM_TIMEOUT_SEC)
    t0 = time.monotonic()
    http_status: int | None = None
    status = "error"
    err: str | None = None
    p_tok = c_tok = tot_tok = None
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=_xai_headers(), json=body) as resp:
                http_status = resp.status
                raw = await resp.read()
                if resp.status != 200:
                    snippet = raw[:400].decode("utf-8", errors="replace")
                    raise RuntimeError(f"xai LLM returned {resp.status}: {snippet}")
                try:
                    obj = json.loads(raw.decode("utf-8"))
                except Exception as exc:
                    raise RuntimeError(f"xai LLM returned non-JSON: {exc}")
                p_tok, c_tok, tot_tok = _usage_from(obj)
                content = _extract_content(obj)
                if not content:
                    status = "empty"
                    raise RuntimeError("xai LLM returned empty content")
                status = "ok"
                return content
    except Exception as exc:
        err = str(exc)
        raise
    finally:
        _record_llm_call(
            provider="xai", model=use_model, mode="chat",
            status=status, http_status=http_status,
            latency_ms=int((time.monotonic() - t0) * 1000),
            prompt_tokens=p_tok, completion_tokens=c_tok, total_tokens=tot_tok,
            error_message=err,
        )


async def _chutes_chat_complete(
    messages: list[dict],
    *,
    temperature: float,
    max_tokens: int,
    model: Optional[str],
) -> str:
    if not chutes_llm_configured() and not model:
        raise RuntimeError("No LLM model configured (set LOCAL_LLM_BASE_URL or VOICE_DESIGN_LLM_MODEL+CHUTES_AUTH_KEY)")
    if not CHUTES_AUTH_KEY:
        raise RuntimeError("CHUTES_AUTH_KEY not set")
    use_model = (model or DEFAULT_CHUTES_MODEL).strip()
    if not use_model:
        raise RuntimeError("No Chutes model name configured")
    url = f"{VOICE_DESIGN_LLM_BASE_URL}/chat/completions"
    body = {
        "model": use_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    timeout = aiohttp.ClientTimeout(total=LOCAL_LLM_TIMEOUT_SEC)
    t0 = time.monotonic()
    http_status: int | None = None
    status = "error"
    err: str | None = None
    p_tok = c_tok = tot_tok = None
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=_chutes_headers(), json=body) as resp:
                http_status = resp.status
                raw = await resp.read()
                if resp.status != 200:
                    snippet = raw[:400].decode("utf-8", errors="replace")
                    raise RuntimeError(f"chutes LLM returned {resp.status}: {snippet}")
                try:
                    obj = json.loads(raw.decode("utf-8"))
                except Exception as exc:
                    raise RuntimeError(f"chutes LLM returned non-JSON: {exc}")
                p_tok, c_tok, tot_tok = _usage_from(obj)
                content = _extract_content(obj)
                if not content:
                    status = "empty"
                    raise RuntimeError("chutes LLM returned empty content")
                status = "ok"
                return content
    except Exception as exc:
        err = str(exc)
        raise
    finally:
        _record_llm_call(
            provider="chutes", model=use_model, mode="chat",
            status=status, http_status=http_status,
            latency_ms=int((time.monotonic() - t0) * 1000),
            prompt_tokens=p_tok, completion_tokens=c_tok, total_tokens=tot_tok,
            error_message=err,
        )


async def chat_complete(
    messages: list[dict],
    *,
    temperature: float = 0.4,
    max_tokens: int = 1500,
    think: bool | None = None,
    model: str | None = None,
    retries: int = 1,
    reasoning_effort: str | None = None,
    timeout_sec: float | None = None,
) -> str:
    """Non-streaming chat completion. Returns the assistant content string.

    Provider routing:
      - Local LLM if configured (default no-think; pass think=True for CoT).
      - Falls back to Chutes when local is unreachable AND
        LLM_FALLBACK_TO_CHUTES=1 (the default).
      - When ``model`` is explicitly provided, the call is forced to Chutes
        (since model selection is meaningless on the single-model local
        endpoint). Allows per-call overrides for Voice Design / agent
        config selecting a specific Chutes model.
    """
    if model:
        # Detect explicit provider prefix (``groq:llama-3.3-70b-versatile``,
        # ``openai:gpt-5-mini``, ``chutes:...``). The prefix wins over the
        # system default so per-agent routing is unambiguous.
        forced_provider, bare_model = split_provider_prefix(model)
        if forced_provider == "groq":
            return await _retry(
                lambda: _groq_chat_complete(messages, temperature=temperature, max_tokens=max_tokens, model=bare_model),
                retries,
            )
        if forced_provider == "cerebras":
            return await _retry(
                lambda: _cerebras_chat_complete(messages, temperature=temperature, max_tokens=max_tokens, model=bare_model),
                retries,
            )
        if forced_provider == "xai":
            return await _retry(
                lambda: _xai_chat_complete(messages, temperature=temperature, max_tokens=max_tokens, model=bare_model),
                retries,
            )
        if forced_provider == "gemini":
            # Non-streaming Gemini path. Same OpenAI-compatible
            # endpoint as the streaming route, but goes through the
            # plain ``_openai_compatible_chat_complete`` shape with
            # the Google headers + reasoning_effort=none baked in.
            if not GOOGLE_API_KEYS:
                raise RuntimeError("GOOGLE_API_KEYS not set")
            return await _retry(
                lambda: _gemini_chat_complete(messages, temperature=temperature, max_tokens=max_tokens, model=bare_model),
                retries,
            )
        if forced_provider == "openai":
            # OpenAI's slot uses OPENAI_MODEL globally; an explicit
            # provider:model overrides for this single call.
            global OPENAI_MODEL  # noqa: PLW0603 — narrow per-call override is intentional
            prior, OPENAI_MODEL = OPENAI_MODEL, (bare_model or OPENAI_MODEL)
            try:
                return await _retry(
                    lambda: _openai_chat_complete(
                        messages,
                        temperature=temperature,
                        max_tokens=max_tokens,
                        reasoning_effort=reasoning_effort,
                        timeout_sec=timeout_sec,
                    ),
                    retries,
                )
            finally:
                OPENAI_MODEL = prior
        # Bare model id or ``chutes:`` prefix → Chutes (the existing
        # behaviour for agent configs that specified a Chutes model id).
        return await _retry(
            lambda: _chutes_chat_complete(messages, temperature=temperature, max_tokens=max_tokens, model=bare_model),
            retries,
        )

    primary = llm_provider()
    if primary == "local":
        if think is None:
            think = _LOCAL_LLM_USE_THINK_DEFAULT
        try:
            return await _retry(
                lambda: _local_chat_complete(messages, temperature=temperature, max_tokens=max_tokens, think=think),
                retries,
            )
        except Exception as exc:  # noqa: BLE001
            if not LLM_FALLBACK_TO_CHUTES or not chutes_llm_configured():
                raise
            _log.warning("local LLM failed (%s); falling back to Chutes", exc)
            return await _retry(
                lambda: _chutes_chat_complete(messages, temperature=temperature, max_tokens=max_tokens, model=None),
                retries,
            )

    if primary == "openai":
        try:
            return await _retry(
                lambda: _openai_chat_complete(
                    messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    reasoning_effort=reasoning_effort,
                    timeout_sec=timeout_sec,
                ),
                retries,
            )
        except Exception as exc:  # noqa: BLE001
            if not LLM_FALLBACK_TO_CHUTES or not chutes_llm_configured():
                raise
            _log.warning("openai LLM failed (%s); falling back to Chutes", exc)
            return await _retry(
                lambda: _chutes_chat_complete(messages, temperature=temperature, max_tokens=max_tokens, model=None),
                retries,
            )

    # primary == "chutes" (or "none" with chutes configured → same call)
    return await _retry(
        lambda: _chutes_chat_complete(messages, temperature=temperature, max_tokens=max_tokens, model=None),
        retries,
    )


async def chat_complete_json(
    messages: list[dict],
    *,
    temperature: float = 0.4,
    max_tokens: int = 1500,
    think: bool | None = None,
    model: str | None = None,
    retries: int = 1,
    reasoning_effort: str | None = None,
    timeout_sec: float | None = None,
) -> dict:
    """Convenience: take the assistant content and parse it as a JSON object."""
    content = await chat_complete(
        messages,
        temperature=temperature,
        max_tokens=max_tokens,
        think=think,
        model=model,
        retries=retries,
        reasoning_effort=reasoning_effort,
        timeout_sec=timeout_sec,
    )
    return extract_json_object(content)


async def _retry(call_fn, retries: int):
    """Retry transient failures (429/5xx-style RuntimeError messages) once."""
    attempts = max(1, retries + 1)
    last_exc: Exception | None = None
    for i in range(attempts):
        try:
            return await call_fn()
        except RuntimeError as exc:
            last_exc = exc
            msg = str(exc).lower()
            transient = ("returned 5" in msg) or ("returned 429" in msg) or ("timed out" in msg) or ("connect" in msg)
            if i + 1 >= attempts or not transient:
                raise
            await asyncio.sleep(0.6 * (2 ** i))
    if last_exc:
        raise last_exc
    raise RuntimeError("LLM unreachable")


# ---------------------------------------------------------------------------
# Streaming
# ---------------------------------------------------------------------------


async def _local_stream_chat(
    messages: list[dict],
    *,
    temperature: float,
    max_tokens: int,
    think: bool,
) -> AsyncIterator[str]:
    path = "/v1/stream/think" if think else "/v1/stream/no-think"
    url = LOCAL_LLM_BASE_URL + path
    body = {
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    headers = {**_local_headers(), "Accept": "text/event-stream"}
    # Same streaming-timeout shape as the Chutes path: no `total` cap,
    # only sock_connect + sock_read. The local service can stream a
    # long reply too.
    timeout = aiohttp.ClientTimeout(
        total=None,
        sock_connect=15,
        sock_read=60,
    )
    t0 = time.monotonic()
    ttft_ms: int | None = None
    http_status: int | None = None
    status = "error"
    err: str | None = None
    metrics: dict = {}
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=headers, json=body) as resp:
                http_status = resp.status
                if resp.status != 200:
                    snippet = (await resp.read())[:400].decode("utf-8", errors="replace")
                    raise RuntimeError(f"local LLM stream returned {resp.status}: {snippet}")
                async for delta in _iter_sse_content(resp, metrics=metrics):
                    if ttft_ms is None:
                        ttft_ms = int((time.monotonic() - t0) * 1000)
                    yield delta
                status = "ok" if ttft_ms is not None else "empty"
    except Exception as exc:
        err = str(exc)
        raise
    finally:
        usage = metrics.get("usage") or {}
        _record_llm_call(
            provider="local", model="qwen3-4b" if not think else "qwen3-4b-think",
            mode="stream", status=status, http_status=http_status,
            latency_ms=int((time.monotonic() - t0) * 1000),
            ttft_ms=ttft_ms,
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            total_tokens=usage.get("total_tokens"),
            error_message=err,
        )


async def _openai_stream_chat(
    messages: list[dict],
    *,
    temperature: float,
    max_tokens: int,
) -> AsyncIterator[str]:
    if not OPENAI_API_KEY:
        raise RuntimeError("OPENAI_API_KEY not set")
    url = f"{OPENAI_BASE_URL}/chat/completions"
    # Same provider quirks as ``_openai_chat_complete``: omit temperature
    # (gpt-5* only allows default) + use max_completion_tokens.
    #
    # ``stream_options.include_usage`` makes OpenAI emit a final chunk
    # with prompt/completion/total tokens — required for cost tracking.
    body = {
        "model": OPENAI_MODEL,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
        "max_completion_tokens": max_tokens,
    }
    headers = {**_openai_headers(), "Accept": "text/event-stream"}
    # Same streaming-timeout shape as Chutes/local: cap the connect and the
    # gap between chunks, never the full stream length.
    timeout = aiohttp.ClientTimeout(
        total=None,
        sock_connect=15,
        sock_read=60,
    )
    t0 = time.monotonic()
    ttft_ms: int | None = None
    http_status: int | None = None
    status = "error"
    err: str | None = None
    metrics: dict = {}
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=headers, json=body) as resp:
                http_status = resp.status
                if resp.status != 200:
                    snippet = (await resp.read())[:400].decode("utf-8", errors="replace")
                    raise RuntimeError(f"openai LLM stream returned {resp.status}: {snippet}")
                async for delta in _iter_sse_content(resp, metrics=metrics):
                    if ttft_ms is None:
                        ttft_ms = int((time.monotonic() - t0) * 1000)
                    yield delta
                status = "ok" if ttft_ms is not None else "empty"
    except Exception as exc:
        err = str(exc)
        raise
    finally:
        usage = metrics.get("usage") or {}
        _record_llm_call(
            provider="openai", model=OPENAI_MODEL, mode="stream",
            status=status, http_status=http_status,
            latency_ms=int((time.monotonic() - t0) * 1000),
            ttft_ms=ttft_ms,
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            total_tokens=usage.get("total_tokens"),
            error_message=err,
        )


async def _groq_stream_chat(
    messages: list[dict],
    *,
    temperature: float,
    max_tokens: int,
    model: str | None,
) -> AsyncIterator[str]:
    if not GROQ_API_KEY:
        raise RuntimeError("GROQ_API_KEY not set")
    use_model = (model or GROQ_MODEL).strip()
    if not use_model:
        raise RuntimeError("No Groq model configured for streaming")
    url = f"{GROQ_BASE_URL}/chat/completions"
    body = {
        "model": use_model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {**_groq_headers(), "Accept": "text/event-stream"}
    timeout = aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=60)
    t0 = time.monotonic()
    ttft_ms: int | None = None
    http_status: int | None = None
    status = "error"
    err: str | None = None
    metrics: dict = {}
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=headers, json=body) as resp:
                http_status = resp.status
                if resp.status != 200:
                    snippet = (await resp.read())[:400].decode("utf-8", errors="replace")
                    raise RuntimeError(f"groq LLM stream returned {resp.status}: {snippet}")
                async for delta in _iter_sse_content(resp, metrics=metrics):
                    if ttft_ms is None:
                        ttft_ms = int((time.monotonic() - t0) * 1000)
                    yield delta
                status = "ok" if ttft_ms is not None else "empty"
    except Exception as exc:
        err = str(exc)
        raise
    finally:
        usage = metrics.get("usage") or {}
        _record_llm_call(
            provider="groq", model=use_model, mode="stream",
            status=status, http_status=http_status,
            latency_ms=int((time.monotonic() - t0) * 1000),
            ttft_ms=ttft_ms,
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            total_tokens=usage.get("total_tokens"),
            error_message=err,
        )


async def _cerebras_stream_chat(
    messages: list[dict],
    *,
    temperature: float,
    max_tokens: int,
    model: str | None,
    api_key: str | None = None,
) -> AsyncIterator[str]:
    if not CEREBRAS_API_KEYS:
        raise RuntimeError("CEREBRAS_API_KEYS not set")
    use_model = (model or CEREBRAS_MODEL).strip()
    if not use_model:
        raise RuntimeError("No Cerebras model configured for streaming")
    url = f"{CEREBRAS_BASE_URL}/chat/completions"
    body = {
        "model": use_model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {**_cerebras_headers(api_key), "Accept": "text/event-stream"}
    timeout = aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=60)
    t0 = time.monotonic()
    ttft_ms: int | None = None
    http_status: int | None = None
    status = "error"
    err: str | None = None
    metrics: dict = {}
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=headers, json=body) as resp:
                http_status = resp.status
                if resp.status != 200:
                    snippet = (await resp.read())[:400].decode("utf-8", errors="replace")
                    raise RuntimeError(f"cerebras LLM stream returned {resp.status}: {snippet}")
                async for delta in _iter_sse_content(resp, metrics=metrics):
                    if ttft_ms is None:
                        ttft_ms = int((time.monotonic() - t0) * 1000)
                    yield delta
                status = "ok" if ttft_ms is not None else "empty"
    except Exception as exc:
        err = str(exc)
        raise
    finally:
        usage = metrics.get("usage") or {}
        _record_llm_call(
            provider="cerebras", model=use_model, mode="stream",
            status=status, http_status=http_status,
            latency_ms=int((time.monotonic() - t0) * 1000),
            ttft_ms=ttft_ms,
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            total_tokens=usage.get("total_tokens"),
            error_message=err,
        )


async def _chutes_stream_chat(
    messages: list[dict],
    *,
    temperature: float,
    max_tokens: int,
    model: Optional[str],
) -> AsyncIterator[str]:
    use_model = (model or DEFAULT_CHUTES_MODEL).strip()
    if not use_model:
        raise RuntimeError("No Chutes model configured for streaming")
    if not CHUTES_AUTH_KEY:
        raise RuntimeError("CHUTES_AUTH_KEY not set")
    url = f"{VOICE_DESIGN_LLM_BASE_URL}/chat/completions"
    body = {
        "model": use_model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {**_chutes_headers(), "Accept": "text/event-stream"}
    # Streaming SSE: do NOT cap `total` — a real reply can stream for
    # minutes (long answers, slow models). Cap the TCP connect and the
    # gap between chunks instead. sock_read=60s means the stream is
    # only killed if Chutes goes silent for a full minute between
    # tokens, which never happens in healthy traffic.
    timeout = aiohttp.ClientTimeout(
        total=None,
        sock_connect=15,
        sock_read=60,
    )
    t0 = time.monotonic()
    ttft_ms: int | None = None
    http_status: int | None = None
    status = "error"
    err: str | None = None
    metrics: dict = {}
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=headers, json=body) as resp:
                http_status = resp.status
                if resp.status != 200:
                    snippet = (await resp.read())[:400].decode("utf-8", errors="replace")
                    raise RuntimeError(f"chutes LLM stream returned {resp.status}: {snippet}")
                async for delta in _iter_sse_content(resp, metrics=metrics):
                    if ttft_ms is None:
                        ttft_ms = int((time.monotonic() - t0) * 1000)
                    yield delta
                status = "ok" if ttft_ms is not None else "empty"
    except Exception as exc:
        err = str(exc)
        raise
    finally:
        usage = metrics.get("usage") or {}
        _record_llm_call(
            provider="chutes", model=use_model, mode="stream",
            status=status, http_status=http_status,
            latency_ms=int((time.monotonic() - t0) * 1000),
            ttft_ms=ttft_ms,
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            total_tokens=usage.get("total_tokens"),
            error_message=err,
        )


async def _iter_sse_content(
    resp: aiohttp.ClientResponse,
    metrics: dict | None = None,
) -> AsyncIterator[str]:
    """Iterate SSE events from a streaming chat-completions response.

    Stops on either provider's end-of-stream sentinel:
      • OpenAI (Chutes): ``data: [DONE]``
      • Local Qwen3-4B:  ``data: {"event":"done", ...}``

    When ``metrics`` is provided, the latest ``usage`` block seen in any
    chunk is stored at ``metrics['usage']`` (a dict with prompt_tokens /
    completion_tokens / total_tokens). OpenAI-compatible providers emit
    this in the final chunk when the request body includes
    ``stream_options: {include_usage: true}``.
    """
    async for raw in resp.content:
        line = raw.decode("utf-8", errors="replace").strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            return
        try:
            obj = json.loads(data)
        except Exception:
            continue
        # Local-LLM done sentinel
        if obj.get("event") == "done":
            return
        if metrics is not None:
            usage = obj.get("usage")
            if isinstance(usage, dict) and usage:
                metrics["usage"] = usage
        delta = _extract_content(obj)
        if delta:
            yield delta


async def stream_chat(
    messages: list[dict],
    *,
    temperature: float = 0.6,
    max_tokens: int = 350,
    think: bool | None = None,
    model: str | None = None,
) -> AsyncIterator[str]:
    """Streaming chat completion. Yields content deltas as they arrive.

    Same provider routing as ``chat_complete``. If the local service errors
    *before* the first delta is yielded, automatic fallback to Chutes is
    attempted (when LLM_FALLBACK_TO_CHUTES=1). Once any delta has been
    emitted to the caller, errors propagate — partial responses don't
    silently restart.
    """
    if model:
        forced_provider, bare_model = split_provider_prefix(model)
        if forced_provider == "groq":
            async for d in _groq_stream_chat(messages, temperature=temperature, max_tokens=max_tokens, model=bare_model):
                yield d
            return
        if forced_provider == "cerebras":
            async for d in _cerebras_stream_chat(messages, temperature=temperature, max_tokens=max_tokens, model=bare_model):
                yield d
            return
        if forced_provider == "openai":
            global OPENAI_MODEL  # noqa: PLW0603 — narrow per-call override is intentional
            prior, OPENAI_MODEL = OPENAI_MODEL, (bare_model or OPENAI_MODEL)
            try:
                async for d in _openai_stream_chat(messages, temperature=temperature, max_tokens=max_tokens):
                    yield d
            finally:
                OPENAI_MODEL = prior
            return
        # Bare or ``chutes:`` → Chutes
        async for d in _chutes_stream_chat(messages, temperature=temperature, max_tokens=max_tokens, model=bare_model):
            yield d
        return

    primary = llm_provider()

    if primary == "local":
        if think is None:
            think = _LOCAL_LLM_USE_THINK_DEFAULT
        emitted_any = False
        try:
            async for d in _local_stream_chat(messages, temperature=temperature, max_tokens=max_tokens, think=think):
                emitted_any = True
                yield d
            return
        except Exception as exc:  # noqa: BLE001
            if emitted_any or not LLM_FALLBACK_TO_CHUTES or not chutes_llm_configured():
                raise
            _log.warning("local LLM stream failed before first delta (%s); falling back to Chutes", exc)
            async for d in _chutes_stream_chat(messages, temperature=temperature, max_tokens=max_tokens, model=None):
                yield d
            return

    if primary == "openai":
        emitted_any = False
        try:
            async for d in _openai_stream_chat(messages, temperature=temperature, max_tokens=max_tokens):
                emitted_any = True
                yield d
            return
        except Exception as exc:  # noqa: BLE001
            if emitted_any or not LLM_FALLBACK_TO_CHUTES or not chutes_llm_configured():
                raise
            _log.warning("openai LLM stream failed before first delta (%s); falling back to Chutes", exc)
            async for d in _chutes_stream_chat(messages, temperature=temperature, max_tokens=max_tokens, model=None):
                yield d
            return

    # primary == "chutes" (or fallthrough)
    async for d in _chutes_stream_chat(messages, temperature=temperature, max_tokens=max_tokens, model=None):
        yield d


# ---------------------------------------------------------------------------
# Tool-aware streaming (OpenAI-compatible function calling)
# ---------------------------------------------------------------------------
#
# stream_chat_with_tools yields a uniform event stream so callers don't
# have to learn the SSE fragmentation rules each provider uses. Content
# deltas pass through one-at-a-time (TTS can chunk them as they arrive);
# tool calls are accumulated across deltas (each chunk carries partial
# JSON in ``function.arguments``) and emitted as a single complete tool
# call once the stream's finish_reason resolves.
#
# Event shape:
#   {"type": "content", "text": "...delta..."}
#   {"type": "tool_call", "tool_call": {"id": "...", "name": "...", "arguments": "json-string"}}
#   {"type": "done", "finish_reason": "stop" | "tool_calls" | "length" | ...}


def _route_for_streaming(model: str | None) -> tuple[str, str, dict, str]:
    """Resolve (url, model_id, headers, provider_name) for a streaming
    chat-completions call. Honors the ``provider:model`` prefix on the
    explicit model argument; otherwise falls back to the default
    routing from ``llm_provider()``."""
    if model:
        forced, bare = split_provider_prefix(model)
        if forced == "groq":
            if not GROQ_API_KEY:
                raise RuntimeError("GROQ_API_KEY not set")
            return (
                f"{GROQ_BASE_URL}/chat/completions",
                (bare or GROQ_MODEL),
                {**_groq_headers(), "Accept": "text/event-stream"},
                "groq",
            )
        if forced == "cerebras":
            if not CEREBRAS_API_KEYS:
                raise RuntimeError("CEREBRAS_API_KEYS not set")
            return (
                f"{CEREBRAS_BASE_URL}/chat/completions",
                (bare or CEREBRAS_MODEL),
                {**_cerebras_headers(), "Accept": "text/event-stream"},
                "cerebras",
            )
        if forced == "openai":
            if not OPENAI_API_KEY:
                raise RuntimeError("OPENAI_API_KEY not set")
            return (
                f"{OPENAI_BASE_URL}/chat/completions",
                (bare or OPENAI_MODEL),
                {**_openai_headers(), "Accept": "text/event-stream"},
                "openai",
            )
        if forced == "gemini":
            if not GOOGLE_API_KEYS:
                raise RuntimeError("GOOGLE_API_KEYS not set")
            return (
                f"{GOOGLE_BASE_URL}/chat/completions",
                (bare or GOOGLE_MODEL),
                {**_google_headers(), "Accept": "text/event-stream"},
                "gemini",
            )
        # Bare or ``chutes:`` prefix → Chutes
        if not CHUTES_AUTH_KEY:
            raise RuntimeError("CHUTES_AUTH_KEY not set")
        return (
            f"{VOICE_DESIGN_LLM_BASE_URL}/chat/completions",
            (bare or DEFAULT_CHUTES_MODEL),
            {**_chutes_headers(), "Accept": "text/event-stream"},
            "chutes",
        )

    # No explicit model — use the system-default provider.
    primary = llm_provider()
    if primary == "groq":
        return (
            f"{GROQ_BASE_URL}/chat/completions", GROQ_MODEL,
            {**_groq_headers(), "Accept": "text/event-stream"}, "groq",
        )
    if primary == "openai":
        return (
            f"{OPENAI_BASE_URL}/chat/completions", OPENAI_MODEL,
            {**_openai_headers(), "Accept": "text/event-stream"}, "openai",
        )
    return (
        f"{VOICE_DESIGN_LLM_BASE_URL}/chat/completions", DEFAULT_CHUTES_MODEL,
        {**_chutes_headers(), "Accept": "text/event-stream"}, "chutes",
    )


async def stream_chat_with_tools(
    messages: list[dict],
    *,
    tools: list[dict] | None = None,
    tool_choice: str | dict = "auto",
    temperature: float = 0.6,
    max_tokens: int = 1500,
    model: str | None = None,
    reasoning_effort: str | None = None,
) -> AsyncIterator[dict]:
    """Stream a chat-completions call with optional tool calling.

    ``tools`` follows the OpenAI / Groq function-calling JSON schema:
      [{"type": "function",
        "function": {"name": "...", "description": "...",
                     "parameters": <JSON Schema>}}]

    The function yields events the voicechat WS layer can fan out
    directly: ``content`` deltas go to TTS, ``tool_call`` events
    trigger the tool dispatcher, and ``done`` signals the turn end.

    Local Qwen3-4B doesn't speak OpenAI tool calls — when the local
    path is selected and ``tools`` are provided, we fall back to
    streaming without tools and warn. Real tool calling needs Groq/
    OpenAI/Chutes (the OpenAI-compatible providers)."""
    # Local path doesn't support OpenAI tool-call JSON. If the caller
    # provides tools while routed to local, drop them and warn — the
    # call still works, just without tool selection.
    if not model and llm_provider() == "local" and tools:
        _log.warning("local LLM doesn't support tool calls; dropping ``tools`` for this stream")
        async for d in _local_stream_chat(messages, temperature=temperature, max_tokens=max_tokens, think=_LOCAL_LLM_USE_THINK_DEFAULT):
            yield {"type": "content", "text": d}
        yield {"type": "done", "finish_reason": "stop"}
        return

    url, model_id, headers, provider = _route_for_streaming(model)
    if not model_id:
        raise RuntimeError(f"{provider}: no model id configured for streaming")

    # Voice-chat fallback ladder, provider-agnostic. Any primary
    # provider that has its own multi-key pool (Cerebras, Gemini)
    # rotates through every configured key in round-robin order
    # BEFORE falling back to xAI Grok. Eligible providers + the
    # ``VOICECHAT_LLM_FALLBACK_ENABLED`` flag both gate the behaviour;
    # if the primary stream fails BEFORE we've emitted any content/
    # tool-call deltas, the loop retries with the next key or falls
    # to Grok. Once any delta has been emitted, errors propagate —
    # partial replies should not silently restart on a different
    # provider/account mid-sentence.
    #
    # The starting key advances by one each call (via the provider's
    # ``_next_*_key_index``) so traffic spreads evenly across accounts:
    #   Call 1: try [A, B, C]   — start at A
    #   Call 2: try [B, C, A]   — start at B
    #   Call 3: try [C, A, B]   — start at C
    #   Call 4: try [A, B, C]   — wraps
    # Keys currently in their post-429 cooldown window are filtered
    # out so re-probing a known-saturated key doesn't waste
    # ~100-200 ms per call. When EVERY key is cooling, we go straight
    # to Grok (tagged with ``<provider>_all_keys_cooling`` in the
    # audit log so the cause is visible).
    PROVIDER_KEY_POOLS: dict[str, dict] = {
        "cerebras": {
            "keys": CEREBRAS_API_KEYS,
            "next_idx": _next_cerebras_key_index,
            "is_cooling": _is_cerebras_key_cooling,
            "mark_cooling": _mark_cerebras_key_cooling,
            "headers": _cerebras_headers,
        },
        "gemini": {
            "keys": GOOGLE_API_KEYS,
            "next_idx": _next_google_key_index,
            "is_cooling": _is_google_key_cooling,
            "mark_cooling": _mark_google_key_cooling,
            "headers": _google_headers,
        },
    }
    pool_info = PROVIDER_KEY_POOLS.get(provider)
    primary_eligible_for_fallback = (
        pool_info is not None
        and VOICECHAT_LLM_FALLBACK_ENABLED
        and xai_llm_configured()
    )
    emitted_any = False
    fallback_reason: str | None = None

    keys_to_try: list[str] = []
    all_keys_cooling = False
    if pool_info and pool_info["keys"]:
        pool = pool_info["keys"]
        next_idx = pool_info["next_idx"]
        is_cooling = pool_info["is_cooling"]
        start = next_idx()
        n = len(pool)
        rotated = [pool[(start + i) % n] for i in range(n)]
        keys_to_try = [k for k in rotated if not is_cooling(k)]
        if not keys_to_try:
            all_keys_cooling = True
            fallback_reason = f"{provider}_all_keys_cooling"
            _log.warning(
                "all %d %s key(s) in cooldown; routing this call directly to Grok",
                len(pool), provider,
            )
    else:
        # Provider has no multi-key pool (openai/groq/chutes/etc.) —
        # single attempt with whatever the route already resolved.
        keys_to_try = [""]

    for attempt_idx, attempt_key in enumerate(keys_to_try):
        # Rebuild headers for THIS key when we have a pool (the route-
        # resolved headers used the round-robin's PREVIOUS pick; the
        # loop's rotation starts from the NEXT index).
        attempt_headers = headers
        if pool_info and attempt_key:
            attempt_headers = {**pool_info["headers"](attempt_key), "Accept": "text/event-stream"}
        try:
            async for evt in _stream_chat_with_tools_once(
                url, model_id, attempt_headers, provider, messages,
                tools=tools, tool_choice=tool_choice,
                temperature=temperature, max_tokens=max_tokens,
                reasoning_effort=reasoning_effort,
            ):
                if evt.get("type") in ("content", "tool_call"):
                    emitted_any = True
                yield evt
            return
        except Exception as exc:  # noqa: BLE001
            if emitted_any:
                # Mid-stream failure: propagate, do NOT restart on a
                # different key (would mix two different completions).
                raise
            if not primary_eligible_for_fallback:
                raise
            msg = str(exc).lower()
            if _is_rate_limit_error(exc):
                fallback_reason = f"{provider}_429"
                # Mark this key as cooling so subsequent calls within
                # the cooldown window skip it entirely.
                if pool_info and attempt_key:
                    pool_info["mark_cooling"](attempt_key)
            elif "timeout" in msg or "timed out" in msg:
                fallback_reason = f"{provider}_timeout"
            elif "5" in msg and "returned 5" in msg:
                fallback_reason = f"{provider}_5xx"
            else:
                fallback_reason = f"{provider}_error"
            # If we have more keys in the pool, log + loop to next.
            # The very last failure falls through to the Grok path
            # below.
            remaining = len(keys_to_try) - attempt_idx - 1
            if remaining > 0:
                _log.warning(
                    "%s key %d/%d failed (%s); trying next key",
                    provider, attempt_idx + 1, len(keys_to_try), exc,
                )
                continue
            _log.warning(
                "all %d %s key(s) failed; last error: %s. Falling back to Grok",
                len(keys_to_try), provider, exc,
            )
            if len(keys_to_try) > 1:
                fallback_reason = f"{provider}_all_keys_{fallback_reason or 'error'}"

    # Sanity: if every key was already cooling at the top of the call,
    # ``keys_to_try`` was empty and we never entered the loop.
    # ``all_keys_cooling`` is True, ``fallback_reason`` is already set,
    # and we drop straight into the Grok path below.
    _ = all_keys_cooling  # referenced so the variable isn't dead code

    # Fallback: route to xAI's Grok. xAI's API is OpenAI-compatible so
    # the same SSE reader handles it. The provider tag is "xai" so the
    # body builder uses the standard ``max_tokens`` + ``temperature``
    # shape (the "openai" branch is reserved for gpt-5*/o-series which
    # require different keys).
    fb_url = f"{XAI_BASE_URL}/chat/completions"
    fb_headers = {**_xai_headers(), "Accept": "text/event-stream"}
    fb_model = VOICECHAT_GROK_FALLBACK_MODEL
    _log.info("voicechat fallback to grok from=%s model=%s", provider, fb_model)
    async for evt in _stream_chat_with_tools_once(
        fb_url, fb_model, fb_headers, "xai", messages,
        tools=tools, tool_choice=tool_choice,
        temperature=temperature, max_tokens=max_tokens,
        fallback_from=provider, fallback_reason=fallback_reason,
        reasoning_effort=None,
    ):
        yield evt


async def _stream_chat_with_tools_once(
    url: str,
    model_id: str,
    headers: dict,
    provider: str,
    messages: list[dict],
    *,
    tools: list[dict] | None,
    tool_choice: str | dict,
    temperature: float,
    max_tokens: int,
    fallback_from: str | None = None,
    fallback_reason: str | None = None,
    reasoning_effort: str | None = None,
) -> AsyncIterator[dict]:
    """Single-shot streaming chat-completions reader. Yields the same
    event envelope as ``stream_chat_with_tools`` but performs no
    fallback — that lives one level up so we can decide based on
    whether anything was emitted yet.

    Records one llm_calls row per attempt (including each rung of a
    fallback ladder)."""
    # Provider-specific body shape. OpenAI's gpt-5* / o-series:
    #   • reject ``max_tokens`` with a 400 → use ``max_completion_tokens``
    #   • reject custom ``temperature`` (only the default 1 is allowed)
    #     → omit temperature entirely
    # Groq, Cerebras, and Chutes still want the legacy ``max_tokens`` +
    # custom temp.
    body: dict = {
        "model": model_id,
        "messages": messages,
        "stream": True,
        # All providers we target are OpenAI-compatible and emit usage
        # in the final SSE chunk when this is requested.
        "stream_options": {"include_usage": True},
    }
    if provider == "openai":
        body["max_completion_tokens"] = max_tokens
        # Intentionally omit ``temperature`` — gpt-5* models only
        # accept default. Older models default to 1 which is fine.
        # Forward thinking depth when the caller opted in. Older
        # non-reasoning OpenAI models reject this field, so we ONLY
        # send it when set explicitly.
        if reasoning_effort:
            body["reasoning_effort"] = reasoning_effort
    else:
        body["max_tokens"] = max_tokens
        body["temperature"] = temperature
        if provider == "gemini":
            # CRITICAL for voice: Gemini 2.5/3.x Flash default to
            # thinking-on, which pushes TTFT from ~0.9 s to 5+ s — the
            # entire reason we'd pick Gemini over Cerebras goes away.
            # The OpenAI-compatible endpoint accepts ``reasoning_effort
            # = "none"`` as a Gemini extension that bypasses the
            # thinking pass entirely. We force it on every call unless
            # the caller already set something else (so a future
            # non-voice integration can opt into reasoning if it wants).
            if reasoning_effort is None:
                body["reasoning_effort"] = "none"
            else:
                body["reasoning_effort"] = reasoning_effort
        elif provider == "cerebras" and "glm" in (model_id or "").lower():
            # GLM-4.7 (zai-glm-4.7) on Cerebras is a reasoning model
            # by default — voice agents want it OFF or every reply
            # burns hundreds of tokens (and ~2-5 s of TTFT) on the
            # thinking pass. GLM accepts ``reasoning_effort="none"``
            # for a clean non-reasoning path. gpt-oss-120b in the
            # same Cerebras family does NOT accept "none" (only
            # low/medium/high), so we narrow the injection to model
            # ids containing "glm".
            if reasoning_effort is None:
                body["reasoning_effort"] = "none"
            else:
                body["reasoning_effort"] = reasoning_effort
    if tools:
        body["tools"] = tools
        body["tool_choice"] = tool_choice

    # Accumulate tool-call deltas keyed by ``index`` so we can emit each
    # complete call when the stream finishes. The OpenAI streaming
    # protocol fragments ``function.arguments`` across many chunks; we
    # concatenate them in arrival order.
    tool_calls_accum: dict[int, dict[str, str]] = {}
    # Indices for which we've already emitted ``tool_call_started`` so
    # we don't fire it once per argument chunk. The signal lets the UI
    # render an "Apply (preparing…)" affordance the moment the model
    # commits to calling a tool, instead of waiting for the full
    # arguments string to finish streaming (which can take seconds for
    # large structured outputs).
    tool_call_started_signaled: set[int] = set()
    finish_reason: str | None = None

    timeout = aiohttp.ClientTimeout(total=None, sock_connect=15, sock_read=60)
    t0 = time.monotonic()
    ttft_ms: int | None = None
    http_status: int | None = None
    log_status = "error"
    err: str | None = None
    usage: dict | None = None
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.post(url, headers=headers, json=body) as resp:
                http_status = resp.status
                if resp.status != 200:
                    snippet = (await resp.read())[:400].decode("utf-8", errors="replace")
                    raise RuntimeError(f"{provider} stream returned {resp.status}: {snippet}")
                async for raw in resp.content:
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if data == "[DONE]":
                        break
                    try:
                        obj = json.loads(data)
                    except Exception:
                        continue
                    # The final usage chunk on OpenAI-compatible providers
                    # has an empty ``choices`` array. Capture usage and
                    # then ``continue`` (no deltas to emit).
                    u = obj.get("usage")
                    if isinstance(u, dict) and u:
                        usage = u
                    choices = obj.get("choices") or []
                    if not choices:
                        continue
                    c0 = choices[0] or {}
                    fr = c0.get("finish_reason")
                    if fr:
                        finish_reason = fr
                    delta = c0.get("delta") or {}
                    # Content tokens — yield immediately so TTS can sentence-
                    # chunk them with no buffering on our side.
                    content = delta.get("content")
                    if isinstance(content, str) and content:
                        if ttft_ms is None:
                            ttft_ms = int((time.monotonic() - t0) * 1000)
                        yield {"type": "content", "text": content}
                    # Tool-call deltas — accumulate, don't emit the full
                    # call yet, but DO signal the moment we first see a
                    # tool name + id so the UI can render an
                    # "Apply (preparing…)" affordance while arguments
                    # are still streaming in.
                    for tcd in (delta.get("tool_calls") or []):
                        idx = int(tcd.get("index", 0))
                        acc = tool_calls_accum.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                        if tcd.get("id"):
                            acc["id"] = tcd["id"]
                        fn = tcd.get("function") or {}
                        if fn.get("name"):
                            acc["name"] = fn["name"]
                        args_chunk = fn.get("arguments")
                        if isinstance(args_chunk, str):
                            acc["arguments"] += args_chunk
                        # First-sighting signal: yield once per index as
                        # soon as we have BOTH name and id populated.
                        # Skip if already signaled — accumulated args
                        # chunks would otherwise re-fire this every
                        # delta.
                        if (
                            idx not in tool_call_started_signaled
                            and acc.get("name") and acc.get("id")
                        ):
                            tool_call_started_signaled.add(idx)
                            yield {
                                "type": "tool_call_started",
                                "tool_call": {"id": acc["id"], "name": acc["name"]},
                            }
                log_status = "ok"
    except Exception as exc:
        err = str(exc)
        raise
    finally:
        u = usage or {}
        _record_llm_call(
            provider=provider, model=model_id, mode="stream",
            status=log_status, http_status=http_status,
            latency_ms=int((time.monotonic() - t0) * 1000),
            ttft_ms=ttft_ms,
            prompt_tokens=u.get("prompt_tokens"),
            completion_tokens=u.get("completion_tokens"),
            total_tokens=u.get("total_tokens"),
            fallback_from=fallback_from,
            fallback_reason=fallback_reason,
            error_message=err,
        )

    # Stream done — emit any accumulated tool calls in index order, then
    # the terminal done event so the caller can decide whether to loop.
    for idx in sorted(tool_calls_accum.keys()):
        tc = tool_calls_accum[idx]
        if tc.get("name"):  # skip incomplete frames
            yield {"type": "tool_call", "tool_call": tc}
    yield {"type": "done", "finish_reason": finish_reason or "stop"}
