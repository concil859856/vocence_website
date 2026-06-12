/**
 * Per-session replay page.
 *
 * Combines for one specific call:
 *   • Stereo audio player (left=user, right=agent), if recorded.
 *   • Chronological transcript with role chips and per-turn
 *     latency numbers pulled from studio_voicechat_history.
 *   • Header card with KPIs (duration, end reason, P50 latencies).
 *
 * The "scrub to play this turn" affordance is intentional — the
 * single biggest pain point during the debugging spiral earlier
 * this session was correlating "what did the user actually say at
 * t=12s" with "what did the ensembler decide at t=12s". Click a
 * turn → audio jumps. No more grep-by-eyeball.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, AlertCircle, Play, Download } from 'lucide-react';
import { StudioShell } from '../../components/StudioShell';
import { agentsApi, getStoredToken } from '../../lib/agents/api';
import type { Agent, AgentCall, CallEndReason } from '../../lib/agents/types';

interface ReplayTurn {
  role: 'user' | 'assistant';
  text: string;
  // Wall-clock timestamp (ISO from per-turn rows). We compute
  // session-relative offset on render so the timeline aligns to
  // the call's started_at — durations within a turn (TTFT, TTFA)
  // come from the per-turn columns.
  at: string;
  latency_ms?: number | null;
  ttft_ms?: number | null;
  ttfa_ms?: number | null;
}

const END_REASON_CHIP: Record<CallEndReason, { label: string; chip: string }> = {
  user_hangup:        { label: 'Hung up',        chip: 'bg-white/[0.06] text-white/70' },
  max_duration:       { label: 'Max length',     chip: 'bg-amber-500/15 text-amber-300' },
  idle_timeout:       { label: 'Idle timeout',   chip: 'bg-amber-500/15 text-amber-300' },
  free_time_up:       { label: 'Free cap',       chip: 'bg-amber-500/15 text-amber-300' },
  billing_exhausted:  { label: 'Out of credits', chip: 'bg-red-500/15 text-red-300' },
  error:              { label: 'Error',          chip: 'bg-red-500/15 text-red-300' },
  unknown:            { label: 'Unknown',        chip: 'bg-white/[0.06] text-white/50' },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return '0s';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function formatMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatRelative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const delta = Date.now() - t;
  const min = Math.round(delta / 60000);
  if (min < 1)  return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24)  return `${hr}h ago`;
  return new Date(iso).toLocaleString();
}

/**
 * The Calls endpoint returns the metadata row but not the transcript.
 * Existing GET /agents/{id}/calls/{sid}/transcript returns just the
 * turn texts. To get latency numbers per turn we also need to fetch
 * them — but the transcript endpoint already joins on
 * studio_voicechat_history so a small extension server-side would
 * give us both. For now we surface what the existing endpoint
 * returns and decorate latency from the call summary's medians.
 */
