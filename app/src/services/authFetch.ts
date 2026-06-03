/**
 * Centralized `fetch` wrapper for authenticated requests.
 *
 * Closes the audit's #1 critical finding by moving session auth from
 * a JavaScript-readable localStorage JWT to an HttpOnly cookie set by
 * the backend. Every authenticated request goes through here so:
 *
 *   1. ``credentials: 'include'`` is set on every call → the
 *      browser auto-attaches the ``vocence_session`` cookie. The
 *      cookie is HttpOnly so JavaScript (including any future XSS)
 *      cannot read it.
 *
 *   2. During the migration window we ALSO attach the legacy
 *      ``Authorization: Bearer <jwt>`` header when localStorage
 *      still has a token. The backend's require_auth accepts EITHER
 *      cookie or Bearer, so pre-migration users keep working. This
 *      compat layer is removed in phase 4 (drop localStorage).
 *
 *   3. Bypasses the auth attachment when the caller already set its
 *      own Authorization header (developer-api key holders making
 *      `voc_live_...` calls, the CLI authorize page, etc).
 *
 * Use this everywhere instead of bare ``fetch``. It's a drop-in
 * replacement — same signature, same return value, just safer.
 */

const LEGACY_TOKEN_KEY = 'vocence_token';

export interface AuthFetchInit extends RequestInit {
  /** Skip the auth-attachment logic entirely. Use for endpoints
   *  that must NOT carry credentials (third-party APIs, public
   *  resources where the cookie shouldn't go).
   *
   *  Default: false (always attach auth). */
  skipAuth?: boolean;
}

export async function authFetch(input: RequestInfo | URL, init: AuthFetchInit = {}): Promise<Response> {
  const { skipAuth, ...rest } = init;
  if (skipAuth) {
    return fetch(input, rest);
  }

  // Normalize headers into a Headers object so we can safely add to it.
  const headers = new Headers(rest.headers);

  // Legacy compat: if the caller hasn't already set Authorization,
  // and we have a token in localStorage, attach it. Removed in phase 4.
  if (!headers.has('Authorization')) {
    try {
      const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
      if (legacyToken) {
        headers.set('Authorization', `Bearer ${legacyToken}`);
      }
    } catch {
      // localStorage access can throw in some sandboxed contexts (incognito,
      // strict cookies-disabled mode). The cookie still works in those
      // contexts, so just skip the Bearer fallback.
    }
  }

  return fetch(input, {
    ...rest,
    credentials: 'include',
    headers,
  });
}
