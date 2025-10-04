// sportzonline schedule fetch & parse (SPON) - programma eventi
// TTL cache: 4h. Parsing multi-day. Matching logica simile a spso_streams (porting parziale).

import crypto from 'crypto';

export interface SponRow {
  day: string;            // e.g. FRIDAY, SATURDAY
  time: string;           // HH:MM (24h)
  rawMatch: string;       // full left part before '|'
  url: string;            // channel page url
  channelCode: string;    // derived from url path (e.g. hd7, sporttv2, br1)
}

interface CacheEntry { rows: SponRow[]; fetchedAt: number; hash: string; }

const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
let cache: CacheEntry | null = null;

const DAY_REGEX = /^(MONDAY|TUESDAY|WEDNESDAY|THURSDAY|FRIDAY|SATURDAY|SUNDAY)\s*$/i;
// Righe evento: HH:MM <spaces> <descrizione> | <url>
const LINE_REGEX = /^(\d{2}:\d{2})\s+(.*?)\s*\|\s*(https?:\/\/[^\s]+)$/;

function extractChannelCode(url: string): string {
  // es: https://sportzonline.st/channels/hd/hd7.php -> hd7
  try {
    const m = url.match(/\/channels\/([^/]+)\/([^/.]+)\.php/);
    if (m) return m[2].toLowerCase();
    const m2 = url.match(/\/channels\/([^/.]+)\.php/);
    if (m2) return m2[1].toLowerCase();
  } catch {}
  return 'unknown';
}

export async function fetchSponSchedule(force = false): Promise<SponRow[]> {
  const now = Date.now();
  if (!force && cache && (now - cache.fetchedAt) < CACHE_TTL_MS) return cache.rows;
  const url = 'https://sportzonline.st/prog.txt';
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (StreamViX-SPON)' } });
  if (!res.ok) throw new Error('SPON schedule fetch failed ' + res.status);
  const text = await res.text();
  const hash = crypto.createHash('sha1').update(text).digest('hex');
  if (cache && cache.hash === hash) {
    cache.fetchedAt = now; // refresh timestamp
    return cache.rows;
  }
  const rows: SponRow[] = [];
  let currentDay = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (DAY_REGEX.test(line)) {
      currentDay = line.toUpperCase();
      continue;
    }
    const lm = line.match(LINE_REGEX);
    if (lm) {
      const time = lm[1];
      const left = lm[2];
      const url = lm[3];
      const channelCode = extractChannelCode(url);
      rows.push({ day: currentDay, time, rawMatch: left, url, channelCode });
    }
  }
  cache = { rows, fetchedAt: now, hash };
  return rows;
}

