import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Plus, Play, Pause, Trash2, Upload, Music, X, GripVertical,
  Shuffle, ListMusic, Globe, Lock, Check,
} from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useStudioPlayer, type Track } from '../contexts/StudioPlayerContext';
import {
  dashboardApi,
  type Playbook,
  type PlaybookDetail,
  type PublicPlaybook,
  type StudioMusicHistoryItem,
} from '../services/dashboardApi';

/* ==========================================================================
   Sample tracks (same as StudioMusic page)
   ========================================================================== */
const SAMPLE_TRACKS = [
  { title: 'Neon Nights', subtitle: 'pop, synth, 120 bpm', audioSrc: '/samples/audios/pop.wav', image: '/samples/images/music_1.webp' },
  { title: 'Rebel Road', subtitle: 'rock, guitar, 130 bpm', audioSrc: '/samples/audios/rock.wav', image: '/samples/images/music_2.webp' },
  { title: 'Urban Flow', subtitle: 'hip hop, 808, 90 bpm', audioSrc: '/samples/audios/street.wav', image: '/samples/images/music_3.webp' },
  { title: 'Pulse Drop', subtitle: 'edm, synth, 128 bpm', audioSrc: '/samples/audios/club.wav', image: '/samples/images/music_4.webp' },
  { title: 'Midnight Blues', subtitle: 'jazz, sax, 110 bpm', audioSrc: '/samples/audios/jazz.wav', image: '/samples/images/music_5.webp' },
  { title: 'Final Boss', subtitle: 'orchestral, 60 bpm', audioSrc: '/samples/audios/orchestral.wav', image: '/samples/images/music_6.webp' },
  { title: 'Code & Coffee', subtitle: 'lo-fi, chill, 75 bpm', audioSrc: '/samples/audios/chill.wav', image: '/samples/images/music_7.webp' },
  { title: 'Velvet Touch', subtitle: 'r&b, soulful, 85 bpm', audioSrc: '/samples/audios/soundful.wav', image: '/samples/images/music_8.webp' },
];

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/* ==========================================================================
   PLAYBOOK LIST VIEW
   ========================================================================== */
export function StudioPlaybooks() {
  const { playbookId } = useParams<{ playbookId?: string }>();

  if (playbookId) {
    return <PlaybookDetailView playbookId={Number(playbookId)} />;
  }
  return <PlaybookListView />;
}

