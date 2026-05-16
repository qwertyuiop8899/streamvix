// CinemaCity provider — port of realbestia1/easystreams providers/cinemacity.js
// EasyProxy-only mode: we never decrypt the player ourselves; we just resolve
// the canonical cinemacity.cc page URL for the IMDB/TMDB id and hand it to the
// configured EasyProxy `/extractor/video.m3u8?host=city&d=…&redirect_stream=true`.
//
// Resolution strategy (mirrors upstream):
//   1) Resolve the request to an IMDB id (tt…). TMDB ids are mapped via TMDB.
//   2) Get TMDB metadata for that id → expected titles + year.
//   3) Fetch `https://cinemacity.cc/news_pages.xml` (1h in-memory cache) and
//      parse <loc> entries; pick the best title-match for the right kind
//      (movies vs tv-series), with optional IMDB verification on the page.
//   4) Build target URL: movie → page URL as-is; series → `?s=<S>&e=<E>`.
//   5) Wrap through EasyProxy. If no EasyProxy is configured we return [].
//
// Notes:
//   - The default session cookie + UA from upstream are kept so the sitemap
//     fetch behaves like a logged-in browser (cinemacity.cc requires this).
//   - We intentionally do NOT implement the legacy search fallback paths —
//     the sitemap alone covers current content and matches upstream default.

import type { StreamForStremio } from '../types/animeunity';

export interface CinemaCityConfig {
  enabled: boolean;
  mfpUrl?: string;       // EasyProxy / MediaFlowProxy base URL
  mfpPassword?: string;  // EasyProxy api_password
  tmdbApiKey?: string;
}

const BASE_URL = 'https://cinemacity.cc';
const SITEMAP_URL = `${BASE_URL}/news_pages.xml`;
const SITEMAP_TTL_MS = 60 * 60 * 1000; // 1h
const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
// Session cookies from upstream (base64 of `dle_user_id=...; dle_password=...;`).
const SESSION_COOKIE = Buffer.from(
  'ZGxlX3VzZXJfaWQ9MzI3Mjk7IGRsZV9wYXNzd29yZD04OTQxNzFjNmE4ZGFiMThlZTU5NGQ1YzY1MjAwOWEzNTs=',
  'base64',
).toString('utf-8');

function logC(...args: any[]) { try { console.log('[CinemaCity]', ...args); } catch { /* */ } }

// --- sitemap cache ----------------------------------------------------------

interface SitemapEntry {
  url: string;
  kind: 'movies' | 'tv-series';
  title: string;
  normalizedTitle: string;
  compactTitle: string;
  tokens: string[];
  year: number | null;
}
let sitemapCache: { entries: SitemapEntry[]; expiresAt: number } | null = null;

// --- helpers ----------------------------------------------------------------

function normalizeTitle(value: string): string {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
function compactTitle(value: string): string { return normalizeTitle(value).replace(/\s+/g, ''); }

const STOPWORDS = new Set([
  'the','a','an','of','and','in','on','to','for','at','by','is','it',
  'il','lo','la','gli','le','un','uno','una','di','da','del','della','dei',
  'e','o','con','per','su','tra','fra',
]);
function getSignificantTokens(value: string): string[] {
  return normalizeTitle(value).split(/\s+/).filter(t => t.length > 1 && !STOPWORDS.has(t));
}

function parseSitemapEntries(xml: string): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  const re = /<loc>(https:\/\/cinemacity\.cc\/(movies|tv-series)\/\d+-([a-z0-9-]+)\.html)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const url = m[1];
    const kind = m[2] as 'movies' | 'tv-series';
    const slug = m[3];
    const yearMatch = slug.match(/-(\d{4})$/);
    const year = yearMatch ? parseInt(yearMatch[1], 10) : null;
    const titleSlug = yearMatch ? slug.slice(0, -5) : slug;
    const title = titleSlug.replace(/-/g, ' ');
    entries.push({
      url, kind, title,
      normalizedTitle: normalizeTitle(title),
      compactTitle: compactTitle(title),
      tokens: getSignificantTokens(title),
      year: Number.isInteger(year) ? year : null,
    });
  }
  return entries;
}

