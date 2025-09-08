//Adapted for use in Streamvix from:
// webstreamr in https://github.com/webstreamr/webstreamr
// 

import { HostExtractor, ExtractResult, ExtractorContext, normalizeUrl } from './base';
import type { StreamForStremio } from '../types/animeunity';
// NOTE: Unlike Mixdrop we DO NOT wrap Doodstream with MediaFlow proxy to match webstreamr behavior.
// NOTE thanks to webstreamr for the logic
interface FetchResult { text: string | null }
// UA rotation (simple) cached for 30m
const UA_POOL = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36'
];
let UA_SELECTED = { ua: UA_POOL[0], ts: 0 };
function pickUA(){
  const now = Date.now();
  if (now - UA_SELECTED.ts > 30*60*1000) { // 30m rotation
    UA_SELECTED = { ua: UA_POOL[Math.floor(Math.random()*UA_POOL.length)], ts: now };
  }
  return UA_SELECTED.ua;
}
async function fetchText(url: string, referer?: string): Promise<FetchResult> {
  try {
  const headers: any = { 'User-Agent': pickUA() };
  if (referer) headers.Referer = referer;
  const r = await fetch(url, { headers });
  if(!r.ok) return { text: null };
  const txt = await r.text();
  return { text: txt };
  } catch { return { text: null }; }
}

function randomToken(len=10){ const chars='abcdefghijklmnopqrstuvwxyz0123456789'; let o=''; for(let i=0;i<len;i++) o+=chars[Math.floor(Math.random()*chars.length)]; return o; }

const DOOD_PRIMARY_HTTP = 'http://dood.to'; // mimic webstreamr (HTTP)
const DOOD_FALLBACKS = [ 'http://dood.to', 'https://dood.to', 'https://doodstream.co' ];

export class DoodStreamExtractor implements HostExtractor {
  id='doodstream';
  supports(url: string){ return /dood|do[0-9]go|doood|dooood|ds2play|ds2video|d0o0d|do0od|d0000d|d000d|vidply|all3do|doply|vide0|vvide0|d-s/i.test(url); }
  async extract(rawUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
  const normU = new URL(normalizeUrl(rawUrl));
  const videoId = normU.pathname.split('/').pop();
    if (!videoId) return { streams: [] };
    let html: string | null = null; let originUsed = DOOD_PRIMARY_HTTP;
    const embedUrl = `${DOOD_PRIMARY_HTTP.replace(/\/$/,'')}/e/${videoId}`;
    console.log('[DoodExtractor] embed attempt', embedUrl);
    let res = await fetchText(embedUrl, DOOD_PRIMARY_HTTP);
    if (res.text && /pass_md5/.test(res.text)) html = res.text; else {
      for (const dom of DOOD_FALLBACKS) {
        if (dom === DOOD_PRIMARY_HTTP) continue;
        const e2 = `${dom.replace(/\/$/,'')}/e/${videoId}`;
        console.log('[DoodExtractor] fallback attempt', e2);
        const fres = await fetchText(e2, dom);
        if (fres.text && /pass_md5/.test(fres.text)) { html = fres.text; originUsed = dom; break; }
      }
    }
    if (!html) return { streams: [] };
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
  const passRes = await fetchText(passUrl, originUsed);
    let baseUrl = passRes.text;
  console.log('[DoodExtractor] passUrl primary', passUrl, 'len', baseUrl?.length);
    if (!baseUrl) {
      // replicate fallback chain
      for (const altDom of domains) {
        passUrl = new URL(pass[0], altDom).toString();
    const altRes = await fetchText(passUrl, altDom);
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

    // Normalize Italian suffix like other extractors
    if (!/\[ITA\]$/i.test(baseTitle)) {
      if (!/•\s*\[ITA\]$/i.test(baseTitle)) baseTitle = `${baseTitle} • [ITA]`;
    }
    const secondSegs: string[] = [];
    if (sizePart) secondSegs.push(sizePart);
    if (resPart) secondSegs.push(resPart);
    secondSegs.push('doodstream');
    const fullTitle = `${baseTitle}\n💾 ${secondSegs.join(' • ')}`;
    const stream: StreamForStremio = { title: fullTitle, url: mp4, behaviorHints:{ notWebReady:true } };
    return { streams: [stream] };
  }
}
