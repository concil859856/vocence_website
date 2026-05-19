import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Plus, Play, Pause, Trash2, Upload, Music, X, GripVertical,
  Shuffle, ListMusic, Globe, Lock, Check, ThumbsUp, MoreHorizontal,
  Image as ImageIcon, Copy, LayoutGrid, List as ListIcon,
  Headphones,
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
import { coverFor, fallbackCoverFor } from '../data/playbookCovers';
import { PlaybookCoverPicker } from '../components/PlaybookCoverPicker';
import { ShareButton } from '../components/PlaybookShareMenu';

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

// Hero stat formatter — picks a coarser unit than mm:ss for total
// playback length. Mirrors how Spotify/Apple Music describe album
// length: short playbooks read as "12 min", long ones as "1 h 23 min".
function formatTotalLength(sec: number): string {
  if (!sec || sec <= 0) return '0 min';
  const totalMin = Math.round(sec / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

function buildPlaybookShareUrl(id: number): string {
  if (typeof window === 'undefined') return '';
  // Short share URL routed (via Vercel rewrite in prod, Vite proxy in
  // dev) to the backend's OG-tagged landing page. Pasting this into
  // Discord/Slack/X/Facebook unfurls into a rich preview card; humans
  // who click get JS-redirected to the SPA URL. The bot/human split
  // lives on the backend (see routers/share.py).
  return `${window.location.origin}/p/${id}`;
}

// Friendlier share body for the X/WhatsApp/Telegram/Email intents. The
// 1st-person "I created…" framing kicks in when the viewer owns the
// playbook; everyone else gets a "check this out" variant. The Vocence
// reference is in the body intentionally — the link itself goes in a
// separate URL field on every platform's intent, and including the
// brand inline survives previews that strip URL metadata.
//
// Multi-line so the personal note lives on its own line; reads more
// like a real human message than a single-sentence blurb. Most share
// targets respect the newlines (WhatsApp, Telegram, Email body, native
// share sheet); X / Reddit / Discord collapse them visually but the
// content still reads cleanly.
function buildPlaybookShareText(title: string, viewerIsOwner: boolean): string {
  if (viewerIsOwner) {
    return (
      `Listen to my playbook "${title}" — I created it on Vocence (https://www.vocence.ai).\n` +
      `I really like how it turned out, hope you do too!`
    );
  }
  return (
    `Listen to "${title}" — a playbook on Vocence (https://www.vocence.ai).\n` +
    `I really like it, please check it out!`
  );
}

// Compact count formatter for stat pills (`245`, `1.2k`, `3.4M`).
// Keeps the card layout from breaking when a playbook goes viral.
function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return (k < 10 ? k.toFixed(1) : Math.round(k)) + 'k';
  }
  const m = n / 1_000_000;
  return (m < 10 ? m.toFixed(1) : Math.round(m)) + 'M';
}

/** Three pulsing vertical bars used in place of the row index when a
 *  track is actively playing — Spotify/Apple Music's "now playing"
 *  affordance. CSS-only so it costs nothing to render. */
