const RAW_API_URL =
  import.meta.env.VITE_API_URL != null && import.meta.env.VITE_API_URL !== ''
    ? import.meta.env.VITE_API_URL.replace(/\/$/, '')
    : '';

/**
 * Dev: empty string → same-origin `/api/...` (use Vite `server.proxy` to the backend — no CORS issues).
 * Prod: empty → same-origin (set rewrites on the host) or set VITE_API_URL to your API origin.
 */
export const API_ORIGIN_BASE =
  RAW_API_URL !== '' ? RAW_API_URL : '';

export const API_BASE_URL = API_ORIGIN_BASE ? `${API_ORIGIN_BASE}/api` : '/api';

export const CONFIGURED_API_TARGET =
  RAW_API_URL !== '' ? RAW_API_URL : '(same-origin /api via Vite proxy in dev)';

export function withNetworkHint(error: unknown): Error {
  if (error instanceof TypeError) {
    return new Error(
      `Network request failed. Check that VITE_API_URL points to a reachable backend. Current value: ${CONFIGURED_API_TARGET}`
    );
  }
  return error instanceof Error ? error : new Error('Unknown API error');
}
