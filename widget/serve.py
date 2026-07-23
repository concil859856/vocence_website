"""Vocence widget host — serves the widget bundle AND its runtime assets.

Runs as a uvicorn process on 127.0.0.1:8087 behind nginx (widget.vocence.ai).
Everything is served from ``host/`` under the ``/v1/`` prefix:

    /v1/widget.js                       -> the <vocence-agent> bundle
    /v1/widget.esm.js                   -> ESM build
    /v1/ort-wasm-simd-threaded.{wasm,mjs}     ONNX-Runtime (voice VAD)
    /v1/ort-wasm-simd-threaded.jsep.{wasm,mjs}
    /v1/vad.worklet.bundle.min.js       -> @ricky0123/vad-web worklet
    /v1/silero_vad_v5.onnx              -> Silero VAD model
    /v1/silero_vad_legacy.onnx

The bundle is loaded cross-origin from arbitrary customer sites and fetches
the VAD assets the same way, so every file is served with permissive CORS
and the correct content-type (``application/wasm`` matters for streaming
compilation). Files come straight from ``host/`` — a fresh ``npm run build``
+ ``cp dist/widget.iife.js host/widget.js`` is picked up on restart.

Run:
    cd /deployment/vocence_website/widget
    ../developer-api/venv/bin/uvicorn serve:app --host 127.0.0.1 --port 8087
"""
from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse

HOST_DIR = Path(__file__).resolve().parent / "host"

# Explicit content-types — Python's mimetypes doesn't know .wasm/.onnx, and
# browsers require `application/wasm` for WebAssembly.instantiateStreaming.
MEDIA = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".wasm": "application/wasm",
    ".onnx": "application/octet-stream",
    ".map": "application/json",
    ".json": "application/json",
}

app = FastAPI(title="Vocence Widget Host", docs_url=None, redoc_url=None)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/healthz")
def healthz() -> JSONResponse:
    ok = (HOST_DIR / "widget.js").is_file()
    return JSONResponse({"status": "ok" if ok else "missing_bundle", "service": "widget-host"})


@app.get("/v1/{path:path}")
def serve_asset(path: str):
    target = (HOST_DIR / path).resolve()
    # Path-traversal guard: must stay inside HOST_DIR.
    if HOST_DIR not in target.parents or not target.is_file():
        return JSONResponse({"detail": f"{path} not found"}, status_code=404)
    media = MEDIA.get(target.suffix, "application/octet-stream")
    # Bundles change on deploy → short cache; large immutable assets (wasm,
    # onnx) can cache longer, but keep it simple and uniform here.
    return FileResponse(target, media_type=media, headers={"Cache-Control": "public, max-age=300"})
