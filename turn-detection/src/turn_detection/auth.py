"""Single-shared-secret auth via ``X-API-Key`` header.

Every Vocence pod uses this pattern. The header value is compared
against ``CONFIG.api_key`` using ``hmac.compare_digest`` so the
comparison is constant-time and not vulnerable to timing attacks.

For HTTP endpoints we provide a FastAPI dependency that raises 401.
For WebSocket endpoints, the upgrade handshake doesn't go through
FastAPI dependencies the same way, so the WS handler calls
``check_ws_auth`` itself and closes with 4401 on mismatch.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status
from starlette.websockets import WebSocket

from .config import CONFIG


def _eq(actual: str | None, expected: str) -> bool:
    """Constant-time equality. ``actual`` may be ``None`` if the header
    was missing — return False in that case rather than raising."""
    if actual is None:
        return False
    return hmac.compare_digest(actual.encode("utf-8"), expected.encode("utf-8"))


def require_api_key(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> None:
    """FastAPI dependency for HTTP endpoints.

    Use as ``dependencies=[Depends(require_api_key)]`` on the route or
    router. On mismatch raises 401 with the standard ``{"error":...}``
    body (matches every other Vocence pod's shape)."""
    if not _eq(x_api_key, CONFIG.api_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "unauthorized"},
        )


async def check_ws_auth(ws: WebSocket) -> bool:
    """Check the ``X-API-Key`` header on a WS upgrade.

    Must be called BEFORE ``ws.accept()`` so we can reject the upgrade
    with a close code per the spec (4401). After ``accept`` we can no
    longer reject the handshake.

    Returns ``True`` if the key matches; on mismatch the function
    closes the WS with code 4401 and returns ``False``. The handler
    should ``return`` on False without doing anything else.
    """
    # Headers are lower-cased per the ASGI spec when normalised by
    # starlette, but ``ws.headers`` gives a case-insensitive view so
    # we can ask for it under the canonical case.
    key = ws.headers.get("x-api-key")
    if _eq(key, CONFIG.api_key):
        return True
    # We can close the WS in the upgrade phase by calling ``close()``
    # WITHOUT first calling ``accept()``. Starlette implements this as
    # an HTTP 403 response, but with a custom close code we'd need to
    # accept then close — that's the convention all Vocence pods use
    # so dispatcher logs see WS-level rather than HTTP-level rejection.
    await ws.accept()
    await ws.close(code=4401, reason="unauthorized")
    return False
