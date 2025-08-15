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
        const filtered = data.map(ch => {
          try {
            if (!ch.expiresAt && ch.eventStart) {
              // Calcola expiresAt = giorno successivo alle 02:00 Europe/Rome
              const eventDate = new Date(ch.eventStart);
              const romeString = eventDate.toLocaleString('en-US', { timeZone: 'Europe/Rome' });
              const romeDate = new Date(romeString);
              const expiryRome = new Date(romeDate);
              expiryRome.setDate(expiryRome.getDate() + 1);
              expiryRome.setHours(2, 0, 0, 0);
              // Converti a ISO UTC
              const expiresAt = new Date(expiryRome.getTime() - (expiryRome.getTimezoneOffset() * 60000)).toISOString();
              ch.expiresAt = expiresAt;
            }
          } catch (e) {
            // ignore singular channel errors
          }
          return ch;
        }).filter(ch => !ch.expiresAt || Date.parse(ch.expiresAt) > now);
        dynamicCache = filtered;
        lastLoad = now;
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
