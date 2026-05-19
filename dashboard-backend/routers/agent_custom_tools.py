"""Custom (user-defined) tool CRUD + dry-run executor.

Routes under ``/api/dashboard/agents/tools/custom``. Custom tools are
user-owned webhook endpoints the LLM can call mid-conversation —
mirrors what the Anthropic/OpenAI/Gemini SDKs ship as "function
calling," but with the function body running on the user's own
infrastructure instead of ours.

  Per the client spec (chat 5/12):
    > "We need to be able to register custom tools, tool calling is
    >  a paradigm supported by the output text modality from LLMs."

  The JSON Schema we accept for ``parameters`` is the one OpenAI/Groq/
  Anthropic all expect, so a tool registered here works identically
  on any modern LLM provider — the user defines it once, every voice
  agent can call it.

Endpoints:
  GET    /tools/custom                          list user's tools
  POST   /tools/custom                          create
  PATCH  /tools/custom/{tool_id}                update
  DELETE /tools/custom/{tool_id}                delete
  POST   /tools/custom/{tool_id}/test           dry-run with sample args
  GET    /{agent_id}/tools                      list tools bound to an agent
  POST   /{agent_id}/tools/{tool_id}            bind a tool to an agent
  DELETE /{agent_id}/tools/{tool_id}            unbind
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

import agent_tools_service
from local_db import get_connection
from routers.auth import require_auth

router = APIRouter(prefix="/agents", tags=["agent_tools"])


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

# Tool names are passed verbatim to the LLM as function names. OpenAI's
# /chat/completions enforces ^[a-zA-Z0-9_-]{1,64}$, so we mirror that.
_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")

# Reserved names (the built-in tools) — we reject collisions at create
# time so the user picks a unique name. They CAN shadow a built-in if
# they want to override it (different name + bind to agent), but it's
# explicit, not a silent overwrite.
_RESERVED_NAMES = set(agent_tools_service.all_tool_names())


def _validate_name(name: str) -> str:
    name = (name or "").strip()
    if not _NAME_RE.match(name):
        raise HTTPException(
            status_code=400,
            detail="name must match ^[a-zA-Z0-9_-]{1,64}$ (LLM function-name rule)",
        )
    if name in _RESERVED_NAMES:
        raise HTTPException(
            status_code=400,
            detail=f"name '{name}' is reserved by a built-in tool. Pick a different name.",
        )
    return name


def _validate_parameters_schema(schema: dict) -> dict:
    """Light validation of the JSON Schema. We don't fully validate
    every JSON Schema feature — the LLM's tool-call layer will error
    cleanly on broken schemas — but we do reject the obvious shapes
    that the LLM API rejects outright."""
    if not isinstance(schema, dict):
        raise HTTPException(status_code=400, detail="parameters must be a JSON object (JSON Schema)")
    if schema.get("type") not in (None, "object"):
        raise HTTPException(status_code=400, detail="parameters.type must be 'object' (or omitted)")
    # Normalise — every modern provider expects the outer object shape.
    out = dict(schema)
    out.setdefault("type", "object")
    out.setdefault("properties", {})
    if not isinstance(out["properties"], dict):
        raise HTTPException(status_code=400, detail="parameters.properties must be an object")
    return out


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------


class CustomToolCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(min_length=1, max_length=1024)
    parameters: dict = Field(default_factory=lambda: {"type": "object", "properties": {}})
    endpoint_url: str = Field(min_length=8, max_length=2048)
    method: str = Field(default="POST", pattern="^(POST|GET|PUT|PATCH|DELETE)$")
    auth_type: str = Field(default="none", pattern="^(none|bearer|header)$")
    auth_header_name: Optional[str] = None
    auth_secret: Optional[str] = None
    timeout_ms: int = Field(default=5000, ge=1000, le=30000)


class CustomToolPatchIn(BaseModel):
    description: Optional[str] = Field(default=None, max_length=1024)
    parameters: Optional[dict] = None
    endpoint_url: Optional[str] = Field(default=None, max_length=2048)
    method: Optional[str] = Field(default=None, pattern="^(POST|GET|PUT|PATCH|DELETE)$")
    auth_type: Optional[str] = Field(default=None, pattern="^(none|bearer|header)$")
    auth_header_name: Optional[str] = None
    auth_secret: Optional[str] = None
    timeout_ms: Optional[int] = Field(default=None, ge=1000, le=30000)


class CustomToolTestIn(BaseModel):
    arguments: dict = Field(default_factory=dict)


def _row_to_out(row, *, redact_secret: bool = True) -> dict:
    """Project a DB row to API shape. ``auth_secret`` is redacted in
    list/get responses — the user pasted it once, we don't need to
    hand it back over the wire."""
    try:
        params = json.loads(row["parameters_json"] or "{}")
    except json.JSONDecodeError:
        params = {"type": "object", "properties": {}}
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"] or "",
        "parameters": params,
        "endpoint_url": row["endpoint_url"],
        "method": row["method"] or "POST",
        "auth_type": row["auth_type"] or "none",
        "auth_header_name": row["auth_header_name"],
        # Don't leak secrets back to the client. ``has_secret`` flag
        # lets the UI show "[set]" instead of an empty field on edit.
        "has_secret": bool(row["auth_secret"]) if redact_secret else None,
        "auth_secret": None if redact_secret else row["auth_secret"],
        "timeout_ms": int(row["timeout_ms"] or 5000),
        "created_at": str(row["created_at"] or ""),
        "updated_at": str(row["updated_at"] or ""),
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@router.get("/tools/custom")
async def list_custom_tools(user_id: str = Depends(require_auth)) -> dict:
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            "SELECT * FROM agent_custom_tools WHERE user_id = ? ORDER BY datetime(created_at) DESC",
            (user_id,),
        )).fetchall()
    finally:
        await conn.close()
    return {"tools": [_row_to_out(r) for r in rows]}


@router.post("/tools/custom")
async def create_custom_tool(body: CustomToolCreateIn, user_id: str = Depends(require_auth)) -> dict:
    name = _validate_name(body.name)
    params = _validate_parameters_schema(body.parameters)
    # Block private/loopback/metadata IPs at create time so the user
    # gets the error here instead of mid-conversation.
    try:
        agent_tools_service.assert_safe_url(body.endpoint_url)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"endpoint_url is unsafe: {exc}")

    tool_id = uuid.uuid4().hex
    conn = await get_connection()
    try:
        try:
            await conn.execute(
                """
                INSERT INTO agent_custom_tools
                  (id, user_id, name, description, parameters_json, endpoint_url, method,
                   auth_type, auth_header_name, auth_secret, timeout_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    tool_id, user_id, name, body.description.strip(), json.dumps(params),
                    body.endpoint_url.strip(), body.method, body.auth_type,
                    body.auth_header_name, body.auth_secret, body.timeout_ms,
                ),
            )
            await conn.commit()
        except Exception as exc:
            msg = str(exc).lower()
            if "unique" in msg and "name" in msg:
                raise HTTPException(status_code=409, detail=f"you already have a tool named '{name}'")
            raise
        row = await (await conn.execute(
            "SELECT * FROM agent_custom_tools WHERE id = ?", (tool_id,),
        )).fetchone()
    finally:
        await conn.close()
    return {"tool": _row_to_out(row)}


