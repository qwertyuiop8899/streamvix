// VidXgo provider — EasyProxy-only.
//
// URL pattern (movie):  {VD_DOMAIN}/{imdb_id}
// URL pattern (series): {VD_DOMAIN}/{imdb_id}/{season}/{episode}
//
// VidXgo signs each .ts segment URL with a ~5 min TTL (`e=` ms epoch).
// Direct playback (player ↔ CDN) therefore stops after ~5 min, and a
// classic MediaFlow Proxy wrap stops too because MFP does not rotate the
// signed token. Only EasyProxy (this repo's `EasyProxy-main/`) is able
// to refresh the token in background and rewrite segment URLs on the fly,
// so the provider produces a stream ONLY when an EP-style proxy is
// configured. Without one (or with `useMediaFlow=true`) we return zero
// streams.

import type { StreamForStremio } from '../types/animeunity';

export interface VidXgoConfig {
  enabled: boolean;
  /** EasyProxy base URL (e.g. https://ep.example.com or http://127.0.0.1:7860). */
  mfpUrl?: string;
  /** EasyProxy api_password. */
  mfpPassword?: string;
  tmdbApiKey?: string;
  /** When true the user picked MediaFlow Proxy (legacy/incompatible). */
  useMediaFlow?: boolean;
}

const VD_DOMAIN = (process.env.VIDXGO_DOMAIN || 'https://v.vidxgo.co').replace(/\/+$/, '');

function logV(...args: any[]) { try { console.log('[VidXgo]', ...args); } catch { /* */ } }

function buildUrl(imdbId: string, season?: number | null, episode?: number | null, isMovie: boolean = true): string {
  const id = (imdbId || '').split(':')[0];
  if (isMovie || !season || !episode) return `${VD_DOMAIN}/${id}`;
  return `${VD_DOMAIN}/${id}/${season}/${episode}`;
}

// EasyProxy wrapper: hand off the embed URL to EP's auto-detect extractor.
// EP will call its VidXgoExtractor (registered via the "vidxgo" hostname
// branch in services/hls_proxy.py), perform extraction, fetch the m3u8,
// cache the captured manifests, and run a background refresh loop that
// rotates the signed CDN token before its ~5 min TTL expires. EP's
// segment proxy handler also rewrites the per-segment `?t=&e=&b=` tokens
// at fetch time using the freshest captured manifest.
function wrapEp(embedUrl: string, epUrl: string, epPassword: string): string {
  const base = epUrl.replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (epPassword) params.set('api_password', epPassword);
  params.set('d', embedUrl);
  return `${base}/proxy/hls/manifest.m3u8?${params.toString()}`;
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

    // EasyProxy is mandatory for VidXgo.
    const proxyUrl = this.config.mfpUrl;
    if (!proxyUrl) { logV('no proxy configured -> skip (EP required)'); return { streams: [] }; }
    if (this.config.useMediaFlow === true) {
      logV('MediaFlow Proxy is not compatible with VidXgo token rotation -> skip');
      return { streams: [] };
    }

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
