/**
 * Centralized Anime Title Resolver
 * 
 * Risolve Stremio IDs (kitsu:, mal:) → titolo inglese + metadati
 * in UNA SOLA catena di chiamate, condivisa tra tutti i provider anime.
 * 
 * Strategia per kitsu: IDs:
 *   1. animemapping.stremio.dpdns.org → tmdbId, malId  (in parallelo con Kitsu details)
 *   2. Jikan (via malId) → titolo inglese specifico per stagione
 *   3. Fallback: Kitsu mappings API → malId → Jikan
 *   4. Fallback: Kitsu canonical title (titles.en / en_jp)
 *   5. Fallback: TMDB title (ultima risorsa)
 * 
 * Cache: 6 ore in-memory (il titolo non cambia)
 */

export interface AnimeResolvedTitle {
  englishTitle: string;
  malId?: string;
  tmdbId?: string;
  imdbId?: string;
  startDate?: string;  // Da Kitsu, per AnimeWorld year filtering
}

// ─── Cache ──────────────────────────────────────────────────────────
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 ore
const MAX_CACHE_SIZE = 5000;
const cache = new Map<string, { data: AnimeResolvedTitle; expiresAt: number }>();

function getCached(key: string): AnimeResolvedTitle | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key: string, data: AnimeResolvedTitle): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now > v.expiresAt) cache.delete(k);
      if (cache.size < MAX_CACHE_SIZE) break;
    }
    // Se ancora pieno, rimuovi il più vecchio
    if (cache.size >= MAX_CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
  }
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

// ─── HTTP helper con timeout ────────────────────────────────────────
async function fetchJson(url: string, timeoutMs = 8000): Promise<any | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

// ─── Title helpers ──────────────────────────────────────────────────
async function getTitleFromJikan(malId: string): Promise<string | null> {
  const data = await fetchJson(`https://api.jikan.moe/v4/anime/${malId}`);
  if (!data?.data) return null;
  // Preferisci titolo inglese esplicito (più specifico per stagione)
  if (Array.isArray(data.data.titles)) {
    const en = data.data.titles.find((t: any) => t.type === 'English');
    if (en?.title) return en.title;
  }
  return data.data.title_english || data.data.title || data.data.title_japanese || null;
}

async function getTitleFromTmdb(tmdbId: string, tmdbKey: string): Promise<string | null> {
  // Prova TV prima (la maggior parte degli anime)
  let data = await fetchJson(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${tmdbKey}&language=en-US`);
  if (data?.name) return data.name;
  // Prova movie
  data = await fetchJson(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdbKey}&language=en-US`);
  if (data?.title) return data.title;
  return null;
}

// ─── Entry point principale ─────────────────────────────────────────
export async function resolveAnimeTitle(
  id: string,
  tmdbApiKey?: string
): Promise<AnimeResolvedTitle | null> {
  // Check cache
  const cached = getCached(id);
  if (cached) {
    console.log(`[AnimeTitleResolver] Cache HIT: ${id} -> "${cached.englishTitle}"`);
    return cached;
  }

  console.log(`[AnimeTitleResolver] Resolving: ${id}`);
  const tmdbKey = tmdbApiKey || process.env.TMDB_API_KEY || '';

  let result: AnimeResolvedTitle | null = null;

  if (id.startsWith('kitsu:')) {
    result = await resolveFromKitsu(id, tmdbKey);
  } else if (id.startsWith('mal:')) {
    result = await resolveFromMal(id);
  }

  if (result) {
    setCache(id, result);
    console.log(`[AnimeTitleResolver] RESOLVED: ${id} -> "${result.englishTitle}" (malId=${result.malId || '-'}, tmdbId=${result.tmdbId || '-'})`);
  } else {
    console.error(`[AnimeTitleResolver] FAILED: ${id}`);
  }

  return result;
}

