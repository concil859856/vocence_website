"""Smart Turn v3 ONNX wrapper.

The model expects mel-spectrogram features at shape ``(1, 80, 800)`` —
80 mel bins, 800 time frames covering 8 s of audio at 16 kHz. We use
HuggingFace ``WhisperFeatureExtractor`` for the mel conversion since
that's exactly what the Pipecat reference inference uses.

The output is a single sigmoid value already in ``[0, 1]`` — no need
to apply sigmoid ourselves.

Threading model: the ONNX Runtime session is thread-safe for inference,
so multiple WebSocket sessions can call ``infer`` concurrently. The
``WhisperFeatureExtractor`` instance is also stateless and safe to
share. We hold both as module-level singletons after ``load()``.
"""

from __future__ import annotations

import logging
import threading
import time
from pathlib import Path
from typing import Final

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from transformers import WhisperFeatureExtractor


_log = logging.getLogger(__name__)


# 8 s window @ 16 kHz — the spec'd input. Don't change without retraining.
SAMPLE_RATE: Final = 16000
WINDOW_SAMPLES: Final = 8 * SAMPLE_RATE


# Singletons populated by ``load()``. The lock protects re-entrant
# load calls (shouldn't happen in practice — the FastAPI lifespan loads
# once at startup — but defensive code makes the failure mode obvious
# if the contract is ever violated).
_session: ort.InferenceSession | None = None
_feature_extractor: WhisperFeatureExtractor | None = None
_load_lock = threading.Lock()


def load(
    *,
    repo_id: str,
    filename: str,
    cache_dir: str | None,
) -> None:
    """Download the ONNX model + build the feature extractor.

    Called once at app startup. After this returns, ``infer`` is safe
    to call from any thread. The download is a no-op when the file is
    already in ``cache_dir`` so re-runs are cheap.
    """
    global _session, _feature_extractor
    with _load_lock:
        if _session is not None and _feature_extractor is not None:
            return
        _log.info("smart_turn: downloading %s/%s", repo_id, filename)
        t0 = time.perf_counter()
        path = hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            cache_dir=cache_dir,
        )
        _log.info(
            "smart_turn: download done in %.1fs (size=%d bytes)",
            time.perf_counter() - t0,
            Path(path).stat().st_size,
        )
        # CPUExecutionProvider explicit so we don't accidentally pick a
        # GPU provider if the container is built with onnxruntime-gpu.
        # Smart Turn is CPU-only by design.
        sess_opts = ort.SessionOptions()
        # Set thread counts modestly — the dominant cost is feature
        # extraction (numpy/torch), not the ONNX graph itself.
        sess_opts.intra_op_num_threads = 2
        sess_opts.inter_op_num_threads = 1
        _session = ort.InferenceSession(
            path, sess_options=sess_opts, providers=["CPUExecutionProvider"]
        )
        # WhisperFeatureExtractor defaults: 80 mel bins, 10 ms hop,
        # 25 ms window, 16 kHz — matches Smart Turn's expected input.
        # ``chunk_length=8`` (seconds) drives the 800-frame time axis.
        _feature_extractor = WhisperFeatureExtractor(
            chunk_length=8, sampling_rate=SAMPLE_RATE, n_mels=80
        )
        _log.info("smart_turn: ready (model + feature extractor loaded)")


def is_loaded() -> bool:
    return _session is not None and _feature_extractor is not None


def infer(audio: np.ndarray) -> tuple[float, int]:
    """Run Smart Turn on a 1-D float32 audio buffer at 16 kHz mono.

    The buffer is auto-truncated to the last 8 seconds (the model's
    receptive field) and padded with zeros if shorter — both handled
    by ``WhisperFeatureExtractor`` itself.

    Returns ``(p_end_of_turn, inference_ms)``.

    Thread-safe.
    """
    if _session is None or _feature_extractor is None:
        raise RuntimeError("smart_turn.infer() called before load()")
    # Truncate to last 8s in our own code as well so the feature
    # extractor doesn't waste cycles padding a 1-minute buffer.
    if audio.shape[0] > WINDOW_SAMPLES:
        audio = audio[-WINDOW_SAMPLES:]

    t0 = time.perf_counter()
    feats = _feature_extractor(
        audio,
        sampling_rate=SAMPLE_RATE,
        padding="max_length",
        return_tensors="np",
    )
    out = _session.run(
        None, {"input_features": feats.input_features.astype(np.float32)}
    )
    p = float(out[0].flat[0])
    inference_ms = int((time.perf_counter() - t0) * 1000)
    return p, inference_ms
