import { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';

export interface Track {
  src: string;
  title: string;
  subtitle?: string;
  image?: string;
  /** Set for user-generated audio (TTS/STT/clone/voice-design results, history items).
   *  When present, the StudioPlayerBar exposes a Download button. Demo samples omit this. */
  downloadFilename?: string;
  /** Caller's known duration in seconds, used to paint the progress
   *  bar correctly while the real ``loadedmetadata`` is still in
   *  flight. Without this, ``playAt(track, 42)`` would flash the
   *  bar at 0:00 (duration unknown → pct=0) before snapping to
   *  the target offset once metadata arrives. Optional — pass it
   *  when you know the duration up front (e.g. call recordings
   *  have ``call.duration_ms`` on the row already). */
  durationHintSec?: number;
}

type RepeatMode = 'off' | 'all' | 'one';

interface StudioPlayerState {
  track: Track | null;
  playing: boolean;
  progress: number;
  duration: number;
  // Queue
  queue: Track[];
  queueIndex: number;
  shuffle: boolean;
  repeat: RepeatMode;
  queueSource: string | null; // e.g. "Playbook: My Mix"
  // Actions
  play: (track: Track) => void;
  playQueue: (tracks: Track[], startIndex?: number, source?: string) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  seek: (pct: number) => void;
  /** Seek directly to an absolute offset in seconds. Used by surfaces
   *  that know the offset they want (call transcript click → "play
   *  this turn") and shouldn't have to convert to percent. Safe to
   *  call before metadata loads — the seek is deferred until the
   *  next loadedmetadata event in that case. */
  seekToSeconds: (sec: number) => void;
  /** Convenience: load a track AND start playback at an offset, in
   *  one call. If the requested track is already the loaded one, we
   *  just seek + resume instead of restarting. */
  playAt: (track: Track, startSec: number) => void;
  setVolume: (v: number) => void;
  next: () => void;
  prev: () => void;
  toggleShuffle: () => void;
  toggleRepeat: () => void;
}

const StudioPlayerContext = createContext<StudioPlayerState | undefined>(undefined);

export function StudioPlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [queue, setQueue] = useState<Track[]>([]);
  const [queueIndex, setQueueIndex] = useState(-1);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<RepeatMode>('off');
  const [queueSource, setQueueSource] = useState<string | null>(null);

  // Shuffled order
  const shuffledRef = useRef<number[]>([]);

  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    const el = audioRef.current;
    const onTime = () => { setProgress(el.currentTime); setDuration(el.duration || 0); };
    const onEnd = () => handleTrackEnd();
    const onLoaded = () => setDuration(el.duration || 0);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnd);
    el.addEventListener('loadedmetadata', onLoaded);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnd);
      el.removeEventListener('loadedmetadata', onLoaded);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const generateShuffleOrder = useCallback((length: number, currentIdx: number) => {
    const indices = Array.from({ length }, (_, i) => i).filter(i => i !== currentIdx);
    for (let i = indices.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [indices[i], indices[j]] = [indices[j], indices[i]];
    }
    // Put current first
    shuffledRef.current = [currentIdx, ...indices];
  }, []);

  const playTrackAtIndex = useCallback((idx: number, q?: Track[]) => {
    const currentQueue = q || queue;
    if (idx < 0 || idx >= currentQueue.length) return;
    const el = audioRef.current;
    if (!el) return;
    const t = currentQueue[idx];
    el.pause();
    el.src = t.src;
    el.currentTime = 0;
    setTrack(t);
    setQueueIndex(idx);
    setProgress(0);
    el.play().catch(() => {});
    setPlaying(true);
  }, [queue]);

  const handleTrackEnd = useCallback(() => {
    if (repeat === 'one') {
      const el = audioRef.current;
      if (el) { el.currentTime = 0; el.play().catch(() => {}); }
      return;
    }

    if (queue.length <= 1 && repeat === 'off') {
      setPlaying(false);
      setProgress(0);
      return;
    }

    // Determine next index
    let nextIdx: number;
    if (shuffle) {
      const currentShufflePos = shuffledRef.current.indexOf(queueIndex);
      const nextShufflePos = currentShufflePos + 1;
      if (nextShufflePos >= shuffledRef.current.length) {
        if (repeat === 'all') {
          generateShuffleOrder(queue.length, 0);
          nextIdx = shuffledRef.current[0];
        } else {
          setPlaying(false);
          setProgress(0);
          return;
        }
      } else {
        nextIdx = shuffledRef.current[nextShufflePos];
      }
    } else {
      nextIdx = queueIndex + 1;
      if (nextIdx >= queue.length) {
        if (repeat === 'all') {
          nextIdx = 0;
        } else {
          setPlaying(false);
          setProgress(0);
          return;
        }
      }
    }
    playTrackAtIndex(nextIdx);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repeat, shuffle, queue, queueIndex]);

  // Re-attach ended handler when dependencies change
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onEnd = () => handleTrackEnd();
    el.addEventListener('ended', onEnd);
    return () => el.removeEventListener('ended', onEnd);
  }, [handleTrackEnd]);

  const play = useCallback((t: Track) => {
    const el = audioRef.current;
    if (!el) return;
    el.pause();
    el.src = t.src;
    el.currentTime = 0;
    setTrack(t);
    setQueue([t]);
    setQueueIndex(0);
    setQueueSource(null);
    setProgress(0);
    el.play().catch(() => {});
    setPlaying(true);
  }, []);

  const playQueue = useCallback((tracks: Track[], startIndex = 0, source?: string) => {
    if (tracks.length === 0) return;
    setQueue(tracks);
    setQueueSource(source || null);
    if (shuffle) {
      generateShuffleOrder(tracks.length, startIndex);
    }
    playTrackAtIndex(startIndex, tracks);
  }, [shuffle, generateShuffleOrder, playTrackAtIndex]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setPlaying(false);
  }, []);

  const resume = useCallback(() => {
    audioRef.current?.play().catch(() => {});
    setPlaying(true);
  }, []);

  const stop = useCallback(() => {
    const el = audioRef.current;
    if (el) { el.pause(); el.currentTime = 0; }
    setTrack(null);
    setPlaying(false);
    setProgress(0);
    setDuration(0);
    setQueue([]);
    setQueueIndex(-1);
    setQueueSource(null);
  }, []);

  const seek = useCallback((pct: number) => {
    const el = audioRef.current;
    if (el && el.duration) {
      el.currentTime = (pct / 100) * el.duration;
      setProgress(el.currentTime);
    }
  }, []);

  const seekToSeconds = useCallback((sec: number) => {
    const el = audioRef.current;
    if (!el) return;
    const safeSec = Math.max(0, sec);
    if (el.duration && el.duration > 0) {
      // Metadata already loaded — seek immediately.
      el.currentTime = Math.min(safeSec, el.duration);
      setProgress(el.currentTime);
      return;
    }
    // Metadata not ready yet (likely a fresh play() that hasn't
    // resolved loadedmetadata). Defer the seek to the next
    // loadedmetadata event, fire once, then clean up.
    const onMeta = () => {
      el.currentTime = Math.min(safeSec, el.duration || safeSec);
      setProgress(el.currentTime);
      el.removeEventListener('loadedmetadata', onMeta);
    };
    el.addEventListener('loadedmetadata', onMeta);
  }, []);

  const playAt = useCallback((t: Track, startSec: number) => {
    const el = audioRef.current;
    if (!el) return;
    const safeSec = Math.max(0, startSec);
    // Same track already loaded → just seek + resume; no re-fetch.
    if (track && track.src === t.src) {
      if (el.duration && el.duration > 0) {
        el.currentTime = Math.min(safeSec, el.duration);
        setProgress(el.currentTime);
      } else {
        const onMeta = () => {
          el.currentTime = Math.min(safeSec, el.duration || safeSec);
          setProgress(el.currentTime);
          el.removeEventListener('loadedmetadata', onMeta);
        };
        el.addEventListener('loadedmetadata', onMeta);
      }
      if (!playing) {
        el.play().catch(() => {});
        setPlaying(true);
      }
      return;
    }
    // Different track — load it, then defer the audio-element
    // seek until loadedmetadata fires (currentTime is meaningless
    // before then). Optimistically paint the UI at the target
    // offset so we don't flash 0:00 → target. The actual audio
    // currentTime catches up once metadata lands.
    el.pause();
    el.src = t.src;
    el.currentTime = 0;
    setTrack(t);
    setQueue([t]);
    setQueueIndex(0);
    setQueueSource(null);
    // Optimistic UI paint: progress=target, duration=hint (when
    // provided). The progress bar percentage = progress/duration,
    // so both have to land in one render or the bar still flashes.
    // Once timeupdate fires after the deferred seek, these snap
    // to the real audio-element values.
    setProgress(safeSec);
    if (t.durationHintSec && t.durationHintSec > 0) {
      setDuration(t.durationHintSec);
    }
    const onMeta = () => {
      el.currentTime = Math.min(safeSec, el.duration || safeSec);
      setProgress(el.currentTime);
      el.removeEventListener('loadedmetadata', onMeta);
    };
    el.addEventListener('loadedmetadata', onMeta);
    el.play().catch(() => {});
    setPlaying(true);
  }, [track, playing]);

  const setVolumeVal = useCallback((v: number) => {
    const el = audioRef.current;
    if (el) el.volume = v;
  }, []);

  const next = useCallback(() => {
    if (queue.length <= 1) return;
    let nextIdx: number;
    if (shuffle) {
      const currentShufflePos = shuffledRef.current.indexOf(queueIndex);
      const nextShufflePos = currentShufflePos + 1;
      nextIdx = nextShufflePos < shuffledRef.current.length
        ? shuffledRef.current[nextShufflePos]
        : shuffledRef.current[0];
    } else {
      nextIdx = (queueIndex + 1) % queue.length;
    }
    playTrackAtIndex(nextIdx);
  }, [queue, queueIndex, shuffle, playTrackAtIndex]);

  const prev = useCallback(() => {
    // If more than 3 seconds in, restart current track
    const el = audioRef.current;
    if (el && el.currentTime > 3) {
      el.currentTime = 0;
      setProgress(0);
      return;
    }
    if (queue.length <= 1) return;
    let prevIdx: number;
    if (shuffle) {
      const currentShufflePos = shuffledRef.current.indexOf(queueIndex);
      const prevShufflePos = currentShufflePos - 1;
      prevIdx = prevShufflePos >= 0
        ? shuffledRef.current[prevShufflePos]
        : shuffledRef.current[shuffledRef.current.length - 1];
    } else {
      prevIdx = (queueIndex - 1 + queue.length) % queue.length;
    }
    playTrackAtIndex(prevIdx);
  }, [queue, queueIndex, shuffle, playTrackAtIndex]);

  const toggleShuffle = useCallback(() => {
    setShuffle(s => {
      const newShuffle = !s;
      if (newShuffle && queue.length > 1) {
        generateShuffleOrder(queue.length, queueIndex);
      }
      return newShuffle;
    });
  }, [queue, queueIndex, generateShuffleOrder]);

  const toggleRepeat = useCallback(() => {
    setRepeat(r => r === 'off' ? 'all' : r === 'all' ? 'one' : 'off');
  }, []);

  return (
    <StudioPlayerContext.Provider value={{
      track, playing, progress, duration,
      queue, queueIndex, shuffle, repeat, queueSource,
      play, playQueue, pause, resume, stop, seek, seekToSeconds, playAt,
      setVolume: setVolumeVal,
      next, prev, toggleShuffle, toggleRepeat,
    }}>
      {children}
    </StudioPlayerContext.Provider>
  );
}

export function useStudioPlayer() {
  const ctx = useContext(StudioPlayerContext);
  if (!ctx) throw new Error('useStudioPlayer must be used within StudioPlayerProvider');
  return ctx;
}
