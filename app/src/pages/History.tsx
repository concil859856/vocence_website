import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  ArrowLeft,
  Search,
  Copy,
  Play,
  Download,
  MoreHorizontal,
} from 'lucide-react';
import { dashboardApi } from '../services/dashboardApi';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../components/ui/select';

const HISTORY_PAGE_SIZE = 10;

interface HistoryItem {
  id: string;
  type: 'tts' | 'stt' | 'cloning' | 'voice_design';
  timestamp: string;
  date: string;
  content: string;
  stylePrompt?: string;
  model: string;
  meta: string;
  duration: string;
  /** From Studio TTS API; enables Play/Download when not expired */
  audioUrl?: string | null;
  expired?: boolean;
  /** Query string for /studio/result e.g. ?entry_type=clone */
  resultQuery?: string;
}

export function History() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [historyPage, setHistoryPage] = useState(1);

  const triggerBrowserDownload = async (url: string, filename: string) => {
    try {
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) {
        throw new Error(`Download request failed (${res.status})`);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = objectUrl;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Allow the browser to start the download before revoking.
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 5000);
    } catch (e) {
      // Fallback: if CORS prevents fetching, open the url (may navigate to Hippius).
      console.error(e);
      window.open(url, '_blank', 'noopener,noreferrer');
    }
  };

  const getFilenameFromAudioUrl = (url: string, fallbackExt = 'wav') => {
    try {
      const u = new URL(url);
      const last = u.pathname.split('/').pop() || '';
      const m = last.match(/\.([a-zA-Z0-9]+)$/);
      const ext = m?.[1]?.toLowerCase();
      return ext || fallbackExt;
    } catch {
      return fallbackExt;
    }
  };

  useEffect(() => {
    if (!user) {
      navigate('/');
      return;
    }

    dashboardApi
      .getStudioHistory(user.id)
      .then((res) => {
        const items: HistoryItem[] = res.items.map((item) => {
          const created = new Date(item.created_at);
          const type: HistoryItem['type'] =
            item.entry_type === 'stt'
              ? 'stt'
              : item.entry_type === 'clone'
                ? 'cloning'
                : item.entry_type === 'voice_design'
                  ? 'voice_design'
                  : 'tts';
          const isCloneLike = item.entry_type === 'clone' || item.entry_type === 'voice_design';
          return {
            id: `api-${item.id}`,
            type,
            timestamp: created.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            date: created.toLocaleDateString(),
            content: isCloneLike
              ? item.target_text || item.prompt_text || ''
              : item.entry_type === 'stt'
                ? item.transcribed_text || item.source_audio_filename || ''
                : item.prompt_text || '',
            stylePrompt: isCloneLike
              ? (item.reference_text || '').slice(0, 120) + ((item.reference_text || '').length > 120 ? '…' : '')
              : item.entry_type === 'stt'
                ? item.source_language || 'auto-detect'
                : item.style_instruction,
            model: item.display_name,
            meta:
              item.entry_type === 'voice_design'
                ? 'Voice Design · My voice'
                : item.entry_type === 'clone'
                  ? `Studio Clone · ${item.clone_source || 'ref'}`
                  : item.entry_type === 'stt'
                    ? item.source_audio_filename || 'Studio STT'
                    : 'Studio TTS',
            duration: item.duration_seconds != null ? `${item.duration_seconds.toFixed(1)}s` : '—',
            audioUrl: item.audio_url,
            expired: item.expired,
            resultQuery:
              item.entry_type === 'clone'
                ? '?entry_type=clone'
                : item.entry_type === 'voice_design'
                  ? '?entry_type=voice_design'
                  : item.entry_type === 'music'
                    ? '?entry_type=music'
                    : '',
          };
        });
        setHistory(items);
      })
      .catch(() => setHistory([]));
  }, [user, navigate]);

  const filteredHistory = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return history.filter((item) => {
      const matchesSearch =
        !q ||
        item.content.toLowerCase().includes(q) ||
        (item.stylePrompt?.toLowerCase().includes(q) ?? false) ||
        item.model.toLowerCase().includes(q) ||
        item.meta.toLowerCase().includes(q);
      const matchesFilter = filterType === 'all' || item.type === filterType;
      return matchesSearch && matchesFilter;
    });
  }, [history, searchQuery, filterType]);

  const totalHistoryPages = Math.max(1, Math.ceil(filteredHistory.length / HISTORY_PAGE_SIZE));
  const safeHistoryPage = Math.min(historyPage, totalHistoryPages);
  const paginatedHistory = useMemo(() => {
    const start = (safeHistoryPage - 1) * HISTORY_PAGE_SIZE;
    return filteredHistory.slice(start, start + HISTORY_PAGE_SIZE);
  }, [filteredHistory, safeHistoryPage]);

  useEffect(() => {
    setHistoryPage(1);
  }, [filterType, searchQuery]);

  useEffect(() => {
    setHistoryPage((p) => Math.min(p, totalHistoryPages));
  }, [totalHistoryPages]);

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'tts':
        return 'bg-[#DFFF00]/15 text-[#DFFF00]';
      case 'stt':
        return 'bg-green-500/15 text-green-400';
      case 'cloning':
        return 'bg-cyan-500/15 text-cyan-400';
      case 'voice_design':
        return 'bg-violet-500/15 text-violet-400';
      default:
        return 'bg-white/10 text-white';
    }
  };

  const getTypeLabel = (type: HistoryItem['type']) => {
    switch (type) {
      case 'cloning':
        return 'CLONE';
      case 'voice_design':
        return 'MY VOICE';
      default:
        return type.toUpperCase();
    }
  };

  return (
    <div className="min-h-screen bg-[#07080A] pt-24 pb-12 px-6 lg:px-8">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-4 mb-8">
          <button
            onClick={() => navigate(-1)}
            className="p-2 hover:bg-white/10 rounded-lg transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h1 className="text-3xl font-semibold">History</h1>
            <p className="text-[#A7B0B7]">View and manage all your creations</p>
          </div>
        </div>

        {/* Search and Filters */}
        <div className="card-vocence p-4 mb-6">
          <div className="flex flex-wrap gap-4">
            <div className="flex-1 min-w-[200px] bg-[#0a0a0a] border border-white/10 rounded-lg px-4 py-2 flex items-center gap-2">
              <Search size={16} className="text-[#666]" />
              <input
                type="text"
                placeholder="Search prompts or text content..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1 bg-transparent text-sm outline-none text-white placeholder-[#666]"
              />
            </div>
            <Select value={filterType} onValueChange={setFilterType}>
              <SelectTrigger className="w-[180px] bg-[#0a0a0a] border-white/10 rounded-lg px-3 py-2 text-sm text-white hover:bg-[#111] focus:border-[#DFFF00]/50 focus:ring-[#DFFF00]/20 data-[state=open]:border-[#DFFF00]/50">
                <SelectValue placeholder="All Types" />
              </SelectTrigger>
              <SelectContent
                position="popper"
                sideOffset={4}
                className="bg-[#0a0a0a] border-white/10 text-white [&_*]:text-white [&_[data-slot=select-item]]:focus:!bg-transparent [&_[data-slot=select-item]]:data-[state=checked]:!bg-[#DFFF00]/15 [&_[data-slot=select-item]]:data-[state=checked]:!text-[#DFFF00] [&_[data-slot=select-item]]:data-[highlighted]:data-[state=unchecked]:!bg-white/[0.06] [&_[data-slot=select-item]]:data-[highlighted]:data-[state=unchecked]:!text-white [&_[data-slot=select-item]]:data-[highlighted]:data-[state=checked]:!bg-[#DFFF00]/15 [&_[data-slot=select-item]]:data-[highlighted]:data-[state=checked]:!text-[#DFFF00]"
              >
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="tts">Text-to-Speech</SelectItem>
                <SelectItem value="stt">Speech-to-Text</SelectItem>
                <SelectItem value="cloning">Voice clone</SelectItem>
                <SelectItem value="voice_design">My voice (Voice Design)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* History Table */}
        {filteredHistory.length === 0 ? (
          <div className="card-vocence p-12 text-center">
            <p className="text-[#A7B0B7] mb-4">No history found</p>
            <p className="text-sm text-[#666]">
              {history.length === 0
                ? "You haven't generated any TTS yet. Use Studio → Text-to-Speech to create audio."
                : 'Try adjusting your search or filter criteria.'}
            </p>
          </div>
        ) : (
          <div className="card-vocence overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-[#666] uppercase bg-white/5">
                  <tr>
                    <th className="px-4 py-3 text-left">Timestamp</th>
                    <th className="px-4 py-3 text-left">Type</th>
                    <th className="px-4 py-3 text-left">Content</th>
                    <th className="px-4 py-3 text-left">Style Prompt</th>
                    <th className="px-4 py-3 text-left">Model & Meta</th>
                    <th className="px-4 py-3 text-left">Duration</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {paginatedHistory.map((item) => (
                    <tr key={item.id} className="hover:bg-white/5 transition-colors">
                      <td className="px-4 py-4">
                        <div className="font-medium">{item.timestamp}</div>
                        <div className="text-xs text-[#666]">{item.date}</div>
                      </td>
                      <td className="px-4 py-4">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] font-medium ${getTypeColor(
                            item.type
                          )}`}
                        >
                          {getTypeLabel(item.type)}
                        </span>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          <span className="truncate max-w-[200px]">{item.content}</span>
                          <button className="text-[#666] hover:text-white" onClick={() => navigator.clipboard.writeText(item.content)} title="Copy">
                            <Copy size={14} />
                          </button>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          <span className="text-[#A7B0B7] truncate max-w-[150px]">
                            {item.stylePrompt || '-'}
                          </span>
                          {item.stylePrompt && (
                            <button className="text-[#666] hover:text-white" onClick={() => navigator.clipboard.writeText(item.stylePrompt!)} title="Copy">
                              <Copy size={14} />
                            </button>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex gap-2">
                          <span className="px-2 py-1 bg-[#0a0a0a] rounded text-xs">
                            {item.model}
                          </span>
                          <span className="px-2 py-1 bg-[#0a0a0a] rounded text-xs">
                            {item.meta}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-4">
                        <div className="flex items-center gap-2">
                          {(item.type === 'tts' || item.type === 'cloning' || item.type === 'voice_design') && (
                            <div className="flex items-center gap-1 h-5">
                              {Array.from({ length: 8 }).map((_, i) => (
                                <div
                                  key={i}
                                  className="w-0.5 bg-[#DFFF00] rounded-full"
                                  style={{ height: `${30 + Math.random() * 70}%` }}
                                />
                              ))}
                            </div>
                          )}
                          <span className="text-xs">{item.duration}</span>
                        </div>
                      </td>
                      <td className="px-4 py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {item.audioUrl != null && !item.expired ? (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  navigate(
                                    `/studio/result/${item.id.replace(/^api-/, '')}${item.resultQuery || ''}`
                                  )
                                }
                                className="p-1.5 text-[#666] hover:text-white"
                                title="Play"
                              >
                                <Play size={16} />
                              </button>
                              <button
                                type="button"
                                className="p-1.5 text-[#666] hover:text-white"
                                title="Download"
                                onClick={() => {
                                  const rawId = item.id.replace(/^api-/, '');
                                  const ext = getFilenameFromAudioUrl(item.audioUrl || '');
                                  const filename =
                                    item.type === 'cloning'
                                      ? `vocence-clone-${rawId}.${ext}`
                                      : item.type === 'voice_design'
                                        ? `vocence-voice-design-${rawId}.${ext}`
                                        : `vocence-${item.type}-${rawId}.${ext}`;
                                  void triggerBrowserDownload(item.audioUrl || '', filename);
                                }}
                              >
                                <Download size={16} />
                              </button>
                            </>
                          ) : item.expired ? (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  navigate(
                                    `/studio/result/${item.id.replace(/^api-/, '')}${item.resultQuery || ''}`
                                  )
                                }
                                className="p-1.5 text-[#666] hover:text-white"
                                title="View result"
                              >
                                <Play size={16} />
                              </button>
                              <span className="text-xs text-[#666]">Expired</span>
                            </>
                          ) : (
                            <>
                              <button className="p-1.5 text-[#666] hover:text-white" title="Play" disabled>
                                <Play size={16} />
                              </button>
                              <button className="p-1.5 text-[#666] hover:text-white" title="Download" disabled>
                                <Download size={16} />
                              </button>
                            </>
                          )}
                          <button className="p-1.5 text-[#666] hover:text-white">
                            <MoreHorizontal size={16} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {filteredHistory.length > HISTORY_PAGE_SIZE && (
              <div className="p-4 border-t border-white/5 flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm text-[#A7B0B7]">
                  Showing{' '}
                  {(safeHistoryPage - 1) * HISTORY_PAGE_SIZE + 1}-
                  {Math.min(safeHistoryPage * HISTORY_PAGE_SIZE, filteredHistory.length)} of{' '}
                  {filteredHistory.length} items
                </span>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-[#666]">
                    Page {safeHistoryPage} / {totalHistoryPages}
                  </span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={safeHistoryPage <= 1}
                      onClick={() => setHistoryPage((p) => Math.max(1, p - 1))}
                      className="px-3 py-1.5 rounded-lg text-sm border border-white/10 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      disabled={safeHistoryPage >= totalHistoryPages}
                      onClick={() => setHistoryPage((p) => Math.min(totalHistoryPages, p + 1))}
                      className="px-3 py-1.5 rounded-lg text-sm border border-white/10 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-white/5"
                    >
                      Next
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