async function fetchWithTimeout(url: string, opts: any = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally { clearTimeout(t); }
}

// --- CF-aware fetch via PROXY / PROXY_BACKUP --------------------------------
// Cinemacity is gated by Cloudflare. We first try a direct fetch; on a blocked
// status (403/429/503/520/521) or HTML carrying CF challenge markers we retry
// through `process.env.PROXY`, then `process.env.PROXY_BACKUP`. Both env vars
// can be standard `http(s)://user:pass@host:port` URLs (undici.ProxyAgent).
//
// We only use this for cinemacity.cc itself. TMDB and the EasyProxy never
// go through these proxies.
// NB: `/cdn-cgi/challenge-platform/scripts/jsd/main.js` is shipped on ALL
// pages by CF for telemetry — it is NOT a challenge marker. The real challenge
// page path is `/cdn-cgi/challenge-platform/h/...`. We match that one.
const CF_MARKERS = /cf-turnstile|__cf_chl_|Just a moment\.\.\.|enable javascript and cookies to continue|\/cdn-cgi\/challenge-platform\/h\/|Cloudflare has blocked/i;

function isBlockedStatus(s: number): boolean {
  return s === 0 || s === 403 || s === 429 || s === 503 || s === 520 || s === 521 || s === 522;
}

function maskProxy(p: string): string { return p.replace(/:[^@/]+@/, ':***@'); }

async function tryFetchOnce(
  url: string,
  headers: Record<string, string>,
  proxyUrl?: string,
): Promise<{ status: number; text: string } | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  const init: any = { headers, signal: ctl.signal };
  if (proxyUrl) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const undici = require('undici');
      init.dispatcher = new undici.ProxyAgent(proxyUrl);
    } catch (e: any) {
      logC('undici ProxyAgent unavailable, skipping proxy attempt:', e?.message || e);
      clearTimeout(t);
      return null;
    }
  }
  try {
    const r: Response = await fetch(url, init);
    const text = await r.text();
    return { status: r.status, text };
  } catch (e: any) {
    logC('fetch err', proxyUrl ? `(via ${maskProxy(proxyUrl)})` : '(direct)', e?.message || e);
    return null;
  } finally { clearTimeout(t); }
}

function isUsable(r: { status: number; text: string } | null): boolean {
  if (!r) return false;
  if (isBlockedStatus(r.status)) return false;
  if (r.status >= 200 && r.status < 400 && !CF_MARKERS.test(r.text)) return true;
  return false;
}

async function cfAwareFetch(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string } | null> {
  let last = await tryFetchOnce(url, headers);
  if (isUsable(last)) return last;
  const env = (typeof process !== 'undefined' ? process.env : {}) as any;
  const primary = String(env.PROXY || '').trim();
  const backup = String(env.PROXY_BACKUP || '').trim();
  const chain = [primary, backup].filter(Boolean);
  for (const p of chain) {
    logC('retry via', maskProxy(p), '(prev status=' + (last ? last.status : 'err') + ')');
    const r = await tryFetchOnce(url, headers, p);
    if (isUsable(r)) return r;
    if (r) last = r;
  }
  if (last && !isUsable(last)) {
    logC('all attempts blocked. final status=' + last.status);
  }
  return last;
}

async function fetchSitemap(): Promise<SitemapEntry[]> {
  if (sitemapCache && sitemapCache.expiresAt > Date.now()) return sitemapCache.entries;
  logC('fetching sitemap', SITEMAP_URL);
  const r = await cfAwareFetch(SITEMAP_URL, {
    'User-Agent': USER_AGENT,
    'Accept': 'application/xml,text/xml,text/html;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': `${BASE_URL}/`,
    'Cookie': SESSION_COOKIE,
  });
  if (!r || r.status < 200 || r.status >= 400) throw new Error(`sitemap HTTP ${r ? r.status : 'err'}`);
  const entries = parseSitemapEntries(r.text);
  sitemapCache = { entries, expiresAt: Date.now() + SITEMAP_TTL_MS };
  logC('sitemap loaded:', entries.length, 'entries');
  return entries;
}

