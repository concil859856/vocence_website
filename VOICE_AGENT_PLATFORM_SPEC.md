# Vocence Voice-Agent Platform — System Spec

> **Audience.** An implementing engineer/agent with no prior Vocence-codebase access. After reading this single document end-to-end, you should be able to (a) build any of the four new components without further context, and (b) understand how they fit together so what you build correctly integrates.

> **What this replaces.** Earlier separate documents covered streaming STT, turn detection, knowledge ingestion, and the embeddable widget as four files. All four have been fully inlined below — this is the canonical source. The standalone files were removed once their content landed here.

---

# Part I — System overview

## 1. What we're building

Vocence is a voice-agent platform built on Bittensor's decentralized AI network. Today it can run conversational voice agents end-to-end — mic capture, STT, LLM, TTS, audio playback — but the pipeline is held together with simple components: **batch STT** (a complete audio blob in, full transcript out), **silence-timer turn detection** (450 ms fixed timeout), **text-only agent knowledge** (paste your facts as a string), and **logged-in users only** (no embed flow).

This spec covers four new components that close the gap to OpenAI Realtime / ElevenLabs Conversational AI 2.0 parity, all using open-weights models and standard open-source stacks:

| # | Component | Repo | What it does | GPU? |
|---|---|---|---|---|
| 1 | **Streaming STT pod** | `vocence/asr-streaming-rt` | Real-time speech-to-text — stream PCM in, stream partials + finals out | Yes (4090-class) |
| 2 | **Turn detection pod** | `vocence/turn-detection` | End-of-utterance probability from both audio (Smart Turn v3) and text (LiveKit Turn Detector v2) | No (CPU only) |
| 3 | **Knowledge ingestion service** | `vocence/knowledge-ingestion` | PDF / URL / sitemap → embeddings → vector store; per-turn retrieval | No (CPU embedding) |
| 4 | **Embeddable widget** | `vocence/widget` (npm `@vocence/widget`) | One-line `<vocence-agent>` Web Component for any customer site | No (browser only) |

Plus integration work on the existing **Vocence dashboard backend** (already-built; lives in `dashboard-backend/`) that wires these four into the existing voicechat WebSocket protocol the Studio UI and widget both speak.

## 2. What already exists (do NOT rebuild)

| Existing | Role |
|---|---|
| `dashboard-backend` | FastAPI service. Owns the user-facing voicechat WebSocket protocol, agent CRUD, billing, ops dispatcher. New pods register here. |
| `dashboard-backend/ops/` | Pod fleet manager. Health-polls every 10 s, scrapes metrics every 30 s, dispatches WS sessions across pod instances. New pods plug into this. |
| `dashboard-backend/llm_client.py` | Wraps Cerebras / xAI / Groq / OpenAI / Chutes / local LLMs with a fallback ladder. Streaming + non-streaming. |
| `dashboard-backend/voicechat_service.py` | The voicechat session handler. Speaks the WebSocket protocol in §5 below. Currently calls batch STT; this is what we replace. |
| Vocence TTS pods (`vocence/fast-tts-streaming`) | Already streaming, already deployed. We don't touch these. |
| Vocence Studio frontend | The signed-in user UI. Already speaks the voicechat WS. Continues to work unchanged. |
| Vocence ops admin (`/admin/ops`) | UI for deploying/monitoring pods. The four new pods register the same way as existing ones. |

The new components do NOT replace the existing batch STT pod (`vocence/asr-streaming`) — that stays for studio/transcription jobs that don't need streaming. We're adding a *parallel* streaming path for voice-agent conversations.

## 3. Architecture diagram

```
   ┌─────────────────────────────────────────────────────────────────────┐
   │                       Customer's website                            │
   │                                                                     │
   │   <script src="https://widget.vocence.ai/v1/widget.js" defer></script>
   │   <vocence-agent agent-id="..." embed-token="..."></vocence-agent>  │
   │                                                                     │
   │              ┌──── Web Component (@vocence/widget) ────┐            │
   │              │  Silero VAD  ·  mic capture  ·  audio   │            │
   │              │  player with barge-in fade  ·  chat UI  │            │
   │              └──────────────────┬───────────────────────┘            │
   └─────────────────────────────────┼───────────────────────────────────┘
                                     │ WS: voicechat protocol (§5)
                                     │ ?token=<embed_token> or <JWT>
                                     ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │                  Vocence dashboard backend                          │
   │             (existing — we add wiring + new auth path)              │
   │                                                                     │
   │   voicechat_service.py:                                             │
   │     ┌─ accept WS, authenticate (JWT or embed_token)                 │
   │     │                                                               │
   │     ├─ on user audio:                                               │
   │     │     ├─ open WS to streaming STT pod  ── partials/finals ──┐   │
   │     │     ├─ open WS to turn detection (Smart Turn audio) ──────┤   │
   │     │     ├─ open WS to turn detection (Turn Detector text) ────┤   │
   │     │     │     (text endpoint fed from STT partials)           │   │
   │     │     ▼                                                     │   │
   │     │  ENSEMBLE 3 signals: Silero VAD + Smart Turn + Turn Det. ─┘   │
   │     │     → decide turn is over                                     │
   │     │                                                               │
   │     ├─ on turn end:                                                 │
   │     │     ├─ POST /v1/query to knowledge service → top-K chunks    │
   │     │     ├─ call llm_client.stream_chat_with_tools(history+chunks)│
   │     │     ├─ stream LLM text → sentence chunker                     │
   │     │     ├─ forward chunks to TTS pod                              │
   │     │     └─ stream TTS audio frames back over the user WS         │
   │     │                                                               │
   │     └─ on barge-in: client sends {type:"cancel"} → cancel STT,     │
   │                     turn-detection, LLM, and TTS in flight        │
   │                                                                     │
   └─────┬───────────────┬───────────────┬───────────────┬───────────────┘
         │               │               │               │
         │ WS            │ WS            │ HTTP          │ WS
         │ streaming     │ turn          │ /v1/query     │ TTS
         │ STT           │ detection     │               │ (existing)
         ▼               ▼               ▼               ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │ asr-stream-  │ │ turn-        │ │ knowledge-   │ │ fast-tts-    │
   │ ing-rt       │ │ detection    │ │ ingestion    │ │ streaming    │
   │              │ │              │ │              │ │ (existing)   │
   │ Parakeet TDT │ │ Smart Turn   │ │ LanceDB +    │ │              │
   │ 0.6B v3      │ │ v3 (audio)   │ │ BGE-small    │ │              │
   │              │ │ +            │ │ embedder     │ │              │
   │              │ │ LiveKit Turn │ │              │ │              │
   │              │ │ Detector v2  │ │              │ │              │
   │              │ │ (text)       │ │              │ │              │
   │              │ │              │ │              │ │              │
   │ Port 8114    │ │ Port 8117    │ │ Port 8118    │ │ Port 8111    │
   │ GPU          │ │ CPU only     │ │ CPU + disk   │ │ GPU          │
   └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

## 4. Shared conventions across the new pods

All three of the new server-side pods (streaming STT, turn detection, knowledge ingestion) follow the same Vocence-wide conventions. **This is non-negotiable** — the dashboard backend's ops dispatcher reads field names that are documented below, and if you deviate the dispatcher silently treats your pod as unhealthy.

### 4.1 Container contract

Every pod exposes three HTTP surfaces:

| Method+path | Purpose | Frequency hit by dispatcher |
|---|---|---|
| `GET /healthz` | Liveness + capacity self-report | Every 10 s |
| `GET /metrics` | Prometheus-format counters | Every 30 s |
| `WS|HTTP /v1/...` | The actual service interface | On demand |

### 4.2 Authentication

A single shared API key per pod, set at startup via env var. Required on every request:

```
X-API-Key: <key>
```

For WebSocket endpoints, the header is on the upgrade request. Wrong/missing key:
- HTTP → `401 {"error":"unauthorized"}`
- WS → close before completing handshake with close code `4401`

There is **no anonymous mode** and **no per-user auth at the pod layer**. The dashboard backend authenticates end users and proxies trusted calls to the pods using the shared key.

### 4.3 `/healthz` response shape

```json
{
  "status": "ok",                          // "ok" | "warming" | "degraded" | "error"
  "service": "<pod-service-name>",         // e.g. "asr-streaming-rt"
  "version": "0.1.0",
  "uptime_seconds": 142,
  "in_flight": <integer>,                  // currently-active sessions/jobs
  "max_concurrent_streams": <integer>      // capacity self-report
  // ... pod-specific fields, see individual specs
}
```

The dispatcher reads `status` (not the HTTP status code) and stops sending sessions to anything except `ok`. HTTP always returns 200 unless the process is genuinely broken.

### 4.4 `/metrics` response shape

Prometheus text format (`text/plain; version=0.0.4`). The dispatcher scrapes these names — they are interpolated into `ops_pod_metrics_minute` rows. If you don't emit them or emit them under different names, the time-series chart in `/admin/ops` shows empty for your pod.

Required counters across all new pods:

```
# Total requests/sessions accepted (labelled by status). Must be monotonic.
asr_requests_total{status="ok"} <int>
asr_requests_total{status="error"} <int>
asr_requests_total{status="timeout"} <int>

