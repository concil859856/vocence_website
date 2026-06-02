/**
 * StudioCommunityVoices, browse every voice the platform ships,
 * preview each one, like the ones you love, and pop any of them into
 * Text-to-Speech for a full generation.
 *
 * The "Use this voice" CTA navigates to ``/studio/tts?voice=<id>``;
 * the TTS page reads that query param at mount and preselects the
 * matching SampleVoice.
 *
 * Like counts are server-side and shared across every user:
 *   GET  /api/dashboard/public/voices/likes  → {voice_id: count}
 *   GET  /api/dashboard/voices/likes/mine    → [voice_id, ...]
 *   POST /api/dashboard/voices/{id}/like     → toggle, returns {liked, count}
 *
 * Grid order: descending by like count (most-loved first), then by the
 * catalog's hand-tuned default ordering as the stable tiebreaker.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Heart, Loader2, Pause, Play, Plus, Search } from 'lucide-react';
import { SAMPLE_VOICES, type SampleVoice } from '../../data/sampleVoices';
import { SampleVoiceAvatar } from './SampleVoiceAvatar';
import { useStudioPlayer } from '../../contexts/StudioPlayerContext';
import { useAuth } from '../../contexts/AuthContext';
import { asset } from '../../data/assets';
import { SubmitVoiceModal } from './SubmitVoiceModal';


function audioSrcFor(v: SampleVoice): string | null {
  // Direct URL wins for community-contributed voices (they live in
  // object storage, not in the curated CDN catalog).
  if (v.audioDirectUrl) return v.audioDirectUrl;
  if (v.audioStaticPath) return `/api/dashboard/sample-voices/${v.audioStaticPath}`;
  if (v.audioAssetKey) return asset(v.audioAssetKey);
  return null;
}


function authHeaders(): HeadersInit {
  const token = typeof window !== 'undefined' ? localStorage.getItem('vocence_token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}


export function StudioCommunityVoices() {
  const { user } = useAuth();
  const [search, setSearch] = useState('');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [myLikes, setMyLikes] = useState<Set<string>>(new Set());
  // True once the like-counts request has settled (success OR fail).
  // Until then the grid shows a spinner, without this gate the cards
  // paint in catalog order, then the counts fetch resolves and the
  // whole grid visibly re-sorts in front of the user.
  const [countsReady, setCountsReady] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  // Approved community-contributed voices. Fetched once on mount,
  // merged with the static SAMPLE_VOICES catalog so they sort + filter
  // together with the curated set.
  const [communityVoices, setCommunityVoices] = useState<SampleVoice[]>([]);

  // Fetch aggregate counts (anonymous) and the signed-in user's liked
  // set in parallel on mount. Both endpoints fall through to empty so
  // a logged-out visitor still gets the popularity sort.
  useEffect(() => {
    let cancelled = false;
    setCountsReady(false);
    fetch('/api/dashboard/public/voices/likes')
      .then((r) => (r.ok ? r.json() : { counts: {} }))
      .then((data) => { if (!cancelled) setCounts(data?.counts ?? {}); })
      .catch(() => { /* leave counts empty */ })
      .finally(() => { if (!cancelled) setCountsReady(true); });
    // Community-submitted approved voices. Soft-fail to an empty list
    // so the curated grid still renders if the endpoint is down.
    fetch('/api/dashboard/public/voices/community')
      .then((r) => (r.ok ? r.json() : { voices: [] }))
      .then((data: { voices?: Array<{
        id: string; name: string; description: string; language: string;
        audio_url: string; avatar_url: string;
        submitter_name: string | null; submitter_picture: string | null;
      }> }) => {
        if (cancelled) return;
        const mapped: SampleVoice[] = (data.voices ?? []).map((v) => ({
          id: v.id,
          name: v.name,
          description: v.description,
          audioDirectUrl: v.audio_url,
          imageDirectUrl: v.avatar_url,
          submitter: {
            name: v.submitter_name,
            picture: v.submitter_picture,
          },
        }));
        setCommunityVoices(mapped);
      })
      .catch(() => { /* leave community list empty */ });
    if (user) {
      fetch('/api/dashboard/voices/likes/mine', { headers: authHeaders() })
        .then((r) => (r.ok ? r.json() : { voice_ids: [] }))
        .then((data) => {
          if (cancelled) return;
          setMyLikes(new Set<string>(data?.voice_ids ?? []));
        })
        .catch(() => { /* leave likes empty */ });
    } else {
      setMyLikes(new Set());
    }
    return () => { cancelled = true; };
  }, [user?.id]);

  // Sort by popularity (desc), with the catalog order as a stable
  // tiebreaker. We re-derive on every search keystroke too, the cost
  // is trivial on a few dozen voices. Community-submitted voices
  // merge in here so they sort/filter together with the curated set.
  const ranked = useMemo(() => {
    const fullCatalog = [...SAMPLE_VOICES, ...communityVoices];
    const indexInCatalog = new Map(fullCatalog.map((v, i) => [v.id, i]));
    const q = search.trim().toLowerCase();
    const matching = q
      ? fullCatalog.filter((v) =>
          v.name.toLowerCase().includes(q) || v.description.toLowerCase().includes(q),
        )
      : fullCatalog;
    return [...matching].sort((a, b) => {
      const ca = counts[a.id] ?? 0;
      const cb = counts[b.id] ?? 0;
      if (cb !== ca) return cb - ca;
      // Same like count → preserve original hand-tuned ordering.
      return (indexInCatalog.get(a.id) ?? 0) - (indexInCatalog.get(b.id) ?? 0);
    });
  }, [counts, search, communityVoices]);

  // Per-voice in-flight set so rapid double-clicks don't fire two
  // concurrent POSTs whose responses race and desync the UI.
  const pendingLikesRef = useRef<Set<string>>(new Set());

  const toggleLike = async (voiceId: string) => {
    if (!user) {
      // No graceful auth flow on this page yet, soft-fail.
      return;
    }
    if (pendingLikesRef.current.has(voiceId)) return;
    pendingLikesRef.current.add(voiceId);
    // Optimistic update so the heart feels instant. Roll back on error.
    const wasLiked = myLikes.has(voiceId);
    const next = new Set(myLikes);
    if (wasLiked) next.delete(voiceId); else next.add(voiceId);
    setMyLikes(next);
    setCounts((prev) => ({
      ...prev,
      [voiceId]: Math.max(0, (prev[voiceId] ?? 0) + (wasLiked ? -1 : 1)),
    }));
    try {
      const res = await fetch(
        `/api/dashboard/voices/${encodeURIComponent(voiceId)}/like`,
        { method: 'POST', headers: authHeaders() },
      );
      if (!res.ok) throw new Error(`http ${res.status}`);
      const data = await res.json();
      // Sync to the server's authoritative count in case of races.
      setCounts((prev) => ({ ...prev, [voiceId]: data.count ?? prev[voiceId] ?? 0 }));
      setMyLikes((prev) => {
        const synced = new Set(prev);
        if (data.liked) synced.add(voiceId); else synced.delete(voiceId);
        return synced;
      });
    } catch {
      // Roll back.
      setMyLikes((prev) => {
        const rolled = new Set(prev);
        if (wasLiked) rolled.add(voiceId); else rolled.delete(voiceId);
        return rolled;
      });
      setCounts((prev) => ({
        ...prev,
        [voiceId]: Math.max(0, (prev[voiceId] ?? 0) + (wasLiked ? 1 : -1)),
      }));
    } finally {
      pendingLikesRef.current.delete(voiceId);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-semibold text-white leading-none mb-1.5">Community Voices</h2>
          <p className="text-sm text-[#A7B0B7]">
            Every voice that ships with Vocence. Preview, like the ones you love, and pop any of them into Text-to-Speech to use directly.
          </p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto flex-wrap">
          <button
            type="button"
            onClick={() => setSubmitOpen(true)}
            disabled={!user}
            title={user ? 'Submit your voice for review' : 'Sign in to submit a voice'}
            className="inline-flex items-center gap-1.5 rounded-full bg-[#DFFF00] text-[#07080A] px-4 py-2 text-sm font-semibold hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus size={15} />
            Submit your voice
          </button>
          <div className="relative w-full sm:w-72">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#666]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search voices…"
              className="
                w-full bg-white/[0.03] border border-white/10 rounded-lg
                pl-9 pr-3 py-2 text-sm text-white placeholder:text-[#666]
                focus:outline-none focus:border-[#DFFF00]/30
              "
            />
          </div>
        </div>
      </div>

      <SubmitVoiceModal open={submitOpen} onClose={() => setSubmitOpen(false)} />

      <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {!countsReady ? (
          // Centered spinner while like-counts load (one SQLite query;
          // usually 50-200 ms). The grid then renders immediately in
          // sorted order. Per-card portrait loads are handled by
          // AvatarImage, which shows its own small spinner per card —
          // no need to gate the whole grid on image preloads.
          <div className="col-span-full flex flex-col items-center justify-center gap-3 min-h-[340px] text-white/55">
            <Loader2 size={28} className="animate-spin text-[#DFFF00]/80" aria-label="Loading voices" />
            <p className="text-xs tracking-wide">Loading voices…</p>
          </div>
        ) : (
          <>
            {ranked.map((v, idx) => (
              <VoiceCard
                key={v.id}
                voice={v}
                likeCount={counts[v.id] ?? 0}
                liked={myLikes.has(v.id)}
                canLike={!!user}
                onToggleLike={() => toggleLike(v.id)}
                // Show a rank ribbon for the top 3, but only when there
                // ARE likes at all and the user hasn't filtered to a
                // sub-list (otherwise "#1" mid-search is misleading).
                rank={
                  !search.trim() && idx < 3 && (counts[v.id] ?? 0) > 0
                    ? idx + 1
                    : undefined
                }
                // First 8 cards (= two full xl rows) sit above the fold on
                // typical viewports, fetch their portraits eagerly so the
                // grid paints in one go instead of popping in one by one.
                eagerImage={idx < 8}
              />
            ))}
            {ranked.length === 0 && (
              <div className="col-span-full text-center text-sm text-white/45 py-12">
                No voices match “{search}”.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------ */

function VoiceCard({
  voice, likeCount, liked, canLike, onToggleLike, rank, eagerImage,
}: {
  voice: SampleVoice;
  likeCount: number;
  liked: boolean;
  canLike: boolean;
  onToggleLike: () => void;
  /** 1-based rank if this voice is in the top-3 by likes. Renders a
   *  ribbon in the top-left of the card. Undefined = no ribbon. */
  rank?: number;
  /** Above-the-fold cards pass true so the portrait fetches at high
   *  priority instead of waiting for the lazy-load observer. */
  eagerImage?: boolean;
}) {
  const player = useStudioPlayer();
  const src = audioSrcFor(voice);
  const isThis = player.track?.src === src;
  const isPlaying = isThis && player.playing;

  // All cards use the SAME accent (brand chartreuse) but each gets a
  // deterministically randomised glow position + angle so no two cards
  // look identical at a glance. Seeded by voice.id so the look is
  // stable across renders.
  const variant = chartreuseGlowVariant(voice.id);

  const handlePlay = () => {
    if (!src) return;
    if (isPlaying) { player.pause(); return; }
    if (isThis)    { player.resume(); return; }
    player.play({
      src,
      title: voice.name,
      subtitle: voice.description,
    });
  };

  return (
    <div
      className={
        'group relative rounded-2xl border bg-white/[0.02] p-4 flex flex-col gap-3 overflow-hidden ' +
        'transition-all duration-300 ' +
        'hover:bg-white/[0.04] hover:-translate-y-[1px] hover:shadow-[0_10px_28px_-12px_rgba(0,0,0,0.55)] ' +
        (isPlaying
          ? 'border-[#DFFF00]/30 shadow-[0_0_0_1px_rgba(223,255,0,0.18),0_8px_24px_-12px_rgba(223,255,0,0.25)]'
          : 'border-white/[0.08] hover:border-white/[0.18]')
      }
    >
      {/* Chartreuse glow, same color everywhere, but the position +
          angle vary per card so the grid feels organic instead of
          stamped. Kept dim at rest, warms up subtly on hover. */}
      <div
        aria-hidden
        className="pointer-events-none absolute w-40 h-40 rounded-full blur-2xl opacity-[0.06] group-hover:opacity-[0.12] transition-opacity duration-500"
        style={{
          top: variant.primary.top,
          left: variant.primary.left,
          right: variant.primary.right,
          bottom: variant.primary.bottom,
          background: `radial-gradient(circle at center, rgba(223,255,0,0.85), transparent 70%)`,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute w-32 h-32 rounded-full blur-2xl opacity-0 group-hover:opacity-[0.07] transition-opacity duration-700"
        style={{
          top: variant.accent.top,
          left: variant.accent.left,
          right: variant.accent.right,
          bottom: variant.accent.bottom,
          background: `radial-gradient(circle at center, rgba(223,255,0,0.6), transparent 70%)`,
        }}
      />

      {/* Rank ribbon, only for top-3 voices with at least one like. */}
      {rank && <RankRibbon rank={rank} />}

      {/* Top row */}
      <div className="relative flex items-start gap-3">
        <div className="shrink-0 transition-transform duration-300 group-hover:scale-[1.04]">
          <SampleVoiceAvatar voice={voice} size="lg" eager={eagerImage} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <h3 className="text-white font-semibold text-[14.5px] leading-tight truncate">
              {voice.name}
            </h3>
            <HeartPill
              count={likeCount}
              liked={liked}
              canLike={canLike}
              onClick={onToggleLike}
            />
          </div>
          <p className="mt-1 text-[12px] text-[#A7B0B7] leading-snug line-clamp-2">
            {voice.description}
          </p>
          {/* Creator attribution, same pattern YouTube / Bandcamp /
              Hugging Face use. Tiny rounded-md (box) avatar + name as
              text, sits under the description where the eye naturally
              continues reading. No badge / no overlay on the portrait. */}
          {voice.submitter && (
            <SubmitterLine
              name={voice.submitter.name}
              picture={voice.submitter.picture}
            />
          )}
        </div>
      </div>

      {/* Action row */}
      <div className="relative flex items-center gap-2 mt-1">
        <button
          type="button"
          onClick={handlePlay}
          disabled={!src}
          aria-label={isPlaying ? `Pause ${voice.name}` : `Play ${voice.name}`}
          className={
            'shrink-0 inline-flex items-center justify-center h-9 w-9 rounded-full transition-all ' +
            (isPlaying
              ? 'bg-[#DFFF00] text-[#07080A] shadow-[0_0_18px_-2px_rgba(223,255,0,0.55)] hover:bg-[#DFFF00]/90'
              : 'bg-white/[0.06] text-white hover:bg-white/[0.14] hover:scale-105') +
            (src ? '' : ' opacity-40 cursor-not-allowed')
          }
        >
          {isPlaying
            ? <Pause size={15} className="fill-current" />
            : <Play  size={15} className="fill-current translate-x-[1px]" />}
        </button>
        <Link
          to={`/studio/tts?voice=${encodeURIComponent(voice.id)}`}
          className="
            flex-1 inline-flex items-center justify-center gap-1.5
            rounded-full bg-white/[0.04] border border-white/[0.10]
            px-3 py-2 text-[12.5px] font-semibold text-white/85
            hover:bg-white/[0.08] hover:border-white/20 hover:text-white
            transition-colors
          "
        >
          Use this voice
        </Link>
      </div>
    </div>
  );
}


/**
 * Creator attribution line for a community-contributed voice. A
 * tiny square (rounded-md) avatar + truncated name, with a tooltip
 * on hover for the full name. Same shape YouTube uses for "creator
 * row" below a thumbnail title, keeps the portrait clean while
 * still surfacing who made it.
 */
function SubmitterLine({
  name, picture,
}: { name: string | null; picture: string | null }) {
  const display = (name || 'Community member').trim() || 'Community member';
  const initial = display.charAt(0).toUpperCase();
  return (
    <div
      className="mt-2 inline-flex items-center gap-1.5 max-w-full"
      title={`Submitted by ${display}`}
    >
      <div
        className="w-4 h-4 rounded-[3px] bg-white/[0.08] overflow-hidden flex items-center justify-center shrink-0"
        aria-hidden
      >
        {picture ? (
          <img src={picture} alt="" className="w-full h-full object-cover" />
        ) : (
          <span className="text-[8px] font-semibold text-white/85 leading-none">{initial}</span>
        )}
      </div>
      <span className="text-[11px] text-white/45 truncate">
        by <span className="text-white/70">{display}</span>
      </span>
    </div>
  );
}


function RankRibbon({ rank }: { rank: number }) {
  // Top-3 hue: 1 = chartreuse (brand), 2 = silver-ish, 3 = warm copper.
  const palette =
    rank === 1
      ? 'bg-[#DFFF00]/15 text-[#DFFF00] border-[#DFFF00]/35'
      : rank === 2
        ? 'bg-white/[0.08] text-white/80 border-white/20'
        : 'bg-amber-500/12 text-amber-300 border-amber-400/30';
  return (
    <div
      className={
        'absolute top-2.5 left-2.5 z-10 inline-flex items-center gap-1 ' +
        'px-1.5 h-5 rounded-md border text-[9.5px] font-bold tabular-nums tracking-[0.06em] ' +
        palette
      }
      title={`#${rank} most-liked voice`}
    >
      <span className="opacity-70">#</span>{rank}
    </div>
  );
}


function HeartPill({
  count, liked, canLike, onClick,
}: {
  count: number;
  liked: boolean;
  canLike: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!canLike}
      title={canLike ? (liked ? 'Unlike' : 'Like this voice') : 'Sign in to like voices'}
      aria-label={liked ? 'Unlike voice' : 'Like voice'}
      aria-pressed={liked}
      className={
        'shrink-0 inline-flex items-center gap-1 px-2 h-7 rounded-full border text-[11px] font-semibold tabular-nums transition-colors ' +
        (liked
          ? 'bg-pink-500/15 border-pink-400/40 text-pink-300'
          : 'bg-white/[0.04] border-white/[0.08] text-white/55 hover:text-white/85 hover:bg-white/[0.08]') +
        (canLike ? '' : ' cursor-not-allowed opacity-60')
      }
    >
      <Heart size={12} className={liked ? 'fill-current' : ''} />
      <span>{formatLikeCount(count)}</span>
    </button>
  );
}


/** Each card picks one of 8 preset chartreuse-glow positions, seeded
 *  by voice id, so every card looks subtly different even though they
 *  all share the same brand accent. Offsets are negative so the glow
 *  blob bleeds in from outside the card frame. */
type Edge = string | undefined;
interface GlowSpot { top: Edge; right: Edge; bottom: Edge; left: Edge }
interface GlowVariant { primary: GlowSpot; accent: GlowSpot }

const GLOW_VARIANTS: GlowVariant[] = [
  // primary in a corner, accent in the diagonally opposite corner
  { primary: { top: '-3.5rem', right: '-3.5rem', bottom: undefined, left: undefined },
    accent:  { top: undefined, right: undefined, bottom: '-4rem',   left: '-2.5rem' } },
  { primary: { top: '-3rem',   left:  '-3rem',   bottom: undefined, right: undefined },
    accent:  { top: undefined, left:  undefined, bottom: '-3.5rem', right: '-3rem'  } },
  { primary: { bottom: '-3.5rem', right: '-3rem', top: undefined, left: undefined },
    accent:  { bottom: undefined, right: undefined, top: '-3rem', left: '-3rem' } },
  { primary: { bottom: '-3rem', left: '-3.5rem', top: undefined, right: undefined },
    accent:  { bottom: undefined, left: undefined, top: '-3rem', right: '-3rem' } },
  // primary along an edge, accent near the opposite edge
  { primary: { top: '-3rem', right: '20%', bottom: undefined, left: undefined },
    accent:  { top: undefined, right: undefined, bottom: '-3rem', left: '20%' } },
  { primary: { top: '-3rem', left:  '25%', bottom: undefined, right: undefined },
    accent:  { top: undefined, left:  undefined, bottom: '-3rem', right: '25%' } },
  { primary: { top: '30%', right: '-3.5rem', bottom: undefined, left: undefined },
    accent:  { top: undefined, right: undefined, bottom: '30%', left: '-3rem' } },
  { primary: { top: '30%', left: '-3.5rem', bottom: undefined, right: undefined },
    accent:  { top: undefined, left: undefined, bottom: '30%', right: '-3rem' } },
];


function chartreuseGlowVariant(id: string): GlowVariant {
  // Tiny string-hash → variant index. Deterministic so a given voice
  // always gets the same look across renders / page loads.
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return GLOW_VARIANTS[h % GLOW_VARIANTS.length]!;
}


/** 0 → "0", 999 → "999", 1234 → "1.2K", 12300 → "12K", 1_200_000 → "1.2M". */
function formatLikeCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) {
    const k = n / 1000;
    return k.toFixed(k < 10 ? 1 : 0).replace(/\.0$/, '') + 'K';
  }
  const m = n / 1_000_000;
  return m.toFixed(m < 10 ? 1 : 0).replace(/\.0$/, '') + 'M';
}
