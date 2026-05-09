/**
 * AgentRunViewer — /studio/agents/:id/runs/:runId
 * Iteration timeline + best output. Polls the run while it's running.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, Loader2, X } from 'lucide-react';
import { StudioShell } from '../../components/StudioShell';
import { agentsApi, getStoredToken } from '../../lib/agents/api';
import type { AgentRun } from '../../lib/agents/types';

export function AgentRunViewer() {
  const { id, runId } = useParams<{ id: string; runId: string }>();
  const [run, setRun] = useState<AgentRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    if (!id || !runId) return;
    const token = getStoredToken();
    if (!token) return;
    let cancelled = false;
    let timer: number | null = null;

    const fetchOnce = async () => {
      try {
        const { run } = await agentsApi.getRun(token, id, runId);
        if (cancelled) return;
        setRun(run);
        if (run.status === 'pending' || run.status === 'running') {
          timer = window.setTimeout(fetchOnce, 1500);
        }
      } catch (err) {
        if (!cancelled) setError((err as Error).message || 'Failed to load run');
      }
    };

    fetchOnce();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [id, runId]);

  const cancel = async () => {
    if (!id || !runId) return;
    const token = getStoredToken();
    if (!token) return;
    setCancelling(true);
    try {
      await agentsApi.cancelRun(token, id, runId);
    } catch (err) {
      setError((err as Error).message || 'Cancel failed');
    } finally {
      setCancelling(false);
    }
  };

  if (!run) {
    return (
      <div className="min-h-screen bg-[#07080A] pt-20">
        <StudioShell activeView="agents">
          <div className="flex items-center justify-center py-20">
            {error ? <div className="text-red-300 text-sm">{error}</div> : <Loader2 size={28} className="animate-spin text-[#A7B0B7]" />}
          </div>
        </StudioShell>
      </div>
    );
  }

  const isLive = run.status === 'pending' || run.status === 'running';

  return (
    <div className="min-h-screen bg-[#07080A] pt-20">
    <StudioShell activeView="agents">
      <div className="max-w-4xl">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Link to={`/studio/agents/${id}`} className="text-[#A7B0B7] hover:text-white inline-flex items-center gap-1 text-sm">
              <ArrowLeft size={16} /> Back to agent
            </Link>
            <h1 className="text-2xl font-semibold text-white">Run {run.id.slice(0, 8)}</h1>
            <StatusBadge status={run.status} />
          </div>
          {isLive && (
            <button
              type="button"
              onClick={cancel}
              disabled={cancelling}
              className="inline-flex items-center gap-2 rounded-lg bg-white/[0.04] hover:bg-white/[0.08] text-white px-3 py-1.5 text-sm disabled:opacity-40"
            >
              {cancelling ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />}
              Cancel
            </button>
          )}
        </div>

        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-5 mb-6">
          <div className="text-[11px] uppercase tracking-wider text-[#666] mb-1">Goal</div>
          <div className="text-sm text-white whitespace-pre-wrap mb-3">{run.goal || <span className="italic text-[#666]">none</span>}</div>
          <div className="text-[11px] uppercase tracking-wider text-[#666] mb-1">Success metric</div>
          <div className="text-sm text-white whitespace-pre-wrap">{run.success_metric || <span className="italic text-[#666]">none</span>}</div>
        </div>

        {run.error && (
          <div className="rounded-lg border border-red-400/30 bg-red-500/[0.06] text-red-200 text-sm px-3 py-2 mb-4">{run.error}</div>
        )}

        {run.best_output && (
          <div className="rounded-xl border border-emerald-400/30 bg-emerald-500/[0.04] p-5 mb-6">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle2 size={16} className="text-emerald-300" />
              <span className="text-[11px] uppercase tracking-wider text-emerald-300">Best output</span>
              {typeof run.best_score === 'number' && (
                <span className="text-xs text-emerald-300/80">score {run.best_score.toFixed(2)}</span>
              )}
            </div>
            <div className="text-sm text-white whitespace-pre-wrap leading-relaxed">{run.best_output}</div>
          </div>
        )}

        {/* Iteration timeline */}
        <h2 className="text-sm uppercase tracking-wider text-[#666] mb-3">Iterations ({run.iterations.length})</h2>
        <div className="space-y-3">
          {run.iterations.map((it) => (
            <div key={it.index} className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-7 h-7 rounded-full bg-[#DFFF00]/15 border border-[#DFFF00]/30 flex items-center justify-center text-xs text-[#DFFF00] font-semibold">
                  {it.index}
                </div>
                <span className="text-xs text-[#A7B0B7] tabular-nums">score {it.score.toFixed(2)}</span>
                <span className="text-xs text-[#666]">{new Date(it.created_at).toLocaleTimeString()}</span>
              </div>
              {it.thought && (
                <details className="mb-2">
                  <summary className="text-[11px] uppercase tracking-wider text-[#666] cursor-pointer hover:text-white">Thought</summary>
                  <div className="text-sm text-[#A7B0B7] whitespace-pre-wrap mt-1">{it.thought}</div>
                </details>
              )}
              <div className="text-[11px] uppercase tracking-wider text-[#666] mb-1">Output</div>
              <div className="text-sm text-white whitespace-pre-wrap leading-relaxed mb-2">{it.output}</div>
              {it.rationale && (
                <details>
                  <summary className="text-[11px] uppercase tracking-wider text-[#666] cursor-pointer hover:text-white">Rationale</summary>
                  <div className="text-sm text-[#A7B0B7] whitespace-pre-wrap mt-1">{it.rationale}</div>
                </details>
              )}
            </div>
          ))}
          {isLive && run.iterations.length === 0 && (
            <div className="rounded-xl border border-white/10 bg-white/[0.02] p-6 text-center text-sm text-[#A7B0B7]">
              <Loader2 size={20} className="animate-spin inline mr-2" />
              Starting…
            </div>
          )}
        </div>
      </div>
    </StudioShell>
    </div>
  );
}

function StatusBadge({ status }: { status: AgentRun['status'] }) {
  const map: Record<AgentRun['status'], string> = {
    pending: 'bg-white/5 text-[#A7B0B7] border-white/10',
    running: 'bg-blue-500/15 text-blue-200 border-blue-400/30',
    completed: 'bg-emerald-500/15 text-emerald-300 border-emerald-400/30',
    failed: 'bg-red-500/15 text-red-200 border-red-400/30',
    cancelled: 'bg-amber-500/15 text-amber-200 border-amber-400/30',
  };
  return (
    <span className={`px-2 py-0.5 rounded-md text-[10px] uppercase tracking-wider border ${map[status]}`}>
      {status}
    </span>
  );
}