# Duration aggregates for p95-of-mean calculation. Must be monotonic.
asr_duration_ms_sum <float>
asr_duration_ms_count <int>

# Currently-in-flight sessions (gauge — can decrease).
asr_inflight <int>
```

Pod-specific extras are documented per pod below — they don't replace these.

### 4.5 Port assignments

The existing services own 8111–8116. New pods get:

| Port | Service |
|---|---|
| 8114 | `asr-streaming-rt` (note: same as existing batch STT — they never co-locate on one host) |
| 8117 | `turn-detection` |
| 8118 | `knowledge-ingestion` |

### 4.6 Image registry and tagging

```
docker.io/vocence/<service>:<tag>
```

Tags:
- `latest` — most recent stable
- `v0.1.0`, `v0.1.1`, … — semver pinned releases
- `dev-<sha>` — CI builds from `main`

CI: GitHub Actions. On push to `main`: lint, type-check, unit tests, integration test against a running container, build + push `dev-<sha>`. On tag `v*`: same plus push `v*` and `latest`.

### 4.7 Health states the dispatcher recognizes

| Pod's `status` | Dispatcher behavior |
|---|---|
| `ok` | Routes new sessions to this pod |
| `warming` | No new sessions; checks again on next poll |
| `degraded` | No new sessions; existing in-flight allowed to drain |
| `error` | No new sessions; marks pod as unhealthy in admin UI |

### 4.8 Logging

JSON-lines to stdout, one event per line:
```
{"ts": "2026-05-29T14:02:11.123Z", "level": "info", "msg": "session started", "session_id": "...", "extra_field": "..."}
```

Use the env var `<POD>_LOG_LEVEL` (e.g. `ASR_LOG_LEVEL`) to control verbosity. Default `info`. Never log audio payloads or transcripts unless `<POD>_LOG_PAYLOADS=1` is explicitly set (privacy default).

---

# Part II — End-to-end flows

## 5. The voicechat WebSocket protocol (existing, unchanged)

The widget and the Studio frontend both speak this protocol to talk to `dashboard-backend`. The new pods don't speak it directly — only `dashboard-backend` does. But every implementer needs to know it so they understand what dashboard-backend is doing when it talks to their pod.

**Endpoint:** `WS {server}/api/dashboard/voicechat/session?token=<JWT|embed_token>&agent_id=<id>`

**Client → server** (JSON text frames):

```json
{"type":"voice", "audio_b64":"<base64 WAV>", "mime":"audio/wav", "duration_ms":1234, "language":"en"}
{"type":"text",  "text":"hello world"}
{"type":"cancel"}                                    // barge-in
```

**Server → client:**

| `type` | Payload |
|---|---|
| `ready` | `{session_id, agent:{id,name}, session:{max_duration_sec,idle_timeout_sec}, billing?:{...}}` |
| `transcript` | `{text, language}` — the user's STT result |
| `token` | `{text}` — streaming LLM delta |
| `audio_meta` | `{sentence_id, sample_rate, frame_ms, encoding:"pcm16le", channels:1, is_filler}` |
| (binary) | Raw PCM16LE mono frames, 40 ms each |
| `audio_end` | `{sentence_id}` |
| `turn_end` | (no payload) |
| `cancelled` | (no payload) — barge-in acknowledged |
| `tool_call_started` / `tool_call_completed` | `{id, name, kind}` / `{id, result_preview}` |
| `session_timeout` | `{code:"idle_timeout"|"max_duration", message}` |
| `billing_exhausted` | `{message}` |
| `error` | `{code, message}` |

After Phase 2 (streaming STT lands), one new message is added — the existing protocol gains a `partial_transcript` server→client event:

```json
{"type":"partial_transcript", "text":"what's the weather in", "audio_ms_consumed":1280}
```

Existing clients can ignore this; new clients (widget, Studio) render it as live caption text.

## 6. End-to-end voice turn — sequence

This is the most important diagram. Read it once carefully; every implementation decision is grounded in this flow.

```
TIME ┄┄►

