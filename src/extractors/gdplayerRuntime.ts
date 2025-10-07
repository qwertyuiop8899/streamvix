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

// === Logging helper (abilitato di default) ===
const GD_LOG_ENABLED: boolean = (() => {
  try {
    const raw = String((process && process.env && process.env.GDPLAYER_LOG) ?? '1');
    return /^(1|true|on|yes)$/i.test(raw);
  } catch { return true; }
})();
function gdLog(...args: any[]) { if (GD_LOG_ENABLED) { try { console.log('[GD]', ...args); } catch {} } }

// --- Lightweight ambient declarations (evitano errori se @types/node non presenti) ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Buffer: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function require(name: string): any;

// === Fallback mapping slug->code (per quando eng.gdplayertv.to è down) ===
//  - Statico interno (popolabile manualmente)
//  - Override via variabile ambiente GDPLAYER_CODE_MAP: formato "slug1:123,slug2:456"
//  - Override via file config/gdplayer_codes.json : { "sky-sport-uno": "123", ... }
// Il CODE è la parte usata in id=premium{CODE} (numeric token). Se presente salta fetch pagina.
const STATIC_CODE_MAP: Record<string,string> = {
  // Esempio: 'sky-sport-uno': '1234'
};
let externalCodeMapLoaded = false;
function loadExternalCodeMap(): Record<string,string> {
  if (externalCodeMapLoaded) return STATIC_CODE_MAP; // avoid re-read each call (we mutate STATIC_CODE_MAP)
  externalCodeMapLoaded = true;
  try {
    // 1. File JSON
    const fs = require('fs');
    const path = require('path');
    const p = path.join(process.cwd(), 'config', 'gdplayer_codes.json');
    if (fs && fs.existsSync && fs.existsSync(p)) {
      const raw = fs.readFileSync(p,'utf8');
      try {
        const j = JSON.parse(raw);
        if (j && typeof j === 'object') {
          for (const [k,v] of Object.entries(j)) {
            if (typeof k === 'string' && typeof v === 'string' && v.trim()) STATIC_CODE_MAP[k.trim().toLowerCase()] = v.trim();
          }
        }
      } catch {}
    }
  } catch {}
  try {
    // 2. Env mapping
    const env: string = (typeof process !== 'undefined' && process?.env?.GDPLAYER_CODE_MAP) ? String(process.env.GDPLAYER_CODE_MAP) : '';
    if (env) {
      env.split(',').map((s: string)=>s.trim()).filter(Boolean).forEach((pair: string) => {
        const [slug,code] = pair.split(':');
        if (slug && code) STATIC_CODE_MAP[slug.trim().toLowerCase()] = code.trim();
      });
    }
  } catch {}
  return STATIC_CODE_MAP;
}
function resolveCodeFromSlug(slug: string): string | undefined {
  const map = loadExternalCodeMap();
  return map[slug.toLowerCase()];
}

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
    gdLog('resolve:start', { slug });
    // 1. Ottenere code:
    //    a) Fallback mapping diretto (se disponibile) per bypassare sito down
    //    b) Altrimenti fetch pagina come prima
    let code: string | undefined = resolveCodeFromSlug(slug);
    if (code) {
      out.debug!.mappingHit = true;
      out.debug!.codeSource = 'map';
      gdLog('resolve:code:map', { slug, code });
    } else {
      const pageUrl = `${BASE_PAGE}/${encodeURIComponent(slug)}`;
      try {
        const pg = await axios.get(pageUrl, { headers: { 'User-Agent': UA, Referer: 'https://eng.gdplayertv.to/' }, timeout: 15000 });
        const html = (pg.data as string).replace(/\n|\r|\t/g, '');
        out.debug!.pageLen = html.length;
        const m = html.match(/data-src="https:\/\/ava\.karmakurama\.com\/\?id=([A-Za-z0-9_-]+)"/i);
        if (!m) throw new Error('code non trovato (data-src)');
        code = m[1];
        out.debug!.codeSource = 'page';
        gdLog('resolve:code:page', { slug, code });
      } catch (e:any) {
        // Se fetch fallisce e non abbiamo mapping -> errore immediato
        gdLog('resolve:error:pageFetch', { slug, error: e?.message || String(e) });
        throw new Error(`impossibile ottenere code (slug=${slug}): ${e?.message || e}`);
      }
    }
    if (!code) throw new Error('code indefinito');
    out.code = code;
    // 2. serverKey resolution
    //    a) Se presente in mappa statica code->serverKey: uso immediato (offline/fast path)
    //    b) Altrimenti eseguo catena daddy (bundle -> auth -> server_lookup)
    //    c) In caso di errore rete nella catena, riprovo fallback mappa (se non già usata)
    let serverKey = resolveServerKeyFromCode(code);
    if (serverKey) {
      out.debug!.serverKeySource = 'map';
      gdLog('resolve:serverKey:map', { slug, code, serverKey });
    } else {
      try {
        const bundle = await fetchDaddyBundle(code);
        out.debug!.bundle = { has: true };
        gdLog('resolve:bundle', { slug, code });
        await callAuth(code, bundle); // best-effort
        serverKey = await fetchServerKey(code);
        if (serverKey && !serverKey.endsWith('/')) serverKey += '/';
        out.debug!.serverKeySource = 'network';
        gdLog('resolve:serverKey:net', { slug, code, serverKey });
      } catch (e:any) {
        gdLog('resolve:serverKey:netFail', { slug, code, error: e?.message || String(e) });
        // Fallback tardivo se la mappa è stata compilata DOPO (in qualche reload hot) o se dimenticata prima
        serverKey = resolveServerKeyFromCode(code);
        if (serverKey) {
          out.debug!.serverKeySource = 'map-fallback';
          gdLog('resolve:serverKey:mapFallback', { slug, code, serverKey });
        } else {
          throw new Error(`serverKey non risolta: ${e?.message || e}`);
        }
      }
    }
    out.serverKey = serverKey;
    // 3. URL finale karmakurama (forza sempre uno slash tra serverKey e 'premium')
    const serverKeyNormalized = (serverKey || '').replace(/\/?$/, '/');
    const finalUrl = `https://ava.karmakurama.com/${serverKeyNormalized}premium${code}/mono.m3u8`;
    out.url = finalUrl;
    gdLog('resolve:success', { slug, code, serverKey });
    // 4. MFP wrapper opzionale
    if (opts?.mfpUrl && opts?.mfpPassword) {
      const base = opts.mfpUrl.replace(/\/$/, '');
      const pass = encodeURIComponent(opts.mfpPassword);
      const encoded = encodeURIComponent(finalUrl);
      // Headers di origine passati come parametri (stile già usato altrove)
      out.wrappedUrl = `${base}/proxy/hls/manifest.m3u8?api_password=${pass}&d=${encoded}&h_Referer=${encodeURIComponent('https://eng.gdplayertv.to/')}&h_Origin=${encodeURIComponent('https://eng.gdplayertv.to')}&h_User-Agent=${encodeURIComponent(UA)}`;
      gdLog('resolve:wrap:mfp', { slug });
    }
  } catch (e: any) {
    out.error = e?.message || String(e);
    gdLog('resolve:fail', { slug, error: out.error });
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
  'skycinemasuspense': 'sky-cinema-suspense', // nota: slug sito usa "suspence"
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

// Mappa opzionale slug->code (numeric code dopo premium{CODE}) per bypassare completamente il fetch della pagina
// Compila qui le coppie solo se conosci già il CODE, ad es. ottenuto una volta dal sito.
// Esempio: 'sky-sport-uno': '1234'
// NOTA: questa mappa viene automaticamente fusa dentro STATIC_CODE_MAP usata dal fallback.
export const GDPLAYER_SLUG_CODE_MAP: Record<string, string> = {
  // Slug definitivi -> CODE fittizio '123' (sostituisci con il vero quando lo conosci)
  'sky-cinema-comedy': '862',
  'sky-cinema-family': '865',
  'sky-cinema-romance': '864',
  'sky-cinema-drama': '867',
  'sky-cinema-suspense': '868',
  'sky-cinema-uno': '860',
  'sky-serie': '880',
  'sky-sport-24': '869',
  'sky-sport-251': '871',
  'sky-sport-252': '872',
  'sky-sport-253': '873',
  'sky-sport-254': '874',
  'sky-sport-255': '875',
  'sky-sport-256': '876',
  'sky-sport-257': '877',
  'sky-sport-arena': '462',
  'sky-sport-calcio': '870',
  'sky-sport-f1': '577',
  'sky-sport-max': '460',
  'sky-sport-motogp': '575',
  'sky-sport-basket': '875',
  'sky-sport-tennis': '576',
  'sky-sport-uno': '461',
  'sky-uno': '881',
  'eurosport-1-it': '878',
  'eurosport-2-it': '879',
  'dazn-1' : '877',
  'rai-sport' : '882',
  'sky-cinema-collection': '859',
  'sky-cinema-due': '866'

};

// =====================================================================================
// Mappa opzionale code->serverKey.
// Scopo: permettere risoluzione offline (senza chiamate a jxoxkplay.xyz / server_lookup)
// quando conosci già quale server_key (es: "wind/", "top1/") corrisponde ad un CODE.
//
// Come usarla:
//  - Inserisci coppie "CODE": "serverKey/" (accetta con o senza slash finale, lo aggiungiamo noi)
//  - Il resolver tenterà PRIMA questa mappa: se trova la serverKey salta tutta la catena bundle + server_lookup
//  - In caso di errore rete nella catena normale tenterà comunque un fallback qui
//  - Mantieni le chiavi come stringhe (anche se numeriche) per coerenza con JSON/env
//  - Puoi copiare i CODE dalla mappa slug->code qui sopra (GDPLAYER_SLUG_CODE_MAP) una volta verificato il server_key
//
// Esempio (decommenta e sostituisci con valori reali quando li conosci):
// export const GDPLAYER_CODE_SERVERKEY_MAP: Record<string,string> = {
//   '862': 'wind/',
//   '577': 'top1/',
//   '461': 'wind/',
// };
//
// Se preferisci tenerla vuota ora, lascia così e popola in seguito.
export const GDPLAYER_CODE_SERVERKEY_MAP: Record<string,string> = {
   '881': 'wind/', // sky-cinema-comedy (ESEMPIO)
      '868': 'ddy6/',
         '861': 'wind/',
            '859': 'wind/',
               '862': 'wind/',
                  '867': 'wind/',
                     '866': 'wind/',
                        '865': 'wind/',
                           '864': 'wind/',
                              '860': 'wind/',
                                 '880': 'wind/',
                                    '877': 'nfs/',
       '878': 'wind/',
          '879': 'wind/',
             '869': 'wind/',
                '871': 'zeko/',
                   '872': 'wind/',
                      '873': 'wind/',
                         '874': 'wind/',
                            '462': 'ddy6/',        
  '875': 'wind/',  
  '870': 'wind/',  
  '577': 'nfs/',  
  '460': 'dokko1/',  
  '575': 'nfs/',  
  '576': 'ddy6/',  
  '882': 'ddy6/',                         
};

function resolveServerKeyFromCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const raw = GDPLAYER_CODE_SERVERKEY_MAP[code];
  if (!raw) return undefined;
  return raw.endsWith('/') ? raw : raw + '/';
}

