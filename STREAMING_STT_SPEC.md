# Vocence Streaming STT Pod — Implementation Spec

**Repo to build:** `vocence/asr-streaming-rt` (a new GitHub repo, separate from the existing batch `asr-streaming`)
**Audience:** an implementing engineer/agent with no Vocence-codebase access — this document is self-contained.

---

## 1. What this is

A self-hostable Docker container that exposes a **streaming speech-to-text service over WebSocket**. The client opens a WS, streams raw PCM audio frames in, and receives a live stream of interim and final transcripts back. The container is built around **NVIDIA Parakeet TDT 0.6B v3** running on a single CUDA-capable GPU.

It will be deployed as one more pod type in the existing Vocence ops fleet, alongside the current batch STT, TTS, voice-clone, etc. pods.

### Why this exists

The current Vocence STT pod is **batch only**: it takes a complete WAV/Opus blob over HTTP POST and returns the full transcript when STT finishes. For voice-agent conversations that pattern adds ~1–3 seconds of dead air after every user utterance because the LLM can't start until the user has fully stopped *and* the round-trip STT completes.

A streaming STT pod fixes this: the LLM and the semantic turn-detection layer both start seeing words as the user speaks, not after.

---

## 2. Scope

### In scope
- A Docker image runnable on a single GPU (RTX 4090 / L4 / A10 class)
- WebSocket server that accepts streaming PCM audio
- Real-time emission of interim ("partial") and finalized ("final") transcripts
- Standard Vocence ops contract: `/healthz`, `/metrics`, `X-API-Key` auth, structured error responses
- Multi-language support (Parakeet TDT v3 covers ~25 languages — surface this as a per-session option)
- Concurrent session handling on one GPU (target: ≥30 concurrent streams per RTX 4090)

### Explicitly out of scope (do NOT include)
- VAD (the client handles client-side VAD; if you want server-side VAD as a *signal*, see §5.5, but it is not the turn-end authority)
- Semantic turn detection / end-of-utterance prediction (a separate component consumes the transcript stream from this pod)
- LLM, TTS, audio playback
- Speaker diarization (multi-speaker labelling) — single-speaker is fine for v1
- Translation
- Punctuation / capitalisation post-processing beyond what Parakeet provides natively
- Word-level timestamps in v1 (nice to have; explicit non-goal until the protocol is stable)

---

## 3. Model

### Required model
**NVIDIA Parakeet TDT 0.6B v3** — `nvidia/parakeet-tdt-0.6b-v3` on HuggingFace.

- Architecture: Token-and-Duration Transducer (TDT)
- ~600M parameters
- Multilingual (25 languages)
- Native streaming support (chunked inference)
- License: CC-BY-4.0 (commercial-OK with attribution; attribute in the container's `/healthz` JSON `model_attribution` field)

### Model loading
- Load once at container startup. Do not lazy-load per request.
- Use NVIDIA NeMo (`nemo_toolkit[asr]`) as the inference framework — that's the path the Parakeet authors maintain and benchmark.
- Pin the NeMo version; do not float on `latest`.
- Pre-warm with a 1-second silent audio buffer at startup before flipping `/healthz` to `ready`. A cold first request shouldn't pay model-compile latency.

### Configurable model variants
The image should accept an env var `ASR_MODEL` defaulting to `nvidia/parakeet-tdt-0.6b-v3`. Operators may override (e.g. to use a smaller variant on cheaper hardware, or a fine-tune later). The runtime must still expose the resolved model name in `/healthz`.

---

## 4. Container contract

Every Vocence ops pod follows the same three-endpoint contract. The new pod must conform exactly.

### 4.1 `GET /healthz`

Used by the operator's health poller (every ~10 s). Return JSON.

**Response — ready state:**
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
  "gpu": {
    "name": "NVIDIA GeForce RTX 4090",
    "vram_used_mib": 18432,
    "vram_total_mib": 24564,
    "utilization_pct": 56
  },
  "started_at": "2026-05-29T13:22:01Z"
}
```

**Response — degraded / warming:**
```json
{
  "status": "warming",
  "service": "asr-streaming-rt",
  "model": "nvidia/parakeet-tdt-0.6b-v3",
  "uptime_seconds": 4,
  "in_flight": 0
}
```

`status` is one of: `ok` | `warming` | `degraded` | `error`. Anything other than `ok` causes the dispatcher to stop sending new sessions to this pod.

HTTP code is always 200 unless the process is genuinely broken — the dispatcher reads the `status` field, not the HTTP code.

### 4.2 `GET /metrics`

Prometheus-style plaintext (`text/plain; version=0.0.4`). The dispatcher scrapes this every ~30 s and rolls into the operator's per-minute time series. The pod must publish **monotonic counters** for these names exactly (the operator's metrics poller is name-sensitive):

```
# HELP asr_requests_total Total streaming sessions accepted (success + error)
# TYPE asr_requests_total counter
asr_requests_total{status="ok"} 1284
asr_requests_total{status="error"} 7
asr_requests_total{status="timeout"} 2