User                Widget/Studio       dashboard-backend         STT pod         Turn det pod      KB svc        LLM       TTS pod
 │                       │                     │                      │              (audio)(text)    │           │           │
 │  click "Start"        │                     │                      │                │      │       │           │           │
 ├──────────────────────►│                     │                      │                │      │       │           │           │
 │                       │ WS open w/ token    │                      │                │      │       │           │           │
 │                       ├────────────────────►│                      │                │      │       │           │           │
 │                       │◄──── ready ─────────┤                      │                │      │       │           │           │
 │                       │ (mic open, Silero VAD running locally)     │                │      │       │           │           │
 │                       │                     │                      │                │      │       │           │           │
 │ "what's the weather   │ Silero detects      │                      │                │      │       │           │           │
 │  in San Francisco"    │ speech-start;       │                      │                │      │       │           │           │
 ├──────────────────────►│ starts capturing    │                      │                │      │       │           │           │
 │                       │ PCM frames          │                      │                │      │       │           │           │
 │                       │                     │                      │                │      │       │           │           │
 │                       │ {type:"voice_pcm"...│                      │                │      │       │           │           │
 │                       ├────────────────────►│ Open 3 fan-out WS:   │                │      │       │           │           │
 │                       │ (PCM streaming)     ├─►WS STT/v1/stream────►│                │      │       │           │           │
 │                       │                     ├─►WS turn-det/smart-turn─────────────►  │      │       │           │           │
 │                       │                     ├─►WS turn-det/turn-detector──────────────────►       │           │           │
 │                       │                     │                      │                │      │       │           │           │
 │                       │ ── PCM frame ─────► │ ── tee 3 ways ─────► │ ─► EOU prob ◄─┘      │       │           │           │
 │                       │                     │                      ├ partial───►│        │       │           │           │
 │                       │                     │                      │            ├ EOU───►│       │           │           │
 │                       │ ◄── partial_transc ─┤◄─ partial "what's" ──┤            │        │       │           │           │
 │                       │ (live caption)      │                      │            │        │       │           │           │
 │                       │ ── PCM frame ─────► │ ── tee 3 ways ─────► │ ─► EOU prob ◄─┘      │       │           │           │
 │                       │                     │                      ├ partial───►│        │       │           │           │
 │                       │                     │                      │            ├ EOU───►│       │           │           │
 │                       │ ◄── partial_transc ─┤◄─ partial "what's    │            │        │       │           │           │
 │                       │   the weather in"   │                      │            │        │       │           │           │
 │                       │ ...                                                                                                │
 │                       │                                                                                                    │
 │ (stops speaking)      │ Silero VAD: silence │                      │                │      │       │           │           │
 │                       │ Silero EOU = true   │ ENSEMBLE: Silero ok? │                │      │       │           │           │
 │                       ├ silence_event ─────►│ Smart Turn high?  ◄──┴────────────────┘      │       │           │           │
 │                       │                     │ Turn Detector high?◄─────────────────────────┘      │           │           │
 │                       │                     │ → YES, commit turn                          │       │           │           │
 │                       │                     │                                              │       │           │           │
 │                       │                     │ ── final transcript ◄ STT pod commits        │       │           │           │
 │                       │ ◄── transcript ─────┤                                              │       │           │           │
 │                       │                     │                                              │       │           │           │
 │                       │                     │ POST /v1/query {agent_id, text, top_k:6} ──►│       │           │           │
 │                       │                     │ ◄────── {chunks:[...]} ─────────────────────┤       │           │           │
 │                       │                     │                                              │       │           │           │
 │                       │                     │ llm_client.stream_chat_with_tools(history,  │       │           │           │
 │                       │                     │   + retrieved_chunks_as_system_prompt) ─────────────►│           │           │
 │                       │                     │ ◄─── stream tokens ─────────────────────────────────┤           │           │
 │                       │                     │                                                                   │           │
 │                       │ ◄── token "It's" ───┤                                                                   │           │
 │                       │ ◄── token " 72" ────┤ sentence chunker: emit on .!? ──────────────────────────────────►│           │
 │                       │ ◄── audio_meta ─────┤                                              ◄─── PCM frames ───┤           │
 │                       │ ◄── PCM frames ─────┤ (forward TTS frames over user WS)                                              │
 │ (hears reply)         │ (Web Audio plays)                                                                                    │
 ├──◄─ audio playback ───┤                                                                                                      │
 │                       │                                                                                                      │
```

### Key decisions during this flow

1. **Mic audio is PCM, not WAV in v2.** The legacy protocol sent `{type:"voice", audio_b64}` with the full WAV after the user stopped. The new streaming path sends raw PCM chunks during speech. The protocol gains a new client→server frame format for this — see §6.1 below.
2. **Three WS sessions per turn.** The dashboard backend fans out: one to the STT pod (audio in, transcript out), two to the turn-detection pod (one for audio, one for text). They run in parallel for the whole turn.
3. **Signal ensembling lives in `dashboard-backend`.** Not in any pod. The pods report their individual signals; the backend decides "the turn is over."
4. **Knowledge retrieval is per-turn.** When the turn is decided over, the backend queries the knowledge service with the final transcript, gets top-K chunks, and injects them into the LLM's system prompt for that one turn. Not at session start, not at LLM streaming time — *at turn boundary*.
5. **Existing TTS path unchanged.** The streaming TTS pod, sentence chunker, and barge-in cancel propagation all stay the same.
6. **Barge-in cancels all three new pod sessions plus LLM plus TTS.** When the user starts talking during agent playback, dashboard-backend sends `cancel` to STT pod, both turn-detection WS sessions, the LLM streamer, and the TTS pod — all in parallel.

### 6.1 Streaming voice-input protocol extension

The existing protocol `{type:"voice", audio_b64}` is preserved for backwards compatibility (Studio falls back to it if streaming setup fails). The new streaming format:

**Client → server:**
```json
{"type":"voice_start", "sample_rate":16000, "encoding":"pcm_s16le", "language":"auto"}
```
Then binary frames carrying raw PCM16LE mono (no JSON wrapper, just the bytes), 20 ms chunks at 16 kHz.

When the client's local Silero VAD detects end-of-utterance:
```json
{"type":"voice_end"}
```

Or, if barge-in:
```json
{"type":"cancel"}
```

The server treats `voice_end` as a *hint* — it's one of three signals the ensembler considers. The ensembler may have already decided the turn is over before `voice_end` arrives, or may decide to wait for more audio if Smart Turn / Turn Detector say "still talking."

## 7. End-to-end agent setup (the configuration side)

```
Agent owner                Vocence Studio              dashboard-backend           Knowledge svc
 │                              │                            │                          │
 │  creates agent in Studio     │                            │                          │
 ├─────────────────────────────►│                            │                          │
 │                              │ POST /api/agents           │                          │
 │                              ├───────────────────────────►│ saves agent row          │
 │                              │◄────── {agent_id} ─────────┤                          │
 │                              │                            │                          │
 │  uploads PDF in Settings     │                            │                          │
 │  → Knowledge tab             │                            │                          │
 ├─────────────────────────────►│                            │                          │
 │                              │ POST /api/agents/{id}/knowledge (multipart)            │
 │                              ├───────────────────────────►│ proxies upload ─────────►│ POST /v1/ingest
 │                              │                            │                          │ → {job_id}
 │                              │◄────── {job_id} ───────────┤◄────────────────────────┤
 │                              │ polls job until completed ─►│ proxies poll ──────────►│
 │                              │                            │                          │ {status:"running"...}
 │                              │                            │                          │ ...
 │                              │                            │                          │ {status:"completed",
 │                              │                            │                          │   chunks:542}
 │                              │ "Ingested 542 chunks"      │                          │
 │                              │                            │                          │
 │  clicks "Generate embed link"│                            │                          │
 ├─────────────────────────────►│                            │                          │
 │                              │ POST /api/agents/{id}/embed-token                     │
 │                              ├───────────────────────────►│ mints signed token       │
 │                              │◄─── {embed_token, snippet}─┤  (allowed_origins,       │
 │                              │                            │   rate_limits)           │
 │  copies snippet              │                            │                          │
 │◄─────────────────────────────┤                            │                          │
 │                              │                            │                          │
 │  pastes into own website     │                            │                          │
 │  <script>...</script>        │                            │                          │
 │  <vocence-agent embed-token="..."></vocence-agent>                                   │
```

## 8. End-to-end public-embed flow (anonymous visitor on customer site)

```
Customer site visitor          Customer's site             dashboard-backend       (downstream pods as in §6)
       │                              │                            │
       │ visits customer site         │                            │
       ├─────────────────────────────►│                            │
       │ widget script loads          │                            │
       │ <vocence-agent embed-token="..."> mounts                  │
       │                                                            │
       │ clicks the widget launcher                                 │
       ├──── opens WS with ?token=<embed_token> ──────────────────►│
       │                                                            │
       │                            backend validates:              │
       │                              - token signature ok          │
       │                              - origin matches allowed list │
       │                              - rate limit not exceeded     │
       │                              - agent owner has credits     │
       │                                                            │
       │◄─────── ready ────────────────────────────────────────────┤
       │                                                            │
       │ ... full voice turn as in §6 ...                          │
       │                                                            │
       │                            backend bills the AGENT OWNER  │
       │                            per minute for this session    │
       │                            (not the anonymous visitor)    │
```

The widget never sees the agent owner's account. The embed_token is the only credential. From the widget's perspective, it's just a `?token=` value.

## 9. Barge-in flow (cross-cuts §6)

```
                User                    Widget               dashboard-backend         STT pod / Turn det / LLM / TTS
                  │                       │                        │                              │
agent is speaking │                       │                        │                              │
                  │  starts speaking      │                        │                              │
                  ├──────────────────────►│                        │                              │
                  │                       │ Silero VAD onSpeechStart                              │
                  │                       │                        │                              │
                  │                       │ Backchannel filter:    │                              │
                  │                       │  agent speaking + short│                              │
                  │                       │  burst? → defer 250 ms │                              │
                  │                       │                        │                              │
                  │  keeps talking        │                        │                              │
                  ├──────────────────────►│                        │                              │
                  │                       │ Speech > 400 ms → fire │                              │
                  │                       │ barge-in path:         │                              │
                  │                       │  - audioPlayer.flush() │                              │
                  │                       │    (150 ms fade + drop │                              │
                  │                       │    queue)              │                              │
                  │                       ├── {type:"cancel"} ────►│                              │
                  │                       │                        │ fan out cancel to:           │
                  │                       │                        ├── close STT WS ─────────────►│
                  │                       │                        ├── close turn-det WSs ───────►│
                  │                       │                        ├── cancel LLM stream ────────►│
                  │                       │                        └── close TTS WS ─────────────►│
                  │                       │                        │                              │
                  │                       │ then re-opens fresh:   │                              │
                  │                       │ (new voice_start) ────►│                              │
                  │                       │                        ├── open new STT WS ──────────►│
                  │                       │                        ├── open new turn-det WSs ────►│
                  │                       │                        └── waiting for transcript     │
```

The "backchannel filter" lives in the widget. The "cancel everything" fan-out lives in `dashboard-backend`. The pods just see WS closes — they don't need barge-in logic; they should clean up their own state quickly (within ~300 ms — see §4.7 in the streaming-STT spec below).

---

# Part III — Integration contracts (the parts that wire across components)

## 10. Dashboard-backend ↔ Streaming STT pod

### 10.1 Lifecycle per user turn

1. User WS sends `{type:"voice_start", sample_rate:16000, ...}` to dashboard-backend.
2. Dashboard-backend immediately opens a new WS to a streaming-STT pod (`opsApi`-style dispatch: pick a `ok` pod with available capacity).
3. Dashboard-backend sends `{type:"start", session_id, language, sample_rate:16000, encoding:"pcm_s16le", enable_partials:true, vad_events:true}` to the STT pod.
4. STT pod replies `{type:"ready", session_id, model, sample_rate:16000}`.
5. For every PCM frame the user WS forwards, dashboard-backend forwards the same bytes to the STT pod over WS binary frames.
6. STT pod streams back `{type:"partial", text, since_session_start_ms, audio_ms_consumed}` events.
7. Dashboard-backend forwards each partial to the user WS as `{type:"partial_transcript", text, audio_ms_consumed}`.
8. STT pod also fires `{type:"vad_silence", silence_ms}` and `{type:"vad_speech"}` events (it has its own internal Silero for utterance commit decisions). Dashboard-backend uses these as one of three signals for the ensembler.
9. When the ensembler decides the turn is over (see §13), dashboard-backend sends `{type:"commit"}` to the STT pod.
10. STT pod responds with `{type:"final", text, utterance_start_ms, utterance_end_ms, confidence, language_detected}`.
11. Dashboard-backend forwards `{type:"transcript", text, language}` to the user WS and proceeds to LLM/knowledge/TTS.
12. If barge-in arrives mid-turn (`{type:"cancel"}` from the user WS), dashboard-backend sends `{type:"close"}` to the STT pod and tears it down.

### 10.2 Failure modes

| Failure | Dashboard-backend response |
|---|---|
| STT pod 4429 (capacity) | Re-dispatch to another pod; if all at capacity, error `stt_busy` to user |
| STT pod connection drops mid-stream | Send `{type:"error", code:"stt_failed"}` to user, end turn |
| STT pod returns empty final | `{type:"error", code:"stt_empty"}` |
| STT timeout (no partials in 5 s with active audio) | Force `{type:"commit"}`; if still empty, `stt_failed` |

### 10.3 Pod-side responsibility

The STT pod must:
- Buffer at most 5 seconds of incoming audio internally before back-pressuring
- Close idle sessions (no activity for 60 s) with WS code 1000
- Treat dashboard-backend's `commit` as authoritative — flush hypotheses and emit `final` immediately, don't wait for its own VAD

## 11. Dashboard-backend ↔ Turn detection pod (BOTH endpoints)

### 11.1 Smart Turn (audio) endpoint

Opened simultaneously with the STT WS — both consume the same audio stream.

1. Open WS to `WS /v1/smart-turn` on a chosen turn-detection pod.
2. Send `{type:"start", sample_rate:16000, encoding:"pcm_s16le", window_ms:4000, emit_every_ms:150}`.
3. Receive `{type:"ready", ...}`.
4. For every PCM frame from the user, forward to BOTH the STT WS AND this Smart Turn WS.
5. Receive continuous `{type:"probability", p_end_of_turn, audio_ms_consumed, inference_ms}` events.
6. Optionally also receive `{type:"end_of_turn", p_end_of_turn}` when probability crosses 0.85.
7. On turn commit (decided by the ensembler), send `{type:"reset"}` if continuing the session for the next utterance, or `{type:"close"}` if barge-in / end.

### 11.2 Turn Detector (text) endpoint

Opened simultaneously with the other two. Fed by STT pod's partials.

1. Open WS to `WS /v1/turn-detector` on the same pod (or a different one — doesn't matter).
2. Send `{type:"start", history:[{role,content}*4], language}` with the last 4 turns of conversation (from the dashboard backend's per-session history).
3. Receive `{type:"ready", ...}`.
4. For every `partial` received from the STT pod, forward the cumulative `text` as `{type:"token", text:"<cumulative partial>", is_final:false}` to this WS.
5. When STT emits `final`, send `{type:"commit", content:"<final transcript>"}` and start the next utterance.
6. Receive `{type:"probability", p_end_of_turn, tokens_seen}` events as new tokens arrive.
7. Same close semantics as Smart Turn.

## 12. Dashboard-backend ↔ Knowledge ingestion service

### 12.1 Setup time (agent owner ingests sources)

Already documented in §7. Dashboard-backend proxies `POST /v1/ingest` and `GET /v1/jobs/{id}` to the knowledge service. The agent UI polls for completion.

### 12.2 Runtime (per turn, hot path)

When a turn commits and the final transcript is in hand:

1. Dashboard-backend calls `POST /v1/query` with:
   ```json
   {"agent_id": "<id>", "text": "<final transcript>", "top_k": 6, "min_score": 0.55}
   ```
2. Service responds within 80 ms p95 with:
   ```json
   {"chunks":[{"text":"...","score":0.84,"source_id":"...","source_title":"...","metadata":{...}}, ...], "total_ms": 22}
   ```
3. Dashboard-backend injects the chunks into the LLM system prompt as:
   ```
   <agent's system_prompt>
   
   Retrieved knowledge (use these as ground truth; cite source_title when relevant):
   [1] (Customer Handbook 2026, p.42) To cancel, visit Account → ...
   [2] (FAQ) Q: What's the refund policy? A: ...
   ...
   ```
4. LLM call proceeds normally.

If the agent has no knowledge sources, dashboard-backend skips the query entirely — no fallback to global knowledge.

### 12.3 Failure modes

| Failure | Response |
|---|---|
| Knowledge service down | Skip retrieval, LLM call proceeds without context, log warning |
| Empty results (all below min_score) | Skip the injection section, LLM call proceeds without context |
| Query > 200 ms | Log slow query event; still wait, the user is already waiting on LLM |

## 13. Signal ensembling — turn-end decision

This is the core integration of the three new components into one decision. Lives in `dashboard-backend/voicechat_service.py`.

### 13.1 Inputs

At any moment during a user turn, dashboard-backend has access to:

1. **Client VAD silence event**: the widget's local Silero VAD has signaled `voice_end` (the user has stopped speaking for ≥ 450 ms client-side).
2. **STT pod VAD events**: the STT pod's own internal Silero emitted `{type:"vad_silence", silence_ms:450}` (server-side; redundant signal in case the client one is missing).
3. **Smart Turn probability**: latest `p_end_of_turn` from the audio-based turn detector.
4. **Turn Detector probability**: latest `p_end_of_turn` from the text-based turn detector.
5. **STT pod's own commit signal**: optionally, the STT pod emits `final` on its own if it decides the utterance is done.

### 13.2 Decision rules (v1)

```python
def should_commit_turn(state) -> bool:
    # Rule 1: Both strong models say end-of-turn → commit immediately.
    if state.smart_turn_p > 0.85 and state.turn_detector_p > 0.85:
        return True
    
    # Rule 2: Either strong model + client VAD silence → commit.
    if state.client_vad_silence and (
        state.smart_turn_p > 0.70 or state.turn_detector_p > 0.70
    ):
        return True
    
    # Rule 3: Client VAD silence + sustained quiet (server VAD agrees) → commit
    # even without the model signals. Catches the "user mumbled something the
    # models couldn't classify but clearly stopped" case.
    if state.client_vad_silence and state.server_vad_silence_ms > 800:
        return True
    
    # Rule 4: Hard cap — if any signal is on for > 5 s of continuous silence,
    # commit no matter what.
    if state.silence_continuous_ms > 5000:
        return True
    
    return False
```

When `should_commit_turn` returns True:
1. Send `{type:"commit"}` to the STT pod.
2. Send `{type:"reset"}` to both turn-detection WSs.
3. Stop forwarding audio to the pods until the next turn starts.
4. Receive STT `final`, proceed to knowledge query + LLM.

### 13.3 Tuning

The thresholds (0.85, 0.70, 800, 5000) are starting points. Add config keys in `dashboard-backend/voicechat_service.py`:

```python
ENSEMBLE_STRONG_THRESHOLD = float(os.environ.get("VOC_ENSEMBLE_STRONG_THRESHOLD", "0.85"))
ENSEMBLE_WEAK_THRESHOLD   = float(os.environ.get("VOC_ENSEMBLE_WEAK_THRESHOLD",   "0.70"))
ENSEMBLE_VAD_SILENCE_MS   = int(os.environ.get("VOC_ENSEMBLE_VAD_SILENCE_MS",     "800"))
ENSEMBLE_HARD_CAP_MS      = int(os.environ.get("VOC_ENSEMBLE_HARD_CAP_MS",        "5000"))
```

Log every commit decision with all four signals + which rule fired. Use the data to tune.

### 13.4 What about the widget's local backchannel filter?

The widget already implements a backchannel filter (250 ms grace + 400 ms duration cutoff during agent playback — see §9 above). That kicks in BEFORE any of the server-side signals — short bursts never even send PCM to the server. So the ensembler doesn't have to worry about backchannels; they're filtered at the client.

## 14. Embed-token auth (cross-cutting)

This is the new backend-side dashboard-backend work that unblocks the widget on public sites. The widget can't ship to production until this is built.

### 14.1 Issuance

New API on dashboard-backend:

```
POST /api/dashboard/agents/{agent_id}/embed-tokens
Authorization: Bearer <agent owner JWT>

Body:
{
  "label": "docs.example.com production",
  "allowed_origins": ["docs.example.com", "*.example.com"],
  "rate_limit_per_ip_per_hour": 30,
  "max_session_minutes": 5
}

Response:
{
  "embed_token": "vet_...",
  "embed_snippet": "<script src=\"https://widget.vocence.ai/v1/widget.js\" defer></script>\n<vocence-agent agent-id=\"ag_abc123\" embed-token=\"vet_...\"></vocence-agent>"
}
```

### 14.2 Storage

New `agent_embed_tokens` table in dashboard-backend:
- `id` (uuid)
- `agent_id` (fk to `agents.id`)
- `owner_user_id` (who created it, who gets billed)
- `token_hash` (the actual token is shown once, only hash is stored)
- `label` (display string)
- `allowed_origins_json` (array)
- `rate_limit_per_ip_per_hour`
- `max_session_minutes`
- `revoked_at`
- `created_at`
- `last_used_at`

### 14.3 Validation at WS open

When dashboard-backend's voicechat WS handler sees `?token=<value>` and the value starts with `vet_`:

1. Hash the token, look up `agent_embed_tokens` row by hash.
2. Reject if `revoked_at IS NOT NULL`.
3. Read `Origin` request header. Reject if not in `allowed_origins` (with `*.example.com` wildcard handling).
4. Check rate limit: count sessions opened in the last hour from this `Origin` + remote IP. Reject if > `rate_limit_per_ip_per_hour`.
5. Verify `owner_user_id` has credits available (re-use existing billing checks).
6. Construct a synthetic session: `user_id = owner_user_id`, `is_embed_session = True`, `session_max_seconds = max_session_minutes * 60`.
7. Proceed as normal.

### 14.4 Billing

`is_embed_session` sessions bill the `owner_user_id`'s credits (the agent owner), same per-minute logic as existing paid agents. The end visitor isn't billed and isn't authenticated.

### 14.5 Public agent metadata endpoint

Required for the widget's panel header. Anonymous, no auth:

```
GET /api/dashboard/public/agents/{agent_id}
Response: {"name":"Acme Support", "avatar_url":"...", "status":"active"}
```

Only returns data if the agent has at least one non-revoked embed token. Otherwise 404. This prevents discovery scraping.

## 15. Component → backend integration summary table

| New component | What dashboard-backend needs to add to integrate it |
|---|---|
| Streaming STT pod | New `asr_streaming_rt` service type registered with ops. New WS client in `voicechat_service.py` that forwards PCM. Replace existing batch STT call. Emit `partial_transcript` to user WS. |
| Turn detection pod | New `turn_detection` service type. Two parallel WS clients per session (audio + text). Feed Smart Turn raw PCM, feed Turn Detector cumulative partials from STT. |
| Knowledge ingestion service | New `knowledge_ingestion` service type. Per-agent settings UI for upload + status polling. Per-turn `/v1/query` call. Prompt injection in LLM call. |
| Embeddable widget | New `embed_token` issuance API + table + WS-handshake validation + `is_embed_session` billing path + public agent metadata endpoint. |
| Signal ensembler | New `should_commit_turn` decision in `voicechat_service.py` (§13). |

---

# Part IV — Component specifications

> The following four sections are full self-contained specs for each component. Implementers building a single pod can read just §16 (their pod) plus §1–§15 (system context).

## 16. Streaming STT pod — `vocence/asr-streaming-rt`

### 16.1 What this is

A Docker container that exposes a streaming speech-to-text service over WebSocket. Client streams raw PCM audio frames in, receives live stream of interim and final transcripts back. Built around **NVIDIA Parakeet TDT 0.6B v3** on a single CUDA-capable GPU.

### 16.2 Model

- HuggingFace: `nvidia/parakeet-tdt-0.6b-v3` (CC-BY-4.0)
- Architecture: Token-and-Duration Transducer, ~600M params, multilingual (25 languages), native streaming
- Framework: NVIDIA NeMo (`nemo_toolkit[asr]`); pin the version
- Load at startup, pre-warm with 1 s silent buffer before flipping `/healthz` to `ready`
- Configurable via `ASR_MODEL` env var

### 16.3 Container contract

`GET /healthz`:
```json
{
  "status": "ok",
  "service": "asr-streaming-rt",
  "model": "nvidia/parakeet-tdt-0.6b-v3",
  "model_attribution": "Parakeet TDT 0.6B v3 (c) NVIDIA, CC-BY-4.0",
  "version": "0.1.0",
  "uptime_seconds": 142,
  "in_flight": 4,
  "max_concurrent_streams": 32,
  "gpu": {"name":"NVIDIA RTX 4090","vram_used_mib":18432,"vram_total_mib":24564,"utilization_pct":56}
}
```

`GET /metrics` — required counters (Prometheus text):
```
asr_requests_total{status="ok"} <int>
asr_requests_total{status="error"} <int>
asr_requests_total{status="timeout"} <int>
asr_duration_ms_sum <float>
asr_duration_ms_count <int>
asr_audio_ms_total <int>
asr_bytes_received_total <int>
asr_inflight <int>
asr_ttft_ms_sum <float>
asr_ttft_ms_count <int>
```

Auth: `X-API-Key` from env var `ASR_API_KEY`. 401 / WS close 4401 on mismatch.

### 16.4 WebSocket protocol — `/v1/stream`

**Lifecycle:** open WS → client `start` → server `ready` → binary PCM + control text → server `partial`/`final` text → client `close` → WS closes.

Client → server (JSON text):
```json
{
  "type":"start",
  "session_id":"optional-client-uuid",
  "language":"en",        // or "auto"
  "sample_rate":16000,    // must be 16000
  "encoding":"pcm_s16le",
  "enable_partials":true,
  "vad_events":false
}
```

Then binary frames: raw 16-bit signed little-endian mono PCM at 16 kHz. Recommended 320 samples (20 ms) per frame. Server must handle 80–1600 samples gracefully; larger → close 4413.

Control:
```json
{"type":"commit"}         // commit current utterance, emit final, continue session
{"type":"close"}          // end the session
{"type":"ping","ts":<ms>} // server replies {"type":"pong","ts":<echoed>}
```

Server → client:
```json
{"type":"ready", "session_id":"...", "model":"...", "language":"en", "sample_rate":16000}

{"type":"partial", "text":"what's the weather in", "since_session_start_ms":1240, "audio_ms_consumed":1280}

{"type":"final", "text":"what's the weather in San Francisco today",
 "utterance_start_ms":0, "utterance_end_ms":2340, "audio_ms_consumed":2480,
 "confidence":0.92, "language_detected":"en"}

{"type":"vad_speech", "audio_ms_consumed":240}
{"type":"vad_silence", "audio_ms_consumed":2640, "silence_ms":450}

{"type":"error", "code":"...", "message":"..."}
```

Error codes: `bad_request | unauthorized | model_overloaded | audio_format_error | internal`.

Close codes: `1000 normal | 1011 internal | 4400 bad request | 4401 unauthorized | 4413 frame too large | 4429 too many concurrent sessions`.

### 16.5 Behavior rules

- Partials may be revised by subsequent partials (transducer hypotheses change)
- `final` is permanent; after emit, internal utterance counter resets — next `partial` starts cumulative from empty
- `final` is triggered by: explicit `commit` from client, internal silence > `ASR_INTERNAL_SILENCE_MS`, or `close`
- Server may emit `partial` no faster than every `ASR_PARTIAL_INTERVAL_MS` (default 200 ms)
- Internal VAD (Silero v5, MIT, embedded) used for utterance commit decisions only; emit `vad_speech`/`vad_silence` over WS only when client requested `vad_events:true`

### 16.6 Audio format

- 16 kHz mono only (v1)
- 16-bit signed little-endian PCM
- Raw frames, no WAV header, no length prefix
- Client downsamples / downmixes; server doesn't resample

### 16.7 Config

| Env var | Default | Purpose |
|---|---|---|
| `ASR_API_KEY` | — (required) | Auth |
| `ASR_MODEL` | `nvidia/parakeet-tdt-0.6b-v3` | HF id |
| `ASR_PORT` | 8114 | Bind port |
| `ASR_MAX_CONCURRENT` | 32 | Capacity cap |
| `ASR_INTERNAL_SILENCE_MS` | 800 | Silence → auto-commit |
| `ASR_PARTIAL_INTERVAL_MS` | 200 | Min gap between partials |
| `ASR_MAX_SESSION_SECONDS` | 1800 | Hard session cap |
| `ASR_LOG_LEVEL` | info | |
| `ASR_LOG_PAYLOADS` | 0 | Privacy default off |

### 16.8 Performance targets

| Metric | Target |
|---|---|
| TTFP p95 (single client) | ≤ 400 ms |
| Partials per second during speech | ≥ 4 |
| RTF (single stream) | ≤ 0.15 |
| Concurrent streams / 4090 | ≥ 30 (TTFP p95 ≤ 600 ms at this load) |
| WER LibriSpeech test-clean | ≤ 8% |
| VRAM idle | ≤ 4 GB |
| VRAM at 30 concurrent | ≤ 22 GB |
| Cold start | ≤ 60 s |

Ship `scripts/benchmark.py` measuring all of these.

### 16.9 Resources

Min: 1 × CUDA GPU ≥ 16 GB VRAM (4090 / L4 / A10 / A100), 8 vCPU, 16 GB RAM, 50 GB disk, 1 Gbps. CUDA 12.1+, driver 535+, PyTorch 2.3+.

### 16.10 Definition of done

1. All §16.8 performance targets pass on a 4090
2. All §16.11 integration tests pass in CI
3. Reference Python + JS clients work end-to-end
4. Image `docker.io/vocence/asr-streaming-rt:v0.1.0` published
5. README documents protocol concisely with link to this spec
6. `/healthz` + `/metrics` schemas match exactly (dispatcher is field-name-sensitive)

### 16.11 Tests

Unit: protocol parsing, frame size validation, counter monotonicity.

Integration (against real container):
- Open WS, `start`, send 3 s speech fixture, receive ≥ 1 partial + 1 final, close 1000
- Bad auth → 4401
- Wrong sample rate → 4400
- Frame too large → 4413
- Concurrent cap → 4429 on (N+1)th

Fixtures: `librispeech_short.wav` (WER smoke), `silence_2s.wav`, `pure_noise_1s.wav`.

Performance: `scripts/benchmark.py` + 30-min soak at 50% capacity.

### 16.12 Repo

```
asr-streaming-rt/
├─ README.md  Dockerfile  pyproject.toml
├─ src/asr_streaming_rt/{server,ws,model,vad,metrics,healthz,config,proto}.py
├─ scripts/{benchmark,smoke_test}.py
├─ tests/{test_proto,test_ws_lifecycle,test_audio_format}.py
├─ tests/fixtures/{librispeech_short.wav,silence_2s.wav,pure_noise_1s.wav}
├─ .github/workflows/{ci,release}.yml
└─ examples/{python_client.py,js_browser_client.js}
```

## 17. Turn detection pod — `vocence/turn-detection`

### 17.1 What this is

CPU-only Docker container bundling two open-weights EOU models behind one HTTP+WS service:

1. **Pipecat Smart Turn v3** (BSD-3) — audio-in, EOU-probability-out. Reads waveform (prosody, intonation).
2. **LiveKit Turn Detector v2** (Apache 2.0, 135M SmolLM v2 fine-tune) — text-in, EOU-probability-out. Reads streaming transcript.

These are complementary; dashboard-backend ensembles them with client VAD silence (§13).

### 17.2 Models

| Model | HF id (default quantized) | Inference | Input | Output |
|---|---|---|---|---|
| Smart Turn v3 | `pipecat-ai/smart-turn-v3-quantized` | ~12 ms CPU | rolling-window 16 kHz mono PCM Float32 | p ∈ [0,1] |
| Turn Detector v2 | `livekit/turn-detector` | ~30–80 ms CPU | text — last 4 turns + in-progress transcript | p ∈ [0,1] |

Configurable via `TD_SMART_TURN_MODEL` and `TD_TURN_DETECTOR_MODEL`.

### 17.3 Container contract

`GET /healthz`:
```json
{
  "status":"ok",
  "service":"turn-detection",
  "models":{
    "smart_turn":{"name":"pipecat-ai/smart-turn-v3-quantized","loaded":true,"license":"BSD-3-Clause"},
    "turn_detector":{"name":"livekit/turn-detector","loaded":true,"license":"Apache-2.0"}
  },
  "version":"0.1.0","uptime_seconds":142,
  "in_flight":8,"max_concurrent_streams":64,
  "cpu_count":16,"ram_used_mib":982,"ram_total_mib":32000
}
```

`GET /metrics` — required (Prometheus):
```
asr_requests_total{status="ok",model="smart_turn"} <int>
asr_requests_total{status="ok",model="turn_detector"} <int>
asr_requests_total{status="error",model="smart_turn"} <int>
asr_requests_total{status="error",model="turn_detector"} <int>
asr_duration_ms_sum{model="smart_turn"} <float>
asr_duration_ms_sum{model="turn_detector"} <float>
asr_duration_ms_count{model="smart_turn"} <int>
asr_duration_ms_count{model="turn_detector"} <int>
asr_inflight <int>
asr_inflight_smart_turn <int>
asr_inflight_turn_detector <int>
```

Auth: `X-API-Key` from `TD_API_KEY`.

### 17.4 WebSocket protocol — Smart Turn `/v1/smart-turn`

Client → server start:
```json
{
  "type":"start","session_id":"...",
  "sample_rate":16000,"encoding":"pcm_s16le",
  "window_ms":4000,        // rolling buffer; 1000..8000
  "emit_every_ms":150      // min gap between probability emissions
}
```

Then binary PCM frames (same format as STT pod).

Control:
```json
{"type":"reset"}          // clear rolling buffer (new utterance)
{"type":"close"}
```

Server → client:
```json
{"type":"ready","session_id":"...","model":"pipecat-ai/smart-turn-v3-quantized","sample_rate":16000}
{"type":"probability","p_end_of_turn":0.62,"audio_ms_consumed":2480,"inference_ms":11}
{"type":"end_of_turn","p_end_of_turn":0.91,"audio_ms_consumed":2620}   // when p first crosses TD_THRESHOLD_FIRE
{"type":"error","code":"...","message":"..."}
```

### 17.5 WebSocket protocol — Turn Detector `/v1/turn-detector`

Client → server start:
```json
{
  "type":"start","session_id":"...",
  "history":[{"role":"user","content":"..."},{"role":"assistant","content":"..."}],  // up to 4
  "language":"en"
}
```

Then text token streams:
```json
{"type":"token","text":"can you tell me what time","is_final":false}
```
- `text` is CUMULATIVE in-progress transcript (not delta)

Control:
```json
{"type":"commit","content":"<final transcript>"}  // promote to history, reset in-progress
{"type":"close"}
```

Server → client:
```json
{"type":"ready","session_id":"...","model":"livekit/turn-detector","language":"en"}
{"type":"probability","p_end_of_turn":0.34,"tokens_seen":7,"inference_ms":38}
{"type":"end_of_turn","p_end_of_turn":0.93,"tokens_seen":12}
{"type":"error","code":"...","message":"..."}
```

### 17.6 Threshold semantics

`end_of_turn` fires when `p_end_of_turn` FIRST crosses `TD_THRESHOLD_FIRE` (default 0.85) since the last `reset`/`start`. Once fired, must not re-fire until `p` drops below `TD_THRESHOLD_RESET` (default 0.40) and crosses up again. Continuous `probability` stream is always available.

### 17.7 Backpressure

- Smart Turn: max 2 seconds of audio queued internally → close with `internal,backpressure`
- Turn Detector: max 50 unprocessed tokens → same
- Idle timeout: 60 s with no client message → server `close` 1000

### 17.8 REST batch endpoints (testing)

```
POST /v1/smart-turn/batch (multipart audio file)
→ {"p_end_of_turn":0.82,"audio_ms":3240,"inference_ms":14}

POST /v1/turn-detector/batch
{"history":[...],"in_progress":"what time does the store open"}
→ {"p_end_of_turn":0.71,"tokens_seen":7,"inference_ms":42}
```

### 17.9 Config

| Env var | Default | |
|---|---|---|
| `TD_API_KEY` | — required | Auth |
| `TD_PORT` | 8117 | |
| `TD_MAX_CONCURRENT` | 64 | Total across both endpoints |
| `TD_SMART_TURN_MODEL` | `pipecat-ai/smart-turn-v3-quantized` | |
| `TD_TURN_DETECTOR_MODEL` | `livekit/turn-detector` | |
| `TD_THRESHOLD_FIRE` | 0.85 | |
| `TD_THRESHOLD_RESET` | 0.40 | |
| `TD_LOG_LEVEL` | info | |
| `TD_LOG_PAYLOADS` | 0 | |

### 17.10 Performance targets

| Metric | Target |
|---|---|
| Smart Turn inference p95 | ≤ 25 ms |
| Turn Detector inference p95 | ≤ 100 ms |
| TTFP Smart Turn | ≤ 250 ms |
| TTFP Turn Detector | ≤ 200 ms |
| Concurrent sessions on 16 vCPU | ≥ 64 |
| RAM idle | ≤ 1.5 GB |
| RAM at 64 concurrent | ≤ 6 GB |
| Cold start | ≤ 30 s |

### 17.11 Resources

Min: 8 vCPU, 8 GB RAM, 20 GB disk, **no GPU**. Recommended: 16 vCPU, 16 GB RAM, NVMe.

### 17.12 Definition of done

1. All §17.10 targets pass on 16-vCPU CPU node
2. Integration tests pass in CI
3. Reference Python client demonstrates both endpoints
4. Image `docker.io/vocence/turn-detection:v0.1.0` published
5. `/healthz` + `/metrics` schemas match

### 17.13 Tests

Unit: protocol parsing, threshold hysteresis (exactly one `end_of_turn` per fire-cycle).

Integration:
- Push complete-sentence fixture audio in 20 ms frames → expect `probability` then `end_of_turn`
- Send mid-sentence partial text ("what time does") → low p
- Append completing text ("does the store close") → high p
- Auth, sample rate, frame size errors

Fixtures: `complete_sentence.wav`, `trailing_uhmm.wav`, `short_backchannel.wav`.

### 17.14 Repo

```
turn-detection/
├─ README.md  Dockerfile  pyproject.toml
├─ src/turn_detection/{server,smart_turn/{ws,model,buffer},turn_detector/{ws,model,tokenize},metrics,healthz,config}.py
├─ scripts/{benchmark,smoke}.py
├─ tests/{test_smart_turn,test_turn_detector,test_protocol}.py
├─ tests/fixtures/*.wav
└─ .github/workflows/{ci,release}.yml
```

## 18. Knowledge ingestion service — `vocence/knowledge-ingestion`

### 18.1 What this is

Per-agent RAG service. Owners attach PDF/URL/sitemap/text/markdown sources to an agent; service parses + chunks + embeds + stores in LanceDB. At runtime, dashboard-backend calls `/v1/query` per turn for top-K chunks to inject into LLM prompt.

### 18.2 Pipeline

| Source | Parser | Notes |
|---|---|---|
| PDF | `unstructured[pdf]` (hi_res ≤ 20p, fast >20p; pypdf fallback) | OCR not in v1; warn but don't fail |
| URL | `httpx` + `trafilatura` | Main-content extraction |
| Sitemap | XML parse + per-URL fetch (4 concurrent max) | include/exclude globs |
| Text/Markdown | Pass-through, HTML strip, heading metadata preserved | |

Chunker: recursive char split, 512-token target, 64-token overlap, preserve heading structure.

Embedder: `BAAI/bge-small-en-v1.5` (MIT, 384-dim, CPU-friendly). Batch 32. Configurable via `KN_EMBEDDING_MODEL`.

Store: **LanceDB** (Apache 2.0). One table per agent: `agent_<agent_id>`. Schema: `chunk_id, text, embedding, source_id, source_title, metadata_json, ingested_at`. Storage at `/data/kn/`.

### 18.3 Container contract

`GET /healthz`:
```json
{
  "status":"ok","service":"knowledge-ingestion",
  "embedding_model":"BAAI/bge-small-en-v1.5","embedding_dim":384,
  "version":"0.1.0","uptime_seconds":142,
  "in_flight_ingests":2,"queued_ingests":4,"max_concurrent_ingests":8,
  "store":{"engine":"lancedb","total_agents":142,"total_chunks":1842033,"size_mib":4820}
}
```

`GET /metrics`:
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

Auth: `X-API-Key` from `KN_API_KEY`.

### 18.4 HTTP API

**`POST /v1/ingest`** — submit one source. Multipart for PDF; JSON for everything else.

PDF (multipart): fields `source_type=pdf`, `agent_id`, `title` (opt), `file`.

JSON variants:
```json
{"source_type":"url","agent_id":"...","url":"...","title":"...","max_depth":0}
{"source_type":"sitemap","agent_id":"...","url":"...","include":["/docs/*"],"exclude":["/internal/*"],"max_pages":500}
{"source_type":"text","agent_id":"...","title":"FAQ","content":"..."}
{"source_type":"markdown","agent_id":"...","title":"Onboarding","content":"# Welcome\n..."}
```

Response (sync if text/markdown ≤ 100 KB):
```json
{"status":"completed","source_id":"src_...","chunk_count":42,"tokens_indexed":13420}
```

Response (async otherwise):
```json
{"status":"pending","job_id":"job_...","source_id":"src_..."}
```

**`GET /v1/jobs/{job_id}`**:
```json
{
  "job_id":"...","source_id":"...","agent_id":"...",
  "status":"running",         // pending|running|completed|failed
  "phase":"parsing PDF (page 17 of 240)",
  "chunks_so_far":312,
  "started_at":"...","finished_at":null,"error":null
}
```

**`GET /v1/agents/{agent_id}/sources`** — list attached sources, chunk counts, ingested_at.

**`DELETE /v1/sources/{source_id}`** — `{"deleted":true,"chunks_removed":542}`.

**`POST /v1/query`** — hot path (per turn):
```json
{"agent_id":"...","text":"how do I cancel my subscription","top_k":6,"min_score":0.55}
```
Response:
```json
{
  "chunks":[
    {"text":"...","score":0.84,"source_id":"...","source_title":"...","metadata":{"page":42,"section":"..."}},
    ...
  ],
  "embedding_ms":8,"search_ms":12,"total_ms":22
}
```

**Required: `POST /v1/query` p95 ≤ 80 ms** for ≤ 50k-chunk single-agent index.

### 18.5 Persistence

Mount `/data/kn` as persistent volume. Container refuses to start if not writable. Without the volume, restart wipes all knowledge.

### 18.6 Config

| Env var | Default | |
|---|---|---|
| `KN_API_KEY` | — required | |
| `KN_PORT` | 8118 | |
| `KN_DATA_DIR` | `/data/kn` | Persistent volume mount |
| `KN_EMBEDDING_MODEL` | `BAAI/bge-small-en-v1.5` | |
| `KN_MAX_CONCURRENT_INGESTS` | 8 | |
| `KN_MAX_SOURCE_BYTES` | 50_000_000 | 50 MB |
| `KN_MAX_PAGES_PER_SITEMAP` | 500 | |
| `KN_MAX_DEPTH` | 1 | URL crawl |
| `KN_LOG_LEVEL` | info | |

### 18.7 Performance targets

| Metric | Target |
|---|---|
| `POST /v1/query` p95 (≤50k chunks) | ≤ 80 ms |
| Embedding throughput (batch 32) | ≥ 100 chunks/sec on 8 vCPU |
| PDF ingest (240 pages) | ≤ 4 min |
| URL ingest (single page) | ≤ 8 s |
| Sitemap (100 pages) | ≤ 4 min |
| RAM idle | ≤ 800 MB |
| RAM at 8 concurrent ingests | ≤ 4 GB |

### 18.8 Resources

Min: 4 vCPU, 8 GB RAM, 50 GB disk, no GPU. Recommended: 8 vCPU, 16 GB RAM, NVMe.

### 18.9 Definition of done

1. All §18.7 targets pass
2. Integration tests pass
3. Reference Python client uploads PDF + queries it
4. Image `docker.io/vocence/knowledge-ingestion:v0.1.0` published
5. Persistent-volume requirement documented prominently in README
6. `/healthz` + `/metrics` + REST schemas match

### 18.10 Tests

Unit: chunker, URL parser (trafilatura strips nav/footer), embedding determinism, store roundtrip.

Integration:
- Submit PDF, poll job to completed, query returns relevant chunk
- Submit URL, sync text → both paths work
- Delete source → chunks gone, future queries return nothing from it
- Per-agent isolation: query agent A returns nothing about agent B's content

Performance: `scripts/benchmark.py` + 100k-chunk smoke (query p95 holds).

### 18.11 Repo

```
knowledge-ingestion/
├─ README.md  Dockerfile  pyproject.toml
├─ src/knowledge_ingestion/{server,ingest/{pdf,url,sitemap,text,chunker},embedding,store,jobs,healthz,metrics,config}.py
├─ scripts/{benchmark,smoke}.py
├─ tests/{test_chunker,test_url_parse,test_query,test_lifecycle}.py
├─ tests/fixtures/{handbook_small.pdf,docs_sitemap.xml}
└─ .github/workflows/
```

## 19. Embeddable widget — `vocence/widget` (npm `@vocence/widget`)

### 19.1 What this is

Single Web Component `<vocence-agent>` that customers embed with one `<script>` tag. Shadow DOM CSS isolation, mic + Silero VAD + audio player + barge-in all client-side, speaks the existing voicechat WS protocol (§5).

```html
<script src="https://widget.vocence.ai/v1/widget.js" defer></script>
<vocence-agent agent-id="ag_abc123" embed-token="vet_..."></vocence-agent>
```

### 19.2 Public HTML API

```html
<vocence-agent
  agent-id="ag_abc123"           [required]
  embed-token="vet_..."          [required for embed; optional with JWT in dev]
  server="https://api.vocence.ai" [default]
  theme="dark|light|auto"        [default auto]
  position="bottom-right|bottom-left|inline"  [default bottom-right]
  greeting="Hi! How can I help?"
  voice-enabled="true"           [default true]
  open-on-load="false"
></vocence-agent>
```

### 19.3 JS API

```js
const w = document.querySelector('vocence-agent');
w.open() / w.close()
w.startVoice() / w.sendText("hello")
w.addEventListener('vocence:open', e => ...)
w.addEventListener('vocence:close', e => ...)
w.addEventListener('vocence:turn', e => ... /* e.detail = {role, text} */)
w.addEventListener('vocence:error', e => ... /* e.detail = {code, message} */)
```

### 19.4 CSS custom properties

```css
vocence-agent {
  --voc-accent: #DFFF00;
  --voc-bg: #0B0D10;
  --voc-text: #FFFFFF;
  --voc-bubble-user: #DFFF00;
  --voc-bubble-agent: rgba(255,255,255,0.06);
  --voc-radius: 16px;
  --voc-font: system-ui, -apple-system, sans-serif;
  --voc-z-index: 2147483000;
}
```

### 19.5 UI surface

- **Launcher**: 56 × 56 px floating button, accent color, mic icon, 24 px margin from viewport corner
- **Panel** (expanded): 380 × 560 px desktop / full-width bottom sheet mobile (< 640 px)
- **Header**: agent name (fetched via `GET /public/agents/{id}` — see §14.5), close, mic/keyboard toggle
- **Message list**: user right, agent left, agent avatar, scroll-bottom
- **Composer**: mic button (reactive ring + state label) OR textarea + send button

States: `disconnected` → `idle` → `connecting` → `listening`/`recording`/`transcribing`/`thinking`/`speaking` → `error`. Match Vocence Studio AgentChat/AgentCall language.

### 19.6 WS protocol

Speaks the existing voicechat protocol (§5). For voice, the widget uses the streaming format (§6.1):
- `{type:"voice_start", sample_rate:16000, encoding:"pcm_s16le"}` → ready
- Binary PCM frames during speech
- `{type:"voice_end"}` when Silero local VAD signals end
- `{type:"cancel"}` for barge-in

### 19.7 Voice pipeline

Match the Vocence main app's `useVoiceChat.ts` patterns:
- Silero VAD via `@ricky0123/vad-web` (0.55/0.40 thresholds, 450 ms end silence, 250 ms min speech)
- 600 ms post-speak echo-lock
- Backchannel filter: 250 ms grace + 400 ms duration threshold during agent playback
- Audio playback with 1500 ms cold prebuffer / 80 ms filler prebuffer
- Barge-in fade-out: 150 ms gain ramp via GainNode

### 19.8 Build & distribution

- Bundler: Vite preferred. Lit (lit-element) as the Web Component framework.
- Outputs: `dist/widget.js` (IIFE, ≤120 KB gz), `dist/widget.esm.js`, `dist/widget.d.ts`, source maps
- Audio worklet inlined as string. Silero ONNX inlined via `@ricky0123/vad-web`.
- No external runtime deps after build.
- Sizes: full (with VAD) ≤ 120 KB gz; without VAD (text-only) ≤ 25 KB. Lazy-load VAD if `voice-enabled="false"`.
- npm: `@vocence/widget`. CDN: `https://widget.vocence.ai/v1/widget.js` and pinned versions.

