# vocence/knowledge-ingestion

Per-agent RAG service for Vocence voice agents. Ingest PDFs, URLs,
sitemaps, plain text, and markdown; serve sub-100ms vector queries
at runtime.

| Component | Choice | Why |
|---|---|---|
| Embedding | [`BAAI/bge-small-en-v1.5`](https://huggingface.co/BAAI/bge-small-en-v1.5) via [fastembed](https://github.com/qdrant/fastembed) | 384-dim, MIT, CPU-friendly, ONNX-based, no torch dep |
| Vector store | [LanceDB](https://github.com/lancedb/lancedb) | Apache-2.0, embedded (no separate process), columnar |
| PDF parsing | [pypdf](https://github.com/py-pdf/pypdf) | Pure-Python, ~1MB install |
| URL extraction | [trafilatura](https://github.com/adbar/trafilatura) | Strips nav/footer, broad CMS support |

---

## Quick start

```bash
# Build
docker build -t vocence/knowledge-ingestion:dev .

# Run — MUST mount a persistent volume for the LanceDB store
docker run --rm -p 8118:8118 \
  -v vocence_kn_data:/data/kn \
  -e KN_API_KEY=test_key_local \
  vocence/knowledge-ingestion:dev

# Health
curl http://localhost:8118/healthz

# Ingest plain text (sync because it's small)
curl -s -X POST http://localhost:8118/v1/ingest/text \
  -H "X-API-Key: test_key_local" \
  -H "Content-Type: application/json" \
  -d '{"source_type":"text","agent_id":"ag_demo","title":"FAQ",
       "content":"To cancel, visit Account > Subscription > Cancel."}'
# → {"status":"completed","source_id":"src_...","chunk_count":1,"tokens_indexed":12}

# Query
curl -s -X POST http://localhost:8118/v1/query \
  -H "X-API-Key: test_key_local" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"ag_demo","text":"how do I cancel my subscription",
       "top_k":3,"min_score":0.55}'
# → {"chunks":[...],"embedding_ms":3,"search_ms":3,"total_ms":7}
```

---

## What this service does

```
┌──────────────────────────┐       ┌──────────────────────────┐
│  Agent owner uploads     │       │  Voice agent runtime     │
│  PDF / URL / text        │       │  (your control plane)    │
└──────────────┬───────────┘       └──────────────┬───────────┘
               │                                  │
               │ POST /v1/ingest                  │ POST /v1/query
               │ (PDF multipart or JSON)          │ {agent_id, text, top_k}
               ▼                                  ▼
┌─────────────────────────────────────────────────────────────┐
│                  vocence/knowledge-ingestion                │
│                                                             │
│  background workers          embedding model                │
│   ┌───────────────┐           ┌───────────────┐             │
│   │ parser →      │           │ BGE-small-en  │             │
│   │ chunker →     │──────────►│ (fastembed)   │             │
│   │ embedder →    │           └───────────────┘             │
│   │ store         │                                         │
│   └───────┬───────┘                                         │
│           │                                                 │
│           ▼                                                 │
│   ┌─────────────────────────────────────────────┐           │
│   │ LanceDB — one table per agent               │           │
│   │ agent_ag_demo, agent_ag_acme, ...           │           │
│   │   chunk_id, source_id, text, embedding,     │           │
│   │   metadata_json, ingested_at                │           │
│   └─────────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────┘
```

Per-turn query path: embed the user's transcript (~5 ms) → LanceDB
top-K search (~5 ms per ≤50k-chunk table) → return chunks → caller
injects them into the LLM system prompt. **End-to-end target: p95 ≤ 80 ms.**

---

## Configuration

| Env | Required | Default | Purpose |
|---|---|---|---|
| `KN_API_KEY` | **yes** | — | Shared secret for `X-API-Key` header |
| `KN_PORT` | no | `8118` | HTTP bind port |
| `KN_DATA_DIR` | no | `/data/kn` | LanceDB persistent volume mount |
| `KN_EMBEDDING_MODEL` | no | `BAAI/bge-small-en-v1.5` | HF id of the embedding model |
| `KN_EMBEDDING_DIM` | no | `384` | Must match the model's output dim; we verify at startup |
| `KN_MAX_CONCURRENT_INGESTS` | no | `8` | Background worker pool size |
| `KN_MAX_SOURCE_BYTES` | no | `50000000` | Single-file upload cap (50 MB) |
| `KN_MAX_PAGES_PER_SITEMAP` | no | `500` | Sitemap crawl cap |
| `KN_MAX_DEPTH` | no | `1` | URL crawl depth (0 or 1 supported) |
| `KN_MAX_SYNC_BYTES` | no | `100000` | text/markdown below this size processed inline; above → background job |
| `KN_LOG_LEVEL` | no | `info` | |
| `KN_LOG_PAYLOADS` | no | `0` | Privacy default off |
| `KN_MODELS_CACHE_DIR` | no | — | HF cache path (the Docker image points this at `/models`) |

---

## ⚠️ Persistent volume required

LanceDB stores per-agent vector tables on disk under `KN_DATA_DIR`.
**Without a persistent volume mounted at this path, every container
restart wipes all ingested knowledge.** The container refuses to
start if `KN_DATA_DIR` isn't writable — fail-loud rather than
silently lose data.

```bash
docker run -v vocence_kn_data:/data/kn ...
```

---

## API

### `GET /healthz`

```json
{
  "status": "ok",
  "service": "knowledge-ingestion",
  "embedding_model": "BAAI/bge-small-en-v1.5",
  "embedding_dim": 384,
  "version": "0.1.0",
  "uptime_seconds": 1,
  "in_flight_ingests": 0,
  "max_concurrent_ingests": 8,
  "store": {
    "engine": "lancedb",
    "total_agents": 12,
    "total_chunks": 4280,
    "size_mib": 18
  },
  "ram_used_mib": 982,
  "ram_total_mib": 32000
}
```

### `GET /metrics`

Prometheus text. Required counters:

```
kn_ingest_jobs_total{status="completed"} <int>
kn_ingest_jobs_total{status="failed"} <int>
kn_ingest_chunks_total <int>
kn_query_total <int>
kn_query_duration_ms_sum <float>
kn_query_duration_ms_count <int>
kn_embedding_duration_ms_sum <float>
kn_embedding_duration_ms_count <int>
kn_inflight_ingests <int>
```

### `POST /v1/ingest/{type}` — type ∈ `url`, `sitemap`, `text`, `markdown`

JSON body. See [src/knowledge_ingestion/proto.py](src/knowledge_ingestion/proto.py) for the exact shape per type.

Small text/markdown (under `KN_MAX_SYNC_BYTES`) returns immediately:

```json
{"status":"completed","source_id":"src_...","chunk_count":42,"tokens_indexed":13420}
```

Larger payloads + URL + sitemap return a job id:

```json
{"status":"pending","job_id":"job_...","source_id":"src_..."}
```

### `POST /v1/ingest` — PDF multipart

```bash
curl -X POST .../v1/ingest \
  -H "X-API-Key: $KEY" \
  -F "source_type=pdf" -F "agent_id=ag_demo" -F "title=Handbook" \
  -F "file=@handbook.pdf"
```

### `GET /v1/jobs/{job_id}`

Poll until `status` is `completed` or `failed`. Live progress in
`phase` and `chunks_so_far`.

### `GET /v1/agents/{agent_id}/sources`

```json
{"sources":[{"source_id":"src_...","source_title":"...","chunks":542,"ingested_at":"..."}]}
```

### `DELETE /v1/sources/{source_id}?agent_id=...`

```json
{"deleted": true, "chunks_removed": 542}
```

### `POST /v1/query` — the per-turn hot path

```json
{"agent_id":"ag_demo","text":"how do I cancel","top_k":6,"min_score":0.55}
```

Returns:

```json
{
  "chunks": [
    {
      "text": "...",
      "score": 0.84,
      "source_id": "src_...",
      "source_title": "...",
      "metadata": {"page": 42, "section": "Cancellations"}
    }
  ],
  "embedding_ms": 8,
  "search_ms": 12,
  "total_ms": 22
}
```

---

## Performance

Measured locally on a 12-core CPU, ~50 k-chunk table:

| Metric | Measured | Spec target |
|---|---|---|
| `POST /v1/query` p95 | < 25 ms | ≤ 80 ms |
| Embedding (single text) | 3–8 ms | ≤ 10 ms |
| LanceDB top-6 search | 3–15 ms | ≤ 30 ms |
| Cold start (with cached weights) | ~2 s | ≤ 30 s |
| Embedding throughput batch-of-32 | ~150 chunks/sec | ≥ 100 chunks/sec |

---

## Development

```bash
pip install -e ".[dev]"
ruff check src
pytest
KN_API_KEY=dev uvicorn knowledge_ingestion.server:app --port 8118 --reload
```

---

## Architectural decisions

- **In-process job queue, not Celery.** For a single-pod deployment
  the external broker (Redis, RabbitMQ) is overkill. The trade-off:
  if the pod restarts mid-ingest the in-flight job is lost, and the
  client must re-submit. Job state in memory only.
- **One LanceDB table per agent.** Simpler than a global table with a
  filter — LanceDB's per-table indexes are independent so per-agent
  hot tables stay hot. Trade-off: thousands of agents → thousands of
  tables. LanceDB handles this fine but operators should know.
- **fastembed instead of sentence-transformers.** Same model (BGE),
  same quality, ~10× smaller install, no torch dep. The trade-off is
  losing some of sentence-transformers' bells (CrossEncoder, etc.)
  that we don't use anyway.
- **pypdf instead of unstructured.** unstructured pulls 2 GB of ML deps
  for layout-aware parsing. For typical prose PDFs (handbooks, FAQs)
  pypdf's text extraction is acceptable. Scanned/image PDFs return
  zero chunks with a warning — operators should OCR first.
- **Single worker per container.** Each worker holds the embedding
  model + a LanceDB connection. Multiple workers per container would
  duplicate them. Scale horizontally with more pods.

---

## License

Apache-2.0.
