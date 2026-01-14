import { ContentType } from "stremio-addon-sdk";
import { buildUnifiedStreamName, providerLabel } from './utils/unifiedNames';
import * as cheerio from "cheerio";
import * as fs from 'fs';
import * as path from 'path';
const domains = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/domains.json'), 'utf-8'));
const VIXCLOUD_SITE_ORIGIN = `https://${domains.vixsrc}`; // e.g., "https://vixcloud.co"
const VIXCLOUD_REQUEST_TITLE_PATH = "/richiedi-un-titolo"; // Path used to fetch site version
const VIXCLOUD_EMBED_BASE_PATH = "/embed"; // Base path for embed URLs, e.g., /embed/movie/tt12345 
// --- TMDB Configuration ---
const TMDB_API_BASE_URL = "https://api.themoviedb.org/3";

// --- IMDB to TMDB Static Mapping ---
interface ImdbToTmdbMapping {
  imdbSeason: number;
  tmdb_id: string;
}

interface ImdbToTmdbEntry {
  title: string;
  note?: string;
  mappings: ImdbToTmdbMapping[];
}

interface ImdbToTmdbMap {
  [imdbId: string]: ImdbToTmdbEntry;
}

let IMDB_TO_TMDB_MAP: ImdbToTmdbMap = {};

try {
  const mappingPath = path.join(__dirname, 'config', 'imdbToTmdb.json');
  if (fs.existsSync(mappingPath)) {
    IMDB_TO_TMDB_MAP = JSON.parse(fs.readFileSync(mappingPath, 'utf-8'));
    console.log(`[IMDB→TMDB] Caricato mapping statico: ${Object.keys(IMDB_TO_TMDB_MAP).length} serie`);
  }
} catch (error) {
  console.warn('[IMDB→TMDB] Impossibile caricare mapping statico:', error);
}

/**
 * Cerca un mapping statico IMDB→TMDB per una specifica stagione.
 * Usato per serie con ID TMDB diversi per stagione (es. Monster).
 * Supporta anche entry semplici con solo tmdb_id diretto (senza mappings).
 * @param imdbId - ID IMDB (es. "tt13207736")
 * @param season - Numero stagione (es. 1, 2, 3)
 * @returns TMDB ID per quella stagione se trovato, altrimenti null
 */
function getStaticTmdbMapping(imdbId: string, season: number): string | null {
  const entry = IMDB_TO_TMDB_MAP[imdbId];
  if (!entry) return null;

  // Entry semplice: solo tmdb_id diretto (senza array mappings)
  if ((entry as any).tmdb_id && !entry.mappings) {
    console.log(`[IMDB→TMDB] Mapping statico semplice trovato: ${imdbId} → TMDB ${(entry as any).tmdb_id} (${entry.title})`);
    return (entry as any).tmdb_id;
  }

  // Entry con mappings per stagione
  const mapping = entry.mappings?.find(m => m.imdbSeason === season);
  if (mapping) {
    console.log(`[IMDB→TMDB] Mapping statico trovato: ${imdbId} S${season} → TMDB ${mapping.tmdb_id} (${entry.title})`);
    return mapping.tmdb_id;
  }

  return null;
}

// --- End Configuration ---

// Ensures playlist URLs have .m3u8 after numeric id: /playlist/12345 => /playlist/12345.m3u8
function ensurePlaylistM3u8(raw: string): string {
  try {
    if (!raw.includes('/playlist/')) return raw;
    const u = new URL(raw);
    const parts = u.pathname.split('/');
    const idx = parts.indexOf('playlist');
    if (idx === -1 || idx === parts.length - 1) return raw;
    const leaf = parts[idx + 1];
    if (/\.m3u8$/i.test(leaf) || leaf.includes('.')) return raw;
    parts[idx + 1] = leaf + '.m3u8';
    u.pathname = parts.join('/');
    return u.toString();
  } catch { return raw; }
}

export interface ExtractorConfig {
  tmdbApiKey?: string;
  mfpUrl?: string;
  mfpPsw?: string;
  // When true (set via landing page "Local" checkbox) include direct stream variant (🔓)
  vixLocal?: boolean;
  // Base URL of the addon (protocol+host) to build synthetic endpoints
  addonBase?: string;
  // When true, expose BOTH automatic master (o proxy) and forced 1080p ITA synthetic stream
  vixDual?: boolean;
  // Nuove checkbox UI (visibilità) propagate qui così il bridge può funzionare
  vixDirect?: boolean;
  vixDirectFhd?: boolean;
  vixProxy?: boolean;
  vixProxyFhd?: boolean;
}

export interface VixCloudStreamInfo {
  name: string;
  streamUrl: string;
  referer: string;
  source: 'proxy' | 'direct';
  // Optional: estimated content size in bytes (parsed from VixSrc page)
  sizeBytes?: number;
  // True only for synthetic FHD (forced variant) streams (used for HD badge in addon layer)
  isSyntheticFhd?: boolean;
  // Original content base title (senza placeholder Synthetic/Proxy FHD) se disponibile
  originalName?: string;
}

/**
 * Fetches the site version from VixCloud.
 * This is analogous to the `version` method in the Python VixCloudExtractor.
 */
