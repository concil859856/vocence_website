/**
 * AgentAvatar — two-ring deterministic gradient tile.
 *
 * The visual is a brighter outer ring around a deeper inner body, with
 * a small visible gap between them. Each id picks one gradient from the
 * outer palette and a different one from the inner palette, so every
 * agent gets a distinct dual-tone identity. Initials sit in white text
 * on the inner body.
 *
 * Same color system used by My Voices tiles, agent cards, agent detail
 * header, agent chat header, and the StudioPlayerBar fallback artwork.
 */

import { avatarGradientPairFor } from '../../data/sampleVoices';

interface Props {
  /** Stable id (or any deterministic string) — picks the gradient pair. */
  id: string;
  /** Display name — used to derive the initials. */
  name: string;
  /** Tailwind size class set; defaults to medium (44 px). */
  size?: 'sm' | 'md' | 'lg';
  /** Tailwind rounding; defaults to "full" so the dual-ring reads as
   * concentric circles. Set to "xl" / "lg" if a square-ish look is
   * needed in a particular spot. */
  rounded?: 'lg' | 'xl' | 'full';
  className?: string;
}

const SIZE_CLS: Record<NonNullable<Props['size']>, { outer: string; ring: string; text: string }> = {
  sm: { outer: 'w-9 h-9',   ring: 'p-[2px]', text: 'text-[12px]' },
  md: { outer: 'w-11 h-11', ring: 'p-[2.5px]', text: 'text-sm' },
  lg: { outer: 'w-14 h-14', ring: 'p-[3px]', text: 'text-base' },
};

const ROUND_CLS: Record<NonNullable<Props['rounded']>, string> = {
  lg: 'rounded-lg',
  xl: 'rounded-xl',
  full: 'rounded-full',
};

function initialsOf(name: string): string {
  const parts = (name || '').split(/\s+/).filter(Boolean).slice(0, 2);
  if (parts.length === 0) return '?';
  return parts.map((p) => p[0]!.toUpperCase()).join('');
}

export function AgentAvatar({ id, name, size = 'md', rounded = 'full', className = '' }: Props) {
  const initials = initialsOf(name);
  const { outer, inner } = avatarGradientPairFor(`agent-${id}`);
  const sz = SIZE_CLS[size];
  const rd = ROUND_CLS[rounded];
  return (
    <div
      className={`shrink-0 bg-gradient-to-br ${outer} ${sz.outer} ${sz.ring} ${rd} ${className}`}
      aria-hidden
    >
      <div
        className={`w-full h-full flex items-center justify-center font-semibold text-white bg-gradient-to-br ${inner} ${rd} ${sz.text}`}
      >
        {initials}
      </div>
    </div>
  );
}
