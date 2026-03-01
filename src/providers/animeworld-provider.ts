import { spawn } from 'child_process';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { KitsuProvider } from './kitsu';
import { getDomain } from '../utils/domains';
// import { formatMediaFlowUrl } from '../utils/mediaflow'; // disabilitato: usiamo URL mp4 diretto
import { AnimeWorldConfig, AnimeWorldResult, AnimeWorldEpisode, StreamForStremio } from '../types/animeunity';
import { checkIsAnimeById, applyUniversalAnimeTitleNormalization } from '../utils/animeGate';

// Cache semplice in-memory per titoli tradotti per evitare chiamate ripetute
const englishTitleCache = new Map<string, string>();

// Helper to invoke python scraper with timeout & timing logs
async function invokePython(args: string[], timeoutOverrideMs?: number): Promise<any> {
  const scriptPath = path.join(__dirname, 'animeworld_scraper.py');
  const timeoutMsBase = parseInt(process.env.ANIMEWORLD_PY_TIMEOUT || '60000', 10); // default 20s
  const timeoutMs = timeoutOverrideMs || timeoutMsBase;
  const start = Date.now();
  console.log('[AnimeWorld][PY] spawn', args.join(' '));
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [scriptPath, ...args]);
    let stdout = '';
    let stderr = '';
    let finished = false;
    const killTimer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { py.kill('SIGKILL'); } catch {}
      console.error(`[AnimeWorld][PY] timeout after ${timeoutMs}ms for args:`, args.join(' '));
      reject(new Error('AnimeWorld python timeout'));
    }, timeoutMs);
    py.stdout.on('data', (d: Buffer) => stdout += d.toString());
    py.stderr.on('data', (d: Buffer) => stderr += d.toString());
    py.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      const dur = Date.now() - start;
      if (code !== 0) {
        console.error('[AnimeWorld][PY] exit code', code, 'stderr:', stderr.slice(0,500));
        return reject(new Error(stderr || 'Python error'));
      }
      try {
        const parsed = JSON.parse(stdout);
        console.log(`[AnimeWorld][PY] success (${dur}ms)`);
        resolve(parsed);
      } catch (e) {
        console.error('[AnimeWorld][PY] JSON parse error', e, 'raw len:', stdout.length);
        reject(e);
      }
    });
    py.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(killTimer);
      console.error('[AnimeWorld][PY] process error', err);
      reject(err);
    });
  });
}

// Reuse logic from other providers (duplicated for rapid integration)
async function getEnglishTitleFromAnyId(id: string, type: 'imdb'|'tmdb'|'kitsu'|'mal', tmdbApiKey?: string): Promise<string> {
  const cacheKey = `${type}:${id}`;
  if (englishTitleCache.has(cacheKey)) return englishTitleCache.get(cacheKey)!;
  let malId: string | null = null;
  let tmdbId: string | null = null;
  let fallbackTitle: string | null = null;
  const tmdbKey = tmdbApiKey || process.env.TMDB_API_KEY || '';
  if (type === 'imdb') {
    if (!tmdbKey) throw new Error('TMDB_API_KEY non configurata');
    const imdbIdOnly = id.split(':')[0];
    const { getTmdbIdFromImdbId } = await import('../extractor');
    tmdbId = await getTmdbIdFromImdbId(imdbIdOnly, tmdbKey, 'tv');
    if (!tmdbId) throw new Error('TMDB ID non trovato per IMDB: ' + id);
    try {
      const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json();
      malId = haglundResp[0]?.myanimelist?.toString() || null;
    } catch {}
  } else if (type === 'tmdb') {
    tmdbId = id;
    try { const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json(); malId = haglundResp[0]?.myanimelist?.toString() || null; } catch {}
  } else if (type === 'kitsu') {
    // 1. Prova a ottenere MAL mapping per poter usare Jikan (English ufficiale)
    try {
      const mappingsResp = await (await fetch(`https://kitsu.io/api/edge/anime/${id}/mappings`)).json();
      const malMapping = mappingsResp.data?.find((m: any) => m.attributes.externalSite === 'myanimelist/anime');
      malId = malMapping?.attributes?.externalId?.toString() || null;
      console.log('[AnimeWorld][UTitle][Kitsu] primary mappings malId=', malId);
    } catch {}
    // 2. Precarica candidato canonico ma NON restituire ancora (lasciamo chance a Jikan)
    try {
      const animeResp = await (await fetch(`https://kitsu.io/api/edge/anime/${id}`)).json();
      const attr = animeResp.data?.attributes || {};
      const canonical = attr.titles?.en || attr.title_en || attr.titles?.en_jp || attr.canonicalTitle || attr.slug || null;
      if (canonical) fallbackTitle = canonical;
      console.log('[AnimeWorld][UTitle][Kitsu] canonical fallback candidate=', fallbackTitle);
    } catch {}
    // 3. Se ancora nessun malId prova endpoint include=mappings (alcuni casi differiscono)
    if (!malId) {
      try {
        const incResp = await (await fetch(`https://kitsu.io/api/edge/anime/${id}?include=mappings`)).json();
        const included = incResp.included || [];
        for (const inc of included) {
          if (inc.type === 'mappings' && inc.attributes?.externalSite === 'myanimelist/anime') {
            malId = inc.attributes.externalId?.toString() || null;
            console.log('[AnimeWorld][UTitle][Kitsu] include=mappings malId=', malId);
            break;
          }
        }
      } catch {}
    }
  } else if (type === 'mal') {
    malId = id;
  }
  if (malId) {
    try {
      const jikanResp = await (await fetch(`https://api.jikan.moe/v4/anime/${malId}`)).json();
      let englishTitle = '';
      if (jikanResp.data && Array.isArray(jikanResp.data.titles)) {
        const en = jikanResp.data.titles.find((t: any) => t.type === 'English');
        englishTitle = en?.title || '';
      }
      if (!englishTitle && jikanResp.data) {
        englishTitle = jikanResp.data.title_english || jikanResp.data.title || jikanResp.data.title_japanese || '';
      }
      if (englishTitle) {
        englishTitleCache.set(cacheKey, englishTitle);
        console.log('[AnimeWorld][UTitle] resolved via Jikan', { type, id, malId, englishTitle });
        return englishTitle;
      }
      console.log('[AnimeWorld][UTitle] Jikan no EnglishTitle, will fallback', { type, id, malId });
    } catch {}
  }
  if (tmdbId && tmdbKey) {
    try {
      let tmdbResp = await (await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}?api_key=${tmdbKey}`)).json();
      if (tmdbResp && tmdbResp.name) fallbackTitle = tmdbResp.name;
      if (!fallbackTitle) {
        tmdbResp = await (await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${tmdbKey}`)).json();
        if (tmdbResp && tmdbResp.title) fallbackTitle = tmdbResp.title;
      }
      if (fallbackTitle) return fallbackTitle;
    } catch {}
  }
  // Ultimo fallback: se abbiamo un fallbackTitle derivato da TMDB o Kitsu lo usiamo; altrimenti prova a usare id stesso (non ideale ma evita crash)
  if (fallbackTitle) {
    englishTitleCache.set(cacheKey, fallbackTitle);
    console.log('[AnimeWorld][UTitle] using fallbackTitle', { type, id, fallbackTitle });
    return fallbackTitle;
  }
  // Se variabile env indica di non interrompere, ritorna un placeholder
  if (process.env.AW_ALLOW_EMPTY_TITLE === 'true') {
    console.warn('[AnimeWorld] Fallback placeholder title for id', id);
    const placeholder = 'Anime';
    englishTitleCache.set(cacheKey, placeholder);
    return placeholder;
  }
  throw new Error('Impossibile ottenere titolo inglese per ' + id);
}

