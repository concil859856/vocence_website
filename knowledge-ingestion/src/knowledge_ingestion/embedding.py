"""Embedding model wrapper — fastembed BGE-small by default.

We use fastembed (Qdrant's ONNX-backed wrapper) instead of
sentence-transformers because:
  • No torch dep → 100MB install vs 2GB
  • Cold start: ~800ms (with cached weights) vs ~3s for sentence-transformers
  • Inference: ~5ms per batch-of-3 on CPU
  • Same BGE family models, same quality

The model is loaded once at startup and held as a module-level singleton.
fastembed's underlying ONNX session is thread-safe for inference, so
multiple concurrent ingest jobs can embed simultaneously.

Batch size of 32 matches the BGE family's optimal throughput on CPU —
larger batches don't gain much because we hit memory bandwidth, smaller
batches waste per-batch overhead.
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Iterable

import numpy as np

from . import metrics


_log = logging.getLogger(__name__)


# Singleton — populated by ``load()``.
_model = None  # type: ignore[var-annotated]
_load_lock = threading.Lock()


def load(*, model_name: str, cache_dir: str | None) -> int:
    """Download (if needed) and instantiate the embedding model.

    Returns the embedding dimension so the LanceDB schema can verify
    it matches what ``CONFIG.embedding_dim`` claims — a mismatch would
    cause cryptic failures at insert time, much better to catch at
    startup.
    """
    global _model
    with _load_lock:
        if _model is not None:
            # Hot path: probe an existing instance for its dim.
            return _model_dim()
        from fastembed import TextEmbedding

        _log.info("embedding: loading %s", model_name)
        t0 = time.perf_counter()
        _model = TextEmbedding(model_name=model_name, cache_dir=cache_dir)
        _log.info("embedding: ready in %.1fs", time.perf_counter() - t0)
        return _model_dim()


def _model_dim() -> int:
    """Probe the loaded model for its output dimension by running it on
    a single token. Cached after first call would be nice but the
    first call happens at startup and only takes a few ms anyway."""
    if _model is None:
        raise RuntimeError("embedding.load() must be called first")
    sample = next(iter(_model.embed(["x"])))
    return int(sample.shape[0])


def is_loaded() -> bool:
    return _model is not None


def embed(texts: Iterable[str]) -> tuple[list[np.ndarray], int]:
    """Embed a sequence of texts. Returns ``(vectors, inference_ms)``.

    ``texts`` may be any iterable — we materialize it into a list
    because fastembed's batching needs the count up front and we'd
    re-iterate to count anyway.
    """
    if _model is None:
        raise RuntimeError("embedding.embed() called before load()")
    text_list = list(texts)
    if not text_list:
        return [], 0
    t0 = time.perf_counter()
    # ``batch_size`` parameter controls fastembed's internal batching.
    # 32 is the sweet spot for BGE on CPU per their published bench.
    vectors = list(_model.embed(text_list, batch_size=32))
    inference_ms = int((time.perf_counter() - t0) * 1000)
    metrics.record_embedding(duration_ms=inference_ms, n_inputs=len(text_list))
    return vectors, inference_ms


def embed_one(text: str) -> np.ndarray:
    """Embed a single string — the per-turn ``/v1/query`` hot path uses
    this. Returns a float32 array, shape ``(dim,)``."""
    vecs, _ = embed([text])
    return vecs[0]
