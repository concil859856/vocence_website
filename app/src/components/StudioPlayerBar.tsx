import { useState, useEffect } from 'react';
import { Play, Pause, X, Volume2, VolumeX } from 'lucide-react';
import { useStudioPlayer } from '../contexts/StudioPlayerContext';

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function StudioPlayerBar() {
  const { track, playing, progress, duration, pause, resume, stop, seek, setVolume: setAudioVolume } = useStudioPlayer();
  const [volume, setVolume] = useState(1);
  const [prevVolume, setPrevVolume] = useState(1);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (track) requestAnimationFrame(() => setVisible(true));
    else setVisible(false);
  }, [track]);

  useEffect(() => { setAudioVolume(volume); }, [volume, setAudioVolume]);

  if (!track) return null;

  const pct = duration > 0 ? (progress / duration) * 100 : 0;
  const initial = track.title?.[0]?.toUpperCase() || '?';

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seek(Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)));
  };

  const toggleMute = () => {
    if (volume > 0) { setPrevVolume(volume); setVolume(0); }
    else setVolume(prevVolume || 1);
  };

  return (
    <div className={`fixed bottom-5 left-4 lg:left-[calc(256px+16px)] right-4 z-[60] transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${visible ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0 pointer-events-none'}`}>
      <div className="max-w-5xl mx-auto rounded-[20px] bg-[#111215]/90 backdrop-blur-2xl border border-white/[0.06] shadow-[0_8px_60px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.03)] p-3 pr-4">
        <div className="flex items-center gap-3">
          {/* Artwork circle */}
          <div className="relative shrink-0">
            <div className={`w-12 h-12 rounded-2xl bg-gradient-to-br from-[#DFFF00]/25 via-emerald-500/20 to-cyan-500/20 flex items-center justify-center transition-transform duration-700 ${playing ? 'scale-100' : 'scale-95'}`}>
              <span className="text-base font-bold text-white/80">{initial}</span>
            </div>
            {playing && <div className="absolute -inset-1 rounded-2xl bg-[#DFFF00]/10 animate-pulse" />}
          </div>

          {/* Info + progress */}
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[13px] text-white font-semibold truncate leading-tight">{track.title}</p>
                {track.subtitle && <p className="text-[11px] text-white/30 truncate leading-tight">{track.subtitle}</p>}
              </div>
              <span className="text-[10px] text-white/25 tabular-nums shrink-0">
                {formatTime(progress)} / {formatTime(duration)}
              </span>
            </div>
            {/* Rounded progress bar */}
            <div className="h-[5px] bg-white/[0.06] rounded-full cursor-pointer group" onClick={handleSeek}>
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#DFFF00] to-[#a3e635] transition-[width] duration-100 relative"
                style={{ width: `${pct}%` }}
              >
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-[11px] h-[11px] rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.3)] opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-1 shrink-0 ml-1">
            <button
              onClick={playing ? pause : resume}
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200 ${
                playing
                  ? 'bg-white text-[#07080A] hover:bg-white/90'
                  : 'bg-white/10 text-white hover:bg-white/20'
              }`}
            >
              {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
            </button>

            <div className="hidden sm:flex items-center gap-1 ml-1">
              <button onClick={toggleMute} className="text-white/20 hover:text-white/50 transition-colors p-1">
                {volume === 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
              </button>
              <input type="range" min={0} max={1} step={0.01} value={volume}
                onChange={(e) => setVolume(Number(e.target.value))}
                className="w-14 h-[3px] appearance-none bg-white/[0.08] rounded-full cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-[10px] [&::-webkit-slider-thumb]:h-[10px] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white/70" />
            </div>

            <button onClick={stop} className="text-white/15 hover:text-white/50 transition-colors p-1 ml-0.5" aria-label="Close">
              <X size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
