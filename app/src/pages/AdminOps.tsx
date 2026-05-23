/**
 * Vocence — Ops fleet manager (admin-only, sudo-gated).
 *
 * URL: /admin/ops      (under /admin namespace, NOT /studio — same
 *                       treatment as the existing /admin platform page)
 *
 * Visibility: non-admins are silently redirected to / — no splash, no
 * hint the page exists. Same pattern Admin.tsx uses.
 *
 * Two-layer admin gate:
 *   1. ADMIN_EMAIL check (component-side; redirects others silently).
 *   2. Admin password unlock (modal; mints a session-scoped admin_token
 *      stored in sessionStorage; auto-prompted when missing/expired).
 *
 * After unlock, three tabs: Analytics, Servers, Pods. Every API call from
 * the tabs sends both the JWT (Authorization) and the admin token
 * (X-Admin-Token) — wired in lib/ops/api.ts. If a child call surfaces
 * `admin_unlock_required` (e.g. token expired mid-session), the modal
 * re-prompts.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Activity, Cpu, Lock, Server, Unlock } from 'lucide-react';
import { ADMIN_EMAIL } from '../config';
import { useAuth } from '../contexts/AuthContext';
import { getStoredToken } from '../lib/agents/api';
import {
  adminAuthApi,
  clearStoredAdminToken,
  getStoredAdminToken,
  getStoredAdminTokenExpiry,
} from '../lib/admin/api';
import { AdminUnlockModal } from '../components/admin/AdminUnlockModal';
import { ServersTab } from '../components/ops/ServersTab';
import { PodsTab } from '../components/ops/PodsTab';
import { AnalyticsTab } from '../components/ops/AnalyticsTab';

type OpsTab = 'servers' | 'pods' | 'analytics';

const TABS: { id: OpsTab; label: string; icon: typeof Server }[] = [
  { id: 'analytics', label: 'Analytics', icon: Activity },
  { id: 'servers', label: 'Servers', icon: Server },
  { id: 'pods', label: 'Pods', icon: Cpu },
];

export function AdminOps() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const [tab, setTab] = useState<OpsTab>('analytics');
  const [token, setToken] = useState<string | null>(null);
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [unlockChecked, setUnlockChecked] = useState(false);
  const [showUnlock, setShowUnlock] = useState(false);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);
  // Bumped after re-unlock so child tab components remount + re-fetch
  // (they hold stale data from the pre-unlock 401 state otherwise).
  const [renderKey, setRenderKey] = useState(0);

  useEffect(() => {
    setToken(getStoredToken());
  }, []);

  // On mount (and after unlock), verify the token with the backend.
  // Cheaper than waiting for a 401 from an ops call.
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
      // Network blip — assume locked rather than open.
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

  // Periodically re-check expiry every 60s — pops the modal when the
  // 4-hour TTL lapses mid-session.
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
  // Non-admins (anonymous OR signed in as non-ADMIN_EMAIL) get silently
  // bounced to the homepage. No splash, no "Admin only" message — they
  // shouldn't even discover this page exists. Same pattern as Admin.tsx.
  if (!isAuthenticated || !user || user.email !== ADMIN_EMAIL) {
    return <Navigate to="/" replace />;
  }
  if (!token) {
    // Auth state says signed in but token missing — likely a stale session.
    // Bounce home and let them re-login normally.
    return <Navigate to="/" replace />;
  }

  // Show a brief "checking unlock status" placeholder before deciding
  // whether to render the modal or the tabs.
  if (!unlockChecked) {
    return (
      <div className="min-h-screen bg-[#07080A] flex items-center justify-center text-[#A7B0B7]">
        Verifying admin session…
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#07080A] pt-20 pb-20">
      <div className="max-w-7xl mx-auto px-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-semibold text-white tracking-tight">Ops</h1>
            <p className="text-sm text-[#A7B0B7] mt-1">
              Fleet manager for Vocence GPU services. Add a rented box,
              deploy a service to it, watch the analytics.
            </p>
          </div>
          {adminToken && (
            <div className="flex items-center gap-3">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[#DFFF00]/30 bg-[#DFFF00]/[0.06] text-[#DFFF00] text-xs">
                <Unlock size={13} />
                <span>Admin unlocked{expiryLabel ? ` · until ${expiryLabel}` : ''}</span>
              </div>
              <button
                type="button"
                onClick={handleLock}
                title="Lock the Ops console"
                className="inline-flex items-center gap-1.5 text-xs text-[#A7B0B7] hover:text-white px-3 py-1.5 rounded-lg bg-white/[0.04] hover:bg-white/[0.08]"
              >
                <Lock size={13} /> Lock
              </button>
            </div>
          )}
        </div>

        {/* Tab nav */}
        <div className="flex items-center gap-1 mb-6 border-b border-white/10">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  active
                    ? 'text-[#DFFF00] border-[#DFFF00]'
                    : 'text-[#A7B0B7] border-transparent hover:text-white'
                }`}
              >
                <Icon size={15} />
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Tab content — render only when unlocked. The lib/ops/api.ts
            wrapper sends X-Admin-Token automatically; any child API call
            that comes back admin_unlock_required will pop the modal via
            the global handler below. */}
        {adminToken ? (
          <div key={renderKey}>
            {tab === 'analytics' && <AnalyticsTab token={token} />}
            {tab === 'servers' && <ServersTab token={token} />}
            {tab === 'pods' && <PodsTab token={token} />}
          </div>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-12 text-center text-[#A7B0B7]">
            <Lock size={28} className="text-[#A7B0B7] mx-auto mb-3" />
            <p className="text-sm">Enter the admin password to access the Ops console.</p>
          </div>
        )}
      </div>

      {showUnlock && (
        <AdminUnlockModal
          token={token}
          onUnlocked={handleUnlocked}
        />
      )}
    </div>
  );
}
