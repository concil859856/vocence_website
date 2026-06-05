"""LLM call telemetry — every provider call from ``llm_client.py`` records
one row in the ``llm_calls`` table so admins can see per-provider cost,
failure rates, rate-limit events, fallback chains, and latency tails.

Design constraints:

  • **Fire-and-forget.** ``record_call`` returns immediately; the actual
    DB write is scheduled on the event loop. An LLM request must NEVER
    be slowed or broken by telemetry overhead or DB unavailability.

  • **Silent on failure.** Any exception from the write path is logged
    at WARN and swallowed — telemetry failure can't propagate to
    callers. This matters for streaming where the `finally:` is on
    a hot path.

  • **In-memory price cache.** Cost lookup happens on every call. We
    cache the entire ``llm_pricing`` table in memory and refresh every
    ``_PRICING_REFRESH_SECONDS``. Admin edits via the UI bypass the
    cache via ``invalidate_pricing_cache()``.

  • **Seed on startup, not on import.** ``seed_default_pricing`` is
    called explicitly from app startup so the price rows exist for
    every known (provider, model) combination before the first call
    fires. Re-running it is a no-op (INSERT OR IGNORE).
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import Any

import aiosqlite

from local_db import get_connection


_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Pricing cache
# ---------------------------------------------------------------------------

# (provider, model) → (input_per_1m, output_per_1m). Refreshed lazily.
_PRICING_CACHE: dict[tuple[str, str], tuple[float, float]] = {}
_PRICING_LAST_REFRESH: float = 0.0
_PRICING_REFRESH_SECONDS = 60.0


async def _refresh_pricing_cache() -> None:
    global _PRICING_LAST_REFRESH
    try:
        conn = await get_connection()
        try:
            cur = await conn.execute(
                "SELECT provider, model, input_per_1m, output_per_1m FROM llm_pricing WHERE active = 1"
            )
            rows = await cur.fetchall()
            _PRICING_CACHE.clear()
            for r in rows:
                _PRICING_CACHE[(r["provider"], r["model"])] = (
                    float(r["input_per_1m"]),
                    float(r["output_per_1m"]),
                )
            _PRICING_LAST_REFRESH = time.monotonic()
        finally:
            await conn.close()
    except Exception as exc:  # noqa: BLE001 — never crash the caller
        _log.warning("llm_logging: pricing cache refresh failed: %s", exc)


def invalidate_pricing_cache() -> None:
    """Force the next ``_compute_cost`` to re-fetch. Call after admin
    edits to llm_pricing."""
    global _PRICING_LAST_REFRESH
    _PRICING_LAST_REFRESH = 0.0


async def _compute_cost(
    provider: str,
    model: str,
    prompt_tokens: int | None,
    completion_tokens: int | None,
) -> float | None:
    """Look up pricing and return USD cost. None when no price row
    matches (provider, model) — the row still records tokens, just no
    cost. Refreshes the cache if stale."""
    if prompt_tokens is None and completion_tokens is None:
        return None
    if time.monotonic() - _PRICING_LAST_REFRESH > _PRICING_REFRESH_SECONDS:
        await _refresh_pricing_cache()
    price = _PRICING_CACHE.get((provider, model))
    if not price:
        return None
    in_per_1m, out_per_1m = price
    cost = ((prompt_tokens or 0) / 1_000_000.0) * in_per_1m
    cost += ((completion_tokens or 0) / 1_000_000.0) * out_per_1m
    return round(cost, 6)


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------

def record_call(
    *,
    provider: str,
    model: str,
    mode: str,                            # 'chat' | 'stream'
    status: str,                          # 'ok' | 'error' | 'empty'
    http_status: int | None = None,
    latency_ms: int | None = None,
    ttft_ms: int | None = None,
    prompt_tokens: int | None = None,
    completion_tokens: int | None = None,
    total_tokens: int | None = None,
    fallback_from: str | None = None,
    fallback_reason: str | None = None,
    user_id: str | None = None,
    agent_id: str | None = None,
    error_message: str | None = None,
) -> None:
    """Schedule a write of one llm_calls row. Returns synchronously —
    the actual DB write runs as a background task on the current loop.

    Must NEVER raise. Safe to call from inside hot paths and finally
    blocks. If the loop isn't running (called outside an async context),
    the write is silently dropped — that only happens in tests where
    telemetry isn't the point.
    """
    try:
        loop = asyncio.get_event_loop()
        if not loop.is_running():
            return
        loop.create_task(
            _record_call_async(
                provider=provider,
                model=model,
                mode=mode,
                status=status,
                http_status=http_status,
                latency_ms=latency_ms,
                ttft_ms=ttft_ms,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                fallback_from=fallback_from,
                fallback_reason=fallback_reason,
                user_id=user_id,
                agent_id=agent_id,
                error_message=error_message,
            )
        )
    except Exception as exc:  # noqa: BLE001
        _log.warning("llm_logging.record_call schedule failed: %s", exc)


async def _record_call_async(**kw: Any) -> None:
    try:
        provider = kw["provider"]
        model = kw["model"]
        prompt_t = kw.get("prompt_tokens")
        completion_t = kw.get("completion_tokens")
        total_t = kw.get("total_tokens")
        if total_t is None and (prompt_t is not None or completion_t is not None):
            total_t = (prompt_t or 0) + (completion_t or 0)
        cost = await _compute_cost(provider, model, prompt_t, completion_t)
        http_status = kw.get("http_status")
        rate_limited = 1 if http_status == 429 else 0
        err = kw.get("error_message")
        timed_out = 1 if (err and "timeout" in err.lower()) else 0
        if err and len(err) > 500:
            err = err[:500]
        conn = await get_connection()
        try:
            await conn.execute(
                """
                INSERT INTO llm_calls (
                    id, provider, model, mode, status, http_status,
                    rate_limited, timed_out, latency_ms, ttft_ms,
                    prompt_tokens, completion_tokens, total_tokens, cost_usd,
                    fallback_from, fallback_reason, user_id, agent_id, error_message,
                    created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                """,
                (
                    uuid.uuid4().hex,
                    provider,
                    model,
                    kw.get("mode"),
                    kw.get("status"),
                    http_status,
                    rate_limited,
                    timed_out,
                    kw.get("latency_ms"),
                    kw.get("ttft_ms"),
                    prompt_t,
                    completion_t,
                    total_t,
                    cost,
                    kw.get("fallback_from"),
                    kw.get("fallback_reason"),
                    kw.get("user_id"),
                    kw.get("agent_id"),
                    err,
                ),
            )
            await conn.commit()
        finally:
            await conn.close()
    except Exception as exc:  # noqa: BLE001
        _log.warning("llm_logging.record_call write failed: %s", exc)


# ---------------------------------------------------------------------------
# Pricing seed
# ---------------------------------------------------------------------------

# Public-rate-card starting prices as of late 2025. Verify and edit via
# the admin UI — these are best-effort placeholders so cost charts show
# *something* on day one. Each note tells the admin what to verify.
_DEFAULT_PRICING: list[tuple[str, str, float, float, str]] = [
    # provider, model, $/1M input, $/1M output, note
    ("cerebras", "gpt-oss-120b",         0.40,  0.80, "verify on launch · Cerebras gpt-oss-120b"),
    ("cerebras", "llama-3.3-70b",        0.85,  1.20, "verify on launch · Cerebras Llama-3.3-70B"),
    ("xai",      "grok-4-0709",          3.00, 15.00, "verify on launch · xAI Grok 4"),
    ("xai",      "grok-4.20-0309-non-reasoning", 0.30, 0.50, "verify on launch · Grok-4.20 non-reasoning fallback model"),
    ("xai",      "grok-3-mini-fast",     0.30,  0.50, "verify on launch · Grok 3 Mini Fast"),
    ("groq",     "llama-3.3-70b-versatile", 0.59, 0.79, "verify on launch · Groq Llama-3.3-70B"),
    ("groq",     "llama-3.1-8b-instant", 0.05,  0.08, "verify on launch · Groq Llama-3.1-8B"),
    ("openai",   "gpt-4.1",              2.50, 10.00, "verify on launch · OpenAI gpt-4.1"),
    ("openai",   "gpt-4.1-mini",         0.40,  1.60, "verify on launch · OpenAI gpt-4.1-mini"),
    ("openai",   "gpt-5-mini",           0.40,  1.60, "verify on launch · OpenAI gpt-5-mini"),
    ("chutes",   "default",              0.00,  0.00, "Chutes default — confirm if billed; zero is a placeholder"),
    ("local",    "qwen3-4b",             0.00,  0.00, "self-hosted; energy cost not tracked here"),
]


async def seed_default_pricing(conn: aiosqlite.Connection | None = None) -> None:
    """Insert placeholder pricing for every known (provider, model) if
    they don't already exist. Safe to call on every startup."""
    own_conn = conn is None
    if own_conn:
        conn = await get_connection()
    try:
        for provider, model, in_p, out_p, note in _DEFAULT_PRICING:
            await conn.execute(
                """
                INSERT OR IGNORE INTO llm_pricing
                    (provider, model, input_per_1m, output_per_1m, notes, active, updated_at)
                VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
                """,
                (provider, model, in_p, out_p, note),
            )
        await conn.commit()
        invalidate_pricing_cache()
    except Exception as exc:  # noqa: BLE001
        _log.warning("llm_logging.seed_default_pricing failed: %s", exc)
    finally:
        if own_conn:
            await conn.close()
