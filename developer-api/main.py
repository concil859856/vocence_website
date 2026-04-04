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
        port=int(os.environ.get("PORT", "8063")),
        reload=os.environ.get("RELOAD", "").lower() == "true",
    )
