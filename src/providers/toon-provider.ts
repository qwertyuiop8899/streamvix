import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { Stream } from 'stremio-addon-sdk';
import { resolveShortener, triggerWarmupAsync } from '../utils/shortenerResolver';

/**
 * TOON provider — onlineserietv.lol
 *
 * Sito WordPress + plugin `searchwp_live_search`. Indicizza TUTTO il sito
 * (serie TV, film, anime, cartoni). Filtra per tipo richiesto.
 * Tutti gli stream sono `uprot.net/msf/<id>` (MaxStream). Stessa chain di
 * CB01/Eurostreaming/ToonItalia — riusa `resolveShortener` (warmup uprot
 * gia' attivo a livello addon).
 */

const BASE_URL = (process.env.TOON_BASE_URL || 'https://onlineserietv.lol').replace(/\/$/, '');
const SEARCH_AJAX = `${BASE_URL}/wp-admin/admin-ajax.php`;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface StreamRequest {
    id: string; // "tt12345:S:E" | "tt12345" | "tmdb:12345:S:E" | "tmdb:12345" | "kitsu:12345" | "kitsu:12345:E" | "kitsu:12345:S:E"
    type: 'movie' | 'series';
    config?: {
        mfpUrl?: string;
        mfpPsw?: string;
        tmdbApiKey?: string;
    };
}

interface EpisodeRow {
    season: number;
    episode: number;
    title: string;
    msfUrl: string;
}

// ------------------------------------------------------------------
// Caches (in-memory, TTL based)
// ------------------------------------------------------------------
const searchCache = new Map<string, { url: string | null; ts: number }>();
const pageCache = new Map<string, { html: string; ts: number }>();
const SEARCH_TTL = 6 * 60 * 60 * 1000; // 6h
const PAGE_TTL = 60 * 60 * 1000; // 1h

// ------------------------------------------------------------------
// Manual title overrides (src/config/toon_overrides.json)
// Schema: array di { title, imdb?, tmdb?, kitsu? } (almeno uno fra imdb/tmdb/kitsu).
// Quando una request arriva con un id che combacia su uno dei 3 campi,
// invece di interrogare TMDB/Kitsu si usa `title` come query di ricerca.
// Hot-reload via cache + check mtime: overhead ~1 stat() per request.
// ------------------------------------------------------------------
interface ToonOverride {
    title: string;
    imdb?: string;
    tmdb?: string;
    kitsu?: string;
}

// Candidate paths: src layout (dev/ts-node) e dist layout (prod compiled).
const OVERRIDES_CANDIDATES = [
    path.join(__dirname, '..', 'config', 'toon_overrides.json'),
    path.join(__dirname, '..', '..', 'src', 'config', 'toon_overrides.json'),
    path.join(process.cwd(), 'src', 'config', 'toon_overrides.json'),
];

let _overridesCache: ToonOverride[] = [];
let _overridesMtime = 0;
let _overridesPath: string | null = null;

function _resolveOverridesPath(): string | null {
    if (_overridesPath && fs.existsSync(_overridesPath)) return _overridesPath;
    for (const p of OVERRIDES_CANDIDATES) {
        if (fs.existsSync(p)) { _overridesPath = p; return p; }
    }
    return null;
}

function loadOverrides(): ToonOverride[] {
    const p = _resolveOverridesPath();
    if (!p) return [];
    try {
        const st = fs.statSync(p);
        if (st.mtimeMs === _overridesMtime) return _overridesCache;
        const raw = fs.readFileSync(p, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            _overridesCache = parsed.filter((e: any) => e && typeof e.title === 'string' && (e.imdb || e.tmdb || e.kitsu));
            _overridesMtime = st.mtimeMs;
            console.log(`[TOON][overrides] loaded ${_overridesCache.length} entries from ${p}`);
        }
    } catch (e) {
        console.warn('[TOON][overrides] parse error:', (e as Error).message);
    }
    return _overridesCache;
}

function findOverrideTitle(ids: { imdb?: string; tmdb?: string; kitsu?: string }): string | null {
    const list = loadOverrides();
    if (!list.length) return null;
    for (const e of list) {
        if (ids.imdb && e.imdb && String(e.imdb) === String(ids.imdb)) return e.title;
        if (ids.tmdb && e.tmdb && String(e.tmdb) === String(ids.tmdb)) return e.title;
        if (ids.kitsu && e.kitsu && String(e.kitsu) === String(ids.kitsu)) return e.title;
    }
    return null;
}

