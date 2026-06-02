/**
 * Vocence ops REST client.
 * Mirrors dashboard-backend/routers/ops.py, every endpoint is admin-only
 * (gated server-side on require_admin_session). Token is the same JWT
 * used elsewhere; admin gating is by email match in the backend.
 */

import { API_BASE_URL, withNetworkHint } from '../../services/baseUrl';
import { clearStoredAdminToken, getStoredAdminToken } from '../admin/api';
import type {
  DispatcherSnapshot,
  FleetHealth,
  LlmBreakdownRow,
  LlmFailureRow,
  LlmFallbackRow,
  LlmOverview,
  LlmPricingRow,
  LlmTimeBucket,
  LlmTimeRange,
  LlmTimeseriesPoint,
  LlmTopError,
  OverviewTiles,
  PodDeployRequest,
  PodEvent,
  PodRow,
  PodRuntimeRow,
  RuntimeWindow,
  ServerAddRequest,
  ServerRow,
  ServerRuntimeRow,
  ServiceName,
  TimeseriesPoint,
} from './types';

function authHeaders(token: string | null): HeadersInit {
  // Every ops call needs BOTH layers: the regular Google JWT AND the
  // sudo-mode admin_token from sessionStorage. Backend gates on both.
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const adminToken = getStoredAdminToken();
  if (adminToken) h['X-Admin-Token'] = adminToken;
  return h;
}

async function jsonFetch<T>(url: string, init: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw withNetworkHint(err);
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { /* keep raw */ }
  }
  if (!res.ok) {
    // Surface the admin_unlock_required signal as a typed error so the
    // caller (AdminOps) can pop the AdminUnlockModal instead of just
    // showing "unauthorized".
    const rawDetail = body && typeof body === 'object' && 'detail' in body
      ? (body as { detail: unknown }).detail
      : undefined;
    if (
      res.status === 401 &&
      rawDetail && typeof rawDetail === 'object' &&
      (rawDetail as { code?: string }).code === 'admin_unlock_required'
    ) {
      clearStoredAdminToken();
      // Dispatch a global event so AdminGate can pop the unlock modal
      // immediately, instead of waiting for the next user interaction
      // (or its 60s expiry watcher) to notice the token's gone.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('admin-unlock-required'));
      }
      const err = new Error('admin_unlock_required') as Error & {
        status?: number;
        code?: string;
      };
      err.status = 401;
      err.code = 'admin_unlock_required';
      throw err;
    }
    const detail = typeof rawDetail === 'string'
      ? rawDetail
      : rawDetail
        ? JSON.stringify(rawDetail)
        : text || `HTTP ${res.status}`;
    const err = new Error(detail) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return body as T;
}

// API_BASE_URL already ends in '/api' (see services/baseUrl.ts), so the
// path starts with '/dashboard/...', NOT '/api/dashboard/...' (which
// would produce a 404 from the duplicated /api/ prefix).
const base = `${API_BASE_URL}/dashboard/ops`;

