/**
 * anime-core/mapping-api.ts
 * Mapping API interaction: ID parsing, lookup resolution, payload fetching, episode resolution.
 * Ported 1:1 from the identical logic shared by all 3 easystreams anime providers.
 *
 * This module does NOT know about specific providers (AnimeUnity/AnimeWorld/AnimeSaturn).
 * Callers extract provider-specific paths from the mapping payload themselves.
 */

import { getCached, setCached, type CacheEntry } from './cache';
import { fetchResource, type ProviderCaches, type FetchResourceOptions, DEFAULT_FETCH_TIMEOUT } from './fetch-resource';
import { getMappingApiBase } from './provider-urls';
import { normalizeRequestedEpisode, normalizeRequestedSeason, parsePositiveInt } from './helpers';

// ─── TTL constants for mapping cache ────────────────────────

const MAPPING_TTL_MS = 2 * 60 * 1000; // 2 min

// ─── Types ──────────────────────────────────────────────────

export interface ExplicitRequestId {
  provider: 'kitsu' | 'imdb' | 'tmdb';
  externalId: string;
  seasonFromId: number | null;
  episodeFromId: number | null;
}

export interface LookupRequest {
  provider: 'kitsu' | 'imdb' | 'tmdb';
  externalId: string;
  season: number | null;
  episode: number;
}

export interface ProviderContext {
  kitsuId?: string | number | null;
  tmdbId?: string | number | null;
  imdbId?: string | null;
}

export interface MappingPayload {
  mappings?: {
    animeunity?: any;
    animeworld?: any;
    animesaturn?: any;
    ids?: { tmdb?: string | number };
    tmdb_episode?: { rawEpisodeNumber?: number; raw_episode_number?: number };
    tmdbEpisode?: { rawEpisodeNumber?: number };
  };
  ids?: { tmdb?: string | number };
  tmdbId?: string | number;
  kitsu?: { episode?: number };
  requested?: { episode?: number };
  tmdb_episode?: { rawEpisodeNumber?: number };
  tmdbEpisode?: { rawEpisodeNumber?: number };
}

// ─── ID Parsing ─────────────────────────────────────────────

/**
 * Parse an explicit request ID string (e.g. "kitsu:12345:3", "imdb:tt1234567:1:5", "tmdb:999:2:10").
 * Returns null if the format is not recognized.
 */
export function parseExplicitRequestId(rawId: string | null | undefined): ExplicitRequestId | null {
  const value = String(rawId || '').trim();
  if (!value) return null;

  // kitsu:ID[:season][:episode] or kitsu:ID[:episode]
  let match = value.match(/^kitsu:(\d+)(?::(\d+))?(?::(\d+))?$/i);
  if (match) {
    return {
      provider: 'kitsu',
      externalId: match[1],
      seasonFromId: match[3] ? normalizeRequestedSeason(match[2]) : null,
      episodeFromId: match[3]
        ? normalizeRequestedEpisode(match[3])
        : match[2]
          ? normalizeRequestedEpisode(match[2])
          : null,
    };
  }

  // imdb:ttXXX[:season][:episode]
  match = value.match(/^imdb:(tt\d+)(?::(\d+))?(?::(\d+))?$/i);
  if (match) {
    return {
      provider: 'imdb',
      externalId: match[1],
      seasonFromId: match[3] ? normalizeRequestedSeason(match[2]) : null,
      episodeFromId: match[3]
        ? normalizeRequestedEpisode(match[3])
        : match[2]
          ? normalizeRequestedEpisode(match[2])
          : null,
    };
  }

  // tmdb:ID[:season][:episode]
  match = value.match(/^tmdb:(\d+)(?::(\d+))?(?::(\d+))?$/i);
  if (match) {
    return {
      provider: 'tmdb',
      externalId: match[1],
      seasonFromId: match[3] ? normalizeRequestedSeason(match[2]) : null,
      episodeFromId: match[3]
        ? normalizeRequestedEpisode(match[3])
        : match[2]
          ? normalizeRequestedEpisode(match[2])
          : null,
    };
  }

  // Bare IMDb ID: tt1234567
  match = value.match(/^(tt\d+)$/i);
  if (match) {
    return {
      provider: 'imdb',
      externalId: match[1],
      seasonFromId: null,
      episodeFromId: null,
    };
  }

  // Bare numeric ID → treat as TMDB
  match = value.match(/^(\d+)$/);
  if (match) {
    return {
      provider: 'tmdb',
      externalId: match[1],
      seasonFromId: null,
      episodeFromId: null,
    };
  }

  return null;
}

