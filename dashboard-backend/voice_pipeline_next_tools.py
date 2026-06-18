"""Bridge agent_tools_service.Tool registry → framework FunctionTool list.

The framework's Agent accepts a ``tools: List[FunctionTool]`` argument
where each FunctionTool is a callable with a ``_tool_info`` attribute
(``FunctionToolInfo`` dataclass). The framework's content_generation
consumer reads that info to drive both:
  - the tool schema handed to the LLM
  - dispatch when the LLM emits a tool_call

Our existing ``agent_tools_service`` already maintains a registry of
``Tool`` dataclasses with name / description / parameters (JSON
Schema) / executor. This module wraps them into the FunctionTool
shape per the agent's ``enabled_tools`` whitelist, dynamically — the
set varies per agent, so static @function_tool decorators on a
single Agent class would be too rigid.

Custom webhook tools (agent_custom_tools_service.CustomTool) get the
same treatment in a follow-up — they're per-agent and bound via
``/v1/agent-tools``. For day one we ship the built-in tool bridge.
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from typing import Any, Awaitable, Callable, Optional

from videosdk.agents.utils import FunctionToolInfo  # type: ignore[import-not-found]

_log = logging.getLogger(__name__)

# Callback shape the session layer can inject: (event_type, payload)
# where event_type is "tool_call_started" or "tool_call_completed" and
# payload matches the legacy frontend's JSON envelope shape
# (see ``case 'tool_call_started'`` in app/src/lib/voicechat/useVoiceChat.ts).
ToolEventCallback = Callable[[str, dict[str, Any]], Awaitable[None]]


async def build_tools_for_agent(
    agent_config: dict[str, Any],
    *,
    agent_id: str | None = None,
    user_id: str | None = None,
    on_tool_event: Optional[ToolEventCallback] = None,
) -> list[Callable[..., Awaitable[Any]]]:
    """Materialize the framework-shaped tool list for an agent.

    Built-ins:
      Reads ``enabled_tools`` from the config (None → all available,
      [] → none, list[str] → that subset). Looks each name up in
      ``agent_tools_service._REGISTRY``. Tools whose env isn't
      configured on this deployment silently drop out — the LLM
      never sees them, so it can't call something that would fail.

    Custom webhook tools:
      When ``agent_id`` + ``user_id`` are provided, also loads any
      ``CustomToolDef`` rows bound to the agent (via
      ``agent_custom_tool_bindings``). Wraps each with the same
      framework FunctionTool shape; on invocation, dispatches via
      ``agent_tools_service.dispatch_custom_tool`` (the same HTTP
      POST + auth + SSRF-guarded path the legacy router uses).
    """
    from agent_tools_service import _REGISTRY  # local import — late binding

    enabled = agent_config.get("enabled_tools")
    if enabled is None:
        names = [n for n, t in _REGISTRY.items() if t.available()]
    elif not enabled:
        names = []
    else:
        names = [n for n in enabled if n in _REGISTRY and _REGISTRY[n].available()]

    tools: list[Callable[..., Awaitable[Any]]] = []
    for name in names:
        tool = _REGISTRY.get(name)
        if tool is None:
            continue
        tools.append(_wrap_tool_as_function_tool(tool, on_tool_event=on_tool_event))

    # Custom webhook tools (per-agent bindings).
    if agent_id is not None and user_id is not None:
        try:
            from routers.voicechat import _load_custom_tools_for_agent
            custom = await _load_custom_tools_for_agent(agent_id, user_id)
        except Exception:  # noqa: BLE001
            _log.exception(
                "[voice-pipeline-next] failed to load custom tools "
                "for agent=%s; built-in tools only", agent_id,
            )
            custom = []
        for c in custom:
            tools.append(_wrap_custom_tool_as_function_tool(c, on_tool_event=on_tool_event))

    _log.info(
        "[voice-pipeline-next] tools materialized: builtin=%s custom=%d "
        "(enabled=%r)",
        [t.__name__ for t in tools[:len(names)]],
        max(0, len(tools) - len(names)),
        enabled,
    )
    return tools


async def _emit_tool_event(
    on_tool_event: Optional[ToolEventCallback],
    event_type: str,
    payload: dict[str, Any],
) -> None:
    """Best-effort emit. Tool execution must not fail because the UI
    bridge is unavailable; we suppress any callback exception."""
    if on_tool_event is None:
        return
    try:
        await on_tool_event(event_type, payload)
    except Exception as exc:  # noqa: BLE001
        _log.debug("[voice-pipeline-next] on_tool_event %s raised: %s", event_type, exc)


def _result_preview(result: Any, *, max_chars: int = 280) -> str:
    """Mirror legacy: stringify the tool result and trim. Frontend
    parses this as JSON to detect errors ({"error": ...} → red chip),
    so dicts/lists must round-trip through json.dumps."""
    if isinstance(result, str):
        s = result
    else:
        try:
            s = json.dumps(result)
        except Exception:  # noqa: BLE001
            s = str(result)
    return s[:max_chars]


def _wrap_tool_as_function_tool(
    tool: Any,
    *,
    on_tool_event: Optional[ToolEventCallback] = None,
) -> Callable[..., Awaitable[Any]]:
    """Build a framework FunctionTool from a legacy Tool dataclass.

    The framework's content_generation reads ``_tool_info`` for the
    name / description / parameters schema. When the LLM emits a
    tool_call, it calls the wrapper with the deserialized arguments
    as kwargs. Our existing executors take a single ``args: dict``
    parameter, so the wrapper repacks kwargs into that shape.

    If ``on_tool_event`` is provided, the wrapper emits
    ``tool_call_started`` before the executor runs and
    ``tool_call_completed`` after — same JSON envelopes the legacy
    voicechat router emitted, so the frontend's tool-chip rendering
    works unchanged.
    """
    info = FunctionToolInfo(
        name=tool.name,
        description=tool.description,
        parameters_schema=tool.parameters,
    )

    async def _wrapper(**kwargs: Any) -> Any:
        # Per-invocation id so the frontend can match start ↔ completed.
        # Framework doesn't expose the LLM's tool_call id to the
        # wrapper, so we mint our own.
        call_id = uuid.uuid4().hex[:12]
        await _emit_tool_event(on_tool_event, "tool_call_started", {
            "id": call_id,
            "name": tool.name,
            "arguments": kwargs,
            "kind": "builtin",
        })
        try:
            result = await tool.executor(kwargs)
        except asyncio.CancelledError:
            # Barge-in mid-tool-execution: the framework cancels the
            # generation task and the tool coroutine raises Cancelled.
            # Without this branch the chip on the UI spins forever
            # because tool_call_completed was never emitted. Mark it
            # cancelled, suppress the cancellation so the framework's
            # gather doesn't blow up, but DO re-raise so the LLM's
            # generation loop unwinds cleanly.
            await _emit_tool_event(on_tool_event, "tool_call_completed", {
                "id": call_id,
                "name": tool.name,
                "result_preview": _result_preview({"error": "cancelled"}),
            })
            raise
        except Exception as exc:  # noqa: BLE001
            _log.exception("tool %r executor failed: %s", tool.name, exc)
            err_payload = {"error": str(exc)}
            await _emit_tool_event(on_tool_event, "tool_call_completed", {
                "id": call_id,
                "name": tool.name,
                "result_preview": _result_preview(err_payload),
            })
            return json.dumps(err_payload)
        await _emit_tool_event(on_tool_event, "tool_call_completed", {
            "id": call_id,
            "name": tool.name,
            "result_preview": _result_preview(result),
        })
        return result

    _wrapper.__name__ = tool.name
    _wrapper.__doc__ = tool.description
    setattr(_wrapper, "_tool_info", info)
    return _wrapper


def _wrap_custom_tool_as_function_tool(
    custom_tool: Any,
    *,
    on_tool_event: Optional[ToolEventCallback] = None,
) -> Callable[..., Awaitable[Any]]:
    """Build a framework FunctionTool from a CustomToolDef row.

    Routes invocations through ``dispatch_custom_tool`` — the same
    webhook-POST + auth + SSRF-guarded path the legacy voicechat
    used. The wrapper repackages the framework's kwargs into the
    JSON-string-arguments shape ``dispatch_custom_tool`` expects.

    Emits ``tool_call_started`` / ``tool_call_completed`` with
    ``kind="custom"`` so the frontend can tag the chip differently
    from built-in tools (the legacy router did the same).
    """
    info = FunctionToolInfo(
        name=custom_tool.name,
        description=custom_tool.description,
        parameters_schema=custom_tool.parameters,
    )

    async def _wrapper(**kwargs: Any) -> Any:
        from agent_tools_service import dispatch_custom_tool  # late import
        call_id = uuid.uuid4().hex[:12]
        await _emit_tool_event(on_tool_event, "tool_call_started", {
            "id": call_id,
            "name": custom_tool.name,
            "arguments": kwargs,
            "kind": "custom",
        })
        try:
            result = await dispatch_custom_tool(custom_tool, json.dumps(kwargs))
        except asyncio.CancelledError:
            # See _wrap_tool_as_function_tool — same barge-in
            # situation. Emit completion so the chip stops spinning,
            # then re-raise so the framework unwinds.
            await _emit_tool_event(on_tool_event, "tool_call_completed", {
                "id": call_id,
                "name": custom_tool.name,
                "result_preview": _result_preview({"error": "cancelled"}),
            })
            raise
        except Exception as exc:  # noqa: BLE001
            _log.exception(
                "custom tool %r dispatch failed: %s", custom_tool.name, exc,
            )
            err_payload = {"error": str(exc)}
            await _emit_tool_event(on_tool_event, "tool_call_completed", {
                "id": call_id,
                "name": custom_tool.name,
                "result_preview": _result_preview(err_payload),
            })
            return json.dumps(err_payload)
        await _emit_tool_event(on_tool_event, "tool_call_completed", {
            "id": call_id,
            "name": custom_tool.name,
            "result_preview": _result_preview(result),
        })
        return result

    _wrapper.__name__ = custom_tool.name
    _wrapper.__doc__ = custom_tool.description
    setattr(_wrapper, "_tool_info", info)
    return _wrapper
