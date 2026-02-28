import { useState, useRef, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Play, Pause, Volume2, VolumeX, Download, ArrowLeft } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { dashboardApi } from '../services/dashboardApi';

export function StudioResult() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
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
  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    if (audioRef.current) audioRef.current.volume = v;
  };
  const toggleMute = () => {
    const next = !muted;
    setMuted(next);
    if (audioRef.current) audioRef.current.volume = next ? 0 : volume;
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
          />

          <div className="flex flex-col sm:flex-row items-center gap-6">
            <button
              onClick={handlePlayPause}
              className="w-14 h-14 rounded-full bg-[#DFFF00] text-[#07080A] flex items-center justify-center hover:bg-[#DFFF00]/90 transition-colors shrink-0"
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} className="ml-0.5" fill="currentColor" />}
            </button>

            <div className="flex-1 w-full flex items-center gap-4">
              <button
                onClick={toggleMute}
                className="p-2 rounded-lg text-[#A7B0B7] hover:text-white hover:bg-white/10 transition-colors"
                aria-label={muted ? 'Unmute' : 'Mute'}
              >
                {muted ? <VolumeX size={22} /> : <Volume2 size={22} />}
              </button>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={muted ? 0 : volume}
                onChange={handleVolumeChange}
                className="flex-1 h-2 bg-white/10 rounded-full appearance-none cursor-pointer accent-[#DFFF00]"
              />
            </div>

            <button
              onClick={handleDownload}
              className="btn-outline inline-flex items-center gap-2 shrink-0"
            >
              <Download size={18} />
              Download
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
