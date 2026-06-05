# How the backend sends text to the TTS server

End-to-end flow of voice-chat TTS: from LLM tokens streaming in, through
sentence chunking, to the audio bytes the user finally hears. Use this
when debugging audio quality, latency, or pipeline bugs.

---

## The big picture — two tasks running in parallel

When a voice-chat turn starts, the backend spawns **two concurrent
asyncio tasks** that work as a producer/consumer pair:

```
                 ┌──────────────────┐
LLM tokens ───→  │ llm_producer     │ ──→ queues sentences ──→
                 └──────────────────┘                         │
                                                              ▼
                                                     ┌────────────────┐
                                                     │ sentence_q     │
                                                     │ (asyncio.Queue)│
                                                     └────────────────┘
                                                              │
                                                              ▼
                                                     ┌──────────────────┐
                                                     │ tts_consumer     │ ──→ audio frames to user
                                                     └──────────────────┘
```

The producer fills the queue with complete sentences. The consumer
drains the queue, calling the TTS server for each one. They never
block each other — TTS for sentence N happens while the LLM is still
writing sentence N+1.

---

## Step 1 — The producer (runs while the LLM streams)

**File:** `routers/voicechat.py:940-1006` (`llm_producer()`)

1. Calls `stream_chat_with_tools()` against the configured LLM
   (Cerebras Qwen 3 235B Instruct by default; Grok 4.20
   non-reasoning as fallback when Cerebras 429s).
2. Tokens stream back one delta at a time over SSE.
3. For each delta:
   - Forwards `{"type":"token","text":delta}` to the chat UI (so the
     text bubble fills in as the model writes).
   - Feeds the delta into a `SentenceChunker` instance.
4. The chunker accumulates deltas into a buffer and returns **0 or
   more complete sentences** each time it's fed.
5. For each complete sentence returned:
   - Runs `sanitize_for_tts()` to strip markdown / URLs / etc.
   - Puts the cleaned text on `sentence_q` via `await sentence_q.put(text)`.
6. When the LLM stream ends, the producer puts `None` on the queue
   as an end-of-turn sentinel.

---

## Step 2 — The chunker's rule

**File:** `voicechat_service.py:184-257` (`SentenceChunker`)

A "complete sentence" is emitted when **all** of these hold:

- The buffer contains `.`, `!`, or `?` followed by whitespace
  (or the CJK equivalents `。！？`, or `\n`)
- AND the buffer is at least **12 characters** long
- AND the punctuation isn't part of an abbreviation like `Mr.` or `U.S.`

Safety net (rarely fires):

- If the buffer reaches **300 characters** with no sentence-end found
  → hard-cut at the last space, log a warning.

Final flush:

- When the LLM stream ends, any leftover buffer is flushed as the last
  chunk via `chunker.flush()`.

**Tail-mode is currently disabled.** `VOICECHAT_WHOLE_REPLY_THRESHOLD=99999`
in `.env` means the chunker stays in sentence-by-sentence mode for
every reply, no matter how long. (Previously, after 300 chars emitted,
the chunker would buffer everything into one giant tail chunk —
disabled because the long tail chunk caused TTS quality drift.)

---

## Step 3 — The consumer (pulls from the queue)

**File:** `routers/voicechat.py:1189-1260` (`tts_consumer()`)

Infinite loop:

