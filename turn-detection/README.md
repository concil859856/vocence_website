# vocence/turn-detection

End-of-utterance detection pod for the Vocence voice-agent platform.
Bundles two open-weights models behind one CPU-only Docker container:

| Model | Input | Reads | License | Inference (CPU) |
|---|---|---|---|---|
| [Pipecat Smart Turn v3](https://huggingface.co/pipecat-ai/smart-turn-v3) | streaming 16 kHz mono PCM | prosody / intonation / breath | BSD-3-Clause | ~15–20 ms |
| [LiveKit Turn Detector v2](https://huggingface.co/livekit/turn-detector) | streaming transcript | semantic completeness | Apache-2.0 | ~7–15 ms |

Both fire continuous probability streams over WebSocket so a downstream
ensembler can fuse them (and optionally client-side VAD) to decide
actual turn-ends.

---

## Quick start

```bash
# Build
docker build -t vocence/turn-detection:dev .

# Run
docker run --rm -p 8119:8119 \
  -e TD_API_KEY=test_key_local \
  vocence/turn-detection:dev

# Health
curl http://localhost:8119/healthz

# REST batch — text EOU
curl -s -X POST http://localhost:8119/v1/turn-detector/batch \
  -H "X-API-Key: test_key_local" \
  -H "Content-Type: application/json" \
  -d '{"history":[],"in_progress":"what time does the store open"}'
# → {"p_end_of_turn":0.07,"tokens_seen":7,"inference_ms":12}

# REST batch — audio EOU
curl -s -X POST http://localhost:8119/v1/smart-turn/batch \
  -H "X-API-Key: test_key_local" \
  -F "audio=@tests/fixtures/complete_sentence.wav"
# → {"p_end_of_turn":0.93,"audio_ms":3240,"inference_ms":18}
```

The reference Python client (`examples/python_client.py`) demonstrates
both WebSocket endpoints end-to-end.

---

## What this is for

A voice-agent control plane typically opens two WebSockets per active
conversation:

```
PCM audio stream  ──►  WS /v1/smart-turn      ──►  p_end_of_turn from prosody
STT partial text  ──►  WS /v1/turn-detector   ──►  p_end_of_turn from content
```

The consumer fuses those two signals with the client-side VAD silence
event to decide "the user is done speaking; commit the turn." Combining
audio and text signals catches both *"My address is twenty-two—"* (text:
clearly mid-utterance, audio: rising intonation) and *"uhhh… mm"*
(text: ambiguous, audio: dropping intonation, breath). Each signal alone
is fragile; together they outperform fixed-time silence timeouts by
~39% in published benchmarks ([LiveKit](https://blog.livekit.io/improved-end-of-turn-model-cuts-voice-ai-interruptions-39/)).

This pod is the open-source replacement for the semantic-VAD layer in
OpenAI Realtime / ElevenLabs Conversational AI 2.0.

---

## Configuration

All knobs are env vars. Required:

| Env | Purpose |
|---|---|
| `TD_API_KEY` | Shared secret for the `X-API-Key` header. Container refuses to start without it. |

Optional:

| Env | Default | Purpose |
|---|---|---|
| `TD_PORT` | `8119` | HTTP bind port |
| `TD_MAX_CONCURRENT` | `64` | Total WS sessions across both endpoints |
| `TD_SMART_TURN_MODEL` | `pipecat-ai/smart-turn-v3` | HF repo id |
| `TD_SMART_TURN_FILE` | `smart-turn-v3.2-cpu.onnx` | filename inside repo |
| `TD_TURN_DETECTOR_MODEL` | `livekit/turn-detector` | HF repo id |
| `TD_TURN_DETECTOR_FILE` | `model_quantized.onnx` | filename inside repo |
| `TD_THRESHOLD_FIRE` | `0.85` | probability to fire `end_of_turn` |
| `TD_THRESHOLD_RESET` | `0.40` | probability below which `end_of_turn` is re-armable |
| `TD_LOG_LEVEL` | `info` | `debug|info|warning|error` |
| `TD_LOG_PAYLOADS` | `0` | `1` to include transcript text in logs (default off for privacy) |
| `TD_MODELS_CACHE_DIR` | _(HF default)_ | path the models were baked into. The Docker image sets this to `/models` |

---

## Protocol summary

### `GET /healthz` — Vocence pod contract

```json
{
  "status": "ok",
  "service": "turn-detection",
  "models": {
    "smart_turn":    {"name":"...","loaded":true,"license":"BSD-3-Clause"},
    "turn_detector": {"name":"...","loaded":true,"license":"Apache-2.0"}
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

`status` is `warming | ok | degraded | error`. Health pollers should
read this field, not the HTTP status code, when deciding whether to
route new sessions.

### `GET /metrics` — Prometheus text

Required counters (the names + label keys form the public contract for
any metrics scraper — don't rename without bumping the major version):

```
asr_requests_total{status="ok",model="smart_turn"}      <int>
asr_requests_total{status="ok",model="turn_detector"}   <int>
asr_duration_ms_sum{model="..."}                        <float>
asr_duration_ms_count{model="..."}                      <int>
asr_inflight                                            <int>
asr_inflight_smart_turn                                 <int>
asr_inflight_turn_detector                              <int>
```

### `WS /v1/smart-turn` — audio EOU

| Direction | Frame | Purpose |
|---|---|---|
| C→S | `{"type":"start","sample_rate":16000,"encoding":"pcm_s16le","window_ms":4000,"emit_every_ms":150}` | required first frame |
| S→C | `{"type":"ready","session_id":"...","model":"...","sample_rate":16000}` | |
| C→S | binary PCM frames | 80–1600 samples per frame at 16 kHz |
| C→S | `{"type":"reset"}` | drop the rolling window (new utterance) |
| C→S | `{"type":"close"}` | end the session |
| C→S | `{"type":"ping","ts":<ms>}` | keep-alive |
| S→C | `{"type":"probability","p_end_of_turn":<float>,"audio_ms_consumed":<ms>,"inference_ms":<int>}` | continuous |
| S→C | `{"type":"end_of_turn","p_end_of_turn":<float>,"audio_ms_consumed":<ms>}` | fires once when p crosses TD_THRESHOLD_FIRE; rearms when p drops below TD_THRESHOLD_RESET |
| S→C | `{"type":"pong","ts":<echoed>}` | |
| S→C | `{"type":"error","code":"...","message":"..."}` | |

### `WS /v1/turn-detector` — text EOU

| Direction | Frame | Purpose |
|---|---|---|
| C→S | `{"type":"start","history":[{"role":"user","content":"..."},...],"language":"en"}` | required first frame; history up to last 4 turns |
| S→C | `{"type":"ready","session_id":"...","model":"livekit/turn-detector","language":"en"}` | |
| C→S | `{"type":"token","text":"<cumulative in-progress transcript>","is_final":false}` | text is CUMULATIVE, not delta |
| C→S | `{"type":"commit","content":"<final transcript>"}` | promote to history, reset in-progress |
| C→S | `{"type":"close"}` / `{"type":"ping","ts":...}` | |
| S→C | `{"type":"probability","p_end_of_turn":<float>,"tokens_seen":<int>,"inference_ms":<int>}` | continuous |
| S→C | `{"type":"end_of_turn","p_end_of_turn":<float>,"tokens_seen":<int>}` | fires once on threshold crossing |
| S→C | `{"type":"error","code":"...","message":"..."}` | |

### Close codes

| Code | Meaning |
|---|---|
| 1000 | Normal closure |
| 1011 | Internal server error |
| 4400 | Bad request (invalid `start`, wrong sample rate, etc.) |
| 4401 | Unauthorized (bad/missing `X-API-Key`) |
| 4413 | Audio frame too large (Smart Turn endpoint) |
| 4429 | Too many concurrent sessions (over `TD_MAX_CONCURRENT`) |

---

## Performance

Measured locally on a 12-core CPU (no GPU), cold cache:

| Metric | Measured | Spec target |
|---|---|---|
| Smart Turn ONNX inference p95 | ~17 ms | ≤ 25 ms |
| Turn Detector ONNX inference p95 | ~10 ms | ≤ 100 ms |
| Smart Turn TTFP | < 250 ms | ≤ 250 ms |
| Cold start (with cached weights) | ~3 s | ≤ 30 s |
| RAM idle (both models loaded) | ~1.1 GB | ≤ 1.5 GB |

Run `scripts/benchmark.py` against a live pod to reproduce.

---

## Development

```bash
# Install dev deps
pip install -e ".[dev]"

# Lint
ruff check src tests

# Type-check
mypy src

# Unit + integration tests
pytest

# Run server locally
TD_API_KEY=dev uvicorn turn_detection.server:app --port 8119 --reload
```

---

## Architectural decisions

- **CPU-only by design.** Both models run in single-digit ms on commodity CPUs. Adding GPU support would gain nothing measurable while complicating the deployment story.
- **Models baked into the image.** Cold-start with a fresh node pulls only the image, not 175 MB of HF downloads on top. The `models` build stage in the Dockerfile handles this; `TD_MODELS_CACHE_DIR=/models` points the runtime at the bundled weights.
- **Single worker per container.** Each worker holds the model sessions in memory; multiple workers would duplicate them. Scale by adding more pods.
- **One semaphore across both endpoints.** Spec says `TD_MAX_CONCURRENT` is the total. We use a single asyncio semaphore the WS handlers acquire on entry. At capacity, new connections close with 4429 — no queueing.
- **Fire-and-reset threshold logic.** The `end_of_turn` event fires exactly once per "turn arc" — when `p` first crosses `TD_THRESHOLD_FIRE`, then re-arms when it drops below `TD_THRESHOLD_RESET`. Continuous `probability` events stream unconditionally; downstream consumers can threshold themselves if they want different policies.

---

## License

This pod's source code is Apache-2.0.

The bundled model weights are subject to their respective licenses:

- Pipecat Smart Turn v3 — BSD-3-Clause ([repo](https://huggingface.co/pipecat-ai/smart-turn-v3))
- LiveKit Turn Detector v2 — Apache-2.0 ([repo](https://huggingface.co/livekit/turn-detector))

Both are surfaced in the `/healthz` response under `models.<name>.license` so downstream operators can attribute correctly.
