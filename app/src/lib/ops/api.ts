/**
 * Vocence ops REST client.
 * Mirrors dashboard-backend/routers/ops.py — every endpoint is admin-only
 * (gated server-side on require_admin_session). Token is the same JWT
 * used elsewhere; admin gating is by email match in the backend.
 */

import { API_BASE_URL, withNetworkHint } from '../../services/baseUrl';
import { clearStoredAdminToken, getStoredAdminToken } from '../admin/api';
import type {
  DispatcherSnapshot,
  OverviewTiles,
  PodDeployRequest,
  PodEvent,
  PodRow,
  ServerAddRequest,
  ServerRow,
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
// path starts with '/dashboard/...' — NOT '/api/dashboard/...' (which
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
};
