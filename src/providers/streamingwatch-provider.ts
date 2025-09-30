/*
 * StreamingWatch Provider (TypeScript port)
 * Derived and adapted from original Python implementation:
 *   https://github.com/UrloMythus/MammaMia/blob/main/Src/API/streamingwatch.py
 * Credits: @urlomythus (MammaMia project - MIT License)
 *
 * Notes:
 *  - Toggle via config.enabled (like CB01 provider style)
 *  - Domain loaded dynamically from config/domains.json key "streamingwatch" (TTL handled by domains loader - 12h)
 *  - No MediaFlow wrapping: direct HLS -> unlocked stream (raw title later unified centrally)
 *  - Movie & Series supported. Series slug pattern: stagione-{S}-episodio-{E} or stagione-{S}-episode-{E}, excluding trailing 0 variant ( ...episodio-{E}0 )
 *  - Nonce (admin_ajax_nonce) fetched from /contatto/ page and cached 30 minutes
 *  - Metadata resolution (optional): TMDb find endpoint (if tmdbApiKey passed) else IMDb <title> scrape fallback
 *  - Caching: results 6h in-memory by (imdb|mode|season|episode)
 *  - Debug logs gated by env SW_DEBUG (1/true)
 *  - Simplified HTML parsing (regex + DOM partial) - fragile if site markup changes
 */

import type { StreamForStremio } from '../types/animeunity';
import { getDomain } from '../utils/domains';

// ---- Debug helpers ----
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const env = (typeof process !== 'undefined' && (process as any).env) ? (process as any).env : {};
function envBool(name: string, def = false): boolean {
  const v = (env[name] || env['REACT_APP_' + name] || '').toString().trim().toLowerCase();
  if (!v) return def;
  if (['1','true','on','yes','y'].includes(v)) return true;
  if (['0','false','off','no','n'].includes(v)) return false;
  return def;
}
// Logs abilitati di default: impostare SW_DEBUG=0 per spegnerli
const SW_DEBUG = envBool('SW_DEBUG', true);
const dlog = (...a: unknown[]) => { if (SW_DEBUG) { try { console.log('[SW]', ...a); } catch {} } };
const dwarn = (...a: unknown[]) => { try { console.warn('[SW]', ...a); } catch {} };

export interface StreamingWatchConfig { enabled: boolean; tmdbApiKey?: string }

interface MetaResult { title: string; year: string | null; source: string }

export class StreamingWatchProvider {
  private baseHost: string;
  private cache = new Map<string, { ts: number; streams: StreamForStremio[] }>();
  private nonceCache: { value: string | null; ts: number } = { value: null, ts: 0 };
  private readonly RESULT_TTL = 6 * 60 * 60 * 1000; // 6h
  private readonly NONCE_TTL = 30 * 60 * 1000; // 30m
  private readonly userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  constructor(private config: StreamingWatchConfig){
    const dom = getDomain('streamingwatch');
    this.baseHost = dom ? `https://${dom}` : 'https://streamingwatch.example';
  dlog('init provider', { baseHost: this.baseHost, enabled: config.enabled });
  }