// ─── Lookup Resolution ──────────────────────────────────────

/**
 * Build a LookupRequest from an incoming ID + season/episode + optional provider context.
 * Ported 1:1 from easystreams resolveLookupRequest().
 */
export function resolveLookupRequest(
  id: string,
  season: number | string | null | undefined,
  episode: number | string | null | undefined,
  providerContext: ProviderContext | null = null
): LookupRequest | null {
  let rawId = String(id || '').trim();
  try {
    rawId = decodeURIComponent(rawId);
  } catch {
    // keep raw id
  }

  let requestedSeason = normalizeRequestedSeason(season);
  let requestedEpisode = normalizeRequestedEpisode(episode);

  const explicit = parseExplicitRequestId(rawId);
  if (explicit) {
    const explicitSeason =
      Number.isInteger(explicit.seasonFromId) && (explicit.seasonFromId as number) >= 0
        ? explicit.seasonFromId
        : null;

    if (explicit.provider === 'kitsu') {
      // For Kitsu lookups use season only when explicitly provided in the id.
      requestedSeason = explicitSeason;
    } else if (explicitSeason !== null) {
      requestedSeason = explicitSeason;
    }
    if (Number.isInteger(explicit.episodeFromId) && (explicit.episodeFromId as number) > 0) {
      requestedEpisode = explicit.episodeFromId as number;
    }

    return {
      provider: explicit.provider,
      externalId: explicit.externalId,
      season: requestedSeason,
      episode: requestedEpisode,
    };
  }

  // Fallback to provider context
  const contextKitsu = parsePositiveInt(providerContext?.kitsuId);
  if (contextKitsu) {
    return {
      provider: 'kitsu',
      externalId: String(contextKitsu),
      season: null,
      episode: requestedEpisode,
    };
  }

  const contextImdb = /^tt\d+$/i.test(String(providerContext?.imdbId || '').trim())
    ? String(providerContext!.imdbId).trim()
    : null;
  if (contextImdb) {
    return {
      provider: 'imdb',
      externalId: contextImdb,
      season: requestedSeason,
      episode: requestedEpisode,
    };
  }

  const contextTmdb = /^\d+$/.test(String(providerContext?.tmdbId || '').trim())
    ? String(providerContext!.tmdbId).trim()
    : null;
  if (contextTmdb) {
    return {
      provider: 'tmdb',
      externalId: contextTmdb,
      season: requestedSeason,
      episode: requestedEpisode,
    };
  }

  return null;
}

// ─── Mapping Payload Fetch ──────────────────────────────────

/**
 * Fetch the mapping payload from the Mapping API for a given lookup.
 * Ported 1:1 from easystreams fetchMappingPayload().
 *
 * @param lookup - The resolved lookup request
 * @param caches - The provider's cache maps
 * @param providerTag - Logging tag (e.g. 'AnimeUnity')
 */
export async function fetchMappingPayload(
  lookup: LookupRequest | null,
  caches: ProviderCaches,
  providerTag: string = 'Mapping'
): Promise<MappingPayload | null> {
  if (!lookup?.provider || !lookup?.externalId) return null;

  const provider = String(lookup.provider || '').trim().toLowerCase();
  const externalId = String(lookup.externalId || '').trim();
  const requestedEpisode = normalizeRequestedEpisode(lookup.episode);
  const requestedSeason = normalizeRequestedSeason(lookup.season);

  if (!['kitsu', 'imdb', 'tmdb'].includes(provider)) return null;
  if (!externalId) return null;

  const cacheKey = `${provider}:${externalId}:s=${requestedSeason ?? 'na'}:ep=${requestedEpisode}`;
  const cached = getCached(caches.mapping, cacheKey);
  if (cached !== undefined) return cached;

  const params = new URLSearchParams();
  params.set('ep', String(requestedEpisode));
  if (Number.isInteger(requestedSeason) && (requestedSeason as number) >= 0) {
    params.set('s', String(requestedSeason));
  }

  const url = `${getMappingApiBase()}/${provider}/${encodeURIComponent(externalId)}?${params.toString()}`;
  try {
    const payload = await fetchResource(url, caches, {
      as: 'json',
      ttlMs: MAPPING_TTL_MS,
      cacheKey,
      timeoutMs: DEFAULT_FETCH_TIMEOUT,
    });
    setCached(caches.mapping, cacheKey, payload, MAPPING_TTL_MS);
    return payload;
  } catch (error: any) {
    console.error(`[${providerTag}] mapping request failed:`, error.message);
    return null;
  }
}

