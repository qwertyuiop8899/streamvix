
interface AnimeEntry {
    kitsu_id?: number;
    imdb_id?: string;
    themoviedb_id?: number;
    season?: {
        tmdb?: number;
        tvdb?: number;
    };
    // other fields ignored
}

const MAPPING_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/refs/heads/master/anime-list-full.json';
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface MappedData {
    imdb_id?: string;
    tmdb_id?: number;
    season?: number;
}

let mappingCache: Map<string, MappedData> | null = null;
let lastUpdate = 0;
let updatePromise: Promise<void> | null = null;

async function updateMapping() {
    console.log('[KitsuMapping] Fetching anime list...');
    try {
        const res = await fetch(MAPPING_URL);
        if (!res.ok) throw new Error(`Status ${res.status}`);
        const data: AnimeEntry[] = await res.json();
        
        const newMap = new Map<string, MappedData>();
        let count = 0;
        for (const entry of data) {
            // Updated condition: accept if has Kitsu ID and (IMDB ID OR TMDB ID)
            if (entry.kitsu_id && (entry.imdb_id || entry.themoviedb_id)) {
                // Store as string keys for easy lookup
                const val: MappedData = { };
                if (entry.imdb_id) val.imdb_id = entry.imdb_id;
                if (entry.themoviedb_id) val.tmdb_id = entry.themoviedb_id;
                
                if (entry.season?.tmdb) val.season = entry.season.tmdb;
                else if (entry.season?.tvdb) val.season = entry.season.tvdb;
                
                newMap.set(String(entry.kitsu_id), val);
                count++;
            }
        }
        mappingCache = newMap;
        lastUpdate = Date.now();
        console.log(`[KitsuMapping] Loaded ${count} mappings.`);
    } catch (e) {
        console.error('[KitsuMapping] Error fetching list:', e);
        // If first load fails, mappingCache remains null
    } finally {
        updatePromise = null;
    }
}

/**
 * Returns the IMDB ID (and season) for a given Kitsu ID.
 * If IMDB ID is missing but TMDB ID is available, it attempts to fetch it from TMDB API.
 * 
 * @param kitsuId The full Kitsu ID string (e.g. "kitsu:123" or just "123")
 * @param type The content type ('movie', 'series', 'anime' etc.) used to select TMDB endpoint
 * @param tmdbApiKey The TMDB API Key used for fallback lookup
 */
export async function getImdbIdFromKitsu(kitsuId: string, type?: string, tmdbApiKey?: string): Promise<MappedData | null> {
    // 1. Initialize logic
    if (!mappingCache) {
        if (!updatePromise) {
            updatePromise = updateMapping();
        }
        await updatePromise;
    } else {
        // Background update if stale
        if (Date.now() - lastUpdate > UPDATE_INTERVAL_MS) {
            if (!updatePromise) updatePromise = updateMapping();
        }
    }

    if (!mappingCache) return null;

    // 2. Normalize ID (remove 'kitsu:' prefix and handle episode suffix)
    // Format is typically 'kitsu:ID' or 'kitsu:ID:EP'
    // We want 'ID'
    const rawId = kitsuId.replace(/^kitsu:/, '').split(':')[0];
    
    // 3. Lookup
    const data = mappingCache.get(rawId);
    if (!data) return null;

    // 4. Return cached IMDB ID if present
    if (data.imdb_id) {
        return data;
    }

    // 5. Fallback: If we have TMDB ID but no IMDB ID, and an API key is provided
    if (data.tmdb_id && tmdbApiKey) {
         try {
             // Determine endpoint: 'anime' usually maps to 'tv' in TMDB, 'movie' to 'movie', 'series' to 'tv'
             const endpointType = (type === 'movie') ? 'movie' : 'tv';
             const url = `https://api.themoviedb.org/3/${endpointType}/${data.tmdb_id}/external_ids?api_key=${tmdbApiKey}`;
             console.log(`[KitsuMapping] Fetching external IDs for TMDB ${data.tmdb_id} (${endpointType})`);
             
             const r = await fetch(url);
             if (r.ok) {
                 const ext = await r.json();
                 if (ext.imdb_id) {
                     console.log(`[KitsuMapping] Resolved IMDB ID via TMDB: ${ext.imdb_id}`);
                     // Cache it for future lookups (in-memory)
                     data.imdb_id = ext.imdb_id;
                     return data;
                 }
             } else {
                 console.warn(`[KitsuMapping] TMDB request failed: status ${r.status}`);
             }
         } catch (e) {
             console.warn('[KitsuMapping] Error fetching external IDs:', e);
         }
    }

    return null;
}
