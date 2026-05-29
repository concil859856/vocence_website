"""Prometheus metrics.

The names + label keys exposed here form the public contract for any
metrics scraper that polls ``/metrics``. Renaming a counter (or removing
a label) is a breaking change — the per-pod time series in a downstream
dashboard will silently render empty if it was watching the old name.

Counter monotonicity: prometheus-client handles this — counters can only
go up. ``inflight`` is a gauge so it can decrease.
"""

from __future__ import annotations

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, generate_latest


# Required across all Vocence pods (matches the streaming-STT contract).
# We label by ``model`` so a single pod that serves two models can be
# scraped without ambiguity, but the unlabelled ``asr_inflight`` total
# is also required for dispatcher-level capacity tracking.
_REQUESTS = Counter(
    "asr_requests_total",
    "Total streaming sessions accepted (labelled by status + model)",
    labelnames=("status", "model"),
)

_DURATION_SUM = Counter(
    "asr_duration_ms_sum",
    "Sum of per-session durations in milliseconds (labelled by model)",
    labelnames=("model",),
)

_DURATION_COUNT = Counter(
    "asr_duration_ms_count",
    "Number of completed sessions (labelled by model)",
    labelnames=("model",),
)

_INFLIGHT_TOTAL = Gauge(
    "asr_inflight",
    "Currently-open WS sessions across both models",
)

_INFLIGHT_BY_MODEL = Gauge(
    "asr_inflight_smart_turn",
    "Currently-open WS sessions on the Smart Turn endpoint",
)

_INFLIGHT_TURN_DETECTOR = Gauge(
    "asr_inflight_turn_detector",
    "Currently-open WS sessions on the Turn Detector endpoint",
)


# Public model labels — keep stable. If we add a new model variant the
# label value should be the model identifier, not a free-text alias.
SMART_TURN = "smart_turn"
TURN_DETECTOR = "turn_detector"


def record_session(model: str, status: str, duration_ms: float) -> None:
    """Increment the per-model counter trio at the end of one session.

    ``status`` is one of ``ok`` | ``error`` | ``timeout``. The Vocence
    dispatcher buckets by these three; using a fourth value silently
    breaks the rollup, so be conservative.
    """
    _REQUESTS.labels(status=status, model=model).inc()
    _DURATION_SUM.labels(model=model).inc(duration_ms)
    _DURATION_COUNT.labels(model=model).inc()


def inc_inflight(model: str) -> None:
    """Bump both the total + per-model inflight gauges on session open."""
    _INFLIGHT_TOTAL.inc()
    if model == SMART_TURN:
        _INFLIGHT_BY_MODEL.inc()
    elif model == TURN_DETECTOR:
        _INFLIGHT_TURN_DETECTOR.inc()


def dec_inflight(model: str) -> None:
    """Decrement on session close. Safe to call multiple times — the
    gauge clamps at 0 implicitly because Prometheus gauges allow negative
    values but we never inspect the raw value, only deltas."""
    _INFLIGHT_TOTAL.dec()
    if model == SMART_TURN:
        _INFLIGHT_BY_MODEL.dec()
    elif model == TURN_DETECTOR:
        _INFLIGHT_TURN_DETECTOR.dec()


def render() -> tuple[bytes, str]:
    """Render the current registry to Prometheus text format. Returns
    ``(body, content_type)`` so the HTTP handler can set the right
    Content-Type header (dispatcher's poller checks it)."""
    return generate_latest(), CONTENT_TYPE_LATEST