# HELP asr_duration_ms_sum Sum of end-to-end session durations in milliseconds
# TYPE asr_duration_ms_sum counter
asr_duration_ms_sum 8420134

# HELP asr_duration_ms_count Number of completed sessions (matches asr_requests_total{status="ok"})
# TYPE asr_duration_ms_count counter
asr_duration_ms_count 1284

# HELP asr_audio_ms_total Total milliseconds of audio transcribed
# TYPE asr_audio_ms_total counter
asr_audio_ms_total 19402100

# HELP asr_bytes_received_total Total bytes received over WS audio frames
# TYPE asr_bytes_received_total counter
asr_bytes_received_total 1294831020

# HELP asr_inflight Current open streaming sessions
# TYPE asr_inflight gauge
asr_inflight 4

# HELP asr_ttft_ms_sum Sum of time-to-first-partial across sessions (ms)
# TYPE asr_ttft_ms_sum counter
asr_ttft_ms_sum 412034

# HELP asr_ttft_ms_count Number of sessions that emitted at least one partial
# TYPE asr_ttft_ms_count counter
asr_ttft_ms_count 1284
```

Counters must never decrement. On container restart they reset — the dispatcher handles that.

### 4.3 `WS /v1/stream`

The streaming endpoint. See §5 for the full protocol.

### 4.4 Auth

A single API key gates everything. Required header on every request (HTTP and WS upgrade):

```
X-API-Key: <key>
```

The key is provided at container startup via env var `ASR_API_KEY`. If unset, the container refuses to start (no anonymous mode).

Missing or wrong key:
- HTTP requests → `401 {"error":"unauthorized"}`
- WS upgrade → close with code `4401` and reason `unauthorized` before completing the handshake

---

## 5. WebSocket protocol — `/v1/stream`

### 5.1 Lifecycle

1. Client opens `WS /v1/stream` with `X-API-Key` header
2. Server accepts the handshake
3. Client sends one `start` JSON message (text frame)
4. Server replies with one `ready` JSON message
5. Client sends a stream of **binary audio frames** (raw PCM, see §6) interleaved with optional control messages
6. Server sends a stream of `partial` / `final` / optional `vad_silence` JSON messages back (text frames)
7. Either side sends `close` JSON, or the WS is closed normally → server flushes any pending final transcript and closes

### 5.2 Message types — client → server (all JSON, text frames)

**`start` (required, exactly once, first message)**
```json
{
  "type": "start",
  "session_id": "optional-client-supplied-uuid",
  "language": "en",
  "sample_rate": 16000,
  "encoding": "pcm_s16le",
  "enable_partials": true,
  "vad_events": false,
  "metadata": {
    "user_id": "opaque to server, echoed in logs",
    "agent_id": "..."
  }
}
```
- `language`: ISO-639-1 code or `"auto"` for auto-detect. Default `"auto"`.
- `sample_rate`: must be 16000. Other rates → close with code `4400`.
- `encoding`: must be `"pcm_s16le"` (16-bit little-endian signed mono). Other values → close with code `4400`.
- `enable_partials`: default `true`. If `false`, server emits only `final` messages.
- `vad_events`: default `false`. If `true`, server emits `vad_silence` and `vad_speech` events as advisory signals (see §5.5).
- `metadata`: opaque map, server echoes to logs only.

**Binary audio frame (after `ready`, before `close`)**
- WS binary frame
- Body: raw 16-bit signed little-endian mono PCM at the declared sample rate
- Recommended frame size: 320 samples = 20 ms at 16 kHz (small enough for fast partials, large enough to not flood the WS)
- Server MUST handle any frame size 80–1600 samples (5 ms to 100 ms) gracefully
- Frames larger than 1600 samples → close with code `4413`

**`commit` (optional)**
```json
{"type": "commit"}
```
Tells the server "treat what I've sent as one finished utterance, emit the final transcript now, then continue receiving more audio in the same session for the next utterance." Useful for client-driven turn endings (e.g., push-to-talk).

**`close` (optional)**
```json
{"type": "close"}
```
Tells the server the session is over. Server flushes any pending final, sends a terminal `final` (if any partial was unflushed), and closes the WS.

**`ping` (optional)**
```json
{"type": "ping", "ts": 1748528521234}
```
Server replies with `{"type":"pong","ts":<echoed>}`. Used by clients behind buggy WS proxies to keep idle connections alive.

### 5.3 Message types — server → client (all JSON, text frames)

**`ready` (sent once after `start` accepted)**
```json
{
  "type": "ready",
  "session_id": "server-assigned-or-client-supplied",
  "model": "nvidia/parakeet-tdt-0.6b-v3",
  "language": "en",
  "sample_rate": 16000
}
```

**`partial` (interim transcript, emitted continuously)**
```json
{
  "type": "partial",
  "text": "what's the weather in",
  "since_session_start_ms": 1240,
  "audio_ms_consumed": 1280
}
```
- Cumulative text from the start of the current utterance (not since session start — utterance is reset by `commit` or by a long silence the server's internal VAD detects)
- May be replaced/refined by subsequent partials (transducer hypotheses change as more audio arrives)
- Frequency: target ≤ every 200 ms

**`final` (committed transcript for one utterance)**
```json
{
  "type": "final",
  "text": "what's the weather in San Francisco today",
  "utterance_start_ms": 0,
  "utterance_end_ms": 2340,
  "audio_ms_consumed": 2480,
  "confidence": 0.92,
  "language_detected": "en"
}
```
- Emitted when the server decides the current utterance is committed. This happens on:
  - Client `commit`
  - Long internal silence (configurable, default 800 ms)
  - Client `close`
- After a `final`, the utterance counter resets — subsequent `partial` text starts from empty again
- `text` is final and will not be revised

**`vad_speech` / `vad_silence` (optional, only if `vad_events: true`)**
```json
{"type": "vad_speech", "audio_ms_consumed": 240}
{"type": "vad_silence", "audio_ms_consumed": 2640, "silence_ms": 450}
```
Advisory only — the *authoritative* turn-end signal is the consuming application's responsibility. These exist so a downstream turn-detector model can fuse them with its own signals.

**`error`**
```json
{
  "type": "error",
  "code": "model_overloaded",
  "message": "too many concurrent sessions; retry"
}
```
Standard codes: `bad_request` | `unauthorized` | `model_overloaded` | `audio_format_error` | `internal`. After an `error`, the server closes the WS.

**`pong`** — reply to client `ping`.

### 5.4 Backpressure

- The server SHOULD apply WebSocket-level backpressure when the consumer is slow. The client must respect TCP/WS backpressure (i.e., not buffer unbounded audio).
- If the server's internal queue exceeds 5 seconds of audio, it must drop the session with `code=internal, message="client too slow; backpressure"` rather than OOMing.
- If the client stops sending audio for > 60 seconds without `commit`/`close`, the server may close with code `1000` (normal) after emitting a final flush.

### 5.5 Server-side VAD (advisory)

The pod MAY include a lightweight server-side VAD (Silero v5 is fine — it's MIT and standard) to detect silence boundaries for **internal utterance commit** decisions. This is NOT the application's turn-end signal — it's the pod's own "should I commit this hypothesis as a final transcript now?" trigger.

When `vad_events: true`, the pod surfaces these decisions via `vad_speech` / `vad_silence` messages so downstream consumers (e.g., a turn-detector) can use them as an additional input. When `vad_events: false`, the events are still used internally to drive `final` emission but are not surfaced over the wire.

### 5.6 Close codes

| Code | Meaning |
|---|---|
| 1000 | Normal closure (either side `close` message) |
| 1011 | Internal server error |
| 4400 | Bad request (invalid `start`, wrong sample rate, etc.) |
| 4401 | Unauthorized (bad/missing `X-API-Key`) |
| 4413 | Audio frame too large |
| 4429 | Too many concurrent sessions (pod at `max_concurrent_streams`) |

---

## 6. Audio format

- **Sample rate:** 16 kHz only (v1)
- **Channels:** mono only
- **Encoding:** 16-bit signed little-endian PCM (`pcm_s16le`)
- **Endianness:** little-endian (no native byte-order detection — clients send little-endian or it's broken)
- **No headers:** the audio frames are raw PCM samples. No RIFF / WAV header. No length prefix. The WS binary frame length determines the sample count (`frame_bytes / 2`).

The client is responsible for any resampling (downmix to mono, downsample to 16 kHz from 48 kHz mic capture, etc.). The server rejects non-conforming formats; it does not resample.

---

## 7. Configuration (env vars)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ASR_API_KEY` | **Yes** | — | Shared secret for the `X-API-Key` header. No default; container refuses to start. |
| `ASR_MODEL` | No | `nvidia/parakeet-tdt-0.6b-v3` | HuggingFace model id |
| `ASR_PORT` | No | `8114` | HTTP+WS port to bind |
| `ASR_MAX_CONCURRENT` | No | `32` | Concurrency cap. Surface in `/healthz` `max_concurrent_streams`. Excess sessions → close 4429. |
| `ASR_INTERNAL_SILENCE_MS` | No | `800` | Silence (per server-internal VAD) before emitting a `final` automatically |
| `ASR_PARTIAL_INTERVAL_MS` | No | `200` | Minimum gap between consecutive partials per session |
| `ASR_MAX_SESSION_SECONDS` | No | `1800` | Hard cap on a single session (30 min). Force-close after. |
| `ASR_LOG_LEVEL` | No | `info` | One of `debug` / `info` / `warn` / `error` |
| `ASR_LOG_PAYLOADS` | No | `0` | If `1`, log transcript text. Default off for privacy. |

