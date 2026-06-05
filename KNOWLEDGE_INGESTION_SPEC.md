# Vocence Agent Knowledge Ingestion Service — Implementation Spec

**Repo to build:** `vocence/knowledge-ingestion`
**Audience:** an implementing engineer/agent with no Vocence-codebase access.

---

## 1. What this is

A self-hosted service that lets a Vocence agent owner attach **PDF, URL, sitemap, plain-text, or Markdown** sources to an agent. The service parses each source, chunks it, generates embeddings, and stores them in a per-agent vector index. At voice-agent runtime, the Vocence dashboard backend queries this service for the top-K most relevant chunks given the user's current utterance and injects them into the LLM prompt — classic RAG.

Three things make this its own service:

1. **It owns vector storage.** The dashboard backend's SQLite is wrong for embedding search; this service uses a real vector store (LanceDB or sqlite-vec) and exposes a query API.
2. **It does heavy parsing on its own clock.** PDF/HTML/sitemap parsing is bursty and slow (multi-second). Keeping it in the dashboard backend would block hot request paths.
3. **It's the natural home for embedding model serving.** A single embedding model loaded once, shared across all agents, is far cheaper than spinning embeddings up per-request.

The current Vocence agent UI explicitly notes "v1 is text-only — file/URL upload coming soon." This service is the backend that flips that to "shipped."

---

## 2. Why this exists

ElevenLabs Conversational AI, Vapi, and Retell all support PDF/URL knowledge upload as a core agent feature. Text-only knowledge is a hard pass for any serious customer (sales, support, docs-Q&A use cases). This is one of the two biggest agent-feature gaps vs the competition (the other is embeddable widgets — see `EMBEDDABLE_WIDGET_SPEC.md`).

---

## 3. Scope

### In scope
- Accept ingestion jobs: PDF file, URL (single page), sitemap URL (many pages), plain-text blob, Markdown blob
- Parse → clean → chunk → embed → store, all on a background job queue
- Per-agent isolation: each agent's chunks are private to that agent
- Streaming chunked retrieval: given a query, return the top-K chunks across an agent's full knowledge
- Job status API: poll a job id for `pending` / `running` / `completed` / `failed`
- Standard Vocence ops contract: `/healthz`, `/metrics`, `X-API-Key` auth

