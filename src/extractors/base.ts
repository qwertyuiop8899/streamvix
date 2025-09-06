//Adapted for use in Streamvix from:
// webstreamr in https://github.com/webstreamr/webstreamr
// 

import type { StreamForStremio } from '../types/animeunity';

export interface ExtractorContext {
  referer?: string;
  mfpUrl?: string;
  mfpPassword?: string;
  countryCode?: string; // e.g. 'IT'
  titleHint?: string; // Italian localized title to force line1
}

export interface ExtractResult {
  streams: StreamForStremio[];
}

export interface HostExtractor {
  id: string;
  supports(url: string): boolean;
  extract(url: string, ctx: ExtractorContext): Promise<ExtractResult>;
}

export const normalizeUrl = (u: string) => {
  if (u.startsWith('//')) return 'https:' + u;
  return u;
};

export const parseSizeToBytes = (raw: string): number | undefined => {
  const m = raw.trim().match(/([\d.,]+)\s*([KMG]?)B/i);
  if (!m) return undefined;
  const num = parseFloat(m[1].replace(',', '.'));
  const unit = m[2].toUpperCase();
  const mult = unit === 'G' ? 1024**3 : unit === 'M' ? 1024**2 : unit === 'K' ? 1024 : 1;
  return Math.round(num * mult);
};
