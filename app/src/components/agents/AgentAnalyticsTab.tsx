/**
 * Per-agent analytics dashboard.
 *
 *   • Headline metric cards: total calls, avg duration, drop rate.
 *   • End-reason breakdown bar.
 *   • Daily call-count sparkline.
 *   • Median latency triplet (turn, TTFT, TTFA).
 *
 * Data comes from a single ``/agents/{id}/analytics`` request that
 * aggregates voice_call_logs + studio_voicechat_history server-side.
 * Range selector shares the same key vocabulary as the Calls tab.
 */

import { useEffect, useMemo, useState } from 'react';
import { Loader2, AlertCircle, BarChart3 } from 'lucide-react';
import { agentsApi } from '../../lib/agents/api';
import type { AgentAnalytics, AnalyticsRange, CallEndReason } from '../../lib/agents/types';

const RANGE_OPTIONS: { id: AnalyticsRange; label: string }[] = [
  { id: '24h', label: '24h' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
];

const REASON_LABEL: Record<CallEndReason, string> = {
  user_hangup:        'User hung up',
  max_duration:       'Max length',
  idle_timeout:       'Idle timeout',
  free_time_up:       'Free cap',
  billing_exhausted:  'Credits out',
  error:              'Error',
  unknown:            'Unknown',
};

// Bar colours for the end-reason stack. Greens/blues for "healthy"
// endings, ambers for watchdog-driven, reds for failure modes —
// reads at a glance.
const REASON_COLOR: Record<CallEndReason, string> = {
  user_hangup:        'bg-emerald-400/70',
  max_duration:       'bg-amber-400/70',
  idle_timeout:       'bg-amber-400/70',
  free_time_up:       'bg-amber-400/70',
  billing_exhausted:  'bg-red-400/70',
  error:              'bg-red-400/70',
  unknown:            'bg-white/30',
};

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return '0s';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}m ${s}s`;
}

function fmtPct(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

interface Props {
  agentId: string;
  token: string | null;
}

export function AgentAnalyticsTab({ agentId, token }: Props) {
  const [range, setRange] = useState<AnalyticsRange>('30d');
  const [data, setData] = useState<AgentAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    agentsApi.getAnalytics(token, agentId, range)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => { if (!cancelled) setError(err?.message ?? 'failed to load analytics'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [agentId, token, range]);

  const maxDaily = useMemo(() => {
    if (!data) return 0;
    return data.daily.reduce((m, d) => Math.max(m, d.call_count), 0);
  }, [data]);

  return (
    <div className="space-y-5">
      {/* Range selector */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-base font-semibold text-white">Analytics</h2>
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

      {!loading && !error && data && data.call_count === 0 && (
        <div className="text-center py-16 text-white/40">
          <BarChart3 size={28} className="mx-auto mb-3 opacity-40" />
          <div className="text-sm">No calls in this window yet.</div>
          <div className="text-xs mt-1 opacity-60">
            Once users start talking to this agent, analytics will appear here.
          </div>
        </div>
      )}

      {!loading && !error && data && data.call_count > 0 && (
        <>
          {/* Headline KPI row. The numerator/denominator layout
              makes drop_rate feel comparable to the totals next to
              it, instead of an isolated percentage. */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <KpiCard
              label="Total calls"
              value={data.call_count.toLocaleString()}
            />
            <KpiCard
              label="Avg duration"
              value={fmtDuration(data.avg_duration_ms)}
              sub={`${fmtDuration(data.total_duration_ms)} total`}
            />
            <KpiCard
              label="Drop rate"
              value={fmtPct(data.drop_rate)}
              sub="under 10 s OR 0 turns"
              accent={data.drop_rate > 0.25 ? 'warn' : undefined}
            />
            <KpiCard
              label="Turns / call"
              value={data.call_count
                ? (data.turn_count / data.call_count).toFixed(1)
                : '—'}
              sub={`${data.turn_count.toLocaleString()} total`}
            />
          </div>

          {/* Latency triplet — the "is this agent SNAPPY?" answer. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <KpiCard
              label="P50 turn latency"
              value={fmtMs(data.p50_turn_latency_ms)}
              sub="end-to-end per user turn"
            />
            <KpiCard
              label="P50 time to first token"
              value={fmtMs(data.p50_ttft_ms)}
              sub="LLM first token"
            />
            <KpiCard
              label="P50 time to first audio"
              value={fmtMs(data.p50_ttfa_ms)}
              sub="TTS first frame to client"
            />
          </div>

          {/* Daily call-count sparkline. Plain divs + height-percent
              so we don't pull in a chart library for one chart. */}
          <div className="bg-white/[0.02] border border-white/10 rounded-xl px-4 py-4">
            <div className="text-xs uppercase tracking-wider text-white/40 mb-3">
              Calls per day
            </div>
            <div className="flex items-end gap-1 h-24">
              {data.daily.length === 0 ? (
                <div className="text-xs text-white/30">No data</div>
              ) : (
                data.daily.map((d) => {
                  const pct = maxDaily > 0 ? (d.call_count / maxDaily) * 100 : 0;
                  return (
                    <div
                      key={d.day}
                      className="flex-1 min-w-0 flex flex-col items-stretch gap-1"
                      title={`${d.day}: ${d.call_count} call${d.call_count === 1 ? '' : 's'}`}
                    >
                      <div className="flex-1 flex items-end">
                        <div
                          className="w-full bg-[#DFFF00]/60 rounded-sm"
                          style={{ height: `${Math.max(pct, d.call_count > 0 ? 4 : 0)}%` }}
                        />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
            <div className="flex justify-between text-[10px] text-white/30 mt-2">
              {data.daily[0] && <span>{data.daily[0].day}</span>}
              {data.daily.length > 1 && <span>{data.daily[data.daily.length - 1].day}</span>}
            </div>
          </div>

          {/* End-reason stacked bar — where do sessions end? */}
          <div className="bg-white/[0.02] border border-white/10 rounded-xl px-4 py-4">
            <div className="text-xs uppercase tracking-wider text-white/40 mb-3">
              How sessions ended
            </div>
            <div className="h-3 flex rounded-full overflow-hidden bg-white/[0.04]">
              {Object.entries(data.end_reasons).map(([reason, count]) => {
                const pct = data.call_count > 0 ? (count / data.call_count) * 100 : 0;
                const key = reason as CallEndReason;
                return (
                  <div
                    key={reason}
                    className={REASON_COLOR[key] ?? 'bg-white/30'}
                    style={{ width: `${pct}%` }}
                    title={`${REASON_LABEL[key] ?? reason}: ${count} (${fmtPct(pct / 100)})`}
                  />
                );
              })}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-[11px] text-white/60">
              {Object.entries(data.end_reasons).map(([reason, count]) => {
                const key = reason as CallEndReason;
                return (
                  <div key={reason} className="inline-flex items-center gap-1.5">
                    <span className={`inline-block w-2 h-2 rounded-full ${REASON_COLOR[key] ?? 'bg-white/30'}`} />
                    {REASON_LABEL[key] ?? reason}
                    <span className="text-white/40">({count})</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface KpiCardProps {
  label: string;
  value: string;
  sub?: string;
  accent?: 'warn';
}

function KpiCard({ label, value, sub, accent }: KpiCardProps) {
  return (
    <div className="bg-white/[0.02] border border-white/10 rounded-xl px-4 py-3">
      <div className="text-[11px] uppercase tracking-wider text-white/40">{label}</div>
      <div
        className={`text-xl font-semibold mt-1 ${
          accent === 'warn' ? 'text-amber-300' : 'text-white'
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-[11px] text-white/40 mt-0.5">{sub}</div>}
    </div>
  );
}
