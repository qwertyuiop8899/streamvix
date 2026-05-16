// VidXgo provider — port of MammaMia Src/API/vidxgoalta.py.
//
// URL pattern (movie):  {VD_DOMAIN}/{imdb_id}
// URL pattern (series): {VD_DOMAIN}/{imdb_id}/{season}/{episode}
//
// TMDB-only requests are mapped to IMDB via TMDB external_ids. If no
// TMDB API key is configured, TMDB requests are skipped (user choice).
//
// Output: a single Stremio stream per request. The visible title contains
// "VidXgo" so addon.ts hostMap can render the unified "▶️ VidXgo" line.

import type { StreamForStremio } from '../types/animeunity';
import { fetchAndExtractVidXgo } from '../extractors/vidxgo';

export interface VidXgoConfig {
  enabled: boolean;
  mfpUrl?: string;
  mfpPassword?: string;
  tmdbApiKey?: string;
}

const VD_DOMAIN = (process.env.VIDXGO_DOMAIN || 'https://v.vidxgo.co').replace(/\/+$/, '');

function logV(...args: any[]) { try { console.log('[VidXgo]', ...args); } catch { /* */ } }

function buildUrl(imdbId: string, season?: number | null, episode?: number | null, isMovie: boolean = true): string {
  const id = (imdbId || '').split(':')[0];
  if (isMovie || !season || !episode) return `${VD_DOMAIN}/${id}`;
  return `${VD_DOMAIN}/${id}/${season}/${episode}`;
}

function wrapMfp(m3u8: string, headers: Record<string, string>, mfpUrl: string, mfpPassword: string): string {
  const base = mfpUrl.replace(/\/+$/, '');
  const params = new URLSearchParams();
  params.set('api_password', mfpPassword);
  params.set('d', m3u8);
  // Pass essential playback headers to the proxy
  for (const k of ['Referer', 'Origin', 'User-Agent']) {
    if (headers[k]) params.set('h_' + k, headers[k]);
  }
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
    const url = buildUrl(imdbId, season, episode, isMovie);
    logV('GET', url);
    const r = await fetchAndExtractVidXgo(url, VD_DOMAIN);
    if (!r) { logV('no stream'); return { streams: [] }; }

    const useMfp = !!(this.config.mfpUrl && this.config.mfpPassword);
    const playUrl = useMfp
      ? wrapMfp(r.m3u8, r.playbackHeaders, this.config.mfpUrl!, this.config.mfpPassword!)
      : r.m3u8;

    // Build a minimal title; addon.ts unifyStreams will rebuild the final name.
    // We just need "VidXgo" to appear (lowercased) so hostMap matches.
    const titleLine = isMovie
      ? `Movie\n💾 VidXgo`
      : `S${season}E${episode}\n💾 VidXgo`;

    const stream: StreamForStremio = {
      title: titleLine,
      url: playUrl,
      behaviorHints: {
        notWebReady: true,
        bingeGroup: useMfp ? 'vidxgo-prx' : 'vidxgo',
        ...(useMfp ? {} : { proxyHeaders: { request: r.playbackHeaders } }),
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