1. `spoken = await sentence_q.get()` — blocks until a sentence arrives.
2. If `spoken is None` → turn done, return.
3. Otherwise:
   - Increment `sentence_id` (1, 2, 3, …).
   - Send `{"type":"audio_meta","sentence_id":N,"sample_rate":24000,
     "frame_ms":40,"encoding":"pcm16le","channels":1}` to the frontend WS.
   - Call `stream_tts_for_voice(spoken, voice, user_id=user_id,
     warmer=tts_warmer)`.
   - For each binary frame the streamer yields, forward to the
     frontend WS as a binary WS message (`await ws.send_bytes(payload)`).
   - When the streamer's stream ends, send `{"type":"audio_end",
     "sentence_id":N}` to the frontend.
4. Loop to step 1.

---

## Step 4 — `stream_tts_for_voice` picks the right TTS backend

**File:** `voicechat_service.py:1089-1135`

Routing based on the agent's `voice` value:

| `voice` value | Routes to |
|---|---|
| `dv:<int>` | `stream_designed_voice_tts` → clone service (`149.36.0.123:8111`) |
| Sample voice id (e.g. `design-aria`) | `stream_voice_clone_tts` → clone service |
| Qwen3 speaker name (e.g. `aria`) | `stream_qwen3_tts` → qwen3-tts (`127.0.0.1:8111` if configured) |

For voice cloning, it first loads the reference audio bytes + reference
transcript for the voice (cached after the first lookup), then calls
`_stream_clone_via_service`.

---

## Step 5 — The actual WebSocket to the TTS server

**File:** `voicechat_service.py:777-877` (`_stream_clone_via_service`)

Per sentence chunk:

1. **Open a fresh aiohttp WebSocket** to:
   ```
   ws://149.36.0.123:8111/v1/voice-clone/stream
   ```
   with header `Authorization: Bearer <QWEN3_CLONE_API_KEY>`.

2. **Send a single "start" frame** as a JSON text message:
   ```json
   {
     "type": "start",
     "text": "Sure — so Bittensor's basically a decentralized network…",
     "ref_audio_b64": "<base64 of the reference WAV, ~540 KB for a 400 KB clip>",
     "ref_text": "<transcript of the reference audio>",
     "language": "English"   // optional; omitted = "Auto"
   }
   ```

3. **Read frames from the server**:
   - Text JSON `{"type":"meta", "sample_rate":24000, "frame_ms":40, ...}`
     — informational; our backend ignores it and hardcodes 24 kHz in
     the audio_meta we send to the frontend.
   - **Binary frames** — raw PCM16LE @ 24 kHz, ~960 samples (1920 bytes)
     per frame, each frame ≈ 40 ms of audio.
   - Text JSON `{"type":"end"}` → synthesis complete, OR
   - Text JSON `{"type":"error","code":"...","message":"..."}` → failure.

4. **Close the WebSocket** with a tight 300 ms cap so a barge-in
   cancel doesn't hang on the server's CLOSE ACK.

**Cancel safety:** if the generator is closed mid-stream (user
barge-in), the `finally` block fires and the WS closes promptly. The
TTS server has `cap=2`, so leaking a slot for 10 seconds on a default
close would cripple the next turn — hence the explicit 300 ms cap.

---

## Step 6 — Backend → frontend forward

For each binary PCM frame the TTS server sends, the backend simply:

```python
await ws.send_bytes(frame)
```

to the frontend WS. **No transcoding, no re-encoding, no batching.**
The bytes the browser receives are the exact bytes the TTS server
produced.

---

## Step 7 — Frontend playback (briefly)

**File:** `app/src/lib/voicechat/audioPlayer.ts`

1. Frontend's WS handler receives each binary frame.
2. Calls `player.push(arrayBuffer)`:
   - Converts `Int16` → `Float32` (PCM samples normalized to [-1, 1]).
   - If the browser's AudioContext sample rate ≠ 24 kHz (e.g. 48 kHz
     on macOS/Windows default), linear-interpolation resamples to the
     output rate.
   - Pushes the Float32Array into an `AudioWorklet` ring buffer.
3. The `AudioWorklet` drains samples at the AudioContext's clock rate
   into the audio output.
4. Prebuffer: 1500 ms accumulated before playback starts (smooths over
   bursty server delivery).
5. Mid-stream rebuffer floor: **disabled** (`REBUFFER_FLOOR_MS=0`).
   The previous setting caused thrashing — drain to 80 ms, pause to
   refill to 200 ms, repeat 4× per second. Now the worklet outputs
   zeros if the queue genuinely empties (imperceptible micro-gap)
   instead of pausing.

---

## Putting it all together — an 8-sentence reply

For *"Sure — so Bittensor's basically a decentralized network … big tech AI systems."*
(8 sentences, 939 chars total):

```
Time →
LLM streaming:        tokens tokens tokens tokens tokens... (continuous)
Chunker:              accumulating...EMIT!...accumulating...EMIT!...
sentence_q:               [s1]    [s2]    [s3]    [s4]    [s5]    [s6]    [s7]    [s8]    [None]
TTS consumer:             WS#1 → WS#2 → WS#3 → WS#4 → WS#5 → WS#6 → WS#7 → WS#8
Each WS#N does:           [open][send start][receive meta][stream PCM frames][receive end][close]
                            ↓                                ↓
                       ~50 ms handshake                ~3-6 s of audio frames
