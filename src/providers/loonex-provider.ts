import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { Stream } from 'stremio-addon-sdk';
import { getLoonexTitle } from '../config/loonexTitleMap';

/**
 * Loonex provider — catalog-based.
 *

interface LoonexEpisode {
    id: string;
    label?: string;
    season: number | null;
    episode: number | null;
    masterUrl: string;
    source?: string;
    headers?: Record<string, string> | null;
}

interface LoonexTmdb {
    id?: number | null;
    type?: string;
    title?: string;
    year?: number | null;
    imdbId?: string | null;
    tvdbId?: number | null;
}

interface LoonexItem {
    slug: string;
    title: string;
    year?: number | null;
    type?: string;
    tmdb?: LoonexTmdb;
    episodes: LoonexEpisode[];
}

interface LoonexCatalog {
    generatedAt?: string;
    count?: number;
    items: LoonexItem[];
}

// ---------------------------------------------------------------------------
// Catalog loading & indexing (lazy, in-memory, singleton with TTL)
// ---------------------------------------------------------------------------

interface LoonexCatalogIndex {
    byImdb: Map<string, LoonexItem>;
    byTmdb: Map<string, LoonexItem>;
    byNormalizedTitle: Map<string, LoonexItem>;
    items: LoonexItem[];
}

let catalogPromise: Promise<LoonexCatalogIndex> | null = null;
let catalogLoadedAt = 0;

function normalizeTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function resolveLocalCatalogPath(): string {
    const envPath = (process.env.LOONEX_CATALOG_PATH || '').trim();
    if (envPath) return envPath;
    const candidates = [
        path.join(__dirname, 'loonex-catalog.json.gz'),
        path.join(__dirname, '..', '..', 'src', 'providers', 'loonex-catalog.json.gz'),
        path.join(process.cwd(), 'src', 'providers', 'loonex-catalog.json.gz'),
        path.join(process.cwd(), 'dist', 'providers', 'loonex-catalog.json.gz'),
    ];
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
    return candidates[0];
}

/**
 * Scarica una URL seguendo i redirect (max 5 hop) restituendo un Buffer.
 */
function fetchUrlBuffer(urlStr: string, authHeader?: string, hops = 5): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const doRequest = (target: string, left: number) => {
            let u: URL;
            try { u = new URL(target); } catch (e) { return reject(e as Error); }
            const lib = u.protocol === 'http:' ? http : https;
            const headers: Record<string, string> = {
                'User-Agent': 'streamvix-loonex/1.0',
                'Accept': 'application/json, application/octet-stream, */*'
            };
            if (authHeader) headers['Authorization'] = authHeader;
            const req = lib.get({
                hostname: u.hostname,
                port: u.port || (u.protocol === 'http:' ? 80 : 443),
                path: u.pathname + (u.search || ''),
                headers,
                timeout: 20000,
            }, res => {
                const status = res.statusCode || 0;
                if (status >= 300 && status < 400 && res.headers.location && left > 0) {
                    res.resume();
                    const next = new URL(res.headers.location, target).toString();
                    return doRequest(next, left - 1);
                }
                if (status < 200 || status >= 300) {
                    res.resume();
                    return reject(new Error(`HTTP ${status} fetching ${target}`));
                }
                const chunks: Buffer[] = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error('timeout')));
            req.on('error', reject);
        };
        doRequest(urlStr, hops);
    });
}

/**
 * Carica i bytes grezzi del catalogo dalla sorgente attiva (URL o file).
 * Restituisce anche un flag `gzipped` deciso da estensione/magic-byte.
 */
async function readCatalogBytes(): Promise<{ buf: Buffer; gzipped: boolean; source: string }> {
    const url = (process.env.LOONEX_CATALOG_URL || '').trim();
    if (url) {
        const auth = (process.env.LOONEX_CATALOG_AUTH || '').trim() || undefined;
        console.log(`[Loonex] Fetching catalog from URL: ${url.replace(/(token=)[^&]+/i, '$1***')}`);
        const buf = await fetchUrlBuffer(url, auth);
        const gzipped = /\.gz(\?|$)/i.test(url) || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b);
        return { buf, gzipped, source: url };
    }
    const file = resolveLocalCatalogPath();
    console.log(`[Loonex] Loading catalog from file: ${file}`);
    const buf = await fs.promises.readFile(file);
    const gzipped = /\.gz$/i.test(file) || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b);
    return { buf, gzipped, source: file };
}

