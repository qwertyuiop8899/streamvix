import axios from 'axios';
import * as cheerio from 'cheerio';
import { Stream } from 'stremio-addon-sdk';
import { getLoonexTitle } from '../config/loonexTitleMap';

const BASE_URL = 'https://loonex.eu';
const CATALOG_URL = 'https://loonex.eu/cartoni/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

interface LoonexSeries {
    title: string;
    url: string;
    normalizedTitle: string;
}

interface LoonexEpisode {
    title: string;
    episodeUrl: string;
    seasonTitle: string;
}

/**
 * Normalizza un titolo per il confronto
 */
function normalizeTitle(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^\w\s]/g, '') // Rimuovi punteggiatura
        .replace(/\s+/g, ' ')    // Normalizza spazi
        .trim();
}

/**
 * Estrae il numero di episodio dal titolo in tutti i formati usati da Loonex:
 * "1 - nome", "Episodio 01", "1x01", "episodio 1x01", "puntata 1", ecc.
 */
function extractEpisodeNumber(title: string): number | null {
    const t = title.trim();

    // "1x01", "S1E01", "episodio 1x01" → prende la parte DOPO x/E
    let m = t.match(/(?:^|\s|[xXeE])\d+[xX](\d+)/);
    if (m) return parseInt(m[1]);

    m = t.match(/[Ss]\d+[Ee](\d+)/);
    if (m) return parseInt(m[1]);

    // "Episodio 01", "episodio 1", "puntata 1", "Ep. 3"
    m = t.match(/(?:episodio|puntata|ep\.?)\s*(\d+)/i);
    if (m) return parseInt(m[1]);

    // "1 - Titolo episodio" → numero all'inizio seguito da trattino
    m = t.match(/^(\d+)\s*[-–]/);
    if (m) return parseInt(m[1]);

    // Numero nudo all'inizio (es: "01", "1")
    m = t.match(/^(\d+)(?:\s|$)/);
    if (m) return parseInt(m[1]);

    return null;
}

/**
 * Estrae il numero di stagione dal testo del bottone accordion.
 * Gestisce: "Stagione 1", "Season 2", "Stagione1", "Tutti gli episodi" (→ null = stagione unica)
 */
function extractSeasonNumber(seasonTitle: string): number | null {
    const t = seasonTitle.toLowerCase();
    // Salta sezioni extra/speciali
    if (/extra|special|speciali|hype|bonus/.test(t)) return -1;
    const m = t.match(/(?:stagione|season)\s*(\d+)/);
    return m ? parseInt(m[1]) : null; // null = stagione unica ("Tutti gli episodi")
}

/**
 * Cerca una serie su Loonex
 */
async function searchSeries(searchTitle: string, imdbId?: string, tmdbId?: string): Promise<LoonexSeries | null> {
    try {
        // 1. Controlla se c'è una normalizzazione statica per questo ID
        let targetTitle = searchTitle;
        const mappedTitle = getLoonexTitle(imdbId, tmdbId);
        if (mappedTitle) {
            targetTitle = mappedTitle;
            console.log(`[Loonex] Using static mapping for ${imdbId || tmdbId}: "${targetTitle}"`);
        }

        const normalizedSearch = normalizeTitle(targetTitle);
        console.log(`[Loonex] Searching for: "${searchTitle}" (normalized: "${normalizedSearch}")`);

        // 2. Scarica il catalogo cartoni (homepage spostata su /cartoni/)
        const response = await axios.get(CATALOG_URL, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);
        const series: LoonexSeries[] = [];

        // 3. Estrai tutte le serie usando data-title (attributo funzionale, immune ai redesign CSS)
        // Ogni card del catalogo ha data-title="..." e un <a href="?cartone=..."> interno
        $('[data-title]').each((_, element) => {
            const $item = $(element);
            const title = ($item.attr('data-title') || '').trim();

            // href relativo tipo "?cartone=over-the-garden-wall-1772122256"
            const rawHref = $item.find('a[href]').attr('href') || '';
            if (!title || !rawHref) return;

            let href: string;
            if (rawHref.startsWith('http')) {
                href = rawHref;
            } else if (rawHref.startsWith('?')) {
                href = CATALOG_URL + rawHref;
            } else {
                href = BASE_URL + (rawHref.startsWith('/') ? '' : '/') + rawHref;
            }

            series.push({
                title,
                url: href,
                normalizedTitle: normalizeTitle(title)
            });
        });

        console.log(`[Loonex] Found ${series.length} series on homepage`);

        // 4. Cerca corrispondenza
        for (const serie of series) {
            if (serie.normalizedTitle.includes(normalizedSearch) ||
                normalizedSearch.includes(serie.normalizedTitle)) {
                console.log(`[Loonex] Found match: "${serie.title}" at ${serie.url}`);
                return serie;
            }
        }

        console.log(`[Loonex] No match found for "${searchTitle}"`);
        return null;

    } catch (error) {
        console.error('[Loonex] Error searching series:', error);
        return null;
    }
}

