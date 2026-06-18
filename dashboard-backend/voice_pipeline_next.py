"""New voice-agent backend built on the agent framework.

The legacy implementation in ``voicechat_stream.py`` opens a new
streaming session per turn and orchestrates STT / VAD / EOU / LLM /
TTS via custom code (~2.5 kLOC). This module is the replacement:
one continuous session per call, with the pipeline composition
delegated to ``the framework Pipeline class`` (the same framework
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
  ``voicechat_session`` handler through ``run_next_session()``
  when ``VOICE_PIPELINE=next``).
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


# Voice-style guidance layered IN BETWEEN the framework's base voice
# persona and the agent's own system_prompt. The framework base
# already covers "no markdown, no bullet lists, speak numbers
# naturally" — this block adds the things that specifically trip up
# TTS output in our cloning pipeline:
#   • parenthetical asides ("(or B)", "(see also...)") that the pod
#     reads literally as "open paren or B close paren"
#   • inline citations / source markers
#   • math notation ("x = 5", "f(x) = ...", "Σ", subscripts)
#   • robotic delivery — every reply sounding like a doc-page
#
# The framework's base instructions tell the model the user's
# instructions take precedence on conflict; this block sits BEFORE
# the user's system_prompt, so a user can still override any of it
# explicitly if they want a more formal persona.
_VOICE_STYLE_RULES = """\
Voice style — strict:
- Your output is spoken aloud through a voice synthesizer. Never write anything a person wouldn't naturally say in conversation: no parenthetical asides like "(or B)" or "(see also X)", no inline citations or source markers like "(source)" or numbered footnotes, no math notation like "x = 5" or "f(x) = ...". Phrase everything the way you would actually say it out loud.
- Match the rhythm of real human speech. Where it sounds natural, use occasional fillers like "hmm,", "alright,", "yeah,", "you know,", or a brief comma pause to think — sparingly, only where a person would genuinely pause. Don't sprinkle them mechanically.
- Acknowledge naturally before answering when it fits: "Alright, so...", "Yeah, basically...", "Hmm, good question." Mid-sentence pauses for emphasis are fine.
- Keep replies to one to three sentences unless more detail is explicitly asked for. When a longer answer is genuinely needed, deliver it as a flowing, connected explanation — never a structured list.
"""


# Feature flag — mirrors the .env entry. Read at module-import time
# so a process restart picks up the change. ``legacy`` is the
# fail-safe default until the new path is validated end-to-end.
VOICE_PIPELINE = (os.environ.get("VOICE_PIPELINE") or "legacy").strip().lower()


def is_next_pipeline() -> bool:
    """True when the deployment has opted into the new path. Callers
    in ``routers/voicechat.py`` switch on this flag to pick which
    session handler runs."""
    return VOICE_PIPELINE == "next"


# Defer the heavy imports until ``is_next_pipeline()`` is true.
# When the flag is off, importing this module is free — no
# the agent framework load (which pulls in onnxruntime + torch, ~150 MB
# RAM on the first import). Production processes that haven't opted
# in pay nothing.
_next_pipeline_loaded = False


def _ensure_next_pipeline_loaded() -> None:
    """Lazy-import the framework + plugins on first opt-in."""
    global _next_pipeline_loaded
    if _next_pipeline_loaded:
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
        # Internal adapters — same interface as the public plugins but
        # talk to our STT/TTS pods directly through gpu_pool, so the
        # backend doesn't round-trip through the public api.vocence.ai
        # gateway just to reach its own pods.
        from voice_pipeline_next_stt import InternalVocenceSTT
        from voice_pipeline_next_tts import InternalVocenceTTS
    except ImportError as exc:
        raise RuntimeError(
            "VOICE_PIPELINE=next requires the agent framework "
            "to be installed in the backend venv. "
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
        "InternalVocenceTTS": InternalVocenceTTS,
        "InternalVocenceSTT": InternalVocenceSTT,
    })
    _disable_framework_analytics()
    _next_pipeline_loaded = True
    _log.info("[voice-pipeline-next] framework + plugins loaded")


def _disable_framework_analytics() -> None:
    """Silence + opt out of the framework's hosted analytics phone-home.

    Every turn the framework's ``AnalyticsClient`` tries to POST to
    ``https://api.videosdk.live/v2/sessions/{id}/agent-analytics``.
    We don't use their hosted infra (no meeting room, no session id
    against their backend), so:

      1. Every call logs ``Failed sending session data : No session ID``
         as ERROR — noise that masks real errors.
      2. If they ever did get a session id, this would leak voice-call
         metadata (turn count, latency, model ids) to their endpoint.

    Both reasons are sufficient on their own. Patch the bound method
    on the class itself to a no-op so every session's AnalyticsClient
    instance silently drops the data.
    """
    try:
        from videosdk.agents.metrics.analytics import AnalyticsClient  # type: ignore[import-not-found]
    except ImportError:
        return

    def _noop_send(self: Any, _interaction_data: Any) -> None:
        return None

    AnalyticsClient.send_interaction_analytics_safe = _noop_send  # type: ignore[assignment]


def build_pipeline_from_agent_config(
    agent_config: dict[str, Any],
    *,
    user_id: str | None = None,
) -> Any:
    """Translate a Vocence agent config row to a the framework Pipeline.

    This is the boundary between the existing data model (agent_config
    fields written by Studio UI / dev-API) and the new pipeline's
    config knobs. Old fields with no direct equivalent (turn_decider,
    ultravad_threshold) are mapped to the closest framework knob; new
    fields (interrupt_min_duration, etc.) use sensible defaults that
    Studio will surface in Phase B.

    ``user_id`` is only needed when the agent's ``voice`` is a
    ``dv:<id>`` designed voice — the resolver enforces per-user
    ownership. Built-in sample voices and the fallback path don't need
    it.

    Returns a constructed ``Pipeline`` ready to hand to
    ``AgentSession(agent=..., pipeline=pipeline)``.
    """
    _ensure_next_pipeline_loaded()

    # ---- STT plugin (per-agent selectable; default Vocence) ----
    stt_provider = (agent_config.get("stt_provider") or "vocence").lower()
    language = agent_config.get("language") or "auto"
    if stt_provider == "deepgram":
        # Defaults match voice_agent/agent.py (which the user
        # validated as working well): nova-2 model, en-US language.
        # nova-3 is newer but has different streaming behavior in
        # this config — felt noticeably worse in real testing.
        # DEEPGRAM_MODEL env var can still override per deployment.
        stt = DeepgramSTT(  # type: ignore[name-defined]
            model=os.environ.get("DEEPGRAM_MODEL") or "nova-2",
            language=_to_deepgram_lang(language),
            # Frontend mic frames are 16 kHz PCM16LE. Without this
            # override DeepgramSTT defaults to sample_rate=48000 and
            # tells Deepgram "expect 48k" — Deepgram then interprets
            # our 16k bytes as 48k audio and silently returns no
            # transcripts. Same sample-rate-mismatch bug we hit on
            # SileroVAD earlier.
            sample_rate=16000,
        )
    else:
        stt = InternalVocenceSTT(  # type: ignore[name-defined]
            language=language,
        )

    # ---- LLM plugin ----
    # The agent_config stores model ids like "cerebras:gpt-oss-120b"
    # or "gemini:gemini-2.5-flash". We route to the right framework
    # plugin based on the prefix. Day 1 supports Gemini natively via
    # GoogleLLM; Cerebras + GLM + Grok need a thin wrapper around our
    # existing llm_client router — that wrapper is _build_router_llm
    # below. Grok stays as the fallback the router already configures.
    llm_model = agent_config.get("llm_model") or ""
    llm = _build_llm_plugin(llm_model, agent_config)

    # ---- TTS plugin (always Vocence — voice cloning is the diff) ----
    tts = InternalVocenceTTS(  # type: ignore[name-defined]
        voice=str(agent_config.get("voice") or "design-aria"),
        language=language if language != "auto" else None,
        user_id=user_id,
    )

    # ---- EOU + Interrupt config (translation from legacy knobs) ----
    eou_cfg = _translate_eou_config(agent_config)
    interrupt_cfg = _translate_interrupt_config(agent_config)

    pipeline = Pipeline(  # type: ignore[name-defined]
        stt=stt,
        llm=llm,
        tts=tts,
        # Pin VAD input rate to 16 kHz — that's what the frontend mic
        # frames are, and the SileroVAD default is 48 kHz. With the
        # default, 16 kHz bytes get interpreted as 48 kHz audio,
        # making VAD timing 3x slower than real-time (END_OF_SPEECH
        # fires after 3x the actual silence). Explicit match.
        #
        # min_silence_duration bumped 0.4 → 0.5 — gives a bit more
        # breathing room mid-sentence so a natural quarter-second
        # pause ("uh", "you know") doesn't fire END_OF_SPEECH and
        # commit the turn prematurely. The framework default felt
        # too aggressive in real conversations.
        vad=SileroVAD(  # type: ignore[name-defined]
            input_sample_rate=16000,
            min_silence_duration=0.5,
        ),
        turn_detector=TurnDetector(),  # type: ignore[name-defined]
        eou_config=eou_cfg,
        interrupt_config=interrupt_cfg,
    )
    return pipeline


def _to_deepgram_lang(language: str) -> str:
    """Map agent-config language names → Deepgram's BCP-47 codes.

    Default fallback is ``en-US`` (matching voice_agent/agent.py).
    NOTE: ``multi`` (Deepgram's multilingual auto-detect) is a
    Nova-3-only feature. With our default model (nova-2), sending
    "multi" silently degrades behavior — so we map agent
    ``language="auto"`` to ``en-US`` instead. Users on Nova-3 can
    still get multilingual by setting agent ``language`` to one of
    the explicit codes below or by setting DEEPGRAM_MODEL=nova-3
    AND switching the fallback to ``multi`` here.
    """
    if not language or language == "auto":
        return "en-US"
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
    return table.get(language, "en-US")


def _build_llm_plugin(llm_model: str, agent_config: dict[str, Any]) -> Any:
    """Pick a framework-compatible LLM plugin for the agent's model id.

    For Gemini we use the framework's ``GoogleLLM`` directly. For
    Cerebras / GLM / Grok we wrap our existing routing client in a
    thin shim (``VocenceRouterLLM``) that satisfies the framework's
    LLM base class — that shim already has Grok-fallback baked in via
    ``llm_client.stream_chat_with_tools``.

    Gemini is the odd one out: ``GoogleLLM`` calls Google's API
    directly with no built-in fallback. Wrap it in the framework's
    ``FallbackLLM`` with a ``VocenceRouterLLM(grok:…)`` backup so
    503s + other transient Google failures transparently fail over
    to Grok. Same SLA as every other provider, no user-visible knob.
    """
    temperature = float(agent_config.get("temperature") or 0.6)
    if llm_model.startswith("gemini:"):
        from videosdk.agents.plugins import GoogleLLM  # type: ignore[import-not-found]
        model_id = llm_model.split(":", 1)[1] or "gemini-2.5-flash"
        # Force thinking OFF for voice — Gemini 2.5 Pro/Flash will burn
        # 5+ s on the thinking pass otherwise, which destroys TTFT. The
        # framework's GoogleLLM defaults to ``thinking_budget=0`` today
        # but we pin it explicitly so a future plugin update can't
        # silently regress us.
        primary = GoogleLLM(model=model_id, temperature=temperature, thinking_budget=0)
        return _wrap_with_grok_fallback(primary, temperature)
    # Everything else (cerebras: / glm: / grok: / unprefixed default)
    # goes through our router shim so the existing multi-provider
    # routing + key rotation + Grok-fallback behavior is preserved.
    from voice_pipeline_next_llm import VocenceRouterLLM
    return VocenceRouterLLM(model=llm_model, temperature=temperature)


def _wrap_with_grok_fallback(primary: Any, temperature: float) -> Any:
    """Wrap ``primary`` in ``FallbackLLM`` with a Grok backup so any
    transient upstream failure (Google 503, key rotation exhaustion,
    rate-limit, network blip) transparently fails over to xAI Grok.

    Backup is the same Grok model the legacy ``stream_chat_with_tools``
    fallback path uses (``VOICECHAT_GROK_FALLBACK_MODEL``), routed via
    ``VocenceRouterLLM`` so it picks up our internal key pool. Falls
    back to just the primary if xAI isn't configured on this deploy
    (no GROK_API_KEYS) — no point in a fallback that can't run.
    """
    try:
        import llm_client  # local import keeps cold-start light
        from videosdk.agents.llm.fallback_llm import FallbackLLM  # type: ignore[import-not-found]
        from voice_pipeline_next_llm import VocenceRouterLLM
    except Exception as exc:  # noqa: BLE001
        _log.warning("[voice-pipeline-next] Grok fallback unavailable: %s", exc)
        return primary

    grok_model = getattr(llm_client, "VOICECHAT_GROK_FALLBACK_MODEL", None)
    is_xai_ready = getattr(llm_client, "xai_llm_configured", lambda: False)()
    if not grok_model or not is_xai_ready:
        _log.info(
            "[voice-pipeline-next] Grok fallback disabled (XAI_API_KEY not set) "
            "— primary LLM will not have a backup"
        )
        return primary
    backup = VocenceRouterLLM(model=f"grok:{grok_model}", temperature=temperature)
    return FallbackLLM(
        providers=[primary, backup],
        # Re-enable the primary after 60 s — long enough for a brief
        # spike to clear without permanently demoting it.
        temporary_disable_sec=60.0,
        # Three consecutive errors → primary stays disabled for the
        # rest of the session.
        permanent_disable_after_attempts=3,
    )


def _translate_eou_config(agent_config: dict[str, Any]) -> Any:
    """Map legacy EOU knobs (min_delay_ms, ultravad_threshold) to the
    framework's ``EOUConfig`` shape.

    Defaults pinned to the voice_agent example the user validated as
    working well (``[0.8, 1.6]`` window, ``0.8`` certainty threshold) —
    those values produce the most natural turn-taking. Legacy field
    overrides are still respected: if an agent's config_json sets
    ``min_delay_ms``, that becomes the low end of the window; if it
    sets ``ultravad_threshold``, that maps onto the certainty
    threshold via the same 0.5+0.5*x rescale used before.
    """
    _ensure_next_pipeline_loaded()
    min_delay_ms_set = agent_config.get("min_delay_ms")
    if min_delay_ms_set:
        min_sec = int(min_delay_ms_set) / 1000.0
        max_sec = min_sec * 2.0
    else:
        min_sec, max_sec = 0.8, 1.6  # voice_agent's validated values
    threshold = agent_config.get("ultravad_threshold")
    if threshold is None:
        eou_certainty = 0.8  # voice_agent's validated value
    else:
        eou_certainty = min(max(0.5 + 0.5 * float(threshold), 0.0), 1.0)
    return EOUConfig(  # type: ignore[name-defined]
        min_max_speech_wait_timeout=[min_sec, max_sec],
        eou_certainty_threshold=eou_certainty,
    )


def _translate_interrupt_config(agent_config: dict[str, Any]) -> Any:
    """Map legacy barge-in tuning to the framework's ``InterruptConfig``.

    The legacy frontend used ``BACKCHANNEL_GRACE_MS=60``,
    ``BACKCHANNEL_MAX_MS=180``, ``BARGE_IN_FADE_MS=80`` (from our
    most recent tuning). the framework's defaults are gentler: 0.5 s
    duration, 2 words, 0.4 s fade. The voice_agent example the user
    validated tuned aggressive: 0.2 s / 1 word / 0.1 s fade. We
    pick the aggressive defaults for snappier UX, since the user
    explicitly liked that example's feel.
    """
    _ensure_next_pipeline_loaded()
    return InterruptConfig(  # type: ignore[name-defined]
        mode="HYBRID",
        # Dropped 0.2 → 0.1: brief barge-in attempts ("hey", "stop")
        # that are too short to sustain 200ms of continuous speech
        # were getting their interrupt-monitor task cancelled before
        # firing (VAD END_OF_SPEECH cancels the monitor). 100ms catches
        # those without significantly increasing false interrupts —
        # the framework still requires ``interrupt_min_words=1`` so
        # background noise alone won't fire.
        interrupt_min_duration=0.1,
        interrupt_min_words=1,
        interrupt_fade_duration=0.1,
        resume_on_false_interrupt=False,
    )


async def run_next_session(
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

    Deliberate scope boundary: the Vocence Assistant / Logos path
    (when no agent_id is supplied) stays on legacy. That path uses
    free_mode billing and anonymous users which the new pipeline
    doesn't model yet, and Logos works fine on legacy today — no
    point in regressing it just to converge implementations.
    routers/voicechat.py gates the dispatch on ``agent_ctx is not
    None`` for this reason.
    """
    _ensure_next_pipeline_loaded()
    from voice_pipeline_next_transport import FastAPIWebSocketTransport
    from datetime import datetime, timezone

    loop = asyncio.get_running_loop()

    # Stamp session start for the voice_call_logs row (drives the
    # call-history endpoints in Studio + the developer API). Updated
    # below as billing/end signals come in.
    _session_started_at = datetime.now(timezone.utc)
    _end_reason_holder: dict[str, str] = {"reason": "client_closed"}
    pipeline = build_pipeline_from_agent_config(agent_config, user_id=user_id)

    # Build a minimal Agent subclass from the agent config. The
    # system prompt drives the LLM's instructions; the first_message
    # is the on_enter greeting the framework's pipeline plays once
    # the session is live.
    #
    # Instructions stack (top→bottom, LLM sees in this order):
    #   1. Framework BASE_VOICE_INSTRUCTIONS (added by Agent.__init__
    #      via use_base_instructions=True)
    #   2. _VOICE_STYLE_RULES (TTS-specific style: no parens, no math,
    #      use natural fillers — see comment at the top of this file)
    #   3. Agent's own system_prompt (verbatim)
    _user_prompt = (agent_config.get("system_prompt") or "").strip() or (
        "You are a helpful voice assistant. Speak naturally and concisely."
    )
    instructions = f"{_VOICE_STYLE_RULES}\n\n{_user_prompt}"
    first_message = (agent_config.get("first_message") or "").strip() or None

    # Tool list — built-in tools (per agent.config.enabled_tools)
    # AND custom webhook tools bound to this agent. The bridge in
    # voice_pipeline_next_tools handles both: built-ins via
    # the agent_tools_service registry, custom tools via the
    # existing _load_custom_tools_for_agent loader + dispatch_custom_tool.
    #
    # ``on_tool_event`` lets the wrappers emit tool_call_started /
    # tool_call_completed JSON envelopes back to the frontend so the
    # tool chip (e.g. "🔍 Searching the web…") renders on the
    # current assistant bubble — same envelope shape the legacy
    # voicechat router used.
    async def _on_tool_event(event_type: str, payload: dict[str, Any]) -> None:
        try:
            await ws.send_json({"type": event_type, **payload})
        except Exception as exc:  # noqa: BLE001
            _log.debug("[voice-pipeline-next] tool event send failed: %s", exc)

    from voice_pipeline_next_tools import build_tools_for_agent
    tools_list = await build_tools_for_agent(
        agent_config,
        agent_id=agent_id,
        user_id=user_id,
        on_tool_event=_on_tool_event,
    )

    class _VocenceAgent(Agent):  # type: ignore[name-defined,misc]
        def __init__(self) -> None:
            super().__init__(
                use_base_instructions=True,
                instructions=instructions,
                tools=tools_list,
            )

        async def on_enter(self) -> None:
            if first_message:
                # session.say() drives the TTS but bypasses the LLM —
                # so the @pipeline.on('llm') token bridge never fires
                # for the greeting and the chat UI gets no text bubble.
                # Mirror the legacy behavior by hand-sending the
                # greeting as a single token frame + a turn_end. The
                # frontend's reveal timer paints the text at speaking
                # pace as the audio plays.
                await _send_safely({"type": "token", "text": first_message})
                await self.session.say(first_message)
                # turn_end is normally fired by synthesis_complete, but
                # send a fallback here so the reveal buffer terminates
                # even if synthesis_complete doesn't reach us in time
                # for very short greetings. _on_synthesis_complete is
                # idempotent on the frontend side (it just marks the
                # current bubble non-pending).

        async def on_exit(self) -> None:
            # No teardown hook needed — session cleanup happens in the
            # ``finally`` block of run_next_session (transport, pipeline,
            # billing, recorder all close there).
            pass

    agent = _VocenceAgent()

    # Bridge transport. The framework's AgentSession reads
    # pipeline.audio_track for outbound audio and pipeline.on_audio_delta
    # for inbound — both are wired up by the transport during connect().
    # We also hand the transport two callbacks for the client-protocol
    # control frames the existing frontend sends — text input and cancel
    # — so the legacy WS contract works unchanged.
    #
    # session is constructed below but the callbacks need a forward
    # reference. Use a dict holder so the closures resolve lazily at
    # call time without UnboundLocalError.
    _session_holder: dict[str, Any] = {"session": None}

    def _reset_pipeline_interrupt_flags() -> None:
        """Clear the orchestrator's interrupt flags before starting a
        new typed turn. process_text doesn't reset these (only the STT
        path's _generate_and_synthesize does), so without this reset a
        preceding {cancel} would leave content_generation thinking
        it's still interrupted and the new turn dies on the first
        LLM chunk."""
        orchestrator = getattr(pipeline, "orchestrator", None)
        if orchestrator is None:
            return
        try:
            orchestrator._is_interrupted = False
            if getattr(orchestrator, "content_generation", None):
                orchestrator.content_generation.reset_interrupt()
            if getattr(orchestrator, "speech_generation", None):
                orchestrator.speech_generation.reset_interrupt()
        except Exception as exc:  # noqa: BLE001
            _log.debug("[voice-pipeline-next] reset_interrupt_flags failed: %s", exc)

    async def _on_text_frame(body: str) -> None:
        """User typed a message in the chat UI. Route through
        pipeline.process_text — it bypasses STT/VAD, runs the LLM, and
        the existing @pipeline.on('llm') hook streams tokens back to
        the UI."""
        # Frontend sends {cancel} immediately before any typed text
        # when an assistant bubble is still pending. Our cancel
        # handler above synchronously awaits _interrupt_pipeline, which
        # leaves _is_interrupted=True on the orchestrator. Reset
        # those flags here so process_text's content_generation can
        # actually run instead of bailing out on the first chunk.
        _reset_pipeline_interrupt_flags()
        try:
            await pipeline.process_text(body)
        except Exception as exc:  # noqa: BLE001
            _log.warning("[voice-pipeline-next] process_text failed: %s", exc)

    async def _on_cancel_frame() -> None:
        """User barge-in via the UI cancel button OR the reflexive cancel
        the frontend sends before any new text input.

        Frontend behavior: when the user submits a typed message, it sends
        ``{cancel}`` THEN ``{text}``. That cancel always fires regardless
        of whether the agent is speaking — it's a "stop whatever was
        playing locally" signal. If we forward every cancel to
        ``pipeline.interrupt()``, the framework's orchestrator sets
        ``_is_interrupted=True`` and cancels in-flight tasks, which then
        kills the very turn the text frame right behind it is trying to
        start (the agent never replies, content_generation discards the
        turn). Only fire the framework interrupt when the agent is
        actually producing speech (SPEAKING) or generating a response
        (THINKING). Otherwise just echo ``{cancelled}`` so the frontend
        flushes its local audio buffer (e.g. greeting tail still draining
        through the worklet) without disturbing orchestrator state.
        """
        try:
            from videosdk.agents.utils import AgentState  # type: ignore[import-not-found]
        except Exception:  # noqa: BLE001
            AgentState = None  # type: ignore[assignment]
        s = _session_holder.get("session")
        state = getattr(s, "agent_state", None) if s is not None else None
        is_active = AgentState is not None and state in (AgentState.SPEAKING, AgentState.THINKING)
        if is_active:
            # AWAIT the interrupt to completion so the next frame
            # (typically the typed text right behind this cancel) sees
            # a settled pipeline state. pipeline.interrupt() spawns a
            # task — if we let it run async, the text frame's
            # process_text starts first and then gets killed when the
            # interrupt task finally fires. Calling _interrupt_pipeline
            # directly (it's the underlying coroutine) lets us await.
            orchestrator = getattr(pipeline, "orchestrator", None)
            if orchestrator is not None and hasattr(orchestrator, "_interrupt_pipeline"):
                try:
                    await orchestrator._interrupt_pipeline()
                except Exception as exc:  # noqa: BLE001
                    _log.warning("[voice-pipeline-next] interrupt failed: %s", exc)
            # The bridge below catches synthesis_interrupted /
            # backchannel_detected and sends {cancelled} downstream.
        else:
            await _send_safely({"type": "cancelled"})

    transport = FastAPIWebSocketTransport(
        loop=loop,
        pipeline=pipeline,
        ws=ws,
        on_text_frame=_on_text_frame,
        on_cancel_frame=_on_cancel_frame,
    )
    try:
        await transport.connect()
    except Exception as exc:  # noqa: BLE001
        _log.exception("[voice-pipeline-next] transport.connect failed: %s", exc)
        raise

    # Wire the transport's audio_track onto the pipeline. In the
    # framework's hosted entry point (job.py), this happens via
    # ``pipeline._set_loop_and_audio_track(loop, room.audio_track)``
    # right after the meeting room joins. We skip job.py entirely
    # (the room is a videosdk meeting concept, irrelevant here), so we
    # have to call the same hook ourselves — otherwise pipeline.tts
    # never gets an audio sink and the agent's TTS output silently
    # vanishes (logged upstream as "Audio track not initialized -
    # skipping last audio callback registration").
    pipeline._set_loop_and_audio_track(loop, transport.audio_track)

    session = AgentSession(agent=agent, pipeline=pipeline)  # type: ignore[name-defined]
    # Publish the session into the forward-reference holder so the
    # cancel-frame callback (defined earlier than session) can query
    # ``session.agent_state`` to distinguish a real barge-in from a
    # reflexive frontend cancel.
    _session_holder["session"] = session
    _log.info(
        "[voice-pipeline-next] session start session=%s agent_id_in_config=%s "
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
            _log.debug("[voice-pipeline-next] send_json failed: %s", exc)

    def _on_transcript_ready(data: Any) -> None:
        # We don't SEND the transcript from here (the user_turn_start
        # hook does that, awaited before LLM). But this event fires
        # for both STT-driven AND typed-text turns, so it's the only
        # reliable place to capture user_text into _turn_state for
        # the studio_voicechat_history INSERT. user_turn_start fires
        # only for STT path; transcript_ready covers both.
        text = ""
        if isinstance(data, dict):
            text = (data.get("text") or "").strip()
        if not text:
            return
        from time import monotonic as _mono
        _turn_state["user_text"] = text
        _turn_state["agent_text_parts"] = []
        _turn_state["turn_started_at"] = _mono()

    def _on_content_generated(_data: Any) -> None:
        # No-op now that the @pipeline.on("llm") streaming hook
        # below sends per-token deltas as they materialize. We
        # keep the listener registered so future code can add
        # content-complete telemetry without re-wiring.
        return

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

    # Synthesis-complete signal. The framework normally fires
    # last_audio_byte from inside audio_track.recv() — but recv() is
    # only called when something CONSUMES the track (videosdk
    # meeting room's RTP outbound). We don't have a meeting room —
    # we push bytes directly via audio_track.add_sink() → WS, so
    # recv() never runs and last_audio_byte never fires. Same story
    # for synthesis_complete on the pipeline (typed-text path only).
    #
    # The reliable end-of-turn signal in our setup is when our TTS
    # adapter's synthesize() coroutine returns — at that moment, all
    # pod bytes have been pushed through the sink to the WS. Wrap
    # the TTS plugin's synthesize so we fire our own turn-end hooks
    # in the finally block. Both UI (turn_end) and billing
    # (mark_turn_ended) need this signal.
    _tts_plugin = pipeline.tts
    if _tts_plugin is not None and hasattr(_tts_plugin, "synthesize"):
        _original_synthesize = _tts_plugin.synthesize

        async def _wrapped_synthesize(text: Any, voice_id: Any = None, **kwargs: Any) -> None:
            try:
                await _original_synthesize(text, voice_id=voice_id, **kwargs)
            finally:
                # Fire our turn-end signal exactly once per synthesize
                # call. _on_synthesis_complete sends {type:'turn_end'}
                # to the UI (resets audioStartedForTurnRef so the
                # next turn's reveal timer kicks). The billing
                # handler (registered below) decrements in_flight so
                # the idle watchdog can fire.
                with _suppress():
                    _on_synthesis_complete(None)

        _tts_plugin.synthesize = _wrapped_synthesize  # type: ignore[assignment]

    # Phase A.10 — streaming token deltas. The framework's
    # @pipeline.on("llm") hook is an async-generator middleware that
    # wraps the text stream between LLM and TTS. Every chunk MUST be
    # yielded through (or TTS gets no input) — alongside, we send a
    # ``token`` event to the frontend so the chat bubble paces with
    # the audio instead of dumping the full reply when it's done.
    #
    # Spacing fix: some LLMs (Cerebras / GLM in particular) stream
    # sub-token deltas where punctuation marks arrive as their own
    # chunk without a trailing space, and the next chunk starts with
    # a letter — concatenated, that's "thing!I can" instead of
    # "thing! I can". The pod's punctuation parser handles audio
    # pacing fine, but the chat bubble (which just concatenates the
    # raw chunks) shows the missing space verbatim. Inject a space
    # at every punctuation→letter boundary, both within a chunk
    # (regex) and across chunk boundaries (track prev tail). Yield
    # the corrected text to TTS too so the pod hears the same.
    import re as _re
    _RE_PUNCT_LETTER = _re.compile(r"([.!?,:;])([A-Za-z])")
    _prev_tail_holder = {"ch": ""}
    # Cross-chunk citation-marker stripper state. Some LLMs
    # (especially Cerebras/GLM after a tool call) like to splice
    # source citations like 【web_search】 inline into prose. They
    # leak into the chat bubble AND the TTS audio ("dot dot dot
    # web search dot dot dot"). Strip them character-by-character so
    # brackets that span chunk boundaries still close cleanly.
    _marker_state = {"inside": False}

    def _strip_markers(chunk_str: str) -> str:
        if not chunk_str:
            return chunk_str
        out: list[str] = []
        for ch in chunk_str:
            if _marker_state["inside"]:
                if ch == "】":
                    _marker_state["inside"] = False
                continue
            if ch == "【":
                _marker_state["inside"] = True
                continue
            out.append(ch)
        return "".join(out)

    def _fix_spacing(chunk_str: str) -> str:
        if not chunk_str:
            return chunk_str
        prev = _prev_tail_holder["ch"]
        head = chunk_str
        if prev and prev in ".!?,:;" and head[0].isalpha():
            head = " " + head
        fixed = _RE_PUNCT_LETTER.sub(r"\1 \2", head)
        _prev_tail_holder["ch"] = fixed[-1] if fixed else prev
        return fixed

    @pipeline.on("llm")
    async def _on_llm_stream(text_stream):  # type: ignore[misc]
        _prev_tail_holder["ch"] = ""
        _marker_state["inside"] = False
        async for chunk in text_stream:
            if isinstance(chunk, str) and chunk:
                stripped = _strip_markers(chunk)
                if not stripped:
                    # Entire chunk was inside a marker — nothing to
                    # send to UI or TTS. Yield empty string to keep
                    # the stream protocol intact.
                    yield ""
                    continue
                fixed = _fix_spacing(stripped)
                # Accumulate the cleaned text for the end-of-turn
                # studio_voicechat_history INSERT.
                _turn_state["agent_text_parts"].append(fixed)
                try:
                    await ws.send_json({"type": "token", "text": fixed})
                except Exception as exc:  # noqa: BLE001
                    _log.debug("[voice-pipeline-next] token send failed: %s", exc)
                yield fixed
            else:
                yield chunk

    # ---- Billing (Phase A.7) -------------------------------------------
    # Same VoiceAgentBilling class the legacy path uses — instantiated
    # here so the new path bills consistently. on_session_end fires on
    # billing-exhausted / max-duration / idle-timeout; on_deduct
    # surfaces the new balance to the frontend after each tick.
    from voice_agent_billing import VoiceAgentBilling  # local import
    billing: Any | None = None
    if agent_id is not None:
        async def _on_session_end(reason: str) -> None:
            _end_reason_holder["reason"] = reason
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

        # For STT-driven turns the framework's synthesis_complete /
        # last_audio_byte don't fire in our WS-only setup (no
        # audio_track.recv() consumer to drain the buffer). Instead
        # we wrap pipeline.tts.synthesize above to fire turn-end
        # signals when our TTS coroutine returns. Hook the billing
        # turn-end into the same wrap so in_flight_turns decrements
        # and the idle watchdog can actually fire.
        _orch = getattr(pipeline, "orchestrator", None)
        _sg = getattr(_orch, "speech_generation", None) if _orch else None
        if _sg is not None:
            _sg.on("synthesis_interrupted", _billing_turn_end)
        # Wrap the (already-wrapped-for-UI) synthesize to ALSO
        # decrement billing. Order matters: UI signal first (so the
        # frontend sees turn_end before any subsequent activity),
        # billing second.
        _tts_for_billing = pipeline.tts
        if _tts_for_billing is not None and hasattr(_tts_for_billing, "synthesize"):
            _synth_with_ui_end = _tts_for_billing.synthesize

            async def _synth_with_billing_end(text: Any, voice_id: Any = None, **kwargs: Any) -> None:
                try:
                    await _synth_with_ui_end(text, voice_id=voice_id, **kwargs)
                finally:
                    _billing_turn_end()

            _tts_for_billing.synthesize = _synth_with_billing_end  # type: ignore[assignment]

        # Kick off the billing watchdog loop — this is what drives the
        # per-second credit tick, the idle-timeout check (default 60 s
        # of no user activity → on_session_end('idle_timeout') → WS
        # close), and the max-duration cap. Without this call the
        # billing object exists but the loop never runs, so an idle
        # tab stays connected forever.
        billing.start()

    # ---- Knowledge-base RAG (Phase A.8) -------------------------------
    # When an agent has a knowledge base, every user turn should be
    # enriched with the top-k most relevant chunks before the LLM
    # sees it. agent_knowledge.search_agent_knowledge is cheap when
    # no KB is attached (returns empty list), so we wire it
    # unconditionally and let it no-op when there's nothing to find.

    # Always-on: send the user transcript to the frontend BEFORE the
    # LLM starts. The framework awaits all user_turn_start hooks before
    # kicking off content_generation, so registering this here
    # guarantees {type:'transcript'} reaches the UI before any
    # {type:'token'} from the LLM stream. Without this the agent's
    # reply bubble could appear above the user's transcript bubble in
    # the chat (token-send wins the race against fire-and-forget
    # transcript_ready listener).
    # Per-turn state for the studio_voicechat_history INSERT and
    # for the recorder's TTS-turn gate (both need user text + agent
    # text + timing for each turn). Mutated by the user_turn_start
    # hook (captures user text) and by the @pipeline.on("llm") hook
    # (accumulates agent text). Drained + reset by the TTS wrap
    # below at end-of-turn.
    _turn_state: dict[str, Any] = {
        "user_text": "",
        "agent_text_parts": [],
        "turn_started_at": None,
    }

    async def _send_user_transcript(transcript: Any) -> None:
        text = transcript if isinstance(transcript, str) else \
            (transcript.get("text") if isinstance(transcript, dict) else "")
        text = (text or "").strip()
        if text:
            await _send_safely({"type": "transcript", "text": text})
            # Capture for studio_voicechat_history at end-of-turn.
            from time import monotonic as _mono
            _turn_state["user_text"] = text
            _turn_state["agent_text_parts"] = []
            _turn_state["turn_started_at"] = _mono()

    pipeline.on("user_turn_start", _send_user_transcript)

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
                _log.exception("[voice-pipeline-next] RAG search failed")
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

        async def _on_user_turn_start(transcript: Any) -> None:
            # Must be ``async def`` — the framework's pipeline_hooks
            # does ``await hook(transcript)``. A sync ``def`` returns
            # None and ``await None`` raises
            # "object NoneType can't be used in 'await' expression".
            #
            # AWAIT the enrichment (don't fire-and-forget with
            # create_task) — the framework calls this hook synchronously
            # before content_generation runs, so awaiting here is what
            # actually guarantees the RAG block lands in the prompt
            # before the LLM sees it. The previous create_task version
            # raced the LLM call and the RAG was usually missed.
            text = transcript if isinstance(transcript, str) else \
                (transcript.get("text") if isinstance(transcript, dict) else "")
            await _enrich_with_rag(text or "")

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
        # Pair the recorder's agent-turn gate with TTS lifecycle.
        # ``synthesis_started`` / ``synthesis_complete`` only emit on
        # the typed-text path — STT-driven turns never fire them
        # (same bug pattern as the idle-timeout fix). Wrap
        # pipeline.tts.synthesize instead so notify_agent_turn_started
        # fires when the TTS coroutine begins, and
        # notify_agent_tts_done fires in the finally block on every
        # turn including barge-ins and exceptions.
        _tts_for_recorder = pipeline.tts
        if _tts_for_recorder is not None and hasattr(_tts_for_recorder, "synthesize"):
            _synth_pre_recorder = _tts_for_recorder.synthesize

            async def _synth_with_recorder(text: Any, voice_id: Any = None, **kwargs: Any) -> None:
                try:
                    recorder.notify_agent_turn_started()
                except Exception:  # noqa: BLE001
                    pass
                try:
                    await _synth_pre_recorder(text, voice_id=voice_id, **kwargs)
                finally:
                    try:
                        recorder.notify_agent_tts_done()
                    except Exception:  # noqa: BLE001
                        pass

            _tts_for_recorder.synthesize = _synth_with_recorder  # type: ignore[assignment]

    # Per-turn studio_voicechat_history INSERT. Same purpose as
    # legacy's _record_turn — without this, the call-history modal
    # in Studio is empty for every session served by the new
    # pipeline (the per-turn rows are what drives the transcript
    # view, even when recording is off).
    #
    # Wrap pipeline.tts.synthesize one more time so we run AFTER the
    # recorder + billing + UI-end wraps. user_text comes from the
    # state captured by _send_user_transcript; agent_text comes from
    # the @pipeline.on("llm") accumulator above. Both are reset on
    # the next user_turn_start.
    _tts_for_history = pipeline.tts
    if _tts_for_history is not None and hasattr(_tts_for_history, "synthesize"):
        _synth_pre_history = _tts_for_history.synthesize

        async def _synth_with_history(text: Any, voice_id: Any = None, **kwargs: Any) -> None:
            try:
                await _synth_pre_history(text, voice_id=voice_id, **kwargs)
            finally:
                # Drain per-turn state synchronously (snapshot), then
                # fire-and-forget the DB write so a slow / failing
                # _record_turn can NEVER stall the TTS coroutine.
                # Stalling would block the next turn since the
                # framework's speech_generation holds tts_lock until
                # synthesize returns.
                user_text = (_turn_state.get("user_text") or "").strip()
                agent_text = "".join(_turn_state.get("agent_text_parts") or []).strip()
                started_at = _turn_state.get("turn_started_at")
                # Reset state up-front so the next user_turn_start
                # is never confused by a stale buffer.
                _turn_state["user_text"] = ""
                _turn_state["agent_text_parts"] = []
                _turn_state["turn_started_at"] = None
                if not user_text and not agent_text:
                    return
                from time import monotonic as _mono
                latency_ms = (
                    int((_mono() - started_at) * 1000) if started_at else 0
                )

                async def _persist() -> None:
                    try:
                        from routers.voicechat import _record_turn
                        await _record_turn(
                            user_id=user_id,
                            user_text=user_text,
                            bot_text=agent_text,
                            mode="voice_next",
                            latency_ms=latency_ms,
                            ttft_ms=0,
                            ttfa_ms=None,
                            error=None,
                            session_id=session_id,
                            agent_id=agent_id,
                        )
                    except Exception:  # noqa: BLE001
                        _log.exception("[voice-pipeline-next] _record_turn failed")

                # ``asyncio.create_task`` returns immediately; the
                # synthesize coroutine returns to the framework
                # without waiting on the DB.
                with _suppress():
                    asyncio.create_task(_persist())

        _tts_for_history.synthesize = _synth_with_history  # type: ignore[assignment]

    # Send the initial ``ready`` envelope so the frontend transitions
    # out of its "connecting" state. The ``capabilities`` block tells
    # the frontend that streaming voice + turn-detection are available
    # on this session (both are always on under the new pipeline, since
    # the framework owns VAD/STT/turn_detector internally — there's no
    # per-call provision step like the legacy path had). Frame format
    # matches what the transport actually expects from the mic.
    await _send_safely({
        "type": "ready",
        "session_id": session_id,
        "agent": {"name": agent_config.get("name") or "Agent"},
        "capabilities": {
            "voice_stream": True,
            "turn_detection": True,
            "frame": {"sample_rate": 16000, "encoding": "pcm_s16le", "frame_ms": 20},
        },
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
        _log.exception("[voice-pipeline-next] session crashed: %s", exc)
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
        # Recording: build + upload the stereo WAV. Fields get folded
        # into the voice_call_logs row below.
        _recording_bucket: str | None = None
        _recording_key: str | None = None
        _recording_bytes: int = 0
        if recorder is not None:
            try:
                bucket, key, n_bytes = await recorder.close()
                if bucket and key and n_bytes > 0:
                    _recording_bucket = bucket
                    _recording_key = key
                    _recording_bytes = n_bytes
                    _log.info(
                        "[voice-pipeline-next] recording_uploaded "
                        "session=%s bucket=%s key=%s bytes=%d",
                        session_id, bucket, key, n_bytes,
                    )
            except Exception:  # noqa: BLE001
                _log.exception("[voice-pipeline-next] recorder.close failed")

        # voice_call_logs row — one INSERT OR REPLACE per session.
        # Legacy did this from routers/voicechat.py's session_close
        # path; without it the call history in Studio (and the
        # developer-API /voice/calls endpoints) stays empty for every
        # call served by the new pipeline. The helper itself sums
        # turn_count + char totals from studio_voicechat_history rows
        # that already share this session_id, so the row stays in
        # sync with per-turn data without duplicating storage.
        try:
            from routers.voicechat import _log_call_session
            _ended_at = datetime.now(timezone.utc)
            duration_ms = int((_ended_at - _session_started_at).total_seconds() * 1000)
            await _log_call_session(
                session_id=session_id,
                user_id=user_id,
                agent_id=agent_id,
                agent_name=(agent_config.get("name") or None),
                started_at_iso=_session_started_at.isoformat(),
                ended_at_iso=_ended_at.isoformat(),
                duration_ms=duration_ms,
                end_reason=_end_reason_holder["reason"],
                recording_path=_recording_key,
                recording_bucket=_recording_bucket,
                recording_bytes=_recording_bytes or None,
            )
        except Exception:  # noqa: BLE001
            _log.exception("[voice-pipeline-next] _log_call_session failed")

        _log.info(
            "[voice-pipeline-next] session end session=%s",
            session_id,
        )


class _suppress:
    """Inline contextlib.suppress(Exception) — kept local so the
    module's import surface is just stdlib + the framework."""

    def __enter__(self) -> None:
        return None

    def __exit__(self, exc_type, exc, tb) -> bool:
        return exc_type is not None and issubclass(exc_type, Exception)
