// FIX: GuardaHD Provider modified to cache ONLY embed URLs (not proxied streams).
// Logic:
// 1. Check cache for 'embedUrls' + title.
// 2. If hit -> Loop embeds -> call extractFromUrl (which applies CURRENT proxy config) -> Return streams.
// 3. If miss -> Scrape MostraGuarda -> Get embed URLs -> Cache them -> Resolve & Return.
// This ensures that different users (or updated proxy configs) get correct proxy links without stale cache.

import type { StreamForStremio } from '../types/animeunity';
import { extractFromUrl } from '../extractors';
// eslint-disable-next-line @typescript-eslint/no-var-requires
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function require(name: string): any;
const cheerio = require('cheerio');
import { fetchPage, fetchPageWithProxies } from './flaresolverr';
import { getTmdbIdFromImdbId } from '../extractor';
import * as fs from 'fs';
import * as path from 'path';

export interface GuardaHdConfig { enabled: boolean; mfpUrl?: string; mfpPassword?: string; tmdbApiKey?: string }

// Cache structure: Store only the embed URL and the resolved title
interface EmbedCacheEntry {
    timestamp: number;
    embedUrls: string[];
    title: string;
}
interface EmbedCache { [imdbId: string]: EmbedCacheEntry }

const CACHE_FILE = path.join(process.cwd(), 'config', 'guardahd_embeds.json');

function readEmbedCache(): EmbedCache {
    try {
        const dir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(CACHE_FILE)) fs.writeFileSync(CACHE_FILE, '{}');
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch { return {}; }
}