export const opsApi = {
  // ---- Servers ----------------------------------------------------------
  listServers: (token: string) =>
    jsonFetch<{ servers: ServerRow[] }>(`${base}/servers`, { headers: authHeaders(token) }),

  addServer: (token: string, body: ServerAddRequest) =>
    jsonFetch<{ server: ServerRow; probe_error?: string }>(`${base}/servers`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    }),

  removeServer: (token: string, serverId: number) =>
    jsonFetch<{ ok: true }>(`${base}/servers/${serverId}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }),

  reprobeServer: (token: string, serverId: number) =>
    jsonFetch<{ server: ServerRow; probe: Record<string, unknown> }>(
      `${base}/servers/${serverId}/probe`,
      { method: 'POST', headers: authHeaders(token) },
    ),

  // ---- Pods -------------------------------------------------------------
  listPods: (token: string, filter?: { service?: ServiceName; server_id?: number }) => {
    const qs = new URLSearchParams();
    if (filter?.service) qs.set('service', filter.service);
    if (filter?.server_id !== undefined) qs.set('server_id', String(filter.server_id));
    const url = `${base}/pods${qs.toString() ? `?${qs}` : ''}`;
    return jsonFetch<{ pods: PodRow[] }>(url, { headers: authHeaders(token) });
  },

  deployPod: (token: string, body: PodDeployRequest) =>
    jsonFetch<{ pod: PodRow }>(`${base}/pods`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify(body),
    }),

  stopPod: (token: string, podId: number) =>
    jsonFetch<{ ok: true }>(`${base}/pods/${podId}/stop`, {
      method: 'POST',
      headers: authHeaders(token),
    }),

  restartPod: (token: string, podId: number) =>
    jsonFetch<{ ok: true }>(`${base}/pods/${podId}/restart`, {
      method: 'POST',
      headers: authHeaders(token),
    }),

  updatePod: (token: string, podId: number) =>
    jsonFetch<{ pod: PodRow }>(`${base}/pods/${podId}/update`, {
      method: 'POST',
      headers: authHeaders(token),
    }),

  drainPod: (token: string, podId: number) =>
    jsonFetch<{ ok: true }>(`${base}/pods/${podId}/drain`, {
      method: 'POST',
      headers: authHeaders(token),
    }),

  removePod: (token: string, podId: number) =>
    jsonFetch<{ ok: true }>(`${base}/pods/${podId}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }),

  podLogs: (token: string, podId: number, tail = 200) =>
    jsonFetch<{ logs: string }>(`${base}/pods/${podId}/logs?tail=${tail}`, {
      headers: authHeaders(token),
    }),

  podTimeseries: (token: string, podId: number, rangeHours = 24) =>
    jsonFetch<{ points: TimeseriesPoint[] }>(
      `${base}/pods/${podId}/timeseries?range_hours=${rangeHours}`,
      { headers: authHeaders(token) },
    ),

  // ---- Dashboard --------------------------------------------------------
  overview: (token: string) =>
    jsonFetch<OverviewTiles>(`${base}/overview`, { headers: authHeaders(token) }),

  dispatcher: (token: string) =>
    jsonFetch<{ services: DispatcherSnapshot }>(`${base}/dispatcher`, {
      headers: authHeaders(token),
    }),

  events: (token: string, filter?: { pod_id?: number; kind?: string; limit?: number }) => {
    const qs = new URLSearchParams();
    if (filter?.pod_id !== undefined) qs.set('pod_id', String(filter.pod_id));
    if (filter?.kind) qs.set('kind', filter.kind);
    if (filter?.limit) qs.set('limit', String(filter.limit));
    const url = `${base}/events${qs.toString() ? `?${qs}` : ''}`;
    return jsonFetch<{ events: PodEvent[] }>(url, { headers: authHeaders(token) });
  },

  // ---- Runtime % + fleet health (Phase 1B) ------------------------------

  podsRuntime: (token: string, window: RuntimeWindow) =>
    jsonFetch<{ window: RuntimeWindow; pods: PodRuntimeRow[] }>(
      `${base}/pods/runtime?window=${window}`,
      { headers: authHeaders(token) },
    ),

  serversRuntime: (token: string, window: RuntimeWindow) =>
    jsonFetch<{ window: RuntimeWindow; servers: ServerRuntimeRow[] }>(
      `${base}/servers/runtime?window=${window}`,
      { headers: authHeaders(token) },
    ),

  fleetHealth: (token: string, window: RuntimeWindow) =>
    jsonFetch<FleetHealth>(`${base}/fleet/health?window=${window}`, {
      headers: authHeaders(token),
    }),

  // ---- LLM telemetry (Phase 1B) -----------------------------------------

  llmOverview: (token: string, range: LlmTimeRange) =>
    jsonFetch<LlmOverview>(`${base}/llm/overview?range=${range}`, {
      headers: authHeaders(token),
    }),

  llmByProvider: (token: string, range: LlmTimeRange) =>
    jsonFetch<{ range: string; rows: LlmBreakdownRow[] }>(
      `${base}/llm/by-provider?range=${range}`,
      { headers: authHeaders(token) },
    ),

  llmByModel: (token: string, range: LlmTimeRange, provider?: string) => {
    const qs = new URLSearchParams({ range });
    if (provider) qs.set('provider', provider);
    return jsonFetch<{ range: string; provider: string | null; rows: LlmBreakdownRow[] }>(
      `${base}/llm/by-model?${qs}`,
      { headers: authHeaders(token) },
    );
  },

  llmFailures: (token: string, range: LlmTimeRange, limit = 200) =>
    jsonFetch<{ range: string; rows: LlmFailureRow[]; top_errors: LlmTopError[] }>(
      `${base}/llm/failures?range=${range}&limit=${limit}`,
      { headers: authHeaders(token) },
    ),

  llmFallbacks: (token: string, range: LlmTimeRange) =>
    jsonFetch<{ range: string; rows: LlmFallbackRow[] }>(
      `${base}/llm/fallbacks?range=${range}`,
      { headers: authHeaders(token) },
    ),

  llmTimeseries: (token: string, range: LlmTimeRange, bucket: LlmTimeBucket, provider?: string) => {
    const qs = new URLSearchParams({ range, bucket });
    if (provider) qs.set('provider', provider);
    return jsonFetch<{ range: string; bucket: LlmTimeBucket; provider: string | null; rows: LlmTimeseriesPoint[] }>(
      `${base}/llm/timeseries?${qs}`,
      { headers: authHeaders(token) },
    );
  },

  llmPricingList: (token: string) =>
    jsonFetch<{ rows: LlmPricingRow[] }>(`${base}/llm/pricing`, {
      headers: authHeaders(token),
    }),

  llmPricingUpsert: (token: string, row: Omit<LlmPricingRow, 'updated_at'>) =>
    jsonFetch<{ ok: true }>(`${base}/llm/pricing`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify(row),
    }),

  llmPricingDeactivate: (token: string, provider: string, model: string) =>
    jsonFetch<{ ok: true }>(`${base}/llm/pricing/${encodeURIComponent(provider)}/${encodeURIComponent(model)}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    }),
};
