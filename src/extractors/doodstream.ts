//Adapted for use in Streamvix from:
// webstreamr in https://github.com/webstreamr/webstreamr
// 

import { HostExtractor, ExtractResult, ExtractorContext, normalizeUrl } from './base';
import type { StreamForStremio } from '../types/animeunity';
// NOTE: Unlike Mixdrop we DO NOT wrap Doodstream with MediaFlow proxy to match webstreamr behavior.
// NOTE thanks to webstreamr for the logic
interface FetchResult { text: string | null; setCookie?: string[] }
async function fetchText(url: string, referer?: string, cookieJar: string[] = [], extraHeaders: Record<string,string> = {}): Promise<FetchResult> {
  try {
    const headers: any = {
      'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language':'it-IT,it;q=0.9,en-US;q=0.7,en;q=0.6',
      'Cache-Control':'no-cache',
      'Pragma':'no-cache',
      'Upgrade-Insecure-Requests':'1',
      'DNT':'1',
      'Connection':'keep-alive',
      ...extraHeaders
    };
    if (cookieJar.length) headers['Cookie'] = cookieJar.join('; ');
    if (referer) headers.Referer = referer;
    const r = await fetch(url, { headers, redirect: 'manual' as any });
    const setCookie = r.headers?.get?.('set-cookie');
    const allCookies: string[] = [];
    if (setCookie) allCookies.push(setCookie);
    // Cloudflare / ddos-guard sometimes splits multiple Set-Cookie; attempt common header names
    // (Fetch in some runtimes merges; if multiple, we rely on comma splitting heuristically)
    if (setCookie && setCookie.includes(',')) {
      // naive split only for key=value; expires attribute contains comma so keep simple tokens with =
      for (const part of setCookie.split(/,(?=[^;]+=[^;]+)/)) allCookies.push(part.trim());
    }
    if (!r.ok && (r.status === 301 || r.status === 302) ) {
      const loc = r.headers.get('location');
      if (loc) {
        // accumulate cookies and follow once
        const jar = cookieJar.concat(allCookies.map(c=>c.split(';')[0]));
        return fetchText(new URL(loc, url).toString(), referer, jar, extraHeaders);
      }
    }
    if(!r.ok) return { text: null, setCookie: allCookies };
    const txt = await r.text();
    return { text: txt, setCookie: allCookies };
  } catch { return { text: null }; }
}

function randomToken(len=10){ const chars='abcdefghijklmnopqrstuvwxyz0123456789'; let o=''; for(let i=0;i<len;i++) o+=chars[Math.floor(Math.random()*chars.length)]; return o; }

const DOOD_PRIMARY = 'https://dood.to';
const DOOD_FALLBACKS = [ 'https://doodstream.co', 'https://dood.watch', 'https://d000d.com' ];

export class DoodStreamExtractor implements HostExtractor {
  id='doodstream';
  supports(url: string){ return /dood|do[0-9]go|doood|dooood|ds2play|ds2video|d0o0d|do0od|d0000d|d000d|vidply|all3do|doply|vide0|vvide0|d-s/i.test(url); }
  async extract(rawUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
    const normU = new URL(normalizeUrl(rawUrl));
    const videoId = normU.pathname.split('/').pop();
    if (!videoId) return { streams: [] };
    const domains = [DOOD_PRIMARY, ...DOOD_FALLBACKS];
    let html: string | null = null; let originUsed = '';
    const cookieJar: string[] = [];
    for (const dom of domains) {
      const test = `${dom.replace(/\/$/,'')}/e/${videoId}`;
      console.log('[DoodExtractor] try', test);
      const res = await fetchText(test, ctx.referer || dom, cookieJar);
      if (res.setCookie?.length) {
        for (const c of res.setCookie) cookieJar.push(c.split(';')[0]);
      }
      if (res.text) { html = res.text; originUsed = dom; break; }
    }
    if (!html) return { streams: [] };
    const pass = html.match(/\/pass_md5\/[\w-]+\/([\w-]+)/);
    if (!pass) { console.log('[DoodExtractor] pass_md5 not found'); return { streams: [] }; }
    const token = pass[1];
    let passUrl = new URL(pass[0], originUsed).toString();
    const passHeaders = { 'Accept':'*/*', 'X-Requested-With':'XMLHttpRequest' };
    const passRes = await fetchText(passUrl, originUsed, cookieJar, passHeaders);
    if (passRes.setCookie?.length) for (const c of passRes.setCookie) cookieJar.push(c.split(';')[0]);
    let baseUrl = passRes.text;
    console.log('[DoodExtractor] passUrl primary', passUrl, 'len', baseUrl?.length, 'cookies', cookieJar.length);
    if (!baseUrl) {
      // replicate fallback chain
      for (const altDom of domains) {
        passUrl = new URL(pass[0], altDom).toString();
        const altRes = await fetchText(passUrl, altDom, cookieJar, passHeaders);
        if (altRes.setCookie?.length) for (const c of altRes.setCookie) cookieJar.push(c.split(';')[0]);
        if (altRes.text) { baseUrl = altRes.text; originUsed = altDom; break; }
      }
    }
    if (!baseUrl) {
      console.log('[DoodExtractor] baseUrl fetch empty after fallbacks');
      return { streams: [] };
    }
    const tMatch = html.match(/<title>([^<]+)<\/title>/i); let baseTitle = tMatch? tMatch[1]: 'Doodstream';
    baseTitle = baseTitle.replace(/ - DoodStream/i,'').trim();
    // Prefer external localized title if provided
    if (ctx.titleHint) baseTitle = ctx.titleHint;
    let mp4 = '';
    if (baseUrl.includes('cloudflarestorage')) mp4 = baseUrl.trim(); else mp4 = `${baseUrl}${randomToken(10)}?token=${token}&expiry=${Date.now()}`;
    console.log('[DoodExtractor] final mp4', mp4.slice(0,120));

    // Attempt to discover size via HEAD request (Content-Length)
    let sizePart = '';
    try {
      const head = await fetch(mp4, { method:'HEAD', headers:{ 'User-Agent':'Mozilla/5.0 (DoodHead)' } as any });
      const len = head.headers.get('content-length');
      if (len) {
        const bytes = parseInt(len);
        if (!isNaN(bytes) && bytes>0) {
          sizePart = bytes >= 1024**3 ? (bytes/1024/1024/1024).toFixed(2)+'GB' : (bytes/1024/1024).toFixed(0)+'MB';
        }
      }
    } catch {}

    // Try to infer resolution from page html (best-effort)
    let resPart = '';
    try {
      const h = html.match(/(\d{3,4})p/);
      if (h) {
        const hv = parseInt(h[1]);
        if (!isNaN(hv) && hv>=144 && hv<=4320) resPart = `${hv}p`;
      }
    } catch {}

  const secondSegs: string[] = [];
  if (sizePart) secondSegs.push(sizePart);
  if (resPart) secondSegs.push(resPart);
  // Always add provider label; even if alone still show second line per new GH requirement
  secondSegs.push('Doodstream');
  const line1 = `${baseTitle} • [ITA]`;
  const title = `\n💾 ${secondSegs.join(' • ')}`.replace(/^\n/,'');
  // Ensure line1 + second line always
  const fullTitle = `${line1}\n💾 ${secondSegs.join(' • ')}`;
    const stream: StreamForStremio = { title: fullTitle, url: mp4, behaviorHints:{ notWebReady:true } };
    return { streams: [stream] };
  }
}
