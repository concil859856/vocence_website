import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { api, type AccountSummary, type CreditTransactionsPage, type DeveloperApiKey, type DailyCreditsUsage } from '../services/api';
import { API_BASE_URL } from '../services/baseUrl';
import { authFetch } from '../services/authFetch';
import {
  User,
  CreditCard,
  Settings,
  ArrowLeft,
  Mail,
  KeyRound,
  Copy,
  BarChart3,
  Gift,
  Users,
  Check,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Avatar, AvatarFallback, AvatarImage } from '../components/ui/avatar';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export function Account() {
  const { user, isLoading } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const checkoutStatus = searchParams.get('checkout');
  const params = useParams<{ tab?: string }>();

  type AccountTab = 'profile' | 'credits' | 'referral' | 'settings' | 'developer';
  const pathTab = (params.tab || '').toLowerCase();
  const queryTab = (searchParams.get('tab') || '').toLowerCase();
  const tabMap: Record<string, AccountTab> = {
    profile: 'profile',
    credits: 'credits',
    referral: 'referral',
    settings: 'settings',
    developer: 'developer',
    usage: 'credits',
    api: 'developer',
  };

  const activeTab: AccountTab = (pathTab && tabMap[pathTab]) || (queryTab && tabMap[queryTab]) || 'profile';
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [apiKeys, setApiKeys] = useState<DeveloperApiKey[]>([]);
  const [dailyCredits, setDailyCredits] = useState<DailyCreditsUsage | null>(null);
  const [dailyCreditsLoading, setDailyCreditsLoading] = useState(false);
  const [newKeyName, setNewKeyName] = useState('Default key');
  const [newPlainKey, setNewPlainKey] = useState<string | null>(null);
  const [developerMessage, setDeveloperMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !user) {
      navigate('/');
    }
  }, [isLoading, user, navigate]);

  useEffect(() => {
    // Normalize legacy URLs like /account?tab=developer into /account/developer.
    if (!params.tab) {
      if (queryTab && tabMap[queryTab] && tabMap[queryTab] !== 'profile') {
        navigate(`/account/${tabMap[queryTab]}`, { replace: true });
        return;
      }
      if (!queryTab || !tabMap[queryTab]) {
        navigate(`/account/profile`, { replace: true });
      }
      return;
    }

    if (!pathTab || !tabMap[pathTab]) {
      navigate(`/account/profile`, { replace: true });
      return;
    }
    // If the path tab resolves to a *different* canonical tab (e.g.
    // legacy /account/usage → /account/credits), rewrite the URL so
    // refresh + back/forward show the new canonical path.
    if (tabMap[pathTab] !== pathTab) {
      navigate(`/account/${tabMap[pathTab]}`, { replace: true });
    }
  }, [navigate, params.tab, pathTab, queryTab]);

  useEffect(() => {
    if (!user) return;
    const load = () =>
      api
        .getAccountSummary('')
        .then(setSummary)
        .catch(() => setSummary(null));
    void load();
    if (checkoutStatus === 'success') {
      const timeout = window.setTimeout(() => { void load(); }, 2000);
      return () => window.clearTimeout(timeout);
    }
  }, [user, checkoutStatus]);

  useEffect(() => {
    // Cookie-only auth: session travels via authFetch credentials:'include'.
    // Gate on the user being loaded, NOT a (now-null) localStorage JWT.
    if (!user) return;
    api.listDeveloperKeys('')
      .then((res) => setApiKeys(res.keys))
      .catch(() => setApiKeys([]));
  }, [user]);

  useEffect(() => {
    if (!user) return;
    setDailyCreditsLoading(true);
    api
      .getDailyCreditsUsage('', 14)
      .then((res) => setDailyCredits(res))
      .catch(() => setDailyCredits(null))
      .finally(() => setDailyCreditsLoading(false));
  }, [user, checkoutStatus]);

  const refreshDeveloperData = async () => {
    const keys = await api.listDeveloperKeys('');
    setApiKeys(keys.keys);
  };

  const onCreateApiKey = async () => {
    try {
      setDeveloperMessage(null);
      const res = await api.createDeveloperKey('', { name: newKeyName });
      setNewPlainKey(res.plainKey);
      setDeveloperMessage('API key created. Copy it now: it will not be shown again.');
      await refreshDeveloperData();
    } catch (error) {
      setDeveloperMessage(error instanceof Error ? error.message : 'Failed to create key');
    }
  };

  const onCopyPlainKey = async () => {
    if (!newPlainKey) return;
    try {
      await navigator.clipboard.writeText(newPlainKey);
      setDeveloperMessage('API key copied.');
    } catch {
      setDeveloperMessage('Could not copy automatically. Please copy it manually.');
    }
  };

  const onRevokeApiKey = async (keyId: string) => {
    try {
      setDeveloperMessage(null);
      await api.revokeDeveloperKey('', keyId);
      setDeveloperMessage('API key revoked.');
      await refreshDeveloperData();
    } catch (error) {
      setDeveloperMessage(error instanceof Error ? error.message : 'Failed to revoke key');
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-[#D1F840] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) return null;
  const accountUser = summary?.user ?? user;

  const getInitials = (name: string) => {
    return name
      .split(' ')
      .map((n) => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <div className="min-h-screen bg-[#07080A] pt-24 pb-12 px-6 lg:px-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate(-1)}
            className="p-2 hover:bg-white/10 rounded-lg transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-3xl font-semibold">My Account</h1>
            <p className="text-[#A7B0B7]">Manage your account settings and preferences</p>
          </div>
        </div>

        {/* Profile Card */}
        <div className="card-vocence p-6 mb-6">
          {checkoutStatus === 'success' ? (
            <div className="mb-4 rounded-xl border border-[#DFFF00]/20 bg-[#DFFF00]/10 px-4 py-3 text-sm text-[#E9F8A6]">
              Payment completed. Your credits and plan status are refreshing now.
            </div>
          ) : null}
          <div className="flex items-center gap-6">
            <Avatar className="w-20 h-20">
              <AvatarImage src={accountUser.picture} alt={accountUser.name} />
              <AvatarFallback className="bg-[#DFFF00] text-[#07080A] text-2xl font-semibold">
                {getInitials(accountUser.name)}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1">
              <h2 className="text-2xl font-semibold mb-1">{accountUser.name}</h2>
              <p className="text-[#A7B0B7] mb-4">{accountUser.email}</p>
              <div className="flex items-center gap-6">
                <div>
                  <p className="text-xs text-[#666] mb-1">Credits</p>
                  <p className="text-xl font-bold text-[#DFFF00]">{accountUser.credits}</p>
                </div>
                <div>
                  <p className="text-xs text-[#666] mb-1">Plan</p>
                  <p className="text-sm text-[#A7B0B7] capitalize">{accountUser.planCode ?? 'normal'}</p>
                </div>
                <div>
                  <p className="text-xs text-[#666] mb-1">Member Since</p>
                  <p className="text-sm text-[#A7B0B7]">
                    {new Date(accountUser.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={(v) => navigate(`/account/${v}`)}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-3 sm:grid-cols-5 bg-[#0D1117] border border-white/10">
            <TabsTrigger value="profile" className="data-[state=active]:bg-white/10">
              <User size={16} className="mr-2" />
              Profile
            </TabsTrigger>
            <TabsTrigger value="credits" className="data-[state=active]:bg-white/10">
              <CreditCard size={16} className="mr-2" />
              Credits
            </TabsTrigger>
            <TabsTrigger value="settings" className="data-[state=active]:bg-white/10">
              <Settings size={16} className="mr-2" />
              Settings
            </TabsTrigger>
            <TabsTrigger value="referral" className="data-[state=active]:bg-white/10">
              <Gift size={16} className="mr-1.5" />
              Referral
            </TabsTrigger>
            <TabsTrigger value="developer" className="data-[state=active]:bg-white/10">
              <KeyRound size={16} className="mr-2" />
              Developer
            </TabsTrigger>
          </TabsList>

          {/* Profile Tab */}
          <TabsContent value="profile" className="mt-6">
            <div className="card-vocence p-6 space-y-6">
              <div>
                <h3 className="text-xl font-semibold mb-4">Profile Information</h3>
                <div className="space-y-4">
                  <div>
                    <label className="label-mono mb-2 block">Name</label>
                    <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4 flex items-center gap-3">
                      <User size={18} className="text-[#666]" />
                      <span className="text-white">{accountUser.name}</span>
                    </div>
                  </div>
                  <div>
                    <label className="label-mono mb-2 block">Email</label>
                    <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4 flex items-center gap-3">
                      <Mail size={18} className="text-[#666]" />
                      <span className="text-white">{accountUser.email}</span>
                    </div>
                    <p className="text-xs text-[#666] mt-2">
                      Email is managed through your Google account
                    </p>
                  </div>
                  <div>
                    <label className="label-mono mb-2 block">Profile Picture</label>
                    <div className="flex items-center gap-4">
                      <Avatar className="w-16 h-16">
                        <AvatarImage src={accountUser.picture} alt={accountUser.name} />
                        <AvatarFallback className="bg-[#DFFF00] text-[#07080A]">
                          {getInitials(accountUser.name)}
                        </AvatarFallback>
                      </Avatar>
                      <p className="text-sm text-[#A7B0B7]">
                        Profile picture is managed through your Google account
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* Credits Tab, simplified per product feedback: lead with
              the balance + the daily-credits graph; tuck the detailed
              transaction table behind a "View detailed usage" toggle
              so the resting page isn't a wall of numbers. */}
          <TabsContent value="credits" className="mt-6">
            <CreditsTabContent
              credits={accountUser.credits}
              dailyCredits={dailyCredits}
              dailyCreditsLoading={dailyCreditsLoading}
            />
          </TabsContent>

          {/* Settings Tab */}
          <TabsContent value="settings" className="mt-6">
            <div className="card-vocence p-6 space-y-6">
              <div>
                <h3 className="text-xl font-semibold mb-4">Account Settings</h3>
                <div className="space-y-4">
                  <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4">
                    <h4 className="font-medium mb-2">Notifications</h4>
                    <p className="text-sm text-[#A7B0B7] mb-4">
                      Manage how you receive notifications
                    </p>
                    <div className="space-y-3">
                      <label className="flex items-center justify-between cursor-pointer">
                        <span className="text-sm">Email notifications</span>
                        <input type="checkbox" className="w-4 h-4 rounded" defaultChecked />
                      </label>
                      <label className="flex items-center justify-between cursor-pointer">
                        <span className="text-sm">Credit balance alerts</span>
                        <input type="checkbox" className="w-4 h-4 rounded" defaultChecked />
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </TabsContent>

          {/* Referral Tab */}
          <TabsContent value="referral" className="mt-6">
            <ReferralTab />
          </TabsContent>

          <TabsContent value="developer" className="mt-6">
            <div className="card-vocence p-6 space-y-6">
              <div>
                <h3 className="text-xl font-semibold mb-2">Developer API</h3>
                <p className="text-sm text-[#A7B0B7]">
                  TTS pricing: $10 per 1M chars (4,000 credits / 1M), prepaid pay-as-you-go. See the Pricing page for STT / cloning / voice agents / music rates.
                </p>
              </div>

              {developerMessage ? (
                <div className="rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-[#C6CDD4]">{developerMessage}</div>
              ) : null}
              {newPlainKey ? (
                <div className="rounded-xl border border-[#DFFF00]/30 bg-[#DFFF00]/10 p-3 text-sm text-[#F3FFD0]">
                  <div className="flex items-center justify-between gap-3">
                    <p className="break-all">{newPlainKey}</p>
                    <button type="button" onClick={onCopyPlainKey} className="inline-flex items-center gap-1 rounded-lg border border-[#DFFF00]/40 px-2 py-1 text-xs text-[#F3FFD0] hover:bg-[#DFFF00]/10">
                      <Copy size={12} />
                      Copy
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="grid gap-3 md:grid-cols-3">
                <input
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  className="md:col-span-2 rounded-xl border border-white/10 bg-[#0a0a0a] px-3 py-2 text-sm text-white"
                  placeholder="Key name"
                />
                <button onClick={onCreateApiKey} className="btn-primary justify-center">
                  Create API key
                </button>
              </div>

              <div className="space-y-2">
                <h4 className="font-medium">Your API Keys</h4>
                <p className="text-xs text-[#7D8A95]">
                  Rate limits are <span className="text-white">per account</span>, every key
                  draws from the same bucket. Creating more keys does not raise your effective
                  request budget.
                </p>
                {apiKeys.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-[#0a0a0a] p-3 text-sm text-[#A7B0B7]">No API keys yet.</div>
                ) : apiKeys.map((k) => (
                  <div key={k.id} className="rounded-xl border border-white/10 bg-[#0a0a0a] p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm text-white">{k.name} <span className="text-[#7D8A95]">({k.tier})</span></p>
                      <p className="text-xs text-[#A7B0B7]">{k.keyPrefix}... · {k.rateLimitRpm} req/min (account-wide)</p>
                    </div>
                    {!k.revokedAt ? (
                      <button onClick={() => onRevokeApiKey(k.id)} className="rounded-lg border border-red-400/30 px-3 py-1 text-xs text-red-300 hover:bg-red-500/10">
                        Revoke
                      </button>
                    ) : (
                      <span className="text-xs text-[#7D8A95]">Revoked</span>
                    )}
                  </div>
                ))}
              </div>

              <div className="rounded-xl border border-white/10 bg-[#0a0a0a] p-4">
                <h4 className="font-medium">Credits usage</h4>
                <p className="text-sm text-[#A7B0B7] mt-1">
                  Daily credits consumed is shown in the <span className="text-white">Credits</span> tab.
                </p>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}


/* ==========================================================================
   CreditsTabContent, simplified Credits tab body.
   ==========================================================================

   The previous layout dumped balance + how-credits-work + summary stats +
   recent transactions all at once. The new layout is:

     1. Balance card with an "Add Credits" CTA
     2. Daily credit-consumption graph (was a separate Usage tab)
     3. A single "View detailed usage" button that expands an
        inline paginated transaction table

   Pagination is server-side via /account/transactions?offset&limit
   so we can stream through thousands of rows without breaking.
*/

const TRANSACTIONS_PAGE_SIZE = 25;

interface CreditsTabContentProps {
  credits: number;
  dailyCredits: DailyCreditsUsage | null;
  dailyCreditsLoading: boolean;
}

function CreditsTabContent({ credits, dailyCredits, dailyCreditsLoading }: CreditsTabContentProps) {
  const [showDetails, setShowDetails] = useState(false);
  const [page, setPage] = useState(0);
  const [txPage, setTxPage] = useState<CreditTransactionsPage | null>(null);
  const [txLoading, setTxLoading] = useState(false);

  // Lazy-fetch: don't pull transactions until the user opens the
  // detail panel. Each page-change re-fetches; previous pages aren't
  // cached because the dataset can grow between visits and stale
  // state would mislead more than it'd help.
  useEffect(() => {
    if (!showDetails) return;
    setTxLoading(true);
    api
      .getCreditTransactions('', {
        offset: page * TRANSACTIONS_PAGE_SIZE,
        limit: TRANSACTIONS_PAGE_SIZE,
      })
      .then(setTxPage)
      .catch(() => setTxPage(null))
      .finally(() => setTxLoading(false));
  }, [showDetails, page]);

  const totalPages = txPage ? Math.max(1, Math.ceil(txPage.total / TRANSACTIONS_PAGE_SIZE)) : 1;
  const todayIso = new Date().toISOString().slice(0, 10);
  const todayCredits = dailyCredits?.days.find((d) => d.day === todayIso)?.creditsUsed ?? 0;
  const hasGraphData = dailyCredits && dailyCredits.days.length > 0;

  return (
    <div className="card-vocence p-6 space-y-6">
      {/* Balance card, compact, single action. The detailed price
          breakdown moved to /pricing where it's actually relevant. */}
      <div className="bg-gradient-to-br from-[#DFFF00]/15 to-[#2E7D32]/10 border border-[#DFFF00]/30 rounded-2xl p-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-wider text-[#A7B0B7] mb-1">Available credits</p>
          <p className="text-4xl font-bold text-[#DFFF00]">{credits.toLocaleString()}</p>
        </div>
        <Link to="/pricing" className="btn-primary self-start sm:self-auto">
          <CreditCard size={16} className="mr-2" />
          Add credits
        </Link>
      </div>

      {/* Daily consumption graph, at-a-glance burn rate. */}
      <div>
        <div className="flex items-end justify-between gap-4 mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Credits consumed</h3>
            <p className="text-xs text-[#666]">Daily burn across Studio, Voice Chat, and Developer API.</p>
          </div>
          {hasGraphData && (
            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wider text-[#666]">Today</p>
              <p className="text-sm font-semibold text-white tabular-nums">{todayCredits.toLocaleString()}</p>
            </div>
          )}
        </div>
        {dailyCreditsLoading ? (
          <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4 text-sm text-[#A7B0B7]">
            Loading…
          </div>
        ) : hasGraphData ? (
          <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4">
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={dailyCredits!.days} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="creditsFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#D1F840" stopOpacity={0.35} />
                      <stop offset="95%" stopColor="#D1F840" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgba(255,255,255,0.05)" />
                  <XAxis
                    dataKey="day"
                    tickFormatter={(v) => String(v).slice(5)}
                    stroke="rgba(255,255,255,0.45)"
                    fontSize={12}
                  />
                  <YAxis stroke="rgba(255,255,255,0.45)" fontSize={12} />
                  <Tooltip
                    contentStyle={{
                      background: '#0a0a0a',
                      border: '1px solid rgba(255,255,255,0.1)',
                      borderRadius: 10,
                    }}
                    labelFormatter={(label) => `Day ${label}`}
                    formatter={(value: number | string) => [`${value} credits`, 'credits burned']}
                  />
                  <Area
                    type="monotone"
                    dataKey="creditsUsed"
                    stroke="#D1F840"
                    fill="url(#creditsFill)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        ) : (
          <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4 text-sm text-[#A7B0B7]">
            No consumption data yet. Generate something in Studio and refresh.
          </div>
        )}
      </div>

      {/* Detailed transactions, collapsed by default. Once expanded
          the panel loads page 0 and reveals pagination controls. */}
      <div>
        <button
          type="button"
          onClick={() => setShowDetails((s) => !s)}
          className="w-full flex items-center justify-between gap-2 px-4 py-3 rounded-xl border border-white/10 bg-[#0a0a0a] text-sm text-white hover:border-white/20 transition-colors"
          aria-expanded={showDetails}
        >
          <span className="flex items-center gap-2">
            <BarChart3 size={14} className="text-[#A7B0B7]" />
            {showDetails ? 'Hide detailed usage' : 'View detailed usage'}
          </span>
          <span className="text-xs text-[#666]">{showDetails ? '−' : '+'}</span>
        </button>

        {showDetails && (
          <div className="mt-3 rounded-xl border border-white/10 overflow-hidden">
            {/* Header row */}
            <div className="hidden md:grid grid-cols-[1fr_minmax(0,2fr)_minmax(0,6rem)_minmax(0,6rem)_minmax(0,6rem)] gap-3 px-4 py-2 border-b border-white/10 bg-white/[0.02] text-[10px] uppercase tracking-wider text-[#555]">
              <div>Date</div>
              <div>Description</div>
              <div>Type</div>
              <div className="text-right">Amount</div>
              <div className="text-right">Balance</div>
            </div>

            {txLoading ? (
              <div className="px-4 py-6 text-sm text-[#A7B0B7]">Loading transactions…</div>
            ) : !txPage || txPage.items.length === 0 ? (
              <div className="px-4 py-6 text-sm text-[#A7B0B7]">No transactions yet.</div>
            ) : (
              <div>
                {txPage.items.map((tx) => (
                  <div
                    key={tx.id}
                    className="grid grid-cols-[1fr_minmax(0,6rem)] md:grid-cols-[1fr_minmax(0,2fr)_minmax(0,6rem)_minmax(0,6rem)_minmax(0,6rem)] items-center gap-3 px-4 py-2.5 border-b border-white/[0.04] last:border-b-0"
                  >
                    <span className="text-xs text-[#9ca3af] tabular-nums">
                      {new Date(tx.createdAt).toLocaleString(undefined, {
                        year: 'numeric', month: 'short', day: '2-digit',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                    <span className="hidden md:block text-sm text-white truncate" title={tx.description}>
                      {tx.description || '—'}
                    </span>
                    <span className="hidden md:block text-xs text-[#888] truncate" title={tx.transactionType}>
                      {tx.transactionType}
                    </span>
                    <span
                      className={`text-sm font-mono tabular-nums text-right ${
                        tx.amount >= 0 ? 'text-green-400' : 'text-red-400'
                      }`}
                    >
                      {tx.amount >= 0 ? '+' : ''}{tx.amount}
                    </span>
                    <span className="hidden md:block text-xs text-[#888] tabular-nums text-right">
                      {tx.balanceAfter.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Pagination, Prev / Page X of N / Next. Disabled state
                handles the edge pages without hiding the controls so
                the layout doesn't shift mid-flip. */}
            {txPage && txPage.total > 0 && (
              <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-white/10 bg-white/[0.02] text-xs">
                <span className="text-[#666] tabular-nums">
                  {txPage.offset + 1}–{Math.min(txPage.offset + txPage.items.length, txPage.total)} of {txPage.total}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                    disabled={page === 0 || txLoading}
                    className="px-3 py-1 rounded-md border border-white/10 text-[#A7B0B7] hover:text-white hover:border-white/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Prev
                  </button>
                  <span className="text-[#A7B0B7] tabular-nums">
                    Page {page + 1} of {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page + 1 >= totalPages || txLoading}
                    className="px-3 py-1 rounded-md border border-white/10 text-[#A7B0B7] hover:text-white hover:border-white/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}


function ReferralTab() {
  const [stats, setStats] = useState<{
    referral_code: string;
    total_invites: number;
    activated_invites: number;
    credits_earned: number;
    milestone_target: number;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Cookie-only auth: session cookie carries identity via credentials:'include'.
    authFetch(`${API_BASE_URL}/auth/referral`)
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="card-vocence p-6 text-center text-[#A7B0B7]">Loading...</div>
    );
  }

  if (!stats?.referral_code) {
    return (
      <div className="card-vocence p-6 text-center text-[#A7B0B7]">
        Referral code not available. Try logging in again.
      </div>
    );
  }

  const referralLink = `${window.location.origin}/?ref=${stats.referral_code}`;
  const milestoneProgress = Math.min(stats.activated_invites, stats.milestone_target);

  const copyLink = () => {
    navigator.clipboard.writeText(referralLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-6">
      {/* Referral Link */}
      <div className="card-vocence p-6">
        <h3 className="text-xl font-semibold mb-2 flex items-center gap-2">
          <Gift size={20} className="text-[#DFFF00]" />
          Invite Friends, Earn Credits
        </h3>
        <p className="text-sm text-[#A7B0B7] mb-4">
          Share your referral link. When they sign up and use any feature, you get <strong className="text-white">200 credits</strong>.
          Plus <strong className="text-white">10%</strong> of every purchase they make.
        </p>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={referralLink}
            className="flex-1 input font-mono text-xs bg-[#0a0a0a] border border-white/10 rounded-lg px-3 py-2.5 text-[#A7B0B7]"
            onClick={(e) => (e.target as HTMLInputElement).select()}
          />
          <button
            onClick={copyLink}
            className="btn-primary h-10 px-4 flex items-center gap-1.5 text-sm"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="card-vocence p-5 text-center">
          <Users size={20} className="mx-auto mb-2 text-[#A7B0B7]" />
          <div className="text-2xl font-bold text-white">{stats.total_invites}</div>
          <div className="text-xs text-[#A7B0B7] mt-1">Total Invites</div>
        </div>
        <div className="card-vocence p-5 text-center">
          <Check size={20} className="mx-auto mb-2 text-[#DFFF00]" />
          <div className="text-2xl font-bold text-white">{stats.activated_invites}</div>
          <div className="text-xs text-[#A7B0B7] mt-1">Activated</div>
        </div>
        <div className="card-vocence p-5 text-center">
          <CreditCard size={20} className="mx-auto mb-2 text-[#A7B0B7]" />
          <div className="text-2xl font-bold text-[#DFFF00]">{stats.credits_earned.toLocaleString()}</div>
          <div className="text-xs text-[#A7B0B7] mt-1">Credits Earned</div>
        </div>
      </div>

      {/* Milestone Progress */}
      <div className="card-vocence p-6">
        <h4 className="text-sm font-semibold mb-3 text-[#A7B0B7] uppercase tracking-wider">
          Milestone: Premium Plan
        </h4>
        <p className="text-sm text-[#A7B0B7] mb-3">
          Get <strong className="text-white">{stats.milestone_target} activated invites</strong> to unlock{' '}
          <strong className="text-[#DFFF00]">Premium</strong> + <strong className="text-white">1,000 bonus credits</strong>.
        </p>
        <div className="w-full bg-white/5 rounded-full h-3 mb-2">
          <div
            className="bg-[#DFFF00] h-3 rounded-full transition-all"
            style={{ width: `${(milestoneProgress / stats.milestone_target) * 100}%` }}
          />
        </div>
        <div className="text-xs text-[#A7B0B7] text-right">
          {milestoneProgress} / {stats.milestone_target}
        </div>
      </div>

      {/* How it works */}
      <div className="card-vocence p-6">
        <h4 className="text-sm font-semibold mb-3 text-[#A7B0B7] uppercase tracking-wider">How it works</h4>
        <ol className="space-y-2 text-sm text-[#A7B0B7]">
          <li className="flex items-start gap-2">
            <span className="text-[#DFFF00] font-bold shrink-0">1.</span>
            Share your referral link with friends
          </li>
          <li className="flex items-start gap-2">
            <span className="text-[#DFFF00] font-bold shrink-0">2.</span>
            They sign up and try any feature (TTS, clone, music, STT)
          </li>
          <li className="flex items-start gap-2">
            <span className="text-[#DFFF00] font-bold shrink-0">3.</span>
            You get <strong className="text-white">200 credits</strong> instantly
          </li>
          <li className="flex items-start gap-2">
            <span className="text-[#DFFF00] font-bold shrink-0">4.</span>
            Earn <strong className="text-white">10%</strong> of every purchase they make, forever
          </li>
        </ol>
      </div>
    </div>
  );
}
