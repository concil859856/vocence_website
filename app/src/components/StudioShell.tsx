import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Eye, EyeOff, Home } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { studioSidebarItems, type StudioView } from '../studio/studioNav';
import { ActiveJobsPill } from './ActiveJobsPill';
import { useHasVoiceChatAccess } from '../lib/voicechatAccess';

const LOW_CREDIT_THRESHOLD = 50;

type Props = {
  activeView: StudioView | 'home';
  children: React.ReactNode;
  /** Appended to main content wrapper (e.g. flex layout for full-height workspace). */
  mainClassName?: string;
};

export function StudioShell({ activeView, children, mainClassName = '' }: Props) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [showCredits, setShowCredits] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('vocence_show_credits') === '1';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    localStorage.setItem('vocence_show_credits', showCredits ? '1' : '0');
  }, [showCredits]);
  // Agents is admin-only until publicly launched — drop the item from
  // the sidebar entirely for non-admins so they don't see it.
  const hasAgentsAccess = useHasVoiceChatAccess();
  const visibleSidebarItems = hasAgentsAccess
    ? studioSidebarItems
    : studioSidebarItems.filter((item) => item.id !== 'agents');

  return (
      <div className="flex">
        <aside className="studio-sidebar w-64 border-r border-white/5 bg-[#07080A] h-screen sticky top-0 p-4 hidden lg:flex lg:flex-col overflow-y-auto">
          <button
            type="button"
            onClick={() => navigate('/studio/home')}
            className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all mb-2 ${
              activeView === 'home'
                ? 'bg-white/10 text-white'
                : 'text-[#A7B0B7] hover:bg-white/5 hover:text-white'
            }`}
          >
            <Home size={18} />
            Studio Home
          </button>
          <div className="border-b border-white/5 mb-2" />
          <div className="space-y-1">
            {visibleSidebarItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(`/studio/${item.id}`)}
                className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all ${
                  activeView === item.id
                    ? 'bg-white/10 text-white'
                    : 'text-[#A7B0B7] hover:bg-white/5 hover:text-white'
                }`}
              >
                <item.icon size={18} />
                <span className="flex-1 text-left">{item.label}</span>
                {item.badge && (
                  <span className="text-[9px] font-semibold uppercase tracking-[0.14em] px-1.5 py-0.5 rounded-md text-indigo-300 bg-indigo-500/15 border border-indigo-400/30">
                    {item.badge}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="mt-6 p-4 bg-white/[0.03] rounded-xl">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-[#666] uppercase tracking-wider">Credit Balance</div>
              <button
                type="button"
                onClick={() => setShowCredits((v) => !v)}
                className="text-[#666] hover:text-[#A7B0B7] transition-colors p-0.5 -m-0.5 rounded"
                aria-label={showCredits ? 'Hide credits' : 'Show credits'}
                title={showCredits ? 'Hide credits' : 'Show credits'}
              >
                {showCredits ? <Eye size={14} /> : <EyeOff size={14} />}
              </button>
            </div>
            <div className="text-xl font-semibold mb-1 tabular-nums">
              {showCredits ? (user?.credits || 0).toLocaleString() : '•••••'}{' '}
              <span className="text-sm text-[#A7B0B7] font-normal">credits</span>
            </div>
            <Link
              to="/pricing"
              className="btn-outline mt-3 flex w-full items-center justify-center py-2 text-xs font-semibold"
            >
              Add Credits
            </Link>
          </div>

          <div className="mt-3">
            <ActiveJobsPill />
          </div>
        </aside>

        <div className="lg:hidden fixed bottom-0 left-0 right-0 bg-[#07080A] border-t border-white/5 p-2 z-50 overflow-x-auto">
          <div className="flex gap-1 min-w-max px-1">
            <button
              type="button"
              onClick={() => navigate('/studio/home')}
              className={`p-3 rounded-lg ${activeView === 'home' ? 'text-[#DFFF00]' : 'text-[#666]'}`}
            >
              <Home size={20} />
            </button>
            {visibleSidebarItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate(`/studio/${item.id}`)}
                className={`p-3 rounded-lg ${activeView === item.id ? 'text-[#DFFF00]' : 'text-[#666]'}`}
              >
                <item.icon size={20} />
              </button>
            ))}
          </div>
        </div>

        <main className={`studio-content flex-1 p-6 lg:p-10 pb-24 lg:pb-10 ${mainClassName}`.trim()}>
          {user && (user.credits ?? 0) <= LOW_CREDIT_THRESHOLD && (
            <div className={`mb-6 rounded-xl border px-4 py-3 text-sm flex flex-wrap items-center gap-3 ${
              (user.credits ?? 0) === 0
                ? 'border-red-400/40 bg-red-500/10 text-red-100'
                : 'border-amber-300/30 bg-amber-400/[0.08] text-amber-100'
            }`}>
              <AlertTriangle size={16} className="shrink-0" />
              <span className="flex-1">
                {(user.credits ?? 0) === 0
                  ? 'You’re out of credits. Top up to keep generating.'
                  : <>Only <span className="font-semibold">{user.credits} credits</span> left. Generations will fail soon.</>}
              </span>
              <Link
                to="/pricing"
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#DFFF00] text-[#07080A] px-3 py-1.5 text-xs font-semibold hover:brightness-110"
              >
                Get more credits
              </Link>
            </div>
          )}
          {children}
        </main>
      </div>
  );
}
