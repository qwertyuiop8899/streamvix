//Adapted for use in Streamvix from:
// webstreamr in https://github.com/webstreamr/webstreamr
// 

import { HostExtractor, ExtractResult, ExtractorContext, normalizeUrl } from './base';
// Ambient declaration for require (runtime dynamic import) without pulling full @types/node
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function require(name: string): any;
// Optional proxy/cloudflare fallback utilities (reuse provider logic)
// They are defensive imports: if path changes or not present, extractor still works without proxy fallback.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let fetchPageWithProxies: any;
try {
  // dynamic require to avoid build-time circular refs if any
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  fetchPageWithProxies = require('../providers/flaresolverr').fetchPageWithProxies;
} catch { /* ignore optional */ }
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

// Expanded list derived from historical mirrors (subset of ResolveURL list). Order matters (fastest & stable first).
const DOOD_PRIMARY = 'https://dood.to';
const DOOD_FALLBACKS = [
  'https://dood.stream', 'https://dood.la', 'https://dood.ws', 'https://dood.watch', 'https://d-s.io',
  'https://doodstream.co', 'https://dood.pm', 'https://dood.re', 'https://dood.sh', 'https://dood.cx',
  'https://d000d.com', 'https://d0000d.com', 'https://dooodster.com', 'https://vidply.com', 'https://all3do.com'
];

