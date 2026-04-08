import { KitsuProvider } from './kitsu';
import { getDomain } from '../utils/domains';
import { formatMediaFlowUrl } from '../utils/mediaflow';
import { AnimeUnityConfig, StreamForStremio } from '../types/animeunity';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { checkIsAnimeById, applyUniversalAnimeTitleNormalization } from '../utils/animeGate';
import { extractFromUrl } from '../extractors';
import {
  createCaches,
  fetchResource,
  getProviderUrl,
  mapLimit,
  normalizeEpisodesList,
  normalizeRequestedEpisode,
  parseEpisodeNumber,
  parsePositiveInt,
  pickEpisodeEntry,
  resolveLookupRequest,
  fetchMappingPayload,
  extractProviderPaths,
  extractTmdbIdFromMappingPayload,
  resolveEpisodeFromMappingPayload,
  toAbsoluteUrl,
  inferSourceTag,
  collectMediaLinksFromEmbedHtml,
  sanitizeAnimeTitle,
} from './anime-core';

const USER_AGENT =
  process.env.AU_USER_AGENT ||
  process.env.AS_USER_AGENT ||
  process.env.AW_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

const FETCH_TIMEOUT = Number.parseInt(process.env.ANIMEUNITY_FETCH_TIMEOUT_MS || '10000', 10) || 10000;
const TTL = {
  http: 5 * 60 * 1000,
  animePage: 15 * 60 * 1000,
  streamPage: 5 * 60 * 1000,
  mapping: 2 * 60 * 1000,
};

const caches = createCaches();

const PROXY_URL = process.env.AU_PROXY || process.env.PROXY || '';
const DIRECT_TIMEOUT = 3000; // timeout breve per tentativo diretto (senza proxy)
let proxyAgent: any = undefined;
if (PROXY_URL) {
  if (PROXY_URL.startsWith('socks')) {
    proxyAgent = new SocksProxyAgent(PROXY_URL);
  } else {
    proxyAgent = new HttpsProxyAgent(PROXY_URL);
  }
}

// --- Proxy diagnostic helpers ---
function maskProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch { return url.replace(/:([^@:]+)@/, ':***@'); }
}

const PROXY_TYPE = PROXY_URL ? (PROXY_URL.startsWith('socks') ? 'SOCKS' : 'HTTP/HTTPS') : 'NONE';
if (PROXY_URL) {
  console.log(`[AnimeUnity][Proxy] Proxy configurato: tipo=${PROXY_TYPE} url=${maskProxyUrl(PROXY_URL)}`);
} else {
  console.log('[AnimeUnity][Proxy] Nessun proxy configurato (AU_PROXY e PROXY non impostati)');
}

function isRetryableError(err: any): boolean {
  const code = err?.code || '';
  const status = err?.response?.status || 0;
  const msg = String(err?.message || '');
  return status === 403 || status === 503 || status >= 500
    || /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|ENOTFOUND|abort|timeout|socket hang up/i.test(code + msg);
}

/**
 * axios GET con retry proxy: tenta prima DIRETTO (3s timeout), poi con proxy se fallisce.
 */
async function auAxiosGet(url: string, config: any = {}): Promise<any> {
  // Tentativo diretto
  console.log(`[AnimeUnity][Proxy] GET diretto (${DIRECT_TIMEOUT}ms) -> ${url}`);
  try {
    const resp = await axios.get(url, { ...config, timeout: DIRECT_TIMEOUT, httpAgent: undefined, httpsAgent: undefined });
    console.log(`[AnimeUnity][Proxy] GET diretto OK (${resp.status}) <- ${url}`);
    return resp;
  } catch (directErr: any) {
    const directMsg = directErr?.message || String(directErr);
    console.warn(`[AnimeUnity][Proxy] GET diretto FALLITO: ${directMsg} <- ${url}`);
    if (!proxyAgent) {
      console.warn('[AnimeUnity][Proxy] Nessun proxy configurato, errore definitivo');
      throw directErr;
    }
    if (!isRetryableError(directErr)) {
      console.warn('[AnimeUnity][Proxy] Errore non retryable, non riprovo con proxy');
      throw directErr;
    }
  }
  // Retry con proxy
  console.log(`[AnimeUnity][Proxy] Retry GET con proxy (${PROXY_TYPE}) -> ${url}`);
  try {
    const resp = await axios.get(url, { ...config, timeout: config.timeout || FETCH_TIMEOUT, httpAgent: proxyAgent, httpsAgent: proxyAgent });
    console.log(`[AnimeUnity][Proxy] GET con proxy OK (${resp.status}) <- ${url}`);
    return resp;
  } catch (proxyErr: any) {
    console.error(`[AnimeUnity][Proxy] GET FALLITO anche con proxy: ${proxyErr?.message || proxyErr} <- ${url}`);
    throw proxyErr;
  }
}

