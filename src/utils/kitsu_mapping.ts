
interface AnimeEntry {
    kitsu_id?: number;
    imdb_id?: string;
    season?: {
        tmdb?: number;
        tvdb?: number;
    };
    // other fields ignored
}

const MAPPING_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/refs/heads/master/anime-list-full.json';
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface MappedData {
    imdb_id: string;
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
            if (entry.kitsu_id && entry.imdb_id) {
                // Store as string keys for easy lookup
                const val: MappedData = { imdb_id: entry.imdb_id };
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
 * Returns the IMDB ID (and season) for a given Kitsu ID, if available.
 * 
 * @param kitsuId The full Kitsu ID string (e.g. "kitsu:123" or just "123")
 */
export async function getImdbIdFromKitsu(kitsuId: string): Promise<MappedData | null> {
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
    return mappingCache.get(rawId) || null;
}
