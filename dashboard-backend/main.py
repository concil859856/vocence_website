"""
Vocence Dashboard Backend (FastAPI)

Reads from the owner's Vocence PostgreSQL database (same DB as Vocence API)
and exposes REST endpoints for the website dashboard. Run separately from the
main Vocence API. Configure POSTGRES_* or DATABASE_URL to point to the
owner's Vocence DB.
"""

import os

from dotenv import load_dotenv

load_dotenv()  # load .env so PORT, DATABASE_URL, JWT_SECRET, etc. are set
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.trustedhost import TrustedHostMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from error_logging import configure_logging, register_exception_handlers

configure_logging()
from database import (
    acquire,
    close_pool,
    health_check,
    ensure_evaluations_audio_columns,
    ensure_graph_activity_leases_table,
    ensure_global_scoring_snapshots_table,
    ensure_live_evaluation_pending_table,
)
from local_db import ensure_tables as ensure_local_tables, migrate_legacy_website_data
from assistant_knowledge_indexer import index_assistant_knowledge_at_startup
from routers import auth, dashboard, studio
from routers.playbooks import router as playbooks_router
from routers.jobs import router as jobs_router
from routers.voicechat import router as voicechat_router
from routers.agents import router as agents_router
from routers.agent_custom_tools import router as agent_custom_tools_router
from routers.share import router as share_router
from routers.cli_auth import router as cli_auth_router
from routers.uploads import router as uploads_router
from jobs import start_workers, stop_workers


UPLOADS_DIR = Path(__file__).resolve().parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)

SAMPLE_VOICES_STATIC_DIR = Path(__file__).resolve().parent / "static" / "sample_voices"
SAMPLE_VOICES_STATIC_DIR.mkdir(parents=True, exist_ok=True)


def _cors_allow_origins() -> list[str]:
    """Explicit origins (required when allow_credentials=True). Never use '*' with credentials.

    Production default: vocence.ai only. Override via CORS_ORIGIN env var
    (comma-separated) for dev/staging.
    """
    raw = (os.environ.get("CORS_ORIGIN") or "").strip()
    if not raw:
        return [
            "https://vocence.ai",
            "https://www.vocence.ai",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ]
    origins = [o.strip() for o in raw.split(",") if o.strip()]
    # Avoid "Failed to fetch" when the app is opened as localhost vs 127.0.0.1
    expanded: list[str] = []
    seen: set[str] = set()
    for o in origins:
        if o not in seen:
            expanded.append(o)
            seen.add(o)
        if "://localhost:" in o:
            mirror = o.replace("://localhost:", "://127.0.0.1:")
            if mirror not in seen:
                expanded.append(mirror)
                seen.add(mirror)
        elif "://127.0.0.1:" in o:
            mirror = o.replace("://127.0.0.1:", "://localhost:")
            if mirror not in seen:
                expanded.append(mirror)
                seen.add(mirror)
    return expanded


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_evaluations_audio_columns()
    await ensure_graph_activity_leases_table()
    await ensure_global_scoring_snapshots_table()
    await ensure_live_evaluation_pending_table()
    await ensure_local_tables()
    async with acquire() as conn:
        await migrate_legacy_website_data(conn)
    # Seed the Vocence Assistant's RAG store from vocence_assistant_knowledge/*.md.
    # No-op when the content hash matches the last run.
    try:
        await index_assistant_knowledge_at_startup()
    except Exception:
        # Don't block boot on indexer failure — assistant will still answer
        # using the static system prompt, just without retrieval depth.
        import logging
        logging.getLogger(__name__).exception("assistant knowledge indexing failed; continuing")
    await start_workers()

    # Ops fleet manager: register the schema, then start the background
    # pollers (health/metrics/update-detector/cleanup). Boot continues even
    # if ops initialization fails — the rest of the dashboard should still
    # serve, and the admin will see the failure in the /studio/ops tab.
    import logging as _logging
    try:
        from ops.db import ensure_ops_tables
        await ensure_ops_tables()
        from ops.pollers import start_pollers
        await start_pollers()
    except Exception:
        _logging.getLogger(__name__).exception("ops module failed to start; continuing without fleet management")

    yield

    try:
        from ops.pollers import stop_pollers
        await stop_pollers()
    except Exception:
        _logging.getLogger(__name__).exception("ops.stop_pollers failed (non-fatal)")
    await stop_workers()
    # Clean up the agent-tools shared HTTP session so the keep-alive
    # connector tears down gracefully (otherwise aiohttp logs an
    # "Unclosed client session" warning at exit).
    try:
        import agent_tools_service
        await agent_tools_service.close_shared_session()
    except Exception:
        pass
    await close_pool()


