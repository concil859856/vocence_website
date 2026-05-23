/**
 * Analytics tab — fleet tiles + per-pod time series.
 *
 * Tiles refresh every 10s (matches the backend health-poll cadence).
 * Time-series chart loads on demand when the admin picks a pod.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, AlertTriangle, CircuitBoard, Cpu, Server, Zap } from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { opsApi } from '../../lib/ops/api';
import {
  SERVICE_LABELS,
  type DispatcherSnapshot,
  type OverviewTiles,
  type PodRow,
  type ServiceName,
  type TimeseriesPoint,
} from '../../lib/ops/types';

const REFRESH_MS = 10_000;

interface Props { token: string }

export function AnalyticsTab({ token }: Props) {
  const [overview, setOverview] = useState<OverviewTiles | null>(null);
  const [dispatcher, setDispatcher] = useState<DispatcherSnapshot | null>(null);
  const [pods, setPods] = useState<PodRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [selectedPodId, setSelectedPodId] = useState<number | null>(null);
  const [rangeHours, setRangeHours] = useState<24 | 168 | 720>(24);
  const [series, setSeries] = useState<TimeseriesPoint[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [ov, dp, pl] = await Promise.all([
        opsApi.overview(token),
        opsApi.dispatcher(token),
        opsApi.listPods(token),
      ]);
      setOverview(ov);
      setDispatcher(dp.services);
      setPods(pl.pods);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [token]);

  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refresh]);

  // Auto-pick the pod with the most traffic so the chart isn't empty.
  useEffect(() => {
    if (selectedPodId === null && pods.length > 0) {
      setSelectedPodId(pods[0].id);
    }
  }, [pods, selectedPodId]);

  // Load time series when pod / range changes.
  useEffect(() => {
    if (selectedPodId === null) {
      setSeries([]);
      return;
    }
    let cancelled = false;
    setSeriesLoading(true);
    opsApi.podTimeseries(token, selectedPodId, rangeHours)
      .then((r) => { if (!cancelled) setSeries(r.points); })
      .catch((e) => { if (!cancelled) setError(`timeseries: ${(e as Error).message}`); })
      .finally(() => { if (!cancelled) setSeriesLoading(false); });
    return () => { cancelled = true; };
  }, [selectedPodId, rangeHours, token]);

  const chartData = useMemo(() => {
    return series.map((p) => {
      const errTotal = Object.values(p.requests_err).reduce((a, b) => a + b, 0);
      return {
        time: new Date(p.minute_ts * 60_000).toLocaleString(),
        timeShort: new Date(p.minute_ts * 60_000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        ok: p.requests_ok,
        err: errTotal,
        p95: Math.round(p.duration_ms_p95),
        inflight: p.max_inflight,
        audio_s: Math.round(p.audio_ms / 1000),
      };
    });
  }, [series]);

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded-lg border border-red-400/30 bg-red-500/[0.06] text-red-200 text-sm px-3 py-2">
          {error}
        </div>
      )}

      {/* Tiles */}
      <div className="grid gap-3 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <Tile
          icon={Server}
          label="Servers ready"
          value={overview ? `${overview.servers_ready} / ${overview.servers_total}` : '—'}
        />
        <Tile
          icon={Cpu}
          label="Pods online"
          value={overview ? String(overview.pods_by_status.online ?? 0) : '—'}
        />
        <Tile
          icon={Zap}
          label="In-flight now"
          value={
            overview
              ? `${overview.dispatcher_inflight} / ${overview.dispatcher_capacity_2N}`
              : '—'
          }
          hint="dispatcher / 2×N cap"
        />
        <Tile
          icon={AlertTriangle}
          label="Unhealthy"
          value={overview ? String(overview.pods_by_status.unhealthy ?? 0) : '—'}
          alert={(overview?.pods_by_status.unhealthy ?? 0) > 0}
        />
        <Tile
          icon={CircuitBoard}
          label="Restarting"
          value={overview ? String(overview.pods_by_status.restarting ?? 0) : '—'}
        />
        <Tile
          icon={Activity}
          label="Draining"
          value={overview ? String(overview.pods_by_status.draining ?? 0) : '—'}
        />
      </div>

      {/* Per-service dispatcher state */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <h2 className="text-white font-semibold mb-3">Live dispatcher state</h2>
        {!dispatcher || Object.keys(dispatcher).length === 0 ? (
          <p className="text-sm text-[#A7B0B7]">No pods registered. Deploy one from the Pods tab.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {Object.entries(dispatcher).map(([svc, st]) => (
              <div key={svc} className="rounded-xl border border-white/5 bg-[#07080A]/60 p-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-medium text-white">
                    {SERVICE_LABELS[svc as ServiceName] ?? svc}
                  </div>
                  <div className="text-[11px] text-[#A7B0B7]">
                    {st.n_pods} pod{st.n_pods === 1 ? '' : 's'}
                  </div>
                </div>
                <LoadBar value={st.total_in_flight} max={st.global_cap || 1} />
                <div className="mt-2 text-xs text-[#A7B0B7]">
                  {st.total_in_flight} / {st.global_cap} in-flight (2×N cap)
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Per-pod chart */}
      <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-5">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h2 className="text-white font-semibold">Per-pod traffic</h2>
          <div className="flex items-center gap-2">
            <select
              value={selectedPodId ?? ''}
              onChange={(e) => setSelectedPodId(e.target.value ? Number(e.target.value) : null)}
              className="bg-[#07080A] border border-white/15 rounded-lg px-3 py-1.5 text-sm text-white focus:outline-none focus:border-[#DFFF00]/40"
            >
              <option value="">— pick a pod —</option>
              {pods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {SERVICE_LABELS[p.service]}
                </option>
              ))}
            </select>
            <div className="inline-flex rounded-lg border border-white/15 overflow-hidden">
              {([24, 168, 720] as const).map((h) => (
                <button
                  key={h}
                  type="button"
                  onClick={() => setRangeHours(h)}
                  className={`px-3 py-1.5 text-xs ${
                    rangeHours === h ? 'bg-[#DFFF00]/15 text-[#DFFF00]' : 'text-[#A7B0B7] hover:text-white'
                  }`}
                >
                  {h === 24 ? '24h' : h === 168 ? '7d' : '30d'}
                </button>
              ))}
            </div>
          </div>
        </div>

        {selectedPodId === null ? (
          <p className="text-sm text-[#A7B0B7]">Pick a pod to see its traffic.</p>
        ) : seriesLoading ? (
          <p className="text-sm text-[#A7B0B7]">Loading…</p>
        ) : chartData.length === 0 ? (
          <p className="text-sm text-[#A7B0B7]">No traffic yet in this window.</p>
        ) : (
          <div className="space-y-6">
            {/* Requests over time */}
            <div>
              <div className="text-xs text-[#A7B0B7] mb-2">Requests per minute (ok vs error)</div>
              <div className="h-56">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                    <XAxis dataKey="timeShort" stroke="#666" fontSize={11} />
                    <YAxis stroke="#666" fontSize={11} />
                    <Tooltip
                      contentStyle={{ background: '#0d0e10', border: '1px solid #222', fontSize: 12 }}
                      labelStyle={{ color: '#fff' }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Area type="monotone" dataKey="ok" stackId="1" stroke="#DFFF00" fill="#DFFF00" fillOpacity={0.3} />
                    <Area type="monotone" dataKey="err" stackId="1" stroke="#f87171" fill="#f87171" fillOpacity={0.4} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Latency p95 */}
            <div>
              <div className="text-xs text-[#A7B0B7] mb-2">Latency p95 (ms)</div>
              <div className="h-44">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                    <XAxis dataKey="timeShort" stroke="#666" fontSize={11} />
                    <YAxis stroke="#666" fontSize={11} />
                    <Tooltip
                      contentStyle={{ background: '#0d0e10', border: '1px solid #222', fontSize: 12 }}
                      labelStyle={{ color: '#fff' }}
                    />
                    <Line type="monotone" dataKey="p95" stroke="#a78bfa" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Max inflight */}
            <div>
              <div className="text-xs text-[#A7B0B7] mb-2">Max in-flight per minute</div>
              <div className="h-32">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#222" />
                    <XAxis dataKey="timeShort" stroke="#666" fontSize={11} />
                    <YAxis stroke="#666" fontSize={11} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{ background: '#0d0e10', border: '1px solid #222', fontSize: 12 }}
                      labelStyle={{ color: '#fff' }}
                    />
                    <Area type="step" dataKey="inflight" stroke="#60a5fa" fill="#60a5fa" fillOpacity={0.3} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}


function Tile({
  icon: Icon,
  label,
  value,
  hint,
  alert,
}: {
  icon: typeof Server;
  label: string;
  value: string;
  hint?: string;
  alert?: boolean;
}) {
  return (
    <div className={`rounded-xl border p-3 ${
      alert ? 'border-red-400/40 bg-red-500/[0.06]' : 'border-white/10 bg-white/[0.02]'
    }`}>
      <div className={`flex items-center gap-2 mb-1 text-xs ${alert ? 'text-red-200' : 'text-[#A7B0B7]'}`}>
        <Icon size={13} />
        {label}
      </div>
      <div className={`text-xl font-semibold ${alert ? 'text-red-100' : 'text-white'}`}>{value}</div>
      {hint && <div className="text-[10px] text-[#666] mt-0.5">{hint}</div>}
    </div>
  );
}


function LoadBar({ value, max }: { value: number; max: number }) {
  const pct = Math.min(100, (value / Math.max(1, max)) * 100);
  const hot = pct > 80;
  const warm = pct > 50;
  return (
    <div className="h-2 rounded-full bg-white/5 overflow-hidden">
      <div
        className={`h-full transition-all ${hot ? 'bg-red-400' : warm ? 'bg-amber-400' : 'bg-[#DFFF00]'}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}
