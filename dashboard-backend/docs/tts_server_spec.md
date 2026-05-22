# TTS streaming server — integration spec

Requirements for building (or replacing) the TTS streaming server that  
the dashboard-backend's voice-chat pipeline talks to. A server that  
implements this spec is a drop-in replacement for the streaming sevice

> Audience: someone building a new TTS server that needs to integrate
> with the existing `dashboard-backend` voice-chat pipeline without
> code changes on the consumer side.

---

## 1. Overview

The dashboard-backend opens **one fresh WebSocket per sentence chunk**
to the TTS server. For each chunk, the backend sends one `start`
frame containing the text to synthesize plus a reference audio clip,
then reads binary PCM frames back in real time as the server
synthesizes them. The connection closes after each chunk.

For an 8-sentence reply, the backend opens **8 sequential WebSocket
connections**. They never overlap in the default config (prewarmer
off).

The audio bytes the user hears are forwarded **byte-for-byte** from
the TTS server, through the backend, to the browser. No transcoding,
no batching. So the server's per-frame output **is** what the user
hears.

---

## 2. Required endpoints

### 2.1 Streaming WebSocket — REQUIRED

```
ws://<host>:<port>/v1/voice-clone/stream
```

- Authentication via HTTP header:
  ```
  Authorization: Bearer <api-key>
  ```
- Server validates the bearer. On mismatch: respond with a single
text frame `{"type":"error","code":"auth","message":"..."}` and
close.

### 2.2 Health — REQUIRED

```
GET /healthz
```

Response (200 OK, JSON):

```json
{
  "status": "ok",
  "model_id": "qwen-3-tts-12hz-1.7b",  // any identifier
  "sample_rate": 24000,
  "inflight": 0,                         // currently active streaming connections
  "cap": 16,                             // max concurrent streaming connections
  "dev_stub": false                      // true if this is a mock/test build
}
```

`**inflight` MUST decrement on EVERY connection close path**, including:

- Normal completion (`end` frame sent)
- Client disconnect mid-stream
- Server-side error
- Connection-refused-after-accept paths

> The current server has a bug where errored connections leak the
> counter. After a few error paths, the server reports `inflight=cap`
> permanently and refuses all new connections. **Do not reproduce
> this bug.**

### 2.3 Optional health-extended endpoint

```
GET /metrics
```

Prometheus-compatible metrics:

- `tts_active_streams` (gauge)
- `tts_synth_latency_seconds` (histogram, time from `start` received → first PCM frame sent)
- `tts_synth_duration_seconds` (histogram, total synth time)
- `tts_errors_total{code}` (counter)

---

## 3. Wire protocol — streaming WebSocket

### 3.1 Client → server (one message per connection)

A single JSON text message with `type: "start"`:

```json
{
  "type": "start",
  "text": "Sure — so Bittensor's basically a decentralized network…",
  "ref_audio_b64": "<base64-encoded WAV bytes; typically 300-500 KB>",
  "ref_text": "<transcript of the reference audio>",
  "language": "English"
}
```

Field rules:


