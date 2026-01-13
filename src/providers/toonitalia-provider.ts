import axios from 'axios';
import * as cheerio from 'cheerio';
import { Stream } from 'stremio-addon-sdk';
import { formatMediaFlowUrl } from '../utils/mediaflow';

const BASE_URL = 'https://toonitalia.xyz';
const SEARCH_URL = `${BASE_URL}/?s=`;

/**
 * Interfaccia per la richiesta dello stream
 */
interface StreamRequest {
    id: string; // format: "seriesName:season:episode"
    type: 'movie' | 'series';
    config?: {
        mfpUrl?: string;
        mfpPsw?: string;
        tmdbApiKey?: string;
    };
}

/**
 * Ottiene la configurazione MediaFlow dalla config passata, con fallback a env vars (per installazioni locali)
 */
function getMediaFlowConfig(config?: { mfpUrl?: string; mfpPsw?: string }) {
    return {
        url: config?.mfpUrl || process.env.MFP_URL || process.env.MEDIAFLOW_PROXY_URL || '',
        password: config?.mfpPsw || process.env.MFP_PSW || process.env.MEDIAFLOW_PROXY_PASSWORD || ''
    };
}

/**
 * Ottiene il titolo e il numero di stagioni della serie da TMDb usando IMDb ID o TMDb ID
 */
async function getSeriesInfoFromTMDb(imdbId?: string, tmdbId?: string, tmdbApiKey?: string): Promise<{ title: string; seasonCount: number } | null> {
    try {
        const apiKey = tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0';
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

        console.log(`[ToonItalia] Fetching series info from TMDb...`);
        const response = await axios.get(url, { timeout: 5000 });

        if (tmdbId) {
            // Risposta diretta da /tv/{id}
            const title = response.data.name || response.data.original_name;
            const seasonCount = response.data.number_of_seasons || 1;
            console.log(`[ToonItalia] TMDb info: "${title}" has ${seasonCount} season(s)`);
            return title ? { title, seasonCount } : null;
        } else {
            // Risposta da /find
            const results = response.data.tv_results || [];
            if (results.length > 0) {
                const title = results[0].name || results[0].original_name;
                // Per /find non abbiamo number_of_seasons, dobbiamo fare una seconda chiamata
                const tvId = results[0].id;
                const detailUrl = `https://api.themoviedb.org/3/tv/${tvId}?api_key=${apiKey}&language=it-IT`;
                const detailResponse = await axios.get(detailUrl, { timeout: 5000 });
                const seasonCount = detailResponse.data.number_of_seasons || 1;
                console.log(`[ToonItalia] TMDb info: "${title}" has ${seasonCount} season(s)`);
                return title ? { title, seasonCount } : null;
            }
        }

        return null;
    } catch (error) {
        console.error('[ToonItalia] Error fetching from TMDb:', error);
        return null;
    }
}

// Carica normalizzazioni e overrides
interface NormalizationConfig {
    title_aliases?: { [key: string]: string };
    id_overrides?: {
        [key: string]: {
            url: string;
            section?: string;
        }
    };
}

let normalizationConfig: NormalizationConfig = {};
try {
    normalizationConfig = require('../config/toonitalia-normalizations.json');
} catch (e) {
    console.log('No toonitalia normalizations file found');
}

function normalizeTitle(title: string): string {
    const lower = title.toLowerCase().trim();
    const aliases = normalizationConfig.title_aliases || {};
    return aliases[lower] || lower;
}

function getIdOverride(id: string): { url: string; section?: string } | null {
    const overrides = normalizationConfig.id_overrides || {};
    return overrides[id] || null;
}

interface EpisodeLink {
    episode: string;
    season?: string;
    voeUrl: string;
}

