/**
 * Per-result thumbs-up / thumbs-down feedback control.
 *
 * Mounted on TTS results, agent calls, voice-clone results, etc. Posts
 * to ``/api/dashboard/feedback`` (via ``dashboardApi.submitGenerationFeedback``)
 * and reflects the user's previous vote on mount.
 *
 * UX:
 *   • Two icon buttons; the currently-selected one shows a lime/red
 *     fill. Clicking the active one again clears the vote (rating=0).
 *   • Optimistic: the button paints immediately on click; on server
 *     failure the previous state is restored and a small inline error
 *     appears below.
 *   • Compact by default (``compact``); set ``label`` to show
 *     "Was this helpful?" alongside.
 *   • For accessibility: each button has ``aria-pressed`` and
 *     ``aria-label`` reflecting its current state.
 *
 * Caller passes:
 *   • ``entryType`` — must match one of the EntryType literals in the
 *     backend (TTS, STT, clone, voice_design, music, noise_remover,
 *     agent_call, agent_message).
 *   • ``entryId`` — the row's primary key (string-encoded so it works
 *     for both INT history rows and UUID-style ids).
 *   • Optional ``onChange`` to mirror the rating into a parent's state.
 */

import { useCallback, useEffect, useState } from 'react';
import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { dashboardApi } from '../../services/dashboardApi';
import { useAuth } from '../../contexts/AuthContext';

export type FeedbackEntryType =
  | 'tts' | 'stt' | 'clone' | 'voice_design' | 'music'
  | 'noise_remover' | 'agent_call' | 'agent_message';

interface Props {
  entryType: FeedbackEntryType;
  entryId: string | number;
  /** Pre-paint a rating without re-fetching — useful when the parent
   *  already knows the user's vote. When omitted, the component fetches
   *  on mount. */
  initialRating?: -1 | 0 | 1;
  /** Show a label alongside the thumbs. */
  label?: string;
  /** Use small (default) or larger thumbs. */
  size?: 'sm' | 'md';
  /** Fires after every successful change. */
  onChange?: (rating: -1 | 0 | 1) => void;
}

export function ThumbsFeedback({
  entryType,
  entryId,
  initialRating,
  label,
  size = 'sm',
  onChange,
}: Props) {
  const { isAuthenticated } = useAuth();
  const [rating, setRating] = useState<-1 | 0 | 1>(initialRating ?? 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the existing vote on mount unless the caller already gave us one.
  useEffect(() => {
    if (initialRating !== undefined) return;
    if (!isAuthenticated) return;
    const token = localStorage.getItem('vocence_token');
    let cancelled = false;
    dashboardApi
      .getMyGenerationFeedback(entryType, String(entryId), token)
      .then((r) => {
        if (cancelled) return;
        const v = (r.rating === 1 ? 1 : r.rating === -1 ? -1 : 0) as -1 | 0 | 1;
        setRating(v);
      })
      .catch(() => { /* silent — no vote yet is not an error */ });
    return () => { cancelled = true; };
  }, [entryType, entryId, initialRating, isAuthenticated]);

  const submit = useCallback(
    async (target: 1 | -1) => {
      if (!isAuthenticated) {
        setError('Sign in to rate generations.');
        return;
      }
      // Clicking the active arrow clears the vote.
      const next: -1 | 0 | 1 = rating === target ? 0 : target;
      const previous = rating;
      setRating(next);
      onChange?.(next);
      setBusy(true);
      setError(null);
      const token = localStorage.getItem('vocence_token');
      try {
        await dashboardApi.submitGenerationFeedback(
          { entry_type: entryType, entry_id: String(entryId), rating: next },
          token,
        );
      } catch (e) {
        // Revert on failure so the UI doesn't lie about what's persisted.
        setRating(previous);
        onChange?.(previous);
        setError((e as Error).message || 'Could not save vote — try again.');
      } finally {
        setBusy(false);
      }
    },
    [entryType, entryId, rating, isAuthenticated, onChange],
  );

  const iconSize = size === 'md' ? 16 : 13;
  const pad = size === 'md' ? 'p-2' : 'p-1.5';

  return (
    <div className="inline-flex items-center gap-2">
      {label && (
        <span className="text-xs text-[#A7B0B7]">{label}</span>
      )}
      <div className="inline-flex items-center gap-0.5 rounded-lg border border-white/10 bg-white/[0.02] p-0.5">
        <button
          type="button"
          aria-label="Thumbs up"
          aria-pressed={rating === 1}
          disabled={busy}
          onClick={() => void submit(1)}
          className={`${pad} rounded-md transition-colors ${
            rating === 1
              ? 'bg-[#DFFF00]/[0.18] text-[#DFFF00]'
              : 'text-[#A7B0B7] hover:text-white hover:bg-white/[0.05]'
          } disabled:opacity-50`}
          title="Helpful"
        >
          <ThumbsUp size={iconSize} fill={rating === 1 ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          aria-label="Thumbs down"
          aria-pressed={rating === -1}
          disabled={busy}
          onClick={() => void submit(-1)}
          className={`${pad} rounded-md transition-colors ${
            rating === -1
              ? 'bg-red-500/20 text-red-200'
              : 'text-[#A7B0B7] hover:text-white hover:bg-white/[0.05]'
          } disabled:opacity-50`}
          title="Not helpful"
        >
          <ThumbsDown size={iconSize} fill={rating === -1 ? 'currentColor' : 'none'} />
        </button>
      </div>
      {error && (
        <span className="text-[11px] text-red-300 truncate max-w-[180px]">{error}</span>
      )}
    </div>
  );
}
