/**
 * Low-latency PCM16 streaming player for the voice-chat bot.
 *
 * The server emits raw PCM16 LE mono frames at SAMPLE_RATE (24 kHz). We
 * push each frame into an AudioWorklet that drains a ring buffer into the
 * audio output. AudioContext is created at 24 kHz when the browser allows
 * it; otherwise we fall back to the system rate and let the worklet do a
 * cheap linear-rate adjust at push time.
 *
 * **Prebuffering**: the streaming TTS server delivers frames in small
 * bursts. If we drained as soon as the first frame arrived, any gap
 * between bursts would empty the queue and the user would hear
 * stuttering. We hold playback until ``prebufferMs`` of audio is queued,
 * then play through continuously without re-buffering. After the first
 * turn the buffer stays comfortably full because the decoder generates
 * faster than realtime on H100-class hardware.
 */

const SAMPLE_RATE = 24000;
// The streaming server emits frames in chunks (EMIT_FRAMES=6 → ~240 ms of
// audio per burst) with variable inter-burst gaps that have been observed
// up to ~1.0 s. The previous 1500 ms safety floor was too generous —
// it pinned every voice-turn perceived latency at 1.5 s on top of LLM
// TTFT + TTS TTFA, making "complete sentence → response" feel ~2.5-3 s
// even when every other stage was fast.
//
// 700 ms is a deliberate trade: it covers the typical 240-500 ms inter-
// burst gap with margin but doesn't cover the rare 1 s worst case. If
// audio stutters reappear, bump this back up (or make it dynamic — flow
// control on burst-arrival rate would be the real fix).
const DEFAULT_PREBUFFER_MS = 700;
// Mid-stream rebuffering is DISABLED (FLOOR=0). Reason: the server
// delivers frames at near-real-time pace (Qwen3 TTS doesn't run faster
// than realtime on the streaming endpoint), so the queue spends most
// of its life near the floor. With any non-zero floor, the player
// thrashes: drain to floor → pause → refill to RESUME → drain again
// → pause → ... up to 4-5 times per second. The user hears that
// thrashing as "broken / glitchy audio", far worse than the brief
// natural silence that occurs if the queue genuinely empties for a
// few ms (which the worklet handles by outputting zeros).
//
// If the TTS server ever stalls for >>100 ms, the worklet outputs
// silence for that duration. That sounds like a tiny micro-pause —
// unnoticeable, much better than the rebuffer-thrash pattern.
//
// Earlier values tried: 200/400 (too aggressive, fired on every
// inter-sentence gap), 80/200 (less aggressive but still thrashed
// continuously once the prebuffer cushion was drained).
const REBUFFER_FLOOR_MS = 0;
const REBUFFER_RESUME_MS = 200;

// Fade-out duration applied to TTS output on barge-in. Hard-cutting the
// audio mid-syllable produces an audible click and feels jarring, every
// SOTA voice agent (OpenAI Realtime, ElevenLabs, Pipecat) fades to silence
// over ~100–200 ms instead. We use 150 ms: fast enough that the agent
// clearly stops, slow enough that there's no click. Kept short so the user
// doesn't keep hearing the agent while they're already mid-sentence.
// Tightened from 150 → 80 ms so the user hears the agent stop almost
// instantly on a barge-in. 80 ms is still long enough to mask the
// discontinuity (a hard cut would click), short enough that it feels
// near-immediate against natural reaction time.
const BARGE_IN_FADE_MS = 80;

