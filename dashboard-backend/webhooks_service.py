"""Outbound webhook delivery.

Customers register URLs against an agent; we POST event payloads
(``call.ended``, etc.) when those events happen on the server.
Signed with HMAC-SHA256 in the format the vocence-sdk's
``webhooks.verify()`` helper accepts — so customers can drop our
SDK into their FastAPI/Flask app and verify deliveries with one
line.

Delivery model
--------------
1. Event happens (e.g. session_close in routers/voicechat.py) →
   ``enqueue_event(agent_id, event_type, payload)`` inserts ONE
   ``webhook_deliveries`` row per active webhook subscribed to that
   event.
2. Background loop ``deliver_pending_webhooks`` (in ops.pollers)
   wakes every few seconds, claims pending/retry-ready rows, signs
   + POSTs, retries with exponential backoff up to MAX_ATTEMPTS.

Security
--------
- Outbound URLs MUST be HTTPS (HTTP allowed only when env
  ``WEBHOOKS_ALLOW_HTTP=true`` — for local-dev testing). Any
  ``localhost`` / ``127.x`` / ``169.254.169.254`` / private RFC1918
  host is blocked unconditionally to prevent SSRF on shared
  infra. Same posture as the SDK's client-side URL guards.
- Each delivery carries a ``timestamp`` header that the receiver
  checks for freshness (SDK default tolerance: 5 minutes) — limits
  replay attacks even if a delivery URL leaks.
- Secret is 64 hex chars generated server-side; shown to the user
  ONCE in the Webhooks tab on creation.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import os
import secrets
import socket
import time
import uuid
from typing import Any
from urllib.parse import urlparse

import aiohttp

from local_db import get_connection


_log = logging.getLogger(__name__)

# Customer can opt into HTTP for local-dev only. Production
# deployments leave this unset, which forces HTTPS.
WEBHOOKS_ALLOW_HTTP = (os.environ.get("WEBHOOKS_ALLOW_HTTP") or "").strip().lower() in {
    "1", "true", "yes",
}

# Hosts we refuse to POST to even when the scheme is HTTPS — they
# point at metadata APIs / internal services. ``localhost`` etc. are
# additionally checked via DNS resolution below.
_BLOCKED_HOSTNAMES = {
    "metadata.google.internal",
    "metadata.goog",
}

# Cap on attempts before we mark a delivery permanently failed.
# Backoff schedule (seconds): 30, 120, 600, 1800. Roughly an hour
# of coverage for transient receiver outages without flooding the
# log with stale rows.
MAX_ATTEMPTS = 5
_BACKOFF_SECONDS = [30, 120, 600, 1800]

# Per-delivery HTTP budget. Customer endpoints sometimes do heavy
# work synchronously — give them enough room to ACK without making
# the rest of our delivery queue wait.
HTTP_TIMEOUT_SECONDS = 15

# Wire format constants — must match the SDK verifier exactly.
HEADER_EVENT = "X-Vocence-Event"
HEADER_DELIVERY_ID = "X-Vocence-Delivery"
HEADER_TIMESTAMP = "X-Vocence-Timestamp"
HEADER_SIGNATURE = "X-Vocence-Signature"
_SIG_PREFIX = "v1="


# ---------------------------------------------------------------------------
# Signing (server side; mirrors vocence-sdk webhooks.sign())
# ---------------------------------------------------------------------------


def _sign_body(body: bytes, secret: str, *, timestamp: int) -> str:
    """Return the ``v1=<base64>`` signature header value."""
    mac = hmac.new(
        secret.encode("utf-8"),
        f"v1.{timestamp}.".encode() + body,
        hashlib.sha256,
    ).digest()
    return _SIG_PREFIX + base64.b64encode(mac).decode("ascii")


def generate_secret() -> str:
    """Fresh webhook secret. 32 bytes = 64 hex chars — plenty of
    entropy and short enough to copy/paste once in a UI."""
    return secrets.token_hex(32)


# ---------------------------------------------------------------------------
# SSRF guard
# ---------------------------------------------------------------------------


def _is_private_address(host: str) -> bool:
    """True if the host resolves to a private / loopback / link-local
    address. We resolve via DNS so an attacker can't sneak past the
    string check with a CNAME pointing at 169.254.169.254."""
    if not host:
        return True
    if host.lower() in _BLOCKED_HOSTNAMES:
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        # Can't resolve — refuse rather than risk a slow-fail that
        # leaves the delivery in pending limbo forever.
        return True
    for info in infos:
        sockaddr = info[4]
        ip_str = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            return True
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            return True
    return False


def validate_webhook_url(url: str) -> None:
    """Raise ValueError if the URL is unsafe to POST to. Run at
    webhook registration time AND at delivery time — config changes
    rarely re-validate, but DNS could shift a public name to a
    private IP in between."""
    parsed = urlparse(url)
    if parsed.scheme not in ("https", "http"):
        raise ValueError(f"webhook url must use http(s): got scheme {parsed.scheme!r}")
    if parsed.scheme == "http" and not WEBHOOKS_ALLOW_HTTP:
        raise ValueError("webhook url must use https (set WEBHOOKS_ALLOW_HTTP=true to override in dev)")
    if not parsed.hostname:
        raise ValueError("webhook url missing hostname")
    if _is_private_address(parsed.hostname):
        raise ValueError(
            f"webhook url host {parsed.hostname!r} resolves to a private / blocked address"
        )


# ---------------------------------------------------------------------------
# Queue helpers
# ---------------------------------------------------------------------------


async def list_webhooks_for_agent(agent_id: str, user_id: str) -> list[dict[str, Any]]:
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            """
            SELECT id, url, events_json, active, created_at
            FROM agent_webhooks
            WHERE agent_id = ? AND user_id = ?
            ORDER BY created_at DESC
            """,
            (agent_id, user_id),
        )).fetchall()
        return [
            {
                "id": r[0],
                "url": r[1],
                "events": json.loads(r[2]) if r[2] else ["*"],
                "active": bool(r[3]),
                "created_at": r[4],
            }
            for r in rows
        ]
    finally:
        await conn.close()


async def create_webhook(
    *, agent_id: str, user_id: str, url: str, events: list[str] | None = None
) -> dict[str, Any]:
    """Register a new webhook. Returns the row WITH the plaintext
    secret — the caller surfaces it ONCE to the user. After that the
    secret is only used by the signing path and never returned by
    list()."""
    validate_webhook_url(url)
    webhook_id = f"wh_{uuid.uuid4().hex[:24]}"
    secret = generate_secret()
    events_json = json.dumps(events or ["*"])
    conn = await get_connection()
    try:
        await conn.execute(
            """
            INSERT INTO agent_webhooks (id, agent_id, user_id, url, secret, events_json)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (webhook_id, agent_id, user_id, url, secret, events_json),
        )
        await conn.commit()
    finally:
        await conn.close()
    return {
        "id": webhook_id,
        "url": url,
        "events": events or ["*"],
        "active": True,
        "secret": secret,
    }


