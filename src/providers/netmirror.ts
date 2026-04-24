// NetMirror provider — Stremio addon integration.
// Scrapes net22.cc / net52.cc, returns ONLY Italian-audio streams (direct
// playback via behaviorHints.proxyHeaders), keeping only the highest
// available resolution (1080p > 720p > 480p, ignoring "auto").
//
// See netmirroreprovider.md for the full protocol spec.

import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { Stream } from 'stremio-addon-sdk';
import { providerLabel } from '../utils/unifiedNames';

// NOTE (2026-04): net22.cc backend is offline (CF 522 / timeout on every
// path). The same API is served by net52.cc, so we point BASE there too.
const NETMIRROR_BASE = 'https://net52.cc';
const NETMIRROR_PLAY = 'https://net52.cc';

const BASE_HEADERS: Record<string, string> = {
    'X-Requested-With': 'XMLHttpRequest',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.5',
    'Connection': 'keep-alive'
};

// Playback headers — these are sent by the client (Stremio native) via
// behaviorHints.proxyHeaders. Also used by the addon to probe the HLS master.
const PLAYBACK_HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Referer': 'https://net52.cc/'
};

const PROBE_HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Android) ExoPlayer',
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
    'Connection': 'keep-alive',
    'Cookie': 'hd=on',
    'Referer': 'https://net52.cc/'
};

type Platform = 'netflix' | 'primevideo' | 'disney';
const OTT_MAP: Record<Platform, string> = { netflix: 'nf', primevideo: 'pv', disney: 'hs' };

const COOKIE_EXPIRY_MS = 54_000_000; // ~15h
let globalCookie = '';
let cookieTimestamp = 0;

function unix(): number { return Math.floor(Date.now() / 1000); }

function endpoints(platform: Platform) {
    const prefix: Record<Platform, string> = {
        netflix: '',
        primevideo: '/pv',
        disney: '/mobile/hs'
    };
    const p = prefix[platform];
    return {
        search: `${NETMIRROR_BASE}${p}/search.php`,
        post: `${NETMIRROR_BASE}${p}/post.php`,
        episodes: `${NETMIRROR_BASE}${p}/episodes.php`,
        play1: `${NETMIRROR_BASE}/play.php`,
        play2: `${NETMIRROR_PLAY}/play.php`,
        playlist: `${NETMIRROR_PLAY}${p}/playlist.php`
    };
}

async function request(url: string, opts: AxiosRequestConfig = {}): Promise<AxiosResponse> {
    return axios({
        url,
        timeout: 6000,
        validateStatus: () => true,
        ...opts,
        headers: { ...BASE_HEADERS, ...(opts.headers || {}) }
    });
}

// Race a promise against a hard timeout. Resolves to fallback if the timeout fires first.
function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
    return new Promise<T>((resolve) => {
        let done = false;
        const timer = setTimeout(() => { if (!done) { done = true; resolve(fallback); } }, ms);
        p.then((v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } })
         .catch(() => { if (!done) { done = true; clearTimeout(timer); resolve(fallback); } });
    });
}

async function bypass(): Promise<string> {
    const now = Date.now();
    if (globalCookie && now - cookieTimestamp < COOKIE_EXPIRY_MS) return globalCookie;

    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const res = await request(`${NETMIRROR_PLAY}/tv/p.php`, { method: 'POST' });
            const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || '');
            if (!body.includes('"r":"n"')) continue;
            const setCookie = res.headers['set-cookie'];
            const cookieStr = Array.isArray(setCookie) ? setCookie.join('; ') : (setCookie || '');
            const m = cookieStr.match(/t_hash_t=([^;]+)/);
            if (m) {
                globalCookie = m[1];
                cookieTimestamp = Date.now();
                return globalCookie;
            }
        } catch { /* retry */ }
    }
    throw new Error('[NetMirror] bypass failed');
}

function buildCookie(cookie: string, ott: string, extra?: Record<string, string>): string {
    const base: Record<string, string> = {
        t_hash_t: cookie,
        user_token: '233123f803cf02184bf6c67e149cdd50',
        hd: 'on',
        ott,
        ...(extra || {})
    };
    return Object.entries(base).map(([k, v]) => `${k}=${v}`).join('; ');
}