interface TmdbMeta { title?: string; name?: string; original_title?: string; original_name?: string; release_date?: string; first_air_date?: string }

async function getTmdbMetadata(id: string, isMovie: boolean, apiKey: string): Promise<TmdbMeta | null> {
  try {
    const normId = id.trim();
    const kind = isMovie ? 'movie' : 'tv';
    let url: string;
    if (/^tt\d+$/i.test(normId)) {
      url = `https://api.themoviedb.org/3/find/${encodeURIComponent(normId)}?api_key=${apiKey}&external_source=imdb_id&language=en-US`;
    } else if (/^\d+$/.test(normId)) {
      url = `https://api.themoviedb.org/3/${kind}/${normId}?api_key=${apiKey}&language=en-US`;
    } else return null;
    const r = await fetchWithTimeout(url);
    if (!r.ok) return null;
    const j: any = await r.json();
    if (/^tt\d+$/i.test(normId)) {
      const arr = isMovie ? j?.movie_results : j?.tv_results;
      return Array.isArray(arr) && arr.length ? arr[0] : null;
    }
    return j;
  } catch (e: any) { logC('tmdb meta err', e?.message || e); return null; }
}

function extractYear(meta: TmdbMeta | null): number | null {
  const d = meta?.release_date || meta?.first_air_date || '';
  const y = parseInt(String(d).slice(0, 4), 10);
  return Number.isInteger(y) ? y : null;
}

function scoreEntry(entry: SitemapEntry, expectedTitles: string[], expectedYear: number | null): number {
  let best = 0;
  for (const title of expectedTitles) {
    const norm = normalizeTitle(title);
    const comp = compactTitle(title);
    if (!norm || !comp) continue;
    let score = 0;
    if (entry.normalizedTitle === norm || entry.compactTitle === comp) score = 1000;
    else if (entry.normalizedTitle.startsWith(norm) || norm.startsWith(entry.normalizedTitle)) score = 500;
    else if (entry.compactTitle.includes(comp) || comp.includes(entry.compactTitle)) score = 420;
    else {
      const exp = getSignificantTokens(title);
      if (exp.length && entry.tokens.length) {
        let hits = 0;
        const set = new Set(entry.tokens);
        for (const t of exp) if (set.has(t)) hits++;
        const coverage = hits / exp.length;
        const extra = Math.max(0, entry.tokens.length - exp.length);
        score = coverage * 300 - extra * 20 - Math.abs(entry.tokens.length - exp.length) * 2;
      }
    }
    if (expectedYear && entry.year) {
      score += entry.year === expectedYear ? 50 : -Math.abs(entry.year - expectedYear) * 3;
    }
    if (score > best) best = score;
  }
  return best;
}

async function verifyImdbOnPage(url: string, expectedImdb: string): Promise<boolean> {
  const r = await cfAwareFetch(url, {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': `${BASE_URL}/`,
    'Cookie': SESSION_COOKIE,
  });
  if (!r || r.status < 200 || r.status >= 400) return false;
  const m = (r.text.match(/\btt\d{5,}\b/gi) || [])[0];
  return !!m && m.toLowerCase() === expectedImdb.toLowerCase();
}

