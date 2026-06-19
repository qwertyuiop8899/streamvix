// ADN Provider — AltadefinizioneStreaming CDN-only direct API.
//
// ipsig binding: the CDN URLs returned by /api/player-sources/... embed an
// HMAC of the caller's IP. Cross-IP playback → CDN replies 410 DENIED. The
// only correct fix is to make the API call from the same IP that serves the
// playback bytes — i.e. delegate the whole resolve to EasyProxy through its
// `/extractor/video.mp4?host=adn&d=<api url>&redirect_stream=true` endpoint. 
//
// Modes:
//   A) EasyProxy mode (`mfpUrl` set) — preferred. Requires an `adn`
//      extractor in EasyProxy.
//   B) Direct mode — addon resolves itself; the raw CDN URL is returned to
//      the player. Works only when addon and player egress from the same IP
//      (rare). PROXY_BACKUP only helps if ADN blocks the addon's host for
//      the API call — it does NOT solve ipsig mismatch.

import type { StreamForStremio } from '../types/animeunity';
import { getTmdbIdFromImdbId } from '../extractor';
import { extractFromUrl } from '../extractors';

export interface AdnConfig {
    enabled: boolean;
    tmdbApiKey?: string;
    mfpUrl?: string;
    mfpPassword?: string;
    cookie?: string;
}

const BASE_URL = 'https://altadefinizionestreaming.com';
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

function getCookie(config?: AdnConfig): string {
    try {
        return (
            config?.cookie ||
            (globalThis as any)?.SCRAPER_SETTINGS?.altadefinizioneCookie ||
            process.env.ADN_COOKIES ||
            process.env.ALTADEFINIZIONE_COOKIE ||
            ''
        ).trim();
    } catch (e) {
        return '';
    }
}

function absoluteUrl(url: string): string | null {
    if (!url) return null;
    try {
        return new URL(url, BASE_URL).toString();
    } catch {
        return null;
    }
}

async function resolveDownloadToMixDrop(url: string, cookie?: string): Promise<string | null> {
    const downloadUrl = absoluteUrl(url);
    if (!downloadUrl) return null;
    const withGo = `${downloadUrl}${downloadUrl.includes('?') ? '&' : '?'}go=1`;

    try {
        const headers: any = {
            'User-Agent': USER_AGENT,
            'Referer': `${BASE_URL}/`
        };
        if (cookie && withGo.startsWith(BASE_URL)) headers.Cookie = cookie;
        const response = await fetch(withGo, { headers });
        const finalUrl = String(response.url || '').replace(/\?download$/i, '');
        if (/mixdrop|m1xdrop|mxdrop/i.test(finalUrl)) return finalUrl;
    } catch {
        return null;
    }
    return null;
}

async function rawFetchJson(url: string, cookie?: string, proxyUrl?: string): Promise<any | null> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 6000); // 6s timeout

    const init: any = {
        headers: {
            'User-Agent': USER_AGENT,
            'Referer': `${BASE_URL}/`,
            'Accept': 'application/json,text/plain,*/*'
        },
        signal: controller.signal
    };
    if (cookie && url.startsWith(BASE_URL)) {
        init.headers.Cookie = cookie;
    }
    if (proxyUrl) {
        try {
            const undici = await import('undici');
            init.dispatcher = new (undici as any).ProxyAgent(proxyUrl);
        } catch (e: any) {
            console.log('[ADN] undici ProxyAgent unavailable', e?.message || e);
            clearTimeout(timeoutId);
            return null;
        }
    }
    try {
        const r = await fetch(url, init);
        clearTimeout(timeoutId);
        if (!r.ok) {
            console.log('[ADN] fetch non-ok', r.status, proxyUrl ? '(via PROXY)' : '(direct)', url);
            return null;
        }
        return await r.json();
    } catch (e: any) {
        clearTimeout(timeoutId);
        console.log('[ADN] fetch error', proxyUrl ? '(via PROXY)' : '(direct)', e?.message || e);
        return null;
    }
}

