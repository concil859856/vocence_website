# Vocence Developer API · Changelog

## 1.2.0 — 2026-06-01

### Added
- **Feedback endpoints** (`/v1/feedback`). Submit / fetch thumbs-up /
  thumbs-down on a single generation so apps can collect quality
  signal on AI outputs they ship to their own users:
  - `POST /v1/feedback` — upsert (rating = -1 / 0 / 1, optional comment)
  - `GET  /v1/feedback?entry_type=…&entry_id=…` — current rating (0
    when no rating exists, never 404s)
  - `entry_type` enum: tts, stt, voice_clone, voice_design, music,
    noise_remover, agent_call, agent_message
- **Agent discovery** under `/v1/agents/`:
  - `GET /templates` + `GET /templates/{id}` — starter gallery + full
    body for building an agent-create UI
  - `GET /models` — voice-agent LLM picker (low-latency Cerebras)
  - `GET /tools/builtin` — built-in tool catalog with per-deployment
    availability flags
- **LLM-powered agent authoring**:
  - `POST /v1/agents/draft` — one-shot agent spec from a plain-English
    description
  - `POST /v1/agents/architect/chat` — iterative conversation; returns
    `{reply, proposed_changes}` so the UI only shows "Apply" when the
    user explicitly asked for an edit
- **Goal-agent runs** under `/v1/agents/{agent_id}/runs/`:
  - `GET /` — list recent runs (max 50)
  - `POST /` — start a new run (returns it in `pending` state; poll
    the run id for progress)
  - `GET /{run_id}` — fetch single run incl. transcript
  - `POST /{run_id}/cancel` — idempotent

## 1.1.0 — 2026-06-01

### Added
- **Per-agent knowledge ingestion** (`/v1/agents/{agent_id}/knowledge/*`).
  Eight new endpoints mirror the dashboard's RAG ingestion surface:
  - `POST /ingest/text` — plain text blob
  - `POST /ingest/markdown` — markdown blob (structure preserved)
  - `POST /ingest/url` — single page (or page + 1 internal-link hop)
  - `POST /ingest/sitemap` — crawl a sitemap.xml (up to 5000 pages,
    include/exclude regex filters)
  - `POST /ingest/pdf` — multipart upload, hard cap 50 MB
  - `GET  /sources` — list ingested sources for an agent
  - `DELETE /sources/{source_id}` — remove an ingested source
  - `GET  /jobs/{job_id}` — poll long-running ingest jobs
- **Embed-token management** (`/v1/agents/{agent_id}/embed-tokens/*`).
  Mint, list and revoke widget tokens so customer-facing sites can run
  `<vocence-agent>` without ever holding an API key:
  - `POST /embed-tokens` — create (returns `plaintext` ONCE)
  - `GET /embed-tokens` — list (metadata only)
  - `DELETE /embed-tokens/{token_id}` — revoke
- **Streaming voice protocol** on the agent WebSocket. The server now
  advertises `capabilities.voice_stream` in its `ready` event; capable
  clients can push `stream_start` + raw 16 kHz PCM16LE frames +
  `stream_commit` for low-latency live transcription. Existing
  `voice` (one-shot WAV) and `text` turns are unchanged.
  Documented end-to-end in `app/api/routes/agents.py`.

### Backend feature parity
- Inherits the dashboard's recent voice-chat hardening transparently
  through the WS relay: forward-frames wait-for-final fix, stray
  `stream_commit` no-op, idle / max-duration session timeouts.
- The 50 MB PDF cap is enforced on the developer-api side as well so
  oversize uploads fail fast before the dashboard hop.