### 19.9 Performance targets

| Metric | Target |
|---|---|
| Script tag → launcher visible | ≤ 200 ms on 3G |
| Launcher click → panel rendered | ≤ 50 ms |
| Start voice → WS connected + mic open | ≤ 800 ms |
| FID impact on host page | ≤ 50 ms |
| RAM idle (closed) | ≤ 5 MB |
| RAM active voice session | ≤ 40 MB |

### 19.10 Browsers

Chrome / Edge / Safari / Firefox last 2 versions. iOS Safari 16+. Graceful degrade to text-only on unsupported.

### 19.11 Privacy

- No `getUserMedia` until user clicks mic
- One-time consent line on first voice activation per origin
- No cookies on host page; `sessionStorage` only
- No third-party calls

### 19.12 Definition of done

1. All §19.9 performance targets pass on Lighthouse desktop + mobile
2. Integration tests (Playwright) pass
3. Examples work end-to-end against real dev backend with JWT or embed token
4. Published `@vocence/widget@0.1.0`
5. Bundle size ≤ 120 KB gz enforced in CI
6. Works on iPhone Safari 16+, Chrome desktop, Firefox desktop in manual smoke
7. README documents: minimal embed, theming, JS API, mobile, embed_token dependency

### 19.13 Repo

```
widget/
├─ README.md  package.json  tsconfig.json  vite.config.ts
├─ src/
│  ├─ index.ts component.ts panel.ts launcher.ts
│  ├─ session/{ws,player,recorder,vad}.ts
│  ├─ ui/{styles,icons,state-label}.ts
│  └─ proto.ts
├─ examples/{minimal.html,themed.html,programmatic.html,react-wrapper.tsx}
└─ .github/workflows/{ci,release}.yml
```

