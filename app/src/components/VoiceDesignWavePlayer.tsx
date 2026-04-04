import { useCallback, useEffect, useRef, useState } from 'react';
import { Pause, Play, Repeat } from 'lucide-react';

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

type Props = {
  src: string;
  /** Stable id so multiple players behave; also used to pause other previews. */
  variantKey: string;
};

/**
 * Minimal dark player: play, loop, current time, cyan progress + white thumb, duration.
 */
export function VoiceDesignWavePlayer({ src, variantKey }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [loopOn, setLoopOn] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    const a = audioRef.current;
    if (a) a.loop = loopOn;
  }, [loopOn]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.dataset.vdPreview = variantKey;
    const onTime = () => setT(a.currentTime);
    const onMeta = () => setDur(Number.isFinite(a.duration) ? a.duration : 0);
    const onEnd = () => {
      if (!a.loop) {
        setPlaying(false);
        setT(0);
        a.currentTime = 0;
      }
    };
    const onPause = () => setPlaying(false);
    const onPlay = () => {
      setPlaying(true);
      document.querySelectorAll('audio[data-vd-preview]').forEach((el) => {
        if (el !== a) (el as HTMLAudioElement).pause();
      });
    };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('ended', onEnd);
    a.addEventListener('pause', onPause);
    a.addEventListener('play', onPlay);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('ended', onEnd);
      a.removeEventListener('pause', onPause);
      a.removeEventListener('play', onPlay);
    };
  }, [src, variantKey]);

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const a = audioRef.current;
      const el = trackRef.current;
      if (!a || !el || !dur) return;
      const rect = el.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      a.currentTime = p * dur;
      setT(p * dur);
    },
    [dur],
  );

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => seekFromClientX(e.clientX);
    const onUp = () => setDragging(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, seekFromClientX]);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (!a) return;
    if (a.paused) {
      void a.play().catch(() => setPlaying(false));
    } else {
      a.pause();
    }
  }, []);

  const progressPct = dur > 0 ? Math.min(100, (t / dur) * 100) : 0;

  return (
    <div
      className="rounded-xl border border-white/[0.1] px-4 py-3 shadow-inner shadow-black/30"
      style={{
        backgroundColor: '#0a0b0e',
        backgroundImage:
          'radial-gradient(circle at center, rgba(255,255,255,0.06) 1px, transparent 1px)',
        backgroundSize: '10px 10px',
      }}
    >
      <audio ref={audioRef} src={src} preload="metadata" className="hidden" />
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={toggle}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/40"
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="ml-0.5" />}
        </button>

        <button
          type="button"
          onClick={() => setLoopOn((v) => !v)}
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/40 ${
            loopOn ? 'bg-cyan-500/20 text-cyan-300' : 'bg-white/5 text-[#9CA3AF] hover:bg-white/10 hover:text-white'
          }`}
          aria-label={loopOn ? 'Disable repeat' : 'Enable repeat'}
          aria-pressed={loopOn}
        >
          <Repeat size={16} strokeWidth={2} />
        </button>

        <span className="shrink-0 text-sm font-semibold tabular-nums text-white">{formatTime(t)}</span>

        <div className="min-w-0 flex-1">
          <div
            ref={trackRef}
            role="slider"
            tabIndex={0}
            aria-valuenow={Math.round(progressPct)}
            aria-valuemin={0}
            aria-valuemax={100}
            className="group relative h-5 cursor-pointer select-none rounded-full py-2 outline-none focus-visible:ring-1 focus-visible:ring-cyan-400/50"
            onMouseDown={(e) => {
              e.preventDefault();
              seekFromClientX(e.clientX);
              setDragging(true);
            }}
            onKeyDown={(e) => {
              const a = audioRef.current;
              if (!a || !dur) return;
              if (e.key === 'ArrowRight') {
                a.currentTime = Math.min(dur, a.currentTime + 5);
              } else if (e.key === 'ArrowLeft') {
                a.currentTime = Math.max(0, a.currentTime - 5);
              }
            }}
          >
            <div className="pointer-events-none absolute left-0 right-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/[0.12]" />
            <div
              className="pointer-events-none absolute left-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-cyan-400/90"
              style={{ width: `${progressPct}%` }}
            />
            <div
              className="pointer-events-none absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white/20 bg-white shadow-md shadow-black/40"
              style={{ left: `${progressPct}%` }}
            />
          </div>
        </div>

        <span className="shrink-0 text-sm font-semibold tabular-nums text-white">{formatTime(dur)}</span>
      </div>
    </div>
  );
}
