import { spawn } from 'child_process';
import { KitsuProvider } from './kitsu';
import { getDomain } from '../utils/domains';
import { formatMediaFlowUrl } from '../utils/mediaflow';
import { AnimeUnityConfig, StreamForStremio } from '../types/animeunity';
import * as path from 'path';
import axios from 'axios';
import { checkIsAnimeById, applyUniversalAnimeTitleNormalization } from '../utils/animeGate';
import { extractFromUrl } from '../extractors';
import { AnimeResolvedTitle } from '../utils/animeTitleResolver';

// Helper function to invoke the Python scraper with timeout & kill
async function invokePythonScraper(args: string[]): Promise<any> {
    const scriptPath = path.join(__dirname, 'animeunity_scraper.py');
    const command = 'python3';
    const timeoutMs = parseInt(process.env.ANIMEUNITY_PY_TIMEOUT || '120000', 10);
    const start = Date.now();
    console.log('[AnimeUnity][PY] spawn', args.join(' '));

    return new Promise((resolve, reject) => {
        const pythonProcess = spawn(command, [scriptPath, ...args]);

        let stdout = '';
        let stderr = '';
        let finished = false;

        const killTimer = setTimeout(() => {
            if (finished) return;
            finished = true;
            try { pythonProcess.kill('SIGKILL'); } catch {}
            console.error(`[AnimeUnity][PY] timeout after ${timeoutMs}ms for args:`, args.join(' '));
            reject(new Error('AnimeUnity python timeout'));
        }, timeoutMs);

        pythonProcess.stdout.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        pythonProcess.stderr.on('data', (data: Buffer) => {
            stderr += data.toString();
            // Log stderr immediatamente per errori AnimeUnity
            const stderrLine = data.toString().trim();
            if (stderrLine.includes('[AnimeUnity][ERROR]') || stderrLine.includes('[AnimeUnity][WARN]')) {
                console.error(stderrLine);
            }
        });

        pythonProcess.on('close', (code: number) => {
            if (finished) return;
            finished = true;
            clearTimeout(killTimer);
            const dur = Date.now() - start;
            if (code !== 0) {
                console.error(`[AnimeUnity][PY] Python script exited with code ${code}`);
                if (stderr) {
                    console.error(`[AnimeUnity][PY] Error details: ${stderr}`);
                }
                return reject(new Error(`Python script error: ${stderr}`));
            }
            try {
                console.log(`[AnimeUnity][PY] success (${dur}ms)`);
                resolve(JSON.parse(stdout));
            } catch (e) {
                console.error('[AnimeUnity][PY] Failed to parse Python script output:');
                console.error(stdout);
                reject(new Error('Failed to parse Python script output.'));
            }
        });

        pythonProcess.on('error', (err: Error) => {
            if (finished) return;
            finished = true;
            clearTimeout(killTimer);
            console.error('[AnimeUnity][PY] Failed to start Python script:', err);
            reject(err);
        });
    });
}

