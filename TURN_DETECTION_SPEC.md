# Vocence Turn-Detection Pod — Implementation Spec

**Repo to build:** `vocence/turn-detection`
**Audience:** an implementing engineer/agent with no Vocence-codebase access — this document is self-contained.

---

## 1. What this is

A Docker container that bundles **two open-weights end-of-utterance models** behind one HTTP+WebSocket service:

1. **Pipecat Smart Turn v3** — audio-in, end-of-turn-probability-out. Reads the raw waveform (prosody, intonation, breath) to predict whether a user has finished speaking.
2. **LiveKit Turn Detector v2** — text-in, end-of-turn-probability-out. Reads streaming transcript tokens (135M-param SmolLM v2 fine-tune) to predict the same thing from the *content* of what was said.

These models are complementary: audio catches "rising intonation = still talking", text catches "*'My address is twenty-two'* = mid-sentence." Combining both signals is what makes OpenAI Realtime's Semantic VAD / ElevenLabs Conv AI 2.0 feel like talking to a person instead of an IVR. We replicate that with open weights.

The pod consumes streams of audio frames and/or transcript tokens, emits a continuous probability that the current utterance is complete, and lets the dashboard backend decide when to commit a turn.

---

## 2. Why this exists

The current Vocence voice agent uses fixed-time silence-timeout endpointing (450 ms). Industry data (LiveKit, May 2026) shows model-based EOU detection cuts wrong-end-of-turn detections by ~39% vs silence-timer endpointing, at a cost of 100–200 ms latency.

This pod is the open-source replacement. It plugs into the existing Vocence voicechat WebSocket flow alongside the new streaming-STT pod (`vocence/asr-streaming-rt`) and the existing client-side Silero VAD. The three signals together — VAD silence, Smart Turn audio EOU probability, LiveKit text EOU probability — are ensembled by the dashboard backend to make the actual turn-end decision.

---

## 3. Scope

### In scope
- Single Docker image runnable on **CPU only** (no GPU required — both models are CPU-friendly)
- Two WebSocket endpoints, one per model, sharing the same container
- Per-model loading at startup, no lazy load
- Standard Vocence ops contract: `/healthz`, `/metrics`, `X-API-Key` auth
- Streaming-friendly: probability updates emitted as audio frames / transcript tokens arrive
- Optional REST endpoint for one-shot batch inference (useful for testing)

### Out of scope (do NOT include)
- VAD (Silero or otherwise) — the client already runs VAD; this pod is not the VAD layer
- STT — the streaming-STT pod handles that
- Any ensembling / fusion logic — the dashboard backend ensembles the signals
- GPU inference — both models run well on CPU; GPU adds complexity for no perceptible gain at this size
- Authentication beyond a single shared API key
- Multi-tenant rate limiting beyond the global concurrency cap

---

## 4. Models

### 4.1 Smart Turn v3

- HuggingFace: `pipecat-ai/smart-turn-v3` (also `pipecat-ai/smart-turn-v3-quantized` for ONNX-quantised int8)
- License: BSD-3-Clause
- Input: raw 16 kHz mono PCM (Float32), variable-length audio buffer
- Output: probability `p ∈ [0, 1]` that the speaker has just finished a complete thought
- Inference time: ~12 ms on a modern CPU per call (Pipecat benchmarks), ~60 ms on a small AWS instance
- Recommended call cadence: every 100–200 ms while audio is streaming, with a rolling window of the last ~4 seconds of audio as input
- Repo: https://github.com/pipecat-ai/smart-turn

Prefer the quantised ONNX variant unless benchmarks show accuracy degradation.

### 4.2 LiveKit Turn Detector v2

- HuggingFace: `livekit/turn-detector`
- License: Apache 2.0
- Architecture: SmolLM v2 fine-tune, ~135M parameters
- Input: text — a list of the last 4 turns in the conversation (alternating user / agent), with the user's *current* in-progress transcript appended
- Output: probability `p ∈ [0, 1]` that the next token would be the end-of-turn marker (`<|im_end|>`)
- Inference time: ~30–80 ms CPU per call depending on context length
- Recommended call cadence: every time a new word arrives from the streaming STT (typically 4–8 times per second of speech)
- Library: `livekit-plugins-turn-detector` (PyPI) — provides a high-level wrapper

The pod ships both float and int8-quantised model variants; the runtime picks based on env var.

---

## 5. Container contract

Same shape as every Vocence ops pod. Three endpoints.

### 5.1 `GET /healthz`

