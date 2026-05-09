/**
 * SampleVoiceAvatar — renders a circular avatar for a SampleVoice.
 *
 * - If the voice has an `imageAssetKey` (CDN-hosted), uses that image.
 * - Otherwise, draws a code avatar: voice's first initial centered on a
 *   deterministic gradient (color is derived from the id, so the same
 *   voice always gets the same look).
 */

import { asset } from '../../data/assets';
import { API_BASE_URL } from '../../services/baseUrl';
import { avatarGradientPairFor, type SampleVoice } from '../../data/sampleVoices';

type Size = 'sm' | 'md' | 'lg';

const SIZE_CLASSES: Record<Size, string> = {
  sm: 'w-9 h-9 text-sm',
  md: 'w-12 h-12 text-base',
  lg: 'w-16 h-16 text-xl',
};

export function SampleVoiceAvatar({
  voice,
  size = 'md',
  rounded = 'full',
}: {
  voice: SampleVoice;
  size?: Size;
  rounded?: 'full' | 'lg';
}) {
  const cls = SIZE_CLASSES[size];
  const radius = rounded === 'full' ? 'rounded-full' : 'rounded-lg';

  // 1) CDN-hosted portrait (older voices)
  if (voice.imageAssetKey) {
    const url = asset(voice.imageAssetKey);
    if (url) {
      return (
        <div className={`${cls} ${radius} overflow-hidden bg-[#07080A] border border-white/10 shrink-0`}>
          <img src={url} alt={voice.name} className="w-full h-full object-cover" loading="lazy" />
        </div>
      );
    }
  }

  // 2) Backend-served portrait (newer local voices)
  if (voice.imageStaticPath) {
    const base = API_BASE_URL.replace(/\/$/, '');
    const url = `${base}/dashboard/sample-voices/${voice.imageStaticPath}`;
    return (
      <div className={`${cls} ${radius} overflow-hidden bg-[#07080A] border border-white/10 shrink-0`}>
        <img src={url} alt={voice.name} className="w-full h-full object-cover" loading="lazy" />
      </div>
    );
  }

  // 3) Code avatar fallback: two-ring deterministic gradient + initial
  const initial = voice.name.charAt(0).toUpperCase();
  const grad = avatarGradientPairFor(voice.id);
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
