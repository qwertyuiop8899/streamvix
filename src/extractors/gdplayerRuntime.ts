import axios from 'axios';

/**
 * Runtime resolver per canali gdplayer (eng.gdplayertv.to) -> ava.karmakurama.com
 * Riproduce la logica di myResolver.gdplayer ma in TS con caching breve.
 * Richieste:
 *  1. GET pagina https://eng.gdplayertv.to/live-tv/{slug}
 *  2. Regex data-src="https://ava.karmakurama.com/?id=CODE" -> CODE numerico daddyC
 *  3. Flusso daddyCode:
 *     - GET https://jxoxkplay.xyz/premiumtv/daddylive.php?id=premium{CODE}
 *       * Estrarre base64 (pattern XKZK=...) => decode JSON { b_ts, b_rnd, b_sig }
 *     - GET https://top2new.newkso.ru/auth.php?channel_id=premium{CODE}&ts=...&rnd=...&sig=...
 *       (la risposta può non essere usata direttamente ma serve a validare)
 *     - GET https://jxoxkplay.xyz/server_lookup.php?channel_id=premium{CODE} => { server_key: "wind/" }
 *  4. Costruire URL finale karmakurama: https://ava.karmakurama.com/{server_key}premium{CODE}/mono.m3u8
 *  5. (Opzionale) Wrapping MFP se mfpUrl/password fornite ma senza rinominare il path karmakurama.
 */

export interface GdplayerResolved {
  slug: string;
  code?: string; // daddyC numerico
  serverKey?: string; // es: wind/ oppure top1/
  url?: string; // URL finale karmakurama (sempre mantenuto)
  wrappedUrl?: string; // URL attraverso MFP proxy se presente
  error?: string;
  resolvedAt: number;
  debug?: Record<string, any>;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
const BASE_PAGE = 'https://eng.gdplayertv.to/live-tv';
const CACHE_TTL = 20_000; // 20s

const cache = new Map<string, GdplayerResolved>();

function b64Decode(str: string): string {
  try { return Buffer.from(str, 'base64').toString('utf-8'); } catch { return ''; }
}

async function fetchDaddyBundle(code: string) {
  const url = `https://jxoxkplay.xyz/premiumtv/daddylive.php?id=premium${code}`;
  const r = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 15000 });
  const txt = r.data as string;
  // Cerca token base64 dopo '=' o pattern XKZK="..."
  const m = txt.match(/XKZK\s*=\s*"([A-Za-z0-9+/=]+)"/); // pattern più esplicito
  if (!m) throw new Error('bundle base64 non trovato');
  const decoded = b64Decode(m[1]);
  let json: any = {};
  try { json = JSON.parse(decoded); } catch { throw new Error('bundle JSON invalido'); }
  if (!json.b_ts || !json.b_rnd || !json.b_sig) throw new Error('campi bundle mancanti');
  return { ts: json.b_ts, rnd: json.b_rnd, sig: json.b_sig };
}

async function callAuth(code: string, bundle: { ts: any; rnd: any; sig: any }) {
  const url = `https://top2new.newkso.ru/auth.php?channel_id=premium${code}&ts=${encodeURIComponent(bundle.ts)}&rnd=${encodeURIComponent(bundle.rnd)}&sig=${encodeURIComponent(bundle.sig)}`;
  try {
    await axios.get(url, { headers: { 'User-Agent': UA, Referer: 'https://eng.gdplayertv.to/' }, timeout: 12000 });
  } catch (e) {
    // Non interrompere: spesso l'URL finale funziona comunque.
  }
}

async function fetchServerKey(code: string): Promise<string> {
  const url = `https://jxoxkplay.xyz/server_lookup.php?channel_id=premium${code}`;
  const r = await axios.get(url, { headers: { 'User-Agent': UA }, timeout: 12000 });
  let j: any = r.data;
  if (typeof j === 'string') {
    try { j = JSON.parse(j); } catch {}
  }
  if (!j || typeof j.server_key !== 'string') throw new Error('server_key mancante');
  return j.server_key; // esempio: "wind/" oppure "top1/"
}

