//Adapted for use in Streamvix from:
// webstreamr in https://github.com/webstreamr/webstreamr
// 

import { ExtractResult, ExtractorContext, HostExtractor } from './base';
import { SuperVideoExtractor } from './supervideo';
import { DroploadExtractor } from './dropload'; // keep legacy
import { MixdropExtractor } from './mixdrop';
import { StreamtapeExtractor } from './streamtape';
import { DoodStreamExtractor } from './doodstream';
// Temporarily disabled adapters to avoid pulling full webstreamr TS tree into build
// import { WsDroploadAdapter, WsDoodAdapter } from './webstreamr-adapters';

const extractors: HostExtractor[] = [
  new SuperVideoExtractor(),
  new DroploadExtractor(), // legacy attempt
  // new WsDroploadAdapter(), // adapter disabled
  new MixdropExtractor(),
  new StreamtapeExtractor(),
  new DoodStreamExtractor(), // legacy
  // new WsDoodAdapter()
];

// Note: Deltabit is now resolved end-to-end inside the Python eurostreaming provider (DeltaBit -> mp4),
// so the previous TypeScript DeltabitExtractor has been removed to avoid duplicate resolution paths.

export async function extractFromUrl(url: string, ctx: ExtractorContext): Promise<ExtractResult> {
  for (const ex of extractors) {
    if (ex.supports(url)) {
      try {
        console.log('[EXTRACT][MATCH]', ex.id, 'url=', url, 'mfp?', !!ctx.mfpUrl && !!ctx.mfpPassword);
        const r = await ex.extract(url, ctx);
        console.log('[EXTRACT][DONE]', ex.id, 'streams=', r.streams?.length || 0);
        return r;
      } catch (e) {
        console.log('[EXTRACT][ERR]', ex.id, (e as any)?.message || e);
        return { streams: [] };
      }
    }
  }
  console.log('[EXTRACT][NO_MATCH]', url);
  return { streams: [] };
}

export function getSupportedExtractorIds(): string[] { return extractors.map(e => e.id); }
