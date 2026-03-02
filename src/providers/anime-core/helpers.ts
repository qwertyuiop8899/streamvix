/**
 * anime-core/helpers.ts
 * Shared utility functions ported 1:1 from easystreams-main.
 * Used by all 3 anime providers for episode/season normalization,
 * URL handling, title sanitization, and concurrency control.
 */

// ─── Numeric helpers ────────────────────────────────────────

/**
 * Parse a value to a positive integer (> 0). Returns null otherwise.
 */
export function parsePositiveInt(value: any): number | null {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Normalize a requested episode number. Falls back to 1 if invalid.
 */
export function normalizeRequestedEpisode(value: any): number {
  const parsed = parsePositiveInt(value);
  return parsed || 1;
}

/**
 * Normalize a requested season number. Returns null if invalid.
 * Season 0 is valid (specials).
 */
export function normalizeRequestedSeason(value: any): number | null {
  const parsed = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Parse an episode number from a string (first sequence of 1-4 digits).
 */
export function parseEpisodeNumber(value: any, fallbackNum: number): number {
  const text = String(value || '').trim();
  const match = text.match(/(\d{1,4})/);
  if (match) {
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallbackNum;
}

// ─── URL helpers ────────────────────────────────────────────

/**
 * Convert a relative or protocol-relative URL to absolute.
 * Uses the given baseUrl as the resolution base.
 */
export function toAbsoluteUrl(href: string | null | undefined, baseUrl: string): string | null {
  if (!href) return null;
  const trimmed = String(href).trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('//')) return `https:${trimmed}`;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Check if a URL/path points to a directly playable media file (.mp4 / .m3u8).
 */
export function isDirectMediaPath(value: string | null | undefined): boolean {
  const text = String(value || '').trim();
  if (!text) return false;

  if (!/^https?:\/\//i.test(text)) {
    return /\.(?:mp4|m3u8)(?:[?#].*)?$/i.test(text);
  }

  try {
    const parsed = new URL(text);
    const path = String(parsed.pathname || '').toLowerCase();
    return path.endsWith('.mp4') || path.endsWith('.m3u8');
  } catch {
    return /\.(?:mp4|m3u8)(?:[?#].*)?$/i.test(text);
  }
}

/**
 * Normalize a raw URL to a playable media URL, resolving nested query-string redirects.
 * Returns null if the URL does not point to a playable media resource.
 * Ported 1:1 from easystreams normalizePlayableMediaUrl().
 *
 * @param rawUrl  - The URL to normalize
 * @param baseUrl - Base URL for resolving relative paths
 * @param depth   - Recursion depth (max 1)
 */
export function normalizePlayableMediaUrl(
  rawUrl: string | null | undefined,
  baseUrl: string,
  depth = 0
): string | null {
  const absolute = toAbsoluteUrl(rawUrl, baseUrl);
  if (!absolute) return null;
  if (isDirectMediaPath(absolute)) return absolute;
  if (depth >= 1) return null;

  let parsed: URL;
  try {
    parsed = new URL(absolute);
  } catch {
    return null;
  }

  const path = String(parsed.pathname || '').toLowerCase();
  if (path.endsWith('.mp4') || path.endsWith('.m3u8')) return parsed.toString();

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

    const nestedUrl = normalizePlayableMediaUrl(decoded, baseUrl, depth + 1);
    if (nestedUrl) return nestedUrl;
  }

  return null;
}

// ─── Title helpers ──────────────────────────────────────────

/**
 * Sanitize an anime title by removing site-specific suffixes and language markers.
 * Ported from easystreams sanitizeAnimeTitle().
 */
export function sanitizeAnimeTitle(rawTitle: string | null | undefined): string | null {
  let text = String(rawTitle || '').trim();
  if (!text) return null;

  text = text
    .replace(/\s*-\s*AnimeUnity.*$/i, '')
    .replace(/\s*-\s*AnimeWorld.*$/i, '')
    .replace(/\s*-\s*AnimeSaturn.*$/i, '')
    .replace(/\s+Streaming.*$/i, '')
    .trim();

  // Remove language markers
  text = text
    .replace(/\s*[\[(]\s*(?:SUB\s*ITA|ITA|SUB|DUB(?:BED)?|DOPPIATO)\s*[\])]\s*/gi, ' ')
    .replace(/\s*[-–_|:]\s*(?:SUB\s*ITA|ITA|SUB|DUB(?:BED)?|DOPPIATO)\s*$/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[-–_|:]\s*$/g, '')
    .trim();

  return text || null;
}

/**
 * Infer a language source tag from title and path.
 * Returns 'ITA' if Italian dub markers found, otherwise 'SUB'.
 */
export function inferSourceTag(title: string | null | undefined, animePath: string | null | undefined): string {
  const titleText = String(title || '').toLowerCase();
  const pathText = String(animePath || '').toLowerCase();
  if (/(?:^|[^\w])ita(?:[^\w]|$)/i.test(titleText)) return 'ITA';
  if (/(?:^|[-_/])ita(?:[-_/]|$)/i.test(pathText)) return 'ITA';
  return 'SUB';
}

/**
 * Convert a source tag to a language emoji.
 */
export function resolveLanguageEmoji(sourceTag: string | null | undefined): string {
  return String(sourceTag || '').toUpperCase() === 'ITA' ? '🇮🇹' : '🇯🇵';
}

/**
 * Extract a quality hint from a URL or filename (e.g. "1080p", "720p").
 */
export function extractQualityHint(value: string | null | undefined): string {
  const text = String(value || '');
  const match = text.match(/(\d{3,4}p)/i);
  return match ? match[1] : 'Unknown';
}

/**
 * Normalize a host label from a URL for display purposes.
 */
export function normalizeHostLabel(url: string): string | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').split('.')[0];
    return host.charAt(0).toUpperCase() + host.slice(1);
  } catch {
    return null;
  }
}

// ─── Concurrency ────────────────────────────────────────────

/**
 * Execute async tasks with limited concurrency.
 * Ported 1:1 from easystreams mapLimit().
 */
export async function mapLimit<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  if (!Array.isArray(values) || values.length === 0) return [];
  const concurrency = Math.max(1, Math.min(limit, values.length));
  const output: R[] = new Array(values.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const current = cursor;
      cursor += 1;
      try {
        output[current] = await mapper(values[current], current);
      } catch (error: any) {
        output[current] = [] as any;
        console.error('[mapLimit] task failed:', error.message);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return output;
}

// ─── Episode list helpers ───────────────────────────────────

/** Normalized episode entry (provider-agnostic structure) */
export interface NormalizedEpisode {
  num: number;
  token: string;
  episodeId: number | null;
  scwsId: number | null;
  link: string | null;
  fileName: string | null;
  embedUrl: string | null;
}

/**
 * Normalize a raw episodes array into a sorted, deduplicated list.
 * Ported 1:1 from easystreams normalizeEpisodesList().
 */
export function normalizeEpisodesList(
  sourceEpisodes: any[],
  baseUrl: string
): NormalizedEpisode[] {
  if (!Array.isArray(sourceEpisodes) || sourceEpisodes.length === 0) return [];
  const out: NormalizedEpisode[] = [];
  const seen = new Set<string>();

  for (let index = 0; index < sourceEpisodes.length; index += 1) {
    const entry = sourceEpisodes[index] || {};
    const numRaw = Number.parseInt(String(entry.num ?? index + 1), 10);
    const num = Number.isFinite(numRaw) && numRaw > 0 ? numRaw : index + 1;
    const episodeId = parsePositiveInt(entry.episodeId ?? entry.id) ?? null;
    const scwsId = parsePositiveInt(entry.scwsId ?? entry.scws_id) ?? null;
    const token =
      String(
        entry.token ||
          (episodeId ? `ep:${episodeId}` : scwsId ? `scws:${scwsId}` : `ep-${num}`)
      ).trim() || `ep-${num}`;
    const link = toAbsoluteUrl(entry.link || entry.file_name || null, baseUrl);
    const fileName = String(entry.fileName || entry.file_name || entry.link || '').trim() || null;
    const embedUrl = toAbsoluteUrl(entry.embedUrl || entry.embed_url || null, baseUrl);
    const key = `${num}|${episodeId || ''}|${scwsId || ''}|${token}|${link || ''}|${fileName || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ num, token, episodeId, scwsId, link, fileName, embedUrl });
  }

  out.sort((a, b) => a.num - b.num);
  return out;
}

/**
 * Pick the best episode entry matching the requested episode number.
 * Ported 1:1 from easystreams pickEpisodeEntry().
 */
export function pickEpisodeEntry(
  episodes: NormalizedEpisode[],
  requestedEpisode: number | string | null | undefined,
  mediaType: 'tv' | 'movie' = 'tv'
): NormalizedEpisode | null {
  const list = episodes;
  if (list.length === 0) return null;

  const episodeNum = normalizeRequestedEpisode(requestedEpisode);

  // For movies, return the first episode
  if (mediaType === 'movie') return list[0];

  // By episode number
  const byNum = list.find((entry) => entry.num === episodeNum);
  if (byNum) return byNum;

  // By index (0-based → episode-1)
  const byIndex = list[episodeNum - 1];
  if (byIndex) return byIndex;

  // Single episode → return it
  if (list.length === 1) return list[0];

  // Episode 1 fallback
  const first = list.find((entry) => entry.num === 1);
  if (episodeNum === 1 && first) return first;

  return null;
}

// ─── HTML/Media helpers ─────────────────────────────────────

/** List of domains known to serve broken/blocked content */
export const BLOCKED_DOMAINS = [
  'jujutsukaisenanime.com',
  'onepunchman.it',
  'dragonballhd.it',
  'narutolegend.it',
];

/**
 * Collect playable media links from an HTML embed page.
 * Ported 1:1 from easystreams collectMediaLinksFromEmbedHtml().
 */
export function collectMediaLinksFromEmbedHtml(
  html: string,
  baseUrl: string
): { href: string; label: string }[] {
  const links: { href: string; label: string }[] = [];
  const seen = new Set<string>();

  function addLink(href: string, label: string): void {
    const playable = normalizePlayableMediaUrl(href, baseUrl);
    if (!playable || seen.has(playable)) return;
    seen.add(playable);
    links.push({ href: playable, label });
  }

  const raw = String(html || '');
  const variants = [raw, raw.replace(/\\\//g, '/')];

  for (const text of variants) {
    // Download URL
    const downloadRegex = /window\.downloadUrl\s*=\s*["']([^"']+)["']/gi;
    let match: RegExpExecArray | null;
    while ((match = downloadRegex.exec(text)) !== null) {
      addLink(match[1], 'Download diretto');
    }

    // Direct media URLs
    const directRegex = /https?:\/\/[^\s"'<>\\]+(?:\.mp4|\.m3u8)(?:[^\s"'<>\\]*)?/gi;
    while ((match = directRegex.exec(text)) !== null) {
      addLink(match[0], 'Player');
    }

    // URL-encoded media URLs
    const encodedUrlRegex = /https%3A%2F%2F[^\s"'<>\\]+/gi;
    while ((match = encodedUrlRegex.exec(text)) !== null) {
      try {
        addLink(decodeURIComponent(match[0]), 'Player');
      } catch {
        // ignore malformed encoded URLs
      }
    }

    // Attribute-based media URLs
    const fileRegex = /(?:file|src|url|link)\s*[:=]\s*["']([^"']+)["']/gi;
    while ((match = fileRegex.exec(text)) !== null) {
      addLink(match[1], 'Player');
    }
  }

  return links;
}
