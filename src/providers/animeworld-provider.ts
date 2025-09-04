import { spawn } from 'child_process';
import * as path from 'path';
import { KitsuProvider } from './kitsu';
import { formatMediaFlowUrl } from '../utils/mediaflow';
import { AnimeWorldConfig, AnimeWorldResult, AnimeWorldEpisode, StreamForStremio } from '../types/animeunity';
import { checkIsAnimeById } from '../utils/animeGate';

// Cache semplice in-memory per titoli tradotti per evitare chiamate ripetute
const englishTitleCache = new Map<string, string>();

// Helper to invoke python scraper with timeout & timing logs
async function invokePython(args: string[], timeoutOverrideMs?: number): Promise<any> {
  const scriptPath = path.join(__dirname, 'animeworld_scraper.py');
  const timeoutMsBase = parseInt(process.env.ANIMEWORLD_PY_TIMEOUT || '20000', 10); // default 20s
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
    tmdbId = await getTmdbIdFromImdbId(imdbIdOnly, tmdbKey);
    if (!tmdbId) throw new Error('TMDB ID non trovato per IMDB: ' + id);
    try {
      const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json();
      malId = haglundResp[0]?.myanimelist?.toString() || null;
    } catch {}
  } else if (type === 'tmdb') {
    tmdbId = id;
    try { const haglundResp = await (await fetch(`https://arm.haglund.dev/api/v2/themoviedb?id=${tmdbId}&include=kitsu,myanimelist`)).json(); malId = haglundResp[0]?.myanimelist?.toString() || null; } catch {}
  } else if (type === 'kitsu') {
    try {
      const mappingsResp = await (await fetch(`https://kitsu.io/api/edge/anime/${id}/mappings`)).json();
      const malMapping = mappingsResp.data?.find((m: any) => m.attributes.externalSite === 'myanimelist/anime');
      malId = malMapping?.attributes?.externalId?.toString() || null;
    } catch {}
    // Fallback immediato: prendi canonicalTitle da risorsa anime se disponibile
    if (!fallbackTitle) {
      try {
        const animeResp = await (await fetch(`https://kitsu.io/api/edge/anime/${id}`)).json();
        const attr = animeResp.data?.attributes || {};
        // Chain di preferenze: titles.en -> title_en -> titles.en_jp -> canonicalTitle -> slug
        fallbackTitle = attr.titles?.en || attr.title_en || attr.titles?.en_jp || attr.canonicalTitle || attr.slug || null;
        if (fallbackTitle) {
          englishTitleCache.set(cacheKey, fallbackTitle);
          return fallbackTitle;
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
      if (englishTitle) return englishTitle;
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

function normalizeTitleForSearch(title: string): string {
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

  async searchAllVersions(title: string): Promise<AnimeWorldResult[]> {
    try {
      const raw: AnimeWorldResult[] = await invokePython(['search','--query', title]);
      if (!raw) return [];
      // Infer language_type similar to AnimeUnity/AnimeSaturn conventions
        const normSlugKey = title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
        const mapped = raw.map(r => {
          const name = r.name ? r.name.toLowerCase() : '';
          const slug = r.slug ? r.slug.toLowerCase() : '';
          let language_type = 'ORIGINAL';
          const isSubIta = name.includes('subita') || slug.includes('subita') || /sub[-_\s]?ita/.test(name) || /sub[-_\s]?ita/.test(slug);
          const isCrIta = /ita[-_]?cr/.test(name) || /ita[-_]?cr/.test(slug) || /cr[-_]?ita/.test(name) || /cr[-_]?ita/.test(slug);
          if (isSubIta) {
            language_type = 'SUB ITA';
          } else if (isCrIta) {
            language_type = 'CR ITA';
          } else if (/(^|[-_\s])ita($|[-_\s])/i.test(name) || /(^|[-_\s])ita($|[-_\s])/i.test(slug) || name.endsWith('-ita') || slug.endsWith('-ita') || (name.includes('ita') || slug.includes('ita'))) {
            language_type = 'ITA';
          } else {
            // Heuristic: lo slug "base" (senza suffissi tipo -ita) è la versione SUB ITA del sito
            const basePart = (slug || name).split('.')[0];
            const cleaned = basePart.replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
            if (cleaned === normSlugKey) {
              language_type = 'SUB ITA';
            }
          }
          return { ...r, language_type };
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

  async handleTitleRequest(title: string, seasonNumber: number | null, episodeNumber: number | null, isMovie=false): Promise<{ streams: StreamForStremio[] }> {
    const normalized = normalizeTitleForSearch(title);
  console.log('[AnimeWorld] Title original:', title);
  console.log('[AnimeWorld] Title normalized:', normalized);
  let versions = await this.searchAllVersions(normalized);
    if (!versions.length && normalized.includes("'")) versions = await this.searchAllVersions(normalized.replace(/'/g,''));
    if (!versions.length && normalized.includes('(')) versions = await this.searchAllVersions(normalized.split('(')[0].trim());
    if (!versions.length) { const words = normalized.split(' '); if (words.length>3) versions = await this.searchAllVersions(words.slice(0,3).join(' ')); }
    // Extra fallback: try plus-joined (simulate site keyword pattern) if still empty
    if (!versions.length) {
      const plus = normalized.replace(/\s+/g,'+');
      if (plus !== normalized) versions = await this.searchAllVersions(plus);
    }
  console.log('[AnimeWorld] Versions found:', versions.length);
  const debugLangCounts = versions.reduce((acc: any, v: any) => { acc[v.language_type] = (acc[v.language_type]||0)+1; return acc; }, {} as Record<string, number>);
  console.log('[AnimeWorld] Language type counts:', debugLangCounts);
    if (!versions.length) return { streams: [] };
  // === STRICT BASE SLUG FILTER (avoid including rewrite/variants when base requested) ===
  try {
    const normSlugKey = normalized.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
    const wantsRewrite = /rewrite/i.test(normalized);
    // Keep original full list for fallback
    const allVersions = versions.slice();
    if (!wantsRewrite) {
      const allowedSuffixes = ['-ita','-subita','-sub-ita','-cr-ita','-ita-cr'];
      const beforeCount = versions.length;
      versions = versions.filter(v => {
        const raw = (v.slug || v.name || '').toLowerCase();
        const basePart = raw.split('.')[0];
        const cleaned = basePart.replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'');
        if (/rewrite\b/.test(cleaned)) return false; // exclude rewrite variants for base title
        if (cleaned === normSlugKey) return true;
        for (const suf of allowedSuffixes) {
          if (cleaned === normSlugKey + suf) return true;
        }
        return false;
      });
      console.log(`[AnimeWorld] Strict base filter applied (${normSlugKey}) from ${beforeCount} -> ${versions.length}`);
      if (!versions.length) {
  // NUOVO COMPORTAMENTO: nessuna corrispondenza ESATTA -> nessun risultato (non ripristinare lista originale)
  console.log('[AnimeWorld] Strict filter produced 0 results, NOT restoring broad matches (no full title match).');
  return { streams: [] };
      }
    } else {
      console.log('[AnimeWorld] Rewrite detected in normalized title, keeping rewrite variants alongside base');
    }
  } catch (e) {
    console.warn('[AnimeWorld] Strict base slug filter error (ignored):', e);
  }
  // Prioritize versions (ITA first, then SUB ITA, CR ITA, ORIGINAL) e poi riduci a solo ITA + SUB ITA
     const order = { 'ITA': 0, 'SUB ITA': 1, 'CR ITA': 2, 'ORIGINAL': 3 } as Record<string, number>;
     versions.sort((a, b) => {
       const rank = (v: any) => {
         if (v.language_type === 'SUB ITA') return 0;
         if (v.language_type === 'ITA') return 1;
         if (v.language_type === 'CR ITA') return 2;
         return 4;
       };
       return rank(a) - rank(b);
     });
  console.log('[AnimeWorld] Top versions sample:', versions.slice(0,8).map(v => `${v.language_type}:${v.slug}`).join(', '));
  let reduced = versions.filter(v => v.language_type === 'ITA' || v.language_type === 'SUB ITA' || v.language_type === 'CR ITA');
  if (!reduced.length) reduced = versions.slice(0,1); // fallback

  // Identifica movie dallo slug/nome
  const isMovieSlug = (v: any) => {
    const s = (v.slug || v.name || '').toLowerCase();
    return s.includes('movie') || /-movie-/.test(s);
  };

  // Episodio specifico: considera tutte le versioni non-movie tra ITA/SUB/CR, senza aggiunte artificiali
  let selected: typeof reduced = [];
  if (episodeNumber != null && !isMovie) {
    selected = reduced.filter(v => !isMovieSlug(v));
  } else {
    // Film o richieste senza episodio: mantieni primi due
    selected = reduced.slice(0, 2);
  }
  console.log('[AnimeWorld] Processing versions (candidates):', selected.map(v => `${v.language_type}:${v.slug || v.name}`).join(', '));

  const seen = new Set<string>();
  const tBatch = Date.now();

  // Parallel fetch episodes
  const episodeInfos = await Promise.all(selected.map(async v => {
    try {
      const t0 = Date.now();
  const episodes: AnimeWorldEpisode[] = await invokePython(['get_episodes','--anime-slug', v.slug]);
      if (!episodes || !episodes.length) return null;
      let target: AnimeWorldEpisode | undefined;
      if (isMovie) {
        target = episodes[0];
      } else if (episodeNumber != null) {
        // Richiesta episodio specifico: accetta SOLO se esiste quel numero
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
    if (!info) return null; const { v, target } = info;
    try {
      const epNum = episodeNumber != null ? episodeNumber : target.number;
      console.log(`[AnimeWorld] Fetching stream for slug=${v.slug} ep=${epNum}`);
      let streamData: any = null;
      let timedOut = false;
      try {
        streamData = await invokePython(['get_stream','--anime-slug', v.slug, ...(epNum != null ? ['--episode', String(epNum)] : [])]);
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
          streamData = await invokePython(['get_stream','--anime-slug', v.slug, ...(epNum != null ? ['--episode', String(epNum)] : [])], 30000);
        } catch (e2) {
          console.error('[AnimeWorld] get_stream retry failed', v.slug, e2);
          return null;
        }
      }
      const mp4 = streamData?.mp4_url;
      if (!mp4) return null;
      // Se stiamo cercando un episodio numerato e l'URL punta ad un Movie o Special non coerente, scarta
      if (!isMovie && episodeNumber != null) {
        const lowerUrl = mp4.toLowerCase();
        const epStr = episodeNumber.toString();
        const epPadded2 = epStr.padStart(2,'0');
        const epPadded3 = epStr.padStart(3,'0');
        const looksLikeEpisode = /ep[_-]?\d{1,3}/i.test(lowerUrl) || lowerUrl.includes(`_${epPadded2}_`) || lowerUrl.includes(`_${epPadded3}_`);
        const isMovieFile = lowerUrl.includes('movie');
        const isSpecialFile = lowerUrl.includes('special');
        if ((isMovieFile || isSpecialFile) && !looksLikeEpisode) {
          console.log('[AnimeWorld] Skipping non-episode file (movie/special) for requested ep:', mp4);
          return null;
        }
      }
      const mediaFlowUrl = formatMediaFlowUrl(mp4, this.config.mfpUrl, this.config.mfpPassword);
      if (seen.has(mediaFlowUrl)) return null;
      seen.add(mediaFlowUrl);
      // Pulizia nome: rimuovi marcatori inutili e newline
      let cleanName = v.name.replace(/\r?\n+/g,' ').replace(/\s{2,}/g,' ').trim();
      cleanName = cleanName
        .replace(/\bDUB\b/gi,'')
        .replace(/\(ITA\)/gi,'')
        .replace(/\(CR\)/gi,'')
        .replace(/CR/gi,'')
        .replace(/ITA/gi,'')
        .replace(/Movie/gi,'')
        .replace(/Special/gi,'')
        .replace(/\s{2,}/g,' ')
        .trim();
      // Fallback: se il nome è vuoto o è solo un'etichetta (es. "ITA"), ricava dal slug o dal titolo richiesto
      let baseName = cleanName;
      const looksLikeLangOnly = /^[A-Z]{2,4}$/i.test(baseName || '');
      if (!baseName || baseName.length < 3 || looksLikeLangOnly) {
        const slugBase = ((v.slug || '') as string).toLowerCase().split('.')[0];
        // rimuovi suffissi lingua dal slug e normalizza
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
      return { title: titleStream, url: mediaFlowUrl, behaviorHints: { notWebReady: true } } as StreamForStremio;
    } catch (e) {
      console.error('[AnimeWorld] get_stream error', v.slug, e);
      return null;
    }
  }));

  const streams = streamObjs.filter(Boolean) as StreamForStremio[];
  console.log(`[AnimeWorld] Total AW streams produced: ${streams.length} (parallel batch ${Date.now() - tBatch}ms)`);
  return { streams };
  }
}

function capitalize(str: string) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
