import { ContentType } from "stremio-addon-sdk";
import * as cheerio from "cheerio";
import * as fs from 'fs';
import * as path from 'path';
const domains = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/domains.json'), 'utf-8'));
const VIXCLOUD_SITE_ORIGIN = `https://${domains.vixsrc}`; // e.g., "https://vixcloud.co"
const VIXCLOUD_REQUEST_TITLE_PATH = "/richiedi-un-titolo"; // Path used to fetch site version
const VIXCLOUD_EMBED_BASE_PATH = "/embed"; // Base path for embed URLs, e.g., /embed/movie/tt12345
// --- TMDB Configuration ---
const TMDB_API_BASE_URL = "https://api.themoviedb.org/3";

// --- End Configuration ---

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
}

export interface VixCloudStreamInfo {
  name: string;
  streamUrl: string;
  referer: string;
  source: 'proxy' | 'direct';
  // Optional: estimated content size in bytes (parsed from VixSrc page)
  sizeBytes?: number;
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

export async function getTmdbIdFromImdbId(imdbId: string, tmdbApiKey?: string): Promise<string | null> {
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
    if (data.movie_results && data.movie_results.length > 0) {
      return data.movie_results[0].id.toString();
    } else if (data.tv_results && data.tv_results.length > 0) {
      return data.tv_results[0].id.toString();
    }
    console.warn(`No TMDB movie or TV results found for IMDb ID: ${imdbId}`);
    return null;
  } catch (error) {
    console.error(`Error fetching TMDB ID for ${imdbId}:`, error);
    return null;
  }
}