async function searchContent(query: string): Promise<string | null> {
    try {
        const searchQuery = normalizeTitle(query);
        console.log(`[ToonItalia][Search] Query: "${query}" -> normalized: "${searchQuery}"`);

        const response = await axios.get(`${SEARCH_URL}${encodeURIComponent(searchQuery)}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(response.data);

        // Funzione per normalizzare stringa: solo lettere e numeri
        const normalizeForMatch = (str: string) => {
            return str
                .toLowerCase()
                .normalize('NFD')  // Decompone caratteri accentati
                .replace(/[\u0300-\u036f]/g, '')  // Rimuove diacritici
                .replace(/[^a-z0-9]/g, '')  // Tiene solo lettere e numeri
                .trim();
        };

        const articles = $('article.post');
        const searchNormalized = normalizeForMatch(searchQuery);

        for (let i = 0; i < articles.length; i++) {
            const article = articles.eq(i);
            const titleLink = article.find('.entry-title a');
            const title = titleLink.text().trim();
            const titleNormalized = normalizeForMatch(title);
            const url = titleLink.attr('href');

            if (titleNormalized.includes(searchNormalized) && url) {
                console.log(`[ToonItalia] Match found: "${title}" -> ${url}`);
                return url;
            }
        }

        console.log(`[ToonItalia] No match found for: "${query}"`);
        return null;
    } catch (error) {
        console.error('[ToonItalia] Search error:', error);
        return null;
    }
}

async function extractEpisodes(contentUrl: string, tmdbSeasonCount: number, preferredSection?: string): Promise<EpisodeLink[]> {
    try {
        const response = await axios.get(contentUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        const episodes: EpisodeLink[] = [];

        // Cerca tutto il contenuto
        const entryContent = $('.entry-content');

        // STEP 1: Rileva stagioni VERE cercando intestazioni con parole chiave
        // NON usare gli anchor <a name="S01"> perché non sono affidabili!
        // Cerca h3, h4, strong, b con "Stagione X", "Season X", "Parte X"
        const seasonHeadings: Array<{ element: any; seasonNum: number; text: string }> = [];

        // Cerca in tutti i possibili elementi che possono contenere titoli di stagione
        entryContent.find('h3, h4, strong, b, p').each((_, el) => {
            const text = $(el).text().trim();
            // Pattern per "Stagione 1", "Season 2", "Parte 1", "1ª Stagione", "1° Stagione", etc.
            const seasonPattern = /(\d+)[ªº°]\s*(?:stagione|season|parte)|(?:stagione|season|parte|серия)\s*(\d+)/i;
            const match = text.match(seasonPattern);

            if (match) {
                const seasonNum = parseInt(match[1] || match[2]);
                // Verifica che non sia parte del titolo di un episodio (es. "001 - Stagione del raccolto")
                // Se il testo è breve/medio (< 100 caratteri) è probabilmente un'intestazione
                if (text.length < 100 && seasonNum > 0 && seasonNum < 20) {
                    seasonHeadings.push({
                        element: $(el),
                        seasonNum,
                        text
                    });
                    console.log(`[ToonItalia] Found season heading: "${text}" -> Season ${seasonNum}`);
                }
            }
        });

        console.log(`[ToonItalia] Found ${seasonHeadings.length} real season headings`);

        // STEP 2: Decidi se usare le intestazioni trovate in base a TMDb
        // Se TMDb dice "1 stagione", ignora le intestazioni su ToonItalia (potrebbero essere sezioni DVD, ecc.)
        // Se TMDb dice "2+ stagioni", usa le intestazioni per separare le stagioni
        const shouldUseSeasonHeadings = tmdbSeasonCount > 1 && seasonHeadings.length > 0;

        console.log(`[ToonItalia] TMDb seasons: ${tmdbSeasonCount}, Will use season headings: ${shouldUseSeasonHeadings}`);

        // STEP 3: Costruisci mappa VOE URL -> Stagione basata sulle intestazioni VERE (solo se TMDb ha 2+ stagioni)
        const voeToSeasonMap = new Map<string, string>();

        if (shouldUseSeasonHeadings) {
            // Per ogni intestazione di stagione, trova tutti i VOE link fino alla prossima intestazione
            seasonHeadings.forEach((seasonHeading, idx) => {
                const seasonNum = seasonHeading.seasonNum.toString().padStart(2, '0');
                console.log(`[ToonItalia] Processing season ${seasonNum}: "${seasonHeading.text}"`);

                // Trova tutti gli elementi dopo questa intestazione fino alla prossima
                let current = seasonHeading.element.next();
                const nextSeasonHeading = seasonHeadings[idx + 1];

                let voeCount = 0;
                while (current.length > 0) {
                    // Se siamo arrivati alla prossima intestazione di stagione, fermati
                    if (nextSeasonHeading && current.is(nextSeasonHeading.element)) {
                        break;
                    }

                    // Cerca link VOE in questo elemento e nei suoi discendenti
                    const voeLinksInSection = current.find('a[href*="voe.sx"], a[href*="voe."], a[href*="chuckle-tube.com"]');

                    if (current.is('a[href*="voe.sx"], a[href*="voe."], a[href*="chuckle-tube.com"]')) {
                        const href = current.attr('href');
                        if (href) {
                            voeToSeasonMap.set(href, seasonNum);
                            voeCount++;
                        }
                    }

                    voeLinksInSection.each((_: any, linkEl: any) => {
                        const href = $(linkEl).attr('href');
                        if (href) {
                            voeToSeasonMap.set(href, seasonNum);
                            voeCount++;
                        }
                    });

                    current = current.next();
                }

                console.log(`[ToonItalia] Season ${seasonNum}: mapped ${voeCount} VOE links`);
            });

            console.log(`[ToonItalia] Total mapped: ${voeToSeasonMap.size} VOE links to seasons`);
        }

        // STEP 3: Ora filtriamo le sezioni e estraiamo i VOE links
        // Se è specificata una sezione preferita, cerca solo in quella
        // Altrimenti, usa logica automatica: ignora DVD se ci sono altre sezioni
        let voeLinks;
        let currentContext = $; // Mantieni riferimento al contesto jQuery corretto

        if (preferredSection) {
            // Trova tutte le sezioni H3 e cerca quella che corrisponde
            const headings = entryContent.find('h3');
            let targetHeading: any = null;

            headings.each((_, el) => {
                const headingText = $(el).text().trim();
                if (headingText.includes(preferredSection)) {
                    targetHeading = $(el);
                    return false; // break
                }
            });

            // Se trovata la sezione, prendi solo i link VOE dopo di essa fino al prossimo H3
            if (targetHeading) {
                // Costruisci HTML solo della sezione target
                let sectionHtml = '';
                let current = targetHeading.next();

                while (current.length > 0 && !current.is('h3')) {
                    sectionHtml += $.html(current);
                    current = current.next();
                }

                if (sectionHtml) {
                    // Crea un nuovo contesto Cheerio SOLO con il contenuto della sezione
                    const sectionScope = cheerio.load(sectionHtml);
                    currentContext = sectionScope;
                    voeLinks = sectionScope('a[href*="voe.sx"], a[href*="voe."], a[href*="chuckle-tube.com"]');
                } else {
                    voeLinks = $();
                }
            } else {
                voeLinks = entryContent.find('a[href*="voe.sx"], a[href*="voe."], a[href*="chuckle-tube.com"]');
            }
        } else {
            // Nessuna sezione preferita: usa logica automatica
            // Se ci sono più sezioni, ignora quelle con "DVD" e usa le altre
            const headings = entryContent.find('h3');
            const sections: Array<{ heading: any; text: string; isDvd: boolean }> = [];

            headings.each((_, el) => {
                const headingText = $(el).text().trim();
                const isDvd = /dvd/i.test(headingText);
                sections.push({ heading: $(el), text: headingText, isDvd });
            });

            // Filtra sezioni non-DVD se esistono
            const nonDvdSections = sections.filter(s => !s.isDvd);
            const sectionsToUse = nonDvdSections.length > 0 ? nonDvdSections : sections;

            if (sectionsToUse.length > 0) {
                // Combina HTML di tutte le sezioni selezionate
                let combinedHtml = '';
                sectionsToUse.forEach(section => {
                    let current = section.heading.next();
                    while (current.length > 0 && !current.is('h3')) {
                        combinedHtml += $.html(current);
                        current = current.next();
                    }
                });

                if (combinedHtml) {
                    const sectionScope = cheerio.load(combinedHtml);
                    currentContext = sectionScope;
                    voeLinks = sectionScope('a[href*="voe.sx"], a[href*="voe."], a[href*="chuckle-tube.com"]');
                } else {
                    voeLinks = $();
                }
            } else {
                // Nessuna sezione trovata: usa tutto il contenuto
                voeLinks = entryContent.find('a[href*="voe.sx"], a[href*="voe."], a[href*="chuckle-tube.com"]');
            }
        }

        // STEP 4: Estrai episodi e associa alle stagioni se necessario
        voeLinks.each((_, el) => {
            const voeUrl = currentContext(el).attr('href');
            if (!voeUrl) return;

            // Il numero episodio è nel TESTO PRIMA del link <a>
            // HTML: "001 – Diventiamo amici – <a href='...'>VOE</a>"
            // Strategia: prendo il PREVIOUS SIBLING TEXT NODE o uso il parent HTML per trovare il testo immediatamente prima

            // Ottieni il parent element e il suo HTML
            const parent = currentContext(el).parent();
            const parentHtml = parent.html() || '';

            // Trova la posizione del link href nell'HTML del parent
            const linkHrefIndex = parentHtml.indexOf(`href="${voeUrl}"`);
            if (linkHrefIndex === -1) {
                console.log(`[ToonItalia] Could not find link in parent HTML`);
                return;
            }

            // Prendi solo il testo PRIMA del link (max 200 caratteri prima per performance)
            const startIndex = Math.max(0, linkHrefIndex - 200);
            const textBeforeLink = parentHtml.substring(startIndex, linkHrefIndex);

            // Skip se contiene "dvd" (case insensitive) come parola intera nel contesto immediato
            if (/\bdvd\b/i.test(textBeforeLink)) {
                console.log(`[ToonItalia] Skipping DVD episode (found in context)`);
                return;
            }

            // Rimuovi tag HTML
            const cleanText = textBeforeLink.replace(/<[^>]*>/g, ' ').trim();

            // Pattern flessibili per episodi:
            // 1. Stagione + Episodio: "1×01", "1x01", "S1E01", "1 - 01", "Stagione 1 Episodio 01"
            // 2. Solo episodio: "001", "01", "Episodio 1"

            // Prova pattern stagione × episodio (più specifico)
            let seasonMatch = cleanText.match(/(?:stagione|season|s)?[\s\-]*(\d+)[\s]*[×x\-][\s]*(?:episodio|episode|ep|e)?[\s]*(\d+)/i);

            if (seasonMatch) {
                const season = seasonMatch[1].padStart(2, '0');
                const episode = seasonMatch[2].padStart(2, '0');
                episodes.push({ season, episode, voeUrl });
                return;
            }

            // Prova pattern solo numero episodio (3 cifre: 001, 002, etc.)
            const threeDigitMatch = cleanText.match(/\b(\d{3})\b/);
            if (threeDigitMatch) {
                const episode = threeDigitMatch[1];

                // Se abbiamo una mappa stagioni, associa questo episodio alla sua stagione
                const seasonFromMap = voeToSeasonMap.get(voeUrl);
                if (seasonFromMap) {
                    episodes.push({ season: seasonFromMap, episode, voeUrl });
                } else {
                    episodes.push({ episode, voeUrl });
                }
                return;
            }

            // Prova pattern episodio singolo con parola chiave
            const episodeWordMatch = cleanText.match(/(?:episodio|episode|ep|puntata)[\s\-:]*(\d+)/i);
            if (episodeWordMatch) {
                const episode = episodeWordMatch[1].padStart(3, '0');
                const seasonFromMap = voeToSeasonMap.get(voeUrl);
                if (seasonFromMap) {
                    episodes.push({ season: seasonFromMap, episode, voeUrl });
                } else {
                    episodes.push({ episode, voeUrl });
                }
                return;
            }

            // Fallback: cerca qualsiasi numero di 1-2 cifre vicino a VOE
            const anyNumberMatch = cleanText.match(/\b(\d{1,2})\b/);
            if (anyNumberMatch) {
                const episode = anyNumberMatch[1].padStart(3, '0');
                const seasonFromMap = voeToSeasonMap.get(voeUrl);
                if (seasonFromMap) {
                    episodes.push({ season: seasonFromMap, episode, voeUrl });
                } else {
                    episodes.push({ episode, voeUrl });
                }
                return;
            }
        });

        console.log(`[ToonItalia] Parsed ${episodes.length} episodes from page`);
        return episodes;

    } catch (error) {
        console.error('[ToonItalia] Episode extraction error:', error);
        return [];
    }
}

async function getStreamFromVoe(voeUrl: string, config?: { mfpUrl?: string; mfpPsw?: string }): Promise<string | null> {
    try {
        const mfpConfig = getMediaFlowConfig(config);
        if (!mfpConfig.url) {
            console.error('[ToonItalia] MediaFlow proxy URL not configured');
            return null;
        }

        console.log('[ToonItalia] MediaFlow config:', { url: mfpConfig.url, hasPassword: !!mfpConfig.password });

        // Step 1: Chiama MediaFlow extractor con redirect=false
        const extractorUrl = `${mfpConfig.url}/extractor/video`;
        const params = new URLSearchParams({
            host: 'Voe',
            d: voeUrl,
            redirect_stream: 'false'
        });
        if (mfpConfig.password) {
            params.append('api_password', mfpConfig.password);
        }

        const response = await axios.get(`${extractorUrl}?${params.toString()}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
            }
        });

        if (response.data && response.data.destination_url) {
            const destinationUrl = response.data.destination_url;
            const requestHeaders = response.data.request_headers || {};

            // Step 2: Costruisci il link finale con MediaFlow proxy
            const proxyUrl = `${mfpConfig.url}/proxy/hls/manifest.m3u8`;
            const proxyParams = new URLSearchParams({
                d: destinationUrl
            });
            if (mfpConfig.password) {
                proxyParams.append('api_password', mfpConfig.password);
            }

            // Aggiungi headers
            if (requestHeaders['user-agent']) {
                proxyParams.append('h_user-agent', requestHeaders['user-agent']);
            }
            if (requestHeaders['referer']) {
                proxyParams.append('h_referer', requestHeaders['referer']);
            }

            return `${proxyUrl}?${proxyParams.toString()}`;
        }

        return null;

    } catch (error) {
        console.error('[ToonItalia] VOE stream extraction error:', error);
        return null;
    }
}