interface AnimeUnitySearchResult {
    id: number;
    slug: string;
    name: string;
    name_it?: string; // Titolo italiano (opzionale)
    name_eng?: string; // Titolo inglese (opzionale)
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
// Aggiunto fallback Kitsu diretto (titles.en) se manca MAL mapping, come in AnimeSaturn
/** @deprecated Usata solo come fallback legacy per handleImdbRequest/handleTmdbRequest.
 *  Il path principale ora usa resolveAnimeTitle() centralizzato via handlePreResolved(). */
async function getEnglishTitleFromAnyId(id: string, type: 'imdb'|'tmdb'|'kitsu'|'mal', tmdbApiKey?: string): Promise<string> {
  let malId: string | null = null;
  let tmdbId: string | null = null;
  let fallbackTitle: string | null = null;
  const tmdbKey = tmdbApiKey || process.env.TMDB_API_KEY || '';
  if (type === 'imdb') {
    if (!tmdbKey) throw new Error('TMDB_API_KEY non configurata');
    const imdbIdOnly = id.split(':')[0];
    const { getTmdbIdFromImdbId } = await import('../extractor');
    tmdbId = await getTmdbIdFromImdbId(imdbIdOnly, tmdbKey, 'tv');
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
    if (!malId) {
      // Fallback: usa direttamente titles.en dal record principale se disponibile
      try {
        const kitsuMain = await (await fetch(`https://kitsu.io/api/edge/anime/${id}`)).json();
        const enTitle = kitsuMain?.data?.attributes?.titles?.en;
        if (enTitle) {
          console.log(`[UniversalTitle][KitsuFallback] Titolo inglese diretto da Kitsu (no MAL mapping): ${enTitle}`);
          return enTitle;
        } else {
          console.warn(`[UniversalTitle][KitsuFallback] Nessun titles.en disponibile per Kitsu ${id}`);
        }
      } catch (e) {
        console.warn(`[UniversalTitle][KitsuFallback] Errore recuperando titles.en per Kitsu ${id}:`, e);
      }
    }
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

function filterAnimeResults(results: { version: AnimeUnitySearchResult; language_type: string }[], searchQuery: string) {
  // LOGICA: usa il TITOLO CON CUI HAI CERCATO per filtrare (italiano O inglese)
  // Accetta varianti con (ITA), (CR), ecc. MA esclude sequel con numeri (es: "Title 2")
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const queryNorm = norm(searchQuery);

  // Genera le varianti ammesse: base, base + (ita), base + (cr), base + (ita) (cr)
  // IMPORTANTE: NON rimuovere i numeri dalla query - fanno parte del titolo!
  const queryBase = queryNorm.replace(/\s*\([^)]*\)/g, '').trim();
  const allowedVariants = [
    queryBase,
    `${queryBase} (ITA)`,
    `${queryBase} (CR)`,
    `${queryBase} (ITA) (CR)`,
    `${queryBase} (CR) (ITA)`
  ];

  const filtered = results.filter(r => {
    // Raccogli tutti i titoli disponibili del risultato
    const titles = [
      r.version.name_eng || '',
      r.version.name_it || '',
      r.version.name || ''
    ].filter(t => t.trim());

    // Per ogni titolo disponibile, controlla se matcha con una delle varianti ammesse
    for (const title of titles) {
      const titleNorm = norm(title);
      // Rimuovi solo le parentesi per il confronto (mantieni i numeri!)
      const titleBase = titleNorm.replace(/\s*\([^)]*\)/g, '').trim();

      // Match: il titolo base del risultato deve essere UGUALE al queryBase
      if (titleBase === queryBase) {
        return true;
      }
    }

    return false;
  });

  console.log(`[UniversalTitle][Filter][Legacy] Query ricerca (norm): "${queryNorm}" -> base: "${queryBase}"`);
  console.log(`[UniversalTitle][Filter][Legacy] Varianti ammesse:`, allowedVariants);
  console.log(`[UniversalTitle][Filter][Legacy] Risultati prima del filtro:`, results.map(r => `${r.version.name} [it:"${r.version.name_it||'N/A'}" eng:"${r.version.name_eng||'N/A'}"]`));
  console.log(`[UniversalTitle][Filter][Legacy] Risultati dopo il filtro:`, filtered.map(r => r.version.name));
  return filtered;
}

// ==== AUTO-NORMALIZATION-EXACT-MAP-START ====
const exactMap: Record<string,string> = {

    "Attack on Titan: Final Season - The Final Chapters": "Attack on Titan Final Season THE FINAL CHAPTERS Special 1",
    "Attack on Titan: The Final Season - Final Chapters Part 2": "Attack on Titan Final Season THE FINAL CHAPTERS Special 2",

        "Attack on Titan OAD": "Attack on Titan OVA",


        "Cat's\u2665Eye": "Occhi di gatto (2025)",
    "Attack on Titan: Final Season": "Attack on Titan: The Final Season",
    "Attack on Titan: Final Season Part 2": "Attack on Titan: The Final Season Part 2",


    "Ranma \u00bd (2024) Season 2": "Ranma \u00bd (2024) 2",
    "Ranma1/2 (2024) Season 2": "Ranma \u00bd (2024) 2",


        "Link Click Season 2": "Link Click 2",



        "K: SEVEN STORIES Lost Small World - Outside the Cage - ": "K: Seven Stories Movie 4 - Lost Small World - Ori no Mukou ni",




        "Nichijou - My Ordinary Life": "Nichijou",





        "Case Closed Movie 01: The Time Bombed Skyscraper": "Detective Conan Movie 1: Fino alla fine del tempo",


        "Jujutsu Kaisen: The Culling Game Part 1": "Jujutsu Kaisen 3: The Culling Game Part 1",

        "My Hero Academia Final Season": "My Hero Academia Final Season",








        "[Oshi No Ko] Season 3": "Oshi No Ko 3",









    // << AUTO-INSERT-EXACT >> (non rimuovere questo commento)
};
// ==== AUTO-NORMALIZATION-EXACT-MAP-END ====

// ==== AUTO-NORMALIZATION-GENERIC-MAP-START ====
const genericMap: Record<string,string> = {


  // << AUTO-INSERT-GENERIC >> (non rimuovere questo commento)
  // Qui puoi aggiungere altre normalizzazioni custom
};
// ==== AUTO-NORMALIZATION-GENERIC-MAP-END ====

// Funzione di normalizzazione per la ricerca (fase base + generic)
function normalizeTitleForSearch(title: string): string {
  // Se exact map colpisce il titolo originale, usiamo direttamente il valore e saltiamo tutto il resto.
  if (Object.prototype.hasOwnProperty.call(exactMap, title)) {
    const mapped = exactMap[title];
    console.log(`[AnimeUnity][ExactMap] Hit: "${title}" -> "${mapped}"`);
    return mapped;
  }
  // LOGICA LEGACY per i NON exact: usare un dizionario di replacements statico (come vecchio codice)
  const replacements: Record<string, string> = {
    'Season': '',
    'Shippuuden': 'Shippuden',
    '-': '',
    'Ore dake Level Up na Ken': 'Solo Leveling',
  };
  let normalized = title;
  for (const [key, value] of Object.entries(replacements)) {
    if (normalized.includes(key)) {
      normalized = normalized.replace(new RegExp(key, 'gi'), value);
    }
  }
  if (normalized.includes('Naruto:')) {
    normalized = normalized.replace(':', '');
  }
  return normalized.replace(/\s{2,}/g, ' ').trim();
}

export class AnimeUnityProvider {
  private kitsuProvider = new KitsuProvider();

