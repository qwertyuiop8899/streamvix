import axios from 'axios';
import * as cheerio from 'cheerio';
import { Stream } from 'stremio-addon-sdk';
import { getLoonexTitle } from '../config/loonexTitleMap';

const BASE_URL = 'https://loonex.eu';
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

        // 2. Scarica la homepage
        const response = await axios.get(BASE_URL, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);
        const series: LoonexSeries[] = [];

        // 3. Estrai tutte le serie dalla homepage
        $('.list-item').each((_, element) => {
            const $item = $(element);
            
            // Il titolo è dentro .item-main-title
            const title = $item.find('.item-main-title').text().trim();
            
            // Il link è dentro .item-link (attributo href)
            const href = $item.find('.item-link').attr('href');
            
            if (title && href) {
                series.push({
                    title,
                    url: href,
                    normalizedTitle: normalizeTitle(title)
                });
            }
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

        // Trova tutte le stagioni
        $('.season-header').each((_, seasonElement) => {
            const $season = $(seasonElement);
            const seasonTitle = $season.find('.season-title').text().trim();
            
            // Prendi il target del collapse per trovare gli episodi
            const target = $season.attr('data-bs-target');
            if (!target) return;

            // Trova il contenitore degli episodi
            const $episodeContainer = $(target);
            
            // Estrai tutti i link "GUARDA" in questa stagione
            $episodeContainer.find('.btn-watch').each((_, btnElement) => {
                const $btn = $(btnElement);
                const episodeUrl = $btn.attr('href');
                
                // Trova il titolo dell'episodio (nel div padre)
                const episodeTitle = $btn.closest('.episode-item, .d-flex')
                    .parent()
                    .find('.episode-title, .episode-number')
                    .text()
                    .trim();

                if (episodeUrl && episodeUrl.includes('/guarda/')) {
                    episodes.push({
                        title: episodeTitle || 'Episodio',
                        episodeUrl,
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

        const $ = cheerio.load(response.data);
        
        // Cerca il tag <source> con l'M3U8
        const m3u8Url = $('#video-source').attr('src') || 
                        $('source[type="application/x-mpegURL"]').attr('src') ||
                        $('source').filter((_, el) => {
                            const src = $(el).attr('src') || '';
                            return src.includes('.m3u8');
                        }).attr('src');

        if (m3u8Url) {
            console.log(`[Loonex] Found M3U8: ${m3u8Url}`);
            return m3u8Url;
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
        // Filtra gli episodi che contengono "0x00" o simili nel titolo
        const filteredEpisodes = episodes.filter(ep => {
            const title = ep.title.toLowerCase();
            // Rimuovi episodi che sono chiaramente 0x00 o "episodio 0"
            return !title.includes('0x00') && !title.match(/^0x0+$/);
        });
        
        if (filteredEpisodes.length < episodes.length) {
            console.log(`[Loonex] Filtered out ${episodes.length - filteredEpisodes.length} prequel episode(s) (0x00)`);
            episodes = filteredEpisodes;
        }

        // 3. Trova l'episodio richiesto
        // Dopo aver rimosso il 0x00, episode 1 = indice 0, episode 2 = indice 1, ecc.
        const streams: Stream[] = [];

        console.log(`[Loonex] Searching for S${season}E${episode} among ${episodes.length} episodes`);
        
        // Usa direttamente l'indice: episode 1 = indice 0, episode 2 = indice 1, ecc.
        const targetIndex = episode - 1;
        
        if (targetIndex >= 0 && targetIndex < episodes.length) {
            const targetEpisode = episodes[targetIndex];
            console.log(`[Loonex] Trying episode at index ${targetIndex}: ${targetEpisode.episodeUrl}`);
            
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
                        bingeGroup: `loonex-${imdbId || tmdbId || 'unknown'}`
                    }
                });
            }
        } else {
            console.log(`[Loonex] Episode index ${targetIndex} out of range (0-${episodes.length - 1})`);
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
