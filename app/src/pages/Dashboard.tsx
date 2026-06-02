import { useEffect, useRef, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Cpu,
  ShieldCheck,
  Activity,
  Layers,
  Clock,
  RefreshCw,
  AlertCircle,
  ShieldOff,
  X,
  Copy,
  ChevronDown,
} from 'lucide-react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import {
  dashboardApi,
  EVALUATION_ELEMENT_ORDER,
  type DashboardOverview,
  type DashboardMiner,
  type DashboardValidator,
  type ActivityBucket,
  type GlobalScoringSnapshot,
  type RecentEvaluation,
  type SubnetGraphSnapshot,
  type ValidationStatusResponse,
} from '../services/dashboardApi';
import { AudioPlayerBar } from '../components/AudioPlayerBar';
import { LiveSubnetMap } from '../components/LiveSubnetMap';

gsap.registerPlugin(ScrollTrigger);

const SUBNET_ID = 78;
const ACCENT = '#D1F840';

/** Mock by default. Set VITE_USE_MOCK_DASHBOARD=false in .env to reveal real dashboard. */
const USE_MOCK_DASHBOARD = import.meta.env.VITE_USE_MOCK_DASHBOARD !== 'false';

// Mock when backend unavailable or when USE_MOCK_DASHBOARD is true
const MOCK_OVERVIEW: DashboardOverview = {
  total_miners: 12,
  valid_miners: 8,
  total_validators: 3,
  total_evaluations: 1240,
  last_activity: new Date(Date.now() - 120_000).toISOString(),
};

const MOCK_MINERS: DashboardMiner[] = [
  { uid: 0, hotkey: '5F3sa2TJAWMqRhXg...9k2a', block: 2841900, model_name: 'user/prompt-tts-v1', model_revision: 'a1b2c3d4', chute_id: null, chute_slug: 'user/chute-1', is_valid: true, invalid_reason: null, last_validated_at: null, total_evaluations: 420, total_wins: 318, win_rate: 75.7 },
  { uid: 1, hotkey: '8K2d4l9p...4l9p', block: 2841895, model_name: 'org/voice-model', model_revision: 'e5f6g7h8', chute_id: null, chute_slug: 'org/voice', is_valid: true, invalid_reason: null, last_validated_at: null, total_evaluations: 380, total_wins: 272, win_rate: 71.6 },
  { uid: 2, hotkey: '2N9x5m1q...5m1q', block: 2841890, model_name: 'miner/tts-pro', model_revision: 'i9j0k1l2', chute_id: null, chute_slug: 'miner/tts', is_valid: true, invalid_reason: null, last_validated_at: null, total_evaluations: 290, total_wins: 188, win_rate: 64.8 },
  { uid: 3, hotkey: '4H7y2n8k...2n8k', block: 2841885, model_name: 'team/expressive', model_revision: 'm3n4o5p6', chute_id: null, chute_slug: null, is_valid: true, invalid_reason: null, last_validated_at: null, total_evaluations: 150, total_wins: 87, win_rate: 58.0 },
  { uid: 4, hotkey: '9J2m7k4r...7k4r', block: 2841880, model_name: 'lab/voice-net', model_revision: 'q7r8s9t0', chute_id: null, chute_slug: null, is_valid: true, invalid_reason: null, last_validated_at: null, total_evaluations: 98, total_wins: 52, win_rate: 53.1 },
  { uid: 5, hotkey: '3L8k1m...2p9q', block: 2841875, model_name: 'voice/alpha-v2', model_revision: 'r0s1t2u3', chute_id: null, chute_slug: 'voice/alpha', is_valid: true, invalid_reason: null, last_validated_at: null, total_evaluations: 210, total_wins: 112, win_rate: 53.3 },
  { uid: 6, hotkey: '7P2n9x...4k8r', block: 2841870, model_name: 'tts/neural-pro', model_revision: 'v4w5x6y7', chute_id: null, chute_slug: 'tts/neural', is_valid: true, invalid_reason: null, last_validated_at: null, total_evaluations: 185, total_wins: 118, win_rate: 63.8 },
  { uid: 7, hotkey: '1R5t4v...6m2w', block: 2841865, model_name: 'speech/hi-fi', model_revision: 'z8a9b0c1', chute_id: null, chute_slug: null, is_valid: true, invalid_reason: null, last_validated_at: null, total_evaluations: 142, total_wins: 89, win_rate: 62.7 },
  { uid: 8, hotkey: '6S9u3w...8n5x', block: 2841860, model_name: 'audio/clarity', model_revision: 'd2e3f4g5', chute_id: null, chute_slug: 'audio/clarity', is_valid: true, invalid_reason: null, last_validated_at: null, total_evaluations: 95, total_wins: 51, win_rate: 53.7 },
  { uid: 9, hotkey: '2T1v7x...9p4q', block: 2841855, model_name: 'vox/stream', model_revision: 'h6i7j8k9', chute_id: null, chute_slug: 'vox/stream', is_valid: true, invalid_reason: null, last_validated_at: null, total_evaluations: 78, total_wins: 41, win_rate: 52.6 },
];

const MOCK_VALIDATORS: DashboardValidator[] = [
  { uid: 0, hotkey: '5GrwvaEF5...1', stake: 120.5, s3_bucket: 'audio-samples', last_seen_at: new Date().toISOString(), created_at: null, is_main: true },
  { uid: 1, hotkey: '5FHneW46x...2', stake: 85.2, s3_bucket: null, last_seen_at: new Date().toISOString(), created_at: null, is_main: false },
  { uid: 2, hotkey: '5DAAnrj7V...3', stake: 62.0, s3_bucket: null, last_seen_at: new Date().toISOString(), created_at: null, is_main: false },
];

type EvalResult = 'WIN' | 'LOSE' | 'EVAL' | 'PENDING';

type ValidationDetail =
  | { type: 'evaluated'; evaluation: RecentEvaluation }
  | { type: 'pending'; validator_hotkey: string; evaluation_id: string; prompt_summary: string | null; miner_hotkey: string; miner_hotkeys: string[]; created_at: string };

type ValidationListItem = { minerUid: string; task: string; result: EvalResult; detail?: ValidationDetail; minerHotkey?: string; validatorHotkey?: string };

const MOCK_VALIDATION_LIST: ValidationListItem[] = [
  { minerUid: '9K2...8m', task: 'Audio Gen', result: 'WIN' },
  { minerUid: '4F7...1p', task: 'Audio Gen', result: 'WIN' },
  { minerUid: '2B9...4x', task: 'TTS Verify', result: 'LOSE' },
  { minerUid: '7H1...9z', task: 'Audio Gen', result: 'WIN' },
  { minerUid: '3M2...5k', task: 'Denoise', result: 'WIN' },
  { minerUid: '1L8...2q', task: 'Audio Gen', result: 'LOSE' },
  { minerUid: '6N4...7w', task: 'TTS Verify', result: 'WIN' },
  { minerUid: '8J3...0v', task: 'Denoise', result: 'WIN' },
  { minerUid: '5P9...3r', task: 'Audio Gen', result: 'WIN' },
  { minerUid: '2K1...6y', task: 'TTS Verify', result: 'WIN' },
  { minerUid: '9T5...4b', task: 'Audio Gen', result: 'LOSE' },
  { minerUid: '4R2...8n', task: 'Denoise', result: 'WIN' },
  { minerUid: '1W7...3m', task: 'Audio Gen', result: 'WIN' },
  { minerUid: '7X4...9p', task: 'TTS Verify', result: 'WIN' },
  { minerUid: '3Q8...2k', task: 'Audio Gen', result: 'EVAL' },
  { minerUid: '6Y1...5j', task: 'Audio Gen', result: 'PENDING' },
  { minerUid: '2V9...3h', task: 'TTS Verify', result: 'PENDING' },
  { minerUid: '8U4...1t', task: 'Denoise', result: 'PENDING' },
  { minerUid: '5O2...7f', task: 'Audio Gen', result: 'PENDING' },
  { minerUid: '9I6...0d', task: 'TTS Verify', result: 'PENDING' },
];