---

## 8. Performance targets

These are acceptance criteria. Don't ship if any are missed.

| Metric | Target | Measured on |
|---|---|---|
| **Time to first partial (TTFP) p95** | ≤ 400 ms after first audio frame | Single client, idle pod |
| **Partial cadence** | ≥ 4 partials/sec while user is speaking | Single client, continuous speech |
| **Real-time factor (RTF)** | ≤ 0.15 | Single stream — i.e. pod processes 1 s of audio in ≤ 150 ms |
| **Concurrent streams per RTX 4090** | ≥ 30 (with TTFP p95 still ≤ 600 ms at this load) | Synthetic load test |
| **WER on LibriSpeech test-clean (English)** | ≤ 8% | NeMo's eval script, no LM rescoring |
| **VRAM footprint at idle (model loaded)** | ≤ 4 GB | `nvidia-smi`, no active sessions |
| **VRAM footprint at 30 concurrent streams** | ≤ 22 GB on a 24 GB card | `nvidia-smi`, peak |
| **Cold start (container start → /healthz returns `ok`)** | ≤ 60 s | Image already pulled |

Include a `scripts/benchmark.py` in the repo that reports all of the above against a running pod.

---

## 9. Resource requirements

### Minimum hardware
- 1 × CUDA-capable GPU, ≥ 16 GB VRAM (RTX 4090, L4, A10, A100)
- 8 vCPU
- 16 GB RAM
- 50 GB disk (model weights ~3 GB; logs/temp)
- 1 Gbps network (mostly for inbound audio: 32 kB/s × 32 streams ≈ 1 MB/s)

