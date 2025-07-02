import { spawn } from 'child_process';
import { KitsuProvider } from './kitsu';
import { formatMediaFlowUrl } from '../utils/mediaflow';
import { AnimeUnityConfig, StreamForStremio } from '../types/animeunity';
import * as path from 'path';
import axios from 'axios';

// Helper function to invoke the Python scraper
async function invokePythonScraper(args: string[]): Promise<any> {
    const scriptPath = path.join(__dirname, 'animeunity_scraper.py');
    
    // Use python3, ensure it's in the system's PATH
    const command = 'python3';

    return new Promise((resolve, reject) => {
        const pythonProcess = spawn(command, [scriptPath, ...args]);

        let stdout = '';
        let stderr = '';

        pythonProcess.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        pythonProcess.on('close', (code: number) => {
            if (code !== 0) {
                console.error(`Python script exited with code ${code}`);
                console.error(stderr);
                return reject(new Error(`Python script error: ${stderr}`));
            }
            try {
                resolve(JSON.parse(stdout));
            } catch (e) {
                console.error('Failed to parse Python script output:');
                console.error(stdout);
                reject(new Error('Failed to parse Python script output.'));
            }
        });

        pythonProcess.on('error', (err: Error) => {
            console.error('Failed to start Python script:', err);
            reject(err);
        });
    });
}

interface AnimeUnitySearchResult {
    id: number;
    slug: string;
    name: string;
    episodes_count: number;
}

interface AnimeUnityEpisode {
    id: number;
    number: string;
    name?: string;
}

interface AnimeUnityStreamData {
    episode_page: string;
    embed_url: string;
    mp4_url: string;
}

// Funzione universale per ottenere il titolo inglese da qualsiasi ID
async function getEnglishTitleFromAnyId(id: string, type: 'imdb'|'tmdb'|'kitsu'|'mal', tmdbApiKey?: string): Promise<string> {
  let malId: string | null = null;
  let tmdbId: string | null = null;
  let fallbackTitle: string | null = null;
  const tmdbKey = tmdbApiKey || process.env.TMDB_API_KEY || '';
  if (type === 'imdb') {
    if (!tmdbKey) throw new Error('TMDB_API_KEY non configurata');
    const imdbIdOnly = id.split(':')[0];
    const { getTmdbIdFromImdbId } = await import('../extractor');
    tmdbId = await getTmdbIdFromImdbId(imdbIdOnly, tmdbKey);
    if (!tmdbId) throw new Error('TMDB ID non trovato per IMDB: ' + id);
    try {
      const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json();
      malId = haglundResp[0]?.myanimelist?.toString() || null;
    } catch {}
  } else if (type === 'tmdb') {
    tmdbId = id;
    try {
      const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json();
      malId = haglundResp[0]?.myanimelist?.toString() || null;
    } catch {}
  } else if (type === 'kitsu') {
    const mappingsResp = await (await fetch(`https://kitsu.io/api/edge/anime/${id}/mappings`)).json();
    const malMapping = mappingsResp.data?.find((m: any) => m.attributes.externalSite === 'myanimelist/anime');
    malId = malMapping?.attributes?.externalId?.toString() || null;
  } else if (type === 'mal') {
    malId = id;
  }
  if (malId) {
    try {
      const jikanResp = await (await fetch(`https://api.jikan.moe/v4/anime/${malId}`)).json();
      let englishTitle = '';
      if (jikanResp.data && Array.isArray(jikanResp.data.titles)) {
        const en = jikanResp.data.titles.find((t: any) => t.type === 'English');
        englishTitle = en?.title || '';
      }
      if (!englishTitle && jikanResp.data) {
        englishTitle = jikanResp.data.title_english || jikanResp.data.title || jikanResp.data.title_japanese || '';
      }
      if (englishTitle) {
        console.log(`[UniversalTitle] Titolo inglese trovato da Jikan: ${englishTitle}`);
        return englishTitle;
      }
    } catch (err) {
      console.warn('[UniversalTitle] Errore Jikan, provo fallback TMDB:', err);
    }
  }
  if (tmdbId && tmdbKey) {
    try {
      let tmdbResp = await (await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${tmdbKey}`)).json();
      if (tmdbResp && tmdbResp.name) {
        fallbackTitle = tmdbResp.name;
      }
      if (!fallbackTitle) {
        tmdbResp = await (await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdbKey}`)).json();
        if (tmdbResp && tmdbResp.title) {
          fallbackTitle = tmdbResp.title;
        }
      }
      if (fallbackTitle) {
        console.warn(`[UniversalTitle] Fallback: uso titolo da TMDB: ${fallbackTitle}`);
        return fallbackTitle;
      }
    } catch (err) {
      console.warn('[UniversalTitle] Errore fallback TMDB:', err);
    }
  }
  throw new Error('Impossibile ottenere titolo inglese da nessuna fonte per ' + id);
}

