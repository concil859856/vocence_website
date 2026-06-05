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


# ---------------------------------------------------------------------------
# JSON snapshot for the dashboard's metrics_poller.
#
# The Vocence dashboard's ops layer historically scraped a JSON-shaped
# endpoint (the legacy TTS/STT pods returned that format). The newer
# Prometheus-style ``/metrics`` here is the right modern choice, but
# the dashboard's poller can't parse Prometheus text — it just reads
# the body as an empty dict and stores zeros, leaving the per-pod
# activity graph permanently flat.
#
# This function flattens the Prometheus REGISTRY into the JSON keys
# the dashboard wants:
#
#   uptime_seconds, requests_ok, requests_err (dict),
#   duration_ms_sum, duration_ms_count, duration_ms_p95,
#   bytes_sent_total, audio_ms_total, inflight
#
# We don't fabricate values we don't have — bytes_sent_total and
# audio_ms_total stay at 0 (no streaming audio on this pod).
# ``requests_ok`` counts BOTH completed ingest jobs AND query calls
# (the dashboard treats this as "total successful work").
# ``inflight`` mirrors the live ingest gauge so the dashboard's
# historical graph shows real spikes during PDF / sitemap crawls.
# ---------------------------------------------------------------------------

import time as _time
from prometheus_client import REGISTRY as _REGISTRY


_PROC_STARTED_AT = _time.time()


def _sample_value(name: str, labels: dict | None = None) -> float:
    """Pull a single value out of the prometheus_client REGISTRY."""
    for fam in _REGISTRY.collect():
        for s in fam.samples:
            if s.name != name:
                continue
            if labels is None or all(s.labels.get(k) == v for k, v in labels.items()):
                return float(s.value)
    return 0.0


def render_dashboard_snapshot() -> dict:
    """Produce the JSON shape the Vocence dashboard's metrics_poller
    expects. Read once per HTTP request to /metrics.json."""
    succeeded = int(_sample_value("kn_ingest_jobs_total", {"status": "succeeded"}))
    failed_ingests = int(_sample_value("kn_ingest_jobs_total", {"status": "failed"}))
    queries = int(_sample_value("kn_query_total"))
    # ``requests_ok`` = anything that worked. The dashboard graph
    # labels this as "successful requests"; for this pod we treat
    # completed ingest jobs + query calls as the unit of work.
    requests_ok = succeeded + queries
    # ``requests_err`` is a code → count map so the dashboard can
    # break down failures in tooltips. We bucket all ingest failures
    # under "ingest_failed" — finer-grained codes can be added later
    # by labelling ``kn_ingest_jobs_total`` with the error class.
    requests_err: dict[str, int] = {}
    if failed_ingests > 0:
        requests_err["ingest_failed"] = failed_ingests
    return {
        "uptime_seconds": int(_time.time() - _PROC_STARTED_AT),
        "requests_ok": requests_ok,
        "requests_err": requests_err,
        "duration_ms_sum": _sample_value("kn_query_duration_ms_sum"),
        "duration_ms_count": int(_sample_value("kn_query_duration_ms_count")),
        # The histogram-of-durations p95 isn't tracked separately yet;
        # leave it 0 so the dashboard's p95 line stays empty rather
        # than showing a fabricated value.
        "duration_ms_p95": 0.0,
        "bytes_sent_total": 0,
        "audio_ms_total": 0,
        "inflight": int(_sample_value("kn_inflight_ingests")),
    }
