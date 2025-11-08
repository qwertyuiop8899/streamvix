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
 * Ottiene la configurazione MediaFlow da variabili di ambiente o config passata
 */
function getMediaFlowConfig(config?: { mfpUrl?: string; mfpPsw?: string }) {
    return {
        url: config?.mfpUrl || process.env.MFP_URL || process.env.MEDIAFLOW_PROXY_URL || '',
        password: config?.mfpPsw || process.env.MFP_PSW || process.env.MEDIAFLOW_PROXY_PASSWORD || ''
    };
}

/**
 * Ottiene il titolo della serie da TMDb usando IMDb ID o TMDb ID
 */
async function getTitleFromTMDb(imdbId?: string, tmdbId?: string, tmdbApiKey?: string): Promise<string | null> {
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
        
        console.log(`[ToonItalia] Fetching title from TMDb...`);
        const response = await axios.get(url, { timeout: 5000 });
        
        if (tmdbId) {
            // Risposta diretta da /tv/{id}
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
        const response = await axios.get(`${SEARCH_URL}${encodeURIComponent(searchQuery)}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        
        // Cerca il primo risultato che matcha
        const articles = $('article.post');
        
        for (let i = 0; i < articles.length; i++) {
            const article = articles.eq(i);
            const titleLink = article.find('.entry-title a');
            const title = titleLink.text().trim().toLowerCase();
            const url = titleLink.attr('href');
            
            if (title.includes(searchQuery.toLowerCase()) && url) {
                console.log(`[ToonItalia] Found match: ${title} -> ${url}`);
                return url;
            }
        }
        
        return null;
    } catch (error) {
        console.error('[ToonItalia] Search error:', error);
        return null;
    }
}

async function extractEpisodes(contentUrl: string, preferredSection?: string): Promise<EpisodeLink[]> {
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
        const html = entryContent.html() || '';
        
        // Se è specificata una sezione preferita, cerca solo in quella
        // Altrimenti, usa logica automatica: ignora DVD se ci sono altre sezioni
        let voeLinks;
        let currentContext = $; // Mantieni riferimento al contesto jQuery corretto
        
        if (preferredSection) {
            console.log(`[ToonItalia] Looking for preferred section: "${preferredSection}"`);
            
            // Trova tutte le sezioni H3 e cerca quella che corrisponde
            const headings = entryContent.find('h3');
            let targetHeading: any = null;
            
            headings.each((_, el) => {
                const headingText = $(el).text().trim();
                if (headingText.includes(preferredSection)) {
                    targetHeading = $(el);
                    console.log(`[ToonItalia] Found preferred section: "${headingText}"`);
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
                    voeLinks = sectionScope('a[href*="voe.sx"], a[href*="voe."]');
                    console.log(`[ToonItalia] Extracting episodes only from "${preferredSection}" section`);
                    console.log(`[ToonItalia] Found ${voeLinks.length} VOE links in preferred section`);
                } else {
                    console.log(`[ToonItalia] Preferred section "${preferredSection}" is empty`);
                    voeLinks = $();
                }
            } else {
                console.log(`[ToonItalia] Preferred section "${preferredSection}" not found, using all content`);
                voeLinks = entryContent.find('a[href*="voe.sx"], a[href*="voe."]');
                console.log(`[ToonItalia] Found ${voeLinks.length} VOE links in all content`);
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
            
            console.log(`[ToonItalia] Found ${sections.length} sections: ${sections.map(s => s.text).join(', ')}`);
            
            // Filtra sezioni non-DVD se esistono
            const nonDvdSections = sections.filter(s => !s.isDvd);
            const sectionsToUse = nonDvdSections.length > 0 ? nonDvdSections : sections;
            
            if (sectionsToUse.length > 0) {
                console.log(`[ToonItalia] Using sections: ${sectionsToUse.map(s => s.text).join(', ')}`);
                
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
                    voeLinks = sectionScope('a[href*="voe.sx"], a[href*="voe."]');
                    console.log(`[ToonItalia] Found ${voeLinks.length} VOE links in selected sections`);
                } else {
                    voeLinks = $();
                }
            } else {
                // Nessuna sezione trovata: usa tutto il contenuto
                voeLinks = entryContent.find('a[href*="voe.sx"], a[href*="voe."]');
                console.log(`[ToonItalia] No sections found, using all content (${voeLinks.length} VOE links)`);
            }
        }
        
        voeLinks.each((_, el) => {
            const voeUrl = currentContext(el).attr('href');
            if (!voeUrl) return;
            
            // Il numero episodio è nel TESTO PRIMA del link <a>
            // HTML: "001 – Diventiamo amici – <a href='...'>VOE</a>"
            // Strategia: prendo il PREVIOUS SIBLING TEXT NODE o uso il parent HTML per trovare il testo immediatamente prima
            
            // Ottieni il parent element e il suo HTML
            const parent = currentContext(el).parent();
            const parentHtml = parent.html() || '';
            
            // Skip se contiene "dvd" (case insensitive)
            if (/dvd/i.test(parentHtml)) {
                console.log(`[ToonItalia] Skipping DVD episode`);
                return;
            }
            
            // Trova la posizione del link href nell'HTML del parent
            const linkHrefIndex = parentHtml.indexOf(`href="${voeUrl}"`);
            if (linkHrefIndex === -1) {
                console.log(`[ToonItalia] Could not find link in parent HTML`);
                return;
            }
            
            // Prendi solo il testo PRIMA del link (max 200 caratteri prima per performance)
            const startIndex = Math.max(0, linkHrefIndex - 200);
            const textBeforeLink = parentHtml.substring(startIndex, linkHrefIndex);
            
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
                console.log(`[ToonItalia] Found S${season}E${episode}: ${voeUrl}`);
                episodes.push({ season, episode, voeUrl });
                return;
            }
            
            // Prova pattern solo numero episodio (3 cifre: 001, 002, etc.)
            const threeDigitMatch = cleanText.match(/\b(\d{3})\b/);
            if (threeDigitMatch) {
                const episode = threeDigitMatch[1];
                console.log(`[ToonItalia] Found episode ${episode}: ${voeUrl}`);
                episodes.push({ episode, voeUrl });
                return;
            }
            
            // Prova pattern episodio singolo con parola chiave
            const episodeWordMatch = cleanText.match(/(?:episodio|episode|ep|puntata)[\s\-:]*(\d+)/i);
            if (episodeWordMatch) {
                const episode = episodeWordMatch[1].padStart(3, '0');
                console.log(`[ToonItalia] Found episode ${episode}: ${voeUrl}`);
                episodes.push({ episode, voeUrl });
                return;
            }
            
            // Fallback: cerca qualsiasi numero di 1-2 cifre vicino a VOE
            const anyNumberMatch = cleanText.match(/\b(\d{1,2})\b/);
            if (anyNumberMatch) {
                const episode = anyNumberMatch[1].padStart(3, '0');
                console.log(`[ToonItalia] Found episode ${episode} (fallback): ${voeUrl}`);
                episodes.push({ episode, voeUrl });
                return;
            }
            
            console.log(`[ToonItalia] Could not parse episode from: ${cleanText.substring(0, 100)}`);
        });
        
        console.log(`[ToonItalia] Successfully parsed ${episodes.length} episodes`);
        return episodes;
        
    } catch (error) {
        console.error('[ToonItalia] Episode extraction error:', error);
        return [];
    }
}

async function getStreamFromVoe(voeUrl: string, config?: { mfpUrl?: string; mfpPsw?: string }): Promise<string | null> {
    try {
        const mfpConfig = getMediaFlowConfig(config);
        if (!mfpConfig.url || !mfpConfig.password) {
            console.error('[ToonItalia] MediaFlow proxy not configured');
            return null;
        }
        
        console.log('[ToonItalia] MediaFlow config:', { url: mfpConfig.url, hasPassword: !!mfpConfig.password });
        
        // Step 1: Chiama MediaFlow extractor con redirect=false
        const extractorUrl = `${mfpConfig.url}/extractor/video`;
        const params = new URLSearchParams({
            host: 'Voe',
            d: voeUrl,
            redirect_stream: 'false',
            api_password: mfpConfig.password
        });
        
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
                api_password: mfpConfig.password,
                d: destinationUrl
            });
            
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
                seriesName = await getTitleFromTMDb(imdbId, tmdbId, req.config?.tmdbApiKey);
                if (!seriesName) {
                    console.log('[ToonItalia] Could not fetch title from TMDb');
                    return streams;
                }
                console.log(`[ToonItalia] Got title from TMDb: "${seriesName}"`);
            }
        } else if (parts[0].startsWith('tmdb:')) {
            // Format: "tmdb:12345:episode" o "tmdb:12345:season:episode"
            tmdbId = parts[0].replace('tmdb:', '');
            
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
                seriesName = await getTitleFromTMDb(undefined, tmdbId, req.config?.tmdbApiKey);
                if (!seriesName) {
                    console.log('[ToonItalia] Could not fetch title from TMDb');
                    return streams;
                }
                console.log(`[ToonItalia] Got title from TMDb: "${seriesName}"`);
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
        const episodes = await extractEpisodes(contentUrl, preferredSection);
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
            console.log(`[ToonItalia] Preferred section has sequential format (${sequentialEpisodes.length} sequential vs ${seasonEpisodes.length} with season)`);
        } else {
            // Se abbiamo molti episodi con stagione MA solo 1-2 combinazioni uniche,
            // probabilmente è un parsing errato (es. tutti "S01E01")
            hasSeasonsInSite = uniqueSeasonEpisodes.size > 5;
            console.log(`[ToonItalia] Episodes with season format: ${seasonEpisodes.length} (${uniqueSeasonEpisodes.size} unique)`);
            console.log(`[ToonItalia] Site has real season format: ${hasSeasonsInSite}`);
        }
        
        // Step 4: Filtra episodio richiesto
        let targetEpisode = null;
        
        if (hasSeasonsInSite && season !== null) {
            // Il sito ha stagioni E la richiesta include stagione → match esatto
            targetEpisode = episodes.find(ep => 
                ep.season && parseInt(ep.season) === season && parseInt(ep.episode) === episode
            );
            console.log(`[ToonItalia] Searching for S${season}E${episode} (site has seasons)`);
        } else if (!hasSeasonsInSite && season !== null && episode !== null) {
            // Il sito NON ha stagioni MA la richiesta include stagione → ignora stagione, usa solo episodio
            console.log(`[ToonItalia] Site has no seasons - ignoring season ${season}, searching for episode ${episode}`);
            targetEpisode = episodes.find(ep => parseInt(ep.episode) === episode);
        } else if (episode !== null) {
            // Formato semplice: cerca solo per numero episodio
            console.log(`[ToonItalia] Searching for episode ${episode} (sequential)`);
            targetEpisode = episodes.find(ep => parseInt(ep.episode) === episode);
        }
        
        if (!targetEpisode) {
            console.log('[ToonItalia] Episode not found in list');
            return streams;
        }
        
        console.log(`[ToonItalia] Found target episode: ${targetEpisode.voeUrl}`);
        
        // Step 4: Ottieni stream da VOE via MediaFlow
        const streamUrl = await getStreamFromVoe(targetEpisode.voeUrl, req.config);
        
        if (streamUrl) {
            console.log(`[ToonItalia] Stream URL generated successfully`);
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
