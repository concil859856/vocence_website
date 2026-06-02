/**
 * Quality, admin view of user thumbs feedback.
 *
 * Two side-by-side cards:
 *   1. Per-feature satisfaction (entry_type breakdown) with 24h/7d/30d
 *      toggle. Shows up/down counts + satisfaction % so the admin can
 *      see which surfaces (TTS, agent chat, voice cloning, …) are doing
 *      well or poorly at a glance.
 *   2. Recent thumbs-down events with user email + comment, the
 *      actionable list. Each row links into the relevant feature so
 *      the admin can inspect the exact output that was rated.
 *
 * Backend routes ([routers/feedback.py](../../../../dashboard-backend/routers/feedback.py)):
 *   GET /feedback/admin/overview        , aggregate
 *   GET /feedback/admin/recent-negative , actionable list
 *
 * Both require admin sudo-unlock, same as the rest of the admin
 * surfaces, so we reuse the ``authHeaders`` pattern from opsApi.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ThumbsUp, ThumbsDown, MessageSquare, RefreshCw } from 'lucide-react';
import { API_BASE_URL } from '../../services/baseUrl';
import { getStoredToken } from '../../lib/agents/api';
import { getStoredAdminToken } from '../../lib/admin/api';

const ACCENT = '#D1F840';

type RangeKey = '24h' | '7d' | '30d';

interface OverviewRow {
  entry_type: string;
  up_count: number;
  down_count: number;
  total: number;
  satisfaction_pct: number | null;
}

interface OverviewResponse {
  range: RangeKey;
  overall_satisfaction_pct: number | null;
  rows: OverviewRow[];
}

interface NegativeRow {
  id: string;
  user_id: number | null;
  user_email: string | null;
  entry_type: string;
  entry_id: string;
  comment: string | null;
  created_at: string;
}

interface NegativeResponse {
  range: RangeKey;
  rows: NegativeRow[];
}

/** Admin endpoints sit under /api/dashboard/feedback/admin. API_BASE_URL
 *  already ends with /api, so the path starts at /dashboard/..., see
 *  the same convention in opsApi. */
const FEEDBACK_BASE = `${API_BASE_URL}/dashboard/feedback/admin`;

