"""Admin endpoints for LLM call analytics + pricing administration.

All routes gate on ``require_admin_unlocked`` (the same dual-layer
admin/sudo check used by /ops/*). Read endpoints are paginated and
filterable by time window, provider, and status. Writes (pricing CRUD)
are audit-logged via ``log_admin_action``.

Mounted at /api/dashboard/ops/llm/*.

Endpoints
---------
GET    /ops/llm/overview?range=24h|7d|30d
       -> Top-line stat cards: total calls, total cost USD,
          ok / error / rate-limited / timed-out counts, fallback count,
          avg latency, avg TTFT, p95 latency.

GET    /ops/llm/by-provider?range=...
       -> Per-provider breakdown: same metrics as overview,
          grouped by provider. Sorted by call count desc.

GET    /ops/llm/by-model?range=...&provider=...
       -> Per-model breakdown within (optional) provider filter.

GET    /ops/llm/failures?range=...&limit=200
       -> Most-recent failed calls (status != 'ok'). Each row carries
          the truncated error_message so admins can see the WHY at a
          glance; full text on click-through.

GET    /ops/llm/fallbacks?range=...
       -> Fallback chain analytics: which fallback_from/fallback_reason
          combos fired, how often, with success rate of the fallback rung.

GET    /ops/llm/timeseries?range=...&bucket=1h|1d&provider=...
       -> Stacked time series (calls / errors / cost) for charting.

GET    /ops/llm/pricing
       -> Full pricing table (all providers + models). Includes active=0
          rows so the admin can re-activate or compare to historical.

PUT    /ops/llm/pricing
       body: {provider, model, input_per_1m, output_per_1m, notes?, active?}
       -> Upsert one row. Updates the cache.

DELETE /ops/llm/pricing/{provider}/{model}
       -> Soft-delete (sets active=0). Historical llm_calls rows keep
          their cost_usd snapshot — only future calls are affected.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from local_db import get_connection, log_admin_action
from llm_logging import invalidate_pricing_cache
from routers.admin_auth import require_admin_unlocked


_log = logging.getLogger(__name__)
router = APIRouter(prefix="/ops/llm", tags=["ops-llm"])


_VALID_RANGES = {"1h": "-1 hours", "24h": "-1 days", "7d": "-7 days", "30d": "-30 days"}


def _range_clause(range_param: str) -> tuple[str, str]:
    """Return (sql_modifier, human_label) for range param. Defaults
    to 24h if the value is unrecognised so a typo doesn't 500."""
    return _VALID_RANGES.get(range_param, "-1 days"), range_param


# ---------------------------------------------------------------------------
# Overview
# ---------------------------------------------------------------------------