interface SearchItem { id: string; title: string; }

async function searchContent(query: string, platform: Platform): Promise<SearchItem[]> {
    const cookie = await bypass();
    const ott = OTT_MAP[platform];
    const ep = endpoints(platform);
    const res = await request(`${ep.search}?s=${encodeURIComponent(query)}&t=${unix()}`, {
        headers: {
            Cookie: buildCookie(cookie, ott),
            Referer: `${NETMIRROR_BASE}/tv/home`
        }
    });
    const data: any = res.data;
    if (!data?.searchResult?.length) return [];
    return data.searchResult.map((it: any) => ({ id: String(it.id), title: String(it.t || '') }));
}

function similarity(a: string, b: string): number {
    const s1 = a.toLowerCase().trim();
    const s2 = b.toLowerCase().trim();
    if (s1 === s2) return 1;
    const w1 = s1.split(/\s+/).filter(Boolean);
    const w2 = s2.split(/\s+/).filter(Boolean);
    if (w2.length <= w1.length) {
        let matches = 0;
        for (const w of w2) if (w1.includes(w)) matches++;
        if (matches === w2.length) return 0.95 * (matches / w1.length);
    }
    if (s1.startsWith(s2)) return 0.9;
    return 0;
}

function pickBest(results: SearchItem[], query: string): SearchItem | null {
    const filtered = results
        .map(r => ({ r, s: similarity(r.title, query) }))
        .filter(x => x.s >= 0.7)
        .sort((a, b) => b.s - a.s);
    return filtered[0]?.r || null;
}

interface EpisodesResponse {
    episodes?: any[];
    nextPageShow?: number;
    nextPageSeason?: any;
    season?: any[];
    title?: string;
    desc?: string;
    year?: string;
}

async function fetchEpisodes(seriesId: string, seasonId: string, platform: Platform, startPage: number): Promise<any[]> {
    const cookie = await bypass();
    const ott = OTT_MAP[platform];
    const ep = endpoints(platform);
    const out: any[] = [];
    let page = startPage;
    for (let guard = 0; guard < 20; guard++) {
        try {
            const res = await request(`${ep.episodes}?s=${seasonId}&series=${seriesId}&t=${unix()}&page=${page}`, {
                headers: {
                    Cookie: buildCookie(cookie, ott),
                    Referer: `${NETMIRROR_BASE}/tv/home`
                }
            });
            const data: EpisodesResponse = res.data;
            if (data?.episodes) out.push(...data.episodes);
            if (!data || data.nextPageShow === 0) break;
            page++;
        } catch { break; }
    }
    return out;
}

interface ContentData {
    id: string;
    title: string;
    year?: string;
    episodes: any[];
    isMovie: boolean;
}

async function loadContent(id: string, platform: Platform): Promise<ContentData | null> {
    const cookie = await bypass();
    const ott = OTT_MAP[platform];
    const ep = endpoints(platform);
    const res = await request(`${ep.post}?id=${id}&t=${unix()}`, {
        headers: {
            Cookie: buildCookie(cookie, ott),
            Referer: `${NETMIRROR_BASE}/tv/home`
        }
    });
    const data: EpisodesResponse = res.data;
    if (!data || !data.title) return null;

    const firstEpisodes: any[] = data.episodes || [];
    const isMovie = !firstEpisodes.length || firstEpisodes[0] === null;
    const allEpisodes: any[] = [...firstEpisodes];

    if (!isMovie) {
        if (data.nextPageShow === 1 && data.nextPageSeason) {
            const more = await fetchEpisodes(id, String(data.nextPageSeason), platform, 2);
            allEpisodes.push(...more);
        }
        if (data.season && data.season.length > 1) {
            const other = data.season.slice(0, -1);
            for (const s of other) {
                const eps = await fetchEpisodes(id, String(s.id), platform, 1);
                allEpisodes.push(...eps);
            }
        }
    }

    return {
        id,
        title: data.title,
        year: data.year,
        episodes: allEpisodes,
        isMovie
    };
}

