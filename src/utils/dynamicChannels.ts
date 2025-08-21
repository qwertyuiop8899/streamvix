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

function resolveDynamicFile(): string {
  // Cerca in possibili posizioni (support legacy nested config/config)
  const candidates = [
    // Dev (ts-node src/...): __dirname ~ src/utils -> ../../config => root/config (OK)
    path.resolve(__dirname, '../../config/dynamic_channels.json'),
    // Dist (addon.js compilato in dist/, utils in dist/utils): usare ../config -> dist/../config => root/config
    path.resolve(__dirname, '../config/dynamic_channels.json'),
    // Some builds may flatten further; try single up level from dist root
    path.resolve(__dirname, '../../../config/dynamic_channels.json'),
    // Nested legacy path
    path.resolve(__dirname, '../../config/config/dynamic_channels.json'),
    // CWD fallback (eseguito da root progetto)
    path.resolve(process.cwd(), 'config/dynamic_channels.json')
  ];
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  try { console.warn('[DynamicChannels] dynamic_channels.json non trovato in nessuno dei path candidati, uso primo fallback:', candidates[0]); } catch {}
  return candidates[0]; // fallback
}

let DYNAMIC_FILE = resolveDynamicFile();

export function loadDynamicChannels(force = false): DynamicChannel[] {
  const now = Date.now();
  // Detect file change
  try {
    const currentPath = resolveDynamicFile();
    if (currentPath !== DYNAMIC_FILE) DYNAMIC_FILE = currentPath;
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
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      dynamicCache = [];
      lastLoad = now;
      return [];
    }
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
    const purgeHourValue = parseInt(process.env.DYNAMIC_PURGE_HOUR || '8', 10); // default 08:00
    const nowRome = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
    const purgeThreshold = new Date(nowRome);
    purgeThreshold.setHours(purgeHourValue, 0, 0, 0);
    const datePartRome = (iso?: string): string | null => {
      if (!iso) return null;
      try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return null;
        const rome = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
        return `${rome.getFullYear()}-${String(rome.getMonth() + 1).padStart(2, '0')}-${String(rome.getDate()).padStart(2, '0')}`;
      } catch { return null; }
    };
    const todayRome = datePartRome(nowRome.toISOString()) || '';
    let removedPrevDay = 0;
    const filtered: DynamicChannel[] = data.filter(ch => {
      if (!ch.eventStart) return true; // keep if undated
      const chDate = datePartRome(ch.eventStart);
      if (!chDate) return true;
      if (nowRome < purgeThreshold) return true; // within grace period
      const keep = chDate >= todayRome;
      if (!keep) removedPrevDay++;
      return keep;
    });
    dynamicCache = filtered;
    lastLoad = now;
    if (removedPrevDay) {
      const hh = purgeHourValue.toString().padStart(2, '0');
      try { console.log(`🧹 runtime filter: rimossi ${removedPrevDay} eventi del giorno precedente (dopo le ${hh}:00 Rome)`); } catch {}
    }
    return filtered;
  } catch (e) {
    console.error('❌ loadDynamicChannels error:', e);
    dynamicCache = [];
    lastLoad = now;
    return [];
  }
}

export function saveDynamicChannels(channels: DynamicChannel[]): void {
  try {
    fs.writeFileSync(DYNAMIC_FILE, JSON.stringify(channels, null, 2), 'utf-8');
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
    const datePartRome = (iso?: string): string | null => {
      if (!iso) return null;
      try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return null;
        const rome = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
        const y = rome.getFullYear();
        const m = String(rome.getMonth() + 1).padStart(2, '0');
        const da = String(rome.getDate()).padStart(2, '0');
        return `${y}-${m}-${da}`;
      } catch { return null; }
    };
    const todayRomeStr = datePartRome(nowRome.toISOString()) || '';
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
      const chDate = datePartRome(ch.eventStart);
      if (!chDate) return true;
      return chDate >= todayRomeStr; // rimuove se < oggi
    });
    fs.writeFileSync(DYNAMIC_FILE, JSON.stringify(filtered, null, 2), 'utf-8');
    // Invalida cache
    dynamicCache = null;
    const after = filtered.length;
    return { before, after, removed: before - after };
  } catch (e) {
    console.error('❌ purgeOldDynamicEvents error:', e);
    return { before: 0, after: 0, removed: 0 };
  }
}

export function mergeDynamic(staticList: any[]): any[] {
  const dyn = loadDynamicChannels();
  if (!dyn.length) return staticList;
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
