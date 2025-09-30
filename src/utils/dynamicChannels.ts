// Dynamic channels utility (Node.js CommonJS style to avoid missing type declarations)
// If using TypeScript with proper @types/node, you can switch to import syntax.
// eslint-disable-next-line @typescript-eslint/no-var-requires
// Basic declarations to satisfy TS if @types/node absent
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function require(name: string): any;
const fs = require('fs');
const path = require('path');
// Declare __dirname for environments where TS complains (normally available in Node.js)
declare const __dirname: string;
// Node's process is available (types provided by @types/node)
declare const process: any;

export interface DynamicChannelStream {
  url: string;        // base URL for staticUrlD flow
  title?: string;     // optional label (quality/source)
}

export interface DynamicChannel {
  id: string;
  name: string;
  logo?: string;
  poster?: string;
  description?: string;
  category?: string;
  eventStart?: string;  // ISO string
  createdAt?: string;   // ISO string (per purge eventi senza eventStart)
  epgChannelIds?: string[];
  streams?: DynamicChannelStream[];
}

// Cache & file state
let dynamicCache: DynamicChannel[] | null = null;
let lastLoad = 0;
let lastKnownMtimeMs = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minuti
// Flag per disabilitare completamente la cache (di default ON per provare senza cache)
const NO_DYNAMIC_CACHE: boolean = (() => {
  try {
    const v = (process?.env?.NO_DYNAMIC_CACHE ?? '1').toString().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  } catch { return true; }
})();
// Flag per disabilitare il filtro runtime su date.
// CAMBIO: default ora = OFF (0) così il comportamento "purge automatico" torna quello atteso:
//   - Prima delle 08:00 Rome: mantieni anche eventi di ieri (grace)
//   - Dopo le 08:00 Rome: rimuovi ieri (salvo KEEP_YESTERDAY=1)
// Se qualcuno vuole mantenere il vecchio comportamento (nessun filtro runtime), deve impostare esplicitamente DYNAMIC_DISABLE_RUNTIME_FILTER=1.
const DISABLE_RUNTIME_FILTER: boolean = (() => {
  try {
    const v = (process?.env?.DYNAMIC_DISABLE_RUNTIME_FILTER ?? '0').toString().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  } catch { return false; }
})();
// Flag per mantenere anche gli eventi di IERI (utile se l'orario/UTC causa slittamenti di data)
const KEEP_YESTERDAY: boolean = (() => {
  try {
  const v = (process?.env?.DYNAMIC_KEEP_YESTERDAY ?? '0').toString().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  } catch { return true; }
})();

// Nuova opzione: età massima evento (in ore) dopo l'orario di inizio, oltre la quale l'evento viene rimosso
// Se 0 (default) => disabilitato. Consigliato 8 per richiesta "purge fallback dopo 8h dallo start".
const EVENT_MAX_AGE_HOURS: number = (() => {
  try {
    const raw = (process?.env?.DYNAMIC_EVENT_MAX_AGE_HOURS || '0').toString().trim();
    const n = parseInt(raw, 10);
    if (!isNaN(n) && n > 0 && n < 72) return n; // hard cap 72h per sicurezza
    return 0;
  } catch { return 0; }
})();

