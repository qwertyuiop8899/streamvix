/**
 * TMDB Trailer Provider with YouTube Fallback
 * Flow: TMDB it-IT → YouTube Search (validated) → TMDB en-US
 * Returns Stremio-compatible Stream objects
 */

import fetch from 'node-fetch';

// TMDB API configuration
const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_KEY = process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0';

// Trailer source types
type TrailerSource = 'tmdb-it' | 'youtube' | 'tmdb-en';

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

interface TrailerResult {
    ytId: string;
    title: string;
    source: TrailerSource;
}

/**
 * Convert IMDb ID to TMDB ID and get title
 */
async function imdbToTmdb(imdbId: string, type: 'movie' | 'series'): Promise<{ id: number; title: string } | null> {
    if (!TMDB_KEY) return null;

    try {
        const url = `${TMDB_BASE}/find/${imdbId}?api_key=${TMDB_KEY}&external_source=imdb_id&language=it-IT`;
        const response = await fetch(url);
        const data = await response.json() as any;

        const results = type === 'series' ? data.tv_results : data.movie_results;
        if (results && results.length > 0) {
            const item = results[0];
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
 */
function selectBestTrailer(videos: TMDBVideo[]): TMDBVideo | null {
    if (!videos || videos.length === 0) return null;

    const youtubeVideos = videos.filter(v => v.site === 'YouTube');
    if (youtubeVideos.length === 0) return null;

    const typePriority = ['Trailer', 'Teaser', 'Clip'];

    for (const type of typePriority) {
        const official = youtubeVideos.find(v => v.type === type && v.official);
        if (official) return official;
    }

    for (const type of typePriority) {
        const video = youtubeVideos.find(v => v.type === type);
        if (video) return video;
    }

    return youtubeVideos[0];
}

/**
 * Number words in Italian for validation
 */
const numberWords: { [key: number]: string[] } = {
    1: ['1', 'uno', 'one', 'prima', 'first'],
    2: ['2', 'due', 'two', 'seconda', 'second'],
    3: ['3', 'tre', 'three', 'terza', 'third'],
    4: ['4', 'quattro', 'four', 'quarta', 'fourth'],
    5: ['5', 'cinque', 'five', 'quinta', 'fifth'],
    6: ['6', 'sei', 'six', 'sesta', 'sixth'],
    7: ['7', 'sette', 'seven', 'settima', 'seventh'],
    8: ['8', 'otto', 'eight', 'ottava', 'eighth'],
    9: ['9', 'nove', 'nine', 'nona', 'ninth'],
    10: ['10', 'dieci', 'ten', 'decima', 'tenth'],
};

/**
 * Validate YouTube video title against expected content
 */
function validateYouTubeTitle(videoTitle: string, contentName: string, season?: number): boolean {
    const titleLower = videoTitle.toLowerCase();
    const contentLower = contentName.toLowerCase();

    // Must contain the content name (movie/series title)
    if (!titleLower.includes(contentLower)) {
        return false;
    }

    // For series with season: accept if has season number OR if it's a generic series trailer
    // We accept generic trailers too (without season number)
    if (season !== undefined && season > 0) {
        const seasonWords = numberWords[season] || [season.toString()];
        const hasSeasonNumber = seasonWords.some(word => titleLower.includes(word.toLowerCase()));
        // Accept either: has season number OR it's just a trailer for the series (no specific season)
        // Both are valid
        return true; // If content name matches, we accept it
    }

    return true;
}

/**
 * Search YouTube using Data API v3 (primary method)
 * Uses YOUTUBE_API_KEY env variable with fallback to default key
 */
async function searchYouTubeAPI(
    query: string
): Promise<{ ytId: string; title: string } | null> {
    const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';
    if (!YOUTUBE_API_KEY) {
        console.log('[TrailerProvider] YOUTUBE_API_KEY not set, skipping API search');
        return null;
    }

    try {
        const encodedQuery = encodeURIComponent(query);
        const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodedQuery}&type=video&maxResults=1&key=${YOUTUBE_API_KEY}`;

        console.log(`[TrailerProvider] YouTube API search: ${query}`);

        const response = await fetch(url);
        if (response.status !== 200) {
            const errorText = await response.text();
            console.log(`[TrailerProvider] YouTube API error: ${response.status} - ${errorText}`);
            return null;
        }

        const data = await response.json() as any;

        if (data.items && data.items.length > 0) {
            const video = data.items[0];
            const ytId = video.id.videoId;
            const title = video.snippet.title;

            console.log(`[TrailerProvider] YouTube API found: "${title}" (${ytId})`);
            return { ytId, title };
        }

        console.log('[TrailerProvider] YouTube API returned no results');
        return null;

    } catch (e) {
        console.error('[TrailerProvider] YouTube API error:', e);
        return null;
    }
}

/**
 * Search YouTube using HTML scraping (fallback method)
 */
async function searchYouTubeScraping(
    query: string
): Promise<{ ytId: string; title: string } | null> {
    try {
        const encodedQuery = encodeURIComponent(query);
        const url = `https://www.youtube.com/results?search_query=${encodedQuery}`;

        console.log(`[TrailerProvider] YouTube scraping search: ${query}`);

        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        if (response.status !== 200) {
            console.log('[TrailerProvider] YouTube scraping failed:', response.status);
            return null;
        }

        const html = await response.text();

        // Extract video ID
        const videoIdMatch = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
        if (!videoIdMatch) {
            console.log('[TrailerProvider] No video ID found in YouTube HTML');
            return null;
        }

        const ytId = videoIdMatch[1];

        // Try to extract title
        let videoTitle = '';
        const titleMatch = html.match(/"title":\s*{\s*"runs":\s*\[\s*{\s*"text":\s*"([^"]+)"/);
        if (titleMatch) {
            videoTitle = titleMatch[1];
        } else {
            const simpleTitleMatch = html.match(/"title":\s*"([^"]+)"/);
            if (simpleTitleMatch) {
                videoTitle = simpleTitleMatch[1];
            }
        }

        if (!videoTitle) {
            console.log('[TrailerProvider] Could not extract title from YouTube HTML');
            return null;
        }

        // Decode HTML entities
        videoTitle = videoTitle
            .replace(/\\u0026/g, '&')
            .replace(/\\"/g, '"')
            .replace(/\\\\/g, '\\');

        console.log(`[TrailerProvider] YouTube scraping found: "${videoTitle}" (${ytId})`);
        return { ytId, title: videoTitle };

    } catch (e) {
        console.error('[TrailerProvider] YouTube scraping error:', e);
        return null;
    }
}

/**
 * Search YouTube for a trailer and return video ID + title if valid
 * Flow: YouTube Data API v3 → HTML Scraping fallback
 */
async function searchYouTubeTrailer(
    contentName: string,
    type: 'movie' | 'series',
    season?: number
): Promise<{ ytId: string; title: string } | null> {
    // Build search query
    let query: string;
    if (type === 'series' && season !== undefined && season > 0) {
        query = `${contentName} stagione ${season} trailer ita`;
    } else {
        query = `${contentName} trailer ita`;
    }

    // Step 1: Try YouTube Data API v3 (stable, official)
    let result = await searchYouTubeAPI(query);

    // Step 2: Fallback to HTML scraping
    if (!result) {
        console.log('[TrailerProvider] Falling back to YouTube scraping');
        result = await searchYouTubeScraping(query);
    }

    if (!result) {
        return null;
    }

    // Validate the title
    if (!validateYouTubeTitle(result.title, contentName, season)) {
        console.log(`[TrailerProvider] YouTube result rejected: title doesn't match "${contentName}"`);
        return null;
    }

    console.log(`[TrailerProvider] YouTube result accepted: "${result.title}"`);
    return result;
}

/**
 * Get trailer streams for a movie or TV series
 * Flow: TMDB it-IT → YouTube (validated) → TMDB en-US
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
        // Get TMDB ID and title
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
            if (!contentTitle) {
                contentTitle = tmdbResult.title;
            }
        }

        let trailerResult: TrailerResult | null = null;

        // === STEP 1: Try TMDB Italian ===
        console.log(`[TrailerProvider] Step 1: Trying TMDB it-IT for "${contentTitle}"`);

        let videos: TMDBVideo[] = [];

        // For series with season, try season-specific first
        if (type === 'series' && season !== undefined && season > 0) {
            videos = await fetchTMDBVideos(tmdbIdNum, type, 'it-IT', season);
            if (!videos || videos.length === 0) {
                // Try series general
                videos = await fetchTMDBVideos(tmdbIdNum, type, 'it-IT');
            }
        } else {
            videos = await fetchTMDBVideos(tmdbIdNum, type, 'it-IT');
        }

        const tmdbItTrailer = selectBestTrailer(videos);
        if (tmdbItTrailer) {
            console.log(`[TrailerProvider] ✓ Found TMDB it-IT trailer: ${tmdbItTrailer.name}`);
            trailerResult = {
                ytId: tmdbItTrailer.key,
                title: type === 'series' && season ? `${contentTitle} Stagione ${season}` : contentTitle,
                source: 'tmdb-it'
            };
        }

        // === STEP 2: YouTube Fallback ===
        if (!trailerResult) {
            console.log(`[TrailerProvider] Step 2: Trying YouTube for "${contentTitle}"`);

            const ytResult = await searchYouTubeTrailer(contentTitle, type, season);
            if (ytResult) {
                console.log(`[TrailerProvider] ✓ Found YouTube trailer: ${ytResult.title}`);
                trailerResult = {
                    ytId: ytResult.ytId,
                    title: ytResult.title,  // Use YouTube video title
                    source: 'youtube'
                };
            }
        }

        // === STEP 3: TMDB English Fallback ===
        if (!trailerResult) {
            console.log(`[TrailerProvider] Step 3: Trying TMDB en-US for "${contentTitle}"`);

            let enVideos: TMDBVideo[] = [];

            if (type === 'series' && season !== undefined && season > 0) {
                enVideos = await fetchTMDBVideos(tmdbIdNum, type, 'en-US', season);
                if (!enVideos || enVideos.length === 0) {
                    enVideos = await fetchTMDBVideos(tmdbIdNum, type, 'en-US');
                }
            } else {
                enVideos = await fetchTMDBVideos(tmdbIdNum, type, 'en-US');
            }

            const tmdbEnTrailer = selectBestTrailer(enVideos);
            if (tmdbEnTrailer) {
                console.log(`[TrailerProvider] ✓ Found TMDB en-US trailer: ${tmdbEnTrailer.name}`);
                trailerResult = {
                    ytId: tmdbEnTrailer.key,
                    title: type === 'series' && season ? `${contentTitle} Stagione ${season}` : contentTitle,
                    source: 'tmdb-en'
                };
            }
        }

        // No trailer found
        if (!trailerResult) {
            console.log(`[TrailerProvider] ✗ No trailer found for ${imdbId}`);
            return [];
        }

        // Build stream name based on source
        let streamName: string;
        switch (trailerResult.source) {
            case 'tmdb-it':
                streamName = '🎬 Trailer';
                break;
            case 'youtube':
                streamName = '🎬▶️ Trailer';
                break;
            case 'tmdb-en':
                streamName = '🎬🇬🇧 Trailer';
                break;
        }

        console.log(`[TrailerProvider] Final: ${streamName} | ${trailerResult.title} (${trailerResult.source})`);

        const stream: StremioStream = {
            name: streamName,
            title: trailerResult.title,
            ytId: trailerResult.ytId,
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