function writeEmbedCache(cache: EmbedCache) {
    try {
        const dir = path.dirname(CACHE_FILE);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch { /* ignore */ }
}

function purgeOldEmbeds(cache: EmbedCache, ttl: number) {
    const t = Date.now();
    let changed = false;
    for (const k of Object.keys(cache)) {
        if (t - cache[k].timestamp > ttl) {
            delete cache[k];
            changed = true;
        }
    }
    if (changed) writeEmbedCache(cache);
}

export class GuardaHdProvider {
    private readonly base = 'https://mostraguarda.stream';
    private readonly CACHE_TTL = 12 * 60 * 60 * 1000; // 12h

    constructor(private config: GuardaHdConfig) { }

    async handleImdbRequest(imdbId: string, _season: number | null, _episode: number | null, isMovie = false) {
        if (!this.config.enabled) return { streams: [] };
        if (!isMovie) return { streams: [] }; // MostraGuarda logic only for movies
        const imdbOnly = imdbId.split(':')[0];
        console.log('[GH][FLOW] handleImdbRequest imdb=', imdbOnly);

        // 1. Load Embed Cache
        const cache = readEmbedCache();
        purgeOldEmbeds(cache, this.CACHE_TTL);
        const ce = cache[imdbOnly];

        let embedUrls: string[];
        let realTitle: string;

        // 2. Check Cache Hit
        if (ce && Date.now() - ce.timestamp < this.CACHE_TTL) {
            console.log('[GH][CACHE] Using cached embeds for', imdbOnly, 'count=', ce.embedUrls.length);
            embedUrls = ce.embedUrls;
            realTitle = ce.title;
        } else {
            // 3. Cache Miss: Scraping
            // Fetch page
            let html: string;
            try {
                html = await fetchPage(`${this.base}/movie/${encodeURIComponent(imdbOnly)}`);
                console.log('[GH][NET] fetched movie page len=', html.length);
            } catch (e: any) {
                const msg = (e?.message || '').toString();
                console.log('[GH][ERR] fetch movie page failed', msg);
                if (/^(cloudflare_challenge|http_403|blocked)/.test(msg)) {
                    try {
                        console.log('[GH][PROXY] proxy attempts (max 2)');
                        html = await fetchPageWithProxies(`${this.base}/movie/${encodeURIComponent(imdbOnly)}`);
                        console.log('[GH][PROXY][OK] len=', html.length);
                    } catch (e2: any) {
                        console.log('[GH][PROXY][FAIL]', e2?.message || e2);
                        return { streams: [] };
                    }
                } else {
                    return { streams: [] };
                }
            }

            // Extract title
            realTitle = imdbOnly;
            try {
                const $t = cheerio.load(html);
                const cand = ($t('h1').first().text().trim() || $t('title').first().text().trim() || '').replace(/Streaming.*$/i, '').trim();
                if (cand) realTitle = cand;
            } catch { /* ignore */ }

            // Refine title with TMDB (Italian) if needed
            if (this.config.tmdbApiKey && (/^tt\d{7,8}$/i.test(realTitle) || /^movie\s+tt\d+/i.test(realTitle) || realTitle.toLowerCase() === 'movie')) {
                try {
                    const tmdbId = await getTmdbIdFromImdbId(imdbOnly, this.config.tmdbApiKey, 'movie');
                    if (tmdbId) {
                        const resp = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${this.config.tmdbApiKey}&language=it`);
                        if (resp.ok) {
                            const data = await resp.json();
                            if (data && (data.title || data.original_title)) realTitle = (data.title || data.original_title).trim();
                        }
                    }
                } catch { /* ignore tmdb fallback */ }
            }

            // Extract Embed URLs
            embedUrls = this.extractEmbedUrls(html);
            console.log('[GH][EMBED] extracted count=', embedUrls.length);

            // SAVE to cache
            cache[imdbOnly] = { timestamp: Date.now(), embedUrls, title: realTitle };
            writeEmbedCache(cache);
        }

        // 4. Resolve Embeds to usage Streams (Applying CURRENT Proxy)
        const streams = await this.resolveEmbedStreams(embedUrls, realTitle);
        console.log('[GH][STREAMS] final streams count=', streams.length);

        return { streams };
    }

    async handleTmdbRequest(tmdbId: string, season: number | null, episode: number | null, isMovie = false): Promise<{ streams: StreamForStremio[] }> {
        // Supporto nativo TMDB: converti in IMDB e delega a handleImdbRequest
        if (!this.config.enabled || !isMovie) return { streams: [] };

        let imdbId: string | null = null;
        // Se abbiamo una chiave API, usiamo l'endpoint /external_ids o /movie/{id} per trovare l'IMDB ID
        if (this.config.tmdbApiKey) {
            try {
                const resp = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${this.config.tmdbApiKey}`);
                if (resp.ok) {
                    const data = await resp.json();
                    if (data.imdb_id) imdbId = data.imdb_id;
                }
            } catch (e) {
                console.log('[GH][TMDB] resolution failed for', tmdbId, e);
            }
        }

        if (imdbId) {
            console.log('[GH][TMDB] resolved', tmdbId, '->', imdbId);
            return this.handleImdbRequest(imdbId, season, episode, isMovie);
        }

        console.log('[GH][TMDB] could not resolve IMDB ID for', tmdbId);
        return { streams: [] };
    }

    private extractEmbedUrls(html: string): string[] {
        const $ = cheerio.load(html);
        const urls = $('[data-link!=""]').map((_: number, el: any) => {
            const raw = ($(el).attr('data-link') || '').trim();
            if (!raw) return null;
            let u = raw.replace(/^(https:)?\/\//, 'https://');
            if (!/^https?:/i.test(u)) return null;
            return u;
        }).toArray().filter(Boolean) as string[];

        // Filter self/broken
        const external = urls.filter(u => !/mostraguarda/gi.test(new URL(u).host));
        const noStreamtape = external.filter(u => !/streamtape\.com/i.test(u));
        // Dedup
        return Array.from(new Set(noStreamtape)).slice(0, 40);
    }

    private async resolveEmbedStreams(embedUrls: string[], titleHint: string): Promise<StreamForStremio[]> {
        const out: StreamForStremio[] = [];
        const seen = new Set<string>();

        // This resolves the embed URL using extractors (e.g. Mixdrop)
        // AND applies the mfpUrl/mfpPassword passed in 'this.config'.
        // This ensures the Proxy is applied *now*, not read from cache.
        for (const eurl of embedUrls) {
            try {
                // Determine if we should attempt resolution
                // Note: extractFromUrl will invoke the extractor which fetches metadata and builds the proxy link
                const { streams } = await extractFromUrl(eurl, {
                    mfpUrl: this.config.mfpUrl,
                    mfpPassword: this.config.mfpPassword,
                    countryCode: 'IT',
                    titleHint
                });

                for (const s of streams) {
                    if (seen.has(s.url)) continue;
                    seen.add(s.url);
                    // Append title normalization
                    const normalizedStream = {
                        ...s,
                        title: this.normalizeTitle(s.title || titleHint)
                    } as StreamForStremio;
                    out.push(normalizedStream);
                }
            } catch { /* ignore single embed */ }
        }
        return out;
    }

    private normalizeTitle(raw: string): string {
        if (!raw) return raw;
        const parts = raw.split('\n');
        if (parts.length > 1) {
            let second = parts[1];
            const hasFloppy = /^💾\s*/.test(second);
            if (hasFloppy) {
                const after = second.replace(/^💾\s*/, '');
                if (/\bstreamtape\b/i.test(after) && !/(\d+p|MB|GB|KB)/i.test(after)) second = after;
            }
            second = second
                .replace(/\bsupervideo\b/gi, 'SuperVideo')
                .replace(/\bmixdrop\b/gi, 'Mixdrop')
                .replace(/\bdoodstream\b/gi, 'Doodstream')
                .replace(/\bstreamtape\b/gi, 'Streamtape');
            parts[1] = second;
        }
        return parts.join('\n');
    }
}
