// Dynamic channels utility (Node.js CommonJS style to avoid missing type declarations)
// If using TypeScript with proper @types/node, you can switch to import syntax.
// eslint-disable-next-line @typescript-eslint/no-var-requires
// Basic declarations to satisfy TS if @types/node absent
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function require(name: string): any;
const fs = require('fs');
const path = require('path');
// Declare __dirname for environments where TS complains
// (Normally available in Node.js)
declare const __dirname: string;


export interface DynamicChannelStream {
  url: string;        // base URL for staticUrlD flow
  title?: string;     // optional label (quality/source)
}

export interface DynamicChannel {
  id: string;                 // unique id (without tv: prefix)
  name: string;               // display name e.g. "Juventus vs Milan"
  streams: DynamicChannelStream[]; // one or more D-type streams
  logo?: string;              // optional logo url
  category?: string;          // e.g. seriea, serieb, seriec, coppe, tennis, f1, motogp
  description?: string;       // optional description
  epgChannelIds?: string[];   // optional EPG mapping
  eventStart?: string;        // ISO start of event
  createdAt?: string;         // timestamp ISO
  expiresAt?: string;         // ISO expiration (after 02:00 next day)
}

const DYNAMIC_FILE = path.join(__dirname, '../../config/dynamic_channels.json');

let dynamicCache: DynamicChannel[] | null = null;
let lastLoad = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export function loadDynamicChannels(force = false): DynamicChannel[] {
  const now = Date.now();
  if (!force && dynamicCache && (now - lastLoad) < CACHE_TTL) return dynamicCache;
  try {
    if (fs.existsSync(DYNAMIC_FILE)) {
      const raw = fs.readFileSync(DYNAMIC_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        // Normalizza i titoli degli stream (aggiunge bandiera se italiano) per evitare regex ripetute a runtime
        const normStreamTitle = (t?: string): string | undefined => {
          if (!t || typeof t !== 'string') return t;
            let title = t.trim();
            // Rimuovi parentesi che avvolgono tutto
            const m = title.match(/^\((.*)\)$/);
            if (m) title = m[1].trim();
            // Se già ha bandiera lascia
            if (title.startsWith('🇮🇹')) return title;
            // Pattern finali che identificano italiano
            if (/\b(it|ita|italy|italian)$/i.test(title)) {
              return `🇮🇹 ${title}`;
            }
            return title;
        };
        for (const ch of data) {
          if (Array.isArray(ch.streams)) {
            for (const s of ch.streams) {
              if (s && typeof s === 'object') {
                s.title = normStreamTitle(s.title);
              }
            }
          }
        }
        // Nuova logica: niente expiresAt per singolo evento.
        // Regola: ogni giorno alle 02:00 Europe/Rome vengono rimossi TUTTI gli eventi del giorno precedente.
        // Fino alle 01:59 si possono ancora vedere quelli di ieri.

        // Calcola ora locale Europe/Rome in modo robusto (senza lib esterne)
        const nowRome = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
        const purgeThreshold = new Date(nowRome); // oggi 02:00 Rome
        purgeThreshold.setHours(2, 0, 0, 0);

        // Funzione helper per estrarre YYYY-MM-DD in Rome da una data ISO
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

        const todayRomeDateStr = datePartRome(nowRome.toISOString());

        // Prima: se manca eventStart prova a derivarlo dall'id (pattern finale YYYYMMDD)
        for (const ch of data) {
          if (!ch.eventStart && typeof ch.id === 'string') {
            const m = ch.id.match(/(20\d{2})(\d{2})(\d{2})$/);
            if (m) {
              const y = m[1]; const mm = m[2]; const dd = m[3];
              try { ch.eventStart = new Date(Date.UTC(parseInt(y), parseInt(mm)-1, parseInt(dd), 0,0,0)).toISOString(); } catch { /* ignore */ }
            }
          }
        }

        let removedPrevDay = 0;
        const filtered = data.filter(ch => {
          // Se manca eventStart lo manteniamo (non possiamo datarlo)
          if (!ch.eventStart) return true;
          const chDate = datePartRome(ch.eventStart);
          if (!chDate) return true;

          // Se non abbiamo ancora raggiunto le 02:00 Rome, non facciamo purge (manteniamo anche ieri)
          if (nowRome < purgeThreshold) return true;

          // Dopo le 02:00 Rome: rimuovi se la data evento è minore di oggi
          const keep = chDate >= (todayRomeDateStr || '');
          if (!keep) removedPrevDay++;
          return keep;
        });

        dynamicCache = filtered;
        lastLoad = now;
        if (removedPrevDay > 0) {
          try { console.log(`🧹 runtime filter: rimossi ${removedPrevDay} eventi del giorno precedente (dopo le 02:00 Rome)`); } catch {}
        }
        // Persisti normalizzazione stream se abbiamo modificato almeno un titolo (best effort, non blocca)
        try {
          fs.writeFileSync(DYNAMIC_FILE, JSON.stringify(data, null, 2), 'utf-8');
        } catch {}
        return filtered;
      }
    }
  } catch (e) {
    console.error('❌ loadDynamicChannels error:', e);
  }
  dynamicCache = [];
  lastLoad = now;
  return [];
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