function findEpisode(episodes: any[], season: number, episode: number): any | null {
    for (const ep of episodes) {
        if (!ep) continue;
        let s: number | null = null;
        let e: number | null = null;
        if (ep.s && ep.ep) {
            s = parseInt(String(ep.s).replace(/^S/i, ''));
            e = parseInt(String(ep.ep).replace(/^E/i, ''));
        } else if (ep.season != null && ep.episode != null) {
            s = parseInt(String(ep.season));
            e = parseInt(String(ep.episode));
        } else if (ep.season_number != null && ep.episode_number != null) {
            s = parseInt(String(ep.season_number));
            e = parseInt(String(ep.episode_number));
        }
        if (s === season && e === episode) return ep;
    }
    return null;
}

async function getVideoToken(id: string, cookie: string, ott: string): Promise<string | null> {
    const cookieStr = `t_hash_t=${cookie}; ott=${ott}; hd=on`;
    const r1 = await request(`${NETMIRROR_BASE}/play.php`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: `${NETMIRROR_BASE}/`,
            Cookie: cookieStr
        },
        data: `id=${id}`
    });
    const h = r1.data?.h;
    if (!h) return null;
    const r2 = await request(`${NETMIRROR_PLAY}/play.php?id=${id}&${h}`, {
        headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            Referer: `${NETMIRROR_BASE}/`,
            'Sec-Fetch-Dest': 'iframe',
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
            Cookie: cookieStr
        }
    });
    const html = typeof r2.data === 'string' ? r2.data : '';
    const m = html.match(/data-h="([^"]+)"/);
    return m ? m[1] : null;
}

interface RawSource { url: string; quality: string; }

async function getStreamingLinks(contentId: string, title: string, platform: Platform): Promise<RawSource[]> {
    const cookie = await bypass();
    const ott = OTT_MAP[platform];
    // NOTE (2026-04): /play.php now returns err:1003 (handshake broken
    // server-side). /playlist.php still works with any dummy `h` value,
    // so we skip the play.php token fetch entirely.
    const token = 'x';
    const ep = endpoints(platform);
    const res = await request(
        `${ep.playlist}?id=${contentId}&t=${encodeURIComponent(title)}&tm=${unix()}&h=${token}`,
        {
            headers: {
                Cookie: `t_hash_t=${cookie}; ott=${ott}; hd=on`,
                Referer: `${NETMIRROR_PLAY}/`
            }
        }
    );
    const playlist: any[] = Array.isArray(res.data) ? res.data : [];
    const out: RawSource[] = [];
    for (const item of playlist) {
        if (!item?.sources) continue;
        for (const src of item.sources) {
            if (!src?.file) continue;
            let full = String(src.file).replace('/tv/', '/');
            if (!full.startsWith('/')) full = '/' + full;
            full = NETMIRROR_PLAY + '/' + full;
            out.push({ url: full, quality: String(src.label || '') });
        }
    }
    return out;
}

// --- Language detection from HLS master ---

const LANG_ALIASES: Record<string, string[]> = {
    it: ['italian', 'italiano', 'ita']
};

function detectItalian(m3u8: string): boolean {
    if (!m3u8) return false;
    const re = /#EXT-X-MEDIA:([^\n\r]+)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(m3u8)) !== null) {
        const attrs = m[1];
        if (!/TYPE=AUDIO/i.test(attrs)) continue;
        const lang = (attrs.match(/LANGUAGE="([^"]+)"/i) || [])[1] || '';
        const name = (attrs.match(/NAME="([^"]+)"/i) || [])[1] || '';
        const combined = `${lang} ${name}`.toLowerCase();
        if (combined.includes('it')) {
            const tokens = [lang.toLowerCase(), name.toLowerCase()];
            for (const t of tokens) {
                if (!t) continue;
                if (t === 'it' || t.startsWith('it-') || t.startsWith('it_')) return true;
                if (LANG_ALIASES.it.some(a => t === a || t.includes(a))) return true;
            }
        }
    }
    return false;
}

async function probeItalianOnce(url: string, timeoutMs: number): Promise<{ ok: boolean; italian: boolean }> {
    try {
        const res = await axios.get(url, {
            headers: PROBE_HEADERS,
            timeout: timeoutMs,
            responseType: 'text',
            validateStatus: () => true,
            transformResponse: [(d) => d]
        });
        if (res.status >= 400) return { ok: false, italian: false };
        const body = typeof res.data === 'string' ? res.data : '';
        if (!body) return { ok: false, italian: false };
        return { ok: true, italian: detectItalian(body) };
    } catch {
        return { ok: false, italian: false };
    }
}

