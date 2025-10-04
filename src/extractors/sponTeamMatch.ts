// Team matching utilities (port from spso_streams.py)

const WORD_CLEAN = /[^a-z0-9]+/g;

// Basic latinize removing accents
export function latinize(txt: string): string {
  try {
    return txt.normalize('NFKD').replace(/\p{M}+/gu, '');
  } catch { return txt; }
}

// Synonyms (subset, extend as needed)
const SYN: Record<string,string> = {
  'internazionale':'inter','inter':'inter','juventus':'juve','juve':'juve','napoli':'napoli',
  'sporting cp':'sporting','sporting clube':'sporting','sporting':'sporting',
  'psg':'psg','paris':'psg','paris saint germain':'psg','saint-germain':'psg','paris sg':'psg',
  'manchester city':'city','man city':'city','mancity':'city','city':'city',
  'atletico madrid':'atletico','atlético madrid':'atletico','athletic club':'athletic','athletic bilbao':'athletic',
  'crvena zvezda':'zvezda','red star':'zvezda','köln':'koln','koln':'koln','bayer leverkusen':'leverkusen',
  'fc porto':'porto','porto':'porto'
};

export function normTeam(name: string): string {
  let n = latinize(name).toLowerCase();
  n = n.replace(WORD_CLEAN,' ').trim();
  const toks = n.split(/\s+/).filter(Boolean);
  if (!toks.length) return '';
  const full = toks.join(' ');
  if (SYN[full]) return SYN[full];
  const filtered = toks.filter(t => !/^\d+$/.test(t));
  const base = filtered.length ? filtered : toks;
  const last = base[base.length-1];
  if (SYN[last]) return SYN[last];
  return last;
}

export function teamAliases(name: string): Set<string> {
  let n = latinize(name).toLowerCase();
  n = n.replace(WORD_CLEAN,' ').trim();
  const toks = n.split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  if (!toks.length) return out;
  const full = toks.join(' ');
  out.add(full);
  if (SYN[full]) out.add(SYN[full]);
  out.add(toks[0]);
  out.add(toks[toks.length-1]);
  if (toks.length >= 2) out.add(toks.slice(-2).join(' '));
  if (toks.length === 2) out.add(toks.join(''));
  for (const t of toks) if (SYN[t]) out.add(SYN[t]);
  return out;
}

// Single-entity keywords
const SINGLE = ['grand prix','gp','formula 1','f1','motogp','qualifying','practice','free practice','fp1','fp2','fp3','sprint','volley','volleyball','tennis'];
export function isSingleEntity(title: string): boolean {
  const t = title.toLowerCase();
  return SINGLE.some(k => t.includes(k));
}

// Extract teams similar to python version
export function extractTeams(title: string): [string|null,string|null] {
  let core = title.trim();
  // remove leading clock / emoji pattern "⏰ 21:00 : "
  if (core.includes(' : ')) {
    const parts = core.split(' : ');
    if (parts.length>1) core = parts.slice(1).join(' : '); // drop first chunk
  }
  if (core.includes(' - ')) core = core.split(' - ',1)[0].trim();
  const low = core.toLowerCase();
  // primary separator ' x '
  const sepIdx = low.indexOf(' x ');
  if (sepIdx !== -1) {
    const left = core.slice(0, sepIdx).trim();
    const right = core.slice(sepIdx + 3).trim();
    if (left && right) return [left, right];
  }
  // fallback vs / vs. / v
  const vsRegex = /\b(vs?|vs\.|v)\b/i;
  const m = vsRegex.exec(core);
  if (m) {
    const left = core.slice(0, m.index).trim();
    const right = core.slice(m.index + m[0].length).trim();
    if (left && right) return [left, right];
  }
  return [null,null];
}