function adminHeaders(): HeadersInit {
  const h: Record<string, string> = {};
  const jwt = getStoredToken();
  if (jwt) h.Authorization = `Bearer ${jwt}`;
  const adminToken = getStoredAdminToken();
  if (adminToken) h['X-Admin-Token'] = adminToken;
  return h;
}

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(`${FEEDBACK_BASE}${path}`, { headers: adminHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Pretty-print entry_type values stored as snake_case in the DB. */
function labelForEntryType(t: string): string {
  if (!t) return 'Unknown';
  return t
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** ISO timestamp → "5m ago" / "2h ago" / "3d ago". Kept inline rather
 *  than pulling in date-fns since this is the only spot we need it. */
function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

export function AdminQualitySection() {
  const [range, setRange] = useState<RangeKey>('7d');
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [negative, setNegative] = useState<NegativeResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, neg] = await Promise.all([
        fetchJson<OverviewResponse>(`/overview?range=${range}`),
        fetchJson<NegativeResponse>(`/recent-negative?range=${range}&limit=50`),
      ]);
      setOverview(ov);
      setNegative(neg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { void refresh(); }, [refresh]);

  const overallText = useMemo(() => {
    if (!overview || overview.overall_satisfaction_pct == null) return '—';
    return `${overview.overall_satisfaction_pct.toFixed(1)}%`;
  }, [overview]);

  return (
    <section className="glass-panel rounded-xl p-6 mb-8">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h2 className="text-lg font-semibold text-white flex items-center gap-2">
          <ThumbsUp className="w-5 h-5" style={{ color: ACCENT }} />
          Quality (user thumbs)
        </h2>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-lg border border-[#27272a] bg-[#0a0a0a] p-0.5">
            {(['24h', '7d', '30d'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRange(r)}
                className={`px-3 py-1 text-xs rounded-md transition-colors ${
                  range === r
                    ? 'bg-white/10 text-white'
                    : 'text-gray-400 hover:text-white'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border border-[#27272a] bg-[#0a0a0a] text-gray-300 hover:text-white hover:border-white/20 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-400 mb-3">Failed to load: {error}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Card 1, per-feature satisfaction */}
        <div className="rounded-xl border border-[#27272a] bg-[#0a0a0a] p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-sm font-medium text-white">By feature</h3>
            <div className="text-xs text-gray-400">
              Overall: <span className="text-white font-semibold tabular-nums">{overallText}</span>
            </div>
          </div>
          {overview && overview.rows.length === 0 ? (
            <p className="text-sm text-gray-500 py-6 text-center">No thumbs in this range yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-[#27272a]">
                  <th className="text-left font-normal py-2">Feature</th>
                  <th className="text-right font-normal py-2">
                    <ThumbsUp className="w-3.5 h-3.5 inline" />
                  </th>
                  <th className="text-right font-normal py-2">
                    <ThumbsDown className="w-3.5 h-3.5 inline" />
                  </th>
                  <th className="text-right font-normal py-2">Sat.</th>
                </tr>
              </thead>
              <tbody>
                {overview?.rows.map((row) => (
                  <tr key={row.entry_type} className="border-b border-[#1a1a1a] last:border-0">
                    <td className="py-2 text-white">{labelForEntryType(row.entry_type)}</td>
                    <td className="py-2 text-right text-emerald-300 tabular-nums">{row.up_count}</td>
                    <td className="py-2 text-right text-rose-300 tabular-nums">{row.down_count}</td>
                    <td className="py-2 text-right tabular-nums">
                      {row.satisfaction_pct == null ? (
                        <span className="text-gray-500">—</span>
                      ) : (
                        <span
                          className={
                            row.satisfaction_pct >= 80
                              ? 'text-emerald-300'
                              : row.satisfaction_pct >= 50
                                ? 'text-amber-300'
                                : 'text-rose-300'
                          }
                        >
                          {row.satisfaction_pct.toFixed(0)}%
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Card 2, recent thumbs-down (the actionable list) */}
        <div className="rounded-xl border border-[#27272a] bg-[#0a0a0a] p-4">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-sm font-medium text-white flex items-center gap-1.5">
              <ThumbsDown className="w-4 h-4 text-rose-300" />
              Recent thumbs-down
            </h3>
            <div className="text-xs text-gray-500">
              {negative ? `${negative.rows.length} shown` : ''}
            </div>
          </div>
          {negative && negative.rows.length === 0 ? (
            <p className="text-sm text-gray-500 py-6 text-center">No negative feedback in this range, nice.</p>
          ) : (
            <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
              {negative?.rows.map((row) => (
                <div
                  key={row.id}
                  className="rounded-lg border border-[#1f1f1f] bg-[#0f0f0f] p-3 text-xs"
                >
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-[#27272a] text-gray-300">
                        {labelForEntryType(row.entry_type)}
                      </span>
                      <span className="truncate text-gray-400" title={row.user_email ?? `user ${row.user_id ?? '?'}`}>
                        {row.user_email ?? `user ${row.user_id ?? '?'}`}
                      </span>
                    </div>
                    <span className="text-gray-500 shrink-0">{relativeTime(row.created_at)}</span>
                  </div>
                  {row.comment ? (
                    <div className="text-gray-300 leading-relaxed flex gap-1.5">
                      <MessageSquare className="w-3 h-3 mt-0.5 shrink-0 text-gray-500" />
                      <span>{row.comment}</span>
                    </div>
                  ) : (
                    <div className="text-gray-500 italic">(no comment)</div>
                  )}
                  <div className="mt-1.5 text-[10px] text-gray-600 font-mono truncate" title={row.entry_id}>
                    {row.entry_id}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
