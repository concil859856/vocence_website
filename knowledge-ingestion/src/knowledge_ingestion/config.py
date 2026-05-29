"""Environment-variable configuration.

Required:
  KN_API_KEY                  Shared secret for X-API-Key auth.

Optional:
  KN_PORT                     HTTP bind port (default 8118).
  KN_DATA_DIR                 Persistent LanceDB storage path. **Must
                              be a mounted volume** — without it the
                              pod refuses to start so operators don't
                              accidentally ship a wiping-on-restart
                              container to production.
  KN_EMBEDDING_MODEL          HF id of the embedding model.
  KN_MAX_CONCURRENT_INGESTS   Background worker pool size (default 8).
  KN_MAX_SOURCE_BYTES         Cap on a single uploaded file (default 50MB).
  KN_MAX_PAGES_PER_SITEMAP    Cap on a single sitemap crawl (default 500).
  KN_MAX_DEPTH                URL crawl depth cap (default 1; only 0/1 supported in v1).
  KN_MAX_SYNC_BYTES           Text/markdown payloads under this size
                              processed inline (default 100 KB).
  KN_LOG_LEVEL                debug|info|warning|error.
  KN_LOG_PAYLOADS             1 to include chunk text in logs (default 0).
  KN_MODELS_CACHE_DIR         Where the embedding model is cached.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Final


def _env(name: str, default: str | None = None, *, required: bool = False) -> str:
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


def _env_bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name, "").strip().lower()
    if raw == "":
        return default
    return raw in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Config:
    api_key: str
    port: int
    data_dir: Path
    embedding_model: str
    embedding_dim: int

    max_concurrent_ingests: int
    max_source_bytes: int
    max_pages_per_sitemap: int
    max_depth: int
    max_sync_bytes: int

    log_level: str
    log_payloads: bool

    models_cache_dir: str | None


def load() -> Config:
    data_dir = Path(_env("KN_DATA_DIR", "/data/kn"))
    return Config(
        api_key=_env("KN_API_KEY", required=True),
        port=_env_int("KN_PORT", 8118),
        data_dir=data_dir,
        embedding_model=_env("KN_EMBEDDING_MODEL", "BAAI/bge-small-en-v1.5"),
        # BGE-small is 384-dim; this is the source of truth for the
        # LanceDB schema, set per the model we configured above. If
        # operators override the model they must also tune this — we
        # surface a clear error in store.py if the actual vector size
        # doesn't match the declared dim.
        embedding_dim=_env_int("KN_EMBEDDING_DIM", 384),
        max_concurrent_ingests=_env_int("KN_MAX_CONCURRENT_INGESTS", 8),
        max_source_bytes=_env_int("KN_MAX_SOURCE_BYTES", 50_000_000),
        max_pages_per_sitemap=_env_int("KN_MAX_PAGES_PER_SITEMAP", 500),
        max_depth=_env_int("KN_MAX_DEPTH", 1),
        max_sync_bytes=_env_int("KN_MAX_SYNC_BYTES", 100_000),
        log_level=_env("KN_LOG_LEVEL", "info").lower(),
        log_payloads=_env_bool("KN_LOG_PAYLOADS", False),
        models_cache_dir=os.environ.get("KN_MODELS_CACHE_DIR") or None,
    )


CONFIG: Final[Config] = load()


def ensure_data_dir() -> None:
    """Create the LanceDB storage path and fail loudly if it isn't
    writable. The pod calls this at startup; without a persistent
    volume here, every restart loses all ingested knowledge."""
    try:
        CONFIG.data_dir.mkdir(parents=True, exist_ok=True)
    except PermissionError as exc:
        raise SystemExit(
            f"KN_DATA_DIR={CONFIG.data_dir} is not writable. "
            "Mount a persistent volume at this path — otherwise every "
            "container restart wipes all ingested knowledge."
        ) from exc
    # Touch a sentinel file so we catch read-only filesystems early.
    sentinel = CONFIG.data_dir / ".kn-writable"
    try:
        sentinel.write_text("ok")
        sentinel.unlink()
    except OSError as exc:
        raise SystemExit(
            f"KN_DATA_DIR={CONFIG.data_dir} exists but isn't writable: {exc}"
        ) from exc
