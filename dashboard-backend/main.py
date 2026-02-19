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

from database import (
    close_pool,
    health_check,
    ensure_blog_table,
    ensure_evaluations_audio_columns,
    ensure_live_evaluation_pending_table,
)
from local_db import ensure_tables as ensure_local_tables
from routers import auth, dashboard


UPLOADS_DIR = Path(__file__).resolve().parent / "uploads"
UPLOADS_DIR.mkdir(exist_ok=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await ensure_blog_table()
    await ensure_evaluations_audio_columns()
    await ensure_live_evaluation_pending_table()
    await ensure_local_tables()
    yield
    await close_pool()


app = FastAPI(
    title="Vocence Dashboard API",
    description="Read-only API for the Vocence website dashboard (owner DB)",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if not os.environ.get("CORS_ORIGIN") else os.environ["CORS_ORIGIN"].split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(dashboard.router)
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
