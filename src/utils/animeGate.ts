// Helper to decide if an external ID refers to an Anime title.
// Strategy:
// 1) Prefer Haglund mappings for MAL or Kitsu: if present -> isAnime=true.
// 2) Soft fallback (configurable via env ANIME_GATE_TMDB_FALLBACK, default true):
//    call TMDB and consider anime if genres include Animation (id 16) and country is JP
//    (via production_countries/origin_country/original_language).
// Feature flag: ANIME_GATE_ENABLED (default true). Callers can still import and decide.

export type ExternalIdType = 'imdb' | 'tmdb';
import type { StreamForStremio } from '../types/animeunity';

export interface AnimeGateResult {
  isAnime: boolean;
  hasMal: boolean;
  hasKitsu: boolean;
  reason: string;
}

async function getTmdbIdFromImdb(imdbId: string, tmdbKey: string): Promise<string | null> {
  try {
    // Lazy import to avoid circular deps if any
    const mod = await import('../extractor');
    const imdbOnly = imdbId.split(':')[0];
    const tmdbId = await mod.getTmdbIdFromImdbId(imdbOnly, tmdbKey);
    return tmdbId || null;
  } catch {
    return null;
  }
}

async function fetchHaglundMappings(tmdbId: string): Promise<{ mal?: string; kitsu?: string } | null> {
  try {
    const resp = await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`);
    const data = await resp.json();
    const entry = Array.isArray(data) ? data[0] : null;
    if (!entry) return null;
    return {
      mal: entry?.myanimelist ? String(entry.myanimelist) : undefined,
      kitsu: entry?.kitsu ? String(entry.kitsu) : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchTmdbDetailsAny(tmdbId: string, tmdbKey: string, mediaHint?: 'movie' | 'tv'): Promise<any | null> {
  const tryEndpoints: ('movie' | 'tv')[] = mediaHint ? [mediaHint, mediaHint === 'movie' ? 'tv' : 'movie'] : ['tv', 'movie'];
  for (const kind of tryEndpoints) {
    try {
      const url = `https://api.themoviedb.org/3/${kind}/${tmdbId}?api_key=${tmdbKey}`;
      const resp = await fetch(url);
      if (!resp.ok) continue;
      const json = await resp.json();
      if (json && (json.id || json.name || json.title)) return json;
    } catch {}
  }
  return null;
}

function tmdbLooksAnime(details: any): boolean {
  if (!details) return false;
  const genres = Array.isArray(details.genres) ? details.genres : [];
  const hasAnimation = genres.some((g: any) => g?.name === 'Animation' || g?.id === 16);
  const productionCountries = Array.isArray(details.production_countries) ? details.production_countries : [];
  const originCountry = Array.isArray(details.origin_country) ? details.origin_country : [];
  const originalLanguage = details.original_language || '';
  const isJP =
    productionCountries.some((c: any) => c?.iso_3166_1 === 'JP') ||
    originCountry.includes('JP') ||
    originalLanguage === 'ja';
  return hasAnimation && isJP;
}

export async function checkIsAnimeById(
  type: ExternalIdType,
  id: string,
  tmdbApiKey?: string,
  mediaHint?: 'movie' | 'tv'
): Promise<AnimeGateResult> {
  const tmdbKey = tmdbApiKey || process.env.TMDB_API_KEY || '';
  if (!tmdbKey) {
    // Without TMDB key we can only say "unknown"; be permissive (treat as anime) to avoid blocking
    return { isAnime: true, hasMal: false, hasKitsu: false, reason: 'no-tmdb-key' };
  }
  let tmdbId: string | null = null;
  if (type === 'imdb') {
    tmdbId = await getTmdbIdFromImdb(id, tmdbKey);
  } else {
    tmdbId = id;
  }
  if (!tmdbId) {
    return { isAnime: false, hasMal: false, hasKitsu: false, reason: 'no-tmdb-id' };
  }
  const map = await fetchHaglundMappings(tmdbId);
  const hasMal = !!map?.mal;
  const hasKitsu = !!map?.kitsu;
  if (hasMal || hasKitsu) {
    return { isAnime: true, hasMal, hasKitsu, reason: 'haglund-mapping' };
  }
  // Fallback via TMDB
  const allowTmdbFallback = (process.env.ANIME_GATE_TMDB_FALLBACK || 'true') !== 'false';
  if (!allowTmdbFallback) {
    return { isAnime: false, hasMal, hasKitsu, reason: 'no-mapping-and-fallback-disabled' };
  }
  const details = await fetchTmdbDetailsAny(tmdbId, tmdbKey, mediaHint);
  if (tmdbLooksAnime(details)) {
    return { isAnime: true, hasMal, hasKitsu, reason: 'tmdb-fallback' };
  }
  return { isAnime: false, hasMal, hasKitsu, reason: 'no-mapping-and-not-animation-jp' };
}

// Build a placeholder informational stream for IMDB/TMDB anime lookups
// Shown to suggest using Kitsu for accurate matching
export function buildAnimeIdWarningStream(source: ExternalIdType): StreamForStremio | null {
  const enabled = (process.env.ANIME_GATE_PLACEHOLDER_ENABLED || 'true') !== 'false';
  if (!enabled) return null;
  const title = '⚠️ La ricerca potrebbe essere errata - usare Kitsu ⚠️';
  // Use a harmless URL; marked notWebReady so players won’t try to play in web
  const url = 'https://kitsu.io';
  return {
    title,
    url,
    behaviorHints: {
      notWebReady: true,
      source,
      notice: true
    } as any
  };
}