---

# Part V — Implementation order, parallelism, ownership

## 20. Dependency graph

```
                  (no deps)                       (no deps)                      (depends on streaming STT
                       │                              │                            for real-world test —
                       ▼                              ▼                            in dev, mock the partials)
              ┌─────────────────┐           ┌──────────────────┐         ┌──────────────────────┐
              │ Streaming STT   │           │ Knowledge        │         │ Turn detection pod   │
              │ pod             │           │ ingestion        │         │ (Smart Turn + LiveKit)│
              │ (this spec §16) │           │ (§18)            │         │ (§17)                │
              └────────┬────────┘           └────────┬─────────┘         └────────┬─────────────┘
                       │                             │                            │
                       └────────────────┬────────────┴────────────────────────────┘
                                        ▼
                       ┌────────────────────────────────────────────┐
                       │ dashboard-backend integration:             │
                       │  - register service types                  │
                       │  - voicechat_service.py: streaming path,   │
                       │    signal ensembler, knowledge query,      │
                       │    embed_token validation                  │
                       │  - agent settings: knowledge upload UI,    │
                       │    embed_token issuance UI                 │
                       └────────────────┬───────────────────────────┘
                                        ▼
                       ┌────────────────────────────────────────────┐
                       │ Widget (§19)                               │
                       │  - depends on embed_token endpoint in      │
                       │    dashboard-backend                       │
                       │  - dev with JWT, prod with embed_token     │
                       └────────────────────────────────────────────┘
```

