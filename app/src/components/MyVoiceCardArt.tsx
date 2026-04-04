import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';

const fallbackClass =
  'h-full w-full bg-gradient-to-br from-[#1a1f2e] via-[#131826] to-[#0a0e14]';

type Props = {
  /** Public URLs from `/abstract/manifest.json` (raster files in `public/abstract/`). */
  urls: string[];
  className?: string;
  /** Stable index into `urls` (e.g. voice id) so the same card doesn’t reshuffle when the pool updates. */
  seed?: number;
  /** Use `loading="eager"` for above-the-fold grid cards. */
  eager?: boolean;
};

function pickUrl(urls: string[], seed: number | undefined): string | null {
  if (!urls.length) return null;
  if (seed == null) return urls[Math.floor(Math.random() * urls.length)] ?? null;
  const idx = Math.abs(seed) % urls.length;
  return urls[idx] ?? null;
}

type FadeImgProps = {
  src: string;
  eager: boolean;
};

function FadeInCardImage({ src, eager }: FadeImgProps) {
  const [loaded, setLoaded] = useState(false);

  return (
    <img
      src={src}
      alt=""
      className={cn(
        'relative z-[1] h-full w-full object-cover brightness-[1.05] saturate-[1.02]',
        'transition-opacity duration-300 ease-out',
        loaded ? 'opacity-100' : 'opacity-0'
      )}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      fetchPriority={eager ? 'high' : undefined}
      onLoad={() => setLoaded(true)}
    />
  );
}

export function MyVoiceCardArt({ urls, className = '', seed, eager = false }: Props) {
  const src = useMemo(() => pickUrl(urls, seed), [urls, seed]);

  return (
    <div className={cn('relative h-full w-full overflow-hidden', className)}>
      <div className={cn('absolute inset-0 z-0', fallbackClass)} aria-hidden />
      {src ? <FadeInCardImage key={src} src={src} eager={eager} /> : null}
    </div>
  );
}
