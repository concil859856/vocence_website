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
        from vocence_agents_plugins import VocenceTTS, VocenceSTT  # type: ignore[import-not-found]
    except ImportError as exc:
        raise RuntimeError(
            "VOICE_PIPELINE=videosdk requires the videosdk-agents framework "
            "and vocence-agents-plugins to be installed in the backend venv. "
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
    if llm_model.startswith("gemini:"):
        from videosdk.agents.plugins import GoogleLLM  # type: ignore[import-not-found]
        model_id = llm_model.split(":", 1)[1] or "gemini-2.5-flash"
        temperature = float(agent_config.get("temperature") or 0.6)
        return GoogleLLM(model=model_id, temperature=temperature)
    # TODO Phase A.5: import and instantiate VocenceRouterLLM here
    # for cerebras: / glm: / grok: model prefixes. Until the shim
    # exists, fall back to Gemini Flash so the scaffold runs end-to-
    # end during dogfooding. This intentional fallback is logged so
    # operators see when an agent's configured LLM hasn't been
    # ported yet.
    _log.warning(
        "[voice-pipeline-videosdk] llm_model=%r not yet supported on the new "
        "path; falling back to gemini-2.5-flash. Implement VocenceRouterLLM "
        "in Phase A.5 to restore the configured model.",
        llm_model,
    )
    from videosdk.agents.plugins import GoogleLLM  # type: ignore[import-not-found]
    return GoogleLLM(model="gemini-2.5-flash")


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


# Placeholder — the actual voicechat WS handler will call this
# (Phase A.4). Signature TBD once the integration shape stabilizes.
async def run_videosdk_session(
    *,
    ws: Any,
    agent_config: dict[str, Any],
    user_id: str,
    session_id: str,
) -> None:
    """Entry point for a voicechat session running on the new pipeline.

    Phase A.4 will fill this in by:
      1. Constructing an ``Agent`` subclass with the system prompt and
         function tools resolved from ``agent_config``.
      2. Building a Pipeline via ``build_pipeline_from_agent_config``.
      3. Starting an ``AgentSession`` and bridging its events to the
         outer WS (transcript_started / token / audio_meta / turn_end /
         etc.) so the existing frontend's wire protocol keeps working.
      4. Wiring the recorder + billing + RAG + custom tools via
         ``@pipeline.on(...)`` hooks (Phase A.6 / A.7 / A.8).

    Until then this is a stub that immediately raises so a deployment
    that flips ``VOICE_PIPELINE=videosdk`` doesn't silently misroute
    sessions to nowhere.
    """
    raise NotImplementedError(
        "run_videosdk_session is the Phase A.4 stub — implementation lands "
        "in a follow-up commit. The voicechat router should keep dispatching "
        "to the legacy handler until then."
    )