function EqualizerBars() {
  return (
    <span className="inline-flex items-end gap-[2px] h-3" aria-hidden>
      <span className="w-[2px] bg-[#DFFF00] animate-eq origin-bottom" style={{ height: '60%', animationDelay: '0ms' }} />
      <span className="w-[2px] bg-[#DFFF00] animate-eq origin-bottom" style={{ height: '90%', animationDelay: '120ms' }} />
      <span className="w-[2px] bg-[#DFFF00] animate-eq origin-bottom" style={{ height: '40%', animationDelay: '260ms' }} />
    </span>
  );
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

// localStorage key for the community-section view-mode toggle. Mirrors
// Spotify/Suno's behaviour where the user's grid-vs-list preference
// sticks across sessions and devices on the same browser.
const COMMUNITY_VIEW_MODE_KEY = 'vocence_playbooks_community_view';
type CommunityViewMode = 'grid' | 'list';

function loadStoredViewMode(): CommunityViewMode {
  if (typeof window === 'undefined') return 'grid';
  try {
    const v = localStorage.getItem(COMMUNITY_VIEW_MODE_KEY);
    if (v === 'list' || v === 'grid') return v;
  } catch { /* */ }
  return 'grid';
}

function PlaybookListView() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { playQueue } = useStudioPlayer();
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [publicPlaybooks, setPublicPlaybooks] = useState<PublicPlaybook[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [communityView, setCommunityView] = useState<CommunityViewMode>(loadStoredViewMode);

  const token = localStorage.getItem('vocence_token');

  // Persist the view-mode toggle so the user's preference survives a
  // page refresh / cross-session navigation.
  useEffect(() => {
    try { localStorage.setItem(COMMUNITY_VIEW_MODE_KEY, communityView); } catch { /* */ }
  }, [communityView]);

  const load = useCallback(async () => {
    try {
      const [myRes, pubRes] = await Promise.all([
        token ? dashboardApi.listPlaybooks(token) : Promise.resolve({ playbooks: [] }),
        // Pass the token so each community card carries the viewer's own
        // ``viewer_voted`` state (filled thumb when already thumbed).
        dashboardApi.browsePublicPlaybooks(12, token),
      ]);
      setPlaybooks(myRes.playbooks);
      setPublicPlaybooks(pubRes.playbooks);
    } catch { /* */ }
    finally { setLoading(false); }
  }, [token]);

  // Toggle the viewer's thumb on a community playbook. Optimistic so the
  // count and button state flip immediately; reverts on server failure.
  // We don't re-sort the visible grid as votes come in — the server's
  // initial order (by vote_count DESC) is preserved per-load to avoid
  // cards jumping while the user interacts.
  const handleToggleVote = useCallback(async (pb: PublicPlaybook) => {
    if (!token) return;
    const next = !pb.viewer_voted;
    setPublicPlaybooks((list) => list.map((p) =>
      p.id === pb.id
        ? { ...p, viewer_voted: next, vote_count: Math.max(0, p.vote_count + (next ? 1 : -1)) }
        : p,
    ));
    try {
      const res = next
        ? await dashboardApi.votePlaybook(pb.id, token)
        : await dashboardApi.unvotePlaybook(pb.id, token);
      setPublicPlaybooks((list) => list.map((p) =>
        p.id === pb.id ? { ...p, viewer_voted: res.viewer_voted, vote_count: res.vote_count } : p,
      ));
    } catch {
      // Revert on failure.
      setPublicPlaybooks((list) => list.map((p) =>
        p.id === pb.id
          ? { ...p, viewer_voted: pb.viewer_voted, vote_count: pb.vote_count }
          : p,
      ));
    }
  }, [token]);

  // Same as handleToggleVote but targets the user's own playbooks list.
  // Splits because the two grids hold separate state; merging them would
  // tangle ownership semantics (vote_count is server-truth, but only the
  // owner's slice knows about private playbooks).
  const handleToggleVoteOwn = useCallback(async (pb: Playbook) => {
    if (!token) return;
    const next = !pb.viewer_voted;
    setPlaybooks((list) => list.map((p) =>
      p.id === pb.id
        ? { ...p, viewer_voted: next, vote_count: Math.max(0, p.vote_count + (next ? 1 : -1)) }
        : p,
    ));
    try {
      const res = next
        ? await dashboardApi.votePlaybook(pb.id, token)
        : await dashboardApi.unvotePlaybook(pb.id, token);
      setPlaybooks((list) => list.map((p) =>
        p.id === pb.id ? { ...p, viewer_voted: res.viewer_voted, vote_count: res.vote_count } : p,
      ));
    } catch {
      setPlaybooks((list) => list.map((p) =>
        p.id === pb.id
          ? { ...p, viewer_voted: pb.viewer_voted, vote_count: pb.vote_count }
          : p,
      ));
    }
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

  const bumpLocalPlayCount = useCallback((id: number) => {
    // Optimistically bump the play counter in both lists so the user
    // sees their own play register immediately. The server is the
    // source of truth — recordPlaybookPlay() fires alongside this and
    // the next refresh resolves any drift.
    setPlaybooks((list) => list.map((p) => p.id === id ? { ...p, play_count: p.play_count + 1 } : p));
    setPublicPlaybooks((list) => list.map((p) => p.id === id ? { ...p, play_count: p.play_count + 1 } : p));
  }, []);

  const handlePlayAll = async (pb: Playbook) => {
    if (!token || pb.track_count === 0) return;
    try {
      const detail = await dashboardApi.getPlaybook(pb.id, token);
      const tracks: Track[] = detail.tracks.map(t => ({
        src: t.audio_url, title: t.title, subtitle: t.subtitle, image: t.image_url || fallbackCoverFor(`track-${t.id}`),
      }));
      // Fire-and-forget play-count increment. Backend silently no-ops
      // for private playbooks so we don't need to gate this client-side.
      bumpLocalPlayCount(pb.id);
      void dashboardApi.recordPlaybookPlay(pb.id, token).catch(() => { /* counter best-effort */ });
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
        // Same PlaybookCard as the community grid below — uniform card
        // size, same fields shown. Creator is filled in from the auth
        // context since the API doesn't echo it back for own playbooks.
        // Vote-toggle is only enabled for public playbooks (private
        // ones can't accrue votes server-side).
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
          {playbooks.map((pb) => (
            <PlaybookCard
              key={pb.id}
              id={pb.id}
              title={pb.title}
              cover={coverFor(pb)}
              creatorName={user.name || 'You'}
              creatorPicture={user.picture || null}
              trackCount={pb.track_count}
              playCount={pb.play_count}
              voteCount={pb.vote_count}
              viewerVoted={pb.viewer_voted}
              viewerIsOwner={true}
              token={token}
              onOpen={() => navigate(`/studio/playbooks/${pb.id}`)}
              onPlay={() => handlePlayAll(pb)}
              onToggleVote={pb.visibility === 'public'
                ? () => handleToggleVoteOwn(pb)
                : undefined}
            />
          ))}
        </div>
      )}

      {/* Public playbooks — sorted by thumb-up count (server). Two
          views: a Spotify/Suno-style grid (cards with hover-overlay
          actions) and a compact list (table-like, dense). Both keep
          the top-3 rank-badge treatment. */}
      {publicPlaybooks.length > 0 && (
        <div className="pt-6 border-t border-[#2e2f33]">
          <div className="flex items-center gap-2 mb-4">
            <Globe size={14} className="text-[#666]" />
            <h3 className="text-sm font-semibold text-white">Community Playbooks</h3>
            <span className="text-xs text-[#444]">· top picks</span>

            {/* Grid/list toggle. The chosen mode is persisted to
                localStorage so the preference survives reloads. */}
            <div className="ml-auto inline-flex items-center rounded-lg border border-[#2e2f33] p-0.5">
              <button
                type="button"
                onClick={() => setCommunityView('grid')}
                aria-pressed={communityView === 'grid'}
                title="Grid view"
                className={`p-1.5 rounded-md transition-colors ${
                  communityView === 'grid' ? 'bg-white/10 text-white' : 'text-[#666] hover:text-white'
                }`}
              >
                <LayoutGrid size={14} />
              </button>
              <button
                type="button"
                onClick={() => setCommunityView('list')}
                aria-pressed={communityView === 'list'}
                title="List view"
                className={`p-1.5 rounded-md transition-colors ${
                  communityView === 'list' ? 'bg-white/10 text-white' : 'text-[#666] hover:text-white'
                }`}
              >
                <ListIcon size={14} />
              </button>
            </div>
          </div>

          {communityView === 'grid' ? (
            <CommunityGrid
              playbooks={publicPlaybooks}
              token={token}
              onOpen={(id) => navigate(`/studio/playbooks/${id}`)}
              onPlay={handlePlayAll}
              onToggleVote={handleToggleVote}
            />
          ) : (
            <CommunityList
              playbooks={publicPlaybooks}
              token={token}
              onOpen={(id) => navigate(`/studio/playbooks/${id}`)}
              onPlay={handlePlayAll}
              onToggleVote={handleToggleVote}
            />
          )}
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   PlaybookCard — unified card used by both the user's own grid and the
   community grid.
   ==========================================================================

   Always shows the same fields at rest:

      [   cover (aspect-square)   ]   <- hover reveals play button
      Title                      [⋯]  <- share-menu kebab on the right
      avatar Creator
      ♫ 12   🎧 245   👍 4

   The kebab is the platform "options" — currently just share (Copy /
   X / Reddit / WhatsApp / Telegram / Email / native share). Owner-only
   ops (delete, change cover, visibility) live on the detail page.
*/

interface PlaybookCardProps {
  id: number;
  title: string;
  cover: string | null;
  creatorName: string;
  creatorPicture: string | null;
  trackCount: number;
  playCount: number;
  voteCount: number;
  viewerVoted: boolean;
  /** 1-based rank in the community list. ``undefined`` = not ranked
   *  (user's own grid). Top-3 with at least one vote get a lime chip. */
  rank?: number;
  /** Whether the signed-in viewer is the creator of this playbook.
   *  Drives the share-message wording (1st-person "I created this" vs
   *  3rd-person "check this out"). */
  viewerIsOwner: boolean;
  token: string | null;
  onOpen: () => void;
  onPlay: () => void;
  /** Optional — if omitted, the vote pill isn't interactive (e.g.
   *  private playbook in the user's own grid). */
  onToggleVote?: () => void;
}

// Tier styling for the top-3. ``rank`` is 1-based. Returns CSS strings for
// border/ring (card outer) and the lime numbered chip.
function tierStyles(rank: number) {
  const ring =
    rank === 1 ? 'border-[#DFFF00]/60 ring-1 ring-[#DFFF00]/30 shadow-[0_0_32px_rgba(223,255,0,0.10)]'
    : rank === 2 ? 'border-[#DFFF00]/35'
    : 'border-[#DFFF00]/20';
  const badge =
    rank === 1 ? 'bg-[#DFFF00] text-[#07080A]'
    : rank === 2 ? 'bg-[#DFFF00]/70 text-[#07080A]'
    : 'bg-[#DFFF00]/40 text-[#07080A]';
  return { ring, badge };
}

function PlaybookCard(props: PlaybookCardProps) {
  const {
    id, title, cover, creatorName, creatorPicture,
    trackCount, playCount, voteCount, viewerVoted,
    rank, viewerIsOwner, token, onOpen, onPlay, onToggleVote,
  } = props;
  const isTop = rank !== undefined && rank <= 3 && voteCount > 0;
  const tiers = isTop ? tierStyles(rank!) : null;
  return (
    <div
      onClick={onOpen}
      className={`relative rounded-2xl border bg-[#111215] p-3 cursor-pointer transition-colors group ${
        tiers ? tiers.ring : 'border-[#2e2f33] hover:border-[#444]'
      }`}
    >
      {isTop && (
        <div className={`absolute -top-2 -left-2 z-10 px-2 py-0.5 rounded-full text-[10px] font-bold tracking-wider ${tiers!.badge}`}>
          #{rank}
        </div>
      )}

      {/* Cover — hover reveals scrim + lift-in play button. Other
          actions (vote, share) sit below the cover in the info area
          so they're permanently visible and tappable on mobile. */}
      <div className="aspect-square rounded-xl bg-gradient-to-br from-[#1c1d21] to-[#111215] mb-2.5 flex items-center justify-center relative overflow-hidden">
        {cover ? (
          <img loading="lazy" src={cover} alt="" className="absolute inset-0 w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" />
        ) : (
          <ListMusic size={28} className="text-[#3a3b3f]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/0 to-transparent opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
        <button
          onClick={(e) => { e.stopPropagation(); onPlay(); }}
          className="absolute bottom-1.5 right-1.5 w-10 h-10 rounded-full bg-[#DFFF00] text-[#07080A] flex items-center justify-center opacity-0 group-hover:opacity-100 translate-y-1 group-hover:translate-y-0 transition-all hover:scale-105 shadow-lg shadow-black/40"
          aria-label="Play playbook"
        >
          <Play size={16} className="ml-0.5" fill="currentColor" />
        </button>
      </div>

      {/* Title row: title + share kebab. The kebab is the "options"
          button — currently share-only; owner ops stay on the
          detail page. */}
      <div className="flex items-start gap-1.5 min-w-0">
        <h3 className="flex-1 min-w-0 text-xs font-semibold text-white truncate" title={title}>{title}</h3>
        <div onClick={(e) => e.stopPropagation()} className="-mt-0.5 -mr-1 shrink-0">
          <ShareButton
            url={buildPlaybookShareUrl(id)}
            title={title}
            text={buildPlaybookShareText(title, viewerIsOwner)}
            variant="compact"
          />
        </div>
      </div>

      {/* Creator row */}
      <div className="flex items-center gap-1.5 mt-1 min-w-0">
        {creatorPicture
          ? <img src={creatorPicture} alt="" className="w-3.5 h-3.5 rounded-full shrink-0" />
          : <div className="w-3.5 h-3.5 rounded-full bg-white/[0.08] shrink-0" />}
        <span className="text-[11px] text-[#9ca3af] truncate">{creatorName}</span>
      </div>

      {/* Stats row — tracks · listens · votes. Vote count is the only
          interactive stat (toggles thumb when signed in). The other
          two are read-only. */}
      <div className="flex items-center gap-2 mt-1.5 text-[11px] text-[#666]">
        <span className="inline-flex items-center gap-1" title={`${trackCount} track${trackCount === 1 ? '' : 's'}`}>
          <Music size={11} />
          <span className="tabular-nums">{formatCount(trackCount)}</span>
        </span>
        <span className="inline-flex items-center gap-1" title={`${playCount} play${playCount === 1 ? '' : 's'}`}>
          <Headphones size={11} />
          <span className="tabular-nums">{formatCount(playCount)}</span>
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); if (onToggleVote && token) onToggleVote(); }}
          disabled={!onToggleVote || !token}
          title={
            !onToggleVote ? 'Voting is only available on public playbooks'
            : token ? (viewerVoted ? 'Remove your thumb' : 'Thumb up')
            : 'Sign in to vote'
          }
          className={`ml-auto inline-flex items-center gap-1 transition-colors disabled:cursor-not-allowed ${
            viewerVoted ? 'text-[#DFFF00]' : 'text-[#666] hover:text-white'
          }`}
        >
          <ThumbsUp size={11} className={viewerVoted ? 'fill-current' : ''} />
          <span className="tabular-nums">{formatCount(voteCount)}</span>
        </button>
      </div>
    </div>
  );
}

/* ==========================================================================
   COMMUNITY SECTION — list helper (grid uses the PlaybookCard above)
   ==========================================================================
*/

interface CommunityRowProps {
  playbooks: PublicPlaybook[];
  token: string | null;
  onOpen: (id: number) => void;
  onPlay: (pb: PublicPlaybook) => void;
  onToggleVote: (pb: PublicPlaybook) => void;
}

/** Grid view: shared PlaybookCard for every entry; no special-case
 *  layout for the featured #1 so card sizes stay uniform. */
function CommunityGrid({ playbooks, token, onOpen, onPlay, onToggleVote }: CommunityRowProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3 sm:gap-4">
      {playbooks.map((pb, idx) => (
        <PlaybookCard
          key={pb.id}
          id={pb.id}
          title={pb.title}
          cover={coverFor(pb)}
          creatorName={pb.user_name}
          creatorPicture={pb.user_picture}
          trackCount={pb.track_count}
          playCount={pb.play_count}
          voteCount={pb.vote_count}
          viewerVoted={pb.viewer_voted}
          rank={idx + 1}
          viewerIsOwner={false}
          token={token}
          onOpen={() => onOpen(pb.id)}
          onPlay={() => onPlay(pb)}
          onToggleVote={() => onToggleVote(pb)}
        />
      ))}
    </div>
  );
}

/** List view: Spotify-style compact table. Each row has the same data
 *  density as Spotify's playlist table (cover thumb + title + creator
 *  + tracks + length + votes + share kebab). Mobile collapses the less
 *  important columns so it stays readable on narrow viewports. */
function CommunityList({ playbooks, token, onOpen, onPlay, onToggleVote }: CommunityRowProps) {
  return (
    <div className="rounded-2xl border border-[#2e2f33] overflow-hidden">
      {/* Column header — Spotify-style small-caps, dim. Hidden on
          mobile where some columns are collapsed. */}
      <div className="hidden md:grid grid-cols-[2rem_minmax(0,1fr)_minmax(0,9rem)_4rem_4rem_4rem_2rem] gap-3 px-3 py-2 border-b border-[#2e2f33] bg-white/[0.02] text-[10px] uppercase tracking-wider text-[#555]">
        <div className="text-center">#</div>
        <div>Title</div>
        <div>Creator</div>
        <div className="text-right">Tracks</div>
        <div className="text-right">Listens</div>
        <div className="text-right">Votes</div>
        <div />
      </div>
      <div>
        {playbooks.map((pb, idx) => {
          const rank = idx + 1;
          const isTop = rank <= 3 && pb.vote_count > 0;
          const { badge } = tierStyles(rank);
          const rowCover = coverFor(pb);
          return (
            <div
              key={pb.id}
              onClick={() => onOpen(pb.id)}
              className="grid grid-cols-[2rem_minmax(0,1fr)_5rem_2rem] md:grid-cols-[2rem_minmax(0,1fr)_minmax(0,9rem)_4rem_4rem_4rem_2rem] items-center gap-3 px-3 py-2 cursor-pointer hover:bg-white/[0.03] transition-colors group border-b border-white/[0.04] last:border-b-0"
            >
              {/* Rank cell — number at rest, lime chip when top-3, swap
                  to play button on hover. */}
              <div className="relative h-8 w-8 flex items-center justify-center">
                {isTop ? (
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold tracking-wider group-hover:opacity-0 transition-opacity ${badge}`}>
                    #{rank}
                  </span>
                ) : (
                  <span className="text-sm tabular-nums text-[#666] group-hover:opacity-0 transition-opacity">
                    {rank}
                  </span>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); onPlay(pb); }}
                  className="absolute inset-0 flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity"
                  aria-label="Play playbook"
                >
                  <Play size={14} className="ml-0.5" fill="currentColor" />
                </button>
              </div>

              {/* Title cell — cover thumb + title. Truncates aggressively. */}
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-9 h-9 rounded-md overflow-hidden shrink-0 bg-gradient-to-br from-[#1c1d21] to-[#111215] flex items-center justify-center">
                  {rowCover
                    ? <img loading="lazy" src={rowCover} alt="" className="w-full h-full object-cover" />
                    : <ListMusic size={14} className="text-[#3a3b3f]" />}
                </div>
                <p className="text-sm font-medium text-white truncate">{pb.title}</p>
              </div>

              {/* Creator — hidden on mobile to save space */}
              <div className="hidden md:flex items-center gap-1.5 min-w-0">
                {pb.user_picture && (
                  <img src={pb.user_picture} alt="" className="w-4 h-4 rounded-full shrink-0" />
                )}
                <span className="text-xs text-[#9ca3af] truncate">{pb.user_name}</span>
              </div>

              {/* Tracks — desktop only */}
              <span className="hidden md:block text-xs text-[#888] tabular-nums text-right">
                {formatCount(pb.track_count)}
              </span>

              {/* Listens — desktop only. Compact format so 1.2k doesn't
                  push the column wider than its allocation. */}
              <span className="hidden md:block text-xs text-[#888] tabular-nums text-right">
                {formatCount(pb.play_count)}
              </span>

              {/* Votes pill — interactive on mobile too (we don't have
                  hover there, so the affordance is always visible). */}
              <button
                onClick={(e) => { e.stopPropagation(); if (token) onToggleVote(pb); }}
                disabled={!token}
                title={token ? (pb.viewer_voted ? 'Remove your thumb' : 'Thumb up') : 'Sign in to vote'}
                className={`flex items-center justify-end gap-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  pb.viewer_voted ? 'text-[#DFFF00]' : 'text-[#9ca3af] hover:text-white'
                }`}
              >
                <ThumbsUp size={12} className={pb.viewer_voted ? 'fill-current' : ''} />
                <span className="tabular-nums">{formatCount(pb.vote_count)}</span>
              </button>

              {/* Share kebab — community context, so the message uses
                  the non-owner "check this out" variant. */}
              <div onClick={(e) => e.stopPropagation()} className="justify-self-end">
                <ShareButton
                  url={buildPlaybookShareUrl(pb.id)}
                  title={pb.title}
                  text={buildPlaybookShareText(pb.title, false)}
                  variant="compact"
                />
              </div>
            </div>
          );
        })}
      </div>
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
  const [showCoverPicker, setShowCoverPicker] = useState(false);

  const token = localStorage.getItem('vocence_token');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  // Owner-only collapsed actions menu (Change cover / Visibility /
  // Delete). Tracks-row per-row kebab is keyed by track id.
  const [ownerMenuOpen, setOwnerMenuOpen] = useState(false);
  const [openTrackMenuId, setOpenTrackMenuId] = useState<number | null>(null);
  const ownerMenuRef = useRef<HTMLDivElement | null>(null);
  const trackMenuRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    if (!token) return;
    try {
      const pb = await dashboardApi.getPlaybook(playbookId, token);
      setPlaybook(pb);
      setTitleVal(pb.title);
    } catch { navigate('/studio/playbooks'); }
    finally { setLoading(false); }
  }, [playbookId, token, navigate]);

  const handleReorderDrop = async (toIdx: number) => {
    if (!playbook || !token || dragIndex == null || dragIndex === toIdx) {
      setDragIndex(null);
      setDragOverIndex(null);
      return;
    }
    const tracks = [...playbook.tracks];
    const [moved] = tracks.splice(dragIndex, 1);
    tracks.splice(toIdx, 0, moved);
    setPlaybook((p) => (p ? { ...p, tracks } : p));
    setDragIndex(null);
    setDragOverIndex(null);
    try {
      await dashboardApi.reorderPlaybookTracks(playbook.id, tracks.map((t) => t.id), token);
    } catch {
      void load(); // revert from server on failure
    }
  };

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (editingTitle && titleRef.current) titleRef.current.focus();
  }, [editingTitle]);

  // Reflect playbook title in the browser tab so back/forward history
  // and tab strips show the actual playbook name. Restore on unmount.
  useEffect(() => {
    if (!playbook) return;
    const prev = document.title;
    document.title = `${playbook.title} · Vocence`;
    return () => { document.title = prev; };
  }, [playbook?.title]);

  // Close the owner action menu / per-track menu on outside click or
  // Escape. Same pattern as ShareButton — kept local since these
  // popovers are short-lived and don't merit a shared component.
  useEffect(() => {
    if (!ownerMenuOpen && openTrackMenuId === null) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ownerMenuRef.current?.contains(target)) return;
      if (trackMenuRef.current?.contains(target)) return;
      setOwnerMenuOpen(false);
      setOpenTrackMenuId(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOwnerMenuOpen(false);
        setOpenTrackMenuId(null);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onEsc);
    };
  }, [ownerMenuOpen, openTrackMenuId]);

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
      src: t.audio_url, title: t.title, subtitle: t.subtitle, image: t.image_url || fallbackCoverFor(`track-${t.id}`),
    }));
    playQueue(tracks, startIdx, playbook.title);
    // Best-effort play-count increment. The server silently no-ops
    // for private playbooks, so we don't gate this client-side. The
    // hero's listens line updates optimistically so the owner sees
    // their own play register right away.
    setPlaybook((p) => p ? { ...p, play_count: p.play_count + 1 } : p);
    void dashboardApi.recordPlaybookPlay(playbook.id, token).catch(() => { /* */ });
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

  // Thumb-up toggle on the detail header. Optimistic — reverts on
  // server failure. Only meaningful for public playbooks; the button
  // isn't rendered for private ones.
  const handleToggleVote = async () => {
    if (!token || !playbook) return;
    const prev = { viewer_voted: playbook.viewer_voted, vote_count: playbook.vote_count };
    const next = !playbook.viewer_voted;
    setPlaybook((p) => p ? {
      ...p,
      viewer_voted: next,
      vote_count: Math.max(0, p.vote_count + (next ? 1 : -1)),
    } : p);
    try {
      const res = next
        ? await dashboardApi.votePlaybook(playbook.id, token)
        : await dashboardApi.unvotePlaybook(playbook.id, token);
      setPlaybook((p) => p ? { ...p, viewer_voted: res.viewer_voted, vote_count: res.vote_count } : p);
    } catch {
      setPlaybook((p) => p ? { ...p, ...prev } : p);
    }
  };

  if (loading) return <div className="flex items-center justify-center py-20 text-[#666]">Loading...</div>;
  if (!playbook) return null;

  const coverUrl = coverFor(playbook);
  const isPublic = playbook.visibility === 'public';
  const shareUrl = buildPlaybookShareUrl(playbook.id);
  const shareText = buildPlaybookShareText(playbook.title, playbook.is_owner);

  return (
    <div className="space-y-6">
      {/* ── HERO ──────────────────────────────────────────────────────
          Spotify/Apple-Music-style: the cover image is rendered twice —
          once large at the front, once blurred + saturated as the
          backdrop — so the page picks up the cover's color automatically
          without needing a JS color extractor. Bleeds to the edges of
          the Studio content area via -mx-6/-mx-10 to feel album-like.

          The blurred backdrop lives in its own absolutely-positioned
          wrapper that owns the ``overflow-hidden``. Putting overflow on
          the outer hero would clip any popover (kebab, share menu) that
          opens below an action-row button. */}
      <div className="relative -mx-6 lg:-mx-10 px-6 lg:px-10 pb-6">
        {coverUrl && (
          <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
            <img
              src={coverUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover scale-150 blur-3xl opacity-40 saturate-150"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-[#07080A]/55 via-[#07080A]/85 to-[#07080A]" />
          </div>
        )}

        <div className="relative pt-8 flex flex-col sm:flex-row items-start sm:items-end gap-5 sm:gap-6">
          {/* Cover */}
          <div
            className={`w-44 h-44 sm:w-52 sm:h-52 shrink-0 rounded-2xl bg-gradient-to-br from-[#1c1d21] to-[#111215] flex items-center justify-center overflow-hidden relative group/cover shadow-2xl shadow-black/60 ${playbook.is_owner ? 'cursor-pointer' : ''}`}
            onClick={() => playbook.is_owner && setShowCoverPicker(true)}
          >
            {coverUrl ? (
              <img loading="lazy" src={coverUrl} alt="" className="absolute inset-0 w-full h-full object-cover" />
            ) : (
              <div className="flex flex-col items-center gap-1.5 text-[#3a3b3f]">
                <ListMusic size={36} />
                {playbook.is_owner && <span className="text-[10px] uppercase tracking-wider">Add cover</span>}
              </div>
            )}
            {playbook.is_owner && coverUrl && (
              <div className="absolute inset-0 bg-black/0 group-hover/cover:bg-black/45 transition-colors flex items-center justify-center opacity-0 group-hover/cover:opacity-100">
                <span className="text-xs font-medium text-white px-3 py-1.5 rounded-full bg-black/40 backdrop-blur-sm">Change cover</span>
              </div>
            )}
          </div>

          {/* Title + metadata */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/70">Playbook</span>
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                isPublic ? 'bg-white/10 text-white/80' : 'bg-white/5 text-[#A7B0B7]'
              }`}>
                {isPublic ? <Globe size={10} /> : <Lock size={10} />}
                {isPublic ? 'Public' : 'Private'}
              </span>
            </div>

            {editingTitle && playbook.is_owner ? (
              <input
                ref={titleRef}
                value={titleVal}
                onChange={(e) => setTitleVal(e.target.value)}
                onBlur={handleTitleSave}
                onKeyDown={(e) => e.key === 'Enter' && handleTitleSave()}
                className="text-3xl sm:text-4xl font-bold bg-transparent border-b border-[#DFFF00] outline-none text-white w-full"
              />
            ) : (
              <h1
                className={`text-3xl sm:text-4xl font-bold leading-tight tracking-tight break-words ${playbook.is_owner ? 'cursor-pointer hover:text-[#DFFF00]' : ''} transition-colors`}
                onClick={() => playbook.is_owner && setEditingTitle(true)}
              >
                {playbook.title}
              </h1>
            )}

            {/* Stats line — tracks · length · listens · thumbs.
                Plays + thumbs only show for public playbooks since both
                are zero by design on private ones (server doesn't
                increment them). */}
            <div className="flex items-center gap-2 mt-3 text-sm text-[#A7B0B7] flex-wrap">
              <span><span className="text-white font-medium">{playbook.track_count}</span> track{playbook.track_count !== 1 ? 's' : ''}</span>
              <span className="text-[#444]">·</span>
              <span>{formatTotalLength(playbook.total_duration)}</span>
              {isPublic && (
                <>
                  <span className="text-[#444]">·</span>
                  <span className="inline-flex items-center gap-1">
                    <Headphones size={12} />
                    <span className="tabular-nums text-white font-medium">{formatCount(playbook.play_count)}</span>
                  </span>
                  <span className="text-[#444]">·</span>
                  <span className="inline-flex items-center gap-1">
                    <ThumbsUp size={12} />
                    <span className="tabular-nums text-white font-medium">{formatCount(playbook.vote_count)}</span>
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Action row — sits below the hero block but inside the bleed
            so the gradient backdrop softly continues underneath. */}
        <div className="relative mt-6 flex items-center gap-2.5 flex-wrap">
          <button
            onClick={() => handlePlayAll()}
            disabled={playbook.tracks.length === 0}
            className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-[#DFFF00] text-[#07080A] text-sm font-bold hover:brightness-110 hover:scale-[1.03] active:scale-100 disabled:opacity-50 disabled:hover:scale-100 transition-all shadow-lg shadow-[#DFFF00]/20"
          >
            <Play size={16} className="ml-0.5" fill="currentColor" /> Play
          </button>
          <button
            onClick={() => handlePlayAll()}
            disabled={playbook.tracks.length === 0}
            className="flex items-center justify-center w-10 h-10 rounded-full border border-[#2e2f33] text-[#A7B0B7] hover:text-white hover:border-[#444] disabled:opacity-50 transition-colors"
            title="Shuffle"
          >
            <Shuffle size={16} />
          </button>

          {/* Thumb-up: public only. Big-version for the hero. */}
          {isPublic && (
            <button
              onClick={handleToggleVote}
              disabled={!token}
              title={token ? (playbook.viewer_voted ? 'Remove your thumb' : 'Thumb up') : 'Sign in to vote'}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-full border text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                playbook.viewer_voted
                  ? 'border-[#DFFF00]/60 bg-[#DFFF00]/10 text-[#DFFF00]'
                  : 'border-[#2e2f33] text-[#A7B0B7] hover:text-white hover:border-[#444]'
              }`}
            >
              <ThumbsUp size={14} className={playbook.viewer_voted ? 'fill-current' : ''} />
              <span className="tabular-nums">{playbook.vote_count}</span>
            </button>
          )}

          {/* Share menu — public playbooks only. The ShareButton owns
              its popover state, copy feedback, and the native share
              fallback on supported devices. */}
          {isPublic && <ShareButton url={shareUrl} title={playbook.title} text={shareText} />}

          {playbook.is_owner && (
            <button
              onClick={() => setShowAddModal(true)}
              className="flex items-center gap-2 px-3 py-2 rounded-full border border-[#2e2f33] text-sm text-[#A7B0B7] hover:text-white hover:border-[#444] transition-colors"
            >
              <Plus size={14} /> Add tracks
            </button>
          )}

          {/* Owner kebab — collapses the secondary actions (cover,
              visibility toggle, delete) so the action row stays clean. */}
          {playbook.is_owner && (
            <div className="relative" ref={ownerMenuRef}>
              <button
                onClick={() => setOwnerMenuOpen((o) => !o)}
                className="flex items-center justify-center w-10 h-10 rounded-full border border-[#2e2f33] text-[#A7B0B7] hover:text-white hover:border-[#444] transition-colors"
                aria-haspopup="menu"
                aria-expanded={ownerMenuOpen}
                title="More"
              >
                <MoreHorizontal size={16} />
              </button>
              {ownerMenuOpen && (
                <div
                  role="menu"
                  className="absolute right-0 mt-2 z-50 w-56 rounded-xl border border-[#2e2f33] bg-[#111215] shadow-2xl shadow-black/60 py-1.5 overflow-hidden"
                >
                  <button
                    role="menuitem"
                    onClick={() => { setOwnerMenuOpen(false); setShowCoverPicker(true); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-white hover:bg-white/[0.04] transition-colors"
                  >
                    <ImageIcon size={14} className="text-[#A7B0B7]" />
                    Change cover
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => { setOwnerMenuOpen(false); void handleToggleVisibility(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-white hover:bg-white/[0.04] transition-colors"
                  >
                    {isPublic ? <Lock size={14} className="text-[#A7B0B7]" /> : <Globe size={14} className="text-[#A7B0B7]" />}
                    {isPublic ? 'Make private' : 'Make public'}
                  </button>
                  <div className="border-t border-white/[0.06] my-1" />
                  <button
                    role="menuitem"
                    onClick={() => { setOwnerMenuOpen(false); void handleDelete(); }}
                    className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:bg-red-500/[0.08] transition-colors"
                  >
                    <Trash2 size={14} />
                    Delete playbook
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Track list */}
      {playbook.tracks.length === 0 ? (
        <div className="text-center py-16 border border-dashed border-[#2e2f33] rounded-2xl">
          <Music size={32} className="mx-auto text-[#333] mb-3" />
          <p className="text-[#666] mb-4">No tracks yet</p>
          {playbook.is_owner && (
            <button
              onClick={() => setShowAddModal(true)}
              className="px-5 py-2 rounded-xl bg-white text-[#07080A] text-sm font-semibold hover:bg-white/90"
            >
              Add Tracks
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-0.5">
          {/* Header row — only on wider screens, like Spotify */}
          <div className="hidden md:grid grid-cols-[2rem_1fr_4rem_2rem] gap-3 px-3 pb-2 mb-1 border-b border-white/[0.04] text-[10px] uppercase tracking-wider text-[#555]">
            <div className="text-center">#</div>
            <div>Title</div>
            <div className="text-right">Time</div>
            <div />
          </div>
          {playbook.tracks.map((t, i) => {
            const isThis = currentTrack?.src === t.audio_url;
            const isPlaying = isThis && playing;
            const isDragging = dragIndex === i;
            const isDragTarget = dragOverIndex === i && dragIndex !== null && dragIndex !== i;
            const rowMenuOpen = openTrackMenuId === t.id;
            const onTogglePlay = () => {
              if (isPlaying) { pause(); return; }
              if (isThis) { resume(); return; }
              handlePlayAll(i);
            };
            const copyTrackLink = async () => {
              try { await navigator.clipboard.writeText(t.audio_url); } catch { /* */ }
              setOpenTrackMenuId(null);
            };
            return (
              <div
                key={t.id}
                draggable={playbook.is_owner}
                onDragStart={(e) => {
                  if (!playbook.is_owner) return;
                  setDragIndex(i);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  if (!playbook.is_owner || dragIndex === null) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dragOverIndex !== i) setDragOverIndex(i);
                }}
                onDragEnd={() => { setDragIndex(null); setDragOverIndex(null); }}
                onDrop={(e) => {
                  if (!playbook.is_owner) return;
                  e.preventDefault();
                  void handleReorderDrop(i);
                }}
                onDoubleClick={onTogglePlay}
                className={`grid grid-cols-[2rem_1fr_4rem_2rem] items-center gap-3 px-3 py-2 rounded-lg transition-colors group ${
                  isThis ? 'bg-white/[0.06]' : 'hover:bg-white/[0.03]'
                } ${isDragging ? 'opacity-40' : ''} ${isDragTarget ? 'ring-1 ring-[#DFFF00]/40' : ''}`}
              >
                {/* Index / hover-play. Drag handle for owner replaces the
                    index when hovering — same column, swapped affordance. */}
                <div className="relative h-8 w-8 flex items-center justify-center shrink-0">
                  {/* Static state: index number (or playing equalizer) */}
                  <span className={`absolute inset-0 flex items-center justify-center transition-opacity ${
                    isPlaying ? 'opacity-100' : 'group-hover:opacity-0 opacity-100'
                  } ${isThis ? 'text-[#DFFF00]' : 'text-[#666]'} text-sm tabular-nums`}>
                    {isPlaying
                      ? <EqualizerBars />
                      : (isThis ? <Play size={12} className="ml-0.5" /> : i + 1)}
                  </span>
                  {/* Hover state: play/pause button */}
                  <button
                    onClick={onTogglePlay}
                    className="absolute inset-0 flex items-center justify-center text-white opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label={isPlaying ? 'Pause' : 'Play'}
                  >
                    {isPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" className="ml-0.5" />}
                  </button>
                </div>

                {/* Title block: optional thumb image + title + subtitle */}
                <div className="flex items-center gap-3 min-w-0">
                  {playbook.is_owner && (
                    <div className="text-[#444] opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing shrink-0 -ml-1" title="Drag to reorder">
                      <GripVertical size={14} />
                    </div>
                  )}
                  <div className="w-9 h-9 rounded-md overflow-hidden shrink-0">
                    <img
                      loading="lazy"
                      src={t.image_url || fallbackCoverFor(`track-${t.id}`)}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${isThis ? 'text-[#DFFF00]' : 'text-white'}`}>{t.title}</p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {/* Source pip — same info as before, much quieter */}
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          t.source_type === 'generated' ? 'bg-indigo-400/70'
                          : t.source_type === 'uploaded' ? 'bg-amber-400/70'
                          : 'bg-white/30'
                        }`}
                        title={t.source_type === 'generated' ? 'AI generated' : t.source_type === 'uploaded' ? 'Uploaded' : 'Sample'}
                      />
                      {t.subtitle && <p className="text-xs text-[#666] truncate">{t.subtitle}</p>}
                    </div>
                  </div>
                </div>

                {/* Duration */}
                <span className="text-xs text-[#888] tabular-nums text-right">
                  {t.duration_seconds ? formatDuration(t.duration_seconds) : '--'}
                </span>

                {/* Per-row kebab. Always visible (icon-only); menu opens
                    with copy-link for everyone and remove for owners. */}
                <div className="relative" ref={rowMenuOpen ? trackMenuRef : null}>
                  <button
                    onClick={(e) => { e.stopPropagation(); setOpenTrackMenuId((id) => id === t.id ? null : t.id); }}
                    className="w-7 h-7 flex items-center justify-center rounded text-[#555] hover:text-white hover:bg-white/[0.06] opacity-0 group-hover:opacity-100 transition-all"
                    aria-haspopup="menu"
                    aria-expanded={rowMenuOpen}
                    aria-label="Track actions"
                  >
                    <MoreHorizontal size={14} />
                  </button>
                  {rowMenuOpen && (
                    <div role="menu" className="absolute right-0 mt-1 z-40 w-48 rounded-xl border border-[#2e2f33] bg-[#111215] shadow-2xl shadow-black/60 py-1.5 overflow-hidden">
                      <button
                        role="menuitem"
                        onClick={(e) => { e.stopPropagation(); void copyTrackLink(); }}
                        className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-white hover:bg-white/[0.04] transition-colors"
                      >
                        <Copy size={14} className="text-[#A7B0B7]" />
                        Copy audio link
                      </button>
                      {playbook.is_owner && (
                        <button
                          role="menuitem"
                          onClick={(e) => { e.stopPropagation(); setOpenTrackMenuId(null); void handleRemoveTrack(t.id); }}
                          className="w-full flex items-center gap-2.5 px-3 py-2 text-sm text-red-400 hover:bg-red-500/[0.08] transition-colors"
                        >
                          <Trash2 size={14} />
                          Remove from playbook
                        </button>
                      )}
                    </div>
                  )}
                </div>
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

      {showCoverPicker && (
        <PlaybookCoverPicker
          playbookId={playbook.id}
          current={playbook.cover_image_url}
          onClose={() => setShowCoverPicker(false)}
          onSaved={(url) => {
            setPlaybook((p) => (p ? { ...p, cover_image_url: url } : p));
            setShowCoverPicker(false);
          }}
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
        <div className="max-h-[30rem] overflow-y-auto p-4">
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
