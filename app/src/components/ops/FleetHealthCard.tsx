/**
 * Fleet Health card, appears at the top of AnalyticsTab.
 *
 * Composite per-pod score (0–100) = 40% uptime + 40% success rate
 * + 20% latency efficiency (vs p95 target). The big number is the
 * unweighted mean across all currently-deployed pods.
 *
 * "Dynamic" handling: pods that disappear from the backend are simply
 * absent from the response; the mean re-computes against whoever is
 * present right now. New pods join the mean as soon as the backend
 * starts including them.
 */

import { useCallback, useEffect, useState } from 'react';
import { Activity, Heart } from 'lucide-react';
import { opsApi } from '../../lib/ops/api';
import { SERVICE_LABELS, type FleetHealth, type RuntimeWindow } from '../../lib/ops/types';

const REFRESH_MS = 15_000;

const WINDOWS: { id: RuntimeWindow; label: string }[] = [
  { id: 'day', label: '24h' },
  { id: 'week', label: '7d' },
  { id: 'month', label: '30d' },
];

interface Props { token: string }

export function FleetHealthCard({ token }: Props) {
  const [window, setWindow] = useState<RuntimeWindow>('week');
  const [data, setData] = useState<FleetHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await opsApi.fleetHealth(token, window);
      setData(r);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token, window]);

  useEffect(() => {
    refresh();
    const t = globalThis.setInterval(refresh, REFRESH_MS);
    return () => globalThis.clearInterval(t);
  }, [refresh]);

  const mean = data?.network_mean_score ?? null;
  const tone = scoreTone(mean);

  return (
    <section className={`rounded-2xl border p-5 ${tone.border} ${tone.bg}`}>
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Heart size={16} className={tone.icon} />
          <h2 className="text-white font-semibold">Fleet health</h2>
          <span className="text-[11px] text-[#A7B0B7]">
            composite, 40% uptime · 40% success · 20% latency
          </span>
        </div>
        <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.02] p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.id}
              type="button"
              onClick={() => setWindow(w.id)}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                window === w.id
                  ? 'bg-white/10 text-white'
                  : 'text-[#A7B0B7] hover:text-white'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-400/30 bg-red-500/[0.06] text-red-200 text-xs px-2 py-1.5 mb-3">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-end gap-6 mb-4">
        <div>
          <div className={`text-4xl font-semibold tabular-nums ${tone.text}`}>
            {mean !== null ? mean.toFixed(1) : '—'}
            <span className="text-base text-[#A7B0B7] ml-1">/ 100</span>
          </div>
          <div className="text-[11px] text-[#A7B0B7] mt-1">
            mean across {data?.active_pod_count ?? 0} active pod
            {data?.active_pod_count === 1 ? '' : 's'}
            {data && ' · p95 target varies by service'}
          </div>
        </div>
        {data && data.pods.length > 0 && (
          <div className="flex items-end gap-4 ml-auto">
            <Bucket label="Healthy" count={data.pods.filter((p) => p.score >= 80).length} tone="ok" />
            <Bucket label="Degraded" count={data.pods.filter((p) => p.score >= 50 && p.score < 80).length} tone="warn" />
            <Bucket label="Critical" count={data.pods.filter((p) => p.score < 50).length} tone="bad" />
          </div>
        )}
      </div>

      {data && data.pods.length > 0 && (
        <div className="grid gap-1.5 md:grid-cols-2">
          {data.pods.slice().sort((a, b) => a.score - b.score).map((p) => (
            <div
              key={p.pod_id}
              className="flex items-center gap-3 rounded-lg border border-white/5 bg-[#07080A]/60 px-2.5 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="text-xs text-white truncate flex items-center gap-1.5">
                  <Activity size={11} className="text-[#A7B0B7] shrink-0" />
                  {p.name}
                </div>
                <div className="text-[10px] text-[#A7B0B7] truncate">
                  {SERVICE_LABELS[p.service] ?? p.service} ·
                  {' '}uptime {p.uptime_pct.toFixed(0)}% ·
                  {' '}success {(p.success_rate * 100).toFixed(1)}%
                  {p.p95_latency_ms !== null && (
                    <>
                      {' '}· p95 {formatMs(p.p95_latency_ms)}
                      <span className="text-[#666]">
                        {' '}/ target {formatMs(p.p95_target_ms)}
                      </span>
                    </>
                  )}
                </div>
              </div>
              <ScoreBar score={p.score} />
              <div className={`w-12 text-right text-sm font-semibold tabular-nums ${scoreColor(p.score)}`}>
                {p.score.toFixed(0)}
              </div>
            </div>
          ))}
        </div>
      )}

      {data && data.pods.length === 0 && (
        <div className="text-sm text-[#A7B0B7]">
          No active pods. Deploy one from the Pods tab to start scoring.
        </div>
      )}
    </section>
  );
}


function ScoreBar({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  return (
    <div className="w-28 h-1.5 rounded-full bg-white/5 overflow-hidden">
      <div
        className={`h-full ${score >= 80 ? 'bg-[#DFFF00]' : score >= 50 ? 'bg-amber-400' : 'bg-red-400'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}


/** Format milliseconds for display: keep ms for short values, switch
 *  to seconds for anything over a second, minutes for over a minute. */
function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  return `${(ms / 60000).toFixed(1)} min`;
}


function Bucket({ label, count, tone }: { label: string; count: number; tone: 'ok' | 'warn' | 'bad' }) {
  const t = tone === 'ok'
    ? 'text-[#DFFF00]'
    : tone === 'warn'
      ? 'text-amber-300'
      : 'text-red-300';
  return (
    <div className="text-center">
      <div className={`text-lg font-semibold tabular-nums ${t}`}>{count}</div>
      <div className="text-[10px] text-[#A7B0B7] uppercase tracking-wider">{label}</div>
    </div>
  );
}


function scoreColor(score: number): string {
  if (score >= 80) return 'text-[#DFFF00]';
  if (score >= 50) return 'text-amber-300';
  return 'text-red-300';
}


function scoreTone(mean: number | null) {
  if (mean === null) {
    return { border: 'border-white/10', bg: 'bg-white/[0.02]', text: 'text-white', icon: 'text-[#A7B0B7]' };
  }
  if (mean >= 80) {
    return { border: 'border-[#DFFF00]/30', bg: 'bg-[#DFFF00]/[0.04]', text: 'text-[#DFFF00]', icon: 'text-[#DFFF00]' };
  }
  if (mean >= 50) {
    return { border: 'border-amber-300/30', bg: 'bg-amber-300/[0.04]', text: 'text-amber-200', icon: 'text-amber-300' };
  }
  return { border: 'border-red-400/30', bg: 'bg-red-500/[0.06]', text: 'text-red-200', icon: 'text-red-300' };
}
