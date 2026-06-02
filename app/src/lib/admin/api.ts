/**
 * Admin sudo-mode auth client.
 *
 * Mirrors dashboard-backend/routers/admin_auth.py. The admin_token is
 * stored in sessionStorage (cleared on browser close, by design; the
 * admin should re-auth after closing their laptop). All ops API calls
 * inject this token as X-Admin-Token via the wrapper in lib/ops/api.ts.
 */

import { API_BASE_URL, withNetworkHint } from '../../services/baseUrl';

const STORAGE_KEY = 'vocence.admin_token';
const EXPIRY_KEY = 'vocence.admin_token_expires_at';

export interface UnlockResponse {
  admin_token: string;
  expires_at: string;
  session_ttl_hours: number;
}

export interface AdminStatus {
  unlocked: boolean;
  expires_at: string | null;
  configured: boolean;
  session_ttl_hours: number;
}

function authHeaders(token: string | null, adminToken?: string | null): HeadersInit {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
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
    const detail =
      body && typeof body === 'object' && 'detail' in body
        ? (body as { detail: unknown }).detail
        : text || `HTTP ${res.status}`;
    const message = typeof detail === 'string' ? detail : JSON.stringify(detail);
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return body as T;
}

// API_BASE_URL already ends in '/api' (see services/baseUrl.ts), so the
// path starts with '/dashboard/...', NOT '/api/dashboard/...' (which
// would produce a 404 from the duplicated /api/ prefix).
const base = `${API_BASE_URL}/dashboard/auth/admin`;

export const adminAuthApi = {
  /** POST the admin password to mint an admin_token. Server rate-limits
   * to 5 attempts per 5 min per IP. */
  unlock: (token: string, password: string) =>
    jsonFetch<UnlockResponse>(`${base}/unlock`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ password }),
    }),

  /** Check whether the current admin_token is still valid. Cheap. */
  status: (token: string, adminToken: string | null) =>
    jsonFetch<AdminStatus>(`${base}/status`, {
      method: 'GET',
      headers: authHeaders(token, adminToken),
    }),

  /** Server-side signal that we're done. Stateless tokens so this is
   * just for the audit log; the real "lock" is wiping sessionStorage. */
  lock: (token: string) =>
    jsonFetch<{ ok: true }>(`${base}/lock`, {
      method: 'POST',
      headers: authHeaders(token),
    }),
};


// ---------------------------------------------------------------------------
// SessionStorage helpers
// ---------------------------------------------------------------------------

export function getStoredAdminToken(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  const expires = sessionStorage.getItem(EXPIRY_KEY);
  if (expires) {
    const t = Date.parse(expires);
    if (!isNaN(t) && t < Date.now()) {
      // Already expired client-side, clean up.
      sessionStorage.removeItem(STORAGE_KEY);
      sessionStorage.removeItem(EXPIRY_KEY);
      return null;
    }
  }
  return sessionStorage.getItem(STORAGE_KEY);
}

export function getStoredAdminTokenExpiry(): Date | null {
  if (typeof sessionStorage === 'undefined') return null;
  const s = sessionStorage.getItem(EXPIRY_KEY);
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

export function setStoredAdminToken(token: string, expiresAt: string): void {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.setItem(STORAGE_KEY, token);
  sessionStorage.setItem(EXPIRY_KEY, expiresAt);
}

export function clearStoredAdminToken(): void {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(EXPIRY_KEY);
}
