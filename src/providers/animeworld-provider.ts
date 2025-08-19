import { spawn } from 'child_process';
import * as path from 'path';
import { KitsuProvider } from './kitsu';
import { formatMediaFlowUrl } from '../utils/mediaflow';
import { AnimeWorldConfig, AnimeWorldResult, AnimeWorldEpisode, StreamForStremio } from '../types/animeunity';

// Helper to invoke python scraper with timeout & timing logs
async function invokePython(args: string[]): Promise<any> {
  const scriptPath = path.join(__dirname, 'animeworld_scraper.py');
  const timeoutMs = parseInt(process.env.ANIMEWORLD_PY_TIMEOUT || '20000', 10); // default 20s
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
    const mappingsResp = await (await fetch(`https://kitsu.io/api/edge/anime/${id}/mappings`)).json();
    const malMapping = mappingsResp.data?.find((m: any) => m.attributes.externalSite === 'myanimelist/anime');
    malId = malMapping?.attributes?.externalId?.toString() || null;
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

export class AnimeWorldProvider {
  private kitsuProvider = new KitsuProvider();
  constructor(private config: AnimeWorldConfig) {}

  async searchAllVersions(title: string): Promise<AnimeWorldResult[]> {
    try {
      const raw: AnimeWorldResult[] = await invokePython(['search','--query', title]);
      if (!raw) return [];
      // Infer language_type similar to AnimeUnity/AnimeSaturn conventions
      return raw.map(r => {
        const lower = r.name.toLowerCase();
        let language_type = 'SUB ITA';
        if (/(\bita\b|ita\)|\(ita)/i.test(r.name)) language_type = 'ITA';
        if (lower.includes('cr')) language_type = 'CR ITA';
        if (!/(ita|sub|cr)/i.test(lower)) language_type = 'ORIGINAL';
        return { ...r, language_type };
      });
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
    try { const englishTitle = await getEnglishTitleFromAnyId(imdbId, 'imdb', this.config.tmdbApiKey); return this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie); } catch(e){ console.error('[AnimeWorld] imdb handler error', e); return { streams: [] }; }
  }
  async handleTmdbRequest(tmdbId: string, seasonNumber: number | null, episodeNumber: number | null, isMovie=false): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) return { streams: [] };
    try { const englishTitle = await getEnglishTitleFromAnyId(tmdbId, 'tmdb', this.config.tmdbApiKey); return this.handleTitleRequest(englishTitle, seasonNumber, episodeNumber, isMovie); } catch(e){ console.error('[AnimeWorld] tmdb handler error', e); return { streams: [] }; }
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
    if (!versions.length) return { streams: [] };
  // Prioritize versions (ITA first, then SUB ITA, CR ITA, ORIGINAL)
  const order = { 'ITA': 0, 'SUB ITA': 1, 'CR ITA': 2, 'ORIGINAL': 3 } as Record<string, number>;
  versions.sort((a,b) => (order[a.language_type || 'SUB ITA'] ?? 9) - (order[b.language_type || 'SUB ITA'] ?? 9));
  const maxVersions = parseInt(process.env.ANIMEWORLD_MAX_VERSIONS || '3', 10);
  const limited = versions.slice(0, maxVersions);
  console.log('[AnimeWorld] Processing versions (limited):', limited.map(v => v.name + '|' + v.language_type).join(', '));
    const streams: StreamForStremio[] = [];
    const seen = new Set<string>();
  for (const v of limited) {
      try {
        const episodes: AnimeWorldEpisode[] = await invokePython(['get_episodes','--anime-slug', v.slug]);
        if (!episodes || !episodes.length) continue;
        let target: AnimeWorldEpisode | undefined;
        if (isMovie) target = episodes[0]; else if (episodeNumber != null) target = episodes.find(e => e.number === episodeNumber) || episodes[0]; else target = episodes[0];
        if (!target) continue;
    console.log(`[AnimeWorld] Fetching stream for slug=${v.slug} ep=${episodeNumber ?? target.number}`);
        const streamData = await invokePython(['get_stream','--anime-slug', v.slug, ...(episodeNumber ? ['--episode', String(episodeNumber)] : [])]);
        const mp4 = streamData?.mp4_url;
        if (!mp4) continue;
        const mediaFlowUrl = formatMediaFlowUrl(mp4, this.config.mfpUrl, this.config.mfpPassword);
        if (seen.has(mediaFlowUrl)) continue;
        seen.add(mediaFlowUrl);
        const cleanName = v.name
          .replace(/\(ITA\)/i,'')
          .replace(/\(CR\)/i,'')
          .replace(/ITA/gi,'')
          .replace(/CR/gi,'')
          .trim();
        const sNum = seasonNumber || 1;
  const langLabel = (v.language_type === 'ITA') ? 'ITA' : (v.language_type === 'ORIGINAL' ? 'SUB' : 'SUB');
  let titleStream = `${capitalize(cleanName)} ${langLabel} S${sNum}`;
        if (episodeNumber) titleStream += `E${episodeNumber}`;
        streams.push({ title: titleStream, url: mediaFlowUrl, behaviorHints: { notWebReady: true } });
      } catch (err) {
        console.error('[AnimeWorld] error building stream', err);
      }
    }
  console.log('[AnimeWorld] Total AW streams produced:', streams.length);
  return { streams };
  }
}

function capitalize(str: string) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
