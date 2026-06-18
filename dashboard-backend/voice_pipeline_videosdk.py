"""New voice-agent backend built on the videosdk-agents framework.

The legacy implementation in ``voicechat_stream.py`` opens a new
streaming session per turn and orchestrates STT / VAD / EOU / LLM /
TTS via custom code (~2.5 kLOC). This module is the replacement:
one continuous session per call, with the pipeline composition
delegated to ``videosdk.agents.Pipeline`` (the same framework the
user validated in ``voice_agent/agent.py``).

Day-1 component picks
---------------------
- **VAD**: SileroVAD (local ONNX, no pod hop)
- **Turn detector**: TurnDetector ONNX (local, multilingual)
- **STT**: per-agent — VocenceSTT (default) or DeepgramSTT (opt-in
  via agent config ``stt_provider``)
- **LLM**: Cerebras or Gemini (per agent's configured ``llm_model``);
  Grok fallback always. Wired through a thin LLM plugin that wraps
  the existing ``llm_client.stream_chat_with_tools`` router so we
  don't break existing routing behavior on day one.
- **TTS**: VocenceTTS (the differentiator — custom voice cloning)

What this module does NOT do yet
--------------------------------
- Not wired to the WS endpoint yet (Phase A.4 will route the
  ``voicechat_session`` handler through ``run_videosdk_session()``
  when ``VOICE_PIPELINE=videosdk``).
- No call recorder / billing / RAG / custom-tool bridge yet — those
  are Phase A.6 / A.7 / A.8. Stubs / TODOs marked inline.
- No Studio UI changes — agent settings continue to feed in via the
  existing ``agent.config`` dict; the translation layer below maps
  old field names to the new pipeline's config knobs.

Behind ``VOICE_PIPELINE`` env var so the legacy path stays the
default while this is dogfooded.
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

_log = logging.getLogger(__name__)


# Feature flag — mirrors the .env entry. Read at module-import time
# so a process restart picks up the change. ``legacy`` is the
# fail-safe default until the new path is validated end-to-end.
VOICE_PIPELINE = (os.environ.get("VOICE_PIPELINE") or "legacy").strip().lower()


def is_videosdk_pipeline() -> bool:
    """True when the deployment has opted into the new path. Callers
    in ``routers/voicechat.py`` switch on this flag to pick which
    session handler runs."""
    return VOICE_PIPELINE == "videosdk"


# Defer the heavy imports until ``is_videosdk_pipeline()`` is true.
# When the flag is off, importing this module is free — no
# videosdk-agents load (which pulls in onnxruntime + torch, ~150 MB
# RAM on the first import). Production processes that haven't opted
# in pay nothing.
_videosdk_loaded = False


def _ensure_videosdk_loaded() -> None:
    """Lazy-import the framework + plugins on first opt-in."""
    global _videosdk_loaded
    if _videosdk_loaded:
        return
    # Import inside the function so the legacy path doesn't pay the
    # framework's startup cost. Names are kept in module globals via
    # ``globals().update`` so the rest of this module reads cleanly
    # without `getattr` plumbing.
    try:
        from videosdk.agents import (  # noqa: F401  type: ignore[import-not-found]
            Agent,
            AgentSession,
            EOUConfig,
            InterruptConfig,
            Pipeline,
        )
        from videosdk.agents.plugins import (  # noqa: F401  type: ignore[import-not-found]
            SileroVAD,
            TurnDetector,
            DeepgramSTT,
            GoogleLLM,
        )
        from vocence_plugins import VocenceTTS, VocenceSTT  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "VOICE_PIPELINE=videosdk requires the videosdk-agents framework "
            "and vocence-plugins to be installed in the backend venv. "
            f"Import failed: {exc}"
        ) from exc

    globals().update({
        "Agent": Agent,
        "AgentSession": AgentSession,
        "EOUConfig": EOUConfig,
        "InterruptConfig": InterruptConfig,
        "Pipeline": Pipeline,
        "SileroVAD": SileroVAD,
        "TurnDetector": TurnDetector,
        "DeepgramSTT": DeepgramSTT,
        "GoogleLLM": GoogleLLM,
        "VocenceTTS": VocenceTTS,
        "VocenceSTT": VocenceSTT,
    })
    _videosdk_loaded = True
    _log.info("[voice-pipeline-videosdk] framework + plugins loaded")


def build_pipeline_from_agent_config(agent_config: dict[str, Any]) -> Any:
    """Translate a Vocence agent config row to a videosdk Pipeline.

    This is the boundary between the existing data model (agent_config
    fields written by Studio UI / dev-API) and the new pipeline's
    config knobs. Old fields with no direct equivalent (turn_decider,
    ultravad_threshold) are mapped to the closest videosdk knob; new
    fields (interrupt_min_duration, etc.) use sensible defaults that
    Studio will surface in Phase B.

    Returns a constructed ``Pipeline`` ready to hand to
    ``AgentSession(agent=..., pipeline=pipeline)``.
    """
    _ensure_videosdk_loaded()

    # ---- STT plugin (per-agent selectable; default Vocence) ----
    stt_provider = (agent_config.get("stt_provider") or "vocence").lower()
    api_key_env = os.environ.get("VOCENCE_INTERNAL_API_KEY")
    language = agent_config.get("language") or "auto"
    if stt_provider == "deepgram":
        stt = DeepgramSTT(  # type: ignore[name-defined]
            model=os.environ.get("DEEPGRAM_MODEL") or "nova-3",
            language=_to_deepgram_lang(language),
        )
    else:
        stt = VocenceSTT(  # type: ignore[name-defined]
            api_key=api_key_env,
            language=language,
        )

    # ---- LLM plugin ----
    # The agent_config stores model ids like "cerebras:gpt-oss-120b"
    # or "gemini:gemini-3.5-flash". We route to the right videosdk
    # plugin based on the prefix. Day 1 supports Gemini natively via
    # GoogleLLM; Cerebras + GLM + Grok need a thin wrapper around our
    # existing llm_client router — that wrapper is _build_router_llm
    # below. Grok stays as the fallback the router already configures.
    llm_model = agent_config.get("llm_model") or ""
    llm = _build_llm_plugin(llm_model, agent_config)

    # ---- TTS plugin (always Vocence — voice cloning is the diff) ----
    tts = VocenceTTS(  # type: ignore[name-defined]
        api_key=api_key_env,
        voice=str(agent_config.get("voice") or "design-aria"),
        language=language if language != "auto" else None,
    )

    # ---- EOU + Interrupt config (translation from legacy knobs) ----
    eou_cfg = _translate_eou_config(agent_config)
    interrupt_cfg = _translate_interrupt_config(agent_config)

    pipeline = Pipeline(  # type: ignore[name-defined]
        stt=stt,
        llm=llm,
        tts=tts,
        vad=SileroVAD(),  # type: ignore[name-defined]
        turn_detector=TurnDetector(),  # type: ignore[name-defined]
        eou_config=eou_cfg,
        interrupt_config=interrupt_cfg,
    )
    return pipeline


def _to_deepgram_lang(language: str) -> str:
    """Map agent-config language names → Deepgram's BCP-47 codes.
    Deepgram accepts ``en``/``en-US``/etc. We err on the side of the
    region-tagged variant for English to get Deepgram's best model."""
    if not language or language == "auto":
        return "multi"
    table = {
        "English": "en-US",
        "Spanish": "es",
        "French": "fr",
        "German": "de",
        "Italian": "it",
        "Portuguese": "pt",
        "Japanese": "ja",
        "Korean": "ko",
        "Chinese": "zh",
        "Russian": "ru",
    }
    return table.get(language, "multi")