app = FastAPI(
    title="Vocence Dashboard API",
    description="Read-only API for the Vocence website dashboard (owner DB)",
    version="1.0.0",
    lifespan=lifespan,
    # This service is INTERNAL — backend.vocence.ai. The public API
    # surface lives on the separate developer-api service (api.vocence.ai)
    # which has its own clean OpenAPI spec. Disable the auto-generated
    # docs here so subnet/admin/internal endpoints (validators, blocklist,
    # evaluations, voicechat WS, etc.) don't leak via /docs or /redoc.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)
register_exception_handlers(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allow_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=[
        "Content-Type",
        "Accept",
        "Authorization",
        # Admin sudo-mode token (see routers/admin_auth.py). Missing here
        # silently breaks every /api/dashboard/ops/* + admin call from a
        # browser, because the CORS preflight rejects the custom header
        # before the actual request even hits the server.
        "X-Admin-Token",
    ],
)

# TrustedHost: reject requests whose Host header isn't one we proxy to.
_trusted_hosts_env = (os.environ.get("TRUSTED_HOSTS") or "").strip()
_trusted_hosts = (
    [h.strip() for h in _trusted_hosts_env.split(",") if h.strip()]
    if _trusted_hosts_env
    else [
        "backend.vocence.ai",
        "localhost",
        "127.0.0.1",
    ]
)
app.add_middleware(TrustedHostMiddleware, allowed_hosts=_trusted_hosts)

app.include_router(auth.router)
app.include_router(dashboard.router)
app.include_router(studio.router, prefix="/api/dashboard")
app.include_router(playbooks_router, prefix="/api/dashboard")
app.include_router(jobs_router, prefix="/api/dashboard")
app.include_router(uploads_router, prefix="/api/dashboard")
app.include_router(voicechat_router, prefix="/api/dashboard")
app.include_router(agents_router, prefix="/api/dashboard")
# Custom (user-defined) voice-agent tools — webhook executors the LLM
# can call mid-conversation. Lives under /api/dashboard/agents/tools/
# alongside the built-in /agents/tools/builtin endpoint.
app.include_router(agent_custom_tools_router, prefix="/api/dashboard")
# Admin sudo-mode auth (separate password on top of Google OAuth for
# /studio/ops + other admin surfaces). Routes live at /api/dashboard/auth/admin/*.
from routers.admin_auth import router as admin_auth_router  # noqa: E402
app.include_router(admin_auth_router, prefix="/api/dashboard")

# Ops fleet manager — admin-only. Surfaces /studio/ops UI endpoints
# (servers + pods CRUD, deploy/stop/restart, analytics queries).
from routers.ops import router as ops_router  # noqa: E402 — keep ops import lazy so a missing dep doesn't crash boot
app.include_router(ops_router, prefix="/api/dashboard")
# Public share/embed pages mount at the ROOT (no /api prefix) so the
# URLs the user actually pastes into tweets/Discord are short and the
# meta-bot crawlers (which generally only fetch the literal URL) hit
# the OG-tagged HTML directly. Vercel rewrites + Vite dev proxies on
# the frontend ensure /p/:id and /embed/p/:id reach this backend.
app.include_router(share_router)
app.include_router(cli_auth_router)
app.mount("/api/dashboard/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")
app.mount(
    "/api/dashboard/sample-voices",
    StaticFiles(directory=str(SAMPLE_VOICES_STATIC_DIR)),
    name="sample-voices",
)


@app.get("/health")
async def health():
    try:
        ok = await health_check()
        body = {
            "status": "ok" if ok else "unhealthy",
            "service": "vocence-dashboard-backend",
            "database": ok,
        }
        status = 200 if ok else 503
        return JSONResponse(content=body, status_code=status)
    except Exception as e:
        return JSONResponse(
            content={
                "status": "unhealthy",
                "service": "vocence-dashboard-backend",
                "database": False,
                "error": str(e),
            },
            status_code=503,
        )


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("DASHBOARD_PORT", os.environ.get("PORT", "3002")))
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=port,
        reload=os.environ.get("RELOAD", "").lower() == "true",
    )