export async function toonitalia(req: StreamRequest): Promise<Stream[]> {
    console.log('[ToonItalia] Request:', req);
    console.log('[ToonItalia] Config received:', {
        hasMfpUrl: !!req.config?.mfpUrl,
        hasMfpPsw: !!req.config?.mfpPsw,
        hasTmdbApiKey: !!req.config?.tmdbApiKey,
        mfpUrl: req.config?.mfpUrl || 'MISSING',
        mfpPsw: req.config?.mfpPsw ? '***' : 'MISSING'
    });

    const streams: Stream[] = [];

    try {
        // Parse request - ora accetta formato "imdbId:tmdbId:season:episode" o "title:season:episode"
        const parts = req.id.split(':');

        let seriesName: string | null = null;
        let imdbId: string | undefined;
        let tmdbId: string | undefined;
        let season: number | null = null;
        let episode: number | null = null;
        let contentUrl: string | null = null;
        let preferredSection: string | undefined;
        let tmdbSeasonCount: number = 1; // Default: 1 stagione

        // Detect format
        if (parts[0].startsWith('tt')) {
            // Format: "tt1234567:episode" o "tt1234567:season:episode" o "tt1234567:tmdb123:season:episode"
            imdbId = parts[0];

            if (parts.length === 2) {
                // Episodio sequenziale: tt1234567:1
                episode = parseInt(parts[1]);
                console.log(`[ToonItalia] Sequential episode format: ${imdbId}:${episode}`);
            } else if (parts[1] && !isNaN(parseInt(parts[1]))) {
                // "tt1234567:season:episode"
                season = parseInt(parts[1]);
                episode = parts[2] ? parseInt(parts[2]) : null;
                console.log(`[ToonItalia] Season/episode format: ${imdbId}:${season}:${episode}`);
            } else {
                // "tt1234567:tmdb123:season:episode"
                tmdbId = parts[1];
                season = parts[2] ? parseInt(parts[2]) : null;
                episode = parts[3] ? parseInt(parts[3]) : null;
                console.log(`[ToonItalia] Full format: ${imdbId}:${tmdbId}:${season}:${episode}`);
            }

            // CHECK 1: Verifica override per IMDb ID
            const override = getIdOverride(imdbId);
            if (override) {
                console.log(`[ToonItalia] Found override for ${imdbId}:`);
                console.log(`[ToonItalia]   URL: ${override.url}`);
                if (override.section) {
                    console.log(`[ToonItalia]   Section: ${override.section}`);
                    preferredSection = override.section;
                }
                contentUrl = override.url;
                seriesName = 'Override'; // Placeholder name
            } else {
                // Fetch title from TMDb
                const seriesInfo = await getSeriesInfoFromTMDb(imdbId, tmdbId, req.config?.tmdbApiKey);
                if (!seriesInfo) {
                    console.log('[ToonItalia] Could not fetch title from TMDb');
                    return streams;
                }
                seriesName = seriesInfo.title;
                tmdbSeasonCount = seriesInfo.seasonCount;
                console.log(`[ToonItalia] Got series from TMDb: "${seriesName}" (${tmdbSeasonCount} seasons)`);
            }
        } else if (parts[0].startsWith('tmdb')) {
            // Format: "tmdb12345:episode" o "tmdb12345:season:episode"
            tmdbId = parts[0].replace('tmdb', '');

            if (parts.length === 2) {
                // Episodio sequenziale: tmdb:12345:1
                episode = parseInt(parts[1]);
                console.log(`[ToonItalia] Sequential episode format: tmdb:${tmdbId}:${episode}`);
            } else if (parts.length >= 3) {
                // tmdb:12345:season:episode
                season = parseInt(parts[1]);
                episode = parseInt(parts[2]);
                console.log(`[ToonItalia] Season/episode format: tmdb:${tmdbId}:${season}:${episode}`);
            }

            // CHECK 2: Verifica override per TMDb ID
            const override = getIdOverride(`tmdb:${tmdbId}`);
            if (override) {
                console.log(`[ToonItalia] Found override for tmdb:${tmdbId}:`);
                console.log(`[ToonItalia]   URL: ${override.url}`);
                if (override.section) {
                    console.log(`[ToonItalia]   Section: ${override.section}`);
                    preferredSection = override.section;
                }
                contentUrl = override.url;
                seriesName = 'Override'; // Placeholder name
            } else {
                // Fetch title from TMDb
                const seriesInfo = await getSeriesInfoFromTMDb(undefined, tmdbId, req.config?.tmdbApiKey);
                if (!seriesInfo) {
                    console.log('[ToonItalia] Could not fetch title from TMDb');
                    return streams;
                }
                seriesName = seriesInfo.title;
                tmdbSeasonCount = seriesInfo.seasonCount;
                console.log(`[ToonItalia] Got series from TMDb: "${seriesName}" (${tmdbSeasonCount} seasons)`);
            }
        } else {
            // Format: "title:episode" o "title:season:episode" (legacy)
            seriesName = parts[0];

            if (parts.length === 2) {
                episode = parseInt(parts[1]);
            } else if (parts.length >= 3) {
                season = parseInt(parts[1]);
                episode = parseInt(parts[2]);
            }
        }

        if (!seriesName) {
            return streams;
        }

        // Step 1: Cerca il contenuto (se non abbiamo già l'URL dall'override)
        if (!contentUrl) {
            contentUrl = await searchContent(seriesName);
            if (!contentUrl) {
                console.log('[ToonItalia] Content not found');
                return streams;
            }
        }

        // Step 2: Estrai episodi (con sezione preferita se specificata)
        const episodes = await extractEpisodes(contentUrl, tmdbSeasonCount, preferredSection);
        if (episodes.length === 0) {
            console.log('[ToonItalia] No episodes found');
            return streams;
        }

        // Step 3: Determina se il sito ha episodi con stagioni o solo sequenziali
        // Conta episodi UNICI con formato stagione
        const seasonEpisodes = episodes.filter(ep => ep.season !== undefined);
        const sequentialEpisodes = episodes.filter(ep => ep.season === undefined);
        const uniqueSeasonEpisodes = new Set(
            seasonEpisodes.map(ep => `${ep.season}:${ep.episode}`)
        );

        // Se c'è una sezione preferita (es. "Episodi TV:"), considera solo il formato prevalente in quella sezione
        // Se gli episodi sequenziali (senza stagione) sono la maggioranza, usa formato sequenziale
        let hasSeasonsInSite: boolean;

        if (preferredSection && sequentialEpisodes.length > seasonEpisodes.length) {
            // La sezione preferita ha principalmente episodi sequenziali
            hasSeasonsInSite = false;
        } else {
            // Se abbiamo molti episodi con stagione MA solo 1-2 combinazioni uniche,
            // probabilmente è un parsing errato (es. tutti "S01E01")
            hasSeasonsInSite = uniqueSeasonEpisodes.size > 5;
        }

        // Step 4: Filtra episodio richiesto
        let targetEpisode = null;

        if (hasSeasonsInSite && season !== null && episode !== null) {
            // Il sito ha stagioni E la richiesta include stagione
            // Prima prova match diretto (se gli episodi sono numerati da 1 per ogni stagione)
            targetEpisode = episodes.find(ep =>
                ep.season && parseInt(ep.season) === season && parseInt(ep.episode) === episode
            );

            // Se non trovato, calcola offset (episodi con numerazione continua)
            if (!targetEpisode) {
                // Filtra episodi per stagione richiesta
                const episodesInSeason = episodes.filter(ep => ep.season && parseInt(ep.season) === season);

                if (episodesInSeason.length > 0) {
                    // Ordina per numero episodio
                    episodesInSeason.sort((a, b) => parseInt(a.episode) - parseInt(b.episode));

                    // L'episodio richiesto è l'N-esimo della stagione (0-indexed)
                    if (episode - 1 < episodesInSeason.length) {
                        targetEpisode = episodesInSeason[episode - 1];
                        console.log(`[ToonItalia] Using offset matching: S${season}E${episode} -> episode ${targetEpisode.episode} (${episode}-th in season)`);
                    }
                }
            }
        } else if (!hasSeasonsInSite && season !== null && episode !== null) {
            // Il sito NON ha stagioni MA la richiesta include stagione → ignora stagione, usa solo episodio
            targetEpisode = episodes.find(ep => parseInt(ep.episode) === episode);
        } else if (episode !== null) {
            // Formato semplice: cerca solo per numero episodio
            targetEpisode = episodes.find(ep => parseInt(ep.episode) === episode);
        }

        if (!targetEpisode) {
            console.log(`[ToonItalia] Episode S${season}E${episode} not found in ${episodes.length} parsed episodes`);
            return streams;
        }

        console.log(`[ToonItalia] Requesting S${season}E${episode}: ${targetEpisode.voeUrl}`);

        // Step 4: Ottieni stream da VOE via MediaFlow
        const streamUrl = await getStreamFromVoe(targetEpisode.voeUrl, req.config);

        if (streamUrl) {
            streams.push({
                name: 'ToonItalia',
                title: `ToonItalia - ${season ? `S${season.toString().padStart(2, '0')}E${episode?.toString().padStart(2, '0')}` : `Ep. ${episode}`}`,
                url: streamUrl,
                behaviorHints: {
                    notWebReady: true,
                    bingeGroup: `toonitalia-${seriesName}`
                }
            });
        } else {
            console.error('[ToonItalia] Failed to get stream URL from VOE');
        }

    } catch (error) {
        console.error('[ToonItalia] Provider error:', error);
    }

    return streams;
}
