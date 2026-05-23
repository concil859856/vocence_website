"""
Central HTTP failure logging for operators.

Access logs (e.g. uvicorn) only show status codes. This module logs structured
reasons for 4xx/5xx (HTTPException detail, validation errors) and tracebacks
for unhandled errors, without changing API response bodies or status codes.
"""

from __future__ import annotations

import logging
import os
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exception_handlers import (
    http_exception_handler,
    request_validation_exception_handler,
)
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse

log = logging.getLogger("vocence_dashboard.http")


class _DashboardAccessFilter(logging.Filter):
    """Drop uvicorn.access lines for `/api/dashboard/*` paths so the console isn't drowned
    in poll traffic. 4xx/5xx still surface via the structured handler in this module, and
    every other route (auth, studio jobs, developer-api) continues to log normally."""

    def filter(self, record: logging.LogRecord) -> bool:
        args = record.args
        if isinstance(args, tuple):
            for a in args:
                if isinstance(a, str) and "/api/dashboard/" in a:
                    return False
        return True


def configure_logging() -> None:
    """Align root and app log levels with LOG_LEVEL (default INFO). Safe if uvicorn already configured handlers."""
    raw = (os.environ.get("LOG_LEVEL") or "INFO").strip().upper()
    level_map = {
        "DEBUG": logging.DEBUG,
        "INFO": logging.INFO,
        "WARNING": logging.WARNING,
        "WARN": logging.WARNING,
        "ERROR": logging.ERROR,
        "CRITICAL": logging.CRITICAL,
    }
    level = level_map.get(raw, logging.INFO)
    root = logging.getLogger()
    root.setLevel(level)
    # Ensure our namespace is visible even under narrower package loggers
    logging.getLogger("vocence_dashboard").setLevel(level)
    logging.getLogger("routers").setLevel(level)
    logging.getLogger("studio_tts_service").setLevel(level)

    # Mute access logs for /api/dashboard/* (frontend polls these every couple of seconds).
    access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, _DashboardAccessFilter) for f in access.filters):
        access.addFilter(_DashboardAccessFilter())


def register_exception_handlers(app: FastAPI) -> None:
    """Log all HTTP error responses and unhandled exceptions."""

    @app.exception_handler(RequestValidationError)
    async def _validation(request: Request, exc: RequestValidationError) -> Any:
        errs = exc.errors()
        try:
            err_repr = repr(errs)
            if len(err_repr) > 4000:
                err_repr = err_repr[:4000] + "…(truncated)"
        except Exception:
            err_repr = "<unrepr-able errors>"
        log.warning(
            "request_validation_failed method=%s path=%s client_host=%s errors=%s",
            request.method,
            request.url.path,
            request.client.host if request.client else None,
            err_repr,
        )
        return await request_validation_exception_handler(request, exc)

    @app.exception_handler(StarletteHTTPException)
    async def _http_exc(request: Request, exc: StarletteHTTPException) -> Any:
        detail = exc.detail
        if exc.status_code >= 500:
            log.error(
                "http_error_response method=%s path=%s status=%s detail=%r",
                request.method,
                request.url.path,
                exc.status_code,
                detail,
            )
        elif exc.status_code >= 400:
            log.warning(
                "http_error_response method=%s path=%s status=%s detail=%r",
                request.method,
                request.url.path,
                exc.status_code,
                detail,
            )
        return await http_exception_handler(request, exc)

    @app.exception_handler(Exception)
    async def _unhandled(request: Request, exc: Exception) -> Any:
        log.exception(
            "unhandled_exception method=%s path=%s: %s",
            request.method,
            request.url.path,
            exc.__class__.__name__,
        )
        # Echo the request's Origin into Access-Control-Allow-Origin so the
        # browser can actually READ this error response. Without this, the
        # CORS middleware's normal path is bypassed on uncaught exceptions —
        # the browser sees the 500 as a CORS failure and the JS layer gets
        # only a generic TypeError ("Network request failed"), hiding the
        # actual detail from the developer + admin.
        origin = request.headers.get("origin", "")
        headers = {}
        if origin:
            headers["Access-Control-Allow-Origin"] = origin
            headers["Access-Control-Allow-Credentials"] = "true"
            headers["Vary"] = "Origin"
        return JSONResponse(
            status_code=500,
            content={"detail": "Internal server error"},
            headers=headers,
        )
