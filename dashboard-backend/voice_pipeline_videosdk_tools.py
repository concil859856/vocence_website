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

import json
import logging
from typing import Any, Awaitable, Callable

from videosdk.agents.utils import FunctionToolInfo  # type: ignore[import-not-found]

_log = logging.getLogger(__name__)


def build_tools_for_agent(
    agent_config: dict[str, Any],
) -> list[Callable[..., Awaitable[Any]]]:
    """Materialize the framework-shaped tool list for an agent.

    Reads ``enabled_tools`` from the config (None → all available,
    [] → none, list[str] → that subset). Looks each name up in
    ``agent_tools_service._REGISTRY`` and wraps it in a
    framework-compatible async callable with ``_tool_info`` attached.

    Tools whose env isn't configured on this deployment (see
    ``Tool.available()``) silently drop out — the LLM never sees
    them, so it can't try to call something that would just fail.
    """
    from agent_tools_service import _REGISTRY  # local import — late binding

    enabled = agent_config.get("enabled_tools")
    if enabled is None:
        # None = all available
        names = [n for n, t in _REGISTRY.items() if t.available()]
    elif not enabled:
        # Empty list = explicitly no tools
        return []
    else:
        names = [n for n in enabled if n in _REGISTRY and _REGISTRY[n].available()]

    tools: list[Callable[..., Awaitable[Any]]] = []
    for name in names:
        tool = _REGISTRY.get(name)
        if tool is None:
            continue
        wrapper = _wrap_tool_as_function_tool(tool)
        tools.append(wrapper)
    _log.info(
        "[voice-pipeline-videosdk] tools materialized: %s (from enabled=%r)",
        [t.__name__ for t in tools], enabled,
    )
    return tools


def _wrap_tool_as_function_tool(
    tool: Any,
) -> Callable[..., Awaitable[Any]]:
    """Build a framework FunctionTool from a legacy Tool dataclass.

    The framework's content_generation reads ``_tool_info`` for the
    name / description / parameters schema. When the LLM emits a
    tool_call, it calls the wrapper with the deserialized arguments
    as kwargs. Our existing executors take a single ``args: dict``
    parameter, so the wrapper repacks kwargs into that shape.
    """
    info = FunctionToolInfo(
        name=tool.name,
        description=tool.description,
        parameters_schema=tool.parameters,
    )

    async def _wrapper(**kwargs: Any) -> Any:
        # Our executors expect ``args: dict``. Repack the kwargs the
        # framework provides (deserialized from the LLM's tool_call
        # arguments JSON) into that shape.
        try:
            result = await tool.executor(kwargs)
        except Exception as exc:  # noqa: BLE001
            _log.exception("tool %r executor failed: %s", tool.name, exc)
            return json.dumps({"error": str(exc)})
        # The framework expects a string-or-JSON-serializable return
        # value — we already normalize complex results to dicts in
        # the executors, so this is usually direct.
        return result

    # Attach the framework's introspection hooks. ``_tool_info`` is
    # what the framework checks (see utils.get_tool_info / Agent.register_tools).
    # ``__name__`` matters for log lines and the FunctionToolInfo's
    # default when no explicit name is set.
    _wrapper.__name__ = tool.name
    _wrapper.__doc__ = tool.description
    setattr(_wrapper, "_tool_info", info)
    return _wrapper