### Recommended for production
- RTX 4090 (24 GB) — cheapest VRAM-per-stream ratio
- 16 vCPU, 32 GB RAM
- NVMe disk for fast model load

### CUDA / driver requirements
- CUDA 12.1+
- Driver 535+
- PyTorch 2.3+ (whatever the pinned NeMo version requires)

---

## 10. Build & release

### Image registry
`docker.io/vocence/asr-streaming-rt:<tag>`

Tags:
- `latest` — most recent stable
- `v0.1.0`, `v0.1.1`, … — semver pinned releases
- `dev-<sha>` — CI builds from `main`

### Dockerfile expectations
- Base image: `nvidia/cuda:12.1.1-runtime-ubuntu22.04` or the NeMo-recommended base for the pinned NeMo version
- Multi-stage build that does NOT ship build tools (`gcc`, `cmake`) in the final layer
- Final image size target: ≤ 8 GB (including model weights). Above 12 GB is a smell — investigate before shipping.
- Model weights baked into the image at build time (no per-start HuggingFace download). Use `huggingface_hub.snapshot_download` in a build step.
- Healthcheck:
  ```dockerfile
  HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
    CMD curl -fsS http://localhost:$ASR_PORT/healthz | grep -q '"status":"ok"'
  ```

### CI / release workflow
- GitHub Actions
- On push to `main`: lint, type-check, unit tests, integration test against a running container (use a tiny sample WAV), build + push `dev-<sha>`
- On tag `v*`: same, plus build + push `v*` and `latest`