function PlaybookListView() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { playQueue } = useStudioPlayer();
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [publicPlaybooks, setPublicPlaybooks] = useState<PublicPlaybook[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const token = localStorage.getItem('vocence_token');

  const load = useCallback(async () => {
    try {
      const [myRes, pubRes] = await Promise.all([
        token ? dashboardApi.listPlaybooks(token) : Promise.resolve({ playbooks: [] }),
        dashboardApi.browsePublicPlaybooks(12),
      ]);
      setPlaybooks(myRes.playbooks);
      setPublicPlaybooks(pubRes.playbooks);
    } catch { /* */ }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const handleCreate = async () => {
    if (!token) return;
    setCreating(true);
    try {
      const pb = await dashboardApi.createPlaybook({ title: 'Untitled Playbook' }, token);
      navigate(`/studio/playbooks/${pb.id}`);
    } catch { /* */ }
    finally { setCreating(false); }
  };

  const handlePlayAll = async (pb: Playbook) => {
    if (!token || pb.track_count === 0) return;
    try {
      const detail = await dashboardApi.getPlaybook(pb.id, token);
      const tracks: Track[] = detail.tracks.map(t => ({
        src: t.audio_url, title: t.title, subtitle: t.subtitle, image: t.image_url || undefined,
      }));
      playQueue(tracks, 0, pb.title);
    } catch { /* */ }
  };

  if (!user) {
    return (
      <div className="text-center py-20">
        <ListMusic size={40} className="mx-auto text-[#333] mb-3" />
        <p className="text-[#666]">Sign in to create playbooks.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">Playbooks</h2>
          <p className="text-sm text-[#666] mt-1">Collect and organize your tracks into playlists.</p>
        </div>
        <button
          onClick={handleCreate}
          disabled={creating}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white text-[#07080A] text-sm font-semibold hover:bg-white/90 transition-colors disabled:opacity-50"
        >
          <Plus size={16} />
          New Playbook
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20 text-[#666]">Loading...</div>
      ) : playbooks.length === 0 ? (
        <div className="text-center py-20 border border-dashed border-[#2e2f33] rounded-2xl">
          <ListMusic size={48} className="mx-auto text-[#333] mb-4" />
          <p className="text-[#666] mb-4">No playbooks yet</p>
          <button
            onClick={handleCreate}
            className="px-5 py-2 rounded-xl bg-white text-[#07080A] text-sm font-semibold hover:bg-white/90"
          >
            Create your first playbook
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {playbooks.map((pb) => (
            <div
              key={pb.id}
              onClick={() => navigate(`/studio/playbooks/${pb.id}`)}
              className="rounded-2xl border border-[#2e2f33] bg-[#111215] p-4 cursor-pointer hover:border-[#444] transition-all group"
            >
              {/* Cover */}
              <div className="aspect-square rounded-xl bg-gradient-to-br from-[#1c1d21] to-[#111215] mb-3 flex items-center justify-center relative overflow-hidden">
                <img loading="lazy" src={`/samples/images/music_${(pb.id % 8) + 1}.webp`} alt="" className="absolute inset-0 w-full h-full object-cover opacity-60 group-hover:scale-105 transition-transform duration-300" />
                <button
                  onClick={(e) => { e.stopPropagation(); handlePlayAll(pb); }}
                  className="absolute bottom-2 right-2 w-10 h-10 rounded-full bg-[#DFFF00] text-[#07080A] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all hover:scale-105 shadow-lg"
                >
                  <Play size={16} className="ml-0.5" />
                </button>
              </div>
              <h3 className="text-sm font-semibold text-white truncate">{pb.title}</h3>
              <p className="text-xs text-[#666] mt-0.5">
                {pb.track_count} track{pb.track_count !== 1 ? 's' : ''} · {formatDuration(pb.total_duration)}
              </p>
            </div>
          ))}
        </div>
      )}

      {/* Public playbooks */}
      {publicPlaybooks.length > 0 && (
        <div className="pt-6 border-t border-[#2e2f33]">
          <div className="flex items-center gap-2 mb-4">
            <Globe size={14} className="text-[#666]" />
            <h3 className="text-sm font-semibold text-white">Community Playbooks</h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {publicPlaybooks.map((pb) => (
              <div
                key={pb.id}
                onClick={() => navigate(`/studio/playbooks/${pb.id}`)}
                className="rounded-2xl border border-[#2e2f33] bg-[#111215] p-4 cursor-pointer hover:border-[#444] transition-all group"
              >
                <div className="aspect-video rounded-xl bg-gradient-to-br from-[#1c1d21] to-[#111215] mb-3 relative overflow-hidden">
                  <img loading="lazy" src={`/samples/images/music_${(pb.id % 8) + 1}.webp`} alt="" className="absolute inset-0 w-full h-full object-cover opacity-60 group-hover:scale-105 transition-transform duration-300" />
                  <button
                    onClick={(e) => { e.stopPropagation(); handlePlayAll(pb); }}
                    className="absolute bottom-2 right-2 w-9 h-9 rounded-full bg-[#DFFF00] text-[#07080A] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all hover:scale-105 shadow-lg"
                  >
                    <Play size={14} className="ml-0.5" />
                  </button>
                </div>
                <h3 className="text-sm font-semibold text-white truncate">{pb.title}</h3>
                <div className="flex items-center gap-2 mt-1">
                  {pb.user_picture && (
                    <img src={pb.user_picture} alt="" className="w-4 h-4 rounded-full" />
                  )}
                  <span className="text-xs text-[#666] truncate">{pb.user_name}</span>
                  <span className="text-xs text-[#444]">·</span>
                  <span className="text-xs text-[#666]">{pb.track_count} track{pb.track_count !== 1 ? 's' : ''}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   PLAYBOOK DETAIL VIEW
   ========================================================================== */
function PlaybookDetailView({ playbookId }: { playbookId: number }) {
  const navigate = useNavigate();
  useAuth(); // ensure auth context available
  const { track: currentTrack, playing, pause, resume, playQueue } = useStudioPlayer();
  const [playbook, setPlaybook] = useState<PlaybookDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleVal, setTitleVal] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);

  const token = localStorage.getItem('vocence_token');

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const pb = await dashboardApi.getPlaybook(playbookId, token);
      setPlaybook(pb);
      setTitleVal(pb.title);
    } catch { navigate('/studio/playbooks'); }
    finally { setLoading(false); }
  }, [playbookId, token, navigate]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (editingTitle && titleRef.current) titleRef.current.focus();
  }, [editingTitle]);

  const handleTitleSave = async () => {
    setEditingTitle(false);
    if (!token || !playbook || titleVal.trim() === playbook.title) return;
    await dashboardApi.updatePlaybook(playbook.id, { title: titleVal.trim() }, token);
    setPlaybook(p => p ? { ...p, title: titleVal.trim() } : p);
  };

  const handleDelete = async () => {
    if (!token || !playbook || !confirm('Delete this playbook?')) return;
    await dashboardApi.deletePlaybook(playbook.id, token);
    navigate('/studio/playbooks');
  };

  const handleRemoveTrack = async (trackId: number) => {
    if (!token || !playbook) return;
    await dashboardApi.removePlaybookTrack(playbook.id, trackId, token);
    setPlaybook(p => p ? { ...p, tracks: p.tracks.filter(t => t.id !== trackId), track_count: p.track_count - 1 } : p);
  };

  const handlePlayAll = (startIdx = 0) => {
    if (!playbook || playbook.tracks.length === 0) return;
    const tracks: Track[] = playbook.tracks.map(t => ({
      src: t.audio_url, title: t.title, subtitle: t.subtitle, image: t.image_url || undefined,
    }));
    playQueue(tracks, startIdx, playbook.title);
  };

  const [showPublicConfirm, setShowPublicConfirm] = useState(false);

  const handleToggleVisibility = async () => {
    if (!token || !playbook) return;
    if (playbook.visibility === 'private') {
      // Going public — show confirmation first
      setShowPublicConfirm(true);
      return;
    }
    // Going private — no confirmation needed
    await dashboardApi.updatePlaybook(playbook.id, { visibility: 'private' }, token);
    setPlaybook(p => p ? { ...p, visibility: 'private' } : p);
  };

  const confirmMakePublic = async () => {
    if (!token || !playbook) return;
    await dashboardApi.updatePlaybook(playbook.id, { visibility: 'public' }, token);
    setPlaybook(p => p ? { ...p, visibility: 'public' } : p);
    setShowPublicConfirm(false);
  };

  if (loading) return <div className="flex items-center justify-center py-20 text-[#666]">Loading...</div>;
  if (!playbook) return null;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start gap-5">
        <div className="w-32 h-32 rounded-xl bg-gradient-to-br from-[#1c1d21] to-[#111215] flex items-center justify-center shrink-0 overflow-hidden relative">
          <img loading="lazy" src={`/samples/images/music_${(playbookId % 8) + 1}.webp`} alt="" className="absolute inset-0 w-full h-full object-cover opacity-70" />
        </div>
        <div className="flex-1 min-w-0 pt-2">
          {editingTitle ? (
            <input
              ref={titleRef}
              value={titleVal}
              onChange={(e) => setTitleVal(e.target.value)}
              onBlur={handleTitleSave}
              onKeyDown={(e) => e.key === 'Enter' && handleTitleSave()}
              className="text-2xl font-bold bg-transparent border-b border-[#DFFF00] outline-none text-white w-full"
            />
          ) : (
            <h2
              className="text-2xl font-bold cursor-pointer hover:text-[#DFFF00] transition-colors"
              onClick={() => setEditingTitle(true)}
            >
              {playbook.title}
            </h2>
          )}
          <p className="text-sm text-[#666] mt-1">
            {playbook.track_count} track{playbook.track_count !== 1 ? 's' : ''} · {formatDuration(playbook.total_duration)}
          </p>
          <div className="flex items-center gap-2 mt-3">
            <button
              onClick={() => handlePlayAll()}
              disabled={playbook.tracks.length === 0}
              className="flex items-center gap-2 px-5 py-2 rounded-xl bg-[#DFFF00] text-[#07080A] text-sm font-semibold hover:brightness-110 disabled:opacity-50 transition-all"
            >
              <Play size={14} className="ml-0.5" /> Play All
            </button>
            <button
              onClick={() => { handlePlayAll(); /* shuffle handled by player */ }}
              disabled={playbook.tracks.length === 0}
              className="flex items-center gap-2 px-4 py-2 rounded-xl border border-[#2e2f33] text-sm text-[#9ca3af] hover:text-white hover:border-[#444] transition-colors"
            >
              <Shuffle size={14} /> Shuffle
            </button>
            <button onClick={() => setShowAddModal(true)} className="flex items-center gap-2 px-4 py-2 rounded-xl border border-[#2e2f33] text-sm text-[#9ca3af] hover:text-white hover:border-[#444] transition-colors">
              <Plus size={14} /> Add Tracks
            </button>
            <button onClick={handleToggleVisibility} className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-[#2e2f33] text-xs text-[#666] hover:text-white hover:border-[#444] transition-colors">
              {playbook.visibility === 'public' ? <Globe size={12} /> : <Lock size={12} />}
              {playbook.visibility === 'public' ? 'Public' : 'Private'}
            </button>
            <button onClick={handleDelete} className="p-2 rounded-xl border border-[#2e2f33] text-[#666] hover:text-red-400 hover:border-red-400/30 transition-colors ml-auto">
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Track list */}
      {playbook.tracks.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-[#2e2f33] rounded-2xl">
          <Music size={32} className="mx-auto text-[#333] mb-3" />
          <p className="text-[#666] mb-4">No tracks yet</p>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-5 py-2 rounded-xl bg-white text-[#07080A] text-sm font-semibold hover:bg-white/90"
          >
            Add Tracks
          </button>
        </div>
      ) : (
        <div className="space-y-1">
          {playbook.tracks.map((t, i) => {
            const isThis = currentTrack?.src === t.audio_url;
            const isPlaying = isThis && playing;
            return (
              <div
                key={t.id}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all group ${
                  isThis ? 'bg-[#1c1d21] border border-[#2e2f33]' : 'hover:bg-[#1c1d21]/50 border border-transparent'
                }`}
              >
                {/* Drag handle */}
                <div className="text-[#333] opacity-0 group-hover:opacity-100 cursor-grab shrink-0">
                  <GripVertical size={14} />
                </div>

                {/* Number / play */}
                <button
                  onClick={() => {
                    if (isPlaying) { pause(); return; }
                    if (isThis) { resume(); return; }
                    handlePlayAll(i);
                  }}
                  className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
                    isPlaying ? 'bg-[#DFFF00] text-[#07080A]' : 'bg-[#1c1d21] text-[#666] group-hover:text-white'
                  }`}
                >
                  {isPlaying ? <Pause size={12} /> : <Play size={12} className="ml-0.5" />}
                </button>

                {/* Image */}
                {t.image_url && (
                  <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0">
                    <img loading="lazy" src={t.image_url} alt="" className="w-full h-full object-cover" />
                  </div>
                )}

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-medium truncate ${isThis ? 'text-[#DFFF00]' : 'text-white/80'}`}>{t.title}</p>
                  {t.subtitle && <p className="text-xs text-[#555] truncate">{t.subtitle}</p>}
                </div>

                {/* Source badge */}
                <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${
                  t.source_type === 'generated' ? 'bg-indigo-500/10 text-indigo-400'
                  : t.source_type === 'uploaded' ? 'bg-amber-500/10 text-amber-400'
                  : 'bg-white/5 text-[#666]'
                }`}>
                  {t.source_type === 'generated' ? 'AI' : t.source_type === 'uploaded' ? 'Upload' : 'Sample'}
                </span>

                {/* Duration */}
                <span className="text-xs text-[#555] tabular-nums shrink-0 w-10 text-right">
                  {t.duration_seconds ? formatDuration(t.duration_seconds) : '--'}
                </span>

                {/* Remove */}
                <button
                  onClick={() => handleRemoveTrack(t.id)}
                  className="text-[#333] hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all shrink-0"
                >
                  <X size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {/* Add tracks modal */}
      {/* Make Public confirmation */}
      {showPublicConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={() => setShowPublicConfirm(false)}>
          <div className="bg-[#111215] border border-[#2e2f33] rounded-2xl w-full max-w-md p-6" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center">
                <Globe size={18} className="text-amber-400" />
              </div>
              <h3 className="text-base font-semibold text-white">Make Playbook Public?</h3>
            </div>
            <div className="space-y-3 text-sm text-[#9ca3af] leading-relaxed mb-6">
              <p>Once public, <span className="text-white font-medium">everyone</span> will be able to see and listen to this playbook and all its tracks.</p>
              <p>Please make sure your playbook content complies with our <a href="/terms" target="_blank" className="text-[#DFFF00] hover:underline">Terms of Service</a> and <a href="/privacy" target="_blank" className="text-[#DFFF00] hover:underline">Privacy Policy</a>. Content that violates these policies may be removed.</p>
              <p className="text-xs text-[#666]">You can switch back to private at any time.</p>
            </div>
            <div className="flex gap-3">
              <button
                onClick={() => setShowPublicConfirm(false)}
                className="flex-1 py-2.5 rounded-xl border border-[#2e2f33] text-sm text-[#9ca3af] hover:text-white hover:border-[#444] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmMakePublic}
                className="flex-1 py-2.5 rounded-xl bg-[#DFFF00] text-[#07080A] text-sm font-semibold hover:brightness-110 transition-all"
              >
                Yes, Make Public
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddModal && (
        <AddTracksModal
          playbookId={playbook.id}
          onClose={() => setShowAddModal(false)}
          onAdded={load}
        />
      )}
    </div>
  );
}

/* ==========================================================================
   ADD TRACKS MODAL
   ========================================================================== */
function AddTracksModal({ playbookId, onClose, onAdded }: { playbookId: number; onClose: () => void; onAdded: () => void }) {
  const { user } = useAuth();
  const [tab, setTab] = useState<'history' | 'samples' | 'upload'>('history');
  const [history, setHistory] = useState<StudioMusicHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const token = localStorage.getItem('vocence_token');

  useEffect(() => {
    if (tab === 'history' && user && history.length === 0) {
      setHistoryLoading(true);
      dashboardApi.getStudioMusicHistory(user.id)
        .then(res => setHistory(res.items))
        .catch(() => {})
        .finally(() => setHistoryLoading(false));
    }
  }, [tab, user, history.length]);

  const toggleSelect = (key: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleAddSelected = async () => {
    if (!token || selected.size === 0) return;
    setAdding(true);
    try {
      const tracks: { title: string; subtitle: string; audio_url: string; image_url?: string; source_type: string }[] = [];

      selected.forEach(key => {
        if (key.startsWith('history:')) {
          const idx = Number(key.split(':')[1]);
          const h = history[idx];
          if (h) tracks.push({ title: h.prompt_text.slice(0, 80) || 'Generated Track', subtitle: h.task, audio_url: h.audio_url || '', source_type: 'generated' });
        } else if (key.startsWith('sample:')) {
          const idx = Number(key.split(':')[1]);
          const s = SAMPLE_TRACKS[idx];
          if (s) tracks.push({ title: s.title, subtitle: s.subtitle, audio_url: s.audioSrc, image_url: s.image, source_type: 'sample' });
        }
      });

      if (tracks.length > 0) {
        await dashboardApi.addPlaybookTracks(playbookId, tracks, token);
        onAdded();
      }
      onClose();
    } catch { /* */ }
    finally { setAdding(false); }
  };

  const handleUpload = async (file: File) => {
    if (!token) return;
    setUploading(true);
    try {
      await dashboardApi.uploadPlaybookTrack(playbookId, file, file.name.replace(/\.[^.]+$/, ''), token);
      onAdded();
      onClose();
    } catch { /* */ }
    finally { setUploading(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div className="bg-[#111215] border border-[#2e2f33] rounded-2xl w-full max-w-xl max-h-[80vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#2e2f33]">
          <h3 className="text-base font-semibold text-white">Add Tracks</h3>
          <button onClick={onClose} className="text-[#666] hover:text-white"><X size={18} /></button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[#2e2f33]">
          {(['history', 'samples', 'upload'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                tab === t ? 'text-white border-b-2 border-[#DFFF00]' : 'text-[#666] hover:text-white'
              }`}
            >
              {t === 'history' ? 'Generation History' : t === 'samples' ? 'Samples' : 'Upload'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'history' && (
            historyLoading ? (
              <p className="text-[#666] text-center py-8">Loading...</p>
            ) : history.length === 0 ? (
              <p className="text-[#666] text-center py-8">No generated music yet. Go to Text-to-Music to create some!</p>
            ) : (
              <div className="space-y-1">
                {history.map((h, i) => {
                  const key = `history:${i}`;
                  const sel = selected.has(key);
                  return (
                    <button
                      key={key}
                      onClick={() => toggleSelect(key)}
                      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all ${
                        sel ? 'bg-[#DFFF00]/[0.06] border border-[#DFFF00]/30' : 'hover:bg-white/[0.03] border border-transparent'
                      }`}
                    >
                      <div className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 ${
                        sel ? 'bg-[#DFFF00] border-[#DFFF00] text-[#07080A]' : 'border-[#444]'
                      }`}>
                        {sel && <Check size={12} />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-white truncate">{h.prompt_text.slice(0, 60) || 'Generated Track'}</p>
                        <p className="text-xs text-[#555]">{h.task} · {h.created_at?.slice(0, 10)}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )
          )}

          {tab === 'samples' && (
            <div className="space-y-1">
              {SAMPLE_TRACKS.map((s, i) => {
                const key = `sample:${i}`;
                const sel = selected.has(key);
                return (
                  <button
                    key={key}
                    onClick={() => toggleSelect(key)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left transition-all ${
                      sel ? 'bg-[#DFFF00]/[0.06] border border-[#DFFF00]/30' : 'hover:bg-white/[0.03] border border-transparent'
                    }`}
                  >
                    <div className={`w-5 h-5 rounded border flex items-center justify-center shrink-0 ${
                      sel ? 'bg-[#DFFF00] border-[#DFFF00] text-[#07080A]' : 'border-[#444]'
                    }`}>
                      {sel && <Check size={12} />}
                    </div>
                    <div className="w-10 h-10 rounded-lg overflow-hidden shrink-0">
                      <img loading="lazy" src={s.image} alt="" className="w-full h-full object-cover" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-white">{s.title}</p>
                      <p className="text-xs text-[#555]">{s.subtitle}</p>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {tab === 'upload' && (
            <div
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed border-[#2e2f33] rounded-2xl p-12 text-center cursor-pointer hover:border-[#444] transition-colors"
            >
              <input ref={fileRef} type="file" accept="audio/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f); }} />
              {uploading ? (
                <p className="text-sm text-[#9ca3af]">Uploading...</p>
              ) : (
                <>
                  <Upload size={28} className="mx-auto text-[#444] mb-3" />
                  <p className="text-sm text-[#9ca3af]">Drop audio file here or click to browse</p>
                  <p className="text-xs text-[#555] mt-1">WAV, MP3, OGG, FLAC — max 50MB</p>
                </>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        {tab !== 'upload' && (
          <div className="flex items-center justify-between px-5 py-3 border-t border-[#2e2f33]">
            <p className="text-xs text-[#666]">{selected.size} selected</p>
            <button
              onClick={handleAddSelected}
              disabled={selected.size === 0 || adding}
              className="px-5 py-2 rounded-xl bg-[#DFFF00] text-[#07080A] text-sm font-semibold hover:brightness-110 disabled:opacity-50 transition-all"
            >
              {adding ? 'Adding...' : `Add ${selected.size} Track${selected.size !== 1 ? 's' : ''}`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
