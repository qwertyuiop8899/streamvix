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
      for (const r of allResults) {
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
      const animeInfo = await this.kitsuProvider.getAnimeInfo(kitsuId);
      if (!animeInfo) {
        return { streams: [] };
      }

      // 1. Prova a recuperare l'ID MAL tramite API Kitsu
      let malId: string | null = null;
      try {
        const mappingsUrl = `https://kitsu.io/api/edge/anime/${kitsuId}/mappings`;
        const resp = await axios.get(mappingsUrl, { timeout: 10000 });
        const mappings = resp.data.data;
        const malMapping = mappings.find((m: any) => m.attributes.externalSite === 'myanimelist/anime');
        if (malMapping) {
          malId = malMapping.attributes.externalId;
          console.log(`[AnimeUnity][DEBUG] KitsuID ${kitsuId} -> MAL ID trovato: ${malId}`);
        } else {
          console.log(`[AnimeUnity][DEBUG] KitsuID ${kitsuId} -> Nessun MAL ID trovato nei mappings`);
        }
      } catch (err) {
        console.warn('[AnimeUnity] Errore nel recupero mapping MAL da Kitsu:', err);
      }

      // 2. Se trovato, chiama handleMalRequest con la stringa mal:ID[:STAGIONE][:EPISODIO]
      if (malId) {
        let malIdString = `mal:${malId}`;
        if (!isMovie && episodeNumber) {
          if (seasonNumber) {
            malIdString += `:${seasonNumber}:${episodeNumber}`;
          } else {
            malIdString += `:${episodeNumber}`;
          }
        }
        return await this.handleMalRequest(malIdString);
      }

      // 3. Fallback: ricerca col titolo Kitsu
      console.log(`[AnimeUnity] Titolo Kitsu: ${animeInfo.title}`);
      const normalizedTitle = this.kitsuProvider.normalizeTitle(animeInfo.title);
      console.log(`[AnimeUnity] Titolo normalizzato per ricerca: ${normalizedTitle}`);
      const animeVersions = await this.searchAllVersions(normalizedTitle);
      if (!animeVersions.length) {
        return { streams: [] };
      }
      if (isMovie) {
        const episodeToFind = "1";
        const streams: StreamForStremio[] = [];
        for (const { version, language_type } of animeVersions) {
          const episodes: AnimeUnityEpisode[] = await invokePythonScraper(['get_episodes', '--anime-id', String(version.id)]);
          const targetEpisode = episodes.find(ep => ep.number === episodeToFind);
          if (targetEpisode) {
            const streamResult: AnimeUnityStreamData = await invokePythonScraper([
              'get_stream',
              '--anime-id', String(version.id),
              '--anime-slug', version.slug,
              '--episode-id', String(targetEpisode.id)
            ]);
            if (streamResult.mp4_url) {
              streams.push({
                title: `🎬 AnimeUnity ${language_type} (Movie)`,
                url: streamResult.mp4_url,
                behaviorHints: { notWebReady: true }
              });
            }
          }
        }
        return { streams };
      }
      const streams: StreamForStremio[] = [];
      for (const { version, language_type } of animeVersions) {
        try {
          const episodes: AnimeUnityEpisode[] = await invokePythonScraper(['get_episodes', '--anime-id', String(version.id)]);
          const targetEpisode = episodes.find(ep => String(ep.number) === String(episodeNumber));
          if (!targetEpisode) continue;
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
            const isDub = language_type === 'DUB';
            const mainName = isDub ? `${cleanName} ITA` : cleanName;
            const sNum = seasonNumber || 1;
            let streamTitle = `${capitalize(cleanName)} ${language_type} S${sNum}`;
            if (episodeNumber) {
              streamTitle += `E${episodeNumber}`;
            }
            streams.push({
              title: streamTitle,
              url: mediaFlowUrl,
              behaviorHints: {
                notWebReady: true
              }
            });
            if (this.config.bothLink && streamResult.embed_url) {
              streams.push({
                title: `[E] ${streamTitle}`,
                url: streamResult.embed_url,
                behaviorHints: {
                  notWebReady: true
                }
              });
            }
          }
        } catch (error) {
          console.error(`Error processing version ${language_type}:`, error);
        }
      }
      return { streams };
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
      // Prendi titolo da Jikan
      const jikanUrl = `https://api.jikan.moe/v4/anime/${malId}`;
      const jikanResp = await axios.get(jikanUrl, { timeout: 10000 });
      const malData = jikanResp.data.data;
      const title = malData.title_english || malData.title || malData.title_japanese;
      if (!title) throw new Error('Titolo non trovato su Jikan/MAL');
      // Normalizza titolo come per Kitsu
      const normalizedTitle = this.kitsuProvider.normalizeTitle(title);
      const animeVersions = await this.searchAllVersions(normalizedTitle);
      if (!animeVersions.length) {
        return { streams: [] };
      }
      // Log titoli
      console.log(`[AnimeUnity] Titolo MAL: ${title}`);
      console.log(`[AnimeUnity] Titolo normalizzato per ricerca: ${normalizedTitle}`);
      // Copio la logica da handleKitsuRequest per movie/episodio
      if (isMovie) {
        const episodeToFind = "1";
        const streams: StreamForStremio[] = [];
        for (const { version, language_type } of animeVersions) {
          const episodes: AnimeUnityEpisode[] = await invokePythonScraper(['get_episodes', '--anime-id', String(version.id)]);
          const targetEpisode = episodes.find(ep => ep.number === episodeToFind);
          if (targetEpisode) {
            const streamResult: AnimeUnityStreamData = await invokePythonScraper([
              'get_stream',
              '--anime-id', String(version.id),
              '--anime-slug', version.slug,
              '--episode-id', String(targetEpisode.id)
            ]);
            if (streamResult.mp4_url) {
              streams.push({
                title: `🎬 AnimeUnity ${language_type} (Movie)`,
                url: streamResult.mp4_url,
                behaviorHints: { notWebReady: true }
              });
            }
          }
        }
        return { streams };
      }
      const streams: StreamForStremio[] = [];
      for (const { version, language_type } of animeVersions) {
        try {
          const episodes: AnimeUnityEpisode[] = await invokePythonScraper(['get_episodes', '--anime-id', String(version.id)]);
          const targetEpisode = episodes.find(ep => String(ep.number) === String(episodeNumber));
          if (!targetEpisode) continue;
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
            const isDub = language_type === 'DUB';
            const mainName = isDub ? `${cleanName} ITA` : cleanName;
            const sNum = seasonNumber || 1;
            let streamTitle = `${capitalize(cleanName)} ${language_type} S${sNum}`;
            if (episodeNumber) {
              streamTitle += `E${episodeNumber}`;
            }
            streams.push({
              title: streamTitle,
              url: mediaFlowUrl,
              behaviorHints: {
                notWebReady: true
              }
            });
            if (this.config.bothLink && streamResult.embed_url) {
              streams.push({
                title: `[E] ${streamTitle}`,
                url: streamResult.embed_url,
                behaviorHints: {
                  notWebReady: true
                }
              });
            }
          }
        } catch (error) {
          console.error(`Error processing version ${language_type}:`, error);
        }
      }
      return { streams };
    } catch (error) {
      console.error('Error handling MAL request:', error);
      return { streams: [] };
    }
  }
}

// Funzione di utilità per capitalizzare la prima lettera
function capitalize(str: string) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
