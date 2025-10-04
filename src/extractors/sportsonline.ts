// Minimal sportsonline extractor replicating mandrakodi sportOnline + wigi logic.
// Strategy:
// 1. Fetch page -> find first <iframe src="...">
// 2. Fetch iframe with Referer=https://sportsonline.si/
// 3. Collect packed eval blocks; if >=2 use second (index 1) else first.
// 4. Unpack P.A.C.K.E.R. and search var src="...m3u8".
// 5. Return final m3u8 with referer param appended, else empty streams.

import { HostExtractor, ExtractResult, ExtractorContext } from './base';
import type { StreamForStremio } from '../types/animeunity';

function detectPackedBlocks(html: string): string[] {
  // Replica della regex Python (mandrakodi): 'eval(function(.+?.+)'
  // Qui catturiamo solo la parte dopo 'eval(function' e ricostruiamo.
  const simple = /eval\(function(.+?.+)/g; // greedy-ish, ma verrà limitato dal parser successivo
  const raw: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = simple.exec(html))) raw.push(m[1]);
  // Ricostruisci forma completa per l'unpacker che si aspetta eval(function...
  return raw.map(r => 'eval(function' + r);
}

// Lightweight P.A.C.K.E.R. unpacker (subset) adapted from jsbeautifier logic.
function unpackPacker(source: string): string | null {
  if (!/^eval\(function\(p,a,c,k,e,d/.test(source)) return null;
  try {
    // Multiple signature variants (with / without extra args)
    const patterns = [
      /\}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\), *(\d+), *(.*)\)\)/,
      /\}\('(.*)', *(\d+|\[\]), *(\d+), *'(.*)'\.split\('\|'\)\)/
    ];
    let payload = '', radix = 0, count = 0, symtab: string[] = [];
    for (const pat of patterns) {
      const m = pat.exec(source);
      if (m) {
        payload = m[1];
        const radixRaw = m[2];
        radix = radixRaw === '[]' ? 62 : parseInt(radixRaw, 10);
        count = parseInt(m[3], 10);
        symtab = m[4].split('|');
        break;
      }
    }
    if (!payload || !symtab.length) return null;
    function unbase(str: string): number {
      const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
      if (radix <= 36) return parseInt(str, radix);
      let val = 0; for (let i=0;i<str.length;i++) val = val * radix + alphabet.indexOf(str[i]);
      return val;
    }
    const decoded = payload.replace(/\b\w+\b/g, w => {
      try { const idx = unbase(w); return symtab[idx] || w; } catch { return w; }
    });
    return decoded;
  } catch { return null; }
}

async function fetchText(url: string, referer?: string): Promise<string | null> {
  try {
    const headers: Record<string,string> = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language':'en-US,en;q=0.9,it;q=0.8',
      'Cache-Control':'no-cache'
    };
    if (referer) headers['Referer'] = referer;
    const r = await fetch(url, { headers });
    if (!r.ok) return null; return await r.text();
  } catch { return null; }
}

export class SportsonlineExtractor implements HostExtractor {
  id = 'sportsonline';
  supports(url: string): boolean {
    return /sportzonline\.(st|bz|cc|top)|sportsonline\.(si|sn)/.test(url);
  }
  async extract(pageUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
    // Step 1: main page
    const mainHtml = await fetchText(pageUrl);
    if (!mainHtml) return { streams: [] };
    const iframeMatch = mainHtml.match(/<iframe src="(.*?)"/i);
    if (!iframeMatch) return { streams: [] };
    let iframeUrl = iframeMatch[1];
    if (iframeUrl.startsWith('//')) iframeUrl = 'https:' + iframeUrl;
    else if (iframeUrl.startsWith('/')) iframeUrl = 'https:' + iframeUrl;

    // Step 2: iframe fetch
    const iframeHtml = await fetchText(iframeUrl, 'https://sportsonline.si/');
    if (!iframeHtml) return { streams: [] };

    // Optional dump for debug: set ENV STREAMVIX_DUMP_IFRAME=1
    if (typeof process !== 'undefined' && process?.env?.STREAMVIX_DUMP_IFRAME) {
      try { console.log('[SPORTSONLINE][IFRAME_LENGTH]', iframeHtml.length); } catch {}
    }

    const packedBlocks = detectPackedBlocks(iframeHtml);
    if (!packedBlocks.length) {
      // fallback: prova ricerca diretta di m3u8 nell'iframe (raro)
      const direct = iframeHtml.match(/https?:[^'"\s]+\.m3u8[^'"\s]*/);
      if (!direct) return { streams: [] };
      const finalDirect = direct[0] + '|referer=' + iframeUrl;
      return { streams: [{ title: 'Sportsonline • [LIVE]', url: finalDirect, behaviorHints: { notWebReady: false } as any }] };
    }
    // Come clone Python: se >=2 scegliere indice 1, altrimenti 0
    const chosenIdx = packedBlocks.length > 1 ? 1 : 0;
    let unpacked = unpackPacker(packedBlocks[chosenIdx]) || '';
    let srcMatch = unpacked.match(/var src=\"([^\"]+)/);
    if (!srcMatch) {
      // fallback: prova tutti gli altri blocchi
      for (let i = 0; i < packedBlocks.length && !srcMatch; i++) {
        if (i === chosenIdx) continue;
        const u = unpackPacker(packedBlocks[i]) || '';
        const m2 = u.match(/var src=\"([^\"]+)/);
        if (m2) { srcMatch = m2; unpacked = u; break; }
      }
    }
    if (!srcMatch) {
      // fallback extra: cerca src= senza var oppure m3u8 nel testo unpackato
      const alt = unpacked.match(/src=\"([^\"]+\.m3u8[^\"]*)/);
      if (alt) srcMatch = alt as any;
    }
    if (!srcMatch) return { streams: [] };
    const rawM3u8 = srcMatch[1];
  const finalUrl = rawM3u8; // Referer gestito nei behaviorHints

  const headers = { 'Referer': iframeUrl, 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' };
    const streams: StreamForStremio[] = [
      {
        title: 'Sportsonline • [LIVE]',
        url: finalUrl,
        behaviorHints: {
          notWebReady: true,
            proxyHeaders: {
              request: headers
          },
          proxyUseFallback: true
        } as any
      }
    ];
    return { streams };
  }
}

// Lightweight helper per ottenere direttamente la prima URL m3u8 dal canale sportzonline
export async function extractSportzonlineStream(pageUrl: string): Promise<{ url: string; headers: Record<string,string> } | null> {
  try {
    const inst = new SportsonlineExtractor();
    const result = await inst.extract(pageUrl, { } as any);
    if (!result.streams || !result.streams.length) return null;
    const first = result.streams[0];
    const bh: any = first.behaviorHints || {};
    const headers = (bh.proxyHeaders && bh.proxyHeaders.request) || {};
    return { url: first.url, headers };
  } catch { return null; }
}
