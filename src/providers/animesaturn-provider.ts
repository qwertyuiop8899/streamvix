import { spawn } from 'child_process';
import { AnimeSaturnConfig, AnimeSaturnResult, AnimeSaturnEpisode, StreamForStremio } from '../types/animeunity';
import * as path from 'path';
import axios from 'axios';
import { KitsuProvider } from './kitsu';

// Helper function to invoke the Python scraper
async function invokePythonScraper(args: string[]): Promise<any> {
    const scriptPath = path.join(__dirname, 'animesaturn.py');
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

// Funzione per normalizzare tutti i tipi di apostrofo in quello normale
function normalizeApostrophes(str: string): string {
  return str.replace(/['’‘]/g, "'");
}

// Funzione filtro risultati
function filterAnimeResults(
  results: { version: AnimeSaturnResult; language_type: string }[],
  englishTitle: string,
  malId?: string
) {
  if (malId) {
    // Se la ricerca Python è stata fatta con MAL ID, accetta tutti i risultati
    return results;
  }
  const norm = (s: string) => normalizeApostrophes(normalizeUnicodeToAscii(s.toLowerCase().replace(/\s+/g, ' ').trim()));
  const base = norm(englishTitle);

  // Accetta titoli che contengono il base, ignorando suffissi e parentesi
  const isAllowed = (title: string) => {
    let t = norm(title);
    // Rimuovi suffissi comuni e parentesi
    t = t.replace(/\s*\(.*?\)/g, '').replace(/\s*ita|\s*cr|\s*sub/gi, '').trim();
    return t.includes(base);
  };

  // Log dettagliato per debug
  console.log('DEBUG filtro:', {
    base,
    titoli: results.map(r => ({
      raw: r.version.title,
      norm: norm(r.version.title),
      afterClean: norm(r.version.title).replace(/\s*\(.*?\)/g, '').replace(/\s*ita|\s*cr|\s*sub/gi, '').trim()
    }))
  });

  const filtered = results.filter(r => isAllowed(r.version.title));
  console.log(`[UniversalTitle] Risultati prima del filtro:`, results.map(r => r.version.title));
  console.log(`[UniversalTitle] Risultati dopo il filtro:`, filtered.map(r => r.version.title));
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
    'Lupin the Third: The Woman Called Fujiko Mine': 'Lupin III - La donna chiamata Fujiko Mine ',
    'Slam Dunk: National Domination! Sakuragi Hanamichi': 'Slam Dunk: Zenkoku Seiha Da! Sakuragi Hanamichi',
    "Slam Dunk: Roar!! Basket Man Spiriy": "Slam Dunk: Hoero Basketman-damashii! Hanamichi to Rukawa no Atsuki Natsu",
    "Parasyte: The Maxim": "Kiseijuu",
    "Attack on Titan OAD": "L'attacco dei Giganti: Il taccuino di Ilse Sub ITA",



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

// Funzione di normalizzazione caratteri speciali per titoli
function normalizeSpecialChars(str: string): string {
  return str
    .replace(/'/g, '\u2019') // apostrofo normale in unicode
    .replace(/:/g, '\u003A'); // due punti in unicode (aggiungi altri se necessario)
}

// Funzione per convertire caratteri unicode "speciali" in caratteri normali
function normalizeUnicodeToAscii(str: string): string {
  return str
    .replace(/[\u2019\u2018'']/g, "'") // tutti gli apostrofi unicode in apostrofo normale
    .replace(/[\u201C\u201D""]/g, '"') // virgolette unicode in doppie virgolette
    .replace(/\u003A/g, ':'); // due punti unicode in normale
}

export class AnimeSaturnProvider {
  private kitsuProvider = new KitsuProvider();
  constructor(private config: AnimeSaturnConfig) {}

  // Ricerca tutte le versioni (AnimeSaturn non distingue SUB/ITA/CR, ma puoi inferirlo dal titolo)
  private async searchAllVersions(title: string, malId?: string): Promise<{ version: AnimeSaturnResult; language_type: string }[]> {
    let args = ['search', '--query', title];
    if (malId) {
      args.push('--mal-id', malId);
    }
    let results: AnimeSaturnResult[] = await invokePythonScraper(args);
    // Se la ricerca trova solo una versione e il titolo contiene apostrofi, riprova con l'apostrofo tipografico
    if (results.length <= 1 && title.includes("'")) {
      const titleTypo = title.replace(/'/g, '’');
      let typoArgs = ['search', '--query', titleTypo];
      if (malId) {
        typoArgs.push('--mal-id', malId);
      }
      const moreResults: AnimeSaturnResult[] = await invokePythonScraper(typoArgs);
      // Unisci risultati senza duplicati (per url)
      const seen = new Set(results.map(r => r.url));
      for (const r of moreResults) {
        if (!seen.has(r.url)) results.push(r);
      }
    }
    // Normalizza i titoli dei risultati per confronto robusto
    results = results.map(r => ({
      ...r,
      title: normalizeUnicodeToAscii(r.title)
    }));
    results.forEach(r => {
      console.log('DEBUG titolo JSON normalizzato:', r.title);
    });
    return results.map(r => {
      const nameLower = r.title.toLowerCase();
      let language_type = 'SUB';
      if (nameLower.includes('cr')) {
        language_type = 'CR';
      } else if (nameLower.includes('ita')) {
        language_type = 'ITA';
      }
      // Qui la chiave 'title' è già normalizzata!
      return { version: { ...r, title: r.title }, language_type };
    });
  }

  // Uniformità: accetta sia Kitsu che MAL
  async handleKitsuRequest(kitsuIdString: string): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) {
      return { streams: [] };
    }
    try {
      const { kitsuId, seasonNumber, episodeNumber, isMovie } = this.kitsuProvider.parseKitsuId(kitsuIdString);
      const englishTitle = await getEnglishTitleFromAnyId(kitsuId, 'kitsu', this.config.tmdbApiKey);
      // Recupera anche l'id MAL
      let malId: string | undefined = undefined;
      try {
        const mappingsResp = await (await fetch(`https://kitsu.io/api/edge/anime/${kitsuId}/mappings`)).json();
        const malMapping = mappingsResp.data?.find((m: any) => m.attributes.externalSite === 'myanimelist/anime');
        malId = malMapping?.attributes?.externalId?.toString() || undefined;
      } catch {}
      console.log(`[AnimeSaturn] Ricerca con titolo inglese: ${englishTitle}`);
      return this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie, malId);
    } catch (error) {
      console.error('Error handling Kitsu request:', error);
      return { streams: [] };
    }
  }

  async handleMalRequest(malIdString: string): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) {
      return { streams: [] };
    }
    try {
      // Parsing: mal:ID[:STAGIONE][:EPISODIO]
      const parts = malIdString.split(':');
      if (parts.length < 2) throw new Error('Formato MAL ID non valido. Usa: mal:ID o mal:ID:EPISODIO o mal:ID:STAGIONE:EPISODIO');
      const malId: string = parts[1];
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
      console.log(`[AnimeSaturn] Ricerca con titolo inglese: ${englishTitle}`);
      return this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie, malId);
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
      // Recupera anche l'id MAL tramite Haglund
      let malId: string | undefined = undefined;
      try {
        const tmdbKey = this.config.tmdbApiKey || process.env.TMDB_API_KEY || '';
        const imdbIdOnly = imdbId.split(':')[0];
        const { getTmdbIdFromImdbId } = await import('../extractor');
        const tmdbId = await getTmdbIdFromImdbId(imdbIdOnly, tmdbKey);
        if (tmdbId) {
          const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json();
          malId = haglundResp[0]?.myanimelist?.toString() || undefined;
        }
      } catch {}
      console.log(`[AnimeSaturn] Ricerca con titolo inglese: ${englishTitle}`);
      return this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie, malId);
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
      // Recupera anche l'id MAL tramite Haglund
      let malId: string | undefined = undefined;
      try {
        const tmdbKey = this.config.tmdbApiKey || process.env.TMDB_API_KEY || '';
        const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json();
        malId = haglundResp[0]?.myanimelist?.toString() || undefined;
      } catch {}
      console.log(`[AnimeSaturn] Ricerca con titolo inglese: ${englishTitle}`);
      return this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie, malId);
    } catch (error) {
      console.error('Error handling TMDB request:', error);
      return { streams: [] };
    }
  }

  // Funzione generica per gestire la ricerca dato un titolo
  async handleTitleRequest(title: string, seasonNumber: number | null, episodeNumber: number | null, isMovie = false, malId?: string): Promise<{ streams: StreamForStremio[] }> {
    const normalizedTitle = normalizeTitleForSearch(title);
    console.log(`[AnimeSaturn] Titolo normalizzato per ricerca: ${normalizedTitle}`);
    console.log(`[AnimeSaturn] MAL ID passato a searchAllVersions:`, malId ? malId : '(nessuno)');
    let animeVersions = await this.searchAllVersions(normalizedTitle, malId);
    animeVersions = filterAnimeResults(animeVersions, normalizedTitle, malId);
    if (!animeVersions.length) {
      console.warn('[AnimeSaturn] Nessun risultato trovato per il titolo:', normalizedTitle);
      return { streams: [] };
    }
    const streams: StreamForStremio[] = [];
    for (const { version, language_type } of animeVersions) {
      const episodes: AnimeSaturnEpisode[] = await invokePythonScraper(['get_episodes', '--anime-url', version.url]);
      console.log(`[AnimeSaturn] Episodi trovati per ${version.title}:`, episodes.map(e => e.title));
      let targetEpisode: AnimeSaturnEpisode | undefined;
      if (isMovie) {
        targetEpisode = episodes[0];
        console.log(`[AnimeSaturn] Selezionato primo episodio (movie):`, targetEpisode?.title);
      } else if (episodeNumber != null) {
        targetEpisode = episodes.find(ep => {
          const match = ep.title.match(/E(\d+)/i);
          if (match) {
            return parseInt(match[1]) === episodeNumber;
          }
          return ep.title.includes(String(episodeNumber));
        });
        console.log(`[AnimeSaturn] Episodio selezionato per E${episodeNumber}:`, targetEpisode?.title);
      } else {
        targetEpisode = episodes[0];
        console.log(`[AnimeSaturn] Selezionato primo episodio (default):`, targetEpisode?.title);
      }
      if (!targetEpisode) {
        console.warn(`[AnimeSaturn] Nessun episodio trovato per la richiesta: S${seasonNumber}E${episodeNumber}`);
        continue;
      }
      const streamResult = await invokePythonScraper(['get_stream', '--episode-url', targetEpisode.url]);
      let streamUrl = streamResult.url;
      let streamHeaders = streamResult.headers || undefined;
      const cleanName = version.title
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
      streams.push({
        title: streamTitle,
        url: streamUrl,
        behaviorHints: {
          notWebReady: true,
          ...(streamHeaders ? { headers: streamHeaders } : {})
        }
      });
    }
    return { streams };
  }
}

function capitalize(str: string) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
