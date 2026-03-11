
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { CookieJar } from 'tough-cookie';
import * as crypto from 'crypto';
import { Stream } from 'stremio-addon-sdk';
import { buildUnifiedStreamName, providerLabel } from '../utils/unifiedNames';
import * as cheerio from 'cheerio';
import { wrapper } from 'axios-cookiejar-support';
import { getDomain } from '../utils/domains';

// Config constants - dynamic domain from domains.json
const getTargetDomain = () => `https://${getDomain('guardaflix') || 'guardaplay.bar'}`;

const jar = new CookieJar();

const SHARED_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.7,en;q=0.6',
};

const PROXY2 = process.env.PROXY2;

function getClient() {
    return wrapper(axios.create({
        jar,
        proxy: false,
        headers: SHARED_HEADERS
    }));
}

// Helper to fetch with cookies and proxy bypass
async function fetchWithCookies(url: string, options: any = {}): Promise<{ data: string; status: number; headers: any }> {
    try {
        // 1. Try direct fetch with short timeout (2s)
        const response = await getClient().get(url, {
            ...options,
            timeout: 2000
        });
        return {
            data: response.data,
            status: response.status,
            headers: response.headers
        };
    } catch (e: any) {
        // Fallback to PROXY2 for blocks or timeouts
        if (e.response?.status === 403 || e.response?.status === 400 || !e.response || e.code === 'ECONNABORTED' || e.message === 'timeout exceeded') {
            return await tryBypass(url, options, e);
        }
        throw e;
    }
}

async function tryBypass(url: string, options: any, originalError: any): Promise<{ data: string; status: number; headers: any }> {
    if (!PROXY2) {
        console.log(`[Guardaflix] Blocked or timeout on ${url}, but PROXY2 is not set. Aborting.`);
        throw originalError;
    }

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
        console.error('[Guardaflix] Error rebuilding URL with params:', urlErr);
    }

    console.log(`[Guardaflix] Blocked or timeout on ${url} (${originalError.status || originalError.code || 'TIMEOUT'}), trying PROXY2 bypass...`);
    
    // 2. Try with PROXY2 (4s timeout)
    try {
        const proxyAgent = new HttpsProxyAgent(PROXY2);
        const proxyRes = await axios.get(finalTargetUrl, {
            ...options,
            httpsAgent: proxyAgent,
            proxy: false,
            timeout: 4000
        });
        console.log(`[Guardaflix] PROXY2 bypass success for ${url}`);
        return {
            data: proxyRes.data,
            status: proxyRes.status,
            headers: proxyRes.headers
        };
    } catch (proxyErr: any) {
        console.error(`[Guardaflix] PROXY2 bypass failed for ${url}: ${proxyErr.message}. Aborting.`);
        throw proxyErr;
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

        const response = await fetchWithCookies(apiUrl, {
            headers: { 'Referer': playerUrl },
            params: { id, w: '2560', h: '1440', r: referer }
        });

        const hexData = response.data;
        const cleanHex = hexData.replace(/[^0-9a-fA-F]/g, '');
        if (!cleanHex) return null;

        const encryptedBytes = Buffer.from(cleanHex, 'hex');
        const decipher = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
        decipher.setAutoPadding(false);

        let decrypted = Buffer.concat([decipher.update(encryptedBytes), decipher.final()]);
        const padLen = decrypted[decrypted.length - 1];
        if (padLen >= 1 && padLen <= 16) {
            decrypted = decrypted.subarray(0, decrypted.length - padLen);
        }

        const data = JSON.parse(decrypted.toString('utf-8'));
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
                params.append('h_User-Agent', SHARED_HEADERS['User-Agent']);
                finalUrl = `${proxyUrl}?${params.toString()}`;
            }

            return {
                name: providerLabel('guardaflix'),
                title: buildUnifiedStreamName({
                    baseTitle: title,
                    isSub: isSub,
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
                            "User-Agent": SHARED_HEADERS['User-Agent']
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
        const searchUrl = `${getTargetDomain()}/?s=${encodeURIComponent(query)}`;
        console.log('[Guardaflix] Direct search:', searchUrl);

        const res = await fetchWithCookies(searchUrl);
        const $ = cheerio.load(res.data);
        const queryLower = query.toLowerCase().replace(/[^a-z0-9]/g, '');

        const allLinks: { href: string, text: string }[] = [];
        $('a[href*="/film/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href || href === '#' || /\/film\/?$/.test(href)) return;
            const text = $(el).text().trim();
            allLinks.push({ href: href.startsWith('http') ? href : `${getTargetDomain()}${href}`, text });
        });

        for (const { href, text } of allLinks) {
            const textLower = text.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (textLower.includes(queryLower) || href.toLowerCase().includes(queryLower)) {
                if (!year || text.includes(year) || href.includes(year)) return href;
            }
        }
        if (allLinks.length > 0) return allLinks[0].href;
    } catch (e) {
        console.error(`[Guardaflix] Search failed: ${e}`);
    }
    return null;
}

async function resolvePageStream(pageUrl: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    const streams: Stream[] = [];
    try {
        const res = await fetchWithCookies(pageUrl);
        const $ = cheerio.load(res.data);

        const optLangMap: Record<string, 'ITA' | 'SUB'> = {};
        $('.aa-tbs li a, .video-options ul li a').each((_, el) => {
            const href = $(el).attr('href');
            const serverSpan = $(el).find('span.server').text().toLowerCase();
            if (href && href.startsWith('#options-')) {
                const optId = href.substring(1);
                if (serverSpan.includes('sub')) optLangMap[optId] = 'SUB';
                else if (serverSpan.includes('ita')) optLangMap[optId] = 'ITA';
            }
        });

        const optionDivs = $('.video.aa-tb[id^="options-"]');
        for (const optDiv of optionDivs) {
            const optId = $(optDiv).attr('id') || '';
            const isSub = optLangMap[optId] === 'SUB';
            const iframes = $(optDiv).find('iframe');
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
        console.error(`[Guardaflix] Resolve page failed: ${e}`);
    }
    return streams;
}

async function getTmdbTitle(imdbId: string, tmdbApiKey?: string): Promise<{ name: string, year: string } | null> {
    try {
        const apiKey = tmdbApiKey || '40a9faa1f6741afb2c0c40238d85f8d0';
        const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id&language=it-IT`;
        const res = await axios.get(url, { timeout: 5000 });
        const results = res.data.movie_results;
        if (results && results.length > 0) {
            const data = results[0];
            return {
                name: data.title || data.name || data.original_title || data.original_name,
                year: (data.release_date || '').split('-')[0]
            };
        }
    } catch (e) {}
    return null;
}

export async function getGuardaflixStreams(type: string, id: string, tmdbApiKey?: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    if (type !== 'movie') return [];
    let imdbId = id.includes(':') ? id.split(':')[0] : id;
    const tmdbMeta = await getTmdbTitle(imdbId, tmdbApiKey);
    if (!tmdbMeta) return [];

    const pageUrl = await searchGuardaflix(tmdbMeta.name, tmdbMeta.year);
    if (!pageUrl) return [];

    return await resolvePageStream(pageUrl, mfpUrl, mfpPsw);
}