@router.get("/overview")
async def llm_overview(
    range: str = Query("24h"),
    _: str = Depends(require_admin_unlocked),
) -> dict:
    modifier, label = _range_clause(range)
    conn = await get_connection()
    try:
        cur = await conn.execute(
            f"""
            SELECT
                COUNT(*)                                                    AS calls,
                SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)              AS ok,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)           AS errors,
                SUM(CASE WHEN status = 'empty' THEN 1 ELSE 0 END)           AS empties,
                SUM(rate_limited)                                           AS rate_limited,
                SUM(timed_out)                                              AS timed_out,
                SUM(CASE WHEN fallback_from IS NOT NULL THEN 1 ELSE 0 END)  AS fallback_calls,
                COALESCE(SUM(cost_usd), 0.0)                                AS cost_usd,
                COALESCE(SUM(prompt_tokens), 0)                             AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0)                         AS completion_tokens,
                COALESCE(SUM(total_tokens), 0)                              AS total_tokens,
                AVG(latency_ms)                                             AS avg_latency_ms,
                AVG(ttft_ms)                                                AS avg_ttft_ms
            FROM llm_calls
            WHERE created_at >= datetime('now', '{modifier}')
            """
        )
        row = await cur.fetchone()
        # p95 latency via percentile pick — SQLite doesn't have native
        # PERCENTILE_CONT, so we approximate by reading nth-row from an
        # ordered subset. Cheap enough for a window of ~10k rows.
        cur2 = await conn.execute(
            f"""
            SELECT latency_ms
            FROM llm_calls
            WHERE created_at >= datetime('now', '{modifier}')
              AND latency_ms IS NOT NULL
            ORDER BY latency_ms ASC
            """
        )
        latencies = [r["latency_ms"] for r in await cur2.fetchall()]
        p95_latency_ms = None
        if latencies:
            idx = max(0, int(len(latencies) * 0.95) - 1)
            p95_latency_ms = latencies[idx]
        return {
            "range": label,
            "calls": row["calls"] or 0,
            "ok": row["ok"] or 0,
            "errors": row["errors"] or 0,
            "empties": row["empties"] or 0,
            "rate_limited": row["rate_limited"] or 0,
            "timed_out": row["timed_out"] or 0,
            "fallback_calls": row["fallback_calls"] or 0,
            "cost_usd": round(row["cost_usd"] or 0.0, 4),
            "prompt_tokens": row["prompt_tokens"] or 0,
            "completion_tokens": row["completion_tokens"] or 0,
            "total_tokens": row["total_tokens"] or 0,
            "avg_latency_ms": int(row["avg_latency_ms"]) if row["avg_latency_ms"] is not None else None,
            "avg_ttft_ms": int(row["avg_ttft_ms"]) if row["avg_ttft_ms"] is not None else None,
            "p95_latency_ms": p95_latency_ms,
        }
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# By-provider / by-model breakdowns
# ---------------------------------------------------------------------------

async def _breakdown(conn, modifier: str, group_cols: str, where_extra: str, params: list) -> list[dict]:
    cur = await conn.execute(
        f"""
        SELECT
            {group_cols},
            COUNT(*)                                                    AS calls,
            SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)              AS ok,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END)           AS errors,
            SUM(rate_limited)                                           AS rate_limited,
            SUM(timed_out)                                              AS timed_out,
            SUM(CASE WHEN fallback_from IS NOT NULL THEN 1 ELSE 0 END)  AS fallback_calls,
            COALESCE(SUM(cost_usd), 0.0)                                AS cost_usd,
            COALESCE(SUM(total_tokens), 0)                              AS total_tokens,
            AVG(latency_ms)                                             AS avg_latency_ms,
            AVG(ttft_ms)                                                AS avg_ttft_ms
        FROM llm_calls
        WHERE created_at >= datetime('now', '{modifier}')
            {where_extra}
        GROUP BY {group_cols}
        ORDER BY calls DESC
        """,
        params,
    )
    rows = await cur.fetchall()
    out = []
    for r in rows:
        d = dict(r)
        if d.get("avg_latency_ms") is not None:
            d["avg_latency_ms"] = int(d["avg_latency_ms"])
        if d.get("avg_ttft_ms") is not None:
            d["avg_ttft_ms"] = int(d["avg_ttft_ms"])
        d["cost_usd"] = round(d["cost_usd"], 4)
        out.append(d)
    return out


@router.get("/by-provider")
async def llm_by_provider(
    range: str = Query("24h"),
    _: str = Depends(require_admin_unlocked),
) -> dict:
    modifier, label = _range_clause(range)
    conn = await get_connection()
    try:
        rows = await _breakdown(conn, modifier, "provider", "", [])
        return {"range": label, "rows": rows}
    finally:
        await conn.close()


@router.get("/by-model")
async def llm_by_model(
    range: str = Query("24h"),
    provider: str | None = Query(None),
    _: str = Depends(require_admin_unlocked),
) -> dict:
    modifier, label = _range_clause(range)
    where = ""
    params: list = []
    if provider:
        where = " AND provider = ?"
        params.append(provider)
    conn = await get_connection()
    try:
        rows = await _breakdown(conn, modifier, "provider, model", where, params)
        return {"range": label, "provider": provider, "rows": rows}
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Failures + fallback chains
# ---------------------------------------------------------------------------

