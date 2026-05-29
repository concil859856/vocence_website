"""Environment-variable configuration.

All public knobs live here. Pulled once at startup. Operators tune
behaviour without touching code by setting env vars on the container.

Required:
  TD_API_KEY               Shared secret for X-API-Key auth.

Optional (with sensible defaults):
  TD_PORT                  HTTP bind port (default 8117).
  TD_MAX_CONCURRENT        Total concurrent WS sessions across both
                           endpoints (default 64).
  TD_SMART_TURN_MODEL      HF id of the Smart Turn ONNX model.
  TD_SMART_TURN_FILE       Filename within the repo to download.
  TD_TURN_DETECTOR_MODEL   HF id for LiveKit Turn Detector.
  TD_TURN_DETECTOR_FILE    Filename of the quantised ONNX inside that repo.
  TD_THRESHOLD_FIRE        Probability to fire ``end_of_turn`` (default 0.85).
  TD_THRESHOLD_RESET       Probability below which ``end_of_turn`` is
                           re-armable (default 0.40).
  TD_LOG_LEVEL             info|debug|warn|error.
  TD_LOG_PAYLOADS          1 to log transcript text (default 0 = off).
  TD_MODELS_CACHE_DIR      Where HF downloads land (default uses HF default).

Tip: in production, set ``TD_MODELS_CACHE_DIR`` to a path inside the
container that the image's build step has pre-populated, so the pod
doesn't try to download model weights at startup.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Final


def _env(name: str, default: str | None = None, required: bool = False) -> str:
    """Read an env var with optional default. Required vars without a
    default raise on missing — fail-fast at startup is better than the
    pod accepting traffic and erroring per-request."""
    val = os.environ.get(name)
    if val is None or val == "":
        if required:
            raise SystemExit(
                f"env var {name} is required — refusing to start without it"
            )
        return default or ""
    return val


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError as exc:
        raise SystemExit(f"env var {name}={raw!r} is not an integer") from exc


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return float(raw)
    except ValueError as exc:
        raise SystemExit(f"env var {name}={raw!r} is not a number") from exc


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if raw == "":
        return default
    return raw in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Config:
    api_key: str
    port: int
    max_concurrent: int

    smart_turn_repo: str
    smart_turn_file: str

    turn_detector_repo: str
    turn_detector_quant_file: str

    threshold_fire: float
    threshold_reset: float

    log_level: str
    log_payloads: bool

    models_cache_dir: str | None


def load() -> Config:
    return Config(
        api_key=_env("TD_API_KEY", required=True),
        port=_env_int("TD_PORT", 8117),
        max_concurrent=_env_int("TD_MAX_CONCURRENT", 64),

        smart_turn_repo=_env("TD_SMART_TURN_MODEL", "pipecat-ai/smart-turn-v3"),
        smart_turn_file=_env("TD_SMART_TURN_FILE", "smart-turn-v3.2-cpu.onnx"),

        turn_detector_repo=_env("TD_TURN_DETECTOR_MODEL", "livekit/turn-detector"),
        turn_detector_quant_file=_env("TD_TURN_DETECTOR_FILE", "model_quantized.onnx"),

        threshold_fire=_env_float("TD_THRESHOLD_FIRE", 0.85),
        threshold_reset=_env_float("TD_THRESHOLD_RESET", 0.40),

        log_level=_env("TD_LOG_LEVEL", "info").lower(),
        log_payloads=_env_bool("TD_LOG_PAYLOADS", False),

        models_cache_dir=os.environ.get("TD_MODELS_CACHE_DIR") or None,
    )


# Eager singleton — first import triggers config validation. If TD_API_KEY
# isn't set, the pod refuses to start at import time, before binding the
# port — exactly the fail-fast behaviour we want.
CONFIG: Final[Config] = load()