async def delete_webhook(webhook_id: str, user_id: str) -> bool:
    """Delete one webhook, owner-scoped. Returns True if a row was
    removed (so the caller can return 404 vs 200 appropriately).
    Cascades remove ``webhook_deliveries`` rows automatically."""
    conn = await get_connection()
    try:
        cur = await conn.execute(
            "DELETE FROM agent_webhooks WHERE id = ? AND user_id = ?",
            (webhook_id, user_id),
        )
        await conn.commit()
        return (cur.rowcount or 0) > 0
    finally:
        await conn.close()


async def list_recent_deliveries(webhook_id: str, limit: int = 20) -> list[dict[str, Any]]:
    """Last N delivery attempts for one webhook. Drives the "recent
    deliveries" panel in the UI so customers can see what we tried
    to send and how their endpoint responded."""
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            """
            SELECT id, event_type, status, attempt, last_status_code,
                   last_error, last_attempted_at, next_attempt_at, created_at
            FROM webhook_deliveries
            WHERE webhook_id = ?
            ORDER BY id DESC
            LIMIT ?
            """,
            (webhook_id, max(1, min(int(limit), 100))),
        )).fetchall()
        return [
            {
                "id": r[0],
                "event_type": r[1],
                "status": r[2],
                "attempt": r[3],
                "last_status_code": r[4],
                "last_error": r[5],
                "last_attempted_at": r[6],
                "next_attempt_at": r[7],
                "created_at": r[8],
            }
            for r in rows
        ]
    finally:
        await conn.close()


