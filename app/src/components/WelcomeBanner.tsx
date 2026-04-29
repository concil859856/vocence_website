import { useState } from 'react';
import { Sparkles, X, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';

const KEY = 'vocence_welcome_dismissed_v1';

export function shouldShowWelcomeBanner(userCredits: number): boolean {
  try {
    if (localStorage.getItem(KEY)) return false;
  } catch { /* ignore */ }
  // Only show while the user still effectively has the signup bonus available.
  return userCredits >= 250;
}

interface Props {
  onDismiss?: () => void;
}

export function WelcomeBanner({ onDismiss }: Props) {
  const [closing, setClosing] = useState(false);

  const dismiss = () => {
    setClosing(true);
    try { localStorage.setItem(KEY, new Date().toISOString()); } catch { /* ignore */ }
    onDismiss?.();
  };

  if (closing) return null;

  return (
    <div className="relative overflow-hidden rounded-2xl border border-[#DFFF00]/30 bg-gradient-to-br from-[#DFFF00]/[0.10] via-[#DFFF00]/[0.04] to-transparent p-5 sm:p-6">
      <div className="absolute -right-8 -top-8 w-40 h-40 rounded-full bg-[#DFFF00]/10 blur-3xl pointer-events-none" />
      <button
        onClick={dismiss}
        className="absolute right-3 top-3 w-8 h-8 rounded-full hover:bg-white/10 text-[#A7B0B7] hover:text-white flex items-center justify-center"
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-6 relative">
        <div className="shrink-0 w-12 h-12 rounded-xl bg-[#DFFF00] text-[#07080A] flex items-center justify-center">
          <Sparkles size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-lg sm:text-xl font-semibold text-white leading-tight">
            Welcome to Vocence — you have <span className="text-[#DFFF00]">300 free credits</span>
          </h3>
          <p className="text-sm text-[#A7B0B7] mt-1.5 leading-relaxed">
            Enough for ~12 TTS clips, 6 voice clones, or 6 music tracks. Try Text-to-Speech to get started.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 sm:shrink-0">
          <Link
            to="/studio/tts"
            onClick={dismiss}
            className="inline-flex items-center gap-2 rounded-xl bg-[#DFFF00] text-[#07080A] px-4 py-2 text-sm font-semibold hover:brightness-110 transition-all"
          >
            Try TTS <ArrowRight size={14} />
          </Link>
          <Link
            to="/studio/voice-design"
            onClick={dismiss}
            className="inline-flex items-center gap-2 rounded-xl border border-white/15 px-4 py-2 text-sm text-white hover:bg-white/[0.05] transition-colors"
          >
            Design a voice
          </Link>
        </div>
      </div>
    </div>
  );
}