/**
 * axios POST con retry proxy: tenta prima DIRETTO (3s timeout), poi con proxy se fallisce.
 */
async function auAxiosPost(url: string, data: any, config: any = {}): Promise<any> {
  console.log(`[AnimeUnity][Proxy] POST diretto (${DIRECT_TIMEOUT}ms) -> ${url}`);
  try {
    const resp = await axios.post(url, data, { ...config, timeout: DIRECT_TIMEOUT, httpAgent: undefined, httpsAgent: undefined });
    console.log(`[AnimeUnity][Proxy] POST diretto OK (${resp.status}) <- ${url}`);
    return resp;
  } catch (directErr: any) {
    const directMsg = directErr?.message || String(directErr);
    console.warn(`[AnimeUnity][Proxy] POST diretto FALLITO: ${directMsg} <- ${url}`);
    if (!proxyAgent) {
      console.warn('[AnimeUnity][Proxy] Nessun proxy configurato, errore definitivo');
      throw directErr;
    }
    if (!isRetryableError(directErr)) {
      console.warn('[AnimeUnity][Proxy] Errore non retryable, non riprovo con proxy');
      throw directErr;
    }
  }
  console.log(`[AnimeUnity][Proxy] Retry POST con proxy (${PROXY_TYPE}) -> ${url}`);
  try {
    const resp = await axios.post(url, data, { ...config, timeout: config.timeout || FETCH_TIMEOUT, httpAgent: proxyAgent, httpsAgent: proxyAgent });
    console.log(`[AnimeUnity][Proxy] POST con proxy OK (${resp.status}) <- ${url}`);
    return resp;
  } catch (proxyErr: any) {
    console.error(`[AnimeUnity][Proxy] POST FALLITO anche con proxy: ${proxyErr?.message || proxyErr} <- ${url}`);
    throw proxyErr;
  }
}

/**
 * fetchResource wrapper con retry proxy: tenta prima DIRETTO (3s, agent: null),
 * poi con proxy agent se fallisce.
 */
async function auFetchResource(url: string, providerCaches: any, options: any = {}): Promise<any> {
  console.log(`[AnimeUnity][Proxy] fetchResource diretto (${DIRECT_TIMEOUT}ms) -> ${url}`);
  try {
    const result = await fetchResource(url, providerCaches, {
      ...options,
      agent: null,  // forza nessun proxy (override auto-detect in fetch-resource.ts)
      timeoutMs: DIRECT_TIMEOUT,
    });
    console.log(`[AnimeUnity][Proxy] fetchResource diretto OK <- ${url}`);
    return result;
  } catch (directErr: any) {
    const directMsg = directErr?.message || String(directErr);
    console.warn(`[AnimeUnity][Proxy] fetchResource diretto FALLITO: ${directMsg} <- ${url}`);
    if (!proxyAgent) {
      console.warn('[AnimeUnity][Proxy] Nessun proxy per fetchResource, errore definitivo');
      throw directErr;
    }
  }
  console.log(`[AnimeUnity][Proxy] Retry fetchResource con proxy (${PROXY_TYPE}) -> ${url}`);
  try {
    const result = await fetchResource(url, providerCaches, {
      ...options,
      agent: proxyAgent,
      timeoutMs: options.timeoutMs || FETCH_TIMEOUT,
    });
    console.log(`[AnimeUnity][Proxy] fetchResource con proxy OK <- ${url}`);
    return result;
  } catch (proxyErr: any) {
    console.error(`[AnimeUnity][Proxy] fetchResource FALLITO anche con proxy: ${proxyErr?.message || proxyErr} <- ${url}`);
    throw proxyErr;
  }
}

interface AnimeUnitySession {
  csrfToken: string;
  cookieHeader: string;
  expiresAt: number;
}

let sessionCache: AnimeUnitySession | null = null;

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
  number: string | number;
  name?: string;
}

interface AnimeUnityStreamData {
  episode_page: string | null;
  embed_url: string | null;
  mp4_url: string | null;
}

