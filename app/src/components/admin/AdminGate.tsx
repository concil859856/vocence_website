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

  const [token, setToken] = useState<string | null>(null);
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [unlockChecked, setUnlockChecked] = useState(false);
  const [showUnlock, setShowUnlock] = useState(false);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  const [renderKey, setRenderKey] = useState(0);

  useEffect(() => { setToken(getStoredToken()); }, []);

  const verifyUnlock = useCallback(async (t: string) => {
    const stored = getStoredAdminToken();
    if (!stored) {
      setAdminToken(null);
      setExpiresAt(null);
      setShowUnlock(true);
      setUnlockChecked(true);
      return;
    }
    try {
      const status = await adminAuthApi.status(t, stored);
      if (status.unlocked) {
        setAdminToken(stored);
        setExpiresAt(status.expires_at ? new Date(status.expires_at) : null);
        setShowUnlock(false);
      } else {
        clearStoredAdminToken();
        setAdminToken(null);
        setExpiresAt(null);
        setShowUnlock(true);
      }
    } catch {
      setAdminToken(null);
      setExpiresAt(null);
      setShowUnlock(true);
    } finally {
      setUnlockChecked(true);
    }
  }, []);

  useEffect(() => {
    if (token) verifyUnlock(token);
  }, [token, verifyUnlock]);

  // Periodically re-check expiry; pops the modal when TTL lapses mid-session.
  useEffect(() => {
    if (!adminToken || !expiresAt) return;
    const id = window.setInterval(() => {
      if (Date.now() >= expiresAt.getTime()) {
        clearStoredAdminToken();
        setAdminToken(null);
        setExpiresAt(null);
        setShowUnlock(true);
      }
    }, 60_000);
    return () => window.clearInterval(id);
  }, [adminToken, expiresAt]);

  const handleUnlocked = useCallback(() => {
    const t = getStoredAdminToken();
    const exp = getStoredAdminTokenExpiry();
    setAdminToken(t);
    setExpiresAt(exp);
    setShowUnlock(false);
    setRenderKey((k) => k + 1);
  }, []);

  const handleLock = useCallback(async () => {
    if (token) {
      try { await adminAuthApi.lock(token); } catch { /* best-effort */ }
    }
    clearStoredAdminToken();
    setAdminToken(null);
    setExpiresAt(null);
    setShowUnlock(true);
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
  if (!isAuthenticated || !user || user.email !== ADMIN_EMAIL || !token) {
    return <Navigate to="/" replace />;
  }
  if (!unlockChecked) {
    return (
      <div className="min-h-screen bg-[#07080A] flex items-center justify-center text-[#A7B0B7]">
        Verifying admin session…
      </div>
    );
  }

  return (
    <>
      {/* Admin top bar — cross-links + unlock badge + Lock button. Only
          rendered when the admin is unlocked; the modal handles the locked state. */}
      {adminToken && (
        <div className="sticky top-16 z-30 bg-[#07080A]/95 backdrop-blur border-b border-white/10">
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
    </>
  );
}