/**
 * Estrae gli episodi da una pagina serie
 */
async function getEpisodes(seriesUrl: string): Promise<LoonexEpisode[]> {
    try {
        console.log(`[Loonex] Fetching episodes from: ${seriesUrl}`);

        const response = await axios.get(seriesUrl, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);
        const episodes: LoonexEpisode[] = [];

        // Struttura reale: ogni stagione ha un <button data-bs-target="#collapseN">Stagione X</button>
        // e un <div id="collapseN"> con i link agli episodi /guarda/...
        $('button[data-bs-target]').each((_, btnElement) => {
            const $btn = $(btnElement);
            const seasonTitle = $btn.text().trim().replace(/\s+/g, ' ');
            const target = $btn.attr('data-bs-target');
            if (!target) return;

            const $container = $(target);

            // Cerca tutti i link a /guarda/ dentro il collapse
            $container.find('a[href*="/guarda/"]').each((_, linkEl) => {
                const $link = $(linkEl);
                const episodeUrl = $link.attr('href') || '';
                // Il titolo episodio è nel testo del link o in un <span> vicino
                const episodeTitle = $link.text().trim() ||
                    $link.closest('div').find('span').first().text().trim() ||
                    'Episodio';

                if (episodeUrl) {
                    // Rendi assoluto se necessario
                    const absUrl = episodeUrl.startsWith('http')
                        ? episodeUrl
                        : BASE_URL + (episodeUrl.startsWith('/') ? '' : '/') + episodeUrl;
                    episodes.push({
                        title: episodeTitle,
                        episodeUrl: absUrl,
                        seasonTitle
                    });
                }
            });
        });

        console.log(`[Loonex] Found ${episodes.length} episodes`);
        return episodes;

    } catch (error) {
        console.error('[Loonex] Error fetching episodes:', error);
        return [];
    }
}

/**
 * Estrae l'URL M3U8 da una pagina episodio
 */
async function getM3U8Url(episodeUrl: string): Promise<string | null> {
    try {
        console.log(`[Loonex] Fetching M3U8 from: ${episodeUrl}`);

        const response = await axios.get(episodeUrl, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 10000
        });

        const html: string = response.data;

        // L'URL M3U8 è base64-encoded in una variabile JS:
        // var encodedStr = "BASE64...";
        // var videoSrc = atob(encodedStr);
        const b64Match = html.match(/var\s+encodedStr\s*=\s*["']([A-Za-z0-9+/=]+)["']/);
        if (b64Match) {
            try {
                let decoded = Buffer.from(b64Match[1], 'base64').toString('utf-8');
                // Se il valore base64-decodificato è già URL-encoded (es. https%3A%2F%2F), decodificalo prima
                if (decoded.includes('%3A') || decoded.includes('%2F')) {
                    try { decoded = decodeURIComponent(decoded); } catch { /* ignore malformed */ }
                }
                if (decoded && decoded.startsWith('http') && !decoded.includes('nontrovato')) {
                    // URL-encoda spazi e caratteri speciali mantenendo il protocollo/struttura
                    const encoded = decoded
                        .split('/')
                        .map((seg, i) => i < 3 ? seg : encodeURIComponent(seg))
                        .join('/');
                    console.log(`[Loonex] Found M3U8 (base64): ${encoded}`);
                    return encoded;
                }
            } catch { /* fallthrough */ }
        }

        // Fallback: cerca direttamente .m3u8 nell'HTML
        const $ = cheerio.load(html);
        const m3u8Url = $('#video-source').attr('src') ||
            $('source[type="application/x-mpegURL"]').attr('src') ||
            $('source').filter((_, el) => {
                const src = $(el).attr('src') || '';
                return src.includes('.m3u8');
            }).attr('src');

        if (m3u8Url && !m3u8Url.includes('1-second-blank-video')) {
            console.log(`[Loonex] Found M3U8 (tag): ${m3u8Url}`);
            return m3u8Url;
        }

        // Fallback regex generica su qualsiasi .m3u8 nell'HTML
        const rawMatch = html.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/);
        if (rawMatch && !rawMatch[0].includes('1-second-blank-video')) {
            console.log(`[Loonex] Found M3U8 (regex): ${rawMatch[0]}`);
            return rawMatch[0];
        }

        console.log('[Loonex] No M3U8 found in episode page');
        return null;

    } catch (error) {
        console.error('[Loonex] Error fetching M3U8:', error);
        return null;
    }
}