// ------------------------------------------------------------------
// TMDB title fetch (IT locale)
// ------------------------------------------------------------------
async function getTitleFromTMDb(opts: { imdbId?: string; tmdbId?: string; type: 'movie' | 'series'; apiKey?: string }): Promise<string | null> {
    const apiKey = opts.apiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0';
    const tmdbType = opts.type === 'movie' ? 'movie' : 'tv';
    try {
        let url: string;
        if (opts.tmdbId) {
            url = `https://api.themoviedb.org/3/${tmdbType}/${opts.tmdbId}?api_key=${apiKey}&language=it-IT`;
            const r = await axios.get(url, { timeout: 6000 });
            return (opts.type === 'movie' ? r.data.title : r.data.name) || r.data.original_title || r.data.original_name || null;
        }
        if (opts.imdbId) {
            url = `https://api.themoviedb.org/3/find/${opts.imdbId}?api_key=${apiKey}&external_source=imdb_id&language=it-IT`;
            const r = await axios.get(url, { timeout: 6000 });
            const results = opts.type === 'movie' ? (r.data.movie_results || []) : (r.data.tv_results || []);
            if (results.length === 0) return null;
            return (opts.type === 'movie' ? results[0].title : results[0].name) || results[0].original_title || results[0].original_name || null;
        }
    } catch (e) {
        console.warn('[TOON] TMDB error:', (e as Error).message);
    }
    return null;
}

// ------------------------------------------------------------------
// Kitsu title fetch (anime). Preferisce titolo IT, poi EN, poi canonical.
// ------------------------------------------------------------------
async function getTitleFromKitsu(kitsuId: string): Promise<string | null> {
    try {
        const r = await axios.get(`https://kitsu.io/api/edge/anime/${kitsuId}`, { timeout: 8000 });
        const attrs = r.data?.data?.attributes;
        if (!attrs) return null;
        return (attrs.titles && (attrs.titles.it || attrs.titles.en || attrs.titles.en_jp))
            || attrs.canonicalTitle
            || null;
    } catch (e) {
        console.warn('[TOON] Kitsu error:', (e as Error).message);
        return null;
    }
}

// ------------------------------------------------------------------
// Query normalization
// Sito non accetta -, _, :, ', ., (, ) ecc. nella ricerca.
// Manteniamo solo lettere/numeri/spazi (italiani inclusi).
// ------------------------------------------------------------------
function decodeEntities(s: string): string {
    return s
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&nbsp;/g, ' ');
}

function normalizeQuery(title: string): string {
    let t = title
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // strip diacritics
        .toLowerCase();
    // Sostituisci tutto cio' che NON e' a-z0-9 con spazi
    t = t.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    return t;
}

function similarity(a: string, b: string): number {
    // Jaccard sui token (case-insensitive, normalizzati).
    const setA = new Set(normalizeQuery(a).split(' ').filter(Boolean));
    const setB = new Set(normalizeQuery(b).split(' ').filter(Boolean));
    if (setA.size === 0 || setB.size === 0) return 0;
    let inter = 0;
    for (const t of setA) if (setB.has(t)) inter++;
    return inter / (setA.size + setB.size - inter);
}