def _build_llm_plugin(llm_model: str, agent_config: dict[str, Any]) -> Any:
    """Pick a videosdk-compatible LLM plugin for the agent's model id.

    For Gemini we use the framework's ``GoogleLLM`` directly. For
    Cerebras / GLM / Grok we wrap our existing routing client in a
    thin shim that satisfies ``videosdk.agents.llm.LLM`` — written
    as part of Phase A.5 (this stub returns a temporary GoogleLLM
    fallback so the scaffold compiles). The shim itself is small
    and lives in ``_llm_router.py`` so this module stays focused on
    orchestration glue.
    """
    temperature = float(agent_config.get("temperature") or 0.6)
    if llm_model.startswith("gemini:"):
        from videosdk.agents.plugins import GoogleLLM  # type: ignore[import-not-found]
        model_id = llm_model.split(":", 1)[1] or "gemini-2.5-flash"
        return GoogleLLM(model=model_id, temperature=temperature)
    # Everything else (cerebras: / glm: / grok: / unprefixed default)
    # goes through our router shim so the existing multi-provider
    # routing + key rotation + Grok-fallback behavior is preserved.
    from voice_pipeline_videosdk_llm import VocenceRouterLLM
    return VocenceRouterLLM(model=llm_model, temperature=temperature)


def _translate_eou_config(agent_config: dict[str, Any]) -> Any:
    """Map legacy EOU knobs (min_delay_ms, ultravad_threshold) to the
    videosdk ``EOUConfig`` shape. Mapping rules:

      - ``min_delay_ms`` becomes the LOW end of
        ``min_max_speech_wait_timeout``. We use ``min_delay_ms * 1.6``
        as the high end (mirroring the ratio in the voice_agent
        example the user validated: ``[0.8, 1.6]``).
      - ``ultravad_threshold`` (a turn-end probability) maps onto
        ``eou_certainty_threshold``. Same semantic, slight scale
        adjustment — old default 0.50 maps to new default 0.75 which
        is videosdk's recommended starting point for English.
    """
    _ensure_videosdk_loaded()
    min_ms = int(agent_config.get("min_delay_ms") or 500)
    min_sec = min_ms / 1000.0
    max_sec = min_sec * 1.6
    threshold = float(agent_config.get("ultravad_threshold") or 0.50)
    # Rescale: 0.5 (legacy default) → 0.75 (videosdk recommended). A
    # straight linear map: new = 0.5 + 0.5 * old gets close enough for
    # day one. The Phase B Studio UI will expose the new slider
    # directly so users can tune in the new scale.
    eou_certainty = min(max(0.5 + 0.5 * threshold, 0.0), 1.0)
    return EOUConfig(  # type: ignore[name-defined]
        min_max_speech_wait_timeout=[min_sec, max_sec],
        eou_certainty_threshold=eou_certainty,
    )