function filterAnimeResults(results: { version: AnimeUnitySearchResult; language_type: string }[], englishTitle: string) {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const base = norm(englishTitle);
  const allowed = [
    base,
    `${base} (ita)`,
    `${base} (cr)`,
    `${base} (ita) (cr)`
  ];
  const isAllowed = (title: string) => {
    const t = norm(title.replace(/\s*\([^)]*\)/g, match => match.toLowerCase()));
    return allowed.some(a => t === a);
  };
  const filtered = results.filter(r => isAllowed(r.version.name));
  console.log(`[UniversalTitle] Risultati prima del filtro:`, results.map(r => r.version.name));
  console.log(`[UniversalTitle] Risultati dopo il filtro:`, filtered.map(r => r.version.name));
  return filtered;
}

// Funzione di normalizzazione custom per la ricerca
function normalizeTitleForSearch(title: string): string {
  const replacements: Record<string, string> = {
    'Attack on Titan': "L'attacco dei Giganti",
    'Season': '',
    'Shippuuden': 'Shippuden',
    '-': '',
    'Ore dake Level Up na Ken': 'Solo Leveling',
    // Qui puoi aggiungere altre normalizzazioni custom
  };
  let normalized = title;
  for (const [key, value] of Object.entries(replacements)) {
    normalized = normalized.replace(key, value);
  }
  if (normalized.includes('Naruto:')) {
    normalized = normalized.replace(':', '');
  }
  return normalized.trim();
}

export class AnimeUnityProvider {
  private kitsuProvider = new KitsuProvider();

  constructor(private config: AnimeUnityConfig) {}

  private async searchAllVersions(title: string): Promise<{ version: AnimeUnitySearchResult; language_type: string }[]> {
      const subPromise = invokePythonScraper(['search', '--query', title]).catch(() => []);
      const dubPromise = invokePythonScraper(['search', '--query', title, '--dubbed']).catch(() => []);

      const [subResults, dubResults]: [AnimeUnitySearchResult[], AnimeUnitySearchResult[]] = await Promise.all([subPromise, dubPromise]);
      const results: { version: AnimeUnitySearchResult; language_type: string }[] = [];

      // Unisci tutti i risultati (SUB e DUB), ma assegna ITA o CR se il nome contiene
      const allResults = [...subResults, ...dubResults];
      // Filtra duplicati per nome e id
      const seen = new Set();
      for (const r of allResults) {
        const key = r.name + '|' + r.id;
        if (seen.has(key)) continue;
        seen.add(key);
        const nameLower = r.name.toLowerCase();
        let language_type = 'SUB';
        if (nameLower.includes('cr')) {
          language_type = 'CR';
        } else if (nameLower.includes('ita')) {
          language_type = 'ITA';
        }
        results.push({ version: r, language_type });
      }
      return results;
  }