// Fonde subito la mappa exportata nel STATIC_CODE_MAP interno (usato dal fallback) all'import del modulo.
// Così basta editare questo file e riavviare il processo per rendere attivi i code.
for (const [k,v] of Object.entries(GDPLAYER_SLUG_CODE_MAP)) {
  if (k && v) { (STATIC_CODE_MAP as any)[k.toLowerCase()] = v; }
}

// Unisci la mappa statica exportata (se popolata) con la STATIC_CODE_MAP usata dal resolver.
// In questo modo basta modificare questo file per aggiungere nuovi code senza creare il json o variabile ambiente.
try { Object.assign((globalThis as any)?.STATIC_CODE_MAP ?? {}, GDPLAYER_SLUG_CODE_MAP); } catch { /* no-op */ }

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
  // === NUOVO: usare direttamente la code map come sorgente slug primaria aggiuntiva ===
  // Se nessun alias trovato, prova varie trasformazioni (id, name, extra, epg) e accetta slug se esiste in GDPLAYER_SLUG_CODE_MAP / STATIC_CODE_MAP
  if (!slug) {
    const candidateSet = new Set<string>();
    const push = (s?: string | null) => { if (s) candidateSet.add(s); };
    push(idKey);
    push(nameKey);
    for (const k of extra) push(k);
    for (const k of epg) push(k);
    // Slug generato dal name (generico, non solo sky/eurosport)
    if (channel.name) {
      const genGeneric = channel.name.toLowerCase()
        .replace(/\s+/g,'-')
        .replace(/[^a-z0-9-]/g,'')
        .replace(/--+/g,'-')
        .replace(/^-+|-+$/g,'');
      push(genGeneric);
      // Variante senza numeri finali (es. channel-1 -> channel)
      push(genGeneric.replace(/-\d+$/,''));
    }
    // Controlla se uno dei candidati è direttamente una chiave di GDPLAYER_SLUG_CODE_MAP o STATIC_CODE_MAP
    for (const cand of candidateSet) {
      if (cand && (GDPLAYER_SLUG_CODE_MAP[cand] || (STATIC_CODE_MAP as any)[cand])) { slug = cand; break; }
    }
  }
  // Fallback legacy pattern (manteniamo come ultima spiaggia per compatibilità)
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
  if (!slug) { gdLog('infer:miss', { id: channel.id, name: channel.name }); return null; }
  gdLog('infer:hit', { id: channel.id, name: channel.name, slug });
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
  // Nuovo: prova direttamente contro code map se non trovato
  if (!slug) {
    const candidateSet = new Set<string>();
    const push = (s?: string | null) => { if (s) candidateSet.add(s); };
    push(idKey); push(nameKey);
    for (const k of extra) push(k);
    for (const k of epg) push(k);
    if (channel.name) {
      const genGeneric = channel.name.toLowerCase()
        .replace(/\s+/g,'-')
        .replace(/[^a-z0-9-]/g,'')
        .replace(/--+/g,'-')
        .replace(/^-+|-+$/g,'');
      push(genGeneric);
      push(genGeneric.replace(/-\d+$/,''));
    }
    for (const cand of candidateSet) {
      if (GDPLAYER_SLUG_CODE_MAP[cand] || (STATIC_CODE_MAP as any)[cand]) { slug = cand; break; }
    }
  }
  // Ultimo fallback legacy
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