@router.patch("/tools/custom/{tool_id}")
async def update_custom_tool(tool_id: str, body: CustomToolPatchIn, user_id: str = Depends(require_auth)) -> dict:
    conn = await get_connection()
    try:
        existing = await (await conn.execute(
            "SELECT * FROM agent_custom_tools WHERE id = ? AND user_id = ?", (tool_id, user_id),
        )).fetchone()
        if not existing:
            raise HTTPException(status_code=404, detail="custom tool not found")

        updates: list[str] = []
        params_sql: list[Any] = []
        if body.description is not None:
            updates.append("description = ?")
            params_sql.append(body.description.strip())
        if body.parameters is not None:
            valid_params = _validate_parameters_schema(body.parameters)
            updates.append("parameters_json = ?")
            params_sql.append(json.dumps(valid_params))
        if body.endpoint_url is not None:
            try:
                agent_tools_service.assert_safe_url(body.endpoint_url)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail=f"endpoint_url is unsafe: {exc}")
            updates.append("endpoint_url = ?")
            params_sql.append(body.endpoint_url.strip())
        if body.method is not None:
            updates.append("method = ?")
            params_sql.append(body.method)
        if body.auth_type is not None:
            updates.append("auth_type = ?")
            params_sql.append(body.auth_type)
        if body.auth_header_name is not None:
            updates.append("auth_header_name = ?")
            params_sql.append(body.auth_header_name)
        if body.auth_secret is not None:
            # Empty string = clear the secret; non-empty = replace.
            updates.append("auth_secret = ?")
            params_sql.append(body.auth_secret or None)
        if body.timeout_ms is not None:
            updates.append("timeout_ms = ?")
            params_sql.append(body.timeout_ms)

        if updates:
            updates.append("updated_at = datetime('now')")
            params_sql.append(tool_id)
            await conn.execute(
                f"UPDATE agent_custom_tools SET {', '.join(updates)} WHERE id = ?",
                params_sql,
            )
            await conn.commit()

        row = await (await conn.execute(
            "SELECT * FROM agent_custom_tools WHERE id = ?", (tool_id,),
        )).fetchone()
    finally:
        await conn.close()
    return {"tool": _row_to_out(row)}