function resolveDynamicFile(): string {
  // 1) Env override
  try {
    const envPath = (process?.env?.DYNAMIC_FILE || '').toString().trim();
    if (envPath) {
      if (fs.existsSync(envPath)) {
        try { console.log('[DynamicChannels] Path da DYNAMIC_FILE:', envPath); } catch {}
        return envPath;
      } else {
        try { console.warn('[DynamicChannels] DYNAMIC_FILE settato ma non esiste:', envPath); } catch {}
      }
    }
  } catch {}

  // 2) Cerca in possibili posizioni (support legacy nested config/config)
  const candidates = [
  // Preferred writable temp path in containers/hosts
  '/tmp/dynamic_channels.json',
    // Dev (ts-node src/...): __dirname ~ src/utils -> ../../config => root/config (OK)
    path.resolve(__dirname, '../../config/dynamic_channels.json'),
    // Dist (addon.js compilato in dist/, utils in dist/utils): usare ../../../config -> root/config
    path.resolve(__dirname, '../../../config/dynamic_channels.json'),
    // Dist variant: ../config from dist root
    path.resolve(__dirname, '../config/dynamic_channels.json'),
    // Nested legacy path (avoid but fallback)
    path.resolve(__dirname, '../../config/config/dynamic_channels.json'),
    // CWD fallback (eseguito da root progetto)
    path.resolve(process.cwd(), 'config/dynamic_channels.json')
  ];

  // Filtra esistenti e raccogli dimensioni; preferisci quello più grande, non-nested e non "tiny" (es. touch -> 0/1 byte)
  const existing: { p: string; size: number; nested: boolean; tiny: boolean }[] = [];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        let size = 0;
        try { size = fs.statSync(p).size || 0; } catch {}
        existing.push({ p, size, nested: /\/(^|.*\/)config\/config\//.test(p) || p.includes(path.sep + 'config' + path.sep + 'config' + path.sep), tiny: size < 10 });
      }
    } catch {}
  }
  if (existing.length) {
    // Ordina: non-nested prima, non-tiny prima, poi size desc
    existing.sort((a, b) => {
      if (a.nested !== b.nested) return a.nested ? 1 : -1;
      if (a.tiny !== b.tiny) return a.tiny ? 1 : -1;
      return b.size - a.size;
    });
    const chosen = existing[0];
    try { console.log('[DynamicChannels] Path selezionato:', chosen.p, 'size=', chosen.size, 'nested=', chosen.nested, 'tiny=', chosen.tiny); } catch {}
    return chosen.p;
  }
  try { console.warn('[DynamicChannels] dynamic_channels.json non trovato in nessuno dei path candidati, uso primo fallback:', candidates[0]); } catch {}
  return candidates[0]; // fallback
}

let DYNAMIC_FILE = resolveDynamicFile();

// Export helpers for diagnostics
export function getDynamicFilePath(): string {
  return DYNAMIC_FILE;
}

export function getDynamicFileStats(): { exists: boolean; size: number; mtimeMs: number } {
  try {
    if (!fs.existsSync(DYNAMIC_FILE)) return { exists: false, size: 0, mtimeMs: 0 };
    const st = fs.statSync(DYNAMIC_FILE);
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return { exists: false, size: 0, mtimeMs: 0 };
  }
}

// Time helpers were moved to EPG manager (src/utils/epg.ts)

