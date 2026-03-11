
import axios from 'axios';
import * as cheerio from 'cheerio';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as crypto from 'crypto';
import { Stream } from 'stremio-addon-sdk';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { buildUnifiedStreamName, providerLabel } from '../utils/unifiedNames';
import { getDomain } from '../utils/domains';

// Config constants - dynamic domain from domains.json
const getTargetDomain = () => `https://${getDomain('guardoserie') || 'guardoserie.digital'}`;

const jar = new CookieJar();

function createClient() {
    const config = {
        jar,
        proxy: false as false,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Origin': getTargetDomain(),
            'Referer': `${getTargetDomain()}/`
        }
    };

    return wrapper(axios.create(config));
}

// Main client (direct)
const client = createClient();

function getClient() {
    return client;
}

const PROXY2 = process.env.PROXY2;

// Helper to fetch with bypass
async function fetchWithBypass(url: string, options: any = {}): Promise<any> {
    try {
        // 1. Try direct fetch with short timeout (2s)
        return await getClient().get(url, { 
            ...options, 
            timeout: 2000 
        });
    } catch (e: any) {
        // Check if it's a block (403/400) or a timeout/network error
        if (e.response?.status === 403 || e.response?.status === 400 || !e.response || e.code === 'ECONNABORTED' || e.message === 'timeout exceeded') {
            
            if (!PROXY2) {
                console.log(`[Guardoserie] Blocked or timeout on ${url}, but PROXY2 is not set. Aborting.`);
                throw e;
            }

            console.log(`[Guardoserie] Blocked or timeout on ${url} (${e.response?.status || e.code || 'TIMEOUT'}), trying PROXY2 bypass...`);
            
            // Build the full URL including params
            let finalTargetUrl = url;
            try {
                if (options.params) {
                    const urlObj = new URL(url);
                    for (const [key, value] of Object.entries(options.params)) {
                        urlObj.searchParams.append(key, String(value));
                    }
                    finalTargetUrl = urlObj.toString();
                }
            } catch (urlErr) {
                console.error('[Guardoserie] Error rebuilding URL with params:', urlErr);
            }

            // 2. Try with PROXY2 (4s timeout)
            try {
                const proxyAgent = new HttpsProxyAgent(PROXY2);
                const proxyRes = await axios.get(finalTargetUrl, {
                    ...options,
                    httpsAgent: proxyAgent,
                    proxy: false,
                    timeout: 4000
                });
                console.log(`[Guardoserie] PROXY2 bypass success for ${url}`);
                return proxyRes;
            } catch (proxyErr: any) {
                console.error(`[Guardoserie] PROXY2 bypass failed for ${url}: ${proxyErr.message}. Aborting.`);
                throw proxyErr;
            }
        }
        throw e;
    }
}

// --- LOADM EXTRACTOR ---
const KEY = Buffer.from('kiemtienmua911ca', 'utf-8');
const IV = Buffer.from('1234567890oiuytr', 'utf-8');

