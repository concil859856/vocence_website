/**
 * Per-route SEO meta helpers.
 *
 * We're a Vite SPA — the static index.html ships one set of meta tags
 * (homepage). Without help, every URL crawlers fetch shows the homepage
 * title/description/og. Googlebot recovers because it runs JS and picks
 * up post-render mutations; non-JS crawlers (Bing, DuckDuckGo, AI
 * agents like ClaudeBot / GPTBot / PerplexityBot) do NOT, so for those
 * we ALSO ship llms.txt + llms-full.txt + an expanded sitemap. This
 * hook handles the JS-rendered path: it updates document.title and the
 * existing <meta>/<link> tags in-place when a route mounts, and resets
 * to the original homepage values on unmount so navigating back doesn't
 * leak stale copy.
 */
import { useEffect } from 'react';

const SITE_ORIGIN = 'https://www.vocence.ai';

const DEFAULT_TITLE = 'Vocence — Decentralized Voice AI';
const DEFAULT_DESCRIPTION =
  'Generate speech from prompts, clone any voice, design custom voices, and create music — powered by a decentralized network on Bittensor. 300 free credits to start.';
const DEFAULT_OG_IMAGE = `${SITE_ORIGIN}/og.png`;

export interface PageMeta {
  /** Will be appended with " | Vocence" unless it already ends with "Vocence". */
  title: string;
  description: string;
  /** Site-relative path (no origin). E.g. ``/docs/api``. */
  path: string;
  /** Optional. Falls back to the homepage og.png. */
  ogImage?: string;
}

function setMeta(selector: string, value: string): void {
  const el = document.head.querySelector<HTMLMetaElement>(selector);
  if (el) el.setAttribute('content', value);
}

function setLink(rel: string, href: string): void {
  const el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (el) el.setAttribute('href', href);
}

/**
 * Update document.title + every shipped meta/link tag for the current
 * route. Restores the homepage values on unmount.
 */
export function usePageMeta(meta: PageMeta): void {
  const { title, description, path, ogImage } = meta;
  useEffect(() => {
    const fullTitle = /vocence/i.test(title) ? title : `${title} | Vocence`;
    const url = `${SITE_ORIGIN}${path}`;
    const image = ogImage || DEFAULT_OG_IMAGE;

    document.title = fullTitle;
    setMeta('meta[name="description"]', description);
    setMeta('meta[property="og:title"]', fullTitle);
    setMeta('meta[property="og:description"]', description);
    setMeta('meta[property="og:url"]', url);
    setMeta('meta[property="og:image"]', image);
    setMeta('meta[name="twitter:title"]', fullTitle);
    setMeta('meta[name="twitter:description"]', description);
    setMeta('meta[name="twitter:image"]', image);
    setLink('canonical', url);

    return () => {
      document.title = DEFAULT_TITLE;
      setMeta('meta[name="description"]', DEFAULT_DESCRIPTION);
      setMeta('meta[property="og:title"]', DEFAULT_TITLE);
      setMeta('meta[property="og:description"]', DEFAULT_DESCRIPTION);
      setMeta('meta[property="og:url"]', `${SITE_ORIGIN}/`);
      setMeta('meta[property="og:image"]', DEFAULT_OG_IMAGE);
      setMeta('meta[name="twitter:title"]', DEFAULT_TITLE);
      setMeta('meta[name="twitter:description"]', DEFAULT_DESCRIPTION);
      setMeta('meta[name="twitter:image"]', DEFAULT_OG_IMAGE);
      setLink('canonical', `${SITE_ORIGIN}/`);
    };
  }, [title, description, path, ogImage]);
}
