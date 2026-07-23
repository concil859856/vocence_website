/**
 * VideoPlayerModal — center-sheet HTML5 player.
 *
 * Opens at ~70% viewport (capped at 1080px wide), 16:9 aspect, black
 * letterbox so the source's actual aspect always renders correctly.
 * Backdrop click + ``Esc`` close. The control bar auto-hides after
 * 2.5 s of idle and reappears on any cursor / touch motion or focus,
 * which is the YouTube / Vimeo convention. Tab / Space / arrow keys
 * inside the modal target the video, not the page below it.
 *
 * No external player lib — native ``<video>`` plus custom UI keeps the
 * bundle clean and means we can theme it to match the rest of Studio.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { createPortal } from 'react-dom';
import {
  Pause,
  Play,
  RotateCcw,
  Volume2,
  VolumeX,
  X,
  Maximize2,
  Minimize2,
} from 'lucide-react';

interface VideoPlayerModalProps {
  open: boolean;
  onClose: () => void;
  /** MP4 (or any browser-playable) source URL. */
  src: string;
  /** Optional poster shown until first play. */
  poster?: string;
  /** ARIA label for the dialog. */
  title?: string;
}

const IDLE_HIDE_MS = 2500;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function VideoPlayerModal({
  open,
  onClose,
  src,
  poster,
  title = 'Video player',
}: VideoPlayerModalProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const idleTimerRef = useRef<number | null>(null);
  const labelId = useId();

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  // Controls reveal only when the cursor enters the bottom strip of the
  // video, otherwise stay hidden. While paused or ended we force them
  // on so the play / replay glyph is reachable.
  const [controlsVisible, setControlsVisible] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Fraction of the container's height from the bottom that counts as
  // the "control zone". 0.35 == bottom 35%. Generous so the cursor
  // doesn't have to land exactly on the bar to reveal it.
  const CONTROL_ZONE_FRAC = 0.35;
  // ``ended`` controls the replay-glyph swap on the play button so the
  // user gets a visual cue that pressing it now means "play again from
  // the start" instead of "resume from where I paused".
  const [ended, setEnded] = useState(false);

  // Reveal the controls. When called from a non-bottom event (e.g.
  // keyboard shortcut, opening the modal) we still flash them briefly
  // so the user has feedback. When called from a cursor-in-bottom-zone
  // event the idle timer is bypassed by ``persist``.
  const wakeControls = useCallback((persist = false) => {
    setControlsVisible(true);
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    if (persist) return;
    idleTimerRef.current = window.setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused) {
        setControlsVisible(false);
      }
    }, IDLE_HIDE_MS);
  }, []);

  // Track cursor position inside the container; show controls when
  // it's in the bottom CONTROL_ZONE_FRAC, hide them otherwise. The
  // backdrop's onMouseMove still calls wakeControls() with no args so
  // keyboard / initial-open paths keep getting a brief flash.
  const onContainerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const yFromBottom = rect.bottom - e.clientY;
    const inZone = yFromBottom <= rect.height * CONTROL_ZONE_FRAC;
    if (inZone) {
      // Pin visible while cursor is in the zone — no idle decay.
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
      setControlsVisible(true);
    } else {
      // Leaving the zone — hide immediately unless paused / ended.
      const v = videoRef.current;
      if (v && !v.paused && !ended) {
        setControlsVisible(false);
      }
    }
  }, [ended]);

  // Esc to close, Space to toggle play/pause, ←/→ to seek 5s.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      const v = videoRef.current;
      if (!v) return;
      if (e.key === ' ' || e.key === 'k') {
        e.preventDefault();
        if (v.paused) v.play();
        else v.pause();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        v.currentTime = Math.max(0, v.currentTime - 5);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 5);
      } else if (e.key === 'm') {
        e.preventDefault();
        v.muted = !v.muted;
      } else if (e.key === 'f') {
        e.preventDefault();
        toggleFullscreen();
      }
      wakeControls();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // toggleFullscreen is stable enough — only deps that matter are
    // ``open`` and the callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose, wakeControls]);

  // Reset state and try to autoplay when the modal opens. The click
  // that opened the modal counts as a user gesture, so most browsers
  // will allow unmuted autoplay; if Chrome/Safari still block it (no
  // prior interaction with the origin), fall back to muted-then-play
  // so the user at least sees the video and can unmute one click in.
  useEffect(() => {
    if (!open) return;
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = 0;
    setProgress(0);
    setEnded(false);
    setControlsVisible(true);
    v.muted = false;
    v.volume = 1;
    setMuted(false);
    setVolume(1);
    v.play()
      .then(() => setPlaying(true))
      .catch(() => {
        // Autoplay blocked: retry muted so playback at least starts.
        v.muted = true;
        setMuted(true);
        v.play()
          .then(() => setPlaying(true))
          .catch(() => setPlaying(false));
      });
    wakeControls();
    return () => {
      v.pause();
      if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    };
  }, [open, src, wakeControls]);

  // Lock body scroll while modal is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  // Track native fullscreen changes (user might press F11 or exit).
  useEffect(() => {
    const onFs = () => setFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const onTimeUpdate = () => {
    const v = videoRef.current;
    if (!v) return;
    setProgress(v.currentTime);
    if (v.buffered.length > 0) {
      setBuffered(v.buffered.end(v.buffered.length - 1));
    }
  };

  const onLoadedMetadata = () => {
    const v = videoRef.current;
    if (!v) return;
    setDuration(v.duration);
  };

  const onPlay = () => {
    setPlaying(true);
    setEnded(false);
    // Once playback resumes after a pause, the controls collapse back
    // to the cursor-in-bottom-zone rule. Initial fade gives the user a
    // visual cue that playback has started.
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
    }, IDLE_HIDE_MS);
  };
  const onPause = () => {
    setPlaying(false);
    // While paused the user wants the controls reachable without
    // hunting for the bottom strip — pin them on.
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
    setControlsVisible(true);
  };
  const onEnded = () => {
    setPlaying(false);
    setEnded(true);
    setControlsVisible(true);
    if (idleTimerRef.current) window.clearTimeout(idleTimerRef.current);
  };

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (ended) {
      v.currentTime = 0;
      setEnded(false);
    }
    if (v.paused) {
      v.play();
    } else {
      v.pause();
    }
  };

  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
    if (!v.muted && v.volume === 0) {
      v.volume = 1;
      setVolume(1);
    }
  };

  const onVolumeChange = (next: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.volume = next;
    setVolume(next);
    if (next === 0) {
      v.muted = true;
      setMuted(true);
    } else if (v.muted) {
      v.muted = false;
      setMuted(false);
    }
  };

  const onSeek = (next: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = next;
    setProgress(next);
  };

  const toggleFullscreen = () => {
    const c = containerRef.current;
    if (!c) return;
    if (document.fullscreenElement === c) {
      document.exitFullscreen().catch(() => {});
    } else {
      c.requestFullscreen().catch(() => {});
    }
  };

  const onBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    // Close only when the backdrop itself was clicked, not a child.
    if (e.target === e.currentTarget) onClose();
  };

  if (!open) return null;

  // Render into ``document.body`` via a Portal. Without this, the modal
  // is positioned relative to whatever ancestor created the current
  // stacking context — the StudioHeroBanner has ``overflow-hidden`` on
  // its <section>, which clips the fixed-positioned backdrop and makes
  // the modal effectively invisible. The Portal moves the DOM nodes to
  // a top-level container so ``fixed inset-0`` actually fills the
  // viewport regardless of where the caller renders us.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={labelId}
      onClick={onBackdropClick}
      onMouseMove={() => wakeControls()}
      onTouchStart={() => wakeControls()}
      // pointer-events-auto is load-bearing when this opens above a Radix
      // dialog: Radix sets `pointer-events: none` on <body> while a modal is
      // open and re-enables it only inside its own layer. This portal is a
      // sibling of that layer, so without this the whole player — controls
      // and close button included — is inert.
      className="pointer-events-auto fixed inset-0 z-[120] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 sm:p-8"
    >
      <span id={labelId} className="sr-only">{title}</span>

      <div
        ref={containerRef}
        className="
          group relative w-full max-w-[1512px]
          aspect-video overflow-hidden rounded-2xl
          bg-black shadow-[0_30px_80px_-20px_rgba(0,0,0,0.6)]
          ring-1 ring-white/[0.08]
        "
        onPointerMove={(e) => { e.stopPropagation(); onContainerMove(e); }}
        onPointerLeave={() => {
          // Cursor left the container entirely: hide unless paused / ended.
          const v = videoRef.current;
          if (v && !v.paused && !ended) {
            setControlsVisible(false);
          }
        }}
        onClick={(e) => {
          // Single-click anywhere on the video toggles play. Skipped if
          // the click originated on a control element — those use
          // stopPropagation below.
          if (e.target === e.currentTarget || e.target === videoRef.current) {
            togglePlay();
          }
        }}
      >
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          playsInline
          preload="metadata"
          className="h-full w-full bg-black object-contain"
          onTimeUpdate={onTimeUpdate}
          onLoadedMetadata={onLoadedMetadata}
          onPlay={onPlay}
          onPause={onPause}
          onEnded={onEnded}
          onProgress={onTimeUpdate}
        />

        {/* Close — always visible, top-right. */}
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onClose(); }}
          className="
            absolute right-3 top-3 z-10
            inline-flex h-9 w-9 items-center justify-center rounded-full
            bg-black/55 text-white/90 backdrop-blur
            transition-opacity hover:bg-black/75
          "
          aria-label="Close video"
        >
          <X className="h-4 w-4" />
        </button>

        {/* Center play button — visible when paused / ended. */}
        {(!playing || ended) && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); togglePlay(); }}
            className="
              absolute inset-0 m-auto grid h-20 w-20 place-items-center
              rounded-full bg-white/95 text-[#0A0A0B]
              shadow-[0_8px_30px_rgba(0,0,0,0.4)]
              transition-transform hover:scale-105
            "
            aria-label={ended ? 'Replay' : 'Play'}
          >
            {ended ? (
              <RotateCcw className="h-7 w-7" />
            ) : (
              <Play className="h-7 w-7 fill-current pl-1" />
            )}
          </button>
        )}

        {/* Bottom controls bar — auto-hides. */}
        <div
          className={`
            pointer-events-${controlsVisible ? 'auto' : 'none'}
            absolute inset-x-0 bottom-0 z-10
            bg-gradient-to-t from-black/85 via-black/45 to-transparent
            px-4 pb-3 pt-12
            transition-opacity duration-200
            ${controlsVisible ? 'opacity-100' : 'opacity-0'}
          `}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Scrubber */}
          <ScrubBar
            current={progress}
            duration={duration}
            buffered={buffered}
            onSeek={onSeek}
          />

          <div className="mt-2 flex items-center gap-3 text-white">
            <button
              type="button"
              onClick={togglePlay}
              className="grid h-8 w-8 place-items-center rounded-full bg-white/10 hover:bg-white/20"
              aria-label={playing ? 'Pause' : ended ? 'Replay' : 'Play'}
            >
              {playing ? (
                <Pause className="h-4 w-4" />
              ) : ended ? (
                <RotateCcw className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4 fill-current pl-0.5" />
              )}
            </button>

            <VolumeControl
              muted={muted}
              volume={volume}
              onToggleMute={toggleMute}
              onVolume={onVolumeChange}
            />

            <span className="ml-1 font-mono text-[12px] tabular-nums text-white/80">
              {formatTime(progress)} / {formatTime(duration)}
            </span>

            <div className="ml-auto">
              <button
                type="button"
                onClick={toggleFullscreen}
                className="grid h-8 w-8 place-items-center rounded-full bg-white/10 hover:bg-white/20"
                aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
              >
                {fullscreen ? (
                  <Minimize2 className="h-4 w-4" />
                ) : (
                  <Maximize2 className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------------ */

function ScrubBar({
  current,
  duration,
  buffered,
  onSeek,
}: {
  current: number;
  duration: number;
  buffered: number;
  onSeek: (next: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const draggingRef = useRef(false);

  const pct = duration > 0 ? (current / duration) * 100 : 0;
  const bufPct = duration > 0 ? (buffered / duration) * 100 : 0;

  const computePctFromEvent = (clientX: number): number => {
    const el = trackRef.current;
    if (!el || duration <= 0) return 0;
    const rect = el.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    onSeek(computePctFromEvent(e.clientX) * duration);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = computePctFromEvent(e.clientX);
    setHoverPct(p * 100);
    if (draggingRef.current) {
      onSeek(p * duration);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      ref={trackRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setHoverPct(null)}
      className="group/scrub relative h-3 cursor-pointer touch-none select-none"
      role="slider"
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.max(0, Math.floor(duration))}
      aria-valuenow={Math.floor(current)}
      tabIndex={0}
    >
      {/* Track */}
      <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-white/15">
        {/* Buffered */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-white/30"
          style={{ width: `${bufPct}%` }}
        />
        {/* Played */}
        <div
          className="absolute inset-y-0 left-0 rounded-full bg-[#DFFF00]"
          style={{ width: `${pct}%` }}
        />
        {/* Hover preview tick */}
        {hoverPct !== null && (
          <div
            className="absolute inset-y-0 w-[2px] bg-white/40"
            style={{ left: `${hoverPct}%` }}
          />
        )}
      </div>
      {/* Thumb */}
      <div
        className="
          absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2
          rounded-full bg-[#DFFF00] opacity-0 transition-opacity
          group-hover/scrub:opacity-100
        "
        style={{ left: `${pct}%` }}
      />
    </div>
  );
}

function VolumeControl({
  muted,
  volume,
  onToggleMute,
  onVolume,
}: {
  muted: boolean;
  volume: number;
  onToggleMute: () => void;
  onVolume: (next: number) => void;
}) {
  return (
    <div className="group/vol flex items-center gap-2">
      <button
        type="button"
        onClick={onToggleMute}
        className="grid h-8 w-8 place-items-center rounded-full bg-white/10 hover:bg-white/20"
        aria-label={muted ? 'Unmute' : 'Mute'}
      >
        {muted || volume === 0 ? (
          <VolumeX className="h-4 w-4" />
        ) : (
          <Volume2 className="h-4 w-4" />
        )}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={muted ? 0 : volume}
        onChange={(e) => onVolume(parseFloat(e.target.value))}
        aria-label="Volume"
        className="
          h-[3px] w-20 cursor-pointer appearance-none rounded-full bg-white/20 transition-all
          [&::-webkit-slider-thumb]:appearance-none
          [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:w-3
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white
          [&::-moz-range-thumb]:h-3 [&::-moz-range-thumb]:w-3
          [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:rounded-full
          [&::-moz-range-thumb]:bg-white
        "
      />
    </div>
  );
}