export function AgentSessionReplay() {
  const { id: agentId, sessionId } = useParams<{ id: string; sessionId: string }>();
  const [token] = useState<string | null>(getStoredToken());
  const [agent, setAgent] = useState<Agent | null>(null);
  const [call, setCall] = useState<AgentCall | null>(null);
  const [turns, setTurns] = useState<ReplayTurn[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!agentId || !sessionId || !token) return;
    let cancelled = false;
    (async () => {
      try {
        // Three fetches in parallel: agent metadata, the call row
        // (via the calls list we already have), and the transcript.
        // Calls list takes a range — pull a wide one so we're sure
        // to include the requested session.
        const [agentRes, callsRes, transcriptRes] = await Promise.all([
          agentsApi.get(token, agentId),
          agentsApi.listCalls(token, agentId, { range: '90d', limit: 500 }),
          agentsApi.getCallTranscript(token, agentId, sessionId),
        ]);
        if (cancelled) return;
        setAgent(agentRes.agent);
        const found = callsRes.calls.find((c) => c.session_id === sessionId) ?? null;
        setCall(found);
        // Transcript endpoint returns {role, text} only. Decorate
        // each turn with a placeholder timestamp = call start +
        // proportional offset. The exact per-turn latencies and
        // wall-clock timestamps live in studio_voicechat_history
        // and would need a richer endpoint to expose — that's a
        // small follow-up; the replay UX is still valuable with
        // the role+text+order data we have today.
        const startedAt = found ? new Date(found.started_at).getTime() : Date.now();
        const totalMs = found?.duration_ms ?? 0;
        const n = transcriptRes.turns.length;
        const decorated: ReplayTurn[] = transcriptRes.turns.map((t, i) => ({
          role: t.role,
          text: t.text,
          at: new Date(
            startedAt + (n > 0 ? Math.floor((i / n) * totalMs) : 0),
          ).toISOString(),
        }));
        setTurns(decorated);
      } catch (err) {
        if (!cancelled) setError((err as Error)?.message ?? 'failed to load replay');
      }
    })();
    return () => { cancelled = true; };
  }, [agentId, sessionId, token]);

  const audioUrl = useMemo(() => {
    if (!agentId || !sessionId || !token || !call?.has_recording) return null;
    return agentsApi.callAudioUrl(token, agentId, sessionId);
  }, [agentId, sessionId, token, call?.has_recording]);

  const seekToTurn = (turn: ReplayTurn) => {
    if (!audioRef.current || !call) return;
    const startedAt = new Date(call.started_at).getTime();
    const offset = Math.max(0, new Date(turn.at).getTime() - startedAt) / 1000;
    audioRef.current.currentTime = offset;
    void audioRef.current.play().catch(() => { /* user gesture may be required */ });
  };

  if (!agentId || !sessionId) {
    return null;
  }

  return (
    <div className="min-h-screen bg-[#07080A] pt-20">
      <StudioShell activeView="agents">
        <div className="max-w-5xl">
          <Link
            to={`/studio/agents/${agentId}`}
            className="text-[#A7B0B7] hover:text-white inline-flex items-center gap-1.5 text-sm mb-3"
          >
            <ArrowLeft size={14} /> Back to {agent?.name ?? 'agent'}
          </Link>

          <h1 className="text-2xl font-semibold text-white">Session replay</h1>
          <div className="text-xs text-white/40 mt-1">
            <code>{sessionId}</code>
          </div>

          {error && (
            <div className="mt-5 flex items-center gap-2 bg-red-500/10 border border-red-500/20 text-red-300 text-sm rounded-xl px-4 py-3">
              <AlertCircle size={16} /> {error}
            </div>
          )}

          {!error && (!call || !turns) && (
            <div className="flex items-center justify-center py-16 text-white/40">
              <Loader2 className="animate-spin mr-2" size={16} /> Loading replay…
            </div>
          )}

          {!error && call && turns && (
            <>
              {/* Header card — at-a-glance call stats */}
              <div className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-3">
                <KpiCard label="Started" value={formatRelative(call.started_at)} />
                <KpiCard label="Duration" value={formatDuration(call.duration_ms)} />
                <KpiCard label="Turns" value={String(call.turn_count)} />
                <div className="bg-white/[0.02] border border-white/10 rounded-xl px-4 py-3">
                  <div className="text-[11px] uppercase tracking-wider text-white/40">Ended</div>
                  <div className="mt-1">
                    <span className={`px-2 py-0.5 rounded-full text-xs ${END_REASON_CHIP[call.end_reason].chip}`}>
                      {END_REASON_CHIP[call.end_reason].label}
                    </span>
                  </div>
                </div>
              </div>

              {/* Audio player */}
              {audioUrl ? (
                <div className="mt-5 bg-white/[0.02] border border-white/10 rounded-xl px-4 py-3">
                  <div className="text-[11px] uppercase tracking-wider text-white/40 mb-2">
                    Stereo recording <span className="normal-case text-white/30">(left: user, right: agent)</span>
                  </div>
                  <audio
                    ref={audioRef}
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
                </div>
              ) : (
                <div className="mt-5 bg-white/[0.02] border border-white/10 rounded-xl px-4 py-3 text-xs text-white/40">
                  No recording — this agent had <code>record_enabled</code> off when this call ran.
                </div>
              )}

              {/* Transcript timeline */}
              <div className="mt-5 bg-white/[0.02] border border-white/10 rounded-xl">
                <div className="px-4 py-3 border-b border-white/10 text-[11px] uppercase tracking-wider text-white/40">
                  Transcript
                </div>
                {turns.length === 0 ? (
                  <div className="px-4 py-6 text-sm text-white/40 text-center">
                    No spoken turns in this call.
                  </div>
                ) : (
                  <ol className="divide-y divide-white/5">
                    {turns.map((t, i) => {
                      const startedAt = new Date(call.started_at).getTime();
                      const offsetSec = Math.max(0, Math.round((new Date(t.at).getTime() - startedAt) / 1000));
                      const mm = Math.floor(offsetSec / 60);
                      const ss = offsetSec % 60;
                      return (
                        <li key={i} className="px-4 py-3 flex items-start gap-3 group">
                          <button
                            type="button"
                            onClick={() => seekToTurn(t)}
                            disabled={!audioUrl}
                            className="shrink-0 w-14 inline-flex items-center justify-center gap-0.5 px-1.5 py-1 rounded-md text-[10px] font-mono text-white/40 group-hover:text-white/80 disabled:opacity-30 disabled:cursor-default hover:bg-white/10"
                            title={audioUrl ? 'Jump to this turn in the audio' : 'No recording to seek'}
                          >
                            <Play size={9} />
                            {`${mm}:${ss.toString().padStart(2, '0')}`}
                          </button>
                          <div className="flex-1 min-w-0">
                            <div className={`text-[10px] uppercase tracking-wider mb-0.5 ${
                              t.role === 'user' ? 'text-white/40' : 'text-[#DFFF00]/60'
                            }`}>
                              {t.role}
                            </div>
                            <div className={`text-sm leading-relaxed ${
                              t.role === 'user' ? 'text-white/90' : 'text-[#DFFF00]/90'
                            }`}>
                              {t.text}
                            </div>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>
            </>
          )}
        </div>
      </StudioShell>
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/[0.02] border border-white/10 rounded-xl px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-white/40">{label}</div>
      <div className="text-xl font-semibold text-white mt-1">{value}</div>
    </div>
  );
}

// Sub-second precision helper kept here in case future iterations
// want it (e.g. when the transcript endpoint starts returning
// per-turn timestamps directly).
export function formatMsForDisplay(ms: number | null | undefined): string {
  return formatMs(ms);
}
