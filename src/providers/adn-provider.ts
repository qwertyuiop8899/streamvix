// ADN Provider — AltadefinizioneStreaming CDN-only direct API.
// Mirrors the easystreams `altadefinizionestreaming.js` logic for the
// `provider === 'cdn'` source returned by /api/player-sources/{movie|tv}/...
// No proxy, no MFP — direct fetch to altadefinizionestreaming.com.

import type { StreamForStremio } from '../types/animeunity';
import { getTmdbIdFromImdbId } from '../extractor';

export interface AdnConfig {
    enabled: boolean;
    tmdbApiKey?: string;
}

const BASE_URL = 'https://altadefinizionestreaming.com';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

async function fetchJson(url: string): Promise<any | null> {
    try {
        const r = await fetch(url, {
            headers: {
                'User-Agent': USER_AGENT,
                'Referer': `${BASE_URL}/`,
                'Accept': 'application/json,text/plain,*/*'
            }
        });
        if (!r.ok) {
            console.log('[ADN] fetchJson non-ok', r.status, url);
            return null;
        }
        return await r.json();
    } catch (e: any) {
        console.log('[ADN] fetchJson error', e?.message || e);
        return null;
    }
}

export class AdnProvider {
    constructor(private config: AdnConfig) { }

    async handleImdbRequest(imdbId: string, season: number | null, episode: number | null, isMovie = false): Promise<{ streams: StreamForStremio[] }> {
        if (!this.config.enabled) return { streams: [] };
        const imdbOnly = imdbId.split(':')[0];
        if (!this.config.tmdbApiKey) {
            console.log('[ADN] no TMDB api key, cannot resolve', imdbOnly);
            return { streams: [] };
        }
        try {
            const tmdbId = await getTmdbIdFromImdbId(imdbOnly, this.config.tmdbApiKey, isMovie ? 'movie' : 'tv');
            if (!tmdbId) {
                console.log('[ADN] tmdb resolution failed for', imdbOnly);
                return { streams: [] };
            }
            return this.handleTmdbRequest(String(tmdbId), season, episode, isMovie);
        } catch (e: any) {
            console.log('[ADN] imdb->tmdb error', e?.message || e);
            return { streams: [] };
        }
    }

    async handleTmdbRequest(tmdbId: string, season: number | null, episode: number | null, isMovie = false): Promise<{ streams: StreamForStremio[] }> {
        if (!this.config.enabled) return { streams: [] };

        const s = season != null ? (parseInt(String(season), 10) || 1) : 1;
        const e = episode != null ? (parseInt(String(episode), 10) || 1) : 1;

        const endpoint = isMovie
            ? `${BASE_URL}/api/player-sources/movie/${encodeURIComponent(tmdbId)}`
            : `${BASE_URL}/api/player-sources/tv/${encodeURIComponent(tmdbId)}/${s}/${e}`;

        console.log('[ADN] GET', endpoint);
        const payload = await fetchJson(endpoint);
        const sources: any[] = Array.isArray(payload?.sources) ? payload.sources : [];
        if (!sources.length) {
            console.log('[ADN] no sources in payload');
            return { streams: [] };
        }

        const cdn = sources.find(x => String(x?.provider || '').toLowerCase() === 'cdn' && x?.url);
        if (!cdn?.url) {
            console.log('[ADN] no cdn source; providers=', sources.map(x => x?.provider).join(','));
            return { streams: [] };
        }

        // Resolve a friendly title via TMDB (Italian).
        let showTitle: string | undefined;
        if (this.config.tmdbApiKey) {
            try {
                const ep = isMovie ? 'movie' : 'tv';
                const meta = await fetchJson(`https://api.themoviedb.org/3/${ep}/${tmdbId}?api_key=${this.config.tmdbApiKey}&language=it-IT`);
                showTitle = meta?.title || meta?.name || meta?.original_title || meta?.original_name;
            } catch { /* ignore */ }
        }
        const base = showTitle || (isMovie ? 'Film' : 'Serie');
        const displayTitle = isMovie ? base : `${base} ${s}x${e}`;

        const playbackHeaders = {
            'User-Agent': USER_AGENT,
            'Referer': `${BASE_URL}/`
        };

        const stream: StreamForStremio = {
            url: String(cdn.url),
            title: `📁 ${displayTitle}\n💾 720p • ADN CDN`,
            behaviorHints: {
                notWebReady: true,
                proxyHeaders: { request: playbackHeaders }
            } as any
        };
        // Root headers for clients that read them (e.g., Nuvio)
        (stream as any).headers = playbackHeaders;

        console.log('[ADN] returning 1 CDN stream for', displayTitle);
        return { streams: [stream] };
    }
}
