import { Link, useNavigate } from 'react-router-dom';
import { Home } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { studioSidebarItems, type StudioView } from '../studio/studioNav';

type Props = {
  activeView: StudioView | 'home';
  children: React.ReactNode;
  /** Appended to main content wrapper (e.g. flex layout for full-height workspace). */
  mainClassName?: string;
};

export function StudioShell({ activeView, children, mainClassName = '' }: Props) {
  const navigate = useNavigate();
  const { user } = useAuth();

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
            {studioSidebarItems.map((item) => (
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
                {item.label}
              </button>
            ))}
          </div>

          <div className="mt-6 p-4 bg-white/[0.03] rounded-xl">
            <div className="text-xs text-[#666] uppercase tracking-wider mb-2">Credit Balance</div>
            <div className="text-xl font-semibold mb-1">
              {user?.credits || 0}{' '}
              <span className="text-sm text-[#A7B0B7] font-normal">credits</span>
            </div>
            <Link
              to="/pricing"
              className="btn-outline mt-3 flex w-full items-center justify-center py-2 text-xs font-semibold"
            >
              Add Credits
            </Link>
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
            {studioSidebarItems.map((item) => (
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

        <main className={`studio-content flex-1 p-6 lg:p-10 pb-24 lg:pb-10 ${mainClassName}`.trim()}>{children}</main>
      </div>
  );
}
