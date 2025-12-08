
import axios from 'axios';
import * as cheerio from 'cheerio';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as crypto from 'crypto';
import { Stream } from 'stremio-addon-sdk';
import { buildUnifiedStreamName, providerLabel } from '../utils/unifiedNames';

// Config constants
// const GS_DOMAIN = "https://guardoserie.wtf"; 
const TARGET_DOMAIN = "https://guardoserie.me";

const jar = new CookieJar();
const client = wrapper(axios.create({
    jar,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Origin': TARGET_DOMAIN,
        'Referer': `${TARGET_DOMAIN}/`
    }
}));


// --- LOADM EXTRACTOR ---
const KEY = Buffer.from('kiemtienmua911ca', 'utf-8');
const IV = Buffer.from('1234567890oiuytr', 'utf-8');

async function extractLoadM(playerUrl: string, referer: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream | null> {
    try {
        const parts = playerUrl.split('#');
        const id = parts[1];
        const playerDomain = new URL(playerUrl).origin;
        const apiUrl = `${playerDomain}/api/v1/video`;

        const response = await client.get(apiUrl, {
            headers: { 'Referer': playerUrl },
            params: { id, w: '2560', h: '1440', r: referer },
            responseType: 'text'
        });

        const hexData = response.data;
        const cleanHex = hexData.replace(/[^0-9a-fA-F]/g, '');
        if (!cleanHex || cleanHex.length === 0) return null;

        const encryptedBytes = Buffer.from(cleanHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
        decipher.setAutoPadding(false);

        let decrypted = Buffer.concat([decipher.update(encryptedBytes), decipher.final()]);
        const padLen = decrypted[decrypted.length - 1];
        if (padLen >= 1 && padLen <= 16) {
            decrypted = decrypted.subarray(0, decrypted.length - padLen);
        }

        const jsonStr = decrypted.toString('utf-8');
        const data = JSON.parse(jsonStr);
        const hls = data['cf'];
        const title = data['title'] || 'Stream';

        if (hls) {
            let finalUrl = hls;

            // Wrap in MFP if configured
            if (mfpUrl) {
                const proxyUrl = `${mfpUrl.replace(/\/+$/, '')}/proxy/hls/manifest.m3u8`;
                const params = new URLSearchParams();
                params.append('d', hls);
                if (mfpPsw) params.append('api_password', mfpPsw);

                // Pass headers to MFP
                params.append('h_Referer', playerUrl);
                params.append('h_Origin', playerDomain);
                params.append('h_User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

                finalUrl = `${proxyUrl}?${params.toString()}`;
            }

            return {
                name: providerLabel('guardoserie'),
                title: buildUnifiedStreamName({
                    baseTitle: title,
                    isSub: false,
                    proxyOn: !!mfpUrl,
                    provider: 'guardoserie',
                    playerName: 'LoadM',
                    hideProviderInTitle: true
                }),
                url: finalUrl,
                behaviorHints: {
                    notWebReady: true,
                    proxyHeaders: {
                        request: {
                            "Referer": playerUrl,
                            "Origin": playerDomain,
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
                        }
                    }
                }
            };
        }
    } catch (e) {
        console.error(`[Guardoserie] LoadM extraction failed: ${e}`);
    }
    return null;
}

// --- SEARCH & SCRAPE ---

async function searchGuardoserie(query: string, year: string): Promise<string | null> {
    try {
        const searchUrl = `${TARGET_DOMAIN}/wp-admin/admin-ajax.php`;
        const params = new URLSearchParams();
        params.append('s', query);
        params.append('action', 'searchwp_live_search');
        params.append('swpengine', 'default');
        params.append('swpquery', query);

        const res = await client.post(searchUrl, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
        });

        // Response is HTML snippet
        const $ = cheerio.load(res.data);
        const links = $('a.ss-title');

        for (const link of links) {
            const href = $(link).attr('href');
            if (!href) continue;

            const pageRes = await client.get(href);
            const pageHtml = pageRes.data;

            // Primitive year check
            if (year && pageHtml.includes(`>${year}<`)) {
                return href;
            } else if (!year) {
                return href; // Return first match if no year
            }
        }
    } catch (e) {
        console.error(`[Guardoserie] Search failed: ${e}`);
    }
    return null;
}

async function getEpisodeLink(seriesUrl: string, season: number, episode: number): Promise<string | null> {
    try {
        const res = await client.get(seriesUrl);
        const $ = cheerio.load(res.data);

        // MammaMia logic: div.les-content (one per season) -> a tags (episodes)
        const seasons = $('div.les-content');
        if (seasons.length < season) return null;

        const seasonDiv = seasons.eq(season - 1);
        const episodeLinks = seasonDiv.find('a');
        if (episodeLinks.length < episode) return null;

        const epLink = episodeLinks.eq(episode - 1).attr('href');
        return epLink || null;
    } catch (e) {
        console.error(`[Guardoserie] Get episode failed: ${e}`);
    }
    return null;
}

async function resolvePageStream(pageUrl: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    const streams: Stream[] = [];
    try {
        const res = await client.get(pageUrl);
        const $ = cheerio.load(res.data);

        // Look for iframes
        const iframes = $('iframe');

        for (const iframe of iframes) {
            let src = $(iframe).attr('data-src') || $(iframe).attr('src');
            if (!src) continue;

            if (src.startsWith('//')) src = 'https:' + src;

            if (src.includes('loadm.cam') || src.includes('loadm')) {
                const stream = await extractLoadM(src, pageUrl, mfpUrl, mfpPsw);
                if (stream) streams.push(stream);
            }
        }
    } catch (e) {
        console.error(`[Guardoserie] Resolve page failed: ${e}`);
    }
    return streams;
}

// --- HELPER: TMDB ---
async function getTmdbTitle(type: string, paramId: string, tmdbApiKey?: string): Promise<{ name: string, year: string } | null> {
    try {
        const apiKey = tmdbApiKey || '40a9faa1f6741afb2c0c40238d85f8d0';
        const imdbId = paramId.split(':')[0];

        let url: string;
        // Check if paramId is tmdb:... but usually it is imdb (tt...)
        if (paramId.startsWith('tmdb:')) {
            const tmdbId = paramId.replace('tmdb:', '');
            url = `https://api.themoviedb.org/3/${type === 'series' ? 'tv' : 'movie'}/${tmdbId}?api_key=${apiKey}&language=it-IT`;
        } else {
            // Find by IMDB ID
            url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id&language=it-IT`;
        }

        console.log(`[Guardoserie] Fetching TMDB info from: ${url}`);
        const res = await axios.get(url, { timeout: 5000 });

        if (paramId.startsWith('tmdb:')) {
            const data = res.data;
            const name = data.title || data.name || data.original_title || data.original_name;
            const date = data.release_date || data.first_air_date || '';
            const year = date.split('-')[0];
            return { name, year };
        } else {
            // Find results
            const results = type === 'series' ? res.data.tv_results : res.data.movie_results;
            if (results && results.length > 0) {
                const data = results[0];
                const name = data.title || data.name || data.original_title || data.original_name;
                const date = data.release_date || data.first_air_date || '';
                const year = date.split('-')[0];
                return { name, year };
            }
        }

    } catch (e) {
        console.error(`[Guardoserie] TMDB fetch failed: ${e}`);
    }
    return null;
}

// --- HELPER: CINEMETA (Fallback) ---
async function getCinemetaMeta(type: string, paramId: string): Promise<{ name: string, year: string } | null> {
    const imdbId = paramId.split(':')[0]; // tt12345
    try {
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
        console.log(`[Guardoserie] Fetching Cinemeta from: ${url}`);
        const res = await axios.get(url);
        if (res.data && res.data.meta) {
            return {
                name: res.data.meta.name,
                year: res.data.meta.year || (res.data.meta.releaseInfo || '').split('-')[0]
            };
        }
    } catch (e) {
        console.error(`[Guardoserie] Cinemeta fetch failed: ${e}`);
    }
    return null;
}

// --- PUBLIC INTERFACE ---

export async function getGuardoserieStreams(type: string, id: string, tmdbApiKey?: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    if (type !== 'series' && type !== 'movie') return [];

    console.log(`[Guardoserie] Requesting: ${id} (${type})`);

    let imdbId = id;
    let season = 1;
    let episode = 1;

    if (id.includes(':')) {
        const p = id.split(':');
        imdbId = p[0];
        season = parseInt(p[1]);
        episode = parseInt(p[2]);
    }

    // Fetch Metadata (TMDB Priority for Italian Title)
    let name = '';
    let year = '';

    const tmdbMeta = await getTmdbTitle(type, imdbId, tmdbApiKey);
    if (tmdbMeta) {
        name = tmdbMeta.name;
        year = tmdbMeta.year;
        console.log(`[Guardoserie] TMDB (IT) found: ${name} (${year})`);
    } else {
        // Fallback to Cinemeta
        const meta = await getCinemetaMeta(type, imdbId);
        if (meta) {
            name = meta.name;
            year = meta.year ? (String(meta.year).match(/\d{4}/)?.[0] || '') : '';
            console.log(`[Guardoserie] Cinemeta (Fallback) found: ${name} (${year})`);
        }
    }

    if (!name) {
        console.log(`[Guardoserie] Meta not found for ${imdbId}, skipping.`);
        return [];
    }

    const seriesUrl = await searchGuardoserie(name, year);
    if (!seriesUrl) {
        console.log(`[Guardoserie] Not found on site (IT): ${name}`);

        // Fallback: Try English title if we used TMDB (IT)
        if (tmdbMeta) {
            const engMeta = await getCinemetaMeta(type, imdbId);
            if (engMeta && engMeta.name !== name) {
                console.log(`[Guardoserie] Trying fallback with English title: ${engMeta.name}`);
                const engUrl = await searchGuardoserie(engMeta.name, year);
                if (engUrl) {
                    console.log(`✅ [Guardoserie] Found with English title!`);
                    const targetUrl = type === 'series'
                        ? (await getEpisodeLink(engUrl, season, episode)) || engUrl
                        : engUrl;
                    return await resolvePageStream(targetUrl, mfpUrl, mfpPsw);
                }
            }
        }
        return [];
    }

    let targetUrl = seriesUrl;
    if (type === 'series') {
        const epLink = await getEpisodeLink(seriesUrl, season, episode);
        if (!epLink) {
            console.log(`[Guardoserie] Episode not found: S${season}E${episode}`);
            return [];
        }
        targetUrl = epLink;
    }

    return await resolvePageStream(targetUrl, mfpUrl, mfpPsw);
}
