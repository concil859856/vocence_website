import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Download, Play, Sparkles } from 'lucide-react';
import { StudioShell } from '../components/StudioShell';
import { VoiceDesignWavePlayer } from '../components/VoiceDesignWavePlayer';
import { AuthModal } from '../components/AuthModal';
import { useAuth } from '../contexts/AuthContext';
import { dashboardApi, type StudioDesignedVoiceItem } from '../services/dashboardApi';
import { CREDIT_MY_VOICE_GENERATE } from '../studio/creditCosts';
const USER_FACING_TRY_AGAIN = 'Something went wrong. Please try again later.';

function userFacingApiError(_e: unknown): string {
  return USER_FACING_TRY_AGAIN;
}

async function triggerBrowserDownload(url: string | null, filename: string) {
  if (!url?.trim()) return;
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
    URL.revokeObjectURL(objectUrl);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export function StudioDesignedVoiceWorkspace() {
  const { voiceId: voiceIdParam } = useParams<{ voiceId: string }>();
  const navigate = useNavigate();
  const { user, isAuthenticated, updateCredits } = useAuth();
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const voiceId = voiceIdParam ? parseInt(voiceIdParam, 10) : NaN;

  const [voice, setVoice] = useState<StudioDesignedVoiceItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [targetText, setTargetText] = useState('');
  const [genLoading, setGenLoading] = useState(false);
  const [result, setResult] = useState<{ id: number; audioUrl: string } | null>(null);
  const [notice, setNotice] = useState<{ type: 'error'; message: string } | null>(null);

  const loadVoice = useCallback(async () => {
    if (!user || !Number.isFinite(voiceId)) {
      setLoading(false);
      return;
    }
    const token = localStorage.getItem('vocence_token');
    setLoading(true);
    try {
      const r = await dashboardApi.listStudioDesignedVoices(token);
      const v = r.voices.find((x) => x.id === voiceId) ?? null;
      setVoice(v);
      if (v) setNotice(null);
      else setNotice({ type: 'error', message: 'Voice not found.' });
    } catch {
      setVoice(null);
      setNotice({ type: 'error', message: userFacingApiError(null) });
    } finally {
      setLoading(false);
    }
  }, [user, voiceId]);

  useEffect(() => {
    if (!isAuthenticated) {
      setLoading(false);
      return;
    }
    void loadVoice();
  }, [isAuthenticated, loadVoice]);

  useEffect(() => {
    setTargetText('');
    setResult(null);
    setNotice(null);
  }, [voiceId]);

  const requireAuth = useCallback(
    (fn: () => void) => {
      if (!isAuthenticated) {
        setIsAuthModalOpen(true);
        return;
      }
      fn();
    },
    [isAuthenticated],
  );

  const handleGenerate = () => {
    requireAuth(async () => {
      if (!user || !Number.isFinite(voiceId)) return;
      const text = targetText.trim();
      if (!text) {
        setNotice({ type: 'error', message: 'Enter the text you want this voice to speak.' });
        return;
      }
      if (user.credits < CREDIT_MY_VOICE_GENERATE) {
        setNotice({
          type: 'error',
          message: `You need at least ${CREDIT_MY_VOICE_GENERATE} credits to generate.`,
        });
        return;
      }
      const token = localStorage.getItem('vocence_token');
      setGenLoading(true);
      setNotice(null);
      setResult(null);
      try {
        const res = await dashboardApi.studioDesignedVoiceSpeak(
          { user_id: user.id, voice_id: voiceId, target_text: text },
          token,
        );
        updateCredits(res.credits);
        setResult({ id: res.id, audioUrl: res.audio_url });
      } catch (e) {
        setNotice({ type: 'error', message: userFacingApiError(e) });
      } finally {
        setGenLoading(false);
      }
    });
  };

  if (!Number.isFinite(voiceId)) {
    return (
      <div className="min-h-screen bg-[#07080A] pt-20">
        <StudioShell activeView="my-voices" mainClassName="flex flex-col">
          <p className="text-[#A7B0B7]">Invalid voice.</p>
          <Link to="/studio/my-voices" className="text-cyan-400 mt-3 text-sm hover:underline">
            Back to My voices
          </Link>
        </StudioShell>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#07080A] pt-20">
      {/* Coming-soon overlay */}
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-[#07080A]">
        <div className="text-center px-6 max-w-lg">
          <div className="mx-auto mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-[#DFFF00]/10 border border-[#DFFF00]/20">
            <Sparkles size={36} className="text-[#DFFF00]" />
          </div>
          <h1 className="text-3xl md:text-4xl font-semibold text-white mb-3">Studio Coming Soon</h1>
          <p className="text-sm md:text-base text-[#A7B0B7] leading-relaxed mb-8">
            We're putting the finishing touches on Vocence Studio — Text-to-Speech, Speech-to-Text, Voice Cloning, Voice Design, Music Generation, and more. Stay tuned!
          </p>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-xl bg-[#DFFF00] px-6 py-3 text-sm font-semibold text-[#07080A] transition-opacity hover:opacity-90"
          >
            Back to Home
          </a>
        </div>
      </div>

      <AuthModal isOpen={isAuthModalOpen} onClose={() => setIsAuthModalOpen(false)} />
      <StudioShell activeView="my-voices" mainClassName="flex flex-col min-h-[calc(100vh-5rem)]">
        <div className="flex flex-col flex-1 min-h-0 max-w-4xl mx-auto w-full gap-6">
          <div className="shrink-0">
            <Link
              to="/studio/my-voices"
              className="inline-flex items-center gap-2 text-sm text-[#A7B0B7] hover:text-white mb-3 transition-colors"
            >
              <ArrowLeft size={16} />
              My voices
            </Link>
            <h1 className="text-2xl font-semibold text-white tracking-tight">
              {voice?.display_name ?? 'Your voice'}
            </h1>
            {voice?.model_name ? <p className="text-xs text-[#6B7280] mt-1">{voice.model_name}</p> : null}
          </div>

          {!isAuthenticated ? (
            <div className="card-vocence p-8 text-center rounded-2xl">
              <p className="text-[#A7B0B7] mb-4">Sign in to generate speech with this voice.</p>
              <button type="button" className="btn-primary" onClick={() => setIsAuthModalOpen(true)}>
                Sign in
              </button>
            </div>
          ) : loading ? (
            <div className="flex items-center gap-2 text-[#A7B0B7] py-12">
              <div className="w-5 h-5 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin" />
              Loading…
            </div>
          ) : !voice ? (
            <div className="rounded-2xl border border-white/10 p-8 text-center">
              <p className="text-[#A7B0B7] mb-4">This voice could not be loaded.</p>
              <Link to="/studio/my-voices" className="btn-primary inline-flex">
                Back to My voices
              </Link>
            </div>
          ) : voice.expired ? (
            <p className="text-amber-200/90 rounded-xl border border-amber-500/25 bg-amber-500/10 px-4 py-3 text-sm">
              This voice reference has expired. Create a new voice in Voice Design.
            </p>
          ) : (
            <>
              {notice ? (
                <div className="rounded-xl border border-red-400/30 bg-red-500/10 px-4 py-3 text-sm text-red-200 shrink-0">
                  {notice.message}
                </div>
              ) : null}

              <div className="flex-1 flex flex-col gap-4 min-h-[12rem]">
                <label className="label-mono block text-xs text-[#A7B0B7]">Script</label>
                <textarea
                  value={targetText}
                  onChange={(e) => setTargetText(e.target.value)}
                  placeholder="Type what this voice should say…"
                  rows={8}
                  className="flex-1 min-h-[220px] w-full resize-y rounded-2xl border border-white/10 bg-[#0a0b0e] p-4 text-white placeholder-[#5c6370] outline-none focus:border-cyan-500/40 text-[15px] leading-relaxed"
                />
                <button
                  type="button"
                  onClick={() => void handleGenerate()}
                  disabled={genLoading}
                  className="btn-primary w-full sm:w-auto shrink-0 disabled:opacity-50"
                >
                  {genLoading ? (
                    <>
                      <span className="inline-block w-4 h-4 border-2 border-[#07080A] border-t-transparent rounded-full animate-spin mr-2 align-middle" />
                      Generating…
                    </>
                  ) : (
                    <>
                      <Play size={16} className="inline mr-2 align-middle" />
                      Generate ({CREDIT_MY_VOICE_GENERATE} cr)
                    </>
                  )}
                </button>
              </div>

              <section className="mt-auto pt-8 border-t border-white/[0.08] space-y-4 shrink-0 pb-4">
                <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-[#6B7280]">
                  Generated audio
                </h2>
                {result ? (
                  <div className="space-y-4">
                    <VoiceDesignWavePlayer src={result.audioUrl} variantKey={`workspace-out-${result.id}`} />
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn-outline text-sm"
                        onClick={() =>
                          void triggerBrowserDownload(result.audioUrl, `vocence-designed-${result.id}.wav`)
                        }
                      >
                        <Download size={14} className="inline mr-1" />
                        Download
                      </button>
                      <button
                        type="button"
                        className="btn-outline text-sm"
                        onClick={() => navigate(`/studio/result/${result.id}?entry_type=voice_design`)}
                      >
                        Open player page
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-[#5c6370] py-2">Run a generation to hear output here.</p>
                )}
              </section>
            </>
          )}
        </div>
      </StudioShell>
    </div>
  );
}