// ------------------------------------------------------------------
// Search admin-ajax
// ------------------------------------------------------------------
async function searchSite(query: string, type: 'movie' | 'series'): Promise<string | null> {
    const cacheKey = `${type}::${query}`;
    const cached = searchCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < SEARCH_TTL) {
        console.log(`[TOON] search cache hit "${query}" -> ${cached.url}`);
        return cached.url;
    }
    const wantedPath = type === 'series' ? '/serietv/' : '/film/';
    // Strategia: tenta query completa, poi prime 4 parole se 0 risultati.
    const variants = [query];
    const tokens = query.split(' ').filter(Boolean);
    if (tokens.length > 4) variants.push(tokens.slice(0, 4).join(' '));
    if (tokens.length > 2) variants.push(tokens.slice(0, 2).join(' '));
    for (const variant of variants) {
        try {
            const q = encodeURIComponent(variant).replace(/%20/g, '%20'); // spazi gia' %20
            const url = `${SEARCH_AJAX}?s=${q}&action=searchwp_live_search&swpengine=default&swpquery=${q}&origin_id=0`;
            console.log(`[TOON] search: "${variant}" (${type})`);
            const resp = await axios.get(url, {
                headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
                timeout: 10000,
                validateStatus: () => true,
            });
            if (resp.status !== 200 || typeof resp.data !== 'string') continue;
            const html = resp.data as string;
            // Estrai tutti gli anchor risultato.
            const anchors: { url: string; title: string }[] = [];
            const reAnchor = /<a\s+href=["']([^"']+)["'][^>]*>\s*([^<]+?)\s*<\/a>/gi;
            let m: RegExpExecArray | null;
            while ((m = reAnchor.exec(html)) !== null) {
                const href = m[1];
                const txt = decodeEntities(m[2]).trim();
                if (!href.startsWith(BASE_URL) || !txt) continue;
                if (!href.includes(wantedPath)) continue;
                anchors.push({ url: href, title: txt });
            }
            if (anchors.length === 0) {
                console.log(`[TOON] no ${wantedPath} matches for "${variant}"`);
                continue;
            }
            // Score per similarita' titolo.
            let best = anchors[0];
            let bestScore = similarity(variant, anchors[0].title);
            for (let i = 1; i < anchors.length; i++) {
                const s = similarity(variant, anchors[i].title);
                if (s > bestScore) { bestScore = s; best = anchors[i]; }
            }
            console.log(`[TOON] match "${best.title}" (score=${bestScore.toFixed(2)}) -> ${best.url}`);
            searchCache.set(cacheKey, { url: best.url, ts: Date.now() });
            return best.url;
        } catch (e) {
            console.warn(`[TOON] search error variant="${variant}":`, (e as Error).message);
        }
    }
    searchCache.set(cacheKey, { url: null, ts: Date.now() });
    return null;
}

// ------------------------------------------------------------------
// Page fetch (cached)
// ------------------------------------------------------------------
async function fetchPage(url: string): Promise<string | null> {
    const cached = pageCache.get(url);
    if (cached && (Date.now() - cached.ts) < PAGE_TTL) return cached.html;
    try {
        const resp = await axios.get(url, {
            headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' },
            timeout: 15000,
            validateStatus: () => true,
        });
        if (resp.status !== 200 || typeof resp.data !== 'string') return null;
        pageCache.set(url, { html: resp.data, ts: Date.now() });
        return resp.data;
    } catch (e) {
        console.warn('[TOON] page fetch error:', (e as Error).message);
        return null;
    }
}

// ------------------------------------------------------------------
// Episode parser (series page)
// Accetta attribute quotes ' o ".
// Struttura: <tr><td colspan='4'><b>Stagione N - Episodi disponibili X</b></td></tr>
//           <tr><td>Title NNxEE Episode m4v</td><td><a href='https://uprot.net/msf/<id>'>...
// ------------------------------------------------------------------
function parseEpisodes(html: string): EpisodeRow[] {
    const out: EpisodeRow[] = [];
    // Regex unica: cattura NxE direttamente dal title (zero-padded o no).
    const re = /<td[^>]*>([^<]*?(\d{1,2})x(\d{1,3})[^<]*)<\/td>\s*<td[^>]*>\s*<a[^>]+href=['"](https?:\/\/uprot\.net\/msf\/[a-z0-9]+)['"]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
        const title = decodeEntities(m[1]).trim();
        const season = parseInt(m[2], 10);
        const episode = parseInt(m[3], 10);
        const msfUrl = m[4];
        if (!Number.isFinite(season) || !Number.isFinite(episode)) continue;
        out.push({ season, episode, title, msfUrl });
    }
    return out;
}