export function loadDynamicChannels(force = false): DynamicChannel[] {
  const now = Date.now();
  // Se richiesto, forza sempre il reload (no cache)
  if (NO_DYNAMIC_CACHE) {
    force = true;
  }
  // Detect file change
  try {
    const currentPath = resolveDynamicFile();
    if (currentPath !== DYNAMIC_FILE) {
      try { console.log('[DynamicChannels] Cambio path file dinamico ->', currentPath); } catch {}
      DYNAMIC_FILE = currentPath;
    }
    if (fs.existsSync(DYNAMIC_FILE)) {
      const st = fs.statSync(DYNAMIC_FILE);
      if (st.mtimeMs > lastKnownMtimeMs) {
        force = true;
        lastKnownMtimeMs = st.mtimeMs;
      }
    }
  } catch {}
  if (!force && dynamicCache && (now - lastLoad) < CACHE_TTL) return dynamicCache;
  try {
    if (!fs.existsSync(DYNAMIC_FILE)) {
      dynamicCache = [];
      lastLoad = now;
      return [];
    }
    const raw = fs.readFileSync(DYNAMIC_FILE, 'utf-8');
    // Se file vuoto o quasi sicuramente in stato "troncato" da write non atomica, tenta recovery senza azzerare la cache precedente
    if (raw.trim().length < 2) {
      try { console.warn('[DynamicChannels] WARNING: file dinamico vuoto o troncato (<2 bytes), mantengo cache precedente se disponibile'); } catch {}
      if (dynamicCache) return dynamicCache; // mantieni precedente
      dynamicCache = [];
      lastLoad = now;
      return [];
    }
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch (perr) {
      // Retry una volta dopo breve sleep sincrono (busy wait minimo) in caso di race (writer ancora in corso)
      try {
        const start = Date.now();
        while (Date.now() - start < 25) {/* piccolo delay */}
        const raw2 = fs.readFileSync(DYNAMIC_FILE, 'utf-8');
        if (raw2.trim().length >= 2) {
          data = JSON.parse(raw2);
        } else {
          throw perr;
        }
      } catch (retryErr) {
        try { console.error('[DynamicChannels] Parse JSON fallita (anche dopo retry). Mantengo cache precedente.', (retryErr as any)?.message || retryErr); } catch {}
        if (dynamicCache) return dynamicCache;
        dynamicCache = [];
        lastLoad = now;
        return [];
      }
    }
    if (!Array.isArray(data)) {
      dynamicCache = [];
      lastLoad = now;
      return [];
    }
    // DIAG: stampa conteggio grezzo per categoria
    try {
      const catMapRaw: Record<string, number> = {};
      for (const ch of data) {
        const c = (ch?.category || 'unknown').toString().toLowerCase();
        catMapRaw[c] = (catMapRaw[c] || 0) + 1;
      }
      console.log(`[DynamicChannels] RAW count=${data.length} per categoria:`, catMapRaw);
    } catch {}
    // Normalizza titoli stream
    const normStreamTitle = (t?: string): string | undefined => {
      if (!t || typeof t !== 'string') return t;
      let title = t.trim();
      const m = title.match(/^\((.*)\)$/);
      if (m) title = m[1].trim();
      if (title.startsWith('🇮🇹')) return title;
      if (/\b(it|ita|italy|italian)$/i.test(title)) return `🇮🇹 ${title}`;
      return title;
    };
    for (const ch of data) {
      if (Array.isArray(ch.streams)) for (const s of ch.streams) s.title = normStreamTitle(s.title);
    }
    // Deriva eventStart da id se manca
    for (const ch of data) {
      if (!ch.eventStart && typeof ch.id === 'string') {
        const m = ch.id.match(/(20\d{2})(\d{2})(\d{2})$/);
        if (m) {
          try {
            ch.eventStart = new Date(Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]), 0, 0, 0)).toISOString();
          } catch {}
        }
      }
    }
    if (DISABLE_RUNTIME_FILTER) {
      try {
        const catMapKept: Record<string, number> = {};
        for (const ch of data) {
          const c = (ch?.category || 'unknown').toString().toLowerCase();
          catMapKept[c] = (catMapKept[c] || 0) + 1;
        }
        console.log(`[DynamicChannels] KEPT (no-filter) count=${data.length} per categoria:`, catMapKept);
      } catch {}
      dynamicCache = data;
      lastLoad = now;
      return data;
    } else {
      const purgeHourValue = parseInt(process.env.DYNAMIC_PURGE_HOUR || '8', 10); // default 08:00
      const nowRome = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
      const purgeThreshold = new Date(nowRome);
      purgeThreshold.setHours(purgeHourValue, 0, 0, 0);
      // Calcola stringa data di oggi e di ieri in Europe/Rome
      const maxAgeMs = EVENT_MAX_AGE_HOURS > 0 ? EVENT_MAX_AGE_HOURS * 60 * 60 * 1000 : 0;
      const datePartRome = (iso?: string): string | null => {
        if (!iso) return null;
        try {
          const d = new Date(iso);
          if (isNaN(d.getTime())) return null;
          const fmt = new Intl.DateTimeFormat('en-CA', {
            timeZone: 'Europe/Rome',
            year: 'numeric', month: '2-digit', day: '2-digit'
          } as any);
          return fmt.format(d); // YYYY-MM-DD in tz Rome
        } catch { return null; }
      };
      const todayRome = (() => {
        try {
          const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' } as any);
          return fmt.format(new Date());
        } catch { return datePartRome(nowRome.toISOString()) || ''; }
      })();
      const yRomeTmp = new Date(nowRome);
      yRomeTmp.setDate(yRomeTmp.getDate() - 1);
      const yesterdayRome = datePartRome(yRomeTmp.toISOString()) || '';
      let removedPrevDay = 0;
      let removedExpiredAge = 0;
      const filtered: DynamicChannel[] = data.filter(ch => {
        if (!ch.eventStart) return true; // keep if undated
        const chDate = datePartRome(ch.eventStart);
        if (!chDate) return true;
        // Rimozione per età (prima di tutto): se evento iniziato ed è passato oltre maxAge (in tz Rome)
        if (maxAgeMs > 0) {
          try {
            const startUtc = new Date(ch.eventStart); // ISO di origine in UTC
            const ageMs = nowRome.getTime() - startUtc.getTime();
            if (ageMs > maxAgeMs) {
              removedExpiredAge++;
              return false;
            }
          } catch { /* ignore */ }
        }
        if (nowRome < purgeThreshold) return true; // within grace period
        // Mantieni eventi di OGGI; opzionalmente mantieni anche IERI (per evitare drop falsi positivi)
        let keep = chDate >= todayRome;
        if (!keep && KEEP_YESTERDAY && chDate === yesterdayRome) keep = true;
        if (!keep) removedPrevDay++;
        return keep;
      });
      // DIAG: stampa conteggio dopo filtro
      try {
        const catMapKept: Record<string, number> = {};
        for (const ch of filtered) {
          const c = (ch?.category || 'unknown').toString().toLowerCase();
          catMapKept[c] = (catMapKept[c] || 0) + 1;
        }
        console.log(`[DynamicChannels] KEPT count=${filtered.length} per categoria:`, catMapKept);
      } catch {}
      dynamicCache = filtered;
      lastLoad = now;
      if (removedPrevDay) {
        const hh = purgeHourValue.toString().padStart(2, '0');
        try { console.log(`🧹 runtime filter: rimossi ${removedPrevDay} eventi del giorno precedente (dopo le ${hh}:00 Rome)`); } catch {}
      }
      if (removedExpiredAge && EVENT_MAX_AGE_HOURS > 0) {
        try { console.log(`⏱️ runtime filter: rimossi ${removedExpiredAge} eventi oltre ${EVENT_MAX_AGE_HOURS}h dallo start`); } catch {}
      }
      return filtered;
    }
  } catch (e) {
    console.error('❌ loadDynamicChannels error:', e);
    dynamicCache = [];
    lastLoad = now;
    return [];
  }
}

