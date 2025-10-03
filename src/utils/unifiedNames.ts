// Centralized unified naming utilities for all non-live TV streams
// Provides functions to build multi-line descriptive stream names.
// Live TV naming should NOT import or use these helpers (as per requirement).

export interface UnifiedNameOptions {
  baseTitle: string; // Raw title already including season/episode markers if needed
  isSub: boolean; // true => [SUB], false => [ITA]
  sizeBytes?: number; // Optional size indicator
  playerName?: string; // Optional player name (host or extractor)
  proxyOn: boolean; // Whether the delivered stream goes through proxy
  provider: string; // Provider key (vixsrc, animeunity, etc.)
  isFhdOrDual?: boolean; // Tag provider with HD marker (VixSrc dual/FHD etc.)
}

export function formatBytesHuman(b?: number): string {
  if (!b || b <= 0) return '';
  const units = ['B','KB','MB','GB','TB'];
  let i = 0; let v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const num = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${num} ${units[i]}`;
}

export function providerLabel(provider: string, isFhd?: boolean): string {
  switch (provider) {
    case 'vixsrc': return `🤌 VixSrc 🍿${isFhd ? ' 🅵🅷🅳' : ''}`;
    case 'animeunity': return '🤌 Anime Unity ⛩️';
    case 'animesaturn': return '🤌 Anime Saturn 🪐';
    case 'animeworld': return '🤌 Anime World 🌍';
    case 'guardaserie': return '🤌 GuardaSerie 🎥';
    case 'guardahd': return '🤌 GuardaHD 🎬';
    case 'cb01': return '🤌 CB01 🎞️';
    case 'streamingwatch': return '🤌 StreamingWatch 📼';
    case 'eurostreaming': return '🤌 Eurostreaming';
    default: return provider;
  }
}

export function buildUnifiedStreamName(opts: UnifiedNameOptions): string {
  const lines: string[] = [];
  lines.push(`🎬 ${opts.baseTitle}`);
  lines.push(`🗣 ${opts.isSub ? '[SUB]' : '[ITA]'}`);
  if (opts.sizeBytes) {
    const sz = formatBytesHuman(opts.sizeBytes);
    if (sz) lines.push(`💾 ${sz}`);
  }
  if (opts.playerName) lines.push(`▶️ ${opts.playerName}`);
  lines.push(`🌐 Proxy (${opts.proxyOn ? 'ON' : 'OFF'})`);
  lines.push(providerLabel(opts.provider, opts.isFhdOrDual));
  return lines.join('\n');
}

// Simple legacy name mapping helper for transitional phase
// Converts legacy addon.ts provider name strings (e.g. 'StreamViX AU') into new label.
export function mapLegacyProviderName(legacy: string): string {
  const lower = legacy.toLowerCase();
  if (lower.includes('streamvix vx')) return providerLabel('vixsrc');
  if (lower.includes('streamvix au')) return providerLabel('animeunity');
  if (lower.includes('streamvix as')) return providerLabel('animesaturn');
  if (lower.includes('streamvix aw')) return providerLabel('animeworld');
  if (lower.includes('streamvix gs')) return providerLabel('guardaserie');
  if (lower.includes('streamvix gh')) return providerLabel('guardahd');
  if (lower.includes('streamvix cb')) return providerLabel('cb01');
  if (lower.includes('streamvix sw')) return providerLabel('streamingwatch');
  if (lower.includes('streamvix es')) return providerLabel('eurostreaming');
  return legacy;
}