  constructor(private config: AnimeUnityConfig) {}

  private get baseHost(): string { return getDomain('animeunity') || 'animeunity.so'; }

  /**
   * Usa il titolo pre-risolto dal resolver centralizzato (0 chiamate API).
   * Chiamato da addon.ts per kitsu:, mal:, IMDB e TMDB IDs.
   */
  async handlePreResolved(resolved: AnimeResolvedTitle, rawId: string): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) return { streams: [] };
    try {
      let seasonNumber: number | null = null;
      let episodeNumber: number | null = null;
      let isMovie = false;
      if (rawId.startsWith('kitsu:')) {
        ({ seasonNumber, episodeNumber, isMovie } = this.kitsuProvider.parseKitsuId(rawId));
      } else if (rawId.startsWith('mal:')) {
        const parts = rawId.split(':');
        if (parts.length === 2) isMovie = true;
        else if (parts.length === 3) episodeNumber = parseInt(parts[2]);
        else if (parts.length === 4) { seasonNumber = parseInt(parts[2]); episodeNumber = parseInt(parts[3]); }
      } else if (rawId.startsWith('tt')) {
        // IMDB: tt0388629:10:10 → season=10, episode=10
        const parts = rawId.split(':');
        if (parts.length === 1) isMovie = true;
        else if (parts.length === 3) { seasonNumber = parseInt(parts[1]); episodeNumber = parseInt(parts[2]); }
      } else if (rawId.startsWith('tmdb:')) {
        // TMDB: tmdb:12345:2:5 → season=2, episode=5
        const parts = rawId.split(':');
        if (parts.length === 2) isMovie = true;
        else if (parts.length === 4) { seasonNumber = parseInt(parts[2]); episodeNumber = parseInt(parts[3]); }
      }

      // Usa absoluteEpisode se disponibile (episodeMode === "absolute")
      const effectiveEpisode = resolved.absoluteEpisode ?? episodeNumber;

      console.log(`[AnimeUnity] handlePreResolved: "${resolved.englishTitle}" (malId=${resolved.malId || '-'}, kitsuId=${resolved.kitsuId || '-'}, mode=${resolved.episodeMode || '-'}) S${seasonNumber}E${episodeNumber}${resolved.absoluteEpisode ? ` → absEp ${resolved.absoluteEpisode}` : ''} movie=${isMovie}`);
      return this.handleTitleRequest(resolved.englishTitle, seasonNumber, effectiveEpisode, isMovie, resolved.titleHints);
    } catch (error) {
      console.error('[AnimeUnity] Error in handlePreResolved:', error);
      return { streams: [] };
    }
  }

  // Made public for catalog search
  async searchAllVersions(title: string): Promise<{ version: AnimeUnitySearchResult; language_type: string }[]> {
      try {
        const subPromise = invokePythonScraper(['search', '--query', title]).catch(() => []);
        const dubPromise = invokePythonScraper(['search', '--query', title, '--dubbed']).catch(() => []);

        const [subResults, dubResults]: [AnimeUnitySearchResult[], AnimeUnitySearchResult[]] = await Promise.all([subPromise, dubPromise]);
        const results: { version: AnimeUnitySearchResult; language_type: string }[] = [];

        console.log(`[AnimeUnity] Risultati SUB per "${title}":`, subResults?.length || 0);
        console.log(`[AnimeUnity] Risultati DUB per "${title}":`, dubResults?.length || 0);

        // Unisci tutti i risultati (SUB e DUB), ma assegna ITA o CR se il nome contiene
        const allResults = [...(subResults || []), ...(dubResults || [])];
        // Filtra duplicati per nome e id
        const seen = new Set();
        for (const r of allResults) {
          if (!r || !r.name || !r.id) continue;
          const key = r.name + '|' + r.id;
          if (seen.has(key)) continue;
          seen.add(key);
          const nameLower = r.name.toLowerCase();
          let language_type = 'SUB ITA';
          if (nameLower.includes('cr')) {
            language_type = 'CR ITA';
          } else if (nameLower.includes('ita')) {
            language_type = 'ITA';
          }
          results.push({ version: r, language_type });
        }
        console.log(`[AnimeUnity] Risultati totali dopo filtro duplicati:`, results.length);
        return results;
      } catch (error) {
        console.error(`[AnimeUnity] Errore in searchAllVersions per "${title}":`, error);
        return [];
      }
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
      const gateEnabled = (process.env.ANIME_GATE_ENABLED || 'true') !== 'false';
      if (gateEnabled) {
        const gate = await checkIsAnimeById('imdb', imdbId, this.config.tmdbApiKey, isMovie ? 'movie' : 'tv');
        if (!gate.isAnime) {
          console.log(`[AnimeUnity] Skipping anime search: no MAL/Kitsu mapping (${gate.reason}) for ${imdbId}`);
          return { streams: [] };
        }
  // Removed placeholder injection; icon added directly to titles
      }
  const englishTitle = await getEnglishTitleFromAnyId(imdbId, 'imdb', this.config.tmdbApiKey);
  console.log(`[AnimeUnity] Ricerca con titolo inglese: ${englishTitle}`);
  const res = await this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
  res.streams = res.streams.map(s => s.title.startsWith('⚠️') ? s : { ...s, title: `⚠️ ${s.title}` });
  return res;
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
      const gateEnabled = (process.env.ANIME_GATE_ENABLED || 'true') !== 'false';
      if (gateEnabled) {
        const gate = await checkIsAnimeById('tmdb', tmdbId, this.config.tmdbApiKey, isMovie ? 'movie' : 'tv');
        if (!gate.isAnime) {
          console.log(`[AnimeUnity] Skipping anime search: no MAL/Kitsu mapping (${gate.reason}) for TMDB ${tmdbId}`);
          return { streams: [] };
        }
  // Removed placeholder injection; icon added directly to titles
      }
  const englishTitle = await getEnglishTitleFromAnyId(tmdbId, 'tmdb', this.config.tmdbApiKey);
  console.log(`[AnimeUnity] Ricerca con titolo inglese: ${englishTitle}`);
  const res = await this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
  res.streams = res.streams.map(s => s.title.startsWith('⚠️') ? s : { ...s, title: `⚠️ ${s.title}` });
  return res;
    } catch (error) {
      console.error('Error handling TMDB request:', error);
      return { streams: [] };
    }
  }

  async handleTitleRequest(title: string, seasonNumber: number | null, episodeNumber: number | null, isMovie = false, titleHints?: string[]): Promise<{ streams: StreamForStremio[] }> {
    const universalTitle = applyUniversalAnimeTitleNormalization(title);
    const normalizedTitle = normalizeTitleForSearch(universalTitle);
    if (universalTitle !== title) {
      console.log(`[UniversalTitle][Applied] ${title} -> ${universalTitle}`);
    }
    console.log(`[AnimeUnity] Titolo normalizzato per ricerca: ${normalizedTitle}${titleHints?.length ? ` (+ ${titleHints.length} titleHints)` : ''}`);
    // Se il titolo originale è una chiave dell'exactMap allora saltiamo qualsiasi filtro successivo:
    // l'intento dell'utente è: se la ricerca parte da una chiave exactMap, NON applicare filterAnimeResults
    const skipFilter = Object.prototype.hasOwnProperty.call(exactMap, title);
    if (skipFilter) {
      console.log(`[AnimeUnity][ExactMap] Skip filtro: titolo di input corrisponde a chiave exactMap -> "${title}"`);
    }
    let animeVersions = await this.searchAllVersions(normalizedTitle);
    // Fallback: prova titleHints dal resolver unificato (animemapping API)
    if (!animeVersions.length && titleHints && titleHints.length > 0) {
      for (const hint of titleHints) {
        if (hint && hint !== normalizedTitle && hint !== title) {
          console.log(`[AnimeUnity] Trying titleHint: "${hint}"`);
          animeVersions = await this.searchAllVersions(hint);
          if (animeVersions.length) {
            console.log(`[AnimeUnity] titleHint "${hint}" found ${animeVersions.length} results`);
            break;
          }
        }
      }
    }
    // Fallback: se non trova nulla, prova anche con titoli alternativi
    if (!animeVersions.length) {
      // Prova a ottenere titoli alternativi da Jikan (se hai il MAL ID)
      let fallbackTitles: string[] = [];
      try {
        // Prova a estrarre MAL ID dal titolo (se è un numero)
        const malIdMatch = title.match && title.match(/\d+/);
        const malId = malIdMatch ? malIdMatch[0] : null;
        if (malId) {
          const jikanResp = await (await fetch(`https://api.jikan.moe/v4/anime/${malId}`)).json();
          fallbackTitles = [
            jikanResp.data?.title_japanese,
            jikanResp.data?.title,
            jikanResp.data?.title_english
          ].filter(Boolean);
        }
      } catch {}
      // Prova fallback con titoli alternativi
      for (const fallbackTitle of fallbackTitles) {
        if (fallbackTitle && fallbackTitle !== normalizedTitle) {
          animeVersions = await this.searchAllVersions(fallbackTitle);
          if (animeVersions.length) break;
        }
      }
      // Fallback: senza apostrofi
      if (!animeVersions.length && normalizedTitle.includes("'")) {
        const noApos = normalizedTitle.replace(/'/g, "");
        animeVersions = await this.searchAllVersions(noApos);
      }
      // Fallback: senza parentesi
      if (!animeVersions.length && normalizedTitle.includes("(")) {
        const noParens = normalizedTitle.split("(")[0].trim();
        animeVersions = await this.searchAllVersions(noParens);
      }
      // Fallback: prime 3 parole
      if (!animeVersions.length) {
        const words = normalizedTitle.split(" ");
        if (words.length > 3) {
          const first3 = words.slice(0, 3).join(" ");
          animeVersions = await this.searchAllVersions(first3);
        }
      }
    }
    if (!skipFilter) {
      animeVersions = filterAnimeResults(animeVersions, normalizedTitle);
    } else {
      console.log('[AnimeUnity][ExactMap] Uso risultati grezzi senza filtro (exactMap).');
      // STRICT EXACT FILTER: per le richieste exactMap, manteniamo SOLO i risultati
      // il cui nome base NON contiene parole extra rispetto agli altri risultati dello stesso gruppo.
      // Esempio: se troviamo "Final Season" e "Final Season Parte 2", teniamo solo i primi.
      // IMPORTANTE: AnimeUnity restituisce nomi in italiano, quindi confrontiamo i risultati tra loro,
      // non con il titolo inglese di input.
      try {
        const before = animeVersions.length;
        console.log(`[AnimeUnity][ExactMap][StrictFilter] Risultati da filtrare (${before}):`);

        // Estrai i nomi base (senza parentesi) di tutti i risultati
        const baseNames = animeVersions.map(v => {
          const base = v.version.name
            .replace(/\([^)]*\)/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
          console.log(`  name="${v.version.name}" -> base="${base}"`);
          return base;
        });

        // Trova il nome più corto (quello senza "Parte 2", "Part 2", ecc.)
        const sortedByLength = [...baseNames].sort((a, b) => a.length - b.length);
        const shortestBase = sortedByLength[0];
        console.log(`[AnimeUnity][ExactMap][StrictFilter] Nome base più corto (target): "${shortestBase}"`);

        // Filtra: mantieni solo i risultati che matchano esattamente il nome più corto
        animeVersions = animeVersions.filter((v, idx) => {
          const match = baseNames[idx] === shortestBase;
          console.log(`  [${idx}] "${v.version.name}" -> match=${match}`);
          return match;
        });

        console.log(`[AnimeUnity][ExactMap][StrictFilter] DOPO filtro: ${animeVersions.length} risultati rimasti`);
      } catch (e) {
        console.warn('[AnimeUnity][ExactMap][StrictFilter] errore:', (e as any)?.message || e);
      }
    }
    if (!animeVersions.length) {
      console.warn('[AnimeUnity] Nessun risultato trovato per il titolo:', normalizedTitle);
      return { streams: [] };
    }
    // OPT 1: Process all anime versions in PARALLEL (was sequential for loop)
    const versionResults = await Promise.allSettled(animeVersions.map(async ({ version, language_type }): Promise<StreamForStremio[]> => {
      const streams: StreamForStremio[] = [];
      const seenLinks = new Set<string>();
      try {
        const episodes: AnimeUnityEpisode[] = await invokePythonScraper(['get_episodes', '--anime-id', String(version.id)]);
        const validEpisodes = (episodes || []).filter(e => e && e.id && e.number);
        if (!validEpisodes.length) {
          console.warn(`[AnimeUnity] Nessun episodio valido trovato per la richiesta: S${seasonNumber}E${episodeNumber} (${version.name})`);
          return [];
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
          return [];
        }

        const streamResult: AnimeUnityStreamData = await invokePythonScraper([
          'get_stream',
          '--anime-id', String(version.id),
          '--anime-slug', version.slug,
          '--episode-id', String(targetEpisode.id)
        ]);
        const preferMp4 = /^(1|true|on)$/i.test(String(process.env.ANIMEUNITY_PREFER_MP4 || '0'));
        let added = false;
        let hls403 = false;
        const cleanName = version.name
          .replace(/\s*\(ITA\)/i, '')
          .replace(/\s*\(CR\)/i, '')
          .replace(/ITA/gi, '')
          .replace(/CR/gi, '')
          .trim();
        const sNum = seasonNumber || 1;
        const langLabel = language_type === 'ITA' ? 'ITA' : 'SUB';
        let baseTitle = `${capitalize(cleanName)} ▪ ${langLabel} ▪ S${sNum}`;
        if (episodeNumber) baseTitle += `E${episodeNumber}`;

        if (!preferMp4 && streamResult.embed_url) {
          try {
            const hlsRes = await extractFromUrl(streamResult.embed_url, {
              referer: streamResult.episode_page,
              mfpUrl: this.config.mfpUrl,
              mfpPassword: this.config.mfpPassword,
              titleHint: baseTitle
            });
            if (hlsRes.streams && hlsRes.streams.length) {
              for (const st of hlsRes.streams) {
                if (!st || !st.url) continue;
                if (seenLinks.has(st.url)) continue;
                streams.push(st);
                seenLinks.add(st.url);
                added = true;

                try {
                  const masterUrl = st.url;
                  const respPl = await fetch(masterUrl, { headers: (st as any)?.behaviorHints?.requestHeaders || {} });
                  if (respPl.ok) {
                    const playlistText = await respPl.text();
                    if (/EXT-X-STREAM-INF/i.test(playlistText)) {
                      interface VariantEntry { line: string; url: string; height: number; bandwidth?: number; }
                      const lines = playlistText.split(/\r?\n/);
                      const variants: VariantEntry[] = [];
                      for (let i = 0; i < lines.length; i++) {
                        const line = lines[i];
                        if (/^#EXT-X-STREAM-INF:/i.test(line)) {
                          const nextUrl = lines[i + 1] || '';
                          if (nextUrl.startsWith('#') || !nextUrl.trim()) continue;
                          let height = 0;
                          const resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
                          if (resMatch) height = parseInt(resMatch[1]);
                          const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
                          const bw = bwMatch ? parseInt(bwMatch[1]) : undefined;
                          variants.push({ line, url: nextUrl.trim(), height, bandwidth: bw });
                        }
                      }
                      if (variants.length) {
                        variants.sort((a, b) => (b.height - a.height) || ((b.bandwidth || 0) - (a.bandwidth || 0)));
                        const best = variants[0];
                        console.log('[AnimeUnity][FHDVariant][Parse]', variants.map(v => `${v.height}p`).join(','), 'best=', best.height);
                        let variantUrl = best.url;
                        if (!/^https?:\/\//i.test(variantUrl)) {
                          try {
                            const mu = new URL(masterUrl);
                            variantUrl = new URL(variantUrl, mu).toString();
                          } catch { }
                        }
                        variantUrl = variantUrl.replace(/(\/playlist\/(\d+))(?!\.m3u8)(?=[^\w]|$)/, '$1.m3u8');
                        if (!seenLinks.has(variantUrl)) {
                          const markAsFhd = best.height >= 720;
                          if (!markAsFhd) console.log('[AnimeUnity][FHDVariant] Altezza migliore <720p, non marchio FHD:', best.height);
                          const fhdTitle = st.title;
                          const behaviorHints: any = { ...(st.behaviorHints || {}), animeunityQuality: markAsFhd ? 'FHD' : 'HQ', animeunityResolution: best.height, animeunityNameSuffix: markAsFhd ? ' 🅵🅷🅳' : '' };
                          if ((st as any)?.behaviorHints?.requestHeaders) {
                            behaviorHints.requestHeaders = (st as any).behaviorHints.requestHeaders;
                          }
                          streams.push({
                            title: fhdTitle,
                            url: variantUrl,
                            behaviorHints,
                            isSyntheticFhd: markAsFhd
                          });
                          seenLinks.add(variantUrl);
                          console.log('[AnimeUnity][FHDVariant] Aggiunta variante', variantUrl.substring(0, 120), 'height=', best.height, 'flagFHD=', markAsFhd);
                        }
                      }
                    }
                  }
                } catch (fhde) {
                  console.warn('[AnimeUnity][FHDVariant] errore generazione variante FHD:', (fhde as any)?.message || fhde);
                }
              }
            }
          } catch (e) {
            const msg = (e as any)?.message || String(e);
            if (/403/.test(msg)) {
              hls403 = true;
              console.warn('[AnimeUnity] HLS extractor 403 – consentito fallback MP4 (se MFP configurato)');
            } else {
              console.warn('[AnimeUnity] HLS extractor fallito (non 403):', msg);
            }
          }
        }

        const mfpConfigured = !!this.config.mfpUrl;
        const allowMp4 = preferMp4 || (hls403 && !added);
        if (allowMp4 && streamResult.mp4_url) {
          if (!preferMp4 && hls403 && !mfpConfigured) {
            console.log('[AnimeUnity] MP4 non mostrato: HLS 403 ma MFP non configurato');
          } else {
            try {
              const mediaFlowUrl = formatMediaFlowUrl(
                streamResult.mp4_url,
                this.config.mfpUrl,
                this.config.mfpPassword
              );
              if (!seenLinks.has(mediaFlowUrl)) {
                streams.push({
                  title: baseTitle + (added ? ' (MP4)' : (preferMp4 ? ' (MP4 Preferred)' : ' (MP4 Fallback)')),
                  url: mediaFlowUrl,
                  behaviorHints: { notWebReady: true }
                });
                seenLinks.add(mediaFlowUrl);
              }
            } catch (e) {
              console.warn('[AnimeUnity] Errore fallback MP4:', (e as any)?.message || e);
            }
          }
        }

        return streams;
      } catch (e) {
        console.warn('[AnimeUnity] Error processing version in parallel:', (e as any)?.message || e);
        return [];
      }
    }));

    const mergedStreams: StreamForStremio[] = versionResults
      .filter((r): r is PromiseFulfilledResult<StreamForStremio[]> => r.status === 'fulfilled')
      .flatMap(r => r.value || []);
    const globalSeen = new Set<string>();
    const streams = mergedStreams.filter(st => {
      const u = st?.url;
      if (!u) return false;
      if (globalSeen.has(u)) return false;
      globalSeen.add(u);
      return true;
    });

    // Filtro finale: nessuna selezione => solo AUTO (master). AUTO implicito se nessun toggle.
  const autoFlag = this.config.animeunityAuto === true;
  const fhdFlag = this.config.animeunityFhd === true;
  const autoWanted = autoFlag || (!autoFlag && !fhdFlag); // default AUTO if none selected
  const fhdWanted = fhdFlag;
    const filtered = streams.filter(st => {
      const qual = st.behaviorHints?.animeunityQuality;
      if (qual === 'FHD') return fhdWanted;
      return autoWanted; // master (AUTO)
    });
    // Post-process: if FHD selected (or both), ensure provider label shows FHD by setting isFhdOrDual equivalent hint
    try {
      if (fhdWanted) {
        filtered.forEach(st => {
          if (st.behaviorHints?.animeunityQuality === 'FHD') {
            // Provide a generic flag some naming layers may inspect
            st.behaviorHints.animeunityIsFhd = true;
          }
        });
      }
    } catch(e) { /* no-op */ }
    return { streams: filtered };
  }
}

// Funzione di utilità per capitalizzare la prima lettera
function capitalize(str: string) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
