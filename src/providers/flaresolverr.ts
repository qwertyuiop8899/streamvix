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
const hostCookies = new Map<string, Map<string,string>>();
const hostUA = new Map<string,string>();

function getCookieHeader(host: string): string | undefined {
  const jar = hostCookies.get(host);
  if (!jar) return undefined;
  if (jar.size === 0) return undefined;
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

async function baseFetch(url: URL, init?: RequestInit & { timeout?: number }): Promise<Response> {
  const controller = new AbortController();
  const to = setTimeout(()=>controller.abort(), init?.timeout ?? 5000);
  const headers: Record<string,string> = {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en',
    'Priority': 'u=0',
    'User-Agent': hostUA.get(url.host) || 'node',
    ...(init?.headers as any || {}),
  };
  const ck = getCookieHeader(url.host); if (ck) headers['Cookie'] = ck;
  try {
    return await fetch(url, { ...init, headers, signal: controller.signal, keepalive: true });
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
}

function getCache(url: URL): HttpCacheItem | undefined {
  const it = httpCache.get(cacheKey(url));
  if (!it) return undefined;
  if (it.expiry && it.expiry < now()) { httpCache.delete(cacheKey(url)); return undefined; }
  return it;
}

async function solveChallenge(url: URL): Promise<string | null> {
  const SOLVER_URL = getSolverUrl();
  if (!SOLVER_URL) return null;
  try {
    const body = JSON.stringify({ cmd: 'request.get', url: url.href, session: 'default' });
    const resp = await fetch(SOLVER_URL, { method: 'POST', headers: { 'Content-Type':'application/json' }, body });
    const json = await resp.json() as SolverResult;
    if (json.status === 'ok' && json.solution) {
      storeSolver(json.solution);
      return json.solution.response;
    }
  } catch { /* ignore */ }
  return null;
}

async function fetchHtml(url: URL, opts?: { noCache?: boolean }): Promise<string> {
  if (!opts?.noCache) {
    const c = getCache(url);
    if (c) {
      const challenge = c.headers['cf-mitigated'] === 'challenge' || c.body.includes('cf-turnstile');
      if (!challenge && c.status >= 200 && c.status <= 399) return c.body;
    }
  }
  const resp = await fetchWithRetry(url);
  const headers: Record<string,string> = {};
  resp.headers.forEach((v,k)=>{ headers[k]=v; });
  let body = await resp.text();
  const challenge = headers['cf-mitigated'] === 'challenge' || body.includes('cf-turnstile');
  if (resp.status === 404) { setCache(url, resp.status, headers, body); throw new Error('not_found'); }
  if (challenge) {
    const solved = await solveChallenge(url);
    if (!solved) throw new Error('cloudflare_challenge');
    body = solved;
  }
  if (resp.status === 403) throw new Error('blocked_403');
  if (resp.status === 451) throw new Error('cloudflare_censor');
  if (resp.status === 429) throw new Error('too_many_requests');
  setCache(url, resp.status, headers, body);
  if (resp.status < 200 || resp.status > 399) throw new Error(`http_${resp.status}`);
  return body;
}

// API pubblica analoga al precedente helper semplificato
export async function fetchPage(url: string, opts?: { noCache?: boolean }) {
  return fetchHtml(new URL(url), opts);
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