async function searchBySitemap(
  id: string,
  isMovie: boolean,
  apiKey: string,
): Promise<{ url: string; title: string } | null> {
  const expectedImdb = /^tt\d{5,}$/i.test(id) ? id.toLowerCase() : null;
  const meta = await getTmdbMetadata(id, isMovie, apiKey);
  const expectedTitles = Array.from(new Set([
    meta?.title, meta?.name, meta?.original_title, meta?.original_name,
  ].filter(Boolean) as string[]));
  if (!expectedTitles.length) { logC('no TMDB titles for', id); return null; }
  const year = extractYear(meta);
  const expectedKind = isMovie ? 'movies' : 'tv-series';
  let entries: SitemapEntry[];
  try { entries = await fetchSitemap(); }
  catch (e: any) { logC('sitemap fetch err', e?.message || e); return null; }

  let best: SitemapEntry | null = null;
  let bestScore = -Infinity;
  const ranked: { entry: SitemapEntry; score: number }[] = [];
  for (const e of entries) {
    if (e.kind !== expectedKind) continue;
    const s = scoreEntry(e, expectedTitles, year);
    if (s >= 250) ranked.push({ entry: e, score: s });
    if (s > bestScore) { bestScore = s; best = e; }
  }
  if (!best || bestScore < 250) {
    logC(`no confident match for "${expectedTitles[0]}" (best=${Math.round(bestScore)})`);
    return null;
  }
  // IMDb verify for top candidates when we have an expected IMDb id.
  if (expectedImdb) {
    ranked.sort((a, b) => b.score - a.score);
    for (const c of ranked.slice(0, 3)) {
      if (await verifyImdbOnPage(c.entry.url, expectedImdb)) {
        logC('IMDb verified:', expectedTitles[0], '->', c.entry.url);
        return { url: c.entry.url, title: expectedTitles[0] || c.entry.title };
      }
    }
    if (bestScore < 950) {
      logC('match not IMDb-verified, skipping (best score', Math.round(bestScore), ')');
      return null;
    }
  }
  logC('match:', expectedTitles[0], '->', best.url, '[score=' + Math.round(bestScore) + ']');
  return { url: best.url, title: expectedTitles[0] || best.title };
}

function buildProxyUrl(targetUrl: string, mfpUrl: string, mfpPassword?: string): string {
  const base = mfpUrl.replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('host', 'city');
  params.set('d', targetUrl);
  params.set('redirect_stream', 'true');
  if (mfpPassword) params.set('api_password', mfpPassword);
  return `${base}/extractor/video.m3u8?${params.toString()}`;
}

// --- provider ---------------------------------------------------------------

export class CinemaCityProvider {
  constructor(private config: CinemaCityConfig) {}

  private get apiKey(): string {
    return this.config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0';
  }

  async handleImdbRequest(
    imdbId: string,
    season?: number | null,
    episode?: number | null,
    isMovie: boolean = true,
  ): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) return { streams: [] };
    if (!this.config.mfpUrl) { logC('no EasyProxy configured -> skip'); return { streams: [] }; }
    const id = (imdbId || '').split(':')[0];
    if (!/^tt\d+$/i.test(id)) return { streams: [] };
    const found = await searchBySitemap(id, isMovie, this.apiKey);
    if (!found) return { streams: [] };
    let target = found.url;
    if (!isMovie && season && episode) {
      const sep = target.includes('?') ? '&' : '?';
      target += `${sep}s=${season}&e=${episode}`;
    }
    const proxyUrl = buildProxyUrl(target, this.config.mfpUrl, this.config.mfpPassword);
    const titleLine = isMovie
      ? `Movie\n💾 CinemaCity`
      : `S${season}E${episode}\n💾 CinemaCity`;
    const stream: StreamForStremio = {
      title: titleLine,
      url: proxyUrl,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: 'cinemacity-std',
      } as any,
    };
    return { streams: [stream] };
  }

  async handleTmdbRequest(
    tmdbId: string,
    season?: number | null,
    episode?: number | null,
    isMovie: boolean = true,
  ): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) return { streams: [] };
    if (!this.config.mfpUrl) return { streams: [] };
    const clean = (tmdbId || '').replace(/^tmdb:/, '').split(':')[0];
    if (!/^\d+$/.test(clean)) return { streams: [] };
    try {
      const endpoint = isMovie
        ? `https://api.themoviedb.org/3/movie/${clean}?api_key=${encodeURIComponent(this.apiKey)}`
        : `https://api.themoviedb.org/3/tv/${clean}/external_ids?api_key=${encodeURIComponent(this.apiKey)}`;
      const r = await fetchWithTimeout(endpoint);
      if (!r.ok) { logC('tmdb→imdb http', r.status); return { streams: [] }; }
      const j: any = await r.json();
      const imdb = j?.imdb_id;
      if (!imdb || !String(imdb).startsWith('tt')) { logC('tmdb→imdb missing'); return { streams: [] }; }
      return this.handleImdbRequest(imdb, season, episode, isMovie);
    } catch (e: any) { logC('tmdb err', e?.message || e); return { streams: [] }; }
  }
}
