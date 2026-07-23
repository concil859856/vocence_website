from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

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
        {"name": "video", "description": "Video dubbing: translate a video into other languages in the original speaker's voice, optionally lip-synced."},
        {"name": "Uploads", "description": "Presigned direct-to-storage uploads for large media (video dubbing sources)."},
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

# OKX AI Marketplace surface (A2MCP ASP). The routes always mount so the
# discovery manifest is reachable; the x402 payment gate attaches only when
# fully configured, and adds nothing to the app otherwise. Wrapped in try so a
# missing optional dep can never break API boot.
try:
    from app.okx.routes import router as okx_router
    from app.okx.payments import build_payment_middleware

    app.include_router(okx_router)
    _okx_payment_mw = build_payment_middleware()
    if _okx_payment_mw is not None:
        app.middleware("http")(_okx_payment_mw)
except Exception:  # pragma: no cover - defensive: never block API startup
    import logging

    logging.getLogger(__name__).exception("[okx] surface failed to mount; continuing without it")


# Override FastAPI's default RequestValidationError handler so it
# doesn't try to JSON-encode the raw request body. The default
# encoder runs ``bytes.decode()`` on the body for the error response;
# when the body is binary (multipart with audio bytes, mis-shaped
# uploads), that raises UnicodeDecodeError → a secondary 500 + a
# huge wall of escaped binary in logs every time someone POSTs an
# audio file to a JSON-only route. Now we redact ``input`` entirely
# on validation errors so the log stays clean and the response stays
# small. Real schema info (loc / msg / type) is preserved so SDK users
# still see what they got wrong.
@app.exception_handler(RequestValidationError)
async def _validation_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    safe_errors = []
    for err in exc.errors():
        scrubbed = {k: v for k, v in err.items() if k != "input"}
        safe_errors.append(scrubbed)
    return JSONResponse(status_code=422, content={"detail": safe_errors})

