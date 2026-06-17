# Server-Side Continuous Barge-In Detection

**Status:** Phase 1–4 SHIPPED, behind ``VOICE_SERVER_BARGE_IN`` env flag (default off). Awaits real-call tuning.
**Code:** ``dashboard-backend/barge_in_listener.py`` + wired in ``routers/voicechat.py``.

## The bug we're fixing

User reports (verified in 2026-06-17 traces): when VAD prematurely cuts user speech and the agent starts replying, the user continues their original thought. The agent **doesn't react fast** — either ignores the continued speech entirely or takes several seconds to stop.

Today's flow can't fix this with tuning alone:

```
User speaks ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
            ↑ premature commit            ↑ continuation
                       ↓
Agent reply           ━━━━━━━━━━━━━━━━━━ TTS playing
                       ↑
                       Server-side audio processing STOPS here
                       (StreamingTurnSession is closed)

  ⇒ Server can't notice the user is still talking until
    frontend Silero fires a NEW speech_start event AND sends
    stream_start. If user is continuously speaking, Silero
    may never emit a fresh speech_start.
```

## Videosdk's architecture (the reference)

One WebSocket per call. VAD runs continuously. During agent reply, `pipeline_orchestrator._monitor_interruption_duration` polls `current_vad_probability` every 50 ms. When sustained speech (`interrupt_min_duration = 0.5 s`) is detected, it calls `_interrupt_pipeline()` which cancels TTS, content_generation, and the current task.

Direct port impossible — they have a per-call session, we have per-turn `StreamingTurnSession`. But we can add the missing piece as a focused component.

## Proposed design

### Component 1: `BargeInListener` (new module)

```
class BargeInListener:
    """Watches incoming audio during agent reply.
    Fires on_barge_in() when sustained user speech is detected.
    """
    async def start(on_barge_in: Callable[[], Awaitable[None]]) -> None
    async def pause() -> None        # called when a turn opens
    def push_audio(frame: bytes) -> None  # no-op if paused
    async def aclose() -> None
```

Owns its own `UltraVADStream` connection. Tick loop @ 60 ms reads `last_p_end_of_turn` — NOT the right signal directly (it's end-of-turn prob, not speech-present prob). Two options:

| Signal | Pros | Cons |
|---|---|---|
| **Reuse STT pod's `vad_speech` event** | Already integrated, binary speech-detected | STT pod has to be open continuously |
| **Add a separate Silero-based VAD** | Pure speech-present detection | New dependency, more code |
| **Use audio RMS energy** | Trivial to compute | No phoneme awareness, harder to threshold |

**Initially recommended `vad_speech`, but the as-built ships RMS energy.** Closer inspection: reusing the STT pod's `vad_speech` requires keeping the STT WS open and paying full transcription compute we never consume. UltraVAD only exposes `p_end_of_turn` (turn-end prob), not speech-presence. RMS over the same audio frames the recorder and preroll buffer already see is the cheapest signal that behaves like Silero (energy-based VAD with smoothing + threshold). Tradeoff: less phoneme-aware than vad_speech, more sensitive to echo — both addressed by the guards below. We already get these events in `_pump_stt`.

### Component 2: Integration in `voicechat_session`

```python
barge_listener = BargeInListener()
await barge_listener.aopen()  # at session start

# In top-level binary-frame handler (currently line 1728):
if msg.get("bytes"):
    frame = msg["bytes"]
    call_recorder.push_user(frame)
    preroll_buf.append(frame)
    if current_turn and not current_turn.done():
        # In-flight agent reply — feed listener
        barge_listener.push_audio(frame)
    continue

# When a turn opens (StreamingTurnSession created):
await barge_listener.pause()

# When a turn ends (commit fires, LLM/TTS starts):
await barge_listener.start(on_barge_in=_on_server_barge_in)
```

### Component 3: Cancellation path

```python
async def _on_server_barge_in() -> None:
    """Called by BargeInListener when sustained user speech detected
    during agent reply."""
    # 1. Cancel the in-flight LLM/TTS turn
    await _cancel_current()
    # 2. Tell the client to flush its audio buffer
    with suppress(Exception):
        await ws.send_json({"type": "flush_player"})
    # 3. The frontend will detect speech_start naturally and send
    #    stream_start — opening a new StreamingTurnSession with the
    #    preroll_buf flushed for the leading edge.
```

## The echo problem

When the agent's TTS plays through user's speakers, the mic picks it up. If we feed those frames to BargeInListener, the bot's own voice triggers false barge-ins.

Mitigations (in order of how I'd actually apply them):

1. **Higher threshold during agent reply.** UltraVAD probability needs to exceed e.g. 0.7 for 3 consecutive ticks (~180 ms) before firing. Bot's echo typically scores lower than direct human speech because the room reverberation degrades phoneme clarity.
2. **Respect the existing mic-mute gate.** Skip pushing frames to the listener when `bot_speaking_evt` is set. But this defeats the whole point (gate is set exactly when bot is replying). So instead:
3. **Apply gate only during the first 200 ms of agent reply.** This avoids the loudest part of the bot's "start speaking" transient. After that, accept echo and rely on threshold.
4. **Headphones detection.** If we can detect headphones (no echo loop), drop the threshold. Browser doesn't expose this directly, but `getUserMedia` constraints + echoCancellation hints get us partway.

## Feature flag

Ship behind `VOICE_SERVER_BARGE_IN={on|off}` env var (default `off`). Lets us:
- Enable for internal dogfooding first
- Roll back instantly if echo false-positives spike
- A/B compare user-perceived barge-in latency

## Phasing

| Phase | Scope | Effort |
|---|---|---|
| 1 | BargeInListener class + STT vad_speech reuse | ~half day |
| 2 | Wire into voicechat_session (audio routing, lifecycle) | ~half day |
| 3 | Echo guard (threshold tuning, gate timing) | ~half day |
| 4 | Feature flag + telemetry | ~quarter day |
| 5 | Real-call testing + tuning | ~1 day |

**Total: ~2.5 days.**

## What I want confirmed before starting

1. **Signal source for barge-in detection:** STT pod's `vad_speech` (recommended), separate Silero VAD, or audio RMS?
2. **Echo strategy:** rely on probability threshold alone, or build the gate-timing approach?
3. **Feature flag default:** `off` until tested, or `on` for everyone?

Reply with any of these and I'll start implementing.
