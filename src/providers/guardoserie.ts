
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
const getTargetDomain = () => `https://${getDomain('guardoserie') || 'guardoserie.bar'}`;

const jar = new CookieJar();

function createClient(useProxy: boolean) {
    const proxyUrl = useProxy ? process.env.PROXY : undefined;
    const httpsAgent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;

    const config = {
        jar,
        httpsAgent,
        proxy: false as false,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Origin': getTargetDomain(),
            'Referer': `${getTargetDomain()}/`
        }
    };

    const instance = axios.create(config);

    if (httpsAgent) {
        // Manual cookie handling because axios-cookiejar-support conflicts with httpsAgent
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

// Two clients: no-proxy first, proxy fallback
const clientNoProxy = createClient(false);
const clientWithProxy = process.env.PROXY ? createClient(true) : null;
let useProxyFallback = false; // Switch to proxy after first failure

function getClient() {
    return useProxyFallback && clientWithProxy ? clientWithProxy : clientNoProxy;
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

        const response = await getClient().get(apiUrl, {
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

async function getDynamicNonce(): Promise<string | null> {
    try {
        console.log('[Guardoserie] Fetching homepage for nonce...');
        const res = await getClient().get(getTargetDomain());
        const html = res.data;
        const match = html.match(/"nonce":"([a-z0-9]+)"/i) || html.match(/nonce["']\s*:\s*["']([a-z0-9]+)["']/i);
        if (match) {
            console.log('[Guardoserie] Found nonce:', match[1]);
            return match[1];
        }
        return null;
    } catch (e) {
        console.error(`[Guardoserie] Failed to fetch nonce: ${e}`);
        return null;
    }
}

async function searchGuardoserie(query: string, year: string): Promise<string | null> {
    try {
        // Usa ricerca diretta /?s= invece di admin-ajax.php che restituisce 400
        const searchUrl = `${getTargetDomain()}/?s=${encodeURIComponent(query)}`;
        console.log('[Guardoserie] Direct search:', searchUrl);

        const res = await getClient().get(searchUrl);
        console.log('[GS][Direct] search html length', res.data.length);

        const $ = cheerio.load(res.data);

        // Normalizza query per matching
        const queryLower = query.toLowerCase().replace(/[^a-z0-9]/g, '');

        // Cerca tutti i link che potrebbero essere risultati
        const allLinks: { href: string, text: string }[] = [];
        $('a[href*="/serie/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href || href === '#') return;
            // Filtra link generici (es. /serie/ senza slug)
            if (/\/serie\/?$/.test(href)) return;
            // Deve avere uno slug dopo /serie/
            if (!/\/serie\/[a-z0-9-]+/i.test(href)) return;

            const text = $(el).text().trim();
            allLinks.push({ href, text });
        });

        console.log('[Guardoserie] Found', allLinks.length, 'candidate links');

        // Prima cerca match esatto con query nel titolo o URL
        for (const { href, text } of allLinks) {
            const textLower = text.toLowerCase().replace(/[^a-z0-9]/g, '');
            const hrefLower = href.toLowerCase();

            if (textLower.includes(queryLower) || hrefLower.includes(queryLower)) {
                // Se abbiamo anno, controlla che corrisponda
                if (year && (text.includes(year) || href.includes(year))) {
                    console.log('[Guardoserie] Found with year match:', href);
                    return href;
                } else if (!year) {
                    console.log('[Guardoserie] Found query match:', href);
                    return href;
                }
            }
        }

        // Se nessun match con query, ritorna il primo link valido
        if (allLinks.length > 0) {
            console.log('[Guardoserie] Returning first valid link:', allLinks[0].href);
            return allLinks[0].href;
        }

        console.log('[Guardoserie] No results found in search page');
    } catch (e) {
        console.error(`[Guardoserie] Search failed: ${e}`);
    }
    return null;
}

async function getEpisodeLink(seriesUrl: string, season: number, episode: number): Promise<string | null> {
    try {
        const res = await getClient().get(seriesUrl);
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
        const res = await getClient().get(pageUrl);
        const $ = cheerio.load(res.data);

        // Build tab-to-language mapping from .idTabs
        // e.g., href="#tab1" -> "Server ITA" or "Server Sub-ITA"
        const tabLangMap: Record<string, 'ITA' | 'SUB'> = {};
        $('.idTabs .les-content a, .player_nav .les-content a').each((_, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().toLowerCase();
            if (href && href.startsWith('#tab')) {
                const tabId = href.substring(1); // Remove #
                if (text.includes('sub')) {
                    tabLangMap[tabId] = 'SUB';
                } else if (text.includes('ita')) {
                    tabLangMap[tabId] = 'ITA';
                }
            }
        });
        console.log('[Guardoserie] Tab language mapping:', tabLangMap);

        // Iterate over tabs and their iframes
        const tabDivs = $('#player2 > div[id^="tab"]');
        for (const tabDiv of tabDivs) {
            const tabId = $(tabDiv).attr('id') || '';
            const lang = tabLangMap[tabId] || 'ITA'; // Default to ITA if not found
            const isSub = lang === 'SUB';

            const iframes = $(tabDiv).find('iframe');
            for (const iframe of iframes) {
                let src = $(iframe).attr('data-src') || $(iframe).attr('src');
                if (!src) continue;

                if (src.startsWith('//')) src = 'https:' + src;

                if (src.includes('loadm.cam') || src.includes('loadm')) {
                    const stream = await extractLoadM(src, pageUrl, mfpUrl, mfpPsw, isSub);
                    if (stream) streams.push(stream);
                }
            }
        }

        // Fallback: if no tabs found, try all iframes directly (legacy behavior)
        if (streams.length === 0) {
            const iframes = $('iframe');
            for (const iframe of iframes) {
                let src = $(iframe).attr('data-src') || $(iframe).attr('src');
                if (!src) continue;
                if (src.startsWith('//')) src = 'https:' + src;
                if (src.includes('loadm.cam') || src.includes('loadm')) {
                    const stream = await extractLoadM(src, pageUrl, mfpUrl, mfpPsw, false);
                    if (stream) streams.push(stream);
                }
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
    // First attempt: without proxy
    useProxyFallback = false;
    try {
        const result = await getGuardoserieStreamsCore(type, id, tmdbApiKey, mfpUrl, mfpPsw);
        if (result.length > 0) return result;
    } catch (e) {
        console.log(`[Guardoserie] First attempt failed: ${e}`);
    }

    // Fallback: with proxy (if available)
    if (clientWithProxy) {
        console.log('[Guardoserie] Retrying with proxy...');
        useProxyFallback = true;
        try {
            return await getGuardoserieStreamsCore(type, id, tmdbApiKey, mfpUrl, mfpPsw);
        } catch (e) {
            console.log(`[Guardoserie] Proxy attempt also failed: ${e}`);
        }
    }

    return [];
}

async function getGuardoserieStreamsCore(type: string, id: string, tmdbApiKey?: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    if (type !== 'series' && type !== 'movie') return [];

    console.log(`[Guardoserie] Requesting: ${id} (${type}) [proxy=${useProxyFallback}]`);

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