// 1. Aggiungi la funzione di verifica dei TMDB ID
async function checkTmdbIdOnVixSrc(tmdbId: string, type: ContentType): Promise<boolean> {
  const skipFlag = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const env: any = (global as any)?.process?.env || (typeof process !== 'undefined' ? (process as any).env : {});
      const v = String(env.VIXSRC_SKIP_LIST_CHECK || '').toLowerCase();
      return ['1','true','on','yes','y'].includes(v);
    } catch { return false; }
  })();
  const vixSrcApiType = type === 'movie' ? 'movie' : 'tv'; // VixSrc usa 'tv' per le serie
  const listUrl = `${VIXCLOUD_SITE_ORIGIN}/api/list/${vixSrcApiType}?lang=it`;

  try {
    console.log(`VIX_CHECK: Checking TMDB ID ${tmdbId} of type ${vixSrcApiType} against VixSrc list: ${listUrl}`);
    const response = await fetch(listUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (StreamViX EarlyDirect)', 'Accept': 'application/json' } });
    if (!response.ok) {
      console.error(`VIX_CHECK: Failed to fetch VixSrc list for type ${vixSrcApiType}, status: ${response.status}`);
      if (skipFlag) {
        console.warn('VIX_CHECK: Skip flag attivo -> continuo nonostante status non OK');
        return true;
      }
      return false;
    }
    const data = await response.json();
    // L'API restituisce un array di oggetti, ognuno con una proprietà 'id' che è l'ID TMDB
    if (data && Array.isArray(data)) {
      const exists = data.some((item: any) => item.tmdb_id && item.tmdb_id.toString() === tmdbId.toString());
      console.log(`VIX_CHECK: TMDB ID ${tmdbId} ${exists ? 'found' : 'NOT found'} in VixSrc list.`);
      return exists;
    } else {
      console.error(`VIX_CHECK: VixSrc list for type ${vixSrcApiType} is not in the expected format.`);
      return skipFlag ? (console.warn('VIX_CHECK: formato inatteso ma skip attivo -> true'), true) : false;
    }
  } catch (error) {
    console.error(`VIX_CHECK: Error checking TMDB ID ${tmdbId} on VixSrc:`, error);
    if (skipFlag) {
      console.warn('VIX_CHECK: errore ma skip attivo -> continuo');
      return true;
    }
    // Retry una volta se non skip
    try {
      await new Promise(r=>setTimeout(r,400));
      console.log('VIX_CHECK: retry fetch list');
      const response2 = await fetch(listUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (StreamViX EarlyDirect Retry)', 'Accept': 'application/json' } });
      if (response2.ok) {
        const d2 = await response2.json();
        if (Array.isArray(d2)) {
          const ex2 = d2.some((item: any) => item.tmdb_id && item.tmdb_id.toString() === tmdbId.toString());
          console.log(`VIX_CHECK: Retry result -> ${ex2}`);
          return ex2;
        }
      }
    } catch {/* ignore secondary */}
    return false; // fallback finale
  }
}

// Verifica se uno specifico episodio (S/E) esiste su VixSrc
async function checkEpisodeOnVixSrc(tmdbId: string, season: number, episode: number): Promise<boolean> {
  const skipFlag = (() => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const env: any = (global as any)?.process?.env || (typeof process !== 'undefined' ? (process as any).env : {});
      const v = String(env.VIXSRC_SKIP_LIST_CHECK || '').toLowerCase();
      return ['1','true','on','yes','y'].includes(v);
    } catch { return false; }
  })();
  const listUrl = `${VIXCLOUD_SITE_ORIGIN}/api/list/episode/?lang=it`;
  try {
    console.log(`VIX_EP_CHECK: Checking TMDB ID ${tmdbId} S${season}E${episode} against VixSrc episode list: ${listUrl}`);
    const response = await fetch(listUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (StreamViX EarlyDirect)', 'Accept': 'application/json' } });
    if (!response.ok) {
      console.error(`VIX_EP_CHECK: Failed to fetch VixSrc episode list, status: ${response.status}`);
      if (skipFlag) { console.warn('VIX_EP_CHECK: Skip attivo -> continuo'); return true; }
      return false;
    }
    const data = await response.json();
    if (data && Array.isArray(data)) {
      const exists = data.some((item: any) =>
        item && item.tmdb_id?.toString() === tmdbId.toString() &&
        Number(item.s) === Number(season) && Number(item.e) === Number(episode)
      );
      console.log(`VIX_EP_CHECK: Episode TMDB ${tmdbId} S${season}E${episode} ${exists ? 'found' : 'NOT found'} in VixSrc episode list.`);
      return exists;
    }
    console.error('VIX_EP_CHECK: Episode list format not as expected');
    return skipFlag ? (console.warn('VIX_EP_CHECK: formato inatteso ma skip -> true'), true) : false;
  } catch (error) {
    console.error(`VIX_EP_CHECK: Error checking episode on VixSrc for TMDB ${tmdbId} S${season}E${episode}:`, error);
    if (skipFlag) { console.warn('VIX_EP_CHECK: errore ma skip -> true'); return true; }
    // retry una volta
    try {
      await new Promise(r=>setTimeout(r,400));
      console.log('VIX_EP_CHECK: retry fetch episode list');
      const r2 = await fetch(listUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (StreamViX EarlyDirect Retry)', 'Accept': 'application/json' } });
      if (r2.ok) {
        const d2 = await r2.json();
        if (Array.isArray(d2)) {
          const ex2 = d2.some((item: any) => item && item.tmdb_id?.toString() === tmdbId.toString() && Number(item.s) === Number(season) && Number(item.e) === Number(episode));
          console.log(`VIX_EP_CHECK: Retry result -> ${ex2}`);
          return ex2;
        }
      }
    } catch {/* ignore */}
    return false;
  }
}

// 2. Modifica la funzione getUrl per rimuovere ?lang=it e aggiungere la verifica
export async function getUrl(id: string, type: ContentType, config: ExtractorConfig): Promise<string | null> {
  // Support direct TMDB id format for movies: tmdb:<tmdbId>
  if (type === 'movie') {
    let tmdbId: string | null = null;
    if (id.startsWith('tmdb:')) {
      // direct TMDB format
      tmdbId = id.split(':')[1] || null;
    } else {
      const imdbIdForMovie = id; // legacy imdb id
      tmdbId = await getTmdbIdFromImdbId(imdbIdForMovie, config.tmdbApiKey);
      if (!tmdbId) return null;
    }
    if (!tmdbId) return null;
    const existsOnVixSrc = await checkTmdbIdOnVixSrc(tmdbId, type);
    if (!existsOnVixSrc) {
      const skip = ['1','true','on','yes','y'].includes(String((global as any)?.process?.env?.VIXSRC_SKIP_LIST_CHECK || '').toLowerCase());
      if (!skip) {
        console.log(`TMDB ID ${tmdbId} for movie not found in VixSrc list. Skipping.`);
        return null;
      } else {
        console.warn(`TMDB ID ${tmdbId} non trovato ma skip attivo -> continuo`);
      }
    }
    return `${VIXCLOUD_SITE_ORIGIN}/movie/${tmdbId}/`;
  }
  // Series: support tmdb:tmdbId:season:episode or legacy imdbId:season:episode
  const rawParts = id.split(':');
  let tmdbSeriesId: string | null = null;
  let seasonStr: string | undefined;
  let episodeStr: string | undefined;
  if (rawParts[0] === 'tmdb') {
    tmdbSeriesId = rawParts[1] || null;
    seasonStr = rawParts[2];
    episodeStr = rawParts[3];
  } else {
    const obj = getObject(id); // interprets legacy imdb format
    tmdbSeriesId = await getTmdbIdFromImdbId(obj.id, config.tmdbApiKey);
    seasonStr = obj.season;
    episodeStr = obj.episode;
  }
  if (!tmdbSeriesId) return null;
  const seasonNum = Number(seasonStr);
  const episodeNum = Number(episodeStr);
  if (isNaN(seasonNum) || isNaN(episodeNum)) {
    console.warn(`Invalid season/episode in id ${id}`);
    return null;
  }
  const existsOnVixSrc = await checkTmdbIdOnVixSrc(tmdbSeriesId, type);
  const skipSeries = ['1','true','on','yes','y'].includes(String((global as any)?.process?.env?.VIXSRC_SKIP_LIST_CHECK || '').toLowerCase());
  if (!existsOnVixSrc && !skipSeries) {
    console.log(`TMDB ID ${tmdbSeriesId} for series not found in VixSrc list. Skipping.`);
    return null;
  } else if (!existsOnVixSrc && skipSeries) {
    console.warn(`TMDB ID ${tmdbSeriesId} series non trovato ma skip attivo -> continuo`);
  }
  const epExists = await checkEpisodeOnVixSrc(tmdbSeriesId, seasonNum, episodeNum);
  if (!epExists && !skipSeries) {
    console.log(`VIX_EP_CHECK: Episode not found on VixSrc for TMDB ${tmdbSeriesId} S${seasonNum}E${episodeNum}. Skipping.`);
    return null;
  } else if (!epExists && skipSeries) {
    console.warn(`VIX_EP_CHECK: episodio non trovato ma skip attivo -> continuo`);
  }
  return `${VIXCLOUD_SITE_ORIGIN}/tv/${tmdbSeriesId}/${seasonNum}/${episodeNum}/`;
}

export async function getStreamContent(id: string, type: ContentType, config: ExtractorConfig): Promise<VixCloudStreamInfo[] | null> {
  // Log config safely without exposing password
  console.log(`Extracting stream for ${id} (${type}) with config:`, { ...config, mfpPsw: config.mfpPsw ? '***' : undefined });
  console.log('[VixSrc][BuildMarker] version=early-direct-v2');
  console.log('[VixSrc][Debug] addonBase initial =', config.addonBase, 'vixDual=', !!config.vixDual, 'vixLocal=', !!config.vixLocal);

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
      if (['1','true','on','yes','y'].includes(dualFlag)) {
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
      tmdbId = await getTmdbIdFromImdbId(imdbOrTmdbId, tmdbApiKey);
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
      tmdbId = await getTmdbIdFromImdbId(imdbOrTmdbComposite.split(':')[0], tmdbApiKey);
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
    if (!mfpUrl || !mfpPsw) {
      console.warn('VixSrc: Proxy MFP non configurato');
      return null;
    }

  const cleanedMfpUrl = mfpUrl.endsWith('/') ? mfpUrl.slice(0, -1) : mfpUrl;
  // Prima richiesta: redirect_stream=false per ottenere JSON completo
  const baseApi = `${cleanedMfpUrl}/extractor/video?host=VixCloud&redirect_stream=false&api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(url)}`;
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
    let finalStreamUrl = await getActualStreamUrl(baseApi.replace('redirect_stream=false','redirect_stream=false'));
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
      name: finalNameForProxy,
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

      let finalStreamUrl = serverUrl.includes("?b=1")
        ? `${serverUrl}&token=${token}&expires=${expires}`
        : `${serverUrl}?token=${token}&expires=${expires}`;

      // Aggiungi &h=1 solo se disponibile
      if (scriptContent.includes("window.canPlayFHD = true")) {
        finalStreamUrl += "&h=1";
      }
      else {
        // fallback: controlla pattern alternativo (spazi, doppio apice, ecc.)
        if (/window\.canPlayFHD\s*=\s*true/.test(scriptContent)) {
          finalStreamUrl += "&h=1";
          console.log('[VixSrc][Direct] FHD flag rilevato via regex fallback, aggiunto &h=1');
        } else {
          console.log('[VixSrc][Direct] FHD non disponibile (nessun canPlayFHD=true nel player script)');
        }
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

      // --- Forza variante 1080p se il link è un master playlist (Opzione A) ---
      try {
        if (finalStreamUrl.includes('/playlist/')) {
          console.log('[VixSrc][Direct][VariantForce] Rilevato possibile master, parsing...');
          const forcedUrl = await forceHighestVariant(finalStreamUrl);
          if (forcedUrl && forcedUrl !== finalStreamUrl) {
            console.log('[VixSrc][Direct][VariantForce] Sostituito master con variante massima:', forcedUrl);
            finalStreamUrl = forcedUrl;
          } else if (forcedUrl === finalStreamUrl) {
            console.log('[VixSrc][Direct][VariantForce] Già variante singola (nessun cambio)');
          } else {
            console.log('[VixSrc][Direct][VariantForce] Parsing fallito, mantengo originale');
          }
        }
      } catch (e) {
        console.warn('[VixSrc][Direct][VariantForce] Fallita la forzatura variante:', (e as any)?.message || e);
      }

      return {
        name: determinedName,
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

  // Nuova strategia: 1) tenta SEMPRE direct parse (stile Kotlin) per ottenere HLS puro
  //                   2) se MFP configurato crea versione proxata partendo dall'HLS diretto
  //                   3) fallback al vecchio percorso proxy se direct fallisce
  let directResult: VixCloudStreamInfo | null = null;
  try {
    console.log('[VixSrc][EarlyDirect] Tentativo parse diretto iniziale');
    directResult = await getDirectStream(targetUrl, id, type, config);
    if (directResult) {
      // Non rinominare mai in FHD: mantenere naming originale
      console.log('[VixSrc][EarlyDirect] OK', { base: directResult.streamUrl.split('?')[0], hasH1: /([?&])h=1/.test(directResult.streamUrl) });
    } else {
      console.log('[VixSrc][EarlyDirect] Nessun direct (null)');
    }
  } catch (e) {
    console.error('[VixSrc][EarlyDirect] Errore direct parse:', (e as any)?.message || e);
  }

  const showDirect = directModeEnabled && !!directResult;
  if (showDirect && directResult) {
    // Direct naming: <Titolo> [ITA] 🔓
    if (!/🔓/.test(directResult.name)) directResult.name = directResult.name.replace(/\s*🔓?$/,'') + ' 🔓';
    streams.push(directResult);
  }

  // NON derivare addonBase dal dominio della playlist (porterebbe a tentare /vixsynthetic su vixsrc.to)
  if (!config.addonBase) {
    console.log('[VixSrc][Debug] addonBase assente: synthetic disabilitato (serve reinstall o ADDON_BASE_URL env)');
  } else if (config.addonBase.includes(domains.vixsrc)) {
    // Caso errato: addonBase punta al dominio sorgente VixSrc => endpoint synthetic non esiste lì
    console.log('[VixSrc][Warn] addonBase punta a dominio VixSrc -> ignoro per synthetic:', config.addonBase);
  }

  // Se abbiamo un direct HLS e MFP è configurato, costruiamo un proxy che punti a QUEL HLS (non alla pagina web)
  if (config.mfpUrl && config.mfpPsw) {
    try {
      // Se abbiamo già direct HLS, proviamo a proxarlo partendo dalla PAGINA (stessa logica) per ottenere header corretti
      console.log('[VixSrc][ProxyStage] Invoco getProxyStream per costruire versione proxy');
      const proxyVariant = await getProxyStream(targetUrl, id, type, config);
      if (proxyVariant) {
        // Forza anche per versione proxy se possibile
        try {
          if (proxyVariant.streamUrl.includes('/playlist/')) {
            // Caso A: URL proxy già punta direttamente ad una playlist master (raro)
            console.log('[VixSrc][Proxy][VariantForce] Rilevato possibile master diretto nel proxy URL');
            const maybeForced = await forceHighestVariant(proxyVariant.streamUrl);
            if (maybeForced && maybeForced !== proxyVariant.streamUrl) {
              console.log('[VixSrc][Proxy][VariantForce] Sostituito master diretto con variante massima');
              proxyVariant.streamUrl = maybeForced;
            }
          } else {
            // Caso B: playlist master è nel parametro d= (destination_url)
            try {
              const urlObj = new URL(proxyVariant.streamUrl);
              const dParam = urlObj.searchParams.get('d');
              if (dParam && dParam.includes('/playlist/') && !/type=video/.test(dParam)) {
                console.log('[VixSrc][Proxy][VariantForce] Master rilevato nel parametro d=, parsing...');
                const forcedInner = await forceHighestVariant(dParam);
                if (forcedInner && forcedInner !== dParam) {
                  urlObj.searchParams.set('d', forcedInner);
                  proxyVariant.streamUrl = urlObj.toString();
                  console.log('[VixSrc][Proxy][VariantForce] Sostituito d= con variante massima');
                } else if (forcedInner === dParam) {
                  console.log('[VixSrc][Proxy][VariantForce] d= è già variante singola');
                } else {
                  console.log('[VixSrc][Proxy][VariantForce] Impossibile forzare d=, mantengo originale');
                }
              }
            } catch (ie) { console.warn('[VixSrc][Proxy][VariantForce] Errore gestione d=', (ie as any)?.message || ie); }
          }
        } catch(e) { console.warn('[VixSrc][Proxy][VariantForce] Fallita forzatura:', (e as any)?.message || e); }
        // Proxy naming: aggiungi lucchetto chiuso (🔒) se non presente
        if (!/🔒/.test(proxyVariant.name)) proxyVariant.name = proxyVariant.name.replace(/\s*🔓?$/,'') + ' 🔒';
        streams.push(proxyVariant);
      }
    } catch (e) {
      console.error('[VixSrc][ProxyStage] Errore getProxyStream:', (e as any)?.message || e);
    }
  }

  if (!streams.length) {
    console.warn('[VixSrc] Nessuno stream ottenuto');
    return null;
  }

  // Ordina per: direct (se mostrato) prima del proxy
  streams.sort((a,b)=> a.source === b.source ? 0 : (a.source === 'direct' ? -1 : 1));
  // Nuova matrice assemblaggio finale secondo combinazioni Local/Dual
  try {
    if (!streams.length) return null;
    const usableAddonBase = (config.addonBase && !config.addonBase.includes(domains.vixsrc)) ? config.addonBase : '';
    const haveMfp = !!(config.mfpUrl && config.mfpPsw && streams.some(s=>s.source==='proxy'));
    const haveDirect = streams.some(s=>s.source==='direct');

    function buildSyntheticBase(masterUrl: string, referer: string): VixCloudStreamInfo | null {
      if (!usableAddonBase) return null;
      if (!/\/playlist\//.test(masterUrl)) return null;
      const syntheticUrl = `${usableAddonBase.replace(/\/$/,'')}/vixsynthetic?src=${encodeURIComponent(masterUrl)}&lang=it&max=1`;
  // Abilita modalità multilingua/sub automatiche (multi=1) per includere tutte le tracce disponibili
  const syntheticFullUrl = syntheticUrl + '&multi=1';
      // Naming rules:
      // 1. Se c'è un direct stream e il master coincide -> usa il suo nome base + ' 🔓FHD'
      // 2. Altrimenti, se non c'è direct ma c'è proxy, riusa il nome del proxy (senza eventuali icone) + ' 🔓FHD'
      // 3. Fallback finale: 'Synthetic 🔓FHD'
      const directRef = streams.find(s=>s.source==='direct');
      if (haveDirect && directRef && masterUrl === directRef.streamUrl) {
        return {
          name: directRef.name.replace(/\s*🔓FHD?$/,'').replace(/\s*🔓$/,'') + ' 🔓FHD',
          streamUrl: syntheticFullUrl,
          referer,
          source: 'direct'
        };
      }
      const proxyRef = streams.find(s=>s.source==='proxy');
      if (!haveDirect && proxyRef) {
        const baseName = proxyRef.name
          .replace(/\s*🔒\s*FHD$/,'')
          .replace(/\s*🔒FHD$/,'')
          .replace(/\s*🔒$/,'')
          .replace(/\s*🔓FHD?$/,'')
          .replace(/\s*🔓$/,'')
          .trim();
        return {
          name: baseName + ' 🔓FHD',
          streamUrl: syntheticFullUrl,
          referer,
          source: 'direct'
        };
      }
      return {
        name: 'Synthetic 🔓FHD',
        streamUrl: syntheticFullUrl,
        referer,
        source: 'direct'
      };
    }

    function buildSyntheticProxyWrapper(innerSynthetic: string, referer: string): VixCloudStreamInfo | null {
      if (!haveMfp || !config.mfpUrl || !config.mfpPsw) return null;
      const cleaned = config.mfpUrl.endsWith('/') ? config.mfpUrl.slice(0,-1) : config.mfpUrl;
      const wrapper = `${cleaned}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(innerSynthetic)}&api_password=${encodeURIComponent(config.mfpPsw)}`;
      return {
        name: (()=>{
          const proxyOrig = streams.find(s=>s.source==='proxy');
          if (proxyOrig) return proxyOrig.name.replace(/\s*FHD$/,'').replace(/\s*🔒FHD$/,'').replace(/\s*🔒$/,'') + ' 🔒 FHD';
          return 'Proxy FHD 🔒';
        })(),
        streamUrl: wrapper,
        referer,
        source: 'proxy'
      };
    }

    const directStream = streams.find(s=>s.source==='direct') || null;
    const proxyStream = streams.find(s=>s.source==='proxy') || null;

    // Scenario logic
    console.log('[VixSrc][Scenario] local=', !!config.vixLocal, 'dual=', !!config.vixDual, 'haveDirect=', !!directStream, 'haveProxy=', !!proxyStream, 'usableAddonBase=', !!usableAddonBase, 'haveMfp=', haveMfp);
    if (config.vixLocal && !config.vixDual) {
      // Scenario 1: Local ON, Dual OFF -> Direct + Proxy (già in streams) (nessun synthetic)
      if (!config.vixDual) {
        if (!usableAddonBase) {
          console.log('[VixSrc][Scenario1] Synthetic assente: addonBase non disponibile (serve reinstall o env)');
        } else {
          console.log('[VixSrc][Scenario1] Synthetic disabilitato perché vixDual=false');
        }
      }
      return [
        ...(directStream ? [directStream] : []),
        ...(proxyStream ? [proxyStream] : [])
      ];
    }
    if (config.vixLocal && config.vixDual) {
      // Scenario 2: Local ON, Dual ON -> Direct, Proxy, Synthetic Direct, Synthetic Proxy Wrapper
      console.log('[VixSrc][Scenario2] Attivo: tenterò creazione synthetic + wrapper');
      const result: VixCloudStreamInfo[] = [];
      if (directStream) result.push(directStream);
      if (proxyStream) result.push(proxyStream);
      // Sorgente per synthetic direct: preferisci direct master, se no master dal proxy (d=)
      let masterForSynthetic: string | null = null;
      if (directStream && /\/playlist\//.test(directStream.streamUrl)) masterForSynthetic = directStream.streamUrl;
      if (!masterForSynthetic && proxyStream) {
        try {
          const urlObj = new URL(proxyStream.streamUrl);
          const dParam = urlObj.searchParams.get('d');
          if (dParam && /\/playlist\//.test(dParam)) masterForSynthetic = dParam;
        } catch {/* ignore */}
      }
      if (masterForSynthetic) {
        const synDirect = buildSyntheticBase(masterForSynthetic, directStream ? directStream.referer : (proxyStream? proxyStream.referer : ''));
        if (synDirect) result.push(synDirect);
        if (synDirect) {
          const synProxy = buildSyntheticProxyWrapper(synDirect.streamUrl, proxyStream ? proxyStream.referer : synDirect.referer);
          if (synProxy) result.push(synProxy);
        }
      } else {
        console.log('[VixSrc][Synthetic] Nessun master disponibile per creare synthetic (Scenario 2)');
      }
      return result;
    }
    if (!config.vixLocal && config.vixDual) {
      // Scenario 3: Local OFF, Dual ON -> solo synthetic direct + synthetic proxy wrapper
      console.log('[VixSrc][Scenario3] Attivo: solo synthetic + wrapper');
      const result: VixCloudStreamInfo[] = [];
      let masterForSynthetic: string | null = null;
      // Prova direct (anche se non mostrato), se non c'è usa proxy d=
      if (directStream && /\/playlist\//.test(directStream.streamUrl)) masterForSynthetic = directStream.streamUrl;
      if (!masterForSynthetic && proxyStream) {
        try {
          const u = new URL(proxyStream.streamUrl);
          const dParam = u.searchParams.get('d');
          if (dParam && /\/playlist\//.test(dParam)) masterForSynthetic = dParam;
        } catch {/* ignore */}
      }
      if (masterForSynthetic) {
        const synDirect = buildSyntheticBase(masterForSynthetic, directStream ? directStream.referer : (proxyStream? proxyStream.referer : ''));
        if (synDirect) result.push(synDirect);
        if (synDirect) {
          const synProxy = buildSyntheticProxyWrapper(synDirect.streamUrl, proxyStream ? proxyStream.referer : synDirect.referer);
          if (synProxy) result.push(synProxy);
        }
      } else {
        console.log('[VixSrc][Synthetic] Nessun master disponibile per creare synthetic (Scenario 3)');
      }
      return result;
    }
    // Scenario 4: Local OFF, Dual OFF -> solo proxy classico
    if (!config.vixLocal && !config.vixDual) {
      if (!config.vixDual) {
        if (!usableAddonBase) {
          console.log('[VixSrc][Scenario4] Synthetic assente: addonBase non disponibile');
        } else {
          console.log('[VixSrc][Scenario4] Synthetic disabilitato perché vixDual=false');
        }
      }
      return proxyStream ? [proxyStream] : null;
    }
    return streams; // fallback generico (non dovrebbe arrivarci)
  } catch (e) {
    console.warn('[VixSrc][Synthetic] Errore gestione streams (matrice):', (e as any)?.message || e);
    return streams.slice(0,1);
  }
}

// Helper: forza variante 1080p (o la massima disponibile) da un master playlist HLS (passato come URL)
async function forceHighestVariant(masterUrl: string): Promise<string | null> {
  try {
    const res = await fetch(masterUrl, { headers: { 'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, */*' }});
    if (!res.ok) {
      console.warn('[VariantForce] Impossibile scaricare master playlist:', res.status);
      return null;
    }
    const text = await res.text();
    // Se il master contiene gruppi AUDIO o SUBTITLES separati, evitare di forzare
    // per non perdere tracce audio / sottotitoli (alcuni player non caricano audio
    // se forniamo direttamente la variante video senza i gruppi dichiarati nel master)
    const hasMediaGroups = /#EXT-X-MEDIA:.*TYPE=(AUDIO|SUBTITLES)/i.test(text);
    if (hasMediaGroups) {
      console.log('[VariantForce] Rilevati gruppi AUDIO/SUBTITLES: restituisco master (sarà eventualmente sintetizzato dopo)');
      return masterUrl; // Non forziamo qui; synthetic endpoint gestirà estrazione mantenendo audio ITA
    }
    if (!/#EXT-X-STREAM-INF:/i.test(text)) {
      // Non è un master (già una variante)
      return masterUrl;
    }
    const lines = text.split(/\r?\n/);
    interface Variant { url: string; height: number; bandwidth: number; raw: string; }
    const variants: Variant[] = [];
    for (let i=0; i<lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const info = l;
        const next = lines[i+1] || '';
        if (!next || next.startsWith('#')) continue; // URL expected next line
        const resMatch = info.match(/RESOLUTION=(\d+)x(\d+)/i);
        const bwMatch = info.match(/BANDWIDTH=(\d+)/i);
        const height = resMatch ? parseInt(resMatch[2], 10) : 0;
        const bandwidth = bwMatch ? parseInt(bwMatch[1], 10) : 0;
        variants.push({ url: resolvePlaylistUrl(masterUrl, next.trim()), height, bandwidth, raw: info });
      }
    }
    if (!variants.length) return null;
    // Ordina per altezza poi banda
    variants.sort((a,b)=> (b.height - a.height) || (b.bandwidth - a.bandwidth));
    const best = variants[0];
    return best.url || null;
  } catch (e) {
    console.warn('[VariantForce] Errore parsing master:', (e as any)?.message || e);
    return null;
  }
}

// Risolve URL relativi rispetto al master
function resolvePlaylistUrl(masterUrl: string, maybeRelative: string): string {
  try {
    return new URL(maybeRelative, masterUrl).toString();
  } catch {
    return maybeRelative;
  }
}