// Fetch with optional PROXY_BACKUP / PROXY fallback. Only the cdn API host benefits
// from the fallback — TMDB calls go direct (Google's CDN is universally
// reachable and the proxy would just slow them down).
async function fetchJson(url: string, cookie?: string, allowBackup = false): Promise<any | null> {
    const direct = await rawFetchJson(url, cookie);
    if (direct) return direct;
    if (!allowBackup) return null;
    const backup = String(process.env.PROXY_BACKUP || process.env.PROXY || '').trim();
    if (!backup) return null;
    console.log('[ADN] retrying via PROXY:', backup);
    return rawFetchJson(url, cookie, backup);
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

        // Resolve a friendly title via TMDB (Italian). Cheap and always
        // reachable — we do it in both modes.
        let showTitle: string | undefined;
        if (this.config.tmdbApiKey) {
            try {
                const ep = isMovie ? 'movie' : 'tv';
                const meta = await fetchJson(`https://api.themoviedb.org/3/${ep}/${tmdbId}?api_key=${this.config.tmdbApiKey}&language=it-IT`, undefined, false);
                showTitle = meta?.title || meta?.name || meta?.original_title || meta?.original_name;
            } catch { /* ignore */ }
        }
        const base = showTitle || (isMovie ? 'Film' : 'Serie');
        const displayTitle = isMovie ? base : `${base} ${s}x${e}`;

        const streams: StreamForStremio[] = [];

        // 1. Direct CDN resolution
        console.log('[ADN] GET', endpoint);
        const cookie = getCookie(this.config);
        const payload = await fetchJson(endpoint, cookie, /* allowBackup */ true);
        const sources: any[] = Array.isArray(payload?.sources) ? payload.sources : [];

        const isAllowed = (src: any) => src?.url && !/vixsrc\.to/i.test(String(src.url));
        const cdn = sources.find(x => String(x?.provider || '').toLowerCase() === 'cdn' && isAllowed(x))
            || sources.find(x => isAllowed(x));

        if (cdn?.url) {
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
            (stream as any).headers = playbackHeaders;
            streams.push(stream);
        }

        // 2. MixDrop backup resolution (only when mfpUrl is configured)
        if (this.config.mfpUrl) {
            try {
                let downloadEntry: string | null = null;
                if (isMovie) {
                    const downloadPayload = await fetchJson(`${BASE_URL}/api/download/${tmdbId}`, cookie, true);
                    if (downloadPayload?.available && downloadPayload?.url) {
                        downloadEntry = downloadPayload.url;
                    }
                } else {
                    const downloadPayload = await fetchJson(`${BASE_URL}/api/download-episodes/${tmdbId}`, cookie, true);
                    const episodes = Array.isArray(downloadPayload?.episodes) ? downloadPayload.episodes : [];
                    const match = episodes.find((item: any) => Number(item?.season) === Number(s) && Number(item?.episode) === Number(e));
                    if (downloadPayload?.available && match?.url) {
                        downloadEntry = match.url;
                    }
                }

                if (downloadEntry) {
                    const mixdropUrl = await resolveDownloadToMixDrop(downloadEntry, cookie);
                    if (mixdropUrl) {
                        const extracted = await extractFromUrl(mixdropUrl, {
                            mfpUrl: this.config.mfpUrl,
                            mfpPassword: this.config.mfpPassword,
                            referer: `${BASE_URL}/`,
                            titleHint: displayTitle
                        });
                        if (extracted?.streams?.length) {
                            for (const str of extracted.streams) {
                                streams.push({
                                    url: str.url,
                                    title: str.title.replace('Mixdrop', 'ADN MixDrop'),
                                    behaviorHints: str.behaviorHints
                                });
                            }
                        }
                    }
                }
            } catch (e: any) {
                console.log('[ADN] MixDrop extraction error', e?.message || e);
            }
        }

        console.log('[ADN] returning', streams.length, 'streams for', displayTitle);
        return { streams };
    }
}
