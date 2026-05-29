"""FastAPI app entrypoint — ``knowledge_ingestion.server:app``.

Endpoints (all auth-gated except healthz/metrics):

  GET  /healthz
  GET  /metrics
  POST /v1/ingest                       JSON or multipart
  GET  /v1/jobs/{job_id}
  GET  /v1/agents/{agent_id}/sources
  DELETE /v1/sources/{source_id}?agent_id=...
  POST /v1/query                        the per-turn hot path
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import (
    Depends,
    FastAPI,
    File,
    Form,
    HTTPException,
    Response,
    UploadFile,
    status,
)
from pydantic import ValidationError

from . import healthz, metrics
from .auth import require_api_key
from .config import CONFIG, ensure_data_dir
from .embedding import embed, embed_one, is_loaded, load as load_embedding
from .ingest import ChunkInput
from .ingest.pdf import parse_pdf
from .ingest.sitemap import parse_sitemap
from .ingest.text import parse_markdown, parse_text
from .ingest.url import parse_url
from .jobs import JobRecord, configure as configure_jobs, get as get_job, serialise
from .jobs import submit as submit_job
from .proto import (
    IngestMarkdownRequest,
    IngestSitemapRequest,
    IngestTextRequest,
    IngestUrlRequest,
    QueryRequest,
)
from .store import (
    StoredChunk,
    delete_source,
    insert_chunks,
    list_sources,
    query,
    store_size_mib,
    total_agents,
    total_chunks,
)


_log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    """Load the embedding model + ensure the data dir + start the
    background-job pool. ``ensure_data_dir`` raises SystemExit on a
    read-only filesystem so the operator finds out about the missing
    persistent volume at boot, not at first ingest."""
    _log.info(
        "boot: data_dir=%s, model=%s, cache=%s",
        CONFIG.data_dir, CONFIG.embedding_model, CONFIG.models_cache_dir,
    )
    ensure_data_dir()
    configure_jobs(CONFIG.max_concurrent_ingests)
    try:
        actual_dim = await asyncio.to_thread(
            load_embedding,
            model_name=CONFIG.embedding_model,
            cache_dir=CONFIG.models_cache_dir,
        )
        if actual_dim != CONFIG.embedding_dim:
            healthz.set_status("error")
            raise SystemExit(
                f"embedding model produced dim={actual_dim} but config "
                f"declared KN_EMBEDDING_DIM={CONFIG.embedding_dim}. "
                "Set KN_EMBEDDING_DIM to match the model, or pick a "
                "different model."
            )
        healthz.set_status("ok")
        _log.info("boot: ready (embedding_dim=%d)", actual_dim)
    except Exception:
        healthz.set_status("error")
        _log.exception("boot: failed; pod will not serve traffic")
        raise
    yield


def configure_logging() -> None:
    logging.basicConfig(
        level=CONFIG.log_level.upper(),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


configure_logging()
app = FastAPI(
    title="vocence-knowledge-ingestion",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url=None,
    openapi_url="/openapi.json",
)


# --- Public endpoints (no auth) ---

@app.get("/healthz")
async def healthz_endpoint() -> dict:
    return {
        "status": healthz.get_status(),
        "service": "knowledge-ingestion",
        "embedding_model": CONFIG.embedding_model,
        "embedding_dim": CONFIG.embedding_dim,
        "version": "0.1.0",
        "uptime_seconds": healthz.uptime_seconds(),
        "in_flight_ingests": 0,  # see metrics for the live gauge
        "max_concurrent_ingests": CONFIG.max_concurrent_ingests,
        "store": {
            "engine": "lancedb",
            "total_agents": total_agents(),
            "total_chunks": total_chunks(),
            "size_mib": store_size_mib(),
        },
        **healthz._ram_info(),
    }


@app.get("/metrics")
async def metrics_endpoint() -> Response:
    body, content_type = metrics.render()
    return Response(content=body, media_type=content_type)


# --- Auth-gated endpoints ---

@app.post("/v1/ingest", dependencies=[Depends(require_api_key)])
async def ingest(
    # Multipart fields (used when source_type=pdf)
    source_type: str | None = Form(default=None),
    agent_id: str | None = Form(default=None),
    title: str | None = Form(default=None),
    file: UploadFile | None = File(default=None),
    # JSON body (used for everything else) is read below via request
    # parsing. FastAPI doesn't let us declare both "multipart Form
    # fields" AND a Pydantic JSON body on the same route, so we
    # branch based on which one is present.
    request: dict[str, Any] | None = None,  # not used; placeholder
) -> dict:
    # When the client posts multipart we get Form values; when they
    # post JSON the Form values are None and we read the body
    # explicitly. The dual-mode is the cleanest way to keep ONE
    # endpoint for ingest while handling file uploads + JSON.
    if source_type == "pdf":
        return await _ingest_pdf(agent_id, title, file)

    # JSON path — read the raw body once and dispatch on source_type.
    from fastapi import Request as _Req
    # Awkward: we can't take Request as a function arg AND expose Form
    # fields. Pull it from the running starlette scope via FastAPI's
    # state stash — or alternatively, refactor into two endpoints.
    # For clarity here we'll use a helper route that explicitly takes
    # JSON. So actually we need to split this — see /v1/ingest/url etc.
    raise HTTPException(
        status_code=400,
        detail={"error": "use /v1/ingest/{type} for non-pdf source types"},
    )


# Separate JSON endpoints for each source type — cleaner than a single
# endpoint that has to discriminate between Form vs JSON parsing.
@app.post("/v1/ingest/url", dependencies=[Depends(require_api_key)])
async def ingest_url(body: IngestUrlRequest) -> dict:
    return await _kick_off_async_ingest(
        agent_id=body.agent_id,
        work=_make_work_url(
            url=body.url, title=body.title, max_depth=body.max_depth,
        ),
    )


@app.post("/v1/ingest/sitemap", dependencies=[Depends(require_api_key)])
async def ingest_sitemap(body: IngestSitemapRequest) -> dict:
    if body.max_pages > CONFIG.max_pages_per_sitemap:
        raise HTTPException(
            status_code=400,
            detail={
                "error": f"max_pages={body.max_pages} exceeds "
                f"server limit {CONFIG.max_pages_per_sitemap}"
            },
        )
    return await _kick_off_async_ingest(
        agent_id=body.agent_id,
        work=_make_work_sitemap(
            url=body.url, title=body.title,
            include=body.include, exclude=body.exclude,
            max_pages=body.max_pages,
        ),
    )


@app.post("/v1/ingest/text", dependencies=[Depends(require_api_key)])
async def ingest_text(body: IngestTextRequest) -> dict:
    return await _ingest_sync_or_async(
        body.agent_id,
        body.content,
        is_markdown=False,
        title=body.title,
    )


@app.post("/v1/ingest/markdown", dependencies=[Depends(require_api_key)])
async def ingest_markdown(body: IngestMarkdownRequest) -> dict:
    return await _ingest_sync_or_async(
        body.agent_id,
        body.content,
        is_markdown=True,
        title=body.title,
    )


@app.get("/v1/jobs/{job_id}", dependencies=[Depends(require_api_key)])
async def get_job_status(job_id: str) -> dict:
    job = await get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail={"error": "job not found"})
    return serialise(job)


@app.get(
    "/v1/agents/{agent_id}/sources", dependencies=[Depends(require_api_key)],
)
async def get_agent_sources(agent_id: str) -> dict:
    return {"sources": list_sources(agent_id)}


@app.delete(
    "/v1/sources/{source_id}", dependencies=[Depends(require_api_key)],
)
async def delete_one_source(source_id: str, agent_id: str) -> dict:
    """Source delete is namespaced by agent_id (passed as a query
    parameter) — that way an operator can't accidentally drop a source
    from the wrong agent's table just by colliding source_ids."""
    removed = delete_source(agent_id, source_id)
    return {"deleted": True, "chunks_removed": removed}