| Field           | Type   | Required | Notes                                                                                                                                                                                                                             |
| --------------- | ------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`          | string | yes      | Must be `"start"`                                                                                                                                                                                                                 |
| `text`          | string | yes      | The text to synthesize. ≤ 600 chars expected. UTF-8.                                                                                                                                                                              |
| `ref_audio_b64` | string | yes      | Base64-encoded raw bytes of a WAV file. 8-48 kHz, mono or stereo, 16-bit or float. Server is responsible for parsing format.                                                                                                      |
| `ref_text`      | string | yes      | Transcript of the reference audio for voice-clone alignment.                                                                                                                                                                      |
| `language`      | string | no       | One of: `"Auto"`, `"English"`, `"Chinese"`, `"Japanese"`, `"Korean"`, `"Spanish"`, `"French"`, `"German"`, `"Portuguese"`, `"Italian"`, `"Russian"`, `"Arabic"`. Default `"Auto"`. Unknown values: pass through (server decides). |


The server **MUST NOT** require any additional client messages —
after the `start` frame the client only reads. (Specifically: no
`continue`, `end`, or ack frames sent by the client.)

The client closes the WS after it receives `end` or `error`.

### 3.2 Server → client

The server emits these messages **in order** over the lifetime of the
connection:

#### 3.2.1 `meta` (text JSON, optional — sent once)

```json
{
  "type": "meta",
  "sample_rate": 24000,
  "frame_ms": 40,
  "encoding": "pcm16le",
  "channels": 1
}
```

Informational. The backend currently ignores it and hardcodes
`24000 / 40 ms / pcm16le / mono` when announcing audio_meta to the
frontend. **For full compatibility with the current backend, the
server MUST produce audio matching these defaults regardless of what
its `meta` frame says.**

#### 3.2.2 Binary PCM frames (many, until end)

Raw PCM16 little-endian mono samples at **24,000 Hz**.

Frame size:

- **40 ms per frame** = 960 samples = 1,920 bytes per frame
- Frames may be smaller at end-of-stream (last frame can be partial)
- Frames may NOT be larger than 40 ms (the frontend's worklet sizes
its prebuffer assuming this)

Pacing: frames SHOULD arrive at near-real-time pace (one 40 ms frame
every ~40 ms wall-clock). Bursty delivery (e.g. all frames at once)
is acceptable BUT the frontend's prebuffer is 1500 ms — bursts ≥ 1.5 s
ahead of real-time may cause the player to drop frames or fall behind.

#### 3.2.3 `end` (text JSON, REQUIRED, sent last on success)

```json
{
  "type": "end",
  "duration_ms": 5240
}
```

`duration_ms` is informational (total synthesized audio length).
After sending `end`, the server SHOULD close the WS within 100 ms.

#### 3.2.4 `error` (text JSON, sent INSTEAD of `end` on failure)

```json
{
  "type": "error",
  "code": "<error code>",
  "message": "<human-readable diagnostic, ≤ 200 chars>"
}
```

Standard error codes:


| `code`                 | When                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| `auth`                 | Missing / invalid bearer token.                                                          |
| `bad_request`          | Malformed `start` frame (missing field, invalid type, ref_audio_b64 not decodable, etc.) |
| `server_busy`          | `inflight >= cap` at connection accept time. Connection refused.                         |
| `engine_failed`        | Model error during synthesis (CUDA OOM, NaN, etc.).                                      |
| `timeout`              | Synthesis exceeded server's hard cap (recommended 60 s).                                 |
| `unsupported_language` | `language` field not supported by the model.                                             |


After sending `error`, the server SHOULD close the WS within 100 ms.

---

## 4. Audio format — strict requirements


| Property             | Required value                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Sample rate          | **24,000 Hz** (exactly)                                                                                               |
| Bit depth            | **16-bit signed**                                                                                                     |
| Endianness           | **little-endian**                                                                                                     |
| Channels             | **1 (mono)**                                                                                                          |
| Encoding             | **raw PCM** (no WAV header on frames; the WAV header is only in the inbound `ref_audio_b64`, not the outbound stream) |
| Byte order per frame | Little-endian samples concatenated (`[s0_lo, s0_hi, s1_lo, s1_hi, …]`)                                                |


> **Do not deviate from 24 kHz.** The frontend's AudioContext is
> created at 24 kHz when the browser allows it, otherwise resampled
> by linear interpolation. Other rates cause audible pitch shift or
> resampling artifacts.

---

## 5. Quality requirements (lessons from the previous server)

The previous server passed standalone tests but degraded under
real-pipeline conditions. The new server MUST hold up to these:

### 5.1 No quality drift WITHIN a single connection

For a single `start` frame with text ≤ 300 chars, audio quality must
be **uniform from first to last frame**. Specifically:

- No vocoder drift / attention drift over the course of one synthesis
- No quality cliff at any point within the audio (e.g. partway
through a long sentence)
- Consonant-heavy words must synthesize cleanly throughout (test
case: *"decentralized network where people contribute compute"*).

### 5.2 No state leakage BETWEEN connections

Each new WebSocket connection is fresh. **No KV cache, attention
state, model context, or per-utterance state may persist across
connections.** Connection N+1 must start with the same model state
as connection 1, even if hundreds of connections preceded it.

### 5.3 Concurrent connections do not degrade each other

When `inflight = cap`, each concurrent connection must produce
audio quality identical to what it would produce alone. No
quality-vs-throughput tradeoff under load.

### 5.4 Recommended cap = 16+ for production

The previous server's `cap=2` is unrealistic for production voice
chat. Recommended minimum: **16 concurrent streams**. This means
your server should handle the GPU/CPU planning to time-slice or
batch synthesize without quality loss (see 5.3).

### 5.5 Reference audio caching

For voice-cloned synthesis, the same `ref_audio_b64` + `ref_text`
will be sent on every chunk of every turn for the same voice. The
server SHOULD cache the parsed/embedded representation keyed on
SHA-256 of `ref_audio_b64`. Cache size: 100 voices. Eviction: LRU.

This avoids re-running the reference-audio encoder per chunk (which
is wasted work — the same ref is used 8 times for an 8-chunk reply).

---

## 6. Performance requirements


| Metric                                                      | Target                         | Hard ceiling |
| ----------------------------------------------------------- | ------------------------------ | ------------ |
| Time to first PCM frame after `start` received (warm cache) | **< 200 ms**                   | < 500 ms     |
| Time to first PCM frame (cold ref)                          | < 400 ms                       | < 800 ms     |
| WS handshake (TCP + Upgrade)                                | < 50 ms (LAN)                  | < 100 ms     |
| Total synthesis time for 100 chars of English text          | < 4 s (real-time factor < 0.4) | < 8 s        |
| Frame delivery jitter                                       | < 100 ms between frames        | < 200 ms     |


> **Why these matter**: voice chat is end-to-end-latency-sensitive.
> The user's perceived "time to first word" is the sum of LLM time
>
> - TTS time-to-first-frame + frontend prebuffer (1500 ms). Any TTS
> startup time over 500 ms is directly visible to the user.

---

## 7. Connection lifecycle & cleanup

The server MUST handle these cases without leaking the `inflight`
counter:


| Event                                     | Server action                                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Normal success                            | Send `end`, close WS, decrement inflight                                                                                                 |
| Synthesis error mid-stream                | Send `error`, close WS, decrement inflight                                                                                               |
| **Client closes mid-stream (barge-in)**   | **See §7.5 — stop synthesis within 100 ms, decrement inflight, do NOT send any further frames**                                          |
| Client disconnects ungracefully (TCP RST) | Detect via WS close handler within 2 s, decrement inflight                                                                               |
| Client never sends `start` (idle)         | Time out after 30 s, send `error{timeout}`, close, decrement                                                                             |
| Server panics mid-stream                  | If unrecoverable, all in-flight connections are dropped — but `inflight` MUST reset to actual count of live connections (not stay stale) |


> The current server fails on case #2 (synthesis error doesn't
> decrement). Over time this fills up the counter until the server
> rejects all new connections. **Test all 5 paths explicitly.**

---

## 7.5 Barge-in and interruption handling — REQUIRED

**This is the most important section in the spec for voice-chat UX.**
A natural-feeling voice agent must stop talking the instant the user
starts talking (or types) — *"barge-in"*. The TTS server is on the
hot path for this.

### 7.5.1 What barge-in looks like end-to-end

1. **Agent is mid-reply.** TTS server is streaming chunk N of an
  8-chunk reply. WS is open, PCM frames are flowing.
2. **User speaks** (or types a new message). Frontend's VAD detects
  speech after ~350 ms of voice activity.
3. **Frontend sends** `{"type":"cancel"}` to the dashboard-backend.
4. **Dashboard-backend cancels the in-flight turn task.** This:
  - Closes the WS to the TTS server (with a 300 ms hard cap on the
   close ACK — the backend will NOT wait longer than 300 ms for
   the server's CLOSE response)
  - Drains the sentence_q
  - Discards any pre-warmed WS (if the warmer is on)
5. **A new turn begins immediately.** The dashboard-backend opens a
  **new** WS to the TTS server for the user's new utterance — often
   within ~50-200 ms of closing the old one.

The TTS server has two hard responsibilities here:

- **Stop synthesis the instant the WS closes.** No more PCM frames
after the close handshake completes (or the TCP connection drops).
- **Release the inflight slot immediately** so the new WS (which is
about to arrive) can be accepted.

### 7.5.2 Detection of client close

The client (dashboard-backend) will close the WS in one of two ways:


| Mode                                          | When                          | Server must detect within              |
| --------------------------------------------- | ----------------------------- | -------------------------------------- |
| **Graceful close** (WS opcode 0x8, code 1000) | Normal barge-in path          | **50 ms** of the close frame arriving  |
| **TCP RST / abrupt drop**                     | Client crash, network failure | **2 s** (TCP keepalive + WS heartbeat) |


The dashboard-backend's `aiohttp` close protocol:

```python
await asyncio.wait_for(ws.close(code=1000), timeout=0.3)
```

So the backend sends the close frame and waits up to 300 ms for the
server's CLOSE ACK. After that, the backend moves on regardless. **If
the server doesn't ACK within 300 ms, the WS is effectively abandoned
from the client's side.**

### 7.5.3 Server actions on close — HARD requirements

Within **100 ms** of detecting a WS close, the server MUST:

1. **Cancel the in-flight synthesis task.** Stop generating new PCM
  frames immediately. Do NOT finish the current sentence and send a
   late `end` frame.
2. **NOT send any further frames** over the WS (binary or text). Even
  if the synthesis task already had 200 ms of audio queued, drop it.
3. **Free GPU memory and KV cache** associated with this connection.
4. **Decrement the `inflight` counter.** The slot must be available
  for the next connection.
5. **Tear down the WS** (FIN/ACK on the TCP side).

> **Why 100 ms?** The dashboard-backend's typical gap between
> closing the old WS and opening the new one is ~50-200 ms. If the
> server is still cleaning up the old slot when the new WS arrives,
> the new connection gets `server_busy` — and the user perceives a
> long silence before the agent responds to their interruption.

### 7.5.4 Forbidden behaviors (audible bugs in the wild)

The new server MUST NOT:

- **Finish the current sentence "to be polite"** after a barge-in
close. The user already started talking; their reply needs the GPU
more than the previous reply does.
- **Buffer PCM frames in a background task** that keeps running after
the WS closes (silent leak of GPU/memory).
- **Hold the inflight slot until the model's `forward()` returns**
naturally. The cancellation must propagate into the inference loop.
- **Reject the next connection** with `server_busy` when the previous
slot is still releasing. Cleanup must be fast enough that this
doesn't happen under normal voice-chat usage.
- **Send `end` after a close.** The contract is: on barge-in,
the WS closes and the synthesis dies silently. No `end` frame, no
`error` frame, just close.

### 7.5.5 Performance targets


| Metric                                                    | Target                                                            | Hard ceiling |
| --------------------------------------------------------- | ----------------------------------------------------------------- | ------------ |
| WS close detection → synthesis cancel                     | < 50 ms                                                           | < 100 ms     |
| WS close detection → `inflight` decrement                 | < 50 ms                                                           | < 100 ms     |
| Time between old WS close and new WS accept (same client) | **must accept new connection** within 50 ms of old being released | < 200 ms     |
| GPU memory freed                                          | within 100 ms                                                     | < 500 ms     |


The aggregate user-facing target: **from "user starts speaking" to
"agent stops talking" must be ≤ 500 ms** (350 ms VAD + 50 ms network

- 100 ms server cleanup). The previous server occasionally took
1-3 s to release a slot, producing a sluggish barge-in experience.

### 7.5.6 Optional: explicit client-sent cancel frame

The current backend ONLY closes the WS. It does not send a text
`cancel` frame. The new server SHOULD continue to treat WS close as
the canonical cancel signal.

If you want to add an explicit `{"type":"cancel"}` text frame from
the client as well (for clearer logging), document it — but the WS
close path MUST always work on its own. Don't make cancellation
depend on a custom text frame the backend doesn't send.

### 7.5.7 Edge case: barge-in BEFORE first PCM frame

If the WS closes after `start` but before the server has produced
any PCM (e.g. during cold model warmup), the server still must:

- Cancel the warmup synthesis (no PCM ever sent)
- Decrement `inflight`
- Close the WS cleanly

No `error` frame is needed for this case — the client knows the
close was its own initiative.

### 7.5.8 Edge case: barge-in DURING synthesis but AFTER `end` sent

If the server already sent the `end` frame and is just waiting for
the client to close, and the client closes ungracefully, this is
not a barge-in — it's normal completion. Handle as a normal close.

### 7.5.9 Test plan for barge-in

Add these to the acceptance test plan (§8):

#### Test B1 — single barge-in

- Open a WS, send a `start` with text long enough to produce 5+
seconds of audio.
- Wait for ~500 ms of PCM frames to arrive.
- Close the WS.
- Verify within 100 ms: server stops sending frames, `inflight`
decrements to 0.

#### Test B2 — barge-in storm (worst case)

- Loop 100 times: open WS, send start, wait 200 ms, close WS.
- After the loop, `inflight` must be exactly 0.
- Open one final WS with a full synthesis — must complete normally.
- No memory growth between runs.

#### Test B3 — rapid reconnect after barge-in

- Open WS A, send start, wait 1 s.
- Close WS A.
- Immediately (within 50 ms) open WS B with a different start.
- WS B must NOT get `server_busy`. It must accept and stream normally.

#### Test B4 — cold-start barge-in

- Open a WS, send start, close the WS within 100 ms (before any PCM
could be produced).
- `inflight` must reach 0 within 200 ms of the close.
- A second WS opened immediately must succeed.

---

## 8. Acceptance test plan

The server passes integration testing when these tests succeed:

### 8.1 Smoke test (single connection)

```bash
# 1. Health endpoint
curl -s http://localhost:8111/healthz
# Expect: {"status":"ok", ..., "inflight":0, ...}

