import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AlertTriangle, Eye, EyeOff, Home } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { studioNavSections, studioSidebarItems, STUDIO_HELP_ITEM, type StudioView, type StudioNavItem } from '../studio/studioNav';
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
  // Agents is admin-only until publicly launched, drop the item from
  // the sidebar entirely for non-admins so they don't see it.
  const hasAgentsAccess = useHasVoiceChatAccess();
  const visibleSections = studioNavSections
    .map((section) => ({
      ...section,
      items: hasAgentsAccess
        ? section.items
        : section.items.filter((item) => item.id !== 'agents'),
    }))
    .filter((section) => section.items.length > 0);

  /** Route handler shared between desktop + mobile rows. External items
   *  (Help → Discord) open in a new tab; internal items use react-router. */
  const handleNavClick = (item: StudioNavItem) => {
    if (item.external && item.to) {
      window.open(item.to, '_blank', 'noopener,noreferrer');
      return;
    }
    navigate(item.to ?? `/studio/${item.id}`);
  };

  return (
      <div className="flex">
        <aside className="studio-sidebar w-64 border-r border-white/5 bg-[#07080A] h-screen sticky top-0 px-3 py-4 hidden lg:flex lg:flex-col overflow-y-auto">
          {/* Home sits at the very top, OUTSIDE any category, it's the
              landing page for the whole Studio, not part of a workflow
              group. */}
          <SidebarItem
            item={{ id: 'home', label: 'Home', icon: Home }}
            active={activeView === 'home'}
            onClick={() => navigate('/studio/home')}
          />

          {visibleSections.map((section) => (
            <div key={section.heading} className="mt-5">
              <div className="px-3 mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.16em] text-white/35">
                {section.heading}
              </div>
              <div className="space-y-0.5">
                {section.items.map((item) => (
                  <SidebarItem
                    key={item.id}
                    item={item}
                    active={activeView === item.id}
                    onClick={() => handleNavClick(item)}
                  />
                ))}
              </div>
            </div>
          ))}

          {/* Credit balance card sits inline right after the last
              category (Developer), NOT pushed to the bottom via
              mt-auto. Keeps the original card density too. */}
          <div className="mt-5 p-4 bg-white/[0.03] rounded-xl">
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

          {/* Help sits at the bottom of the rail, OUTSIDE the category
              system, same placement Vercel / Linear / Figma use. The
              standalone slot signals "this is escape-hatch support, not
              part of the product nav". Routes to community Discord. */}
          <div className="mt-3 pt-3 border-t border-white/5">
            <SidebarItem
              item={STUDIO_HELP_ITEM}
              active={false}
              onClick={() => handleNavClick(STUDIO_HELP_ITEM)}
            />
          </div>
        </aside>

        {/* Floating "X generating" chip, viewport-anchored bottom-right
            so it stays visible no matter which Studio page is open or
            how far the user has scrolled. On mobile it sits ABOVE the
            bottom nav bar (which is ~64px tall) so it doesn't get
            covered. Self-hides when there are no pending jobs. */}
        <div className="fixed bottom-20 right-4 lg:bottom-6 lg:right-6 z-40">
          <ActiveJobsPill variant="floating" />
        </div>

        <div className="lg:hidden fixed bottom-0 left-0 right-0 bg-[#07080A] border-t border-white/5 p-2 z-50 overflow-x-auto">
          <div className="flex gap-1 min-w-max px-1">
            {[...studioSidebarItems, STUDIO_HELP_ITEM]
              .filter((item) => !item.disabled)
              .filter((item) => hasAgentsAccess || item.id !== 'agents')
              .map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleNavClick(item)}
                  className={`p-3 rounded-lg ${activeView === item.id ? 'text-[#DFFF00]' : 'text-[#666]'}`}
                  aria-label={item.label}
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


/* ------------------------------------------------------------------ */

function SidebarItem({
  item, active, onClick,
}: {
  item: StudioNavItem;
  active: boolean;
  onClick: () => void;
}) {
  const isDisabled = !!item.disabled;
  return (
    <button
      type="button"
      onClick={isDisabled ? undefined : onClick}
      disabled={isDisabled}
      title={isDisabled ? `${item.label}, coming soon` : undefined}
      className={
        'group w-full flex items-center gap-3 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors ' +
        (isDisabled
          ? 'text-white/35 cursor-not-allowed'
          : active
            ? 'bg-white/[0.06] text-white'
            : 'text-white/65 hover:bg-white/[0.04] hover:text-white')
      }
    >
      <item.icon
        size={16}
        className={
          isDisabled
            ? 'text-white/30'
            : active
              ? 'text-white'
              : 'text-white/55 group-hover:text-white/85'
        }
      />
      <span className="flex-1 text-left">{item.label}</span>
      {item.badge && <NavBadge {...item.badge} />}
    </button>
  );
}

function NavBadge({ text, variant }: { text: string; variant: 'new' | 'beta' | 'soon' }) {
  // NEW: pink/magenta, fresh feature, eye-catching.
  // BETA: violet, quieter, signals "use with care".
  // SOON: neutral grey, not shipped yet, no excitement to convey.
  const palette =
    variant === 'new'
      ? 'bg-gradient-to-r from-pink-500/25 to-fuchsia-500/25 text-pink-200 border-pink-400/30'
      : variant === 'beta'
        ? 'bg-violet-500/15 text-violet-200 border-violet-400/30'
        : 'bg-white/[0.06] text-white/55 border-white/[0.10]';
  return (
    <span
      className={
        'text-[9.5px] font-bold uppercase tracking-[0.10em] px-1.5 py-0.5 rounded-md border ' +
        palette
      }
    >
      {text}
    </span>
  );
}
