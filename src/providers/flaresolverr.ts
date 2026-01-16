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
// Solver disabilitato: ritorna undefined (puoi riattivare ripristinando lettura env)
function getSolverUrl(): string | undefined { return undefined; /* process?.env?.SOLVER_URL */ }

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

// NOTE: Snellito: rimosse logiche solver, rate limit avanzato, pickProxy random.
// Cache ora SOLO per status 200.

// Funzioni di utilità
function now() { return Date.now(); }

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
  // simplified: direct baseFetch with one retry on 5xx or abort
  try {
    const resp = await baseFetch(url, {});
    if (resp.status >=500 && resp.status < 600 && attempt < 1) {
      await sleep(250);
      return fetchWithRetry(url, attempt+1);
    }
    return resp;
  } catch(e:any){
    if (e?.name === 'AbortError' && attempt < 1) {
      await sleep(250);
      return fetchWithRetry(url, attempt+1);
    }
    throw e;
  }
}

function cacheKey(url: URL) { return url.href; }

function setCache(url: URL, status:number, headers:Record<string,string>, body:string) {
  // SOLO status 200 in cache
  const ttl = (status === 200) ? MIN_CACHE_TTL : 0;
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

// Proxy support hard-coded (DISABLED): la lista è stata spostata in src/config/proxies.ts per uso negli extractor.
// Manteniamo l'array vuoto così questa logica non userà più proxy interni.
// Storico (commentato) lasciato per riferimento rapido.
/*
*/
const HARD_CODED_PROXIES: string[] = [];
function pickProxy(): string | undefined { if (!HARD_CODED_PROXIES.length) return undefined; return HARD_CODED_PROXIES[Math.floor(Math.random()*HARD_CODED_PROXIES.length)]; }

let rrIndex = 0; // round-robin pointer
async function proxyAttemptSimple(url: URL): Promise<string | null> {
  const proxies = HARD_CODED_PROXIES.filter(Boolean);
  if (!proxies.length) return null;
  const first = rrIndex % proxies.length; rrIndex++;
  const order = [first];
  if (proxies.length > 1) order.push((first+1) % proxies.length);
  for (let i=0;i<order.length;i++) {
    const proxy = proxies[order[i]];
    const masked = proxy.replace(/:\w+@/, ':***@');
    try {
      console.log('[FS][PROXY][TRY]', masked, 'slot', i+1, 'of', order.length);
      const controller = new AbortController();
      const to = setTimeout(()=>controller.abort(), 6000);
      // @ts-ignore
      const agent = new (require('undici').ProxyAgent)(proxy);
      // @ts-ignore
      const r: Response = await fetch(url, { headers: { 'User-Agent': hostUA.get(url.host)||DEFAULT_UA,'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8','Accept-Language':'en','Priority':'u=0' }, dispatcher: agent, signal: controller.signal });
      clearTimeout(to);
      const txt = await r.text();
      const hasMarkers = r.status === 200 && /data-link\s*=\s*"[^"]+"/i.test(txt);
      const challengeLike = r.status === 403 || /cf-turnstile|__cf_chl_|Just a moment|enable javascript and cookies to continue|challenge-platform\//i.test(txt);
      if (r.status === 200 && (hasMarkers || !challengeLike)) {
        setCache(url, r.status, {}, txt); // cache only 200
        return txt;
      }
    } catch(e:any){ console.log('[FS][PROXY][ERR]', masked, e?.message||e); }
  }
  return null;
}

async function fetchHtml(url: URL, opts?: { noCache?: boolean }): Promise<string> {
  if (!opts?.noCache) {
    const c = getCache(url);
    if (c && c.status === 200) return c.body;
  }
  console.log('[FS][FETCH]', url.href);
  const resp = await fetchWithRetry(url);
  const headers: Record<string,string> = {}; resp.headers.forEach((v,k)=>{ headers[k]=v; });
  const body = await resp.text();

  const hasMarkers = resp.status === 200 && /data-link\s*=\s*"[^"]+"/i.test(body);
  const challengePattern = /cf-turnstile|__cf_chl_|Just a moment|enable javascript and cookies to continue|challenge-platform\//i;
  const challengeLike = resp.status === 403 || challengePattern.test(body);

  if (resp.status === 404) throw new Error('not_found');

  // Caso success 200 con markers (bypass sempre)
  if (resp.status === 200 && hasMarkers) {
    setCache(url, 200, headers, body);
    return body;
  }

  // Se 200 ma challengeLike (senza markers) -> tenta proxy (max 2)
  if (resp.status === 200 && challengeLike && !hasMarkers) {
    const via = await proxyAttemptSimple(url);
    if (via) return via;
    throw new Error('cloudflare_challenge');
  }

  // Se 403 o challenge-like -> proxy attempt
  if (challengeLike && resp.status !== 200) {
    const via = await proxyAttemptSimple(url);
    if (via) return via;
    throw new Error('cloudflare_challenge');
  }

  if (resp.status >=200 && resp.status <=399) {
    setCache(url, resp.status, headers, body);
    return body;
  }
  if (resp.status === 451) throw new Error('cloudflare_censor');
  if (resp.status === 429) throw new Error('too_many_requests');
  if (resp.status === 403) throw new Error('cloudflare_challenge');
  throw new Error(`http_${resp.status}`);
}

// API pubblica analoga al precedente helper semplificato
export async function fetchPage(url: string, opts?: { noCache?: boolean }) { return fetchHtml(new URL(url), opts); }

// Forza tentativi su TUTTI i proxy hard-coded ignorando cache/solver: usato come ultima risorsa
export async function fetchPageWithProxies(url: string): Promise<string> {
  const out = await proxyAttemptSimple(new URL(url));
  if (out) return out;
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
