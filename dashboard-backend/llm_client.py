"""Unified LLM client for the dashboard backend.

Routes every LLM call to one of two providers:

  1. **Local Qwen3-4B service** (preferred) — when ``LOCAL_LLM_BASE_URL`` is
     set in the environment. Uses the four-route contract documented in
     /workspace/qwen-8m-streaming-llm/small/README.md:
         POST /v1/no-think          (non-streaming, fast)
         POST /v1/think             (non-streaming, with chain-of-thought)
         POST /v1/stream/no-think   (SSE streaming, fast)
         POST /v1/stream/think      (SSE streaming, with chain-of-thought)
     Request body: {"messages": [...], "max_tokens": N, "temperature": F}.
     Response: OpenAI chat-completions-compatible shape.

  2. **Chutes hosted LLM** (fallback) — when LOCAL_LLM_BASE_URL is empty.
     Uses the existing OpenAI-compatible POST {VOICE_DESIGN_LLM_BASE_URL}
     /chat/completions with VOICECHAT_LLM_MODEL / VOICE_DESIGN_LLM_MODEL.

Public API (provider-agnostic):

    chat_complete(messages, *, temperature, max_tokens, think=None, model=None) -> str
    chat_complete_json(messages, ...) -> dict   (parses JSON from the content)
    stream_chat(messages, ...) -> AsyncIterator[str]   (yields content deltas)

The Chutes path is preserved so we can fall back automatically if the
local service is unreachable, and so any non-default model selections
(e.g. picking a specific Chutes model in agent config) keep working.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from typing import AsyncIterator, Optional

import aiohttp

from studio_tts_service import CHUTES_AUTH_KEY, VOICE_DESIGN_LLM_BASE_URL


_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

# Local LLM endpoint (Qwen3-4B). When set, takes priority for every call.
LOCAL_LLM_BASE_URL = (os.environ.get("LOCAL_LLM_BASE_URL") or "").strip().rstrip("/")
LOCAL_LLM_API_KEY = (os.environ.get("LOCAL_LLM_API_KEY") or "").strip()
LOCAL_LLM_TIMEOUT_SEC = float(os.environ.get("LOCAL_LLM_TIMEOUT_SEC") or "120")
# Default to no-think for speed; flip to 1 if you want chain-of-thought everywhere.
_LOCAL_LLM_USE_THINK_DEFAULT = (os.environ.get("LOCAL_LLM_USE_THINK") or "").strip().lower() in (
    "1", "true", "yes", "on",
)
# When the local service is unreachable / errors, automatically retry against Chutes.
LLM_FALLBACK_TO_CHUTES = (os.environ.get("LLM_FALLBACK_TO_CHUTES") or "1").strip().lower() in (
    "1", "true", "yes", "on",
)

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


def llm_configured() -> bool:
    return local_llm_configured() or chutes_llm_configured()


def llm_provider() -> str:
    return "local" if local_llm_configured() else ("chutes" if chutes_llm_configured() else "none")


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
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url, headers=_local_headers(), json=body) as resp:
            raw = await resp.read()
            if resp.status != 200:
                snippet = raw[:400].decode("utf-8", errors="replace")
                raise RuntimeError(f"local LLM returned {resp.status}: {snippet}")
            try:
                obj = json.loads(raw.decode("utf-8"))
            except Exception as exc:
                raise RuntimeError(f"local LLM returned non-JSON: {exc}")
            content = _extract_content(obj)
            if not content:
                raise RuntimeError(f"local LLM returned empty content; payload={str(obj)[:300]}")
            return content


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
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url, headers=_chutes_headers(), json=body) as resp:
            raw = await resp.read()
            if resp.status != 200:
                snippet = raw[:400].decode("utf-8", errors="replace")
                raise RuntimeError(f"chutes LLM returned {resp.status}: {snippet}")
            try:
                obj = json.loads(raw.decode("utf-8"))
            except Exception as exc:
                raise RuntimeError(f"chutes LLM returned non-JSON: {exc}")
            content = _extract_content(obj)
            if not content:
                raise RuntimeError("chutes LLM returned empty content")
            return content


async def chat_complete(
    messages: list[dict],
    *,
    temperature: float = 0.4,
    max_tokens: int = 1500,
    think: bool | None = None,
    model: str | None = None,
    retries: int = 1,
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
        # Caller explicitly wants a specific Chutes model — use Chutes.
        return await _retry(
            lambda: _chutes_chat_complete(messages, temperature=temperature, max_tokens=max_tokens, model=model),
            retries,
        )

    if local_llm_configured():
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
) -> dict:
    """Convenience: take the assistant content and parse it as a JSON object."""
    content = await chat_complete(
        messages,
        temperature=temperature,
        max_tokens=max_tokens,
        think=think,
        model=model,
        retries=retries,
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
    timeout = aiohttp.ClientTimeout(total=LOCAL_LLM_TIMEOUT_SEC)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url, headers=headers, json=body) as resp:
            if resp.status != 200:
                snippet = (await resp.read())[:400].decode("utf-8", errors="replace")
                raise RuntimeError(f"local LLM stream returned {resp.status}: {snippet}")
            async for delta in _iter_sse_content(resp):
                yield delta


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
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    headers = {**_chutes_headers(), "Accept": "text/event-stream"}
    timeout = aiohttp.ClientTimeout(total=LOCAL_LLM_TIMEOUT_SEC)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.post(url, headers=headers, json=body) as resp:
            if resp.status != 200:
                snippet = (await resp.read())[:400].decode("utf-8", errors="replace")
                raise RuntimeError(f"chutes LLM stream returned {resp.status}: {snippet}")
            async for delta in _iter_sse_content(resp):
                yield delta


async def _iter_sse_content(resp: aiohttp.ClientResponse) -> AsyncIterator[str]:
    """Iterate SSE events from a streaming chat-completions response.

    Stops on either provider's end-of-stream sentinel:
      • OpenAI (Chutes): ``data: [DONE]``
      • Local Qwen3-4B:  ``data: {"event":"done", ...}``
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
        async for d in _chutes_stream_chat(messages, temperature=temperature, max_tokens=max_tokens, model=model):
            yield d
        return

    if local_llm_configured():
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

    async for d in _chutes_stream_chat(messages, temperature=temperature, max_tokens=max_tokens, model=None):
        yield d
