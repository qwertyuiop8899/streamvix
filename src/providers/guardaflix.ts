
import axios from 'axios';
import * as cheerio from 'cheerio';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as crypto from 'crypto';
import { Stream } from 'stremio-addon-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { buildUnifiedStreamName, providerLabel } from '../utils/unifiedNames';

// Config constants
const TARGET_DOMAIN = "https://guardaflix.me";
const NONCE = "20115729b4";

const jar = new CookieJar();

function createClient() {
    const proxyUrl = process.env.PROXY;
    const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

    const config = {
        jar,
        httpsAgent,
        proxy: false as false,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Origin': TARGET_DOMAIN,
            'Referer': `${TARGET_DOMAIN}/`
        }
    };

    const instance = axios.create(config);

    if (httpsAgent) {
        instance.interceptors.request.use(async (config) => {
            const cookieString = await jar.getCookieString(config.url || '');
            if (cookieString) {
                config.headers.set('Cookie', cookieString);
            }
            return config;
        });

        instance.interceptors.response.use(async (response) => {
            if (response.headers['set-cookie']) {
                const cookies = response.headers['set-cookie'];
                const url = response.config.url || '';
                if (Array.isArray(cookies)) {
                    for (const cookie of cookies) {
                        try { await jar.setCookie(cookie, url); } catch { }
                    }
                } else {
                    try { await jar.setCookie(cookies, url); } catch { }
                }
            }
            return response;
        });

        return instance;
    }

    return wrapper(instance);
}

const client = createClient();

// --- LOADM EXTRACTOR (Duplicated from Guardoserie as requested) ---
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
                name: providerLabel('guardaflix'),
                title: buildUnifiedStreamName({
                    baseTitle: title,
                    isSub: false,
                    proxyOn: !!mfpUrl,
                    provider: 'guardaflix',
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
        console.error(`[Guardaflix] LoadM extraction failed: ${e}`);
    }
    return null;
}

// --- SEARCH & SCRAPE ---

async function searchGuardaflix(query: string, year: string): Promise<string | null> {
    try {
        const searchUrl = `${TARGET_DOMAIN}/wp-admin/admin-ajax.php`;
        const params = new URLSearchParams();
        params.append('action', 'action_tr_search_suggest');
        params.append('nonce', NONCE);
        params.append('term', query);

        const res = await client.post(searchUrl, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' }
        });

        const $ = cheerio.load(res.data);
        // HTML: <li class="fa-play-circle"><a href="...">...</a></li>
        const links = $('li a'); // Select all links in lists

        for (const link of links) {
            const href = $(link).attr('href');
            if (!href) continue;

            const pageRes = await client.get(href);
            const pageHtml = pageRes.data;
            const $page = cheerio.load(pageHtml);

            // Year check
            // MammaMia: soup.find('span',class_='year fa-calendar far').text
            // In Cheerio: span.year.fa-calendar.far
            const pageYear = $page('span.year.fa-calendar.far').text().trim();

            // Allow loose match or check if year is contained
            if (year && (pageYear === year || pageYear.includes(year) || pageHtml.includes(`>${year}<`))) {
                return href;
            } else if (!year) {
                return href;
            }
        }
    } catch (e) {
        console.error(`[Guardaflix] Search failed: ${e}`);
    }
    return null;
}

async function resolvePageStream(pageUrl: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    const streams: Stream[] = [];
    try {
        const res = await client.get(pageUrl);
        const $ = cheerio.load(res.data);

        // Look for iframes
        // Look for iframes
        const iframes = $('iframe');

        for (const iframe of iframes) {
            let src = $(iframe).attr('data-src') || $(iframe).attr('src');
            if (!src) continue;

            if (src.startsWith('//')) src = 'https:' + src;

            // Direct LoadM
            if (src.includes('loadm.cam') || src.includes('loadm')) {
                const stream = await extractLoadM(src, pageUrl, mfpUrl, mfpPsw);
                if (stream) streams.push(stream);
            }
            // Recursive Embed (trembed)
            else if (src.includes('trembed=')) {
                console.log(`[Guardaflix] Inspecting embed: ${src}`);
                try {
                    const embedRes = await client.get(src, { headers: { 'Referer': pageUrl } });
                    const $embed = cheerio.load(embedRes.data);
                    const nestedIframes = $embed('iframe');
                    for (const nested of nestedIframes) {
                        let nSrc = $(nested).attr('data-src') || $(nested).attr('src');
                        if (nSrc) {
                            if (nSrc.startsWith('//')) nSrc = 'https:' + nSrc;
                            if (nSrc.includes('loadm.cam') || nSrc.includes('loadm')) {
                                const stream = await extractLoadM(nSrc, pageUrl, mfpUrl, mfpPsw);
                                if (stream) streams.push(stream);
                            }
                        }
                    }
                } catch (e) {
                    console.error(`[Guardaflix] Failed to inspect embed: ${e}`);
                }
            }
        }
    } catch (e) {
        console.error(`[Guardaflix] Resolve page failed: ${e}`);
    }
    return streams;
}