async function hasItalianAudio(url: string): Promise<boolean> {
    // Try with progressively larger timeouts to reduce flakiness
    for (const t of [8000, 12000]) {
        const r = await probeItalianOnce(url, t);
        if (r.ok) return r.italian;
    }
    return false;
}

// --- Quality helpers ---

function parseQuality(source: RawSource): number {
    // Ignore "auto"
    const q = source.quality || '';
    const urlMatch = source.url.match(/[?&]q=(\d+)p/i);
    if (urlMatch) return parseInt(urlMatch[1], 10);
    const labelMatch = q.match(/(\d{3,4})p/i);
    if (labelMatch) return parseInt(labelMatch[1], 10);
    const l = q.toLowerCase();
    if (l.includes('1080') || l.includes('full hd')) return 1080;
    if (l.includes('720') || l === 'hd') return 720;
    if (l.includes('480')) return 480;
    const urlSub = source.url.toLowerCase();
    if (urlSub.includes('1080p')) return 1080;
    if (urlSub.includes('720p')) return 720;
    if (urlSub.includes('480p')) return 480;
    return 0;
}

function isAutoQuality(source: RawSource): boolean {
    const q = (source.quality || '').toLowerCase();
    if (q === 'auto' || q.includes('auto')) return true;
    if (/[?&]q=auto/i.test(source.url)) return true;
    return false;
}

// --- TMDB helpers ---

interface TmdbInfo { title: string; year?: string; }

async function tmdbInfo(tmdbId: string, mediaType: 'movie' | 'tv', apiKey: string): Promise<TmdbInfo | null> {
    try {
        const res = await axios.get(
            `https://api.themoviedb.org/3/${mediaType}/${tmdbId}?api_key=${apiKey}`,
            { timeout: 8000, validateStatus: () => true }
        );
        if (res.status !== 200) return null;
        const d = res.data;
        const title = mediaType === 'tv' ? d.name : d.title;
        const date = mediaType === 'tv' ? d.first_air_date : d.release_date;
        if (!title) return null;
        return { title, year: date ? String(date).substring(0, 4) : undefined };
    } catch { return null; }
}

async function resolveTmdbFromImdb(imdbId: string, apiKey: string): Promise<{ tmdbId: string; mediaType: 'movie' | 'tv' } | null> {
    try {
        const res = await axios.get(
            `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id`,
            { timeout: 8000, validateStatus: () => true }
        );
        if (res.status !== 200) return null;
        const d = res.data;
        if (d.movie_results?.length) return { tmdbId: String(d.movie_results[0].id), mediaType: 'movie' };
        if (d.tv_results?.length) return { tmdbId: String(d.tv_results[0].id), mediaType: 'tv' };
        return null;
    } catch { return null; }
}

// --- Main entry ---

export interface NetMirrorRequest {
    type: 'movie' | 'series' | string;
    id: string; // tt1234567 | tt1234567:1:2 | tmdb:12345 | tmdb:12345:1:2
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    tmdbApiKey?: string;
}