# 2. Drive one synthesis via WS (see /tmp/tts_concurrent.py for client code)
python -m test.smoke
# Expect: WS opens, start sent, meta + PCM frames + end received,
#         WS closes cleanly, healthz inflight back to 0.
```

### 8.2 Quality test (consonant-heavy text)

For text = `"Sure — so Bittensor's basically a decentralized network where people run AI models and get rewarded in cryptocurrency for contributing useful ones."`:

- Audio plays cleanly start to finish
- No glitches, dropouts, or pitch artifacts in any word
- Specifically *"decentralized"*, *"cryptocurrency"*, *"contributing"*
must be intelligible

### 8.3 Sequential connections (mimics one voice chat reply)

Send 8 sequential connections, each with a different sentence.
Audio quality of connection 8 must equal audio quality of connection 1.
Total `inflight` time series across the test: should rise to 1, then
return to 0 between connections, never exceeding 1.

### 8.4 Concurrent connections (mimics multi-user)

Open `cap` (e.g. 16) concurrent connections simultaneously. Each
connection must:

- Receive its first PCM frame within 500 ms of `start`
- Stream to completion without `engine_failed`
- Produce audio quality equal to a solo connection

After all connections close, `inflight` MUST return to 0.

### 8.5 Error path tests

Trigger each error code and verify `inflight` decrements:


| Test            | Trigger                                        | Expected                                                                      |
| --------------- | ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `auth`          | Connect with wrong/missing bearer              | `error{auth}`, close, inflight unchanged from before-accept                   |
| `bad_request`   | `start` missing `text`                         | `error{bad_request}`, close, inflight decremented                             |
| `server_busy`   | Open `cap+1` simultaneous connections          | The `cap+1`-th gets `error{server_busy}` and closes, the rest stream normally |
| `engine_failed` | Send 10,000-char `text` (force OOM or similar) | `error{engine_failed}`, close, inflight decremented                           |
| `timeout`       | Open WS, never send `start` for 60 s           | `error{timeout}`, close, inflight decremented                                 |


### 8.6 Reconnection storm

Open + close 1,000 WS connections in 60 seconds. Check `inflight`
is exactly 0 at the end. Verify no slow memory leak via repeated runs.

---

## 9. Optional / nice-to-have features



### 9.4 Streaming reference audio update

For long voice chats with the same voice, allow the client to send
the ref_audio_b64 ONCE per session and reference it by hash in
subsequent connections:

```json
{ "type": "start", "text": "...", "ref_audio_sha256": "<hex>" }
```

This avoids the 540 KB upload on every chunk. Would require a
session-handshake endpoint.

### 9.5 Cancellation

Honor the WS close frame from the client as an immediate cancel.
Stop synthesis within 100 ms of receiving close — don't waste GPU
on audio nobody's listening to.

---

## 10. Implementation hints

### 10.1 Recommended stack

- **WebSocket library**: `websockets` (Python) or any equivalent.
- **HTTP framework for /healthz**: FastAPI, Starlette, aiohttp.
- **Model serving**: PyTorch / vLLM / SGLang depending on the model.
- **Audio**: NumPy + soundfile for ref-audio parsing; raw bytes for output.

### 10.2 Concurrency model

- **One process per GPU** with `cap = N_concurrent_streams_per_GPU`.
- Use asyncio for WS handling, with synthesis offloaded to a thread
pool or separate process.
- Batch concurrent inference requests if your model supports it
(Qwen3-TTS, XTTS, Bark, etc. generally do).

### 10.3 Inflight counter implementation

Use an `asyncio.Lock`-protected integer or `contextvars`. Track in a
context manager pattern so EVERY path decrements:

```python
@asynccontextmanager
async def inflight_slot():
    if inflight >= cap:
        raise ServerBusy
    inflight += 1
    try:
        yield
    finally:
        inflight -= 1   # always runs, no matter what
```

### 10.4 Test under load

Before declaring the server production-ready, run a 24-hour
soak test:

- 8 concurrent connections, each doing 100 sequential chunks
- Verify no quality drift, no inflight leak, no memory growth

The previous server passed isolated tests but failed under sustained
streaming pressure. **The soak test is what catches the bugs that
matter to users.**

---

## 11. Reference: what the current backend assumes

For drop-in compatibility, the new server MUST:

- Accept exactly the wire protocol in §3
- Output exactly the audio format in §4
- Be reachable at the URL configured in `dashboard-backend/.env`
under `QWEN3_CLONE_BASE_URL`
- Accept the bearer token configured in `QWEN3_CLONE_API_KEY`
- Run on port 8111 (or whatever you point `QWEN3_CLONE_BASE_URL` at)

No changes to the dashboard-backend should be required.

---

*This spec was written 2026-05-22 after debugging an audio-quality
regression where the previous `qwen3-clone-streaming` server degraded
mid-utterance under real-pipeline load. The quality requirements in §5
are direct lessons from that incident.*