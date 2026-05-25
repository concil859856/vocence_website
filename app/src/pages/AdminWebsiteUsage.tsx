import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowLeft, Search, User, X, ChevronLeft, ChevronRight, Sparkles, Mic, FileAudio, Copy as CopyIcon, Music, Palette, Zap, Maximize2 } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ADMIN_EMAIL } from '../config';
import {
  dashboardApi,
  type AdminAuthHistoryRow,
  type AdminCreditTransactionRow,
  type AdminPaymentRow,
  type AdminUserActivitySummary,
  type RegisteredUser,
  type UserRecentActivityResponse,
  type WebsiteOverview,
} from '../services/dashboardApi';

const ACCENT = '#D1F840';
const PAGE_SIZE = 25;

type ActivityType = 'tts' | 'stt' | 'clone' | 'voice_design' | 'music';
const ACTIVITY_META: Record<ActivityType, { label: string; color: string; key: string; icon: typeof Mic }> = {
  tts:          { label: 'TTS',          color: '#DFFF00', key: 'tts_generation_count', icon: Zap },
  stt:          { label: 'STT',          color: '#34d399', key: 'stt_count',            icon: Mic },
  clone:        { label: 'Voice Clone',  color: '#22d3ee', key: 'clone_count',          icon: CopyIcon },
  voice_design: { label: 'Voice Design', color: '#a78bfa', key: 'voice_design_count',   icon: Palette },
  music:        { label: 'Music',        color: '#f472b6', key: 'music_count',          icon: Music },
};
const ACTIVITY_TYPES: ActivityType[] = ['tts', 'stt', 'clone', 'voice_design', 'music'];

type Tab = 'overview' | 'tts' | 'credits' | 'payments' | 'history' | 'users';

const VALID_TABS: Tab[] = ['overview', 'tts', 'credits', 'payments', 'history', 'users'];

