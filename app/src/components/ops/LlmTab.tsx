/**
 * LLM tab, cost, failure, fallback, latency analytics across every
 * provider call (Cerebras / Grok / Groq / OpenAI / Chutes / local).
 *
 * Data source: ``opsApi.llm*`` endpoints, which read ``llm_calls`` rows
 * populated by the wrapper in ``llm_client.py``.
 *
 * Range picker (1h / 24h / 7d / 30d) applies to every section. Refresh
 * cadence matches the rest of the ops surfaces (15s).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, Coins, RefreshCw, ServerCrash, Timer, TrendingDown,
  Zap,
} from 'lucide-react';
import {
  Area, AreaChart, CartesianGrid, Legend, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { opsApi } from '../../lib/ops/api';
import type {
  LlmBreakdownRow, LlmFailureRow, LlmFallbackRow, LlmOverview,
  LlmTimeRange, LlmTimeseriesPoint, LlmTopError,
} from '../../lib/ops/types';

const REFRESH_MS = 15_000;

const RANGES: { id: LlmTimeRange; label: string }[] = [
  { id: '1h', label: '1h' },
  { id: '24h', label: '24h' },
  { id: '7d', label: '7d' },
  { id: '30d', label: '30d' },
];

interface Props { token: string }


export function LlmTab({ token }: Props) {
  const [range, setRange] = useState<LlmTimeRange>('24h');
  const [overview, setOverview] = useState<LlmOverview | null>(null);
  const [providers, setProviders] = useState<LlmBreakdownRow[]>([]);
  const [models, setModels] = useState<LlmBreakdownRow[]>([]);
  const [fallbacks, setFallbacks] = useState<LlmFallbackRow[]>([]);
  const [failures, setFailures] = useState<LlmFailureRow[]>([]);
  const [topErrors, setTopErrors] = useState<LlmTopError[]>([]);
  const [timeseries, setTimeseries] = useState<LlmTimeseriesPoint[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      // ``bucket`` for the chart: 1h-resolution under 7d, daily for 30d.
      const bucket = range === '30d' ? '1d' : '1h';
      const [ov, byP, byM, fb, fail, ts] = await Promise.all([
        opsApi.llmOverview(token, range),
        opsApi.llmByProvider(token, range),
        opsApi.llmByModel(token, range),
        opsApi.llmFallbacks(token, range),
        opsApi.llmFailures(token, range, 100),
        opsApi.llmTimeseries(token, range, bucket),
      ]);
      setOverview(ov);
      setProviders(byP.rows);
      setModels(byM.rows);
      setFallbacks(fb.rows);
      setFailures(fail.rows);
      setTopErrors(fail.top_errors);
      setTimeseries(ts.rows);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [range, token]);

  useEffect(() => {
    refresh();
    const t = globalThis.setInterval(refresh, REFRESH_MS);
    return () => globalThis.clearInterval(t);
  }, [refresh]);

  const chartData = useMemo(
    () =>
      timeseries.map((p) => ({
        bucket: p.bucket,
        label: shortBucket(p.bucket),
        calls: p.calls,
        ok: Math.max(0, p.calls - p.errors),
        errors: p.errors,
        rate_limited: p.rate_limited,
        timed_out: p.timed_out,
        cost: p.cost_usd,
        avg_latency: p.avg_latency_ms,
        avg_ttft: p.avg_ttft_ms,
      })),
    [timeseries],
  );

  return (
    <div className="space-y-6">
      {/* Range picker */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.02] p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setRange(r.id)}
              className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                range === r.id
                  ? 'bg-white/10 text-white'
                  : 'text-[#A7B0B7] hover:text-white'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="inline-flex items-center gap-1.5 text-xs text-[#A7B0B7] hover:text-white"
        >
          <RefreshCw size={12} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="rounded-lg border border-red-400/30 bg-red-500/[0.06] text-red-200 text-sm px-3 py-2">
          {error}
        </div>
      )}

      {/* Top-line tiles */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <Tile
          icon={Zap}
          label="Calls"
          value={overview ? formatInt(overview.calls) : '—'}
          hint={overview ? `${formatInt(overview.ok)} ok` : undefined}
        />
        <Tile
          icon={Coins}
          label="Cost"
          value={overview ? `$${overview.cost_usd.toFixed(2)}` : '—'}
          hint={overview ? `${formatInt(overview.total_tokens)} tokens` : undefined}
        />
        <Tile
          icon={AlertTriangle}
          label="Errors"
          value={overview ? formatInt(overview.errors + overview.empties) : '—'}
          alert={(overview?.errors ?? 0) + (overview?.empties ?? 0) > 0}
          hint={
            overview
              ? `${((overview.errors + overview.empties) / Math.max(1, overview.calls) * 100).toFixed(1)}%`
              : undefined
          }
        />
        <Tile
          icon={TrendingDown}
          label="Rate-limited"
          value={overview ? formatInt(overview.rate_limited) : '—'}
          alert={(overview?.rate_limited ?? 0) > 0}
        />
        <Tile
          icon={ServerCrash}
          label="Fallbacks"
          value={overview ? formatInt(overview.fallback_calls) : '—'}
          hint="Cerebras → Grok hops"
          alert={(overview?.fallback_calls ?? 0) > 0}
        />
        <Tile
          icon={Timer}
          label="p95 latency"
          value={overview && overview.p95_latency_ms !== null
            ? `${overview.p95_latency_ms} ms`
            : '—'}
          hint={overview && overview.avg_ttft_ms !== null
            ? `ttft ${overview.avg_ttft_ms} ms`
            : undefined}
        />
      </div>

      {/* Charts: calls (stacked) + cost (line) */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h2 className="text-white font-semibold mb-3">Volume & cost over time</h2>
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartBox title="Calls per bucket (ok + errors)">
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" />
              <XAxis dataKey="label" stroke="#666" fontSize={11} />
              <YAxis stroke="#666" fontSize={11} />
              <Tooltip
                contentStyle={{ background: '#0d0e10', border: '1px solid #222', fontSize: 12 }}
                labelStyle={{ color: '#fff' }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" stackId="1" dataKey="ok"     stroke="#DFFF00" fill="#DFFF00" fillOpacity={0.3} />
              <Area type="monotone" stackId="1" dataKey="errors" stroke="#f87171" fill="#f87171" fillOpacity={0.4} />
            </AreaChart>
          </ChartBox>
          <ChartBox title="Cost (USD per bucket)">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" />
              <XAxis dataKey="label" stroke="#666" fontSize={11} />
              <YAxis stroke="#666" fontSize={11} />
              <Tooltip
                contentStyle={{ background: '#0d0e10', border: '1px solid #222', fontSize: 12 }}
                labelStyle={{ color: '#fff' }}
                formatter={(v: number) => `$${v.toFixed(4)}`}
              />
              <Line type="monotone" dataKey="cost" stroke="#22d3ee" strokeWidth={2} dot={false} />
            </LineChart>
          </ChartBox>
          <ChartBox title="Rate-limited + timeouts">
            <AreaChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" />
              <XAxis dataKey="label" stroke="#666" fontSize={11} />
              <YAxis stroke="#666" fontSize={11} />
              <Tooltip
                contentStyle={{ background: '#0d0e10', border: '1px solid #222', fontSize: 12 }}
                labelStyle={{ color: '#fff' }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" stackId="1" dataKey="rate_limited" stroke="#fbbf24" fill="#fbbf24" fillOpacity={0.4} />
              <Area type="monotone" stackId="1" dataKey="timed_out"    stroke="#f97316" fill="#f97316" fillOpacity={0.4} />
            </AreaChart>
          </ChartBox>
          <ChartBox title="Avg latency / TTFT (ms)">
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#222" />
              <XAxis dataKey="label" stroke="#666" fontSize={11} />
              <YAxis stroke="#666" fontSize={11} />
              <Tooltip
                contentStyle={{ background: '#0d0e10', border: '1px solid #222', fontSize: 12 }}
                labelStyle={{ color: '#fff' }}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="avg_latency" stroke="#a78bfa" strokeWidth={2} dot={false} name="avg latency" />
              <Line type="monotone" dataKey="avg_ttft"    stroke="#34d399" strokeWidth={2} dot={false} name="avg ttft" />
            </LineChart>
          </ChartBox>
        </div>
      </section>

      {/* By-provider + by-model */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h2 className="text-white font-semibold mb-3">Provider & model breakdown</h2>
        <div className="grid gap-4 xl:grid-cols-2">
          <BreakdownTable title="By provider" rows={providers} primaryCol="provider" />
          <BreakdownTable title="By model"    rows={models}    primaryCol="model" secondaryCol="provider" />
        </div>
      </section>

      {/* Fallback chain analytics */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <div className="flex items-center gap-2 mb-3">
          <ServerCrash size={16} className="text-amber-300" />
          <h2 className="text-white font-semibold">Fallback ladder</h2>
          <span className="text-[11px] text-[#A7B0B7]">when one provider failed and another took over</span>
        </div>
        {fallbacks.length === 0 ? (
          <p className="text-sm text-[#A7B0B7]">No fallback hops in this window, primary providers held up.</p>
        ) : (
          <div className="border border-white/10 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-white/[0.04] text-[10px] uppercase tracking-wider text-[#A7B0B7]">
                <tr>
                  <th className="text-left px-3 py-2">From</th>
                  <th className="text-left px-3 py-2">To</th>
                  <th className="text-left px-3 py-2">Reason</th>
                  <th className="text-right px-3 py-2">Hops</th>
                  <th className="text-right px-3 py-2">Recovered</th>
                  <th className="text-right px-3 py-2">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {fallbacks.map((f, i) => (
                  <tr key={`${f.from_provider}-${f.to_provider}-${f.reason}-${i}`}>
                    <td className="px-3 py-2 text-white">{f.from_provider}</td>
                    <td className="px-3 py-2 text-white">{f.to_provider}</td>
                    <td className="px-3 py-2 text-[#A7B0B7]">{f.reason || '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{f.hops}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {f.recovered} / {f.hops}
                      {f.recovery_rate !== null && (
                        <span className={`ml-1.5 text-[10px] ${f.recovery_rate >= 0.9 ? 'text-[#DFFF00]' : f.recovery_rate >= 0.5 ? 'text-amber-300' : 'text-red-300'}`}>
                          {(f.recovery_rate * 100).toFixed(0)}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-[#A7B0B7]">${f.cost_usd.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Recent failures + top error buckets */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle size={16} className="text-red-300" />
          <h2 className="text-white font-semibold">Failures</h2>
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="text-[10px] uppercase tracking-wider text-[#A7B0B7] mb-2">Top error messages</h3>
            {topErrors.length === 0 ? (
              <p className="text-sm text-[#A7B0B7]">No errors in this window.</p>
            ) : (
              <ul className="space-y-1.5">
                {topErrors.map((e, i) => (
                  <li key={i} className="text-xs text-white border border-white/5 bg-[#07080A]/60 rounded px-2.5 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono truncate text-[#A7B0B7]">{e.provider}/{e.model}</span>
                      <span className="text-[#DFFF00] tabular-nums">×{e.count}</span>
                    </div>
                    <div className="text-[11px] text-red-200 mt-0.5 truncate">{e.err_prefix}</div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="text-[10px] uppercase tracking-wider text-[#A7B0B7] mb-2">Recent failed calls</h3>
            {failures.length === 0 ? (
              <p className="text-sm text-[#A7B0B7]">No failed calls in this window.</p>
            ) : (
              <div className="max-h-[420px] overflow-y-auto space-y-1.5 pr-1">
                {failures.map((f) => (
                  <div key={f.id} className="text-xs border border-white/5 bg-[#07080A]/60 rounded px-2.5 py-1.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[#A7B0B7] truncate">{f.provider}/{f.model}</span>
                      <span className="text-[10px] text-[#A7B0B7] shrink-0">{shortTime(f.created_at)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] mt-0.5">
                      <span className={`px-1 py-px rounded ${f.rate_limited ? 'bg-amber-500/20 text-amber-200' : f.timed_out ? 'bg-orange-500/20 text-orange-200' : 'bg-red-500/20 text-red-200'}`}>
                        {f.rate_limited ? '429' : f.timed_out ? 'timeout' : (f.http_status ?? f.status)}
                      </span>
                      {f.fallback_from && (
                        <span className="text-[#A7B0B7]">← from {f.fallback_from}</span>
                      )}
                      <span className="text-[#A7B0B7] ml-auto">
                        {f.latency_ms !== null ? `${f.latency_ms} ms` : ''}
                      </span>
                    </div>
                    {f.error_message && (
                      <div className="text-[11px] text-red-200 mt-1 break-words">{f.error_message}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Small reusable bits, local to this file so the diff stays self-contained
// ---------------------------------------------------------------------------

function Tile({
  icon: Icon, label, value, hint, alert,
}: {
  icon: typeof Zap; label: string; value: string; hint?: string; alert?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-3 ${
      alert ? 'border-amber-300/40 bg-amber-300/[0.06]' : 'border-white/10 bg-white/[0.02]'
    }`}>
      <div className={`flex items-center gap-2 mb-1 text-xs ${alert ? 'text-amber-200' : 'text-[#A7B0B7]'}`}>
        <Icon size={13} />
        {label}
      </div>
      <div className={`text-xl font-semibold ${alert ? 'text-amber-100' : 'text-white'}`}>{value}</div>
      {hint && <div className="text-[10px] text-[#666] mt-0.5">{hint}</div>}
    </div>
  );
}


function ChartBox({ title, children }: { title: string; children: React.ReactElement }) {
  return (
    <div className="rounded-xl border border-white/5 bg-[#07080A]/60 p-3">
      <div className="text-[10px] uppercase tracking-wider text-[#A7B0B7] mb-2">{title}</div>
      <div style={{ width: '100%', height: 200 }}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
}


function BreakdownTable({
  title, rows, primaryCol, secondaryCol,
}: {
  title: string;
  rows: LlmBreakdownRow[];
  primaryCol: 'provider' | 'model';
  secondaryCol?: 'provider' | 'model';
}) {
  return (
    <div>
      <h3 className="text-[10px] uppercase tracking-wider text-[#A7B0B7] mb-2">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-[#A7B0B7]">No calls in this window.</p>
      ) : (
        <div className="border border-white/10 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.04] text-[10px] uppercase tracking-wider text-[#A7B0B7]">
              <tr>
                <th className="text-left px-2.5 py-1.5">{primaryCol === 'provider' ? 'Provider' : 'Model'}</th>
                {secondaryCol && <th className="text-left px-2.5 py-1.5">{secondaryCol === 'provider' ? 'Provider' : 'Model'}</th>}
                <th className="text-right px-2.5 py-1.5">Calls</th>
                <th className="text-right px-2.5 py-1.5">Err</th>
                <th className="text-right px-2.5 py-1.5">429</th>
                <th className="text-right px-2.5 py-1.5">Cost</th>
                <th className="text-right px-2.5 py-1.5">p95-ish</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="px-2.5 py-1.5 text-white font-mono text-xs">{r[primaryCol] ?? '—'}</td>
                  {secondaryCol && (
                    <td className="px-2.5 py-1.5 text-[#A7B0B7] font-mono text-xs">{r[secondaryCol] ?? '—'}</td>
                  )}
                  <td className="px-2.5 py-1.5 text-right tabular-nums">{formatInt(r.calls)}</td>
                  <td className={`px-2.5 py-1.5 text-right tabular-nums ${r.errors > 0 ? 'text-red-300' : ''}`}>
                    {r.errors}
                  </td>
                  <td className={`px-2.5 py-1.5 text-right tabular-nums ${r.rate_limited > 0 ? 'text-amber-300' : ''}`}>
                    {r.rate_limited}
                  </td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums text-[#A7B0B7]">${r.cost_usd.toFixed(4)}</td>
                  <td className="px-2.5 py-1.5 text-right tabular-nums text-[#A7B0B7]">
                    {r.avg_latency_ms !== null ? `${r.avg_latency_ms} ms` : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}


function formatInt(n: number): string {
  return n.toLocaleString();
}


function shortBucket(bucket: string): string {
  // Backend returns either 'YYYY-MM-DD' (daily) or 'YYYY-MM-DDTHH:00:00'
  // (hourly). Display short forms to keep the X-axis legible.
  if (bucket.length <= 10) return bucket.slice(5);     // 'MM-DD'
  return bucket.slice(11, 16);                          // 'HH:00'
}


function shortTime(ts: string): string {
  try {
    return new Date(ts.replace(' ', 'T') + 'Z').toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return ts;
  }
}
