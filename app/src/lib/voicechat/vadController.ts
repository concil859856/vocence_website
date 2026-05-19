/**
 * VAD controller — wraps `@ricky0123/vad-web` (Silero VAD) into a small
 * event-driven controller for the always-on voice chat.
 *
 * Lifecycle:
 *   start() → mic opens, VAD model loads, controller starts emitting
 *     onSpeechStart / onSpeechEnd events.
 *   pause() / resume() → soft-disable VAD without releasing the mic.
 *   destroy() → tear everything down (used on panel close / unmount).
 *
 * Audio handling: Silero VAD operates on 16 kHz mono Float32 frames. When
 * a speech segment ends, the library hands us the full Float32Array of
 * captured samples (without the leading/trailing silence). We encode it
 * to a 16 kHz mono PCM16 WAV and base64 it for the WS upload. The
 * voicechat backend already accepts WAV (`audio_b64` + `mime`).
 *
 * Barge-in lock: callers can call `lockSpeechStartFor(ms)` after the
 * agent starts speaking. While that window is active, onSpeechStart is
 * dropped — this prevents the agent's own first syllable bleeding
 * through cheap speakers and being misread as a user interrupt before
 * echo cancellation has settled.
 */

// MicVAD + onnxruntime-web are large (~MB of WASM + model). Dynamic-
// import them inside `start()` so they're only fetched when the user
// actually opens a voice chat — keeps the cold-start bundle lean for
// users who never interact with Logos or an agent.
import type { MicVAD as MicVADType } from '@ricky0123/vad-web';

const VAD_SAMPLE_RATE = 16_000;

// Where the VAD worklet/model/onnx files are served from. We copy these
// into /public/vad at install time so the browser can fetch them from
// the same origin (no CORS hop, no CDN dependency).
const VAD_ASSET_BASE = '/vad/';

export interface VadEvents {
  /** Speech onset detected. Treat as user-is-talking — barge-in here. */
  onSpeechStart?: () => void;
  /** Speech segment captured. `wavBytes` is a complete 16 kHz mono PCM16
   * WAV (with RIFF header), already base64-encodable. Submit it as a
   * voice turn. */
  onSpeechEnd?: (segment: { wavBytes: ArrayBuffer; durationMs: number }) => void;
  /** Continuous speech probability (0..1) — useful for a live indicator. */
  onProbability?: (p: number) => void;
  /** Permanent setup failure (mic permission denied, model fetch failed,
   * worklet crashed). The controller will not recover; caller should
   * surface to the user and disable always-on mode. */
  onError?: (err: Error) => void;
}

export interface VadOptions {
  /** Silence (in ms) the user must hold before we consider speech over.
   * Shorter = snappier but cuts off mid-sentence pauses; longer = more
   * natural but adds latency before the bot responds. */
  endSilenceMs?: number;
  /** Min duration of speech to count as a real turn. Below this, the
   * segment is dropped silently (filters cough, single-word noise,
   * etc.). */
  minSpeechMs?: number;
}

export class VadController {
  private vad: MicVADType | null = null;
  private events: VadEvents;
  private opts: Required<VadOptions>;
  private paused = false;
  private lockUntil = 0;

  constructor(events: VadEvents, opts: VadOptions = {}) {
    this.events = events;
    this.opts = {
      endSilenceMs: opts.endSilenceMs ?? 350,
      minSpeechMs: opts.minSpeechMs ?? 250,
    };
  }