// --- HELPER: TMDB ---
async function getTmdbTitle(type: string, paramId: string, tmdbApiKey?: string): Promise<{ name: string, year: string } | null> {
    try {
        const apiKey = tmdbApiKey || '40a9faa1f6741afb2c0c40238d85f8d0';
        const imdbId = paramId.split(':')[0];

        let url: string;
        if (paramId.startsWith('tmdb:')) {
            const tmdbId = paramId.replace('tmdb:', '');
            url = `https://api.themoviedb.org/3/${type === 'series' ? 'tv' : 'movie'}/${tmdbId}?api_key=${apiKey}&language=it-IT`;
        } else {
            url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id&language=it-IT`;
        }

        console.log(`[Guardaflix] Fetching TMDB info from: ${url}`);
        const res = await axios.get(url, { timeout: 5000 });

        if (paramId.startsWith('tmdb:')) {
            const data = res.data;
            const name = data.title || data.name || data.original_title || data.original_name;
            const date = data.release_date || data.first_air_date || '';
            const year = date.split('-')[0];
            return { name, year };
        } else {
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
        console.error(`[Guardaflix] TMDB fetch failed: ${e}`);
    }
    return null;
}

async function getCinemetaMeta(type: string, paramId: string): Promise<{ name: string, year: string } | null> {
    const imdbId = paramId.split(':')[0]; // tt12345
    try {
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
        console.log(`[Guardaflix] Fetching Cinemeta from: ${url}`);
        const res = await axios.get(url);
        if (res.data && res.data.meta) {
            return {
                name: res.data.meta.name,
                year: res.data.meta.year || (res.data.meta.releaseInfo || '').split('-')[0]
            };
        }
    } catch (e) {
        console.error(`[Guardaflix] Cinemeta fetch failed: ${e}`);
    }
    return null;
}

// --- PUBLIC INTERFACE ---

export async function getGuardaflixStreams(type: string, id: string, tmdbApiKey?: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    // Only Movies supported for now (matching MammaMia logic?)
    if (type !== 'movie') return [];

    console.log(`[Guardaflix] Requesting: ${id} (${type})`);

    let imdbId = id;
    if (id.includes(':')) {
        imdbId = id.split(':')[0];
    }

    // Fetch Metadata (TMDB)
    const tmdbMeta = await getTmdbTitle(type, imdbId, tmdbApiKey);
    if (!tmdbMeta) {
        console.log(`[Guardaflix] Meta not found for ${imdbId}, skipping.`);
        return [];
    }

    const { name, year } = tmdbMeta;
    console.log(`[Guardaflix] TMDB (IT) found: ${name} (${year})`);

    const pageUrl = await searchGuardaflix(name, year);
    if (!pageUrl) {
        console.log(`[Guardaflix] Not found on site (IT): ${name}`);

        // Fallback: Try English title if we used TMDB (IT)
        if (tmdbMeta) {
            const engMeta = await getCinemetaMeta(type, imdbId);
            if (engMeta && engMeta.name !== name) {
                console.log(`[Guardaflix] Trying fallback with English title: ${engMeta.name}`);
                const engUrl = await searchGuardaflix(engMeta.name, year);
                if (engUrl) {
                    console.log(`✅ [Guardaflix] Found with English title!`);
                    return await resolvePageStream(engUrl, mfpUrl, mfpPsw);
                }
            }
        }
        return [];
    }

    return await resolvePageStream(pageUrl, mfpUrl, mfpPsw);
}

// End of file