Frontend hears:                           [audio for s1][audio for s2]…[audio for s8]
```

**The 8 chunks for that reply** (produced by `SentenceChunker.feed()`):

| # | Chars | Text |
|---|---:|---|
| 1 | 147 | Sure — so Bittensor's basically a decentralized network where people run AI models and get rewarded in cryptocurrency for contributing useful ones. |
| 2 | 151 | Instead of one company controlling everything, it's like a marketplace where anyone can plug in their model and earn tokens based on how helpful it is. |
| 3 | 164 | It uses a blockchain to track who's doing valuable work, and the more your model helps others — like answering questions or processing data — the more you get paid. |
| 4 | 57 | The tokens, called TAO, can then be traded or reinvested. |
| 5 | 130 | It's kind of like if open-source AI and Uber had a baby — distributed, incentive-driven, and focused on making AI more accessible. |
| 6 | 95 | The network also connects to other AI subnets for things like text, audio, or image generation. |
| 7 | 84 | Each subnet handles a different task, and miners compete to provide the best output. |
| 8 | 104 | It's still pretty new, but the idea is to build a smarter, more open alternative to big tech AI systems. |

---

## Key facts to remember when debugging

- **One WS connection per sentence chunk, sequential.** Never two
  in-flight from a single voice chat (with the prewarmer disabled,
  which is the current setting).
- **The reference audio (~400 KB) is sent on every chunk's start frame.**
  That's per-chunk overhead the server has to base64-decode and load
  before it can start synthesizing.
- **Audio bytes are passthrough.** The audio the user hears is the
  exact PCM the TTS server produced. Backend doesn't re-encode.
- **Each chunk's WS is independent.** No shared state — the server
  should treat each chunk as a fresh synthesis from scratch.
- **`VOICECHAT_FORCE_MODEL=cerebras:qwen-3-235b-a22b-instruct-2507`**
  pins the LLM, ignoring per-agent overrides.
- **`VOICECHAT_LLM_FALLBACK_ENABLED=1`** auto-retries the LLM call
  against Grok (`grok-4.20-0309-non-reasoning`) when Cerebras fails
  before yielding the first token. After any content streams, errors
  propagate — we don't switch providers mid-sentence.
- **`TTS_PREWARM_ENABLED=0`** disables the pre-opening of WS connections
  for chunks 2..N. With it on, the backend opens chunk N+1's connection
  during chunk N's audio stream (saving ~50-80 ms per chunk) but
  doubles peak slot usage against the `cap=2` server.
- **`VOICECHAT_WHOLE_REPLY_THRESHOLD=99999`** disables the chunker's
  tail-mode switch. Every sentence is its own chunk.

---

## Where to look when audio is bad

| Symptom | Likely cause | Where to look |
|---|---|---|
| Long silence at the start | LLM TTFT or Cerebras 429 → fallback | `grep "voicechat: TTFT\|cerebras stream failed" /tmp/dashboard-backend.log` |
| First chunk fine, later chunks bad | Inter-chunk gaps draining buffer; OR tail-mode tail chunk; OR prewarmer race | Already mitigated via current env (prewarmer off, tail off, rebuffer floor 0) |
| Audio breaks INSIDE chunk 1 (e.g. on "decentralized") | TTS server per-stream quality drift | Reproduce on the TTS server team's side with the exact same `start` frame |
| Audio plays at wrong pitch/speed | Sample rate mismatch (AudioContext ≠ 24 kHz) | Browser dev console: log `audioCtx.sampleRate` — should be 24000 |
| Backend connects, then silence | TTS server `cap=2` exhausted | `curl http://149.36.0.123:8111/healthz` — check `inflight` |

---

*Last updated: 2026-05-21 (audio-quality debugging session)*