@app.post("/v1/query", dependencies=[Depends(require_api_key)])
async def query_endpoint(body: QueryRequest) -> dict:
    """The hot path. Called per voice-agent turn by the dashboard
    backend. p95 target: ≤ 80 ms for ≤ 50k-chunk single-agent indexes.
    Most of the time goes into embedding (~5–8 ms) and LanceDB search
    (~5–15 ms depending on table size); JSON encoding adds ~1 ms."""
    if not is_loaded():
        raise HTTPException(
            status_code=503, detail={"error": "embedding model not loaded"}
        )
    t0 = time.perf_counter()
    embed_t0 = time.perf_counter()
    # Embed off the event loop — single-input embedding is fast but
    # we don't want any chance of a fastembed-internal mutex blocking
    # the loop under load.
    query_vec = await asyncio.to_thread(embed_one, body.text)
    embedding_ms = int((time.perf_counter() - embed_t0) * 1000)

    search_t0 = time.perf_counter()
    chunks: list[StoredChunk] = await asyncio.to_thread(
        query, body.agent_id, query_vec, top_k=body.top_k, min_score=body.min_score,
    )
    search_ms = int((time.perf_counter() - search_t0) * 1000)
    total_ms = int((time.perf_counter() - t0) * 1000)
    metrics.record_query(total_ms)
    return {
        "chunks": [
            {
                "text": c.text,
                "score": c.score,
                "source_id": c.source_id,
                "source_title": c.source_title,
                "metadata": c.metadata,
            }
            for c in chunks
        ],
        "embedding_ms": embedding_ms,
        "search_ms": search_ms,
        "total_ms": total_ms,
    }