export async function getNetMirrorStreams(req: NetMirrorRequest): Promise<Stream[]> {
    const { id, type } = req;
    const tmdbApiKey = req.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0';
    const mediaType: 'movie' | 'tv' = type === 'series' ? 'tv' : 'movie';

    // Resolve TMDB id
    let tmdbId: string | null = null;
    let resolvedMediaType: 'movie' | 'tv' = mediaType;
    if (id.startsWith('tmdb:')) {
        tmdbId = id.replace(/^tmdb:/, '').split(':')[0];
    } else if (id.startsWith('tt')) {
        const imdbId = id.split(':')[0];
        const resolved = await resolveTmdbFromImdb(imdbId, tmdbApiKey);
        if (!resolved) return [];
        tmdbId = resolved.tmdbId;
        resolvedMediaType = type === 'series' ? 'tv' : resolved.mediaType;
    } else {
        return [];
    }
    if (!tmdbId) return [];

    const info = await tmdbInfo(tmdbId, resolvedMediaType, tmdbApiKey);
    if (!info) return [];

    const title = info.title;
    const year = info.year;
    const season = req.seasonNumber ?? null;
    const episode = req.episodeNumber ?? null;

    let platforms: Platform[] = ['netflix', 'primevideo', 'disney'];
    const low = title.toLowerCase();
    if (low.includes('boys') || low.includes('prime')) {
        platforms = ['primevideo', 'netflix', 'disney'];
    }

    // Try a single platform — returns a Stream or null. All network calls inside
    // are bounded by the per-request timeout (6s) and the outer 15s race below.
    const tryPlatform = async (platform: Platform): Promise<Stream | null> => {
        try {
            let results = await searchContent(title, platform);
            let chosen = pickBest(results, title);
            if (!chosen && year) {
                results = await searchContent(`${title} ${year}`, platform);
                chosen = pickBest(results, title);
            }
            if (!chosen) return null;

            const content = await loadContent(chosen.id, platform);
            if (!content) return null;

            let targetId = chosen.id;
            if (resolvedMediaType === 'tv' && !content.isMovie) {
                if (season == null || episode == null) return null;
                const ep = findEpisode(content.episodes, season, episode);
                if (!ep?.id) return null;
                targetId = String(ep.id);
            }

            const sources = await getStreamingLinks(targetId, title, platform);
            if (!sources.length) return null;

            // Dedup sources for probing.
            const probeOrder: RawSource[] = [];
            const seen = new Set<string>();
            for (const s of sources) {
                if (!seen.has(s.url)) { seen.add(s.url); probeOrder.push(s); }
            }

            // Probe up to 3 masters in parallel — much faster than serial.
            const probes = probeOrder.slice(0, 3).map(p => probeItalianOnce(p.url, 6000));
            const results2 = await Promise.all(probes);
            const probedOk = results2.some(r => r.ok);
            const hasIt = results2.some(r => r.ok && r.italian);

            if (!probedOk) {
                console.log(`[NetMirror] ${title} on ${platform}: probe failed (network), skipping`);
                return null;
            }
            if (!hasIt) {
                console.log(`[NetMirror] ${title} on ${platform}: no Italian audio, skipping`);
                return null;
            }

            const nonAuto = sources.filter(s => !isAutoQuality(s));
            if (!nonAuto.length) return null;
            const maxRes = Math.max(...nonAuto.map(parseQuality));
            if (maxRes <= 0) return null;
            const best = nonAuto.find(s => parseQuality(s) === maxRes);
            if (!best) return null;

            const qualityLabel = `${maxRes}p`;
            const platformName = platform === 'primevideo' ? 'Prime Video' : platform.charAt(0).toUpperCase() + platform.slice(1);
            const baseTitle = resolvedMediaType === 'tv'
                ? `${title}${year ? ` (${year})` : ''} S${season}E${episode}`
                : `${title}${year ? ` (${year})` : ''}`;
            const displayTitle = `🎬 ${baseTitle}\n🗣 🇮🇹\n📺 ${platformName} ${qualityLabel}`;

            console.log(`[NetMirror] ✅ ${title} (${platform}) → ${qualityLabel} ITA`);
            return {
                name: providerLabel('netmirror'),
                title: displayTitle,
                url: best.url,
                behaviorHints: {
                    notWebReady: true,
                    proxyHeaders: {
                        request: {
                            'User-Agent': PLAYBACK_HEADERS['User-Agent'],
                            'Referer': PLAYBACK_HEADERS['Referer']
                        }
                    }
                }
            };
        } catch (e) {
            console.log(`[NetMirror] Error on ${platform}:`, (e as any)?.message || e);
            return null;
        }
    };

    // Race all platforms in parallel. First one with a Stream wins; otherwise
    // wait for all (up to the 15s hard cap) and return the first non-null.
    const HARD_CAP_MS = 15000;
    const platformPromises = platforms.map(p => tryPlatform(p));

    const firstHit = new Promise<Stream | null>((resolve) => {
        let pending = platformPromises.length;
        if (!pending) { resolve(null); return; }
        for (const pp of platformPromises) {
            pp.then(s => {
                if (s) resolve(s);
                else if (--pending === 0) resolve(null);
            }).catch(() => { if (--pending === 0) resolve(null); });
        }
    });

    const winner = await withTimeout(firstHit, HARD_CAP_MS, null);
    return winner ? [winner] : [];
}
