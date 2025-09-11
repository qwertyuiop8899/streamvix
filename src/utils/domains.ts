import fs from 'fs';
import path from 'path';

let domainCache: Record<string, string> | null = null;
let lastLoad = 0; // epoch ms
const TTL_MS = 12 * 60 * 60 * 1000; // 12 ore

function _readDomainsFile(): Record<string, string> {
  try {
    const p = path.join(__dirname, '..', '..', 'config', 'domains.json');
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Record<string, string>;
  } catch {
    /* ignore */
  }
  return {};
}

function loadDomains(): Record<string, string> {
  const now = Date.now();
  if (!domainCache || (now - lastLoad) > TTL_MS) {
    domainCache = _readDomainsFile();
    lastLoad = now;
  }
  return domainCache;
}

export function forceReloadDomains(): void {
  domainCache = null;
  lastLoad = 0;
  loadDomains();
}

export function getDomain(key: string): string | undefined {
  const map = loadDomains();
  return map[key];
}

export function getFullUrl(key: string, protocol: 'https'|'http' = 'https'): string | undefined {
  const host = getDomain(key);
  if (!host) return undefined;
  return `${protocol}://${host}`;
}