# ---------------------------------------------------------------------------
# Helpers — keep the route bodies short
# ---------------------------------------------------------------------------

async def _ingest_pdf(
    agent_id: str | None, title: str | None, file: UploadFile | None,
) -> dict:
    if not agent_id or not file:
        raise HTTPException(
            status_code=400,
            detail={"error": "agent_id and file are required for PDF ingest"},
        )
    body = await file.read()
    if len(body) > CONFIG.max_source_bytes:
        raise HTTPException(
            status_code=413,
            detail={"error": f"file too large; max {CONFIG.max_source_bytes} bytes"},
        )

    async def work(job: JobRecord) -> int:
        job.phase = "parsing PDF"
        chunks = await asyncio.to_thread(parse_pdf, body, title)
        return await _index_chunks(job, chunks)

    source_id = f"src_{uuid.uuid4().hex[:16]}"
    j = await submit_job(source_id=source_id, agent_id=agent_id, work=work)
    return {"status": "pending", "job_id": j.job_id, "source_id": source_id}


async def _ingest_sync_or_async(
    agent_id: str, content: str, *, is_markdown: bool, title: str | None,
) -> dict:
    """Text/markdown — synchronous when small (< KN_MAX_SYNC_BYTES),
    asynchronous via the job queue otherwise."""
    chunks_input = (
        parse_markdown(content, title) if is_markdown else parse_text(content, title)
    )
    if not chunks_input:
        raise HTTPException(
            status_code=400, detail={"error": "input produced no extractable text"},
        )

    source_id = f"src_{uuid.uuid4().hex[:16]}"

    if len(content.encode("utf-8")) <= CONFIG.max_sync_bytes:
        # Sync path — embed + insert inline, return finished.
        n = await asyncio.to_thread(
            _embed_and_insert_sync, agent_id, source_id, title, chunks_input,
        )
        metrics.add_chunks(n)
        metrics.record_job("completed")
        return {
            "status": "completed",
            "source_id": source_id,
            "chunk_count": n,
            "tokens_indexed": _approx_tokens(chunks_input),
        }

    async def work(job: JobRecord) -> int:
        job.phase = "embedding"
        return await _index_chunks(job, chunks_input, source_id=source_id, title=title)

    j = await submit_job(source_id=source_id, agent_id=agent_id, work=work)
    return {"status": "pending", "job_id": j.job_id, "source_id": source_id}