```json
{
  "status": "ok",
  "service": "turn-detection",
  "models": {
    "smart_turn": {
      "name": "pipecat-ai/smart-turn-v3-quantized",
      "loaded": true,
      "license": "BSD-3-Clause"
    },
    "turn_detector": {
      "name": "livekit/turn-detector",
      "loaded": true,
      "license": "Apache-2.0"
    }
  },
  "version": "0.1.0",
  "uptime_seconds": 142,
  "in_flight": 8,
  "max_concurrent_streams": 64,
  "cpu_count": 16,
  "ram_used_mib": 982,
  "ram_total_mib": 32000
}
```

`status` ∈ `ok` | `warming` | `degraded` | `error`. Anything except `ok` causes the dispatcher to stop sending sessions to this pod.

### 5.2 `GET /metrics`

Prometheus plaintext. Required counters (names are dispatcher-sensitive):

```
asr_requests_total{status="ok",model="smart_turn"} 24102
asr_requests_total{status="ok",model="turn_detector"} 18443
asr_requests_total{status="error",model="smart_turn"} 12
asr_requests_total{status="error",model="turn_detector"} 3

asr_duration_ms_sum{model="smart_turn"} 218304
asr_duration_ms_sum{model="turn_detector"} 1024138
asr_duration_ms_count{model="smart_turn"} 24102
asr_duration_ms_count{model="turn_detector"} 18443

asr_inflight 8
asr_inflight_smart_turn 5
asr_inflight_turn_detector 3
```

### 5.3 Auth

```
X-API-Key: <key>
```

Set at startup via env var `TD_API_KEY`. Container refuses to start without it. Missing/wrong key:
- HTTP → `401 {"error":"unauthorized"}`
- WS → close code `4401` before completing the handshake

---

## 6. WebSocket protocol

Two endpoints, one per model. Both follow the same lifecycle: `start` → `ready` → continuous events → `close`.

### 6.1 `WS /v1/smart-turn` — audio-based EOU

**Lifecycle:**
1. Client opens WS with `X-API-Key` header
2. Client sends `start` (text JSON)
3. Server replies `ready`
4. Client streams binary audio frames (raw PCM, see §7)
5. Server emits `probability` messages whenever the rolling-window probability changes meaningfully (see threshold rules below)
6. Either side sends `close` or the WS closes normally

**Client → server:**

```json
// Required first message
{
  "type": "start",
  "session_id": "optional-client-uuid",
  "sample_rate": 16000,
  "encoding": "pcm_s16le",
  "window_ms": 4000,
  "emit_every_ms": 150
}
```
- `window_ms`: rolling buffer of audio to feed the model on each call. Default 4000. Min 1000. Max 8000.
- `emit_every_ms`: minimum gap between consecutive `probability` emissions. Default 150. Server may emit faster than this if probability changes by ≥ 0.2 between calls.

Then binary PCM frames (same format as the streaming-STT pod — see §7).

