const RAW_API_URL =
  import.meta.env.VITE_API_URL != null && import.meta.env.VITE_API_URL !== ''
    ? import.meta.env.VITE_API_URL.replace(/\/$/, '')
    : '';

/**
 * Dev: empty string → same-origin `/api/...` (use Vite `server.proxy` to the backend, no CORS issues).
 * Prod: empty → same-origin (set rewrites on the host) or set VITE_API_URL to your API origin.
 */
export const API_ORIGIN_BASE =
  RAW_API_URL !== '' ? RAW_API_URL : '';

export const API_BASE_URL = API_ORIGIN_BASE ? `${API_ORIGIN_BASE}/api` : '/api';

export const CONFIGURED_API_TARGET =
  RAW_API_URL !== '' ? RAW_API_URL : '(same-origin /api via Vite proxy in dev)';

export function withNetworkHint(error: unknown): Error {
  if (error instanceof TypeError) {
    // fetch() throws TypeError for three distinct cases:
    //   1. backend truly unreachable (DNS / connection refused / hang up)
    //   2. CORS preflight rejected (e.g. backend missing the right
    //      Access-Control-Allow-Headers entry, or 5xx response with no
    //      CORS headers, both make the browser discard the response body)
    //   3. request aborted client-side (timeout, AbortController)
    // The previous message assumed #1 only and falsely blamed VITE_API_URL
    // when the real cause was usually #2 (e.g. a backend 500 that lost its
    // CORS headers along the way). The clearer message asks the user to
    // check DevTools Network tab where the actual status code is visible.
    return new Error(
      `Request failed before a response was received. Check DevTools → Network for the actual status (500 with missing CORS headers, blocked CORS preflight, and a genuinely unreachable backend all look the same here). Backend target: ${CONFIGURED_API_TARGET}`
    );
  }
  return error instanceof Error ? error : new Error('Unknown API error');
}
