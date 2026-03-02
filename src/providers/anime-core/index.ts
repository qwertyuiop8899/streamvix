/**
 * anime-core/index.ts
 * Barrel export for all shared anime provider infrastructure.
 *
 * Usage in providers:
 *   import { fetchResource, createCaches, resolveLookupRequest, ... } from './anime-core';
 */

// Cache utilities
export {
  getCached,
  setCached,
  uniqueStrings,
  createCaches,
  type CacheEntry,
} from './cache';

// Fetch with cache + inflight dedup
export {
  fetchResource,
  fetchWithTimeout,
  DEFAULT_USER_AGENT,
  DEFAULT_FETCH_TIMEOUT,
  type ProviderCaches,
  type FetchResourceOptions,
} from './fetch-resource';

// Provider URL resolution
export {
  getProviderUrl,
  getMappingApiBase,
  getProviderUrlsFilePath,
} from './provider-urls';

// Mapping API interaction
export {
  parseExplicitRequestId,
  resolveLookupRequest,
  fetchMappingPayload,
  extractProviderPaths,
  extractTmdbIdFromMappingPayload,
  resolveEpisodeFromMappingPayload,
  resolveEpisodeFromMappingPayloadExtended,
  type ExplicitRequestId,
  type LookupRequest,
  type ProviderContext,
  type MappingPayload,
} from './mapping-api';

// Shared helpers
export {
  parsePositiveInt,
  normalizeRequestedEpisode,
  normalizeRequestedSeason,
  parseEpisodeNumber,
  toAbsoluteUrl,
  isDirectMediaPath,
  normalizePlayableMediaUrl,
  sanitizeAnimeTitle,
  inferSourceTag,
  resolveLanguageEmoji,
  extractQualityHint,
  normalizeHostLabel,
  mapLimit,
  normalizeEpisodesList,
  pickEpisodeEntry,
  collectMediaLinksFromEmbedHtml,
  BLOCKED_DOMAINS,
  type NormalizedEpisode,
} from './helpers';