// --- Matching utilities (inline port to avoid module resolution issues) ---
const WORD_CLEAN = /[^a-z0-9]+/g;
function latinize(txt: string): string { try { return txt.normalize('NFKD').replace(/\p{M}+/gu,''); } catch { return txt; } }
const SYN: Record<string,string> = { 'internazionale':'inter','inter':'inter','juventus':'juve','juve':'juve','napoli':'napoli','psg':'psg','paris':'psg','paris saint germain':'psg','saint-germain':'psg','paris sg':'psg','manchester city':'city','man city':'city','mancity':'city','city':'city','porto':'porto','fc porto':'porto' };
function normTeam(name: string): string { let n = latinize(name).toLowerCase(); n = n.replace(WORD_CLEAN,' ').trim(); const toks = n.split(/\s+/).filter(Boolean); if(!toks.length) return ''; const full = toks.join(' '); if (SYN[full]) return SYN[full]; const filtered = toks.filter(t=>!/^[0-9]+$/.test(t)); const base = filtered.length?filtered:toks; const last = base[base.length-1]; if (SYN[last]) return SYN[last]; return last; }
function teamAliases(name: string): Set<string> { let n = latinize(name).toLowerCase(); n = n.replace(WORD_CLEAN,' ').trim(); const toks = n.split(/\s+/).filter(Boolean); const out = new Set<string>(); if(!toks.length) return out; const full = toks.join(' '); out.add(full); if (SYN[full]) out.add(SYN[full]); out.add(toks[0]); out.add(toks[toks.length-1]); if (toks.length>=2) out.add(toks.slice(-2).join(' ')); for (const t of toks) if (SYN[t]) out.add(SYN[t]); return out; }
// Estendiamo SINGLE per riconoscere eventi singoli (no due team) anche per motorsport aggiungendo sinonimi
const SINGLE = ['grand prix','gp','formula 1','f1','motogp','moto gp','qualifying','qualifica','practice','free practice','fp1','fp2','fp3','fp4','sprint','warm up','race','gara','volley','tennis'];
function isSingleEntity(title: string): boolean { const t = title.toLowerCase(); return SINGLE.some(k=>t.includes(k)); }
function extractTeams(title: string): [string|null,string|null] {
  // Original title example: "19:45 : Hellas Verona vs Sassuolo - Serie A 03/10"
  // We only get the portion after the time externally; still we guard.
  let core = title.trim();
  // Normalizza dash unicode (– —) in semplice '-'
  core = core.replace(/[\u2012\u2013\u2014\u2015]/g,'-');
  // Remove leading optional emoji + time markers like "⏰ 19:45 :" or "19:45 :"
  core = core.replace(/^[^A-Za-z0-9]*\d{1,2}:\d{2}\s*:\s*/, '');
  // Some lines use "19:45 : Team1 - Team2" BEFORE adding competition; detect pattern 
  // We must NOT truncate at first ' - ' because that erases team2. Instead, isolate suffixes with known league/date tokens.
  // Strategy: try to locate a dash that introduces a league/date segment AFTER both team names are detected.
  // We'll attempt extraction on the full core first; only if it fails, we then try removing trailing metadata after the last ' - '.

  function trySplit(str: string): [string|null,string|null] {
    const low = str.toLowerCase();
    // Prefer explicit separators ' x ' or vs variants.
    const sepIdx = low.indexOf(' x ');
    if (sepIdx !== -1) {
      const left = str.slice(0, sepIdx).trim();
      const right = str.slice(sepIdx + 3).trim();
      if (left && right) return [left, right];
    }
    const vsRegex = /\b(vs?|vs\.|v)\b/i;
    const m = vsRegex.exec(str);
    if (m) {
      const left = str.slice(0, m.index).trim();
      const right = str.slice(m.index + m[0].length).trim();
      if (left && right) return [left, right];
    }
    // NUOVO: supporto separatore ' - ' tra due squadre (tenendo conto di eventuale metadata dopo un secondo trattino)
    // Esempi: "Lazio - Torino - Serie A" -> Lazio / Torino
    //         "Milan - Inter" -> Milan / Inter
    const partsDash = str.split(/\s-\s/);
    if (partsDash.length >= 2) {
      // Se ci sono più di 2 parti, assumiamo le prime due sono squadre e il resto metadata
      const left = partsDash[0].trim();
      const right = partsDash[1].trim();
      if (left && right && !/^(serie|liga|premier|bundes|champions|coppa|cup|league)\b/i.test(left) && !/^(serie|liga|premier|bundes|champions|coppa|cup|league)\b/i.test(right)) {
        return [left, right];
      }
    }
    return [null, null];
  }

  // First attempt: full string
  let [a,b] = trySplit(core);
  if (a && b) return [a,b];

  // Second attempt: remove trailing metadata after last ' - ' IF that metadata looks like league/date (contains a date dd/mm or a known league word)
  const lastDash = core.lastIndexOf(' - ');
  if (lastDash !== -1) {
    const suffix = core.slice(lastDash + 3).toLowerCase();
    if (/\b(serie|liga|premier|bundes|champions|coppa|cup|league)\b/.test(suffix) || /\b\d{1,2}\/\d{1,2}\b/.test(suffix)) {
      const candidate = core.slice(0, lastDash).trim();
      [a,b] = trySplit(candidate);
      if (a && b) return [a,b];
    }
  }

  const result: [string|null,string|null] = [a,b];
  if (!result[0] || !result[1]) {
    // Debug ridotto (non invasivo) per analizzare fallimenti parser
    if (/\bvs?\b|\sx\s|\s-\s/.test(core.toLowerCase())) {
      try { console.debug('[SPON][PARSE] impossibile estrarre coppia squadre da:', core); } catch {}
    }
  }
  return result[0] && result[1] ? result : [null,null];
}

export interface SponMatchRow extends SponRow {
  matchQuality: 'strict' | 'alias' | 'single';
}

export interface EventInfo {
  name: string;
  eventStart?: string; // ISO
}

export function matchRowsForEvent(event: EventInfo, schedule: SponRow[]): SponRow[] {
  const { name } = event;
  const [t1, t2] = extractTeams(name);
  const singleMode = (!t1 || !t2) && isSingleEntity(name);
  if (!t1 || !t2) {
    if (!singleMode) return [];
  }
  const evAliases1 = t1 ? teamAliases(t1) : new Set<string>();
  const evAliases2 = t2 ? teamAliases(t2) : new Set<string>();
  const evNormSet = (t1 && t2) ? new Set([normTeam(t1), normTeam(t2)]) : new Set<string>();

  const out: { row: SponRow; quality: 'strict' | 'alias' | 'single' }[] = [];
  for (const r of schedule) {
    const [pt1, pt2] = extractTeams(r.rawMatch);
    if (singleMode) {
      if (isSingleEntity(r.rawMatch)) out.push({ row: r, quality: 'single' });
      continue;
    }
    if (!pt1 || !pt2) continue;
    const pls = new Set([normTeam(pt1), normTeam(pt2)]);
    if (pls.size === 2 && plsEqual(pls, evNormSet)) {
      out.push({ row: r, quality: 'strict' });
      continue;
    }
    const p1a = teamAliases(pt1);
    const p2a = teamAliases(pt2);
    const direct = intersect(p1a, evAliases1) && intersect(p2a, evAliases2);
    const cross = intersect(p2a, evAliases1) && intersect(p1a, evAliases2);
    if (direct || cross) out.push({ row: r, quality: 'alias' });
  }
  // Ordina: strict > alias > single, poi per time
  out.sort((a,b)=>{
    const qOrder = { strict:0, alias:1, single:2 } as any;
    if (qOrder[a.quality] !== qOrder[b.quality]) return qOrder[a.quality]-qOrder[b.quality];
    return a.row.time.localeCompare(b.row.time);
  });
  return out.map(o=>o.row);
}

function intersect(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}
function plsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false; return true;
}