## 21. Suggested split between agents

**Other agent (RTX 4090 available, can run real models):**
- Streaming STT pod (§16)
- Turn detection pod (§17)
- Knowledge ingestion service (§18)
- Embeddable widget (§19) — last, since it benefits from real-browser validation

**This agent (Vocence repo context):**
- dashboard-backend integration: register new pod service types in `ops` schemas, write the dispatcher wiring
- `voicechat_service.py` modifications: streaming PCM input handling, 3-way WS fan-out, signal ensembler, knowledge retrieval injection
- Agent settings UI: knowledge upload + ingest job polling + sources list
- Embed token issuance: API + storage + Studio UI
- Embed-session billing path
- Public agent metadata endpoint
- Frontend: render `partial_transcript` as live caption in AgentChat/AgentCall

The two streams of work can run in parallel until the very end. Final integration test is end-to-end against deployed pods.

## 22. What blocks what

| If you're building... | You're blocked by... | You're NOT blocked by |
|---|---|---|
| Streaming STT pod | Nothing | All other pods, dashboard-backend |
| Turn detection pod | Nothing (mock audio + text in tests) | All other pods, dashboard-backend |
| Knowledge service | Nothing | All other pods, dashboard-backend |
| Widget | Embed-token endpoint in dashboard-backend (for prod); for dev, use JWT | The 3 pods (widget speaks the voicechat WS, not the pods directly) |
| dashboard-backend integration | The 3 pods (need real `/healthz` to register; can mock for early dev) | Widget (independent) |