async def enqueue_event(
    agent_id: str | None,
    event_type: str,
    payload: dict[str, Any],
) -> int:
    """Fan-out an event to every webhook on the agent that
    subscribes to ``event_type`` (explicitly or via ``"*"``).
    Returns the number of delivery rows created. Idempotent only
    in the sense that calling it twice queues twice — callers
    should fire exactly once per real event.

    No-op when ``agent_id`` is None (the Logos / no-agent path has
    no webhook subscriptions).
    """
    if not agent_id:
        return 0
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            """
            SELECT id, events_json FROM agent_webhooks
            WHERE agent_id = ? AND active = 1
            """,
            (agent_id,),
        )).fetchall()
        if not rows:
            return 0
        body_str = json.dumps(payload, separators=(",", ":"))
        inserts = 0
        for r in rows:
            try:
                subscribed = json.loads(r[1]) if r[1] else ["*"]
            except Exception:
                subscribed = ["*"]
            if "*" not in subscribed and event_type not in subscribed:
                continue
            await conn.execute(
                """
                INSERT INTO webhook_deliveries (webhook_id, event_type, payload_json)
                VALUES (?, ?, ?)
                """,
                (r[0], event_type, body_str),
            )
            inserts += 1
        if inserts:
            await conn.commit()
        return inserts
    finally:
        await conn.close()


# ---------------------------------------------------------------------------
# Background delivery (called from ops.pollers loop)
# ---------------------------------------------------------------------------


async def deliver_pending_webhooks(batch_size: int = 32) -> tuple[int, int, int]:
    """Drain up to ``batch_size`` deliveries whose ``next_attempt_at``
    is now-or-earlier. Returns ``(attempted, delivered, failed)``
    — counts for the cycle. Cycle stays cheap by capping the batch
    and not holding any locks across the network round-trips.

    Ordering:

        1. SELECT pending + retry-ready rows + their webhook config.
        2. Mark each as ``delivering`` so a concurrent poller pass
           doesn't double-dispatch (we run one poller, but a redeploy
           gap could overlap if you ever scale out).
        3. POST one by one (one HTTP session reused for connection
           pooling).
        4. UPDATE per row with delivered / pending+next_attempt /
           failed depending on outcome.
    """
    conn = await get_connection()
    try:
        rows = await (await conn.execute(
            """
            SELECT d.id, d.webhook_id, d.event_type, d.payload_json, d.attempt,
                   w.url, w.secret, w.active
            FROM webhook_deliveries d
            JOIN agent_webhooks w ON w.id = d.webhook_id
            WHERE d.status IN ('pending', 'delivering')
              AND d.next_attempt_at <= datetime('now')
            ORDER BY d.id ASC
            LIMIT ?
            """,
            (batch_size,),
        )).fetchall()
        if not rows:
            return (0, 0, 0)
        # Claim the rows so a parallel poller doesn't re-dispatch.
        ids = [r[0] for r in rows]
        placeholders = ",".join(["?"] * len(ids))
        await conn.execute(
            f"UPDATE webhook_deliveries SET status='delivering' "
            f"WHERE id IN ({placeholders})",
            ids,
        )
        await conn.commit()
    finally:
        await conn.close()

    delivered = 0
    failed = 0
    timeout = aiohttp.ClientTimeout(total=HTTP_TIMEOUT_SECONDS)
    async with aiohttp.ClientSession(timeout=timeout) as http:
        for r in rows:
            delivery_id, webhook_id, event_type, body_str, attempt, url, secret, active = r
            if not active:
                # Webhook turned off after the row was enqueued — drop
                # without further attempts.
                await _finalize(delivery_id, "failed", None, "webhook inactive")
                failed += 1
                continue
            outcome = await _attempt_delivery(http, url, secret, event_type, body_str, delivery_id)
            await _record_attempt(delivery_id, attempt + 1, outcome)
            if outcome["delivered"]:
                delivered += 1
            elif outcome["permanent"] or attempt + 1 >= MAX_ATTEMPTS:
                failed += 1
    return (len(rows), delivered, len(rows) - delivered - failed if False else failed)


