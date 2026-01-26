import { spawn } from 'child_process';
import { AnimeSaturnConfig, AnimeSaturnResult, AnimeSaturnEpisode, StreamForStremio } from '../types/animeunity';
import * as path from 'path';
import axios from 'axios';
import { KitsuProvider } from './kitsu';
import { getDomain } from '../utils/domains';
import { checkIsAnimeById, applyUniversalAnimeTitleNormalization } from '../utils/animeGate';

// Helper function to invoke the Python scraper
// MFP config viene passata esplicitamente, con fallback a env vars per installazioni locali
async function invokePythonScraper(args: string[], mfpConfig?: { mfpUrl?: string; mfpPassword?: string }): Promise<any> {
    const scriptPath = path.join(__dirname, 'animesaturn.py');
    const command = 'python3';

    // MFP dalla config passata, fallback a env vars per installazioni locali
    const mfpProxyUrl = mfpConfig?.mfpUrl || process.env.MFP_PROXY_URL || process.env.MFP_URL || '';
    const mfpProxyPassword = mfpConfig?.mfpPassword || process.env.MFP_PROXY_PASSWORD || process.env.MFP_PSW || '';

    // Aggiungi gli argomenti proxy MFP se presenti
    if (mfpProxyUrl && mfpProxyPassword) {
        args.push('--mfp-proxy-url', mfpProxyUrl);
        args.push('--mfp-proxy-password', mfpProxyPassword);
    }

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
      // Fallback Kitsu diretto: usa SOLO titles.en dal record principale
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
  const clean = (s: string) => s.replace(/\s*\(.*?\)/g, '').replace(/\s*ita|\s*cr|\s*sub/gi, '').trim();
  const baseRaw = norm(englishTitle);
  const baseClean = clean(baseRaw);

  // Accetta titoli che contengono il base, ignorando suffissi e parentesi
  const isAllowed = (title: string) => {
    const tNorm = norm(title);
    const tClean = clean(tNorm);
    return (
      tNorm.includes(baseRaw) ||
      (baseClean.length > 0 && tNorm.includes(baseClean)) ||
      (baseClean.length > 0 && tClean.includes(baseClean))
    );
  };

  // Log dettagliato per debug
  console.log('DEBUG filtro:', {
    base: baseRaw,
    baseClean,
    titoli: results.map(r => ({
      raw: r.version.title,
      norm: norm(r.version.title),
      afterClean: clean(norm(r.version.title))
    }))
  });

  const filtered = results.filter(r => isAllowed(r.version.title));
  console.log(`[UniversalTitle] Risultati prima del filtro:`, results.map(r => r.version.title));
  console.log(`[UniversalTitle] Risultati dopo il filtro:`, filtered.map(r => r.version.title));
  return filtered;
}

