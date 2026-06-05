/**
 * Browser audio recorder for the voice-chat bot.
 *
 * Push-to-talk. Records via MediaRecorder (Opus inside webm/ogg), returns
 * a Blob and base64 string when stopped. Includes a tiny RMS meter so the
 * UI can show a live mic level.
 */

export interface RecorderEvents {
  onLevel?: (rms01: number) => void;
}

export class MicRecorder {
  private stream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mimeType = '';
  private analyserCtx: AudioContext | null = null;
  private levelTimer: number | null = null;
  private events: RecorderEvents;
  private resolveStop: ((value: { blob: Blob; base64: string; mimeType: string; durationMs: number }) => void) | null = null;
  private rejectStop: ((reason: unknown) => void) | null = null;
  private startedAt = 0;

  constructor(events: RecorderEvents = {}) {
    this.events = events;
  }

  async start(): Promise<void> {
    if (this.mediaRecorder) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });

    // Pick the best supported mime type
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    this.mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || '';
    this.mediaRecorder = this.mimeType
      ? new MediaRecorder(this.stream, { mimeType: this.mimeType, audioBitsPerSecond: 64000 })
      : new MediaRecorder(this.stream);

    this.chunks = [];
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.mimeType || 'audio/webm' });
      const fr = new FileReader();
      fr.onloadend = () => {
        const dataUrl = String(fr.result || '');
        const comma = dataUrl.indexOf(',');
        const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : '';
        const durationMs = Math.max(0, Date.now() - this.startedAt);
        this.resolveStop?.({ blob, base64, mimeType: this.mimeType || 'audio/webm', durationMs });
        this.cleanup();
      };
      fr.onerror = () => {
        this.rejectStop?.(fr.error);
        this.cleanup();
      };
      fr.readAsDataURL(blob);
    };
    this.mediaRecorder.onerror = (ev) => {
      this.rejectStop?.((ev as any).error || new Error('recorder error'));
      this.cleanup();
    };
    this.mediaRecorder.start(50);
    this.startedAt = Date.now();
    this.attachLevelMeter();
  }

  async stop(): Promise<{ blob: Blob; base64: string; mimeType: string; durationMs: number }> {
    if (!this.mediaRecorder) {
      return Promise.reject(new Error('not recording'));
    }
    return new Promise((resolve, reject) => {
      this.resolveStop = resolve;
      this.rejectStop = reject;
      try {
        this.mediaRecorder?.stop();
      } catch (err) {
        reject(err);
        this.cleanup();
      }
    });
  }

  cancel(): void {
    try {
      this.mediaRecorder?.stop();
    } catch {
      // ignore
    }
    this.cleanup();
  }

  isActive(): boolean {
    return !!this.mediaRecorder && this.mediaRecorder.state === 'recording';
  }

  private attachLevelMeter(): void {
    if (!this.events.onLevel || !this.stream) return;
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.analyserCtx = ctx;
      const src = ctx.createMediaStreamSource(this.stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      src.connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);
        this.events.onLevel?.(Math.min(1, rms * 4));
        this.levelTimer = window.setTimeout(tick, 80);
      };
      tick();
    } catch {
      // ignore meter failures
    }
  }

  private cleanup(): void {
    if (this.levelTimer != null) {
      window.clearTimeout(this.levelTimer);
      this.levelTimer = null;
    }
    if (this.analyserCtx) {
      try { this.analyserCtx.close(); } catch { /* ignore */ }
      this.analyserCtx = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.mediaRecorder = null;
    this.chunks = [];
    this.resolveStop = null;
    this.rejectStop = null;
  }
}
