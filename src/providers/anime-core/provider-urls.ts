/**
 * anime-core/provider-urls.ts
 * Dynamic provider URL resolution from JSON file + environment variables.
 * Ported 1:1 from easystreams-main provider_urls.js.
 *
 * Reload strategy:
 * - Local JSON file checked every 1.5 s (stat mtime)
 * - Remote JSON refreshed every 10 s from configurable URL
 */

import * as fs from 'fs';
import * as path from 'path';
import { getDomain } from '../../utils/domains';

// ─── Configuration ──────────────────────────────────────────

const PROVIDER_URLS_FILE: string = process.env.PROVIDER_URLS_FILE
  ? path.resolve(process.env.PROVIDER_URLS_FILE)
  : path.resolve(__dirname, '..', '..', '..', 'config', 'provider_urls.json');

const RELOAD_INTERVAL_MS = Number.parseInt(process.env.PROVIDER_URLS_RELOAD_MS || '1500', 10) || 1500;

const DEFAULT_PROVIDER_URLS_URL =
  'https://raw.githubusercontent.com/realbestia1/easystreams/refs/heads/main/provider_urls.json';
const PROVIDER_URLS_URL = String(process.env.PROVIDER_URLS_URL || DEFAULT_PROVIDER_URLS_URL).trim();

const REMOTE_RELOAD_INTERVAL_MS =
  Number.parseInt(process.env.PROVIDER_URLS_REMOTE_RELOAD_MS || '10000', 10) || 10000;
const REMOTE_FETCH_TIMEOUT_MS =
  Number.parseInt(process.env.PROVIDER_URLS_REMOTE_TIMEOUT_MS || '5000', 10) || 5000;

// ─── Alias map (same as easystreams) ────────────────────────

const ALIASES: Record<string, string[]> = {
  animeunity: ['animeunuty', 'anime_unity'],
  animeworld: ['anime_world'],
  animesaturn: ['anime_saturn'],
  streamingcommunity: ['streaming_community'],
  guardahd: ['guarda_hd'],
  guardaserie: ['guarda_serie'],
  guardoserie: ['guardo_serie'],
  mapping_api: ['mappingapi', 'mapping_api_url', 'mapping_url'],
};

const DOMAIN_KEY_MAP: Record<string, string> = {
  animeunity: 'animeunity',
  animeworld: 'animeworld',
  animesaturn: 'animesaturn',
  streamingcommunity: 'vixsrc',
  guardahd: 'guardahd',
  guardaserie: 'guardaserie',
  guardoserie: 'guardoserie',
};

// ─── Internal state ─────────────────────────────────────────

let lastCheckAt = 0;
let lastMtimeMs = -1;
let lastData: Record<string, string> = {};
let lastRemoteCheckAt = 0;
let remoteInFlight: Promise<void> | null = null;

// ─── Helpers ────────────────────────────────────────────────

function normalizeKey(key: string): string {
  return String(key || '').trim().toLowerCase();
}

function normalizeUrl(value: string | undefined): string {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.replace(/\/+$/, '');
}

function toNormalizedMap(raw: any): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const nk = normalizeKey(key);
    const nv = normalizeUrl(value as string);
    if (!nk || !nv) continue;
    out[nk] = nv;
  }
  return out;
}

// ─── Local file reload ──────────────────────────────────────

function reloadProviderUrlsIfNeeded(force = false): void {
  const now = Date.now();
  if (!force && now - lastCheckAt < RELOAD_INTERVAL_MS) return;
  lastCheckAt = now;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(PROVIDER_URLS_FILE);
  } catch {
    if (lastMtimeMs !== -1) {
      lastMtimeMs = -1;
      lastData = {};
    }
    return;
  }

  if (!force && stat.mtimeMs === lastMtimeMs) return;

  try {
    const raw = fs.readFileSync(PROVIDER_URLS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    lastData = toNormalizedMap(parsed);
    lastMtimeMs = stat.mtimeMs;
  } catch {
    lastData = {};
    lastMtimeMs = stat.mtimeMs;
  }
}

// ─── Remote refresh ─────────────────────────────────────────

async function refreshProviderUrlsFromRemoteIfNeeded(force = false): Promise<void> {
  if (!PROVIDER_URLS_URL) return;
  if (remoteInFlight) return;

  const now = Date.now();
  if (!force && now - lastRemoteCheckAt < REMOTE_RELOAD_INTERVAL_MS) return;
  lastRemoteCheckAt = now;

  remoteInFlight = (async () => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REMOTE_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(PROVIDER_URLS_URL, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response || !response.ok) return;
      const payload = await response.json();
      const parsed = toNormalizedMap(payload);
      if (Object.keys(parsed).length > 0) {
        lastData = parsed;
      }
    } catch {
      // Ignore remote refresh errors — keep last known values.
    } finally {
      clearTimeout(timeoutId);
      remoteInFlight = null;
    }
  })();
}

// ─── Public API ─────────────────────────────────────────────

function findFromJson(providerKey: string): string {
  reloadProviderUrlsIfNeeded(false);
  // Fire-and-forget remote refresh (non-blocking)
  refreshProviderUrlsFromRemoteIfNeeded(false);

  const key = normalizeKey(providerKey);
  const candidates = [key, ...(ALIASES[key] || [])].map(normalizeKey);
  for (const candidate of candidates) {
    const value = normalizeUrl(lastData[candidate]);
    if (value) return value;
  }
  return '';
}

function findFromEnv(envKeys: string[] = []): string {
  for (const envKey of envKeys) {
    const value = normalizeUrl(process.env[envKey]);
    if (value) return value;
  }
  return '';
}

function findFromDomains(providerKey: string): string {
  const key = normalizeKey(providerKey);
  const candidates = [key, ...(ALIASES[key] || [])].map(normalizeKey);
  for (const candidate of candidates) {
    const domainKey = DOMAIN_KEY_MAP[candidate];
    if (!domainKey) continue;
    const host = String(getDomain(domainKey) || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    if (!host) continue;
    return `https://${host}`;
  }
  return '';
}

/**
 * Resolve a provider URL.
 * Checks local JSON file first, then environment variables.
 */
export function getProviderUrl(providerKey: string, envKeys: string[] = []): string {
  const safeEnvKeys = Array.isArray(envKeys) ? envKeys : [];
  const fromDomains = findFromDomains(providerKey);
  if (fromDomains) return fromDomains;
  const fromJson = findFromJson(providerKey);
  if (fromJson) return fromJson;
  const fromEnv = findFromEnv(safeEnvKeys);
  if (fromEnv) return fromEnv;
  return '';
}

/**
 * Shortcut: get the Mapping API base URL (no trailing slash).
 */
export function getMappingApiBase(): string {
  return getProviderUrl('mapping_api', ['MAPPING_API_URL']).replace(/\/+$/, '');
}

/**
 * Get the path to the provider_urls.json file (for debugging/logging).
 */
export function getProviderUrlsFilePath(): string {
  return PROVIDER_URLS_FILE;
}
