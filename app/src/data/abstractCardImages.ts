import { assetsByPrefix } from './assets';

export const DEFAULT_ABSTRACT_CARD_IMAGES: string[] = assetsByPrefix('abstract').filter(
  (url) => !url.endsWith('.json'),
);
