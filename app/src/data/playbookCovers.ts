import { asset, assetKeys } from './assets';

/** Fisher–Yates shuffle. Pure, returns a new array. Used once at module load
 *  so the picker order is fresh per session but stable within it. */
function shuffleOnce<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** The 41 curated playbook cover images (people + AI-generated music vibes). */
export const CURATED_COVERS: string[] = shuffleOnce(
  assetKeys('playbook')
    .filter((k) => k.startsWith('playbook.cover-'))
    .map((k) => asset(k))
    .filter(Boolean),
);

/** The 8 original music-genre sample images (Vite-served from public/). */
export const MUSIC_SAMPLE_COVERS: string[] = shuffleOnce(
  Array.from({ length: 8 }, (_, i) => `/samples/images/music_${i + 1}.webp`),
);

/** All abstract images uploaded to R2, in their manifest order. This
 *  is the **stable** list — never shuffled — used by ``fallbackCoverFor``
 *  so a given seed always lands on the same image across reloads.
 *  Sorted by key for a deterministic order even if the JSON manifest
 *  is regenerated with a different field order. */
const STABLE_ABSTRACT_COVERS: string[] =
  assetKeys('abstract')
    .filter((k) => !k.endsWith('.manifest'))
    .sort()
    .map((k) => asset(k))
    .filter(Boolean);

/** Display-order abstract covers — shuffled at module load so the
 *  cover-picker gallery doesn't always start with the same image.
 *  Do NOT use this for ``fallbackCoverFor`` lookups; the shuffle
 *  makes the same seed land on a different URL each session. */
export const ABSTRACT_COVERS: string[] = shuffleOnce(STABLE_ABSTRACT_COVERS);

/** Everything in display order, also shuffled across groups so the gallery
 *  feels truly random rather than three sequential blocks. */
export const PLAYBOOK_COVERS: string[] = shuffleOnce([
  ...CURATED_COVERS,
  ...MUSIC_SAMPLE_COVERS,
  ...ABSTRACT_COVERS,
]);

/**
 * Tiny string-hash for deterministic fallback selection. Same input
 * always lands on the same index — no flicker between renders. Mirrors
 * the seed pattern in ``avatarGradientPairFor``.
 */
function _seedHash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    // FNV-1a-ish: multiply + bitwise xor, kept in unsigned 32-bit range.
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h;
}

/**
 * Deterministic fallback cover from the abstract pool. Items lacking an
 * explicit image (no ``cover_image_url``, no ``image_url``, etc.) get
 * a stable, colorful identity by hashing their id into the **stable**
 * abstract list — NOT the shuffled display list — so the same id
 * always lands on the same image across page reloads / sessions.
 *
 * Use anywhere an item needs a visual identity but the user hasn't
 * provided one — playbook list cards, track rows, agent avatars, etc.
 */
export function fallbackCoverFor(seed: string | number): string {
  if (STABLE_ABSTRACT_COVERS.length === 0) return '';
  const s = typeof seed === 'string' ? seed : String(seed);
  return STABLE_ABSTRACT_COVERS[_seedHash(s) % STABLE_ABSTRACT_COVERS.length] || '';
}

/**
 * Resolve a cover URL for a playbook. Prefers the user-set
 * ``cover_image_url`` when present; falls back to a deterministic
 * pick from ``ABSTRACT_COVERS`` keyed by the playbook id so the
 * card never renders without artwork.
 */
export function coverFor(pb: { id: number; cover_image_url?: string | null }): string {
  return pb.cover_image_url || fallbackCoverFor(`playbook-${pb.id}`);
}
