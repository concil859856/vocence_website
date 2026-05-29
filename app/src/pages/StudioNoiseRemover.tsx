import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Upload, Download, Loader2, Mic, Square, Play, Pause, RotateCcw, Sparkles, AlertCircle, Trash2, Clock } from 'lucide-react';
import WaveSurfer from 'wavesurfer.js';
import { useAuth } from '../contexts/AuthContext';
import { API_BASE_URL } from '../services/baseUrl';
import { CREDIT_NOISE_REMOVER, NOISE_REMOVER_MAX_DURATION_SEC, NOISE_REMOVER_MAX_UPLOAD_BYTES } from '../studio/creditCosts';

const MAX_DURATION_SEC = NOISE_REMOVER_MAX_DURATION_SEC;
const MAX_FILE_MB = NOISE_REMOVER_MAX_UPLOAD_BYTES / (1024 * 1024);
const ALLOWED_EXTENSIONS = new Set(['wav', 'mp3', 'm4a', 'mp4', 'ogg', 'flac', 'webm', 'aac']);

function formatTime(sec: number) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(0)} KB`;
}

interface AudioMeta {
  duration: number;
  sampleRate?: number;
  channels?: number;
}

function WavePlayer({ src, label, accent = 'primary', onRemove, meta }: {
  src: string;
  label: string;
  accent?: 'primary' | 'result';
  onRemove?: () => void;
  meta?: { filename?: string; fileSize?: number; audioMeta?: AudioMeta };
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    setReady(false);
    setPlaying(false);
    setCurrent(0);
    setDuration(0);

    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: src,
      height: 56,
      waveColor: accent === 'result'
        ? ['rgba(223,255,0,0.25)', 'rgba(223,255,0,0.10)']
        : ['rgba(255,255,255,0.18)', 'rgba(255,255,255,0.08)'],
      progressColor: accent === 'result'
        ? ['#DFFF00', '#b8e600']
        : ['rgba(255,255,255,0.55)', 'rgba(255,255,255,0.35)'],
      cursorColor: accent === 'result' ? '#DFFF00' : 'rgba(255,255,255,0.4)',
      cursorWidth: 1,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: true,
      dragToSeek: true,
      fillParent: true,
      hideScrollbar: true,
    });
    wsRef.current = ws;

    ws.on('ready', (d) => { setDuration(d); setReady(true); });
    ws.on('audioprocess', (t) => setCurrent(t));
    ws.on('seeking', (t) => setCurrent(t));
    ws.on('finish', () => setPlaying(false));

    return () => { ws.destroy(); wsRef.current = null; };
  }, [src, accent]);

  const toggle = useCallback(() => {
    const ws = wsRef.current;
    if (!ws) return;
    if (playing) { ws.pause(); setPlaying(false); }
    else { ws.play(); setPlaying(true); }
  }, [playing]);

  const isPrimary = accent === 'primary';

  const metaLine = useMemo(() => {
    const parts: string[] = [];
    if (meta?.fileSize) parts.push(formatFileSize(meta.fileSize));
    const dur = meta?.audioMeta?.duration || duration;
    if (dur > 0) parts.push(formatTime(dur));
    if (meta?.audioMeta?.sampleRate) parts.push(`${(meta.audioMeta.sampleRate / 1000).toFixed(1)} kHz`);
    if (meta?.audioMeta?.channels) parts.push(meta.audioMeta.channels === 1 ? 'mono' : 'stereo');
    return parts.join(' · ');
  }, [meta, duration]);

  return (
    <div className={`rounded-2xl border p-4 space-y-3 ${
      isPrimary ? 'border-white/[0.08] bg-white/[0.02]' : 'border-[#DFFF00]/20 bg-[#DFFF00]/[0.03]'
    }`}>
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`text-[10px] uppercase tracking-widest font-semibold ${
            isPrimary ? 'text-[#A7B0B7]' : 'text-[#DFFF00]'
          }`}>{label}</span>
          {meta?.filename && (
            <span className="text-xs text-[#555] truncate max-w-[200px]">{meta.filename}</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-[#555] tabular-nums">
            {formatTime(current)}<span className="text-[#333]"> / </span>{formatTime(duration)}
          </span>
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="p-1 rounded-lg text-[#555] hover:text-red-400/70 hover:bg-red-400/[0.06] transition-colors"
              title="Remove"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Waveform */}
      <div className="relative">
        {!ready && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Loader2 size={16} className="animate-spin text-[#555]" />
          </div>
        )}
        <div ref={containerRef} className={`w-full transition-opacity ${ready ? 'opacity-100' : 'opacity-0'}`} />
      </div>

      {/* Controls row */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          disabled={!ready}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-30 ${
            isPrimary
              ? 'bg-white/[0.06] text-white/70 hover:bg-white/10'
              : 'bg-[#DFFF00]/10 text-[#DFFF00] hover:bg-[#DFFF00]/20'
          }`}
        >
          {playing ? <Pause size={12} /> : <Play size={12} className="ml-0.5" />}
          {playing ? 'Pause' : 'Preview'}
        </button>

        {metaLine && (
          <span className="text-[11px] text-[#555]">{metaLine}</span>
        )}
      </div>
    </div>
  );
}

