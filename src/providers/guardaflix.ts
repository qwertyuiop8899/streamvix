import { CookieJar } from 'tough-cookie';
import * as crypto from 'crypto';
import { Stream } from 'stremio-addon-sdk';
import { buildUnifiedStreamName, providerLabel } from '../utils/unifiedNames';
import * as cheerio from 'cheerio';
import { fetch, ProxyAgent, Response } from 'undici';
import { getDomain } from '../utils/domains';

// Config constants - dynamic domain from domains.json
const getTargetDomain = () => `https://${getDomain('guardaflix') || 'guardaplay.bar'}`;

const jar = new CookieJar();

const SHARED_HEADERS = {
    'User-Agent': 'Mozilla/5.0',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.7,en;q=0.6',
};

// Proxy fallback: start without proxy, switch to proxy on failure
let useProxyFallback = false;
const proxyDispatcher = process.env.PROXY ? new ProxyAgent(process.env.PROXY) : null;

function getDispatcher() {
    if (useProxyFallback && proxyDispatcher) {
        return proxyDispatcher;
    }
    return undefined; // No proxy initially
}

// Helper to fetch with cookies and proxy
async function fetchWithCookies(url: string, options: any = {}): Promise<{ data: string; status: number; headers: any }> {
    const cookieString = await jar.getCookieString(url);
    const headers = {
        ...SHARED_HEADERS,
        ...options.headers,
        'Cookie': cookieString
    };

    const dispatcher = getDispatcher();

    console.log(`[Guardaflix] Fetching: ${url}`);

    // @ts-ignore
    const response = await fetch(url, {
        ...options,
        headers,
        dispatcher
    });

    // Handle Set-Cookie
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) {
        // undici might return string or array of strings, or combined string. 
        // Typically explicit handling for array needed if multiple. 
        // For simplicity, we try to split or handle single.
        // Node-fetch / undici often combine into one string with comma, but split is tricky with dates.
        // tough-cookie handles single strings well.
        // Ideally loop if we can access raw headers, but response.headers.get combines.
        // We will try raw iterator if available or just attempt setCookie.
        // Note: response.headers is Headers object.

        // Basic attempt:
        try {
            if (Array.isArray(setCookie)) {
                for (const c of setCookie) await jar.setCookie(c, url);
            } else {
                await jar.setCookie(setCookie, url);
            }
        } catch (e) { console.error('[Guardaflix] Cookie error:', e); }
    }

    const text = await response.text();
    return {
        data: text,
        status: response.status,
        headers: response.headers
    };
}


// --- LOADM EXTRACTOR ---
const KEY = Buffer.from('kiemtienmua911ca', 'utf-8');
const IV = Buffer.from('1234567890oiuytr', 'utf-8');

