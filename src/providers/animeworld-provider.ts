import { spawn } from 'child_process';
import * as path from 'path';
import { KitsuProvider } from './kitsu';
import { formatMediaFlowUrl } from '../utils/mediaflow';
import { AnimeWorldConfig, AnimeWorldResult, AnimeWorldEpisode, StreamForStremio } from '../types/animeunity';

// Helper to invoke python scraper
async function invokePython(args: string[]): Promise<any> {
  const scriptPath = path.join(__dirname, 'animeworld_scraper.py');
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [scriptPath, ...args]);
    let stdout = '';
    let stderr = '';
    py.stdout.on('data', (d: Buffer) => stdout += d.toString());
    py.stderr.on('data', (d: Buffer) => stderr += d.toString());
    py.on('close', code => {
      if (code !== 0) {
        console.error('[AnimeWorld] Python exit', code, stderr);
        return reject(new Error(stderr || 'Python error'));
      }
      try { resolve(JSON.parse(stdout)); } catch (e) { reject(e); }
    });
    py.on('error', err => reject(err));
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
    '-': '',
  };
  let normalized = title;
  for (const [k,v] of Object.entries(replacements)) normalized = normalized.replace(k,v);
  if (normalized.includes('Naruto:')) normalized = normalized.replace(':','');
  return normalized.trim();
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
    let versions = await this.searchAllVersions(normalized);
    if (!versions.length && normalized.includes("'")) versions = await this.searchAllVersions(normalized.replace(/'/g,''));
    if (!versions.length && normalized.includes('(')) versions = await this.searchAllVersions(normalized.split('(')[0].trim());
    if (!versions.length) { const words = normalized.split(' '); if (words.length>3) versions = await this.searchAllVersions(words.slice(0,3).join(' ')); }
    if (!versions.length) return { streams: [] };
    const streams: StreamForStremio[] = [];
    const seen = new Set<string>();
  for (const v of versions) {
      try {
        const episodes: AnimeWorldEpisode[] = await invokePython(['get_episodes','--anime-slug', v.slug]);
        if (!episodes || !episodes.length) continue;
        let target: AnimeWorldEpisode | undefined;
        if (isMovie) target = episodes[0]; else if (episodeNumber != null) target = episodes.find(e => e.number === episodeNumber) || episodes[0]; else target = episodes[0];
        if (!target) continue;
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
    return { streams };
  }
}

function capitalize(str: string) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