export function StudioNoiseRemover() {
  const { user, setLocalCredits } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [audioMeta, setAudioMeta] = useState<AudioMeta | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'upload' | 'record'>('upload');
  const [recording, setRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [dragging, setDragging] = useState(false);
  const mrRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    return () => { if (originalUrl) URL.revokeObjectURL(originalUrl); };
  }, [originalUrl]);

  const validateFile = useCallback((f: File): string | null => {
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const mime = f.type.toLowerCase().split(';')[0].trim();
    if (!mime.startsWith('audio/') && !ALLOWED_EXTENSIONS.has(ext)) {
      return `Unsupported format. Accepted: WAV, MP3, M4A, OGG, FLAC, WebM, AAC.`;
    }
    if (f.size > MAX_FILE_MB * 1024 * 1024) {
      return `File exceeds ${MAX_FILE_MB} MB limit.`;
    }
    return null;
  }, []);

  const clearFile = useCallback(() => {
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    setFile(null);
    setOriginalUrl(null);
    setAudioMeta(null);
    setResultUrl(null);
    setLatencyMs(null);
    setError(null);
  }, [originalUrl]);

  const handleFile = useCallback((f: File | null) => {
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    setResultUrl(null);
    setLatencyMs(null);
    setError(null);
    setAudioMeta(null);
    if (f) {
      const err = validateFile(f);
      if (err) { setError(err); setFile(null); setOriginalUrl(null); return; }
      const objUrl = URL.createObjectURL(f);

      const actx = new AudioContext();
      f.arrayBuffer().then((buf) => actx.decodeAudioData(buf)).then((decoded) => {
        actx.close();
        if (decoded.duration > MAX_DURATION_SEC) {
          URL.revokeObjectURL(objUrl);
          setFile(null);
          setOriginalUrl(null);
          setError(`Audio is ${Math.ceil(decoded.duration)}s — max ${MAX_DURATION_SEC}s (${Math.floor(MAX_DURATION_SEC / 60)} minutes).`);
          return;
        }
        setAudioMeta({
          duration: decoded.duration,
          sampleRate: decoded.sampleRate,
          channels: decoded.numberOfChannels,
        });
        setFile(f);
        setOriginalUrl(objUrl);
      }).catch(() => {
        actx.close();
        setFile(f);
        setOriginalUrl(objUrl);
      });
      return;
    }
    setFile(null);
    setOriginalUrl(null);
  }, [originalUrl, validateFile]);

  const startRecording = async () => {
    setError(null);
    handleFile(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const chunks: BlobPart[] = [];
      const mr = new MediaRecorder(stream);
      mrRef.current = mr;
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
        const ext = (mr.mimeType || 'audio/webm').includes('mp4') ? 'mp4' : 'webm';
        handleFile(new File([blob], `recording.${ext}`, { type: blob.type }));
        setRecording(false);
        mrRef.current = null;
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      };
      mr.start();
      setRecording(true);
      setRecordSec(0);
      timerRef.current = setInterval(() => {
        setRecordSec((s) => {
          if (s + 1 >= MAX_DURATION_SEC) {
            if (mrRef.current?.state === 'recording') mrRef.current.stop();
          }
          return s + 1;
        });
      }, 1000);
    } catch {
      setError('Microphone access denied or unavailable.');
    }
  };

  const stopRecording = () => {
    if (mrRef.current?.state === 'recording') mrRef.current.stop();
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setRecording(false);
  };

  const handleSubmit = async () => {
    if (!file || !user) return;
    if ((user.credits ?? 0) < CREDIT_NOISE_REMOVER) {
      setError(`Insufficient credits. Need ${CREDIT_NOISE_REMOVER} credits — you have ${user.credits ?? 0}.`);
      return;
    }
    setError(null);
    setResultUrl(null);
    setLatencyMs(null);
    setLoading(true);

    const token = localStorage.getItem('vocence_token');
    const form = new FormData();
    form.append('user_id', user.id);
    form.append('audio_file', file);

    try {
      const res = await fetch(`${API_BASE_URL}/dashboard/studio/noise-remover/enhance`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `Server error ${res.status}`);
      }

      const data = await res.json();
      setResultUrl(data.audio_url);
      setLatencyMs(data.latency_ms ?? null);
      if (data.credits_remaining != null) {
        setLocalCredits(data.credits_remaining);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Enhancement failed');
    } finally {
      setLoading(false);
    }
  };

  // Page-level drag-and-drop: drop audio anywhere on the page
  const pageRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = pageRef.current;
    if (!el) return;
    let dragCount = 0;
    const onEnter = (e: DragEvent) => { e.preventDefault(); dragCount++; setDragging(true); setMode('upload'); };
    const onLeave = () => { dragCount--; if (dragCount <= 0) { dragCount = 0; setDragging(false); } };
    const onOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCount = 0;
      setDragging(false);
      const dropped = e.dataTransfer?.files?.[0];
      if (dropped?.type.startsWith('audio/')) { setMode('upload'); handleFile(dropped); }
    };
    el.addEventListener('dragenter', onEnter);
    el.addEventListener('dragleave', onLeave);
    el.addEventListener('dragover', onOver);
    el.addEventListener('drop', onDrop);
    return () => {
      el.removeEventListener('dragenter', onEnter);
      el.removeEventListener('dragleave', onLeave);
      el.removeEventListener('dragover', onOver);
      el.removeEventListener('drop', onDrop);
    };
  }, [handleFile]);

  // Keyboard shortcuts: R to re-enhance
  const submitRef = useRef(handleSubmit);
  useEffect(() => { submitRef.current = handleSubmit; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey) {
        if (resultUrl && file && !loading) {
          e.preventDefault();
          submitRef.current();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [resultUrl, file, loading]);

  return (
    <div ref={pageRef} className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-semibold mb-2">Noise Remover</h2>
        <p className="text-[#A7B0B7]">
          Remove background noise and enhance audio clarity. Up to {Math.floor(MAX_DURATION_SEC / 60)} minutes per file.
        </p>
      </div>

      {/* Main card */}
      <div className="card-vocence p-6 space-y-6">
        {/* Upload / Record toggle */}
        <div className="inline-flex rounded-xl border border-white/10 bg-white/[0.03] p-1">
          {([
            { id: 'upload' as const, label: 'Upload file', icon: Upload },
            { id: 'record' as const, label: 'Record now', icon: Mic },
          ]).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => {
                if (recording) stopRecording();
                setMode(m.id);
                if (m.id === 'record') clearFile();
              }}
              className={`inline-flex items-center gap-1.5 px-4 py-1.5 text-sm rounded-lg transition-colors ${
                mode === m.id ? 'bg-white/10 text-white' : 'text-[#A7B0B7] hover:text-white'
              }`}
            >
              <m.icon size={14} />
              {m.label}
            </button>
          ))}
        </div>

        {/* Source zone */}
        {mode === 'upload' ? (
          !file ? (
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.webm"
                className="hidden"
                onChange={(e) => { handleFile(e.target.files?.[0] || null); if (e.target) e.target.value = ''; }}
              />
              <div
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragEnter={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const dropped = e.dataTransfer.files?.[0];
                  if (dropped?.type.startsWith('audio/')) handleFile(dropped);
                }}
                className={`border-2 border-dashed rounded-2xl p-12 text-center transition-colors cursor-pointer ${
                  dragging
                    ? 'border-[#DFFF00] bg-[#DFFF00]/10'
                    : 'border-white/10 hover:border-white/20'
                }`}
              >
                <Upload size={40} className="mx-auto mb-4 text-[#666]" />
                <p className="mb-2">
                  Drag and drop audio files or{' '}
                  <span className="text-[#DFFF00]">browse</span>
                </p>
                <p className="text-sm text-[#666]">WAV, MP3, M4A, WebM, OGG, FLAC · max {Math.floor(MAX_DURATION_SEC / 60)} minutes · {MAX_FILE_MB} MB</p>
              </div>
            </div>
          ) : (
            /* File loaded — show waveform player instead of drop zone */
            originalUrl && (
              <WavePlayer
                src={originalUrl}
                label="Original"
                accent="primary"
                onRemove={clearFile}
                meta={{ filename: file.name, fileSize: file.size, audioMeta: audioMeta || undefined }}
              />
            )
          )
        ) : (
          <div className="border-2 border-dashed border-white/10 rounded-2xl p-12 text-center">
            {recording ? (
              <>
                <div className="flex items-center justify-center gap-3 mb-4">
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400/60 opacity-75" />
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-red-400/80" />
                  </span>
                  <span className="text-2xl font-mono tabular-nums text-white">
                    {Math.floor(recordSec / 60)}:{String(recordSec % 60).padStart(2, '0')}
                  </span>
                  <span className="text-sm text-[#666]">/ 2:00</span>
                </div>
                <button
                  type="button"
                  onClick={stopRecording}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white text-[#07080A] text-sm font-semibold hover:bg-white/90"
                >
                  <Square size={14} />
                  Stop recording
                </button>
              </>
            ) : file && originalUrl ? (
              <WavePlayer
                src={originalUrl}
                label="Recording"
                accent="primary"
                onRemove={() => { clearFile(); }}
                meta={{ filename: file.name, fileSize: file.size, audioMeta: audioMeta || undefined }}
              />
            ) : (
              <>
                <Mic size={40} className="mx-auto mb-4 text-[#666]" />
                <p className="mb-4 text-[#A7B0B7]">Record noisy audio to enhance</p>
                <button
                  type="button"
                  onClick={startRecording}
                  disabled={loading}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white text-[#07080A] text-sm font-semibold hover:bg-white/90 disabled:opacity-40"
                >
                  <Mic size={14} />
                  Start recording
                </button>
              </>
            )}
          </div>
        )}

        {/* Enhance button */}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!file || loading || recording}
          className="w-full inline-flex items-center justify-center gap-2.5 px-5 py-3 rounded-xl bg-[#DFFF00] text-[#07080A] text-sm font-semibold hover:bg-[#DFFF00]/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? (
            <><Loader2 size={16} className="animate-spin" /> Enhancing…</>
          ) : resultUrl ? (
            <>
              <RotateCcw size={16} />
              Re-enhance
              <span className="px-2 py-0.5 rounded-full bg-[#07080A]/10 text-[11px] font-bold tabular-nums">{CREDIT_NOISE_REMOVER} cr</span>
            </>
          ) : (
            <>
              <Sparkles size={16} />
              Enhance Audio
              <span className="px-2 py-0.5 rounded-full bg-[#07080A]/10 text-[11px] font-bold tabular-nums">{CREDIT_NOISE_REMOVER} cr</span>
            </>
          )}
        </button>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2.5 rounded-xl border border-red-400/15 bg-red-400/[0.05] px-4 py-3">
            <AlertCircle size={16} className="shrink-0 mt-0.5 text-red-400/70" />
            <p className="text-sm text-red-300/80 leading-relaxed">{error}</p>
          </div>
        )}
      </div>

      {/* Results card */}
      {resultUrl && originalUrl && (
        <div className="card-vocence p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Sparkles size={16} className="text-[#DFFF00]" />
              <h3 className="text-sm font-semibold text-white">Enhancement Complete</h3>
            </div>
            {latencyMs != null && (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-white/[0.06] bg-white/[0.02]">
                <Clock size={12} className="text-[#555]" />
                <span className="text-[10px] uppercase tracking-widest text-[#555] font-semibold">Processed in</span>
                <span className="text-xs font-mono text-[#DFFF00] tabular-nums">{(latencyMs / 1000).toFixed(1)}<span className="text-[#666] ml-0.5">s</span></span>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <WavePlayer
              src={originalUrl}
              label="Original"
              accent="primary"
              meta={{ filename: file?.name, fileSize: file?.size, audioMeta: audioMeta || undefined }}
            />
            <WavePlayer
              src={resultUrl}
              label="Enhanced"
              accent="result"
            />
          </div>

          <a
            href={resultUrl}
            download="enhanced.wav"
            className="w-full inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl border border-[#DFFF00]/20 bg-[#DFFF00]/[0.06] text-sm font-medium text-[#DFFF00] hover:bg-[#DFFF00]/10 transition-colors"
          >
            <Download size={14} /> Download Enhanced Audio
          </a>
        </div>
      )}

      {/* Keyboard shortcut tip */}
      <div className="flex items-center justify-center gap-1.5 text-[12px] text-[#555] py-2">
        <span>Tip: drag any audio file onto the page</span>
        <span className="text-[#444]">·</span>
        <span>press</span>
        <kbd className="px-1.5 py-0.5 rounded bg-white/[0.06] border border-white/[0.08] text-[#888] font-mono text-[11px]">space</kbd>
        <span>to play/pause</span>
        <span className="text-[#444]">·</span>
        <kbd className="px-1.5 py-0.5 rounded bg-white/[0.06] border border-white/[0.08] text-[#888] font-mono text-[11px]">R</kbd>
        <span>to re-enhance</span>
      </div>
    </div>
  );
}
