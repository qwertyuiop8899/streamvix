import axios from 'axios';

/**
 * Runtime resolver per canali Freeshot -> beautifulpeople.lovecdn.ru
 * Genera token ad ogni richiesta (token effimero) senza persistenza.
 * Inserisce una mini-cache opzionale (TTL 20s) per evitare doppie risoluzioni immediate.
 */

interface FreeShotResolved {
  code: string;
  url?: string; // m3u8 finale
  token?: string;
  error?: string;
  resolvedAt: number;
  matchHint?: string; // info su quale chiave ha fatto match (debug)
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
const TTL_MS = 20_000; // cache breve
const cache = new Map<string, FreeShotResolved>();

// Mappa id/nome normalizzato -> codice Freeshot (path dopo host)
// NOTA: normalizzeremo id/nome a minuscolo senza spazi e caratteri speciali
export const FREESHOT_CODE_MAP: Record<string, string> = {
  skysportuno: 'SkySportUnoIT',
  skysportarena: 'SkySportArenaIT',
  skysportmax: 'SkySportMaxIT',
  skysporttennis: 'SkySportTennisIT',
  skysport24: 'SkySport24IT',
  skysportf1: 'SkySportF1IT',
  skysportmotogp: 'SkySportMotoGPIT',
  skysportgolf: 'SkySportGolfIT',
  skysportcalcio: 'SkySportCalcioIT',
  dazn1: 'ZonaDAZN',
  dazn: 'ZonaDAZN',
  zonadazn: 'ZonaDAZN'
};

// Nome visuale canonico da usare nel titolo dello stream (se diverso dal code o se evento ha nome lungo)
const FREESHOT_DISPLAY_NAME: Record<string, string> = {
  SkySportUnoIT: 'Sky Sport Uno',
  SkySportArenaIT: 'Sky Sport Arena',
  SkySportMaxIT: 'Sky Sport Max',
  SkySportTennisIT: 'Sky Sport Tennis',
  SkySport24IT: 'Sky Sport 24',
  SkySportF1IT: 'Sky Sport F1',
  SkySportMotoGPIT: 'Sky Sport MotoGP',
  SkySportGolfIT: 'Sky Sport Golf',
  SkySportCalcioIT: 'Sky Sport Calcio',
  ZonaDAZN: 'Zona DAZN'
};

function normalizeKey(s?: string): string | null {
  if (!s || typeof s !== 'string') return null;
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

async function fetchFreeshot(code: string): Promise<FreeShotResolved> {
  const ret: FreeShotResolved = { code, resolvedAt: Date.now() };
  try {
    const urlAuth = `https://popcdn.day/go.php?stream=${encodeURIComponent(code)}`;
    const html = await axios.get(urlAuth, {
      timeout: 15000,
      headers: {
        'User-Agent': UA,
        'Referer': `https://freeshot.live/embed/${code}.php`,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });
    const body = html.data as string;
    const iframeMatch = body.match(/frameborder="0"\s+src="([^"]+)"/i);
    if (!iframeMatch) {
      ret.error = 'iframe non trovato';
      return ret;
    }
    const iframeUrl = iframeMatch[1];
    const tokenMatch = iframeUrl.match(/token=([A-Za-z0-9_-]+)/);
    if (!tokenMatch) {
      ret.error = 'token non trovato';
      return ret;
    }
    const token = tokenMatch[1];
    ret.token = token;
    ret.url = `https://beautifulpeople.lovecdn.ru/${code}/index.fmp4.m3u8?token=${token}`;
    return ret;
  } catch (e: any) {
    ret.error = e?.message || String(e);
    return ret;
  }
}

export async function resolveFreeshotForChannel(channel: { id?: string; name?: string; epgChannelIds?: string[]; extraTexts?: string[] }): Promise<FreeShotResolved | null> {
  const idKey = normalizeKey(channel.id);
  const nameKey = normalizeKey(channel.name);
  let code: string | undefined;
  let matchHint = '';

  // 1. Match diretto per id
  if (!code && idKey && FREESHOT_CODE_MAP[idKey]) { code = FREESHOT_CODE_MAP[idKey]; matchHint = `id:${idKey}`; }
  // 2. Match diretto per name
  if (!code && nameKey && FREESHOT_CODE_MAP[nameKey]) { code = FREESHOT_CODE_MAP[nameKey]; matchHint = `name:${nameKey}`; }
  // 3. epgChannelIds (lista): prova ogni id normalizzato
  if (!code && Array.isArray((channel as any).epgChannelIds)) {
    for (const epg of (channel as any).epgChannelIds) {
      const ek = normalizeKey(epg);
      if (ek && FREESHOT_CODE_MAP[ek]) { code = FREESHOT_CODE_MAP[ek]; matchHint = `epg:${ek}`; break; }
    }
  }
  // Helper per verificare se un testo contiene marker italiano
  const hasItaMarker = (txt: string) => /(\b(it|ita|italia|italian)\b|🇮🇹)/i.test(txt);

  // 4. Substring match su name (con regola speciale per DAZN: richiede marker italiano)
  const keysOrdered = Object.keys(FREESHOT_CODE_MAP).sort((a,b)=>b.length - a.length);
  if (!code && nameKey) {
    for (const k of keysOrdered) {
      if (nameKey.includes(k)) {
        const candidate = FREESHOT_CODE_MAP[k];
        const rawName = channel.name || '';
        if (/^ZonaDAZN$/i.test(candidate) || /dazn/i.test(k)) {
          if (!hasItaMarker(rawName)) continue; // salta se non chiaramente italiano
        }
        code = candidate; matchHint = `substrName:${k}`; break; }
    }
  }
  // 5. Substring match su extraTexts (titoli stream dynamic, descrizioni, ecc.)
  if (!code && Array.isArray(channel.extraTexts)) {
    for (const raw of channel.extraTexts) {
      const nk = normalizeKey(raw || '');
      if (!nk) continue;
      for (const k of keysOrdered) {
        if (nk.includes(k)) {
          const candidate = FREESHOT_CODE_MAP[k];
          if (/^ZonaDAZN$/i.test(candidate) || /dazn/i.test(k)) {
            if (!hasItaMarker(raw)) continue; // richiede marker italiano nel testo specifico
          }
          code = candidate; matchHint = `substrExtra:${k}`; break; }
      }
      if (code) break;
    }
  }
  if (!code) return null;

  const cacheKey = code;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && (now - cached.resolvedAt) < TTL_MS && !cached.error) {
    return cached;
  }
  const resolved = await fetchFreeshot(code);
  if (resolved && !resolved.error) {
    resolved.matchHint = matchHint;
    const disp = FREESHOT_DISPLAY_NAME[resolved.code];
    if (disp) (resolved as any).displayName = disp;
  }
  cache.set(cacheKey, resolved);
  return resolved;
}
