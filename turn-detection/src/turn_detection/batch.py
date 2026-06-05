"""REST batch endpoints for one-shot inference.

These are mostly for testing and CI smoke checks — production traffic
goes through the WebSocket endpoints because the dashboard backend
needs streaming probabilities, not a single point-in-time score.

  POST /v1/smart-turn/batch       multipart audio file
  POST /v1/turn-detector/batch    JSON history + in_progress

Both are auth-gated via the ``X-API-Key`` dependency installed at
router-mount time in server.py.
"""

from __future__ import annotations

import io
import wave

import numpy as np
from fastapi import APIRouter, HTTPException, UploadFile, status
from pydantic import BaseModel

from .smart_turn import model as smart_turn_model
from .turn_detector import model as turn_detector_model
from .smart_turn.model import SAMPLE_RATE


router = APIRouter()


# ---------------------------------------------------------------------------
# Smart Turn
# ---------------------------------------------------------------------------

@router.post("/smart-turn/batch")
async def smart_turn_batch(audio: UploadFile) -> dict:
    """Inference on a single audio file. Accepts WAV in any sample rate;
    if not 16 kHz mono we currently return 400 rather than resample —
    keeping resampling in the client makes for a more predictable
    benchmark surface."""
    if not smart_turn_model.is_loaded():
        raise HTTPException(status_code=503, detail={"error": "model not loaded"})
    body = await audio.read()
    if not body:
        raise HTTPException(status_code=400, detail={"error": "empty body"})
    try:
        samples, sr = _wav_to_pcm_float32(body)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": str(exc)}) from exc
    if sr != SAMPLE_RATE:
        raise HTTPException(
            status_code=400,
            detail={"error": f"sample rate must be {SAMPLE_RATE}, got {sr}"},
        )
    p, infer_ms = smart_turn_model.infer(samples)
    return {
        "p_end_of_turn": round(p, 4),
        "audio_ms": int(samples.shape[0] / SAMPLE_RATE * 1000),
        "inference_ms": infer_ms,
    }


# ---------------------------------------------------------------------------
# Turn Detector
# ---------------------------------------------------------------------------

class TurnDetectorBatchRequest(BaseModel):
    history: list[dict[str, str]] = []
    in_progress: str


@router.post("/turn-detector/batch")
async def turn_detector_batch(body: TurnDetectorBatchRequest) -> dict:
    if not turn_detector_model.is_loaded():
        raise HTTPException(status_code=503, detail={"error": "model not loaded"})
    if not body.in_progress.strip():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"error": "in_progress must not be empty"},
        )
    p, tokens_seen, infer_ms = turn_detector_model.infer(body.history, body.in_progress)
    return {
        "p_end_of_turn": round(p, 4),
        "tokens_seen": tokens_seen,
        "inference_ms": infer_ms,
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _wav_to_pcm_float32(body: bytes) -> tuple[np.ndarray, int]:
    """Parse a WAV body to a 1-D float32 mono array + sample rate.

    Uses the stdlib ``wave`` module — works on standard PCM WAV without
    extra deps. We refuse non-mono and non-PCM16 inputs explicitly so
    operators don't get a silent wrong answer on a stereo file.
    """
    try:
        with wave.open(io.BytesIO(body), "rb") as wf:
            sr = wf.getframerate()
            n_channels = wf.getnchannels()
            sampwidth = wf.getsampwidth()
            frames = wf.readframes(wf.getnframes())
    except wave.Error as exc:
        raise ValueError(f"not a valid WAV file: {exc}") from exc

    if sampwidth != 2:
        raise ValueError(f"WAV must be 16-bit PCM (sample width 2), got {sampwidth}")
    if n_channels != 1:
        raise ValueError(f"WAV must be mono, got {n_channels} channels")
    samples = np.frombuffer(frames, dtype="<i2").astype(np.float32) * (1.0 / 32768.0)
    return samples, sr
