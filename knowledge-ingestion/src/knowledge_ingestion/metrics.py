"""Prometheus metrics.

The names + label keys exposed here form the public contract for any
scraper polling ``/metrics``. Renaming a counter silently breaks
downstream rollups, so treat changes here as a breaking version bump.
"""

from __future__ import annotations

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, generate_latest


# Ingest job lifecycle (background workers).
_INGEST_JOBS = Counter(
    "kn_ingest_jobs_total",
    "Total ingest jobs processed, labelled by terminal status",
    labelnames=("status",),
)

_CHUNKS = Counter(
    "kn_ingest_chunks_total",
    "Total chunks indexed across all agents (monotonic — no decrement on delete)",
)

_INGEST_INFLIGHT = Gauge(
    "kn_inflight_ingests",
    "Background ingest jobs currently running",
)

# Query hot path.
_QUERY = Counter(
    "kn_query_total",
    "Total /v1/query calls served",
)

_QUERY_DURATION_SUM = Counter(
    "kn_query_duration_ms_sum",
    "Sum of /v1/query end-to-end latencies in milliseconds",
)

_QUERY_DURATION_COUNT = Counter(
    "kn_query_duration_ms_count",
    "Number of /v1/query calls (matches kn_query_total)",
)

_EMBEDDING_DURATION_SUM = Counter(
    "kn_embedding_duration_ms_sum",
    "Cumulative time spent embedding text (sum over chunks and queries)",
)

_EMBEDDING_DURATION_COUNT = Counter(
    "kn_embedding_duration_ms_count",
    "Number of embed() calls (matches the sum counter)",
)


def record_job(status: str) -> None:
    """Bump the terminal-status counter when a background job finishes."""
    _INGEST_JOBS.labels(status=status).inc()


def add_chunks(n: int) -> None:
    _CHUNKS.inc(n)


def inc_ingest_inflight() -> None:
    _INGEST_INFLIGHT.inc()


def dec_ingest_inflight() -> None:
    _INGEST_INFLIGHT.dec()


def record_query(duration_ms: float) -> None:
    _QUERY.inc()
    _QUERY_DURATION_SUM.inc(duration_ms)
    _QUERY_DURATION_COUNT.inc()


def record_embedding(duration_ms: float, n_inputs: int) -> None:
    """Embedding latency is per-call (a call may embed N inputs in a
    batch). We track sum / count so the dispatcher can render a true
    per-call mean from delta-of-deltas."""
    _EMBEDDING_DURATION_SUM.inc(duration_ms)
    _EMBEDDING_DURATION_COUNT.inc(n_inputs)


def render() -> tuple[bytes, str]:
    return generate_latest(), CONTENT_TYPE_LATEST
