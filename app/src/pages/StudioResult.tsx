import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Play, Pause, Volume2, Download, ArrowLeft, Loader2, Sparkles } from 'lucide-react';
import WaveSurfer from 'wavesurfer.js';
import { useAuth } from '../contexts/AuthContext';
import { dashboardApi, type StudioHistoryItem } from '../services/dashboardApi';
import { ScrollArea } from '../components/ui/scroll-area';
import { cn } from '@/lib/utils';

function formatTime(s: number) {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function entryTypeQuery(et: StudioHistoryItem['entry_type']): 'tts' | 'clone' | 'voice_design' | 'music' {
  if (et === 'clone') return 'clone';
  if (et === 'voice_design') return 'voice_design';
  if (et === 'music') return 'music';
  return 'tts';
}

function typeBadgeClass(et: StudioHistoryItem['entry_type']): string {
  switch (et) {
    case 'tts':
      return 'bg-[#DFFF00]/15 text-[#DFFF00]';
    case 'stt':
      return 'bg-green-500/15 text-green-400';
    case 'clone':
      return 'bg-cyan-500/15 text-cyan-400';
    case 'voice_design':
      return 'bg-violet-500/15 text-violet-300';
    case 'music':
      return 'bg-indigo-500/15 text-indigo-300';
  }
}

function typeBadgeLabel(et: StudioHistoryItem['entry_type']): string {
  switch (et) {
    case 'tts':
      return 'TTS';
    case 'stt':
      return 'STT';
    case 'clone':
      return 'CLONE';
    case 'voice_design':
      return 'MY VOICE';
    case 'music':
      return 'MUSIC';
  }
}

function previewLine(item: StudioHistoryItem): string {
  if (item.entry_type === 'stt') {
    return (item.transcribed_text || item.source_audio_filename || 'Transcription').trim();
  }
  if (item.entry_type === 'clone' || item.entry_type === 'voice_design') {
    return (
      item.target_text ||
      item.prompt_text ||
      item.reference_text ||
      item.display_name ||
      ''
    ).trim();
  }
  if (item.entry_type === 'music') {
    return (item.prompt_text || item.display_name || 'Music generation').trim();
  }
  return (item.prompt_text || item.display_name || '').trim();
}

export function StudioResult() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const rawEntry = (searchParams.get('entry_type') || 'tts').toLowerCase();
  const historyEntryType: 'tts' | 'clone' | 'voice_design' | 'music' =
    rawEntry === 'clone'
      ? 'clone'
      : rawEntry === 'voice_design' || rawEntry === 'designed_voice'
        ? 'voice_design'
        : rawEntry === 'music'
          ? 'music'
          : 'tts';

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [historyItems, setHistoryItems] = useState<StudioHistoryItem[]>([]);
  const [waveReady, setWaveReady] = useState(false);
  const [waveError, setWaveError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);

  const waveformRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const volumeRef = useRef(volume);
  volumeRef.current = volume;

  const historyId = id ? parseInt(id, 10) : NaN;

  useEffect(() => {
    if (!user) {
      navigate('/studio/tts');
      return;
    }
    dashboardApi
      .getStudioHistory(user.id)
      .then((res) => setHistoryItems(res.items))
      .catch(() => setHistoryItems([]));
  }, [user, navigate]);

  useEffect(() => {
    if (!id || !user) {
      setLoading(false);
      return;
    }
    if (Number.isNaN(historyId)) {
      setError('Invalid result id');
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAudioUrl(null);
    dashboardApi
      .getStudioHistoryAudioUrl(historyId, user.id, historyEntryType)
      .then(({ audio_url }) => {
        if (!cancelled) {
          setAudioUrl(audio_url);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err?.message || 'Failed to load audio');
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [id, user, historyId, historyEntryType]);

  useEffect(() => {
    if (!audioUrl || !waveformRef.current) return;

    setWaveReady(false);
    setWaveError(null);

    const container = waveformRef.current;

    let ws: WaveSurfer;
    try {
      ws = WaveSurfer.create({
        container,
        url: audioUrl,
        height: 148,
        waveColor: ['rgba(255,255,255,0.12)', 'rgba(255,255,255,0.06)'],
        progressColor: ['#DFFF00', '#b8e600'],
        cursorColor: '#DFFF00',
        cursorWidth: 2,
        barWidth: 2,
        barGap: 1,
        barRadius: 2,
        normalize: true,
        interact: true,
        dragToSeek: true,
        fillParent: true,
        hideScrollbar: false,
        fetchParams: { mode: 'cors', credentials: 'omit' },
      });
    } catch (e) {
      setWaveError(e instanceof Error ? e.message : 'Waveform failed');
      return;
    }

    wsRef.current = ws;

    ws.on('ready', (d) => {
      setDuration(d);
      setWaveReady(true);
      ws.setVolume(volumeRef.current);
    });
    ws.on('timeupdate', (t) => setCurrentTime(t));
    ws.on('play', () => setIsPlaying(true));
    ws.on('pause', () => setIsPlaying(false));
    ws.on('finish', () => setIsPlaying(false));
    ws.on('error', (err) => setWaveError(err.message || 'Playback error'));

    return () => {
      wsRef.current = null;
      ws.destroy();
    };
  }, [audioUrl]);

  useEffect(() => {
    wsRef.current?.setVolume(volume);
  }, [volume]);

  const currentItem = useMemo(
    () => (!Number.isNaN(historyId) ? historyItems.find((h) => h.id === historyId) : undefined),
    [historyItems, historyId]
  );

  /** Playable entries: STT has no stored output audio in this product surface */
  const sidebarItems = useMemo(
    () =>
      [...historyItems]
        .filter((h) => h.entry_type !== 'stt')
        .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
    [historyItems]
  );

  const triggerBrowserDownload = async (url: string, filename: string) => {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`Download request failed (${res.status})`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
    } catch (e) {
      console.error(e);
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const handlePlayPause = () => {
    void wsRef.current?.playPause();
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
  };

  const handleDownload = () => {
    if (!audioUrl) return;
    const filename =
      historyEntryType === 'clone'
        ? `vocence-clone-${id}.wav`
        : historyEntryType === 'voice_design'
          ? `vocence-voice-design-${id}.wav`
          : historyEntryType === 'music'
            ? `vocence-music-${id}.wav`
            : `vocence-tts-${id}.wav`;
    void triggerBrowserDownload(audioUrl, filename);
  };

  const goToHistoryItem = useCallback(
    (item: StudioHistoryItem) => {
      const q = entryTypeQuery(item.entry_type);
      navigate(`/studio/result/${item.id}?entry_type=${q}`);
    },
    [navigate]
  );

  if (loading) {
    return (
      <div className="min-h-screen bg-[#07080A] pt-24 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-2 border-[#DFFF00] border-t-transparent rounded-full animate-spin" />
          <p className="text-[#A7B0B7]">Loading your audio...</p>
        </div>
      </div>
    );
  }

  if (error || !audioUrl) {
    return (
      <div className="min-h-screen bg-[#07080A] pt-24 flex items-center justify-center">
        <div className="max-w-md text-center px-6">
          <p className="text-red-400 mb-4">{error || 'Audio not found or expired.'}</p>
          <p className="text-[#A7B0B7] text-sm mb-6">
            Audio is available for 7 days (Normal plan) or permanently (Premium plan). You can generate a new one from Studio.
          </p>
          <button onClick={() => navigate('/studio/tts')} className="btn-primary inline-flex items-center gap-2">
            <ArrowLeft size={18} />
            Back to Studio
          </button>
        </div>
      </div>
    );
  }

  const title = currentItem?.display_name || 'Your generated audio';
  const inferredEntry: StudioHistoryItem['entry_type'] =
    historyEntryType === 'clone' ? 'clone' : historyEntryType === 'voice_design' ? 'voice_design' : 'tts';
  const subtitle =
    currentItem != null
      ? `${typeBadgeLabel(currentItem.entry_type)} · ${new Date(currentItem.created_at).toLocaleString()}`
      : `${typeBadgeLabel(inferredEntry)} · Studio`;
  const bodyPreview = currentItem ? previewLine(currentItem) : '';

  return (
    <div className="min-h-screen bg-[#07080A] text-white pt-24 pb-14 px-4 sm:px-6">
      {/* Coming-soon overlay */}
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[#07080A]">
        <div className="text-center px-6 max-w-lg">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-[#DFFF00]/10 border border-[#DFFF00]/20">
            <Sparkles size={36} className="text-[#DFFF00]" />
          </div>
          <h1 className="text-3xl md:text-4xl font-semibold text-white mb-3">Studio Coming Soon</h1>
          <p className="text-sm md:text-base text-[#A7B0B7] leading-relaxed mb-8">
            We're putting the finishing touches on Vocence Studio — Text-to-Speech, Speech-to-Text, Voice Cloning, Voice Design, Music Generation, and more. Stay tuned!
          </p>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-xl bg-[#DFFF00] px-6 py-3 text-sm font-semibold text-[#07080A] transition-opacity hover:opacity-90"
          >
            Back to Home
          </a>
        </div>
      </div>

      <div className="max-w-[1200px] mx-auto">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
          <button
            type="button"
            onClick={() => navigate('/history')}
            className="flex items-center gap-2 text-[#A7B0B7] hover:text-white transition-colors w-fit text-sm"
          >
            <ArrowLeft size={18} />
            History
          </button>
          <button
            type="button"
            onClick={() => navigate('/studio/tts')}
            className="flex items-center gap-2 text-[#A7B0B7] hover:text-white transition-colors w-fit text-sm sm:ml-auto"
          >
            Studio
            <span className="text-white/40">→</span>
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_minmax(260px,300px)] gap-8 lg:gap-10">
          <main>
            <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-gradient-to-br from-[#101218] via-[#0c0d10] to-[#07080a] shadow-[0_0_0_1px_rgba(223,255,0,0.06),0_24px_64px_rgba(0,0,0,0.55)]">
              <div className="absolute inset-0 pointer-events-none opacity-[0.35] bg-[radial-gradient(ellipse_80%_50%_at_20%_-10%,rgba(223,255,0,0.12),transparent_50%)]" />
              <div className="relative p-6 sm:p-8">
                <div className="flex items-start gap-3 mb-6">
                  <div className="mt-0.5 w-9 h-9 rounded-xl bg-[#DFFF00]/10 border border-[#DFFF00]/20 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-[#DFFF00]" />
                  </div>
                  <div className="min-w-0">
                    <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-white truncate">{title}</h1>
                    <p className="text-sm text-[#8b959c] mt-1">{subtitle}</p>
                    {bodyPreview ? (
                      <p className="text-sm text-[#A7B0B7] mt-3 line-clamp-3 leading-relaxed border-l-2 border-[#DFFF00]/30 pl-3">
                        {bodyPreview}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="mb-4">
                  <span className="text-xs uppercase tracking-wider text-[#666]">Waveform</span>
                </div>

                <div className="relative rounded-xl bg-black/40 border border-white/[0.06] p-3 sm:p-4 mb-2 min-h-[168px]">
                  {!waveReady && !waveError ? (
                    <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 m-3 rounded-lg bg-black/35 text-[#A7B0B7] text-sm">
                      <Loader2 className="w-4 h-4 animate-spin text-[#DFFF00]" />
                      Decoding waveform…
                    </div>
                  ) : null}
                  {waveError ? (
                    <div className="absolute inset-0 z-20 flex items-center justify-center m-3 rounded-lg bg-black/60 text-amber-400/95 text-sm px-4 text-center">
                      {waveError}
                    </div>
                  ) : null}
                  <div ref={waveformRef} className={cn('w-full min-h-[148px]', waveError && 'pointer-events-none opacity-30')} />
                </div>

                <div className="mt-6 flex flex-col sm:flex-row sm:items-center gap-4">
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handlePlayPause}
                      disabled={!waveReady || !!waveError}
                      className="w-12 h-12 rounded-full bg-[#DFFF00] text-black flex items-center justify-center hover:bg-[#e8ff33] disabled:opacity-40 transition-colors shadow-[0_0_24px_rgba(223,255,0,0.25)]"
                      aria-label={isPlaying ? 'Pause' : 'Play'}
                    >
                      {isPlaying ? (
                        <Pause size={22} fill="currentColor" />
                      ) : (
                        <Play size={22} className="ml-0.5" fill="currentColor" />
                      )}
                    </button>
                    <div className="text-sm tabular-nums text-[#A7B0B7]">
                      <span className="text-white">{formatTime(currentTime)}</span>
                      <span className="mx-1 text-white/30">/</span>
                      <span>{formatTime(duration)}</span>
                    </div>
                  </div>

                  <div className="flex flex-1 flex-wrap items-center gap-3 sm:justify-end">
                    <div className="flex items-center gap-2 min-w-[120px]">
                      <Volume2 size={18} className="text-[#666] shrink-0" />
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={volume}
                        onChange={handleVolumeChange}
                        className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-white/10 accent-[#DFFF00] min-w-[72px]"
                        aria-label="Volume"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={handleDownload}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-white/5 border border-white/10 text-sm hover:bg-white/10 transition-colors"
                    >
                      <Download size={18} />
                      Download
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </main>

          <aside className="lg:sticky lg:top-24 h-fit">
            <div className="rounded-2xl border border-white/[0.08] bg-[#0c0d11]/90 backdrop-blur-sm overflow-hidden">
              <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
                <h2 className="text-sm font-medium text-white">More in your library</h2>
                <span className="text-[10px] uppercase tracking-wider text-[#666]">
                  {sidebarItems.length} clips
                </span>
              </div>
              <ScrollArea className="h-[min(520px,calc(100vh-12rem))]">
                <ul className="divide-y divide-white/[0.07] py-1">
                  {sidebarItems.map((item) => {
                    const active = item.id === historyId;
                    const line = previewLine(item);
                    const expired = item.expired;
                    return (
                      <li key={`${item.entry_type}-${item.id}`} className="px-2 py-2">
                        <button
                          type="button"
                          disabled={active || expired}
                          onClick={() => goToHistoryItem(item)}
                          className={cn(
                            'w-full text-left rounded-xl px-3 py-2.5 transition-colors border border-transparent',
                            active
                              ? 'bg-[#DFFF00]/10 border-[#DFFF00]/25 ring-1 ring-[#DFFF00]/20'
                              : 'hover:bg-white/[0.04] disabled:opacity-50 disabled:cursor-default',
                            expired && 'opacity-45'
                          )}
                        >
                          <div className="flex items-center gap-2 mb-1">
                            <span
                              className={cn(
                                'text-[10px] font-semibold px-1.5 py-0.5 rounded',
                                typeBadgeClass(item.entry_type)
                              )}
                            >
                              {typeBadgeLabel(item.entry_type)}
                            </span>
                            {expired && (
                              <span className="text-[10px] text-red-400/90">Expired</span>
                            )}
                            {item.duration_seconds != null && (
                              <span className="text-[10px] text-[#666] ml-auto tabular-nums">
                                {item.duration_seconds.toFixed(1)}s
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-[#c5cdd4] line-clamp-2 leading-snug">
                            {line || item.display_name || `Entry #${item.id}`}
                          </p>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </ScrollArea>
              <div className="px-3 py-2 border-t border-white/[0.06] text-center">
                <button
                  type="button"
                  onClick={() => navigate('/history')}
                  className="text-xs text-[#DFFF00] hover:underline"
                >
                  Open full history
                </button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