async function fetchVixCloudSiteVersion(siteOrigin: string): Promise<string> {
  const versionUrl = `${siteOrigin}${VIXCLOUD_REQUEST_TITLE_PATH}`;
  try {
    const response = await fetch(versionUrl, {
      headers: {
        "Referer": `${siteOrigin}/`,
        "Origin": siteOrigin,
      },
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch version, status: ${response.status}`);
    }
    const html = await response.text();
    const $ = cheerio.load(html);
    const appDiv = $("div#app");
    if (appDiv.length > 0) {
      const dataPage = appDiv.attr("data-page");
      if (dataPage) {
        const jsonData = JSON.parse(dataPage);
        if (jsonData && jsonData.version) {
          return jsonData.version;
        }
      }
    }
    throw new Error("Failed to parse version from page data.");
  } catch (error) {
    let message = "Unknown error";
    if (error instanceof Error) {
      message = error.message;
    }
    console.error("Error fetching VixCloud site version:", message, error);
    throw new Error(`Failed to get VixCloud site version: ${message}`);
  }
}

// Supports both legacy imdb based ids (imdbId:season:episode) and tmdb based ids (tmdb:tmdbId:season:episode)
function getObject(id: string) {
  const arr = id.split(':');
  if (arr[0] === 'tmdb') {
    return {
      id: arr[1], // actual TMDB id
      season: arr[2],
      episode: arr[3]
    };
  }
  return {
    id: arr[0], // imdb id
    season: arr[1],
    episode: arr[2]
  };
}

export async function getTmdbIdFromImdbId(imdbId: string, tmdbApiKey?: string, preferredType?: 'movie' | 'tv'): Promise<string | null> {
  // Prima controlla il mapping statico (per ID non linkati correttamente in TMDB)
  const entry = IMDB_TO_TMDB_MAP[imdbId];
  if (entry && (entry as any).tmdb_id && !entry.mappings) {
    console.log(`[IMDB→TMDB] Mapping statico semplice usato: ${imdbId} → TMDB ${(entry as any).tmdb_id} (${entry.title})`);
    return (entry as any).tmdb_id;
  }

  if (!tmdbApiKey) {
    console.error("TMDB_API_KEY is not configured.");
    return null;
  }
  const findUrl = `${TMDB_API_BASE_URL}/find/${imdbId}?api_key=${tmdbApiKey}&external_source=imdb_id`;
  try {
    const response = await fetch(findUrl);
    if (!response.ok) {
      console.error(`Failed to fetch TMDB ID for ${imdbId}: ${response.status}`);
      return null;
    }
    const data = await response.json();

    // Priorità intelligente: se preferredType è specificato, cerca prima quel tipo
    const movieResults = data.movie_results || [];
    const tvResults = data.tv_results || [];

    if (preferredType === 'tv' && tvResults.length > 0) {
      console.log(`[IMDB→TMDB] Preferred TV: ${imdbId} → TMDB ${tvResults[0].id} (${tvResults[0].name})`);
      return tvResults[0].id.toString();
    } else if (preferredType === 'movie' && movieResults.length > 0) {
      console.log(`[IMDB→TMDB] Preferred Movie: ${imdbId} → TMDB ${movieResults[0].id} (${movieResults[0].title})`);
      return movieResults[0].id.toString();
    }

    // Fallback: se preferredType non trova nulla, prova l'altro tipo
    if (movieResults.length > 0) {
      console.log(`[IMDB→TMDB] Fallback Movie: ${imdbId} → TMDB ${movieResults[0].id} (${movieResults[0].title})`);
      return movieResults[0].id.toString();
    } else if (tvResults.length > 0) {
      console.log(`[IMDB→TMDB] Fallback TV: ${imdbId} → TMDB ${tvResults[0].id} (${tvResults[0].name})`);
      return tvResults[0].id.toString();
    }

    console.warn(`No TMDB movie or TV results found for IMDb ID: ${imdbId}`);
    return null;
  } catch (error) {
    console.error(`Error fetching TMDB ID for ${imdbId}:`, error);
    return null;
  }
}

// 1. Aggiungi la funzione di verifica dei TMDB ID
// async function checkTmdbIdOnVixSrc(tmdbId: string, type: ContentType): Promise<boolean> {
//   const skipFlag = (() => {
//     try {
//       // eslint-disable-next-line @typescript-eslint/no-explicit-any
//       const env: any = (global as any)?.process?.env || (typeof process !== 'undefined' ? (process as any).env : {});
//       const v = String(env.VIXSRC_SKIP_LIST_CHECK || '').toLowerCase();
//       return ['1', 'true', 'on', 'yes', 'y'].includes(v);
//     } catch { return false; }
//   })();
//   // Handle both 'movie' and 'film' types (API may send either)
//   const vixSrcApiType = (type === 'movie' || type === 'film' as any) ? 'movie' : 'tv'; // VixSrc usa 'tv' per le serie
//   const listUrl = `${VIXCLOUD_SITE_ORIGIN}/api/list/${vixSrcApiType}`;
//   //   const listUrl = `${VIXCLOUD_SITE_ORIGIN}/api/list/${vixSrcApiType}?lang=it`;

//   try {
//     console.log(`VIX_CHECK: Checking TMDB ID ${tmdbId} of type ${vixSrcApiType} against VixSrc list: ${listUrl}`);
//     const response = await fetch(listUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (StreamViX EarlyDirect)', 'Accept': 'application/json' } });
//     if (!response.ok) {
//       console.error(`VIX_CHECK: Failed to fetch VixSrc list for type ${vixSrcApiType}, status: ${response.status}`);
//       if (skipFlag) {
//         console.warn('VIX_CHECK: Skip flag attivo -> continuo nonostante status non OK');
//         return true;
//       }
//       return false;
//     }
//     const data = await response.json();
//     // L'API restituisce un array di oggetti, ognuno con una proprietà 'id' che è l'ID TMDB
//     if (data && Array.isArray(data)) {
//       const exists = data.some((item: any) => item.tmdb_id && item.tmdb_id.toString() === tmdbId.toString());
//       console.log(`VIX_CHECK: TMDB ID ${tmdbId} ${exists ? 'found' : 'NOT found'} in VixSrc list.`);
//       return exists;
//     } else {
//       console.error(`VIX_CHECK: VixSrc list for type ${vixSrcApiType} is not in the expected format.`);
//       return skipFlag ? (console.warn('VIX_CHECK: formato inatteso ma skip attivo -> true'), true) : false;
//     }
//   } catch (error) {
//     console.error(`VIX_CHECK: Error checking TMDB ID ${tmdbId} on VixSrc:`, error);
//     if (skipFlag) {
//       console.warn('VIX_CHECK: errore ma skip attivo -> continuo');
//       return true;
//     }
//     // Retry una volta se non skip
//     try {
//       await new Promise(r => setTimeout(r, 400));
//       console.log('VIX_CHECK: retry fetch list');
//       const response2 = await fetch(listUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (StreamViX EarlyDirect Retry)', 'Accept': 'application/json' } });
//       if (response2.ok) {
//         const d2 = await response2.json();
//         if (Array.isArray(d2)) {
//           const ex2 = d2.some((item: any) => item.tmdb_id && item.tmdb_id.toString() === tmdbId.toString());
//           console.log(`VIX_CHECK: Retry result -> ${ex2}`);
//           return ex2;
//         }
//       }
//     } catch {/* ignore secondary */ }
//     return false; // fallback finale
//   }
// }

// Verifica se uno specifico episodio (S/E) esiste su VixSrc
// async function checkEpisodeOnVixSrc(tmdbId: string, season: number, episode: number): Promise<boolean> {
//   const skipFlag = (() => {
//     try {
//       // eslint-disable-next-line @typescript-eslint/no-explicit-any
//       const env: any = (global as any)?.process?.env || (typeof process !== 'undefined' ? (process as any).env : {});
//       const v = String(env.VIXSRC_SKIP_LIST_CHECK || '').toLowerCase();
//       return ['1', 'true', 'on', 'yes', 'y'].includes(v);
//     } catch { return false; }
//   })();
//   const listUrl = `${VIXCLOUD_SITE_ORIGIN}/api/list/episode/`;
//   //const listUrl = `${VIXCLOUD_SITE_ORIGIN}/api/list/episode/?lang=it`;
//   try {
//     console.log(`VIX_EP_CHECK: Checking TMDB ID ${tmdbId} S${season}E${episode} against VixSrc episode list: ${listUrl}`);
//     const response = await fetch(listUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (StreamViX EarlyDirect)', 'Accept': 'application/json' } });
//     if (!response.ok) {
//       console.error(`VIX_EP_CHECK: Failed to fetch VixSrc episode list, status: ${response.status}`);
//       if (skipFlag) { console.warn('VIX_EP_CHECK: Skip attivo -> continuo'); return true; }
//       return false;
//     }
//     const data = await response.json();
//     if (data && Array.isArray(data)) {
//       const exists = data.some((item: any) =>
//         item && item.tmdb_id?.toString() === tmdbId.toString() &&
//         Number(item.s) === Number(season) && Number(item.e) === Number(episode)
//       );
//       console.log(`VIX_EP_CHECK: Episode TMDB ${tmdbId} S${season}E${episode} ${exists ? 'found' : 'NOT found'} in VixSrc episode list.`);
//       return exists;
//     }
//     console.error('VIX_EP_CHECK: Episode list format not as expected');
//     return skipFlag ? (console.warn('VIX_EP_CHECK: formato inatteso ma skip -> true'), true) : false;
//   } catch (error) {
//     console.error(`VIX_EP_CHECK: Error checking episode on VixSrc for TMDB ${tmdbId} S${season}E${episode}:`, error);
//     if (skipFlag) { console.warn('VIX_EP_CHECK: errore ma skip -> true'); return true; }
//     // retry una volta
//     try {
//       await new Promise(r => setTimeout(r, 400));
//       console.log('VIX_EP_CHECK: retry fetch episode list');
//       const r2 = await fetch(listUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (StreamViX EarlyDirect Retry)', 'Accept': 'application/json' } });
//       if (r2.ok) {
//         const d2 = await r2.json();
//         if (Array.isArray(d2)) {
//           const ex2 = d2.some((item: any) => item && item.tmdb_id?.toString() === tmdbId.toString() && Number(item.s) === Number(season) && Number(item.e) === Number(episode));
//           console.log(`VIX_EP_CHECK: Retry result -> ${ex2}`);
//           return ex2;
//         }
//       }
//     } catch {/* ignore */ }
//     return false;
//   }
// }

// Helper per verificare se un URL esiste via HEAD request (più veloce e sicuro della lista parziale)
async function checkUrlExists(url: string): Promise<boolean> {
  const skipFlag = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const env: any = (global as any)?.process?.env || (typeof process !== 'undefined' ? (process as any).env : {});
      const v = String(env.VIXSRC_SKIP_LIST_CHECK || '').toLowerCase();
      return ['1', 'true', 'on', 'yes', 'y'].includes(v);
    } catch { return false; }
  })();

  if (skipFlag) {
    console.warn(`VIX_CHECK: Skip flag attivo -> assumo esistente: ${url}`);
    return true;
  }

  try {
    console.log(`VIX_CHECK: Checking existence via HEAD: ${url}`);
    // Importante: User-Agent specifico per evitare blocchi
    const response = await fetch(url, {
      method: 'HEAD',
      headers: {
        'User-Agent': 'Mozilla/5.0 (StreamViX EarlyDirect)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    // 200 OK -> Esiste
    // 301/302 -> Redirect (spesso a trailing slash o altra pagina valida) -> Esiste
    // 404 -> Non esiste
    if (response.ok) {
      console.log(`VIX_CHECK: OK (${response.status}) -> ${url}`);
      return true;
    } else {
      console.log(`VIX_CHECK: Fail (${response.status}) -> ${url}`);
      return false;
    }
  } catch (error) {
    console.error(`VIX_CHECK: Error checking URL ${url}:`, error);
    // In caso di errore di rete (non 404), assumiamo TRUE per non bloccare falsi negativi
    // a meno che non siamo sicuri sia un errore fatale.
    return true;
  }
}

// 2. Modifica la funzione getUrl per rimuovere ?lang=it e aggiungere la verifica HEAD
export async function getUrl(id: string, type: ContentType, config: ExtractorConfig): Promise<string | null> {
  let targetUrl: string | null = null;

  // Support direct TMDB id format for movies: tmdb:<tmdbId>
  // Handle both 'movie' and 'film' types (API may send either)
  if (type === 'movie' || type === 'film' as any) {
    let tmdbId: string | null = null;
    if (id.startsWith('tmdb:')) {
      // direct TMDB format
      tmdbId = id.split(':')[1] || null;
    } else {
      const imdbIdForMovie = id; // legacy imdb id
      tmdbId = await getTmdbIdFromImdbId(imdbIdForMovie, config.tmdbApiKey, 'movie');
    }

    if (!tmdbId) return null;
    // --- OLD LOGIC COMMENTED OUT ---
    // const existsOnVixSrc = await checkTmdbIdOnVixSrc(tmdbId, type);
    // if (!existsOnVixSrc) {
    //   const skip = ['1', 'true', 'on', 'yes', 'y'].includes(String((global as any)?.process?.env?.VIXSRC_SKIP_LIST_CHECK || '').toLowerCase());
    //   if (!skip) {
    //     console.log(`TMDB ID ${tmdbId} for movie not found in VixSrc list. Skipping.`);
    //     return null;
    //   } else {
    //     console.warn(`TMDB ID ${tmdbId} non trovato ma skip attivo -> continuo`);
    //   }
    // }
    // return `${VIXCLOUD_SITE_ORIGIN}/movie/${tmdbId}/`;

    targetUrl = `${VIXCLOUD_SITE_ORIGIN}/movie/${tmdbId}/`;
  } else {
    // Series: support tmdb:tmdbId:season:episode or legacy imdbId:season:episode
    const rawParts = id.split(':');
    let tmdbSeriesId: string | null = null;
    let seasonStr: string | undefined;
    let episodeStr: string | undefined;
    let imdbIdForMapping: string | null = null; // Per mapping statico

    if (rawParts[0] === 'tmdb') {
      tmdbSeriesId = rawParts[1] || null;
      seasonStr = rawParts[2];
      episodeStr = rawParts[3];
    } else {
      const obj = getObject(id); // interprets legacy imdb format
      imdbIdForMapping = obj.id; // Salva IMDB ID per mapping statico
      seasonStr = obj.season;
      episodeStr = obj.episode;

      // Prima controlla se c'è un mapping statico per questa serie+stagione
      const seasonNum = Number(seasonStr);
      if (!isNaN(seasonNum) && imdbIdForMapping) {
        const staticTmdbId = getStaticTmdbMapping(imdbIdForMapping, seasonNum);
        if (staticTmdbId) {
          tmdbSeriesId = staticTmdbId;
          // IMPORTANTE: Quando usiamo mapping statico, la serie TMDB separata
          // ricomincia sempre da stagione 1! (es. Monster S2 su IMDB = S1 su TMDB 225634)
          seasonStr = "1";
          console.log(`[IMDB→TMDB] Usato mapping statico: ${imdbIdForMapping} S${seasonNum} → TMDB ${staticTmdbId} S1 (serie TMDB separata)`);
        }
      }

      // Se non trovato mapping statico, usa API TMDB classica
      if (!tmdbSeriesId) {
        tmdbSeriesId = await getTmdbIdFromImdbId(obj.id, config.tmdbApiKey, 'tv');
      }
    }

    if (!tmdbSeriesId) return null;
    const seasonNum = Number(seasonStr);
    const episodeNum = Number(episodeStr);

    if (isNaN(seasonNum) || isNaN(episodeNum)) {
      console.warn(`Invalid season/episode in id ${id}`);
      return null;
    }

    // --- OLD LOGIC COMMENTED OUT ---
    // const existsOnVixSrc = await checkTmdbIdOnVixSrc(tmdbSeriesId, type);
    // const skipSeries = ['1', 'true', 'on', 'yes', 'y'].includes(String((global as any)?.process?.env?.VIXSRC_SKIP_LIST_CHECK || '').toLowerCase());
    // if (!existsOnVixSrc && !skipSeries) {
    //   console.log(`TMDB ID ${tmdbSeriesId} for series not found in VixSrc list. Skipping.`);
    //   return null;
    // } else if (!existsOnVixSrc && skipSeries) {
    //   console.warn(`TMDB ID ${tmdbSeriesId} series non trovato ma skip attivo -> continuo`);
    // }
    // const epExists = await checkEpisodeOnVixSrc(tmdbSeriesId, seasonNum, episodeNum);
    // if (!epExists && !skipSeries) {
    //   console.log(`VIX_EP_CHECK: Episode not found on VixSrc for TMDB ${tmdbSeriesId} S${seasonNum}E${episodeNum}. Skipping.`);
    //   return null;
    // } else if (!epExists && skipSeries) {
    //   console.warn(`VIX_EP_CHECK: episodio non trovato ma skip attivo -> continuo`);
    // }
    // return `${VIXCLOUD_SITE_ORIGIN}/tv/${tmdbSeriesId}/${seasonNum}/${episodeNum}/`;

    targetUrl = `${VIXCLOUD_SITE_ORIGIN}/tv/${tmdbSeriesId}/${seasonNum}/${episodeNum}/`;
  }

  // Ora verifichiamo se l'URL generato esiste davvero
  if (targetUrl) {
    const exists = await checkUrlExists(targetUrl);
    if (!exists) {
      console.log(`VixSrc content check failed for: ${targetUrl}`);
      return null;
    }
    return targetUrl;
  }

  return null;
}

export async function getStreamContent(id: string, type: ContentType, config: ExtractorConfig): Promise<VixCloudStreamInfo[] | null> {
  // Log config safely without exposing password
  console.log(`Extracting stream for ${id} (${type}) with config:`, { ...config, mfpPsw: config.mfpPsw ? '***' : undefined });
  console.log('[VixSrc][BuildMarker] version=early-direct-v2');
  console.log('[VixSrc][Debug] addonBase initial =', config.addonBase, 'vixDual=', !!config.vixDual, 'vixLocal=', !!config.vixLocal);

  // -------------------------------------------------------------
  // Bridge NUOVE checkbox (vixDirect, vixDirectFhd, vixProxy, vixProxyFhd)
  // alle flag interne storiche (vixLocal, vixDual) SOLO per la logica
  // di generazione. Il filtro visuale resta invariato dopo.
  // - vixLocal deve essere true se l'utente vuole vedere QUALSIASI direct
  //   (base o FHD) => vixDirect || vixDirectFhd
  // - vixDual deve essere true se l'utente chiede QUALSIASI FHD
  //   (directFhd o proxyFhd) per consentire generazione synthetic.
  try {
    const wantsDirect = (config as any).vixDirect === true || (config as any).vixDirectFhd === true;
    const wantsAnyFhd = (config as any).vixDirectFhd === true || (config as any).vixProxyFhd === true;
    // Applica solo se non già esplicitamente impostato (non sovrascrivere override env o landing legacy)
    if (wantsDirect && config.vixLocal !== true) {
      config.vixLocal = true;
      console.log('[VixSrc][Bridge] vixLocal abilitato perché selezionato direct/directFHD');
    }
    if (wantsAnyFhd && config.vixDual !== true) {
      config.vixDual = true;
      console.log('[VixSrc][Bridge] vixDual abilitato perché selezionato qualche FHD (direct o proxy)');
    }
  } catch (e) {
    console.warn('[VixSrc][Bridge] errore applicazione bridge nuove checkbox -> legacy:', (e as any)?.message || e);
  }

  // ------------------------------------------------------------------
  // Environment fallbacks (useful if user non ha ancora reinstallato
  // con landing aggiornata che inietta addonBase / vixDual)
  // ------------------------------------------------------------------
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env: any = (global as any)?.process?.env || (typeof process !== 'undefined' ? (process as any).env : {});
    if (!config.addonBase) {
      const envBase = env.ADDON_BASE_URL || env.STREAMVIX_ADDON_BASE || '';
      if (envBase.startsWith('http') && !envBase.includes(domains.vixsrc)) {
        config.addonBase = envBase.replace(/\/$/, '');
        console.log('[VixSrc][Debug] addonBase fallback da ENV =', config.addonBase);
      } else if (envBase) {
        console.log('[VixSrc][Warn] addonBase ENV ignorato (vuoto o contiene dominio VixSrc):', envBase);
      }
    }
    if (config.vixDual !== true) {
      const dualFlag = String(env.VIX_DUAL || env.VIXSRC_DUAL || env.STREAMVIX_DUAL || '').toLowerCase();
      if (['1', 'true', 'on', 'yes', 'y'].includes(dualFlag)) {
        config.vixDual = true;
        console.log('[VixSrc][Debug] vixDual abilitato via ENV');
      }
    }
  } catch (e) {
    console.warn('[VixSrc][EnvFallback] errore lettura ENV:', (e as any)?.message || e);
  }
  // Re-log dopo eventuali fallback
  if (!config.addonBase) {
    console.log('[VixSrc][Debug] addonBase ancora assente dopo fallback ENV');
    // Ultimo fallback: applica default hard-coded richiesto dall'utente
    // Solo se ancora assente e per evitare derivazioni errate dal dominio sorgente.
    const DEFAULT_ADDON_BASE = 'https://streamvix.hayd.uk';
    try {
      if (!config.addonBase) {
        config.addonBase = DEFAULT_ADDON_BASE;
        console.log('[VixSrc][Debug] addonBase default applicato =', config.addonBase);
      }
    } catch (e) {
      console.warn('[VixSrc][Debug] impossibile applicare default addonBase:', (e as any)?.message || e);
    }
  }
  if (config.vixDual) {
    console.log('[VixSrc][Debug] Modalità DUAL attiva (env o landing)');
  }

  // First, get the target URL on vixsrc.to (this is needed for both proxy and direct modes)
  const targetUrl = await getUrl(id, type, config);
  if (!targetUrl) {
    console.error(`Could not generate target URL for ${id} (${type})`);
    return null;
  }

  // Helper function to fetch movie title from TMDB
  async function getMovieTitle(imdbOrTmdbId: string, tmdbApiKey?: string): Promise<string | null> {
    let tmdbId: string | null = null;
    if (imdbOrTmdbId.startsWith('tmdb:')) {
      tmdbId = imdbOrTmdbId.split(':')[1] || null;
    } else {
      tmdbId = await getTmdbIdFromImdbId(imdbOrTmdbId, tmdbApiKey, 'movie');
    }
    if (!tmdbId) return null;
    const movieDetailsUrl = `${TMDB_API_BASE_URL}/movie/${tmdbId}?api_key=${tmdbApiKey}&language=it`;
    try {
      const response = await fetch(movieDetailsUrl);
      if (!response.ok) {
        console.error(`Error fetching movie title for TMDB ID ${tmdbId}: ${response.status}`);
        return null;
      }
      const data = await response.json();
      return data.title || null;
    } catch (error) {
      console.error("Error fetching movie title:", error);
      return null;
    }
  }

  // Helper function to fetch series title from TMDB
  async function getSeriesTitle(imdbOrTmdbComposite: string, tmdbApiKey?: string): Promise<string | null> {
    let tmdbId: string | null = null;
    if (imdbOrTmdbComposite.startsWith('tmdb:')) {
      const parts = imdbOrTmdbComposite.split(':');
      tmdbId = parts[1] || null; // tmdb:tmdbId:season:episode
    } else {
      tmdbId = await getTmdbIdFromImdbId(imdbOrTmdbComposite.split(':')[0], tmdbApiKey, 'tv');
    }
    if (!tmdbId) return null;
    const seriesDetailsUrl = `${TMDB_API_BASE_URL}/tv/${tmdbId}?api_key=${tmdbApiKey}&language=it`;
    try {
      const response = await fetch(seriesDetailsUrl);
      if (!response.ok) {
        console.error(`Error fetching series title for TMDB ID ${tmdbId}: ${response.status}`);
        return null;
      }
      const data = await response.json();
      return data.name || null;
    } catch (error) {
      console.error("Error fetching series title:", error);
      return null;
    }
  }

  // Funzione per ottenere il proxy stream
  async function getProxyStream(url: string, id: string, type: ContentType, config: ExtractorConfig): Promise<VixCloudStreamInfo | null> {
    const { mfpUrl, mfpPsw, tmdbApiKey } = config;
    if (!mfpUrl) {
      console.warn('VixSrc: Proxy MFP URL non configurato');
      return null;
    }

    const cleanedMfpUrl = mfpUrl.endsWith('/') ? mfpUrl.slice(0, -1) : mfpUrl;
    // Prima richiesta: redirect_stream=false per ottenere JSON completo
    const passwordParam = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
    const baseApi = `${cleanedMfpUrl}/extractor/video?host=VixCloud&redirect_stream=false${passwordParam}&d=${encodeURIComponent(url)}`;
    console.log(`[VixSrc][Proxy] FETCH JSON: ${baseApi}`);

    // Nuova funzione asincrona per ottenere l'URL m3u8 finale
    async function getActualStreamUrl(proxyUrl: string): Promise<string> {
      try {
        // In modalità "debug" non seguiamo i reindirizzamenti e otteniamo l'URL m3u8 dalla risposta JSON
        const debugUrl = proxyUrl.replace('redirect_stream=true', 'redirect_stream=false');

        console.log(`Fetching stream URL from: ${debugUrl}`);
        const response = await fetch(debugUrl);

        if (!response.ok) {
          console.error(`Failed to fetch stream details: ${response.status}`);
          return proxyUrl; // Fallback al proxy URL originale
        }

        const data = await response.json();
        console.log(`MFP Response:`, data);

        // CORREZIONE: usa mediaflow_proxy_url invece di stream_url
        if (data && data.mediaflow_proxy_url) {
          // Costruisci l'URL completo includendo i parametri necessari
          let finalUrl = data.mediaflow_proxy_url;

          // Aggiungi i parametri di query se presenti
          if (data.query_params) {
            const params = new URLSearchParams();
            for (const [key, value] of Object.entries(data.query_params)) {
              if (value !== null) {
                params.append(key, String(value));
              }
            }

            // Se l'URL ha già parametri, aggiungi & altrimenti ?
            finalUrl += (finalUrl.includes('?') ? '&' : '?') + params.toString();
          }

          // Aggiungi il parametro d per il destination_url
          if (data.destination_url) {
            const destParam = 'd=' + encodeURIComponent(data.destination_url);
            finalUrl += (finalUrl.includes('?') ? '&' : '?') + destParam;
          }

          // Aggiungi gli header come parametri h_
          if (data.request_headers) {
            for (const [key, value] of Object.entries(data.request_headers)) {
              if (value !== null) {
                const headerParam = `h_${key}=${encodeURIComponent(String(value))}`;
                finalUrl += '&' + headerParam;
              }
            }
          }

          console.log(`Extracted proxy m3u8 URL: ${finalUrl}`);
          return finalUrl;
        } else {
          console.warn(`Couldn't find mediaflow_proxy_url in MFP response, using proxy URL`);
          return proxyUrl; // Fallback al proxy URL originale
        }
      } catch (error) {
        console.error(`Error extracting m3u8 URL: ${error}`);
        return proxyUrl; // Fallback al proxy URL originale
      }
    }

    // Helper: inietta h=1 nel parametro 'd' (destination_url) del link proxy se possibile
    function injectH1IntoDestination(proxyUrl: string): string {
      try {
        const urlObj = new URL(proxyUrl);
        const dParam = urlObj.searchParams.get('d');
        if (!dParam) return proxyUrl;

        // URLSearchParams.get() restituisce il valore decodificato
        const destUrl = new URL(dParam);
        // imposta/forza h=1
        destUrl.searchParams.set('h', '1');
        // reimposta 'd' con l'URL aggiornato (verrà ri-encodato automaticamente)
        urlObj.searchParams.set('d', destUrl.toString());
        return urlObj.toString();
      } catch {
        return proxyUrl; // in caso di problemi, lascia invariato
      }
    }

    // Ottieni il titolo dalla TMDB API
    const tmdbApiTitle = type === 'movie' ? await getMovieTitle(id, tmdbApiKey) : await getSeriesTitle(id, tmdbApiKey);

    // Determina il nome finale per il proxy stream
    let finalNameForProxy: string;
    if (tmdbApiTitle) { // Titolo TMDB trovato
      finalNameForProxy = tmdbApiTitle;
      if (type !== 'movie') { // È una serie, aggiungi Stagione/Episodio
        const obj = getObject(id);
        finalNameForProxy += ` (S${obj.season}E${obj.episode})`;
      }
      finalNameForProxy += '[ITA]';
    } else { // Titolo TMDB non trovato, usa il fallback
      if (type === 'movie') {
        finalNameForProxy = 'Movie Stream [ITA]';
      } else { // Serie
        const obj = getObject(id);
        // Per richiesta utente, anche i titoli di fallback delle serie dovrebbero avere S/E
        finalNameForProxy = `Series Stream (S${obj.season}E${obj.episode}) [ITA]`;
      }
    }

    // Ottieni l'URL m3u8 finale
    // Usa la funzione per comporre a partire dalla risposta debug
    let finalStreamUrl = await getActualStreamUrl(baseApi.replace('redirect_stream=false', 'redirect_stream=false'));
    console.log(`[VixSrc][Proxy] Final m3u8 URL ricostruito: ${finalStreamUrl}`);

    // Prova ad estrarre la dimensione (bytes) dalla pagina VixSrc
    let sizeBytes: number | undefined = undefined;
    let canPlayFHD = false;
    try {
      const pageRes = await fetch(url);
      if (pageRes.ok) {
        const html = await pageRes.text();
        // Rileva supporto Full HD
        canPlayFHD = html.includes('window.canPlayFHD = true');
        const sizeMatch = html.match(/\"size\":(\d+)/);
        if (sizeMatch) {
          // Nel codice originale la size è in kB -> converti in bytes (kB * 1024)
          const kB = parseInt(sizeMatch[1] as string, 10);
          if (!isNaN(kB) && kB >= 0) sizeBytes = kB * 1024;
        }
      }
    } catch (e) {
      // Ignora errori di parsing/rete: la dimensione è solo informativa
    }
    // Se la pagina supporta FHD, inietta h=1 nel parametro d del link proxy
    if (canPlayFHD) {
      finalStreamUrl = injectH1IntoDestination(finalStreamUrl);
      console.log('Applied h=1 to destination URL (FHD enabled).');
    }

    return {
      name: finalNameForProxy, // will be transformed later
      streamUrl: finalStreamUrl,
      referer: url,
      source: 'proxy',
      ...(typeof sizeBytes === 'number' ? { sizeBytes } : {})
    };
  }

  // Funzione per ottenere il direct stream
  async function getDirectStream(url: string, id: string, type: ContentType, config: ExtractorConfig): Promise<VixCloudStreamInfo | null> {
    // The 'url' parameter is guaranteed to be a string, so no more null checks needed here.
    const siteOrigin = new URL(url).origin;
    let pageHtml = "";
    let finalReferer: string = url;

    try {
      if (url.includes("/iframe")) {
        const version = await fetchVixCloudSiteVersion(siteOrigin);
        const initialResponse = await fetch(url, {
          headers: {
            "x-inertia": "true",
            "x-inertia-version": version,
            "Referer": `${siteOrigin}/`
          },
        });
        if (!initialResponse.ok) throw new Error(`Initial iframe request failed: ${initialResponse.status}`);
        const initialHtml = await initialResponse.text();
        const $initial = cheerio.load(initialHtml);
        const iframeSrc = $initial("iframe").attr("src");

        if (iframeSrc) {
          const actualPlayerUrl = new URL(iframeSrc, siteOrigin).toString();
          const playerResponse = await fetch(actualPlayerUrl, {
            headers: {
              "x-inertia": "true",
              "x-inertia-version": version,
              "Referer": url
            },
          });
          if (!playerResponse.ok) throw new Error(`Player iframe request failed: ${playerResponse.status}`);
          pageHtml = await playerResponse.text();
          finalReferer = actualPlayerUrl; // Now we can modify finalReferer
        } else {
          throw new Error("Iframe src not found in initial response.");
        }
      } else {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Direct embed request failed: ${response.status}`);
        pageHtml = await response.text();
        // Non modificare finalReferer qui, rimane targetUrl
      }

      const $ = cheerio.load(pageHtml);
      const scriptTag = $("body script").filter((_, el) => {
        const htmlContent = $(el).html();
        return !!htmlContent && htmlContent.includes("'token':") && htmlContent.includes("'expires':");
      }).first();
      const scriptContent = scriptTag.html() || '';

      if (!scriptContent) throw new Error("Player script with token/expires not found.");

      const tokenMatch = scriptContent.match(/'token':\s*'(\w+)'/);
      const expiresMatch = scriptContent.match(/'expires':\s*'(\d+)'/);
      const serverUrlMatch = scriptContent.match(/url:\s*'([^']+)'/);

      if (!tokenMatch || !expiresMatch || !serverUrlMatch) {
        throw new Error("Failed to extract token, expires, or server URL from script.");
      }

      const token = tokenMatch[1];
      const expires = expiresMatch[1];
      let serverUrl = serverUrlMatch[1];
      let finalStreamUrl: string;

      // Costruzione URL finale stile webstreamr:
      // 1. Normalizza /playlist/<id> aggiungendo .m3u8 se manca
      // 2. Se l'URL originale conteneva già b=1 lo manteniamo.
      // 3. Se NON conteneva b=1 lo aggiungeremo solo se poi rileviamo FHD (h=1) disponibile.
      let hadBOriginally = false; // verrà deciso dopo aver rilevato canPlayFHD
      try {
        serverUrl = ensurePlaylistM3u8(serverUrl);
        const urlObj = new URL(serverUrl);
        const hadB = urlObj.searchParams.get('b') === '1';
        hadBOriginally = hadB;
        // Costruiamo intanto base senza token/expires (li aggiungiamo dopo per mantenere ordine desiderato: b, token, expires, h)
        urlObj.search = '';
        finalStreamUrl = urlObj.toString();
        // nessuna aggiunta di b=1 se assente: hadBOriginally memorizza se presente all'origine
      } catch (e) {
        console.warn('[VixSrc][Direct] Fallback parsing serverUrl prima di token/expire:', (e as any)?.message || e);
        finalStreamUrl = ensurePlaylistM3u8(serverUrl);
        // hadBOriginally già valorizzato
        hadBOriginally = /([?&])b=1(?!\d)/.test(serverUrl);
      }

      // Detect FHD (canPlayFHD)
      let fhd = false;
      if (scriptContent.includes("window.canPlayFHD = true")) fhd = true; else if (/window\.canPlayFHD\s*=\s*true/.test(scriptContent)) fhd = true;
      // Ora componiamo la query mantenendo ordine: (b=1 se applicabile), token, expires, (h=1 se FHD)
      try {
        const assembled = new URL(finalStreamUrl);
        if (hadBOriginally) assembled.searchParams.set('b', '1');
        assembled.searchParams.set('token', token);
        assembled.searchParams.set('expires', expires);
        if (fhd) assembled.searchParams.set('h', '1');
        finalStreamUrl = assembled.toString();
        console.log('[VixSrc][Direct] FHD', fhd, 'hadBOriginally', hadBOriginally);
      } catch (e) {
        console.warn('[VixSrc][Direct] Fallback composizione finale query:', (e as any)?.message || e);
        const parts: string[] = [];
        if (hadBOriginally) parts.push('b=1');
        parts.push(`token=${token}`);
        parts.push(`expires=${expires}`);
        if (fhd) parts.push('h=1');
        finalStreamUrl += (finalStreamUrl.includes('?') ? '&' : '?') + parts.join('&');
      }

      // --- Inizio della nuova logica per il titolo ---

      // 1. Ottieni il titolo di base, dando priorità a TMDB
      let baseTitle: string | null = null;

      // Prima prova a ottenere il titolo dalle API TMDB
      baseTitle = type === 'movie' ?
        await getMovieTitle(id, config.tmdbApiKey) :
        await getSeriesTitle(id, config.tmdbApiKey);

      console.log(`TMDB title result: "${baseTitle}"`);

      // Solo se TMDB fallisce, prova a usare il titolo dalla pagina
      if (!baseTitle) {
        const pageTitle = $("title").text().trim();
        // Pulisci ulteriormente il titolo rimuovendo parti comuni nei siti di streaming
        if (pageTitle) {
          baseTitle = pageTitle
            .replace(" - VixSrc", "")
            .replace(" - Guarda Online", "")
            .replace(" - Streaming", "")
            .replace(/\s*\|\s*.*$/, ""); // Rimuove qualsiasi cosa dopo il simbolo |
        }
        console.log(`Page title after cleanup: "${baseTitle}"`);
      }

      // 2. Determina il nome finale, gestendo esplicitamente il caso null
      let determinedName: string;
      if (baseTitle) {
        // Se abbiamo un titolo, ora siamo sicuri che sia una stringa.
        if (type === 'movie') {
          determinedName = `${baseTitle} [ITA]`;
        } else { // È una serie, aggiungi info S/E
          const obj = getObject(id);
          determinedName = `${baseTitle} (S${obj.season}E${obj.episode}) [ITA]`;
        }
      } else {
        // Se non abbiamo un titolo (baseTitle è null), usiamo un nome di fallback.
        if (type === 'movie') {
          determinedName = 'Movie Stream (Direct) [ITA]';
        } else { // È una serie
          const obj = getObject(id);
          // Per richiesta utente, anche i titoli di fallback delle serie dovrebbero avere S/E
          determinedName = `Series Stream (Direct) (S${obj.season}E${obj.episode}) [ITA]`;
        }
      }

      console.log(`Final stream name: "${determinedName}"`);
      console.log(`Final stream URL: "${finalStreamUrl}"`); // Aggiungi questo log per l'URL

      // --- Variant forcing disabilitato: manteniamo sempre la master firmata ---
      // Motivazione: le varianti (?type=video&rendition=1080p) rimuovono h=1, possono perdere tracce audio/sub e
      // generano token differenti/non validi. Manteniamo solo la URL master con token,expires,(h=1) senza edge.
      // (Se necessario in futuro, riattivare dietro flag.)

      // Normalizzazione: rimuovi parametri inutili (edge, type, rendition) se comparissero già nella URL.
      try {
        if (finalStreamUrl.includes('/playlist/')) {
          const u = new URL(finalStreamUrl);
          // Preserva solo token, expires, h (se presente), più eventuali altri parametri necessari futuri.
          const token = u.searchParams.get('token');
          const expires = u.searchParams.get('expires');
          const h = u.searchParams.get('h');
          const b = u.searchParams.get('b'); // mantieni se presente
          u.search = '';
          if (b) u.searchParams.set('b', b); // b prima per replicare ordine osservato (b,token,expires,h)
          if (token) u.searchParams.set('token', token);
          if (expires) u.searchParams.set('expires', expires);
          if (h) u.searchParams.set('h', h);
          const cleaned = u.toString();
          if (cleaned !== finalStreamUrl) {
            console.log('[VixSrc][Direct][Normalize] Pulito URL master =>', cleaned);
            finalStreamUrl = cleaned;
          } else {
            console.log('[VixSrc][Direct][Normalize] URL master già pulita');
          }
        }
      } catch (e) {
        console.warn('[VixSrc][Direct][Normalize] Errore normalizzazione URL master:', (e as any)?.message || e);
      }

      return {
        name: determinedName, // raw; unify later
        streamUrl: finalStreamUrl,
        referer: finalReferer,
        source: 'direct'
      };

    } catch (error) {
      let message = "Unknown error during stream content extraction";
      if (error instanceof Error) {
        message = error.message;
      }
      console.error(`Stream extraction error: ${message}`, error);

      // Ritorna null invece di un oggetto con URL HTML
      return null;
    }
  }

  // Direct mode now controlled ONLY by runtime config (checkbox "Local"), not by env.
  const directModeEnabled = !!config.vixLocal;

  const streams: VixCloudStreamInfo[] = [];
  // -------------------------------------------------------------
  // SEZIONE GENERAZIONE VARIANTI (ripristino matrice scenari legacy)
  // 1. Tentativo direct early (se abilitato vixLocal)
  // 2. Costruzione proxy (se MFP configurato)
  // 3. Costruzione synthetic (se vixDual + addonBase valido)
  // 4. Matrice scenari (1..4) invariata rispetto a versione backup
  //    ma NON ritorna subito: accumula in baseList e passa poi
  //    alla funzione di filtro visibilità finalizeAndFilter.
  // -------------------------------------------------------------

  let directResult: VixCloudStreamInfo | null = null;
  let directHadB = false; // se il master originale (direct) aveva b=1
  try {
    console.log('[VixSrc][EarlyDirect] Tentativo parse diretto iniziale');
    directResult = await getDirectStream(targetUrl, id, type, config);
    if (directResult) {
      if (!/🔓/.test(directResult.name)) directResult.name = directResult.name.replace(/\s*🔓?$/, '') + ' 🔓';
      // Pulizia parametri superflui (difensivo)
      try {
        if (directResult.streamUrl.includes('/playlist/')) {
          const u = new URL(directResult.streamUrl);
          const token = u.searchParams.get('token');
          const expires = u.searchParams.get('expires');
          const h = u.searchParams.get('h');
          const b = u.searchParams.get('b');
          u.search = '';
          if (b) u.searchParams.set('b', b);
          if (token) u.searchParams.set('token', token);
          if (expires) u.searchParams.set('expires', expires);
          if (h) u.searchParams.set('h', h);
          const cleaned = u.toString();
          if (cleaned !== directResult.streamUrl) {
            console.log('[VixSrc][Direct][FinalizeNormalize] URL direct ripulita =>', cleaned);
            directResult.streamUrl = cleaned;
          }
        }
      } catch {/* ignore */ }
      try {
        if (directResult.streamUrl.includes('/playlist/')) {
          const uTest = new URL(directResult.streamUrl);
          if (uTest.searchParams.get('b') === '1') directHadB = true;
        }
      } catch {/* ignore */ }
      streams.push(directResult);
    } else {
      console.log('[VixSrc][EarlyDirect] Nessun direct (null)');
    }
  } catch (e) {
    console.error('[VixSrc][EarlyDirect] Errore direct parse:', (e as any)?.message || e);
  }

  // Proxy variant (solo se credenziali presenti)
  let proxyResult: VixCloudStreamInfo | null = null;
  if (config.mfpUrl && config.mfpPsw) {
    try {
      console.log('[VixSrc][ProxyStage] Invoco getProxyStream per costruire versione proxy');
      proxyResult = await getProxyStream(targetUrl, id, type, config);
      if (proxyResult) {
        if (!/🔒/.test(proxyResult.name)) proxyResult.name = proxyResult.name.replace(/\s*🔓?$/, '') + ' 🔒';
        // Normalizza inner d param se contiene master playlist
        try {
          const urlObj = new URL(proxyResult.streamUrl);
          const dParam = urlObj.searchParams.get('d');
          if (dParam && /\/playlist\//.test(dParam)) {
            try {
              const inner = new URL(dParam);
              if (directHadB && inner.searchParams.get('b') !== '1') inner.searchParams.set('b', '1');
              const token = inner.searchParams.get('token');
              const expires = inner.searchParams.get('expires');
              const h = inner.searchParams.get('h');
              inner.search = '';
              if (directHadB) inner.searchParams.set('b', '1');
              if (token) inner.searchParams.set('token', token);
              if (expires) inner.searchParams.set('expires', expires);
              if (h) inner.searchParams.set('h', h);
              const cleanedInner = inner.toString();
              if (cleanedInner !== dParam) { urlObj.searchParams.set('d', cleanedInner); proxyResult.streamUrl = urlObj.toString(); }
            } catch {/* ignore */ }
          }
          // Se non c'è parametro d ma l'URL proxy stesso è playlist e manca b=1, aggiungilo
          if (directHadB && !dParam && /\/playlist\//.test(proxyResult.streamUrl)) {
            try {
              const pu = new URL(proxyResult.streamUrl);
              if (pu.searchParams.get('b') !== '1') pu.searchParams.set('b', '1');
              proxyResult.streamUrl = pu.toString();
            } catch {/* ignore */ }
          }
        } catch {/* ignore */ }
        streams.push(proxyResult);
      }
    } catch (e) {
      console.error('[VixSrc][ProxyStage] Errore getProxyStream:', (e as any)?.message || e);
    }
  }

  if (!streams.length) {
    console.warn('[VixSrc] Nessuno stream ottenuto');
    return null; // niente da filtrare
  }

  // Ordinamento stabile: direct prima di proxy
  streams.sort((a, b) => a.source === b.source ? 0 : (a.source === 'direct' ? -1 : 1));

  // Synthetic helpers (solo se addonBase valido e scenario richiede)
  // Costruzione usableAddonBase con rilevamento automatico prioritario (come DLHD)
  let usableAddonBase = '';

  // Tentativo 1: Rilevamento automatico dalla richiesta corrente (PRIORITÀ MASSIMA)
  try {
    const lastReq: any = (global as any).lastExpressRequest;
    if (lastReq) {
      const protocol = lastReq.protocol || 'https';
      const host = lastReq.get('host') || lastReq.headers?.host || '';
      if (host && !host.includes(domains.vixsrc)) {
        usableAddonBase = `${protocol}://${host}`;
        console.log(`[VixSrc] addonBase rilevato automaticamente: ${usableAddonBase}`);
      } else if (host && host.includes(domains.vixsrc)) {
        console.log(`[VixSrc] Host rilevato è dominio VixSrc stesso (${host}), skip per evitare loop`);
      }
    }
  } catch (e) {
    console.log(`[VixSrc] Errore rilevamento automatico addonBase:`, e);
  }

  // Fallback 2: Variabile ambiente ADDON_BASE_URL
  if (!usableAddonBase) {
    const envBase = (process && process.env && process.env.ADDON_BASE_URL) ? String(process.env.ADDON_BASE_URL).trim() : '';
    if (envBase && !envBase.includes(domains.vixsrc)) {
      usableAddonBase = envBase;
      console.log(`[VixSrc] addonBase da variabile ambiente: ${usableAddonBase}`);
    } else if (envBase && envBase.includes(domains.vixsrc)) {
      console.log(`[VixSrc] ADDON_BASE_URL è dominio VixSrc stesso, skip per evitare loop`);
    }
  }

  // Fallback 3: config.addonBase (runtime / landing page)
  if (!usableAddonBase) {
    if (config.addonBase && !config.addonBase.includes(domains.vixsrc)) {
      usableAddonBase = config.addonBase;
      console.log(`[VixSrc] addonBase da config runtime: ${usableAddonBase}`);
    } else if (config.addonBase && config.addonBase.includes(domains.vixsrc)) {
      console.log(`[VixSrc] config.addonBase è dominio VixSrc stesso, skip per evitare loop`);
    }
  }

  if (!usableAddonBase) {
    console.log(`[VixSrc] Nessun usableAddonBase disponibile: synthetic FHD disabilitato`);
  }

  const haveMfp = !!(config.mfpUrl && config.mfpPsw && streams.some(s => s.source === 'proxy'));
  const haveDirect = streams.some(s => s.source === 'direct');

  function buildSyntheticBase(masterUrl: string, referer: string): VixCloudStreamInfo | null {
    if (!usableAddonBase || !config.vixDual) return null;
    if (!/\/playlist\//.test(masterUrl)) return null;
    try {
      const mu = new URL(masterUrl);
      const token = mu.searchParams.get('token');
      const expires = mu.searchParams.get('expires');
      const h = mu.searchParams.get('h');
      const b = mu.searchParams.get('b');
      mu.search = '';
      if (directHadB || b === '1') mu.searchParams.set('b', '1');
      if (token) mu.searchParams.set('token', token);
      if (expires) mu.searchParams.set('expires', expires);
      if (h) mu.searchParams.set('h', h);
      masterUrl = mu.toString();
    } catch {/* ignore */ }
    // Aggiunto suffisso .m3u8 per compatibilità con player HLS che richiedono estensione
    const syntheticUrl = `${usableAddonBase.replace(/\/$/, '')}/vixsynthetic.m3u8?src=${encodeURIComponent(masterUrl)}&lang=it&max=1&multi=1`;
    const directRef = streams.find(s => s.source === 'direct');
    if (haveDirect && directRef && masterUrl === directRef.streamUrl) {
      return { name: directRef.name.replace(/\s*🔓FHD?$/, '').replace(/\s*🔓$/, '') + ' 🔓FHD', streamUrl: syntheticUrl, referer, source: 'direct', isSyntheticFhd: true, originalName: directRef.name };
    }
    const proxyRef = streams.find(s => s.source === 'proxy');
    if (!haveDirect && proxyRef) {
      const baseName = proxyRef.name.replace(/\s*🔒FHD$/, '').replace(/\s*🔒$/, '').replace(/\s*🔓FHD?$/, '').replace(/\s*🔓$/, '').trim();
      return { name: baseName + ' 🔓FHD', streamUrl: syntheticUrl, referer, source: 'direct', isSyntheticFhd: true, originalName: baseName };
    }
    return { name: 'Synthetic 🔓FHD', streamUrl: syntheticUrl, referer, source: 'direct', isSyntheticFhd: true };
  }

  function buildSyntheticProxyWrapper(innerSynthetic: string, referer: string): VixCloudStreamInfo | null {
    if (!haveMfp || !config.vixDual || !config.mfpUrl) return null;
    const cleaned = config.mfpUrl.endsWith('/') ? config.mfpUrl.slice(0, -1) : config.mfpUrl;
    let syntheticTarget = innerSynthetic;
    try {
      if (directHadB) {
        const su = new URL(syntheticTarget);
        if (su.searchParams.get('b') !== '1') su.searchParams.set('b', '1');
        syntheticTarget = su.toString();
      }
    } catch {/* ignore */ }
    const passwordParam = config.mfpPsw ? `&api_password=${encodeURIComponent(config.mfpPsw)}` : '';
    const wrapper = `${cleaned}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(syntheticTarget)}${passwordParam}`;
    const proxyOrig = streams.find(s => s.source === 'proxy');
    const baseName = proxyOrig ? proxyOrig.name.replace(/\s*🔒FHD$/, '').replace(/\s*🔒$/, '') : 'Proxy';
    return { name: baseName + ' 🔒 FHD', streamUrl: wrapper, referer, source: 'proxy', isSyntheticFhd: true, originalName: baseName };
  }

  const directStream = streams.find(s => s.source === 'direct') || null;
  const proxyStream = streams.find(s => s.source === 'proxy') || null;

  console.log('[VixSrc][Scenario] local=', !!config.vixLocal, 'dual=', !!config.vixDual, 'haveDirect=', !!directStream, 'haveProxy=', !!proxyStream, 'usableAddonBase=', !!usableAddonBase, 'haveMfp=', haveMfp);
  console.log('[VixSrc][VariantForce] DISABLED: utilizzo sempre master playlist pulita (token,expires,h).');

  let baseList: VixCloudStreamInfo[] | null = null;
  try {
    if (config.vixLocal && !config.vixDual) {
      baseList = [...(directStream ? [directStream] : []), ...(proxyStream ? [proxyStream] : [])]; // Scenario 1
    } else if (config.vixLocal && config.vixDual) { // Scenario 2
      const result: VixCloudStreamInfo[] = [];
      if (directStream) result.push(directStream);
      if (proxyStream) result.push(proxyStream);
      let masterForSynthetic: string | null = null;
      if (directStream && /\/playlist\//.test(directStream.streamUrl)) masterForSynthetic = directStream.streamUrl;
      if (!masterForSynthetic && proxyStream) {
        try { const u = new URL(proxyStream.streamUrl); const d = u.searchParams.get('d'); if (d && /\/playlist\//.test(d)) masterForSynthetic = d; } catch {/* ignore */ }
      }
      if (masterForSynthetic) {
        const syn = buildSyntheticBase(masterForSynthetic, directStream ? directStream.referer : (proxyStream ? proxyStream.referer : ''));
        if (syn) result.push(syn);
        if (syn) { const synProxy = buildSyntheticProxyWrapper(syn.streamUrl, proxyStream ? proxyStream.referer : syn.referer); if (synProxy) result.push(synProxy); }
      }
      baseList = result;
    } else if (!config.vixLocal && config.vixDual) { // Scenario 3
      const result: VixCloudStreamInfo[] = [];
      let masterForSynthetic: string | null = null;
      if (directStream && /\/playlist\//.test(directStream.streamUrl)) masterForSynthetic = directStream.streamUrl;
      if (!masterForSynthetic && proxyStream) {
        try { const u = new URL(proxyStream.streamUrl); const d = u.searchParams.get('d'); if (d && /\/playlist\//.test(d)) masterForSynthetic = d; } catch {/* ignore */ }
      }
      if (masterForSynthetic) {
        const syn = buildSyntheticBase(masterForSynthetic, directStream ? directStream.referer : (proxyStream ? proxyStream.referer : ''));
        if (syn) result.push(syn);
        if (syn) { const synProxy = buildSyntheticProxyWrapper(syn.streamUrl, proxyStream ? proxyStream.referer : syn.referer); if (synProxy) result.push(synProxy); }
      }
      baseList = result;
    } else { // Scenario 4: solo proxy
      baseList = proxyStream ? [proxyStream] : [];
    }
  } catch (e) {
    console.warn('[VixSrc][ScenarioMatrix] Errore scenario:', (e as any)?.message || e);
    baseList = streams.slice();
  }

  // Se per qualche ragione vuota, fallback alla lista originale
  if (!baseList || !baseList.length) baseList = streams.slice();

  // helper to apply unified naming when returning
  function finalize(list: VixCloudStreamInfo[]): VixCloudStreamInfo[] {
    return list.map(s => {
      try {
        const isFhd = /[?&]h=1/.test(s.streamUrl) || /FHD/.test(s.name) || !!config.vixDual;
        const baseTitle = s.name
          .replace(/\s*🔓FHD?$/, '')
          .replace(/\s*🔒FHD?$/, '')
          .replace(/\s*🔓$/, '')
          .replace(/\s*🔒$/, '')
          .replace(/\s*\[ITA\].*$/, '')
          .replace(/\s*\[SUB\].*$/, '')
          .trim();
        const isSub = /\bSUB\b/i.test(s.name);
        const proxyOn = s.source === 'proxy' || /mediaflow|proxy/i.test(s.streamUrl);
        const sizeBytes = (s as any).sizeBytes as number | undefined;
        const unified = buildUnifiedStreamName({
          baseTitle: baseTitle || 'Titolo',
          isSub,
          sizeBytes,
          playerName: undefined,
          proxyOn,
          provider: 'vixsrc',
          isFhdOrDual: isFhd
        });
        // PATCH: aggiungi linea fissa "🎦 1080p" SOLO per stream synthetic FHD VixSrc (isSyntheticFhd true)
        // Requisito: la linea deve comparire immediatamente sopra la linea Proxy e solo per questi casi.
        if ((s as any).isSyntheticFhd) {
          try {
            const lines = unified.split('\n');
            const proxyIdx = lines.findIndex(l => l.startsWith('🌐 Proxy '));
            if (proxyIdx > 0) {
              const already = lines.some(l => l.trim() === '🎦 1080p');
              if (!already) {
                lines.splice(proxyIdx, 0, '🎦 1080p');
              }
              return { ...s, name: lines.join('\n') };
            }
          } catch {/* ignore injection errors */ }
        }
        return { ...s, name: unified };
      } catch { return s; }
    });
  }

  // --- Filtro visualizzazione NON invasivo: applicato DOPO la logica originale ---
  function finalizeAndFilter(list: VixCloudStreamInfo[]): VixCloudStreamInfo[] {
    const f = {
      direct: (config as any).vixDirect === true,
      directFhd: (config as any).vixDirectFhd === true,
      proxy: (config as any).vixProxy === true,
      proxyFhd: (config as any).vixProxyFhd === true
    };
    const none = !f.direct && !f.directFhd && !f.proxy && !f.proxyFhd;
    const variants = {
      baseDirect: list.find(s => s.source === 'direct' && !((s as any).isSyntheticFhd || /FHD/.test(s.name))),
      directFhd: list.find(s => s.source === 'direct' && ((s as any).isSyntheticFhd || /FHD/.test(s.name))),
      baseProxy: list.find(s => s.source === 'proxy' && !((s as any).isSyntheticFhd || /FHD/.test(s.name))),
      proxyFhd: list.find(s => s.source === 'proxy' && ((s as any).isSyntheticFhd || /FHD/.test(s.name)))
    };
    const available = Object.entries(variants).filter(([_, v]) => !!v).map(([k]) => k);
    const mfpPresent = !!(config.mfpUrl && config.mfpPsw);
    console.log('[VixSrc][Filter] Flags', f, 'MFP', mfpPresent, 'Available', available);
    const out: VixCloudStreamInfo[] = []; const add = (v: VixCloudStreamInfo | undefined | null) => { if (v && !out.includes(v)) out.push(v); };

    // -------------------------------------------------------------
    // EARLY SHORTCUT: nessuna credenziale MFP => vietato mostrare
    // qualsiasi variante proxy (base o FHD) indipendentemente da
    // cosa è stato selezionato nelle checkbox. Questo elimina le
    // ultime leakage (es. D+DF+PF, D+P+PF) osservate nei test.
    // Logica di degradazione:
    //  - Nessuna flag: fallback a direct (base o FHD)
    //  - Qualsiasi combinazione che include direct/directFHD: mostra solo le corrispondenti direct
    //  - Solo proxy/proxyFHD selezionati: degrada a direct (base o FHD) se disponibile
    //  - Ordine: baseDirect prima, poi directFhd se distinta e richiesta
    // -------------------------------------------------------------
    if (!mfpPresent) {
      // Caso auto (nessuna selezione): preferisci baseDirect altrimenti directFhd
      if (none) {
        add(variants.baseDirect || variants.directFhd);
        const fin = finalize(out); console.log('[VixSrc][Filter][Chosen][EarlyNoMFP]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
      }
      // Se l'utente ha chiesto direct e/o directFhd, rispetta ordine
      if (f.direct || f.directFhd) {
        if (f.direct) add(variants.baseDirect || variants.directFhd);
        if (f.directFhd) add(variants.directFhd || variants.baseDirect);
        const fin = finalize(out); console.log('[VixSrc][Filter][Chosen][EarlyNoMFP]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
      }
      // Solo proxy flags selezionate -> degrada a direct fallback
      if (f.proxy || f.proxyFhd) {
        add(variants.baseDirect || variants.directFhd);
        // Se l'utente aveva richiesto proxyFHD e abbiamo anche una directFhd distinta, aggiungila come miglior fallback
        if (f.proxyFhd && variants.directFhd && variants.directFhd !== variants.baseDirect) add(variants.directFhd);
        const fin = finalize(out); console.log('[VixSrc][Filter][Chosen][EarlyNoMFP]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
      }
    }

    if (none) { // default (auto)
      if (mfpPresent) {
        // prefer proxy family if available
        add(variants.baseProxy || variants.proxyFhd || variants.baseDirect || variants.directFhd);
      } else {
        // no MFP: never show proxy variants
        add(variants.baseDirect || variants.directFhd);
      }
      const fin = finalize(out);
      console.log('[VixSrc][Filter][Chosen]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : '')));
      return fin;
    }
    // Solo Direct
    if (f.direct && !f.directFhd && !f.proxy && !f.proxyFhd) {
      if (mfpPresent) add(variants.baseDirect || variants.directFhd || variants.baseProxy || variants.proxyFhd);
      else add(variants.baseDirect || variants.directFhd); // no proxy leak
      const fin = finalize(out); console.log('[VixSrc][Filter][Chosen]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
    }
    // Solo Direct FHD
    if (!f.direct && f.directFhd && !f.proxy && !f.proxyFhd) {
      if (mfpPresent) add(variants.directFhd || variants.baseDirect || variants.proxyFhd || variants.baseProxy);
      else add(variants.directFhd || variants.baseDirect); // strict
      const fin = finalize(out); console.log('[VixSrc][Filter][Chosen]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
    }
    // Solo Proxy
    if (!f.direct && !f.directFhd && f.proxy && !f.proxyFhd) {
      if (mfpPresent) add(variants.baseProxy || variants.proxyFhd || variants.baseDirect || variants.directFhd);
      else add(variants.baseDirect || variants.directFhd); // degrade to direct only
      const fin = finalize(out); console.log('[VixSrc][Filter][Chosen]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
    }
    // Solo Proxy FHD
    if (!f.direct && !f.directFhd && !f.proxy && f.proxyFhd) {
      if (mfpPresent) add(variants.proxyFhd || variants.baseProxy || variants.directFhd || variants.baseDirect);
      else add(variants.directFhd || variants.baseDirect); // strict
      const fin = finalize(out); console.log('[VixSrc][Filter][Chosen]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
    }
    // Direct + Proxy
    if (f.direct && !f.directFhd && f.proxy && !f.proxyFhd) {
      if (mfpPresent) { add(variants.baseDirect || variants.directFhd); add(variants.baseProxy || variants.proxyFhd); }
      else { add(variants.baseDirect || variants.directFhd); } // block proxy
      const fin = finalize(out); console.log('[VixSrc][Filter][Chosen]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
    }
    // Direct + Direct FHD (solo) -> mai proxy
    if (f.direct && f.directFhd && !f.proxy && !f.proxyFhd) {
      if (variants.baseDirect) add(variants.baseDirect);
      if (variants.directFhd && variants.directFhd !== variants.baseDirect) add(variants.directFhd);
      if (!variants.baseDirect && !variants.directFhd && mfpPresent) add(variants.baseProxy || variants.proxyFhd); // only if truly nothing
      const fin = finalize(out); console.log('[VixSrc][Filter][Chosen]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
    }
    // Direct FHD + Proxy FHD
    if (!f.direct && f.directFhd && !f.proxy && f.proxyFhd) {
      if (mfpPresent) { add(variants.directFhd || variants.baseDirect); add(variants.proxyFhd || variants.baseProxy); }
      else { add(variants.directFhd || variants.baseDirect); }
      const fin = finalize(out); console.log('[VixSrc][Filter][Chosen]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
    }
    // Direct FHD + Proxy (senza Direct base, senza Proxy FHD)
    if (!f.direct && f.directFhd && f.proxy && !f.proxyFhd) {
      if (mfpPresent) { add(variants.directFhd || variants.baseDirect); add(variants.baseProxy || variants.proxyFhd); }
      else { add(variants.directFhd || variants.baseDirect); }
      const fin = finalize(out); console.log('[VixSrc][Filter][Chosen]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
    }
    // Tutte e 4
    if (f.direct && f.directFhd && f.proxy && f.proxyFhd) {
      if (mfpPresent) { add(variants.baseDirect || variants.directFhd); add(variants.directFhd); add(variants.baseProxy || variants.proxyFhd); add(variants.proxyFhd); }
      else { add(variants.baseDirect || variants.directFhd); add(variants.directFhd); }
      const fin = finalize(out); console.log('[VixSrc][Filter][Chosen]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
    }
    // Direct + Direct FHD + Proxy (senza Proxy FHD)
    if (f.direct && f.directFhd && f.proxy && !f.proxyFhd) {
      if (mfpPresent) {
        add(variants.baseDirect || variants.directFhd);
        add(variants.directFhd || variants.baseDirect);
        add(variants.baseProxy || variants.proxyFhd);
      } else {
        add(variants.baseDirect || variants.directFhd);
        add(variants.directFhd || variants.baseDirect);
      }
      const fin = finalize(out); console.log('[VixSrc][Filter][Chosen]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
    }
    // Direct + Proxy FHD
    if (f.direct && !f.directFhd && !f.proxy && f.proxyFhd) {
      if (mfpPresent) { add(variants.baseDirect || variants.directFhd); add(variants.proxyFhd || variants.baseProxy); }
      else { add(variants.baseDirect || variants.directFhd); } // remove second add (no implicit FHD if not requested)
      const fin = finalize(out); console.log('[VixSrc][Filter][Chosen]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
    }
    // Proxy + Proxy FHD (senza direct)
    if (!f.direct && !f.directFhd && f.proxy && f.proxyFhd) {
      if (mfpPresent) {
        add(variants.baseProxy || variants.proxyFhd);
        add(variants.proxyFhd);
        const onlyProxy = out.filter(v => v.source === 'proxy');
        const fin = finalize(onlyProxy.length ? onlyProxy : out); console.log('[VixSrc][Filter][Chosen]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
      } else {
        add(variants.directFhd || variants.baseDirect); // strict fallback
        const fin = finalize(out); console.log('[VixSrc][Filter][Chosen]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
      }
    }
    // Direct FHD + Proxy + Proxy FHD (senza Direct base)
    if (!f.direct && f.directFhd && f.proxy && f.proxyFhd) {
      if (mfpPresent) {
        add(variants.directFhd || variants.baseDirect);
        add(variants.baseProxy || variants.proxyFhd);
        add(variants.proxyFhd);
      } else {
        add(variants.directFhd || variants.baseDirect);
      }
      const fin = finalize(out); console.log('[VixSrc][Filter][Chosen]', fin.map(s => s.source + (s.isSyntheticFhd ? 'FHD' : ''))); return fin;
    }
    console.log('[VixSrc][Filter] Combinazione non riconosciuta, ritorno lista intera');
    return finalize(list);
  }

  // Safety final return (should normally not reach here) - applica comunque filtro
  return finalizeAndFilter(baseList);
}