@router.get("/failures")
async def llm_failures(
    range: str = Query("24h"),
    limit: int = Query(200, ge=1, le=2000),
    _: str = Depends(require_admin_unlocked),
) -> dict:
    modifier, label = _range_clause(range)
    conn = await get_connection()
    try:
        cur = await conn.execute(
            f"""
            SELECT id, provider, model, mode, status, http_status,
                   rate_limited, timed_out, latency_ms, ttft_ms,
                   prompt_tokens, completion_tokens, fallback_from,
                   fallback_reason, error_message, created_at
            FROM llm_calls
            WHERE created_at >= datetime('now', '{modifier}')
              AND status != 'ok'
            ORDER BY created_at DESC
            LIMIT ?
            """,
            [limit],
        )
        rows = [dict(r) for r in await cur.fetchall()]
        # Top error-message buckets across the window — most useful single
        # number for "what's failing right now". Coarse string-prefix
        # grouping is more useful than exact match (different request IDs
        # would otherwise split the same root cause).
        cur2 = await conn.execute(
            f"""
            SELECT SUBSTR(error_message, 1, 80) AS err_prefix,
                   COUNT(*) AS count,
                   provider,
                   model
            FROM llm_calls
            WHERE created_at >= datetime('now', '{modifier}')
              AND status != 'ok'
              AND error_message IS NOT NULL
            GROUP BY err_prefix, provider, model
            ORDER BY count DESC
            LIMIT 20
            """
        )
        top_errors = [dict(r) for r in await cur2.fetchall()]
        return {"range": label, "rows": rows, "top_errors": top_errors}
    finally:
        await conn.close()


@router.get("/fallbacks")
async def llm_fallbacks(
    range: str = Query("24h"),
    _: str = Depends(require_admin_unlocked),
) -> dict:
    """Fallback ladder analytics: which (from -> to) hops fired and
    what fraction recovered. Use this to spot when one provider's
    rate-limit / downtime is silently masked by the fallback."""
    modifier, label = _range_clause(range)
    conn = await get_connection()
    try:
        cur = await conn.execute(
            f"""
            SELECT
                fallback_from                                                AS from_provider,
                provider                                                     AS to_provider,
                fallback_reason                                              AS reason,
                COUNT(*)                                                     AS hops,
                SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END)               AS recovered,
                COALESCE(SUM(cost_usd), 0.0)                                 AS cost_usd
            FROM llm_calls
            WHERE created_at >= datetime('now', '{modifier}')
              AND fallback_from IS NOT NULL
            GROUP BY fallback_from, provider, fallback_reason
            ORDER BY hops DESC
            """
        )
        rows = []
        for r in await cur.fetchall():
            d = dict(r)
            d["recovery_rate"] = round((d["recovered"] or 0) / d["hops"], 3) if d["hops"] else None
            d["cost_usd"] = round(d["cost_usd"], 4)
            rows.append(d)
        return {"range": label, "rows": rows}
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Time series — used to draw stacked area / line charts
# ---------------------------------------------------------------------------

