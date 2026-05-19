"""
Vocence Developer API service.

Runs behind api.vocence.ai and authenticates with API keys created on
backend.vocence.ai.
"""

from __future__ import annotations

import os

from app.main import app


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        # Default 8031 — this matches the nginx config for
        # api.vocence.ai (proxy_pass http://127.0.0.1:8031). The
        # subnet validator's ``vocence api`` CLI lives on 8063 and is
        # routed to subnet.vocence.ai (separate origin), so there is
        # no collision. The website docs page's Swagger explorer
        # proxies to this exact port via Vite (/devapi/*), so the
        # two MUST stay in sync.
        port=int(os.environ.get("PORT", "8031")),
        reload=os.environ.get("RELOAD", "").lower() == "true",
    )