  // --- Public API (IMDB only, matches other providers signature) ---
  async handleImdbRequest(imdbId: string, season: number | null, episode: number | null, isMovie: boolean){
    if(!this.config.enabled) return { streams: [] };
    const key = `${imdbId}|${isMovie?'movie':'series'}|${season||''}|${episode||''}`;
    const c = this.cache.get(key); if(c && Date.now() - c.ts < this.RESULT_TTL) return { streams: c.streams };
    try {
      const imdbOnly = imdbId.split(':')[0];
      let s = season; let e = episode; let movie = isMovie;
      if(!movie){ // if season/episode not passed but embedded in id (ttxxxx:1:2)
        const parts = imdbId.split(':');
        if(parts.length >= 3){ s = parseInt(parts[1]); e = parseInt(parts[2]); movie = false; }
      }
  dlog('handleImdbRequest parsed', { imdbId, imdbOnly, season: s, episode: e, isMovie: movie });
      const meta = await this.resolveTitleYear(imdbOnly, movie);
      const shownameQ = this.normalizeQuery(meta.title);
      dlog('meta', meta, { shownameQ });
      const hdplayer = await this.search(shownameQ, s, e, meta.year, movie);
      if(!hdplayer){ dlog('no hdplayer'); return { streams: [] }; }
      const hls = await this.extractHls(hdplayer);
      if(!hls){ dlog('no hls'); return { streams: [] }; }
      const final = hls.endsWith('.m3u8') ? hls : (hls + '.m3u8');
      // Titolo interno deve essere il nome reale (TMDb/IMDb) + opzionale SxE + [ITA]
  let internalTitle = meta.title || imdbOnly;
  if(meta.year) internalTitle += ` (${meta.year})`;
  if(!movie && s!=null && e!=null) internalTitle += ` S${s}E${e}`;
  if(!/\[ITA\]/i.test(internalTitle)) internalTitle += ' • [ITA]';
      const streams: StreamForStremio[] = [{
        title: internalTitle,
        url: final,
        behaviorHints: { notWebReady: false }
      }];
      this.cache.set(key, { ts: Date.now(), streams });
      return { streams };
    } catch (e){ dwarn('handleImdbRequest error', (e as Error).message); return { streams: [] }; }
  }
  async handleTmdbRequest(tmdbId:string, season:number|null, episode:number|null, isMovie:boolean){
    if(!this.config.enabled) return { streams: [] };
    const key = `tmdb:${tmdbId}|${isMovie?'movie':'series'}|${season||''}|${episode||''}`;
    const c = this.cache.get(key); if(c && Date.now() - c.ts < this.RESULT_TTL) return { streams: c.streams };
    const apiKey = this.config.tmdbApiKey || env.TMDB_API_KEY;
    if(!apiKey){ dlog('tmdb handler skipped: no api key'); return { streams: [] }; }
    try {
      // fetch base title
      const endpoint = isMovie ? `movie/${tmdbId}` : `tv/${tmdbId}`;
      const url = `https://api.themoviedb.org/3/${endpoint}?api_key=${apiKey}&language=it`;
      const r = await fetch(url);
      if(!r.ok){ dwarn('tmdb handler meta status', r.status); return { streams: [] }; }
      const meta = await r.json();
      const rawTitle = (meta.title || meta.name || meta.original_title || meta.original_name || '').toString();
      const shownameQ = this.normalizeQuery(rawTitle);
      dlog('tmdb handler meta', { tmdbId, rawTitle, shownameQ, season, episode, isMovie });
      const hdplayer = await this.search(shownameQ, season, episode, (meta.release_date||meta.first_air_date||'').slice(0,4)||null, isMovie);
      if(!hdplayer){ dlog('tmdb handler no hdplayer'); return { streams: [] }; }
      const hls = await this.extractHls(hdplayer);
      if(!hls){ dlog('tmdb handler no hls'); return { streams: [] }; }
  const final = hls.endsWith('.m3u8') ? hls : (hls + '.m3u8');
  let internalTitle = rawTitle || `tmdb:${tmdbId}`;
  const year = (meta.release_date||meta.first_air_date||'').slice(0,4);
  if(year) internalTitle += ` (${year})`;
  if(!isMovie && season!=null && episode!=null) internalTitle += ` S${season}E${episode}`;
  if(!/\[ITA\]/i.test(internalTitle)) internalTitle += ' • [ITA]';
  const streams: StreamForStremio[] = [{ title: internalTitle, url: final, behaviorHints: { notWebReady: false }}];
      this.cache.set(key, { ts: Date.now(), streams });
      return { streams };
    } catch(e){ dwarn('handleTmdbRequest error', String(e)); return { streams: [] }; }
  }

  // --- Query normalization (Python replacement chain) ---
  private normalizeQuery(t: string){
    return t.replace(/[\s]+/g,'+').replace(/[–—]/g,'+').replace(/&/g,'');
  }