async def _attempt_delivery(
    http: aiohttp.ClientSession,
    url: str,
    secret: str,
    event_type: str,
    body_str: str,
    delivery_id: int,
) -> dict[str, Any]:
    """Sign + POST. Returns a dict with the outcome fields used by
    ``_record_attempt`` to write the row update."""
    try:
        validate_webhook_url(url)
    except ValueError as exc:
        return {
            "delivered": False,
            "permanent": True,           # URL won't ever be valid this run
            "status_code": None,
            "error": str(exc),
        }
    body = body_str.encode("utf-8")
    ts = int(time.time())
    headers = {
        "Content-Type": "application/json",
        HEADER_EVENT: event_type,
        HEADER_DELIVERY_ID: str(delivery_id),
        HEADER_TIMESTAMP: str(ts),
        HEADER_SIGNATURE: _sign_body(body, secret, timestamp=ts),
        "User-Agent": "Vocence-Webhooks/1.0",
    }
    try:
        async with http.post(url, data=body, headers=headers, allow_redirects=False) as resp:
            status = resp.status
            if 200 <= status < 300:
                return {
                    "delivered": True,
                    "permanent": False,
                    "status_code": status,
                    "error": None,
                }
            # 4xx (other than 429) is a permanent receiver problem —
            # the request is malformed or auth'd wrong; retrying won't
            # change the outcome. Skip backoff.
            permanent = 400 <= status < 500 and status != 429
            err = await _short_response_text(resp)
            return {
                "delivered": False,
                "permanent": permanent,
                "status_code": status,
                "error": err,
            }
    except aiohttp.ClientError as exc:
        return {
            "delivered": False,
            "permanent": False,
            "status_code": None,
            "error": str(exc)[:300],
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "delivered": False,
            "permanent": False,
            "status_code": None,
            "error": f"{type(exc).__name__}: {str(exc)[:280]}",
        }


async def _short_response_text(resp: aiohttp.ClientResponse) -> str:
    """Read up to 1 KiB of the response body for the error column.
    Customers' 4xx bodies often contain a useful message; truncate
    so we don't store megabytes of HTML on every failed delivery."""
    try:
        raw = await resp.content.read(1024)
        return raw.decode("utf-8", errors="replace")
    except Exception:
        return ""


async def _record_attempt(
    delivery_id: int, attempt_number: int, outcome: dict[str, Any]
) -> None:
    """Single UPDATE per row at the end of an attempt. We chose
    UPDATE-per-row over batching because the outcomes are
    heterogeneous (delivered / retry / permanent fail) and the
    batch is tiny; the row updates land in <1 ms each on SQLite.
    """
    if outcome["delivered"]:
        await _finalize(delivery_id, "delivered", outcome["status_code"], None)
        return
    if outcome["permanent"] or attempt_number >= MAX_ATTEMPTS:
        await _finalize(
            delivery_id, "failed", outcome["status_code"], outcome["error"]
        )
        return
    # Schedule next retry with capped exponential backoff. attempt_number is
    # 1-indexed here (we just bumped from N to N+1), so subtract 1 for
    # the backoff index.
    backoff_idx = min(attempt_number - 1, len(_BACKOFF_SECONDS) - 1)
    seconds = _BACKOFF_SECONDS[backoff_idx]
    conn = await get_connection()
    try:
        await conn.execute(
            """
            UPDATE webhook_deliveries
            SET status = 'pending',
                attempt = ?,
                next_attempt_at = datetime('now', ?),
                last_status_code = ?,
                last_error = ?,
                last_attempted_at = datetime('now')
            WHERE id = ?
            """,
            (
                attempt_number,
                f"+{seconds} seconds",
                outcome["status_code"],
                (outcome["error"] or "")[:1000],
                delivery_id,
            ),
        )
        await conn.commit()
    finally:
        await conn.close()


async def _finalize(
    delivery_id: int, status: str, status_code: int | None, error: str | None
) -> None:
    conn = await get_connection()
    try:
        await conn.execute(
            """
            UPDATE webhook_deliveries
            SET status = ?,
                last_status_code = ?,
                last_error = ?,
                last_attempted_at = datetime('now')
            WHERE id = ?
            """,
            (status, status_code, (error or "")[:1000] or None, delivery_id),
        )
        await conn.commit()
    finally:
        await conn.close()