// ─── Path Extraction Helpers ────────────────────────────────

/**
 * Extract provider-specific paths from mapping payload.
 * The `providerKey` should be 'animeunity', 'animeworld', or 'animesaturn'.
 * Returns an array of path strings.
 */
export function extractProviderPaths(
  mappingPayload: MappingPayload | null,
  providerKey: 'animeunity' | 'animeworld' | 'animesaturn',
  normalizeFn: (pathOrUrl: string | null) => string | null
): string[] {
  if (!mappingPayload || typeof mappingPayload !== 'object') return [];
  const raw = (mappingPayload?.mappings as any)?.[providerKey];
  const list: any[] = Array.isArray(raw) ? raw : raw ? [raw] : [];

  const paths: string[] = [];
  for (const item of list) {
    const candidate: string | null =
      typeof item === 'string'
        ? item
        : item && typeof item === 'object'
          ? item.path || item.url || item.href || item.playPath
          : null;
    const normalized = normalizeFn(candidate);
    if (normalized) paths.push(normalized);
  }

  // Deduplicate
  const seen = new Set<string>();
  return paths.filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return true;
  });
}

/**
 * Extract TMDB ID from the mapping payload.
 * Used for IMDb→TMDB fallback when provider paths are empty.
 */
export function extractTmdbIdFromMappingPayload(mappingPayload: MappingPayload | null): string | null {
  const candidate =
    (mappingPayload?.mappings as any)?.ids?.tmdb ||
    mappingPayload?.ids?.tmdb ||
    mappingPayload?.tmdbId ||
    null;
  const text = String(candidate || '').trim();
  return /^\d+$/.test(text) ? text : null;
}

// ─── Episode Resolution ─────────────────────────────────────

/**
 * Resolve the target episode number from the mapping payload.
 * Priority: kitsu.episode > requested.episode > fallbackEpisode.
 * Ported 1:1 from easystreams resolveEpisodeFromMappingPayload().
 */
export function resolveEpisodeFromMappingPayload(
  mappingPayload: MappingPayload | null,
  fallbackEpisode: number | string | null | undefined
): number {
  const fromKitsu = parsePositiveInt(mappingPayload?.kitsu?.episode);
  if (fromKitsu) return fromKitsu;

  const fromRequested = parsePositiveInt(mappingPayload?.requested?.episode);
  if (fromRequested) return fromRequested;

  return normalizeRequestedEpisode(fallbackEpisode);
}

/**
 * Extended episode resolution including tmdb_episode.rawEpisodeNumber.
 * Used by AnimeSaturn (which checks this extra field).
 */
export function resolveEpisodeFromMappingPayloadExtended(
  mappingPayload: MappingPayload | null,
  fallbackEpisode: number | string | null | undefined
): number {
  const fromKitsu = parsePositiveInt(mappingPayload?.kitsu?.episode);
  if (fromKitsu) return fromKitsu;

  const fromRequested = parsePositiveInt(mappingPayload?.requested?.episode);
  if (fromRequested) return fromRequested;

  // AnimeSaturn-specific: check tmdb_episode.rawEpisodeNumber
  const fromTmdbRaw = parsePositiveInt(
    mappingPayload?.mappings?.tmdb_episode?.rawEpisodeNumber ||
    mappingPayload?.mappings?.tmdb_episode?.raw_episode_number ||
    (mappingPayload?.mappings as any)?.tmdbEpisode?.rawEpisodeNumber ||
    mappingPayload?.tmdb_episode?.rawEpisodeNumber ||
    mappingPayload?.tmdbEpisode?.rawEpisodeNumber
  );
  if (fromTmdbRaw) return fromTmdbRaw;

  return normalizeRequestedEpisode(fallbackEpisode);
}
