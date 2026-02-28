/**
 * Centralized Anime Title Resolver
 *
 * Risolve Stremio IDs (kitsu:, mal:, imdb:, tmdb:) → titolo inglese + metadati
 * in UNA SOLA catena di chiamate, condivisa tra tutti i provider anime.
 *
 * Strategia per kitsu: IDs:
 *   1. animemapping.stremio.dpdns.org → tmdbId, malId  (in parallelo con Kitsu details)
 *   2. Jikan (via malId) → titolo inglese specifico per stagione
 *   3. Fallback: Kitsu mappings API → malId → Jikan
 *   4. Fallback: Kitsu canonical title (titles.en / en_jp)
 *   5. Fallback: TMDB title (ultima risorsa)
 *
 * Strategia per imdb:/tmdb: IDs (NUOVO):
 *   1. (solo imdb) getTmdbIdFromImdbId → tmdbId
 *   2. animemapping by-imdb/by-tmdb?season=N → kitsuId, malId, titleHints, episodeMode
 *   3. Se episodeMode === "absolute": TMDB seasons → calculateAbsoluteEpisode
 *   4. Jikan → englishTitle (fallback: titleHints[0])
 *   5. Fallback: Haglund → malId → Jikan
 *   6. Fallback: TMDB title
 *
 * Cache: 6 ore in-memory (il titolo non cambia)
 */