// ==== AUTO-NORMALIZATION-EXACT-MAP-START ====
const exactMap: Record<string, string> = {

      "Cat's\u2665Eye": "Occhi di gatto (2025)",
      "Cat's Eye (2025)": "Occhi di gatto (2025)",


      "Ranma \u00bd (2024) Season 2": "Ranma \u00bd (2024) 2",
      "Ranma1/2 (2024) Season 2": "Ranma \u00bd (2024) 2",


      "Link Click Season 2": "Link Click 2",



      "K: SEVEN STORIES Lost Small World - Outside the Cage - ": "K: Seven Stories Movie 4 - Lost Small World - Ori no Mukou ni",




      "Nichijou - My Ordinary Life": "Nichijou",

      "Case Closed Movie 01: The Time Bombed Skyscraper": "Detective Conan Movie 01: Fino alla fine del tempo",
      "My Hero Academia Final Season": "Boku no Hero Academia: Final Season",






      "Jujutsu Kaisen: The Culling Game Part 1": "Jujutsu Kaisen 3: The Culling Game Part 1",






      "Hell's Paradise Season 2": "Hell's Paradise 2",







      "[Oshi no Ko]": "Oshi no Ko",








  // << AUTO-INSERT-EXACT >> (non rimuovere questo commento)
};
// ==== AUTO-NORMALIZATION-EXACT-MAP-END ====

// ==== AUTO-NORMALIZATION-GENERIC-MAP-START ====
const genericMap: Record<string, string> = {


  // << AUTO-INSERT-GENERIC >> (non rimuovere questo commento)
  // Qui puoi aggiungere altre normalizzazioni custom
};
// ==== AUTO-NORMALIZATION-GENERIC-MAP-END ====

function resolveExactMapKey(originalTitle: string, universalTitle: string): string | null {
  if (Object.prototype.hasOwnProperty.call(exactMap, originalTitle)) {
    return originalTitle;
  }
  if (Object.prototype.hasOwnProperty.call(exactMap, universalTitle)) {
    return universalTitle;
  }
  return null;
}

function normalizeTitleForSearch(title: string, exactKey?: string | null): string {
  const key = exactKey && Object.prototype.hasOwnProperty.call(exactMap, exactKey)
    ? exactKey
    : (Object.prototype.hasOwnProperty.call(exactMap, title) ? title : null);
  if (key) {
    const mapped = exactMap[key];
    console.log(`[AnimeWorld][ExactMap] Hit: "${key}" -> "${mapped}"`);
    return mapped;
  }
  const replacements: Record<string, string> = {
    'Attack on Titan': "L'attacco dei Giganti",
    'Season': '',
    'Shippuuden': 'Shippuden',
    'Solo Leveling 2': 'Solo Leveling 2:',
    'Solo Leveling 2 :': 'Solo Leveling 2:',
    '-': '',
  };
  let normalized = title;
  for (const [k,v] of Object.entries(replacements)) {
    if (normalized.includes(k)) normalized = normalized.replace(new RegExp(k,'gi'), v);
  }
  if (normalized.includes('Naruto:')) normalized = normalized.replace(':','');
  return normalized.replace(/\s{2,}/g,' ').trim();
}