async function extractLoadM(playerUrl: string, referer: string, mfpUrl?: string, mfpPsw?: string, isSub: boolean = false): Promise<Stream | null> {
    try {
        const parts = playerUrl.split('#');
        const id = parts[1];
        const playerDomain = new URL(playerUrl).origin;
        const apiUrl = `${playerDomain}/api/v1/video?id=${id}&w=2560&h=1440&r=${encodeURIComponent(referer)}`;

        const response = await fetchWithCookies(apiUrl, {
            headers: { 'Referer': playerUrl }
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
        // Usa ricerca diretta /?s=
        const searchUrl = `${getTargetDomain()}/?s=${encodeURIComponent(query)}`;
        console.log('[Guardaflix] Direct search:', searchUrl);

        const res = await fetchWithCookies(searchUrl);
        console.log('[GF][Direct] search html length', res.data.length);

        if (res.status === 403) {
            console.error('[Guardaflix] Search failed with 403 Forbidden. Cloudflare block?');
            // Could implement retry or more complex bypass here if needed
            return null;
        }

        const $ = cheerio.load(res.data);

        // Normalizza query per matching
        const queryLower = query.toLowerCase().replace(/[^a-z0-9]/g, '');

        // Cerca tutti i link che potrebbero essere risultati film
        const allLinks: { href: string, text: string }[] = [];
        $('a[href*="/film/"]').each((_, el) => {
            const href = $(el).attr('href');
            if (!href || href === '#') return;
            // Filtra link generici
            if (/\/film\/?$/.test(href)) return;
            if (!/\/film\/[a-z0-9-]+/i.test(href)) return;

            const text = $(el).text().trim();
            allLinks.push({ href: href.startsWith('http') ? href : `${getTargetDomain()}${href}`, text });
        });

        console.log('[Guardaflix] Found', allLinks.length, 'candidate links');

        // Prima cerca match esatto
        for (const { href, text } of allLinks) {
            const textLower = text.toLowerCase().replace(/[^a-z0-9]/g, '');
            const hrefLower = href.toLowerCase();

            if (textLower.includes(queryLower) || hrefLower.includes(queryLower)) {
                if (year && (text.includes(year) || href.includes(year))) {
                    console.log('[Guardaflix] Found with year match:', href);
                    return href;
                } else if (!year) {
                    console.log('[Guardaflix] Found query match:', href);
                    return href;
                }
            }
        }

        // Se nessun match con query, ritorna il primo link valido
        if (allLinks.length > 0) {
            console.log('[Guardaflix] Returning first valid link:', allLinks[0].href);
            return allLinks[0].href;
        }

        console.log('[Guardaflix] No results found in search page');
    } catch (e) {
        console.error(`[Guardaflix] Search failed: ${e}`);
    }
    return null;
}

import * as fs from 'fs';

async function resolvePageStream(pageUrl: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    const streams: Stream[] = [];
    try {
        const res = await fetchWithCookies(pageUrl);
        const $ = cheerio.load(res.data);

        // Build options-to-language mapping from .aa-tbs li a span.server
        // e.g., href="#options-0" -> span.server contains "Loadm -ITA" or "-SUB"
        const optLangMap: Record<string, 'ITA' | 'SUB'> = {};
        $('.aa-tbs li a, .video-options ul li a').each((_, el) => {
            const href = $(el).attr('href');
            const serverSpan = $(el).find('span.server').text().toLowerCase();
            if (href && href.startsWith('#options-')) {
                const optId = href.substring(1); // Remove #
                if (serverSpan.includes('sub')) {
                    optLangMap[optId] = 'SUB';
                } else if (serverSpan.includes('ita')) {
                    optLangMap[optId] = 'ITA';
                }
            }
        });
        console.log('[Guardaflix] Options language mapping:', optLangMap);

        // Also check the main language group buttons (span.btn.active.rtg or span.btn.rtg)
        let defaultLang: 'ITA' | 'SUB' = 'ITA';
        const langGroupBtns = $('.video-options .d-flex-ch .btr span.btn');
        langGroupBtns.each((_, el) => {
            const text = $(el).text().toLowerCase();
            if ($(el).hasClass('active')) {
                if (text.includes('sub')) {
                    defaultLang = 'SUB';
                } else if (text.includes('ita')) {
                    defaultLang = 'ITA';
                }
            }
        });

        // Iterate over option divs and their iframes
        const optionDivs = $('.video.aa-tb[id^="options-"]');
        for (const optDiv of optionDivs) {
            const optId = $(optDiv).attr('id') || '';
            const lang = optLangMap[optId] || defaultLang;
            const isSub = lang === 'SUB';

            const iframes = $(optDiv).find('iframe');
            for (const iframe of iframes) {
                let src = $(iframe).attr('data-src') || $(iframe).attr('src');
                if (!src) continue;

                if (src.startsWith('//')) src = 'https:' + src;

                // Direct LoadM
                if (src.includes('loadm.cam') || src.includes('loadm')) {
                    const stream = await extractLoadM(src, pageUrl, mfpUrl, mfpPsw, isSub);
                    if (stream) streams.push(stream);
                }
                // Recursive Embed (trembed)
                else if (src.includes('trembed=')) {
                    console.log(`[Guardaflix] Inspecting embed: ${src}`);
                    try {
                        const embedRes = await fetchWithCookies(src, { headers: { 'Referer': pageUrl } });
                        const $embed = cheerio.load(embedRes.data);
                        const nestedIframes = $embed('iframe');
                        for (const nested of nestedIframes) {
                            let nSrc = $(nested).attr('data-src') || $(nested).attr('src');
                            if (nSrc) {
                                if (nSrc.startsWith('//')) nSrc = 'https:' + nSrc;
                                if (nSrc.includes('loadm.cam') || nSrc.includes('loadm')) {
                                    const stream = await extractLoadM(nSrc, pageUrl, mfpUrl, mfpPsw, isSub);
                                    if (stream) streams.push(stream);
                                }
                            }
                        }
                    } catch (e) {
                        console.error(`[Guardaflix] Failed to inspect embed: ${e}`);
                    }
                }
            }
        }

        // Fallback: if no options found, try all iframes directly (legacy behavior)
        if (streams.length === 0) {
            const iframes = $('iframe');
            console.log(`[Guardaflix] Fallback: Found ${iframes.length} iframes on page`);
            for (const iframe of iframes) {
                let src = $(iframe).attr('data-src') || $(iframe).attr('src');
                if (!src) continue;
                if (src.startsWith('//')) src = 'https:' + src;

                if (src.includes('loadm.cam') || src.includes('loadm')) {
                    const stream = await extractLoadM(src, pageUrl, mfpUrl, mfpPsw, false);
                    if (stream) streams.push(stream);
                }
                else if (src.includes('trembed=')) {
                    try {
                        const embedRes = await fetchWithCookies(src, { headers: { 'Referer': pageUrl } });
                        const $embed = cheerio.load(embedRes.data);
                        const nestedIframes = $embed('iframe');
                        for (const nested of nestedIframes) {
                            let nSrc = $(nested).attr('data-src') || $(nested).attr('src');
                            if (nSrc) {
                                if (nSrc.startsWith('//')) nSrc = 'https:' + nSrc;
                                if (nSrc.includes('loadm.cam') || nSrc.includes('loadm')) {
                                    const stream = await extractLoadM(nSrc, pageUrl, mfpUrl, mfpPsw, false);
                                    if (stream) streams.push(stream);
                                }
                            }
                        }
                    } catch { }
                }
            }
        }
    } catch (e) {
        console.error(`[Guardaflix] Resolve page failed: ${e}`);
    }
    return streams;
}

// --- HELPER: TMDB ---
// Keep using native fetch here too for consistency, or generic axios.
// TMDB API doesn't need proxy usually, but let's stick to simple fetch.
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
        // @ts-ignore
        const res = await fetch(url);
        const data: any = await res.json();

        if (paramId.startsWith('tmdb:')) {
            const name = data.title || data.name || data.original_title || data.original_name;
            const date = data.release_date || data.first_air_date || '';
            const year = date.split('-')[0];
            return { name, year };
        } else {
            const results = type === 'series' ? data.tv_results : data.movie_results;
            if (results && results.length > 0) {
                const first = results[0];
                const name = first.title || first.name || first.original_title || first.original_name;
                const date = first.release_date || first.first_air_date || '';
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
        // @ts-ignore
        const res = await fetch(url);
        const data: any = await res.json();
        if (data && data.meta) {
            return {
                name: data.meta.name,
                year: data.meta.year || (data.meta.releaseInfo || '').split('-')[0]
            };
        }
    } catch (e) {
        console.error(`[Guardaflix] Cinemeta fetch failed: ${e}`);
    }
    return null;
}

// --- PUBLIC INTERFACE ---

export async function getGuardaflixStreams(type: string, id: string, tmdbApiKey?: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    // First attempt: without proxy
    useProxyFallback = false;
    try {
        const result = await getGuardaflixStreamsCore(type, id, tmdbApiKey, mfpUrl, mfpPsw);
        if (result.length > 0) return result;
    } catch (e) {
        console.log(`[Guardaflix] First attempt failed: ${e}`);
    }

    // Fallback: with proxy (if available)
    if (proxyDispatcher) {
        console.log('[Guardaflix] Retrying with proxy...');
        useProxyFallback = true;
        try {
            return await getGuardaflixStreamsCore(type, id, tmdbApiKey, mfpUrl, mfpPsw);
        } catch (e) {
            console.log(`[Guardaflix] Proxy attempt also failed: ${e}`);
        }
    }

    return [];
}

async function getGuardaflixStreamsCore(type: string, id: string, tmdbApiKey?: string, mfpUrl?: string, mfpPsw?: string): Promise<Stream[]> {
    // Only Movies supported for now
    if (type !== 'movie') return [];

    console.log(`[Guardaflix] Requesting: ${id} (${type}) [proxy=${useProxyFallback}]`);

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
        // Check cinemeta for english title
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