const WORKLET_SOURCE = `
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._cursor = 0;
    this._stopped = false;
    this._queuedSamples = 0;
    // Three states: 'buffering' (output silence, accumulating frames),
    // 'playing' (drain normally), 'rebuffering' (drained too low, hold
    // until refilled to avoid worse stutter).
    this._state = 'buffering';
    this._prebufferSamples = 0;
    this._rebufferFloorSamples = 0;
    this._rebufferResumeSamples = 0;
    this._endSignaled = false;  // true after caller signals end-of-stream
    // Fires the 'drained' message exactly once per turn, the first
    // time the queue empties out after 'end' is signaled. Without
    // this latch the worklet would repeatedly post 'drained' every
    // process() call after the queue empties, spamming the WS.
    // NB: backticks would terminate WORKLET_SOURCE's template literal,
    // so single quotes for emphasis here, NOT doubled-backticks.
    this._drainedFired = false;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.type === 'push' && d.pcm) {
        this._chunks.push(d.pcm);
        this._queuedSamples += d.pcm.length;
        // Transition to 'playing' under either condition:
        //   • normal: prebuffer has filled
        //   • the stream has ended and we have ANY audio, for very short
        //     replies ("Awesome!", "Hey") the entire reply may be smaller
        //     than the prebuffer threshold, in which case waiting for the
        //     full prebuffer would mean playback NEVER starts.
        if (this._state === 'buffering' && (
          this._queuedSamples >= this._prebufferSamples
          || (this._endSignaled && this._queuedSamples > 0)
        )) {
          this._state = 'playing';
          this.port.postMessage({ type: 'playing' });
        } else if (this._state === 'rebuffering' && this._queuedSamples >= this._rebufferResumeSamples) {
          // Mid-stream recovery uses a much smaller resume target than the
          // initial prebuffer, we just need enough to bridge the next
          // inter-sentence gap, not the full cold-start cushion.
          this._state = 'playing';
          this.port.postMessage({ type: 'playing' });
        }
      } else if (d.type === 'flush') {
        this._chunks = [];
        this._cursor = 0;
        this._queuedSamples = 0;
        this._state = 'buffering';
        this._endSignaled = false;
        // Reset the once-per-turn drained latch — the next turn is a
        // fresh window with its own drained event.
        this._drainedFired = false;
      } else if (d.type === 'config') {
        if (typeof d.prebufferSamples === 'number') {
          this._prebufferSamples = d.prebufferSamples;
        }
        if (typeof d.rebufferFloorSamples === 'number') {
          this._rebufferFloorSamples = d.rebufferFloorSamples;
        }
        if (typeof d.rebufferResumeSamples === 'number') {
          this._rebufferResumeSamples = d.rebufferResumeSamples;
        }
      } else if (d.type === 'set_prebuffer') {
        // Adjust the prebuffer target on the fly. Used when a filler
        // sentence is about to arrive: dropping to ~80 ms lets the filler
        // start playing immediately so it actually masks LLM latency
        // instead of being hidden inside the cold-start cushion.
        if (typeof d.samples === 'number') {
          this._prebufferSamples = d.samples;
          // If we're already buffering AND the queue is now past the new
          // (lower) threshold, flip straight to playing.
          if (this._state === 'buffering' && this._queuedSamples >= this._prebufferSamples) {
            this._state = 'playing';
            this.port.postMessage({ type: 'playing' });
          }
        }
      } else if (d.type === 'end') {
        // Caller declares the stream complete. Once the queue drains we
        // don't try to rebuffer, there are no more frames coming.
        this._endSignaled = true;
        // Edge case: the entire reply may have been shorter than the
        // prebuffer threshold (very short audio like "Awesome!"). In
        // that case we're still in 'buffering' with audio queued but
        // never enough to flip to 'playing'. The end signal is our cue
        // to play whatever's there.
        if (this._state === 'buffering' && this._queuedSamples > 0) {
          this._state = 'playing';
          this.port.postMessage({ type: 'playing' });
        }
      } else if (d.type === 'stop') {
        this._stopped = true;
      }
    };
  }

  process(_inputs, outputs) {
    const channel = outputs[0][0];
    if (!channel) return true;

    // While buffering or rebuffering, just output silence.
    if (this._state !== 'playing') {
      for (let i = 0; i < channel.length; i++) channel[i] = 0;
      return true;
    }

    // Pre-decision: if queue has fallen below the rebuffer floor AND we
    // haven't been told the stream is over, switch back to rebuffering
    // BEFORE outputting silence so we cleanly pause instead of glitch.
    if (
      !this._endSignaled
      && this._rebufferFloorSamples > 0
      && this._queuedSamples < this._rebufferFloorSamples
    ) {
      this._state = 'rebuffering';
      this.port.postMessage({ type: 'rebuffering', queuedMs: this._queuedSamples / sampleRate * 1000 });
      for (let i = 0; i < channel.length; i++) channel[i] = 0;
      return true;
    }

    let i = 0;
    while (i < channel.length) {
      if (!this._chunks.length) {
        for (; i < channel.length; i++) channel[i] = 0;
        if (this._stopped) {
          this.port.postMessage({ type: 'idle' });
        }
        // Once the queue is empty AND the caller has signaled the
        // stream is over, the speakers will produce their final
        // sample within the next few buffer-quanta. Emit 'drained'
        // exactly once so the host can tell the server the audio
        // tail is gone, which is what releases the server's mic-
        // mute gate without timer estimation.
        if (this._endSignaled && !this._drainedFired) {
          this._drainedFired = true;
          this.port.postMessage({ type: 'drained' });
        }
        break;
      }
      const head = this._chunks[0];
      const remaining = head.length - this._cursor;
      const take = Math.min(remaining, channel.length - i);
      for (let k = 0; k < take; k++) channel[i + k] = head[this._cursor + k];
      this._cursor += take;
      this._queuedSamples -= take;
      i += take;
      if (this._cursor >= head.length) {
        this._chunks.shift();
        this._cursor = 0;
        this.port.postMessage({ type: 'progress', remainingChunks: this._chunks.length });
      }
    }
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
`;

