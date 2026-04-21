import manifest from './assets.json';

type AssetEntry = { url: string; type: string; size: number; originalSize?: number; source?: string };
type AssetManifest = { version: number; baseUrl: string; generatedAt: string; assets: Record<string, AssetEntry> };

const m = manifest as AssetManifest;

export const asset = (key: string): string => {
  const entry = m.assets[key];
  if (!entry) {
    if (import.meta.env.DEV) console.warn(`[assets] missing key: ${key}`);
    return '';
  }
  return entry.url;
};

export const assetKeys = (prefix: string): string[] =>
  Object.keys(m.assets).filter((k) => k.startsWith(`${prefix}.`));

export const assetsByPrefix = (prefix: string): string[] =>
  assetKeys(prefix).map((k) => m.assets[k].url);
