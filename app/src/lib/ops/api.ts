/**
 * Vocence ops REST client.
 * Mirrors dashboard-backend/routers/ops.py — every endpoint is admin-only
 * (gated server-side on require_admin_session). Token is the same JWT
 * used elsewhere; admin gating is by email match in the backend.
 */

import { API_BASE_URL, withNetworkHint } from '../../services/baseUrl';
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
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
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
    const detail =
      body && typeof body === 'object' && 'detail' in body && typeof (body as { detail?: string }).detail === 'string'
        ? (body as { detail: string }).detail
        : text || `HTTP ${res.status}`;
    throw new Error(detail);
  }
  return body as T;
}

const base = `${API_BASE_URL}/api/dashboard/ops`;

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
