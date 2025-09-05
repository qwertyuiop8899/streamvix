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

export async function extractFromUrl(url: string, ctx: ExtractorContext): Promise<ExtractResult> {
  for (const ex of extractors) {
    if (ex.supports(url)) {
      try { return await ex.extract(url, ctx); } catch { return { streams: [] }; }
    }
  }
  return { streams: [] };
}

export function getSupportedExtractorIds(): string[] { return extractors.map(e => e.id); }
