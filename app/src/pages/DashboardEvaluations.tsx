import { useEffect, useState, useCallback, Fragment, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw, ChevronDown, ChevronRight, Copy } from 'lucide-react';
import {
  dashboardApi,
  EVALUATION_ELEMENT_ORDER,
  type RecentEvaluation,
  type DashboardValidator,
} from '../services/dashboardApi';
import { AudioPlayerBar } from '../components/AudioPlayerBar';

const ACCENT = '#D1F840';

function formatHotkey(hotkey: string) {
  if (!hotkey || hotkey.length < 12) return hotkey;
  return `${hotkey.slice(0, 6)}...${hotkey.slice(-4)}`;
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

export function DashboardEvaluations() {
  const [searchParams] = useSearchParams();
  const minerFromUrl = searchParams.get('miner_hotkey') ?? '';
  const PAGE_SIZE = 100;
  const [evaluations, setEvaluations] = useState<RecentEvaluation[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [validators, setValidators] = useState<DashboardValidator[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterValidator, setFilterValidator] = useState<string>('');
  const [filterMiner, setFilterMiner] = useState<string>(minerFromUrl);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [copiedCellId, setCopiedCellId] = useState<string | null>(null);
  const [validatorDropdownOpen, setValidatorDropdownOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const validatorDropdownRef = useRef<HTMLDivElement>(null);

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

  const copyToClipboard = useCallback((text: string, cellId: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedCellId(cellId);
      setTimeout(() => setCopiedCellId(null), 2000);
    });
  }, []);

  const load = useCallback(
    async (page = 1, validatorHotkey?: string | null, minerHotkey?: string | null) => {
      setLoading(true);
      setError(null);
      const v = validatorHotkey ?? (filterValidator.trim() || null);
      const m = minerHotkey ?? (filterMiner.trim() || null);
      try {
        const safePage = Math.max(1, page);
        const offset = (safePage - 1) * PAGE_SIZE;
        const res = await dashboardApi.getEvaluations(PAGE_SIZE, offset, v, m);
        setEvaluations(res.evaluations || []);
        setTotalCount(res.total_count ?? 0);
        setCurrentPage(safePage);
        setPageInput(String(safePage));
        setExpandedId(null);
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        setEvaluations([]);
        setTotalCount(0);
        setError(msg || 'Failed to load evaluations');
      } finally {
        setLoading(false);
      }
    },
    [filterValidator, filterMiner]
  );

  useEffect(() => {
    document.title = 'All evaluation results | Vocence Dashboard';
    if (minerFromUrl) {
      setFilterMiner(minerFromUrl);
    }
  }, [minerFromUrl]);

  useEffect(() => {
    load(1, filterValidator.trim() || null, filterMiner.trim() || null);
  }, [filterValidator, filterMiner, load]);

  useEffect(() => {
    return () => {
      document.title = 'Vocence';
    };
  }, []);

  useEffect(() => {
    dashboardApi.getValidators().then((r) => setValidators(r.validators || [])).catch(() => setValidators([]));
  }, []);

  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));

  const applyFilters = () => {
    setCurrentPage(1);
    setPageInput('1');
    load(1, filterValidator.trim() || null, filterMiner.trim() || null);
  };

  const goToPage = (page: number) => {
    const nextPage = Math.min(totalPages, Math.max(1, page));
    load(nextPage, filterValidator.trim() || null, filterMiner.trim() || null);
  };

  return (
    <div className="min-h-screen bg-[#050505] text-white pt-24 pb-12 px-4 md:px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        <header className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6">
          <div className="flex items-center gap-4">
            <Link
              to="/dashboard"
              className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              <ArrowLeft className="w-4 h-4" /> Back to Dashboard
            </Link>
            <h1 className="text-2xl font-bold text-white">All evaluation results</h1>
          </div>
          <button
            onClick={() => load(currentPage, filterValidator.trim() || null, filterMiner.trim() || null)}
            disabled={loading}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-[#050505] hover:opacity-90 disabled:opacity-50 transition-opacity"
            style={{ background: ACCENT }}
          >
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} /> {loading ? 'Loading...' : 'Refresh'}
          </button>
        </header>

        {/* Filters */}
        <div className="mb-6 p-5 rounded-2xl glass-panel border border-[#27272a] flex flex-wrap items-end gap-5">
          <div ref={validatorDropdownRef} className="flex flex-col gap-2">
            <label className="text-xs font-medium text-gray-400 tracking-wide">Validator</label>
            <div className="relative min-w-[240px]">
              <button
                type="button"
                onClick={() => setValidatorDropdownOpen((o) => !o)}
                className="w-full flex items-center justify-between gap-2 bg-[#0f0f0f] border border-[#27272a] rounded-xl px-4 py-2.5 text-left text-sm font-medium text-white focus:outline-none focus:ring-2 focus:ring-[#D1F840]/40 focus:border-[#D1F840]/50 hover:border-[#3f3f46] transition-all"
                aria-expanded={validatorDropdownOpen}
                aria-haspopup="listbox"
                aria-label="Select validator"
              >
                <span className="min-w-0 truncate font-mono">
                  {filterValidator
                    ? `${formatHotkey(filterValidator)} (uid ${validators.find((v) => v.hotkey === filterValidator)?.uid ?? '?'})`
                    : 'All validators'}
                </span>
                <ChevronDown
                  size={18}
                  className={`shrink-0 text-gray-400 transition-transform duration-200 ${validatorDropdownOpen ? 'rotate-180' : ''}`}
                />
              </button>
              {validatorDropdownOpen && (
                <div
                  className="absolute top-full left-0 mt-2 w-full min-w-[240px] rounded-xl border border-[#27272a] bg-[#0f0f0f] shadow-xl shadow-black/50 py-1.5 z-50 max-h-[280px] overflow-y-auto custom-scrollbar"
                  role="listbox"
                >
                  <button
                    type="button"
                    role="option"
                    aria-selected={!filterValidator}
                    onClick={() => {
                      setFilterValidator('');
                      setValidatorDropdownOpen(false);
                    }}
                    className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${
                      !filterValidator ? 'bg-[#D1F840]/15 text-[#D1F840] font-medium' : 'text-gray-300 hover:bg-[#1a1a1a] hover:text-white'
                    }`}
                  >
                    All validators
                  </button>
                  {validators.map((v) => (
                    <button
                      key={v.uid}
                      type="button"
                      role="option"
                      aria-selected={filterValidator === v.hotkey}
                      onClick={() => {
                        setFilterValidator(v.hotkey);
                        setValidatorDropdownOpen(false);
                      }}
                      className={`w-full text-left px-4 py-2.5 font-mono text-sm transition-colors ${
                        filterValidator === v.hotkey
                          ? 'bg-[#D1F840]/15 text-[#D1F840] font-medium'
                          : 'text-gray-300 hover:bg-[#1a1a1a] hover:text-white'
                      }`}
                    >
                      {formatHotkey(v.hotkey)} <span className="text-gray-500 font-sans">(uid {v.uid})</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-gray-400 tracking-wide">Miner hotkey</label>
            <input
              type="text"
              value={filterMiner}
              onChange={(e) => setFilterMiner(e.target.value)}
              placeholder="Paste or type miner hotkey"
              className="min-w-[240px] px-4 py-2.5 rounded-xl bg-[#0f0f0f] border border-[#27272a] text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-[#D1F840]/40 focus:border-[#D1F840]/50 hover:border-[#3f3f46] transition-all"
            />
          </div>
          <button
            type="button"
            onClick={applyFilters}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold text-[#050505] hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-[#D1F840]/50 transition-all"
            style={{ background: ACCENT }}
          >
            Apply filters
          </button>
        </div>

        {error && (
          <div className="mb-6 p-4 rounded-xl border border-red-500/20 bg-red-500/10">
            <p className="text-red-400 text-sm mb-2">{error}</p>
            <p className="text-gray-400 text-xs mb-4">Ensure the dashboard backend is running and connected to the same Postgres as the validator (validator_evaluations table).</p>
            <button
              type="button"
              onClick={() => load(currentPage, filterValidator.trim() || null, filterMiner.trim() || null)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-[#050505]"
              style={{ background: ACCENT }}
            >
              <RefreshCw className="w-4 h-4" /> Retry
            </button>
          </div>
        )}

        {loading && evaluations.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24">
            <RefreshCw size={40} className="animate-spin mb-4" style={{ color: ACCENT }} />
            <p className="text-gray-400 text-sm">Loading evaluation results...</p>
          </div>
        ) : evaluations.length === 0 && !error ? (
          <div className="glass-panel rounded-xl p-12 text-center">
            <p className="text-gray-400">No evaluation results in validator_evaluations.</p>
            <p className="text-gray-500 text-sm mt-2">Run the validator to submit evaluations.</p>
          </div>
        ) : (
          <div className="glass-panel rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-[#27272a] bg-[#0f0f0f]">
                    <th className="py-3 px-4 text-[10px] font-semibold text-gray-500 uppercase tracking-wider w-10" />
                    <th className="py-3 px-4 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">ID</th>
                    <th className="py-3 px-4 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Validator hotkey</th>
                    <th className="py-3 px-4 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Evaluation ID</th>
                    <th className="py-3 px-4 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Miner hotkey</th>
                    <th className="py-3 px-4 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Wins</th>
                    <th className="py-3 px-4 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Evaluated at</th>
                    <th className="py-3 px-4 text-[10px] font-semibold text-gray-500 uppercase tracking-wider w-20">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#27272a]">
                  {evaluations.map((e) => (
                    <Fragment key={e.id}>
                      <tr className="hover:bg-[#1a1a1a] transition-colors">
                        <td className="py-3 px-4 w-10">
                          <button
                            type="button"
                            onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
                            className="p-1 rounded text-gray-400 hover:text-white"
                            aria-label={expandedId === e.id ? 'Collapse' : 'Expand'}
                          >
                            {expandedId === e.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                          </button>
                        </td>
                        <td className="py-3 px-4 text-xs text-gray-400 font-mono">{e.id}</td>
                        <td className="py-3 px-4 text-xs font-mono text-gray-300 max-w-[160px]">
                          <span className="inline-flex items-center gap-1.5 min-w-0">
                            <span className="truncate" title={e.validator_hotkey}>{formatHotkey(e.validator_hotkey)}</span>
                            <button
                              type="button"
                              onClick={(ev) => { ev.stopPropagation(); copyToClipboard(e.validator_hotkey, `v-${e.id}`); }}
                              className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded text-gray-400 hover:text-white hover:bg-[#27272a] transition-colors"
                              title="Copy validator hotkey"
                              aria-label="Copy validator hotkey"
                            >
                              {copiedCellId === `v-${e.id}` ? <span className="text-[10px] font-medium" style={{ color: ACCENT }}>✓</span> : <Copy size={12} />}
                            </button>
                          </span>
                        </td>
                        <td className="py-3 px-4 text-xs font-mono text-gray-400 max-w-[140px] truncate" title={e.evaluation_id}>{e.evaluation_id}</td>
                        <td className="py-3 px-4 text-xs font-mono text-gray-300 max-w-[160px]">
                          <span className="inline-flex items-center gap-1.5 min-w-0">
                            <span className="truncate" title={e.miner_hotkey}>{formatHotkey(e.miner_hotkey)}</span>
                            <button
                              type="button"
                              onClick={(ev) => { ev.stopPropagation(); copyToClipboard(e.miner_hotkey, `m-${e.id}`); }}
                              className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded text-gray-400 hover:text-white hover:bg-[#27272a] transition-colors"
                              title="Copy miner hotkey"
                              aria-label="Copy miner hotkey"
                            >
                              {copiedCellId === `m-${e.id}` ? <span className="text-[10px] font-medium" style={{ color: ACCENT }}>✓</span> : <Copy size={12} />}
                            </button>
                          </span>
                        </td>
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${e.wins ? 'text-[#4ade80] bg-[#1a2e1a]' : 'text-red-400 bg-red-500/10'}`}>
                              {e.wins ? 'WIN' : 'LOSE'}
                            </span>
                            {typeof e.score === 'number' && (
                              <span
                                className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-medium bg-[#1a1a1a] border border-[#27272a] ${scoreToneClass(e.score)}`}
                                title="Total weighted score"
                              >
                                {e.score.toFixed(2)}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-3 px-4 text-xs text-gray-500">{e.evaluated_at ? formatTimeAgo(e.evaluated_at) : '—'}</td>
                        <td className="py-3 px-4">
                          <button
                            type="button"
                            onClick={() => setExpandedId(expandedId === e.id ? null : e.id)}
                            className="text-[10px] font-medium hover:opacity-80"
                            style={{ color: ACCENT }}
                          >
                            {expandedId === e.id ? 'Hide' : 'Details'}
                          </button>
                        </td>
                      </tr>
                      {expandedId === e.id && (
                        <tr key={`${e.id}-detail`} className="bg-[#0f0f0f] border-b border-[#27272a]">
                          <td colSpan={8} className="py-4 px-4">
                            <div className="space-y-4">
                              {e.element_scores && Object.keys(e.element_scores).length > 0 && (
                                <div>
                                  <p className="text-[10px] font-semibold text-gray-500 uppercase mb-2">Element scores</p>
                                  <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-9 gap-2">
                                    {EVALUATION_ELEMENT_ORDER.filter((k) => e.element_scores && k in e.element_scores).map((key) => {
                                      const s = e.element_scores?.[key] ?? 0;
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
                                  <div className="mt-2 flex items-center gap-3 text-xs">
                                    <span className="text-gray-500">Total</span>
                                    <span className={`font-mono font-semibold ${typeof e.score === 'number' ? scoreToneClass(e.score) : 'text-gray-400'}`}>
                                      {typeof e.score === 'number' ? e.score.toFixed(3) : '—'}
                                    </span>
                                    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium ${e.wins ? 'text-[#4ade80] bg-[#1a2e1a]' : 'text-red-400 bg-red-500/10'}`}>
                                      {e.wins ? 'WIN' : 'LOSE'}
                                    </span>
                                  </div>
                                </div>
                              )}
                              <div>
                                <p className="text-[10px] font-semibold text-gray-500 uppercase mb-1">Prompt</p>
                                <p className="text-sm text-gray-300 whitespace-pre-wrap break-words">{e.prompt || '—'}</p>
                              </div>
                              <div>
                                <p className="text-[10px] font-semibold text-gray-500 uppercase mb-1">Who wins / Reasoning</p>
                                <p className="text-xs text-gray-400 mb-1">
                                  <span className={e.wins ? 'text-[#4ade80]' : 'text-red-400'}>{e.wins ? 'Generated audio won' : 'Original audio won'}</span>
                                </p>
                                <p className="text-sm text-gray-400 whitespace-pre-wrap break-words">{e.reasoning || '—'}</p>
                              </div>
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <div>
                                  <p className="text-[10px] font-semibold text-gray-500 uppercase mb-2">Original audio</p>
                                  <AudioPlayerBar src={e.original_audio_url} label="Original" className="w-full" />
                                </div>
                                <div>
                                  <p className="text-[10px] font-semibold text-gray-500 uppercase mb-2">Generated audio</p>
                                  <AudioPlayerBar src={e.generated_audio_url} label="Generated" className="w-full" />
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-[#27272a] text-xs text-gray-500">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <span>
                  Showing {(currentPage - 1) * PAGE_SIZE + (evaluations.length > 0 ? 1 : 0)}-
                  {(currentPage - 1) * PAGE_SIZE + evaluations.length} of {totalCount} evaluation result{totalCount !== 1 ? 's' : ''}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => goToPage(currentPage - 1)}
                    disabled={loading || currentPage <= 1}
                    className="px-3 py-1.5 rounded-lg border border-[#27272a] bg-[#0f0f0f] text-gray-300 disabled:opacity-40 hover:border-[#3f3f46] hover:text-white transition-colors"
                  >
                    Prev
                  </button>
                  <span className="text-gray-400">
                    Page {currentPage} / {totalPages}
                  </span>
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={pageInput}
                    onChange={(e) => setPageInput(e.target.value.replace(/[^\d]/g, ''))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const parsed = Number(pageInput);
                        if (!Number.isNaN(parsed)) goToPage(parsed);
                      }
                    }}
                    className="w-20 rounded-lg border border-[#27272a] bg-[#0f0f0f] px-3 py-1.5 text-sm text-white"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const parsed = Number(pageInput);
                      if (!Number.isNaN(parsed)) goToPage(parsed);
                    }}
                    disabled={loading}
                    className="px-3 py-1.5 rounded-lg text-sm font-medium text-[#050505] disabled:opacity-50"
                    style={{ background: ACCENT }}
                  >
                    Go
                  </button>
                  <button
                    type="button"
                    onClick={() => goToPage(currentPage + 1)}
                    disabled={loading || currentPage >= totalPages}
                    className="px-3 py-1.5 rounded-lg border border-[#27272a] bg-[#0f0f0f] text-gray-300 disabled:opacity-40 hover:border-[#3f3f46] hover:text-white transition-colors"
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