export interface AnimeResolvedTitle {
  englishTitle: string;
  malId?: string;
  tmdbId?: string;
  imdbId?: string;
  kitsuId?: string;
  startDate?: string;  // Da Kitsu, per AnimeWorld year filtering
  // Nuovi campi dal resolver unificato
  titleHints?: string[];                              // alias ordinati per ricerca sui provider
  episodeMode?: 'absolute' | 'seasonal' | 'mixed';   // da animemapping
  mappedSeasons?: number[];                           // stagioni mappate (da animemapping)
  absoluteEpisode?: number;                           // episodio assoluto calcolato (se episodeMode === "absolute")
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

// ─── NUOVI HELPERS per IMDB/TMDB ────────────────────────────────────

const ANIMEMAPPING_BASE = 'https://animemapping.stremio.dpdns.org';

/** Ottieni TMDB ID da IMDB ID usando l'extractor del codebase */
async function getTmdbIdFromImdb(imdbId: string, tmdbKey: string): Promise<string | null> {
  try {
    const mod = await import('../extractor');
    const imdbOnly = imdbId.split(':')[0];
    const result = await mod.getTmdbIdFromImdbId(imdbOnly, tmdbKey, 'tv');
    return result || null;
  } catch {
    return null;
  }
}

/** Ottieni episode_count per stagione da TMDB (serve per calcolo episodio assoluto) */
async function fetchTmdbSeasons(tmdbId: string, tmdbKey: string): Promise<Array<{ season_number: number; episode_count: number }> | null> {
  const data = await fetchJson(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${tmdbKey}`);
  if (!data?.seasons || !Array.isArray(data.seasons)) return null;
  return data.seasons
    .filter((s: any) => s.season_number > 0)
    .map((s: any) => ({ season_number: s.season_number, episode_count: s.episode_count || 0 }))
    .sort((a: any, b: any) => a.season_number - b.season_number);
}

/**
 * Calcola l'episodio assoluto dalla coppia (stagione, episodio).
 * Somma gli episode_count di tutte le stagioni precedenti a targetSeason.
 *
 * Se episode > episode_count della stagione corrente, probabilmente è già assoluto → non toccare.
 * Se targetSeason === 1, restituisce episode invariato.
 */
function calculateAbsoluteEpisode(
  seasons: Array<{ season_number: number; episode_count: number }>,
  targetSeason: number,
  episode: number
): number {
  if (targetSeason <= 1) return episode;
  // Se l'episodio supera il count della stagione corrente, potrebbe già essere assoluto
  const currentSeason = seasons.find(s => s.season_number === targetSeason);
  if (currentSeason && episode > currentSeason.episode_count) {
    return episode; // già assoluto, non sommare
  }
  let offset = 0;
  for (const s of seasons) {
    if (s.season_number > 0 && s.season_number < targetSeason) {
      offset += s.episode_count;
    }
  }
  return offset + episode;
}

/** Haglund mappings come fallback se animemapping non risponde */
async function fetchHaglundMappings(tmdbId: string): Promise<{ mal?: string; kitsu?: string } | null> {
  const data = await fetchJson(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`);
  if (!data || !Array.isArray(data) || !data[0]) return null;
  return {
    mal: data[0]?.myanimelist ? String(data[0].myanimelist) : undefined,
    kitsu: data[0]?.kitsu ? String(data[0].kitsu) : undefined,
  };
}

/** Estrai i dati comuni dalla risposta animemapping (by-imdb / by-tmdb) */
function extractAnimeMappingData(mappingData: any) {
  return {
    kitsuId: mappingData.kitsuId?.toString() as string | undefined,
    malId: mappingData.malId?.toString() as string | undefined,
    imdbId: mappingData.imdbId?.toString() as string | undefined,
    titleHints: Array.isArray(mappingData.titleHints) ? mappingData.titleHints as string[] : undefined,
    episodeMode: (['absolute', 'seasonal', 'mixed'].includes(mappingData.episodeMode)
      ? mappingData.episodeMode
      : undefined) as 'absolute' | 'seasonal' | 'mixed' | undefined,
    mappedSeasons: Array.isArray(mappingData.mappedSeasons)
      ? mappingData.mappedSeasons.map((n: any) => parseInt(n, 10)).filter((n: number) => Number.isInteger(n) && n > 0)
      : undefined,
  };
}

// ─── Entry point principale ─────────────────────────────────────────
/**
 * Risolve un ID anime Stremio in titolo inglese + metadati.
 *
 * @param id       - ID nel formato "kitsu:12345", "mal:67890", "imdb:tt...", "tmdb:12345"
 * @param tmdbApiKey - API key TMDB (opzionale, usa env var come fallback)
 * @param season   - numero stagione (per IMDB/TMDB, per disambiguazione + calcolo ep assoluto)
 * @param episode  - numero episodio (per IMDB/TMDB, per calcolo ep assoluto)
 */
export async function resolveAnimeTitle(
  id: string,
  tmdbApiKey?: string,
  season?: number,
  episode?: number
): Promise<AnimeResolvedTitle | null> {
  // Cache key include la stagione per imdb/tmdb (stagioni diverse → kitsuId/malId diversi)
  const isImdbTmdb = id.startsWith('imdb:') || id.startsWith('tmdb:');
  const cacheKey = isImdbTmdb ? `${id}:S${season || 1}` : id;

  // Check cache
  const cached = getCached(cacheKey);
  if (cached) {
    // Per IMDB/TMDB ricalcola absoluteEpisode se l'episodio richiesto è diverso
    // (stessa stagione ma episodio diverso → cache HIT per titolo, ricalcolo solo ep assoluto)
    if (isImdbTmdb && cached.episodeMode === 'absolute' && episode && season && season > 1) {
      // L'ep assoluto dipende dall'episodio specifico, non solo dalla stagione
      // Ma titleHints, malId, kitsuId sono gli stessi → riusa tutto tranne absoluteEpisode
      const tmdbKey = tmdbApiKey || process.env.TMDB_API_KEY || '';
      if (cached.tmdbId && tmdbKey) {
        const seasons = await fetchTmdbSeasons(cached.tmdbId, tmdbKey);
        if (seasons) {
          const absEp = calculateAbsoluteEpisode(seasons, season, episode);
          console.log(`[AnimeTitleResolver] Cache HIT + recalc absoluteEp: ${cacheKey} → "${cached.englishTitle}" ep ${absEp}`);
          return { ...cached, absoluteEpisode: absEp };
        }
      }
    }
    console.log(`[AnimeTitleResolver] Cache HIT: ${cacheKey} → "${cached.englishTitle}"`);
    return cached;
  }

  console.log(`[AnimeTitleResolver] Resolving: ${cacheKey}`);
  const tmdbKey = tmdbApiKey || process.env.TMDB_API_KEY || '';

  let result: AnimeResolvedTitle | null = null;

  if (id.startsWith('kitsu:')) {
    result = await resolveFromKitsu(id, tmdbKey);
  } else if (id.startsWith('mal:')) {
    result = await resolveFromMal(id);
  } else if (id.startsWith('imdb:')) {
    result = await resolveFromImdb(id, tmdbKey, season, episode);
  } else if (id.startsWith('tmdb:')) {
    result = await resolveFromTmdb(id, tmdbKey, season, episode);
  }

  if (result) {
    setCache(cacheKey, result);
    console.log(`[AnimeTitleResolver] RESOLVED: ${cacheKey} → "${result.englishTitle}" (malId=${result.malId || '-'}, kitsuId=${result.kitsuId || '-'}, tmdbId=${result.tmdbId || '-'}, episodeMode=${result.episodeMode || '-'}, absoluteEp=${result.absoluteEpisode ?? '-'})`);
  } else {
    console.error(`[AnimeTitleResolver] FAILED: ${cacheKey}`);
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
  let titleHints: string[] | undefined;
  let episodeMode: 'absolute' | 'seasonal' | 'mixed' | undefined;
  let mappedSeasons: number[] | undefined;

  // ── Parallel: Mapping API + Kitsu anime details ──
  // 2 chiamate in parallelo, 0 tempo extra rispetto a farne 1
  const [mappingData, kitsuData] = await Promise.all([
    fetchJson(`${ANIMEMAPPING_BASE}/mapping/${kitsuId}`, 5000),
    fetchJson(`https://kitsu.io/api/edge/anime/${kitsuId}`, 8000)
  ]);

  // Estrai IDs dalla Mapping API
  if (mappingData) {
    tmdbId = mappingData.tmdbId?.toString() || undefined;
    malId = mappingData.malId?.toString() || undefined;
    imdbId = mappingData.imdbId?.toString() || undefined;
    // Estrai anche i nuovi campi se disponibili
    titleHints = Array.isArray(mappingData.titleHints) ? mappingData.titleHints : undefined;
    episodeMode = (['absolute', 'seasonal', 'mixed'].includes(mappingData.episodeMode) ? mappingData.episodeMode : undefined);
    mappedSeasons = Array.isArray(mappingData.mappedSeasons)
      ? mappingData.mappedSeasons.map((n: any) => parseInt(n, 10)).filter((n: number) => Number.isInteger(n) && n > 0)
      : undefined;
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
      return { englishTitle, malId, tmdbId, imdbId, kitsuId, startDate, titleHints, episodeMode, mappedSeasons };
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
          return { englishTitle, malId, tmdbId, imdbId, kitsuId, startDate, titleHints, episodeMode, mappedSeasons };
        }
      }
    }
  }

  // ── Step 3: Kitsu canonical title ──
  if (kitsuCanonical) {
    console.log(`[AnimeTitleResolver] Kitsu canonical fallback: "${kitsuCanonical}"`);
    return { englishTitle: kitsuCanonical, malId, tmdbId, imdbId, kitsuId, startDate, titleHints, episodeMode, mappedSeasons };
  }

  // ── Step 4: TMDB title (ultima risorsa) ──
  if (tmdbId && tmdbKey) {
    englishTitle = await getTitleFromTmdb(tmdbId, tmdbKey);
    if (englishTitle) {
      console.log(`[AnimeTitleResolver] TMDB fallback: "${englishTitle}"`);
      return { englishTitle, malId, tmdbId, imdbId, kitsuId, startDate, titleHints, episodeMode, mappedSeasons };
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

// ─── IMDB resolver (NUOVO) ──────────────────────────────────────────
async function resolveFromImdb(
  fullId: string,
  tmdbKey: string,
  season?: number,
  episode?: number
): Promise<AnimeResolvedTitle | null> {
  const imdbId = fullId.replace('imdb:', '');

  // ── Step 1: TMDB ID + animemapping in parallelo ──
  const mappingUrl = `${ANIMEMAPPING_BASE}/mapping/by-imdb/${imdbId}${season ? `?season=${season}` : ''}`;
  const [tmdbId, mappingData] = await Promise.all([
    getTmdbIdFromImdb(imdbId, tmdbKey),
    fetchJson(mappingUrl, 5000)
  ]);

  let malId: string | undefined;
  let kitsuId: string | undefined;
  let titleHints: string[] | undefined;
  let episodeMode: 'absolute' | 'seasonal' | 'mixed' | undefined;
  let mappedSeasons: number[] | undefined;
  let absoluteEpisode: number | undefined;
  let englishTitle: string | null = null;

  // Estrai dati da animemapping
  if (mappingData) {
    const extracted = extractAnimeMappingData(mappingData);
    kitsuId = extracted.kitsuId;
    malId = extracted.malId;
    titleHints = extracted.titleHints;
    episodeMode = extracted.episodeMode;
    mappedSeasons = extracted.mappedSeasons;
    console.log(`[AnimeTitleResolver] animemapping by-imdb HIT: kitsuId=${kitsuId}, malId=${malId}, mode=${episodeMode}, hints=${titleHints?.length || 0}`);
  } else {
    console.log(`[AnimeTitleResolver] animemapping by-imdb MISS per ${imdbId}`);
  }

  // ── Step 2: Calcola episodio assoluto se necessario ──
  if (episodeMode === 'absolute' && season && season > 1 && episode && tmdbId && tmdbKey) {
    const seasons = await fetchTmdbSeasons(tmdbId, tmdbKey);
    if (seasons && seasons.length > 0) {
      absoluteEpisode = calculateAbsoluteEpisode(seasons, season, episode);
      console.log(`[AnimeTitleResolver] Absolute episode calc: S${season}E${episode} → ep ${absoluteEpisode}`);
    }
  }

  // ── Step 3: Titolo da Jikan (preferito) ──
  if (malId) {
    englishTitle = await getTitleFromJikan(malId);
    if (englishTitle) {
      console.log(`[AnimeTitleResolver] IMDB→Jikan title: "${englishTitle}"`);
    }
  }

  // ── Step 4: Fallback titleHints[0] ──
  if (!englishTitle && titleHints && titleHints.length > 0) {
    englishTitle = titleHints[0];
    console.log(`[AnimeTitleResolver] IMDB→titleHints[0] fallback: "${englishTitle}"`);
  }

  // ── Step 5: Fallback Haglund (se animemapping non ha dato malId) ──
  if (!englishTitle && !malId && tmdbId) {
    const haglund = await fetchHaglundMappings(tmdbId);
    if (haglund?.mal) {
      malId = haglund.mal;
      kitsuId = kitsuId || haglund.kitsu;
      englishTitle = await getTitleFromJikan(malId);
      if (englishTitle) {
        console.log(`[AnimeTitleResolver] IMDB→Haglund→Jikan fallback: "${englishTitle}"`);
      }
    }
  }

  // ── Step 6: Fallback TMDB title ──
  if (!englishTitle && tmdbId && tmdbKey) {
    englishTitle = await getTitleFromTmdb(tmdbId, tmdbKey);
    if (englishTitle) {
      console.log(`[AnimeTitleResolver] IMDB→TMDB title fallback: "${englishTitle}"`);
    }
  }

  if (!englishTitle) return null;

  return {
    englishTitle,
    malId,
    tmdbId: tmdbId || undefined,
    imdbId,
    kitsuId,
    titleHints,
    episodeMode,
    mappedSeasons,
    absoluteEpisode,
  };
}

// ─── TMDB resolver (NUOVO) ──────────────────────────────────────────
async function resolveFromTmdb(
  fullId: string,
  tmdbKey: string,
  season?: number,
  episode?: number
): Promise<AnimeResolvedTitle | null> {
  const tmdbId = fullId.replace('tmdb:', '');

  // ── Step 1: animemapping by-tmdb ──
  const mappingUrl = `${ANIMEMAPPING_BASE}/mapping/by-tmdb/${tmdbId}${season ? `?season=${season}` : ''}`;
  const mappingData = await fetchJson(mappingUrl, 5000);

  let malId: string | undefined;
  let kitsuId: string | undefined;
  let imdbId: string | undefined;
  let titleHints: string[] | undefined;
  let episodeMode: 'absolute' | 'seasonal' | 'mixed' | undefined;
  let mappedSeasons: number[] | undefined;
  let absoluteEpisode: number | undefined;
  let englishTitle: string | null = null;

  if (mappingData) {
    const extracted = extractAnimeMappingData(mappingData);
    kitsuId = extracted.kitsuId;
    malId = extracted.malId;
    imdbId = extracted.imdbId;
    titleHints = extracted.titleHints;
    episodeMode = extracted.episodeMode;
    mappedSeasons = extracted.mappedSeasons;
    console.log(`[AnimeTitleResolver] animemapping by-tmdb HIT: kitsuId=${kitsuId}, malId=${malId}, mode=${episodeMode}, hints=${titleHints?.length || 0}`);
  } else {
    console.log(`[AnimeTitleResolver] animemapping by-tmdb MISS per ${tmdbId}`);
  }

  // ── Step 2: Calcola episodio assoluto se necessario ──
  if (episodeMode === 'absolute' && season && season > 1 && episode && tmdbKey) {
    const seasons = await fetchTmdbSeasons(tmdbId, tmdbKey);
    if (seasons && seasons.length > 0) {
      absoluteEpisode = calculateAbsoluteEpisode(seasons, season, episode);
      console.log(`[AnimeTitleResolver] Absolute episode calc: S${season}E${episode} → ep ${absoluteEpisode}`);
    }
  }

  // ── Step 3: Jikan ──
  if (malId) {
    englishTitle = await getTitleFromJikan(malId);
    if (englishTitle) {
      console.log(`[AnimeTitleResolver] TMDB→Jikan title: "${englishTitle}"`);
    }
  }

  // ── Step 4: titleHints[0] ──
  if (!englishTitle && titleHints && titleHints.length > 0) {
    englishTitle = titleHints[0];
    console.log(`[AnimeTitleResolver] TMDB→titleHints[0] fallback: "${englishTitle}"`);
  }

  // ── Step 5: Haglund ──
  if (!englishTitle && !malId) {
    const haglund = await fetchHaglundMappings(tmdbId);
    if (haglund?.mal) {
      malId = haglund.mal;
      kitsuId = kitsuId || haglund.kitsu;
      englishTitle = await getTitleFromJikan(malId);
      if (englishTitle) {
        console.log(`[AnimeTitleResolver] TMDB→Haglund→Jikan fallback: "${englishTitle}"`);
      }
    }
  }

  // ── Step 6: TMDB title ──
  if (!englishTitle && tmdbKey) {
    englishTitle = await getTitleFromTmdb(tmdbId, tmdbKey);
    if (englishTitle) {
      console.log(`[AnimeTitleResolver] TMDB→TMDB title fallback: "${englishTitle}"`);
    }
  }

  if (!englishTitle) return null;

  return {
    englishTitle,
    malId,
    tmdbId,
    imdbId,
    kitsuId,
    titleHints,
    episodeMode,
    mappedSeasons,
    absoluteEpisode,
  };
}