function ttlMs(): number {
    const raw = parseInt(process.env.LOONEX_CATALOG_TTL_MIN || '', 10);
    const min = Number.isFinite(raw) && raw > 0 ? raw : 360; // default 6h
    return min * 60 * 1000;
}

async function loadCatalog(force = false): Promise<LoonexCatalogIndex> {
    const expired = Date.now() - catalogLoadedAt > ttlMs();
    if (catalogPromise && !force && !expired) return catalogPromise;
    const p = (async () => {
        const { buf, gzipped, source } = await readCatalogBytes();
        const json = gzipped ? zlib.gunzipSync(buf).toString('utf-8') : buf.toString('utf-8');
        const data: LoonexCatalog = JSON.parse(json);
        const items = Array.isArray(data.items) ? data.items : [];

        const byImdb = new Map<string, LoonexItem>();
        const byTmdb = new Map<string, LoonexItem>();
        const byNormalizedTitle = new Map<string, LoonexItem>();

        for (const it of items) {
            const imdb = it.tmdb?.imdbId;
            if (imdb && !byImdb.has(imdb)) byImdb.set(imdb, it);
            const tmdbId = it.tmdb?.id;
            if (tmdbId != null) {
                const key = String(tmdbId);
                if (!byTmdb.has(key)) byTmdb.set(key, it);
            }
            const titleKey = normalizeTitle(it.title || '');
            if (titleKey && !byNormalizedTitle.has(titleKey)) byNormalizedTitle.set(titleKey, it);
            const tmdbTitleKey = normalizeTitle(it.tmdb?.title || '');
            if (tmdbTitleKey && !byNormalizedTitle.has(tmdbTitleKey)) byNormalizedTitle.set(tmdbTitleKey, it);
        }

        console.log(`[Loonex] Catalog indexed from ${source}: ${items.length} items (imdb=${byImdb.size}, tmdb=${byTmdb.size}, titles=${byNormalizedTitle.size})`);
        catalogLoadedAt = Date.now();
        return { byImdb, byTmdb, byNormalizedTitle, items };
    })().catch(err => {
        console.error('[Loonex] Failed to load catalog:', err);
        catalogPromise = null;
        catalogLoadedAt = 0;
        throw err;
    });
    catalogPromise = p;
    return p;
}

/** Forza il reload del catalogo (utile per endpoint admin). */
export async function reloadLoonexCatalog(): Promise<number> {
    const idx = await loadCatalog(true);
    return idx.items.length;
}

// ---------------------------------------------------------------------------
// Lookup helpers
// ---------------------------------------------------------------------------

function findItem(
    idx: LoonexCatalogIndex,
    imdbId?: string,
    tmdbId?: string,
    title?: string
): LoonexItem | null {
    if (imdbId) {
        const hit = idx.byImdb.get(imdbId);
        if (hit) return hit;
    }
    if (tmdbId) {
        const hit = idx.byTmdb.get(String(tmdbId));
        if (hit) return hit;
    }
    // Title mapping override (static map for edge cases)
    const mapped = getLoonexTitle(imdbId, tmdbId);
    const candidate = mapped || title;
    if (candidate) {
        const key = normalizeTitle(candidate);
        const direct = idx.byNormalizedTitle.get(key);
        if (direct) return direct;
        // Fuzzy: substring match across titles
        for (const it of idx.items) {
            const t1 = normalizeTitle(it.title || '');
            const t2 = normalizeTitle(it.tmdb?.title || '');
            if (!t1 && !t2) continue;
            if ((t1 && (t1.includes(key) || key.includes(t1))) ||
                (t2 && (t2.includes(key) || key.includes(t2)))) {
                return it;
            }
        }
    }
    return null;
}