async function extractLoadM(playerUrl: string, referer: string, mfpUrl?: string, mfpPsw?: string, isSub: boolean = false): Promise<Stream | null> {
    try {
        const parts = playerUrl.split('#');
        const id = parts[1];
        const playerDomain = new URL(playerUrl).origin;
        const apiUrl = `${playerDomain}/api/v1/video`;

        const response = await fetchWithBypass(apiUrl, {
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

            if (mfpUrl) {
                const proxyUrl = `${mfpUrl.replace(/\/+$/, '')}/proxy/hls/manifest.m3u8`;
                const params = new URLSearchParams();
                params.append('d', hls);
                if (mfpPsw) params.append('api_password', mfpPsw);
                params.append('h_Referer', playerUrl);
                params.append('h_Origin', playerDomain);
                params.append('h_User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
                finalUrl = `${proxyUrl}?${params.toString()}`;
            }

            return {
                name: providerLabel('guardoserie'),
                title: buildUnifiedStreamName({
                    baseTitle: title,
                    isSub: isSub,
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

async function getGuardoserieStreamsCore(type: string, id: string, tmdbApiKey?: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    if (type !== 'series') return [];

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

    let name = '';
    let year = '';

    const tmdbMeta = await getTmdbTitle(type, imdbId, tmdbApiKey);
    if (tmdbMeta) {
        name = tmdbMeta.name;
        year = tmdbMeta.year;
        console.log(`[Guardoserie] TMDB (IT) found: ${name} (${year})`);
    } else {
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

export async function getGuardoserieStreams(type: string, id: string, tmdbApiKey?: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    return await getGuardoserieStreamsCore(type, id, tmdbApiKey, mfpUrl, mfpPsw);
}

async function searchGuardoserie(query: string, year: string): Promise<string | null> {
    try {
        const searchUrl = `${getTargetDomain()}/?s=${encodeURIComponent(query)}`;
        console.log('[Guardoserie] Direct search:', searchUrl);

        const res = await fetchWithBypass(searchUrl);
        const $ = cheerio.load(res.data);

        const queryLower = query.toLowerCase().replace(/[^a-z0-9]/g, '');

        const allLinks: { href: string, text: string }[] = [];
        $('a[href*="/serie/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href || href === '#') return;
            if (/\/serie\/?$/.test(href)) return;
            if (!/\/serie\/[a-z0-9-]+/i.test(href)) return;

            const text = $(el).text().trim();
            allLinks.push({ href: href.startsWith('http') ? href : `${getTargetDomain()}${href}`, text });
        });

        for (const { href, text } of allLinks) {
            const textLower = text.toLowerCase().replace(/[^a-z0-9]/g, '');
            const hrefLower = href.toLowerCase();

            if (textLower.includes(queryLower) || hrefLower.includes(queryLower)) {
                if (year && (text.includes(year) || href.includes(year))) {
                    return href;
                } else if (!year) {
                    return href;
                }
            }
        }

        if (allLinks.length > 0) return allLinks[0].href;
    } catch (e) {
        console.error(`[Guardoserie] Search failed: ${e}`);
    }
    return null;
}

async function getEpisodeLink(seriesUrl: string, season: number, episode: number): Promise<string | null> {
    try {
        const res = await fetchWithBypass(seriesUrl);
        const $ = cheerio.load(res.data);
        const seasons = $('div.les-content');
        if (seasons.length < season) return null;

        const seasonDiv = seasons.eq(season - 1);
        const episodeLinks = seasonDiv.find('a');
        if (episodeLinks.length < episode) return null;

        return episodeLinks.eq(episode - 1).attr('href') || null;
    } catch (e) {
        console.error(`[Guardoserie] Get episode failed: ${e}`);
    }
    return null;
}

async function resolvePageStream(pageUrl: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    const streams: Stream[] = [];
    try {
        const res = await fetchWithBypass(pageUrl);
        const $ = cheerio.load(res.data);

        const tabLangMap: Record<string, 'ITA' | 'SUB'> = {};
        $('.idTabs .les-content a, .player_nav .les-content a').each((_, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().toLowerCase();
            if (href && href.startsWith('#tab')) {
                const tabId = href.substring(1);
                if (text.includes('sub')) tabLangMap[tabId] = 'SUB';
                else if (text.includes('ita')) tabLangMap[tabId] = 'ITA';
            }
        });

        const tabDivs = $('#player2 > div[id^="tab"]');
        for (const tabDiv of tabDivs) {
            const tabId = $(tabDiv).attr('id') || '';
            const lang = tabLangMap[tabId] || 'ITA';
            const isSub = lang === 'SUB';
            const iframes = $(tabDiv).find('iframe');
            for (const iframe of iframes) {
                let src = $(iframe).attr('data-src') || $(iframe).attr('src');
                if (src) {
                    if (src.startsWith('//')) src = 'https:' + src;
                    if (src.includes('loadm')) {
                        const stream = await extractLoadM(src, pageUrl, mfpUrl, mfpPsw, isSub);
                        if (stream) streams.push(stream);
                    }
                }
            }
        }

        if (streams.length === 0) {
            const iframes = $('iframe');
            for (const iframe of iframes) {
                let src = $(iframe).attr('data-src') || $(iframe).attr('src');
                if (src) {
                    if (src.startsWith('//')) src = 'https:' + src;
                    if (src.includes('loadm')) {
                        const stream = await extractLoadM(src, pageUrl, mfpUrl, mfpPsw, false);
                        if (stream) streams.push(stream);
                    }
                }
            }
        }
    } catch (e) {
        console.error(`[Guardoserie] Resolve page failed: ${e}`);
    }
    return streams;
}

async function getTmdbTitle(type: string, imdbId: string, tmdbApiKey?: string): Promise<{ name: string, year: string } | null> {
    try {
        const apiKey = tmdbApiKey || '40a9faa1f6741afb2c0c40238d85f8d0';
        const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id&language=it-IT`;
        const res = await axios.get(url, { timeout: 5000 });
        const results = type === 'series' ? res.data.tv_results : res.data.movie_results;
        if (results && results.length > 0) {
            const data = results[0];
            return {
                name: data.title || data.name || data.original_title || data.original_name,
                year: (data.release_date || data.first_air_date || '').split('-')[0]
            };
        }
    } catch (e) {}
    return null;
}

async function getCinemetaMeta(type: string, imdbId: string): Promise<{ name: string, year: string } | null> {
    try {
        const url = `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`;
        const res = await axios.get(url, { timeout: 5000 });
        if (res.data && res.data.meta) {
            return {
                name: res.data.meta.name,
                year: (res.data.meta.year || (res.data.meta.releaseInfo || '').split('-')[0] || '').toString()
            };
        }
    } catch (e) {}
    return null;
}
