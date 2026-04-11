import { createContext, useContext, useState, useRef, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';

interface Track {
  src: string;
  title: string;
  subtitle?: string;
  image?: string;
}

interface StudioPlayerState {
  track: Track | null;
  playing: boolean;
  progress: number;
  duration: number;
  play: (track: Track) => void;
  pause: () => void;
  resume: () => void;
  stop: () => void;
  seek: (pct: number) => void;
  setVolume: (v: number) => void;
}

const StudioPlayerContext = createContext<StudioPlayerState | undefined>(undefined);

export function StudioPlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [track, setTrack] = useState<Track | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  // Lazy-create audio element once
  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }
    const el = audioRef.current;
    const onTime = () => {
      setProgress(el.currentTime);
      setDuration(el.duration || 0);
    };
    const onEnd = () => {
      setPlaying(false);
      setProgress(0);
    };
    const onLoaded = () => setDuration(el.duration || 0);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnd);
    el.addEventListener('loadedmetadata', onLoaded);
    return () => {
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnd);
      el.removeEventListener('loadedmetadata', onLoaded);
    };
  }, []);

  const play = useCallback((t: Track) => {
    const el = audioRef.current;
    if (!el) return;
    // If same track, just restart
    if (track?.src === t.src && !playing) {
      el.play().catch(() => {});
      setPlaying(true);
      setTrack(t);
      return;
    }
    el.pause();
    el.src = t.src;
    el.currentTime = 0;
    setTrack(t);
    setProgress(0);
    el.play().catch(() => {});
    setPlaying(true);
  }, [track, playing]);

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
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    setTrack(null);
    setPlaying(false);
    setProgress(0);
    setDuration(0);
  }, []);

  const seek = useCallback((pct: number) => {
    const el = audioRef.current;
    if (el && el.duration) {
      el.currentTime = (pct / 100) * el.duration;
      setProgress(el.currentTime);
    }
  }, []);

  const setVolumeVal = useCallback((v: number) => {
    const el = audioRef.current;
    if (el) el.volume = v;
  }, []);

  return (
    <StudioPlayerContext.Provider value={{ track, playing, progress, duration, play, pause, resume, stop, seek, setVolume: setVolumeVal }}>
      {children}
    </StudioPlayerContext.Provider>
  );
}

export function useStudioPlayer() {
  const ctx = useContext(StudioPlayerContext);
  if (!ctx) throw new Error('useStudioPlayer must be used within StudioPlayerProvider');
  return ctx;
}
