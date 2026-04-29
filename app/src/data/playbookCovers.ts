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

/** All abstract images uploaded to R2 (voice-themed + generic). */
export const ABSTRACT_COVERS: string[] = shuffleOnce(
  assetKeys('abstract')
    .filter((k) => !k.endsWith('.manifest'))
    .map((k) => asset(k))
    .filter(Boolean),
);

/** Everything in display order, also shuffled across groups so the gallery
 *  feels truly random rather than three sequential blocks. */
export const PLAYBOOK_COVERS: string[] = shuffleOnce([
  ...CURATED_COVERS,
  ...MUSIC_SAMPLE_COVERS,
  ...ABSTRACT_COVERS,
]);

/**
 * Resolve a cover URL for a playbook. Returns the user-set `cover_image_url` when
 * present, otherwise an empty string — callers should render a "no cover yet"
 * placeholder rather than auto-assign one. New playbooks start blank.
 */
export function coverFor(pb: { id: number; cover_image_url?: string | null }): string {
  return pb.cover_image_url || '';
}
