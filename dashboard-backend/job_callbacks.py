"""One-shot completion callbacks for async jobs.

Different from webhooks_service: that is *subscription* delivery (customer
registers a URL against an agent, we fan out events through a persistent
queue). This is *per-request* — an API caller passes ``callback_url`` when
submitting an async job (video dubbing today) and we POST the terminal status
there once, from the worker, with a few in-process retries. Best-effort by
design: the poll endpoint stays the source of truth, so a lost callback
degrades to what the caller had anyway.

Signing reuses the exact header format of webhooks_service / the SDK's
``webhooks.verify()`` helper — but with the caller-supplied ``callback_secret``
(optional). No secret → unsigned delivery; the receiver should treat the body
as a hint and re-fetch the job by id.

SSRF: ``validate_callback_url`` runs at submit time (reject early, before
charging) and again at delivery time (DNS may have shifted inward since).
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

import aiohttp

from webhooks_service import (
    HEADER_EVENT,
    HEADER_SIGNATURE,
    HEADER_TIMESTAMP,
    _sign_body,
    validate_webhook_url,
)


_log = logging.getLogger(__name__)

# Short in-process retry ladder. Anything longer-lived belongs in the
# subscription queue, not tied to a worker task's lifetime.
_RETRY_DELAYS_SEC = [0, 30, 120]
_DELIVERY_TIMEOUT_SEC = 15


def validate_callback_url(url: str) -> None:
    """Raise ValueError if ``url`` is not a safe public HTTPS endpoint."""
    validate_webhook_url(url)


def fire_and_forget(job: Any, status: str, result: dict | None, error: str | None) -> None:
    """Schedule a callback delivery for a finished job, if it asked for one.

    Never raises — a callback problem must not affect job bookkeeping.
    """
    try:
        payload = job.payload or {}
        url = (payload.get("callback_url") or "").strip()
        if not url:
            return
        secret = (payload.get("callback_secret") or "").strip() or None
        body = {
            "event": f"{job.type}.{'completed' if status == 'completed' else 'failed'}",
            "job_id": job.id,
            "status": status,
            "result": result,
            "error": error,
        }
        asyncio.get_running_loop().create_task(_deliver(url, secret, body))
    except Exception:
        _log.exception("[callbacks] failed to schedule callback for job %s", getattr(job, "id", "?"))


async def _deliver(url: str, secret: str | None, payload: dict) -> None:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    event = payload.get("event", "job.finished")

    for attempt, delay in enumerate(_RETRY_DELAYS_SEC, start=1):
        if delay:
            await asyncio.sleep(delay)
        try:
            # Re-validate each attempt: delivery-time DNS is what matters.
            validate_callback_url(url)
        except ValueError as exc:
            _log.warning("[callbacks] refusing unsafe callback_url: %s", exc)
            return
        try:
            ts = int(time.time())
            headers = {"Content-Type": "application/json", HEADER_EVENT: event, HEADER_TIMESTAMP: str(ts)}
            if secret:
                headers[HEADER_SIGNATURE] = _sign_body(body, secret, timestamp=ts)
            timeout = aiohttp.ClientTimeout(total=_DELIVERY_TIMEOUT_SEC)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.post(url, data=body, headers=headers) as resp:
                    if resp.status < 300:
                        _log.info("[callbacks] delivered %s -> %s (%s)", event, resp.status, url[:80])
                        return
                    _log.warning("[callbacks] attempt %d got HTTP %s from %s", attempt, resp.status, url[:80])
        except Exception as exc:
            _log.warning("[callbacks] attempt %d failed for %s: %s", attempt, url[:80], exc)

    _log.warning("[callbacks] giving up on %s after %d attempts", url[:80], len(_RETRY_DELAYS_SEC))
