//Adapted for use in Streamvix from:
// webstreamr in https://github.com/webstreamr/webstreamr
// 

import { ExtractResult, ExtractorContext, HostExtractor } from './base';
import { SuperVideoExtractor } from './supervideo';
import { DroploadExtractor } from './dropload'; // keep legacy
import { MixdropExtractor } from './mixdrop';
import { DoodStreamExtractor } from './doodstream';
// Temporarily disabled adapters to avoid pulling full webstreamr TS tree into build
// import { WsDroploadAdapter, WsDoodAdapter } from './webstreamr-adapters';

const extractors: HostExtractor[] = [
  new SuperVideoExtractor(),
  new DroploadExtractor(), // legacy attempt
  // new WsDroploadAdapter(), // adapter disabled
  new MixdropExtractor(),
  new DoodStreamExtractor(), // legacy
  // new WsDoodAdapter()
];

// Note: Deltabit is now resolved end-to-end inside the Python eurostreaming provider (DeltaBit -> mp4),
// so the previous TypeScript DeltabitExtractor has been removed to avoid duplicate resolution paths.

export async function extractFromUrl(url: string, ctx: ExtractorContext): Promise<ExtractResult> {
  for (const ex of extractors) {
    if (ex.supports(url)) {
      try { return await ex.extract(url, ctx); } catch { return { streams: [] }; }
    }
  }
  return { streams: [] };
}

export function getSupportedExtractorIds(): string[] { return extractors.map(e => e.id); }
