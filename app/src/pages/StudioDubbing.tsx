import { useState, useRef } from 'react';
import { Upload, AudioLines, Download, Loader2, Mic, Square } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { API_BASE_URL } from '../services/baseUrl';

export function StudioDubbing() {
  const { user, setLocalCredits } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'upload' | 'record'>('upload');
  const [recording, setRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const mrRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const startRecording = async () => {
    setError(null);
    setFile(null);
    setResultUrl(null);
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
        setFile(new File([blob], `recording.${ext}`, { type: blob.type }));
        setRecording(false);
        mrRef.current = null;
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      };
      mr.start();
      setRecording(true);
      setRecordSec(0);
      timerRef.current = setInterval(() => setRecordSec((s) => s + 1), 1000);
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
    setError(null);
    setResultUrl(null);
    setLoading(true);

    const token = localStorage.getItem('vocence_token');
    const form = new FormData();
    form.append('user_id', user.id);
    form.append('audio_file', file);

    try {
      const res = await fetch(`${API_BASE_URL}/dashboard/dubbing/enhance`, {
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
      if (data.credits_remaining != null) {
        setLocalCredits(data.credits_remaining);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Enhancement failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-semibold mb-2">Voice Dubbing</h2>
        <p className="text-[#A7B0B7]">
          Remove background noise from audio using DeepFilterNet. Upload or record noisy audio and get a clean version back.
        </p>
      </div>

      <div className="card-vocence p-6 space-y-5">
        {/* Mode toggle */}
        <div className="flex gap-2">
          <button
            onClick={() => { setMode('upload'); stopRecording(); }}
            className={`flex-1 py-2 text-sm font-medium rounded-lg border transition-colors ${
              mode === 'upload'
                ? 'border-[#DFFF00]/40 bg-[#DFFF00]/10 text-[#DFFF00]'
                : 'border-white/10 text-[#A7B0B7] hover:text-white hover:border-white/20'
            }`}
          >
            <Upload size={14} className="inline mr-1.5" />
            Upload file
          </button>
          <button
            onClick={() => { setMode('record'); setFile(null); setResultUrl(null); }}
            className={`flex-1 py-2 text-sm font-medium rounded-lg border transition-colors ${
              mode === 'record'
                ? 'border-[#DFFF00]/40 bg-[#DFFF00]/10 text-[#DFFF00]'
                : 'border-white/10 text-[#A7B0B7] hover:text-white hover:border-white/20'
            }`}
          >
            <Mic size={14} className="inline mr-1.5" />
            Record
          </button>
        </div>

        {/* Upload mode */}
        {mode === 'upload' && (
          <div
            className="border-2 border-dashed border-white/10 rounded-xl p-8 text-center cursor-pointer hover:border-white/20 transition-colors"
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={(e) => { setFile(e.target.files?.[0] || null); setResultUrl(null); }}
            />
            {file ? (
              <div className="space-y-1">
                <AudioLines size={24} className="mx-auto text-[#DFFF00]" />
                <p className="text-sm text-white font-medium">{file.name}</p>
                <p className="text-xs text-[#A7B0B7]">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
              </div>
            ) : (
              <div className="space-y-2">
                <Upload size={28} className="mx-auto text-[#A7B0B7]" />
                <p className="text-sm text-[#A7B0B7]">Click to upload audio file</p>
                <p className="text-xs text-[#666]">WAV, MP3, M4A, WebM, OGG, FLAC</p>
              </div>
            )}
          </div>
        )}

        {/* Record mode */}
        {mode === 'record' && (
          <div className="flex flex-col items-center gap-3 py-6 rounded-xl border border-white/10 bg-white/[0.02]">
            {recording ? (
              <>
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-sm font-mono text-white">
                    {String(Math.floor(recordSec / 60)).padStart(2, '0')}:{String(recordSec % 60).padStart(2, '0')}
                  </span>
                </div>
                <button
                  onClick={stopRecording}
                  className="px-4 py-2 rounded-lg bg-red-500/20 border border-red-500/30 text-red-300 text-sm font-medium hover:bg-red-500/30 inline-flex items-center gap-1.5"
                >
                  <Square size={12} /> Stop
                </button>
              </>
            ) : (
              <>
                {file ? (
                  <p className="text-xs text-[#A7B0B7]">Recorded · {(file.size / 1024).toFixed(0)} KB</p>
                ) : (
                  <p className="text-xs text-[#A7B0B7]">Record noisy audio to enhance</p>
                )}
                <button
                  onClick={startRecording}
                  disabled={loading}
                  className="px-4 py-2 rounded-lg bg-[#DFFF00]/10 border border-[#DFFF00]/30 text-[#DFFF00] text-sm font-medium hover:bg-[#DFFF00]/20 inline-flex items-center gap-1.5 disabled:opacity-40"
                >
                  <Mic size={14} /> {file ? 'Re-record' : 'Start recording'}
                </button>
              </>
            )}
          </div>
        )}

        {/* Enhance button */}
        <button
          onClick={handleSubmit}
          disabled={!file || loading || recording}
          className="w-full btn-primary h-11 text-sm font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-40"
        >
          {loading ? (
            <>
              <Loader2 size={16} className="animate-spin" /> Enhancing...
            </>
          ) : (
            <>
              <AudioLines size={16} /> Enhance Audio
            </>
          )}
        </button>

        {/* Error */}
        {error && (
          <div className="rounded-lg border border-red-400/30 bg-red-500/10 text-red-200 text-sm px-3 py-2">
            {error}
          </div>
        )}

        {/* Result */}
        {resultUrl && (
          <div className="rounded-xl border border-[#DFFF00]/20 bg-[#DFFF00]/[0.04] p-4 space-y-3">
            <p className="text-sm font-medium text-[#DFFF00]">Enhancement complete</p>
            <audio controls src={resultUrl} className="w-full" />
            <a
              href={resultUrl}
              download="enhanced.wav"
              className="inline-flex items-center gap-1.5 text-sm text-[#DFFF00] hover:underline"
            >
              <Download size={14} /> Download enhanced audio
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
