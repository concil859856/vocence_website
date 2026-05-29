# syntax=docker/dockerfile:1.7
#
# Multi-stage build:
#   - ``models``  pre-downloads the HF model weights into a layer we
#                 copy into the final image. Bakes the weights into the
#                 image so the pod doesn't need outbound HF access on
#                 first boot.
#   - ``runtime`` slim Python base + just the runtime deps.
#
# We avoid copying build toolchains into the final layer — that keeps
# the image at ~3GB rather than ~6GB.


FROM python:3.11-slim AS models

ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HUB_DISABLE_TELEMETRY=1

RUN pip install --no-cache-dir --quiet huggingface_hub

# Pin the snapshot revisions so an upstream model push can't silently
# change behaviour between our builds. Update deliberately with a PR.
ENV SMART_TURN_REPO="pipecat-ai/smart-turn-v3" \
    SMART_TURN_FILE="smart-turn-v3.2-cpu.onnx" \
    TURN_DETECTOR_REPO="livekit/turn-detector" \
    HF_HOME=/models

RUN python -c "from huggingface_hub import hf_hub_download; hf_hub_download(repo_id='${SMART_TURN_REPO}', filename='${SMART_TURN_FILE}', cache_dir='${HF_HOME}')" && \
    python -c "import os; \
from huggingface_hub import hf_hub_download; \
[hf_hub_download(repo_id='${TURN_DETECTOR_REPO}', filename=f, cache_dir='${HF_HOME}') for f in ('model_quantized.onnx','tokenizer.json','tokenizer_config.json','vocab.json','merges.txt','special_tokens_map.json','config.json')]"


# ---------------------------------------------------------------------------
# Runtime layer — slim, no compilers.
# ---------------------------------------------------------------------------

FROM python:3.11-slim AS runtime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    TD_MODELS_CACHE_DIR=/models \
    HF_HOME=/models

# curl for HEALTHCHECK; libgomp1 is needed by onnxruntime's CPU kernels.
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl libgomp1 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml /app/

# Install Python deps. ``--no-deps`` on the local package because the
# pyproject already lists the runtime deps in its own ``dependencies``;
# pip resolves them in the same install pass.
COPY src /app/src
RUN pip install --no-cache-dir --quiet . && \
    # Drop the build-only egg-info to shave a few KB off the image.
    find /usr/local/lib/python3.11/site-packages -name "*.dist-info" -exec ls {} + >/dev/null

# Bring in the pre-downloaded model weights.
COPY --from=models /models /models

EXPOSE 8117

# The dispatcher polls ``/healthz`` itself; the docker HEALTHCHECK is
# a belt-and-suspenders check so ``docker ps`` reports accurately to
# operators looking at the host directly.
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
    CMD curl -fsS http://localhost:${TD_PORT:-8117}/healthz | grep -q '"status":"ok"' || exit 1

# Single worker on purpose — the FastAPI process holds the model
# sessions in memory; running multiple workers per container would
# duplicate them and balloon RAM. Scale horizontally with more pods,
# not more workers per pod.
CMD ["uvicorn", "turn_detection.server:app", "--host", "0.0.0.0", "--port", "8117", "--workers", "1"]
