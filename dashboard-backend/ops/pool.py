"""GPU pool — the in-memory dispatcher that callers (voicechat,
studio_tts, music, stt) use to find a healthy pod for a given service.

Hot path:

    async with gpu_pool.pick_pod("tts_streaming") as pod:
        ws = await aiohttp.ClientSession().ws_connect(pod.url + "/v1/voice-clone/stream", ...)
        ...

``pick_pod`` returns a context manager that:

  * raises ``NoCapacity`` if no online pod has room AND the global 2*N cap
    is exhausted (caller propagates 503 server_busy);
  * increments the dispatcher's local in-flight counter on enter;
  * decrements on exit (success, failure, or cancellation alike).

The 2*N global cap is the platform's load-balancer rule (per user
requirement): even if individual pods advertise a higher per-pod cap, the
dispatcher will never admit more than 2 × (online_pod_count_for_service)
simultaneous sessions. Prevents the system accepting more load than the
fleet can absorb during a spike.

State refresh is push-driven: the health poller calls ``reload_pool()``
after every poll cycle so this module always sees the current set of
online pods without hitting the DB on every dispatch call.
"""
from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from . import crypto
from . import db

_log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Tunables
# ---------------------------------------------------------------------------

# The platform load-balancer rule: max in-flight per service = N × this factor,
# where N is the number of online pods for that service. Override via env.
OVERSUBSCRIBE_FACTOR = int(os.environ.get("OPS_OVERSUBSCRIBE_FACTOR") or "2")

# Pod statuses considered eligible for new traffic.
ROUTABLE_STATUSES = ("online",)


# ---------------------------------------------------------------------------
# Public data shape
# ---------------------------------------------------------------------------

@dataclass
class PodView:
    """Minimal subset of an ops_pods row needed for dispatch. Built and
    refreshed by reload_pool(); never queried from DB on hot path."""
    id: int
    server_id: int
    name: str
    service: str
    host: str
    port: int
    api_key: str          # plaintext — decrypted once per refresh
    pod_cap: int          # the pod's own self-advertised cap (from last healthz)
    status: str
    drain_requested: bool
    # Live in-flight count maintained by the dispatcher (NOT the pod's healthz
    # inflight — that one lags by the poll interval and would let us
    # oversubscribe). Initialized to whatever the pod reports + any in-flight
    # we already gave out since the last refresh.
    in_flight: int = 0

    @property
    def url(self) -> str:
        return f"http://{self.host}:{self.port}"


class NoCapacity(RuntimeError):
    """No pod available for the requested service. Caller should surface a
    503 server_busy to the end-user (the same error their own /healthz cap
    would have produced).
    """


# ---------------------------------------------------------------------------
# Pool state
# ---------------------------------------------------------------------------

_LOCK = asyncio.Lock()
_PODS_BY_SERVICE: dict[str, list[PodView]] = {}
_PODS_BY_ID: dict[int, PodView] = {}


async def reload_pool() -> None:
    """Refresh the in-memory pool from the DB. Called by the health poller
    after each cycle so newly-online pods are immediately routable and
    just-dead pods stop receiving traffic on the next pick_pod() call.

    Preserves the in_flight counter for pods that survive the refresh —
    otherwise a poll cycle would forget the sessions we'd already handed out.
    """
    # Pull online + draining pods (draining pods still serve in-flight but
    # accept no new traffic — we filter routability inside pick_pod()).
    rows = await db.list_pods(statuses=("online", "draining"))

    new_by_id: dict[int, PodView] = {}
    new_by_service: dict[str, list[PodView]] = {}
    servers_cache: dict[int, dict | None] = {}

    for r in rows:
        # Materialize the server once per server_id.
        sid = int(r["server_id"])
        if sid not in servers_cache:
            servers_cache[sid] = await db.get_server(sid)
        server = servers_cache[sid]
        if not server or server.get("status") == "removed":
            continue

        # Decrypt the per-pod API key once.
        api_key = ""
        if r.get("api_key_enc"):
            try:
                api_key = crypto.decrypt(r["api_key_enc"])
            except Exception as e:
                _log.warning("pod %s: api_key decrypt failed (%s) — pod will be unreachable", r["id"], e)

        # Pod's self-advertised cap from the last healthz snapshot.
        pod_cap = 1
        last_h = r.get("last_healthz_json") or ""
        if last_h:
            try:
                import json as _json
                hz = _json.loads(last_h)
                pod_cap = int(hz.get("cap") or 1)
            except Exception:
                pass

        view = PodView(
            id=int(r["id"]),
            server_id=sid,
            name=r["name"],
            service=r["service"],
            host=server["host"],
            port=int(r["port"]),
            api_key=api_key,
            pod_cap=max(1, pod_cap),
            status=r["status"],
            drain_requested=bool(r["drain_requested"]),
        )

        # Preserve in-flight from the existing view if we still know about
        # this pod. Otherwise start at 0 (fresh pod).
        prev = _PODS_BY_ID.get(view.id)
        if prev is not None:
            view.in_flight = prev.in_flight

        new_by_id[view.id] = view
        new_by_service.setdefault(view.service, []).append(view)

    async with _LOCK:
        _PODS_BY_ID.clear()
        _PODS_BY_ID.update(new_by_id)
        _PODS_BY_SERVICE.clear()
        _PODS_BY_SERVICE.update(new_by_service)


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------

