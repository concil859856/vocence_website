import { useState, useRef, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Play, Pause, Volume2, Download, ArrowLeft } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { dashboardApi } from '../services/dashboardApi';

function formatTime(s: number) {
  if (!isFinite(s) || s < 0) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function StudioResult() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!id || !user) {
      if (!user) navigate('/studio');
      setLoading(false);
      return;
    }
    const historyId = parseInt(id, 10);
    if (Number.isNaN(historyId)) {
      setError('Invalid result id');
      setLoading(false);
      return;
    }
    dashboardApi
      .getStudioHistoryAudioUrl(historyId, user.id)
      .then(({ audio_url }) => {
        setAudioUrl(audio_url);
        setLoading(false);
      })
      .catch((err) => {
        setError(err?.message || 'Failed to load audio');
        setLoading(false);
      });
  }, [id, user, navigate]);

  const handlePlayPause = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      el.play();
      setIsPlaying(true);
    } else {
      el.pause();
      setIsPlaying(false);
    }
  };

  const handleEnded = () => setIsPlaying(false);
  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const el = audioRef.current;
    if (!el || !duration) return;
    const t = parseFloat(e.target.value);
    el.currentTime = t;
    setCurrentTime(t);
  };
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (audioRef.current) audioRef.current.volume = v;
  };

  const handleDownload = () => {
    if (!audioUrl) return;
    const a = document.createElement('a');
    a.href = audioUrl;
    a.download = `vocence-tts-${id}.wav`;
    a.click();
  };

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
          <p className="text-[#A7B0B7] text-sm mb-6">Audio is available for 7 days. You can generate a new one from Studio.</p>
          <button onClick={() => navigate('/studio')} className="btn-primary inline-flex items-center gap-2">
            <ArrowLeft size={18} />
            Back to Studio
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#07080A] pt-24 pb-12">
      <div className="max-w-2xl mx-auto px-6">
        <button
          onClick={() => navigate('/studio')}
          className="flex items-center gap-2 text-[#A7B0B7] hover:text-white mb-8 transition-colors"
        >
          <ArrowLeft size={20} />
          Back to Studio
        </button>

        <div className="card-vocence p-8">
          <h1 className="text-2xl font-semibold mb-1">Your generated audio</h1>
          <p className="text-[#A7B0B7] text-sm mb-8">Available for 7 days. Use the player below to listen or download.</p>

          <audio
            ref={audioRef}
            src={audioUrl}
            onEnded={handleEnded}
            onPlay={() => setIsPlaying(true)}
            onPause={() => setIsPlaying(false)}
            onTimeUpdate={() => setCurrentTime(audioRef.current?.currentTime ?? 0)}
            onDurationChange={() => setDuration(audioRef.current?.duration ?? 0)}
            onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
          />

          {/* Capsule-style player: play, time, progress, volume, download */}
          <div className="flex items-center gap-3 p-3 rounded-full bg-[#0a0a0a] border border-white/10">
            <button
              onClick={handlePlayPause}
              className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20 shrink-0"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause size={18} fill="currentColor" /> : <Play size={18} className="ml-0.5" fill="currentColor" />}
            </button>
            <span className="text-sm text-white tabular-nums shrink-0">
              {formatTime(currentTime)} / {formatTime(duration)}
            </span>
            <input
              type="range"
              min={0}
              max={duration || 1}
              step={0.1}
              value={currentTime}
              onChange={handleSeek}
              className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer bg-white/10 accent-[#DFFF00]"
            />
            <Volume2 size={18} className="text-[#A7B0B7] shrink-0" />
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={handleVolumeChange}
              className="w-16 h-1.5 rounded-full appearance-none cursor-pointer bg-white/10 accent-[#DFFF00] shrink-0"
              aria-label="Volume"
            />
            <button
              onClick={handleDownload}
              className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center text-white hover:bg-white/20 shrink-0"
              aria-label="Download"
            >
              <Download size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