def _make_work_url(*, url: str, title: str | None, max_depth: int):
    async def work(job: JobRecord) -> int:
        job.phase = f"fetching {url}"
        chunks_input = await parse_url(url, title, max_depth=max_depth)
        return await _index_chunks(job, chunks_input)
    return work


def _make_work_sitemap(*, url: str, title: str | None,
                       include: list[str] | None, exclude: list[str] | None,
                       max_pages: int):
    async def work(job: JobRecord) -> int:
        job.phase = f"crawling sitemap {url}"
        chunks_input = await parse_sitemap(
            url, title=title, include=include, exclude=exclude,
            max_pages=max_pages,
        )
        return await _index_chunks(job, chunks_input)
    return work


async def _kick_off_async_ingest(
    *, agent_id: str, work,
) -> dict:
    source_id = f"src_{uuid.uuid4().hex[:16]}"

    async def wrapped(job: JobRecord) -> int:
        # Inject the source_id into the worker's closure via the job
        # record so _index_chunks can stamp it on every row.
        job._source_id_for_insert = source_id  # type: ignore[attr-defined]
        return await work(job)

    j = await submit_job(source_id=source_id, agent_id=agent_id, work=wrapped)
    return {"status": "pending", "job_id": j.job_id, "source_id": source_id}


async def _index_chunks(
    job: JobRecord,
    chunks_input: list[ChunkInput],
    *,
    source_id: str | None = None,
    title: str | None = None,
) -> int:
    """Embed + insert a list of ChunkInputs. Updates ``job.chunks_so_far``
    after each batch so polling shows live progress.

    ``source_id`` defaults to one stashed on the job record by the
    submitter (see ``_kick_off_async_ingest``). Either path works.
    """
    if not chunks_input:
        return 0
    eff_source_id = (
        source_id
        or getattr(job, "_source_id_for_insert", None)
        or f"src_{uuid.uuid4().hex[:16]}"
    )
    # All chunks for one job get the same source_title (the document /
    # URL / sitemap top-level label) — falls back to the first chunk's
    # own metadata if present.
    eff_title = title or (chunks_input[0].metadata.get("source_title") or "")

    total = 0
    batch_size = 64  # tune jointly with embedding.embed() batch_size
    for batch_start in range(0, len(chunks_input), batch_size):
        batch = chunks_input[batch_start : batch_start + batch_size]
        texts = [c.text for c in batch]
        metas = [c.metadata for c in batch]
        job.phase = f"embedding batch {batch_start // batch_size + 1}"
        vectors, _ = await asyncio.to_thread(embed, texts)
        await asyncio.to_thread(
            insert_chunks,
            job.agent_id,
            source_id=eff_source_id,
            source_title=eff_title,
            texts=texts,
            embeddings=vectors,
            per_chunk_metadata=metas,
            embedding_dim=CONFIG.embedding_dim,
        )
        total += len(batch)
        job.chunks_so_far = total
        metrics.add_chunks(len(batch))
    return total


def _embed_and_insert_sync(
    agent_id: str, source_id: str, title: str | None,
    chunks_input: list[ChunkInput],
) -> int:
    """Synchronous inline path used by text/markdown under the sync
    size cap. Same logic as ``_index_chunks`` minus the asyncio bits."""
    if not chunks_input:
        return 0
    eff_title = title or (chunks_input[0].metadata.get("source_title") or "")
    texts = [c.text for c in chunks_input]
    metas = [c.metadata for c in chunks_input]
    vectors, _ = embed(texts)
    insert_chunks(
        agent_id,
        source_id=source_id,
        source_title=eff_title,
        texts=texts,
        embeddings=vectors,
        per_chunk_metadata=metas,
        embedding_dim=CONFIG.embedding_dim,
    )
    return len(texts)


def _approx_tokens(chunks_input: list[ChunkInput]) -> int:
    """Rough token count for the response. ~4 chars per token, summed
    across chunks."""
    return sum(len(c.text) for c in chunks_input) // 4