  // --- Metadata resolution (TMDb find -> IMDb scrape) ---
  private async resolveTitleYear(imdbId: string, isMovie: boolean): Promise<MetaResult>{
    const apiKey = this.config.tmdbApiKey || env.TMDB_API_KEY;
    const base: MetaResult = { title: imdbId, year: null, source: 'imdb-id' };
    if(apiKey){
      try {
        const url = `https://api.themoviedb.org/3/find/${imdbId}?api_key=${apiKey}&language=it&external_source=imdb_id`;
        const r = await fetch(url);
        if(r.ok){
          const js = await r.json();
            const arr = isMovie ? (js.movie_results||[]) : (js.tv_results||[]);
            const alt = isMovie ? (js.tv_results||[]) : (js.movie_results||[]);
            const node = arr[0] || alt[0];
            if(node){
              const dateRaw = (node.release_date || node.first_air_date || '').toString();
              const year = dateRaw.slice(0,4)||null;
              const title = (node.title || node.name || node.original_title || node.original_name || imdbId).toString();
              base.title = title; base.year = year; base.source = 'tmdb';
              return base;
            }
        }
      } catch(e){ dwarn('tmdb meta error', String(e)); }
    }
    // Fallback scrape
    try {
      const imdbUrl = `https://www.imdb.com/title/${imdbId}/`;
      const r = await fetch(imdbUrl, { headers:{ 'User-Agent': this.userAgent, 'Accept':'text/html' } });
      if(r.ok){
        const html = await r.text();
        const m = html.match(/<title>([^<]+)<\/title>/i);
        if(m){
          let raw = m[1].replace(/- IMDb.*$/i,'').trim();
          const ym = raw.match(/\((\d{4})\)/); let year: string|null = null;
          if(ym){ year = ym[1]; raw = raw.replace(/\(\d{4}\)/,'').trim(); }
          base.title = raw || base.title; base.year = year; base.source = 'imdb-scrape';
        }
      }
    } catch(e){ dwarn('imdb scrape error', String(e)); }
    return base;
  }

  // --- Nonce (cached) ---
  private async fetchNonce(): Promise<string | null>{
    const now = Date.now();
    if(this.nonceCache.value && (now - this.nonceCache.ts) < this.NONCE_TTL) return this.nonceCache.value;
    try {
      const url = `${this.baseHost}/contatto/`;
      const r = await fetch(url, { headers:{ 'User-Agent': this.userAgent, 'Accept':'text/html' }, redirect: 'follow' });
      if(!r.ok) return null;
      const html = await r.text();
      const matches = html.match(/"admin_ajax_nonce":"(\w+)"/g) || [];
      // Python prende matches[1]; replichiamo ma verifichiamo
      if(matches.length >= 2){
        const second = matches[1].match(/"admin_ajax_nonce":"(\w+)"/);
        const val = second ? second[1] : null;
        if(val){ this.nonceCache = { value: val, ts: now }; return val; }
      } else if(matches.length === 1){
        const m = matches[0].match(/"admin_ajax_nonce":"(\w+)"/); if(m){ this.nonceCache = { value: m[1], ts: now }; return m[1]; }
      }
    } catch(e){ dwarn('fetchNonce error', String(e)); }
    return null;
  }

  // --- Core search (movie vs series) -> returns embed hdplayer url or null ---
  private async search(showname: string, season: number | null, episode: number | null, year: string | null, isMovie: boolean): Promise<string | null>{
    if(isMovie) return this.movieSearch(showname, year);
    if(season==null || episode==null) return null;
    return this.seriesSearch(showname, season, episode);
  }

