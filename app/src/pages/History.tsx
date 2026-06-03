import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useStudioPlayer } from '../contexts/StudioPlayerContext';
import {
  ArrowLeft,
  Search,
  Copy,
  Play,
  Pause,
  Download,
  MoreHorizontal,
  ChevronDown,
  ChevronRight,
  Check,
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
  type: 'tts' | 'stt' | 'cloning' | 'voice_design' | 'music' | 'noise_remover';
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
  /** Music-only: the generation mode (text2music, retake, repaint, edit, extend, audio2audio). */
  musicTask?: string;
  /** Music-only: full lyrics block as it was sent to the engine. */
  lyrics?: string;
  /** Music-only: parsed mode-specific params. The set of keys depends on
   *  ``musicTask``, retake has variance/seeds, repaint has start/end,
   *  edit has target_prompt/target_lyrics, extend has left/right, etc. */
  musicMeta?: Record<string, unknown>;
}

export function History() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const player = useStudioPlayer();
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [historyPage, setHistoryPage] = useState(1);
  // Music rows have rich per-task metadata (prompt, lyrics, mode-specific
  // params) that would clutter the table if we showed it inline. We
  // store the set of expanded row ids and render a details panel right
  // below each expanded music row. Only music rows are expandable; tts/
  // stt/clone keep the same flat shape they had before.
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const toggleExpanded = (id: string) =>
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  // Track which field was most recently copied (per row) so the icon
  // briefly flips to a checkmark, small affordance that makes copy
  // feel responsive.
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyValue = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey((c) => (c === key ? null : c)), 1200);
    } catch { /* clipboard unavailable */ }
  };

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
                  : item.entry_type === 'music'
                    ? 'music'
                    : item.entry_type === 'noise_remover' || item.entry_type === 'dubbing'
                      ? 'noise_remover'
                      : 'tts';
          const isCloneLike = item.entry_type === 'clone' || item.entry_type === 'voice_design';
          // Parse music metadata into a plain object so the expandable
          // row can render task-specific fields without each consumer
          // re-parsing the JSON string. Empty / unparsable → {}.
          let musicMeta: Record<string, unknown> | undefined;
          if (item.entry_type === 'music') {
            try {
              musicMeta = JSON.parse(item.music_metadata_json || '{}');
            } catch {
              musicMeta = {};
            }
          }
          const musicTaskLabel = item.music_task
            ? item.music_task.replace('2', ' to ').replace('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase())
            : '';
          return {
            id: `api-${item.id}`,
            type,
            timestamp: created.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
            date: created.toLocaleDateString(),
            content: isCloneLike
              ? item.target_text || item.prompt_text || ''
              : item.entry_type === 'stt'
                ? item.transcribed_text || item.source_audio_filename || ''
                : item.entry_type === 'noise_remover'
                  ? item.source_audio_filename || 'Audio enhancement'
                  : item.prompt_text || '',
            stylePrompt: isCloneLike
              ? (item.reference_text || '').slice(0, 120) + ((item.reference_text || '').length > 120 ? '…' : '')
              : item.entry_type === 'stt'
                ? item.source_language || 'auto-detect'
                : item.entry_type === 'music'
                  ? musicTaskLabel
                  : item.entry_type === 'noise_remover'
                    ? 'Noise reduction'
                    : item.style_instruction,
            model: item.display_name,
            meta:
              item.entry_type === 'voice_design'
                ? 'Voice Design · My voice'
                : item.entry_type === 'clone'
                  ? `Studio Clone · ${item.clone_source || 'ref'}`
                  : item.entry_type === 'stt'
                    ? item.source_audio_filename || 'Studio STT'
                    : item.entry_type === 'music'
                      ? `Studio Music · ${musicTaskLabel}`
                      : item.entry_type === 'noise_remover'
                        ? 'Noise Remover · DeepFilterNet'
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
                    : item.entry_type === 'noise_remover'
                      ? '?entry_type=noise_remover'
                      : '',
            musicTask: item.music_task || undefined,
            lyrics: item.lyrics || undefined,
            musicMeta,
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
      case 'music':
        return 'bg-pink-500/15 text-pink-300';
      case 'noise_remover':
        return 'bg-amber-500/15 text-amber-300';
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
      case 'music':
        return 'MUSIC';
      case 'noise_remover':
        return 'NOISE REMOVER';
      default:
        return type.toUpperCase();
    }
  };

  // Renders one labeled row inside the music-detail panel with a
  // copy-to-clipboard button. The ``key`` makes copy feedback
  // per-field instead of per-row, so the user sees which field they
  // just copied.
  const renderDetailRow = (rowId: string, label: string, value: string, monospace = false) => {
    const fieldKey = `${rowId}:${label}`;
    if (!value) return null;
    const copied = copiedKey === fieldKey;
    return (
      <div className="flex items-start gap-3 py-1.5">
        <div className="text-[10px] uppercase tracking-wider text-[#666] w-32 shrink-0 pt-0.5">{label}</div>
        <div className={`flex-1 min-w-0 text-sm text-[#C5CAD1] ${monospace ? 'font-mono text-xs' : ''} whitespace-pre-wrap break-words`}>
          {value}
        </div>
        <button
          type="button"
          onClick={() => copyValue(fieldKey, value)}
          className={`shrink-0 inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border transition-colors ${
            copied
              ? 'border-[#DFFF00]/40 text-[#DFFF00] bg-[#DFFF00]/10'
              : 'border-white/10 text-[#A7B0B7] hover:text-white hover:border-white/30'
          }`}
          title={`Copy ${label.toLowerCase()}`}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    );
  };

  // Mode-specific fields to show below a music row. Each task has a
  // different set of knobs that mattered for the generation; we list
  // the ones the user can reuse or paste back into Studio.
  const renderMusicDetails = (item: HistoryItem) => {
    if (item.type !== 'music') return null;
    const meta = item.musicMeta || {};
    const task = item.musicTask || 'text2music';
    const rows: { label: string; value: string; mono?: boolean }[] = [
      { label: 'Mode', value: item.stylePrompt || task },
      { label: 'Prompt', value: item.content || '' },
      { label: 'Lyrics', value: item.lyrics || '', mono: true },
    ];
    // Task-specific knobs. Order is "most informative first" so the
    // user's eye lands on the field they're most likely to want to
    // copy back into Studio.
    if (task === 'audio2audio') {
      if (meta.ref_audio_strength != null) rows.push({ label: 'Ref strength', value: String(meta.ref_audio_strength) });
    } else if (task === 'retake') {
      if (meta.retake_variance != null) rows.push({ label: 'Variance', value: String(meta.retake_variance) });
      if (meta.retake_seeds) rows.push({ label: 'Seeds', value: String(meta.retake_seeds) });
    } else if (task === 'repaint') {
      if (meta.repaint_start != null) rows.push({ label: 'Window start', value: `${meta.repaint_start}s` });
      if (meta.repaint_end != null) rows.push({ label: 'Window end', value: `${meta.repaint_end}s` });
      if (meta.retake_variance != null) rows.push({ label: 'Variance', value: String(meta.retake_variance) });
    } else if (task === 'edit') {
      if (meta.edit_target_prompt) rows.push({ label: 'Target prompt', value: String(meta.edit_target_prompt) });
      if (meta.edit_target_lyrics) rows.push({ label: 'Target lyrics', value: String(meta.edit_target_lyrics), mono: true });
      if (meta.edit_n_min != null) rows.push({ label: 'n_min', value: String(meta.edit_n_min) });
      if (meta.edit_n_max != null) rows.push({ label: 'n_max', value: String(meta.edit_n_max) });
    } else if (task === 'extend') {
      if (meta.left_extend_length != null) rows.push({ label: 'Left (sec)', value: String(meta.left_extend_length) });
      if (meta.right_extend_length != null) rows.push({ label: 'Right (sec)', value: String(meta.right_extend_length) });
      if (meta.extend_seeds) rows.push({ label: 'Seeds', value: String(meta.extend_seeds) });
    }
    // Common engine knobs, last, most users won't care, but power users want them.
    if (meta.infer_step != null) rows.push({ label: 'Infer step', value: String(meta.infer_step) });
    if (meta.guidance_scale != null) rows.push({ label: 'Guidance', value: String(meta.guidance_scale) });
    return (
      <div className="bg-white/[0.02] border-t border-white/5 px-6 py-3">
        <div className="text-[10px] uppercase tracking-wider text-[#666] mb-2">Generation details</div>
        <div className="space-y-0">
          {rows.map((r) => renderDetailRow(item.id, r.label, r.value, r.mono))}
        </div>
      </div>
    );
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
                <SelectItem value="music">Music</SelectItem>
                <SelectItem value="noise_remover">Noise Remover</SelectItem>
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
                  {paginatedHistory.flatMap((item) => {
                    const isMusic = item.type === 'music';
                    const isExpanded = isMusic && expandedIds.has(item.id);
                    const rows = [
                    <tr
                      key={item.id}
                      className={`hover:bg-white/5 transition-colors ${isMusic ? 'cursor-pointer' : ''}`}
                      onClick={isMusic ? () => toggleExpanded(item.id) : undefined}
                    >
                      <td className="px-4 py-4">
                        <div className="font-medium flex items-center gap-1.5">
                          {isMusic && (
                            isExpanded ? <ChevronDown size={14} className="text-[#A7B0B7]" /> : <ChevronRight size={14} className="text-[#A7B0B7]" />
                          )}
                          {item.timestamp}
                        </div>
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
                          <button
                            className="text-[#666] hover:text-white"
                            onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(item.content); }}
                            title="Copy"
                          >
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
                            <button
                              className="text-[#666] hover:text-white"
                              onClick={(e) => { e.stopPropagation(); navigator.clipboard.writeText(item.stylePrompt!); }}
                              title="Copy"
                            >
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
                      <td
                        className="px-4 py-4 text-right"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center justify-end gap-2">
                          {item.audioUrl != null && !item.expired ? (
                            <>
                              {(() => {
                                const isThis = !!item.audioUrl && player.track?.src === item.audioUrl;
                                const isPlaying = isThis && player.playing;
                                const onPlayPause = () => {
                                  if (!item.audioUrl) return;
                                  if (isPlaying) { player.pause(); return; }
                                  if (isThis) { player.resume(); return; }
                                  const rawId = item.id.replace(/^api-/, '');
                                  const ext = getFilenameFromAudioUrl(item.audioUrl);
                                  const downloadFilename =
                                    item.type === 'cloning'
                                      ? `vocence-clone-${rawId}.${ext}`
                                      : item.type === 'voice_design'
                                        ? `vocence-voice-design-${rawId}.${ext}`
                                        : `vocence-${item.type}-${rawId}.${ext}`;
                                  player.play({
                                    src: item.audioUrl,
                                    title: item.content?.slice(0, 80) || `${item.type.toUpperCase()} result`,
                                    subtitle: item.model,
                                    downloadFilename,
                                  });
                                };
                                return (
                                  <button
                                    type="button"
                                    onClick={onPlayPause}
                                    className={`p-1.5 transition-colors ${
                                      isPlaying ? 'text-[#DFFF00]' : 'text-[#666] hover:text-white'
                                    }`}
                                    title={isPlaying ? 'Pause' : 'Play'}
                                    aria-label={isPlaying ? 'Pause' : 'Play'}
                                  >
                                    {isPlaying ? <Pause size={16} /> : <Play size={16} />}
                                  </button>
                                );
                              })()}
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
                    </tr>,
                    ];
                    if (isExpanded) {
                      rows.push(
                        <tr key={`${item.id}-details`} className="bg-[#0a0a0a]">
                          <td colSpan={7} className="p-0">
                            {renderMusicDetails(item)}
                          </td>
                        </tr>,
                      );
                    }
                    return rows;
                  })}
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

