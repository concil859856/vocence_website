from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


# Languages accepted by the Qwen3-ASR transcriber and the voice-clone
# pipeline. Use canonical English names — the model rejects ISO codes
# like "en"/"ja". Keep in sync with app/src/pages/Studio.tsx
# (STT_LANGUAGES).
STT_LANGUAGE = Literal[
    "English", "Chinese", "Cantonese", "Arabic", "German", "French",
    "Spanish", "Portuguese", "Indonesian", "Italian", "Korean", "Russian",
    "Thai", "Vietnamese", "Japanese", "Turkish", "Hindi", "Malay",
    "Dutch", "Swedish", "Danish", "Finnish",
]


class TtsGenerateRequest(BaseModel):
    """PromptTTS — describe a voice in plain text and synthesize.
    For a specific pre-defined speaker use POST /v1/tts/speak instead."""

    text: str = Field(
        min_length=1,
        max_length=2000,
        description="Text to synthesize. Up to 2,000 characters per call.",
    )
    style_instruction: str | None = Field(
        default=None,
        max_length=500,
        description=(
            "Free-form description of the voice / delivery, e.g. "
            "'calm female narrator with a warm tone'. Up to 500 chars. "
            "Omit to use the API_DEFAULT_STYLE_INSTRUCTION on the server."
        ),
    )
    model: str | None = Field(
        default=None,
        description=(
            "Optional TTS model id. When omitted the server picks the "
            "default Vocence PromptTTS model. Pass a name from the "
            "subnet's top-models list to pin a specific miner."
        ),
    )


class TtsSpeakRequest(BaseModel):
    """Synthesize text in a pre-defined speaker's voice. List available
    speaker ids with GET /v1/voices/builtin."""

    text: str = Field(
        min_length=1,
        max_length=2000,
        description="Text to synthesize. Up to 2,000 characters per call.",
    )
    voice: str = Field(
        min_length=1,
        max_length=64,
        description=(
            "Built-in speaker id (e.g. `voc-atlas`, `design-aria`, "
            "`char-epic-warrior`). Call GET /v1/voices/builtin for the "
            "full catalog."
        ),
    )


class TtsGenerateResponse(BaseModel):
    request_id: str
    audio_url: str
    provider: str
    credits_remaining: int
    latency_ms: int
    credits_used: int
    request_chars: int


class SttTranscribeRequest(BaseModel):
    audio_b64: str = Field(
        min_length=1,
        description=(
            "Base64-encoded audio. Accepts any common codec (mp3, wav, "
            "webm, m4a, opus, flac). Hard cap: **50 MB encoded** "
            "(~36 MB of raw audio). Larger clips return HTTP 413."
        ),
    )
    language: STT_LANGUAGE | None = Field(
        default=None,
        description=(
            "Language hint for the transcriber. Auto-detected when "
            "omitted. Must be one of the canonical English names "
            "below — ISO codes like `en`/`ja` are rejected."
        ),
    )


class SttTranscribeResponse(BaseModel):
    request_id: str
    text: str
    language: str | None = None
    provider: str
    credits_remaining: int
    latency_ms: int
    credits_used: int


class VoiceCloneRequest(BaseModel):
    """One-shot voice clone. The reference clip is transcribed server-side
    and then used as the voice source for ``target_text``."""

    reference_audio_b64: str = Field(
        min_length=1,
        description=(
            "Base64-encoded reference clip of the speaker to clone. "
            "5–30 seconds gives the best results; clips shorter than "
            "~3 s often sound flat. Hard cap: **50 MB encoded** "
            "(~36 MB of raw audio)."
        ),
    )
    target_text: str = Field(
        min_length=1,
        max_length=2000,
        description="Text to speak in the cloned voice. Up to 2,000 characters.",
    )
    language: STT_LANGUAGE | None = Field(
        default=None,
        description=(
            "Language hint for the reference-clip transcription step. "
            "Auto-detected when omitted."
        ),
    )


class VoiceCloneResponse(BaseModel):
    request_id: str
    audio_url: str
    reference_text: str
    language: str | None = None
    provider: str
    credits_remaining: int
    latency_ms: int
    credits_used: int


class DubbingEnhanceRequest(BaseModel):
    """Noise Remover: remove background noise and enhance audio clarity.

    Class name kept as ``DubbingEnhance*`` for backwards-compatible
    OpenAPI references; the public endpoint is ``/v1/audio/noise-remover``.
    """

    audio_b64: str = Field(
        min_length=1,
        description=(
            "Base64-encoded noisy audio. Accepts WAV, MP3, M4A, OGG, "
            "FLAC, WebM, AAC. Max 50 MB encoded, max 5 minutes duration."
        ),
    )


class DubbingEnhanceResponse(BaseModel):
    request_id: str
    audio_url: str
    provider: str
    credits_remaining: int
    latency_ms: int
    credits_used: int


