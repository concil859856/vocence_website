/**
 * Shared wrapper for every admin-only page:
 *
 *   <AdminGate>
 *     <Admin />        // or AdminWebsiteUsage, AdminOps, ...
 *   </AdminGate>
 *
 * Behavior:
 *   1. Anonymous / non-ADMIN_EMAIL users          → silent <Navigate to="/">
 *      (no splash; the page shouldn't even be discoverable)
 *   2. Admin without a valid X-Admin-Token        → AdminUnlockModal pops,
 *      child stays unmounted until unlocked
 *   3. Admin with a valid unlock                  → renders the AdminNavBar
 *      (cross-links to all admin pages + "Lock" button + expiry badge)
 *      then the wrapped child
 *
 * Re-renders the child with a fresh key after each unlock so any stale
 * data fetched while locked-out gets retried.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { Activity, Lock, ShieldCheck, Unlock, Users } from 'lucide-react';
import { ADMIN_EMAIL } from '../../config';
import { useAuth } from '../../contexts/AuthContext';
import { getStoredToken } from '../../lib/agents/api';
import {
  adminAuthApi,
  clearStoredAdminToken,
  getStoredAdminToken,
  getStoredAdminTokenExpiry,
} from '../../lib/admin/api';
import { AdminUnlockModal } from './AdminUnlockModal';

// Custom event dispatched from lib/ops/api.ts (or any admin API client) when
// the backend rejects a call with 401 code=admin_unlock_required. Listening
// for it lets AdminGate re-pop the unlock modal mid-session WITHOUT having
// to poll /status itself.
const ADMIN_UNLOCK_EVENT = 'admin-unlock-required';

interface Props {
  children: React.ReactNode;
}

interface AdminNavItem {
  to: string;
  label: string;
  icon: typeof ShieldCheck;
}

const ADMIN_NAV: AdminNavItem[] = [
  { to: '/admin', label: 'Admin', icon: ShieldCheck },
  { to: '/admin/website_usage', label: 'Website usage', icon: Users },
  { to: '/admin/ops', label: 'Ops', icon: Activity },
];

export function AdminGate({ children }: Props) {
  const { user, isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  // Read everything synchronously from storage on first render. The admin
  // token + expiry are signed by the backend (HMAC-sha256) so we can trust
  // the client-side state, no need to call /status on every mount, which
  // was the source of the "ask me again after one good unlock" instability
  // (any network blip on /status would clear the local token).
  //
  // Re-pop the modal only when:
  //   (a) client-side expiry passes (60s interval check below), OR
  //   (b) any admin API call returns 401 admin_unlock_required (which fires
  //       the ADMIN_UNLOCK_EVENT, listener below).
  const [token, setToken] = useState<string | null>(() => getStoredToken());
  const [adminToken, setAdminToken] = useState<string | null>(() => {
    const t = getStoredAdminToken();
    const exp = getStoredAdminTokenExpiry();
    // Trust the stored token only if its expiry hasn't already passed.
    if (t && exp && exp.getTime() <= Date.now()) {
      clearStoredAdminToken();
      return null;
    }
    return t;
  });
  const [expiresAt, setExpiresAt] = useState<Date | null>(() => getStoredAdminTokenExpiry());
  const [renderKey, setRenderKey] = useState(0);

  const showUnlock = !adminToken;

  // Re-read JWT after mount as a safety net (e.g. just-logged-in user
  // whose AuthContext updated localStorage in a later render).
  useEffect(() => {
    const t = getStoredToken();
    if (t !== token) setToken(t);
  }, [token]);

  // Listen for the global "admin-unlock-required" event dispatched by
  // lib/ops/api.ts (and any other admin API client) when the backend
  // rejects a request with 401 code=admin_unlock_required. This is how a
  // truly-expired-server-side token forces a re-prompt mid-session.
  useEffect(() => {
    const handler = () => {
      clearStoredAdminToken();
      setAdminToken(null);
      setExpiresAt(null);
    };
    window.addEventListener(ADMIN_UNLOCK_EVENT, handler);
    return () => window.removeEventListener(ADMIN_UNLOCK_EVENT, handler);
  }, []);

  // Client-side expiry watcher, pops the modal when the 4-hour TTL lapses
  // without a server-side check. Cheap and works offline.
  useEffect(() => {
    if (!adminToken || !expiresAt) return;
    const id = window.setInterval(() => {
      if (Date.now() >= expiresAt.getTime()) {
        clearStoredAdminToken();
        setAdminToken(null);
        setExpiresAt(null);
      }
    }, 60_000);
    return () => window.clearInterval(id);
  }, [adminToken, expiresAt]);

  const handleUnlocked = useCallback(() => {
    const t = getStoredAdminToken();
    const exp = getStoredAdminTokenExpiry();
    setAdminToken(t);
    setExpiresAt(exp);
    setRenderKey((k) => k + 1);
  }, []);

  const handleLock = useCallback(async () => {
    if (token) {
      try { await adminAuthApi.lock(token); } catch { /* best-effort */ }
    }
    clearStoredAdminToken();
    setAdminToken(null);
    setExpiresAt(null);
  }, [token]);

  const expiryLabel = useMemo(() => {
    if (!expiresAt) return null;
    return expiresAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }, [expiresAt]);

  // ---- guards ------------------------------------------------------------
  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#07080A] flex items-center justify-center text-[#A7B0B7]">
        Loading…
      </div>
    );
  }
  // Non-admins (anonymous or signed in as the wrong user) get silently
  // bounced to /. No splash, no hint that admin pages exist.
  //
  // NOTE: we intentionally do NOT gate on a localStorage JWT here. After the
  // cookie-only migration the session lives in the HttpOnly ``vocence_session``
  // cookie, so ``token`` (getStoredToken()) is always null and gating on it
  // would bounce every legitimate admin before the unlock modal could render.
  // Identity is established by the cookie-backed ``isAuthenticated``/``user``.
  if (!isAuthenticated || !user || user.email !== ADMIN_EMAIL) {
    return <Navigate to="/" replace />;
  }
  return (
    <div className="pt-20">
      {/* Admin top bar, cross-links + unlock badge + Lock button. Only
          rendered when the admin is unlocked; the modal handles the locked state. */}
      {adminToken && (
        <div className="sticky top-20 z-30 bg-[#07080A]/95 backdrop-blur border-b border-white/10">
          <div className="max-w-7xl mx-auto px-6 py-2 flex items-center justify-between gap-3 flex-wrap">
            <nav className="flex items-center gap-1">
              {ADMIN_NAV.map((item) => {
                const Icon = item.icon;
                const active = location.pathname === item.to
                  || (item.to !== '/admin' && location.pathname.startsWith(item.to));
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                      active
                        ? 'bg-[#DFFF00]/15 text-[#DFFF00]'
                        : 'text-[#A7B0B7] hover:text-white hover:bg-white/[0.04]'
                    }`}
                  >
                    <Icon size={13} />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
            <div className="flex items-center gap-2">
              <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-[#DFFF00]/30 bg-[#DFFF00]/[0.06] text-[#DFFF00] text-[11px]">
                <Unlock size={11} />
                <span>Unlocked{expiryLabel ? ` · until ${expiryLabel}` : ''}</span>
              </div>
              <button
                type="button"
                onClick={handleLock}
                title="Lock all admin pages"
                className="inline-flex items-center gap-1 text-[11px] text-[#A7B0B7] hover:text-white px-2 py-1 rounded-lg bg-white/[0.04] hover:bg-white/[0.08]"
              >
                <Lock size={11} /> Lock
              </button>
            </div>
          </div>
        </div>
      )}

      {adminToken ? (
        <div key={renderKey}>{children}</div>
      ) : (
        <div className="min-h-screen bg-[#07080A] pt-20 flex items-center justify-center">
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-10 text-center text-[#A7B0B7] max-w-sm">
            <Lock size={28} className="text-[#A7B0B7] mx-auto mb-3" />
            <p className="text-sm">Enter the admin password to continue.</p>
          </div>
        </div>
      )}

      {showUnlock && (
        <AdminUnlockModal token={token} onUnlocked={handleUnlocked} />
      )}
    </div>
  );
}
