import { useState, useEffect } from 'react';
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

interface HistoryItem {
  id: string;
  type: 'tts' | 'stt' | 'cloning' | 'chat';
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
}

export function History() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');

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
          return {
            id: `api-${item.id}`,
            type: 'tts' as const,
            timestamp: created.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            date: created.toLocaleDateString(),
            content: item.prompt_text,
            stylePrompt: item.style_instruction,
            model: item.display_name,
            meta: 'Studio',
            duration: '—',
            audioUrl: item.audio_url,
            expired: item.expired,
          };
        });
        setHistory(items);
      })
      .catch(() => setHistory([]));
  }, [user, navigate]);

  const filteredHistory = history.filter((item) => {
    const matchesSearch =
      item.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
      item.stylePrompt?.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = filterType === 'all' || item.type === filterType;
    return matchesSearch && matchesFilter;
  });

  const getTypeColor = (type: string) => {
    switch (type) {
      case 'tts':
        return 'bg-[#DFFF00]/15 text-[#DFFF00]';
      case 'stt':
        return 'bg-green-500/15 text-green-400';
      case 'cloning':
        return 'bg-blue-500/15 text-blue-400';
      case 'chat':
        return 'bg-purple-500/15 text-purple-400';
      default:
        return 'bg-white/10 text-white';
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
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="bg-[#0a0a0a] border border-white/10 rounded-lg px-3 py-2 text-sm text-white"
            >
              <option value="all">All Types</option>
              <option value="tts">Text-to-Speech</option>
              <option value="stt">Speech-to-Text</option>
              <option value="cloning">Voice Cloning</option>
              <option value="chat">Voice Chat</option>
            </select>
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
                  {filteredHistory.map((item) => (
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
                          {item.type.toUpperCase()}
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
                          {item.type === 'tts' && (
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
                              <a href={item.audioUrl} target="_blank" rel="noopener noreferrer" className="p-1.5 text-[#666] hover:text-white" title="Play">
                                <Play size={16} />
                              </a>
                              <a href={item.audioUrl} download className="p-1.5 text-[#666] hover:text-white" title="Download">
                                <Download size={16} />
                              </a>
                            </>
                          ) : item.expired ? (
                            <span className="text-xs text-[#666]">Expired</span>
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
            {filteredHistory.length > 10 && (
              <div className="p-4 border-t border-white/5 flex items-center justify-between">
                <span className="text-sm text-[#A7B0B7]">
                  Showing 1-{Math.min(10, filteredHistory.length)} of {filteredHistory.length}{' '}
                  items
                </span>
                <div className="flex gap-2">
                  {[1, 2, 3].map((page) => (
                    <button
                      key={page}
                      className={`w-8 h-8 rounded-lg text-sm ${
                        page === 1
                          ? 'bg-white/10 text-white'
                          : 'bg-transparent border border-white/10 text-[#666] hover:text-white'
                      }`}
                    >
                      {page}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

