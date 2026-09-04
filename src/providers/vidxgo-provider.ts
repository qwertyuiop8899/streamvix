// VidXgo provider — EasyProxy / MediaFlow Proxy extractor integration.
//
// URL pattern (movie):  {VD_DOMAIN}/{imdb_id}
// URL pattern (series): {VD_DOMAIN}/{imdb_id}/{season}/{episode}
//
// VidXgo signs each .ts segment URL with a short TTL (~5 min).
// When an EP/MFP proxy is configured, the provider hands off the embed URL
// to the proxy's extractor endpoint:
//   /extractor/video.m3u8?host=vidxgo&d=<url>&redirect_stream=true(&api_password=...)
// The proxy performs extraction, handles Cloudflare / anti-bot bypass,
// and manages token rotation and stream delivery.

import type { StreamForStremio } from '../types/animeunity';

export interface VidXgoConfig {
  enabled: boolean;
  /** EasyProxy / MediaFlow Proxy base URL (e.g. https://ep.example.com or http://127.0.0.1:7860). */
  mfpUrl?: string;
  /** Proxy api_password. */
  mfpPassword?: string;
  tmdbApiKey?: string;
  /** When true the user picked MediaFlow Proxy backend. */
  useMediaFlow?: boolean;
}

const VD_DOMAIN = (process.env.VIDXGO_DOMAIN || 'https://v.vidxgo.co').replace(/\/+$/, '');

function logV(...args: any[]) { try { console.log('[VidXgo]', ...args); } catch { /* */ } }

function buildUrl(imdbId: string, season?: number | null, episode?: number | null, isMovie: boolean = true): string {
  const id = (imdbId || '').split(':')[0];
  if (isMovie || !season || !episode) return `${VD_DOMAIN}/${id}`;
  return `${VD_DOMAIN}/${id}/${season}/${episode}`;
}

// Wrapper for MediaFlow Proxy / EasyProxy extractor endpoint:
// ${base}/extractor/video.m3u8?host=vidxgo&d=${embedUrl}&redirect_stream=true(&api_password=...)
function wrapEp(embedUrl: string, epUrl: string, epPassword?: string): string {
  const base = epUrl.replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('host', 'vidxgo');
  params.set('d', embedUrl);
  params.set('redirect_stream', 'true');
  if (epPassword) params.set('api_password', epPassword);
  return `${base}/extractor/video.m3u8?${params.toString()}`;
}

export class VidXgoProvider {
  constructor(private config: VidXgoConfig) {}

  async handleImdbRequest(
    imdbId: string,
    season?: number | null,
    episode?: number | null,
    isMovie: boolean = true,
  ): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) return { streams: [] };
    if (!imdbId) return { streams: [] };

    // Proxy is mandatory for VidXgo (EasyProxy or MediaFlow Proxy with extractor endpoint).
    const proxyUrl = this.config.mfpUrl;
    if (!proxyUrl) { logV('no proxy configured -> skip (proxy required)'); return { streams: [] }; }

    const url = buildUrl(imdbId, season, episode, isMovie);
    logV('EP path ->', url);
    const playUrl = wrapEp(url, proxyUrl, this.config.mfpPassword || '');
    const titleLine = isMovie
      ? `Movie\n💾 VidXgo`
      : `S${season}E${episode}\n💾 VidXgo`;
    const stream: StreamForStremio = {
      title: titleLine,
      url: playUrl,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: 'vidxgo-prx',
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
    const key = this.config.tmdbApiKey;
    if (!key) { logV('TMDB request but no tmdbApiKey -> skip'); return { streams: [] }; }
    const cleanId = (tmdbId || '').replace(/^tmdb:/, '').split(':')[0];
    if (!cleanId) return { streams: [] };
    try {
      const kind = isMovie ? 'movie' : 'tv';
      // For movies the main resource has imdb_id; for tv we need external_ids
      const endpoint = isMovie
        ? `https://api.themoviedb.org/3/movie/${cleanId}?api_key=${encodeURIComponent(key)}`
        : `https://api.themoviedb.org/3/tv/${cleanId}/external_ids?api_key=${encodeURIComponent(key)}`;
      const resp = await fetch(endpoint);
      if (!resp.ok) { logV('TMDB lookup failed', resp.status, kind, cleanId); return { streams: [] }; }
      const j: any = await resp.json();
      const imdb = j?.imdb_id;
      if (!imdb || typeof imdb !== 'string' || !imdb.startsWith('tt')) {
        logV('TMDB→IMDB missing/invalid for', kind, cleanId);
        return { streams: [] };
      }
      return this.handleImdbRequest(imdb, season, episode, isMovie);
    } catch (e: any) {
      logV('TMDB error', e?.message || e);
      return { streams: [] };
    }
  }
}