function findEpisode(item: LoonexItem, season?: number, episode?: number): LoonexEpisode | null {
    const eps = item.episodes || [];
    if (eps.length === 0) return null;

    // Series request: cerca match esatto su season+episode
    if (season != null && episode != null) {
        const exact = eps.find(e => e.season === season && e.episode === episode);
        if (exact) return exact;
        // Fallback: stagione null (catalogo "stagione unica") e episode match
        const seasonless = eps.find(e => e.season == null && e.episode === episode);
        if (seasonless) return seasonless;
        // Fallback ulteriore: serie con un solo episodio
        if (eps.length === 1 && season === 1 && episode === 1) return eps[0];
        return null;
    }

    // Movie / single: prendi il primo episodio disponibile
    const movieEntry = eps.find(e => e.season == null && e.episode == null);
    return movieEntry || eps[0];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getLoonexStreams(
    type: string,
    imdbId: string,
    title?: string,
    season?: number,
    episode?: number,
    tmdbId?: string
): Promise<Stream[]> {
    console.log(`[Loonex] Request: type=${type} title="${title || 'N/A'}" imdb=${imdbId || 'N/A'} tmdb=${tmdbId || 'N/A'} S${season ?? '-'}E${episode ?? '-'}`);

    if (!imdbId && !tmdbId && !title) {
        console.log('[Loonex] No imdbId/tmdbId/title provided — abort');
        return [];
    }

    let idx: LoonexCatalogIndex;
    try {
        idx = await loadCatalog();
    } catch {
        return [];
    }

    const item = findItem(idx, imdbId || undefined, tmdbId, title);
    if (!item) {
        console.log(`[Loonex] No catalog entry for imdb=${imdbId} tmdb=${tmdbId} title="${title}"`);
        return [];
    }
    console.log(`[Loonex] Matched: "${item.title}" (slug=${item.slug}, episodes=${item.episodes.length})`);

    const ep = findEpisode(item, season, episode);
    if (!ep || !ep.masterUrl) {
        console.log(`[Loonex] Episode not found for S${season}E${episode}`);
        return [];
    }

    const seriesTitle = item.tmdb?.title || item.title;
    const seLabel = (season != null && episode != null) ? ` S${season}E${episode}` : '';
    const streamTitle = `${seriesTitle}${seLabel}`;
    const description = [
        `🎬 ${streamTitle}`,
        `🗣 [ITA]`,
        `📺 1080p`,
        ep.label ? `📝 ${ep.label}` : null,
    ].filter(Boolean).join('\n');

    // Headers (Referer / Origin) per il videoserver
    const reqHeaders: Record<string, string> = {
        'Referer': (ep.headers && ep.headers['Referer']) || 'https://loonex.eu/',
        'Origin': 'https://loonex.eu',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
    };
    if (ep.headers) {
        for (const [k, v] of Object.entries(ep.headers)) {
            if (v && !reqHeaders[k]) reqHeaders[k] = String(v);
        }
    }

    const stream: Stream = {
        name: 'Loonex',
        title: description,
        url: ep.masterUrl,
        behaviorHints: {
            notWebReady: true,
            bingeGroup: `loonex-${imdbId || tmdbId || item.slug}`,
            proxyHeaders: { request: reqHeaders }
        } as any
    };

    console.log(`[Loonex] Returning stream for ${item.slug} → ${ep.masterUrl.substring(0, 120)}...`);
    return [stream];
}

/**
 * Mantiene compatibilità con eventuali chiamate esterne. Le mappature statiche
 * di titoli vivono in src/config/loonexTitleMap.ts.
 */
export function addTitleNormalization(id: string, loonexTitle: string) {
    const mod = require('../config/loonexTitleMap');
    if (mod && mod.LOONEX_TITLE_MAP) {
        mod.LOONEX_TITLE_MAP[id] = loonexTitle;
        console.log(`[Loonex] Added static mapping: ${id} -> "${loonexTitle}"`);
    }
}