---

## 11. Suggested repo structure

```
asr-streaming-rt/
├─ README.md                # quickstart + protocol summary
├─ Dockerfile
├─ pyproject.toml           # pinned deps
├─ src/
│  ├─ asr_streaming_rt/
│  │  ├─ __init__.py
│  │  ├─ server.py          # FastAPI app entrypoint
│  │  ├─ ws.py              # WebSocket session handler
│  │  ├─ model.py           # NeMo model wrapper, batching, GPU streams
│  │  ├─ vad.py             # internal Silero VAD for utterance commit
│  │  ├─ metrics.py         # Prometheus counters
│  │  ├─ healthz.py         # /healthz endpoint
│  │  ├─ config.py          # env var loading + validation
│  │  └─ proto.py           # JSON schema for messages
├─ scripts/
│  ├─ benchmark.py          # §8 acceptance test script
│  └─ smoke_test.py         # one-WAV smoke test
├─ tests/
│  ├─ test_proto.py
│  ├─ test_ws_lifecycle.py
│  └─ test_audio_format.py
├─ .github/workflows/
│  ├─ ci.yml
│  └─ release.yml
└─ examples/
   ├─ python_client.py      # reference client
   └─ js_browser_client.js  # browser reference (raw WS, no library)
```

---

## 12. Test plan

### Unit tests
- Protocol message parsing — every valid + invalid `start` shape
- Audio frame size validation
- Counter monotonicity

### Integration tests (run in CI against a real container)
- Open WS, send `start`, send 3 s of speech (a fixture WAV), receive ≥ 1 partial and 1 final, close cleanly. Assert close code 1000.
- Bad auth → 4401
- Wrong sample rate → 4400
- Frame too large → 4413
- Concurrent session cap → 4429 on the (N+1)th session, then 4429 clears once one closes

