// CinemaCity provider — port of realbestia1/easystreams providers/cinemacity.js
// Two modes, chosen automatically per request:
//   A) EasyProxy mode — when `mfpUrl` is configured. We resolve the canonical
//      cinemacity.cc page URL for the IMDB/TMDB id and hand it to the
//      configured EasyProxy `/extractor/video.m3u8?host=city&d=…` (encoding
//      the episode as `?s=&e=` for series). The EasyProxy backend takes care
//      of decrypting the player.
//   B) Direct mode — when no EasyProxy is configured. We fetch the catalog
//      page through the upstream Cloudflare Worker, then extract a direct
//      HLS URL ourselves (anchor scan + atob/JSON `file:` reconstruction).
//      This mirrors the upstream easystreams behaviour.
//
// Resolution strategy is shared by both modes:
//   1) Resolve the request to an IMDB id (tt…). TMDB ids are mapped via TMDB.
//   2) Get TMDB metadata for that id → expected titles + year.
//   3) Fetch `https://cinemacity.cc/news_pages.xml` paginated through the
//      worker (1h in-memory cache); parse <loc> entries; pick the best
//      title-match for the right kind (movies vs tv-series), with IMDB
//      verification on the top candidates when we have a tt id.
//
// Notes:
//   - cinemacity.cc is fronted by Cloudflare. We mirror the upstream approach
//     and go through a public Cloudflare Worker (`cc.leanhhu061206.workers.dev`)
//     that proxies the origin and returns the raw response. No session cookie
//     is needed in this mode.
//   - The sitemap is paginated (`?page=N&perPage=500`); we read the
//     `x-total-entries` header on page 1 and fan out the remaining pages in
//     parallel.
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
const SITEMAP_PATH = '/news_pages.xml';
const SITEMAP_PAGE_SIZE = 500;
const SITEMAP_TTL_MS = 60 * 60 * 1000; // 1h
const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
// Cloudflare Worker that proxies cinemacity.cc and bypasses the CF challenge
// (mirrors the upstream easystreams/providers/cinemacity.js approach).
const WORKER_HOST = Buffer.from('Y2MubGVhbmhodTA2MTIwNi53b3JrZXJzLmRldg==', 'base64').toString('utf-8');

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

// --- direct HLS extraction (no-EasyProxy mode) ------------------------------
// Mirrors easystreams: parse the catalog page (fetched via worker) and pull
// out a playable URL. Two strategies in order:
//   1) <a href="...mp4|m3u8|mkv"> anchors, preferring italian-labelled ones
//   2) atob('…') blobs in <script>: decode → JSON `file:` array → reconstruct
//      a CDN `/public_files/.../<file>.urlset/master.m3u8` URL with italian
//      audio + 1080p video parts.

function base64DecodeSafe(s: string): string {
  try { return Buffer.from(s, 'base64').toString('utf-8'); } catch { return ''; }
}

function buildDownloadUrl(fileVal: string): string | null {
  const idx = fileVal.indexOf('/public_files/');
  if (idx === -1) return null;
  const cdnBase = fileVal.substring(0, idx + '/public_files/'.length);
  const rest = fileVal.substring(idx + '/public_files/'.length);
  const parts = rest.split(',');
  const video = parts.find(p => p.includes('1080p') && p.endsWith('.mp4')) || parts.find(p => p.endsWith('.mp4'));
  const itaAudio = parts.find(p => /italian|italiano/i.test(p) && p.endsWith('.m4a'));
  if (!itaAudio || !video) return null;
  const m3u8Entry = parts.find(p => p.includes('.m3u8'));
  return cdnBase + rest + (m3u8Entry ? '' : '.urlset/master.m3u8');
}

