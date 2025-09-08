/*
 * This file reuses logic patterns from the MIT licensed project "webstreamr" (https://github.com/webstreamr/webstreamr):
 *  - Fetcher challenge detection & FlareSolverr integration (src/utils/Fetcher.ts)
 *  - Cache TTL approach and Cloudflare handling heuristics
 * Adjusted minimally for local use (single domain, SOLVER_URL env) without changing original intent.
 * Thanks to the webstreamr authors for their work. Original code under MIT license.
 */
// Replica della logica di Fetcher (webstreamr) in forma compatta locale:
// - Cache (LRU in-memory gzip simulata) semplificata ma con TTL minimo
// - Rate limit (429 retry-after con attesa se breve)
// - Timeout, retry su 5xx e un retry su timeout
// - Cloudflare challenge detection: header cf-mitigated=challenge o body contenente cf-turnstile
// - Uso FlareSolverr tramite SOLVER_URL (stesso comando request.get, session default)
// - Gestione cf_clearance e user-agent per host
// - Error mapping simile (404 -> not_found, 403 -> blocked, 451 -> cloudflare_censor, 429 -> too_many_requests)

// Ambient declarations (niente @types/node)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function require(name: string): any;
const fs = require('fs');
const path = require('path');

// Nota: usare funzione per leggere SOLVER_URL runtime (il test imposta env dopo import)
function getSolverUrl(): string | undefined { return process?.env?.SOLVER_URL; }

interface SolverResultCookie { name:string; value:string; domain:string; expires:number }
interface SolverResult { status:string; message?:string; solution?: { url:string; status:number; response:string; userAgent:string; headers:Record<string,string>; cookies:SolverResultCookie[] } }

// Cookie e UA per host
const hostCookies = new Map<string, Map<string,string>>(); // name->value per host (only cf_clearance retained)
const hostUA = new Map<string,string>();

function getCookieHeader(host: string): string | undefined {
  const jar = hostCookies.get(host);
  if (!jar) return undefined;
  if (jar.size === 0) return undefined;
  console.log('[FS][CK][OUT]', host, 'cookies', Array.from(jar.keys()).join(','));
  return Array.from(jar.entries()).map(([k,v])=>`${k}=${v}`).join('; ');
}

function storeSolver(solution: NonNullable<SolverResult['solution']>) {
  const u = new URL(solution.url);
  let jar = hostCookies.get(u.host);
  if (!jar) { jar = new Map(); hostCookies.set(u.host, jar); }
  for (const c of solution.cookies) {
    if (c.name === 'cf_clearance') jar.set(c.name, c.value);
  }
  hostUA.set(u.host, solution.userAgent);
  console.log('[FS][SOLVER] stored cf_clearance + UA for', u.host);
}

// Simple caches
interface HttpCacheItem { body:string; status:number; headers:Record<string,string>; expiry:number }
const httpCache = new Map<string,HttpCacheItem>();
const MIN_CACHE_TTL = 15 * 60 * 1000; // 15m (come Fetcher)

// Rate limit & timeouts tracking
const rateLimitHost = new Map<string, number>(); // host -> epoch ms expiry
const timeoutCount = new Map<string, number>();
const TIMEOUT_MAX = 30;
const TIMEOUT_CACHE_TTL = 60 * 60 * 1000; // 1h
const MAX_WAIT_RETRY_AFTER = 10000;

function now() { return Date.now(); }

function pruneTimeout(host: string) {
  const entry = timeoutCount.get(host);
  if (entry && entry < 0) timeoutCount.delete(host);
}

async function sleep(ms: number){ return new Promise(r=>setTimeout(r, ms)); }

const DEFAULT_UA = 'node';

async function baseFetch(url: URL, init?: RequestInit & { timeout?: number }): Promise<Response> {
  const controller = new AbortController();
  const to = setTimeout(()=>controller.abort(), init?.timeout ?? 5000);
  const headers: Record<string,string> = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en',
    'Priority': 'u=0',
    'User-Agent': hostUA.get(url.host) || DEFAULT_UA,
    ...(init?.headers as any || {}),
  };
  const ck = getCookieHeader(url.host); if (ck) headers['Cookie'] = ck;
  // Removed fake forwarded headers to mimic webstreamr behaviour when no ctx.ip
  try {
  console.log('[FS][HTTP][REQ]', url.href, 'ua=', headers['User-Agent'], 'hasCookie=', !!headers['Cookie']);
  const r = await fetch(url, { ...init, headers, signal: controller.signal, keepalive: true });
  console.log('[FS][HTTP][RESP]', url.href, 'status', r.status);
  return r;
  } finally { clearTimeout(to); }
}