export async function resolveGdplayer(slug: string, opts?: { mfpUrl?: string; mfpPassword?: string }): Promise<GdplayerResolved> {
  const now = Date.now();
  // Cache per slug
  const cached = cache.get(slug);
  if (cached && (now - cached.resolvedAt) < CACHE_TTL && !cached.error) return cached;
  const out: GdplayerResolved = { slug, resolvedAt: now, debug: {} };
  try {
    // 1. Pagina canale
    const pageUrl = `${BASE_PAGE}/${encodeURIComponent(slug)}`;
    const pg = await axios.get(pageUrl, { headers: { 'User-Agent': UA, Referer: 'https://eng.gdplayertv.to/' }, timeout: 15000 });
    const html = (pg.data as string).replace(/\n|\r|\t/g, '');
    out.debug!.pageLen = html.length;
    const m = html.match(/data-src="https:\/\/ava\.karmakurama\.com\/\?id=([A-Za-z0-9_-]+)"/i);
    if (!m) throw new Error('code non trovato (data-src)');
    const code = m[1];
    out.code = code;
    // 2. daddyCode chain
    const bundle = await fetchDaddyBundle(code);
    out.debug!.bundle = { has: true };
    await callAuth(code, bundle); // best-effort
  let serverKey = await fetchServerKey(code);
  // assicurati che termini con '/'
  if (serverKey && !serverKey.endsWith('/')) serverKey = serverKey + '/';
  out.serverKey = serverKey;
  // 3. URL finale karmakurama (forza sempre uno slash tra serverKey e 'premium')
  const serverKeyNormalized = (serverKey || '').replace(/\/?$/, '/');
  const finalUrl = `https://ava.karmakurama.com/${serverKeyNormalized}premium${code}/mono.m3u8`;
    out.url = finalUrl;
    // 4. MFP wrapper opzionale
    if (opts?.mfpUrl && opts?.mfpPassword) {
      const base = opts.mfpUrl.replace(/\/$/, '');
      const pass = encodeURIComponent(opts.mfpPassword);
      const encoded = encodeURIComponent(finalUrl);
      // Headers di origine passati come parametri (stile già usato altrove)
      out.wrappedUrl = `${base}/proxy/hls/manifest.m3u8?api_password=${pass}&d=${encoded}&h_Referer=${encodeURIComponent('https://eng.gdplayertv.to/')}&h_Origin=${encodeURIComponent('https://eng.gdplayertv.to')}&h_User-Agent=${encodeURIComponent(UA)}`;
    }
  } catch (e: any) {
    out.error = e?.message || String(e);
  }
  cache.set(slug, out);
  return out;
}

