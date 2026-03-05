//Adapted for use in Streamvix from:
// webstreamr in https://github.com/webstreamr/webstreamr
// 

import { HostExtractor, ExtractResult, ExtractorContext, normalizeUrl, parseSizeToBytes } from './base';
import type { StreamForStremio } from '../types/animeunity';
import { formatMediaFlowUrl } from '../utils/mediaflow';
// NOTE thanks to webstreamr for the logic
async function fetchText(url: string, referer?: string): Promise<string | null> {
  try {
    const headers: any = { 'User-Agent': 'Mozilla/5.0 (MixdropExtractor)' };
    if (referer) headers.Referer = referer;
    const r = await fetch(url, { headers });
    if (!r.ok) return null; return await r.text();
  } catch { return null; }
}

export class MixdropExtractor implements HostExtractor {
  id = 'mixdrop';
  supports(url: string) { return /mixdrop|m1xdrop|m[i1]xdr[o0]p/i.test(url); }
  async extract(rawUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
    const debug = true;
    // Require MediaFlow URL; password is optional
    if (!ctx.mfpUrl) {
      if (debug) console.log('[Mixdrop] skipped: no mfpUrl');
      return { streams: [] };
    }

    // Keep embed URL with original domain for MFP (MFP resolves the stream itself)
    let embedUrl = normalizeUrl(rawUrl).replace('/f/', '/e/');
    if (!/\/e\//.test(embedUrl)) embedUrl = embedUrl.replace('/f/', '/e/');

    if (debug) console.log('[Mixdrop] embedUrl=', embedUrl, 'mfpUrl=', ctx.mfpUrl);

    // Try to fetch /f/ page for metadata (title, size, resolution) — optional
    const fileUrl = embedUrl.replace('/e/', '/f/');
    const html = await fetchText(fileUrl, ctx.referer);

    // If page says file is gone on canonical domain, log it but still try MFP
    // (domain variants like m1xdrop.net may report "not found" on /f/ but /e/ works)
    const fileNotFound = html && /can't find the (file|video)/i.test(html);
    if (fileNotFound && debug) console.log('[Mixdrop] /f/ page says not found, still trying MFP wrap');

    // Extract metadata from page (if available)
    let titleFromPage: string | undefined;
    let sizeMatch: RegExpMatchArray | null = null;
    let resMatch: RegExpMatchArray | null = null;
    if (html && !fileNotFound) {
      const tm = html.match(/<b>([^<]+)<\/b>/) || html.match(/class="title"[^>]*>\s*<b>([^<]+)<\/b>/i);
      if (tm) titleFromPage = tm[1].trim();
      sizeMatch = html.match(/([\d.,]+ ?[GM]B)/);
      resMatch = html.match(/(\b[1-9]\d{2,3}p\b)/i);
    } else {
      if (debug) console.log('[Mixdrop] page fetch failed, proceeding with MFP wrap anyway');
    }

    // Build MediaFlow redirect URL
    const encoded = encodeURIComponent(embedUrl);
    const passwordParam = ctx.mfpPassword ? `&api_password=${encodeURIComponent(ctx.mfpPassword)}` : '';
    const finalUrl = `${ctx.mfpUrl.replace(/\/$/, '')}/extractor/video?host=Mixdrop${passwordParam}&d=${encoded}&redirect_stream=true`;

    if (debug) console.log('[Mixdrop] finalUrl=', finalUrl.substring(0, 100));

    const bytes = sizeMatch ? parseSizeToBytes(sizeMatch[1]) : undefined;
    let sizePart = '';
    if (bytes) {
      sizePart = bytes >= 1024 ** 3 ? (bytes / 1024 / 1024 / 1024).toFixed(2) + 'GB' : (bytes / 1024 / 1024).toFixed(0) + 'MB';
    }

    // First line: prefer Italian titleHint, else extracted title, else fallback
    let baseTitle = (ctx.titleHint || titleFromPage || 'Mixdrop').trim();
    // Ensure bullet + [ITA]
    if (!/\[ITA\]$/i.test(baseTitle)) {
      if (!/•\s*\[ITA\]$/i.test(baseTitle)) baseTitle = `${baseTitle} • [ITA]`;
    }

    const line2Segs: string[] = [];
    if (sizePart) line2Segs.push(sizePart);
    if (resMatch) line2Segs.push(resMatch[1].toLowerCase());
    // Capitalized host label
    line2Segs.push('Mixdrop');
    // Always show second line with Mixdrop label
    const fullTitle = `${baseTitle}\n💾 ${line2Segs.join(' • ')}`;

    const streams: StreamForStremio[] = [{ title: fullTitle, url: finalUrl, behaviorHints: { notWebReady: true } as any }];
    return { streams };
  }
}
