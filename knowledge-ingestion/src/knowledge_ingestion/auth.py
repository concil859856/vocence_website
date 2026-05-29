"""X-API-Key authentication — same shape as the other Vocence pods.

Constant-time comparison via ``hmac.compare_digest`` so a slow API key
guess doesn't leak via timing.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from .config import CONFIG


def require_api_key(
    x_api_key: str | None = Header(default=None, alias="X-API-Key"),
) -> None:
    if x_api_key is None or not hmac.compare_digest(
        x_api_key.encode("utf-8"), CONFIG.api_key.encode("utf-8")
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "unauthorized"},
        )