function getMockActivity24h(): ActivityBucket[] {
  const now = new Date();
  return Array.from({ length: 24 }, (_, i) => {
    const d = new Date(now);
    d.setHours(d.getHours() - (23 - i), 0, 0, 0);
    return { at: d.toISOString(), count: 20 + Math.floor(Math.random() * 50) + (i >= 8 && i <= 18 ? 25 : 0) };
  });
}

function getMockActivity7d(): ActivityBucket[] {
  const now = new Date();
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (6 - i));
    d.setHours(12, 0, 0, 0);
    return { at: d.toISOString(), count: 80 + Math.floor(Math.random() * 120) };
  });
}

/** Truncate with "…" in the middle: first `start` + last `end` chars. */
function formatStartEnd(str: string | null | undefined, start: number, end: number): string {
  if (!str) return '—';
  if (str.length <= start + end) return str;
  return `${str.slice(0, start)}…${str.slice(-end)}`;
}

function formatElementLabel(key: string) {
  return key.replace(/_/g, ' ');
}

function scoreToneClass(score: number) {
  if (score >= 0.8) return 'text-[#4ade80]';
  if (score >= 0.5) return 'text-amber-400';
  return 'text-red-400';
}

function formatTimeAgo(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/** Avoid hitting the API while the tab is in the background (user on another tab / window). */
function skipDashboardPoll(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

export function Dashboard() {
  const dashboardRef = useRef<HTMLDivElement>(null);
  const [overview, setOverview] = useState<DashboardOverview | null>(null);
  const [miners, setMiners] = useState<DashboardMiner[]>([]);
  const [validators, setValidators] = useState<DashboardValidator[]>([]);
  const [activityBuckets, setActivityBuckets] = useState<ActivityBucket[]>([]);
  const [activityRange, setActivityRange] = useState<'24h' | '7d'>('24h');
  const [loading, setLoading] = useState(true);
  const [useFallbackData, setUseFallbackData] = useState(false);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [showBlacklistModal, setShowBlacklistModal] = useState(false);
  const [recentEvaluations, setRecentEvaluations] = useState<RecentEvaluation[]>([]);
  const [recentEvalsTotal, setRecentEvalsTotal] = useState(0);
  const [globalScoring, setGlobalScoring] = useState<GlobalScoringSnapshot | null>(null);
  const [subnetGraph, setSubnetGraph] = useState<SubnetGraphSnapshot | null>(null);
  const [validationStatus, setValidationStatus] = useState<ValidationStatusResponse | null>(null);
  const [blacklistedHotkeys, setBlacklistedHotkeys] = useState<string[]>([]);
  const [copiedHotkey, setCopiedHotkey] = useState<string | null>(null);
  const [copiedValidationRowId, setCopiedValidationRowId] = useState<string | null>(null);
  const [selectedValidationDetail, setSelectedValidationDetail] = useState<ValidationDetail | null>(null);
  const [selectedValidatorHotkey, setSelectedValidatorHotkey] = useState<string | null>(null);
  const [validatorDropdownOpen, setValidatorDropdownOpen] = useState(false);
  const validatorDropdownRef = useRef<HTMLDivElement>(null);

  const navigate = useNavigate();

  useEffect(() => {
    if (!validatorDropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (validatorDropdownRef.current && !validatorDropdownRef.current.contains(e.target as Node)) {
        setValidatorDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [validatorDropdownOpen]);

  const copyHotkey = useCallback((hotkey: string) => {
    navigator.clipboard.writeText(hotkey).then(() => {
      setCopiedHotkey(hotkey);
      setTimeout(() => setCopiedHotkey(null), 2000);
    });
  }, []);

  const selectedValidatorRef = useRef<string | null>(null);
  useEffect(() => {
    selectedValidatorRef.current = selectedValidatorHotkey;
  }, [selectedValidatorHotkey]);

  const fetchAll = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    if (USE_MOCK_DASHBOARD) {
      setOverview(MOCK_OVERVIEW);
      setMiners(MOCK_MINERS);
      setValidators(MOCK_VALIDATORS);
      setSelectedValidatorHotkey((prev) => prev ?? MOCK_VALIDATORS[0]?.hotkey ?? null);
      setActivityBuckets(activityRange === '24h' ? getMockActivity24h() : getMockActivity7d());
      setRecentEvaluations([]);
      setRecentEvalsTotal(0);
      setGlobalScoring(null);
      setSubnetGraph(null);
      setLastFetch(new Date());
      setUseFallbackData(true);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    try {
      const validatorHotkey = selectedValidatorRef.current ?? undefined;
      const [overviewRes, minersRes, validatorsRes, activityRes, evalsRes, globalScoringRes, subnetGraphRes] = await Promise.all([
        dashboardApi.getOverview(),
        dashboardApi.getMiners(true, validatorHotkey),
        dashboardApi.getValidators(),
        dashboardApi.getActivity(activityRange),
        dashboardApi.getRecentEvaluations(50),
        dashboardApi.getGlobalScoring(),
        dashboardApi.getSubnetGraph(),
      ]);
      setOverview(overviewRes);
      setMiners(minersRes.miners || []);
      const validatorList = validatorsRes.validators || [];
      setValidators(validatorList);
      setSelectedValidatorHotkey((prev) => {
        if (prev !== null) return prev;
        const main = validatorList.find((v) => v.is_main);
        return main?.hotkey ?? validatorList[0]?.hotkey ?? null;
      });
      setActivityBuckets(activityRes.buckets || []);
      setRecentEvaluations(evalsRes.evaluations || []);
      setRecentEvalsTotal(evalsRes.total_count ?? 0);
      setGlobalScoring(globalScoringRes);
      setSubnetGraph(subnetGraphRes);
      setLastFetch(new Date());
      setUseFallbackData(false);
    } catch {
      setOverview(MOCK_OVERVIEW);
      setMiners(MOCK_MINERS);
      setValidators(MOCK_VALIDATORS);
      setActivityBuckets(activityRange === '24h' ? getMockActivity24h() : getMockActivity7d());
      setRecentEvaluations([]);
      setRecentEvalsTotal(0);
      setGlobalScoring(null);
      setSubnetGraph(null);
      setLastFetch(new Date());
      setUseFallbackData(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [activityRange]);

  useEffect(() => {
    document.title = 'Network Overview | Vocence';
    return () => { document.title = 'Vocence'; };
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    dashboardApi.getBlocklist().then((r) => setBlacklistedHotkeys(r.hotkeys || [])).catch(() => setBlacklistedHotkeys([]));
  }, [showBlacklistModal]);

  useEffect(() => {
    const t = setInterval(() => {
      if (skipDashboardPoll()) return;
      void fetchAll(true);
    }, 60_000);
    return () => clearInterval(t);
  }, [fetchAll]);

  const fetchValidationStatus = useCallback(async () => {
    try {
      const data = await dashboardApi.getValidationStatus(10, 30);
      setValidationStatus(data);
    } catch {
      setValidationStatus(null);
    }
  }, []);

  const fetchRecentEvaluationsOnly = useCallback(async () => {
    try {
      const evalsRes = await dashboardApi.getRecentEvaluations(50);
      setRecentEvaluations(evalsRes.evaluations || []);
      setRecentEvalsTotal(evalsRes.total_count ?? 0);
    } catch {
      // keep existing
    }
  }, []);

  const fetchSubnetGraphOnly = useCallback(async () => {
    if (USE_MOCK_DASHBOARD || useFallbackData) return;
    try {
      const graphRes = await dashboardApi.getSubnetGraph();
      setSubnetGraph(graphRes);
    } catch {
      // keep existing graph
    }
  }, [useFallbackData]);

  const fetchMinersForValidator = useCallback(async (validatorHotkey: string | null) => {
    if (USE_MOCK_DASHBOARD || useFallbackData) return;
    try {
      const res = await dashboardApi.getMiners(true, validatorHotkey ?? undefined);
      setMiners(res.miners || []);
    } catch {
      // keep existing miners
    }
  }, [useFallbackData]);

  const onSelectValidator = useCallback((hotkey: string) => {
    setSelectedValidatorHotkey(hotkey);
    fetchMinersForValidator(hotkey);
  }, [fetchMinersForValidator]);

  useEffect(() => {
    if (USE_MOCK_DASHBOARD) return;
    void fetchValidationStatus();
    const t = setInterval(() => {
      if (skipDashboardPoll()) return;
      void fetchValidationStatus();
    }, 2_000);
    return () => clearInterval(t);
  }, [fetchValidationStatus]);

  useEffect(() => {
    if (USE_MOCK_DASHBOARD || useFallbackData) return;
    void fetchRecentEvaluationsOnly();
    const t = setInterval(() => {
      if (skipDashboardPoll()) return;
      void fetchRecentEvaluationsOnly();
    }, 15_000);
    return () => clearInterval(t);
  }, [useFallbackData, fetchRecentEvaluationsOnly]);

  useEffect(() => {
    if (USE_MOCK_DASHBOARD || useFallbackData) return;
    void fetchSubnetGraphOnly();
    const t = setInterval(() => {
      if (skipDashboardPoll()) return;
      void fetchSubnetGraphOnly();
    }, 2_500);
    return () => clearInterval(t);
  }, [useFallbackData, fetchSubnetGraphOnly]);

  useEffect(() => {
    if (activityRange && useFallbackData) {
      setActivityBuckets(activityRange === '24h' ? getMockActivity24h() : getMockActivity7d());
    } else if (activityRange && !useFallbackData) {
      dashboardApi.getActivity(activityRange).then((r) => setActivityBuckets(r.buckets || [])).catch(() => {
        setActivityBuckets(activityRange === '24h' ? getMockActivity24h() : getMockActivity7d());
      });
    }
  }, [activityRange, useFallbackData]);

  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.fromTo('.stat-card', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.5, stagger: 0.1, scrollTrigger: { trigger: dashboardRef.current, start: 'top 85%' } });
      gsap.fromTo('.chart-section', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.5, scrollTrigger: { trigger: '.chart-section', start: 'top 88%' } });
      gsap.fromTo('.miners-panel', { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.5, scrollTrigger: { trigger: '.miners-panel', start: 'top 88%' } });
      gsap.fromTo('.right-panel', { opacity: 0, x: 20 }, { opacity: 1, x: 0, duration: 0.5, scrollTrigger: { trigger: '.right-panel', start: 'top 88%' } });
    });
    return () => ctx.revert();
  }, [loading]);

  const maxActivity = activityBuckets.length ? Math.max(...activityBuckets.map((b) => b.count), 1) : 1;
  const sortedMiners = [...miners].sort((a, b) => b.win_rate - a.win_rate);
  const topMiners = sortedMiners.slice(0, 20);
  const showTopMiners = topMiners.length > 0;
  const winner = globalScoring?.winner ?? null;

  const { validationList, evaluatedCount, batchTotal } = (() => {
    if (useFallbackData) {
      return {
        validationList: MOCK_VALIDATION_LIST,
        evaluatedCount: MOCK_VALIDATION_LIST.filter((e) => e.result !== 'PENDING').length,
        batchTotal: MOCK_VALIDATION_LIST.length,
      };
    }
    if (validationStatus && (validationStatus.pending.length > 0 || validationStatus.evaluations.length > 0)) {
      const pendingRows: { minerUid: string; task: string; result: EvalResult; sortAt: string; detail: ValidationDetail; minerHotkey?: string; validatorHotkey?: string }[] = [];
      for (const p of validationStatus.pending) {
        for (const m of p.miner_hotkeys) {
          pendingRows.push({
            minerUid: formatStartEnd(m, 4, 4),
            task: p.evaluation_id,
            result: 'PENDING',
            sortAt: p.created_at,
            detail: { type: 'pending', validator_hotkey: p.validator_hotkey, evaluation_id: p.evaluation_id, prompt_summary: p.prompt_summary, miner_hotkey: m, miner_hotkeys: p.miner_hotkeys, created_at: p.created_at },
            minerHotkey: m,
            validatorHotkey: p.validator_hotkey,
          });
        }
      }
      const evalRows = validationStatus.evaluations.map((e) => ({
        minerUid: formatStartEnd(e.miner_hotkey, 4, 4),
        task: e.evaluation_id,
        result: (e.wins ? 'WIN' : 'LOSE') as EvalResult,
        sortAt: e.evaluated_at,
        detail: { type: 'evaluated', evaluation: e } as ValidationDetail,
        minerHotkey: e.miner_hotkey,
        validatorHotkey: e.validator_hotkey,
      }));
      const combined = [...pendingRows, ...evalRows].sort(
        (a, b) => new Date(b.sortAt).getTime() - new Date(a.sortAt).getTime()
      );
      const list: ValidationListItem[] = combined.slice(0, 25).map(({ minerUid, task, result, detail, minerHotkey, validatorHotkey }) => ({ minerUid, task, result, detail, minerHotkey, validatorHotkey }));
      return {
        validationList: list,
        evaluatedCount: evalRows.length,
        batchTotal: combined.length,
      };
    }
    return {
      validationList: recentEvaluations.map((e): ValidationListItem => ({
        minerUid: formatStartEnd(e.miner_hotkey, 4, 4),
        task: e.evaluation_id,
        result: (e.wins ? 'WIN' : 'LOSE') as EvalResult,
        detail: { type: 'evaluated', evaluation: e },
        minerHotkey: e.miner_hotkey,
        validatorHotkey: e.validator_hotkey,
      })),
      evaluatedCount: recentEvaluations.length,
      batchTotal: Math.max(recentEvalsTotal, recentEvaluations.length),
    };
  })();
  if (loading && !overview) {
    return (
      <div className="min-h-screen bg-[#050505] pt-24 pb-12 px-4 md:px-6 lg:px-8 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <RefreshCw size={32} className="animate-spin" style={{ color: ACCENT }} />
          <p className="text-gray-400 text-sm">Loading dashboard from network...</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={dashboardRef} className="dashboard-page min-h-screen bg-[#050505] text-white pt-24 pb-12 px-4 md:px-6 lg:px-8">
      <div className="max-w-[1680px] mx-auto w-full">
        {USE_MOCK_DASHBOARD && useFallbackData && (
          <div className="mb-6 p-4 rounded-xl flex items-center gap-3 border border-[#D1F840]/30 bg-[#D1F840]/10">
            <AlertCircle size={20} className="shrink-0" style={{ color: ACCENT }} />
            <div className="text-gray-200 text-sm flex-1">
              <p className="font-semibold" style={{ color: ACCENT }}>Mock data</p>
              <p className="mt-1 text-gray-400">Real-time dashboard coming soon. Numbers and tables below are for preview only.</p>
            </div>
          </div>
        )}
        {!USE_MOCK_DASHBOARD && useFallbackData && (
          <div className="mb-6 p-4 rounded-xl flex items-center gap-3 border border-amber-500/20 bg-amber-500/10">
            <AlertCircle size={20} className="text-amber-400 shrink-0" />
            <div className="text-amber-200 text-sm flex-1">
              <p className="font-medium">Showing sample data.</p>
              <p className="mt-1 text-amber-200/90">
                This site is served over HTTPS. Browsers block requests to <strong>http://</strong> APIs (mixed content). Use an <strong>https://</strong> URL for the dashboard API: put the backend behind a reverse proxy with SSL (e.g. nginx, Caddy, or Cloudflare Tunnel) and set <code className="bg-black/30 px-1.5 py-0.5 rounded font-mono text-xs">VITE_API_URL</code> to that <code className="bg-black/30 px-1.5 py-0.5 rounded font-mono text-xs">https://...</code> URL.
              </p>
              <p className="mt-1 text-amber-200/80 text-xs">Configured API: {import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '—' : 'http://localhost:34717')}</p>
            </div>
            <button onClick={() => fetchAll(true)} className="text-xs font-medium text-amber-300 hover:text-white shrink-0">
              Retry
            </button>
          </div>
        )}

        <header className="flex flex-col md:flex-row justify-between items-start md:items-end mb-8 gap-4">
          <div>
            <h1 className="text-2xl font-bold text-white mb-1">Network Overview</h1>
            <p className="text-gray-400 text-sm">Real-time metrics from the Vocence decentralized voice protocol.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => fetchAll(true)}
              disabled={refreshing}
              className="flex items-center gap-2 text-gray-400 text-sm hover:text-white disabled:opacity-50"
            >
              <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
              {refreshing ? 'Refreshing...' : 'Refresh'}
            </button>
            <span className="flex items-center text-gray-400 text-sm">
              <Clock className="w-4 h-4 mr-2 shrink-0" />
              Last updated: {lastFetch ? formatTimeAgo(lastFetch.toISOString()) : 'just now'}
            </span>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
          <div className="stat-card glass-panel rounded-2xl px-5 py-4 relative overflow-hidden min-h-[124px]">
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[#2ee1e8]/35 to-transparent" />
            <div className="flex h-full flex-col justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#151515] flex items-center justify-center border border-[#333] shrink-0">
                  <Cpu className="w-4.5 h-4.5 text-gray-300" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-[0.16em] text-gray-500">Total Miners</p>
                  <p className="text-xs text-gray-600">Current registry size</p>
                </div>
              </div>
              <div className="flex items-end justify-between gap-4">
                <h3 className="text-[2rem] font-semibold leading-none text-white">{overview?.total_miners ?? 0}</h3>
                <p className="pb-1 text-sm text-gray-400">{overview?.valid_miners ?? 0} valid</p>
              </div>
            </div>
          </div>

          <div className="stat-card glass-panel rounded-2xl px-5 py-4 relative overflow-hidden min-h-[124px]">
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[#D1F840]/35 to-transparent" />
            <div className="absolute top-4 right-4">
              <span className="bg-[#151515] border border-[#333] text-gray-400 text-[10px] px-2 py-0.5 rounded-md">Subnet {SUBNET_ID}</span>
            </div>
            <div className="flex h-full flex-col justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#151515] flex items-center justify-center border border-[#333] shrink-0">
                  <ShieldCheck className="w-4.5 h-4.5 text-gray-300" />
                </div>
                <div className="min-w-0 pr-16">
                  <p className="text-[11px] uppercase tracking-[0.16em] text-gray-500">Active Validators</p>
                  <p className="text-xs text-gray-600">Reporting to owner API</p>
                </div>
              </div>
              <div className="flex items-end justify-between gap-4">
                <h3 className="text-[2rem] font-semibold leading-none text-white">{overview?.total_validators ?? 0}</h3>
                <p className="pb-1 text-sm text-gray-400">Online set</p>
              </div>
            </div>
          </div>

          <div className="stat-card glass-panel rounded-2xl px-5 py-4 relative overflow-hidden min-h-[124px]">
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[#7dd3fc]/35 to-transparent" />
            <div className="flex h-full flex-col justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#151515] flex items-center justify-center border border-[#333] shrink-0">
                  <Activity className="w-4.5 h-4.5 text-gray-300" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-[0.16em] text-gray-500">Active Miners</p>
                  <p className="text-xs text-gray-600">Ready for evaluation</p>
                </div>
              </div>
              <div className="flex items-end justify-between gap-4">
                <h3 className="text-[2rem] font-semibold leading-none text-white">{overview?.valid_miners ?? 0}</h3>
                <p className="pb-1 text-sm text-gray-400">Online now</p>
              </div>
            </div>
          </div>

          <div className="stat-card glass-panel rounded-2xl px-5 py-4 relative overflow-hidden min-h-[124px]">
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-[#f59e0b]/35 to-transparent" />
            <div className="flex h-full flex-col justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-[#151515] flex items-center justify-center border border-[#333] shrink-0">
                  <Layers className="w-4.5 h-4.5 text-gray-300" />
                </div>
                <div className="min-w-0">
                  <p className="text-[11px] uppercase tracking-[0.16em] text-gray-500">Network Overview</p>
                  <p className="text-xs text-gray-600">Total evaluations</p>
                </div>
              </div>
              <div className="flex items-end justify-between gap-4">
                <h3 className="text-[2rem] font-semibold leading-none text-white">
                  {overview?.total_evaluations != null ? overview.total_evaluations.toLocaleString() : '—'}
                </h3>
                <p className="pb-1 text-sm text-gray-400">evals</p>
              </div>
            </div>
          </div>
        </div>

        <div className="mb-6">
          <LiveSubnetMap graph={subnetGraph} useFallbackData={useFallbackData} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_440px] gap-6 items-stretch">
          <div className="flex flex-col gap-6 min-h-0">
            <div className="chart-section glass-panel rounded-xl p-6 shrink-0">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-base font-semibold text-white">Network Activity ({activityRange})</h2>
                <div className="flex bg-[#1a1a1a] rounded-lg p-0.5 border border-[#333]">
                  <button
                    onClick={() => setActivityRange('24h')}
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors ${activityRange === '24h' ? 'bg-[#2a2a2a] text-white' : 'text-gray-500 hover:text-white'}`}
                  >
                    24h
                  </button>
                  <button
                    onClick={() => setActivityRange('7d')}
                    className={`px-3 py-1 text-xs font-medium rounded transition-colors ${activityRange === '7d' ? 'bg-[#2a2a2a] text-white' : 'text-gray-500 hover:text-white'}`}
                  >
                    7d
                  </button>
                </div>
              </div>
              <div className="relative h-48 w-full flex items-end justify-between gap-1 md:gap-2 px-2">
                {activityBuckets.length === 0 ? (
                  <div className="w-full flex items-center justify-center text-gray-500 text-sm">No data</div>
                ) : (
                  activityBuckets.map((b, i) => (
                    <div
                      key={i}
                      className="w-full rounded-t-sm transition-all duration-300 hover:opacity-100 chart-bar"
                      style={{
                        height: `${Math.max(8, (b.count / maxActivity) * 100)}%`,
                        background: `rgba(209, 248, 64, ${0.2 + (b.count / maxActivity) * 0.5})`,
                      }}
                      title={`${b.count} evaluations`}
                    />
                  ))
                )}
              </div>
              <div className="flex justify-between mt-3 text-[10px] text-gray-500 font-mono">
                <span>{(() => { const at = activityBuckets[0]?.at; return at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '00:00'; })()}</span>
                <span>06:00</span>
                <span>12:00</span>
                <span>18:00</span>
                <span>{(() => { const at = activityBuckets[activityBuckets.length - 1]?.at; return at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '23:59'; })()}</span>
              </div>
            </div>

            <div className="miners-panel glass-panel rounded-xl overflow-hidden flex-1 min-h-0 flex flex-col">
              <div className="p-6 flex justify-between items-center gap-4 border-b border-[#27272a] shrink-0 flex-wrap">
                <h2 className="text-base font-semibold text-white">
                  {showTopMiners ? 'Top 20 Performing Miners' : 'Performing Miners'}
                </h2>
                {validators.length > 0 && (
                  <div ref={validatorDropdownRef} className="inline-flex items-center gap-2 text-sm text-gray-400">
                    <span>Validator:</span>
                    <div className="relative w-[220px] min-w-[220px]">
                      <button
                        type="button"
                        onClick={() => setValidatorDropdownOpen((o) => !o)}
                        className="w-full flex items-center justify-between gap-2 bg-[#18181b] border border-[#27272a] rounded-lg px-3 py-2 text-white font-mono text-sm focus:outline-none focus:ring-1 focus:ring-[#D1F840]/50 hover:border-[#3f3f46] transition-colors"
                        aria-label="Select validator"
                        aria-expanded={validatorDropdownOpen}
                        aria-haspopup="listbox"
                      >
                        <span className="min-w-0 truncate text-left">
                          {formatStartEnd(selectedValidatorHotkey ?? validators[0]?.hotkey ?? '', 6, 6)}
                        </span>
                        <ChevronDown
                          size={16}
                          className={`shrink-0 text-gray-400 transition-transform ${validatorDropdownOpen ? 'rotate-180' : ''}`}
                        />
                      </button>
                      {validatorDropdownOpen && (
                        <div
                          className="absolute top-full left-0 mt-1 w-full min-w-[220px] rounded-lg border border-[#27272a] bg-[#18181b] shadow-xl shadow-black/40 py-1 z-50"
                          role="listbox"
                        >
                          {validators.map((v) => (
                            <button
                              key={v.hotkey}
                              type="button"
                              role="option"
                              aria-selected={selectedValidatorHotkey === v.hotkey}
                              onClick={() => {
                                onSelectValidator(v.hotkey);
                                setValidatorDropdownOpen(false);
                              }}
                              className={`w-full text-left px-3 py-2.5 font-mono text-sm transition-colors ${
                                selectedValidatorHotkey === v.hotkey
                                  ? 'bg-[#D1F840]/15 text-[#D1F840]'
                                  : 'text-white hover:bg-[#27272a]'
                              }`}
                            >
                              {formatStartEnd(v.hotkey, 6, 6)}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
              <div className="overflow-x-auto flex-1 min-h-0">
                <table className="w-full">
                  <thead>
                    <tr className="text-left border-b border-[#27272a]">
                      <th className="pb-2 px-4 text-[10px] font-semibold text-gray-500 uppercase tracking-wider w-10">#</th>
                      <th className="pb-2 px-4 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">UID</th>
                      <th className="pb-2 pl-4 pr-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider w-[180px]">Hotkey</th>
                      <th className="pb-2 px-4 text-[10px] font-semibold text-gray-500 uppercase tracking-wider w-[90px]">Block</th>
                      <th className="pb-2 pl-4 pr-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider w-[220px]">Model</th>
                      <th className="pb-2 pl-4 pr-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider w-[180px]">Chute</th>
                      <th className="pb-2 px-4 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Valid</th>
                      <th className="pb-2 px-4 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Last validated</th>
                      <th className="pb-2 px-4 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Evals / Wins</th>
                      <th className="pb-2 px-4 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Win rate</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#27272a]">
                    {!showTopMiners ? (
                      <tr>
                        <td colSpan={10} className="py-8 px-4 text-center text-gray-500 text-sm">
                          No valid miners yet.
                        </td>
                      </tr>
                    ) : (
                      topMiners.map((miner, index) => {
                        const modelDisplay = miner.model_name
                          ? (miner.model_revision ? `${miner.model_name} @ ${miner.model_revision}` : miner.model_name)
                          : '—';
                        const modelCopyValue = miner.model_name
                          ? (miner.model_revision ? `${miner.model_name} @ ${miner.model_revision}` : miner.model_name)
                          : '';
                        const chuteDisplay = miner.chute_slug ?? miner.chute_id ?? '—';
                        const chuteCopyValue = miner.chute_slug ?? miner.chute_id ?? '';
                        return (
                          <tr
                            key={`${miner.uid}-${miner.hotkey}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => navigate(`/dashboard/evaluations?miner_hotkey=${encodeURIComponent(miner.hotkey)}`)}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(`/dashboard/evaluations?miner_hotkey=${encodeURIComponent(miner.hotkey)}`); }}
                            className="group hover:bg-[#1a1a1a] transition-colors cursor-pointer"
                          >
                            <td className="py-3 px-4 text-xs text-gray-400">#{String(index + 1).padStart(2, '0')}</td>
                            <td className="py-3 px-4 text-xs font-mono text-white">{miner.uid}</td>
                            <td className="py-3 pl-4 pr-3 text-xs font-mono text-gray-300 whitespace-nowrap w-[180px] max-w-[180px] align-middle">
                              <span className="inline-flex items-center gap-1.5">
                                <span title={miner.hotkey} className="min-w-0 truncate">{formatStartEnd(miner.hotkey, 4, 4)}</span>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); e.preventDefault(); copyHotkey(miner.hotkey); }}
                                  className="inline-flex items-center justify-center min-w-[22px] min-h-[22px] rounded text-gray-400 hover:text-white hover:bg-[#27272a] transition-colors shrink-0"
                                  title="Copy hotkey"
                                  aria-label="Copy hotkey"
                                >
                                  {copiedHotkey === miner.hotkey ? <span className="text-[10px] font-medium" style={{ color: ACCENT }}>Copied</span> : <Copy size={14} className="shrink-0" />}
                                </button>
                              </span>
                            </td>
                            <td className="py-3 px-4 text-xs text-gray-400 w-[90px]">{miner.block ?? '—'}</td>
                            <td className="py-3 pl-4 pr-3 text-xs text-gray-400 whitespace-nowrap w-[220px] max-w-[220px] align-middle">
                              <span className="inline-flex items-center gap-1.5">
                                <span title={modelCopyValue} className="min-w-0 truncate">{formatStartEnd(modelDisplay === '—' ? null : modelDisplay, 8, 8)}</span>
                                {modelCopyValue && (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); e.preventDefault(); copyHotkey(modelCopyValue); }}
                                    className="inline-flex items-center justify-center min-w-[22px] min-h-[22px] rounded text-gray-400 hover:text-white hover:bg-[#27272a] transition-colors shrink-0"
                                    title="Copy model"
                                    aria-label="Copy model"
                                  >
                                    {copiedHotkey === modelCopyValue ? <span className="text-[10px] font-medium" style={{ color: ACCENT }}>Copied</span> : <Copy size={14} className="shrink-0" />}
                                  </button>
                                )}
                              </span>
                            </td>
                            <td className="py-3 pl-4 pr-3 text-xs text-gray-400 whitespace-nowrap w-[180px] max-w-[180px] align-middle">
                              <span className="inline-flex items-center gap-1.5">
                                <span title={chuteCopyValue} className="min-w-0 truncate">{formatStartEnd(chuteDisplay === '—' ? null : chuteDisplay, 7, 7)}</span>
                                {chuteCopyValue && (
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); e.preventDefault(); copyHotkey(chuteCopyValue); }}
                                    className="inline-flex items-center justify-center min-w-[22px] min-h-[22px] rounded text-gray-400 hover:text-white hover:bg-[#27272a] transition-colors shrink-0"
                                    title="Copy chute"
                                    aria-label="Copy chute"
                                  >
                                    {copiedHotkey === chuteCopyValue ? <span className="text-[10px] font-medium" style={{ color: ACCENT }}>Copied</span> : <Copy size={14} className="shrink-0" />}
                                  </button>
                                )}
                              </span>
                            </td>
                            <td className="py-3 px-4">
                              <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${miner.is_valid ? 'text-[#4ade80]' : 'text-amber-400'}`}>
                                {miner.is_valid ? 'Yes' : 'No'}
                              </span>
                            </td>
                            <td className="py-3 px-4 text-[11px] text-gray-500">{miner.last_validated_at ? formatTimeAgo(miner.last_validated_at) : '—'}</td>
                            <td className="py-3 px-4 text-xs font-medium" style={{ color: ACCENT }}>{miner.total_wins}/{miner.total_evaluations}</td>
                            <td className="py-3 px-4 text-xs text-gray-400">{miner.win_rate.toFixed(1)}%</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
              <div className="p-4 border-t border-[#27272a] shrink-0 flex justify-center">
                <button
                  onClick={() => setShowBlacklistModal(true)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-medium text-gray-400 hover:text-white border border-[#27272a] hover:border-[#333] bg-[#0f0f0f] hover:bg-[#1a1a1a] transition-colors"
                >
                  <ShieldOff className="w-3.5 h-3.5" />
                  Blacklisted hotkeys
                </button>
              </div>
            </div>
          </div>

          <div className="right-panel flex flex-col min-h-0">
            <div className="glass-panel rounded-xl p-6 flex-1 min-h-0 flex flex-col">
              <div className="flex justify-between items-center mb-3 shrink-0">
                <Link
                  to="/dashboard/evaluations"
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all hover:brightness-110"
                  style={{ color: ACCENT, background: `${ACCENT}15`, borderColor: `${ACCENT}40`, boxShadow: `0 0 14px ${ACCENT}20` }}
                >
                  View whole list
                </Link>
              </div>
              <div className="flex justify-between items-center mb-4 shrink-0">
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold text-white">Validation Status</h2>
                  <span className="inline-flex items-center gap-2 px-2.5 py-1 rounded-full border text-[11px] font-semibold text-blue-300 bg-blue-500/15 border-blue-400/40 shadow-[0_0_12px_rgba(96,165,250,0.25)]">
                    <span className="live-dot w-2.5 h-2.5 rounded-full bg-blue-400 shrink-0 ring-2 ring-blue-400/50" />
                    Live
                    {validationStatus && (validationStatus.pending.length > 0 || validationStatus.evaluations.length > 0) && (
                      <span className="text-blue-200/90 font-normal text-[10px]">· every 2s</span>
                    )}
                  </span>
                </div>
                <span className="text-xs font-mono px-2 py-1 rounded border" style={{ color: ACCENT, background: `${ACCENT}10`, borderColor: `${ACCENT}30` }}>
                  Cycle-{overview?.total_evaluations ?? 0}
                </span>
              </div>
              <div className="mb-4 shrink-0">
                <div className="flex justify-between text-xs text-gray-400 mb-2">
                  <span>Evaluations</span>
                  <span>{overview?.total_evaluations != null ? overview.total_evaluations.toLocaleString() : evaluatedCount} total</span>
                </div>
                <div className="h-1.5 w-full bg-[#1a1a1a] rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{ width: `${batchTotal ? Math.min(100, (evaluatedCount / batchTotal) * 100) : 0}%`, background: `linear-gradient(to right, ${ACCENT}, #22c55e)` }}
                  />
                </div>
              </div>
              {!useFallbackData && validationStatus && validationStatus.pending.length === 0 && validationStatus.evaluations.length === 0 && (
                <p className="text-[11px] text-amber-200/90 mb-3 px-2 py-2 rounded border border-amber-500/20 bg-amber-500/10">
                  Live evaluations from all validators will appear here (updates every 2s).
                </p>
              )}
              <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-2">
                <div className="flex flex-col gap-2">
                  <div className="grid grid-cols-12 text-[10px] text-gray-500 font-medium pb-2 border-b border-[#27272a] mb-1">
                    <div className="col-span-4">MINER</div>
                    <div className="col-span-4">EVAL ID</div>
                    <div className="col-span-4 text-right">RESULT</div>
                  </div>
                  {validationList.length === 0 ? (
                    <p className="text-[11px] text-gray-500 py-4">No recent evaluations.</p>
                  ) : (
                    (validationList.slice(0, 25).map((row, i) => {
                      const rowId = row.minerHotkey != null ? `${row.task}-${row.minerHotkey}` : `mock-${i}`;
                      return (
                      <div
                        key={i}
                        role="button"
                        tabIndex={0}
                        onClick={() => row.detail && setSelectedValidationDetail(row.detail)}
                        onKeyDown={(e) => row.detail && (e.key === 'Enter' || e.key === ' ') && setSelectedValidationDetail(row.detail)}
                        className={`grid grid-cols-12 items-center p-2 rounded border cursor-pointer hover:border-[#333] transition-colors ${
                          row.result === 'EVAL'
                            ? 'bg-[#1a1a1a] border-[#D1F840]/30 shadow-[0_0_10px_rgba(209,248,64,0.1)]'
                            : row.result === 'PENDING'
                              ? 'validation-row-evaluating border-[#D1F840]/40 bg-[#1a1a1a]'
                              : 'bg-[#1a1a1a]/50 border-[#27272a]'
                        }`}
                      >
                        <div className="col-span-4 text-[11px] font-mono text-gray-300 flex items-center gap-1 min-w-0">
                          <span className="truncate" title={row.minerHotkey ?? row.minerUid}>{row.minerUid}</span>
                          {row.minerHotkey != null && (
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                copyHotkey(row.minerHotkey!);
                                setCopiedValidationRowId(rowId);
                                setTimeout(() => setCopiedValidationRowId(null), 2000);
                              }}
                              className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded text-gray-400 hover:text-white hover:bg-[#27272a] transition-colors"
                              title="Copy hotkey"
                              aria-label="Copy hotkey"
                            >
                              {copiedValidationRowId === rowId ? <span className="text-[9px] font-medium" style={{ color: ACCENT }}>✓</span> : <Copy size={12} />}
                            </button>
                          )}
                        </div>
                        <div className="col-span-4 text-[11px] text-gray-400 break-all" title={row.task}>{row.task}</div>
                        <div className="col-span-4 text-right">
                          {row.result === 'WIN' && <span className="text-[10px] font-bold text-[#4ade80]">WIN</span>}
                          {row.result === 'LOSE' && <span className="text-[10px] font-bold text-red-500">LOSE</span>}
                          {row.result === 'EVAL' && (
                            <span className="text-[10px] font-bold text-yellow-400 flex justify-end items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
                              EVAL
                            </span>
                          )}
                          {row.result === 'PENDING' && (
                            <span className="text-[10px] font-semibold text-[#D1F840] flex justify-end items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-[#D1F840] animate-pulse" />
                              EVALUATING
                            </span>
                          )}
                        </div>
                      </div>
                    );
                    }))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6 glass-panel rounded-xl overflow-hidden">
          <div className="border-b border-[#27272a] px-6 py-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <span className="inline-flex items-center rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#D1F840] border border-[#D1F840]/30 bg-[#D1F840]/10">
                Global scoring
              </span>
              <h2 className="mt-3 text-lg font-semibold text-white">Winner Reasoning And Full Valid Miner Ranking</h2>
              <p className="mt-2 max-w-3xl text-sm text-gray-400">
                This snapshot mirrors validator weight-setting logic: recent bucket windows from active validators, sqrt(stake) weighting, minimum validator coverage, and threshold checks against earlier eligible miners.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-[11px]">
              <span className="rounded-full border border-[#27272a] bg-[#111111] px-3 py-1.5 text-gray-300">
                Updated {globalScoring?.generated_at ? formatTimeAgo(globalScoring.generated_at) : '—'}
              </span>
              <span className="rounded-full border border-[#27272a] bg-[#111111] px-3 py-1.5 text-gray-300">
                Window {globalScoring?.max_evals_for_scoring ?? '—'} evals
              </span>
              <span className="rounded-full border border-[#27272a] bg-[#111111] px-3 py-1.5 text-gray-300">
                Active validators {globalScoring?.active_validator_count ?? '—'}
              </span>
              <span className="rounded-full border border-[#27272a] bg-[#111111] px-3 py-1.5 text-gray-300">
                Threshold {globalScoring?.threshold_margin != null ? `${(globalScoring.threshold_margin * 100).toFixed(1)}%` : '—'}
              </span>
            </div>
          </div>

          {!globalScoring ? (
            <div className="px-6 py-10 text-sm text-gray-500">No global scoring snapshot available yet.</div>
          ) : (
            <>
              <div className="grid grid-cols-1 xl:grid-cols-[1.15fr_0.85fr] gap-4 border-b border-[#27272a] px-6 py-6">
                <div className="rounded-2xl border border-[#D1F840]/20 bg-[radial-gradient(circle_at_top_left,rgba(209,248,64,0.18),rgba(12,12,12,0.92)_55%)] p-5">
                  <div className="flex items-center gap-2 mb-3">
                    <span className="inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[#D1F840] border border-[#D1F840]/25 bg-black/30">
                      Current winner
                    </span>
                    {winner ? (
                      <span className="font-mono text-sm text-white">{formatStartEnd(winner.hotkey, 8, 8)}</span>
                    ) : (
                      <span className="text-sm text-red-300">No eligible winner</span>
                    )}
                  </div>
                  <div className="mb-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-[0.14em] text-gray-500">Weighted</p>
                      <p className="text-lg font-semibold text-white">{winner ? `${(winner.weighted_win_rate * 100).toFixed(1)}%` : '—'}</p>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-[0.14em] text-gray-500">Raw</p>
                      <p className="text-lg font-semibold text-white">{winner ? `${winner.wins}/${winner.total}` : '—'}</p>
                    </div>
                    <div className="rounded-xl border border-white/10 bg-black/20 px-3 py-2">
                      <p className="text-[10px] uppercase tracking-[0.14em] text-gray-500">Coverage</p>
                      <p className="text-lg font-semibold text-white">{winner ? winner.validator_count : '—'}</p>
                    </div>
                  </div>
                  <p className="text-sm leading-6 text-gray-100/90">
                    {globalScoring.winner_reason ?? 'No miner cleared the active-validator coverage and threshold rules in the current snapshot.'}
                  </p>
                </div>

                <div className="rounded-2xl border border-[#27272a] bg-[#0d0d0d] p-5">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-white">Winner Threshold Checks</h3>
                    <span className="text-[11px] text-gray-500">Earlier eligible miners</span>
                  </div>
                  {!winner || winner.threshold_checks.length === 0 ? (
                    <p className="text-sm text-gray-500">No threshold checks recorded for this snapshot.</p>
                  ) : (
                    <div className="space-y-2">
                      {winner.threshold_checks.slice(0, 2).map((check) => (
                        <div key={`${winner.hotkey}-${check.prior_hotkey}`} className="rounded-xl border border-[#27272a] bg-[#121212] px-3 py-2.5">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <p className="font-mono text-xs text-white">{formatStartEnd(check.prior_hotkey, 8, 8)}</p>
                              <p className="text-[11px] text-gray-500">Block {check.prior_block}</p>
                            </div>
                            <span className={`inline-flex items-center rounded-full px-2 py-1 text-[10px] font-semibold ${check.passed ? 'border border-emerald-400/20 bg-emerald-500/10 text-emerald-300' : 'border border-red-400/20 bg-red-500/10 text-red-300'}`}>
                              {check.passed ? 'PASS' : 'FAIL'}
                            </span>
                          </div>
                          <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                            <div>
                              <p className="text-gray-500">Prior</p>
                              <p className="text-white">{(check.prior_rate * 100).toFixed(1)}%</p>
                            </div>
                            <div>
                              <p className="text-gray-500">Need at least</p>
                              <p className="text-white">{(check.required_rate * 100).toFixed(1)}%</p>
                            </div>
                            <div>
                              <p className="text-gray-500">Winner</p>
                              <p className="text-white">{(check.candidate_rate * 100).toFixed(1)}%</p>
                            </div>
                          </div>
                        </div>
                      ))}
                      {winner.threshold_checks.length > 2 && (
                        <p className="pt-1 text-[11px] text-gray-500">
                          Showing top 2 earlier eligible miners out of {winner.threshold_checks.length}.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[1080px]">
                  <thead>
                    <tr className="border-b border-[#27272a] text-left">
                      <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Rank</th>
                      <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Miner</th>
                      <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Status</th>
                      <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Weighted</th>
                      <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Raw</th>
                      <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Vals</th>
                      <th className="px-4 py-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">Per-validator detail</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#27272a]">
                    {globalScoring.miners.map((miner) => (
                      <tr key={miner.hotkey} className={miner.is_winner ? 'bg-[#D1F840]/[0.06]' : 'hover:bg-[#121212] transition-colors'}>
                        <td className="px-4 py-4 align-top text-xs text-gray-400">#{String(miner.rank).padStart(2, '0')}</td>
                        <td className="px-4 py-4 align-top">
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <span className="font-mono text-sm text-white">{formatStartEnd(miner.hotkey, 6, 6)}</span>
                              {miner.is_winner && (
                                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold text-[#D1F840] border border-[#D1F840]/30 bg-[#D1F840]/10">
                                  Winner
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-gray-500">UID {miner.uid} · Block {miner.block}</p>
                            <p className="text-[11px] text-gray-400">{miner.model_name || 'Unknown model'}</p>
                          </div>
                        </td>
                        <td className="px-4 py-4 align-top">
                          <div className="space-y-2">
                            <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-semibold ${
                              miner.is_winner
                                ? 'text-[#D1F840] border border-[#D1F840]/30 bg-[#D1F840]/10'
                                : miner.eligible
                                  ? 'text-emerald-300 border border-emerald-400/20 bg-emerald-500/10'
                                  : 'text-amber-300 border border-amber-400/20 bg-amber-500/10'
                            }`}>
                              {miner.is_winner ? 'Winner' : miner.eligible ? 'Eligible' : 'Ineligible'}
                            </span>
                            <p className="max-w-[240px] text-[11px] leading-5 text-gray-400">{miner.status_reason}</p>
                          </div>
                        </td>
                        <td className="px-4 py-4 align-top text-sm font-semibold text-white">{(miner.weighted_win_rate * 100).toFixed(1)}%</td>
                        <td className="px-4 py-4 align-top text-sm text-gray-300">{miner.wins}/{miner.total}</td>
                        <td className="px-4 py-4 align-top text-sm text-gray-300">{miner.validator_count}</td>
                        <td className="px-4 py-4 align-top">
                          <div className="space-y-2">
                            {miner.per_validator.length === 0 ? (
                              <p className="text-[11px] text-gray-500">No contributing validators.</p>
                            ) : (
                              miner.per_validator.map((detail) => (
                                <div key={`${miner.hotkey}-${detail.validator_hotkey}`} className="rounded-lg border border-[#27272a] bg-[#111111] px-3 py-2 text-[11px] text-gray-300">
                                  <span className="font-mono">{detail.display}</span>
                                </div>
                              ))
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Validation detail slide-out (right side), above navbar (z-[60]) */}
      {selectedValidationDetail && (
        <div
          className="fixed inset-0 z-[60] flex justify-end bg-black/50 backdrop-blur-sm"
          onClick={() => setSelectedValidationDetail(null)}
          aria-hidden="true"
        >
          <div
            className="w-full max-w-md sm:w-[min(420px,33vw)] h-full bg-[#0f0f0f] border-l border-[#27272a] shadow-xl overflow-y-auto flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex justify-between items-center p-4 border-b border-[#27272a] bg-[#0f0f0f] shrink-0">
              <h3 className="text-sm font-semibold text-white">Evaluation details</h3>
              <button
                type="button"
                onClick={() => setSelectedValidationDetail(null)}
                className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-[#27272a] transition-colors"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-4 flex-1 space-y-4 text-sm">
              {selectedValidationDetail.type === 'evaluated' ? (
                <>
                  <div>
                    <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Evaluation ID</p>
                    <p className="font-mono text-gray-200 break-all">{selectedValidationDetail.evaluation.evaluation_id}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Miner hotkey</p>
                    <p className="font-mono text-gray-200 break-all text-xs">{selectedValidationDetail.evaluation.miner_hotkey}</p>
                  </div>
                  {(() => {
                    const miner = miners.find((m) => m.hotkey === selectedValidationDetail.evaluation.miner_hotkey);
                    if (!miner) return null;
                    return (
                      <div className="space-y-2 rounded-lg border border-[#27272a] p-3 bg-[#1a1a1a]/50">
                        <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">Miner info</p>
                        <div>
                          <span className="text-[10px] text-gray-500">Chute ID</span>
                          <p className="font-mono text-gray-300 text-xs break-all">{miner.chute_id ?? '—'}</p>
                        </div>
                        <div>
                          <span className="text-[10px] text-gray-500">Chute slug</span>
                          <p className="font-mono text-gray-300 text-xs break-all">{miner.chute_slug ?? '—'}</p>
                        </div>
                        <div>
                          <span className="text-[10px] text-gray-500">Model</span>
                          <p className="font-mono text-gray-300 text-xs break-all">
                            {miner.model_name ? (miner.model_revision ? `${miner.model_name} @ ${miner.model_revision}` : miner.model_name) : '—'}
                          </p>
                        </div>
                      </div>
                    );
                  })()}
                  <div>
                    <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Validator hotkey</p>
                    <p className="font-mono text-gray-400 break-all text-xs">{selectedValidationDetail.evaluation.validator_hotkey?.trim() || '—'}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-bold px-2 py-1 rounded ${selectedValidationDetail.evaluation.wins ? 'text-[#4ade80] bg-[#4ade80]/15' : 'text-red-500 bg-red-500/15'}`}>
                      {selectedValidationDetail.evaluation.wins ? 'WIN' : 'LOSE'}
                    </span>
                    {typeof selectedValidationDetail.evaluation.score === 'number' && (
                      <span
                        className={`text-xs font-mono font-semibold px-2 py-1 rounded bg-[#1a1a1a] border border-[#27272a] ${scoreToneClass(selectedValidationDetail.evaluation.score)}`}
                        title="Total weighted score"
                      >
                        {selectedValidationDetail.evaluation.score.toFixed(2)}
                      </span>
                    )}
                    <span className="text-gray-500 text-xs">Evaluated {formatTimeAgo(selectedValidationDetail.evaluation.evaluated_at)}</span>
                  </div>
                  {selectedValidationDetail.evaluation.element_scores &&
                    Object.keys(selectedValidationDetail.evaluation.element_scores).length > 0 && (
                      <div>
                        <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-2">Element scores</p>
                        <div className="grid grid-cols-3 gap-1.5">
                          {EVALUATION_ELEMENT_ORDER.filter(
                            (k) => selectedValidationDetail.evaluation!.element_scores && k in selectedValidationDetail.evaluation!.element_scores,
                          ).map((key) => {
                            const s = selectedValidationDetail.evaluation!.element_scores![key];
                            return (
                              <div
                                key={key}
                                className="rounded border border-[#27272a] bg-[#141414] px-2 py-1.5 text-center"
                                title={`${formatElementLabel(key)}: ${s.toFixed(3)}`}
                              >
                                <div className="text-[9px] uppercase tracking-wider text-gray-500">{formatElementLabel(key)}</div>
                                <div className={`text-sm font-mono font-semibold ${scoreToneClass(s)}`}>{s.toFixed(2)}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  {selectedValidationDetail.evaluation.prompt && (
                    <div>
                      <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Prompt</p>
                      <p className="text-gray-300 text-xs whitespace-pre-wrap break-words">{selectedValidationDetail.evaluation.prompt}</p>
                    </div>
                  )}
                  {selectedValidationDetail.evaluation.reasoning && (
                    <div>
                      <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Reasoning</p>
                      <p className="text-gray-400 text-xs whitespace-pre-wrap break-words">{selectedValidationDetail.evaluation.reasoning}</p>
                    </div>
                  )}
                  <div className="space-y-3 pt-2 border-t border-[#27272a]">
                    <div>
                      <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Original audio</p>
                      <AudioPlayerBar
                        src={selectedValidationDetail.evaluation.original_audio_url}
                        label="Original audio"
                        className="text-xs"
                      />
                    </div>
                    <div>
                      <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Generated audio</p>
                      <AudioPlayerBar
                        src={selectedValidationDetail.evaluation.generated_audio_url}
                        label="Generated audio"
                        className="text-xs"
                      />
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-semibold px-2 py-1 rounded text-[#D1F840] bg-[#D1F840]/15">EVALUATING</span>
                  </div>
                  <div>
                    <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Evaluation ID</p>
                    <p className="font-mono text-gray-200 break-all">{selectedValidationDetail.evaluation_id}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Validator hotkey</p>
                    <p className="font-mono text-gray-400 break-all text-xs">{selectedValidationDetail.validator_hotkey?.trim() || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Miner (this row)</p>
                    <p className="font-mono text-gray-200 break-all text-xs">{selectedValidationDetail.miner_hotkey}</p>
                  </div>
                  {(() => {
                    const miner = miners.find((m) => m.hotkey === selectedValidationDetail.miner_hotkey);
                    if (!miner) return null;
                    return (
                      <div className="space-y-2 rounded-lg border border-[#27272a] p-3 bg-[#1a1a1a]/50">
                        <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider">Miner info</p>
                        <div>
                          <span className="text-[10px] text-gray-500">Chute ID</span>
                          <p className="font-mono text-gray-300 text-xs break-all">{miner.chute_id ?? '—'}</p>
                        </div>
                        <div>
                          <span className="text-[10px] text-gray-500">Chute slug</span>
                          <p className="font-mono text-gray-300 text-xs break-all">{miner.chute_slug ?? '—'}</p>
                        </div>
                        <div>
                          <span className="text-[10px] text-gray-500">Model</span>
                          <p className="font-mono text-gray-300 text-xs break-all">
                            {miner.model_name ? (miner.model_revision ? `${miner.model_name} @ ${miner.model_revision}` : miner.model_name) : '—'}
                          </p>
                        </div>
                      </div>
                    );
                  })()}
                  <div>
                    <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">All miners in this round</p>
                    <ul className="space-y-1">
                      {selectedValidationDetail.miner_hotkeys.map((hk) => (
                        <li key={hk} className="font-mono text-xs text-gray-400 break-all">
                          {hk}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {selectedValidationDetail.prompt_summary && (
                    <div>
                      <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Prompt summary</p>
                      <p className="text-gray-300 text-xs whitespace-pre-wrap break-words">{selectedValidationDetail.prompt_summary}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-[10px] font-medium text-gray-500 uppercase tracking-wider mb-1">Started</p>
                    <p className="text-gray-500 text-xs">{selectedValidationDetail.created_at ? new Date(selectedValidationDetail.created_at).toLocaleString() : '—'}</p>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Blacklisted hotkeys modal */}
      {showBlacklistModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-md"
          onClick={() => setShowBlacklistModal(false)}
        >
          <div
            className="glass-panel rounded-xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between p-4 border-b border-[#27272a] shrink-0">
              <h3 className="text-sm font-semibold text-white">Blacklisted hotkeys</h3>
              <button
                onClick={() => setShowBlacklistModal(false)}
                className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-[#27272a] transition-colors"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="overflow-y-auto custom-scrollbar p-4 flex-1 min-h-0">
              {blacklistedHotkeys.length === 0 ? (
                <p className="text-sm text-gray-500 text-center py-8">No blacklisted hotkeys.</p>
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="text-left border-b border-[#27272a]">
                      <th className="pb-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Hotkey</th>
                      <th className="pb-2 text-[10px] font-semibold text-gray-500 uppercase tracking-wider w-14 text-right">Copy</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#27272a]">
                    {blacklistedHotkeys.map((hk) => (
                      <tr key={hk} className="hover:bg-[#1a1a1a] transition-colors">
                        <td className="py-3 text-xs font-mono text-gray-300 break-all pr-2">{hk}</td>
                        <td className="py-3 text-right align-middle">
                          <button
                            type="button"
                            onClick={() => copyHotkey(hk)}
                            className="inline-flex items-center justify-center p-2 rounded-lg text-gray-400 hover:text-white hover:bg-[#27272a] transition-colors"
                            title="Copy address"
                          >
                            {copiedHotkey === hk ? (
                              <span className="text-[10px] font-medium" style={{ color: '#D1F840' }}>Copied</span>
                            ) : (
                              <Copy className="w-4 h-4" />
                            )}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
