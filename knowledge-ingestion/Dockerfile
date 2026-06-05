# syntax=docker/dockerfile:1.7
#
# Two-stage build. The first stage downloads + caches the embedding
# model so the runtime container has no outbound network dependency
# on first start. The second stage installs runtime deps only.
#
# Note: unlike the turn-detection pod, this one needs a PERSISTENT
# VOLUME mounted at /data/kn. Without it, every container restart
# wipes the LanceDB store. The HEALTHCHECK won't catch this — it's
# the operator's responsibility to mount the volume.


FROM python:3.11-slim AS models

ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HUB_DISABLE_TELEMETRY=1

RUN pip install --no-cache-dir --quiet fastembed

# Pre-download the BGE-small ONNX weights. fastembed's TextEmbedding
# constructor downloads on first instantiation; we run it here once
# so the model is baked into the layer.
ENV EMBED_MODEL="BAAI/bge-small-en-v1.5" \
    EMBED_CACHE=/models

RUN python -c "from fastembed import TextEmbedding; \
m = TextEmbedding(model_name='${EMBED_MODEL}', cache_dir='${EMBED_CACHE}'); \
list(m.embed(['warm-up']))"


# ---------------------------------------------------------------------------
# Runtime layer
# ---------------------------------------------------------------------------

FROM python:3.11-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    KN_MODELS_CACHE_DIR=/models \
    KN_DATA_DIR=/data/kn

# curl for HEALTHCHECK; libgomp1 for onnxruntime's CPU kernels;
# build-essential needed by lxml (sitemap parsing) — purged after install
# in the same RUN layer so it doesn't bloat the final image.
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl libgomp1 libxml2 libxslt1.1 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml /app/
COPY src /app/src
RUN pip install --no-cache-dir --quiet .

# Pre-create the data dir so KN_DATA_DIR defaults to a valid path even
# when the operator forgets to mount a volume. (The container will
# still refuse to start if /data/kn isn't writable, but having a
# default lets local-dev work without `-v`.)
RUN mkdir -p /data/kn

COPY --from=models /models /models

EXPOSE 8118

HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
    CMD curl -fsS http://localhost:${KN_PORT:-8118}/healthz | grep -q '"status":"ok"' || exit 1

# Single worker per container — same reason as turn-detection: each
# worker holds the embedding model in memory + a LanceDB connection.
# Scale by adding more pods.
CMD ["uvicorn", "knowledge_ingestion.server:app", "--host", "0.0.0.0", "--port", "8118", "--workers", "1"]
