/**
 * AgentAvatar — colorful, deterministic identity tile.
 *
 * Each agent gets a unique abstract artwork pulled from the
 * ``ABSTRACT_COVERS`` pool (50+ pre-generated cover images), seeded
 * by the agent id. Initials sit on top in white with a soft drop
 * shadow so the agent name remains identifiable at a glance over
 * the busy artwork. The same agent always lands on the same image —
 * navigating between pages doesn't shuffle.
 *
 * Previously this rendered a two-ring gradient. We swapped to the
 * image-based identity so the avatar matches the rest of the cover
 * system (playbook covers, track artwork) — anywhere an item lacks
 * its own image, this is the visual it gets.
 *
 * Same component is used by My Voices tiles (via avatarGradientPairFor
 * still — that one's voice-keyed, not agent-keyed), agent cards,
 * agent detail header, agent chat header, and any future surface
 * that needs an agent identity tile.
 */

import { fallbackCoverFor } from '../../data/playbookCovers';

interface Props {
  /** Stable id (or any deterministic string) — seeds the cover pick. */
  id: string;
  /** Display name — used to derive the initials overlay. */
  name: string;
  /** Tailwind size class set; defaults to medium (44 px). ``xl`` is
   *  the hero-sized variant used on the AgentDetail header. ``xs``
   *  (28 px) is the compact variant used in dense chat headers. */
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  /** Tailwind rounding; defaults to "full" so the avatar reads as a
   *  circular profile tile. Set to "xl" / "lg" / "2xl" for square-ish
   *  identity blocks (large hero covers, list thumbnails). */
  rounded?: 'lg' | 'xl' | '2xl' | 'full';
  className?: string;
  /** Hide the initials overlay — useful when the surrounding UI
   *  already shows the agent name big and the initials add noise. */
  hideInitials?: boolean;
}

const SIZE_CLS: Record<NonNullable<Props['size']>, { outer: string; text: string }> = {
  xs: { outer: 'w-7 h-7',                       text: 'text-[10px]' },
  sm: { outer: 'w-9 h-9',                       text: 'text-[12px]' },
  md: { outer: 'w-11 h-11',                     text: 'text-sm' },
  lg: { outer: 'w-14 h-14',                     text: 'text-lg' },
  // Hero sizing — bigger initials drop-shadow so the letter stays
  // readable over the high-saturation abstract artwork.
  xl: { outer: 'w-32 h-32 sm:w-36 sm:h-36',     text: 'text-3xl sm:text-4xl' },
};

const ROUND_CLS: Record<NonNullable<Props['rounded']>, string> = {
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  '2xl': 'rounded-2xl',
  full: 'rounded-full',
};


function initialsOf(name: string): string {
  const parts = (name || '').split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length === 0) return '?';
  return parts.map((p) => p[0]!.toUpperCase()).join('');
}


export function AgentAvatar({
  id,
  name,
  size = 'md',
  rounded = 'full',
  className = '',
  hideInitials = false,
}: Props) {
  const initials = initialsOf(name);
  // Same seed shape used elsewhere ("agent-${id}") so the agent's
  // image is stable across every surface that displays it — card,
  // detail hero, chat header all land on the same artwork.
  const cover = fallbackCoverFor(`agent-${id}`);
  const sz = SIZE_CLS[size];
  const rd = ROUND_CLS[rounded];
  return (
    <div
      className={`shrink-0 relative overflow-hidden bg-gradient-to-br from-[#1c1d21] to-[#111215] ${sz.outer} ${rd} ${className}`}
      aria-label={name}
    >
      {cover && (
        <img
          src={cover}
          alt=""
          loading="lazy"
          aria-hidden
          className="absolute inset-0 w-full h-full object-cover"
        />
      )}
      {!hideInitials && (
        <span
          className={`absolute inset-0 flex items-center justify-center font-semibold text-white ${sz.text}`}
          style={{
            // Light multiply-blend overlay + text shadow keep the
            // initials readable on bright/busy artwork without
            // washing out the underlying colors.
            textShadow: '0 1px 4px rgba(0,0,0,0.55), 0 0 8px rgba(0,0,0,0.35)',
          }}
        >
          {initials}
        </span>
      )}
    </div>
  );
}
