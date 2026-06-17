from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router


# Metadata that surfaces in /docs (Swagger) and /redoc. Keep the
# description short — the long-form copy lives on the website docs
# page. The OpenAPI tags list orders the groups in the explorer so
# related endpoints sit next to each other.
app = FastAPI(
    title="Vocence Developer API",
    version="1.1.0",
    description="",
    openapi_tags=[
        {"name": "TTS", "description": "Synthesize speech from text. Pick a voice or use a saved voice id."},
        {"name": "STT", "description": "Transcribe speech to text via Whisper."},
        {"name": "Voice Clone", "description": "One-shot voice cloning from a reference audio clip."},
        {"name": "Audio", "description": "Audio enhancement and noise reduction."},
        {"name": "Agents", "description": "CRUD + voice WebSocket session for your Studio agents."},
        {"name": "Knowledge", "description": "Per-agent RAG knowledge ingestion (text / URL / sitemap / PDF)."},
        {"name": "Call History", "description": "Per-agent voice-call list, per-turn transcripts, and presigned URLs to stereo WAV recordings. Recordings require `config.record_enabled = true` and are retained 30 days by default."},
        {"name": "Embed Tokens", "description": "Mint scoped tokens for the embeddable <vocence-agent> widget."},
        {"name": "Voices", "description": "Manage saved designed / cloned voices and synthesize with them."},
        {"name": "Custom Tools", "description": "Register webhook tools your agents can call mid-conversation."},
        {"name": "Account", "description": "Account snapshot (credits, plan) and developer-key management."},
    ],
    contact={"name": "Vocence", "url": "https://www.vocence.ai/docs/api"},
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)