  private async movieSearch(showname: string, year: string | null): Promise<string | null>{
    const nonce = await this.fetchNonce(); if(!nonce){ dlog('nonce missing'); return null; }
    const form = new URLSearchParams();
    form.set('action','data_fetch');
    form.set('keyword', showname);
    form.set('_wpnonce', nonce);
    const url = `${this.baseHost}/wp-admin/admin-ajax.php`;
    const headers: Record<string,string> = {
      'User-Agent': this.userAgent,
      'Accept': '*/*',
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'Origin': this.baseHost,
      'Referer': `${this.baseHost}/`,
      'X-Requested-With': 'XMLHttpRequest'
    };
    let html: string;
    try {
      const r = await fetch(url, { method:'POST', headers, body: form.toString() });
      if(!r.ok) return null; html = await r.text();
    } catch(e){ dwarn('movieSearch post error', String(e)); return null; }
    // Parse minimal anchors + year spans
    // We'll use DOMParser if available else regex fallback
    let matchHref: string | null = null;
    try {
      // Simple parse: collect years and anchors in order
      const yearRe = /id=['"]search-cat-year['"][^>]*>([^<]+)</gi;
      const years: string[] = []; let m: RegExpExecArray | null;
      while((m = yearRe.exec(html))) years.push(m[1].trim());
      const aRe = /<a\s+[^>]*href=['"]([^'"]+)['"]/gi; const hrefs: string[] = []; let am: RegExpExecArray | null;
      while((am = aRe.exec(html))) hrefs.push(am[1]);
      // zip years & hrefs
      for(let i=0;i<Math.min(years.length, hrefs.length);i++){
        const y = years[i]; const h = hrefs[i];
        if(year && y === year){ matchHref = h; break; }
        if(!year && !matchHref) matchHref = h; // fallback first
      }
      if(!matchHref && hrefs.length) matchHref = hrefs[0];
    } catch(e){ dwarn('movieSearch parse error', String(e)); }
    if(!matchHref) return null;
    return this.extractIframeSrc(matchHref);
  }

  private async seriesSearch(showname: string, season: number, episode: number): Promise<string | null>{
    dlog('seriesSearch start', { showname, season, episode });
    // attempt multiple variants (plus -> space) for category search like Python behavior (it searches raw name)
    const variants = [showname, showname.replace(/\+/g,' '), showname.replace(/\+/g,'')];
    let catJson: any = null; let categoryId: number | null = null; let lastErr: string | null = null;
    for(const v of variants){
      const catUrl = `${this.baseHost}/wp-json/wp/v2/categories?search=${encodeURIComponent(v)}&_fields=id`;
      dlog('seriesSearch category attempt', { variant: v, catUrl });
      try {
        const r = await fetch(catUrl, { headers:{ 'User-Agent': this.userAgent, 'Accept':'application/json' } });
        if(!r.ok){ lastErr = 'status '+r.status; continue; }
        catJson = await r.json();
        if(Array.isArray(catJson) && catJson.length){
          categoryId = catJson[0].id; dlog('seriesSearch category match', { variant: v, categoryId });
          break;
        }
      } catch(e){ lastErr = String(e); }
    }
    if(!categoryId){ dwarn('seriesSearch no category', { showname, lastErr }); return null; }
    const postsUrl = `${this.baseHost}/wp-json/wp/v2/posts?categories=${categoryId}&per_page=100`;
    let posts: any[] = [];
    try {
      const r = await fetch(postsUrl, { headers:{ 'User-Agent': this.userAgent, 'Accept':'application/json' } });
      if(!r.ok){ dwarn('series posts status', r.status); return null; }
      posts = await r.json();
      dlog('seriesSearch posts fetched', { count: posts.length });
    } catch(e){ dwarn('series posts error', String(e)); return null; }
    const needleA = `stagione-${season}-episodio-${episode}`;
    const needleB = `stagione-${season}-episode-${episode}`;
    for(const entry of posts){
      const slug: string = entry?.slug || '';
      if(!slug) continue;
      if((slug.includes(needleA) || slug.includes(needleB)) && !slug.includes(`${needleA}0`)){
        const content = entry?.content?.rendered || '';
        const idx = content.indexOf('src="');
        if(idx === -1) continue;
        const start = idx + 'src="'.length;
        const end = content.indexOf('"', start);
        if(end === -1) continue;
        const hdplayer = content.slice(start, end);
        dlog('seriesSearch match', { slug, hdplayer });
        return hdplayer;
      }
    }
    dlog('seriesSearch no episode match', { needleA, needleB });
    return null;
  }

  private async extractIframeSrc(pageUrl: string): Promise<string | null>{
    try {
      const r = await fetch(pageUrl, { headers:{ 'User-Agent': this.userAgent, 'Accept':'text/html', 'Referer': this.baseHost+'/' }, redirect: 'follow' });
      if(!r.ok) return null;
      const html = await r.text();
      // parse first <iframe ... data-lazy-src="...">
      const m = html.match(/<iframe[^>]+data-lazy-src=['"]([^'"]+)['"]/i);
      if(m) return m[1];
  dlog('extractIframeSrc no iframe', { pageUrl });
    } catch(e){ dwarn('extractIframeSrc error', String(e)); }
    return null;
  }

  private async extractHls(hdplayer: string): Promise<string | null>{
    try {
      const r = await fetch(hdplayer, { headers:{ 'User-Agent': this.userAgent, 'Accept':'text/html', 'Referer': this.baseHost+'/' }, redirect: 'follow' });
      if(!r.ok) return null;
      const html = await r.text();
      const patts = [
        /sources:\s*\[\s*\{\s*file\s*:\s*"([^"]+)"/i,
        /file\s*:\s*"([^"]+\.m3u8[^"]*)"/i,
        /src\s*=\s*"([^"]+\.m3u8[^"]*)"/i
      ];
      for(const p of patts){
        const m = html.match(p); if(m) return m[1];
      }
  dlog('extractHls no pattern', { hdplayer });
    } catch(e){ dwarn('extractHls error', String(e)); }
    return null;
  }
}