  /** Kick off the controller. Returns once the mic is open and the model
   * is loaded — that may take 200-800ms on first load (ONNX warmup). */
  async start(): Promise<void> {
    if (this.vad) return;
    try {
      // Lazy-loaded so the ONNX runtime + Silero model only land on
      // first voice-chat open, not in the initial bundle.
      const { MicVAD } = await import('@ricky0123/vad-web');

      this.vad = await MicVAD.new({
        model: 'v5',
        // Resolve relative to deployment origin so dev + prod both work.
        baseAssetPath: VAD_ASSET_BASE,
        onnxWASMBasePath: VAD_ASSET_BASE,
        // Force single-threaded ORT. Multi-threaded mode spawns a
        // Worker pointed at ort-wasm-simd-threaded.mjs, which Vite's
        // dev server refuses to load from /public via the module
        // pipeline. Silero VAD inference is ~1 ms per 32 ms frame on
        // the main thread — threading buys nothing here and removes
        // the dev-server fight. Also flip off the wasm proxy so the
        // model runs in the page instead of an extra worker.
        ortConfig: (ort) => {
          ort.env.wasm.numThreads = 1;
          ort.env.wasm.proxy = false;
          ort.env.wasm.wasmPaths = VAD_ASSET_BASE;
        },
        // Slightly more permissive thresholds than the library default —
        // we want barge-in to feel snappy, false-trigger rate is
        // controlled by the post-speak lock window in the caller.
        positiveSpeechThreshold: 0.55,
        negativeSpeechThreshold: 0.40,
        // The lib v0.0.30 API takes durations in milliseconds; it does
        // the frame conversion internally (Silero v5 ≈ 32 ms frames).
        redemptionMs: this.opts.endSilenceMs,
        minSpeechMs: this.opts.minSpeechMs,
        // Caller-supplied MediaStream so we can apply echo cancellation,
        // noise suppression, and AGC — without these the agent hears
        // itself through laptop speakers and self-interrupts. The lib
        // (v0.0.30) wires whatever stream this returns into its
        // AudioContext, so the constraints stick for the whole session.
        getStream: () => navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        }),
        onFrameProcessed: (probabilities) => {
          if (this.paused) return;
          this.events.onProbability?.(probabilities.isSpeech ?? 0);
        },
        onSpeechStart: () => {
          if (this.paused) return;
          if (Date.now() < this.lockUntil) return;
          this.events.onSpeechStart?.();
        },
        onSpeechEnd: (audio: Float32Array) => {
          if (this.paused) return;
          if (audio.length < (this.opts.minSpeechMs / 1000) * VAD_SAMPLE_RATE) return;
          const wavBytes = encodeWav(audio, VAD_SAMPLE_RATE);
          const durationMs = Math.round((audio.length / VAD_SAMPLE_RATE) * 1000);
          this.events.onSpeechEnd?.({ wavBytes, durationMs });
        },
      });
      this.vad.start();
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  }

  /** Soft-disable VAD without releasing the mic. Use this while the
   * client is uploading / waiting on the model / playing TTS, when you
   * don't want barge-in to fire. Resume with `resume()`. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  /** Drop onSpeechStart events for the next `ms` milliseconds. Used
   * right after the agent's audio actually starts playing — gives the
   * browser's echo canceller a moment to settle before we trust the mic
   * to distinguish the user from the agent's own voice. */
  lockSpeechStartFor(ms: number): void {
    this.lockUntil = Math.max(this.lockUntil, Date.now() + ms);
  }

  isPaused(): boolean {
    return this.paused;
  }

  async destroy(): Promise<void> {
    if (!this.vad) return;
    try {
      this.vad.pause();
      this.vad.destroy();
    } catch {
      // ignore — best-effort teardown
    }
    this.vad = null;
  }
}

/** Encode a Float32 PCM mono buffer to a 16-bit PCM WAV (with RIFF
 * header). Used to convert Silero's captured speech segment into the
 * format the voicechat backend's STT accepts. */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  // RIFF header
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(view, 8, 'WAVE');
  // fmt chunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);                // chunk size
  view.setUint16(20, 1, true);                 // PCM format
  view.setUint16(22, 1, true);                 // 1 channel (mono)
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);    // byte rate (16-bit mono)
  view.setUint16(32, 2, true);                 // block align
  view.setUint16(34, 16, true);                // bits per sample
  // data chunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  // PCM samples (clamped, scaled to int16)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return bytes;
}

function writeAscii(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  // Chunked to avoid String.fromCharCode argument-count limits on big
  // buffers — 8KB at a time stays well below every browser's cap.
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