// Semplice scorer: distanza basata su differenza lunghezza + mismatch caratteri posizione-invariante
function scoreOriginalMatch(slug: string, normKey: string): number {
  const s = slug.toLowerCase();
  // estrai parte base prima di punto/random id
  const base = s.split('.')[0];
  // normalizza slug base
  const cleaned = base.replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
  if (cleaned === normKey) return 0;
  // calcola distanza approssimata
  const a = cleaned;
  const b = normKey;
  const lenDiff = Math.abs(a.length - b.length);
  let mismatches = 0;
  const minLen = Math.min(a.length, b.length);
  for (let i=0;i<minLen;i++) if (a[i] !== b[i]) mismatches++;
  return lenDiff * 2 + mismatches; // peso maggiore a differenza lunghezza
}

export class AnimeWorldProvider {
  private kitsuProvider = new KitsuProvider();
  constructor(private config: AnimeWorldConfig) {}

  private playLangCache = new Map<string,'ITA'|'SUB ITA'>();
  private playLangSubChecked = new Set<string>();
  private async inferLanguageFromPlayPage(slug: string): Promise<'ITA' | 'SUB ITA'> {
    const cacheKey = slug;
    if (this.playLangCache.has(cacheKey)) {
      const cached = this.playLangCache.get(cacheKey)!;
      // If cached ITA, return immediately. If SUB ITA and not yet rechecked, fall through to re-fetch to allow upgrade.
      if (cached === 'ITA') return cached;
      if (cached === 'SUB ITA' && this.playLangSubChecked.has(cacheKey)) return cached;
      if (cached === 'SUB ITA' && !this.playLangSubChecked.has(cacheKey)) {
        // mark so that only one recheck happens
        this.playLangSubChecked.add(cacheKey);
        console.log('[AnimeWorld][LangProbe] Rechecking SUB ITA cached slug for possible DUB upgrade:', slug);
      }
    }
    const awDom = getDomain('animeworld') || 'animeworld.ac';
    const urls = [ `https://www.${awDom}/play/${slug}` ];
    for (const url of urls) {
      try {
        const headerVariants: Record<string,string>[] = [
          { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Accept-Language':'it-IT,it;q=0.9,en;q=0.6', 'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
          { 'User-Agent': 'Mozilla/5.0 AWLangProbe', 'Accept-Language':'it-IT,it;q=0.9,en;q=0.6' }
        ];
        let html: string | null = null;
        let lastStatus: number | null = null;
        for (const headers of headerVariants) {
          const r = await fetch(url, { headers });
          lastStatus = r.status;
          if (!r.ok) {
            console.log(`[AnimeWorld][LangProbe] ${slug} status=${r.status} ua=${headers['User-Agent'].slice(0,40)}`);
            continue;
          }
            html = await r.text();
            console.log(`[AnimeWorld][LangProbe] OK status=${r.status} for ${slug} using UA=${headers['User-Agent'].slice(0,40)}`);
            break;
        }
        if (!html) {
          console.log('[AnimeWorld][LangProbe] Failed all header variants for', slug, 'lastStatus=', lastStatus, '-> trying curl fallback');
          try {
            const curl = spawnSync('curl', ['-L','-s','-A','Mozilla/5.0 (Windows NT 10.0; Win64; x64)','-H','Accept-Language: it-IT,it;q=0.9,en;q=0.6', url], { timeout: 8000 });
            if (curl.status === 0 && curl.stdout) {
              html = curl.stdout.toString();
              console.log('[AnimeWorld][LangProbe] curl fallback OK for', slug, 'size=', html.length);
            } else {
              console.log('[AnimeWorld][LangProbe] curl fallback failed code=', curl.status, 'signal=', curl.signal);
            }
          } catch (e) {
            console.log('[AnimeWorld][LangProbe] curl fallback exception', e);
          }
          if (!html) continue; // try next URL (future expansion)
        }
        // Strong DUB detection only (avoid plain (ITA) noise):
        // 1. window.animeDub = true
        // 2. Any class with 'dub'
        // 3. Words doppiato/doppiata/doppi
        // 4. Standalone >DUB<
        const lower = html.toLowerCase();
        let isDub = false;
        if (/window\.animeDub\s*=\s*true/i.test(html)) isDub = true;
        else if (/class=["'][^"']*\bdub\b[^"']*["']/i.test(html)) isDub = true;
        else if (/>\s*dub\s*</i.test(html)) isDub = true;
        else if (/doppiat[oa]|doppi\b/.test(lower)) isDub = true;
        if (isDub) {
          console.log('[AnimeWorld][LangProbe] Detected DUB badge -> ITA for', slug);
          this.playLangCache.set(cacheKey, 'ITA');
          return 'ITA';
        }
        this.playLangCache.set(cacheKey, 'SUB ITA');
        return 'SUB ITA';
      } catch { /* try next url */ }
    }
    // Fallback assume SUB ITA
    this.playLangCache.set(cacheKey, 'SUB ITA');
    return 'SUB ITA';
  }

  async searchAllVersions(title: string): Promise<AnimeWorldResult[]> {
    try {
      const raw: AnimeWorldResult[] = await invokePython(['search','--query', title]);
      if (!raw) return [];
      const normSlugKey = title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');

      // Regole richieste:
      // 1. Se slug contiene pattern sub ita -> SUB ITA
      // 2. Altrimenti se slug contiene ita -> ITA
      // 3. Altrimenti (slug "base", nessun marcatore) -> probe HTML UNA VOLTA
      //    Se page mostra DUB forte -> ITA, else SUB ITA
      // Evitare probe per slug già marcati.

  // Pattern lingua (ordine: SUB prima per evitare che 'subita' attivi 'ita')
  const SUB_PAT = /(?:^|[\-_.])sub(?:[-_]?ita)?(?:$|[\-_.])/i; // sub, subita, sub-ita
  const ITA_PAT = /(?:^|[\-_.])(cr[-_]?ita|ita[-_]?cr|ita)(?:$|[\-_.])/i; // ita, cr-ita, crita, ita-cr

      // Colleziona slug che richiedono probe (base slugs)
      const probeQueue: string[] = [];
      const baseSlugSet = new Set<string>();

      interface TempRes { baseMatch: boolean; nameRaw: string; slugRaw: string; language_type: 'ORIGINAL' | 'SUB ITA' | 'CR ITA' | 'ITA' | 'NEEDS_PROBE'; }
      const prelim: TempRes[] = raw.map(r => {
        const nameRaw = r.name || '';
        const slugRaw = r.slug || '';
        const slugLower = slugRaw.toLowerCase();
        let language_type: TempRes['language_type'] = 'ORIGINAL';
        // 1. Marker nello slug
        if (SUB_PAT.test(slugLower)) {
          language_type = 'SUB ITA';
        } else if (ITA_PAT.test(slugLower)) {
          language_type = 'ITA';
        } else {
          // Nessun marcatore nello slug -> probe HTML successiva
          const basePartProbe = slugLower.split('.')[0];
          const cleanedProbe = basePartProbe.replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
          if (!baseSlugSet.has(cleanedProbe)) {
            probeQueue.push(slugRaw);
            baseSlugSet.add(cleanedProbe);
          }
          language_type = 'NEEDS_PROBE';
        }
        const basePart = slugLower.split('.')[0];
        const cleaned = basePart.replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
        const baseMatch = cleaned === normSlugKey;
        return { baseMatch, nameRaw, slugRaw, language_type };
      });

      // Probe funzione ridotta (solo segnali forti)
      const probeLang = async (slug: string): Promise<'ITA' | 'SUB ITA'> => {
        try {
          const awDom = getDomain('animeworld') || 'animeworld.ac';
          const url = `https://www.${awDom}/play/${slug}`;
          const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 AWProbe', 'Accept-Language': 'it-IT,it;q=0.9' } });
          if (!r.ok) return 'SUB ITA';
          const html = await r.text();
          // Limita l'analisi SOLO al blocco relativo allo slug richiesto per evitare contaminazioni da altre versioni (es. variante DUB a fianco)
          const slugSafe = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Trova anchor principale
          const anchorRe = new RegExp(`<a[^>]+href=["']/play/${slugSafe}["'][^>]*>[\\s\\S]*?</a>`, 'i');
          let snippet = '';
          const anchorMatch = html.match(anchorRe);
          if (anchorMatch) {
            // Estendi la finestra includendo eventuale div.status e label vicini (greedy fino a ~400 chars dopo l'anchor)
            const idx = html.indexOf(anchorMatch[0]);
            snippet = html.substring(Math.max(0, idx - 300), Math.min(html.length, idx + anchorMatch[0].length + 400));
          } else {
            // Fallback: usa intera pagina (ma logga)
            snippet = html;
            console.log('[AnimeWorld][LangProbe][WARN] Anchor snippet non trovato per', slug, 'uso fallback pagina intera');
          }
          const lowerSnippet = snippet.toLowerCase();
          const strongDubLocal = /window\.animeDub\s*=\s*true/i.test(snippet)
            || /class=["'][^"']*\bdub\b[^"']*"/i.test(snippet)
            || />\s*dub\s*</i.test(snippet)
            || /doppiat[oa]|doppi\b/i.test(lowerSnippet);
          if (strongDubLocal) {
            console.log('[AnimeWorld][LangProbe] Strong DUB markers (scoped) -> ITA for', slug);
            return 'ITA';
          }
          const selfIta = /\(\s*ITA\s*\)/i.test(snippet) || /data-jtitle=\"[^\"]*\(\s*ITA\s*\)[^\"]*\"/i.test(snippet);
          if (selfIta) {
            console.log('[AnimeWorld][LangProbe] (ITA) marker inside own block -> ITA for', slug);
            return 'ITA';
          }
          // Default SUB ITA
          return 'SUB ITA';
        } catch { return 'SUB ITA'; }
      };

      // Esegui probe in serie (pochi slug base)
      for (const slug of probeQueue) {
        const lang = await probeLang(slug);
        prelim.filter(p => p.slugRaw === slug && p.language_type === 'NEEDS_PROBE').forEach(p => p.language_type = lang);
      }

      const mapped = prelim.map(p => ({
        ...raw.find(r => r.slug === p.slugRaw)!,
        language_type: p.language_type === 'NEEDS_PROBE' ? 'SUB ITA' : p.language_type
      }));

      // Regola aggiuntiva: se il nome e' vuoto e lo slug era "base" (nessun marcatore originale) forza SUB ITA
      mapped.forEach(m => {
        if (!m.name || !m.name.trim()) {
          const slugLower = (m.slug || '').toLowerCase();
          const basePart = slugLower.split('.')[0];
          const hasSub = SUB_PAT.test(slugLower);
          const hasIta = ITA_PAT.test(slugLower);
          if (!hasSub && !hasIta) {
            if (m.language_type === 'ITA') {
              console.log('[AnimeWorld][LangMap][AdjustEmptyName] Forzo SUB ITA per slug base con name vuoto:', m.slug);
            }
            m.language_type = 'SUB ITA';
          }
        }
      });

      mapped.forEach(m => {
        console.log('[AnimeWorld][LangMap][DecisionSimple]', {
          slug: m.slug,
          name: m.name,
          final: m.language_type
        });
      });
      console.log('[AnimeWorld] search versions sample:', mapped.slice(0,12).map(v => `${v.language_type}:${v.slug}`).join(', '));
      return mapped;
    } catch (e) {
      console.error('[AnimeWorld] search error', e);
      return [];
    }
  }

  async handleKitsuRequest(kitsuIdString: string): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) return { streams: [] };
    try {
      const { kitsuId, seasonNumber, episodeNumber, isMovie } = this.kitsuProvider.parseKitsuId(kitsuIdString);
      // Fetch startDate for fallback filter-year logic (only for kitsu ids)
      try {
        const metaResp = await fetch(`https://kitsu.io/api/edge/anime/${kitsuId}`);
        if (metaResp.ok) {
          const metaJson: any = await metaResp.json();
          const startDate: string | undefined = metaJson?.data?.attributes?.startDate;
          if (startDate) (this as any)._lastKitsuStartDate = startDate;
        }
      } catch (e) {
        console.warn('[AnimeWorld] startDate fetch failed for kitsu id', kitsuId, e);
      }
  // NOTE (Approach 2 active): We now resolve a universal EN title via MAL/Kitsu mappings (getEnglishTitleFromAnyId)
  // Old approach (commented) used the raw Kitsu canonical title directly, e.g.:
  //   const kitsuRaw = await this.kitsuProvider.fetchTitle(kitsuId)  <-- NON PIU' USATO
  //   return this.handleTitleRequest(kitsuRaw, seasonNumber, episodeNumber, isMovie);
  // This produced verbose strings like "Devil May Cry: The Animated Series".
  // The new approach normalizes across providers, giving just "Devil May Cry" when available.
  const englishTitle = await getEnglishTitleFromAnyId(kitsuId, 'kitsu', this.config.tmdbApiKey);
      return this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
    } catch (e) {
      console.error('[AnimeWorld] kitsu handler error', e);
      return { streams: [] };
    }
  }
  async handleMalRequest(malIdString: string): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) return { streams: [] };
    try {
      const parts = malIdString.split(':');
      if (parts.length < 2) throw new Error('Formato MAL ID non valido');
      const malId = parts[1];
      let seasonNumber: number | null = null;
      let episodeNumber: number | null = null;
      let isMovie = false;
      if (parts.length === 2) isMovie = true; else if (parts.length === 3) episodeNumber = parseInt(parts[2]); else if (parts.length === 4) { seasonNumber = parseInt(parts[2]); episodeNumber = parseInt(parts[3]); }
      const englishTitle = await getEnglishTitleFromAnyId(malId, 'mal', this.config.tmdbApiKey);
      return this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
    } catch (e) { console.error('[AnimeWorld] mal handler error', e); return { streams: [] }; }
  }
  async handleImdbRequest(imdbId: string, seasonNumber: number | null, episodeNumber: number | null, isMovie=false): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) return { streams: [] };
    try {
      const gateEnabled = (process.env.ANIME_GATE_ENABLED || 'true') !== 'false';
      if (gateEnabled) {
        const gate = await checkIsAnimeById('imdb', imdbId, this.config.tmdbApiKey, isMovie ? 'movie' : 'tv');
        if (!gate.isAnime) {
          console.log(`[AnimeWorld] Skipping anime search: no MAL/Kitsu mapping (${gate.reason}) for ${imdbId}`);
          return { streams: [] };
        }
  // Removed placeholder injection; icon added directly to titles
      }
  const englishTitle = await getEnglishTitleFromAnyId(imdbId, 'imdb', this.config.tmdbApiKey);
  const res = await this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
  res.streams = res.streams.map(s => s.title.startsWith('⚠️') ? s : { ...s, title: `⚠️ ${s.title}` });
  return res;
    } catch(e){ console.error('[AnimeWorld] imdb handler error', e); return { streams: [] }; }
  }
  async handleTmdbRequest(tmdbId: string, seasonNumber: number | null, episodeNumber: number | null, isMovie=false): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) return { streams: [] };
    try {
      const gateEnabled = (process.env.ANIME_GATE_ENABLED || 'true') !== 'false';
      if (gateEnabled) {
        const gate = await checkIsAnimeById('tmdb', tmdbId, this.config.tmdbApiKey, isMovie ? 'movie' : 'tv');
        if (!gate.isAnime) {
          console.log(`[AnimeWorld] Skipping anime search: no MAL/Kitsu mapping (${gate.reason}) for TMDB ${tmdbId}`);
          return { streams: [] };
        }
  // Removed placeholder injection; icon added directly to titles
      }
  const englishTitle = await getEnglishTitleFromAnyId(tmdbId, 'tmdb', this.config.tmdbApiKey);
  const res = await this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie);
  res.streams = res.streams.map(s => s.title.startsWith('⚠️') ? s : { ...s, title: `⚠️ ${s.title}` });
  return res;
    } catch(e){ console.error('[AnimeWorld] tmdb handler error', e); return { streams: [] }; }
  }

  async handleTitleRequest(title: string, seasonNumber: number | null, episodeNumber: number | null, isMovie = false): Promise<{ streams: StreamForStremio[] }> {
    const universalTitle = applyUniversalAnimeTitleNormalization(title);
    if (universalTitle !== title) {
      console.log(`[UniversalTitle][Applied] ${title} -> ${universalTitle}`);
    }

    const exactMapKey = resolveExactMapKey(title, universalTitle);
    const normalized = normalizeTitleForSearch(universalTitle, exactMapKey);
    const skipExtraNormalization = !!exactMapKey;
    if (skipExtraNormalization) {
      console.log(`[AnimeWorld][ExactMap] Forced search title: ${normalized}`);
    }

    const searchWithLogging = async (query: string) => {
      const results = await this.searchAllVersions(query);
      console.log(`[AnimeWorld] Search query "${query}" -> ${results.length}`);
      return results;
    };

    console.log('[AnimeWorld] Title original:', title);
    console.log('[AnimeWorld] Title normalized:', normalized);

    let versions = await searchWithLogging(normalized);

    if (!skipExtraNormalization && !versions.length) {
      const fallbackQueries: string[] = [];
      if (normalized.includes("'")) fallbackQueries.push(normalized.replace(/'/g, ''));
      if (normalized.includes('(')) fallbackQueries.push(normalized.split('(')[0].trim());
      const words = normalized.split(' ');
      if (words.length > 3) fallbackQueries.push(words.slice(0, 3).join(' '));
      const plus = normalized.replace(/\s+/g, '+');
      if (plus !== normalized) fallbackQueries.push(plus);

      for (const query of fallbackQueries) {
        if (!query || query === normalized) continue;
        const res = await searchWithLogging(query);
        if (res.length) {
          versions = res;
          break;
        }
      }
    } else if (skipExtraNormalization && !versions.length) {
      console.warn(`[AnimeWorld][ExactMap] Nessun risultato trovato per titolo mappato "${normalized}" (fallback disabilitati).`);
    }

    console.log('[AnimeWorld] Versions found:', versions.length);
    const debugLangCounts = versions.reduce((acc: Record<string, number>, item) => {
      const key = item.language_type || 'UNKNOWN';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    console.log('[AnimeWorld] Language type counts:', debugLangCounts);

    if (!versions.length) {
      const fallbackDate = (this as any)._lastKitsuStartDate as string | undefined;
      if (fallbackDate) {
        try {
          const fb = await this.fallbackFilterYearSearch(normalized, fallbackDate, isMovie, episodeNumber, seasonNumber);
          if (fb.streams.length) {
            return fb;
          }
          console.log('[AnimeWorld] Fallback filter-year search produced 0 streams.');
        } catch (err) {
          console.warn('[AnimeWorld] Fallback filter-year search errored:', err);
        }
      }
      return { streams: [] };
    }

    if (!skipExtraNormalization) {
      try {
        const normSlugKey = normalized.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const wantsRewrite = /rewrite/i.test(normalized);
        if (!wantsRewrite) {
          const allowedSuffixes = ['-ita', '-subita', '-sub-ita', '-cr-ita', '-ita-cr'];
          const beforeCount = versions.length;
          const filtered = versions.filter(v => {
            const raw = (v.slug || v.name || '').toLowerCase();
            const basePart = raw.split('.')[0];
            const cleaned = basePart.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            if (/rewrite\b/.test(cleaned)) return false;
            if (cleaned === normSlugKey) return true;
            return allowedSuffixes.some(suf => cleaned === normSlugKey + suf);
          });
          console.log(`[AnimeWorld] Strict base filter applied (${normSlugKey}) from ${beforeCount} -> ${filtered.length}`);
          if (!filtered.length) {
            console.log('[AnimeWorld] Strict filter produced 0 results, NOT restoring broad matches (no full title match).');
            const fallbackDate = (this as any)._lastKitsuStartDate as string | undefined;
            if (fallbackDate) {
              try {
                console.log('[AnimeWorld] Invoking fallbackFilterYearSearch AFTER strict filter zero-match, date=', fallbackDate);
                const fb = await this.fallbackFilterYearSearch(normalized, fallbackDate, isMovie, episodeNumber, seasonNumber);
                if (fb.streams.length) {
                  return fb;
                }
                console.log('[AnimeWorld] fallbackFilterYearSearch produced 0 streams after strict filter.');
              } catch (err) {
                console.warn('[AnimeWorld] fallbackFilterYearSearch post-strict error:', err);
              }
            }
            return { streams: [] };
          }
          versions = filtered;
        } else {
          console.log('[AnimeWorld] Rewrite detected in normalized title, keeping rewrite variants alongside base');
        }
      } catch (e) {
        console.warn('[AnimeWorld] Strict base slug filter error (ignored):', e);
      }
    } else {
      console.log('[AnimeWorld][ExactMap] Skip strict base slug filter (exact map enforced).');
    }

    const rank = (v: AnimeWorldResult & { language_type?: string }) => {
      if (v.language_type === 'ITA') return 0;
      if (v.language_type === 'SUB ITA') return 1;
      if (v.language_type === 'CR ITA') return 2;
      return 3;
    };
    versions.sort((a, b) => rank(a) - rank(b));
    console.log('[AnimeWorld] Top versions sample:', versions.slice(0, 8).map(v => `${v.language_type}:${v.slug}`).join(', '));

    let reduced = versions.filter(v => v.language_type === 'ITA' || v.language_type === 'SUB ITA' || v.language_type === 'CR ITA');
    if (!reduced.length) reduced = versions.slice(0, 1);

    const isMovieSlug = (v: any) => {
      const s = (v.slug || v.name || '').toLowerCase();
      return s.includes('movie') || /-movie-/.test(s);
    };

    let selected: typeof reduced = [];
    if (episodeNumber != null && !isMovie) {
      selected = reduced.filter(v => !isMovieSlug(v));
    } else {
      selected = reduced.slice(0, 2);
    }
    console.log('[AnimeWorld] Processing versions (candidates):', selected.map(v => `${v.language_type}:${v.slug || v.name}`).join(', '));

    const seen = new Set<string>();
    const tBatch = Date.now();

    const episodeInfos = await Promise.all(selected.map(async v => {
      try {
        const t0 = Date.now();
        const episodes: AnimeWorldEpisode[] = await invokePython(['get_episodes', '--anime-slug', v.slug]);
        if (!episodes || !episodes.length) return null;
        let target: AnimeWorldEpisode | undefined;
        if (isMovie) {
          target = episodes[0];
        } else if (episodeNumber != null) {
          target = episodes.find(e => e.number === episodeNumber);
          if (!target) {
            console.log(`[AnimeWorld] Skipping ${v.language_type} version: episode ${episodeNumber} not found for slug=${v.slug}`);
            return null;
          }
        } else {
          target = episodes[0];
        }
        if (!target) return null;
        return { v, target, ms: Date.now() - t0 };
      } catch (e) {
        console.error('[AnimeWorld] get_episodes error', v.slug, e);
        return null;
      }
    }));

    const streamObjs = await Promise.all(episodeInfos.filter(Boolean).map(async info => {
      if (!info) return null;
      const { v, target } = info;
      try {
        const epNum = episodeNumber != null ? episodeNumber : target.number;
        console.log(`[AnimeWorld] Fetching stream for slug=${v.slug} ep=${epNum}`);
        let streamData: any = null;
        let timedOut = false;
        try {
          streamData = await invokePython(['get_stream', '--anime-slug', v.slug, ...(epNum != null ? ['--episode', String(epNum)] : [])]);
        } catch (e: any) {
          if (e && /timeout/i.test(String(e.message))) {
            timedOut = true;
            console.warn('[AnimeWorld] get_stream timeout, retry extended 30s:', v.slug);
          } else {
            throw e;
          }
        }
        if (timedOut) {
          try {
            streamData = await invokePython(['get_stream', '--anime-slug', v.slug, ...(epNum != null ? ['--episode', String(epNum)] : [])], 30000);
          } catch (e2) {
            console.error('[AnimeWorld] get_stream retry failed', v.slug, e2);
            return null;
          }
        }

        const mp4 = streamData?.mp4_url;
        if (!mp4) return null;

        if (!isMovie && episodeNumber != null) {
          const lowerUrl = mp4.toLowerCase();
          const epStr = episodeNumber.toString();
          const epPadded2 = epStr.padStart(2, '0');
          const epPadded3 = epStr.padStart(3, '0');
          const looksLikeEpisode = /ep[_-]?\d{1,3}/i.test(lowerUrl) || lowerUrl.includes(`_${epPadded2}_`) || lowerUrl.includes(`_${epPadded3}_`);
          const isMovieFile = lowerUrl.includes('movie');
          const isSpecialFile = lowerUrl.includes('special');
          if ((isMovieFile || isSpecialFile) && !looksLikeEpisode) {
            console.log('[AnimeWorld] Skipping non-episode file (movie/special) for requested ep:', mp4);
            return null;
          }
        }

        const finalUrl = mp4;
        if (seen.has(finalUrl)) return null;
        seen.add(finalUrl);

        let cleanName = v.name.replace(/\r?\n+/g, ' ').replace(/\s{2,}/g, ' ').trim();
        cleanName = cleanName
          .replace(/\bDUB\b/gi, '')
          .replace(/\(ITA\)/gi, '')
          .replace(/\(CR\)/gi, '')
          .replace(/CR/gi, '')
          .replace(/ITA/gi, '')
          .replace(/Movie/gi, '')
          .replace(/Special/gi, '')
          .replace(/\s{2,}/g, ' ')
          .trim();

        let baseName = cleanName;
        const looksLikeLangOnly = /^[A-Z]{2,4}$/i.test(baseName || '');
        if (!baseName || baseName.length < 3 || looksLikeLangOnly) {
          const slugBase = ((v.slug || '') as string).toLowerCase().split('.')[0];
          let fromSlug = slugBase
            .replace(/(?:^|[-_])(sub[-_]?ita|cr[-_]?ita|ita[-_]?cr|ita)(?:$|[-_])/gi, ' ')
            .replace(/[^a-z0-9]+/gi, ' ')
            .trim();
          if (!fromSlug) fromSlug = (normalized || title || '').toString();
          baseName = fromSlug;
        }

        const sNum = seasonNumber || 1;
        let langLabel = 'SUB';
        if (v.language_type === 'ITA') langLabel = 'ITA';
        else if (v.language_type === 'SUB ITA') langLabel = 'SUB';
        else if (v.language_type === 'CR ITA') langLabel = 'CR';

        let titleStream = `${capitalize(baseName)} ▪ ${langLabel} ▪ S${sNum}`;
        if (episodeNumber) titleStream += `E${episodeNumber}`;

        return { title: titleStream, url: finalUrl } as StreamForStremio;
      } catch (e) {
        console.error('[AnimeWorld] get_stream error', v.slug, e);
        return null;
      }
    }));

    const streams = streamObjs.filter(Boolean) as StreamForStremio[];
    console.log(`[AnimeWorld] Total AW streams produced: ${streams.length} (parallel batch ${Date.now() - tBatch}ms)`);
    return { streams };
  }

  /**
   * Fallback che replica la logica del vecchio script: usa la ricerca filter?year=YYYY&keyword=TitoloTroncato
   * - Usa Python scraper con --date per forzare pattern identico all'originale (prima prova con anno, poi senza)
   * - Prende i primi 2 risultati compatibili (data match gia' gestita nello scraper)
   * - get_episodes + get_stream come normale, ma etichetta versioni come Original / Italian come ordine di apparizione
   */
  private async fallbackFilterYearSearch(normalizedTitle: string, startDate: string, isMovie: boolean, episodeNumber: number | null, seasonNumber: number | null): Promise<{ streams: StreamForStremio[] }> {
    try {
      console.log('[AnimeWorld][FallbackFilter] Triggered with title=', normalizedTitle, 'date=', startDate);
      // Emula lo "split(':')[0]" aggressivo del vecchio script: tronca al primo ':' o '?'
      let query = normalizedTitle;
      if (normalizedTitle.includes(':')) {
        query = normalizedTitle.split(':')[0];
      } else if (normalizedTitle.includes('?')) {
        query = normalizedTitle.split('?')[0];
      }
      query = query.trim();
      console.log('[AnimeWorld][FallbackFilter] Truncated query:', query);
      // Nel vecchio script poi spazio -> '+' prima della costruzione URL; lo scraper fa gia' replace interno (spazi -> +) prima di generare URL, passiamo quindi query semplice
      const results = await invokePython(['search','--query', query,'--date', startDate]);
      if (!Array.isArray(results) || !results.length) {
        console.log('[AnimeWorld][FallbackFilter] No results from filter year search');
        return { streams: [] };
      }
      // Prendi massimo due risultati (ordine naturale) per imitare i/0 Original i/1 Italian
      const picked = results.slice(0,2);
      const streams: StreamForStremio[] = [];
      let idx = 0;
      for (const r of picked) {
        const slug = r.slug || r.id || r.name;
        if (!slug) continue;
        try {
          const episodes: AnimeWorldEpisode[] = await invokePython(['get_episodes','--anime-slug', slug]);
          if (!episodes || !episodes.length) continue;
          let target: AnimeWorldEpisode | undefined;
            if (isMovie) target = episodes[0];
            else if (episodeNumber != null) target = episodes.find(e => e.number === episodeNumber);
            else target = episodes[0];
          if (!target) continue; // episodio richiesto non trovato
          const epNum = episodeNumber != null ? episodeNumber : target.number;
          let streamData: any = null;
          try {
            streamData = await invokePython(['get_stream','--anime-slug', slug, ...(epNum != null ? ['--episode', String(epNum)] : [])]);
          } catch (e) {
            console.warn('[AnimeWorld][FallbackFilter] get_stream error', slug, e);
            continue;
          }
          const mp4 = streamData?.mp4_url;
          if (!mp4) continue;
          const lang = idx === 0 ? 'Original' : 'Italian';
          const sNum = seasonNumber || 1;
          let baseName = (r.name || slug || normalizedTitle).toString().trim();
          if (baseName.includes('\n')) baseName = baseName.replace(/\s+/g,' ').trim();
          let titleStream = `${baseName} ▪ ${lang === 'Original' ? 'SUB' : 'ITA'} ▪ S${sNum}`;
          if (episodeNumber) titleStream += `E${episodeNumber}`;
          streams.push({ title: titleStream, url: mp4, behaviorHints: { bingeGroup: 'animeworld-fallback' } });
          idx++;
        } catch (e) {
          console.warn('[AnimeWorld][FallbackFilter] error processing slug', r.slug, e);
        }
      }
      console.log('[AnimeWorld][FallbackFilter] Produced streams:', streams.length);
      return { streams };
    } catch (e) {
      console.error('[AnimeWorld][FallbackFilter] failure', e);
      return { streams: [] };
    }
  }
}

function capitalize(str: string) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
