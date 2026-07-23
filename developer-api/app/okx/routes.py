"""OKX MCP merchant surface.

Three things an OKX buyer agent (or the marketplace) touches:

    GET  /okx/manifest            — discovery: tools, schemas, prices, payTo
    POST /okx/tools/{tool_name}   — execute one tool (x402-priced per call)
    POST /okx/mcp                 — MCP JSON-RPC (tools/list, tools/call)

The x402 middleware (app/okx/payments.py) gates the /okx/tools/* routes at the
HTTP layer: a call with no payment gets a 402 challenge; a settled call reaches
the handler. The handler then fulfills via the system-key proxy. The JSON-RPC
endpoint dispatches tools/call to the same HTTP route so payment is enforced
identically no matter how the agent reaches us.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from jsonschema import Draft7Validator

from . import config
from .payments import price_for
from .proxy import ToolExecutionError, execute_tool, fetch_dub_status
from .tools import TOOLS, TOOLS_BY_NAME, Tool

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/okx", tags=["okx-mcp"])


# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------


def _tool_manifest(tool: Tool) -> dict:
    entry: dict[str, Any] = {
        "name": tool.name,
        "title": tool.title,
        "description": tool.description,
        "input_schema": tool.input_schema,
        "endpoint": f"/okx/tools/{tool.name}",
        "tags": tool.tags,
    }
    if tool.metered:
        entry["pricing"] = {
            "model": "per_minute_per_language",
            "usd_per_minute": config.PRICE_VIDEO_DUB_PER_MIN,
            "usd_per_minute_lipsync": config.PRICE_VIDEO_DUB_LIPSYNC_PER_MIN,
        }
        # Async tool: the paid call returns a job_id; poll here for free.
        entry["status_endpoint"] = f"/okx/tools/{tool.name}/jobs/{{job_id}}"
    else:
        entry["pricing"] = {"model": "per_call", "usd": tool.price}
    return entry


@router.get("/manifest", summary="Discover Vocence's MCP tools, schemas and prices")
async def manifest() -> dict:
    """Static discovery document for the marketplace listing and buyer agents.

    Always available, even before payments are wired, so the listing can be
    reviewed and the schemas inspected. ``payments_ready`` tells a caller
    whether paid calls will currently settle.
    """
    return {
        "provider": "Vocence",
        "description": "Decentralized voice AI: TTS, STT, voice cloning, voice design, dubbing, denoise.",
        "protocol": "a2mcp",
        "payment": {
            "scheme": "x402",
            "network": config.OKX_NETWORK,
            "pay_to": config.PAY_TO_ADDRESS or None,
            "currency": "USD (settled as X Layer stablecoin)",
        },
        "payments_ready": config.okx_enabled() and config.payments_configured(),
        "tools": [_tool_manifest(t) for t in TOOLS],
    }


# ---------------------------------------------------------------------------
# Execution
# ---------------------------------------------------------------------------


def _validate(tool: Tool, arguments: dict) -> None:
    errors = sorted(Draft7Validator(tool.input_schema).iter_errors(arguments), key=lambda e: e.path)
    if errors:
        raise HTTPException(400, f"Invalid arguments for {tool.name}: {errors[0].message}")


async def _run(tool: Tool, arguments: dict) -> dict:
    if not config.okx_enabled():
        raise HTTPException(503, "This service is not currently accepting requests.")
    _validate(tool, arguments)
    try:
        result = await execute_tool(tool, arguments)
    except ToolExecutionError as exc:
        raise HTTPException(exc.status, exc.message) from exc
    return {"tool": tool.name, "result": result}


@router.post("/tools/{tool_name}", summary="Execute a Vocence tool (paid per call via x402)")
async def call_tool(tool_name: str, request: Request) -> dict:
    """Payable execution endpoint. The x402 middleware has already settled
    payment by the time this runs (when the gate is active)."""
    tool = TOOLS_BY_NAME.get(tool_name)
    if not tool:
        raise HTTPException(404, f"Unknown tool: {tool_name}")
    try:
        arguments = await request.json()
    except Exception:
        arguments = {}
    if not isinstance(arguments, dict):
        raise HTTPException(400, "Request body must be a JSON object of tool arguments.")
    return await _run(tool, arguments)


@router.get(
    "/tools/vocence_video_dub/jobs/{job_id}",
    summary="Poll a paid dubbing job (free)",
)
async def dub_job_status(job_id: str) -> dict:
    """Dubbing is async: the paid call returns a ``job_id``; this endpoint polls
    it for free until the results (video URLs) are ready. It is a GET, so the
    x402 gate — which prices ``POST /okx/tools/*`` — never charges for polling.
    """
    if not config.okx_enabled():
        raise HTTPException(503, "This service is not currently accepting requests.")
    try:
        job = await fetch_dub_status(job_id)
    except ToolExecutionError as exc:
        raise HTTPException(exc.status, exc.message) from exc
    # Buyer-relevant fields only — internal payload (storage keys, tier
    # bookkeeping) stays inside.
    return {
        k: job.get(k)
        for k in ("id", "job_id", "status", "phase", "result", "error_message",
                  "queue_position", "created_at", "finished_at")
        if k in job
    }


# ---------------------------------------------------------------------------
# MCP JSON-RPC (tools/list, tools/call)
# ---------------------------------------------------------------------------


def _rpc_ok(rpc_id: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": rpc_id, "result": result}


def _rpc_err(rpc_id: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": rpc_id, "error": {"code": code, "message": message}}


@router.post("/mcp", summary="MCP JSON-RPC endpoint (tools/list, tools/call)")
async def mcp_rpc(request: Request) -> dict:
    """Minimal MCP server surface for MCP-native clients.

    Supports ``tools/list`` and ``tools/call``. Payment for ``tools/call`` is
    enforced by the same x402 gate on ``/okx/tools/*`` — this endpoint dispatches
    there rather than duplicating the pay logic. A call arriving here without a
    settled payment therefore surfaces the underlying 402/503.
    """
    try:
        req = await request.json()
    except Exception:
        return _rpc_err(None, -32700, "Parse error")

    rpc_id = req.get("id")
    method = req.get("method")

    if method == "tools/list":
        return _rpc_ok(rpc_id, {"tools": [
            {"name": t.name, "title": t.title, "description": t.description, "inputSchema": t.input_schema}
            for t in TOOLS
        ]})

    if method == "tools/call":
        params = req.get("params") or {}
        name = params.get("name")
        arguments = params.get("arguments") or {}
        tool = TOOLS_BY_NAME.get(name)
        if not tool:
            return _rpc_err(rpc_id, -32602, f"Unknown tool: {name}")
        if not isinstance(arguments, dict):
            return _rpc_err(rpc_id, -32602, "arguments must be an object")
        try:
            out = await _run(tool, arguments)
        except HTTPException as exc:
            # 402 stays a payment signal; everything else is a tool error.
            code = -32000 if exc.status_code != 402 else -32001
            return _rpc_err(rpc_id, code, f"{exc.status_code}: {exc.detail}")
        # MCP content envelope.
        return _rpc_ok(rpc_id, {"content": [{"type": "text", "text": _json_text(out)}], "isError": False})

    return _rpc_err(rpc_id, -32601, f"Method not found: {method}")


def _json_text(obj: Any) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False)


# Re-export so main.py can price the metered tool if it wants; kept close to the
# route that uses it.
__all__ = ["router", "price_for"]
