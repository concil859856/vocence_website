/**
 * Vocence Studio — Ops fleet manager (admin-only).
 *
 * URL: /studio/ops
 *
 * Three tabs:
 *   Servers   — register rented GPU boxes, see Docker/GPU info, remove
 *   Pods      — deploy services on those servers, stop/restart/update,
 *               view logs, see live in-flight from the dispatcher
 *   Analytics — fleet tiles + 24h/7d per-service time series
 *
 * Builds on dashboard-backend's ops module — every action here turns into
 * an HTTP call to /api/dashboard/ops/* (admin-gated server-side).
 */
import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Activity, Cpu, Server, Sparkles } from 'lucide-react';
import { ADMIN_EMAIL } from '../config';
import { useAuth } from '../contexts/AuthContext';
import { getStoredToken } from '../lib/agents/api';
import { ServersTab } from '../components/ops/ServersTab';
import { PodsTab } from '../components/ops/PodsTab';
import { AnalyticsTab } from '../components/ops/AnalyticsTab';

type OpsTab = 'servers' | 'pods' | 'analytics';

const TABS: { id: OpsTab; label: string; icon: typeof Server }[] = [
  { id: 'analytics', label: 'Analytics', icon: Activity },
  { id: 'servers', label: 'Servers', icon: Server },
  { id: 'pods', label: 'Pods', icon: Cpu },
];

export function StudioOps() {
  const { user, isAuthenticated, isLoading } = useAuth();
  const [tab, setTab] = useState<OpsTab>('analytics');
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    setToken(getStoredToken());
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#07080A] flex items-center justify-center text-[#A7B0B7]">
        Loading…
      </div>
    );
  }
  if (!isAuthenticated || !user) return <Navigate to="/" replace />;
  if (user.email !== ADMIN_EMAIL) {
    return (
      <div className="min-h-screen bg-[#07080A] flex items-center justify-center">
        <div className="max-w-md text-center text-[#A7B0B7]">
          <Sparkles className="w-8 h-8 text-[#DFFF00] mx-auto mb-4" />
          <h2 className="text-2xl text-white mb-2">Admin only</h2>
          <p>
            /studio/ops is the internal fleet manager. Signed-in admins only —
            you're signed in as <span className="text-white">{user.email}</span>.
          </p>
        </div>
      </div>
    );
  }
  if (!token) {
    return (
      <div className="min-h-screen bg-[#07080A] flex items-center justify-center text-[#A7B0B7]">
        No auth token — please sign out and back in.
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

        {/* Tab content */}
        {tab === 'analytics' && <AnalyticsTab token={token} />}
        {tab === 'servers' && <ServersTab token={token} />}
        {tab === 'pods' && <PodsTab token={token} />}
      </div>
    </div>
  );
}