@router.get("/timeseries")
async def llm_timeseries(
    range: str = Query("24h"),
    bucket: str = Query("1h"),
    provider: str | None = Query(None),
    _: str = Depends(require_admin_unlocked),
) -> dict:
    """Bucketed time series for charts. ``bucket=1h`` groups by hour,
    ``bucket=1d`` groups by day. Returns one row per bucket with
    calls / errors / rate_limited / cost / avg_latency. Optional
    provider filter for per-provider chart drilldowns."""
    modifier, label = _range_clause(range)
    if bucket == "1d":
        bucket_expr = "strftime('%Y-%m-%d', created_at)"
    else:
        bucket_expr = "strftime('%Y-%m-%dT%H:00:00', created_at)"
    where = ""
    params: list = []
    if provider:
        where = " AND provider = ?"
        params.append(provider)
    conn = await get_connection()
    try:
        cur = await conn.execute(
            f"""
            SELECT
                {bucket_expr}                                                AS bucket,
                COUNT(*)                                                     AS calls,
                SUM(CASE WHEN status != 'ok' THEN 1 ELSE 0 END)              AS errors,
                SUM(rate_limited)                                            AS rate_limited,
                SUM(timed_out)                                               AS timed_out,
                COALESCE(SUM(cost_usd), 0.0)                                 AS cost_usd,
                AVG(latency_ms)                                              AS avg_latency_ms,
                AVG(ttft_ms)                                                 AS avg_ttft_ms
            FROM llm_calls
            WHERE created_at >= datetime('now', '{modifier}')
                {where}
            GROUP BY bucket
            ORDER BY bucket ASC
            """,
            params,
        )
        rows = []
        for r in await cur.fetchall():
            d = dict(r)
            if d.get("avg_latency_ms") is not None:
                d["avg_latency_ms"] = int(d["avg_latency_ms"])
            if d.get("avg_ttft_ms") is not None:
                d["avg_ttft_ms"] = int(d["avg_ttft_ms"])
            d["cost_usd"] = round(d["cost_usd"], 4)
            rows.append(d)
        return {"range": label, "bucket": bucket, "provider": provider, "rows": rows}
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Pricing CRUD
# ---------------------------------------------------------------------------

class PricingUpsert(BaseModel):
    provider: str = Field(..., min_length=1, max_length=40)
    model: str = Field(..., min_length=1, max_length=120)
    input_per_1m: float = Field(..., ge=0.0)
    output_per_1m: float = Field(..., ge=0.0)
    notes: str | None = Field(None, max_length=400)
    active: int = Field(1, ge=0, le=1)


@router.get("/pricing")
async def list_pricing(_: str = Depends(require_admin_unlocked)) -> dict:
    conn = await get_connection()
    try:
        cur = await conn.execute(
            """
            SELECT provider, model, input_per_1m, output_per_1m,
                   notes, active, updated_at
            FROM llm_pricing
            ORDER BY active DESC, provider ASC, model ASC
            """
        )
        return {"rows": [dict(r) for r in await cur.fetchall()]}
    finally:
        await conn.close()


@router.put("/pricing")
async def upsert_pricing(
    body: PricingUpsert,
    admin_email: str = Depends(require_admin_unlocked),
) -> dict:
    conn = await get_connection()
    try:
        await conn.execute(
            """
            INSERT INTO llm_pricing
                (provider, model, input_per_1m, output_per_1m, notes, active, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT (provider, model) DO UPDATE SET
                input_per_1m = excluded.input_per_1m,
                output_per_1m = excluded.output_per_1m,
                notes = excluded.notes,
                active = excluded.active,
                updated_at = datetime('now')
            """,
            (body.provider, body.model, body.input_per_1m, body.output_per_1m,
             body.notes, body.active),
        )
        await log_admin_action(
            conn,
            admin_email=admin_email,
            action="llm_pricing.upsert",
            target_type="llm_pricing",
            target_id=f"{body.provider}/{body.model}",
            metadata={
                "input_per_1m": body.input_per_1m,
                "output_per_1m": body.output_per_1m,
                "active": body.active,
            },
        )
        await conn.commit()
        invalidate_pricing_cache()
        return {"ok": True}
    finally:
        await conn.close()


@router.delete("/pricing/{provider}/{model:path}")
async def deactivate_pricing(
    provider: str,
    model: str,
    admin_email: str = Depends(require_admin_unlocked),
) -> dict:
    """Soft-delete via active=0. Historical llm_calls.cost_usd is
    preserved (it was snapshot at write time)."""
    conn = await get_connection()
    try:
        cur = await conn.execute(
            "UPDATE llm_pricing SET active = 0, updated_at = datetime('now') WHERE provider = ? AND model = ?",
            (provider, model),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="pricing row not found")
        await log_admin_action(
            conn,
            admin_email=admin_email,
            action="llm_pricing.deactivate",
            target_type="llm_pricing",
            target_id=f"{provider}/{model}",
        )
        await conn.commit()
        invalidate_pricing_cache()
        return {"ok": True}
    finally:
        await conn.close()
