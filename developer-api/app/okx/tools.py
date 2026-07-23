"""The 6 Vocence tools exposed to the OKX AI Marketplace.

Single source of truth for: the tool name an agent calls, its JSON-schema
input contract, its per-call price, and the dashboard endpoint it proxies to.
The routes, the payment price table, and the discovery manifest are all built
from this list, so adding or repricing a tool is a one-place change.

Text-to-Music and Voice Agents are intentionally absent: music has no public
endpoint, and voice agents are a real-time WS surface that MCP's request/reply
tool model does not fit.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from . import config


@dataclass(frozen=True)
class Tool:
    name: str                    # MCP tool name the agent calls
    title: str
    description: str
    # The Vocence /v1 API path the tool proxies to (all POST). Fulfillment
    # reuses the existing paid API with a system key — no new logic.
    v1_path: str
    input_schema: dict[str, Any]
    # Flat per-call price (USD string). None for the metered dubbing tool,
    # which prices per minute at request time — see ``metered``.
    price: str | None = None
    # True for tools priced per minute of media rather than per call.
    metered: bool = False
    tags: list[str] = field(default_factory=list)


def _str(desc: str, **extra: Any) -> dict:
    return {"type": "string", "description": desc, **extra}


TOOLS: list[Tool] = [
    Tool(
        name="vocence_text_to_speech",
        title="Text to Speech",
        description=(
            "Synthesize natural speech from text using a built-in Vocence voice. "
            "Returns an audio URL."
        ),
        v1_path="/v1/tts/speak",
        price=config.PRICE_TTS,
        tags=["audio", "tts", "voice"],
        input_schema={
            "type": "object",
            "properties": {
                "text": _str("Text to speak. Up to 2000 characters.", maxLength=2000),
                "voice_id": _str("Built-in voice id. Omit for the default voice.", default=""),
            },
            "required": ["text"],
        },
    ),
    Tool(
        name="vocence_speech_to_text",
        title="Speech to Text",
        description="Transcribe spoken audio to text. Accepts an audio URL.",
        v1_path="/v1/stt/transcribe",
        price=config.PRICE_STT,
        tags=["audio", "stt", "transcription"],
        input_schema={
            "type": "object",
            "properties": {
                "audio_url": _str("HTTPS URL of the audio to transcribe. Up to 5 minutes."),
                "language": _str("Optional source-language hint (canonical name).", default=""),
            },
            "required": ["audio_url"],
        },
    ),
    Tool(
        name="vocence_voice_design",
        title="Voice Design",
        description=(
            "Generate a brand-new voice from a text description and speak a line "
            "in it. Returns a preview audio URL."
        ),
        v1_path="/v1/voice/design/preview",
        price=config.PRICE_VOICE_DESIGN,
        tags=["audio", "voice", "design"],
        input_schema={
            "type": "object",
            "properties": {
                "prompt": _str("Description of the voice, e.g. 'warm female narrator, calm, 30s'."),
                "text": _str("A line for the designed voice to speak in the preview."),
            },
            "required": ["prompt", "text"],
        },
    ),
    Tool(
        name="vocence_voice_clone",
        title="Voice Cloning",
        description=(
            "Clone the voice from a short reference clip and make it say new text. "
            "You must hold the rights/consent for the reference voice."
        ),
        v1_path="/v1/voice/clone",
        price=config.PRICE_VOICE_CLONE,
        tags=["audio", "voice", "clone"],
        input_schema={
            "type": "object",
            "properties": {
                "reference_audio_url": _str("HTTPS URL of a 5–30s reference clip."),
                "text": _str("Text for the cloned voice to speak."),
                "reference_text": _str("Optional transcript of the reference clip.", default=""),
            },
            "required": ["reference_audio_url", "text"],
        },
    ),
    Tool(
        name="vocence_noise_remover",
        title="Noise Remover",
        description="Remove background noise from audio while preserving speech. Accepts an audio URL.",
        v1_path="/v1/audio/noise-remover",
        price=config.PRICE_NOISE_REMOVER,
        tags=["audio", "enhance", "denoise"],
        input_schema={
            "type": "object",
            "properties": {
                "audio_url": _str("HTTPS URL of the audio to clean. Up to 5 minutes / 50 MB."),
            },
            "required": ["audio_url"],
        },
    ),
    Tool(
        name="vocence_video_dub",
        title="Video Dubbing",
        description=(
            "Translate a video into another language in the original speaker's voice, "
            "optionally lip-synced. Priced per minute of source video, per language. "
            "You must hold the rights/consent for everyone in the video."
        ),
        v1_path="/v1/video/dub",
        metered=True,
        tags=["video", "dubbing", "translate"],
        input_schema={
            "type": "object",
            "properties": {
                "video_url": _str("HTTPS URL of the source video. Up to 10 min."),
                "target_languages": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "ISO codes, e.g. ['ja','es']. Up to 3.",
                    "maxItems": 3,
                },
                "duration_sec": {"type": "number", "description": "Source video length in seconds."},
                "lipsync": {"type": "boolean", "description": "Re-render the mouth to match.", "default": False},
                "source_language": _str("Optional source-language ISO code.", default="auto"),
                "consent_attested": {
                    "type": "boolean",
                    "const": True,
                    "description": (
                        "Must be true: you confirm you hold the rights and consent for "
                        "every person appearing or speaking in the video."
                    ),
                },
                "callback_url": _str(
                    "Optional public HTTPS URL POSTed once when the job finishes.", default=""
                ),
            },
            "required": ["video_url", "target_languages", "duration_sec", "consent_attested"],
        },
    ),
]


TOOLS_BY_NAME: dict[str, Tool] = {t.name: t for t in TOOLS}
