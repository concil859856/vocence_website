/**
 * Voice activity detection — Silero VAD via ``@ricky0123/vad-web``.
 *
 * The library loads a ~1 MB ONNX model (Silero v5) into an
 * AudioWorklet and runs it on every 32 ms frame of mic audio. We
 * receive ``onSpeechStart`` / ``onSpeechEnd`` callbacks; on speech
 * end the library hands us the captured audio buffer.
 *
 * The widget uses VAD for two things:
 *   1. Auto-segmenting always-on conversations (turn ends without
 *      the user clicking "stop").
 *   2. Barge-in: detect that the user started talking during agent
 *      playback so the audio player can fade and the WS client can
 *      send ``cancel``.
 *
 * Tunable parameters match the Studio settings:
 *   • positiveSpeechThreshold 0.55, negativeSpeechThreshold 0.40
 *     give natural hysteresis (start on confidence, end on doubt).
 *   • redemptionMs 450 — silence required before declaring end-of-
 *     turn. Lower = snappier but more accidental cuts.
 *   • minSpeechMs 250 — shorter than this is dropped as noise (lip
 *     smack / mouse click / cough).
 *
 * Backchannel filtering ("uh-huh" shouldn't trigger barge-in) lives
 * one layer up in the Lit component — the VAD just reports timing.
 */

import { MicVAD, utils } from '@ricky0123/vad-web';


export interface VadEvents {
  /** User started speaking. Fires BEFORE we have any audio — used to
   *  trigger barge-in immediately. */
  onSpeechStart?: () => void;
  /** User stopped speaking. In segment mode, carries the captured WAV
   *  bytes + duration so the caller can ship a one-shot. In stream
   *  mode, ``wavBytes`` is empty — the caller has already received
   *  the audio frame-by-frame via ``onPcmFrame``. */
  onSpeechEnd?: (args: { wavBytes: ArrayBuffer; durationMs: number }) => void;
  /** Real-time speech probability (0..1). Drive the mic-level ring
   *  animation off this. */
  onProbability?: (p: number) => void;
  /** Streaming mode only — fires for every ~32 ms audio frame with
   *  raw 16-bit PCM (little-endian, 16 kHz mono) ready to ship over
   *  the WS to the streaming-STT pod. */
  onPcmFrame?: (pcm16le: Uint8Array) => void;
  /** Mic permission denied or hardware unavailable. */
  onError?: (err: Error) => void;
}


export interface VadOptions {
  /** Silence (ms) before declaring end-of-turn. */
  endSilenceMs?: number;
  /** Minimum speech duration to register a turn. */
  minSpeechMs?: number;
  /** Capture mode:
   *   * ``segment`` — buffer until end-of-turn, emit one WAV (legacy).
   *   * ``stream``  — emit every audio frame as PCM via onPcmFrame; the
   *     server-side ensembler decides turn-end.
   *  Default ``segment`` for backward compat. */
  mode?: 'segment' | 'stream';
}


export class VadController {
  private vad: MicVAD | null = null;
  private events: VadEvents;
  private opts: VadOptions;

  constructor(events: VadEvents, opts: VadOptions = {}) {
    this.events = events;
    this.opts = opts;
  }

  /** Start the VAD. Throws on mic permission denial or no audio
   *  device — callers should catch + surface an error message. */
  async start(): Promise<void> {
    if (this.vad) return;
    const endSilenceMs = this.opts.endSilenceMs ?? 450;
    const minSpeechMs = this.opts.minSpeechMs ?? 250;
    const isStream = this.opts.mode === 'stream';
    try {
      this.vad = await MicVAD.new({
        positiveSpeechThreshold: 0.55,
        negativeSpeechThreshold: 0.40,
        // ``@ricky0123/vad-web`` accepts millisecond-based knobs
        // directly — no frame-count math needed.
        redemptionMs: endSilenceMs,
        minSpeechMs: minSpeechMs,
        onSpeechStart: () => {
          this.events.onSpeechStart?.();
        },
        onSpeechEnd: (audio: Float32Array) => {
          if (isStream) {
            // In streaming mode the caller has already received the
            // audio frame-by-frame; just signal end-of-utterance.
            const durationMs = Math.round((audio.length / 16000) * 1000);
            this.events.onSpeechEnd?.({ wavBytes: new ArrayBuffer(0), durationMs });
            return;
          }
          // Segment mode: hand back a complete WAV.
          const wavBytes = encodeWav(audio, 16000);
          const durationMs = Math.round((audio.length / 16000) * 1000);
          this.events.onSpeechEnd?.({ wavBytes, durationMs });
        },
        onFrameProcessed: (probabilities, frame) => {
          // ``isSpeech`` is the 0..1 confidence we want for the
          // mic-level ring animation.
          if (this.events.onProbability) {
            this.events.onProbability(probabilities.isSpeech);
          }
          // Streaming mode: ship every frame as PCM so the server-
          // side ensembler can run. We don't gate on speech vs
          // silence here — the STT pod's own VAD does that and feeds
          // the ensembler. Sending silence frames is also cheap
          // (640 bytes / 20ms = 32 kB/s).
          if (isStream && this.events.onPcmFrame && frame) {
            this.events.onPcmFrame(float32ToPcm16(frame));
          }
        },
      });
      await this.vad.start();
    } catch (err) {
      this.events.onError?.(err as Error);
      throw err;
    }
  }

  /** Stop + free everything. Safe to call multiple times. */
  destroy(): void {
    try {
      this.vad?.pause();
      this.vad?.destroy();
    } catch {
      // ignore
    }
    this.vad = null;
  }
}


/** Encode a Float32Array of audio samples as a RIFF WAV ArrayBuffer.
 *  We need this because the batch STT path on the dashboard backend
 *  accepts WAV; the streaming-STT path (Parakeet pod) will accept raw
 *  PCM frames directly — when that's wired we'll skip this step. */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  // Use the helper from the VAD package if available — it has the
  // same WAV encoder under ``utils.encodeWAV``. Falling back to a
  // hand-rolled encoder if the API changed.
  const enc = (utils as unknown as { encodeWAV?: (s: Float32Array, sr: number) => ArrayBuffer }).encodeWAV;
  if (typeof enc === 'function') {
    return enc(samples, sampleRate);
  }
  return encodeWavManual(samples, sampleRate);
}


function encodeWavManual(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');
  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // PCM samples — clamp to int16 range
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] as number));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return buffer;
}


function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}


/** Convert a Float32Array of audio samples (-1..1) into raw PCM s16le
 *  bytes — the shape the streaming-STT pod expects. */
function float32ToPcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] as number));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return out;
}


/** Base64-encode an ArrayBuffer. Used by the WS client to ship the
 *  captured WAV in the JSON ``voice`` message body. We chunk the
 *  conversion so we don't ``apply`` a huge array to ``String.fromCharCode``
 *  and trip stack limits. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