### Performance tests (not in CI; run before each release)
- `scripts/benchmark.py` — must pass all targets in §8
- 30-minute soak at 50% capacity. No VRAM growth, no descriptor leak.

### Reference fixtures
Include `tests/fixtures/` with 3 short WAVs:
- `librispeech_short.wav` — 3 s English, known transcript, used for WER smoke
- `silence_2s.wav` — pure silence, must produce empty transcript and clean close
- `pure_noise_1s.wav` — pink noise, must produce empty or near-empty transcript

---

## 13. Things the implementing engineer should explicitly check with the Vocence team before writing them

1. **Image name collision.** The Vocence ops fleet has an existing `vocence/asr-streaming` image (a batch service). To avoid confusion, this new image is `vocence/asr-streaming-rt`. Confirm before naming the repo.
2. **Default port.** §7 suggests `8114`. The existing batch STT also uses `8114`. The two pod types are separate services and will not co-locate on the same host, so this collision is fine — but call it out if for some reason both need to run on one box.
3. **License attribution.** Parakeet TDT is CC-BY-4.0 — attribution must be surfaced *somewhere* visible. We're surfacing it in `/healthz` `model_attribution`. Confirm that's sufficient legally on the Vocence side, or whether we need it in the API docs too.
4. **Multilingual default.** Parakeet v3 supports 25 languages but English-only fine-tunes are smaller / faster. We default to the multilingual model. Confirm that's what we want — otherwise we should pick a per-deployment env override.
5. **Model storage.** Baking the weights into the image makes the image ~6 GB. Alternative: download at first start to a persistent volume. Faster cold-start for image-pull cache hits, but slower for cold container starts on a fresh node. Confirm the trade-off.

---

## 14. Out of scope for v1 — future considerations

These are explicitly *not* part of v1 but worth keeping in mind for the protocol:

- **Word-level timestamps** (would extend `final` with a `words: [{w, start_ms, end_ms, conf}]` array). NeMo provides this; we just don't expose it yet.
- **Speaker diarization** (multi-speaker labelling).
- **On-the-fly language switching** mid-session.
- **Custom vocabulary boost / biasing** for product names, brand terms.
- **Streaming punctuation/restoration** as a separate post-processor.
- **gRPC interface** as an alternative to WebSocket for service-mesh deployments.

If you design the protocol with these in mind (e.g., extra optional fields rather than hard-baked schemas), v2 is additive rather than breaking.

---

## 15. Quick start (for the implementing engineer)

```bash
# 1. Build
docker build -t vocence/asr-streaming-rt:dev .

# 2. Run with a 4090
docker run --rm --gpus all -p 8114:8114 \
  -e ASR_API_KEY=test_key_local_only \
  vocence/asr-streaming-rt:dev

# 3. Smoke test
python scripts/smoke_test.py \
  --url ws://localhost:8114/v1/stream \
  --api-key test_key_local_only \
  --wav tests/fixtures/librispeech_short.wav
```

Expected output: at least one `partial`, one `final` with the known transcript text, clean close.

---

## 16. Definition of done

The pod is shippable to production when:
1. All §8 performance targets pass on a 4090
2. All §12 integration tests pass in CI
3. The reference Python and JS clients in `examples/` work end-to-end
4. The image is published to `docker.io/vocence/asr-streaming-rt:v0.1.0`
5. The README on the repo links this spec and documents the protocol concisely
6. The `/healthz` and `/metrics` schemas match this document exactly (the Vocence dispatcher is field-name-sensitive)

Once all six are green, the integration on the Vocence dashboard-backend side is small: register the new service type, wire a backend-side WS client to forward user audio frames to a chosen pod, and pipe partials/finals back into the existing voicechat WS protocol. That work happens in parallel and does not block this pod.
