// Centralized proxy list + round-robin helper for extractors.
// Populate / modify this list with Webshare (or other) rotating proxies.
// Format: protocol://user:pass@host:port/ 
// Keep it small & curated; extractor will only try max 2 per call.

export const PROXIES: string[] = [
  // Example entries (replace with real ones)
  'http://emaschipx-rotate:emaschipx@p.webshare.io:80/',
  'http://proxooo4-rotate:proxooo4@p.webshare.io:80/',
  'http://fabiorealdebrid-rotate:MammamiaHF1@p.webshare.io:80/',
  'http://proxoooo-rotate:proxoooo@p.webshare.io:80/',
  'http://teststremio-rotate:teststremio@p.webshare.io:80/',
  'http://mammapro-rotate:mammapro@p.webshare.io:80/',
  'http://iuhcxjzk-rotate:b3oqk3q40awp@p.webshare.io:80/',
  'http://zmjoluhu-rotate:ej6ddw3ily90@p.webshare.io:80/',
  'http://kkuafwyh-rotate:kl6esmu21js3@p.webshare.io:80/',
  'http://stzaxffz-rotate:ax92ravj1pmm@p.webshare.io:80/',
  'http://nfokjhhu-rotate:ez248bgee4z9@p.webshare.io:80/',
  'http://fiupzkjx-rotate:0zlrd2in3mrh@p.webshare.io:80/',
  'http://tpnvndgp-rotate:xjp0ux1wwc7n@p.webshare.io:80/',
  'http://tmglotxc-rotate:stlrhx17nhqj@p.webshare.io:80/',
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
