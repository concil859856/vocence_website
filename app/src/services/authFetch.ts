/**
 * Centralized `fetch` wrapper for authenticated requests.
 *
 * Sets ``credentials: 'include'`` on every call so the browser
 * auto-attaches the HttpOnly ``vocence_session`` cookie set by the
 * backend at login. The cookie is HttpOnly so JavaScript (including
 * any future XSS) cannot read it — closing the audit's #1 critical
 * finding (previously the JWT was in localStorage where any XSS
 * could exfiltrate it in one line).
 *
 * Pre-phase-4 builds also attached an Authorization: Bearer header
 * from localStorage as transition compat. That code is gone now;
 * the cookie is the only credential.
 *
 * If the caller passes an explicit Authorization header (developer-
 * api key holders making `voc_live_...` calls, the CLI authorize
 * page, etc), it's preserved unchanged — only the cookie attachment
 * is automatic.
 *
 * Use this everywhere instead of bare ``fetch``. It's a drop-in
 * replacement — same signature, same return value, just safer.
 */

export interface AuthFetchInit extends RequestInit {
  /** Skip the auth-attachment logic entirely. Use for endpoints
   *  that must NOT carry credentials (third-party APIs, public
   *  resources where the cookie shouldn't go).
   *
   *  Default: false (always send credentials). */
  skipAuth?: boolean;
}

export async function authFetch(input: RequestInfo | URL, init: AuthFetchInit = {}): Promise<Response> {
  const { skipAuth, ...rest } = init;
  if (skipAuth) {
    return fetch(input, rest);
  }
  return fetch(input, {
    ...rest,
    credentials: 'include',
  });
}