function atomicWrite(target: string, content: string) {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const tmp = path.join(dir, `.${base}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.writeFileSync(tmp, content, 'utf-8');
  try {
    fs.renameSync(tmp, target); // atomic su stessa FS
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

export function saveDynamicChannels(channels: DynamicChannel[]): void {
  try {
    atomicWrite(DYNAMIC_FILE, JSON.stringify(channels, null, 2));
    dynamicCache = channels;
    lastLoad = Date.now();
  } catch (e) {
    console.error('❌ saveDynamicChannels error:', e);
  }
}

// Invalida cache dinamica (usato da file watcher)
export function invalidateDynamicChannels(): void {
  dynamicCache = null;
  lastLoad = 0;
}

// Purge: rimuove tutti gli eventi con eventStart del giorno precedente (Europe/Rome)
// Mantiene eventi senza eventStart come richiesto.
export function purgeOldDynamicEvents(): { before: number; after: number; removed: number } {
  try {
    if (!fs.existsSync(DYNAMIC_FILE)) return { before: 0, after: 0, removed: 0 };
    const raw = fs.readFileSync(DYNAMIC_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return { before: 0, after: 0, removed: 0 };
    const before = data.length;
    const nowRome = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
    const maxAgeMs = EVENT_MAX_AGE_HOURS > 0 ? EVENT_MAX_AGE_HOURS * 60 * 60 * 1000 : 0;
    const datePartRome = (iso?: string): string | null => {
      if (!iso) return null;
      try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return null;
        const fmt = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Rome',
          year: 'numeric', month: '2-digit', day: '2-digit'
        } as any);
        return fmt.format(d); // YYYY-MM-DD
      } catch { return null; }
    };
  const todayRomeStr = (() => {
      try {
        const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' } as any);
        return fmt.format(new Date());
      } catch { return datePartRome(nowRome.toISOString()) || ''; }
    })();
  const yRomeTmp2 = new Date(nowRome);
  yRomeTmp2.setDate(yRomeTmp2.getDate() - 1);
  const yesterdayRomeStr = datePartRome(yRomeTmp2.toISOString()) || '';
  // Grace period: mantieni anche IERI fino alle 08:00 Rome, indipendentemente da KEEP_YESTERDAY
  const isBeforeGrace = (() => { try { return nowRome.getHours() < 8; } catch { return false; } })();
    // Deriva eventStart se mancante (00:00 del giorno codificato nell'id)
    for (const ch of data) {
      if (!ch.eventStart && typeof ch.id === 'string') {
        const m = ch.id.match(/(20\d{2})(\d{2})(\d{2})$/);
        if (m) {
          const y = m[1]; const mm = m[2]; const dd = m[3];
          try { ch.eventStart = new Date(Date.UTC(parseInt(y), parseInt(mm)-1, parseInt(dd), 0,0,0)).toISOString(); } catch { /* ignore */ }
        }
      }
    }
    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    const nowMs = nowRome.getTime();
  const filtered = data.filter((ch: DynamicChannel) => {
      if (!ch.eventStart) {
        // Usa createdAt per determinare età, se manca assegnalo ora e conserva (verrà valutato ai prossimi purge)
        if (!ch.createdAt) {
          ch.createdAt = new Date().toISOString();
          return true;
        }
        const created = Date.parse(ch.createdAt);
        if (isNaN(created)) return true; // formato invalido -> conserva
        const age = nowMs - created;
        if (age > TWO_DAYS_MS) return false; // elimina dopo 2 giorni
        return true;
      }
  // Se impostata la max age, elimina se oltre soglia
  if (maxAgeMs > 0) {
    try {
      const start = Date.parse(ch.eventStart);
      if (!isNaN(start)) {
        const age = nowMs - start;
        if (age > maxAgeMs) return false;
      }
    } catch { /* ignore */ }
  }
  const chDate = datePartRome(ch.eventStart);
  if (!chDate) return true;
  // Mantieni oggi; opzionalmente mantieni anche ieri
  if (chDate >= todayRomeStr) return true;
  // Effettivo mantenimento di IERI: fino alle 08:00 Rome sempre; dopo, solo se KEEP_YESTERDAY è attivo
  if (chDate === yesterdayRomeStr) {
    if (isBeforeGrace) return true;
    if (KEEP_YESTERDAY) return true;
  }
  return false; // rimuove se < ieri (o < oggi se KEEP_YESTERDAY è off)
    });
    try {
      atomicWrite(DYNAMIC_FILE, JSON.stringify(filtered, null, 2));
    } catch (wErr) {
      console.error('[DynamicChannels][PURGE] atomic write failed, fallback direct write', (wErr as any)?.message || wErr);
      try { fs.writeFileSync(DYNAMIC_FILE, JSON.stringify(filtered, null, 2), 'utf-8'); } catch {/* ignore */}
    }
    // Invalida cache
    dynamicCache = null;
    const after = filtered.length;
    try {
      // Logging diagnostico dettagliato
      const removed = before - after;
      const removedDetail = { before, after, removed, graceActive: isBeforeGrace, keepYesterdayFlag: KEEP_YESTERDAY, maxAgeHours: EVENT_MAX_AGE_HOURS };
      console.log('[DynamicChannels][PURGE] result', removedDetail);
    } catch {}
    return { before, after, removed: before - after };
  } catch (e) {
    console.error('❌ purgeOldDynamicEvents error:', e);
    return { before: 0, after: 0, removed: 0 };
  }
}

export function mergeDynamic(staticList: any[]): any[] {
  const dyn = loadDynamicChannels();
  if (!dyn.length) return staticList;
  try {
    const perCat: Record<string, number> = {};
    for (const ch of dyn) {
      const c = (ch.category || 'unknown').toString().toLowerCase();
      perCat[c] = (perCat[c] || 0) + 1;
    }
    console.log('[DynamicChannels] merge: categorie dinamiche disponibili:', perCat);
  } catch {}
  const existingIds = new Set(staticList.map(c => c.id));
  const merged = [...staticList];
  let added = 0;
  for (const ch of dyn) {
    if (!existingIds.has(ch.id)) {
      merged.push({
        id: ch.id,
        type: 'tv', // assicurati che Stremio riconosca il tipo
        name: ch.name,
        logo: ch.logo,
        poster: ch.logo,
        description: ch.description || '',
  eventStart: ch.eventStart || null,
  category: ch.category || 'sport',
  // store dynamic D stream urls (array) for handler
  dynamicDUrls: ch.streams?.map(s => ({ url: s.url, title: s.title })) || [],
  epgChannelIds: ch.epgChannelIds || [],
  _dynamic: true
      });
      added++;
    }
  }
  if (added) {
    try { console.log(`🔄 mergeDynamic: aggiunti ${added} canali dinamici (totale catalogo provvisorio: ${merged.length})`); } catch {}
  }
  return merged;
}
