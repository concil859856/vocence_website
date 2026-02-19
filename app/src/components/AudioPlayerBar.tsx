import { useRef, useState, useEffect } from 'react';
import { Play, Pause, Volume2, Download } from 'lucide-react';

const ACCENT = '#D1F840';

interface AudioPlayerBarProps {
  src: string | null | undefined;
  label: string;
  className?: string;
}

export function AudioPlayerBar({ src, label, className = '' }: AudioPlayerBarProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [volume, setVolume] = useState(1);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    el.volume = volume;
  }, [volume]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTimeUpdate = () => setCurrentTime(el.currentTime);
    const onDurationChange = () => setDuration(el.duration || 0);
    const onEnded = () => setPlaying(false);
    const onLoadedData = () => setLoaded(true);
    el.addEventListener('timeupdate', onTimeUpdate);
    el.addEventListener('durationchange', onDurationChange);
    el.addEventListener('ended', onEnded);
    el.addEventListener('loadeddata', onLoadedData);
    return () => {
      el.removeEventListener('timeupdate', onTimeUpdate);
      el.removeEventListener('durationchange', onDurationChange);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('loadeddata', onLoadedData);
    };
  }, [src]);

  const togglePlay = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
    } else {
      el.play().catch(() => {});
    }
    setPlaying(!playing);
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const p = (e.clientX - rect.left) / rect.width;
    const t = Math.max(0, Math.min(1, p)) * duration;
    el.currentTime = t;
    setCurrentTime(t);
  };

  const formatTime = (s: number) => {
    if (!isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  const handleDownload = async () => {
    if (!src?.trim() || downloading) return;
    setDownloading(true);
    try {
      const res = await fetch(src, { mode: 'cors' });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${label.replace(/\s+/g, '-').toLowerCase() || 'audio'}.wav`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      window.open(src, '_blank');
    } finally {
      setDownloading(false);
    }
  };

  if (!src?.trim()) {
    return (
      <div className={`flex items-center gap-2 rounded-lg bg-[#1a1a1a] border border-[#27272a] px-3 py-2 ${className}`}>
        <span className="text-xs text-gray-500">{label}: no URL</span>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-2 rounded-lg bg-[#1a1a1a] border border-[#27272a] px-3 py-2 ${className}`}>
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        type="button"
        onClick={togglePlay}
        className="w-8 h-8 flex items-center justify-center rounded-full bg-[#27272a] hover:bg-[#333] text-white shrink-0"
        aria-label={playing ? 'Pause' : 'Play'}
      >
        {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
      </button>
      <span className="text-[11px] font-mono text-gray-400 w-20 shrink-0">
        {formatTime(currentTime)} / {formatTime(duration)}
      </span>
      <div
        className="flex-1 h-1.5 bg-[#27272a] rounded-full overflow-hidden cursor-pointer min-w-[60px]"
        onClick={seek}
        role="progressbar"
        aria-valuenow={duration ? (currentTime / duration) * 100 : 0}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: duration ? `${(currentTime / duration) * 100}%` : '0%',
            background: ACCENT,
          }}
        />
      </div>
      <div className="flex items-center gap-1 shrink-0 w-20">
        <Volume2 className="w-4 h-4 text-gray-500 shrink-0" />
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={volume}
          onChange={(e) => setVolume(parseFloat(e.target.value))}
          className="w-12 h-1 accent-[#D1F840] cursor-pointer bg-[#27272a] rounded"
          aria-label="Volume"
        />
      </div>
      <button
        type="button"
        onClick={handleDownload}
        disabled={downloading}
        className="w-8 h-8 flex items-center justify-center rounded-lg bg-[#27272a] hover:bg-[#333] text-gray-400 hover:text-white shrink-0 disabled:opacity-50"
        title="Download"
        aria-label="Download audio"
      >
        <Download className="w-4 h-4" />
      </button>
    </div>
  );
}
