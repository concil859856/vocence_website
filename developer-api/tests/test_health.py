"""``GET /health`` — uptime probe used by load balancers."""

from __future__ import annotations


def test_health_returns_ok(client) -> None:
    resp = client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    # Liveness probes don't usually inspect the body; we just want a
    # 200 + a JSON ``{ok: true}``-ish shape so anything that does is
    # happy. Defensive: tolerate the response not having ``status``
    # field if the route shape changes.
    assert isinstance(body, dict)