export interface AudioPlayerEvents {
  onIdle?: () => void;
  /** Fired when the prebuffer fills and playback actually starts. */
  onPlayingStart?: () => void;
  /** Fired when playback pauses to wait for more frames. The argument is
   * how much audio (in ms) was still queued at the moment of the pause —
   * useful for diagnosing how often / how badly underruns happen. */
  onRebuffering?: (queuedMs: number) => void;
  /** Fired the FIRST time audio actually starts playing for a turn. The
   * server's mic-mute gate latches on this so it knows the bot's voice
   * has reached the speakers — anything the mic picks up between this
   * event and ``onSettled`` is potentially echo. Unlike
   * ``onPlayingStart`` (which fires every time the worklet exits a
   * rebuffer pause), this fires exactly once per turn. */
  onAudioStarted?: () => void;
  /** Fired when the bot's audio is genuinely gone from the speakers —
   * either the queue drained after the server signaled turn_end, or
   * the barge-in fade completed and the queue was flushed. The server
   * releases its mic-mute gate on this event. Fires at most once per
   * turn (resets on the next ``onAudioStarted``). */
  onSettled?: () => void;
}

export interface AudioPlayerOptions {
  /** Milliseconds of audio to queue before playback starts. Default 800 ms.
   * Higher = smoother across bursty streams, slower perceived TTFA.
   * Lower  = faster start, more risk of mid-stream stutter. */
  prebufferMs?: number;
}

export class StreamingAudioPlayer {
  private ctx: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  // GainNode sits between the worklet and the audio output so we can
  // ramp gain → 0 on barge-in for a smooth fade-out instead of a hard
  // mid-syllable cut. The worklet's flush still drops queued audio
  // immediately, but the fade hides the discontinuity.
  private gainNode: GainNode | null = null;
  private outputRate = SAMPLE_RATE;
  private events: AudioPlayerEvents;
  private workletReady: Promise<void> | null = null;
  private prebufferMs: number;
  // Per-turn latches for the audio-lifecycle callbacks.
  //   audioStartedFired - gates onAudioStarted to once-per-turn (vs. the
  //                       worklet's 'playing' message that also fires on
  //                       rebuffer recoveries).
  //   settledFired      - gates onSettled so a worklet 'drained' after a
  //                       barge-in fade doesn't double-fire on top of the
  //                       fade's settled emission.
  //   turnFirstPushSeen - true between push() of a turn's first frame and
  //                       the next flush()/signalEnd. Used to detect when
  //                       a NEW turn begins so the audioStartedFired latch
  //                       can re-arm even if the prior turn's settled was
  //                       lost (which would otherwise leave audioStartedFired
  //                       stuck true forever and prevent onAudioStarted
  //                       from re-firing on subsequent turns).
  private audioStartedFired = false;
  private settledFired = false;
  private turnFirstPushSeen = false;

  constructor(events: AudioPlayerEvents = {}, options: AudioPlayerOptions = {}) {
    this.events = events;
    this.prebufferMs = Math.max(0, options.prebufferMs ?? DEFAULT_PREBUFFER_MS);
  }

