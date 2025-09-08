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

const DOOD_PRIMARY_HTTP = 'http://dood.to'; // mimic webstreamr (HTTP)
const DOOD_FALLBACKS = [ 'http://dood.to', 'https://dood.to', 'https://doodstream.co', 'https://dood.watch', 'https://d000d.com' ];
// Simple in-memory cache (videoId -> html) to reduce repeated challenges
const doodHtmlCache: Map<string, { html: string; ts: number }> = new Map();
const DOOD_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

export class DoodStreamExtractor implements HostExtractor {
  id='doodstream';
  supports(url: string){ return /dood|do[0-9]go|doood|dooood|ds2play|ds2video|d0o0d|do0od|d0000d|d000d|vidply|all3do|doply|vide0|vvide0|d-s/i.test(url); }
  async extract(rawUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
  const normU = new URL(normalizeUrl(rawUrl));
  const videoId = normU.pathname.split('/').pop();
    if (!videoId) return { streams: [] };
    // Check cache
    const cached = doodHtmlCache.get(videoId);
    let html: string | null = null; let originUsed = '';
  // keep a reference cookieJar for later pass fetch even if loaded from cache
  const cookieJar: string[] = [];
  if (cached && (Date.now() - cached.ts) < DOOD_CACHE_TTL) {
      html = cached.html;
      originUsed = DOOD_PRIMARY_HTTP;
    } else {
      function sleep(ms:number){ return new Promise(r=>setTimeout(r, ms)); }
      // Primary single attempt HTTP
      const primaryEmbed = `${DOOD_PRIMARY_HTTP.replace(/\/$/,'')}/e/${videoId}`;
      console.log('[DoodExtractor] primary http attempt', primaryEmbed);
      let res = await fetchText(primaryEmbed, DOOD_PRIMARY_HTTP, cookieJar, { 'Accept-Language':'en' });
      if (res.setCookie?.length) for (const c of res.setCookie) cookieJar.push(c.split(';')[0]);
      if (res.text) {
        const isChallenge = /cf-|turnstile|captcha|ddos|cloudflare/i.test(res.text) && !/pass_md5/.test(res.text);
        if (!isChallenge) { html = res.text; originUsed = DOOD_PRIMARY_HTTP; }
        else {
          console.log('[DoodExtractor] challenge short html len', res.text.length, 'retrying once after delay');
          await sleep(1200 + Math.floor(Math.random()*400));
          res = await fetchText(primaryEmbed, DOOD_PRIMARY_HTTP, cookieJar, { 'Accept-Language':'en' });
          if (res.text && !(/cf-|turnstile|captcha|ddos|cloudflare/i.test(res.text) && !/pass_md5/.test(res.text))) {
            html = res.text; originUsed = DOOD_PRIMARY_HTTP;
          }
        }
      }
      // Fallback domains only if still no html (network fail or persistent challenge)
      if (!html) {
        for (const dom of DOOD_FALLBACKS) {
          if (dom === DOOD_PRIMARY_HTTP) continue; // already tried
            const embed = `${dom.replace(/\/$/,'')}/e/${videoId}`;
          console.log('[DoodExtractor] fallback attempt', embed);
          let fres = await fetchText(embed, dom, cookieJar, { 'Accept-Language':'en' });
          if (fres.setCookie?.length) for (const c of fres.setCookie) cookieJar.push(c.split(';')[0]);
          if (fres.text) {
            const isChallenge = /cf-|turnstile|captcha|ddos|cloudflare/i.test(fres.text) && !/pass_md5/.test(fres.text);
            if (!isChallenge) { html = fres.text; originUsed = dom; break; }
          }
        }
      }
      if (!html) return { streams: [] };
      doodHtmlCache.set(videoId, { html, ts: Date.now() });
    }
    const domains = [DOOD_PRIMARY_HTTP, ...DOOD_FALLBACKS];
    // --- Enhanced pass_md5 extraction with diagnostics (Step 1) ---
    let pass = html.match(/\/pass_md5\/[\w-]+\/[\w-]+/); // broader first capture (full segment)
    let tokenVal: string | null = null;
    if (pass) {
      // extract token as last path segment
      try { tokenVal = pass[0].split('/').pop() || null; } catch {}
    }
    if (!pass || !tokenVal) {
      // try original capturing-group style (maybe changed structure)
      const alt = html.match(/\/pass_md5\/[^"'<>\s)]+/);
      if (alt) {
        pass = alt; tokenVal = alt[0].split('/').pop() || null;
      }
    }
    if (!pass || !tokenVal) {
      const len = html.length;
      const hasPhrase = html.includes('pass_md5');
      const cloudflare = /cf-|turnstile|captcha|ddos|cloudflare/i.test(html);
      const snippet = html.slice(0, 500).replace(/\n/g,'\\n');
      console.log('[DoodExtractor] pass_md5 not found', JSON.stringify({ len, hasPhrase, cloudflare, snippet }));
      // Fallback: direct cloudflarestorage URL inside HTML (rare but possible)
      const direct = html.match(/https?:\/\/[^"']+cloudflarestorage[^"']+/);
      if (direct) {
        console.log('[DoodExtractor] using direct cloudflarestorage fallback');
        const stream: StreamForStremio = { title: 'Doodstream • fallback', url: direct[0].trim(), behaviorHints:{ notWebReady:true } };
        return { streams: [stream] };
      }
      return { streams: [] };
    }
  const token = tokenVal as string;
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
    secondSegs.push('doodstream');
    const line1 = `${baseTitle} • [ITA]`;
    const title = `${line1}\n💾 ${secondSegs.join(' • ')}`;
    const stream: StreamForStremio = { title, url: mp4, behaviorHints:{ notWebReady:true } };
    return { streams: [stream] };
  }
}
