/**
 * Streaming PCM16 audio player — Web Audio API + AudioWorklet.
 *
 * The Vocence TTS server emits raw PCM16LE mono frames at 24 kHz in
 * small bursts (~6 frames every 240 ms). We push each frame into a
 * worklet that drains a ring buffer into the speakers.
 *
 * Mirrors the dashboard's ``app/src/lib/voicechat/audioPlayer.ts`` so
 * playback behaviour is consistent between Studio and the widget:
 *
 *   • Prebuffer ~1500 ms before starting playback (cold-start cushion
 *     to ride out inter-burst gaps without underrun).
 *
 *   • For "filler" sentences (the server emits "Hmm," / "Okay," to
 *     mask LLM latency) drop the prebuffer to 80 ms so the filler
 *     actually starts playing while the LLM is still thinking.
 *
 *   • On barge-in, fade the gain to silence over 150 ms then flush
 *     the queue. Avoids the click of a hard cut and matches what
 *     ElevenLabs / OpenAI Realtime do.
 *
 * The AudioWorklet processor lives inline as a string literal so we
 * don't need a second HTTP fetch for it — important for the widget's
 * "one round trip" embed promise.
 */

const SAMPLE_RATE = 24_000;
const DEFAULT_PREBUFFER_MS = 1500;
const FILLER_PREBUFFER_MS = 80;
const BARGE_IN_FADE_MS = 150;

const WORKLET_SOURCE = `
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._cursor = 0;
    this._stopped = false;
    this._playing = false;
    this._prebufferSamples = 0;
    this._queued = 0;
    this.port.onmessage = (ev) => {
      const d = ev.data;
      if (!d) return;
      if (d.type === 'push') {
        this._chunks.push(d.pcm);
        this._queued += d.pcm.length;
        if (!this._playing && this._queued >= this._prebufferSamples) {
          this._playing = true;
          this.port.postMessage({ type: 'playing' });
        }
      } else if (d.type === 'config') {
        this._prebufferSamples = d.prebufferSamples;
      } else if (d.type === 'set_prebuffer') {
        this._prebufferSamples = d.samples;
      } else if (d.type === 'flush') {
        this._chunks = [];
        this._cursor = 0;
        this._queued = 0;
        this._playing = false;
        this.port.postMessage({ type: 'idle' });
      } else if (d.type === 'end') {
        this._stopped = true;
      } else if (d.type === 'stop') {
        this._stopped = true;
      }
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    if (!this._playing) {
      out.fill(0);
      return true;
    }
    let i = 0;
    while (i < out.length) {
      if (this._chunks.length === 0) {
        // Drain — fill the rest with silence. If end signalled,
        // emit one 'idle' so the host can update state.
        out.fill(0, i);
        if (this._stopped) {
          this._playing = false;
          this.port.postMessage({ type: 'idle' });
          this._stopped = false;
        }
        return true;
      }
      const chunk = this._chunks[0];
      const n = Math.min(chunk.length - this._cursor, out.length - i);
      out.set(chunk.subarray(this._cursor, this._cursor + n), i);
      this._cursor += n;
      this._queued -= n;
      i += n;
      if (this._cursor >= chunk.length) {
        this._chunks.shift();
        this._cursor = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-player', PcmPlayer);
`;


export interface PlayerEvents {
  /** Fires when the queue has fully drained and playback is idle. The
   *  widget uses this to drop back to ``listening`` state when the
   *  agent's audio finishes. */
  onIdle?: () => void;
  /** Fires once on the transition from prebuffering to actually
   *  emitting samples. Useful for paced text reveal. */
  onPlayingStart?: () => void;
}


export class StreamingAudioPlayer {
  private ctx: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;
  private outputRate = SAMPLE_RATE;
  private prebufferMs: number;
  private events: PlayerEvents;

  constructor(events: PlayerEvents = {}, prebufferMs: number = DEFAULT_PREBUFFER_MS) {
    this.events = events;
    this.prebufferMs = prebufferMs;
  }

  /** Open the AudioContext, load the worklet, and connect the audio
   *  graph. MUST be called from a user gesture (click/tap) on Safari
   *  — autoplay policy refuses to start an AudioContext otherwise.
   *  The widget already opens the player on the user's click of the
   *  launcher, so we're inside a user gesture by construction. */
  async init(): Promise<void> {
    if (this.ctx) return;
    // Try to negotiate the native 24kHz; fall back to the system rate
    // (browsers can refuse arbitrary rates and re-sample for us).
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
    } catch {
      ctx = new AudioContext();
    }
    this.ctx = ctx;
    this.outputRate = ctx.sampleRate;

