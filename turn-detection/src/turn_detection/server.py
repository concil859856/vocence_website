"""FastAPI app entrypoint — ``turn_detection.server:app``.

Lifespan:
  - load both models on startup, in parallel (they're independent and
    network-bound during the HF download phase)
  - flip ``healthz`` to ``ok`` once both are loaded
  - on shutdown, no special teardown needed — the ONNX sessions will
    be garbage-collected when the process exits

Endpoints:
  GET  /healthz                        — Vocence pod contract
  GET  /metrics                        — Prometheus text format
  WS   /v1/smart-turn                  — audio EOU stream
  WS   /v1/turn-detector               — text EOU stream
  POST /v1/smart-turn/batch            — one-shot inference (testing)
  POST /v1/turn-detector/batch         — one-shot inference (testing)

Auth is enforced at the route level on HTTP endpoints (via the
``require_api_key`` dependency) and inside the WS handlers via
``check_ws_auth``. Healthz + metrics are intentionally NOT auth-gated —
the Vocence ops dispatcher hits these without sending the API key.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import Depends, FastAPI, Response

from . import healthz, metrics
from .auth import require_api_key
from .config import CONFIG
from .smart_turn import model as smart_turn_model
from .turn_detector import model as turn_detector_model
from .smart_turn.ws import ws_smart_turn
from .turn_detector.ws import ws_turn_detector
from .batch import router as batch_router


_log = logging.getLogger(__name__)


# Concurrency cap — shared across both WS endpoints. A simple semaphore
# is enough because we don't need fairness between endpoints (operators
# expect the cap to be a soft total, not per-endpoint allotment). The
# WS handlers acquire here and surface a 4429 close when at capacity.
session_semaphore: asyncio.Semaphore | None = None
in_flight_count: int = 0


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan: load models, flip status, then yield.

    Both models load in parallel. The downloads dominate the cold-start
    time — Smart Turn is ~8 MB, Turn Detector is ~165 MB. On a warm
    cache (re-runs without nuking the cache dir) they're millisecond
    no-ops.
    """
    global session_semaphore
    session_semaphore = asyncio.Semaphore(CONFIG.max_concurrent)
    _log.info(
        "boot: loading models (cache_dir=%s, max_concurrent=%d)",
        CONFIG.models_cache_dir, CONFIG.max_concurrent,
    )
    try:
        # Run the two synchronous loaders concurrently in threadpool.
        # They both do I/O (HF download) followed by CPU work (ONNX
        # session init) so overlapping them halves cold-start time
        # when the cache is empty.
        await asyncio.gather(
            asyncio.to_thread(
                smart_turn_model.load,
                repo_id=CONFIG.smart_turn_repo,
                filename=CONFIG.smart_turn_file,
                cache_dir=CONFIG.models_cache_dir,
            ),
            asyncio.to_thread(
                turn_detector_model.load,
                repo_id=CONFIG.turn_detector_repo,
                onnx_filename=CONFIG.turn_detector_quant_file,
                cache_dir=CONFIG.models_cache_dir,
            ),
        )
        healthz.set_status("ok")
        _log.info("boot: ready")
    except Exception:
        # If either model fails to load we're not coming back from this
        # — flip to error and let the dispatcher mark us unhealthy. The
        # operator sees the exception in the pod logs.
        healthz.set_status("error")
        _log.exception("boot: model load failed; pod will not serve traffic")
        raise

    yield

    # No teardown — the ONNX sessions are owned by the model modules
    # and will be released on process exit. We could explicitly del
    # them here but it's not worth the complexity.


def configure_logging() -> None:
    """Set up logging once. Stdout JSON-lines would be nicer but the
    Vocence ops fleet currently captures container stdout verbatim, so
    plain text with a timestamp is the right default."""
    logging.basicConfig(
        level=CONFIG.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


configure_logging()
app = FastAPI(
    title="vocence-turn-detection",
    version="0.1.0",
    lifespan=lifespan,
    # We expose a minimal public schema. /docs is reachable in dev for
    # smoke-testing but doesn't require auth — gate behind a reverse
    # proxy in production if leaking the schema is a concern.
    docs_url="/docs",
    redoc_url=None,
    openapi_url="/openapi.json",
)


# Public endpoints — NOT auth-gated.
@app.get("/healthz")
async def healthz_endpoint() -> dict:
    return healthz.render(
        smart_turn_loaded=smart_turn_model.is_loaded(),
        turn_detector_loaded=turn_detector_model.is_loaded(),
        smart_turn_model=CONFIG.smart_turn_repo + "/" + CONFIG.smart_turn_file,
        turn_detector_model=CONFIG.turn_detector_repo,
        in_flight=in_flight_count,
        max_concurrent=CONFIG.max_concurrent,
    )


@app.get("/metrics")
async def metrics_endpoint() -> Response:
    body, content_type = metrics.render()
    return Response(content=body, media_type=content_type)


@app.get("/metrics.json")
async def metrics_json_endpoint() -> dict:
    """JSON-shaped metrics snapshot for the Vocence dashboard. See
    ``metrics.render_dashboard_snapshot`` for why this exists — the
    dashboard's poller can't parse Prometheus text format."""
    return metrics.render_dashboard_snapshot()


# Auth-gated REST batch endpoints — convenient for testing without WS plumbing.
app.include_router(batch_router, prefix="/v1", dependencies=[Depends(require_api_key)])


# WebSocket endpoints — auth checked inside the handler (see auth.check_ws_auth).
app.add_api_websocket_route("/v1/smart-turn", ws_smart_turn)
app.add_api_websocket_route("/v1/turn-detector", ws_turn_detector)