def _routable_pods(service: str) -> list[PodView]:
    pods = _PODS_BY_SERVICE.get(service) or []
    return [p for p in pods if p.status in ROUTABLE_STATUSES and not p.drain_requested]


@asynccontextmanager
async def pick_pod(service: str):
    """Yield the least-loaded online pod with capacity for ``service``.

    Raises ``NoCapacity`` if either:
      * no online pods exist for ``service``, OR
      * the global cap (2 × N, by default) is already reached, OR
      * every routable pod is at its own per-pod cap.

    Use it as an async context manager — the dispatcher's in-flight counter
    for the chosen pod is incremented on enter and decremented on exit,
    regardless of how the caller's body terminates (success, raise, cancel)."""
    async with _LOCK:
        routable = _routable_pods(service)
        n = len(routable)
        if n == 0:
            raise NoCapacity(f"no online pods for service {service!r}")

        # Global 2*N cap — the platform load-balancer rule.
        total_in_flight = sum(p.in_flight for p in routable)
        global_cap = OVERSUBSCRIBE_FACTOR * n
        if total_in_flight >= global_cap:
            raise NoCapacity(
                f"service {service!r}: global cap reached "
                f"({total_in_flight} >= {OVERSUBSCRIBE_FACTOR}*{n})"
            )

        # Per-pod cap respected too. Pick the pod with the lowest in_flight
        # that still has room locally. Ties broken by pod_id for determinism.
        eligible = [p for p in routable if p.in_flight < p.pod_cap]
        if not eligible:
            # All routable pods are individually full even though global cap
            # would technically allow another (because individual caps sum
            # to less than 2*N). Reject — the per-pod cap is also a hard rule.
            raise NoCapacity(
                f"service {service!r}: every routable pod is at its per-pod cap"
            )

        chosen = min(eligible, key=lambda p: (p.in_flight, p.id))
        chosen.in_flight += 1

    try:
        yield chosen
    finally:
        async with _LOCK:
            # The pod might have been removed from the pool between yield
            # and finally (poll cycle replaced the view). In that case we
            # do nothing — counter is gone.
            still_here = _PODS_BY_ID.get(chosen.id)
            if still_here is not None:
                still_here.in_flight = max(0, still_here.in_flight - 1)


# ---------------------------------------------------------------------------
# Introspection (used by routers/ops + admin UI)
# ---------------------------------------------------------------------------

def snapshot() -> dict:
    """Return a serializable view of the current pool state. Cheap; reads
    in-memory without DB."""
    out: dict[str, dict] = {}
    for service, pods in _PODS_BY_SERVICE.items():
        out[service] = {
            "n_pods": len(pods),
            "total_in_flight": sum(p.in_flight for p in pods),
            "global_cap": OVERSUBSCRIBE_FACTOR * len(pods),
            "pods": [
                {
                    "id": p.id,
                    "name": p.name,
                    "host": p.host,
                    "port": p.port,
                    "status": p.status,
                    "drain_requested": p.drain_requested,
                    "in_flight": p.in_flight,
                    "pod_cap": p.pod_cap,
                }
                for p in pods
            ],
        }
    return out


def in_flight(pod_id: int) -> int:
    p = _PODS_BY_ID.get(pod_id)
    return p.in_flight if p else 0


def online_pod_count(service: str) -> int:
    return len(_routable_pods(service))
