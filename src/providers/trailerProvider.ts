/**
 * TMDB Trailer Provider
 * Fetches Italian trailers from TMDB API for movies and TV series
 * Returns Stremio-compatible Stream objects
 */

import fetch from 'node-fetch';

// TMDB API configuration
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_KEY = process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0';

interface TMDBVideo {
    id: string;
    key: string;           // YouTube video ID
    name: string;
    site: string;          // "YouTube", "Vimeo", etc.
    type: string;          // "Trailer", "Teaser", "Clip", "Featurette"
    official: boolean;
    iso_639_1: string;     // Language code
    published_at: string;
}

interface TMDBVideoResponse {
    id: number;
    results: TMDBVideo[];
}

interface StremioStream {
    name: string;
    title: string;
    url?: string;
    externalUrl?: string;
    ytId?: string;
    behaviorHints?: {
        notWebReady?: boolean;
        bingeGroup?: string;
    };
}

/**
 * Convert IMDb ID to TMDB ID and get title
 * Returns both the TMDB ID and the Italian or English title
 */
async function imdbToTmdb(imdbId: string, type: 'movie' | 'series'): Promise<{ id: number; title: string } | null> {
    if (!TMDB_KEY) return null;

    try {
        const mediaType = type === 'series' ? 'tv' : 'movie';
        const url = `${TMDB_BASE}/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`;
        const response = await fetch(url);
        const data = await response.json() as any;

        const results = type === 'series' ? data.tv_results : data.movie_results;
        if (results && results.length > 0) {
            const item = results[0];
            // For movies: title, for series: name
            const title = item.title || item.name || '';
            return { id: item.id, title };
        }
    } catch (e) {
        console.error('[TrailerProvider] Error converting IMDb to TMDB:', e);
    }

    return null;
}


/**
 * Fetch videos from TMDB for a movie, TV series, or season
 */
async function fetchTMDBVideos(tmdbId: number, type: 'movie' | 'series', language: string, season?: number): Promise<TMDBVideo[]> {
    if (!TMDB_KEY) return [];

    try {
        let url: string;
        if (type === 'series' && season !== undefined && season > 0) {
            // Season-specific videos
            url = `${TMDB_BASE}/tv/${tmdbId}/season/${season}/videos?api_key=${TMDB_KEY}&language=${language}`;
        } else {
            const mediaType = type === 'series' ? 'tv' : 'movie';
            url = `${TMDB_BASE}/${mediaType}/${tmdbId}/videos?api_key=${TMDB_KEY}&language=${language}`;
        }
        const response = await fetch(url);
        const data = await response.json() as TMDBVideoResponse;

        return data.results || [];
    } catch (e) {
        console.error('[TrailerProvider] Error fetching TMDB videos:', e);
        return [];
    }
}

/**
 * Select the best trailer from a list of videos
 * Priority: Official Trailer > Trailer > Teaser
 */
function selectBestTrailer(videos: TMDBVideo[]): TMDBVideo | null {
    if (!videos || videos.length === 0) return null;

    // Filter only YouTube videos
    const youtubeVideos = videos.filter(v => v.site === 'YouTube');
    if (youtubeVideos.length === 0) return null;

    // Priority order for video types
    const typePriority = ['Trailer', 'Teaser', 'Clip'];

    // First try to find official trailers
    for (const type of typePriority) {
        const official = youtubeVideos.find(v => v.type === type && v.official);
        if (official) return official;
    }

    // Then try non-official
    for (const type of typePriority) {
        const video = youtubeVideos.find(v => v.type === type);
        if (video) return video;
    }

    // Return first YouTube video as fallback
    return youtubeVideos[0];
}

/**
 * Get trailer streams for a movie or TV series
 * For series: tries season-specific trailer first, then falls back to series trailer
 * @param type - 'movie' or 'series'
 * @param imdbId - IMDb ID (e.g., 'tt0137523')
 * @param contentName - Name of the movie/series for display
 * @param season - Optional season number for series
 * @param tmdbId - Optional TMDB ID (if already known)
 * @returns Array of Stremio Stream objects (usually 1)
 */
export async function getTrailerStreams(
    type: 'movie' | 'series',
    imdbId: string,
    contentName?: string,
    season?: number,
    tmdbId?: number
): Promise<StremioStream[]> {
    if (!TMDB_KEY) {
        console.warn('[TrailerProvider] TMDB_KEY not set, skipping trailer fetch');
        return [];
    }

    try {
        // Get TMDB ID and title if not provided
        let tmdbIdNum: number;
        let contentTitle = contentName || '';

        if (tmdbId) {
            tmdbIdNum = tmdbId;
        } else {
            const tmdbResult = await imdbToTmdb(imdbId, type);
            if (!tmdbResult) {
                console.log(`[TrailerProvider] Could not find TMDB ID for ${imdbId}`);
                return [];
            }
            tmdbIdNum = tmdbResult.id;
            // Use title from TMDB if not provided
            if (!contentTitle) {
                contentTitle = tmdbResult.title;
            }
        }

        let videos: TMDBVideo[] = [];
        let language = 'ITA';
        let trailerType = type === 'series' ? 'Serie' : 'Film';

        // For series with season, try season-specific first
        if (type === 'series' && season !== undefined && season > 0) {
            // Try Italian season trailer first
            videos = await fetchTMDBVideos(tmdbIdNum, type, 'it-IT', season);

            // Fallback to English season trailer
            if (!videos || videos.length === 0) {
                videos = await fetchTMDBVideos(tmdbIdNum, type, 'en-US', season);
                language = 'ENG';
            }

            // If season trailer found, use it
            if (videos && videos.length > 0) {
                trailerType = `Stagione ${season}`;
                console.log(`[TrailerProvider] Found ${language} S${season} trailer for ${imdbId}`);
            }
        }

        // Fallback to series/movie trailer if no season trailer
        if (!videos || videos.length === 0) {
            language = 'ITA';
            videos = await fetchTMDBVideos(tmdbIdNum, type, 'it-IT');

            if (!videos || videos.length === 0) {
                videos = await fetchTMDBVideos(tmdbIdNum, type, 'en-US');
                language = 'ENG';
            }
            trailerType = type === 'series' ? 'Serie' : 'Film';
        }

        // Select best trailer
        const trailer = selectBestTrailer(videos);
        if (!trailer) {
            console.log(`[TrailerProvider] No trailer found for ${imdbId}`);
            return [];
        }

        console.log(`[TrailerProvider] Found ${language} trailer for "${contentTitle}": ${trailer.name}`);

        // Format title: use content title (from TMDB or provided)
        // For series with season, append "Stagione X"
        // Example: "Interstellar" for movies, "Mercoledì Stagione 2" for series
        let displayTitle = contentTitle || `Trailer ${trailerType} ${language}`;
        if (type === 'series' && season !== undefined && season > 0 && contentTitle) {
            displayTitle = `${contentTitle} Stagione ${season}`;
        }

        // Create Stremio stream object with new format
        // Add English flag when trailer is not in Italian
        const streamName = language === 'ENG' ? '🎬▶️🇬🇧 Trailer' : '🎬▶️ Trailer';

        const stream: StremioStream = {
            name: streamName,
            title: displayTitle,
            ytId: trailer.key,
            behaviorHints: {
                notWebReady: true,
                bingeGroup: 'trailer'
            }
        };

        return [stream];

    } catch (e) {
        console.error('[TrailerProvider] Error getting trailer streams:', e);
        return [];
    }
}

/**
 * Check if trailer provider is available
 */
export function isTrailerProviderAvailable(): boolean {
    return !!TMDB_KEY;
}