/**
 * Ottiene il titolo da TMDb usando l'API
 */
async function getTitleFromTMDb(imdbId: string, tmdbId?: string, tmdbApiKey?: string): Promise<string | null> {
    try {
        const apiKey = tmdbApiKey || '40a9faa1f6741afb2c0c40238d85f8d0';
        let url: string;

        if (tmdbId) {
            // Se abbiamo TMDb ID, usalo direttamente
            url = `https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${apiKey}&language=it-IT`;
        } else if (imdbId) {
            // Se abbiamo IMDb ID, cerca prima il TMDb ID
            url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&external_source=imdb_id&language=it-IT`;
        } else {
            return null;
        }

        console.log(`[Loonex] Fetching title from TMDb...`);
        const response = await axios.get(url, { timeout: 5000 });

        if (tmdbId) {
            return response.data.name || response.data.original_name || null;
        } else {
            // Risposta da /find
            const results = response.data.tv_results || [];
            if (results.length > 0) {
                return results[0].name || results[0].original_name || null;
            }
        }

        return null;
    } catch (error) {
        console.error('[Loonex] Error fetching from TMDb:', error);
        return null;
    }
}

/**
 * Provider principale per Loonex
 */
export async function getLoonexStreams(
    type: string,
    imdbId: string,
    title?: string,
    season?: number,
    episode?: number,
    tmdbId?: string
): Promise<Stream[]> {
    console.log(`[Loonex] Request: ${type} - ${title || 'N/A'} (IMDb: ${imdbId || 'N/A'}, TMDb: ${tmdbId || 'N/A'}) S${season}E${episode}`);

    // Solo per serie TV
    if (type !== 'series' || !season || !episode) {
        console.log(`[Loonex] Skipping: type=${type}, season=${season}, episode=${episode}`);
        return [];
    }

    // Se non abbiamo IDs, non possiamo cercare
    if (!imdbId && !tmdbId) {
        console.log('[Loonex] No IMDb or TMDb ID provided');
        return [];
    }

    try {
        // 1. Ottieni il titolo da TMDb se non fornito
        let searchTitle = title;
        if (!searchTitle) {
            const tmdbTitle = await getTitleFromTMDb(imdbId, tmdbId);
            if (!tmdbTitle) {
                console.log('[Loonex] Could not fetch title from TMDb');
                return [];
            }
            searchTitle = tmdbTitle;
            console.log(`[Loonex] Got title from TMDb: "${searchTitle}"`);
        }

        // 2. Cerca la serie
        const series = await searchSeries(searchTitle, imdbId, tmdbId);
        if (!series) {
            return [];
        }

        // 2. Ottieni gli episodi
        let episodes = await getEpisodes(series.url);
        if (episodes.length === 0) {
            return [];
        }

        // IMPORTANTE: Loonex può avere un episodio 0x00 (prequel) che non esiste su IMDb/TMDb
        // Filtra gli episodi che contengono "0x00" nell'URL o nel titolo
        const filteredEpisodes = episodes.filter(ep => {
            const title = ep.title.toLowerCase();
            const url = ep.episodeUrl.toLowerCase();

            // Rimuovi episodi con:
            // - URL che contiene "0x00" (es: overthegardenwall_0x00)
            // - Titolo che inizia con "0 -" (es: "0 - PREQUEL")
            // - Titolo che contiene "0x00"
            // - Titolo che contiene "prequel"
            const isPrequel = url.includes('0x00') ||
                url.includes('_0x0') ||
                title.startsWith('0 -') ||
                title.includes('0x00') ||
                title.includes('prequel');

            return !isPrequel;
        });

        if (filteredEpisodes.length < episodes.length) {
            console.log(`[Loonex] Filtered out ${episodes.length - filteredEpisodes.length} prequel episode(s) (0x00)`);
            episodes = filteredEpisodes;
        }

        // 3. Trova l'episodio richiesto
        // Dopo aver rimosso il 0x00, episode 1 = indice 0, episode 2 = indice 1, ecc.
        const streams: Stream[] = [];

        console.log(`[Loonex] Searching for S${season}E${episode} among ${episodes.length} episodes`);

        // Filtra per stagione usando extractSeasonNumber
        // null = stagione unica ("Tutti gli episodi") → accetta qualunque season richiesta
        // -1 = Extra/Speciali → escludi sempre per episodi normali
        const seasonEpisodes = episodes.filter(ep => {
            const sn = extractSeasonNumber(ep.seasonTitle);
            if (sn === -1) return false;          // Salta Extra/Speciali
            if (sn === null) return true;          // Stagione unica
            return sn === season;
        });

        const episodeList = seasonEpisodes.length > 0 ? seasonEpisodes : episodes.filter(ep => extractSeasonNumber(ep.seasonTitle) !== -1);
        console.log(`[Loonex] Season filter: ${seasonEpisodes.length} eps for S${season}, using ${episodeList.length} total`);

        // Prova prima a trovare l'episodio per numero estratto dal titolo
        let targetEpisode = episodeList.find(ep => extractEpisodeNumber(ep.title) === episode);

        // Fallback: usa l'indice posizionale (episode 1 = indice 0)
        if (!targetEpisode) {
            const targetIndex = episode - 1;
            console.log(`[Loonex] No title match for E${episode}, trying index ${targetIndex}`);
            targetEpisode = (targetIndex >= 0 && targetIndex < episodeList.length)
                ? episodeList[targetIndex]
                : undefined;
        } else {
            console.log(`[Loonex] Matched E${episode} by title: "${targetEpisode.title}"`);
        }

        if (targetEpisode) {
            console.log(`[Loonex] Fetching stream for: ${targetEpisode.episodeUrl}`);

            const m3u8Url = await getM3U8Url(targetEpisode.episodeUrl);
            if (m3u8Url) {
                // Titolo con serie, stagione ed episodio
                const streamTitle = `${searchTitle} S${season}E${episode}`;

                // Descrizione dettagliata multi-linea
                const streamDescription = [
                    `🎬 ${streamTitle}`,
                    `🗣 [ITA]`,
                    `📺 1080p`,
                    `📝 ${targetEpisode.title || `Episodio ${episode}`}`
                ].join('\n');

                streams.push({
                    name: 'Loonex',  // Il nome verrà sostituito da providerLabel() in addon.ts
                    title: streamDescription,
                    url: m3u8Url,
                    behaviorHints: {
                        notWebReady: true,
                        bingeGroup: `loonex-${imdbId || tmdbId || 'unknown'}`,
                        proxyHeaders: {
                            request: {
                                'Origin': 'https://loonex.eu',
                                'Referer': 'https://loonex.eu/',
                                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36'
                            }
                        }
                    } as any
                });
            }
        } else {
            console.log(`[Loonex] Episode E${episode} not found in ${episodeList.length} available episodes`);
        }

        console.log(`[Loonex] Returning ${streams.length} stream(s)`);
        return streams;

    } catch (error) {
        console.error('[Loonex] Error in getLoonexStreams:', error);
        return [];
    }
}

/**
 * Funzione helper per aggiungere una normalizzazione statica
 * Nota: Le mappature statiche vanno aggiunte in src/config/loonexTitleMap.ts
 */
export function addTitleNormalization(id: string, loonexTitle: string) {
    const { LOONEX_TITLE_MAP } = require('../config/loonexTitleMap');
    LOONEX_TITLE_MAP[id] = loonexTitle;
    console.log(`[Loonex] Added static mapping: ${id} -> "${loonexTitle}"`);
}
