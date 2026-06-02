/**
 * SampleVoiceAvatar, renders a circular avatar for a SampleVoice.
 *
 * - If the voice has an `imageAssetKey` (CDN-hosted), uses that image.
 * - Otherwise, draws a code avatar: voice's first initial centered on a
 *   deterministic gradient (color is derived from the id, so the same
 *   voice always gets the same look).
 *
 * Cards in the above-the-fold portion of a grid should pass
 * ``eager`` so the portrait fetches at high priority and the user
 * doesn't watch them pop in one by one.
 */

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { asset } from '../../data/assets';
import { avatarGradientPairFor, type SampleVoice } from '../../data/sampleVoices';

// Bump this when the backend-served sample-voice avatars are replaced
// so browsers don't keep serving the cached previous file under the
// same URL. The voice .webp filenames stay stable, so without a
// version query browsers will keep showing the old picture until the
// user does a hard refresh.
// Exported so callers that want to preload an avatar URL (e.g. the
// Community Voices grid waiting for top portraits before reveal) use
// the same versioned URL the <img> tag will eventually request, the
// browser cache hits between the two then.
export const AVATAR_REV = 'v10-grok-females-chest-vneck-2026-06-01';

type Size = 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<Size, string> = {
  sm: 'w-9 h-9 text-sm',
  md: 'w-12 h-12 text-base',
  lg: 'w-16 h-16 text-xl',
};

/** Fade-in <img> with a centered spinner while loading. A previous
 *  version showed a brand-coloured gradient as the placeholder, which
 *  flashed visibly green on the Community Voices grid before the image
 *  arrived. A small spinner reads as "loading" instead of "broken"
 *  and matches the loading-states elsewhere in the app. */
function AvatarImage({
  src,
  alt,
  eager,
}: {
  src: string;
  alt: string;
  eager: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      {!loaded && (
        <div
          className="absolute inset-0 flex items-center justify-center bg-white/[0.04]"
          aria-hidden
        >
          <Loader2 className="size-4 animate-spin text-white/40" />
        </div>
      )}
      <img
        src={src}
        alt={alt}
        className={
          'relative z-[1] w-full h-full object-cover transition-opacity duration-150 ease-out ' +
          (loaded ? 'opacity-100' : 'opacity-0')
        }
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        fetchPriority={eager ? 'high' : undefined}
        onLoad={() => setLoaded(true)}
      />
    </>
  );
}

export function SampleVoiceAvatar({
  voice,
  size = 'md',
  rounded = 'full',
  eager = false,
}: {
  voice: SampleVoice;
  size?: Size;
  rounded?: 'full' | 'lg';
  /** Force ``loading="eager"`` + ``fetchPriority="high"`` for cards
   *  rendered above the fold so the portrait paints immediately. */
  eager?: boolean;
}) {
  const cls = SIZE_CLASSES[size];
  const radius = rounded === 'full' ? 'rounded-full' : 'rounded-lg';
  const grad = avatarGradientPairFor(voice.id);

  // 0) Direct URL (community-submitted voices stored in MinIO/R2 —
  // their portraits live at a fixed URL, no CDN-key lookup needed.)
  if (voice.imageDirectUrl) {
    return (
      <div className={`relative ${cls} ${radius} overflow-hidden bg-[#07080A] border border-white/10 shrink-0`}>
        <AvatarImage src={voice.imageDirectUrl} alt={voice.name} eager={eager} />
      </div>
    );
  }

  // 1) CDN-hosted portrait (older voices)
  if (voice.imageAssetKey) {
    const url = asset(voice.imageAssetKey);
    if (url) {
      return (
        <div className={`relative ${cls} ${radius} overflow-hidden bg-[#07080A] border border-white/10 shrink-0`}>
          <AvatarImage src={url} alt={voice.name} eager={eager} />
        </div>
      );
    }
  }

  // 2) Backend-served portrait (newer local voices).
  // Served straight from Vite's /public dir (file lives in
  // app/public/sample-voices/) so the browser fetches it in a single
  // hop. The previous /api/dashboard/sample-voices/... path went
  // Vite-proxy → FastAPI → StaticFiles → back, which was visibly
  // slower on the community-voices grid. The backend still serves
  // the same files at the old path for any non-app consumer.
  if (voice.imageStaticPath) {
    const url = `/sample-voices/${voice.imageStaticPath}?v=${AVATAR_REV}`;
    return (
      <div className={`relative ${cls} ${radius} overflow-hidden bg-[#07080A] border border-white/10 shrink-0`}>
        <AvatarImage src={url} alt={voice.name} eager={eager} />
      </div>
    );
  }

  // 3) Code avatar fallback: two-ring deterministic gradient + initial
  const initial = voice.name.charAt(0).toUpperCase();
  return (
    <div className={`${cls} ${radius} shrink-0 p-[2px] bg-gradient-to-br ${grad.outer}`} aria-hidden>
      <div
        className={`w-full h-full ${radius} flex items-center justify-center font-semibold text-white bg-gradient-to-br ${grad.inner}`}
      >
        {initial}
      </div>
    </div>
  );
}