## 23. Cross-team coordination checkpoints

Before final integration, the implementing engineer needs answers on these from the Vocence team. Flag them early.

| # | Question | Why it matters |
|---|---|---|
| 1 | Image name `vocence/asr-streaming-rt` is OK? (vs existing `vocence/asr-streaming`) | Avoid registry confusion |
| 2 | Port assignments: 8114 / 8117 / 8118 — confirmed? | Ops dispatcher binds these |
| 3 | Model license attribution in `/healthz` `model_attribution` — sufficient legally? | Parakeet TDT is CC-BY-4.0 |
| 4 | Multilingual default for Parakeet — confirmed? | English-only is faster but limits product |
| 5 | Model storage: bake into image (~6 GB image) vs download to volume on first start? | Trade-off cold-start vs node disk |
| 6 | Quantised vs full models for Smart Turn / LiveKit — confirmed? | RAM footprint impact |
| 7 | Ensembler thresholds (0.85 / 0.70 / 800 ms / 5 s) | Will tune in integration |
| 8 | LanceDB persistent volume strategy | Operator must mount; document loudly |
| 9 | Knowledge embedding model default `bge-small-en-v1.5` (English-leaning) vs `bge-m3` (multilingual) | Customer use cases |
| 10 | Source upload limits 50 MB / 500 pages / depth 1 — appropriate? | Adjust if needed |
| 11 | CDN host `widget.vocence.ai` set up by Vocence ops? | Widget can publish to npm without, can't fully ship without |
| 12 | Embed-token endpoint timeline | Widget blocked on prod until this lands |