// Funzione di normalizzazione custom per la ricerca
function normalizeTitleForSearch(title: string): string {
  // 1. Mappature esatte inserire qui titoli che hanno in mal i - (devono avvenire prima per evitare che le sostituzioni generiche rovinino la chiave)
  // ==== AUTO-NORMALIZATION-EXACT-MAP-START ====
  const exactMap: Record<string,string> = {
    "Demon Slayer: Kimetsu no Yaiba - The Movie: Infinity Castle": "Demon Slayer: Kimetsu no Yaiba Infinity Castle",
    "Attack on Titan: The Final Season - Final Chapters Part 2": "L'attacco dei Giganti: L'ultimo attacco",
    'Ore dake Level Up na Ken': 'Solo Leveling',
    'Lupin the Third: The Woman Called Fujiko Mine': 'Lupin III - La donna chiamata Fujiko Mine ',
    "Slam Dunk: Roar!! Basket Man Spiriy": "Slam Dunk: Hoero Basketman-damashii! Hanamichi to Rukawa no Atsuki Natsu",
    "Parasyte: The Maxim": "Kiseijuu",
    "Attack on Titan OAD": "L'attacco dei Giganti: Il taccuino di Ilse",
    "Fullmetal Alchemist: Brotherhood": "Fullmetal Alchemist Brotherhood",
    "Slam Dunk: Roar!! Basket Man Spirit": "Slam Dunk: Hoero Basketman-damashii! Hanamichi to Rukawa no Atsuki Natsu",
    "Slam Dunk: Shohoku Maximum Crisis! Burn Sakuragi Hanamichi": "Slam Dunk: Shouhoku Saidai no Kiki! Moero Sakuragi Hanamichi",
    "Slam Dunk: National Domination! Sakuragi Hanamichi": "Slam Dunk: Zenkoku Seiha Da! - Sakuragi Hanamichi",
    "JoJo's Bizarre Adventure (2012)": "Le Bizzarre Avventure di JoJo",
    "JoJo's Bizarre Adventure: Stardust Crusaders": "Le Bizzarre Avventure di JoJo: Stardust Crusaders",
        "Cat's Eye (2025)": "Occhi di gatto (2025)",
        "Cat's\u2665Eye": "Occhi di gatto (2025)",
    "Ranma \u00bd (2024) Season 2": "Ranma \u00bd (2024) 2",
    "Ranma1/2 (2024) Season 2": "Ranma \u00bd (2024) 2",
        "Link Click Season 2": "Link Click 2",
        "K: SEVEN STORIES Lost Small World - Outside the Cage - ": "K: Seven Stories Movie 4 - Lost Small World - Ori no Mukou ni",
        "Nichijou - My Ordinary Life": "Nichijou",
        "Case Closed Movie 01: The Time Bombed Skyscraper": "Detective Conan Movie 01: Fino alla fine del tempo",
        "My Hero Academia Final Season": "Boku no Hero Academia: Final Season",
        "Jujutsu Kaisen: The Culling Game Part 1": "Jujutsu Kaisen 3: The Culling Game Part 1",
        "Hell's Paradise Season 2": "Jigokuraku 2",
        "[Oshi no Ko]": "Oshi no Ko",
        "Record of Ragnarok II Part 2": "Record of Ragnarok 2 Part 2",
        "Record of Ragnarok II": "Record of Ragnarok 2",

        "Magical Circle": "Mahoujin Guru Guru",


    // << AUTO-INSERT-EXACT >> (non rimuovere questo commento)
  };
  // ==== AUTO-NORMALIZATIOmN-EXACT-MAP-END ====
  // Se il titolo originale ha una mappatura esatta, usala e NON applicare altre normalizzazioni
  const hasExact = Object.prototype.hasOwnProperty.call(exactMap, title);
  let normalized = hasExact ? exactMap[title] : title;

  if (!hasExact) {
    // 2. Replacements generici (solo se non è stata applicata una exact per non corrompere l'output voluto)
    // ==== AUTO-NORMALIZATION-GENERIC-MAP-START ====
    const generic: Record<string,string> = {
      'Attack on Titan': "L'attacco dei Giganti",
      'Season': '',
      'Shippuuden': 'Shippuden',

      // << AUTO-INSERT-GENERIC >> (non rimuovere questo commento)
      // Qui puoi aggiungere altre normalizzazioni custom (legacy placeholder)
    };
    // ==== AUTO-NORMALIZATION-GENERIC-MAP-END ====
    for (const [k,v] of Object.entries(generic)) {
      if (normalized.includes(k)) normalized = normalized.replace(k, v);
    }
    // 3. Cleanup leggero SOLO per casi non exact (evita di rimuovere trattini intenzionali della mappa esatta)
    normalized = normalized.replace(/\s+-\s+/g,' ');
    if (normalized.includes('Naruto:')) normalized = normalized.replace(':','');
    // 4. Collassa spazi multipli
    normalized = normalized.replace(/\s{2,}/g,' ').trim();
  }
  return normalized;
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
  private baseHost: string;
  constructor(private config: AnimeSaturnConfig) {
    this.baseHost = getDomain('animesaturn') || 'animesaturn.cx';
  }

  // Ricerca tutte le versioni (AnimeSaturn non distingue SUB/ITA/CR, ma puoi inferirlo dal titolo)
  // Made public for catalog search
  async searchAllVersions(title: string, malId?: string): Promise<{ version: AnimeSaturnResult; language_type: string }[]> {
    let args = ['search', '--query', title];
    if (malId) {
      args.push('--mal-id', malId);
    }
    let results: AnimeSaturnResult[] = await invokePythonScraper(args);
    // Fallback: se la ricerca con MAL ID non restituisce nulla, riprova senza MAL ID
    if (malId && results.length === 0) {
      console.log('[AnimeSaturn] Nessun risultato con MAL ID, retry senza mal-id');
      results = await invokePythonScraper(['search', '--query', title]);
    }
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
      let language_type = 'SUB ITA';
      if (nameLower.includes('cr')) {
        language_type = 'CR ITA';
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
      // Anime gate: decide if this IMDB id refers to anime; if not, skip
      const gateEnabled = (process.env.ANIME_GATE_ENABLED || 'true') !== 'false';
      if (gateEnabled) {
        const gate = await checkIsAnimeById('imdb', imdbId, this.config.tmdbApiKey, isMovie ? 'movie' : 'tv');
        if (!gate.isAnime) {
          console.log(`[AnimeSaturn] Skipping anime search: no MAL/Kitsu mapping (${gate.reason}) for ${imdbId}`);
          return { streams: [] };
        }
  // Placeholder stream removed; warning now via icon prefix in stream titles
      }
  const englishTitle = await getEnglishTitleFromAnyId(imdbId, 'imdb', this.config.tmdbApiKey);
      // Recupera anche l'id MAL tramite Haglund
      let malId: string | undefined = undefined;
      try {
        const tmdbKey = this.config.tmdbApiKey || process.env.TMDB_API_KEY || '';
        const imdbIdOnly = imdbId.split(':')[0];
        const { getTmdbIdFromImdbId } = await import('../extractor');
        const tmdbId = await getTmdbIdFromImdbId(imdbIdOnly, tmdbKey, 'tv');
        if (tmdbId) {
          const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json();
          malId = haglundResp[0]?.myanimelist?.toString() || undefined;
        }
      } catch {}
      console.log(`[AnimeSaturn] Ricerca con titolo inglese: ${englishTitle}`);
  const res = await this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie, malId);
  // Prefix warning icon for non-Kitsu/MAL origin (IMDB)
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
      // Anime gate on TMDB
      const gateEnabled = (process.env.ANIME_GATE_ENABLED || 'true') !== 'false';
      if (gateEnabled) {
        const gate = await checkIsAnimeById('tmdb', tmdbId, this.config.tmdbApiKey, isMovie ? 'movie' : 'tv');
        if (!gate.isAnime) {
          console.log(`[AnimeSaturn] Skipping anime search: no MAL/Kitsu mapping (${gate.reason}) for TMDB ${tmdbId}`);
          return { streams: [] };
        }
  // Placeholder stream removed; warning now via icon prefix in stream titles
      }
  const englishTitle = await getEnglishTitleFromAnyId(tmdbId, 'tmdb', this.config.tmdbApiKey);
      // Recupera anche l'id MAL tramite Haglund
      let malId: string | undefined = undefined;
      try {
        const tmdbKey = this.config.tmdbApiKey || process.env.TMDB_API_KEY || '';
        const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json();
        malId = haglundResp[0]?.myanimelist?.toString() || undefined;
      } catch {}
      console.log(`[AnimeSaturn] Ricerca con titolo inglese: ${englishTitle}`);
  const res = await this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie, malId);
  res.streams = res.streams.map(s => s.title.startsWith('⚠️') ? s : { ...s, title: `⚠️ ${s.title}` });
  return res;
    } catch (error) {
      console.error('Error handling TMDB request:', error);
      return { streams: [] };
    }
  }

  // Funzione generica per gestire la ricerca dato un titolo
  async handleTitleRequest(title: string, seasonNumber: number | null, episodeNumber: number | null, isMovie = false, malId?: string): Promise<{ streams: StreamForStremio[] }> {
    const universalTitle = applyUniversalAnimeTitleNormalization(title);
    if (universalTitle !== title) {
      console.log(`[UniversalTitle][Applied] ${title} -> ${universalTitle}`);
    }
    const normalizedTitle = normalizeTitleForSearch(universalTitle);
    console.log(`[AnimeSaturn] Titolo normalizzato per ricerca: ${normalizedTitle}`);
    console.log(`[AnimeSaturn] MAL ID passato a searchAllVersions:`, malId ? malId : '(nessuno)');
  console.log('[AnimeSaturn] Query inviata allo scraper (post-normalize):', normalizedTitle);
    let animeVersions = await this.searchAllVersions(normalizedTitle, malId);
    animeVersions = filterAnimeResults(animeVersions, normalizedTitle, malId);
    // Fallback MAL -> loose: se filtrando con MAL non troviamo nulla, riprova senza malId
    if (malId && animeVersions.length === 0) {
      console.log('[AnimeSaturn] Nessun risultato dopo filtro con MAL ID, ritento ricerca loose');
      animeVersions = await this.searchAllVersions(normalizedTitle);
      animeVersions = filterAnimeResults(animeVersions, normalizedTitle);
    }
    if (!animeVersions.length) {
      console.warn('[AnimeSaturn] Nessun risultato trovato per il titolo:', normalizedTitle);
      return { streams: [] };
    }
    const streams: StreamForStremio[] = [];
    for (const { version, language_type } of animeVersions) {
      const episodes: AnimeSaturnEpisode[] = await invokePythonScraper(['get_episodes', '--anime-url', version.url]);
      if (!episodes || episodes.length === 0) {
        console.warn(`[AnimeSaturn] Nessun episodio ottenuto per ${version.title} (URL=${version.url}). Skip versione.`);
        continue;
      }
      console.log(`[AnimeSaturn] Episodi trovati per ${version.title}:`, episodes.map(e => e.title));
      let targetEpisode: AnimeSaturnEpisode | undefined;
      if (isMovie) {
        targetEpisode = episodes[0];
        console.log(`[AnimeSaturn] Selezionato primo episodio (movie):`, targetEpisode?.title);
      } else if (episodeNumber != null) {
        // Pattern semplice originale: cerca E<number>, altrimenti include del numero
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
      // Preparare gli argomenti per lo scraper Python
      const scrapperArgs = ['get_stream', '--episode-url', targetEpisode.url];

      // Aggiungi parametri MFP per lo streaming m3u8 se disponibili
      if (this.config.mfpProxyUrl) {
        scrapperArgs.push('--mfp-proxy-url', this.config.mfpProxyUrl);
      }
      if (this.config.mfpProxyPassword) {
        scrapperArgs.push('--mfp-proxy-password', this.config.mfpProxyPassword);
      }

      const streamResult = await invokePythonScraper(scrapperArgs);
      let streamUrl = streamResult.url;
      let streamHeaders = streamResult.headers || undefined;
      const cleanName = version.title
        .replace(/\s*\(ITA\)/i, '')
        .replace(/\s*\(CR\)/i, '')
        .replace(/ITA/gi, '')
        .replace(/CR/gi, '')
        .trim();
  const sNum = seasonNumber || 1;
  const langLabel = language_type === 'ITA' ? 'ITA' : 'SUB';
  let streamTitle = `${capitalize(cleanName)} ▪ ${langLabel} ▪ S${sNum}`;
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
