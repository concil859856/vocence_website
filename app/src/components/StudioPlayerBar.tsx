import { useState, useEffect } from 'react';
import { Play, Pause, X, Volume2, VolumeX, SkipBack, SkipForward, Shuffle, Repeat, Repeat1, Download } from 'lucide-react';
import { useStudioPlayer } from '../contexts/StudioPlayerContext';
import { avatarGradientPairFor } from '../data/sampleVoices';

async function downloadTrack(url: string, filename: string) {
  try {
    const res = await fetch(url, { mode: 'cors' });
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
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

function formatTime(s: number): string {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function StudioPlayerBar() {
  const {
    track, playing, progress, duration, pause, resume, stop, seek, setVolume: setAudioVolume,
    queue, queueIndex, shuffle, repeat, queueSource,
    next, prev, toggleShuffle, toggleRepeat,
  } = useStudioPlayer();
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
  // Initials from up to 2 words of the title — "Lofi Jazz Beat" → "LJ"
  const initials = (track.title || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?';
  // Deterministic two-ring gradient seeded from the track title (or src
  // as fallback) — same palette as agents / designed voices.
  const grad = avatarGradientPairFor(track.title || track.src || 'track');
  const hasQueue = queue.length > 1;

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seek(Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)));
  };

  const toggleMute = () => {
    if (volume > 0) { setPrevVolume(volume); setVolume(0); }
    else setVolume(prevVolume || 1);
  };

  return (
    <div className={`fixed bottom-5 left-4 lg:left-[calc(256px+16px)] right-4 z-[60] pointer-events-none transition-all duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] ${visible ? 'translate-y-0 opacity-100' : 'translate-y-12 opacity-0'}`}>
      <div className="max-w-5xl mx-auto pointer-events-auto rounded-[20px] bg-[#111215]/90 backdrop-blur-2xl border border-white/[0.06] shadow-[0_8px_60px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.03)] p-3 pr-4">
        <div className="flex items-center gap-3">
          {/* Artwork — image when present, otherwise a two-ring gradient
              tile with the track's initials. Same palette as the rest of
              Studio (agents, designed voices) for visual consistency. */}
          <div className="relative shrink-0">
            {track.image ? (
              <div
                className={`w-12 h-12 rounded-lg overflow-hidden flex items-center justify-center transition-transform duration-700 ${
                  playing ? 'scale-100' : 'scale-95'
                }`}
              >
                <img src={track.image} alt="" className="w-full h-full object-cover" />
              </div>
            ) : (
              <div
                className={`w-12 h-12 rounded-lg p-[2.5px] bg-gradient-to-br ${grad.outer} transition-transform duration-700 ${
                  playing ? 'scale-100' : 'scale-95'
                }`}
              >
                <div className={`w-full h-full rounded-md flex items-center justify-center bg-gradient-to-br ${grad.inner}`}>
                  <span className="text-[15px] font-semibold text-white">{initials}</span>
                </div>
              </div>
            )}
            {playing && <div className="absolute -inset-1 rounded-lg bg-[#DFFF00]/10 animate-pulse" />}
          </div>

          {/* Info */}
          <div className="min-w-0 w-36 shrink-0">
            <p className="text-[13px] text-white font-semibold truncate leading-tight">{track.title}</p>
            <p className="text-[11px] text-white/30 truncate leading-tight">
              {queueSource || track.subtitle || ''}
              {hasQueue && <span className="ml-1 text-white/20">{queueIndex + 1}/{queue.length}</span>}
            </p>
          </div>

          {/* Controls */}
          <div className="flex items-center gap-1 shrink-0">
            {/* Shuffle */}
            {hasQueue && (
              <button
                onClick={toggleShuffle}
                className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors ${
                  shuffle ? 'text-[#DFFF00]' : 'text-white/20 hover:text-white/50'
                }`}
                aria-label="Shuffle"
              >
                <Shuffle size={13} />
              </button>
            )}

            {/* Prev */}
            {hasQueue && (
              <button onClick={prev} className="w-7 h-7 rounded-full flex items-center justify-center text-white/40 hover:text-white transition-colors" aria-label="Previous">
                <SkipBack size={14} />
              </button>
            )}

            {/* Play/Pause */}
            <button
              onClick={playing ? pause : resume}
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-all duration-200 ${
                playing ? 'bg-white text-[#07080A] hover:bg-white/90' : 'bg-white/10 text-white hover:bg-white/20'
              }`}
            >
              {playing ? <Pause size={14} /> : <Play size={14} className="ml-0.5" />}
            </button>

            {/* Next */}
            {hasQueue && (
              <button onClick={next} className="w-7 h-7 rounded-full flex items-center justify-center text-white/40 hover:text-white transition-colors" aria-label="Next">
                <SkipForward size={14} />
              </button>
            )}

            {/* Repeat */}
            {hasQueue && (
              <button
                onClick={toggleRepeat}
                className={`w-7 h-7 rounded-full flex items-center justify-center transition-colors ${
                  repeat !== 'off' ? 'text-[#DFFF00]' : 'text-white/20 hover:text-white/50'
                }`}
                aria-label={`Repeat: ${repeat}`}
              >
                {repeat === 'one' ? <Repeat1 size={13} /> : <Repeat size={13} />}
              </button>
            )}
          </div>

          {/* Progress */}
          <div className="flex-1 min-w-0 flex items-center gap-2">
            <span className="text-[10px] text-white/25 tabular-nums shrink-0 w-8 text-right">{formatTime(progress)}</span>
            <div className="flex-1 h-[5px] bg-white/[0.06] rounded-full cursor-pointer group" onClick={handleSeek}>
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#DFFF00] to-[#a3e635] transition-[width] duration-100 relative"
                style={{ width: `${pct}%` }}
              >
                <div className="absolute right-0 top-1/2 -translate-y-1/2 w-[11px] h-[11px] rounded-full bg-white shadow-[0_0_8px_rgba(255,255,255,0.3)] opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </div>
            <span className="text-[10px] text-white/25 tabular-nums shrink-0 w-8">{formatTime(duration)}</span>
          </div>

          {/* Volume */}
          <button onClick={toggleMute} className="text-white/20 hover:text-white/50 transition-colors p-1 shrink-0">
            {volume === 0 ? <VolumeX size={13} /> : <Volume2 size={13} />}
          </button>
          <input type="range" min={0} max={1} step={0.01} value={volume}
            onChange={(e) => setVolume(Number(e.target.value))}
            className="w-14 h-[3px] appearance-none bg-white/[0.08] rounded-full cursor-pointer hidden sm:block [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-[10px] [&::-webkit-slider-thumb]:h-[10px] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white/70" />

          {/* Download (only for user-generated audio) */}
          {track.downloadFilename && (
            <button
              onClick={() => void downloadTrack(track.src, track.downloadFilename!)}
              className="text-white/20 hover:text-white/70 transition-colors p-1 ml-1 shrink-0"
              aria-label="Download"
              title="Download"
            >
              <Download size={13} />
            </button>
          )}

          {/* Close */}
          <button onClick={stop} className="text-white/15 hover:text-white/50 transition-colors p-1 ml-0.5 shrink-0" aria-label="Close">
            <X size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
