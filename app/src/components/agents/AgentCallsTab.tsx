/**
 * Per-agent call history.
 *
 *   • Table of recent calls (newest first) for one agent.
 *   • Range selector: 24h / 7d / 30d / 90d.
 *   • Each row shows duration, end reason, turn count.
 *
 * Recording playback + transcript download wire up in a follow-up
 * commit — this tab ships first with the listing + range filter so
 * the analytics surface is testable end-to-end without waiting for
 * the recording pipeline.
 */

import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2, Phone, AlertCircle, Play, FileText, X, Download, Trash2, ExternalLink } from 'lucide-react';
import { agentsApi } from '../../lib/agents/api';
import type { AgentCall, AnalyticsRange, CallEndReason } from '../../lib/agents/types';
import { useConfirm } from '../../hooks/useConfirm';

const RANGE_OPTIONS: { id: AnalyticsRange; label: string }[] = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
];

// Human-readable + colour-coded reason labels. The CSS class keeps
// the chip visually consistent with the rest of the dashboard's
// muted palette.
const REASON_PRESENTATION: Record<CallEndReason, { label: string; chip: string }> = {
  user_hangup:        { label: 'Hung up',     chip: 'bg-white/[0.06] text-white/70' },
  max_duration:       { label: 'Max length',  chip: 'bg-amber-500/15 text-amber-300' },
  idle_timeout:       { label: 'Idle timeout', chip: 'bg-amber-500/15 text-amber-300' },
  free_time_up:       { label: 'Free cap',    chip: 'bg-amber-500/15 text-amber-300' },
  billing_exhausted:  { label: 'Out of credits', chip: 'bg-red-500/15 text-red-300' },
  error:              { label: 'Error',       chip: 'bg-red-500/15 text-red-300' },
  unknown:            { label: 'Unknown',     chip: 'bg-white/[0.06] text-white/50' },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return '0s';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const delta = Date.now() - t;
  const min = Math.round(delta / 60000);
  if (min < 1)   return 'just now';
  if (min < 60)  return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24)   return `${hr}h ago`;
  const d = Math.round(hr / 24);
  if (d < 30)    return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

interface Props {
  agentId: string;
  token: string | null;
}