// Normalizzazione similar freeshotRuntime
function normalizeKey(s?: string): string | null {
  if (!s) return null; return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Mappa slug canonicali -> slug reale (nel caso di alias futuri)
export const GDPLAYER_SLUG_MAP: Record<string, string> = {
  // Sky Cinema
  'skycinemacomedy': 'sky-cinema-comedy',
  'skycinemafamily': 'sky-cinema-family',
  'skycinemaromance': 'sky-cinema-romance',
  'skycinemasuspense': 'sky-cinema-suspence', // nota: slug sito usa "suspence"
  'skycinemauno': 'sky-cinema-uno',
  // Sky Sport principali
  'skysport24': 'sky-sport-24',
  'skysport251': 'sky-sport-251',
  'skysport252': 'sky-sport-252',
  'skysport253': 'sky-sport-253',
  'skysport254': 'sky-sport-254',
  'skysport255': 'sky-sport-255',
  'skysport256': 'sky-sport-256',
  'skysport257': 'sky-sport-257',
  'skysportarena': 'sky-sport-arena',
  'skysportcalcio': 'sky-sport-calcio',
  'skysportf1': 'sky-sport-f1',
  'skysportmax': 'sky-sport-max',
  'skysportmotogp': 'sky-sport-motogp',
  'skysportnba': 'sky-sport-nba',
  'skysporttennis': 'sky-sport-tennis',
  'skysportuno': 'sky-sport-uno',
  // Sky generalista
  'skyuno': 'sky-uno',
  // Eurosport
  'eurosport1': 'eurosport-1-it',
  'eurosport2': 'eurosport-2-it'
};

export async function resolveGdplayerForChannel(channel: { id?: string; name?: string; epgChannelIds?: string[]; extraTexts?: string[] }, opts?: { mfpUrl?: string; mfpPassword?: string }): Promise<GdplayerResolved | null> {
  const idKey = normalizeKey(channel.id);
  const nameKey = normalizeKey(channel.name);
  const extraRaw = Array.isArray(channel.extraTexts) ? channel.extraTexts : [];
  const extra = extraRaw.map(t=>normalizeKey(t)||'');
  const epg = Array.isArray(channel.epgChannelIds) ? channel.epgChannelIds.map(t=>normalizeKey(t)||'') : [];
  // Ordine di match: id -> name -> epg -> extra -> pattern infer (da extra) -> pattern infer (da name)
  let slug: string | undefined;
  if (idKey && GDPLAYER_SLUG_MAP[idKey]) slug = GDPLAYER_SLUG_MAP[idKey];
  if (!slug && nameKey && GDPLAYER_SLUG_MAP[nameKey]) slug = GDPLAYER_SLUG_MAP[nameKey];
  if (!slug) {
    for (const k of epg) { if (GDPLAYER_SLUG_MAP[k]) { slug = GDPLAYER_SLUG_MAP[k]; break; } }
  }
  if (!slug) {
    for (const k of extra) { if (GDPLAYER_SLUG_MAP[k]) { slug = GDPLAYER_SLUG_MAP[k]; break; } }
  }
  // Nuovo: inferenza basata su substring dai testi provider (extra)
  if (!slug && extra.length) {
    outerExtra: for (const k of extra) {
      if (!k) continue;
      for (const known of Object.keys(GDPLAYER_SLUG_MAP)) {
        if (k.includes(known)) { slug = GDPLAYER_SLUG_MAP[known]; break outerExtra; }
      }
    }
  }
  if (!slug) {
    // Fallback pattern dal name
    if (channel.name) {
      const gen = channel.name.toLowerCase()
        .replace(/sky sport ?(\d{3})/i, 'sky-sport-$1')
        .replace(/sky sport /g, 'sky-sport-')
        .replace(/sky cinema /g, 'sky-cinema-')
        .replace(/eurosport ?1/i, 'eurosport-1-it')
        .replace(/eurosport ?2/i, 'eurosport-2-it')
        .replace(/ /g, '-')
        .replace(/[^a-z0-9-]/g, '');
      if (/^(sky|eurosport)/.test(gen)) slug = gen;
    }
  }
  if (!slug) return null; // nessuna corrispondenza
  return await resolveGdplayer(slug, opts);
}

// Solo inferenza dello slug (no rete) per tagging ottimistico
export function inferGdplayerSlug(channel: { id?: string; name?: string; epgChannelIds?: string[]; extraTexts?: string[] }): string | null {
  const idKey = normalizeKey(channel.id);
  const nameKey = normalizeKey(channel.name);
  const extraRaw = Array.isArray(channel.extraTexts) ? channel.extraTexts : [];
  const extra = extraRaw.map(t=>normalizeKey(t)||'');
  const epg = Array.isArray(channel.epgChannelIds) ? channel.epgChannelIds.map(t=>normalizeKey(t)||'') : [];
  let slug: string | undefined;
  if (idKey && GDPLAYER_SLUG_MAP[idKey]) slug = GDPLAYER_SLUG_MAP[idKey];
  if (!slug && nameKey && GDPLAYER_SLUG_MAP[nameKey]) slug = GDPLAYER_SLUG_MAP[nameKey];
  if (!slug) {
    for (const k of epg) { if (GDPLAYER_SLUG_MAP[k]) { slug = GDPLAYER_SLUG_MAP[k]; break; } }
  }
  if (!slug) {
    for (const k of extra) { if (GDPLAYER_SLUG_MAP[k]) { slug = GDPLAYER_SLUG_MAP[k]; break; } }
  }
  if (!slug && extra.length) {
    outerExtra: for (const k of extra) {
      if (!k) continue;
      for (const known of Object.keys(GDPLAYER_SLUG_MAP)) {
        if (k.includes(known)) { slug = GDPLAYER_SLUG_MAP[known]; break outerExtra; }
      }
    }
  }
  if (!slug && channel.name) {
    const gen = channel.name.toLowerCase()
      .replace(/sky sport ?(\d{3})/i, 'sky-sport-$1')
      .replace(/sky sport /g, 'sky-sport-')
      .replace(/sky cinema /g, 'sky-cinema-')
      .replace(/eurosport ?1/i, 'eurosport-1-it')
      .replace(/eurosport ?2/i, 'eurosport-2-it')
      .replace(/ /g, '-')
      .replace(/[^a-z0-9-]/g, '');
    if (/^(sky|eurosport)/.test(gen)) slug = gen;
  }
  return slug || null;
}