@router.delete("/tools/custom/{tool_id}")
async def delete_custom_tool(tool_id: str, user_id: str = Depends(require_auth)) -> dict:
    conn = await get_connection()
    try:
        cursor = await conn.execute(
            "DELETE FROM agent_custom_tools WHERE id = ? AND user_id = ?",
            (tool_id, user_id),
        )
        await conn.commit()
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="custom tool not found")
    finally:
        await conn.close()
    return {"ok": True}


@router.post("/tools/custom/{tool_id}/test")
async def test_custom_tool(tool_id: str, body: CustomToolTestIn, user_id: str = Depends(require_auth)) -> dict:
    """Dry-run a custom tool with caller-supplied arguments. Same
    execution path the voicechat loop uses, so a successful test here
    proves the agent can actually invoke this tool live. Used by the
    frontend "Test" button on the tool form."""
    conn = await get_connection()
    try:
        row = await (await conn.execute(
            "SELECT * FROM agent_custom_tools WHERE id = ? AND user_id = ?", (tool_id, user_id),
        )).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="custom tool not found")
        try:
            params = json.loads(row["parameters_json"] or "{}")
        except json.JSONDecodeError:
            params = {}
        tool = agent_tools_service.CustomToolDef(
            id=row["id"], user_id=row["user_id"], name=row["name"],
            description=row["description"] or "", parameters=params,
            endpoint_url=row["endpoint_url"], method=row["method"] or "POST",
            auth_type=row["auth_type"] or "none",
            auth_header_name=row["auth_header_name"],
            auth_secret=row["auth_secret"],
            timeout_ms=int(row["timeout_ms"] or 5000),
        )
    finally:
        await conn.close()

    result_str = await agent_tools_service.dispatch_custom_tool(
        tool, json.dumps(body.arguments),
    )
    # Try to parse the result back so the UI can render it nicely;
    # fall back to raw string. The voicechat loop receives the same
    # string-only payload either way.
    try:
        result_obj = json.loads(result_str)
    except json.JSONDecodeError:
        result_obj = result_str
    return {"result": result_obj}


# ---------------------------------------------------------------------------
# Per-agent bindings
# ---------------------------------------------------------------------------


async def _assert_agent_owned(conn, agent_id: str, user_id: str) -> None:
    row = await (await conn.execute(
        "SELECT id FROM agents WHERE id = ? AND user_id = ?", (agent_id, user_id),
    )).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="agent not found")


async def _assert_tool_owned(conn, tool_id: str, user_id: str) -> None:
    row = await (await conn.execute(
        "SELECT id FROM agent_custom_tools WHERE id = ? AND user_id = ?", (tool_id, user_id),
    )).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="custom tool not found")


@router.get("/{agent_id}/tools")
async def list_agent_bound_tools(agent_id: str, user_id: str = Depends(require_auth)) -> dict:
    """Custom tools currently bound to an agent (i.e., the LLM will
    see their specs when chatting with this agent)."""
    conn = await get_connection()
    try:
        await _assert_agent_owned(conn, agent_id, user_id)
        rows = await (await conn.execute(
            """
            SELECT t.* FROM agent_custom_tool_bindings b
            JOIN agent_custom_tools t ON t.id = b.tool_id
            WHERE b.agent_id = ? AND t.user_id = ?
            ORDER BY t.name ASC
            """,
            (agent_id, user_id),
        )).fetchall()
    finally:
        await conn.close()
    return {"tools": [_row_to_out(r) for r in rows]}


@router.post("/{agent_id}/tools/{tool_id}")
async def bind_tool_to_agent(agent_id: str, tool_id: str, user_id: str = Depends(require_auth)) -> dict:
    conn = await get_connection()
    try:
        await _assert_agent_owned(conn, agent_id, user_id)
        await _assert_tool_owned(conn, tool_id, user_id)
        # Idempotent — INSERT OR IGNORE so binding twice is a no-op.
        await conn.execute(
            "INSERT OR IGNORE INTO agent_custom_tool_bindings (agent_id, tool_id) VALUES (?, ?)",
            (agent_id, tool_id),
        )
        await conn.commit()
    finally:
        await conn.close()
    return {"ok": True}


@router.delete("/{agent_id}/tools/{tool_id}")
async def unbind_tool_from_agent(agent_id: str, tool_id: str, user_id: str = Depends(require_auth)) -> dict:
    conn = await get_connection()
    try:
        await _assert_agent_owned(conn, agent_id, user_id)
        await conn.execute(
            "DELETE FROM agent_custom_tool_bindings WHERE agent_id = ? AND tool_id = ?",
            (agent_id, tool_id),
        )
        await conn.commit()
    finally:
        await conn.close()
    return {"ok": True}
