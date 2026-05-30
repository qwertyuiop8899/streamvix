// ADN Provider — AltadefinizioneStreaming CDN-only direct API.
// Mirrors the easystreams `altadefinizionestreaming.js` logic for the
// `provider === 'cdn'` source returned by /api/player-sources/{movie|tv}/...
//
// IP binding note: the CDN URLs returned by /api/player-sources/... carry an
// `ipsig` parameter bound to the IP that made the API call. If the addon
// (server) and the playback device are on different IPs, the device gets
// HTTP 410 DENIED. Two mitigations are wired in:
//   1) If `mfpUrl` (EasyProxy/MediaFlowProxy) is configured, the CDN .mp4
//      URL is wrapped through `/proxy/stream/...` so playback egresses from
//      the same IP that performed the API call.
//   2) When the direct fetch to altadefinizionestreaming.com fails (network
//      error, non-OK status, or empty payload), the request is retried via
//      `process.env.PROXY_BACKUP` (standard HTTP(S) proxy URL) using
//      undici.ProxyAgent. This is useful when ADN blocks the addon's host.

import type { StreamForStremio } from '../types/animeunity';
import { getTmdbIdFromImdbId } from '../extractor';
import { formatMediaFlowUrl } from '../utils/mediaflow';

export interface AdnConfig {
    enabled: boolean;
    tmdbApiKey?: string;
    mfpUrl?: string;
    mfpPassword?: string;
}

const BASE_URL = 'https://altadefinizionestreaming.com';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

async function rawFetchJson(url: string, proxyUrl?: string): Promise<any | null> {
    const init: any = {
        headers: {
            'User-Agent': USER_AGENT,
            'Referer': `${BASE_URL}/`,
            'Accept': 'application/json,text/plain,*/*'
        }
    };
    if (proxyUrl) {
        try {
            const undici = await import('undici');
            init.dispatcher = new (undici as any).ProxyAgent(proxyUrl);
        } catch (e: any) {
            console.log('[ADN] undici ProxyAgent unavailable', e?.message || e);
            return null;
        }
    }
    try {
        const r = await fetch(url, init);
        if (!r.ok) {
            console.log('[ADN] fetch non-ok', r.status, proxyUrl ? '(via PROXY_BACKUP)' : '(direct)', url);
            return null;
        }
        return await r.json();
    } catch (e: any) {
        console.log('[ADN] fetch error', proxyUrl ? '(via PROXY_BACKUP)' : '(direct)', e?.message || e);
        return null;
    }
}

// Fetch with optional PROXY_BACKUP fallback. Only the cdn API host benefits
// from the fallback — TMDB calls go direct (Google's CDN is universally
// reachable and the proxy would just slow them down).
async function fetchJson(url: string, allowBackup = false): Promise<any | null> {
    const direct = await rawFetchJson(url);
    if (direct) return direct;
    if (!allowBackup) return null;
    const backup = String(process.env.PROXY_BACKUP || '').trim();
    if (!backup) return null;
    console.log('[ADN] retrying via PROXY_BACKUP');
    return rawFetchJson(url, backup);
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
        const payload = await fetchJson(endpoint, /* allowBackup */ true);
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

        // ipsig binding workaround: when MFP is configured, wrap the CDN .mp4
        // URL through /proxy/stream so playback egresses from the same IP
        // that requested the API. Otherwise we hand the direct URL to the
        // player (works only if the player's IP matches the addon's IP).
        const directUrl = String(cdn.url);
        const finalUrl = this.config.mfpUrl
            ? formatMediaFlowUrl(directUrl, this.config.mfpUrl, this.config.mfpPassword || '')
            : directUrl;
        const wrappedTag = this.config.mfpUrl ? ' • MFP' : '';

        const stream: StreamForStremio = {
            url: finalUrl,
            title: `📁 ${displayTitle}\n💾 720p • ADN CDN${wrappedTag}`,
            behaviorHints: {
                notWebReady: true,
                proxyHeaders: { request: playbackHeaders }
            } as any
        };
        // Root headers for clients that read them (e.g., Nuvio)
        (stream as any).headers = playbackHeaders;

        console.log('[ADN] returning 1 CDN stream for', displayTitle, this.config.mfpUrl ? '(wrapped via MFP)' : '(direct)');
        return { streams: [stream] };
    }
}
