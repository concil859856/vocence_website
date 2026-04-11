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
from routers import auth, dashboard, studio
from routers.playbooks import router as playbooks_router


UPLOADS_DIR = Path(__file__).resolve().parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)


def _cors_allow_origins() -> list[str]:
    """Explicit origins (required when allow_credentials=True). Never use '*' with credentials."""
    raw = (os.environ.get("CORS_ORIGIN") or "").strip()
    if not raw:
        return [
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
    yield
    await close_pool()


app = FastAPI(
    title="Vocence Dashboard API",
    description="Read-only API for the Vocence website dashboard (owner DB)",
    version="1.0.0",
    lifespan=lifespan,
)
register_exception_handlers(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_allow_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(dashboard.router)
app.include_router(studio.router, prefix="/api/dashboard")
app.include_router(playbooks_router, prefix="/api/dashboard")
app.mount("/api/dashboard/uploads", StaticFiles(directory=str(UPLOADS_DIR)), name="uploads")


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
        host="0.0.0.0",
        port=port,
        reload=os.environ.get("RELOAD", "").lower() == "true",
    )
