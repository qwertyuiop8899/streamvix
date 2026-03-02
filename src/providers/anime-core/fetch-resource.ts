/**
 * anime-core/fetch-resource.ts
 * HTTP fetching with TTL cache, inflight request dedup, and configurable timeout.
 * Ported 1:1 from easystreams-main fetchResource() + fetchWithTimeout().
 */

import { getCached, setCached, type CacheEntry } from './cache';

export const DEFAULT_USER_AGENT =
  process.env.AU_USER_AGENT ||
  process.env.AS_USER_AGENT ||
  process.env.AW_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

export const DEFAULT_FETCH_TIMEOUT = Number.parseInt(
  process.env.ANIME_FETCH_TIMEOUT_MS || '10000',
  10
) || 10000;

/**
 * Caches object — each provider should create its own via createCaches().
 * This interface mirrors the easystreams cache structure.
 */
export interface ProviderCaches {
  http: Map<string, CacheEntry>;
  mapping: Map<string, CacheEntry>;
  inflight: Map<string, Promise<any>>;
}

export interface FetchResourceOptions {
  /** TTL in ms for caching the response. 0 = no cache. */
  ttlMs?: number;
  /** Cache key override. Defaults to the URL. */
  cacheKey?: string;
  /** Response type. 'text' (default) or 'json'. */
  as?: 'text' | 'json';
  /** HTTP method. Defaults to 'GET'. */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Additional request headers. */
  headers?: Record<string, string>;
  /** Request body (for POST etc). */
  body?: string;
  /** Timeout in ms. Defaults to DEFAULT_FETCH_TIMEOUT. */
  timeoutMs?: number;
}

/**
 * Fetch with AbortController-based timeout.
 * Ported 1:1 from easystreams fetchWithTimeout().
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Cached, deduplicated fetch.
 * Ported 1:1 from easystreams fetchResource():
 * - Checks TTL cache first
 * - Deduplicates concurrent inflight requests for the same resource
 * - Stores successful responses in cache
 *
 * @param url      - The URL to fetch
 * @param caches   - The provider's cache maps
 * @param options  - Fetch options (ttl, as, headers, etc.)
 */
export async function fetchResource(
  url: string,
  caches: ProviderCaches,
  options: FetchResourceOptions = {}
): Promise<any> {
  const {
    ttlMs = 0,
    cacheKey = url,
    as = 'text',
    method = 'GET',
    headers = {},
    body = undefined,
    timeoutMs = DEFAULT_FETCH_TIMEOUT,
  } = options;

  const key = `${as}:${method}:${cacheKey}:${typeof body === 'string' ? body : ''}`;

  // 1. Check TTL cache
  if (ttlMs > 0) {
    const cached = getCached(caches.http, key);
    if (cached !== undefined) return cached;
  }

  // 2. Inflight deduplication
  const inflightKey = `http:${key}`;
  const running = caches.inflight.get(inflightKey);
  if (running) return running;

  // 3. Execute fetch
  const task = (async () => {
    const response = await fetchWithTimeout(
      url,
      {
        method,
        headers: {
          'user-agent': DEFAULT_USER_AGENT,
          'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
          ...headers,
        },
        body,
        redirect: 'follow',
      },
      timeoutMs
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    }

    const payload = as === 'json' ? await response.json() : await response.text();
    if (ttlMs > 0) setCached(caches.http, key, payload, ttlMs);
    return payload;
  })();

  caches.inflight.set(inflightKey, task);
  try {
    return await task;
  } finally {
    caches.inflight.delete(inflightKey);
  }
}
