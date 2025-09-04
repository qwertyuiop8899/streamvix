import fs from 'fs';
import path from 'path';

let domainCache: Record<string, string> | null = null;

function loadDomains(): Record<string, string> {
  if (domainCache) return domainCache;
  try {
    const p = path.join(__dirname, '..', '..', 'config', 'domains.json');
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      domainCache = parsed as Record<string, string>;
    } else {
      domainCache = {};
    }
  } catch (e) {
    domainCache = {};
  }
  return domainCache || {};
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
