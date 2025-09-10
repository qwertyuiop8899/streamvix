import { HostExtractor, ExtractResult, ExtractorContext, normalizeUrl } from './base';
import type { StreamForStremio } from '../types/animeunity';

// Enhanced DoodStream extractor approximating behavior of external fetcher-based implementation.

// Implementazione ridotta identica a webstreamr (singolo host dood.to, singolo pass_md5).

function randomToken(len=10){ const chars='abcdefghijklmnopqrstuvwxyz0123456789'; let o=''; for(let i=0;i<len;i++) o+=chars[Math.floor(Math.random()*chars.length)]; return o; }

const DOOD_DOMAINS = [
  'https://dood.to', 'http://dood.to',
  'https://dood.li', 'http://dood.li',
  'https://dood.ws', 'http://dood.ws',
  'https://d000d.com', 'http://d000d.com'
];
const BASE_HEADERS = {
  'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language':'en-US,en;q=0.9,it;q=0.6'
};

async function headForSize(url: string, referer: string): Promise<number | undefined> {
  try {
    const r = await fetch(url, { method:'HEAD', headers:{ 'User-Agent': BASE_HEADERS['User-Agent'], 'Referer': referer } as any });
    const cl = r.headers.get('content-length');
    if (cl) return parseInt(cl,10);
    const disp = r.headers.get('content-disposition');
    if (disp) {
      const sizeMatch = disp.match(/size=([0-9]+)/i);
      if (sizeMatch) return parseInt(sizeMatch[1],10);
    }
  } catch {}
  return undefined;
}

export class DoodStreamExtractor implements HostExtractor {
  id='doodstream';
  supports(url: string){ return /dood|do[0-9]go|doood|dooood|ds2play|ds2video|d0o0d|do0od|d0000d|d000d|vidply|all3do|doply|vide0|vvide0|d-s/i.test(url); }
  async extract(rawUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
    const debug = !!((globalThis as any).process?.env?.DOOD_DEBUG === '1');
    const normU = new URL(normalizeUrl(rawUrl));
    const videoId = normU.pathname.split('/').pop();
    if (!videoId) return { streams: [] };

    // Try each dood domain until we get pass_md5
    let html: string | null = null;
    let domain: string | undefined;
    for (const base of DOOD_DOMAINS) {
      const embed = `${base}/e/${videoId}`;
      if (debug) console.log('[Dood] try', embed);
      try {
        const resp = await fetch(embed, { headers: BASE_HEADERS as any });
        if (!resp.ok) continue;
        const text = await resp.text();
        if (/pass_md5/.test(text)) { html = text; domain = base; break; }
      } catch {}
    }
    if (!html || !domain) return { streams: [] };
    if (debug) console.log('[Dood] got html from', domain, 'len', html.length);

    // Extract pass_md5 path
  const passMatch = html.match(/(\/pass_md5\/[\w-]+\/[\w-]+)/);
    if (debug) console.log('[Dood] pass_md5', passMatch? passMatch[1]: null);
    if (!passMatch) return { streams: [] };
  const passPath = passMatch[1];
  const token = passPath.split('/').pop();
  let passUrl: string;
  try { passUrl = new URL(passPath, domain).toString(); } catch { passUrl = domain.replace(/\/$/,'') + passPath; }

    // Resolve base video url
    let baseUrl: string | undefined;
    try {
      const r2 = await fetch(passUrl, { headers: { ...BASE_HEADERS, 'X-Requested-With':'XMLHttpRequest', 'Referer': domain } as any });
      if (r2.ok) baseUrl = (await r2.text()).trim();
    } catch {}
    if (!baseUrl) return { streams: [] };
    if (debug) console.log('[Dood] baseUrl', baseUrl.slice(0,120));

    // Title
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i); let title = titleMatch? titleMatch[1]: 'Doodstream';
    title = title.replace(/ - DoodStream/i,'').trim();
    if (ctx.titleHint) title = ctx.titleHint;

    // Final mp4
    const mp4 = baseUrl.includes('cloudflarestorage') ? baseUrl : `${baseUrl}${randomToken(10)}?token=${token}&expiry=${Date.now()}`;

    // Optional size HEAD probe (quick, can fail silently)
  const sizeBytes = await headForSize(mp4, domain).catch(()=>undefined);
    const sizeLabel = sizeBytes ? ` • ${(sizeBytes/1024/1024).toFixed(1)} MB` : '';

    const stream: StreamForStremio = {
      title: `${title} • [ITA]${sizeLabel}\n💾 doodstream`,
      url: mp4,
      behaviorHints:{ notWebReady:true, referer: domain }
    } as StreamForStremio;
    if (sizeBytes) (stream as any).bytes = sizeBytes;
    return { streams:[stream] };
  }
}
