import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams, useParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { api, type AccountSummary, type CreditTransaction, type DeveloperApiKey, type DailyCreditsUsage } from '../services/api';
import {
  User,
  CreditCard,
  Settings,
  ArrowLeft,
  Mail,
  KeyRound,
  Copy,
  BarChart3,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Avatar, AvatarFallback, AvatarImage } from '../components/ui/avatar';
import { formatCreditsCompact } from '../utils/formatCredits';
import {
  CREDIT_MY_VOICE_GENERATE,
  CREDIT_SIGNUP_BONUS,
  CREDIT_STT,
  CREDIT_TTS,
  CREDIT_VOICE_CLONE,
  CREDIT_VOICE_DESIGN_PREVIEW,
} from '../studio/creditCosts';
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

  type AccountTab = 'profile' | 'credits' | 'settings' | 'developer' | 'usage';
  const pathTab = (params.tab || '').toLowerCase();
  const queryTab = (searchParams.get('tab') || '').toLowerCase();
  const tabMap: Record<string, AccountTab> = {
    profile: 'profile',
    credits: 'credits',
    settings: 'settings',
    developer: 'developer',
    usage: 'usage',
    // Back-compat alias
    api: 'developer',
  };

  const activeTab: AccountTab = (pathTab && tabMap[pathTab]) || (queryTab && tabMap[queryTab]) || 'profile';
  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
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
    }
  }, [navigate, params.tab, pathTab, queryTab]);

  useEffect(() => {
    const token = localStorage.getItem('vocence_token');
    if (!user || !token) return;
    setSummaryLoading(true);
    const load = () =>
      api
        .getAccountSummary(token)
        .then(setSummary)
        .catch(() => setSummary(null))
        .finally(() => setSummaryLoading(false));
    load();
    if (checkoutStatus === 'success') {
      const timeout = window.setTimeout(() => {
        load();
      }, 2000);
      return () => window.clearTimeout(timeout);
    }
  }, [user, checkoutStatus]);

  useEffect(() => {
    const token = localStorage.getItem('vocence_token');
    if (!user || !token) return;
    api.listDeveloperKeys(token)
      .then((res) => setApiKeys(res.keys))
      .catch(() => setApiKeys([]));
  }, [user]);

  useEffect(() => {
    const token = localStorage.getItem('vocence_token');
    if (!user || !token) return;
    setDailyCreditsLoading(true);
    api
      .getDailyCreditsUsage(token, 14)
      .then((res) => setDailyCredits(res))
      .catch(() => setDailyCredits(null))
      .finally(() => setDailyCreditsLoading(false));
  }, [user, checkoutStatus]);

  const refreshDeveloperData = async () => {
    const token = localStorage.getItem('vocence_token');
    if (!token) return;
    const keys = await api.listDeveloperKeys(token);
    setApiKeys(keys.keys);
  };

  const onCreateApiKey = async () => {
    const token = localStorage.getItem('vocence_token');
    if (!token) return;
    try {
      setDeveloperMessage(null);
      const res = await api.createDeveloperKey(token, { name: newKeyName });
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
    const token = localStorage.getItem('vocence_token');
    if (!token) return;
    try {
      setDeveloperMessage(null);
      await api.revokeDeveloperKey(token, keyId);
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
  const transactions: CreditTransaction[] = summary?.transactions ?? [];

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
          <TabsList className="grid w-full grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 bg-[#0D1117] border border-white/10">
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
            <TabsTrigger value="usage" className="data-[state=active]:bg-white/10">
              <BarChart3 size={16} className="mr-2" />
              Usage
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

          {/* Credits Tab */}
          <TabsContent value="credits" className="mt-6">
            <div className="card-vocence p-6 space-y-6">
              <div>
                <h3 className="text-xl font-semibold mb-4">Credit Balance</h3>
                <div className="bg-gradient-to-br from-[#DFFF00]/20 to-[#2E7D32]/20 border border-[#DFFF00]/30 rounded-2xl p-8 text-center mb-6">
                  <div className="text-5xl font-bold text-[#DFFF00] mb-2">
                    {accountUser.credits}
                  </div>
                  <p className="text-[#A7B0B7]">Available Credits</p>
                </div>

                <div className="space-y-4">
                  <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4">
                    <h4 className="font-medium mb-2">How Credits Work</h4>
                    <p className="text-sm text-[#A7B0B7] mb-3">
                      Top-ups are not one single price: <span className="text-[#C6CDD4]">card (Stripe)</span> and{' '}
                      <span className="text-[#C6CDD4]">crypto (NOWPayments)</span> sell different pack sizes. You get the
                      credits for whichever checkout you complete.
                    </p>
                    <ul className="text-sm text-[#A7B0B7] space-y-1 list-disc list-inside">
                      <li>
                        Studio — TTS: {CREDIT_TTS} cr · STT: {CREDIT_STT} cr · Voice clone: {CREDIT_VOICE_CLONE} cr ·
                        Voice design (preview): {CREDIT_VOICE_DESIGN_PREVIEW} cr · Generate with My voice:{' '}
                        {CREDIT_MY_VOICE_GENERATE} cr
                      </li>
                      <li>Every new account starts with {CREDIT_SIGNUP_BONUS} free credits</li>
                      <li>
                        Normal — card: $12 → {formatCreditsCompact(4000)} credits · crypto: $20 →{' '}
                        {formatCreditsCompact(7000)} credits
                      </li>
                      <li>
                        Premium — card: $24 → {formatCreditsCompact(10000)} credits · crypto: $40 →{' '}
                        {formatCreditsCompact(16000)} credits (unlocks Developer API)
                      </li>
                    </ul>
                  </div>
                  {summary ? (
                    <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4 grid gap-4 md:grid-cols-2">
                      <div>
                        <p className="text-xs text-[#666] mb-1">Current plan</p>
                        <p className="text-sm text-white capitalize">{summary.user.planCode ?? 'normal'}</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#666] mb-1">Total TTS generations</p>
                        <p className="text-sm text-white">{summary.totalTtsGenerations}</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#666] mb-1">Total credits used</p>
                        <p className="text-sm text-white">{summary.totalCreditsUsed}</p>
                      </div>
                      <div>
                        <p className="text-xs text-[#666] mb-1">Plan status</p>
                        <p className="text-sm text-white capitalize">{summary.user.planStatus ?? 'active'}</p>
                      </div>
                    </div>
                  ) : null}

                  <Link to="/pricing" className="btn-primary w-full justify-center">
                    <CreditCard size={16} className="mr-2" />
                    Upgrade Plan
                  </Link>
                </div>
              </div>

              {/* Transaction History */}
              <div>
                <h3 className="text-lg font-semibold mb-4">Recent Transactions</h3>
                <div className="space-y-2">
                  {summaryLoading ? (
                    <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4 text-sm text-[#A7B0B7]">
                      Loading transactions...
                    </div>
                  ) : transactions.length === 0 ? (
                    <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4 text-sm text-[#A7B0B7]">
                      No transactions yet.
                    </div>
                  ) : transactions.map((transaction) => (
                    <div
                      key={transaction.id}
                      className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4 flex items-center justify-between"
                    >
                      <div>
                        <p className="font-medium">{transaction.description}</p>
                        <p className="text-xs text-[#666]">
                          {new Date(transaction.createdAt).toLocaleString()}
                        </p>
                      </div>
                      <span
                        className={`font-mono ${
                          transaction.amount >= 0
                            ? 'text-green-400'
                            : 'text-red-400'
                        }`}
                      >
                        {transaction.amount >= 0 ? '+' : ''}
                        {transaction.amount}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
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

          {/* Usage Tab */}
          <TabsContent value="usage" className="mt-6">
            <div className="card-vocence p-6 space-y-6">
              <div>
                <h3 className="text-xl font-semibold mb-2">Credits consumed (daily)</h3>
                <p className="text-sm text-[#A7B0B7]">
                  Shows daily credit burn across Studio, Voice Chat, and Developer API.
                </p>
              </div>

              {dailyCreditsLoading ? (
                <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4 text-sm text-[#A7B0B7]">
                  Loading daily usage...
                </div>
              ) : dailyCredits && dailyCredits.days.length > 0 ? (
                (() => {
                  const todayIso = new Date().toISOString().slice(0, 10);
                  const todayRow = dailyCredits.days.find((d) => d.day === todayIso);
                  const todayCredits = todayRow?.creditsUsed ?? 0;

                  return (
                    <>
                      <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4 flex items-center justify-between gap-4">
                        <div>
                          <p className="text-xs text-[#666] mb-1">Today</p>
                          <p className="text-lg font-semibold text-white">{todayCredits.toLocaleString()} credits</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xs text-[#666] mb-1">Total (last {dailyCredits.days.length} days)</p>
                          <p className="text-lg font-semibold text-white">
                            {dailyCredits.totalCreditsUsed.toLocaleString()} credits
                          </p>
                        </div>
                      </div>

                      <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4">
                        <div className="h-64">
                          <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={dailyCredits.days} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
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
                              <YAxis
                                stroke="rgba(255,255,255,0.45)"
                                fontSize={12}
                                tickFormatter={(v) => `${v}`}
                              />
                              <Tooltip
                                contentStyle={{
                                  background: '#0a0a0a',
                                  border: '1px solid rgba(255,255,255,0.1)',
                                  borderRadius: 10,
                                }}
                                labelFormatter={(label) => `Day ${label}`}
                                formatter={(value: any) => [`${value} credits`, 'credits burned']}
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
                    </>
                  );
                })()
              ) : (
                <div className="bg-[#0a0a0a] border border-white/10 rounded-xl p-4 text-sm text-[#A7B0B7]">
                  No credits consumption data yet.
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="developer" className="mt-6">
            <div className="card-vocence p-6 space-y-6">
              <div>
                <h3 className="text-xl font-semibold mb-2">Developer API</h3>
                <p className="text-sm text-[#A7B0B7]">
                  Pricing: 2,000 credits per 1M chars, prepaid pay-as-you-go. Character usage counts text + instruction prompt.
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
                {apiKeys.length === 0 ? (
                  <div className="rounded-xl border border-white/10 bg-[#0a0a0a] p-3 text-sm text-[#A7B0B7]">No API keys yet.</div>
                ) : apiKeys.map((k) => (
                  <div key={k.id} className="rounded-xl border border-white/10 bg-[#0a0a0a] p-3 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm text-white">{k.name} <span className="text-[#7D8A95]">({k.tier})</span></p>
                      <p className="text-xs text-[#A7B0B7]">{k.keyPrefix}... · {k.rateLimitRpm} req/min</p>
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
                  Daily credits consumed is shown in the <span className="text-white">Usage</span> tab.
                </p>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