Optional control messages:
- `{"type": "reset"}` — clear the rolling buffer (the user's previous utterance ended; a new one is starting)
- `{"type": "close"}` — end the session

**Server → client:**

```json
// After accepting start
{"type":"ready","session_id":"...","model":"pipecat-ai/smart-turn-v3-quantized","sample_rate":16000}

// Continuous probability updates
{
  "type": "probability",
  "p_end_of_turn": 0.62,
  "audio_ms_consumed": 2480,
  "inference_ms": 11
}

// Optional — only if explicit threshold crossed (see §6.3)
{
  "type": "end_of_turn",
  "p_end_of_turn": 0.91,
  "audio_ms_consumed": 2620
}

// Errors
{"type":"error","code":"bad_request|internal","message":"..."}
```

### 6.2 `WS /v1/turn-detector` — text-based EOU

**Client → server:**

```json
// Required first message
{
  "type": "start",
  "session_id": "optional",
  "history": [
    {"role": "user", "content": "what's the weather like today"},
    {"role": "assistant", "content": "It's 72 and sunny in San Francisco."}
  ],
  "language": "en"
}
```
- `history`: prior turns of conversation context (max last 4). Optional; if omitted, the model runs with empty history.

Then a stream of text messages as the STT produces new words:

```json
{"type":"token","text":"can you tell me","is_final":false}
{"type":"token","text":"can you tell me what","is_final":false}
{"type":"token","text":"can you tell me what time","is_final":false}
```
- `text` is the *cumulative* in-progress transcript for the current utterance (not a delta). This matches what the LiveKit Turn Detector model expects.
- `is_final` is advisory: when STT promotes a partial to a final, the client should send the final once with `is_final: true`.

Optional control:
- `{"type":"commit","content":"<final transcript>"}` — promote this utterance to a completed turn in the history and start a new in-progress utterance. Server resets in-progress context.
- `{"type":"close"}`

**Server → client:**

```json
{"type":"ready","session_id":"...","model":"livekit/turn-detector","language":"en"}

{
  "type": "probability",
  "p_end_of_turn": 0.34,
  "tokens_seen": 7,
  "inference_ms": 38
}

{"type":"end_of_turn","p_end_of_turn":0.93,"tokens_seen":12}

{"type":"error","code":"...","message":"..."}
```

### 6.3 When to emit `end_of_turn`

In addition to continuous `probability` updates, the server emits a one-shot `end_of_turn` message when the probability **first crosses 0.85** since the last `reset` / `start`. Once emitted in a session, it must not re-emit until a `reset` or the probability drops below 0.40 and crosses 0.85 again.

This is convenience for clients that don't want to threshold themselves. The continuous `probability` stream is the source of truth.

### 6.4 Backpressure

- WS-level: server applies TCP backpressure. Client must respect it.
- If the server's internal queue exceeds 2 seconds of audio (smart-turn) or 50 unprocessed tokens (turn-detector), the server drops the session with `code=internal, message="backpressure"`.
- Idle timeout: 60 seconds without any client message → server closes with `1000`.

### 6.5 Close codes

| Code | Meaning |
|---|---|
| 1000 | Normal closure |
| 1011 | Internal server error |
| 4400 | Bad `start` (wrong sample rate, invalid history shape, etc.) |
| 4401 | Unauthorized |
| 4413 | Audio frame too large |
| 4429 | Too many concurrent sessions (over `TD_MAX_CONCURRENT`) |

---

## 7. Audio format (Smart Turn endpoint only)

Identical to the streaming-STT pod for protocol parity:
- 16 kHz mono PCM, 16-bit signed little-endian (`pcm_s16le`), raw frames (no WAV header)
- Recommended frame size: 320 samples = 20 ms at 16 kHz
- Server accepts 80–1600 sample frames; anything larger → close `4413`

---

## 8. REST batch endpoints (optional but recommended)

For testing + one-shot inference without WS overhead.

### `POST /v1/smart-turn/batch`
Body: multipart `audio` (WAV/PCM file)
Response:
```json
{"p_end_of_turn": 0.82, "audio_ms": 3240, "inference_ms": 14}
```

### `POST /v1/turn-detector/batch`
Body: JSON
```json
{
  "history": [{"role":"user","content":"..."}],
  "in_progress": "what time does the store open"
}
```
Response:
```json
{"p_end_of_turn": 0.71, "tokens_seen": 7, "inference_ms": 42}
```

---

## 9. Configuration (env vars)

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TD_API_KEY` | **Yes** | — | Shared secret for `X-API-Key` |
| `TD_PORT` | No | `8117` | Bind port (chosen to not collide with existing pods) |
| `TD_MAX_CONCURRENT` | No | `64` | Total concurrent WS sessions across both models |
| `TD_SMART_TURN_MODEL` | No | `pipecat-ai/smart-turn-v3-quantized` | HuggingFace id |
| `TD_TURN_DETECTOR_MODEL` | No | `livekit/turn-detector` | HuggingFace id |
| `TD_THRESHOLD_FIRE` | No | `0.85` | Probability to fire `end_of_turn` message |
| `TD_THRESHOLD_RESET` | No | `0.40` | Probability below which `end_of_turn` is re-armable |
| `TD_LOG_LEVEL` | No | `info` | One of `debug`/`info`/`warn`/`error` |
| `TD_LOG_PAYLOADS` | No | `0` | If `1`, log transcript text (default off for privacy) |

---

## 10. Performance targets

| Metric | Target |
|---|---|
| Smart Turn inference latency p95 | ≤ 25 ms on a modern CPU (8+ vCPU) |
| Turn Detector inference latency p95 | ≤ 100 ms on the same CPU |
| Time to first `probability` (Smart Turn) | ≤ 250 ms after first audio frame |
| Time to first `probability` (Turn Detector) | ≤ 200 ms after first token |
| Concurrent WS sessions on 16 vCPU | ≥ 64 (with all p95s above still met) |
| RAM at idle | ≤ 1.5 GB |
| RAM at 64 concurrent sessions | ≤ 6 GB |
| Cold start (container → `/healthz` `ok`) | ≤ 30 s |

Include `scripts/benchmark.py` that measures all of the above against a running pod.

---

## 11. Resource requirements

### Minimum
- 8 vCPU
- 8 GB RAM
- 20 GB disk
- No GPU
- 1 Gbps network

### Recommended
- 16 vCPU
- 16 GB RAM
- NVMe disk

Co-locates well with the streaming-STT pod or the dashboard backend — neither contends for GPU or significant disk I/O.

---

## 12. Suggested repo structure

```
turn-detection/
├─ README.md
├─ Dockerfile
├─ pyproject.toml
├─ src/
│  └─ turn_detection/
│     ├─ __init__.py
│     ├─ server.py          # FastAPI app
│     ├─ smart_turn/
│     │  ├─ ws.py
│     │  ├─ model.py        # ONNX Runtime wrapper
│     │  └─ buffer.py       # rolling-window audio buffer
│     ├─ turn_detector/
│     │  ├─ ws.py
│     │  ├─ model.py        # transformers-based wrapper
│     │  └─ tokenize.py
│     ├─ metrics.py
│     ├─ healthz.py
│     └─ config.py
├─ scripts/
│  ├─ benchmark.py
│  └─ smoke.py
├─ tests/
│  ├─ test_smart_turn.py
│  ├─ test_turn_detector.py
│  ├─ test_protocol.py
│  └─ fixtures/
│     ├─ complete_sentence.wav
│     ├─ trailing_uhmm.wav
│     └─ short_backchannel.wav
└─ .github/workflows/
   ├─ ci.yml
   └─ release.yml
```

---

## 13. Test plan

### Unit
- Protocol parsing — every valid + invalid `start` shape
- Threshold edge cases (probability stays at 0.86 — exactly one `end_of_turn` per session until reset)
- Audio buffer rolling-window correctness

### Integration (against running container)
- Open Smart Turn WS, push a fixture audio file in 20 ms frames, assert at least one `probability` and one `end_of_turn` for a complete sentence
- Open Turn Detector WS, send a streaming partial that ends mid-sentence ("what time does"), assert `p_end_of_turn < 0.4`
- Same WS, send completing token ("what time does the store close"), assert `p_end_of_turn > 0.7`
- Auth failures: bad key → 4401
- Wrong sample rate on Smart Turn → 4400

### Reference fixtures
- `complete_sentence.wav` — clear declarative finished sentence, expect high p_end_of_turn at end
- `trailing_uhmm.wav` — speaker pauses with "uhmm", expect *low* p_end_of_turn during the pause (the model should know they're still talking)
- `short_backchannel.wav` — "uh-huh" / "yeah" alone, expect low p_end_of_turn (it's a turn fragment, not an end)

### Performance (pre-release)
- Run `scripts/benchmark.py` — must pass all targets in §10
- 30-minute soak at 50% capacity. No RAM growth.

---

## 14. Build & release

### Image
`docker.io/vocence/turn-detection:<tag>`. Tags: `latest`, `v0.1.0`, `dev-<sha>`.

### Dockerfile expectations
- Base: `python:3.11-slim`
- Multi-stage; no compilers in the final layer
- Model weights baked in at build time (`huggingface_hub.snapshot_download` in a build step)
- Final image ≤ 2.5 GB
- HEALTHCHECK identical pattern to the other Vocence pods

### CI
- GitHub Actions
- Push to `main`: lint, type-check, unit tests, integration tests against a running container, build + push `dev-<sha>`
- Tag `v*`: same + push `v*` and `latest`

---

## 15. Things to confirm with Vocence team before writing them

1. **Port assignment.** I picked `8117` to not collide with the existing services (8111–8116). Confirm before hardcoding.
2. **Service name registration.** This will register in the dispatcher as service type `turn_detection`. Confirm.
3. **Quantised vs full model.** §4 defaults to the quantised ONNX variants — fine for accuracy in our tests, but verify before pinning. The non-quantised models are ~3× the RAM.
4. **The `end_of_turn` threshold (0.85).** Reasonable default, but the *correct* value depends on how the dashboard backend ensembles signals. Flag this as "tune in integration."

---

## 16. Definition of done

1. All §10 performance targets pass on a 16-vCPU CPU node
2. All §13 integration tests pass in CI
3. Reference Python client (`examples/python_client.py`) demonstrates both endpoints end-to-end
4. Image published to `docker.io/vocence/turn-detection:v0.1.0`
5. README documents protocol concisely with a link to this spec
6. `/healthz` + `/metrics` schemas match this document exactly

Once green, the Vocence integration is: register a `turn_detection` service type, open WS connections to a chosen pod from `voicechat_service.py` whenever a streaming-STT session starts, ensemble the audio + text + Silero VAD signals to decide actual turn ends. That work happens in parallel and does not block this pod.

---

## 17. Quick start

```bash
docker build -t vocence/turn-detection:dev .

docker run --rm -p 8117:8117 \
  -e TD_API_KEY=test_key_local \
  vocence/turn-detection:dev

# Smoke
python scripts/smoke.py \
  --url ws://localhost:8117 \
  --api-key test_key_local \
  --audio tests/fixtures/complete_sentence.wav

# Expected: a stream of probability updates, ending with p > 0.85 and one end_of_turn event.
```