### Out of scope
- Multi-tenant ACLs beyond a single shared API key (the dashboard backend handles user-facing auth and proxies to this service)
- Document versioning / re-crawl scheduling — v1 is "ingest once, manual re-ingest to update"
- OCR for image-only PDFs (use `unstructured` defaults; warn but don't fail)
- Vector store horizontal sharding — single-process LanceDB scales to ~10M chunks per agent which is plenty for v1
- Custom embedding models or fine-tuning — uses a single shared open-weights embedding model

---

## 4. Architecture

```
┌──────────────────────┐     1. POST /v1/ingest             ┌──────────────────────────┐
│  Dashboard backend   │ ──────────────────────────────────▶│ knowledge-ingestion pod  │
│  (Vocence main API)  │                                    │                          │
│                      │ ◀─────────────────────────────────│   ┌─ FastAPI HTTP        │
└──────────────────────┘     2. {job_id, status: pending}   │   ├─ Background workers │
         │                                                  │   ├─ Embedding model    │
         │ 3. periodic poll                                  │   ├─ LanceDB store      │
         │ GET /v1/jobs/{id}                                 │   └─ HF Parsers         │
         │                                                  │                          │
         └──────────────────────────────────────────────────▶│                          │
                                                            └──────────────────────────┘
                                                                       │
   At voice-agent runtime:                                              │ 5. retrieve top-K
   POST /v1/query                                                       │
   { agent_id, text, top_k }                                            ▼
   →    { chunks: [...] }                                       ┌─────────────┐
                                                                │  LanceDB     │
                                                                │  per-agent   │
                                                                │  vector idx  │
                                                                └─────────────┘
```

Two job types:
- **Synchronous-looking small ingests** (plain text, Markdown ≤ 100 KB): processed inside the request, return `{status: "completed", chunk_count: N}` directly.
- **Async large ingests** (PDF, URL, sitemap): queued, return `{status: "pending", job_id}`. Caller polls.

---

## 5. Container contract

### 5.1 `GET /healthz`

```json
{
  "status": "ok",
  "service": "knowledge-ingestion",
  "embedding_model": "BAAI/bge-small-en-v1.5",
  "embedding_dim": 384,
  "version": "0.1.0",
  "uptime_seconds": 142,
  "in_flight_ingests": 2,
  "queued_ingests": 4,
  "max_concurrent_ingests": 8,
  "store": {
    "engine": "lancedb",
    "total_agents": 142,
    "total_chunks": 1842033,
    "size_mib": 4820
  }
}
```

### 5.2 `GET /metrics`

```
kn_ingest_jobs_total{status="completed"} 1284
kn_ingest_jobs_total{status="failed"} 7
kn_ingest_chunks_total 1842033
kn_query_total 89102
kn_query_duration_ms_sum 412034
kn_query_duration_ms_count 89102
kn_embedding_duration_ms_sum 124021
kn_embedding_duration_ms_count 1842033
kn_inflight_ingests 2
```

### 5.3 Auth

`X-API-Key` header — same pattern as other Vocence pods. Set via `KN_API_KEY` env var. No anonymous access.

---

## 6. HTTP API

### 6.1 `POST /v1/ingest`

Submit one knowledge source. Body shape depends on `source_type`.

**PDF (multipart):**
```
POST /v1/ingest
Content-Type: multipart/form-data
X-API-Key: ...

source_type=pdf
agent_id=ag_abc123
title=Customer Handbook 2026         (optional, display label)
file=@handbook.pdf
```

**URL (JSON):**
```json
POST /v1/ingest
{
  "source_type": "url",
  "agent_id": "ag_abc123",
  "url": "https://docs.example.com/api/getting-started",
  "title": "API Quickstart",
  "max_depth": 0
}
```
- `max_depth=0`: just this URL. `max_depth>0`: follow same-origin links up to N hops. v1 supports 0 and 1; >1 returns `400`.

**Sitemap (JSON):**
```json
{
  "source_type": "sitemap",
  "agent_id": "ag_abc123",
  "url": "https://docs.example.com/sitemap.xml",
  "include": ["/docs/*"],
  "exclude": ["/docs/internal/*"],
  "max_pages": 500
}
```

**Plain text (JSON):**
```json
{
  "source_type": "text",
  "agent_id": "ag_abc123",
  "title": "FAQ",
  "content": "Q: ... A: ..."
}
```

**Markdown (JSON):**
```json
{
  "source_type": "markdown",
  "agent_id": "ag_abc123",
  "title": "Onboarding",
  "content": "# Welcome\n..."
}
```

**Response (small / sync):**
```json
{
  "status": "completed",
  "source_id": "src_def456",
  "chunk_count": 42,
  "tokens_indexed": 13420
}
```

**Response (queued / async):**
```json
{
  "status": "pending",
  "job_id": "job_ghi789",
  "source_id": "src_def456"
}
```

Server picks sync vs async based on:
- text/markdown ≤ 100 KB → sync
- everything else → async

### 6.2 `GET /v1/jobs/{job_id}`

```json
{
  "job_id": "job_ghi789",
  "source_id": "src_def456",
  "agent_id": "ag_abc123",
  "status": "running",
  "phase": "parsing PDF (page 17 of 240)",
  "chunks_so_far": 312,
  "started_at": "2026-05-29T14:02:11Z",
  "finished_at": null,
  "error": null
}
```

Status ∈ `pending` | `running` | `completed` | `failed`.

### 6.3 `GET /v1/agents/{agent_id}/sources`

List sources attached to an agent.
```json
{
  "sources": [
    {
      "source_id": "src_def456",
      "source_type": "pdf",
      "title": "Customer Handbook 2026",
      "chunk_count": 542,
      "tokens": 184022,
      "ingested_at": "2026-05-29T14:02:11Z"
    },
    ...
  ]
}
```

### 6.4 `DELETE /v1/sources/{source_id}`

Remove a source and all its chunks from the agent's vector store. Returns `{"deleted": true, "chunks_removed": 542}`.

### 6.5 `POST /v1/query`

The hot path — called per voice-agent turn to retrieve relevant chunks.

**Request:**
```json
{
  "agent_id": "ag_abc123",
  "text": "how do I cancel my subscription",
  "top_k": 6,
  "min_score": 0.55
}
```

**Response:**
```json
{
  "chunks": [
    {
      "text": "To cancel, visit Account → Subscription → Cancel. Cancellations take effect at the end of the current billing period.",
      "score": 0.84,
      "source_id": "src_def456",
      "source_title": "Customer Handbook 2026",
      "metadata": {
        "page": 42,
        "section": "Subscription Management"
      }
    },
    ...
  ],
  "embedding_ms": 8,
  "search_ms": 12,
  "total_ms": 22
}
```

Required performance: **p95 ≤ 80 ms** for a 6-chunk query on a single-agent index with ≤ 50k chunks. The dashboard backend calls this on every turn — it must be fast.

---

## 7. Pipeline details

### 7.1 Parsing
- **PDF**: `unstructured[pdf]` with `hi_res` strategy when ≤ 20 pages, `fast` strategy beyond. Falls back to `pypdf` text extraction if `unstructured` fails.
- **URL**: `httpx` GET → `trafilatura` for main-content extraction (drops nav/footer/ads).
- **Sitemap**: parse `<urlset>`, filter by include/exclude globs, then per-URL same as URL path. Concurrency cap: 4 simultaneous fetches.
- **Text / Markdown**: pass through; Markdown gets HTML-stripped but heading structure preserved as metadata.

### 7.2 Chunking
- Recursive character splitter with ~512-token target chunks, 64-token overlap
- Preserve structure: don't split inside a heading section if avoidable
- Each chunk carries metadata: `source_id`, `source_title`, `page` (PDF), `url` (web), `section_path` (e.g., `"Billing > Cancellations"`)

### 7.3 Embedding
- Default model: `BAAI/bge-small-en-v1.5` (384-dim, MIT, fast on CPU)
- Configurable via `KN_EMBEDDING_MODEL` env var
- Inference batched (32 chunks per forward pass) for throughput
- Recommendation: ship two model variants — `bge-small` (fast, default) and `bge-large` (higher quality, slower). Operator picks per deployment.

### 7.4 Storage
- **LanceDB** as the embedded vector store (Apache 2.0, columnar, fast). One table per agent: `agent_<agent_id>`.
- Schema: `chunk_id`, `text`, `embedding`, `source_id`, `source_title`, `metadata_json`, `ingested_at`
- Storage path: `/data/kn/` (mount this as a persistent volume — see §11)

---

## 8. Configuration (env vars)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `KN_API_KEY` | **Yes** | — | Shared secret |
| `KN_PORT` | No | `8118` | HTTP bind port |
| `KN_DATA_DIR` | No | `/data/kn` | Persistent vector store path |
| `KN_EMBEDDING_MODEL` | No | `BAAI/bge-small-en-v1.5` | HF id |
| `KN_MAX_CONCURRENT_INGESTS` | No | `8` | Worker pool size |
| `KN_MAX_SOURCE_BYTES` | No | `50_000_000` | 50 MB cap on a single PDF |
| `KN_MAX_PAGES_PER_SITEMAP` | No | `500` | Sitemap page limit |
| `KN_MAX_DEPTH` | No | `1` | URL crawl depth cap |
| `KN_LOG_LEVEL` | No | `info` | |

---

## 9. Performance targets

| Metric | Target |
|---|---|
| `POST /v1/query` p95 (single-agent, ≤50k chunks) | ≤ 80 ms |
| Embedding throughput (batch of 32) | ≥ 100 chunks/sec on 8 vCPU CPU |
| PDF ingest (240-page handbook) | ≤ 4 min end-to-end |
| URL ingest (single page) | ≤ 8 sec |
| Sitemap ingest (100-page docs site) | ≤ 4 min |
| RAM at idle (model loaded) | ≤ 800 MB |
| RAM at 8 concurrent ingests | ≤ 4 GB |

---

## 10. Resource requirements

### Minimum
- 4 vCPU
- 8 GB RAM
- 50 GB disk (vector store + ingest temp space)
- No GPU required (CPU embedding is fine for `bge-small`)

### Recommended
- 8 vCPU
- 16 GB RAM
- NVMe disk (vector search is I/O-bound at large scale)

Optional: GPU for `bge-large` embedding model if upgraded later. v1 is CPU-only.

---

## 11. Persistent volume

LanceDB stores per-agent vector tables on disk. The container needs a persistent volume mounted at `/data/kn`. Without it, restarting the pod wipes all knowledge.

Operator deployment:
```bash
docker run -v vocence_kn_data:/data/kn ...
```

The container must check `/data/kn` is writable on startup and refuse to start if not.

---

## 12. Repo structure

```
knowledge-ingestion/
├─ README.md
├─ Dockerfile
├─ pyproject.toml
├─ src/
│  └─ knowledge_ingestion/
│     ├─ __init__.py
│     ├─ server.py
│     ├─ ingest/
│     │  ├─ pdf.py
│     │  ├─ url.py
│     │  ├─ sitemap.py
│     │  ├─ text.py
│     │  └─ chunker.py
│     ├─ embedding.py
│     ├─ store.py            # LanceDB wrapper
│     ├─ jobs.py              # background worker queue
│     ├─ healthz.py
│     ├─ metrics.py
│     └─ config.py
├─ scripts/
│  ├─ benchmark.py
│  └─ smoke.py
├─ tests/
│  ├─ fixtures/
│  │  ├─ handbook_small.pdf
│  │  └─ docs_sitemap.xml
│  ├─ test_chunker.py
│  ├─ test_url_parse.py
│  ├─ test_query.py
│  └─ test_lifecycle.py
└─ .github/workflows/
```

---

## 13. Test plan

### Unit
- Chunker: known input → expected chunk count + boundary preservation
- URL parser: trafilatura strips nav/footer
- Embedding: deterministic given seed
- Storage: insert + query roundtrip

### Integration (against running container)
- Submit PDF, poll job to completion, query and assert relevant chunk returned
- Submit URL, sync small text, verify both paths
- Delete source → chunks gone, subsequent query returns nothing from that source
- Per-agent isolation: query agent A returns nothing about agent B's content

### Performance
- `scripts/benchmark.py` — query p95 + ingest throughput
- 100k-chunk smoke load: query p95 stays under target

---

## 14. Things to confirm with Vocence team

1. **Port assignment.** `8118` to not collide with the existing 8111–8116 services or the new 8117 (turn-detection). Confirm.
2. **Service name registration.** Will register as `knowledge_ingestion` in the ops dispatcher.
3. **Persistent volume strategy.** Operator must mount a persistent volume. Document this clearly in the README — first-time operators will lose data otherwise.
4. **Embedding model default.** Defaulting to `bge-small-en-v1.5` — English-leaning. If multi-lingual is needed, `BAAI/bge-m3` is a drop-in (multi-lingual + bigger). Confirm preferred default.
5. **Source upload limits.** 50 MB / 500 pages / depth 1 are conservative caps. Adjust if needed.

---

## 15. Definition of done

1. All §9 performance targets pass
2. All §13 integration tests pass
3. Reference Python client example uploads a PDF + queries it end-to-end
4. Image published to `docker.io/vocence/knowledge-ingestion:v0.1.0`
5. Persistent-volume requirement documented prominently in README
6. `/healthz` + `/metrics` + REST schemas match this document exactly

The Vocence integration side then needs: an upload UI on the agent settings page (file picker + URL field + sitemap field), `dashboardApi` methods that proxy to this pod, a sources-list panel showing what's attached + status of in-progress ingests, and a query call in `voicechat_service.py` at turn time to fetch top-K chunks and inject them into the LLM system prompt. That work happens in parallel.
