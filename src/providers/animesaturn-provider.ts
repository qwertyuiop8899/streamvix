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
  toAbsoluteUrl,
  normalizeRequestedEpisode,
  normalizeRequestedSeason,
  parseEpisodeNumber as coreParseEpisodeNumber,
  parsePositiveInt,
  normalizePlayableMediaUrl,
  normalizeHostLabel,
  BLOCKED_DOMAINS,
} from './anime-core';

const AS_FETCH_TIMEOUT = Number.parseInt(process.env.ANIMESATURN_FETCH_TIMEOUT_MS || '10000', 10) || 10000;
const asCaches = createCaches();
const AS_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

function buildSaturnHeaders(referer?: string): Record<string, string> {
  const h: Record<string, string> = {
    'user-agent': AS_USER_AGENT,
    'accept-language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  };
  if (referer) h.referer = referer;
  return h;
}

function getSaturnBaseUrl(): string {
  const configured = getProviderUrl('animesaturn', ['ANIMESATURN_BASE_URL', 'AS_BASE_URL']);
  const raw = configured || `https://${getDomain('animesaturn') || 'animesaturn.cx'}`;
  try {
    const u = new URL(String(raw).replace(/\/+$/, ''));
    if (!/^www\./i.test(u.hostname)) u.hostname = `www.${u.hostname}`;
    return u.origin;
  } catch {
    const host = (getDomain('animesaturn') || 'animesaturn.cx').replace(/^www\./i, '');
    return `https://www.${host}`;
  }
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
  const match = value.match(/^\/episode\/[^/?#]+\/ep-\d+/i);
  return match ? match[0] : null;
}

function buildSaturnUrl(pathOrUrl: string | null | undefined): string | null {
  const text = String(pathOrUrl || '').trim();
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('/')) return `${getSaturnBaseUrl()}${text}`;
  return `${getSaturnBaseUrl()}/${text}`;
}

function inferSourceTag(title: string | null | undefined, animePath: string | null | undefined): 'ITA' | 'SUB' {
  const titleText = String(title || '').toLowerCase();
  const pathText = String(animePath || '').toLowerCase();
  if (/(?:^|[^\w])ita(?:[^\w]|$)/i.test(titleText)) return 'ITA';
  if (/(?:^|[-_/])ita(?:[-_/]|$)/i.test(pathText)) return 'ITA';
  return 'SUB';
}

function resolveLanguageEmoji(sourceTag: string | null | undefined): string {
  return String(sourceTag || '').toUpperCase() === 'ITA' ? '🇮🇹' : '🇯🇵';
}

function sanitizeAnimeTitle(rawTitle: string | null | undefined): string | null {
  let text = String(rawTitle || '').trim();
  if (!text) return null;
  text = text.replace(/^\s*AnimeSaturn\s*-\s*/i, '')
             .replace(/\s*-\s*AnimeSaturn.*$/i, '')
             .replace(/\s+Streaming.*$/i, '')
             .replace(/\s+Episodi.*$/i, '')
             .replace(/\s+episodio\s*\d+(?:[.,]\d+)?\b/gi, '')
             .replace(/\s+episode\s*\d+(?:[.,]\d+)?\b/gi, '')
             .trim();
  text = text.replace(/\s*[\[(]\s*(?:SUB\s*ITA|ITA|SUB|DUB(?:BED)?|DOPPIATO)\s*[\])]\s*/gi, ' ')
             .replace(/\s*[-–_|:]\s*(?:SUB\s*ITA|ITA|SUB|DUB(?:BED)?|DOPPIATO)\s*$/gi, '')
             .replace(/\s{2,}/g, ' ')
             .replace(/\s*[-–_|:]\s*$/g, '')
             .trim();
  return text || null;
}

function decodeHtmlEntities(value: string | null | undefined): string {
  return String(value || '')
    .replace(/&quot;/gi, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

function stripHtmlTags(value: string | null | undefined): string {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function getTagAttribute(tag: string | null | undefined, attrName: string): string | null {
  const escaped = String(attrName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`${escaped}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, 'i');
  const match = String(tag || '').match(regex);
  return match ? decodeHtmlEntities(match[2]) : null;
}

function getFirstTagText(html: string | null | undefined, tagName: string): string {
  const regex = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i');
  const match = String(html || '').match(regex);
  return match ? stripHtmlTags(match[1]) : '';
}

function getMetaContent(html: string | null | undefined, propertyValue: string): string | null {
  const escaped = String(propertyValue || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<meta\\b(?=[^>]*(?:property|name)\\s*=\\s*["']${escaped}["'])[\\s\\S]*?>`, 'i');
  const match = String(html || '').match(regex);
  return match ? getTagAttribute(match[0], 'content') : null;
}

interface AnchorMatch {
  href: string;
  title: string;
  text: string;
}

function collectAnchorMatches(html: string | null | undefined, hrefNeedle: string): AnchorMatch[] {
  const anchors: AnchorMatch[] = [];
  const regex = /<a\b[^>]*href\s*=\s*(["'])([\s\S]*?)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  const content = String(html || '');
  while ((match = regex.exec(content)) !== null) {
    const tag = match[0];
    const href = decodeHtmlEntities(match[2]);
    if (!String(href || '').includes(hrefNeedle)) continue;
    anchors.push({
      href,
      title: getTagAttribute(tag, 'title') || '',
      text: stripHtmlTags(match[3]),
    });
  }
  return anchors;
}

function parseEpisodeNumber(value: string | null | undefined, fallbackNum: number): number {
  const raw = String(value || '').trim();
  if (!raw) return fallbackNum;
  const byHref = raw.match(/\/ep-(\d+)/i);
  if (byHref) {
    const parsed = Number.parseInt(byHref[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const byLabel = raw.match(/episodio\s*(\d+)/i);
  if (byLabel) {
    const parsed = Number.parseInt(byLabel[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallbackNum;
}

function extractQualityHint(value: string | null | undefined): string {
  const text = String(value || '');
  const match = text.match(/(\d{3,4}p)/i);
  return match ? match[1] : 'Unknown';
}

function normalizeAnimeSaturnQuality(value: string | null | undefined): string {
  const text = String(value || '').trim();
  if (!text) return '720p';
  if (/^(?:unknown|unknow|auto)$/i.test(text)) return '720p';
  return text;
}

function extractWatchUrlsFromHtml(html: string, expectedFileId: string | null = null): string[] {
  const text = String(html || '');
  const values = new Set<string>();
  let match: RegExpExecArray | null;
  const absoluteRegex = /https?:\/\/[^\s"'<>\\]+\/watch\?file=[^"'<>\\\s]+/gi;
  while ((match = absoluteRegex.exec(text)) !== null) values.add(match[0]);
  const relativeRegex = /\/watch\?file=[^"'<>\\\s]+/gi;
  while ((match = relativeRegex.exec(text)) !== null) {
    const abs = buildSaturnUrl(match[0]);
    if (abs) values.add(abs);
  }

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

interface MediaLink {
  href: string;
  label: string;
}

function collectMediaLinksFromWatchHtml(html: string | null | undefined): MediaLink[] {
  const links: MediaLink[] = [];
  const seen = new Set<string>();
  function addLink(href: string | null | undefined, label: string) {
    const playable = normalizePlayableMediaUrl(href, getSaturnBaseUrl());
    if (!playable || seen.has(playable)) return;
    seen.add(playable);
    links.push({ href: playable, label });
  }
  const sourceRegex = /<source\b[^>]*src\s*=\s*(["'])([\s\S]*?)\1[^>]*>/gi;
  let sourceMatch: RegExpExecArray | null;
  const content = String(html || '');
  while ((sourceMatch = sourceRegex.exec(content)) !== null) {
    addLink(decodeHtmlEntities(sourceMatch[2]), 'Player');
  }
  const rawHtml = String(html || '');
  const variants = [rawHtml, rawHtml.replace(/\\\//g, '/')];
  for (const text of variants) {
    let match: RegExpExecArray | null;
    const directRegex = /https?:\/\/[^\s"'<>\\]+(?:\.mp4|\.m3u8)(?:[^\s"'<>\\]*)?/gi;
    while ((match = directRegex.exec(text)) !== null) {
      addLink(match[0], 'Player');
    }
    const encodedRegex = /https%3A%2F%2F[^\s"'<>\\]+/gi;
    while ((match = encodedRegex.exec(text)) !== null) {
      try {
        addLink(decodeURIComponent(match[0]), 'Player');
      } catch {
        // ignore
      }
    }
    const sourceRegex2 = /(?:file|src|url|link)\s*[:=]\s*["']([^"']+)["']/gi;
    while ((match = sourceRegex2.exec(text)) !== null) {
      addLink(match[1], 'Player');
    }
  }
  return links;
}

function checkQualityFromText(text: string): string | null {
  if (!text) return null;
  if (/RESOLUTION=\d+x2160/i.test(text) || /RESOLUTION=2160/i.test(text)) return '4K';
  if (/RESOLUTION=\d+x1440/i.test(text) || /RESOLUTION=1440/i.test(text)) return '1440p';
  if (/RESOLUTION=\d+x1080/i.test(text) || /RESOLUTION=1080/i.test(text)) return '1080p';
  if (/RESOLUTION=\d+x720/i.test(text) || /RESOLUTION=720/i.test(text)) return '720p';
  if (/RESOLUTION=\d+x480/i.test(text) || /RESOLUTION=480/i.test(text)) return '480p';
  return null;
}

async function checkQualityFromPlaylist(url: string, headers: Record<string, string> = {}): Promise<string | null> {
  try {
    const finalHeaders = { ...headers };
    if (!finalHeaders['User-Agent'] && !finalHeaders['user-agent']) {
      finalHeaders['User-Agent'] = AS_USER_AGENT;
    }
    const response = await fetch(url, { headers: finalHeaders });
    if (!response.ok) return null;
    const text = await response.text();
    if (!text.startsWith('#EXTM3U')) return null;
    return checkQualityFromText(text);
  } catch {
    return null;
  }
}

function extractEmbedUrlFromWatchHtml(html: string | null | undefined): string | null {
  const content = String(html || '');
  const match = content.match(/<iframe\b[^>]*src\s*=\s*["']([^"']*play\.saturncdn\.net[^"']*)["']/i);
  if (match) return decodeHtmlEntities(match[1]);
  const dataMatch = content.match(/initialVideoUrl\s*:\s*["']([^"']*)["']/i);
  if (dataMatch) return decodeHtmlEntities(dataMatch[1]);
  return null;
}

function base64XorDecrypt(encoded: string, key: string): string | null {
  if (!encoded || !key) return null;
  try {
    const bytes = typeof Buffer !== 'undefined'
      ? Buffer.from(encoded, 'base64').toString('binary')
      : atob(encoded);
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      out += String.fromCharCode(bytes.charCodeAt(i) ^ key.charCodeAt(i % key.length));
    }
    return out;
  } catch {
    return null;
  }
}

async function resolvePlaylistUrl(embedUrl: string): Promise<string | null> {
  if (!embedUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(embedUrl);
  } catch {
    return null;
  }
  const pathMatch = parsed.pathname.match(/\/embed\/(\d+)/);
  if (!pathMatch) return embedUrl;
  const id = pathMatch[1];
  const token = parsed.searchParams.get('token');
  const expires = parsed.searchParams.get('expires');
  if (!id || !token || !expires) return embedUrl;
  
  const playlistUrl = `${parsed.origin}/embed/${id}/playlist?token=${encodeURIComponent(token)}&expires=${encodeURIComponent(expires)}`;
  
  try {
    const payload = await fetchResource(playlistUrl, asCaches, {
      as: 'json',
      ttlMs: 5 * 60 * 1000,
      cacheKey: `playlist:${embedUrl}`,
      timeoutMs: AS_FETCH_TIMEOUT,
      headers: {
        'Accept': '*/*',
        'Origin': parsed.origin,
        'Referer': embedUrl,
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'user-agent': AS_USER_AGENT,
      },
    });
    if (!payload || !payload.d) return embedUrl;
    const decrypted = base64XorDecrypt(payload.d, token);
    if (decrypted) return decrypted;
  } catch (error: any) {
    console.error('[AnimeSaturn] playlist resolution failed:', error.message);
  }
  return embedUrl;
}

async function resolveWatchUrlsForEpisodeEntry(
  source: { animePath: string; title: string | null; sourceTag: string; episodes: any[] },
  episodeEntry: { num: number; token: string; episodePath: string | null; watchUrl: string | null }
): Promise<string[]> {
  const urls: string[] = [];
  if (episodeEntry?.watchUrl) {
    urls.push(...extractWatchUrlsFromHtml(episodeEntry.watchUrl));
  }
  if (urls.length === 0 && episodeEntry?.episodePath) {
    const watchPath = episodeEntry.episodePath.replace(/^\/episode\//, '/anime/');
    const watchUrl = buildSaturnUrl(watchPath);
    if (watchUrl) urls.push(watchUrl);
  }
  if (urls.length === 0 && episodeEntry?.episodePath) {
    const episodeUrl = buildSaturnUrl(episodeEntry.episodePath);
    if (episodeUrl) {
      try {
        const html = await fetchResource(episodeUrl, asCaches, {
          ttlMs: 5 * 60 * 1000,
          cacheKey: `episode-page:${episodeEntry.episodePath}`,
          timeoutMs: AS_FETCH_TIMEOUT,
          headers: buildSaturnHeaders(),
        });
        urls.push(...extractWatchUrlsFromHtml(html));
      } catch (error: any) {
        console.error('[AnimeSaturn] episode page request failed:', error.message);
      }
    }
  }
  const clean = urls.map((url) => toAbsoluteUrl(url, getSaturnBaseUrl()) || '').filter(Boolean);
  const seen = new Set<string>();
  return clean.filter((v) => {
    if (seen.has(v)) return false;
    seen.add(v);
    return true;
  });
}

interface ParsedSaturnPage {
  title: string | null;
  animePath: string | null;
  sourceTag: 'ITA' | 'SUB';
  episodes: { num: number; token: string; episodePath: string | null; watchUrl: string | null }[];
  relatedAnimePaths: string[];
}

function parseAnimeSaturnPage(html: string, fallback: { animePath?: string | null; title?: string | null } = {}): ParsedSaturnPage {
  const pageTitle = getFirstTagText(html, 'h1') || getMetaContent(html, 'og:title') || getFirstTagText(html, 'title') || null;
  const title = sanitizeAnimeTitle(fallback.title) || sanitizeAnimeTitle(pageTitle) || null;
  const animePath = normalizeAnimeSaturnPath(fallback.animePath || null);
  const sourceTag = inferSourceTag(title, animePath);
  const episodes: { num: number; token: string; episodePath: string | null; watchUrl: string | null }[] = [];
  const seenEpisodePath = new Set<string>();
  
  collectAnchorMatches(html, '/episode/').forEach((anchor, index) => {
    const href = normalizeEpisodePath(anchor.href);
    if (!href || seenEpisodePath.has(href)) return;
    seenEpisodePath.add(href);
    const probe = `${href} ${anchor.text || ''} ${anchor.title || ''}`;
    const num = parseEpisodeNumber(probe, index + 1);
    episodes.push({
      num,
      token: href,
      episodePath: href,
      watchUrl: null,
    });
  });

  if (episodes.length === 0) {
    const watchUrls = extractWatchUrlsFromHtml(html);
    if (watchUrls.length > 0) {
      episodes.push({
        num: 1,
        token: 'watch-1',
        episodePath: null,
        watchUrl: watchUrls[0],
      });
    }
  }

  const relatedAnimePaths: string[] = [];
  const seenRelated = new Set<string>();
  collectAnchorMatches(html, '/anime/').forEach((anchor) => {
    const relatedPath = normalizeAnimeSaturnPath(anchor.href);
    if (!relatedPath || seenRelated.has(relatedPath)) return;
    if (animePath && relatedPath === animePath) return;
    const probe = `${anchor.text || ''} ${anchor.title || ''} ${relatedPath}`.toLowerCase();
    if (!probe.includes('ita')) return;
    seenRelated.add(relatedPath);
    relatedAnimePaths.push(relatedPath);
  });

  episodes.sort((a, b) => a.num - b.num);
  return {
    title,
    animePath,
    sourceTag,
    episodes,
    relatedAnimePaths,
  };
}

function normalizeEpisodesList(sourceEpisodes: any[] = []): { num: number; token: string; episodePath: string | null; watchUrl: string | null }[] {
  if (!Array.isArray(sourceEpisodes) || sourceEpisodes.length === 0) return [];
  const out: { num: number; token: string; episodePath: string | null; watchUrl: string | null }[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < sourceEpisodes.length; index += 1) {
    const entry = sourceEpisodes[index] || {};
    const numRaw = Number.parseInt(String(entry.num !== undefined && entry.num !== null ? entry.num : index + 1), 10);
    const num = Number.isFinite(numRaw) && numRaw > 0 ? numRaw : index + 1;
    const episodePath = normalizeEpisodePath(entry.episodePath || entry.href || entry.token || null);
    const watchUrl = toAbsoluteUrl(entry.watchUrl || null, getSaturnBaseUrl());
    const token = String(entry.token || episodePath || watchUrl || `ep-${num}`).trim();
    const key = `${num}|${episodePath || ''}|${watchUrl || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ num, token, episodePath, watchUrl });
  }
  out.sort((a, b) => a.num - b.num);
  return out;
}

function mergeEpisodeLists(existingEpisodes: any[] = [], nextEpisodes: any[] = []): { num: number; token: string; episodePath: string | null; watchUrl: string | null }[] {
  const map = new Map<number, { num: number; token: string | null; episodePath: string | null; watchUrl: string | null }>();
  function setEpisode(entry: any) {
    if (!entry) return;
    const num = Number.parseInt(String(entry.num || ''), 10);
    if (!Number.isFinite(num) || num <= 0) return;
    const current = map.get(num) || { num, token: null, episodePath: null, watchUrl: null };
    map.set(num, {
      num,
      token: entry.token || current.token || null,
      episodePath: entry.episodePath || current.episodePath || null,
      watchUrl: entry.watchUrl || current.watchUrl || null,
    });
  }
  normalizeEpisodesList(existingEpisodes).forEach(setEpisode);
  normalizeEpisodesList(nextEpisodes).forEach(setEpisode);
  return [...map.values()].sort((a, b) => a.num - b.num) as any;
}

function pickEpisodeEntry(
  episodes: any[],
  requestedEpisode: number,
  mediaType = 'tv'
): { num: number; token: string; episodePath: string | null; watchUrl: string | null } | null {
  const list = normalizeEpisodesList(episodes);
  if (list.length === 0) return null;
  if (mediaType === 'movie') return list[0];
  const episode = normalizeRequestedEpisode(requestedEpisode);
  const byNum = list.find((entry) => entry.num === episode);
  if (byNum) return byNum;
  if (episode === 1) return list[0];
  return null;
}

async function asSearch(query: string): Promise<AnimeSaturnResult[]> {
  const qRaw = String(query || '').trim();
  const q = encodeURIComponent(qRaw);
  if (!q) return [];

  try {
    const apiUrl = `${getSaturnBaseUrl()}/index.php?search=1&key=${q}`;
    const apiData = await fetchResource(apiUrl, asCaches, {
      ttlMs: 2 * 60 * 1000,
      cacheKey: `as-search-api:${qRaw.toLowerCase()}`,
      as: 'json',
      timeoutMs: AS_FETCH_TIMEOUT,
      headers: {
        ...buildSaturnHeaders(`${getSaturnBaseUrl()}/`),
        accept: 'application/json,text/javascript,*/*;q=0.01',
        'x-requested-with': 'XMLHttpRequest',
      },
    });

    const outFromApi: AnimeSaturnResult[] = [];
    const seen = new Set<string>();
    if (Array.isArray(apiData)) {
      for (const item of apiData) {
        const link = String(item?.link || '').trim();
        const path = normalizeAnimeSaturnPath(`/anime/${link}`);
        if (!path || seen.has(path)) continue;
        seen.add(path);
        const title = String(item?.name || link || path).replace(/\s+/g, ' ').trim();
        outFromApi.push({ title, url: buildSaturnUrl(path) || `${getSaturnBaseUrl()}${path}` });
      }
    }
    if (outFromApi.length) return outFromApi;
  } catch (err: any) {
    console.warn('[AnimeSaturn][Search] live-search API failed, fallback HTML:', err?.message || err);
  }

  const urls = [
    `${getSaturnBaseUrl()}/?search=${q}`,
    `${getSaturnBaseUrl()}/anime?search=${q}`,
  ];
  const out: AnimeSaturnResult[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    let html = '';
    try {
      html = await fetchResource(url, asCaches, {
        ttlMs: 2 * 60 * 1000,
        cacheKey: `as-search:${url}`,
        timeoutMs: AS_FETCH_TIMEOUT,
        headers: buildSaturnHeaders(`${getSaturnBaseUrl()}/`),
      });
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
      if (title && qRaw) {
        const t = normalizeUnicodeToAscii(title.toLowerCase());
        const qn = normalizeUnicodeToAscii(qRaw.toLowerCase());
        if (!t.includes(qn) && !qn.includes(t)) return;
      }
      out.push({ title, url: buildSaturnUrl(path) || `${getSaturnBaseUrl()}${path}` });
    });
    if (out.length) break;
  }
  return out;
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

function normalizeApostrophes(str: string): string {
  return str.replace(/['’‘]/g, "'");
}

function filterAnimeResults(
  results: { version: AnimeSaturnResult; language_type: string }[],
  englishTitle: string,
  malId?: string
) {
  const norm = (s: string) => normalizeApostrophes(normalizeUnicodeToAscii(s.toLowerCase().replace(/\s+/g, ' ').trim()));
  const clean = (s: string) => s.replace(/\s*\(.*?\)/g, '').replace(/\s*ita|\s*cr|\s*sub/gi, '').trim();
  const baseRaw = norm(englishTitle);
  const baseClean = clean(baseRaw);

  const isAllowed = (title: string) => {
    const tNorm = norm(title);
    const tClean = clean(tNorm);
    return (
      tNorm.includes(baseRaw) ||
      (baseClean.length > 0 && tNorm.includes(baseClean)) ||
      (baseClean.length > 0 && tClean.includes(baseClean))
    );
  };

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

function normalizeTitleForSearch(title: string): string {
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
  };
  const hasExact = Object.prototype.hasOwnProperty.call(exactMap, title);
  let normalized = hasExact ? exactMap[title] : title;

  if (!hasExact) {
    const generic: Record<string,string> = {
      'Attack on Titan': "L'attacco dei Giganti",
      'Season': '',
      'Shippuuden': 'Shippuden',
    };
    for (const [k,v] of Object.entries(generic)) {
      if (normalized.includes(k)) normalized = normalized.replace(k, v);
    }
    normalized = normalized.replace(/\s+-\s+/g,' ');
    if (normalized.includes('Naruto:')) normalized = normalized.replace(':','');
    normalized = normalized.replace(/\s{2,}/g,' ').trim();
  }
  return normalized;
}

function normalizeSpecialChars(str: string): string {
  return str
    .replace(/'/g, '\u2019')
    .replace(/:/g, '\u003A');
}

function normalizeUnicodeToAscii(str: string): string {
  return str
    .replace(/[\u2019\u2018'']/g, "'")
    .replace(/[\u201C\u201D""]/g, '"')
    .replace(/\u003A/g, ':');
}

export class AnimeSaturnProvider {
  private kitsuProvider = new KitsuProvider();
  private baseHost: string;
  constructor(private config: AnimeSaturnConfig) {
    this.baseHost = getDomain('animesaturn') || 'animesaturn.cx';
  }

  async searchAllVersions(title: string, malId?: string): Promise<{ version: AnimeSaturnResult; language_type: string }[]> {
    let results = await asSearch(title);
    if (malId && results.length === 0) {
      console.log('[AnimeSaturn] Nessun risultato con MAL ID, retry senza mal-id');
      results = await asSearch(title);
    }
    if (results.length <= 1 && title.includes("'")) {
      const titleTypo = title.replace(/'/g, '’');
      const moreResults = await asSearch(titleTypo);
      const seen = new Set(results.map(r => r.url));
      for (const r of moreResults) {
        if (!seen.has(r.url)) results.push(r);
      }
    }
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
      return { version: { ...r, title: r.title }, language_type };
    });
  }

  private async extractStreamsFromAnimePath(
    animePath: string,
    requestedEpisode: number,
    seasonNumber: number | null,
    mediaType = 'tv',
    originalEpisode: number | null = null
  ): Promise<StreamForStremio[]> {
    const normalizedPath = normalizeAnimeSaturnPath(animePath);
    if (!normalizedPath) return [];
    const animeUrl = buildSaturnUrl(normalizedPath);
    if (!animeUrl) return [];
    
    let parsedPage: ParsedSaturnPage;
    try {
      const html = await fetchResource(animeUrl, asCaches, {
        ttlMs: 15 * 60 * 1000,
        cacheKey: `anime:${normalizedPath}`,
        timeoutMs: AS_FETCH_TIMEOUT,
        headers: buildSaturnHeaders(),
      });
      parsedPage = parseAnimeSaturnPage(html, { animePath: normalizedPath });
    } catch (error: any) {
      console.error('[AnimeSaturn] anime page request failed:', error.message);
      return [];
    }

    const normalizedEpisode = normalizeRequestedEpisode(requestedEpisode);
    const normalizedOriginalEpisode = normalizeRequestedEpisode(
      originalEpisode === null || originalEpisode === undefined ? normalizedEpisode : originalEpisode
    );

    let episodes = normalizeEpisodesList(parsedPage.episodes);
    let selected = pickEpisodeEntry(episodes, normalizedEpisode, mediaType);

    const allowRelated = String(parsedPage.sourceTag || '').toUpperCase() !== 'ITA';
    if (allowRelated && (!selected || episodes.length === 0) && Array.isArray(parsedPage.relatedAnimePaths) && parsedPage.relatedAnimePaths.length > 0) {
      for (const related of parsedPage.relatedAnimePaths.slice(0, 2)) {
        try {
          const relatedUrl = buildSaturnUrl(related);
          if (!relatedUrl) continue;
          const html = await fetchResource(relatedUrl, asCaches, {
            ttlMs: 15 * 60 * 1000,
            cacheKey: `anime-related:${related}`,
            timeoutMs: AS_FETCH_TIMEOUT,
            headers: buildSaturnHeaders(),
          });
          const relatedParsed = parseAnimeSaturnPage(html, { animePath: related, title: parsedPage.title });
          episodes = mergeEpisodeLists(episodes, relatedParsed.episodes);
        } catch {
          // ignore related parse failure
        }
      }
      selected = pickEpisodeEntry(episodes, normalizedEpisode, mediaType);
    }

    if (!selected) return [];

    const baseTitle = sanitizeAnimeTitle(parsedPage.title) || 'Unknown Title';
    const resolvedEpisode = parsePositiveInt(selected.num) || normalizedEpisode;

    if (String(parsedPage.sourceTag || '').toUpperCase() === 'ITA' && resolvedEpisode !== normalizedOriginalEpisode) {
      console.log(`[AnimeSaturn] Skipping ITA episode ${resolvedEpisode} (requested ${normalizedOriginalEpisode}).`);
      return [];
    }

    const initialWatchUrls = await resolveWatchUrlsForEpisodeEntry(
      {
        animePath: normalizedPath,
        title: parsedPage.title,
        sourceTag: parsedPage.sourceTag,
        episodes,
      },
      selected
    );

    if (initialWatchUrls.length === 0) return [];
    
    const queue = [...initialWatchUrls];
    const visitedWatchUrls = new Set<string>();
    const streams: StreamForStremio[] = [];
    const seenMedia = new Set<string>();

    const expectedFileId = (() => {
      try {
        const parsed = new URL(initialWatchUrls[0]);
        return parsed.searchParams.get('file');
      } catch {
        return null;
      }
    })();

    let processed = 0;
    while (queue.length > 0 && processed < 6) {
      const watchUrl = queue.shift();
      if (!watchUrl || visitedWatchUrls.has(watchUrl)) continue;
      visitedWatchUrls.add(watchUrl);
      processed += 1;

      let html = '';
      try {
        html = await fetchResource(watchUrl, asCaches, {
          ttlMs: 5 * 60 * 1000,
          cacheKey: `watch:${watchUrl}`,
          timeoutMs: AS_FETCH_TIMEOUT,
          headers: {
            ...buildSaturnHeaders(animeUrl),
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'upgrade-insecure-requests': '1',
          },
        });
      } catch (error: any) {
        console.error('[AnimeSaturn] watch page request failed:', error.message);
        continue;
      }

      const embedUrl = extractEmbedUrlFromWatchHtml(html);
      if (embedUrl) {
        const resolved = await resolvePlaylistUrl(embedUrl);
        const mediaUrl = normalizePlayableMediaUrl(resolved, getSaturnBaseUrl());
        if (mediaUrl && !seenMedia.has(mediaUrl)) {
          seenMedia.add(mediaUrl);
          let quality = extractQualityHint(mediaUrl);
          if (mediaUrl.includes('.m3u8')) {
            const detected = await checkQualityFromPlaylist(mediaUrl, {
              'User-Agent': AS_USER_AGENT,
              Referer: watchUrl,
            });
            if (detected) quality = detected;
          }
          const host = normalizeHostLabel(mediaUrl);

          const sNum = seasonNumber !== undefined && seasonNumber !== null ? seasonNumber : 1;
          const langLabel = parsedPage.sourceTag === 'ITA' ? 'ITA' : 'SUB';
          let streamTitle = `${capitalize(baseTitle)} ▪ ${langLabel} ▪ S${sNum}`;
          if (mediaType !== 'movie' && requestedEpisode) {
            streamTitle += `E${requestedEpisode}`;
          }
          if (host) {
            streamTitle += ` (${host})`;
          }

          streams.push({
            title: streamTitle,
            url: mediaUrl,
            behaviorHints: {
              notWebReady: true,
              headers: {
                'User-Agent': AS_USER_AGENT,
                Referer: watchUrl,
              },
            },
          });
        } else {
          const hostLabel = 'SaturnCDN';
          const sNum = seasonNumber !== undefined && seasonNumber !== null ? seasonNumber : 1;
          const langLabel = parsedPage.sourceTag === 'ITA' ? 'ITA' : 'SUB';
          let streamTitle = `${capitalize(baseTitle)} ▪ ${langLabel} ▪ S${sNum}`;
          if (mediaType !== 'movie' && requestedEpisode) {
            streamTitle += `E${requestedEpisode}`;
          }
          streamTitle += ` (SaturnCDN)`;

          streams.push({
            title: streamTitle,
            url: embedUrl,
            behaviorHints: {
              notWebReady: true,
              headers: {
                'User-Agent': AS_USER_AGENT,
                Referer: watchUrl,
              },
            },
          });
        }
        continue;
      }

      const links = collectMediaLinksFromWatchHtml(html);
      for (const link of links) {
        const mediaUrl = normalizePlayableMediaUrl(link.href, getSaturnBaseUrl());
        if (!mediaUrl || seenMedia.has(mediaUrl)) continue;

        const lowerLink = mediaUrl.toLowerCase();
        if (lowerLink.endsWith('.mkv.mp4') || BLOCKED_DOMAINS.some((domain) => lowerLink.includes(domain))) {
          continue;
        }
        seenMedia.add(mediaUrl);
        let quality = extractQualityHint(mediaUrl);
        if (lowerLink.includes('.m3u8')) {
          const detected = await checkQualityFromPlaylist(mediaUrl, {
            'User-Agent': AS_USER_AGENT,
            Referer: watchUrl,
          });
          if (detected) quality = detected;
        }
        const hostLabel = normalizeHostLabel(mediaUrl);

        const sNum = seasonNumber !== undefined && seasonNumber !== null ? seasonNumber : 1;
        const langLabel = parsedPage.sourceTag === 'ITA' ? 'ITA' : 'SUB';
        let streamTitle = `${capitalize(baseTitle)} ▪ ${langLabel} ▪ S${sNum}`;
        if (mediaType !== 'movie' && requestedEpisode) {
          streamTitle += `E${requestedEpisode}`;
        }
        if (hostLabel) {
          streamTitle += ` (${hostLabel})`;
        }

        streams.push({
          title: streamTitle,
          url: mediaUrl,
          behaviorHints: {
            notWebReady: true,
            headers: {
              'User-Agent': AS_USER_AGENT,
              Referer: watchUrl,
            },
          },
        });
      }

      const extraWatchUrls = extractWatchUrlsFromHtml(html, expectedFileId);
      for (const extra of extraWatchUrls) {
        if (!visitedWatchUrls.has(extra)) queue.push(extra);
      }
    }

    return streams;
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
    if (!lookup) {
      console.log('[AnimeSaturn][Mapping] resolveLookupRequest returned null for id:', id);
      return [];
    }

    console.log('[AnimeSaturn][Mapping] lookup:', JSON.stringify(lookup));
    const extendedContext = {
      ...providerContext,
      mappingLanguage: 'it',
      easyCatalogsLangIt: true,
    };
    let mappingPayload = await fetchMappingPayload(lookup, asCaches, 'AnimeSaturn', extendedContext);
    let animePaths = extractProviderPaths(mappingPayload, 'animesaturn', normalizeAnimeSaturnPath as any);
    console.log('[AnimeSaturn][Mapping] paths from mapping API:', animePaths);

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
        const tmdbPayload = await fetchMappingPayload(tmdbLookup, asCaches, 'AnimeSaturn', extendedContext);
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
      const perPath = await this.extractStreamsFromAnimePath(
        path,
        requestedEpisode,
        seasonNumber,
        isMovie ? 'movie' : 'tv',
        lookup.episode
      );
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

  async handleKitsuRequest(kitsuIdString: string): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) {
      return { streams: [] };
    }
    try {
      const { kitsuId, seasonNumber, episodeNumber, isMovie } = this.kitsuProvider.parseKitsuId(kitsuIdString);
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
      const fromMapping = await this.getStreamsFromMapping(
        `kitsu:${kitsuId}`, seasonNumber, episodeNumber, isMovie, { kitsuId }, quickTitle
      );
      if (fromMapping.length) {
        console.log('[AnimeSaturn] Mapping hit (Kitsu): skipped heavy title resolution.');
        return { streams: fromMapping };
      }
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
      const gateEnabled = (process.env.ANIME_GATE_ENABLED || 'true') !== 'false';
      if (gateEnabled) {
        const gate = await checkIsAnimeById('imdb', imdbId, this.config.tmdbApiKey, isMovie ? 'movie' : 'tv');
        if (!gate.isAnime) {
          console.log(`[AnimeSaturn] Skipping anime search: no MAL/Kitsu mapping (${gate.reason}) for ${imdbId}`);
          return { streams: [] };
        }
      }
      const imdbIdClean = imdbId.split(':')[0];
      const fromMappingImdb = await this.getStreamsFromMapping(
        imdbIdClean, seasonNumber, episodeNumber, isMovie, { imdbId: imdbIdClean }, ''
      );
      if (fromMappingImdb.length) {
        console.log('[AnimeSaturn] Mapping hit (IMDB): skipped title resolution.');
        return { streams: fromMappingImdb };
      }
      console.log('[AnimeSaturn] Mapping miss (IMDB): fallback a ricerca per titolo per', imdbIdClean);
      const englishTitle = await getEnglishTitleFromAnyId(imdbId, 'imdb', this.config.tmdbApiKey);
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
      const gateEnabled = (process.env.ANIME_GATE_ENABLED || 'true') !== 'false';
      if (gateEnabled) {
        const gate = await checkIsAnimeById('tmdb', tmdbId, this.config.tmdbApiKey, isMovie ? 'movie' : 'tv');
        if (!gate.isAnime) {
          console.log(`[AnimeSaturn] Skipping anime search: no MAL/Kitsu mapping (${gate.reason}) for TMDB ${tmdbId}`);
          return { streams: [] };
        }
      }
      const fromMappingTmdb = await this.getStreamsFromMapping(
        `tmdb:${tmdbId}`, seasonNumber, episodeNumber, isMovie, { tmdbId }, ''
      );
      if (fromMappingTmdb.length) {
        console.log('[AnimeSaturn] Mapping hit (TMDB): skipped title resolution.');
        return { streams: fromMappingTmdb };
      }
      console.log('[AnimeSaturn] Mapping miss (TMDB): fallback a ricerca per titolo per TMDB', tmdbId);
      const englishTitle = await getEnglishTitleFromAnyId(tmdbId, 'tmdb', this.config.tmdbApiKey);
      let malId: string | undefined = undefined;
      try {
        const tmdbKey = this.config.tmdbApiKey || process.env.TMDB_API_KEY || '';
        const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json();
        malId = haglundResp[0]?.myanimelist?.toString() || undefined;
      } catch {}
      return this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie, malId);
    } catch (error) {
      console.error('Error handling TMDB request:', error);
      return { streams: [] };
    }
  }

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
    const seen = new Set<string>();
    for (const { version } of animeVersions) {
      const path = normalizeAnimeSaturnPath(version.url);
      if (!path) continue;
      
      const perPath = await this.extractStreamsFromAnimePath(
        path,
        episodeNumber ?? 1,
        seasonNumber,
        isMovie ? 'movie' : 'tv',
        episodeNumber ?? 1
      );
      for (const st of perPath) {
        const key = String(st.url || '').trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        streams.push(st);
      }
    }
    return { streams };
  }
}

function capitalize(str: string) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