export function AgentCallsTab({ agentId, token }: Props) {
  const [range, setRange] = useState<AnalyticsRange>('30d');
  const [calls, setCalls] = useState<AgentCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Session_id of the call whose transcript modal is currently open.
  // Null when no modal is showing.
  const [openTranscriptFor, setOpenTranscriptFor] = useState<string | null>(null);
  // Session_id whose audio player is expanded inline. We keep audio
  // inline (vs a modal) so the user can keep scanning the table.
  const [playingFor, setPlayingFor] = useState<string | null>(null);
  // Session_id currently being deleted (POST in flight). Disables
  // the trash button to prevent double-fires.
  const [deletingFor, setDeletingFor] = useState<string | null>(null);
  const { confirm, dialog: confirmDialog } = useConfirm();

  const handleDeleteRecording = async (sessionId: string) => {
    if (!token) return;
    const ok = await confirm({
      title: 'Delete recording?',
      message:
        'This permanently removes the audio file. The call itself stays in the history (so your analytics are unchanged), but you won\'t be able to play or download this recording again.',
      confirmLabel: 'Delete recording',
      confirmVariant: 'danger',
    });
    if (!ok) return;
    setDeletingFor(sessionId);
    try {
      await agentsApi.deleteCallRecording(token, agentId, sessionId);
      // Optimistic local update: clear recording flags on the row so
      // the Play button disappears immediately, no refetch needed.
      setCalls((prev) =>
        prev.map((c) =>
          c.session_id === sessionId
            ? { ...c, has_recording: false, recording_bytes: null }
            : c,
        ),
      );
      // Collapse the player if it was open for this call.
      if (playingFor === sessionId) setPlayingFor(null);
    } catch (err) {
      setError((err as Error)?.message ?? 'failed to delete recording');
    } finally {
      setDeletingFor(null);
    }
  };

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    agentsApi.listCalls(token, agentId, { range })
      .then((res) => { if (!cancelled) setCalls(res.calls); })
      .catch((err) => { if (!cancelled) setError(err?.message ?? 'failed to load calls'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [agentId, token, range]);

  return (
    <div className="space-y-4">
      {/* Range selector */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-base font-semibold text-white">Calls</h2>
        <div className="flex items-center gap-1 bg-white/[0.04] border border-white/10 rounded-full p-0.5">
          {RANGE_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => setRange(opt.id)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                range === opt.id
                  ? 'bg-white/10 text-white'
                  : 'text-white/50 hover:text-white/80'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center py-16 text-white/40">
          <Loader2 className="animate-spin mr-2" size={16} />
          Loading…
        </div>
      )}

      {!loading && error && (
        <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 text-red-300 text-sm rounded-xl px-4 py-3">
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      {!loading && !error && calls.length === 0 && (
        <div className="text-center py-16 text-white/40">
          <Phone size={28} className="mx-auto mb-3 opacity-40" />
          <div className="text-sm">No calls in the last {RANGE_OPTIONS.find((r) => r.id === range)?.label}.</div>
          <div className="text-xs mt-1 opacity-60">
            Calls show up here as soon as users speak to this agent.
          </div>
        </div>
      )}

      {!loading && !error && calls.length > 0 && (
        <div className="bg-white/[0.02] border border-white/10 rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wider text-white/40 border-b border-white/10">
                <th className="px-4 py-3 font-medium">When</th>
                <th className="px-4 py-3 font-medium">Duration</th>
                <th className="px-4 py-3 font-medium">Turns</th>
                <th className="px-4 py-3 font-medium">Ended</th>
                <th className="px-4 py-3 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {calls.map((c) => {
                const pres = REASON_PRESENTATION[c.end_reason] ?? REASON_PRESENTATION.unknown;
                const playing = playingFor === c.session_id;
                const audioUrl = c.has_recording && token
                  ? agentsApi.callAudioUrl(token, agentId, c.session_id)
                  : null;
                return (
                  <Fragment key={c.session_id}>
                    <tr className="hover:bg-white/[0.02]">
                      <td className="px-4 py-3 text-white/80" title={c.started_at}>
                        {formatRelative(c.started_at)}
                      </td>
                      <td className="px-4 py-3 text-white/80">{formatDuration(c.duration_ms)}</td>
                      <td className="px-4 py-3 text-white/60">{c.turn_count}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-xs ${pres.chip}`}>
                          {pres.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex items-center gap-1">
                          {audioUrl ? (
                            <button
                              type="button"
                              onClick={() => setPlayingFor(playing ? null : c.session_id)}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-white/70 hover:bg-white/10 hover:text-white"
                              title="Play recording"
                            >
                              <Play size={12} /> Play
                            </button>
                          ) : (
                            <span className="text-xs text-white/30 px-2">No recording</span>
                          )}
                          <button
                            type="button"
                            onClick={() => setOpenTranscriptFor(c.session_id)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-white/70 hover:bg-white/10 hover:text-white"
                            title="View transcript"
                          >
                            <FileText size={12} /> Transcript
                          </button>
                          <Link
                            to={`/studio/agents/${agentId}/calls/${c.session_id}`}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-white/70 hover:bg-white/10 hover:text-white"
                            title="Open full replay (audio + transcript timeline)"
                          >
                            <ExternalLink size={12} /> Replay
                          </Link>
                          {/* Only show the Delete affordance when the
                              row actually has a recording — once the
                              file is gone the button has nothing to
                              act on, and showing a disabled button
                              would just be noise. */}
                          {c.has_recording && (
                            <button
                              type="button"
                              onClick={() => handleDeleteRecording(c.session_id)}
                              disabled={deletingFor === c.session_id}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-white/50 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-white/50"
                              title="Delete recording"
                            >
                              {deletingFor === c.session_id ? (
                                <Loader2 size={12} className="animate-spin" />
                              ) : (
                                <Trash2 size={12} />
                              )}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {playing && audioUrl && (
                      <tr className="bg-white/[0.015]">
                        <td colSpan={5} className="px-4 py-3">
                          {/* The src points at our endpoint which
                              authorizes (via vocence_session cookie)
                              and 302-redirects to a presigned R2
                              URL. ``crossOrigin="use-credentials"``
                              ensures the cookie is sent on the
                              initial request; the presigned URL
                              afterwards needs no auth. */}
                          <audio
                            controls
                            crossOrigin="use-credentials"
                            src={audioUrl}
                            className="w-full"
                          />
                          <div className="mt-2 text-right">
                            <a
                              href={`${audioUrl}?download=true`}
                              className="inline-flex items-center gap-1 text-xs text-white/60 hover:text-white"
                            >
                              <Download size={12} /> Download WAV
                            </a>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {openTranscriptFor && (
        <TranscriptModal
          agentId={agentId}
          sessionId={openTranscriptFor}
          token={token}
          onClose={() => setOpenTranscriptFor(null)}
        />
      )}
      {confirmDialog}
    </div>
  );
}

interface TranscriptModalProps {
  agentId: string;
  sessionId: string;
  token: string | null;
  onClose: () => void;
}

function TranscriptModal({ agentId, sessionId, token, onClose }: TranscriptModalProps) {
  const [turns, setTurns] = useState<{ role: 'user' | 'assistant'; text: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    agentsApi.getCallTranscript(token, agentId, sessionId)
      .then((res) => { if (!cancelled) setTurns(res.turns); })
      .catch((err) => { if (!cancelled) setError(err?.message ?? 'failed to load transcript'); });
    return () => { cancelled = true; };
  }, [agentId, sessionId, token]);

  const downloadJson = () => {
    if (!turns) return;
    const blob = new Blob(
      [JSON.stringify({ session_id: sessionId, turns }, null, 2)],
      { type: 'application/json' },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${sessionId}.transcript.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-[#0E1014] border border-white/10 rounded-2xl max-w-2xl w-full max-h-[80vh] flex flex-col">
        <div className="px-5 py-3 border-b border-white/10 flex items-center justify-between">
          <div>
            <div className="text-sm font-semibold text-white">Call transcript</div>
            <div className="text-[11px] text-white/40 mt-0.5">{sessionId}</div>
          </div>
          <div className="flex items-center gap-1">
            {turns && turns.length > 0 && (
              <button
                type="button"
                onClick={downloadJson}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs text-white/70 hover:bg-white/10 hover:text-white"
              >
                <Download size={12} /> JSON
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded-md text-white/60 hover:bg-white/10 hover:text-white"
            >
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="px-5 py-4 overflow-y-auto flex-1">
          {error && (
            <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          {!error && turns === null && (
            <div className="flex items-center text-white/40 text-sm">
              <Loader2 className="animate-spin mr-2" size={14} /> Loading…
            </div>
          )}
          {!error && turns && turns.length === 0 && (
            <div className="text-sm text-white/40">No spoken turns in this call.</div>
          )}
          {!error && turns && turns.length > 0 && (
            <div className="space-y-3">
              {turns.map((t, i) => (
                <div
                  key={i}
                  className={`text-sm leading-relaxed ${
                    t.role === 'user' ? 'text-white/90' : 'text-[#DFFF00]/90'
                  }`}
                >
                  <span className={`text-[10px] uppercase tracking-wider mr-2 ${
                    t.role === 'user' ? 'text-white/40' : 'text-[#DFFF00]/60'
                  }`}>
                    {t.role}
                  </span>
                  {t.text}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