  async handleKitsuRequest(kitsuIdString: string): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) {
      return { streams: [] };
    }

    try {
      const { kitsuId, seasonNumber, episodeNumber, isMovie } = this.kitsuProvider.parseKitsuId(kitsuIdString);
      const englishTitle = await getEnglishTitleFromAnyId(kitsuId, 'kitsu', this.config.tmdbApiKey);
      console.log(`[AnimeUnity] Ricerca con titolo inglese: ${englishTitle}`);
      return this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
    } catch (error) {
      console.error('Error handling Kitsu request:', error);
      return { streams: [] };
    }
  }

  /**
   * Gestisce la ricerca AnimeUnity partendo da un ID MAL (mal:ID[:STAGIONE][:EPISODIO])
   */
  async handleMalRequest(malIdString: string): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) {
      return { streams: [] };
    }
    try {
      const parts = malIdString.split(':');
      if (parts.length < 2) throw new Error('Formato MAL ID non valido. Usa: mal:ID o mal:ID:EPISODIO o mal:ID:STAGIONE:EPISODIO');
      const malId = parts[1];
      let seasonNumber: number | null = null;
      let episodeNumber: number | null = null;
      let isMovie = false;
      if (parts.length === 2) {
        isMovie = true;
      } else if (parts.length === 3) {
        episodeNumber = parseInt(parts[2]);
      } else if (parts.length === 4) {
        seasonNumber = parseInt(parts[2]);
        episodeNumber = parseInt(parts[3]);
      }
      const englishTitle = await getEnglishTitleFromAnyId(malId, 'mal', this.config.tmdbApiKey);
      console.log(`[AnimeUnity] Ricerca con titolo inglese: ${englishTitle}`);
      return this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
    } catch (error) {
      console.error('Error handling MAL request:', error);
      return { streams: [] };
    }
  }

  async handleImdbRequest(imdbId: string, seasonNumber: number | null, episodeNumber: number | null, isMovie = false): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) {
      return { streams: [] };
    }
    try {
      const englishTitle = await getEnglishTitleFromAnyId(imdbId, 'imdb', this.config.tmdbApiKey);
      console.log(`[AnimeUnity] Ricerca con titolo inglese: ${englishTitle}`);
      return this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
    } catch (error) {
      console.error('Error handling IMDB request:', error);
      return { streams: [] };
    }
  }

  async handleTmdbRequest(tmdbId: string, seasonNumber: number | null, episodeNumber: number | null, isMovie = false): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) {
      return { streams: [] };
    }
    try {
      const englishTitle = await getEnglishTitleFromAnyId(tmdbId, 'tmdb', this.config.tmdbApiKey);
      console.log(`[AnimeUnity] Ricerca con titolo inglese: ${englishTitle}`);
      return this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
    } catch (error) {
      console.error('Error handling TMDB request:', error);
      return { streams: [] };
    }
  }

  async handleTitleRequest(title: string, seasonNumber: number | null, episodeNumber: number | null, isMovie = false): Promise<{ streams: StreamForStremio[] }> {
    const normalizedTitle = normalizeTitleForSearch(title);
    console.log(`[AnimeUnity] Titolo normalizzato per ricerca: ${normalizedTitle}`);
    let animeVersions = await this.searchAllVersions(normalizedTitle);
    animeVersions = filterAnimeResults(animeVersions, normalizedTitle);
    if (!animeVersions.length) {
      console.warn('[AnimeUnity] Nessun risultato trovato per il titolo:', normalizedTitle);
      return { streams: [] };
    }
    const streams: StreamForStremio[] = [];
    const seenLinks = new Set();
    for (const { version, language_type } of animeVersions) {
      const episodes: AnimeUnityEpisode[] = await invokePythonScraper(['get_episodes', '--anime-id', String(version.id)]);
      // Filtra undefined e episodi nulli
      const validEpisodes = (episodes || []).filter(e => e && e.id && e.number);
      if (!validEpisodes.length) {
        console.warn(`[AnimeUnity] Nessun episodio valido trovato per la richiesta: S${seasonNumber}E${episodeNumber} (${version.name})`);
        continue;
      }
      let targetEpisode: AnimeUnityEpisode | undefined;
      if (isMovie) {
        targetEpisode = validEpisodes[0];
        console.log(`[AnimeUnity] Selezionato primo episodio (movie):`, targetEpisode?.name);
      } else if (episodeNumber != null) {
        targetEpisode = validEpisodes.find(ep => String(ep.number) === String(episodeNumber));
        console.log(`[AnimeUnity] Episodio selezionato per E${episodeNumber}:`, targetEpisode?.name);
      } else {
        targetEpisode = validEpisodes[0];
        console.log(`[AnimeUnity] Selezionato primo episodio (default):`, targetEpisode?.name);
      }
      if (!targetEpisode) {
        console.warn(`[AnimeUnity] Nessun episodio trovato per la richiesta: S${seasonNumber}E${episodeNumber} (${version.name})`);
        continue;
      }
      const streamResult: AnimeUnityStreamData = await invokePythonScraper([
        'get_stream',
        '--anime-id', String(version.id),
        '--anime-slug', version.slug,
        '--episode-id', String(targetEpisode.id)
      ]);
      if (streamResult.mp4_url) {
        const mediaFlowUrl = formatMediaFlowUrl(
          streamResult.mp4_url,
          this.config.mfpUrl,
          this.config.mfpPassword
        );
        const cleanName = version.name
          .replace(/\s*\(ITA\)/i, '')
          .replace(/\s*\(CR\)/i, '')
          .replace(/ITA/gi, '')
          .replace(/CR/gi, '')
          .trim();
        const sNum = seasonNumber || 1;
        let streamTitle = `${capitalize(cleanName)} ${language_type} S${sNum}`;
        if (episodeNumber) {
          streamTitle += `E${episodeNumber}`;
        }
        // Filtra duplicati per url
        if (!seenLinks.has(mediaFlowUrl)) {
          streams.push({
            title: streamTitle,
            url: mediaFlowUrl,
            behaviorHints: {
              notWebReady: true
            }
          });
          seenLinks.add(mediaFlowUrl);
        }
        if (this.config.bothLink && streamResult.embed_url && !seenLinks.has(streamResult.embed_url)) {
          streams.push({
            title: `[E] ${streamTitle}`,
            url: streamResult.embed_url,
            behaviorHints: {
              notWebReady: true
            }
          });
          seenLinks.add(streamResult.embed_url);
        }
      }
    }
    return { streams };
  }
}

// Funzione di utilità per capitalizzare la prima lettera
function capitalize(str: string) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