// ─── Kitsu resolver ─────────────────────────────────────────────────
async function resolveFromKitsu(fullId: string, tmdbKey: string): Promise<AnimeResolvedTitle | null> {
  const kitsuId = fullId.split(':')[1];

  let malId: string | undefined;
  let tmdbId: string | undefined;
  let imdbId: string | undefined;
  let startDate: string | undefined;
  let kitsuCanonical: string | null = null;
  let englishTitle: string | null = null;

  // ── Parallel: Mapping API + Kitsu anime details ──
  // 2 chiamate in parallelo, 0 tempo extra rispetto a farne 1
  const [mappingData, kitsuData] = await Promise.all([
    fetchJson(`https://animemapping.stremio.dpdns.org/mapping/${kitsuId}`, 5000),
    fetchJson(`https://kitsu.io/api/edge/anime/${kitsuId}`, 8000)
  ]);

  // Estrai IDs dalla Mapping API
  if (mappingData) {
    tmdbId = mappingData.tmdbId?.toString() || undefined;
    malId = mappingData.malId?.toString() || undefined;
    imdbId = mappingData.imdbId?.toString() || undefined;
    console.log(`[AnimeTitleResolver] MappingAPI hit: tmdbId=${tmdbId}, malId=${malId}`);
  } else {
    console.log(`[AnimeTitleResolver] MappingAPI miss per kitsu:${kitsuId}`);
  }

  // Estrai startDate + canonical title da Kitsu details
  if (kitsuData?.data?.attributes) {
    const attr = kitsuData.data.attributes;
    startDate = attr.startDate || undefined;
    kitsuCanonical = attr.titles?.en || attr.titles?.en_jp || attr.canonicalTitle || null;
  }

  // ── Step 1: Titolo da Jikan (preferito — specifico per stagione) ──
  if (malId) {
    englishTitle = await getTitleFromJikan(malId);
    if (englishTitle) {
      console.log(`[AnimeTitleResolver] Jikan title: "${englishTitle}"`);
      return { englishTitle, malId, tmdbId, imdbId, startDate };
    }
    console.log(`[AnimeTitleResolver] Jikan fallito per malId=${malId}`);
  }

  // ── Step 2: Se mapping API non aveva malId, prova Kitsu mappings ──
  if (!malId) {
    const mappingsData = await fetchJson(`https://kitsu.io/api/edge/anime/${kitsuId}/mappings`);
    if (mappingsData?.data) {
      const malMapping = mappingsData.data.find((m: any) => m.attributes?.externalSite === 'myanimelist/anime');
      malId = malMapping?.attributes?.externalId?.toString() || undefined;
      if (malId) {
        console.log(`[AnimeTitleResolver] Kitsu mappings: malId=${malId}`);
        englishTitle = await getTitleFromJikan(malId);
        if (englishTitle) {
          return { englishTitle, malId, tmdbId, imdbId, startDate };
        }
      }
    }
  }

  // ── Step 3: Kitsu canonical title ──
  if (kitsuCanonical) {
    console.log(`[AnimeTitleResolver] Kitsu canonical fallback: "${kitsuCanonical}"`);
    return { englishTitle: kitsuCanonical, malId, tmdbId, imdbId, startDate };
  }

  // ── Step 4: TMDB title (ultima risorsa) ──
  if (tmdbId && tmdbKey) {
    englishTitle = await getTitleFromTmdb(tmdbId, tmdbKey);
    if (englishTitle) {
      console.log(`[AnimeTitleResolver] TMDB fallback: "${englishTitle}"`);
      return { englishTitle, malId, tmdbId, imdbId, startDate };
    }
  }

  return null;
}

// ─── MAL resolver ───────────────────────────────────────────────────
async function resolveFromMal(fullId: string): Promise<AnimeResolvedTitle | null> {
  const malId = fullId.split(':')[1];
  const englishTitle = await getTitleFromJikan(malId);
  if (!englishTitle) return null;
  return { englishTitle, malId };
}
