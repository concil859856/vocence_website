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
// up to ~1.0 s. GPU speed (4090 vs H100) doesn't change this cadence; it
// only changes per-burst compute time. So the safe default is large
// enough that *any* expected gap fits inside the cushion at any moment
// during playback. 1500 ms covers the worst-case observed.
const DEFAULT_PREBUFFER_MS = 1500;
// Mid-stream rebuffering is DISABLED (FLOOR=0). Reason: the server
// delivers frames at near-real-time pace (Qwen3 TTS doesn't run faster
// than realtime on the streaming endpoint), so the queue spends most
// of its life near the floor. With any non-zero floor, the player
// thrashes: drain to floor → pause → refill to RESUME → drain again
// → pause → ... up to 4-5 times per second. The user hears that
// thrashing as "broken / glitchy audio" — far worse than the brief
// natural silence that occurs if the queue genuinely empties for a
// few ms (which the worklet handles by outputting zeros).
//
// If the TTS server ever stalls for >>100 ms, the worklet outputs
// silence for that duration. That sounds like a tiny micro-pause —
// unnoticeable, much better than the rebuffer-thrash pattern.
//
// Earlier values tried: 200/400 (too aggressive — fired on every
// inter-sentence gap), 80/200 (less aggressive but still thrashed
// continuously once the prebuffer cushion was drained).
const REBUFFER_FLOOR_MS = 0;
const REBUFFER_RESUME_MS = 200;

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
    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d) return;
      if (d.type === 'push' && d.pcm) {
        this._chunks.push(d.pcm);
        this._queuedSamples += d.pcm.length;
        // Transition to 'playing' under either condition:
        //   • normal: prebuffer has filled
        //   • the stream has ended and we have ANY audio — for very short
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
          // initial prebuffer — we just need enough to bridge the next
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
      } else if (d.type === 'end') {
        // Caller declares the stream complete. Once the queue drains we
        // don't try to rebuffer — there are no more frames coming.
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
  private outputRate = SAMPLE_RATE;
  private events: AudioPlayerEvents;
  private workletReady: Promise<void> | null = null;
  private prebufferMs: number;

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
      if (d.type === 'playing' && this.events.onPlayingStart) this.events.onPlayingStart();
      if (d.type === 'rebuffering' && this.events.onRebuffering) {
        this.events.onRebuffering(typeof d.queuedMs === 'number' ? d.queuedMs : 0);
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
    this.worklet.connect(ctx.destination);

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // ignore — will auto-resume on next user gesture
      }
    }
  }

  /** Push one PCM16 LE mono chunk (server frame) into the player. */
  push(pcm16: ArrayBuffer): void {
    if (!this.worklet) return;
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

  /** Drop everything queued (barge-in). */
  flush(): void {
    this.worklet?.port.postMessage({ type: 'flush' });
  }

  /** Tell the player no more frames are coming. After this, when the
   * queue drains, we *don't* enter rebuffering — the audio just ends. */
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
    this.worklet = null;
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