const PASS_MD5_RE = /\/pass_md5\/[\w-]+\/([\w-]+)/;
const CHALLENGE_RE = /(cf-turnstile|Just a moment|DDOS-GUARD|checking your browser|challenge-platform|enable javascript and cookies)/i;

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

    // helper to attempt fetching embed or direct page with small strategy permutations
    const tryFetchVariant = async (dom: string): Promise<string | null> => {
      const embedUrl = `${dom.replace(/\/$/,'')}/e/${videoId}`;
      const directUrl = `${dom.replace(/\/$/,'')}/d/${videoId}`;
      console.log('[DoodExtractor] try embed', embedUrl);
      const resEmbed = await fetchText(embedUrl, ctx.referer || dom, cookieJar);
      if (resEmbed.setCookie?.length) for (const c of resEmbed.setCookie) cookieJar.push(c.split(';')[0]);
      let body = resEmbed.text;
      if (!body || CHALLENGE_RE.test(body)) {
        console.log('[DoodExtractor] embed challenge/empty, try direct', directUrl);
        const resDirect = await fetchText(directUrl, ctx.referer || dom, cookieJar);
        if (resDirect.setCookie?.length) for (const c of resDirect.setCookie) cookieJar.push(c.split(';')[0]);
        body = resDirect.text || body;
      }
      if (!body) return null;
      // If still no pass_md5 but iframe present, follow iframe
      if (!PASS_MD5_RE.test(body)) {
        const iframeMatch = body.match(/<iframe[^>]+src="([^"]+)/i);
        if (iframeMatch) {
          const iframeUrl = new URL(iframeMatch[1], dom).toString();
          console.log('[DoodExtractor] follow iframe', iframeUrl);
          const resIframe = await fetchText(iframeUrl, dom, cookieJar);
            if (resIframe.setCookie?.length) for (const c of resIframe.setCookie) cookieJar.push(c.split(';')[0]);
          if (resIframe.text) body = resIframe.text;
        }
      }
      return body;
    };

    for (const dom of domains) {
      html = await tryFetchVariant(dom);
      if (html && PASS_MD5_RE.test(html)) { originUsed = dom; break; }
    }

    // Proxy fallback: only if html missing pass_md5 and we have proxy helper
    if ((!html || !PASS_MD5_RE.test(html)) && fetchPageWithProxies) {
      for (const dom of domains) {
        try {
          const proxyUrl = `${dom.replace(/\/$/,'')}/e/${videoId}`;
          console.log('[DoodExtractor][proxy] attempt', proxyUrl);
          const proxyHtml = await fetchPageWithProxies(proxyUrl);
          if (proxyHtml && PASS_MD5_RE.test(proxyHtml)) { html = proxyHtml; originUsed = dom; break; }
        } catch { /* ignore */ }
      }
    }

    if (!html) return { streams: [] };
    const pass = html.match(PASS_MD5_RE);
    if (!pass) { console.log('[DoodExtractor] pass_md5 not found after all strategies'); return { streams: [] }; }
    const token = pass[1];
    let passUrl = new URL(pass[0], originUsed).toString();
    const passHeaders = { 'Accept':'*/*', 'X-Requested-With':'XMLHttpRequest' };
    const passRes = await fetchText(passUrl, originUsed, cookieJar, passHeaders);
    if (passRes.setCookie?.length) for (const c of passRes.setCookie) cookieJar.push(c.split(';')[0]);
    let baseUrl = (passRes.text || '').trim();
    console.log('[DoodExtractor] passUrl primary', passUrl, 'len', baseUrl.length, 'cookies', cookieJar.length);

    // Retry same pass endpoint a couple of times with small delay if empty (some mirrors lazy-generate link)
    if (!baseUrl) {
      for (let attempt=1; attempt<=2 && !baseUrl; attempt++) {
        await new Promise(r=>setTimeout(r, 200 * attempt));
        const retry = await fetchText(passUrl, originUsed, cookieJar, passHeaders);
        if (retry.setCookie?.length) for (const c of retry.setCookie) cookieJar.push(c.split(';')[0]);
        baseUrl = (retry.text || '').trim();
        console.log('[DoodExtractor] retry pass attempt', attempt, 'len', baseUrl.length);
      }
    }

    // Fallback: try alternative domains for the pass endpoint
    if (!baseUrl) {
      for (const altDom of domains) {
        passUrl = new URL(pass[0], altDom).toString();
        const altRes = await fetchText(passUrl, altDom, cookieJar, passHeaders);
        if (altRes.setCookie?.length) for (const c of altRes.setCookie) cookieJar.push(c.split(';')[0]);
        if (altRes.text) { baseUrl = (altRes.text || '').trim(); originUsed = altDom; console.log('[DoodExtractor] pass fallback domain success', altDom); break; }
      }
    }

    // Ultimate fallback: parse hotkeys/makePlay JS sequence (pattern from legacy resolver)
    if (!baseUrl) {
      const hotkeysMatch = html.match(/dsplayer\.hotkeys[^']+'([^']+).+?function\s*makePlay.+?return[^?]+([^"]+)/is);
      if (hotkeysMatch) {
        try {
          const pathPart = hotkeysMatch[1];
          const tokenPart = hotkeysMatch[2];
          const altPlayUrl = new URL(pathPart, originUsed).toString();
          console.log('[DoodExtractor] hotkeys fallback requesting', altPlayUrl);
          const altPlayRes = await fetchText(altPlayUrl, originUsed, cookieJar, passHeaders);
          let altBody = (altPlayRes.text || '').trim();
          if (altBody) {
            if (altBody.includes('cloudflarestorage.')) {
              baseUrl = altBody; // direct
              console.log('[DoodExtractor] hotkeys fallback produced cloudflare direct');
            } else {
              // replicate dood_decode (add 10 random chars) then append tokenPart and timestamp
              const decoded = altBody + randomToken(10);
              baseUrl = decoded + tokenPart + Date.now();
              console.log('[DoodExtractor] hotkeys fallback constructed baseUrl len', baseUrl.length);
            }
          }
        } catch (e) {
          console.log('[DoodExtractor] hotkeys fallback error', (e as Error).message);
        }
      } else {
        console.log('[DoodExtractor] hotkeys pattern not found');
      }
    }

    if (!baseUrl) { console.log('[DoodExtractor] baseUrl fetch empty after all fallbacks'); return { streams: [] }; }
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
      const head = await fetch(mp4, { method:'HEAD', headers:{ 'User-Agent':'Mozilla/5.0 (DoodHead)', 'Referer': originUsed } as any });
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
  const stream: StreamForStremio = { title, url: mp4, behaviorHints:{ notWebReady:true, referer: originUsed } } as StreamForStremio;
    return { streams: [stream] };
  }
}
