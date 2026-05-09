/**
 * StudioTtsGeneral — sample-voice-based TTS view.
 *
 * Uses the existing job system: startJob({ type: 'clone', payload: { sample_voice_id, target_text } })
 * + generations.trackServerJob(...). The user gets the same UX as PromptTTS:
 *   - Active-jobs pill in the sidebar
 *   - Toast with "View" / "Play" actions on completion
 *   - Auto-play in the bottom StudioPlayerBar
 */

import { useMemo, useState } from 'react';
import { AlertCircle, ChevronDown, Loader2, Play } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import { useGenerations } from '../../contexts/GenerationsContext';
import { useStudioPlayer } from '../../contexts/StudioPlayerContext';
import { dashboardApi } from '../../services/dashboardApi';
import { CREDIT_TTS } from '../../studio/creditCosts';
import { SAMPLE_VOICE_INDEX, SAMPLE_VOICES, type SampleVoice } from '../../data/sampleVoices';
import { SampleVoiceAvatar } from './SampleVoiceAvatar';
import { SampleVoicePickerModal } from './SampleVoicePickerModal';

const TTS_CONTENT_MAX_CHARS = 300;

export function StudioTtsGeneral() {
  const { user, setLocalCredits } = useAuth();
  const generations = useGenerations();
  const player = useStudioPlayer();

  // Default to the first Voice Design entry so the "no voice picked" state is rare
  const [selectedId, setSelectedId] = useState<string | null>(() => SAMPLE_VOICES[0]?.id ?? null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected: SampleVoice | null = selectedId ? SAMPLE_VOICE_INDEX[selectedId] ?? null : null;
  const charCount = text.length;
  const charPct = Math.min(100, (charCount / TTS_CONTENT_MAX_CHARS) * 100);
  const overLimit = charCount > TTS_CONTENT_MAX_CHARS;

  const barColor = useMemo(() => {
    if (charPct >= 95) return 'bg-red-400';
    if (charPct >= 80) return 'bg-amber-400';
    return 'bg-[#DFFF00]';
  }, [charPct]);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value;
    setText(v.length <= TTS_CONTENT_MAX_CHARS ? v : v.slice(0, TTS_CONTENT_MAX_CHARS));
  };

  const handleGenerate = async () => {
    setError(null);
    if (!user) { setError('Please sign in.'); return; }
    if (!selected) { setError('Pick a voice first.'); return; }
    const target = text.trim();
    if (!target) { setError('Type something for the voice to say.'); return; }
    if ((user.credits ?? 0) < CREDIT_TTS) {
      setError(`Need ${CREDIT_TTS} credits — you have ${user.credits ?? 0}.`);
      return;
    }
    setSubmitting(true);
    const label = target.slice(0, 80) || `Generated with ${selected.name}`;
    const subtitle = `Voice · ${selected.name}`;

    try {
      const token = localStorage.getItem('vocence_token');
      const submission = await dashboardApi.startJob(
        {
          type: 'clone',
          credits: CREDIT_TTS,
          payload: {
            sample_voice_id: selected.id,
            target_text: target,
          },
        },
        token,
      );
      // Optimistically deduct + register with the queue. The toast/pill +
      // auto-play in the bottom player happen via trackServerJob.
      setLocalCredits((user.credits ?? 0) - CREDIT_TTS);
      generations.trackServerJob({
        serverJobId: submission.job_id,
        type: 'clone',
        label,
        toastResult: {
          navigateTo: '/studio/tts',
          playerTitle: label,
          playerSubtitle: subtitle,
          downloadFilename: `vocence-tts-${submission.job_id.slice(0, 8)}.wav`,
        },
      });

      // Local poll so we can also auto-play in the bottom bar without waiting
      // for the toast click. (Same pattern as PromptTTS' handleGenerateAudio.)
      let done = false;
      while (!done) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const job = await dashboardApi.getJob(submission.job_id, token);
          if (job.status === 'completed') {
            const audioUrl = (job.result?.audio_url as string | undefined) || '';
            if (audioUrl) {
              player.play({
                src: audioUrl,
                title: label,
                subtitle,
                downloadFilename: `vocence-tts-${submission.job_id.slice(0, 8)}.wav`,
              });
            }
            done = true;
          } else if (['failed', 'timeout', 'cancelled'].includes(job.status)) {
            // refund optimistic credit deduction
            setLocalCredits((user.credits ?? 0));
            done = true;
          }
        } catch { /* keep polling */ }
      }
    } catch (err) {
      setError((err as Error).message || 'Generation failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Top control bar — voice picker pill */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="flex items-center gap-3 rounded-xl border border-white/15 bg-white/[0.03] hover:bg-white/[0.06] hover:border-white/25 transition-colors pl-1.5 pr-3 py-1.5"
        >
          {selected ? (
            <SampleVoiceAvatar voice={selected} size="sm" rounded="lg" />
          ) : (
            <div className="w-9 h-9 rounded-lg border border-white/10 bg-[#07080A] flex items-center justify-center shrink-0">
              <span className="text-[#666] text-xs">?</span>
            </div>
          )}
          <div className="text-left min-w-0">
            <div className="text-[10px] uppercase tracking-wider text-[#666] leading-none">Voice</div>
            <div className="text-sm font-semibold text-white leading-tight truncate">
              {selected ? selected.name : 'Choose a voice'}
            </div>
          </div>
          <ChevronDown size={16} className="text-[#A7B0B7] shrink-0" />
        </button>
      </div>

      {/* Big editor + vertical char bar */}
      <div className={`relative rounded-2xl border bg-[#0a0a0a] transition-colors ${
        overLimit ? 'border-amber-500/45 ring-1 ring-amber-500/20' : 'border-white/10 focus-within:border-[#DFFF00]/40'
      }`}>
        <div className="flex">
          <textarea
            value={text}
            onChange={handleTextChange}
            placeholder="Type or paste the script you want this voice to speak…"
            className="flex-1 bg-transparent text-white placeholder-[#666] resize-none outline-none px-6 py-5 text-base leading-relaxed font-normal"
            style={{ minHeight: 'min(60vh, 480px)' }}
          />
          <div className="w-14 sm:w-16 shrink-0 flex flex-col items-center justify-end pb-4 pt-3 border-l border-white/[0.06] bg-white/[0.01]">
            <div className="relative w-1.5 flex-1 rounded-full bg-white/[0.06] overflow-hidden">
              <div
                className={`absolute bottom-0 left-0 right-0 transition-[height,background-color] duration-150 ${barColor}`}
                style={{ height: `${charPct}%` }}
              />
            </div>
            <div className="mt-3 text-center tabular-nums">
              <div className={`text-sm font-semibold ${
                charCount >= TTS_CONTENT_MAX_CHARS ? 'text-amber-400' :
                charCount >= TTS_CONTENT_MAX_CHARS * 0.8 ? 'text-amber-300' :
                'text-white'
              }`}>{charCount}</div>
              <div className="text-[10px] text-[#666] leading-none mt-0.5">/ {TTS_CONTENT_MAX_CHARS}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Action row */}
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={submitting || !selected || !text.trim()}
          className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submitting ? (
            <><Loader2 size={16} className="animate-spin mr-2 inline-block" /> Generating…</>
          ) : (
            <><Play size={16} className="mr-2 inline-block" /> Generate ({CREDIT_TTS} cr)</>
          )}
        </button>

        {error && (
          <div className="text-xs text-red-300 flex items-start gap-2 leading-relaxed max-w-md">
            <AlertCircle size={14} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
      </div>

      <SampleVoicePickerModal
        open={pickerOpen}
        selectedId={selectedId}
        onSelect={(v) => setSelectedId(v.id)}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