export function AdminWebsiteUsage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user, isAuthenticated } = useAuth();
  const isAdmin = isAuthenticated && user?.email === ADMIN_EMAIL;
  const adminEmail = user?.email ?? '';

  const [tab, setTab] = useState<Tab>(() => {
    const t = searchParams.get('tab');
    return t && VALID_TABS.includes(t as Tab) ? (t as Tab) : 'overview';
  });
  const [overview, setOverview] = useState<WebsiteOverview | null>(null);
  const [overviewErr, setOverviewErr] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [page, setPage] = useState(1);
  const [filterUserId, setFilterUserId] = useState<string | null>(() => searchParams.get('user'));
  const [userSummary, setUserSummary] = useState<AdminUserActivitySummary | null>(null);

  const [activity, setActivity] = useState<UserRecentActivityResponse | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [credits, setCredits] = useState<{ items: AdminCreditTransactionRow[]; total: number } | null>(null);
  const [payments, setPayments] = useState<{ items: AdminPaymentRow[]; total: number } | null>(null);
  const [history, setHistory] = useState<{ items: AdminAuthHistoryRow[]; total: number } | null>(null);
  const [users, setUsers] = useState<{ items: RegisteredUser[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  const [activeSeries, setActiveSeries] = useState<Set<ActivityType>>(() => new Set(ACTIVITY_TYPES));
  const [recentActivity, setRecentActivity] = useState<UserRecentActivityResponse | null>(null);
  const [recentLoading, setRecentLoading] = useState(false);
  const [fullscreenChart, setFullscreenChart] = useState<'gen' | 'credits' | null>(null);

  const toggleSeries = (t: ActivityType) => {
    setActiveSeries((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  useEffect(() => {
    if (!isAuthenticated || !user) {
      navigate('/', { replace: true });
      return;
    }
    if (user.email !== ADMIN_EMAIL) {
      navigate('/', { replace: true });
    }
  }, [isAuthenticated, user, navigate]);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    setPage(1);
  }, [debouncedQ, tab, filterUserId]);

  useEffect(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('tab', tab);
        if (filterUserId) next.set('user', filterUserId);
        else next.delete('user');
        return next;
      },
      { replace: true }
    );
  }, [tab, filterUserId, setSearchParams]);

  const loadOverview = useCallback(async () => {
    if (!adminEmail) return;
    setOverviewErr(null);
    try {
      const res = await dashboardApi.getWebsiteOverview(adminEmail);
      setOverview(res);
    } catch (e) {
      setOverviewErr(e instanceof Error ? e.message : 'Failed to load overview');
      setOverview(null);
    }
  }, [adminEmail]);

  useEffect(() => {
    if (isAdmin) loadOverview();
  }, [isAdmin, loadOverview]);

  const loadUserSummary = useCallback(
    async (uid: string) => {
      if (!adminEmail) return;
      try {
        const s = await dashboardApi.getAdminUserActivitySummary(adminEmail, uid);
        setUserSummary(s);
      } catch {
        setUserSummary(null);
      }
    },
    [adminEmail]
  );

  useEffect(() => {
    if (filterUserId && adminEmail) loadUserSummary(filterUserId);
    else setUserSummary(null);
  }, [filterUserId, adminEmail, loadUserSummary]);

  useEffect(() => {
    if (!filterUserId || !adminEmail) {
      setRecentActivity(null);
      return;
    }
    setRecentLoading(true);
    dashboardApi
      .getAdminUserRecentActivity(adminEmail, filterUserId, 100)
      .then(setRecentActivity)
      .catch(() => setRecentActivity(null))
      .finally(() => setRecentLoading(false));
  }, [filterUserId, adminEmail]);

  const fetchTabData = useCallback(async () => {
    if (!isAdmin || !adminEmail) return;
    if (tab === 'overview') return;
    setLoading(true);
    setListErr(null);
    try {
      const opts = { page, page_size: PAGE_SIZE, q: debouncedQ, user_id: filterUserId };
      if (tab === 'tts') {
        setActivityLoading(true);
        const r = await dashboardApi.getAdminRecentActivity(adminEmail, { limit: 100, user_id: filterUserId });
        setActivity(r);
        setActivityLoading(false);
      } else if (tab === 'credits') {
        const r = await dashboardApi.getAdminWebsiteUsageCredits(adminEmail, opts);
        setCredits({ items: r.items, total: r.total });
      } else if (tab === 'payments') {
        const r = await dashboardApi.getAdminWebsiteUsagePayments(adminEmail, opts);
        setPayments({ items: r.items, total: r.total });
      } else if (tab === 'history') {
        const r = await dashboardApi.getAdminWebsiteUsageAuthHistory(adminEmail, opts);
        setHistory({ items: r.items, total: r.total });
      } else if (tab === 'users') {
        const r = await dashboardApi.getRegisteredUsers(adminEmail, {
          page,
          page_size: PAGE_SIZE,
          q: debouncedQ,
        });
        setUsers({ items: r.users, total: r.total });
      }
    } catch (e) {
      setListErr(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [isAdmin, adminEmail, tab, page, debouncedQ, filterUserId]);

  useEffect(() => {
    if (tab !== 'overview') fetchTabData();
  }, [tab, fetchTabData]);

  const totalPages = (total: number) => Math.max(1, Math.ceil(total / PAGE_SIZE));

  const focusUser = (uid: string) => {
    setFilterUserId(uid);
    setTab('tts');
    window.scrollTo(0, 0);
  };

  const clearUserFilter = () => {
    setFilterUserId(null);
    setUserSummary(null);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('user');
        return next;
      },
      { replace: true }
    );
  };

  if (!isAdmin) return null;

  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'tts', label: 'Activity' },
    { id: 'credits', label: 'Credits' },
    { id: 'payments', label: 'Payments' },
    { id: 'history', label: 'User history' },
    { id: 'users', label: 'All users' },
  ];

  return (
    <div className="min-h-screen bg-[#07080A] pt-4 pb-20 px-4 lg:px-8">
      <div className="max-w-[1400px] mx-auto">
        <div className="flex flex-wrap items-center gap-3 mb-8">
          {filterUserId ? (
            <>
              <Link
                to="/admin/website_usage"
                className="inline-flex items-center gap-2 rounded-xl border border-[#DFFF00]/35 bg-[#DFFF00]/10 px-4 py-2 text-sm font-medium text-[#DFFF00] hover:bg-[#DFFF00]/20 transition-colors"
              >
                <ArrowLeft size={16} />
                Back to full usage
              </Link>
              <Link
                to="/admin"
                className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-[#A7B0B7] hover:text-white hover:bg-white/10 transition-colors"
              >
                Admin home
              </Link>
            </>
          ) : (
            <Link
              to="/admin"
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm text-[#A7B0B7] hover:text-white hover:bg-white/10 transition-colors"
            >
              <ArrowLeft size={16} />
              Admin home
            </Link>
          )}
          <div className="flex items-center gap-2 text-white">
            <Sparkles className="w-5 h-5" style={{ color: ACCENT }} />
            <h1 className="text-2xl font-semibold">Website usage</h1>
          </div>
        </div>

        {/* User drill-down banner */}
        {filterUserId && userSummary && (
          <div className="mb-6 rounded-2xl border border-[#DFFF00]/30 bg-gradient-to-r from-[#DFFF00]/10 via-white/[0.04] to-cyan-500/10 p-5 flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="rounded-xl bg-[#DFFF00]/20 p-2">
                <User className="w-5 h-5 text-[#DFFF00]" />
              </div>
              <div>
                <p className="text-sm font-semibold text-white">{userSummary.name || '—'}</p>
                <p className="text-xs text-[#A7B0B7]">{userSummary.email}</p>
                <p className="text-[11px] font-mono text-gray-500 mt-1 break-all">{userSummary.user_id}</p>
                <div className="mt-3 flex flex-wrap gap-3 text-xs">
                  <span className="rounded-lg bg-black/30 px-2 py-1 text-[#DFFF00]">
                    {userSummary.credits} credits
                  </span>
                  <span className="rounded-lg bg-black/30 px-2 py-1 text-gray-300 capitalize">
                    {userSummary.plan_code} · {userSummary.plan_status}
                  </span>
                  <span className="rounded-lg bg-black/30 px-2 py-1 text-gray-400">
                    TTS: {userSummary.tts_completed_count} gen · {userSummary.tts_total_credits} cr used
                  </span>
                  <span className="rounded-lg bg-black/30 px-2 py-1 text-gray-400">
                    {userSummary.credit_tx_count} credit events · {userSummary.payments_count} payments
                  </span>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={clearUserFilter}
              className="inline-flex items-center gap-1 rounded-lg border border-white/15 px-3 py-1.5 text-xs text-white hover:bg-white/10"
            >
              <X size={14} /> Clear user filter
            </button>
          </div>
        )}

        {/* Tab bar */}
        <div className="flex flex-wrap gap-2 mb-6">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-xl px-4 py-2 text-sm font-medium transition-all ${
                tab === t.id
                  ? 'bg-[#DFFF00] text-[#07080A] shadow-[0_0_24px_rgba(223,255,0,0.25)]'
                  : 'border border-white/10 bg-white/[0.04] text-[#A7B0B7] hover:text-white hover:bg-white/10'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'overview' && (
          <div className="space-y-8">
            {overviewErr && <p className="text-sm text-red-400">{overviewErr}</p>}
            {overview && (
              <>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
                  {[
                    { label: 'Users', value: overview.total_users, sub: `${overview.active_users_7d} active 7d` },
                    { label: 'TTS completed', value: overview.total_generations, sub: 'all time' },
                    { label: 'Credits burned', value: overview.total_credits_used, sub: 'generations' },
                    { label: 'Revenue USD (all time)', value: `$${overview.total_revenue_usd.toFixed(2)}`, sub: 'completed payments' },
                    {
                      label: 'Revenue (full history)',
                      value: `$${overview.usage.reduce((s, d) => s + d.revenue_usd, 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
                      sub: `${overview.usage.length} days in chart`,
                    },
                  ].map((card) => (
                    <div
                      key={card.label}
                      className="relative overflow-hidden rounded-2xl border border-white/10 bg-gradient-to-br from-white/[0.08] to-transparent p-5"
                    >
                      <div className="absolute -right-4 -top-4 h-24 w-24 rounded-full bg-[#DFFF00]/10 blur-2xl" />
                      <p className="text-[10px] uppercase tracking-[0.2em] text-gray-500">{card.label}</p>
                      <p className="mt-2 text-2xl font-bold text-white">{card.value}</p>
                      <p className="mt-1 text-xs text-gray-500">{card.sub}</p>
                    </div>
                  ))}
                </div>

                {(() => {
                  const renderGenChart = () => (
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={overview.usage} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                        <defs>
                          {ACTIVITY_TYPES.map((t) => (
                            <linearGradient key={t} id={`fill-${t}`} x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={ACTIVITY_META[t].color} stopOpacity={0.55} />
                              <stop offset="95%" stopColor={ACTIVITY_META[t].color} stopOpacity={0.02} />
                            </linearGradient>
                          ))}
                        </defs>
                        <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} strokeDasharray="3 3" />
                        <XAxis dataKey="day" tick={{ fill: '#737373', fontSize: 10 }} />
                        <YAxis tick={{ fill: '#737373', fontSize: 10 }} tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))} />
                        <Tooltip
                          cursor={{ stroke: 'rgba(255,255,255,0.06)' }}
                          contentStyle={{ background: 'rgba(10,10,10,0.95)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 12, color: '#fff', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
                          formatter={(value: number, name: string) => [Number(value).toLocaleString(), name]}
                        />
                        {ACTIVITY_TYPES.filter((t) => activeSeries.has(t)).map((t) => (
                          <Area key={t} type="monotone" stackId="gen" dataKey={ACTIVITY_META[t].key} name={ACTIVITY_META[t].label} stroke={ACTIVITY_META[t].color} fill={`url(#fill-${t})`} strokeWidth={1.5} />
                        ))}
                      </AreaChart>
                    </ResponsiveContainer>
                  );
                  const renderCreditsChart = () => (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={overview.usage} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="creditsBarFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.95} />
                            <stop offset="100%" stopColor="#0ea5e9" stopOpacity={0.85} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} strokeDasharray="3 3" />
                        <XAxis dataKey="day" tick={{ fill: '#737373', fontSize: 10 }} />
                        <YAxis tick={{ fill: '#737373', fontSize: 10 }} tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))} />
                        <Tooltip
                          cursor={false}
                          contentStyle={{ background: 'rgba(10,10,10,0.95)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 12, color: '#fff', boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}
                          formatter={(value: number) => [`${Number(value).toLocaleString()} credits`, 'Used']}
                        />
                        <Bar dataKey="credits_used" fill="url(#creditsBarFill)" radius={[6, 6, 0, 0]} name="Credits" />
                      </BarChart>
                    </ResponsiveContainer>
                  );
                  return (
                    <div className="grid gap-6 lg:grid-cols-2">
                      <div className="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(223,255,0,0.06)_0%,rgba(10,10,10,0.98)_70%)] p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                          <div>
                            <h3 className="text-sm font-semibold text-white">Daily generations by type</h3>
                            <p className="text-xs text-[#A7B0B7] mt-1">Toggle a series in the legend to focus on it</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <p className="text-lg font-bold text-[#DFFF00]/90">
                              {overview.usage.reduce((s, d) =>
                                s
                                + (activeSeries.has('tts') ? d.tts_generation_count : 0)
                                + (activeSeries.has('stt') ? (d.stt_count ?? 0) : 0)
                                + (activeSeries.has('clone') ? (d.clone_count ?? 0) : 0)
                                + (activeSeries.has('voice_design') ? (d.voice_design_count ?? 0) : 0)
                                + (activeSeries.has('music') ? (d.music_count ?? 0) : 0),
                              0).toLocaleString()}{' '}
                              <span className="text-xs font-normal text-gray-500">total in selection</span>
                            </p>
                            <button
                              type="button"
                              onClick={() => setFullscreenChart('gen')}
                              className="p-1.5 rounded-lg border border-white/10 text-[#A7B0B7] hover:text-white hover:bg-white/5 transition-colors"
                              title="Fullscreen"
                              aria-label="Fullscreen"
                            >
                              <Maximize2 size={14} />
                            </button>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-2 mb-3">
                          {ACTIVITY_TYPES.map((t) => {
                            const meta = ACTIVITY_META[t];
                            const on = activeSeries.has(t);
                            const Icon = meta.icon;
                            return (
                              <button
                                key={t}
                                type="button"
                                onClick={() => toggleSeries(t)}
                                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-all ${on ? 'border-white/15 bg-white/[0.06] text-white' : 'border-white/5 bg-white/[0.02] text-gray-500 line-through'}`}
                                style={on ? { boxShadow: `inset 0 0 0 1px ${meta.color}40` } : undefined}
                              >
                                <span className="w-2 h-2 rounded-full" style={{ background: meta.color }} />
                                <Icon className="w-3 h-3" />
                                {meta.label}
                              </button>
                            );
                          })}
                        </div>
                        <div className="h-72">{renderGenChart()}</div>
                      </div>
                      <div className="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(56,189,248,0.06)_0%,rgba(10,10,10,0.98)_70%)] p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
                        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                          <div>
                            <h3 className="text-sm font-semibold text-white">Credits burned per day</h3>
                            <p className="text-xs text-[#A7B0B7] mt-1">Full history · daily credits burned (Studio + Voice Chat + Developer API)</p>
                          </div>
                          <div className="flex items-center gap-3">
                            <p className="text-lg font-bold text-sky-400">
                              {overview.usage.reduce((s, d) => s + d.credits_used, 0).toLocaleString()}{' '}
                              <span className="text-xs font-normal text-gray-500">total in chart</span>
                            </p>
                            <button
                              type="button"
                              onClick={() => setFullscreenChart('credits')}
                              className="p-1.5 rounded-lg border border-white/10 text-[#A7B0B7] hover:text-white hover:bg-white/5 transition-colors"
                              title="Fullscreen"
                              aria-label="Fullscreen"
                            >
                              <Maximize2 size={14} />
                            </button>
                          </div>
                        </div>
                        <div className="h-72">{renderCreditsChart()}</div>
                      </div>

                      {/* Fullscreen modal */}
                      {fullscreenChart && (
                        <div
                          className="fixed inset-0 z-50 bg-[#07080A]/95 backdrop-blur-md flex flex-col p-6"
                          onClick={() => setFullscreenChart(null)}
                        >
                          <div className="flex items-center justify-between mb-4" onClick={(e) => e.stopPropagation()}>
                            <h3 className="text-base font-semibold text-white">
                              {fullscreenChart === 'gen' ? 'Daily generations by type' : 'Credits burned per day'}
                            </h3>
                            <button
                              type="button"
                              onClick={() => setFullscreenChart(null)}
                              className="w-9 h-9 rounded-full border border-white/10 text-[#A7B0B7] hover:text-white hover:bg-white/5 flex items-center justify-center"
                              aria-label="Close fullscreen"
                            >
                              <X size={16} />
                            </button>
                          </div>
                          {fullscreenChart === 'gen' && (
                            <div className="flex flex-wrap gap-2 mb-3" onClick={(e) => e.stopPropagation()}>
                              {ACTIVITY_TYPES.map((t) => {
                                const meta = ACTIVITY_META[t];
                                const on = activeSeries.has(t);
                                const Icon = meta.icon;
                                return (
                                  <button
                                    key={t}
                                    type="button"
                                    onClick={() => toggleSeries(t)}
                                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-all ${on ? 'border-white/15 bg-white/[0.06] text-white' : 'border-white/5 bg-white/[0.02] text-gray-500 line-through'}`}
                                    style={on ? { boxShadow: `inset 0 0 0 1px ${meta.color}40` } : undefined}
                                  >
                                    <span className="w-2 h-2 rounded-full" style={{ background: meta.color }} />
                                    <Icon className="w-3 h-3" />
                                    {meta.label}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                          <div className="flex-1 min-h-0" onClick={(e) => e.stopPropagation()}>
                            {fullscreenChart === 'gen' ? renderGenChart() : renderCreditsChart()}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                <div className="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(52,211,153,0.06)_0%,rgba(10,10,10,0.98)_70%)] p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
                  <div className="flex flex-wrap items-end justify-between gap-2 mb-4">
                    <div>
                      <h3 className="text-sm font-semibold text-white">Daily purchase revenue (USD)</h3>
                      <p className="text-xs text-[#A7B0B7] mt-1">
                        Full history · paid / completed checkout amounts per day
                      </p>
                    </div>
                    <p className="text-lg font-bold text-emerald-400">
                      $
                      {overview.usage
                        .reduce((s, d) => s + d.revenue_usd, 0)
                        .toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}{' '}
                      <span className="text-xs font-normal text-gray-500">total in chart</span>
                    </p>
                  </div>
                  <div className="h-72">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={overview.usage} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="revenueBarFill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor="#34d399" stopOpacity={0.95} />
                              <stop offset="100%" stopColor="#10b981" stopOpacity={0.85} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} strokeDasharray="3 3" />
                          <XAxis dataKey="day" tick={{ fill: '#737373', fontSize: 10 }} />
                          <YAxis
                            tick={{ fill: '#737373', fontSize: 10 }}
                            tickFormatter={(v) => (typeof v === 'number' && v >= 0 ? `$${v}` : '')}
                          />
                          <Tooltip
                            cursor={false}
                            contentStyle={{
                              background: 'rgba(10,10,10,0.95)',
                              border: '1px solid rgba(255,255,255,0.12)',
                              borderRadius: 12,
                              color: '#fff',
                              boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                            }}
                            formatter={(value: number) => [`$${Number(value).toFixed(2)}`, 'Revenue']}
                            labelFormatter={(label) => label}
                          />
                        <Bar dataKey="revenue_usd" fill="url(#revenueBarFill)" radius={[6, 6, 0, 0]} name="USD" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="rounded-[24px] border border-white/10 bg-white/[0.03] p-6">
                  <h3 className="text-sm font-semibold text-white mb-4">Recent payments</h3>
                  <div className="grid gap-3 md:grid-cols-2">
                    {overview.recent_payments.length === 0 ? (
                      <p className="text-sm text-gray-500">No payments yet.</p>
                    ) : (
                      overview.recent_payments.map((p) => (
                        <div
                          key={p.id}
                          className="rounded-xl border border-white/5 bg-black/30 px-4 py-3 flex justify-between gap-3"
                        >
                          <div>
                            <p className="text-sm text-white capitalize">{p.provider}</p>
                            <p className="text-xs text-gray-500">
                              {p.plan_code ?? '—'} · {p.status}
                            </p>
                          </div>
                          <div className="text-right">
                            <p className="text-sm font-semibold text-[#DFFF00]">${p.amount_usd.toFixed(2)}</p>
                            <button
                              type="button"
                              onClick={() => focusUser(p.user_id)}
                              className="text-[10px] text-cyan-400 hover:underline mt-1"
                            >
                              View user
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            )}
            {!overview && !overviewErr && <p className="text-gray-500">Loading overview…</p>}
          </div>
        )}

        {tab !== 'overview' && (
          <div className="space-y-4">
            <div className="flex flex-col sm:flex-row gap-3 sm:items-center sm:justify-between">
              <div className="relative flex-1 max-w-xl">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
                <input
                  type="search"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder={
                    tab === 'users'
                      ? 'Search email, name, or user id…'
                      : 'Search email, name, model, text, ids…'
                  }
                  className="w-full rounded-xl border border-white/10 bg-white/5 py-2.5 pl-10 pr-4 text-sm text-white placeholder:text-gray-500 focus:border-[#DFFF00]/40 focus:outline-none"
                />
              </div>
              {filterUserId && (
                <p className="text-xs text-[#A7B0B7]">
                  Filtered to one user — tables below show only their rows.
                </p>
              )}
            </div>

            {listErr && <p className="text-sm text-red-400">{listErr}</p>}
            {loading && <p className="text-sm text-gray-500">Loading…</p>}

            {/* Pagination — only the paginated tabs */}
            {!loading && tab !== 'tts' && (
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[#A7B0B7]">
                <span>
                  {tab === 'credits' && credits && (
                    <>
                      {credits.total} transactions · page {page} / {totalPages(credits.total)}
                    </>
                  )}
                  {tab === 'payments' && payments && (
                    <>
                      {payments.total} payments · page {page} / {totalPages(payments.total)}
                    </>
                  )}
                  {tab === 'history' && history && (
                    <>
                      {history.total} history rows · page {page} / {totalPages(history.total)}
                    </>
                  )}
                  {tab === 'users' && users && (
                    <>
                      {users.total} users · page {page} / {totalPages(users.total)}
                    </>
                  )}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-white disabled:opacity-40 hover:bg-white/10"
                  >
                    <ChevronLeft size={16} /> Prev
                  </button>
                  <button
                    type="button"
                    disabled={
                      (tab === 'credits' && (!credits || page >= totalPages(credits.total))) ||
                      (tab === 'payments' && (!payments || page >= totalPages(payments.total))) ||
                      (tab === 'history' && (!history || page >= totalPages(history.total))) ||
                      (tab === 'users' && (!users || page >= totalPages(users.total)))
                    }
                    onClick={() => setPage((p) => p + 1)}
                    className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-white disabled:opacity-40 hover:bg-white/10"
                  >
                    Next <ChevronRight size={16} />
                  </button>
                </div>
              </div>
            )}

            {/* Tables */}
            <div className="rounded-2xl border border-white/10 overflow-hidden bg-[#0a0a0a]">
              {tab === 'tts' && (
                <div className="p-5 space-y-5">
                  {activityLoading && <p className="text-sm text-gray-500">Loading recent activity…</p>}
                  {!activityLoading && activity && (
                    <>
                      <div className="flex flex-wrap items-end justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-semibold text-white">
                            Recent {activity.items.length} generations{filterUserId ? ' (this user)' : ' (all users)'}
                          </h3>
                          <p className="text-xs text-[#A7B0B7] mt-0.5">Newest first · audio plays inline when still available</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          {ACTIVITY_TYPES.map((t) => {
                            const count = activity.items.filter((i) => i.type === t).length;
                            const meta = ACTIVITY_META[t];
                            const Icon = meta.icon;
                            return (
                              <span key={t} className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1 text-[11px]">
                                <Icon className="w-3.5 h-3.5" style={{ color: meta.color }} />
                                <span className="text-white">{meta.label}</span>
                                <span className="text-gray-500 font-mono">{count}</span>
                              </span>
                            );
                          })}
                        </div>
                      </div>

                      {activity.items.length === 0 ? (
                        <p className="py-8 text-center text-gray-500 text-sm">No activity yet.</p>
                      ) : (
                        <ul className="divide-y divide-white/[0.05] rounded-2xl border border-white/10 bg-[#0a0a0a]">
                          {activity.items.map((it) => {
                            const meta = ACTIVITY_META[it.type] || { label: it.type, color: '#888', icon: FileAudio };
                            const Icon = meta.icon;
                            const ts = it.created_at ? new Date(it.created_at) : null;
                            return (
                              <li key={`${it.type}-${it.id}`} className="px-4 py-3 hover:bg-white/[0.015] transition-colors">
                                <div className="flex items-start gap-3">
                                  <div className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: `${meta.color}1a`, color: meta.color }}>
                                    <Icon className="w-4 h-4" />
                                  </div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex flex-wrap items-center gap-2 mb-0.5">
                                      <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: meta.color }}>
                                        {meta.label}
                                      </span>
                                      <span className="text-[11px] text-gray-500">{ts ? ts.toLocaleString() : '—'}</span>
                                      {it.user_id && (
                                        <button
                                          type="button"
                                          onClick={() => focusUser(it.user_id!)}
                                          className="text-[11px] text-cyan-400 hover:underline truncate max-w-[200px]"
                                          title={it.user_id}
                                        >
                                          {it.user_email || it.user_name || it.user_id.slice(0, 14) + '…'}
                                        </button>
                                      )}
                                      {it.status && it.status !== 'completed' && (
                                        <span className="text-[10px] text-amber-400 uppercase">{it.status}</span>
                                      )}
                                      {it.credits_used > 0 && (
                                        <span className="text-[11px] text-[#DFFF00]/80 ml-auto font-mono">{it.credits_used} cr</span>
                                      )}
                                    </div>
                                    <p className="text-sm text-white whitespace-pre-wrap break-words" title={it.title}>
                                      {it.title || <span className="text-gray-600 italic">(no content)</span>}
                                    </p>
                                    {it.detail && (
                                      <p className="text-[11px] text-gray-500 mt-0.5 truncate" title={it.detail}>{it.detail}</p>
                                    )}
                                    {it.audio_url && (
                                      <audio
                                        controls
                                        preload="none"
                                        src={it.audio_url}
                                        className="mt-2 w-full max-w-md h-8"
                                        style={{ filter: 'invert(0.92) hue-rotate(180deg)' }}
                                      />
                                    )}
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </>
                  )}
                </div>
              )}

              {tab === 'credits' && credits && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-white/10 bg-white/[0.03]">
                        <th className="py-3 px-3 text-gray-500 font-semibold">When</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">User</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Type</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Δ</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Balance</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Description</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {credits.items.map((row) => (
                        <tr key={row.id} className="hover:bg-white/[0.02]">
                          <td className="py-2 px-3 text-gray-400 whitespace-nowrap">
                            {new Date(row.created_at).toLocaleString()}
                          </td>
                          <td className="py-2 px-3">
                            <button
                              type="button"
                              onClick={() => focusUser(row.user_id)}
                              className="text-cyan-400 hover:underline"
                            >
                              {row.user_email || '—'}
                            </button>
                          </td>
                          <td className="py-2 px-3 text-gray-300">{row.transaction_type}</td>
                          <td className={`py-2 px-3 ${row.amount >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                            {row.amount > 0 ? '+' : ''}
                            {row.amount}
                          </td>
                          <td className="py-2 px-3 text-white">{row.balance_after}</td>
                          <td className="py-2 px-3 text-gray-500 max-w-xs truncate" title={row.description}>
                            {row.description}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {tab === 'payments' && payments && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-white/10 bg-white/[0.03]">
                        <th className="py-3 px-3 text-gray-500 font-semibold">When</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">User</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Provider</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Plan</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">USD</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Credits</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {payments.items.map((row) => (
                        <tr key={row.id} className="hover:bg-white/[0.02]">
                          <td className="py-2 px-3 text-gray-400 whitespace-nowrap">
                            {new Date(row.created_at).toLocaleString()}
                          </td>
                          <td className="py-2 px-3">
                            <button
                              type="button"
                              onClick={() => focusUser(row.user_id)}
                              className="text-cyan-400 hover:underline"
                            >
                              {row.user_email || '—'}
                            </button>
                          </td>
                          <td className="py-2 px-3 capitalize">{row.provider}</td>
                          <td className="py-2 px-3">{row.plan_code ?? '—'}</td>
                          <td className="py-2 px-3 text-[#DFFF00]">${row.amount_usd.toFixed(2)}</td>
                          <td className="py-2 px-3">{row.credits_granted}</td>
                          <td className="py-2 px-3">{row.status}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {tab === 'history' && filterUserId && (
                <div className="p-5 space-y-6">
                  {recentLoading && <p className="text-sm text-gray-500">Loading recent activity…</p>}
                  {!recentLoading && recentActivity && (
                    <>
                      {/* Per-day breakdown chart for this user's recent activity */}
                      {recentActivity.by_day.length > 0 && (
                        <div className="rounded-2xl border border-white/10 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(10,10,10,0.95))] p-5">
                          <div className="flex items-center justify-between mb-3">
                            <div>
                              <h3 className="text-sm font-semibold text-white">Recent activity by day</h3>
                              <p className="text-xs text-[#A7B0B7] mt-0.5">From this user's most recent {recentActivity.items.length} generations</p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {ACTIVITY_TYPES.map((t) => (
                                <span key={t} className="inline-flex items-center gap-1.5 text-[11px] text-gray-400">
                                  <span className="w-2 h-2 rounded-full" style={{ background: ACTIVITY_META[t].color }} />
                                  {ACTIVITY_META[t].label}
                                </span>
                              ))}
                            </div>
                          </div>
                          <div className="h-56 overflow-x-auto overflow-y-hidden">
                            <div style={{ minWidth: Math.max(420, recentActivity.by_day.length * 36) }} className="h-full">
                              <ResponsiveContainer width="100%" height="100%">
                                <BarChart data={recentActivity.by_day} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                                  <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} strokeDasharray="3 3" />
                                  <XAxis dataKey="day" tick={{ fill: '#737373', fontSize: 10 }} />
                                  <YAxis tick={{ fill: '#737373', fontSize: 10 }} allowDecimals={false} />
                                  <Tooltip
                                    cursor={{ fill: 'rgba(255,255,255,0.03)' }}
                                    contentStyle={{ background: 'rgba(10,10,10,0.95)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 12, color: '#fff' }}
                                  />
                                  {ACTIVITY_TYPES.map((t) => (
                                    <Bar key={t} dataKey={t} stackId="g" fill={ACTIVITY_META[t].color} name={ACTIVITY_META[t].label} radius={[4, 4, 0, 0]} />
                                  ))}
                                </BarChart>
                              </ResponsiveContainer>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Type tally chips */}
                      <div className="flex flex-wrap gap-2">
                        {ACTIVITY_TYPES.map((t) => {
                          const count = recentActivity.items.filter((i) => i.type === t).length;
                          const meta = ACTIVITY_META[t];
                          const Icon = meta.icon;
                          return (
                            <div key={t} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs">
                              <Icon className="w-3.5 h-3.5" style={{ color: meta.color }} />
                              <span className="text-white">{meta.label}</span>
                              <span className="text-gray-400 font-mono">{count}</span>
                            </div>
                          );
                        })}
                      </div>

                      {/* Recent 100 detailed list */}
                      <div className="rounded-2xl border border-white/10 bg-[#0a0a0a]">
                        <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
                          <h3 className="text-sm font-semibold text-white">Recent {recentActivity.items.length} generations</h3>
                          <p className="text-[11px] text-gray-500">Newest first</p>
                        </div>
                        {recentActivity.items.length === 0 ? (
                          <p className="p-6 text-center text-gray-500 text-sm">This user hasn't generated anything yet.</p>
                        ) : (
                          <ul className="divide-y divide-white/[0.05]">
                            {recentActivity.items.map((it) => {
                              const meta = ACTIVITY_META[it.type as ActivityType] || { label: it.type, color: '#888', icon: FileAudio };
                              const Icon = meta.icon;
                              const ts = it.created_at ? new Date(it.created_at) : null;
                              return (
                                <li key={`${it.type}-${it.id}`} className="px-4 py-3 hover:bg-white/[0.02] transition-colors">
                                  <div className="flex items-start gap-3">
                                    <div className="shrink-0 w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: `${meta.color}1a`, color: meta.color }}>
                                      <Icon className="w-4 h-4" />
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2 mb-0.5">
                                        <span className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: meta.color }}>
                                          {meta.label}
                                        </span>
                                        <span className="text-[11px] text-gray-500">
                                          {ts ? ts.toLocaleString() : '—'}
                                        </span>
                                        {it.credits_used > 0 && (
                                          <span className="text-[11px] text-[#DFFF00]/80 ml-auto font-mono">{it.credits_used} cr</span>
                                        )}
                                      </div>
                                      <p className="text-sm text-white truncate" title={it.title}>
                                        {it.title || <span className="text-gray-600 italic">(no content)</span>}
                                      </p>
                                      {it.detail && (
                                        <p className="text-[11px] text-gray-500 truncate" title={it.detail}>{it.detail}</p>
                                      )}
                                    </div>
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {tab === 'history' && !filterUserId && history && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-white/10 bg-white/[0.03]">
                        <th className="py-3 px-3 text-gray-500 font-semibold">When</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">User</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Type</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Content</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Model</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {history.items.map((row) => (
                        <tr key={row.id} className="hover:bg-white/[0.02]">
                          <td className="py-2 px-3 text-gray-400 whitespace-nowrap">
                            {new Date(row.created_at).toLocaleString()}
                          </td>
                          <td className="py-2 px-3">
                            <button
                              type="button"
                              onClick={() => focusUser(row.user_id)}
                              className="text-cyan-400 hover:underline"
                            >
                              {row.user_email || '—'}
                            </button>
                          </td>
                          <td className="py-2 px-3">{row.type}</td>
                          <td className="py-2 px-3 text-gray-500 max-w-md truncate" title={row.content ?? ''}>
                            {row.content ?? '—'}
                          </td>
                          <td className="py-2 px-3 text-gray-500">{row.model ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {tab === 'users' && users && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-white/10 bg-white/[0.03]">
                        <th className="py-3 px-3 text-gray-500 font-semibold">Email</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Name</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Credits</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Plan</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Created</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {users.items.map((u) => (
                        <tr key={String(u.id)} className="hover:bg-white/[0.02]">
                          <td className="py-2 px-3 text-gray-300">{u.email}</td>
                          <td className="py-2 px-3 text-gray-400">{u.name || '—'}</td>
                          <td className="py-2 px-3 text-[#DFFF00]">{u.credits ?? '—'}</td>
                          <td className="py-2 px-3 capitalize text-gray-400">
                            {u.plan_code} / {u.plan_status}
                          </td>
                          <td className="py-2 px-3 text-gray-500">
                            {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                          </td>
                          <td className="py-2 px-3">
                            <button
                              type="button"
                              onClick={() => focusUser(String(u.id))}
                              className="text-cyan-400 hover:underline"
                            >
                              View usage
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

            </div>

            {!loading && tab === 'credits' && credits?.items.length === 0 && (
              <p className="p-4 text-center text-gray-500 text-sm">No credit transactions match.</p>
            )}
            {!loading && tab === 'payments' && payments?.items.length === 0 && (
              <p className="p-4 text-center text-gray-500 text-sm">No payments match.</p>
            )}
            {!loading && tab === 'history' && history?.items.length === 0 && (
              <p className="p-4 text-center text-gray-500 text-sm">No history rows match.</p>
            )}
            {!loading && tab === 'users' && users?.items.length === 0 && (
              <p className="p-4 text-center text-gray-500 text-sm">No users match.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
