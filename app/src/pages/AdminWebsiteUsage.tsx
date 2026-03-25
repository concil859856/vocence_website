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
import { ArrowLeft, Search, User, X, ChevronLeft, ChevronRight, Sparkles } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { ADMIN_EMAIL } from '../config';
import {
  dashboardApi,
  type AdminAuthHistoryRow,
  type AdminCreditTransactionRow,
  type AdminPaymentRow,
  type AdminTtsHistoryRow,
  type AdminUserActivitySummary,
  type RegisteredUser,
  type WebsiteOverview,
} from '../services/dashboardApi';

const ACCENT = '#D1F840';
const PAGE_SIZE = 25;
const CHART_BAR_WIDTH = 28;
const CHART_MIN_WIDTH = 520;

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

  const [tts, setTts] = useState<{ items: AdminTtsHistoryRow[]; total: number } | null>(null);
  const [credits, setCredits] = useState<{ items: AdminCreditTransactionRow[]; total: number } | null>(null);
  const [payments, setPayments] = useState<{ items: AdminPaymentRow[]; total: number } | null>(null);
  const [history, setHistory] = useState<{ items: AdminAuthHistoryRow[]; total: number } | null>(null);
  const [users, setUsers] = useState<{ items: RegisteredUser[]; total: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);

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

  const fetchTabData = useCallback(async () => {
    if (!isAdmin || !adminEmail) return;
    if (tab === 'overview') return;
    setLoading(true);
    setListErr(null);
    try {
      const opts = { page, page_size: PAGE_SIZE, q: debouncedQ, user_id: filterUserId };
      if (tab === 'tts') {
        const r = await dashboardApi.getAdminWebsiteUsageTts(adminEmail, opts);
        setTts({ items: r.items, total: r.total });
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
    { id: 'tts', label: 'TTS activity' },
    { id: 'credits', label: 'Credits' },
    { id: 'payments', label: 'Payments' },
    { id: 'history', label: 'User history' },
    { id: 'users', label: 'All users' },
  ];

  return (
    <div className="min-h-screen bg-[#07080A] pt-24 pb-20 px-4 lg:px-8">
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

                <div className="grid gap-6 lg:grid-cols-2">
                  <div className="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(223,255,0,0.06)_0%,rgba(10,10,10,0.98)_70%)] p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                      <div>
                        <h3 className="text-sm font-semibold text-white">Daily TTS generations</h3>
                        <p className="text-xs text-[#A7B0B7] mt-1">Full history</p>
                      </div>
                      <p className="text-lg font-bold text-[#DFFF00]/90">
                        {overview.usage.reduce((s, d) => s + d.tts_generation_count, 0).toLocaleString()}{' '}
                        <span className="text-xs font-normal text-gray-500">total in chart</span>
                      </p>
                    </div>
                    <div className="h-72 overflow-x-auto overflow-y-hidden">
                      <div style={{ minWidth: Math.max(CHART_MIN_WIDTH, overview.usage.length * CHART_BAR_WIDTH) }} className="h-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <AreaChart data={overview.usage} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                            <defs>
                              <linearGradient id="wuFill" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="5%" stopColor={ACCENT} stopOpacity={0.5} />
                                <stop offset="95%" stopColor={ACCENT} stopOpacity={0} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} strokeDasharray="3 3" />
                            <XAxis dataKey="day" tick={{ fill: '#737373', fontSize: 10 }} />
                            <YAxis
                              tick={{ fill: '#737373', fontSize: 10 }}
                              tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))}
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
                              formatter={(value: number) => [Number(value).toLocaleString(), 'Generations']}
                              labelFormatter={(label) => label}
                            />
                            <Area
                              type="monotone"
                              dataKey="tts_generation_count"
                              stroke={ACCENT}
                              fill="url(#wuFill)"
                              strokeWidth={2}
                            />
                          </AreaChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </div>
                  <div className="rounded-[24px] border border-white/10 bg-[linear-gradient(180deg,rgba(56,189,248,0.06)_0%,rgba(10,10,10,0.98)_70%)] p-6 shadow-[0_0_0_1px_rgba(255,255,255,0.04)]">
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
                      <div>
                        <h3 className="text-sm font-semibold text-white">Credits burned per day</h3>
                        <p className="text-xs text-[#A7B0B7] mt-1">
                          Full history · daily credits burned (Studio + Voice Chat + Developer API)
                        </p>
                      </div>
                      <p className="text-lg font-bold text-sky-400">
                        {overview.usage.reduce((s, d) => s + d.credits_used, 0).toLocaleString()}{' '}
                        <span className="text-xs font-normal text-gray-500">total in chart</span>
                      </p>
                    </div>
                    <div className="h-72 overflow-x-auto overflow-y-hidden">
                      <div style={{ minWidth: Math.max(CHART_MIN_WIDTH, overview.usage.length * CHART_BAR_WIDTH) }} className="h-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={overview.usage} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                            <defs>
                              <linearGradient id="creditsBarFill" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.95} />
                                <stop offset="100%" stopColor="#0ea5e9" stopOpacity={0.85} />
                              </linearGradient>
                            </defs>
                            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} strokeDasharray="3 3" />
                            <XAxis dataKey="day" tick={{ fill: '#737373', fontSize: 10 }} />
                            <YAxis
                              tick={{ fill: '#737373', fontSize: 10 }}
                              tickFormatter={(v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v))}
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
                              formatter={(value: number) => [`${Number(value).toLocaleString()} credits`, 'Used']}
                              labelFormatter={(label) => label}
                            />
                            <Bar dataKey="credits_used" fill="url(#creditsBarFill)" radius={[6, 6, 0, 0]} name="Credits" />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </div>
                  </div>
                </div>

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
                  <div className="h-72 overflow-x-auto overflow-y-hidden">
                    <div style={{ minWidth: Math.max(CHART_MIN_WIDTH, overview.usage.length * CHART_BAR_WIDTH) }} className="h-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <BarChart data={overview.usage} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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

            {/* Pagination */}
            {!loading && (
              <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-[#A7B0B7]">
                <span>
                  {tab === 'tts' && tts && (
                    <>
                      {tts.total} TTS events · page {page} / {totalPages(tts.total)}
                    </>
                  )}
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
                      (tab === 'tts' && (!tts || page >= totalPages(tts.total))) ||
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
              {tab === 'tts' && tts && (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-white/10 bg-white/[0.03]">
                        <th className="py-3 px-3 text-gray-500 font-semibold">When</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">User</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Model</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Prompt</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Cr</th>
                        <th className="py-3 px-3 text-gray-500 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {tts.items.map((row) => (
                        <tr key={row.id} className="hover:bg-white/[0.02]">
                          <td className="py-2 px-3 text-gray-400 whitespace-nowrap">
                            {new Date(row.created_at).toLocaleString()}
                          </td>
                          <td className="py-2 px-3">
                            <button
                              type="button"
                              onClick={() => focusUser(row.user_id)}
                              className="text-left text-cyan-400 hover:underline"
                            >
                              {row.user_email || row.user_id.slice(0, 12) + '…'}
                            </button>
                            <div className="text-[10px] text-gray-600 font-mono truncate max-w-[140px]">
                              {row.user_id}
                            </div>
                          </td>
                          <td className="py-2 px-3 text-gray-300 max-w-[120px] truncate">{row.model_name}</td>
                          <td className="py-2 px-3 text-gray-400 max-w-md truncate" title={row.prompt_text}>
                            {row.prompt_text}
                          </td>
                          <td className="py-2 px-3 text-[#DFFF00]">{row.credits_used}</td>
                          <td className="py-2 px-3">
                            <span
                              className={
                                row.status === 'completed' ? 'text-emerald-400' : 'text-amber-400'
                              }
                            >
                              {row.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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

              {tab === 'history' && history && (
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

            {!loading && tab === 'tts' && tts?.items.length === 0 && (
              <p className="p-4 text-center text-gray-500 text-sm">No TTS rows match your filters.</p>
            )}
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