function getUnityBaseUrl(): string {
  const configured = getProviderUrl('animeunity', ['ANIMEUNITY_BASE_URL', 'AU_BASE_URL']);
  if (configured) return configured.replace(/\/+$/, '');
  const host = getDomain('animeunity') || 'animeunity.so';
  return `https://www.${host}`.replace(/\/+$/, '');
}

function normalizeAnimePath(pathOrUrl: string | null | undefined): string | null {
  if (!pathOrUrl) return null;
  let value = String(pathOrUrl).trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      return null;
    }
  }

  if (!value.startsWith('/')) value = `/${value}`;
  value = value.replace(/\/+$/, '');

  const match = value.match(/^\/(?:anime\/\d+(?:-[^/?#]+)?|play\/[^/?#]+)/i);
  return match ? match[0] : null;
}

function buildUnityUrl(pathOrUrl: string | null | undefined): string | null {
  const text = String(pathOrUrl || '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('/')) return `${getUnityBaseUrl()}${text}`;
  return `${getUnityBaseUrl()}/${text}`;
}

function parseVideoPlayerJson(rawValue: string | undefined | null, fallback: any) {
  const text = String(rawValue || '').trim();
  if (!text) return fallback;
  const attempts = [
    text,
    text
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>'),
  ];
  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {
      // continue
    }
  }
  return fallback;
}

function extractAnimeIdSlugFromPath(animePath: string): { animeId: number | null; animeSlug: string | null } {
  const match = String(animePath || '').match(/^\/anime\/(\d+)(?:-([^/?#]+))?/i);
  return {
    animeId: parsePositiveInt(match?.[1]),
    animeSlug: match?.[2] ? String(match[2]).trim() : null,
  };
}

async function getSessionData(): Promise<AnimeUnitySession | null> {
  if (sessionCache && sessionCache.expiresAt > Date.now()) return sessionCache;
  try {
    const response = await auAxiosGet(`${getUnityBaseUrl()}/`, {
      timeout: FETCH_TIMEOUT,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    const html = String(response.data || '');
    const $ = cheerio.load(html);
    const csrfToken = $('meta[name="csrf-token"]').attr('content') || '';
    const setCookies: string[] = Array.isArray(response.headers['set-cookie']) ? response.headers['set-cookie'] : [];
    const cookieHeader = setCookies.map((cookie) => String(cookie).split(';')[0]).filter(Boolean).join('; ');
    if (!csrfToken) return null;

    sessionCache = {
      csrfToken,
      cookieHeader,
      expiresAt: Date.now() + TTL.http,
    };
    return sessionCache;
  } catch (error: any) {
    console.warn('[AnimeUnity] session bootstrap failed:', error?.message || error);
    return null;
  }
}

async function searchEndpoint(query: string, dubbed = false): Promise<AnimeUnitySearchResult[]> {
  const session = await getSessionData();
  if (!session) return [];

  const headers = {
    'User-Agent': USER_AGENT,
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json;charset=utf-8',
    'X-CSRF-Token': session.csrfToken,
    Referer: getUnityBaseUrl(),
    Cookie: session.cookieHeader,
  };

  const seen = new Set<number>();
  const out: AnimeUnitySearchResult[] = [];

  const requests = [
    auAxiosPost(
      `${getUnityBaseUrl()}/livesearch`,
      { title: query },
      { timeout: FETCH_TIMEOUT, headers }
    ).catch(() => null),
    auAxiosPost(
      `${getUnityBaseUrl()}/archivio/get-animes`,
      {
        title: query,
        type: false,
        year: false,
        order: 'Lista A-Z',
        status: false,
        genres: false,
        season: false,
        offset: 0,
        dubbed,
      },
      { timeout: FETCH_TIMEOUT, headers }
    ).catch(() => null),
  ];

  const responses = await Promise.all(requests);
  for (const response of responses) {
    const records = response?.data?.records;
    if (!Array.isArray(records)) continue;
    for (const record of records) {
      const id = Number(record?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const nameIt = String(record?.title_it || '').trim();
      const nameEng = String(record?.title_eng || '').trim();
      const fallbackName = String(record?.title || '').trim();
      const display = nameIt || nameEng || fallbackName;
      if (!display) continue;
      out.push({
        id,
        slug: String(record?.slug || '').trim(),
        name: display,
        name_it: nameIt,
        name_eng: nameEng,
        episodes_count: Number(record?.episodes_count || 0),
      });
    }
  }

  return out;
}

async function fetchEpisodesRangeFromApi(animeId: number, requestedEpisode: number, animeUrl: string): Promise<AnimeUnityEpisode[]> {
  const startRange = Math.floor((requestedEpisode - 1) / 120) * 120 + 1;
  const endRange = startRange + 119;

  try {
    const payload = await auFetchResource(
      `${getUnityBaseUrl()}/info_api/${animeId}/1?start_range=${startRange}&end_range=${endRange}`,
      caches,
      {
        as: 'json',
        ttlMs: TTL.animePage,
        cacheKey: `au-info:${animeId}:${startRange}:${endRange}`,
        timeoutMs: FETCH_TIMEOUT,
        headers: {
          'x-requested-with': 'XMLHttpRequest',
          referer: animeUrl,
        },
      }
    );
    const rows = Array.isArray(payload?.episodes) ? payload.episodes : [];
    return rows.map((entry: any, index: number) => ({
      id: Number(entry?.id || 0),
      number: parseEpisodeNumber(entry?.number || entry?.link, index + 1),
      name: String(entry?.name || '').trim() || undefined,
    })).filter((entry: AnimeUnityEpisode) => !!entry.id);
  } catch (error: any) {
    console.warn('[AnimeUnity] info_api request failed:', error?.message || error);
    return [];
  }
}

async function getStreamData(animeId: number, animeSlug: string, episodeId: number): Promise<AnimeUnityStreamData> {
  const episodePage = `${getUnityBaseUrl()}/anime/${animeId}-${animeSlug}/${episodeId}`;

  try {
    const html = await auFetchResource(episodePage, caches, {
      ttlMs: TTL.streamPage,
      cacheKey: `au-ep:${animeId}:${episodeId}`,
      timeoutMs: FETCH_TIMEOUT,
    });

    const $ = cheerio.load(String(html || ''));
    const vp = $('video-player').first();
    let embedUrl = toAbsoluteUrl(vp.attr('embed_url') || null, getUnityBaseUrl());

    if (!embedUrl) {
      const iframeSrc = $('iframe[src*="vixcloud"]').first().attr('src');
      embedUrl = toAbsoluteUrl(iframeSrc || null, getUnityBaseUrl());
    }

    let mp4Url: string | null = null;
    if (embedUrl) {
      try {
        const embedHtml = await auFetchResource(embedUrl, caches, {
          ttlMs: TTL.streamPage,
          cacheKey: `au-embed:${embedUrl}`,
          timeoutMs: FETCH_TIMEOUT,
          headers: {
            referer: episodePage,
            'user-agent': USER_AGENT,
          },
        });
        const mediaLinks = collectMediaLinksFromEmbedHtml(String(embedHtml || ''), getUnityBaseUrl());
        const preferred = mediaLinks.find((entry) => /\.mp4(?:[?#].*)?$/i.test(entry.href)) || mediaLinks[0];
        mp4Url = preferred?.href || null;
      } catch {
        mp4Url = null;
      }
    }

    return {
      episode_page: episodePage,
      embed_url: embedUrl,
      mp4_url: mp4Url,
    };
  } catch (error: any) {
    console.warn('[AnimeUnity] getStreamData failed:', error?.message || error);
    return {
      episode_page: episodePage,
      embed_url: null,
      mp4_url: null,
    };
  }
}

// Funzione universale per ottenere il titolo inglese da qualsiasi ID
// Aggiunto fallback Kitsu diretto (titles.en) se manca MAL mapping, come in AnimeSaturn
async function getEnglishTitleFromAnyId(id: string, type: 'imdb' | 'tmdb' | 'kitsu' | 'mal', tmdbApiKey?: string): Promise<string> {
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
    } catch { }
  } else if (type === 'tmdb') {
    tmdbId = id;
    try {
      const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json();
      malId = haglundResp[0]?.myanimelist?.toString() || null;
    } catch { }
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
  console.log(`[UniversalTitle][Filter][Legacy] Risultati prima del filtro:`, results.map(r => `${r.version.name} [it:"${r.version.name_it || 'N/A'}" eng:"${r.version.name_eng || 'N/A'}"]`));
  console.log(`[UniversalTitle][Filter][Legacy] Risultati dopo il filtro:`, filtered.map(r => r.version.name));
  return filtered;
}

// ==== AUTO-NORMALIZATION-EXACT-MAP-START ====
const exactMap: Record<string, string> = {

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
const genericMap: Record<string, string> = {


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
  return normalized.trim();
}

export class AnimeUnityProvider {
  private kitsuProvider = new KitsuProvider();

  constructor(private config: AnimeUnityConfig) { }

  private get baseHost(): string { return getDomain('animeunity') || 'animeunity.so'; }

  private async extractStreamsFromAnimePath(
    animePath: string,
    requestedEpisodeInput: number | null,
    seasonNumber: number | null,
    isMovie: boolean,
    titleOverride?: string,
    languageOverride?: string
  ): Promise<StreamForStremio[]> {
    const normalizedPath = normalizeAnimePath(animePath);
    if (!normalizedPath) return [];

    const animeUrl = buildUnityUrl(normalizedPath);
    if (!animeUrl) return [];

    const html = await auFetchResource(animeUrl, caches, {
      ttlMs: TTL.animePage,
      cacheKey: `au-anime:${normalizedPath}`,
      timeoutMs: FETCH_TIMEOUT,
    }).catch(() => '');

    if (!html) return [];

    const $ = cheerio.load(String(html));
    const vp = $('video-player').first();
    const animeData = parseVideoPlayerJson(vp.attr('anime'), {});
    const episodesData = parseVideoPlayerJson(vp.attr('episodes'), []);
    const pageTitle =
      $('meta[property="og:title"]').attr('content') ||
      $('title').first().text().trim() ||
      null;

    const displayTitle = titleOverride || sanitizeAnimeTitle(
      animeData?.title_it || animeData?.title_eng || animeData?.title || pageTitle
    ) || 'Unknown Title';

    const sourceTag = inferSourceTag(displayTitle, normalizedPath);
    const langLabel = languageOverride || (sourceTag === 'ITA' ? 'ITA' : 'SUB');
    const requestedEpisode = normalizeRequestedEpisode(requestedEpisodeInput);

    const parsedPath = extractAnimeIdSlugFromPath(normalizedPath);
    const animeId = parsedPath.animeId || parsePositiveInt(animeData?.id);
    const animeSlug = parsedPath.animeSlug || String(animeData?.slug || '').trim();
    if (!animeId || !animeSlug) return [];

    let normalizedEpisodes = normalizeEpisodesList(
      (Array.isArray(episodesData) ? episodesData : []).map((entry: any, index: number) => ({
        num: parseEpisodeNumber(entry?.number || entry?.link, index + 1),
        episodeId: entry?.id,
        scwsId: entry?.scws_id,
        fileName: entry?.file_name || entry?.link,
        link: entry?.link || entry?.file_name,
        embedUrl: entry?.embed_url || null,
      })),
      getUnityBaseUrl()
    );

    if (!normalizedEpisodes.length) {
      const fetched = await fetchEpisodesRangeFromApi(animeId, requestedEpisode, animeUrl);
      normalizedEpisodes = normalizeEpisodesList(
        fetched.map((entry, index) => ({
          num: parseEpisodeNumber(entry.number, index + 1),
          episodeId: entry.id,
          link: null,
          fileName: null,
          embedUrl: null,
        })),
        getUnityBaseUrl()
      );
    }

    const selected = pickEpisodeEntry(normalizedEpisodes, requestedEpisode, isMovie ? 'movie' : 'tv');
    if (!selected?.episodeId) return [];

    const streamResult = await getStreamData(animeId, animeSlug, selected.episodeId);
    const streams: StreamForStremio[] = [];
    const seenLinks = new Set<string>();

    const sNum = seasonNumber || 1;
    let baseTitle = `${capitalize(displayTitle)} ▪ ${langLabel} ▪ S${sNum}`;
    const resolvedEpisodeNum = parsePositiveInt(selected.num) || requestedEpisode;
    if (resolvedEpisodeNum) baseTitle += `E${resolvedEpisodeNum}`;

    const preferMp4 = /^(1|true|on)$/i.test(String(process.env.ANIMEUNITY_PREFER_MP4 || '0'));
    let added = false;
    let hls403 = false;

    if (!preferMp4 && streamResult.embed_url) {
      try {
        const hlsRes = await extractFromUrl(streamResult.embed_url, {
          referer: streamResult.episode_page || animeUrl,
          mfpUrl: this.config.mfpUrl,
          mfpPassword: this.config.mfpPassword,
          titleHint: baseTitle,
        });
        if (hlsRes.streams && hlsRes.streams.length) {
          for (const st of hlsRes.streams) {
            if (!st || !st.url) continue;
            if (seenLinks.has(st.url)) continue;
            streams.push(st as StreamForStremio);
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
                  for (let i = 0; i < lines.length; i += 1) {
                    const line = lines[i];
                    if (/^#EXT-X-STREAM-INF:/i.test(line)) {
                      const nextUrl = lines[i + 1] || '';
                      if (nextUrl.startsWith('#') || !nextUrl.trim()) continue;
                      let height = 0;
                      const resMatch = line.match(/RESOLUTION=\d+x(\d+)/i);
                      if (resMatch) height = parseInt(resMatch[1], 10);
                      const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
                      const bw = bwMatch ? parseInt(bwMatch[1], 10) : undefined;
                      variants.push({ line, url: nextUrl.trim(), height, bandwidth: bw });
                    }
                  }
                  if (variants.length) {
                    variants.sort((a, b) => (b.height - a.height) || ((b.bandwidth || 0) - (a.bandwidth || 0)));
                    const best = variants[0];
                    let variantUrl = best.url;
                    if (!/^https?:\/\//i.test(variantUrl)) {
                      try {
                        variantUrl = new URL(variantUrl, masterUrl).toString();
                      } catch {
                        // keep as is
                      }
                    }
                    variantUrl = variantUrl.replace(/(\/playlist\/(\d+))(?!\.m3u8)(?=[^\w]|$)/, '$1.m3u8');
                    if (!seenLinks.has(variantUrl)) {
                      const markAsFhd = best.height >= 720;
                      const behaviorHints: any = {
                        ...((st as any).behaviorHints || {}),
                        animeunityQuality: markAsFhd ? 'FHD' : 'HQ',
                        animeunityResolution: best.height,
                        animeunityNameSuffix: markAsFhd ? ' 🅵🅷🅳' : '',
                      };
                      if ((st as any)?.behaviorHints?.requestHeaders) {
                        behaviorHints.requestHeaders = (st as any).behaviorHints.requestHeaders;
                      }
                      streams.push({
                        title: (st as any).title,
                        url: variantUrl,
                        behaviorHints,
                        isSyntheticFhd: markAsFhd,
                      });
                      seenLinks.add(variantUrl);
                    }
                  }
                }
              }
            } catch (fhde: any) {
              console.warn('[AnimeUnity][FHDVariant] errore generazione variante FHD:', fhde?.message || fhde);
            }
          }
        }
      } catch (error: any) {
        const msg = error?.message || String(error);
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
              behaviorHints: { notWebReady: true },
            });
            seenLinks.add(mediaFlowUrl);
          }
        } catch (e: any) {
          console.warn('[AnimeUnity] Errore fallback MP4:', e?.message || e);
        }
      }
    }

    // --- Nuova logica 3 modalità (come StreamingCommunity) ---
    // animeunityDirect    = Direct (solo locale, IP-bound)
    // animeunityDirectFhd = Synthetic FHD (solo locale, IP-bound)
    // animeunityProxy     = Proxy (cross-IP, tutto via EasyProxy)
    // Default (nessuna selezione) = Proxy se MFP presente, altrimenti Direct
    const wantsDirect = this.config.animeunityDirect === true;
    const wantsDirectFhd = this.config.animeunityDirectFhd === true;
    const wantsProxy = this.config.animeunityProxy === true;
    const noneSelected = !wantsDirect && !wantsDirectFhd && !wantsProxy;
    const directWanted = noneSelected ? !this.config.mfpUrl : wantsDirect;
    const directFhdWanted = noneSelected ? false : wantsDirectFhd;
    const proxyWanted = noneSelected ? !!this.config.mfpUrl : wantsProxy;

    // Genera versione Proxy cross-IP via EasyProxy generic HLS proxy.
    const mfpWrapped: StreamForStremio[] = [];
    if (proxyWanted && this.config.mfpUrl && streamResult.embed_url) {
      const cleanMfp = this.config.mfpUrl.endsWith('/') ? this.config.mfpUrl.slice(0, -1) : this.config.mfpUrl;
      const pwdParam = this.config.mfpPassword ? `&api_password=${encodeURIComponent(this.config.mfpPassword)}` : '';

      try {
        const embedReferer = streamResult.episode_page || animeUrl || 'https://animeunity.so/';
        const proxyPlaylistUrl = `${cleanMfp}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(streamResult.embed_url)}${pwdParam}`
          + `&h_Origin=${encodeURIComponent('https://vixcloud.co')}`
          + `&h_Referer=${encodeURIComponent(embedReferer)}`;
        console.log('[AnimeUnity][MFP] Built generic proxy URL:', proxyPlaylistUrl);

        mfpWrapped.push({
          title: baseTitle + ' 🔒',
          url: proxyPlaylistUrl,
          behaviorHints: { notWebReady: true, animeunityMfpWrapped: true },
        });
      } catch (e: any) {
        console.warn('[AnimeUnity][MFP] Errore costruzione proxy URL:', e?.message || e);
      }
    }

    // Stream diretti: solo se Direct o Synthetic FHD richiesti
    const directOut: StreamForStremio[] = [];
    if (directWanted || directFhdWanted) {
      directOut.push(...streams);
    }

    return [...directOut, ...mfpWrapped];
  }

  private async getStreamsFromMapping(
    id: string,
    seasonNumber: number | null,
    episodeNumber: number | null,
    isMovie: boolean,
    providerContext: { kitsuId?: string; tmdbId?: string; imdbId?: string } | null,
    titleFallback: string
  ): Promise<StreamForStremio[]> {
    const lookup = resolveLookupRequest(id, seasonNumber, episodeNumber, providerContext);
    if (!lookup) return [];

    let mappingPayload = await fetchMappingPayload(lookup, caches, 'AnimeUnity');
    let animePaths = extractProviderPaths(mappingPayload, 'animeunity', normalizeAnimePath);

    if (animePaths.length === 0 && String(lookup.provider || '').toLowerCase() === 'imdb') {
      const tmdbFromContext = providerContext?.tmdbId && /^\d+$/.test(String(providerContext.tmdbId))
        ? String(providerContext.tmdbId)
        : null;
      const tmdbFromPayload = extractTmdbIdFromMappingPayload(mappingPayload);
      const fallbackTmdbId = tmdbFromContext || tmdbFromPayload;
      if (fallbackTmdbId) {
        const tmdbLookup = {
          provider: 'tmdb' as const,
          externalId: fallbackTmdbId,
          season: lookup.season,
          episode: lookup.episode,
        };
        const tmdbPayload = await fetchMappingPayload(tmdbLookup, caches, 'AnimeUnity');
        const tmdbPaths = extractProviderPaths(tmdbPayload, 'animeunity', normalizeAnimePath);
        if (tmdbPaths.length > 0) {
          mappingPayload = tmdbPayload;
          animePaths = tmdbPaths;
        }
      }
    }

    if (!animePaths.length) return [];

    const requestedEpisode = resolveEpisodeFromMappingPayload(mappingPayload, lookup.episode);
    const chunks = await mapLimit(animePaths, 3, (path) =>
      this.extractStreamsFromAnimePath(path, requestedEpisode, seasonNumber, isMovie, titleFallback)
    );
    const merged = chunks.flat().filter((stream) => stream && stream.url);

    const deduped: StreamForStremio[] = [];
    const seen = new Set<string>();
    for (const stream of merged) {
      const key = String(stream.url).trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      deduped.push(stream);
    }

    return deduped;
  }

  private async handleLookupWithTitleFallback(
    lookupId: string,
    title: string,
    seasonNumber: number | null,
    episodeNumber: number | null,
    isMovie: boolean,
    providerContext: { kitsuId?: string; tmdbId?: string; imdbId?: string } | null
  ): Promise<{ streams: StreamForStremio[] }> {
    const fromMapping = await this.getStreamsFromMapping(
      lookupId,
      seasonNumber,
      episodeNumber,
      isMovie,
      providerContext,
      title
    );
    if (fromMapping.length) {
      console.log('[AnimeUnity] Mapping API hit: uso stream da mapping path.');
      return { streams: fromMapping };
    }
    console.log('[AnimeUnity] Mapping API miss: fallback a ricerca per titolo.');
    return this.handleTitleRequest(title, seasonNumber, episodeNumber, isMovie);
  }

  // Made public for catalog search
  async searchAllVersions(title: string): Promise<{ version: AnimeUnitySearchResult; language_type: string }[]> {
    try {
      const subPromise = searchEndpoint(title, false).catch(() => []);
      const dubPromise = searchEndpoint(title, true).catch(() => []);

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
      // Single quick Kitsu call for canonical title (stream label only)
      // Heavy resolution (mappings, include=mappings, Jikan) deferred to fallback path only
      let quickTitle = kitsuId;
      try {
        const metaResp = await fetch(`https://kitsu.io/api/edge/anime/${kitsuId}`);
        if (metaResp.ok) {
          const j: any = await metaResp.json();
          const attr = j?.data?.attributes || {};
          quickTitle = attr.titles?.en || attr.titles?.en_jp || attr.canonicalTitle || kitsuId;
        }
      } catch { }
      // Try mapping API first — no expensive title resolution yet
      const fromMapping = await this.getStreamsFromMapping(
        `kitsu:${kitsuId}`, seasonNumber, episodeNumber, isMovie, { kitsuId }, quickTitle
      );
      if (fromMapping.length) {
        console.log('[AnimeUnity] Mapping hit (Kitsu): skipped heavy title resolution.');
        return { streams: fromMapping };
      }
      // Mapping miss → now do full title resolution for the title search fallback
      const englishTitle = await getEnglishTitleFromAnyId(kitsuId, 'kitsu', this.config.tmdbApiKey);
      console.log(`[AnimeUnity] Mapping miss (Kitsu): ricerca con titolo inglese: ${englishTitle}`);
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
      const imdbIdClean = imdbId.split(':')[0];
      // Try mapping API first — defer expensive title resolution to fallback path only
      const fromMappingImdb = await this.getStreamsFromMapping(
        imdbIdClean, seasonNumber, episodeNumber, isMovie, { imdbId: imdbIdClean }, ''
      );
      if (fromMappingImdb.length) {
        console.log('[AnimeUnity] Mapping hit (IMDB): skipped title resolution.');
        return { streams: fromMappingImdb };
      }
      // Mapping miss → resolve full English title for search fallback
      const englishTitle = await getEnglishTitleFromAnyId(imdbId, 'imdb', this.config.tmdbApiKey);
      console.log(`[AnimeUnity] Mapping miss (IMDB): ricerca con titolo inglese: ${englishTitle}`);
      const res = await this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
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
      // Try mapping API first — defer expensive title resolution to fallback path only
      const fromMappingTmdb = await this.getStreamsFromMapping(
        tmdbId, seasonNumber, episodeNumber, isMovie, { tmdbId }, ''
      );
      if (fromMappingTmdb.length) {
        console.log('[AnimeUnity] Mapping hit (TMDB): skipped title resolution.');
        return { streams: fromMappingTmdb };
      }
      // Mapping miss → resolve full English title for search fallback
      const englishTitle = await getEnglishTitleFromAnyId(tmdbId, 'tmdb', this.config.tmdbApiKey);
      console.log(`[AnimeUnity] Mapping miss (TMDB): ricerca con titolo inglese: ${englishTitle}`);
      const res = await this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
      return res;
    } catch (error) {
      console.error('Error handling TMDB request:', error);
      return { streams: [] };
    }
  }

  async handleTitleRequest(title: string, seasonNumber: number | null, episodeNumber: number | null, isMovie = false): Promise<{ streams: StreamForStremio[] }> {
    const universalTitle = applyUniversalAnimeTitleNormalization(title);
    const normalizedTitle = normalizeTitleForSearch(universalTitle);
    if (universalTitle !== title) {
      console.log(`[UniversalTitle][Applied] ${title} -> ${universalTitle}`);
    }
    console.log(`[AnimeUnity] Titolo normalizzato per ricerca: ${normalizedTitle}`);
    // Se il titolo originale è una chiave dell'exactMap allora saltiamo qualsiasi filtro successivo:
    // l'intento dell'utente è: se la ricerca parte da una chiave exactMap, NON applicare filterAnimeResults
    const skipFilter = Object.prototype.hasOwnProperty.call(exactMap, title);
    if (skipFilter) {
      console.log(`[AnimeUnity][ExactMap] Skip filtro: titolo di input corrisponde a chiave exactMap -> "${title}"`);
    }
    let animeVersions = await this.searchAllVersions(normalizedTitle);
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
      } catch { }
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
    const streams: StreamForStremio[] = [];
    const seenLinks = new Set();
    for (const { version, language_type } of animeVersions) {
      const cleanName = version.name
        .replace(/\s*\(ITA\)/i, '')
        .replace(/\s*\(CR\)/i, '')
        .replace(/ITA/gi, '')
        .replace(/CR/gi, '')
        .trim();
      const langLabel = language_type === 'ITA' ? 'ITA' : 'SUB';
      const path = normalizeAnimePath(`/anime/${version.id}-${version.slug}`);
      if (!path) continue;
      const perVersion = await this.extractStreamsFromAnimePath(
        path,
        episodeNumber,
        seasonNumber,
        isMovie,
        cleanName,
        langLabel
      );
      for (const st of perVersion) {
        if (!st || !st.url) continue;
        if (seenLinks.has(st.url)) continue;
        streams.push(st);
        seenLinks.add(st.url);
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
