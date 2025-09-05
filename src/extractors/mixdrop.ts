import { HostExtractor, ExtractResult, ExtractorContext, normalizeUrl, parseSizeToBytes } from './base';
import type { StreamForStremio } from '../types/animeunity';
import { formatMediaFlowUrl } from '../utils/mediaflow';

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
    // Real video URL is provided via MediaFlow proxy; we mimic by returning a proxy redirect style link if credentials provided, else keep embed (so Stremio opens it, or we provide file page URL as last resort)
    // If mfp available, wrap embedUrl (NOT /f/) to allow remote server to resolve actual media like original project.
    let finalUrl = embedUrl;
    if (ctx.mfpUrl && ctx.mfpPassword) {
      // Use /extractor/video variant requested by user
      const encoded = encodeURIComponent(embedUrl);
      finalUrl = `${ctx.mfpUrl.replace(/\/$/,'')}/extractor/video?host=Mixdrop&api_password=${encodeURIComponent(ctx.mfpPassword)}&d=${encoded}&redirect_stream=true`;
    }

    const bytes = sizeMatch ? parseSizeToBytes(sizeMatch[1]) : undefined;
    let sizePart = '';
    if (bytes) {
      sizePart = bytes >= 1024**3 ? (bytes/1024/1024/1024).toFixed(2)+'GB' : (bytes/1024/1024).toFixed(0)+'MB';
    }
  const baseTitle = ctx.titleHint || (titleMatch ? titleMatch[1].trim() : 'Mixdrop');
  const line1 = `${baseTitle} • [ITA]`;
    const line2Segs: string[] = [];
    if (sizePart) line2Segs.push(sizePart);
    line2Segs.push('mixdrop');
    const title = line2Segs.length ? `${line1}\n💾 ${line2Segs.join(' • ')}` : line1;
    const streams: StreamForStremio[] = [{ title, url: finalUrl, behaviorHints:{ notWebReady:true } }];
    return { streams };
  }
}