  async init(): Promise<void> {
    if (this.ctx) return;
    let ctx: AudioContext;
    try {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: SAMPLE_RATE });
    } catch {
      ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    this.ctx = ctx;
    this.outputRate = ctx.sampleRate;

    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      this.workletReady = ctx.audioWorklet.addModule(url);
      await this.workletReady;
    } finally {
      URL.revokeObjectURL(url);
    }

    this.worklet = new AudioWorkletNode(ctx, 'pcm-player', { numberOfOutputs: 1, outputChannelCount: [1] });
    this.worklet.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.type === 'idle' && this.events.onIdle) this.events.onIdle();
      if (d.type === 'playing') {
        if (this.events.onPlayingStart) this.events.onPlayingStart();
        // Once-per-turn audio_started: only emit on the first
        // ``playing`` after a flush/init. Subsequent rebuffer-recover
        // ``playing`` messages don't re-fire (the audio gate on the
        // server is already latched).
        if (!this.audioStartedFired) {
          this.audioStartedFired = true;
          this.events.onAudioStarted?.();
        }
      }
      if (d.type === 'rebuffering' && this.events.onRebuffering) {
        this.events.onRebuffering(typeof d.queuedMs === 'number' ? d.queuedMs : 0);
      }
      if (d.type === 'drained') {
        // The worklet's queue is empty AND signalEnd() was called —
        // the bot's audio tail is gone. Fire onSettled exactly once
        // per turn AND mark the turn boundary so the next push()
        // re-arms the latches.
        if (!this.settledFired) {
          this.settledFired = true;
          this.events.onSettled?.();
        }
        this.turnFirstPushSeen = false;
      }
    };
    // Configure both thresholds in OUTPUT-rate samples (push() resamples
    // to outputRate before queuing, and the worklet tracks queued count
    // post-resample, so prebuffer/floor must use outputRate too).
    const prebufferSamples = Math.round((this.prebufferMs / 1000) * this.outputRate);
    const rebufferFloorSamples = Math.round((REBUFFER_FLOOR_MS / 1000) * this.outputRate);
    const rebufferResumeSamples = Math.round((REBUFFER_RESUME_MS / 1000) * this.outputRate);
    this.worklet.port.postMessage({
      type: 'config',
      prebufferSamples,
      rebufferFloorSamples,
      rebufferResumeSamples,
    });
    // worklet → gainNode → destination so the fade-out logic in
    // ``flush()`` has somewhere to apply the ramp without re-wiring
    // the graph at barge-in time.
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = 1.0;
    this.worklet.connect(this.gainNode);
    this.gainNode.connect(ctx.destination);

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // ignore, will auto-resume on next user gesture
      }
    }
  }

  /** Push one PCM16 LE mono chunk (server frame) into the player. */
  push(pcm16: ArrayBuffer): void {
    if (!this.worklet) return;
    // Re-arm the per-turn latches on the FIRST push of a new turn.
    //
    // The "new turn" boundary is: turnFirstPushSeen flipped false by a
    // prior flush() or signalEnd, and now we're seeing the first push
    // since. This works even if the prior turn's settled was lost
    // (which the old "reset only when settledFired" rule did NOT — it
    // would leave audioStartedFired stuck true and the new turn's
    // onAudioStarted would silently skip).
    if (!this.turnFirstPushSeen) {
      this.turnFirstPushSeen = true;
      this.audioStartedFired = false;
      this.settledFired = false;
    }
    const i16 = new Int16Array(pcm16);
    let f32: Float32Array;
    if (this.outputRate === SAMPLE_RATE) {
      f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    } else {
      const ratio = this.outputRate / SAMPLE_RATE;
      const outLen = Math.floor(i16.length * ratio);
      f32 = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const srcIdx = i / ratio;
        const a = i16[Math.floor(srcIdx)] || 0;
        const b = i16[Math.min(i16.length - 1, Math.ceil(srcIdx))] || 0;
        const t = srcIdx - Math.floor(srcIdx);
        f32[i] = ((1 - t) * a + t * b) / 32768;
      }
    }
    this.worklet.port.postMessage({ type: 'push', pcm: f32 }, [f32.buffer]);
  }

  /** Drop everything queued (barge-in).
   *
   * Sequence:
   *   1. Ramp the GainNode from current → 0 over BARGE_IN_FADE_MS so
   *      whatever is already in the audio output buffer fades smoothly
   *      to silence (no click / no mid-syllable cut).
   *   2. After the fade completes, send ``flush`` to the worklet to
   *      drop everything still in the queue.
   *   3. Schedule the gain to ramp back to 1.0 just before the next
   *      ``push`` is likely to land, so subsequent audio plays at
   *      normal level. A 5 ms ramp avoids a click on the way back up.
   *
   * If no AudioContext is available (init never ran or already closed),
   * fall back to the old behaviour, just send the flush. */
  flush(): void {
    if (this.ctx && this.gainNode) {
      const fadeSec = BARGE_IN_FADE_MS / 1000;
      const now = this.ctx.currentTime;
      const g = this.gainNode.gain;
      // Cancel anything pending, anchor the current value, then ramp down.
      try { g.cancelScheduledValues(now); } catch { /* ignore */ }
      try { g.setValueAtTime(g.value, now); } catch { /* ignore */ }
      g.linearRampToValueAtTime(0.0001, now + fadeSec);
      // After the fade, drop the queue and ramp gain back up so the
      // next sentence starts at full volume. The 5ms ramp on the way
      // up prevents a click on the rising edge.
      window.setTimeout(() => {
        this.worklet?.port.postMessage({ type: 'flush' });
        if (this.ctx && this.gainNode) {
          const t = this.ctx.currentTime;
          try { this.gainNode.gain.cancelScheduledValues(t); } catch { /* ignore */ }
          try { this.gainNode.gain.setValueAtTime(0.0001, t); } catch { /* ignore */ }
          this.gainNode.gain.linearRampToValueAtTime(1.0, t + 0.005);
        }
        // ALWAYS fire onSettled when the fade completes. Prior code
        // gated this on ``audioStartedFired`` — which lost the event
        // entirely if barge-in happened during the prebuffer window
        // OR if the latch was stale from a previous broken turn. The
        // server's gate-clear is idempotent, so a redundant settled
        // is a harmless no-op; a MISSING settled locks the mic for
        // up to GATE_MAX_HOLD_S seconds.
        if (!this.settledFired) {
          this.settledFired = true;
          this.events.onSettled?.();
        }
      }, BARGE_IN_FADE_MS);
    } else {
      this.worklet?.port.postMessage({ type: 'flush' });
      if (!this.settledFired) {
        this.settledFired = true;
        this.events.onSettled?.();
      }
    }
    // Mark turn boundary so the NEXT push() re-arms the latches.
    // Without this, audioStartedFired would stay true and the new
    // turn's onAudioStarted would never fire (see push() comment).
    this.turnFirstPushSeen = false;
    // Reset prebuffer to default after a barge-in so the next turn's
    // first content sentence gets the full cold-start cushion.
    this.setPrebufferMs(this.prebufferMs);
  }

  /** Lower the prebuffer threshold for the next buffering session.
   * Called when the backend announces a filler sentence (is_filler=true in
   * audio_meta), the small prebuffer lets the filler start playing
   * immediately so it actually masks LLM latency. Subsequent non-filler
   * sentences should call ``setPrebufferMs(defaultMs)`` to restore the
   * full cushion, though in practice once playback is in 'playing' state
   * no buffering happens until the next flush. */
  setPrebufferMs(ms: number): void {
    if (!this.worklet) return;
    const samples = Math.round((Math.max(0, ms) / 1000) * this.outputRate);
    this.worklet.port.postMessage({ type: 'set_prebuffer', samples });
  }

  /** Tell the player no more frames are coming. After this, when the
   * queue drains, we *don't* enter rebuffering, the audio just ends. */
  signalEnd(): void {
    this.worklet?.port.postMessage({ type: 'end' });
  }

  async close(): Promise<void> {
    try {
      this.worklet?.port.postMessage({ type: 'stop' });
      this.worklet?.disconnect();
    } catch {
      // ignore
    }
    try {
      this.gainNode?.disconnect();
    } catch {
      // ignore
    }
    this.worklet = null;
    this.gainNode = null;
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch {
        // ignore
      }
      this.ctx = null;
    }
  }
}
