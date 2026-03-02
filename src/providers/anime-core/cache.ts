/**
 * anime-core/cache.ts
 * TTL-based Map cache with inflight request deduplication.
 * Ported 1:1 from easystreams-main (inline cache logic shared by all 3 anime providers).
 */

export interface CacheEntry<T = any> {
  value: T;
  expiresAt: number;
}

/**
 * Get a cached value if it exists and hasn't expired.
 * Returns `undefined` when missing or expired (expired entries are auto-pruned).
 */
export function getCached<T = any>(map: Map<string, CacheEntry<T>>, key: string): T | undefined {
  const entry = map.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    map.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * Store a value in the cache with the given TTL (milliseconds).
 * Returns the stored value for convenience (allows inline usage).
 */
export function setCached<T = any>(map: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): T {
  map.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

/**
 * Deduplicate an array of strings, preserving insertion order.
 * Trims whitespace and discards empty values.
 */
export function uniqueStrings(values: (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * Create a fresh set of caches for a provider instance.
 * Each provider should call this once at module scope.
 */
export function createCaches() {
  return {
    http: new Map<string, CacheEntry>(),
    mapping: new Map<string, CacheEntry>(),
    inflight: new Map<string, Promise<any>>(),
  };
}
