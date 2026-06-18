"""VocenceRouterLLM — wraps our internal LLM router for the new pipeline.

Our existing routing logic lives in ``llm_client.stream_chat_with_tools``:
based on the ``model`` prefix (``cerebras:``, ``gemini:``, ``glm:``,
``grok:``), it picks an upstream provider, multi-key-rotates within
that provider, and falls back to Grok if everything else is down.
This module wraps that router in a ``the framework LLM base class``
subclass so the new pipeline can use it as a drop-in LLM plugin.

Gemini (``gemini:*``) is already handled by the framework's
``GoogleLLM`` plugin, which is generally preferred — direct client,
no extra translation step, supports the framework's native streaming.
This shim covers the **non-Gemini** providers: Cerebras (the default
primary on most agents), GLM, and Grok (the always-available fallback).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator, Optional

from videosdk.agents import (  # type: ignore[import-not-found]
    LLM,
    LLMResponse,
)
from videosdk.agents.llm.chat_context import (  # type: ignore[import-not-found]
    ChatContext,
    ChatRole,
    ChatMessage,
    FunctionCall,
    FunctionCallOutput,
)
from videosdk.agents.utils import FunctionTool  # type: ignore[import-not-found]

_log = logging.getLogger(__name__)


class VocenceRouterLLM(LLM):
    """LLM plugin that delegates to ``llm_client.stream_chat_with_tools``.

    Parameters
    ----------
    model:
        Vocence model id with provider prefix, e.g.
        ``"cerebras:gpt-oss-120b"``, ``"glm:glm-4.7"``,
        ``"grok:grok-2"``. The prefix tells the router which
        upstream provider + key pool to use.
    temperature:
        Forwarded to the upstream API.
    max_tokens:
        Soft cap per generation. Matches the existing voicechat
        default of 1500.
    reasoning_effort:
        Optional. Forwarded for providers that respect it
        (currently OpenAI-compatible reasoning models).
    """

    def __init__(
        self,
        *,
        model: str,
        temperature: float = 0.6,
        max_tokens: int = 1500,
        reasoning_effort: Optional[str] = None,
    ) -> None:
        super().__init__()
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens
        self.reasoning_effort = reasoning_effort
        self._current_task: Optional[asyncio.Task[Any]] = None

    async def chat(
        self,
        messages: ChatContext,
        tools: list[FunctionTool] | None = None,
        conversational_graph: Optional[Any] = None,
        **kwargs: Any,
    ) -> AsyncIterator[LLMResponse]:
        """Stream a chat response.

        Translates ChatContext → OpenAI-shaped message list, calls
        the router, and yields LLMResponse objects per content delta.
        Tool calls from the router are accumulated and emitted as a
        final response with metadata (the framework's
        ``content_generation`` consumer will dispatch the tool).
        """
        from llm_client import stream_chat_with_tools

        oai_messages = _context_to_openai_messages(messages)
        oai_tools = _function_tools_to_openai(tools)

        # Track the iteration so cancel_current_generation() can
        # interrupt mid-stream. The router itself uses cancellable
        # asyncio operations, so cancelling the task tears the
        # upstream connection down cleanly.
        gen = stream_chat_with_tools(
            oai_messages,
            tools=oai_tools,
            temperature=self.temperature,
            max_tokens=self.max_tokens,
            model=self.model,
            reasoning_effort=self.reasoning_effort,
        )

        tool_call_accumulators: dict[str, dict[str, Any]] = {}
        try:
            async for event in gen:
                etype = event.get("type")
                if etype == "content":
                    text = event.get("text") or ""
                    if not text:
                        continue
                    yield LLMResponse(
                        content=text,
                        role=ChatRole.ASSISTANT,
                    )
                elif etype == "tool_call":
                    # Accumulate streaming tool-call deltas (OpenAI
                    # protocol streams the arguments piece by piece).
                    call_id = event.get("id") or "call_0"
                    acc = tool_call_accumulators.setdefault(
                        call_id,
                        {"name": "", "arguments": ""},
                    )
                    if event.get("name"):
                        acc["name"] += event["name"]
                    if event.get("arguments"):
                        acc["arguments"] += event["arguments"]
                elif etype == "done":
                    # Emit each accumulated tool call as its OWN
                    # LLMResponse — the framework's content_generation
                    # consumer reads metadata["function_call"]
                    # (singular dict) per response and dispatches one
                    # at a time. The earlier shape
                    # (metadata={"tool_calls": [...]}) was silently
                    # dropped, leaving the LLM to hallucinate tool
                    # calls as inline JSON text on the next iteration.
                    #
                    # arguments must be a DICT (the framework does
                    # ``tool(**self._safe_tool_kwargs(t, args))``).
                    # The accumulator builds a JSON string from the
                    # streaming deltas; parse it here.
                    for cid, v in tool_call_accumulators.items():
                        args_obj: Any
                        raw = (v.get("arguments") or "").strip()
                        if not raw:
                            args_obj = {}
                        else:
                            try:
                                args_obj = json.loads(raw)
                                if not isinstance(args_obj, dict):
                                    args_obj = {"value": args_obj}
                            except json.JSONDecodeError:
                                _log.warning(
                                    "VocenceRouterLLM: tool args not valid JSON; "
                                    "passing as raw string. raw=%r", raw[:200],
                                )
                                args_obj = {"raw": raw}
                        yield LLMResponse(
                            content="",
                            role=ChatRole.ASSISTANT,
                            metadata={
                                "function_call": {
                                    "name": v.get("name") or "",
                                    "arguments": args_obj,
                                    "call_id": cid,
                                }
                            },
                        )
                    return
                # Drop unknown event types silently — the router
                # may add new ones over time.
        except asyncio.CancelledError:
            # Cancellation is expected via cancel_current_generation;
            # let it bubble so the consumer's gather() unwinds cleanly.
            raise
        except Exception as exc:  # noqa: BLE001
            _log.exception("VocenceRouterLLM.chat failed: %s", exc)
            self.emit("error", str(exc))
            return

    async def cancel_current_generation(self) -> None:
        """Stop the in-flight chat stream. The current task — if any
        — is the iterator created in ``chat()``; cancelling it tears
        the upstream HTTP / WS connection down."""
        task = self._current_task
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        self._current_task = None


# ----- helpers --------------------------------------------------------


def _context_to_openai_messages(ctx: ChatContext) -> list[dict[str, Any]]:
    """Flatten a ChatContext into the OpenAI ``messages=[...]`` shape.

    Only ``ChatMessage`` items become messages here; ``FunctionCall``
    and ``FunctionCallOutput`` are interleaved in the right order so
    a tool-call → tool-result flow round-trips through the router
    correctly. Image content is dropped — the LLM router doesn't yet
    accept vision input. Add it when ``llm_client`` does.
    """
    out: list[dict[str, Any]] = []
    for item in ctx.items:
        if isinstance(item, ChatMessage):
            content = item.content
            if isinstance(content, list):
                # Multi-part content — pick the first text part only
                # for now. Vision support requires LLM router changes.
                text_parts = [c for c in content if isinstance(c, str)]
                text = " ".join(text_parts).strip()
            else:
                text = str(content)
            if not text:
                continue
            out.append({"role": _role_to_str(item.role), "content": text})
        elif isinstance(item, FunctionCall):
            out.append({
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": item.call_id,
                    "type": "function",
                    "function": {"name": item.name, "arguments": item.arguments},
                }],
            })
        elif isinstance(item, FunctionCallOutput):
            out.append({
                "role": "tool",
                "tool_call_id": item.call_id,
                "content": item.output,
            })
        # Other ChatItem subclasses (AgentHandoff, AgentConfigUpdate)
        # are framework-internal control items — they don't translate
        # to OpenAI messages, so skip them.
    return out


def _function_tools_to_openai(
    tools: list[FunctionTool] | None,
) -> list[dict[str, Any]] | None:
    """Translate the framework's FunctionTool list to OpenAI's tool
    JSON shape, which is what our router expects.

    Each FunctionTool carries a ``_tool_info`` attribute (a
    ``FunctionToolInfo`` dataclass with name / description /
    parameters_schema) — that's what both ``@function_tool``
    decorated tools and our own dynamic wrappers in
    voice_pipeline_next_tools set. Tools missing the attribute are
    silently dropped.
    """
    if not tools:
        return None
    out: list[dict[str, Any]] = []
    for t in tools:
        info = getattr(t, "_tool_info", None)
        if info is None:
            continue
        out.append({
            "type": "function",
            "function": {
                "name": info.name,
                "description": info.description or "",
                "parameters": info.parameters_schema or {"type": "object", "properties": {}},
            },
        })
    return out or None


def _role_to_str(role: ChatRole) -> str:
    """``ChatRole.USER`` → ``"user"`` (the router expects str roles)."""
    return role.value if hasattr(role, "value") else str(role)
