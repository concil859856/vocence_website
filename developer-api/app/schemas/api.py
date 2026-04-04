from __future__ import annotations

from pydantic import BaseModel


class TtsGenerateRequest(BaseModel):
    text: str
    style_instruction: str | None = None
    model: str | None = None


class TtsGenerateResponse(BaseModel):
    request_id: str
    audio_url: str
    provider: str
    credits_remaining: int
    latency_ms: int
    credits_used: int
    request_chars: int


class SttTranscribeRequest(BaseModel):
    audio_b64: str
    language: str | None = None


class SttTranscribeResponse(BaseModel):
    request_id: str
    text: str
    language: str | None = None
    provider: str
    credits_remaining: int
    latency_ms: int
    credits_used: int

