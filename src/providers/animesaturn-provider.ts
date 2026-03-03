import { AnimeSaturnConfig, AnimeSaturnResult, AnimeSaturnEpisode, StreamForStremio } from '../types/animeunity';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { KitsuProvider } from './kitsu';
import { getDomain } from '../utils/domains';
import { checkIsAnimeById, applyUniversalAnimeTitleNormalization } from '../utils/animeGate';
import {
  createCaches,
  fetchResource,
  getProviderUrl,
  resolveLookupRequest,
  fetchMappingPayload,
  extractProviderPaths,
  extractTmdbIdFromMappingPayload,
  resolveEpisodeFromMappingPayloadExtended,
} from './anime-core';

const AS_FETCH_TIMEOUT = Number.parseInt(process.env.ANIMESATURN_FETCH_TIMEOUT_MS || '10000', 10) || 10000;
const asCaches = createCaches();

function getSaturnBaseUrl(): string {
  const configured = getProviderUrl('animesaturn', ['ANIMESATURN_BASE_URL', 'AS_BASE_URL']);
  if (configured) return configured.replace(/\/+$/, '');
  const host = getDomain('animesaturn') || 'animesaturn.cx';
  return `https://www.${host}`;
}

function normalizeAnimeSaturnPath(pathOrUrl: string | null | undefined): string | null {
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
  const match = value.match(/^\/anime\/[^/?#]+/i);
  return match ? match[0] : null;
}

function normalizeEpisodePath(pathOrUrl: string | null | undefined): string | null {
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
  const match = value.match(/^\/ep\/[^/?#]+/i);
  return match ? match[0] : null;
}

function buildSaturnUrl(pathOrUrl: string | null | undefined): string | null {
  const text = String(pathOrUrl || '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('/')) return `${getSaturnBaseUrl()}${text}`;
  return `${getSaturnBaseUrl()}/${text}`;
}

function parseAsEpisodeNumber(value: any, fallbackNum: number): number {
  const raw = String(value || '').trim();
  if (!raw) return fallbackNum;
  const byHref = raw.match(/-ep-(\d+)/i);
  if (byHref) return Number.parseInt(byHref[1], 10);
  const byLabel = raw.match(/episodio\s*(\d+)/i);
  if (byLabel) return Number.parseInt(byLabel[1], 10);
  const byAny = raw.match(/(\d{1,4})/);
  if (byAny) return Number.parseInt(byAny[1], 10);
  return fallbackNum;
}

function normalizePlayableMediaUrl(rawUrl: string | null | undefined, depth = 0): string | null {
  if (!rawUrl) return null;
  let absolute: string;
  try {
    absolute = new URL(String(rawUrl).trim(), getSaturnBaseUrl()).toString();
  } catch {
    return null;
  }
  if (/\.(?:mp4|m3u8)(?:[?#].*)?$/i.test(absolute)) return absolute;
  if (depth >= 1) return null;
  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return null;
  }
  const nestedKeys = ['url', 'src', 'file', 'link', 'stream', 'id'];
  for (const key of nestedKeys) {
    const nested = parsed.searchParams.get(key);
    if (!nested) continue;
    let decoded = nested;
    try {
      decoded = decodeURIComponent(nested);
    } catch {
      decoded = nested;
    }
    const nestedUrl = normalizePlayableMediaUrl(decoded, depth + 1);
    if (nestedUrl) return nestedUrl;
  }
  return null;
}

function extractWatchUrlsFromHtml(html: string, expectedFileId: string | null = null): string[] {
  const text = String(html || '');
  const values = new Set<string>();
  let match: RegExpExecArray | null;
  const absoluteRegex = /https?:\/\/[^\s"'<>\\]+\/watch\?file=[^"'<>\\\s]+/gi;
  while ((match = absoluteRegex.exec(text)) !== null) values.add(match[0]);
  const relativeRegex = /\/watch\?file=[^"'<>\\\s]+/gi;
  while ((match = relativeRegex.exec(text)) !== null) values.add(`${getSaturnBaseUrl()}${match[0]}`);

  const out: string[] = [];
  const seen = new Set<string>();
  values.forEach((candidate) => {
    try {
      const parsed = new URL(candidate, getSaturnBaseUrl());
      if (parsed.pathname !== '/watch') return;
      const fileParam = parsed.searchParams.get('file');
      if (!fileParam) return;
      if (expectedFileId && fileParam !== expectedFileId) return;
      const abs = parsed.toString();
      if (!seen.has(abs)) {
        seen.add(abs);
        out.push(abs);
      }
      if (!parsed.searchParams.has('s')) {
        parsed.searchParams.set('s', 'alt');
        const alt = parsed.toString();
        if (!seen.has(alt)) {
          seen.add(alt);
          out.push(alt);
        }
      }
    } catch {
      // ignore
    }
  });
  return out;
}

function collectMediaLinksFromWatchHtml(html: string): string[] {
  const $ = cheerio.load(String(html || ''));
  const links: string[] = [];
  const seen = new Set<string>();
  const add = (href: string | null | undefined) => {
    const playable = normalizePlayableMediaUrl(href || null);
    if (!playable || seen.has(playable)) return;
    seen.add(playable);
    links.push(playable);
  };
  $('source[src], video source[src]').each((_, el) => add($(el).attr('src')));
  const raw = String(html || '');
  const variants = [raw, raw.replace(/\\\//g, '/')];
  for (const text of variants) {
    let match: RegExpExecArray | null;
    const directRegex = /https?:\/\/[^\s"'<>\\]+(?:\.mp4|\.m3u8)(?:[^\s"'<>\\]*)?/gi;
    while ((match = directRegex.exec(text)) !== null) add(match[0]);
    const sourceRegex = /(?:file|src|url|link)\s*[:=]\s*["']([^"']+)["']/gi;
    while ((match = sourceRegex.exec(text)) !== null) add(match[1]);
  }
  return links;
}

async function asSearch(query: string): Promise<AnimeSaturnResult[]> {
  const q = encodeURIComponent(String(query || '').trim());
  if (!q) return [];
  const urls = [
    `${getSaturnBaseUrl()}/?search=${q}`,
    `${getSaturnBaseUrl()}/anime?search=${q}`,
  ];
  const out: AnimeSaturnResult[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    let html = '';
    try {
      html = await fetchResource(url, asCaches, { ttlMs: 2 * 60 * 1000, cacheKey: `as-search:${url}`, timeoutMs: AS_FETCH_TIMEOUT });
    } catch {
      continue;
    }
    const $ = cheerio.load(String(html || ''));
    $('a[href*="/anime/"]').each((_, el) => {
      const href = String($(el).attr('href') || '').trim();
      const path = normalizeAnimeSaturnPath(href);
      if (!path || seen.has(path)) return;
      seen.add(path);
      const title = String($(el).attr('title') || $(el).text() || path).replace(/\s+/g, ' ').trim();
      out.push({ title, url: buildSaturnUrl(path) || `${getSaturnBaseUrl()}${path}` });
    });
    if (out.length) break;
  }
  return out;
}

async function asGetEpisodes(animeUrl: string): Promise<AnimeSaturnEpisode[]> {
  const animePath = normalizeAnimeSaturnPath(animeUrl);
  const finalUrl = animePath ? buildSaturnUrl(animePath) : animeUrl;
  if (!finalUrl) return [];
  let html = '';
  try {
    html = await fetchResource(finalUrl, asCaches, { ttlMs: 5 * 60 * 1000, cacheKey: `as-anime:${finalUrl}`, timeoutMs: AS_FETCH_TIMEOUT });
  } catch {
    return [];
  }
  const $ = cheerio.load(String(html || ''));
  const episodes: AnimeSaturnEpisode[] = [];
  const seen = new Set<string>();
  $('a[href*="/ep/"]').each((index, el) => {
    const href = normalizeEpisodePath($(el).attr('href') || null);
    if (!href || seen.has(href)) return;
    seen.add(href);
    const probe = `${href} ${$(el).text() || ''} ${$(el).attr('title') || ''}`;
    episodes.push({
      title: String($(el).text() || $(el).attr('title') || `Episodio ${index + 1}`).trim(),
      url: buildSaturnUrl(href) || `${getSaturnBaseUrl()}${href}`,
    });
  });
  if (!episodes.length) {
    const watch = extractWatchUrlsFromHtml(String(html || ''));
    if (watch.length) {
      episodes.push({ title: 'Episodio 1', url: watch[0] });
    }
  }
  return episodes;
}

async function asGetStream(episodeUrl: string): Promise<{ url: string | null; headers?: any }> {
  const epPath = normalizeEpisodePath(episodeUrl);
  const entryUrl = epPath ? (buildSaturnUrl(epPath) || episodeUrl) : episodeUrl;
  if (!entryUrl) return { url: null };

  let html = '';
  try {
    html = await fetchResource(entryUrl, asCaches, { ttlMs: 5 * 60 * 1000, cacheKey: `as-ep:${entryUrl}`, timeoutMs: AS_FETCH_TIMEOUT });
  } catch {
    return { url: null };
  }

  const initialWatch = extractWatchUrlsFromHtml(String(html || ''));
  const queue = [...initialWatch];
  const visited = new Set<string>();
  let processed = 0;
  while (queue.length && processed < 6) {
    const watchUrl = queue.shift();
    if (!watchUrl || visited.has(watchUrl)) continue;
    visited.add(watchUrl);
    processed += 1;
    let watchHtml = '';
    try {
      watchHtml = await fetchResource(watchUrl, asCaches, { ttlMs: 5 * 60 * 1000, cacheKey: `as-watch:${watchUrl}`, timeoutMs: AS_FETCH_TIMEOUT });
    } catch {
      continue;
    }
    const media = collectMediaLinksFromWatchHtml(String(watchHtml || ''));
    if (media.length) return { url: media[0] };
    const extra = extractWatchUrlsFromHtml(String(watchHtml || ''));
    for (const candidate of extra) if (!visited.has(candidate)) queue.push(candidate);
  }

  return { url: null };
}

// Adapter drop-in: preserva chiamate legacy invokePythonScraper ma in pure TypeScript.
async function invokePythonScraper(args: string[], _mfpConfig?: { mfpUrl?: string; mfpPassword?: string }): Promise<any> {
  const cmd = String(args?.[0] || '');
  if (cmd === 'search') {
    const qIdx = args.indexOf('--query');
    const query = qIdx >= 0 ? String(args[qIdx + 1] || '') : '';
    return asSearch(query);
  }
  if (cmd === 'get_episodes') {
    const uIdx = args.indexOf('--anime-url');
    const animeUrl = uIdx >= 0 ? String(args[uIdx + 1] || '') : '';
    return asGetEpisodes(animeUrl);
  }
  if (cmd === 'get_stream') {
    const uIdx = args.indexOf('--episode-url');
    const episodeUrl = uIdx >= 0 ? String(args[uIdx + 1] || '') : '';
    return asGetStream(episodeUrl);
  }
  throw new Error(`AnimeSaturn adapter command non supportato: ${cmd}`);
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
  // Anche con MAL ID, filtra sempre per titolo per evitare risultati irrilevanti
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

  private async extractStreamsFromMappedPath(
    animePath: string,
    requestedEpisode: number,
    seasonNumber: number | null,
    isMovie: boolean,
    titleFallback: string
  ): Promise<StreamForStremio[]> {
    const normalizedPath = normalizeAnimeSaturnPath(animePath);
    if (!normalizedPath) return [];
    const animeUrl = buildSaturnUrl(normalizedPath);
    if (!animeUrl) return [];

    const episodes: AnimeSaturnEpisode[] = await invokePythonScraper(['get_episodes', '--anime-url', animeUrl]).catch(() => []);
    if (!episodes.length) return [];

    let targetEpisode: AnimeSaturnEpisode | undefined;
    if (isMovie) targetEpisode = episodes[0];
    else targetEpisode = episodes.find((ep) => {
      const match = String(ep.title || '').match(/E(\d+)/i);
      if (match) return parseInt(match[1], 10) === requestedEpisode;
      return String(ep.title || '').includes(String(requestedEpisode));
    }) || episodes[0];
    if (!targetEpisode) return [];

    const streamResult = await invokePythonScraper(['get_stream', '--episode-url', targetEpisode.url]).catch(() => ({ url: null }));
    const streamUrl = String(streamResult?.url || '').trim();
    if (!streamUrl) return [];

    const cleanName = String(titleFallback || '').replace(/\s+/g, ' ').trim() || 'AnimeSaturn';
    const sNum = seasonNumber || 1;
    const langLabel = /(?:^|[-_])ita(?:[-_]|$)/i.test(animePath) ? 'ITA' : 'SUB';
    let streamTitle = `${capitalize(cleanName)} ▪ ${langLabel} ▪ S${sNum}`;
    if (!isMovie && requestedEpisode) streamTitle += `E${requestedEpisode}`;

    return [{
      title: streamTitle,
      url: streamUrl,
      behaviorHints: {
        notWebReady: true,
        ...(streamResult?.headers ? { headers: streamResult.headers } : {}),
      },
    }];
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

    let mappingPayload = await fetchMappingPayload(lookup, asCaches, 'AnimeSaturn');
    let animePaths = extractProviderPaths(mappingPayload, 'animesaturn', normalizeAnimeSaturnPath as any);

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
        const tmdbPayload = await fetchMappingPayload(tmdbLookup, asCaches, 'AnimeSaturn');
        const tmdbPaths = extractProviderPaths(tmdbPayload, 'animesaturn', normalizeAnimeSaturnPath as any);
        if (tmdbPaths.length > 0) {
          mappingPayload = tmdbPayload;
          animePaths = tmdbPaths;
        }
      }
    }

    if (!animePaths.length) return [];
    const requestedEpisode = resolveEpisodeFromMappingPayloadExtended(mappingPayload, lookup.episode);

    const streams: StreamForStremio[] = [];
    const seen = new Set<string>();
    for (const path of animePaths) {
      const perPath = await this.extractStreamsFromMappedPath(path, requestedEpisode, seasonNumber, isMovie, titleFallback);
      for (const st of perPath) {
        const key = String(st.url || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        streams.push(st);
      }
    }
    return streams;
  }

  private async handleLookupWithTitleFallback(
    lookupId: string,
    title: string,
    seasonNumber: number | null,
    episodeNumber: number | null,
    isMovie: boolean,
    providerContext: { kitsuId?: string; tmdbId?: string; imdbId?: string } | null,
    malId?: string
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
      console.log('[AnimeSaturn] Mapping API hit: uso stream da mapping path.');
      return { streams: fromMapping };
    }
    console.log('[AnimeSaturn] Mapping API miss: fallback a ricerca per titolo.');
    return this.handleTitleRequest(title, seasonNumber, episodeNumber, isMovie, malId);
  }

  // Uniformità: accetta sia Kitsu che MAL
  async handleKitsuRequest(kitsuIdString: string): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) {
      return { streams: [] };
    }
    try {
      const { kitsuId, seasonNumber, episodeNumber, isMovie } = this.kitsuProvider.parseKitsuId(kitsuIdString);
      // Two quick Kitsu calls in PARALLEL: canonical title + MAL ID
      // Heavy resolution (Jikan) deferred to fallback path only
      let quickTitle = kitsuId;
      let malId: string | undefined = undefined;
      try {
        const [metaResp, mappingsResp] = await Promise.all([
          fetch(`https://kitsu.io/api/edge/anime/${kitsuId}`),
          fetch(`https://kitsu.io/api/edge/anime/${kitsuId}/mappings`),
        ]);
        if (metaResp.ok) {
          const j: any = await metaResp.json();
          const attr = j?.data?.attributes || {};
          quickTitle = attr.titles?.en || attr.titles?.en_jp || attr.canonicalTitle || kitsuId;
        }
        if (mappingsResp.ok) {
          const j: any = await mappingsResp.json();
          const malMapping = j.data?.find((m: any) => m.attributes.externalSite === 'myanimelist/anime');
          malId = malMapping?.attributes?.externalId?.toString() || undefined;
        }
      } catch {}
      // Try mapping API first — no expensive title/Jikan resolution yet
      const fromMapping = await this.getStreamsFromMapping(
        `kitsu:${kitsuId}`, seasonNumber, episodeNumber, isMovie, { kitsuId }, quickTitle
      );
      if (fromMapping.length) {
        console.log('[AnimeSaturn] Mapping hit (Kitsu): skipped heavy title resolution.');
        return { streams: fromMapping };
      }
      // Mapping miss → full title resolution (Jikan) for title search fallback
      console.log('[AnimeSaturn] Mapping miss (Kitsu): resolving full English title...');
      const englishTitle = await getEnglishTitleFromAnyId(kitsuId, 'kitsu', this.config.tmdbApiKey);
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
  const imdbIdClean = imdbId.split(':')[0];
  // Try mapping API first — defer expensive title resolution to fallback path only
  const fromMappingImdb = await this.getStreamsFromMapping(
    imdbIdClean, seasonNumber, episodeNumber, isMovie, { imdbId: imdbIdClean }, ''
  );
  if (fromMappingImdb.length) {
    console.log('[AnimeSaturn] Mapping hit (IMDB): skipped title resolution.');
    return { streams: fromMappingImdb };
  }
  // Mapping miss → full title + MAL ID for title search fallback
  const englishTitle = await getEnglishTitleFromAnyId(imdbId, 'imdb', this.config.tmdbApiKey);
      // Recupera anche l'id MAL tramite Haglund
      let malId: string | undefined = undefined;
      try {
        const tmdbKey = this.config.tmdbApiKey || process.env.TMDB_API_KEY || '';
        const { getTmdbIdFromImdbId } = await import('../extractor');
        const tmdbId = await getTmdbIdFromImdbId(imdbIdClean, tmdbKey, 'tv');
        if (tmdbId) {
          const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json();
          malId = haglundResp[0]?.myanimelist?.toString() || undefined;
        }
      } catch {}
  const res = await this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie, malId);
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
  // Try mapping API first — defer expensive title resolution to fallback path only
  const fromMappingTmdb = await this.getStreamsFromMapping(
    `tmdb:${tmdbId}`, seasonNumber, episodeNumber, isMovie, { tmdbId }, ''
  );
  if (fromMappingTmdb.length) {
    console.log('[AnimeSaturn] Mapping hit (TMDB): skipped title resolution.');
    return { streams: fromMappingTmdb };
  }
  // Mapping miss → full title + MAL ID for title search fallback
  const englishTitle = await getEnglishTitleFromAnyId(tmdbId, 'tmdb', this.config.tmdbApiKey);
      // Recupera anche l'id MAL tramite Haglund
      let malId: string | undefined = undefined;
      try {
        const tmdbKey = this.config.tmdbApiKey || process.env.TMDB_API_KEY || '';
        const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json();
        malId = haglundResp[0]?.myanimelist?.toString() || undefined;
      } catch {}
  const res = await this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie, malId);
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
