//Adapted for use in Streamvix from:
// webstreamr in https://github.com/webstreamr/webstreamr
// 

import { HostExtractor, ExtractResult, ExtractorContext, normalizeUrl, parseSizeToBytes } from './base';
import type { StreamForStremio } from '../types/animeunity';
import { formatMediaFlowUrl } from '../utils/mediaflow';
// NOTE thanks to webstreamr for the logic
async function fetchText(url: string, referer?: string): Promise<string | null> {
  try {
    const headers: any = { 'User-Agent':'Mozilla/5.0 (MixdropExtractor)' };
    if (referer) headers.Referer = referer;
    const r = await fetch(url, { headers });
    if(!r.ok) return null; return await r.text();
  } catch { return null; }
}

export class MixdropExtractor implements HostExtractor {
  id='mixdrop';
  supports(url:string){ return /mixdrop/i.test(url); }
  async extract(rawUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
  // Require MediaFlow credentials; if missing, exclude Mixdrop entirely (per new rule)
  if (!ctx.mfpUrl || !ctx.mfpPassword) return { streams: [] };
  // Emulate webstreamr: keep /e/ form for the public (embed) and fetch /f/ for meta (size/title)
  let embedUrl = normalizeUrl(rawUrl).replace('/f/', '/e/');
    if (!/\/e\//.test(embedUrl)) embedUrl = embedUrl.replace('/f/', '/e/');
    const fileUrl = embedUrl.replace('/e/', '/f/');
    const html = await fetchText(fileUrl, ctx.referer);
    if (!html) return { streams: [] };
    if (/can't find the (file|video)/i.test(html)) return { streams: [] };

    // Title & size like webstreamr (title inside .title b)
    const titleMatch = html.match(/<b>([^<]+)<\/b>/) || html.match(/class="title"[^>]*>\s*<b>([^<]+)<\/b>/i);
    const sizeMatch = html.match(/([\d.,]+ ?[GM]B)/);
    // Try to infer resolution (e.g. 720p / 1080p) from page text
    const resMatch = html.match(/(\b[1-9]\d{2,3}p\b)/i);
    // Real video URL is provided via MediaFlow proxy; we mimic by returning a proxy redirect style link if credentials provided, else keep embed (so Stremio opens it, or we provide file page URL as last resort)
    // If mfp available, wrap embedUrl (NOT /f/) to allow remote server to resolve actual media like original project.
  // Build MediaFlow redirect URL (always, since we enforce presence above)
  const encoded = encodeURIComponent(embedUrl);
  const finalUrl = `${ctx.mfpUrl.replace(/\/$/,'')}/extractor/video?host=Mixdrop&api_password=${encodeURIComponent(ctx.mfpPassword)}&d=${encoded}&redirect_stream=true`;

    const bytes = sizeMatch ? parseSizeToBytes(sizeMatch[1]) : undefined;
    let sizePart = '';
    if (bytes) {
      sizePart = bytes >= 1024**3 ? (bytes/1024/1024/1024).toFixed(2)+'GB' : (bytes/1024/1024).toFixed(0)+'MB';
    }

    // First line: prefer Italian titleHint, else extracted title, else fallback
    let baseTitle = (ctx.titleHint || (titleMatch ? titleMatch[1].trim() : 'Mixdrop')).trim();
    // Ensure bullet + [ITA]
    if (!/\[ITA\]$/i.test(baseTitle)) {
      // append bullet only if not already there
      if (!/•\s*\[ITA\]$/i.test(baseTitle)) baseTitle = `${baseTitle} • [ITA]`;
    }

  const line2Segs: string[] = [];
  if (sizePart) line2Segs.push(sizePart);
  if (resMatch) line2Segs.push(resMatch[1].toLowerCase());
  // Capitalized host label
  line2Segs.push('Mixdrop');
  // If both size & resolution missing, omit second line entirely per new rule
  const fullTitle = (sizePart || resMatch) ? `${baseTitle}\n💾 ${line2Segs.join(' • ')}` : baseTitle;

    // Restore notWebReady (will show lock unless overridden upstream; addon logic handles Mixdrop lock removal by name property)
    const streams: StreamForStremio[] = [{ title: fullTitle, url: finalUrl, behaviorHints: { notWebReady: true } as any }];
    return { streams };
  }
}