// Parser per pagina film: primo link msf (con eventuale Stagione/Episodio non
// presente per i movie singoli).
function parseMovieMsf(html: string): string | null {
    const m = html.match(/href=['"](https?:\/\/uprot\.net\/msf\/[a-z0-9]+)['"]/i);
    return m ? m[1] : null;
}

// ------------------------------------------------------------------
// Resolve + build Stream
// ------------------------------------------------------------------
async function resolveMsfToStream(msfUrl: string, label: string): Promise<Stream | null> {
    try {
        const resolved = await resolveShortener(msfUrl);
        if (!resolved.ok) {
            if (resolved.error === 'captcha_required') {
                console.log('[TOON] maxstream captcha_required -> skip (warmup periodico gestira\' lo state)');
            } else {
                console.log('[TOON] maxstream resolve fail:', (resolved as any).error);
            }
            return null;
        }
        if (resolved.kind !== 'maxstream') {
            console.log('[TOON] unexpected resolver kind:', resolved.kind);
            return null;
        }
        // m3u8 maxstream e' servito direttamente al client (stessa strategia
        // di Eurostreaming): non IP-locked, no referer-check sui segmenti.
        return {
            name: 'TOON',
            title: `${label}\n💾 Maxstream • [ITA]`,
            url: resolved.m3u8,
            behaviorHints: { notWebReady: true, bingeGroup: 'toon-std' } as any,
        };
    } catch (e) {
        console.log('[TOON] resolver error:', (e as Error).message);
        return null;
    }
}

// ------------------------------------------------------------------
// Main entry
// ------------------------------------------------------------------
export async function toon(req: StreamRequest): Promise<Stream[]> {
    console.log('[TOON] Request:', { id: req.id, type: req.type });
    const streams: Stream[] = [];
    try {
        const parts = req.id.split(':');
        let imdbId: string | undefined;
        let tmdbId: string | undefined;
        let kitsuId: string | undefined;
        let season: number | null = null;
        let episode: number | null = null;

        if (parts[0].startsWith('tt')) {
            imdbId = parts[0];
            if (parts.length === 3) {
                season = parseInt(parts[1], 10);
                episode = parseInt(parts[2], 10);
            }
        } else if (parts[0] === 'tmdb' || parts[0].startsWith('tmdb')) {
            // formati: "tmdb:12345:S:E" oppure "tmdb12345:S:E"
            if (parts[0] === 'tmdb') {
                tmdbId = parts[1];
                if (parts.length >= 4) {
                    season = parseInt(parts[2], 10);
                    episode = parseInt(parts[3], 10);
                }
            } else {
                tmdbId = parts[0].replace(/^tmdb/, '');
                if (parts.length === 3) {
                    season = parseInt(parts[1], 10);
                    episode = parseInt(parts[2], 10);
                }
            }
        } else if (parts[0] === 'kitsu') {
            // formati: "kitsu:ID" (movie), "kitsu:ID:E" (series s1), "kitsu:ID:S:E"
            kitsuId = parts[1];
            if (parts.length === 3) {
                season = 1;
                episode = parseInt(parts[2], 10);
            } else if (parts.length === 4) {
                season = parseInt(parts[2], 10);
                episode = parseInt(parts[3], 10);
            }
        } else {
            console.log('[TOON] unsupported id format:', req.id);
            return streams;
        }

        // Per series: serve season+episode validi.
        if (req.type === 'series' && (!Number.isFinite(season as number) || !Number.isFinite(episode as number))) {
            console.log('[TOON] series request missing S/E');
            return streams;
        }

        const title = (() => {
            const ov = findOverrideTitle({ imdb: imdbId, tmdb: tmdbId, kitsu: kitsuId });
            if (ov) {
                console.log(`[TOON][overrides] match: id=${req.id} -> "${ov}"`);
                return Promise.resolve(ov as string | null);
            }
            return kitsuId
                ? getTitleFromKitsu(kitsuId)
                : getTitleFromTMDb({ imdbId, tmdbId, type: req.type, apiKey: req.config?.tmdbApiKey });
        })();
        const resolvedTitle = await title;
        if (!resolvedTitle) {
            console.log('[TOON] could not fetch title from', kitsuId ? 'Kitsu' : 'TMDB');
            return streams;
        }
        console.log(`[TOON] title: "${resolvedTitle}"`);

        const query = normalizeQuery(resolvedTitle);
        if (!query) return streams;

        const pageUrl = await searchSite(query, req.type);
        if (!pageUrl) return streams;

        const html = await fetchPage(pageUrl);
        if (!html) return streams;

        if (req.type === 'movie') {
            const msf = parseMovieMsf(html);
            if (!msf) {
                console.log('[TOON] no msf link on movie page');
                return streams;
            }
            const stream = await resolveMsfToStream(msf, `🎬 ${title} • Ita`);
            if (stream) streams.push(stream);
            return streams;
        }

        // series: parse + match
        const all = parseEpisodes(html);
        console.log(`[TOON] parsed ${all.length} episode rows`);
        if (all.length === 0) return streams;

        const target = all.find(e => e.season === season && e.episode === episode);
        if (!target) {
            console.log(`[TOON] S${season}E${episode} not found in ${all.length} episodes (seasons available: ${[...new Set(all.map(e => e.season))].join(',')})`);
            return streams;
        }
        const label = `▶ S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')} • Ita`;
        const stream = await resolveMsfToStream(target.msfUrl, label);
        if (stream) streams.push(stream);
    } catch (e) {
        console.error('[TOON] provider error:', (e as Error).message);
    }
    return streams;
}