## 24. Glossary

| Term | Definition |
|---|---|
| **Agent** | A configured Vocence voice persona — name, system prompt, voice, optional knowledge, optional embed_token |
| **dashboard-backend** | The existing Vocence FastAPI service. Owns user-facing WS, billing, ops dispatcher. Not part of any new spec — extended by integration work. |
| **Embed token** | Signed token an agent owner generates from Studio; lets anonymous visitors on a customer site use the agent. Sessions billed to the owner. |
| **EOU** | End-of-utterance. The signal that decides "the user is done; time to respond." |
| **Ops dispatcher** | The existing component in `dashboard-backend` that load-balances WS sessions across pod instances of the same service type. |
| **Pod** | A Vocence service running as a Docker container, registered with the ops dispatcher, exposing `/healthz`, `/metrics`, and one or more service endpoints. |
| **Smart Turn** | Pipecat's open-weights audio-based EOU model. Reads raw waveform. |
| **Studio** | The Vocence signed-in user UI. Where agent owners configure agents and test them. |
| **TTFP** | Time to first partial. Latency from audio start to first transcript snippet. |
| **Turn Detector** | LiveKit's open-weights text-based EOU model. Reads streaming transcript. |
| **Voicechat WS protocol** | The existing WebSocket message format the Studio and widget use to talk to dashboard-backend (§5). |
| **Widget** | The `<vocence-agent>` Web Component. Customer-embeddable. |

---

## 25. Quick references

### 25.1 New pod ports

| Port | Service |
|---|---|
| 8114 | `asr-streaming-rt` (Streaming STT) |
| 8117 | `turn-detection` |
| 8118 | `knowledge-ingestion` |

### 25.2 New Vocence ops service types

`asr_streaming_rt`, `turn_detection`, `knowledge_ingestion` — register these in `app/src/lib/ops/types.ts` `ServiceName` union and the backend dispatcher.

### 25.3 New env vars by pod

| Pod | Required | Optional defaults |
|---|---|---|
| Streaming STT | `ASR_API_KEY` | `ASR_MODEL`, `ASR_PORT=8114`, `ASR_MAX_CONCURRENT=32`, `ASR_INTERNAL_SILENCE_MS=800`, `ASR_PARTIAL_INTERVAL_MS=200`, `ASR_MAX_SESSION_SECONDS=1800`, `ASR_LOG_LEVEL=info`, `ASR_LOG_PAYLOADS=0` |
| Turn detection | `TD_API_KEY` | `TD_PORT=8117`, `TD_MAX_CONCURRENT=64`, `TD_SMART_TURN_MODEL`, `TD_TURN_DETECTOR_MODEL`, `TD_THRESHOLD_FIRE=0.85`, `TD_THRESHOLD_RESET=0.40`, `TD_LOG_LEVEL=info`, `TD_LOG_PAYLOADS=0` |
| Knowledge | `KN_API_KEY` | `KN_PORT=8118`, `KN_DATA_DIR=/data/kn`, `KN_EMBEDDING_MODEL`, `KN_MAX_CONCURRENT_INGESTS=8`, `KN_MAX_SOURCE_BYTES=50_000_000`, `KN_MAX_PAGES_PER_SITEMAP=500`, `KN_MAX_DEPTH=1`, `KN_LOG_LEVEL=info` |

### 25.4 New backend env vars (dashboard-backend, for ensembler tuning)

```
VOC_ENSEMBLE_STRONG_THRESHOLD=0.85
VOC_ENSEMBLE_WEAK_THRESHOLD=0.70
VOC_ENSEMBLE_VAD_SILENCE_MS=800
VOC_ENSEMBLE_HARD_CAP_MS=5000
```

### 25.5 Documents this replaces

The standalone spec files that previously covered these subsystems have been
removed in favor of this consolidated document. Their content lives in the
sections noted below:
- streaming STT → §16 (was `STREAMING_STT_SPEC.md`)
- turn detection → §17 (was `TURN_DETECTION_SPEC.md`)
- knowledge ingestion → §18 (was `KNOWLEDGE_INGESTION_SPEC.md`)
- embeddable widget → §19 (was `EMBEDDABLE_WIDGET_SPEC.md`)

This file is the source of truth.

---

*End of system spec.*
