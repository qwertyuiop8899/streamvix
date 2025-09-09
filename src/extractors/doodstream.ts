import { HostExtractor, ExtractResult, ExtractorContext, normalizeUrl } from './base';
import type { StreamForStremio } from '../types/animeunity';

// Implementazione ridotta identica a webstreamr (singolo host dood.to, singolo pass_md5).

function randomToken(len=10){ const chars='abcdefghijklmnopqrstuvwxyz0123456789'; let o=''; for(let i=0;i<len;i++) o+=chars[Math.floor(Math.random()*chars.length)]; return o; }

export class DoodStreamExtractor implements HostExtractor {
  id='doodstream';
  supports(url: string){ return /dood|do[0-9]go|doood|dooood|ds2play|ds2video|d0o0d|do0od|d0000d|d000d|vidply|all3do|doply|vide0|vvide0|d-s/i.test(url); }
  async extract(rawUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
    const debug = !!((globalThis as any).process?.env?.DOOD_DEBUG === '1');
    const normU = new URL(normalizeUrl(rawUrl));
    const videoId = normU.pathname.split('/').pop();
    if (!videoId) return { streams: [] };
    const embedUrl = `http://dood.to/e/${videoId}`;
    if (debug) console.log('[Dood] embed', embedUrl);
    let html: string | null = null;
    try {
      const resp = await fetch(embedUrl, { headers:{ 'User-Agent':'node','Accept':'text/html,*/*;q=0.8','Accept-Language':'en' } as any });
      html = await resp.text();
    } catch {}
    if (!html) { if (debug) console.log('[Dood] no html'); return { streams: [] }; }
    if (debug) console.log('[Dood] html len', html.length);
    const pass = html.match(/\/pass_md5\/[\w-]+\/([\w-]+)/);
    if (debug) console.log('[Dood] pass_md5', pass? pass[0]: null);
    if (!pass) return { streams: [] };
    const token = pass[1];
    const passUrl = new URL(pass[0], 'http://dood.to').toString();
    if (debug) console.log('[Dood] passUrl', passUrl);
    let baseUrl: string | null = null;
    try {
      const r2 = await fetch(passUrl, { headers:{ 'User-Agent':'node','Accept':'*/*','X-Requested-With':'XMLHttpRequest','Referer':'http://dood.to' } as any });
      baseUrl = await r2.text();
    } catch {}
    if (!baseUrl) return { streams: [] };
    baseUrl = baseUrl.trim();
    if (debug) console.log('[Dood] baseUrl', baseUrl.slice(0,140));
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i); let title = titleMatch? titleMatch[1]: 'Doodstream';
    title = title.replace(/ - DoodStream/i,'').trim();
    if (ctx.titleHint) title = ctx.titleHint;
    const mp4 = baseUrl.includes('cloudflarestorage') ? baseUrl : `${baseUrl}${randomToken(10)}?token=${token}&expiry=${Date.now()}`;
    if (debug) console.log('[Dood] final mp4', mp4);
    const stream: StreamForStremio = { title: `${title} • [ITA]\n💾 doodstream`, url: mp4, behaviorHints:{ notWebReady:true, referer:'http://dood.to' } } as StreamForStremio;
    return { streams:[stream] };
  }
}