    const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.worklet = new AudioWorkletNode(ctx, 'pcm-player', {
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    this.worklet.port.onmessage = (e) => {
      const d = e.data;
      if (d?.type === 'idle' && this.events.onIdle) this.events.onIdle();
      if (d?.type === 'playing' && this.events.onPlayingStart) this.events.onPlayingStart();
    };
    const prebufferSamples = Math.round((this.prebufferMs / 1000) * this.outputRate);
    this.worklet.port.postMessage({ type: 'config', prebufferSamples });

    // worklet → gainNode → destination, so barge-in fade has somewhere
    // to apply the ramp without re-wiring the graph mid-cancel.
    this.gainNode = ctx.createGain();
    this.gainNode.gain.value = 1.0;
    this.worklet.connect(this.gainNode);
    this.gainNode.connect(ctx.destination);

    if (ctx.state === 'suspended') {
      try {
        await ctx.resume();
      } catch {
        // Will auto-resume on the next user gesture; not fatal.
      }
    }
  }

  /** Push one PCM16LE mono chunk (network frame) into the player.
   *  The chunk is normalised to float32 and resampled to the output
   *  rate before queuing. */
  push(pcm16: ArrayBuffer): void {
    if (!this.worklet) return;
    const i16 = new Int16Array(pcm16);
    let f32: Float32Array;
    if (this.outputRate === SAMPLE_RATE) {
      f32 = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f32[i] = (i16[i] as number) / 32768;
    } else {
      const ratio = this.outputRate / SAMPLE_RATE;
      const outLen = Math.floor(i16.length * ratio);
      f32 = new Float32Array(outLen);
      // Cheap linear-rate interpolation. Good enough for speech; we
      // never go between drastically different rates in practice
      // (24kHz → 44.1/48kHz are the only paths we see).
      for (let i = 0; i < outLen; i++) {
        const srcIdx = i / ratio;
        const a = i16[Math.floor(srcIdx)] ?? 0;
        const b = i16[Math.min(i16.length - 1, Math.ceil(srcIdx))] ?? 0;
        const t = srcIdx - Math.floor(srcIdx);
        f32[i] = ((1 - t) * a + t * b) / 32768;
      }
    }
    this.worklet.port.postMessage({ type: 'push', pcm: f32 }, [f32.buffer]);
  }

  /** Drop everything queued, with a 150 ms fade-out for smoothness.
   *  Sequence:
   *    1. Ramp GainNode from current → ~0 over BARGE_IN_FADE_MS
   *    2. Send flush to the worklet
   *    3. Ramp gain back to 1.0 over 5 ms so subsequent audio starts
   *       at full volume without a click
   *  Same pattern as the Studio audioPlayer.ts — see comments there. */
  flush(): void {
    if (this.ctx && this.gainNode) {
      const fadeSec = BARGE_IN_FADE_MS / 1000;
      const now = this.ctx.currentTime;
      const g = this.gainNode.gain;
      try { g.cancelScheduledValues(now); } catch { /* ignore */ }
      try { g.setValueAtTime(g.value, now); } catch { /* ignore */ }
      g.linearRampToValueAtTime(0.0001, now + fadeSec);
      window.setTimeout(() => {
        this.worklet?.port.postMessage({ type: 'flush' });
        if (this.ctx && this.gainNode) {
          const t = this.ctx.currentTime;
          try { this.gainNode.gain.cancelScheduledValues(t); } catch { /* ignore */ }
          try { this.gainNode.gain.setValueAtTime(0.0001, t); } catch { /* ignore */ }
          this.gainNode.gain.linearRampToValueAtTime(1.0, t + 0.005);
        }
      }, BARGE_IN_FADE_MS);
    } else {
      this.worklet?.port.postMessage({ type: 'flush' });
    }
    this.setPrebufferMs(this.prebufferMs);
  }

  /** Adjust the prebuffer for the next buffering session. The server
   *  signals a filler sentence via ``audio_meta.is_filler=true``; on
   *  those we drop to a tiny prebuffer so the filler actually plays
   *  while the LLM is still composing the real reply. */
  setPrebufferMs(ms: number): void {
    if (!this.worklet) return;
    const useMs = Math.max(0, ms);
    const samples = Math.round((useMs / 1000) * this.outputRate);
    this.worklet.port.postMessage({ type: 'set_prebuffer', samples });
  }

  /** Lower prebuffer for filler audio (the "Hmm," masking the LLM). */
  setFillerPrebuffer(): void {
    this.setPrebufferMs(FILLER_PREBUFFER_MS);
  }

  /** Restore the default prebuffer for real-reply audio. */
  setDefaultPrebuffer(): void {
    this.setPrebufferMs(this.prebufferMs);
  }

  /** Tell the player no more frames are coming. When the queue
   *  finishes draining, ``onIdle`` will fire instead of waiting for
   *  more input. */
  signalEnd(): void {
    this.worklet?.port.postMessage({ type: 'end' });
  }

  /** Close + free everything. */
  async close(): Promise<void> {
    try {
      this.worklet?.port.postMessage({ type: 'stop' });
      this.worklet?.disconnect();
    } catch { /* ignore */ }
    try {
      this.gainNode?.disconnect();
    } catch { /* ignore */ }
    this.worklet = null;
    this.gainNode = null;
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch { /* ignore */ }
      this.ctx = null;
    }
  }
}