function extractStreamFromAtob(html: string, season: number | null, episode: number | null): string | null {
  const re = /atob\s*\(\s*['"]([^"']{20,})['"]\s*\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const decoded = base64DecodeSafe(m[1]);
    if (!decoded) continue;
    const jm = decoded.match(/file\s*:\s*'(\[.*?\])'/s);
    if (!jm) continue;
    try {
      const parsed = JSON.parse(jm[1]);
      if (!Array.isArray(parsed) || parsed.length === 0) continue;
      if (parsed[0]?.folder && Array.isArray(parsed[0].folder)) {
        const sIdx = Math.max(0, (season || 1) - 1);
        const s = parsed[sIdx];
        const eIdx = Math.max(0, (episode || 1) - 1);
        const ep = s?.folder?.[eIdx];
        if (ep?.file) return buildDownloadUrl(ep.file) || ep.file;
      }
      const fileVal = parsed[0]?.file;
      if (typeof fileVal === 'string' && fileVal.startsWith('http')) {
        return buildDownloadUrl(fileVal) || fileVal;
      }
    } catch { /* keep scanning */ }
  }
  return null;
}

function extractDownloadLinks(html: string): { url: string; text: string }[] {
  const out: { url: string; text: string }[] = [];
  const re = /<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    if (!/\.(mp4|m3u8|mkv|avi|mov|webm)([?#].*)?$/i.test(href)) continue;
    if (href.length < 10) continue;
    out.push({ url: href, text: m[2].replace(/<[^>]+>/g, '').trim().toLowerCase() });
  }
  return out;
}

function pickItalianLink(links: { url: string; text: string }[]): string | null {
  for (const l of links) {
    const t = l.text;
    if (t.includes('ita') || t.includes('italian') || t.includes('italiano')) return l.url;
  }
  for (const l of links) if (!l.text.includes('eng') && !l.text.includes('sub')) return l.url;
  return links[0]?.url || null;
}

function resolveAbsUrl(base: string, rel: string): string {
  if (/^https?:\/\//i.test(rel)) return rel;
  try { return new URL(rel, base).toString(); } catch { return rel; }
}

async function extractDirectStream(
  pageUrl: string,
  isMovie: boolean,
  season: number | null,
  episode: number | null,
): Promise<string | null> {
  const r = await fetchViaWorker(pageUrl, {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': `${BASE_URL}/`,
  });
  if (!r || r.status < 200 || r.status >= 400) {
    logC('direct extract: page status', r?.status);
    return null;
  }
  const html = r.text;
  if (html.length < 500) { logC('direct extract: page too small'); return null; }

  // Strategy 1: anchor links (often present for movies)
  const anchors = extractDownloadLinks(html);
  let picked = pickItalianLink(anchors);
  // Strategy 2: atob-encoded JSON player config
  if (!picked) {
    picked = extractStreamFromAtob(html, isMovie ? null : season, isMovie ? null : episode);
  }
  if (!picked) { logC('direct extract: no playable url'); return null; }
  return resolveAbsUrl(pageUrl, picked);
}

async function fetchWithTimeout(url: string, opts: any = {}): Promise<Response> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeout || FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally { clearTimeout(t); }
}

// --- Worker-proxied fetch ---------------------------------------------------
// cinemacity.cc is gated by Cloudflare. The upstream easystreams provider goes
// through a public Cloudflare Worker (`cc.leanhhu061206.workers.dev`) that
// forwards the request to the origin and returns the raw response. We do the
// same here. Only used for cinemacity.cc itself — TMDB and the EasyProxy
// extractor never go through it.
function workerUrl(pathAndQuery: string): string {
  const p = pathAndQuery.startsWith('/') ? pathAndQuery : '/' + pathAndQuery;
  return `https://${WORKER_HOST}${p}`;
}

async function fetchViaWorker(
  absoluteOrPath: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; text: string; headers: Headers } | null> {
  let pathAndQuery: string;
  if (/^https?:\/\//i.test(absoluteOrPath)) {
    try {
      const u = new URL(absoluteOrPath);
      pathAndQuery = u.pathname + u.search;
    } catch { return null; }
  } else {
    pathAndQuery = absoluteOrPath;
  }
  const target = workerUrl(pathAndQuery);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r: Response = await fetch(target, {
      headers: { 'User-Agent': USER_AGENT, ...extraHeaders },
      signal: ctl.signal,
    });
    const text = await r.text();
    return { status: r.status, text, headers: r.headers };
  } catch (e: any) {
    logC('worker fetch err:', e?.message || e);
    return null;
  } finally { clearTimeout(t); }
}

async function fetchSitemap(): Promise<SitemapEntry[]> {
  if (sitemapCache && sitemapCache.expiresAt > Date.now()) return sitemapCache.entries;
  logC('fetching paginated sitemap via worker');

  let all: SitemapEntry[] = [];
  // First page tells us how many entries exist (x-total-entries header).
  const first = await fetchViaWorker(`${SITEMAP_PATH}?page=1&perPage=${SITEMAP_PAGE_SIZE}`);
  if (first && first.status >= 200 && first.status < 400) {
    all = parseSitemapEntries(first.text);
    const total = parseInt(first.headers.get('x-total-entries') || '0', 10);
    if (Number.isInteger(total) && total > all.length) {
      const totalPages = Math.ceil(total / SITEMAP_PAGE_SIZE);
      const tasks: Promise<void>[] = [];
      for (let p = 2; p <= totalPages; p++) {
        tasks.push((async () => {
          const r = await fetchViaWorker(`${SITEMAP_PATH}?page=${p}&perPage=${SITEMAP_PAGE_SIZE}`);
          if (r && r.status >= 200 && r.status < 400) {
            all = all.concat(parseSitemapEntries(r.text));
          }
        })());
      }
      await Promise.all(tasks);
    }
  }

  // Fallback: single-shot full sitemap if paginated mode returned nothing.
  if (all.length === 0) {
    const r = await fetchViaWorker(SITEMAP_PATH);
    if (r && r.status >= 200 && r.status < 400) all = parseSitemapEntries(r.text);
  }

  if (all.length === 0) throw new Error('sitemap empty');
  sitemapCache = { entries: all, expiresAt: Date.now() + SITEMAP_TTL_MS };
  logC('sitemap loaded:', all.length, 'entries');
  return all;
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
  const r = await fetchViaWorker(url, {
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Referer': `${BASE_URL}/`,
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
    const id = (imdbId || '').split(':')[0];
    if (!/^tt\d+$/i.test(id)) return { streams: [] };
    const found = await searchBySitemap(id, isMovie, this.apiKey);
    if (!found) return { streams: [] };
    const pageUrl = found.url;
    const titleLine = isMovie
      ? `Movie\n💾 CinemaCity`
      : `S${season}E${episode}\n💾 CinemaCity`;

    // Branch A: EasyProxy configured → wrap through MFP extractor (host=city).
    // EasyProxy expects the series episode encoded as ?s=&e= on the target.
    if (this.config.mfpUrl) {
      let target = pageUrl;
      if (!isMovie && season && episode) {
        const sep = target.includes('?') ? '&' : '?';
        target += `${sep}s=${season}&e=${episode}`;
      }
      const proxyUrl = buildProxyUrl(target, this.config.mfpUrl, this.config.mfpPassword);
      return {
        streams: [{
          title: titleLine,
          url: proxyUrl,
          behaviorHints: { notWebReady: true, bingeGroup: 'cinemacity-std' } as any,
        }],
      };
    }

    // Branch B: no EasyProxy → resolve directly via worker (easystreams mode).
    // The catalog page itself carries the full season/episode tree inside the
    // atob blob; we pick the right ep from there. No ?s=&e= needed.
    const directUrl = await extractDirectStream(pageUrl, isMovie, season || null, episode || null);
    if (!directUrl) { logC('direct mode: no stream resolved'); return { streams: [] }; }
    return {
      streams: [{
        title: titleLine,
        url: directUrl,
        behaviorHints: { notWebReady: true, bingeGroup: 'cinemacity-std' } as any,
      }],
    };
  }

  async handleTmdbRequest(
    tmdbId: string,
    season?: number | null,
    episode?: number | null,
    isMovie: boolean = true,
  ): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) return { streams: [] };
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
