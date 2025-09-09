//Adapted for use in Streamvix from:
// webstreamr in https://github.com/webstreamr/webstreamr
// 

import { HostExtractor, ExtractResult, ExtractorContext, normalizeUrl } from './base';
import type { StreamForStremio } from '../types/animeunity';
// NOTE: Unlike Mixdrop we DO NOT wrap Doodstream with MediaFlow proxy to match webstreamr behavior.
// NOTE thanks to webstreamr for the logic
interface FetchResult { text: string | null; setCookie?: string[]; status?: number; location?: string | null; error?: string }
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
  'Accept-Encoding':'gzip, deflate, br',
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
    if(!r.ok) return { text: null, setCookie: allCookies, status: r.status, location: r.headers.get('location') };
    const txt = await r.text();
    return { text: txt, setCookie: allCookies, status: r.status };
  } catch (e: any) { return { text: null, status: -1, error: e?.message }; }
}

function randomToken(len=10){ const chars='abcdefghijklmnopqrstuvwxyz0123456789'; let o=''; for(let i=0;i<len;i++) o+=chars[Math.floor(Math.random()*chars.length)]; return o; }

// Canonical host come in webstreamr (usa dood.to)
const CANONICAL = 'https://dood.to';
const PASS_MD5_RE = /\/pass_md5\/[\w-]+\/([\w-]+)/;
const HOTKEYS_RE = /dsplayer\.hotkeys[^']+'([^']+).+?function\s*makePlay.+?return[^?]+([^"]+)/is;

function tryDecodeForPass(html: string): RegExpMatchArray | null {
  // direct
  let m = html.match(PASS_MD5_RE);
  if (m) return m;
  // unescape common \x2f sequences
  const replaced = html.replace(/\\x2f/g,'/');
  if (replaced !== html) {
    m = replaced.match(PASS_MD5_RE);
    if (m) return m;
  }
  // unicode escapes \u002f etc
  const unicode = replaced.replace(/\\u002f/g,'/');
  if (unicode !== replaced) {
    m = unicode.match(PASS_MD5_RE);
    if (m) return m;
  }
  return null;
}

export class DoodStreamExtractor implements HostExtractor {
  id='doodstream';
  supports(url: string){ return /dood|do[0-9]go|doood|dooood|ds2play|ds2video|d0o0d|do0od|d0000d|d000d|vidply|all3do|doply|vide0|vvide0|d-s/i.test(url); }
  async extract(rawUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
    const normU = new URL(normalizeUrl(rawUrl));
    const videoId = normU.pathname.split('/').pop();
    if (!videoId) return { streams: [] };
  const cookieJar: string[] = [];
  const originalOrigin = `${normU.protocol}//${normU.host}`;
  const hosts = Array.from(new Set([originalOrigin, CANONICAL]));
  let originUsed = originalOrigin;
  let html: string | null = null;
  let pass: RegExpMatchArray | null = null;

  for (const host of hosts) {
    const embedUrl = `${host}/e/${videoId}`;
    console.log('[DoodExtractor] try host', host, 'embed');
    const res = await fetchText(embedUrl, host, cookieJar);
    if (res.setCookie?.length) for (const c of res.setCookie) cookieJar.push(c.split(';')[0]);
    let body = res.text;
    if (!body && embedUrl.startsWith('https://')) {
      // HTTP downgrade attempt if network error
      const httpUrl = embedUrl.replace('https://','http://');
      const resHttp = await fetchText(httpUrl, host, cookieJar);
      if (resHttp.setCookie?.length) for (const c of resHttp.setCookie) cookieJar.push(c.split(';')[0]);
      if (resHttp.text) { body = resHttp.text; console.log('[DoodExtractor] recovered via http for host', host); }
      else if (res.error) { console.log('[DoodExtractor] http downgrade still empty err', resHttp.error); }
    }
    if (!body) {
      // Warm homepage
      const home = await fetchText(host + '/', host, cookieJar);
      if (home.setCookie?.length) for (const c of home.setCookie) cookieJar.push(c.split(';')[0]);
      const res2 = await fetchText(embedUrl, host, cookieJar);
      if (res2.text) { body = res2.text; console.log('[DoodExtractor] recovered after homepage warmup host', host); }
    }
    if (!body) {
      // /d/ path
      const directUrl = `${host}/d/${videoId}`;
      const resD = await fetchText(directUrl, host, cookieJar);
      if (resD.setCookie?.length) for (const c of resD.setCookie) cookieJar.push(c.split(';')[0]);
      if (resD.text) { body = resD.text; console.log('[DoodExtractor] recovered via /d/ path host', host); }
    }
    if (body) {
      const m = tryDecodeForPass(body);
      if (m) { html = body; pass = m; originUsed = host; break; }
      if (!html) html = body; // store first non-empty attempt
    } else {
      console.log('[DoodExtractor] still empty for host', host);
    }
  }

  if (!html) { console.log('[DoodExtractor] all hosts failed to fetch html'); return { streams: [] }; }
  if (!pass) {
    // Attempt hotkeys fallback only if we captured some html
    if (html) {
      const hk = html.match(HOTKEYS_RE);
      if (hk) {
        try {
          const pathPart = hk[1];
          const tokenPart = hk[2];
          const altPlayUrl = new URL(pathPart, originUsed).toString();
          console.log('[DoodExtractor] hotkeys attempt', altPlayUrl);
          const altRes = await fetchText(altPlayUrl, originUsed, cookieJar, { 'Accept':'*/*' });
          if (altRes.text) {
            // If contains cloudflarestorage -> direct; otherwise synthesize like legacy
            if (altRes.text.includes('cloudflarestorage.')) {
              const tMatch = html.match(/<title>([^<]+)<\/title>/i); let baseTitle = tMatch? tMatch[1]: 'Doodstream';
              baseTitle = baseTitle.replace(/ - DoodStream/i,'').trim();
              if (ctx.titleHint) baseTitle = ctx.titleHint;
              const mp4 = altRes.text.trim();
              console.log('[DoodExtractor] hotkeys direct mp4', mp4.slice(0,120));
              const stream: StreamForStremio = { title: baseTitle, url: mp4, behaviorHints:{ notWebReady:true, referer: originUsed } } as StreamForStremio;
              return { streams: [stream] };
            } else {
              const decoded = altRes.text + randomToken(10);
              const mp4 = decoded + tokenPart + Date.now();
              const tMatch = html.match(/<title>([^<]+)<\/title>/i); let baseTitle = tMatch? tMatch[1]: 'Doodstream';
              baseTitle = baseTitle.replace(/ - DoodStream/i,'').trim();
              if (ctx.titleHint) baseTitle = ctx.titleHint;
              console.log('[DoodExtractor] hotkeys synthesized mp4', mp4.slice(0,120));
              const stream: StreamForStremio = { title: baseTitle, url: mp4, behaviorHints:{ notWebReady:true, referer: originUsed } } as StreamForStremio;
              return { streams: [stream] };
            }
          }
        } catch (e) { console.log('[DoodExtractor] hotkeys fallback error',(e as Error).message); }
      }
      // dump longer snippet for debugging (capped)
      console.log('[DoodExtractor][debug] first 400 chars:', html.slice(0,400).replace(/\n+/g,' '));
    }
    console.log('[DoodExtractor] pass_md5 not found after host iterations');
    return { streams: [] };
  }

  const token = pass[1];
  let passUrl = new URL(pass[0], originUsed).toString();
    const passHeaders = { 'Accept':'*/*', 'X-Requested-With':'XMLHttpRequest' };
    const passRes = await fetchText(passUrl, originUsed, cookieJar, passHeaders);
    if (passRes.setCookie?.length) for (const c of passRes.setCookie) cookieJar.push(c.split(';')[0]);
    const baseUrl = (passRes.text || '').trim();
    console.log('[DoodExtractor] passUrl', passUrl, 'len', baseUrl.length);
    if (!baseUrl) {
      // Debug: dump first 120 chars of embed to help diagnose
      console.log('[DoodExtractor][debug] embed snippet:', html.slice(0,120).replace(/\n/g,' '));
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