def _translate_interrupt_config(agent_config: dict[str, Any]) -> Any:
    """Map legacy barge-in tuning to videosdk's ``InterruptConfig``.

    The legacy frontend used ``BACKCHANNEL_GRACE_MS=60``,
    ``BACKCHANNEL_MAX_MS=180``, ``BARGE_IN_FADE_MS=80`` (from our
    most recent tuning). videosdk's defaults are gentler: 0.5 s
    duration, 2 words, 0.4 s fade. The voice_agent example the user
    validated tuned aggressive: 0.2 s / 1 word / 0.1 s fade. We
    pick the aggressive defaults for snappier UX, since the user
    explicitly liked that example's feel.
    """
    _ensure_videosdk_loaded()
    return InterruptConfig(  # type: ignore[name-defined]
        mode="HYBRID",
        interrupt_min_duration=0.2,
        interrupt_min_words=1,
        interrupt_fade_duration=0.1,
        resume_on_false_interrupt=False,
    )


async def run_videosdk_session(
    *,
    ws: Any,
    agent_config: dict[str, Any],
    user_id: str,
    session_id: str,
    agent_id: str | None = None,
    free_mode: bool = False,
) -> None:
    """Entry point for a voicechat session on the new pipeline.

    Wires our already-open FastAPI WebSocket to a framework AgentSession
    via the custom ``FastAPIWebSocketTransport``. The transport handles
    audio I/O (PCM in over the WS → pipeline VAD/STT, pipeline TTS →
    PCM out over the WS). Everything else (interrupt handling, EOU,
    LLM routing, tool calling, transcript events) is the framework's
    job.

    Caller has already:
      - accepted the WS upgrade
      - authenticated the user
      - loaded the agent config

    What's NOT yet wired here (Phase A.6-9 — separate commits):
      - call_recorder integration (push_user + push_agent + finalize)
      - voice_agent_billing integration (mark_turn_started / _ended)
      - knowledge_base RAG bridge (function_tool that fetches context)
      - built-in tools (web_search, weather, etc. as @function_tool)
      - custom webhook tools (dynamically registered per-agent)
      - client-protocol JSON event forwarding (token / audio_meta /
        turn_end / cancelled / etc.) — the legacy frontend expects
        these; the framework emits them differently and we need a
        bridge layer over the pipeline.on(...) hooks.

    These are deliberate gaps for the next session — getting the
    audio round-trip working end-to-end first establishes the
    structural skeleton; the feature wiring fills the bones.
    """
    _ensure_videosdk_loaded()
    from voice_pipeline_videosdk_transport import FastAPIWebSocketTransport

    loop = asyncio.get_running_loop()
    pipeline = build_pipeline_from_agent_config(agent_config)

    # Build a minimal Agent subclass from the agent config. The
    # system prompt drives the LLM's instructions; the first_message
    # is the on_enter greeting the framework's pipeline plays once
    # the session is live.
    instructions = (agent_config.get("system_prompt") or "").strip() or (
        "You are a helpful voice assistant. Speak naturally and concisely."
    )
    first_message = (agent_config.get("first_message") or "").strip() or None

    # Tool list — built-in tools the agent has enabled. Custom
    # webhook tools (per-agent /v1/agent-tools registrations) are
    # bridged in a follow-up commit; the wrapper signature is the
    # same so adding them is local to build_tools_for_agent.
    from voice_pipeline_videosdk_tools import build_tools_for_agent
    tools_list = build_tools_for_agent(agent_config)

    class _VocenceAgent(Agent):  # type: ignore[name-defined,misc]
        def __init__(self) -> None:
            super().__init__(
                use_base_instructions=True,
                instructions=instructions,
                tools=tools_list,
            )

        async def on_enter(self) -> None:
            if first_message:
                await self.session.say(first_message)

    agent = _VocenceAgent()

    # Bridge transport. The framework's AgentSession reads
    # pipeline.audio_track for outbound audio and pipeline.on_audio_delta
    # for inbound — both are wired up by the transport during connect().
    transport = FastAPIWebSocketTransport(loop=loop, pipeline=pipeline, ws=ws)
    try:
        await transport.connect()
    except Exception as exc:  # noqa: BLE001
        _log.exception("[voice-pipeline-videosdk] transport.connect failed: %s", exc)
        raise

    session = AgentSession(agent=agent, pipeline=pipeline)  # type: ignore[name-defined]
    _log.info(
        "[voice-pipeline-videosdk] session start session=%s agent_id_in_config=%s "
        "llm=%s stt=%s tts=%s voice=%s lang=%s",
        session_id,
        agent_config.get("name") or "unknown",
        type(pipeline.llm).__name__,
        type(pipeline.stt).__name__,
        type(pipeline.tts).__name__,
        agent_config.get("voice"),
        agent_config.get("language"),
    )

    # ---- minimal client-protocol event bridge --------------------------
    # The existing frontend expects ``{type: "transcript"|"token"|
    # "audio_meta"|"turn_end"|"cancelled"|...}`` JSON frames. Mirror
    # the most critical ones from the framework's emitted events so
    # the UI keeps working without code changes. Token-stream wiring
    # (per-token deltas) needs the @pipeline.on("llm") decorator
    # pattern and lands in a follow-up — for now the chat bubble
    # paces with the final transcript on ``content_generated``.
    async def _send_safely(payload: dict[str, Any]) -> None:
        try:
            await ws.send_json(payload)
        except Exception as exc:  # noqa: BLE001
            _log.debug("[voice-pipeline-videosdk] send_json failed: %s", exc)

    def _on_transcript_ready(data: Any) -> None:
        text = ""
        if isinstance(data, dict):
            text = (data.get("text") or "").strip()
        if not text:
            return
        loop.create_task(_send_safely({"type": "transcript", "text": text}))

    def _on_content_generated(data: Any) -> None:
        text = ""
        if isinstance(data, dict):
            text = (data.get("text") or "").strip()
        if text:
            # Single token event with the full reply — replaces the
            # legacy token-stream UX (text appears all at once when
            # ready instead of typing-style stream). Real streaming
            # lands in Phase A.6+ via @pipeline.on("llm").
            loop.create_task(_send_safely({"type": "token", "text": text}))

    def _on_synthesis_complete(_data: Any = None) -> None:
        loop.create_task(_send_safely({"type": "turn_end"}))

    def _on_synthesis_interrupted(_data: Any = None) -> None:
        loop.create_task(_send_safely({"type": "cancelled"}))

    def _on_error(data: Any) -> None:
        msg = (data.get("error") if isinstance(data, dict) else str(data)) or "error"
        loop.create_task(_send_safely({
            "type": "error", "code": "pipeline_error", "message": msg,
        }))

    pipeline.on("transcript_ready", _on_transcript_ready)
    pipeline.on("content_generated", _on_content_generated)
    pipeline.on("synthesis_complete", _on_synthesis_complete)
    pipeline.on("backchannel_detected", _on_synthesis_interrupted)
    pipeline.on("error", _on_error)

    # ---- Billing (Phase A.7) -------------------------------------------
    # Same VoiceAgentBilling class the legacy path uses — instantiated
    # here so the new path bills consistently. on_session_end fires on
    # billing-exhausted / max-duration / idle-timeout; on_deduct
    # surfaces the new balance to the frontend after each tick.
    from voice_agent_billing import VoiceAgentBilling  # local import
    billing: Any | None = None
    if agent_id is not None:
        async def _on_session_end(reason: str) -> None:
            await _send_safely({"type": "session_timeout", "code": reason})
            with _suppress():
                await ws.close(code=4408)

        async def _on_deduct(remaining: int) -> None:
            await _send_safely({
                "type": "billing_update", "credits_remaining": remaining,
            })

        billing = VoiceAgentBilling(
            user_id=user_id,
            session_id=session_id,
            agent_id=agent_id,
            on_session_end=_on_session_end,
            on_deduct=_on_deduct,
            free_mode=free_mode,
        )
        # Framework lifecycle hooks → billing turn tracker.
        # synthesis_complete = agent's TTS finished playing, so the
        # turn is "ended" from a billing standpoint (per-second tick
        # stops). transcript_ready = user committed a new turn → start.
        def _billing_turn_start(_d: Any = None) -> None:
            if billing is not None:
                billing.mark_turn_started()

        def _billing_turn_end(_d: Any = None) -> None:
            if billing is not None:
                billing.mark_turn_ended()

        pipeline.on("transcript_ready", _billing_turn_start)
        pipeline.on("synthesis_complete", _billing_turn_end)
        pipeline.on("backchannel_detected", _billing_turn_end)

    # ---- Knowledge-base RAG (Phase A.8) -------------------------------
    # When an agent has a knowledge base, every user turn should be
    # enriched with the top-k most relevant chunks before the LLM
    # sees it. agent_knowledge.search_agent_knowledge is cheap when
    # no KB is attached (returns empty list), so we wire it
    # unconditionally and let it no-op when there's nothing to find.
    if agent_id is not None:
        from agent_knowledge import search_agent_knowledge
        from voicechat_knowledge import VOICE_CHAT_FORMAT_RULES

        _last_enriched_user_msg: dict[str, Any] = {}

        async def _enrich_with_rag(transcript: str) -> None:
            """Fire RAG retrieval + mutate the last user message in
            chat_context to prepend the retrieved chunks. Runs in a
            tight window between transcript_ready and the LLM call."""
            text = (transcript or "").strip()
            if not text:
                return
            try:
                chunks = await search_agent_knowledge(agent_id, text, top_k=5)
            except Exception:  # noqa: BLE001
                _log.exception("[voice-pipeline-videosdk] RAG search failed")
                return
            if not chunks:
                return
            try:
                items = agent.chat_context.items  # type: ignore[attr-defined]
            except Exception:  # noqa: BLE001
                return
            # Find the LAST user message — that's the one the LLM
            # is about to act on. Prepend the RAG block as context.
            for item in reversed(items):
                if getattr(item, "role", None) is not None and \
                   str(item.role).endswith("user"):
                    rag_block = (
                        "\n\n[KNOWLEDGE-BASE CONTEXT — use to ground "
                        "your reply, do not quote this block verbatim]\n"
                        + "\n---\n".join(chunks)
                        + "\n[END KNOWLEDGE-BASE CONTEXT]\n\n"
                    )
                    original = item.content if isinstance(item.content, str) else ""
                    item.content = rag_block + original  # type: ignore[assignment]
                    _last_enriched_user_msg["text"] = original
                    break

        def _on_user_turn_start(transcript: Any) -> None:
            text = transcript if isinstance(transcript, str) else \
                (transcript.get("text") if isinstance(transcript, dict) else "")
            loop.create_task(_enrich_with_rag(text or ""))

        pipeline.on("user_turn_start", _on_user_turn_start)

    # ---- Call recorder (Phase A.6) ------------------------------------
    # Stereo WAV recording when the agent has record_enabled. The
    # recorder needs raw PCM frames on BOTH legs:
    #   - user channel (left): from transport's inbound read loop
    #   - agent channel (right): from TTS via pipeline.audio_track
    # Hook by wrapping the transport's audio sink + pipeline.on_audio_delta.
    from call_recorder import CallRecorder  # local import
    recorder: Any | None = None
    if bool(agent_config.get("record_enabled")):
        recorder = CallRecorder(user_id=user_id, session_id=session_id)

    # Wrap the transport's inbound read with a user-leg tee. The
    # transport itself routes audio to pipeline.on_audio_delta —
    # we wrap that so the recorder sees every user PCM frame too.
    if recorder is not None:
        _orig_on_audio_delta = getattr(pipeline, "on_audio_delta", None)
        if _orig_on_audio_delta is not None:
            async def _on_audio_delta_with_recorder(frame: bytes) -> None:
                recorder.push_user(frame)
                await _orig_on_audio_delta(frame)
            pipeline.on_audio_delta = _on_audio_delta_with_recorder  # type: ignore[attr-defined]
        # Agent-leg tee: register a sink on the pipeline's TTS audio
        # track that pushes every outbound PCM chunk into the
        # recorder's agent buffer. Same sink shape as the WS forward.
        async def _agent_recording_sink(data: bytes) -> None:
            recorder.push_agent(data)
        pl_track = getattr(pipeline, "audio_track", None)
        if pl_track is not None and hasattr(pl_track, "add_sink"):
            pl_track.add_sink(_agent_recording_sink)
        # Pair the recorder's agent-turn gate with TTS lifecycle so
        # mid-stream barge-ins trim the right channel correctly.
        def _on_tts_started(_d: Any = None) -> None:
            recorder.notify_agent_turn_started()

        def _on_tts_done(_d: Any = None) -> None:
            recorder.notify_agent_tts_done()

        pipeline.on("synthesis_started", _on_tts_started)
        pipeline.on("synthesis_complete", _on_tts_done)

    # Send the initial ``ready`` envelope so the frontend transitions
    # out of its "connecting" state. Mirrors what the legacy handler
    # emits right after auth + agent load complete.
    await _send_safely({
        "type": "ready",
        "session_id": session_id,
        "agent": {"name": agent_config.get("name") or "Agent"},
    })

    try:
        # NOT run_until_shutdown=True — the FastAPI handler owns the
        # process lifecycle. We just start the conversation loop and
        # let it run until either the WS disconnects (transport read
        # loop ends) or the agent calls session.leave() etc.
        await session.start(wait_for_participant=False)

        # Keep the coroutine alive until the transport's read loop
        # signals disconnect. We block on the transport's _closed
        # event because the framework's session.start() returns once
        # the loop is wired but doesn't itself block on disconnect.
        await transport._closed.wait()
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001
        _log.exception("[voice-pipeline-videosdk] session crashed: %s", exc)
    finally:
        with _suppress():
            await session.aclose()  # type: ignore[attr-defined]
        with _suppress():
            await transport.cleanup()
        with _suppress():
            if hasattr(pipeline, "cleanup"):
                await pipeline.cleanup()
        # Billing reconciliation — final tick + transaction row.
        if billing is not None:
            with _suppress():
                await billing.stop()
        # Recording: build + upload the stereo WAV, persist on the
        # voice_call_logs row. Mirrors the legacy session_close path.
        if recorder is not None:
            try:
                bucket, key, n_bytes = await recorder.close()
                if bucket and key and n_bytes > 0 and agent_id is not None:
                    _log.info(
                        "[voice-pipeline-videosdk] recording_uploaded "
                        "session=%s bucket=%s key=%s bytes=%d",
                        session_id, bucket, key, n_bytes,
                    )
                    # Persist on voice_call_logs row so the call-history
                    # endpoints can later mint a presigned URL.
                    with _suppress():
                        from local_db import get_connection
                        conn = await get_connection()
                        try:
                            await conn.execute(
                                "UPDATE voice_call_logs SET recording_bucket=?, "
                                "recording_path=?, recording_bytes=? WHERE session_id=?",
                                (bucket, key, n_bytes, session_id),
                            )
                            await conn.commit()
                        finally:
                            await conn.close()
            except Exception:  # noqa: BLE001
                _log.exception("[voice-pipeline-videosdk] recorder.close failed")
        _log.info(
            "[voice-pipeline-videosdk] session end session=%s",
            session_id,
        )


class _suppress:
    """Inline contextlib.suppress(Exception) — kept local so the
    module's import surface is just stdlib + the framework."""

    def __enter__(self) -> None:
        return None

    def __exit__(self, exc_type, exc, tb) -> bool:
        return exc_type is not None and issubclass(exc_type, Exception)
