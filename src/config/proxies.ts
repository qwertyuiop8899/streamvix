// Centralized proxy list + round-robin helper for extractors.
// Populate / modify this list with Webshare (or other) rotating proxies.
// Format: protocol://user:pass@host:port/ 
// Keep it small & curated; extractor will only try max 2 per call.

export const PROXIES: string[] = [
  // Example entries (replace with real ones)
];

let rr = 0;
export function nextProxyPair(): string[] {
  if (!PROXIES.length) return [];
  const a = rr % PROXIES.length; rr++;
  if (PROXIES.length === 1) return [PROXIES[a]];
  const b = rr % PROXIES.length; rr++;
  if (a === b) return [PROXIES[a]]; // edge if length=1
  return [PROXIES[a], PROXIES[b]];
}
