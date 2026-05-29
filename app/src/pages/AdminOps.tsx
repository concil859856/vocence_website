/**
 * Vocence — Ops fleet manager (admin-only).
 *
 * URL: /admin/ops
 *
 * Auth + sudo-mode unlock + cross-link nav are all handled by the
 * <AdminGate> wrapper in App.tsx. This component is just the three-tab
 * page (Analytics / Servers / Pods) — by the time it mounts, the user is
 * confirmed admin + unlocked.
 */
import { useState } from 'react';
import { Activity, Brain, Cpu, Server } from 'lucide-react';
import { getStoredToken } from '../lib/agents/api';
import { ServersTab } from '../components/ops/ServersTab';
import { PodsTab } from '../components/ops/PodsTab';
import { AnalyticsTab } from '../components/ops/AnalyticsTab';
import { LlmTab } from '../components/ops/LlmTab';

type OpsTab = 'servers' | 'pods' | 'analytics' | 'llm';

const TABS: { id: OpsTab; label: string; icon: typeof Server }[] = [
  { id: 'analytics', label: 'Analytics', icon: Activity },
  { id: 'servers', label: 'Servers', icon: Server },
  { id: 'pods', label: 'Pods', icon: Cpu },
  { id: 'llm', label: 'LLM', icon: Brain },
];

export function AdminOps() {
  const [tab, setTab] = useState<OpsTab>('analytics');
  // AdminGate guarantees the JWT is present in localStorage by the time
  // this child mounts. Read it synchronously so tab components have it
  // on first render.
  const token = getStoredToken() || '';

  return (
    <div className="min-h-screen bg-[#07080A] pt-4 pb-20">
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

        {/* Tab content. All admin/auth headers are injected by lib/ops/api.ts
            (X-Admin-Token from sessionStorage). If a call returns 401
            code=admin_unlock_required mid-session, AdminGate's expiry
            watcher pops the unlock modal. */}
        {tab === 'analytics' && <AnalyticsTab token={token} />}
        {tab === 'servers' && <ServersTab token={token} />}
        {tab === 'pods' && <PodsTab token={token} />}
        {tab === 'llm' && <LlmTab token={token} />}
      </div>
    </div>
  );
}
