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

export class AnimeSaturnProvider {
  private kitsuProvider = new KitsuProvider();
  constructor(private config: AnimeSaturnConfig) {}

  // Ricerca tutte le versioni (AnimeSaturn non distingue SUB/ITA/CR, ma puoi inferirlo dal titolo)
  private async searchAllVersions(title: string): Promise<{ version: AnimeSaturnResult; language_type: string }[]> {
    const results: AnimeSaturnResult[] = await invokePythonScraper(['search', '--query', title]);
    return results.map(r => {
      const nameLower = r.title.toLowerCase();
      let language_type = 'SUB';
      if (nameLower.includes('cr')) {
        language_type = 'CR';
      } else if (nameLower.includes('ita')) {
        language_type = 'ITA';
      }
      return { version: r, language_type };
    });
  }

  // Uniformità: accetta sia Kitsu che MAL
  async handleKitsuRequest(kitsuIdString: string): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) {
      return { streams: [] };
    }
    try {
      const { kitsuId, seasonNumber, episodeNumber, isMovie } = this.kitsuProvider.parseKitsuId(kitsuIdString);
      const animeInfo = await this.kitsuProvider.getAnimeInfo(kitsuId);
      if (!animeInfo) {
        return { streams: [] };
      }
      const normalizedTitle = this.kitsuProvider.normalizeTitle(animeInfo.title);
      return this.handleTitleRequest(normalizedTitle, seasonNumber, episodeNumber, isMovie);
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
      const jikanUrl = `https://api.jikan.moe/v4/anime/${malId}`;
      const jikanResp = await axios.get(jikanUrl, { timeout: 10000 });
      const malData = jikanResp.data.data;
      const title = malData.title_english || malData.title || malData.title_japanese;
      if (!title) throw new Error('Titolo non trovato su Jikan/MAL');
      const normalizedTitle = this.kitsuProvider.normalizeTitle(title);
      return this.handleTitleRequest(normalizedTitle, seasonNumber, episodeNumber, isMovie);
    } catch (error) {
      console.error('Error handling MAL request:', error);
      return { streams: [] };
    }
  }

  // Funzione generica per gestire la ricerca dato un titolo
  async handleTitleRequest(title: string, seasonNumber: number | null, episodeNumber: number | null, isMovie = false): Promise<{ streams: StreamForStremio[] }> {
    console.log(`[AnimeSaturn] Titolo normalizzato per ricerca: ${title}`);
    const animeVersions = await this.searchAllVersions(title);
    console.log(`[AnimeSaturn] Risultati searchAllVersions:`, animeVersions.map(v => v.version.title));
    if (!animeVersions.length) {
      console.warn('[AnimeSaturn] Nessun risultato trovato per il titolo:', title);
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
