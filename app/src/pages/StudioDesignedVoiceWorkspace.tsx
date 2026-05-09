import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AlertCircle, ArrowLeft, BookOpen, Download, Play } from 'lucide-react';
import { StudioShell } from '../components/StudioShell';
import { AuthModal } from '../components/AuthModal';
import { useAuth } from '../contexts/AuthContext';
import { useStudioPlayer } from '../contexts/StudioPlayerContext';
import { dashboardApi, type StudioDesignedVoiceItem } from '../services/dashboardApi';
import { useGenerations } from '../contexts/GenerationsContext';
import { CREDIT_MY_VOICE_GENERATE } from '../studio/creditCosts';

/** Designed-voice script: character cap (shown to user only if they try to exceed it). */
const SCRIPT_MAX_CHARS = 2000;

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
  const player = useStudioPlayer();
  const generations = useGenerations();
  const { voiceId: voiceIdParam } = useParams<{ voiceId: string }>();
  const navigate = useNavigate();
  const { user, isAuthenticated, setLocalCredits } = useAuth();
  const [isAuthModalOpen, setIsAuthModalOpen] = useState(false);
  const voiceId = voiceIdParam ? parseInt(voiceIdParam, 10) : NaN;

  const [voice, setVoice] = useState<StudioDesignedVoiceItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [targetText, setTargetText] = useState('');
  const [scriptLimitNotice, setScriptLimitNotice] = useState(false);
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
    setScriptLimitNotice(false);
    setResult(null);
    setNotice(null);
  }, [voiceId]);

  const handleScriptChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    if (v.length <= SCRIPT_MAX_CHARS) {
      setTargetText(v);
      setScriptLimitNotice(false);
    } else {
      setTargetText(v.slice(0, SCRIPT_MAX_CHARS));
      setScriptLimitNotice(true);
    }
  }, []);

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
      if (targetText.length > SCRIPT_MAX_CHARS) {
        setScriptLimitNotice(true);
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
      const label = `${voice?.display_name || 'Designed voice'} — ${text.slice(0, 60)}`;
      void (async () => {
        try {
          const submission = await dashboardApi.startJob({
            type: 'voice_design',
            credits: CREDIT_MY_VOICE_GENERATE,
            payload: { mode: 'speak', voice_id: voiceId, target_text: text },
          }, token);
          setLocalCredits((user.credits ?? 0) - CREDIT_MY_VOICE_GENERATE);
          setNotice({
            type: 'info' as never,
            message: submission.load_warning
              ? `Queued (position ${submission.queue_position}). Capacity is heavy — this might take roughly 2× as long as usual.`
              : `Queued (position ${submission.queue_position}). Generating…`,
          } as never);
          generations.trackServerJob({
            serverJobId: submission.job_id,
            type: 'voice_design',
            label,
            toastResult: {
              navigateTo: `/studio/my-voices/${voiceId}`,
              playerTitle: voice?.display_name || 'Designed voice',
              playerSubtitle: text.slice(0, 80),
              downloadFilename: `vocence-designed-${submission.job_id.slice(0, 8)}.wav`,
            },
          });
          // Local poll for in-page result + auto-play
          let done = false;
          while (!done) {
            await new Promise((r) => setTimeout(r, 2000));
            try {
              const job = await dashboardApi.getJob(submission.job_id, token);
              if (job.status === 'completed') {
                const audioUrl = (job.result?.audio_url as string | undefined) || '';
                const historyId = (job.result?.history_id as number | undefined) || Date.now();
                setResult({ id: historyId, audioUrl });
                if (audioUrl) {
                  player.play({
                    src: audioUrl,
                    title: voice?.display_name || 'Designed voice',
                    subtitle: text.slice(0, 80),
                    downloadFilename: `vocence-designed-${historyId}.wav`,
                  });
                }
                done = true;
              } else if (['failed', 'timeout', 'cancelled'].includes(job.status)) {
                setNotice({ type: 'error', message: job.error_message || 'Generation failed.' });
                setLocalCredits((user.credits ?? 0) + CREDIT_MY_VOICE_GENERATE);
                done = true;
              }
            } catch { /* keep polling */ }
          }
        } catch (e) {
          setNotice({ type: 'error', message: userFacingApiError(e) });
        } finally {
          setGenLoading(false);
        }
      })();
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
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-2xl font-semibold text-white tracking-tight">
                  {voice?.display_name ?? 'Your voice'}
                </h1>
                {voice?.model_name ? <p className="text-xs text-[#6B7280] mt-1">{voice.model_name}</p> : null}
              </div>
              <a
                href="/docs/guide-cloning"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-xs text-[#A7B0B7] hover:border-white/25 hover:text-white transition-colors"
              >
                <BookOpen size={14} />
                Guide
              </a>
            </div>
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
                <div
                  className={`flex flex-col rounded-2xl border bg-[#0a0b0e] p-4 transition-colors ${
                    scriptLimitNotice
                      ? 'border-amber-500/45 ring-1 ring-amber-500/20'
                      : 'border-white/10 focus-within:border-cyan-500/40'
                  }`}
                >
                  <textarea
                    value={targetText}
                    onChange={handleScriptChange}
                    placeholder="Type what this voice should say…"
                    rows={5}
                    className="min-h-[150px] w-full resize-y bg-transparent text-white placeholder-[#5c6370] outline-none text-[15px] leading-relaxed"
                    aria-invalid={scriptLimitNotice}
                    aria-describedby={scriptLimitNotice ? 'designed-voice-script-limit-hint' : undefined}
                  />
                  <div className="flex items-center justify-end mt-2 -mb-1">
                    <span
                      className={`text-[11px] tabular-nums ${
                        targetText.length >= SCRIPT_MAX_CHARS
                          ? 'text-amber-400'
                          : targetText.length >= SCRIPT_MAX_CHARS * 0.9
                            ? 'text-amber-300/70'
                            : 'text-[#666]'
                      }`}
                    >
                      {targetText.length.toLocaleString()} / {SCRIPT_MAX_CHARS.toLocaleString()}
                    </span>
                  </div>
                </div>
                {scriptLimitNotice ? (
                  <p
                    id="designed-voice-script-limit-hint"
                    className="text-xs text-amber-400/95 flex items-start gap-2 leading-relaxed"
                    role="alert"
                  >
                    <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" aria-hidden />
                    <span>
                      Script is limited to {SCRIPT_MAX_CHARS.toLocaleString()} characters. Anything beyond that
                      wasn&apos;t added—shorten your text or split it into multiple generations.
                    </span>
                  </p>
                ) : null}
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