async function fetchWithRetry(url: URL, attempt = 0): Promise<Response> {
  const host = url.host;
  // rate limit check
  const rl = rateLimitHost.get(host);
  if (rl && rl > now()) {
    const ttl = rl - now();
    if (ttl <= MAX_WAIT_RETRY_AFTER && attempt < 1) {
      await sleep(ttl);
    } else {
      return new Response('', { status: 429, statusText: 'Too Many Requests' });
    }
  }
  // timeouts threshold
  const tc = timeoutCount.get(host) || 0;
  if (tc >= TIMEOUT_MAX) {
    return new Response('', { status: 599, statusText: 'Too Many Timeouts' });
  }
  try {
    const resp = await baseFetch(url, {});
    if (resp.status >= 500 && resp.status < 600 && attempt < 3) {
      await sleep(333);
      return fetchWithRetry(url, attempt + 1);
    }
    if (resp.status === 429) {
      const ra = parseInt(`${resp.headers.get('retry-after')}`) * 1000;
      if (!isNaN(ra)) {
        rateLimitHost.set(host, now() + ra);
        if (ra <= MAX_WAIT_RETRY_AFTER && attempt < 1) {
          await sleep(ra);
          return fetchWithRetry(url, attempt + 1);
        }
      }
    }
    return resp;
  } catch (e:any) {
    if (e?.name === 'AbortError') {
      timeoutCount.set(host, (timeoutCount.get(host) || 0) + 1);
      if (attempt < 1) {
        await sleep(333);
        return fetchWithRetry(url, attempt + 1);
      }
    }
    throw e;
  } finally {
    setTimeout(()=>pruneTimeout(host), TIMEOUT_CACHE_TTL);
  }
}

function cacheKey(url: URL) { return url.href; }

function setCache(url: URL, status:number, headers:Record<string,string>, body:string) {
  const ttl = (status === 200 || status === 404) ? MIN_CACHE_TTL : 0;
  const expiry = ttl ? now() + ttl : 0;
  if (ttl) httpCache.set(cacheKey(url), { body, status, headers, expiry });
  if (ttl) console.log('[FS][CACHE][SET]', url.href, 'status', status, 'ttlMs', ttl);
}

function getCache(url: URL): HttpCacheItem | undefined {
  const it = httpCache.get(cacheKey(url));
  if (!it) return undefined;
  if (it.expiry && it.expiry < now()) { httpCache.delete(cacheKey(url)); return undefined; }
  console.log('[FS][CACHE][HIT]', url.href, 'status', it.status, 'exp', it.expiry - now());
  return it;
}

async function solveChallenge(url: URL): Promise<string | null> {
  const SOLVER_URL = getSolverUrl();
  if (!SOLVER_URL) { console.log('[FS][SOLVER][MISS] SOLVER_URL not set'); return null; }
  try {
    console.log('[FS][SOLVER][REQ]', url.href);
    const body = JSON.stringify({ cmd: 'request.get', url: url.href, session: 'default' });
    const resp = await fetch(SOLVER_URL, { method: 'POST', headers: { 'Content-Type':'application/json' }, body });
    const json = await resp.json() as SolverResult;
    if (json.status === 'ok' && json.solution) {
      storeSolver(json.solution);
      console.log('[FS][SOLVER][OK]', url.href, 'len', json.solution.response.length);
      return json.solution.response;
    }
    console.log('[FS][SOLVER][FAIL]', url.href, json.status, json.message);
  } catch { /* ignore */ }
  return null;
}

// Proxy support hard-coded: aggiungi fino a 20 proxy in questo array (formato http://user:pass@host:port/)
const HARD_CODED_PROXIES: string[] = [
  'http://emaschipx-rotate:emaschipx@p.webshare.io:80/',
  'http://proxooo4-rotate:proxooo4@p.webshare.io:80/',
  'http://fabiorealdebrid-rotate:MammamiaHF1@p.webshare.io:80/',
  'http://proxoooo-rotate:proxoooo@p.webshare.io:80/',
  'http://teststremio-rotate:teststremio@p.webshare.io:80/',
  'http://mammapro-rotate:mammapro@p.webshare.io:80/'
];
function pickProxy(): string | undefined { if (!HARD_CODED_PROXIES.length) return undefined; return HARD_CODED_PROXIES[Math.floor(Math.random()*HARD_CODED_PROXIES.length)]; }

let rrIndex = 0; // round-robin pointer
async function proxyAttempt(url: URL): Promise<string | null> {
  const proxies = HARD_CODED_PROXIES.filter(Boolean);
  if (!proxies.length) return null;
  const first = rrIndex % proxies.length; rrIndex++;
  const order = [first];
  if (proxies.length > 1) order.push((first+1) % proxies.length); // al massimo il successivo
  for (let i=0;i<order.length;i++) {
    const proxy = proxies[order[i]];
    const masked = proxy.replace(/:\w+@/, ':***@');
    try {
      console.log('[FS][PROXY][TRY]', masked, 'slot', i+1,'of', order.length, 'rrIndexStart', first);
      const controller = new AbortController();
      const to = setTimeout(()=>controller.abort(), 5000);
      // @ts-ignore
      const agent = new (require('undici').ProxyAgent)(proxy);
  // @ts-ignore undici ProxyAgent custom field
  const r = await fetch(url, { headers: { 'User-Agent': hostUA.get(url.host)||DEFAULT_UA, 'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'en','Priority':'u=0' }, dispatcher: agent, signal: controller.signal });
      clearTimeout(to);
      const txt = await r.text();
      console.log('[FS][PROXY][RESP]', masked, 'status', r.status, 'len', txt.length);
      if (r.status >=200 && r.status <=399 && txt.length>0) return txt;
    } catch(e:any) { console.log('[FS][PROXY][ERR]', masked, e?.message || e); }
  }
  return null;
}

// Estensione heuristics Cloudflare: aggiunti pattern ("Just a moment", __cf_chl_, enable javascript, challenge-platform)
// con bypass immediato se pagina 200 contiene marker stream (data-link=)
async function fetchHtml(url: URL, opts?: { noCache?: boolean }): Promise<string> {
  if (!opts?.noCache) {
    const c = getCache(url);
    if (c) {
      const isChallengeCache = c.headers['cf-mitigated'] === 'challenge' || c.body.includes('cf-turnstile');
      if (!isChallengeCache && c.status >= 200 && c.status <= 399) return c.body;
    }
  }
  console.log('[FS][FETCH]', url.href);
  const resp = await fetchWithRetry(url);
  const headers: Record<string,string> = {}; resp.headers.forEach((v,k)=>{ headers[k]=v; });
  let body = await resp.text();

  const headerChallenge = headers['cf-mitigated'] === 'challenge';
  const bodyTurnstile = body.includes('cf-turnstile');
  // Broad heuristics richieste
  const broadPatterns = [ /__cf_chl_/i, /Just a moment/i, /enable javascript and cookies to continue/i, /challenge-platform\//i ];
  const bodyBroad = broadPatterns.some(r=>r.test(body));
  // Marker pagina valida MostraGuarda (contiene data-link per gli embed)
  const hasStreamMarkers = resp.status === 200 && /data-link\s*=\s*"[^"]+"/i.test(body);
  const isChallenge = headerChallenge || bodyTurnstile || bodyBroad;

  if (resp.status === 404) { setCache(url, resp.status, headers, body); throw new Error('not_found'); }

  // 403: always attempt solver, then proxy fallback
  if (resp.status === 403) {
    console.log('[FS][HTTP][403]', url.href, 'attempt solver');
    const solved = await solveChallenge(url);
    if (!solved) {
      console.log('[FS][SOLVER][403][FAIL]', url.href);
      const viaProxy = await proxyAttempt(url);
      if (viaProxy) return viaProxy;
      throw new Error('cloudflare_challenge');
    }
    body = solved;
    setCache(url, 200, headers, body);
    console.log('[FS][SOLVER][403][OK]', url.href, 'len', body.length);
    return body;
  }

  // Bypass: se la pagina ha già marker stream e status 200 ignoriamo heuristics anche se broad patterns matchano
  if (hasStreamMarkers && resp.status >=200 && resp.status <=399) {
    setCache(url, resp.status, headers, body);
    console.log('[FS][STREAMPAGE][BYPASS]', url.href, 'len', body.length, 'broadMatch=', bodyBroad, 'turnstile=', bodyTurnstile, 'hdrChal=', headerChallenge);
    return body;
  }

  // Challenge path (any status) when explicit signals present
  if (isChallenge) {
    console.log('[FS][CHALLENGE] detected', url.href, 'hdr=', headerChallenge, 'turnstile=', bodyTurnstile, 'broad=', bodyBroad);
    const solved = await solveChallenge(url);
    if (!solved) {
      console.log('[FS][CHALLENGE][FAIL]', url.href);
      const viaProxy = await proxyAttempt(url);
      if (viaProxy) return viaProxy;
      throw new Error('cloudflare_challenge');
    }
    body = solved;
    setCache(url, 200, headers, body);
    console.log('[FS][CHALLENGE][SOLVED]', url.href, 'len', body.length);
    return body;
  }

  if (resp.status === 451) throw new Error('cloudflare_censor');
  if (resp.status === 429) throw new Error('too_many_requests');

  // Normal successful response (no challenge signals)
  if (resp.status >= 200 && resp.status <= 399) {
    setCache(url, resp.status, headers, body);
    console.log('[FS][FETCH][OK]', url.href, 'status', resp.status, 'len', body.length);
    return body;
  }

  // Other non-success
  setCache(url, resp.status, headers, body);
  throw new Error(`http_${resp.status}`);
}

// API pubblica analoga al precedente helper semplificato
export async function fetchPage(url: string, opts?: { noCache?: boolean }) {
  return fetchHtml(new URL(url), opts);
}

// Forza tentativi su TUTTI i proxy hard-coded ignorando cache/solver: usato come ultima risorsa
export async function fetchPageWithProxies(url: string): Promise<string> {
  const u = new URL(url);
  // Usa la stessa logica di proxyAttempt ma forzando partenza round-robin attuale + prossimo
  const proxies = HARD_CODED_PROXIES.filter(Boolean);
  if (!proxies.length) throw new Error('no_proxies');
  const start = rrIndex % proxies.length; rrIndex++;
  const order = [start];
  if (proxies.length > 1) order.push((start+1)%proxies.length);
  console.log('[FS][PROXYFORCE][START]', u.href, 'order', order.map(i=>i+1).join(','),'of',proxies.length);
  const broadPatterns = [ /__cf_chl_/i, /Just a moment/i, /enable javascript and cookies to continue/i, /challenge-platform\//i ];
  for (let i=0;i<order.length;i++) {
    const proxy = proxies[order[i]];
    const masked = proxy.replace(/:\w+@/, ':***@');
    try {
      console.log('[FS][PROXYFORCE][TRY]', masked, 'slot', i+1, 'of', order.length);
      const controller = new AbortController();
      const to = setTimeout(()=>controller.abort(), 7000);
      // @ts-ignore
      const agent = new (require('undici').ProxyAgent)(proxy);
      const headers: Record<string,string> = { 'User-Agent': hostUA.get(u.host) || DEFAULT_UA,'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'en','Priority':'u=0' };
      const ck = getCookieHeader(u.host); if (ck) headers['Cookie'] = ck;
  // @ts-ignore undici ProxyAgent custom field
  const resp: Response = await fetch(u, { headers, dispatcher: agent, signal: controller.signal });
      clearTimeout(to);
      const txt = await resp.text();
      const headerChallenge = resp.headers.get('cf-mitigated') === 'challenge';
      const bodyBroad = broadPatterns.some(r=>r.test(txt));
      const bodyTurnstile = /cf-turnstile/.test(txt);
      const hasStreamMarkers = resp.status === 200 && /data-link\s*=\s*"[^\"]+"/i.test(txt);
      const isChallenge = headerChallenge || bodyBroad || bodyTurnstile;
      console.log('[FS][PROXYFORCE][RESP]', masked, 'status', resp.status, 'len', txt.length, 'chal=', isChallenge, 'streamMarkers=', hasStreamMarkers);
      if (resp.status >=200 && resp.status <=399 && txt.length>0) {
        if (hasStreamMarkers || !isChallenge) {
          console.log('[FS][PROXYFORCE][OK]', masked);
          return txt;
        }
      }
    } catch(e:any) {
      console.log('[FS][PROXYFORCE][ERR]', masked, e?.message || e);
    }
  }
  console.log('[FS][PROXYFORCE][FAIL]', u.href);
  throw new Error('cloudflare_challenge');
}

// Cache streams (immutata dalla versione precedente)
const CACHE_FILE = path.join(process.cwd(), 'config', 'mostraguarda_cache.json');
interface StreamCacheEntry { timestamp: number; streams: any[] }
interface StreamCache { [imdbId: string]: StreamCacheEntry }

function ensureCacheFile() {
  try {
    const dir = path.dirname(CACHE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(CACHE_FILE)) fs.writeFileSync(CACHE_FILE, '{}');
  } catch { /* ignore */ }
}

export function readStreamCache(): StreamCache { ensureCacheFile(); try { return JSON.parse(fs.readFileSync(CACHE_FILE,'utf8')); } catch { return {}; } }
export function writeStreamCache(cache: StreamCache) { ensureCacheFile(); try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache,null,2)); } catch { /* ignore */ } }
export function purgeOld(cache: StreamCache, ttl: number) { const t = now(); let changed=false; for (const k of Object.keys(cache)) { if (t - cache[k].timestamp > ttl) { delete cache[k]; changed=true; } } if (changed) writeStreamCache(cache); }
