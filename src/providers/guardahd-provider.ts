/** GuardaHD Provider (raw HLS, no proxy) - single clean implementation */
import type { StreamForStremio } from '../types/animeunity';
import { getFullUrl } from '../utils/domains';

// Removed showSizeInfo (always show size & resolution now)
export interface GuardaHdConfig { enabled:boolean; tmdbApiKey?:string; baseUrl?:string; mfpUrl?:string; mfpPassword?:string; }
interface GHSearchResult { id:string; slug:string; title:string };
interface GHEpisode { number:number; url:string };
// Aliases used by the implementation (naming parity with earlier compressed version)
type GHDSearchResult = GHSearchResult;
type GHDEpisode = GHEpisode;

export class GuardaHdProvider {
  private base: string;
  private hlsInfoCache = new Map<string, { res?: string; size?: string }>();

  constructor(private config: GuardaHdConfig) {
    const dom = getFullUrl('guardahd');
    this.base = (config.baseUrl || dom || 'https://www.guardahd.example').replace(/\/$/, '');
  }

  async handleImdbRequest(imdbId: string, season: number | null, episode: number | null, isMovie = false) {
    if (!this.config.enabled) return { streams: [] };
    try {
      const imdbOnly = imdbId.split(':')[0];
      if (isMovie) {
        const direct = await this.tryDirectImdbMovie(imdbOnly);
        if (direct.length) return { streams: direct };
      }
      const t = await this.resolveTitle('imdb', imdbId, isMovie);
      return this.core(t, season, episode, isMovie);
    } catch {
      return { streams: [] };
    }
  }

  async handleTmdbRequest(tmdbId: string, season: number | null, episode: number | null, isMovie = false) {
    if (!this.config.enabled) return { streams: [] };
    try {
      const t = await this.resolveTitle('tmdb', tmdbId, isMovie);
      return this.core(t, season, episode, isMovie);
    } catch {
      return { streams: [] };
    }
  }

  private async core(title: string, season: number | null, episode: number | null, isMovie: boolean): Promise<{ streams: StreamForStremio[] }> {
    let results = await this.search(title);

    if (!results.length) {
      const np = title.replace(/[:\-_.]/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if (np && np !== title) results = await this.search(np);
    }

    if (!results.length) {
      const w = title.split(/\s+/);
      if (w.length > 3) results = await this.search(w.slice(0, 3).join(' '));
    }

    if (!results.length) return { streams: [] };

    const picked = this.pickBest(results, title);
    if (!picked) return { streams: [] };

    if (isMovie) {
      return { streams: await this.fetchMovieStreams(picked) };
    }

    const eps = await this.fetchEpisodes(picked);
    if (!eps.length) return { streams: [] };
    const target = this.selectEpisode(eps, episode);
    if (!target) return { streams: [] };

    return { streams: await this.fetchEpisodeStreams(picked, target, season || 1, episode || target.number) };
  }

  private async resolveTitle(kind: 'imdb' | 'tmdb', id: string, isMovie: boolean): Promise<string> {
    const key = this.config.tmdbApiKey || (globalThis as any).process?.env?.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0';
    if (kind === 'imdb') {
      const imdbOnly = id.split(':')[0];
      const mod = await import('../extractor');
      const tmdbId = await mod.getTmdbIdFromImdbId(imdbOnly, key);
      if (!tmdbId) throw new Error('No TMDB');
      return this.fetchTmdbTitle(tmdbId, isMovie, key);
    }
    return this.fetchTmdbTitle(id, isMovie, key);
  }

  private async fetchTmdbTitle(tmdbId: string, isMovie: boolean, key: string): Promise<string> {
    const base = isMovie ? 'movie' : 'tv';
    const r = await fetch(`https://api.themoviedb.org/3/${base}/${tmdbId}?api_key=${key}`);
    if (!r.ok) throw new Error('tmdb fail');
    const j: any = await r.json();
    return j?.title || j?.name || j?.original_title || j?.original_name || 'Unknown';
  }

  private async search(q: string): Promise<GHDSearchResult[]> {
    try {
      const url = `${this.base}/?s=${encodeURIComponent(q.replace(/\s+/g, '+'))}`;
      const html = await this.get(url);
      if (!html) return [];
      const out: GHDSearchResult[] = [];
      const re = /<a[^>]+href=\"([^\"]+)\"[^>]*class=\"[^\">]*post-thumb[^>]*>\s*<img[^>]+alt=\"([^\"]+)\"/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html))) {
        const href = m[1];
        const title = m[2];
        const id = href.split('/').filter(Boolean).pop() || href;
        out.push({ id, slug: id, title });
        if (out.length > 40) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  private pickBest(results: GHDSearchResult[], wanted: string): GHDSearchResult | null {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const target = norm(wanted);
    let best: GHDSearchResult | null = null;
    let bestScore = Infinity;
    for (const r of results) {
      const d = this.lev(norm(r.title), target);
      if (d < bestScore) {
        bestScore = d;
        best = r;
      }
    }
    return best;
  }

  private async fetchEpisodes(r: GHDSearchResult): Promise<GHDEpisode[]> {
    const html = await this.get(`${this.base}/${r.slug}/`);
    if (!html) return [];
    const eps: GHDEpisode[] = [];
    const rx = /data-episode=\"(\d+)\"[^>]*data-url=\"([^\"]+)\"/gi;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(html))) {
      const n = parseInt(m[1]);
      if (!isNaN(n)) eps.push({ number: n, url: m[2] });
      if (eps.length > 400) break;
    }
    return eps.sort((a, b) => a.number - b.number);
  }

  private selectEpisode(eps: GHDEpisode[], wanted: number | null): GHDEpisode | null {
    if (wanted == null) return eps[0] || null;
    return eps.find(e => e.number === wanted) || null;
  }

  private async fetchMovieStreams(r: GHDSearchResult): Promise<StreamForStremio[]> {
    const html = await this.get(`${this.base}/${r.slug}/`);
    if (!html) return [];
    const urls = await this.extractDeep(html);
    const out: StreamForStremio[] = [];
    for (const u of urls) {
      const info = await this.getHlsInfoSafe(u);
      out.push({
        title: this.formatStreamTitle(r.title, null, null, info),
        url: u,
        behaviorHints: { notWebReady: true }
      });
    }
    return out;
  }

  private async fetchEpisodeStreams(r: GHDSearchResult, ep: GHDEpisode, season: number, episode: number): Promise<StreamForStremio[]> {
    const html = await this.get(ep.url);
    if (!html) return [];
    const urls = await this.extractDeep(html);
    const out: StreamForStremio[] = [];
    for (const u of urls) {
      const info = await this.getHlsInfoSafe(u);
      out.push({
        title: this.formatStreamTitle(r.title, season, episode, info),
        url: u,
        behaviorHints: { notWebReady: true }
      });
    }
    return out;
  }

  // ==== Mammamia style flow (GuardaHD movie only) ====
  private async tryDirectImdbMovie(imdbId: string): Promise<StreamForStremio[]> {
    try {
      const searchUrl = `${this.base}/set-movie-a/${encodeURIComponent(imdbId)}`;
  console.log('[GH][Direct] search url', searchUrl);
      const html = await this.get(searchUrl);
      if (!html) return [];
  console.log('[GH][Direct] search html length', html.length);
      const li = html.match(/<li[^>]+data-link="([^"]+)"/i);
      if (!li) {
        // fallback: maybe page already has serversicuro link inside scripts
        const sv = html.match(/https?:[^"'\s]+serversicuro\.cc[^"'\s]+master\.m3u8/);
        if (sv) {
          console.log('[GH][Direct] fallback serversicuro master found');
          const info = await this.getHlsInfoSafe(sv[0]);
          return [{ title: this.formatStreamTitle('', null, null, info), url: sv[0], behaviorHints: { notWebReady: true } }];
        }
        return [];
      }
      let superVideoLink = li[1];
      if (superVideoLink.startsWith('//')) superVideoLink = 'https:' + superVideoLink;
  console.log('[GH][Direct] supervideo link', superVideoLink);
      const finalUrl = await this.resolveSupervideo(superVideoLink);
      if (!finalUrl) return [];
  const info = await this.getHlsInfoSafe(finalUrl);
  // Prova a ricavare titolo reale via TMDB (usa resolveTitle con imdb path)
  let realTitle = '';
  try { realTitle = await this.resolveTitle('imdb', imdbId, true); } catch {}
  return [{ title: this.formatStreamTitle(realTitle || '', null, null, info), url: finalUrl, behaviorHints: { notWebReady: true } }];
    } catch { return [] }
  }
  /**
   * Line 1: Movie: "<Title> • [ITA]"  | Episode: "<Title> S<season>E<episode> • [ITA]"
   * Line 2 (optional): "� <size>[ • <res>]" when size or resolution present.
   */
  private formatStreamTitle(title: string, season: number | null, episode: number | null, info?: { res?: string; size?: string }): string {
    let line1 = (title || '').trim();
    if (season != null && episode != null) {
      if (line1) line1 += ` S${season}E${episode}`; else line1 = `S${season}E${episode}`;
    }
    if (!line1) line1 = 'Stream';
    if (!/• \[ITA\]$/i.test(line1)) {
      if (/\[ITA\]$/i.test(line1)) line1 = line1.replace(/\s*\[ITA\]$/i,' • [ITA]'); else line1 += ' • [ITA]';
    }
    const sizePart = info?.size ? info.size : undefined;
    const resPart = info?.res ? info.res : undefined;
    let line2 = '';
    if (sizePart || resPart) {
      line2 = '💾 ' + (sizePart || '');
      if (resPart) line2 += (sizePart ? ' • ' : '') + resPart;
    }
    return line2 ? `${line1}\n${line2}` : line1;
  }

  private async getHlsInfoSafe(url: string): Promise<{ res?: string; size?: string }> {
    try { return await this.getHlsInfo(url); } catch { return {}; }
  }

  private async getHlsInfo(masterUrl: string): Promise<{ res?: string; size?: string }> {
    if (this.hlsInfoCache.has(masterUrl)) return this.hlsInfoCache.get(masterUrl)!;
    const out: { res?: string; size?: string } = {};
    const masterTxt = await this.fetchText(masterUrl, 120000);
    if (!masterTxt) { this.hlsInfoCache.set(masterUrl, out); return out; }
    // Parse variants
    interface Variant { bw: number; height: number; uri: string; }
    const variants: Variant[] = [];
    const lines = masterTxt.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = l.substring('#EXT-X-STREAM-INF:'.length);
        const bwMatch = attrs.match(/BANDWIDTH=(\d+)/i);
        const resMatch = attrs.match(/RESOLUTION=(\d+)x(\d+)/i);
        const next = lines[i + 1] || '';
        if (bwMatch && next && !next.startsWith('#')) {
          const bw = parseInt(bwMatch[1]);
          const height = resMatch ? parseInt(resMatch[2]) : 0;
          variants.push({ bw, height, uri: next.trim() });
        }
      }
    }
    if (!variants.length) { this.hlsInfoCache.set(masterUrl, out); return out; }
    // Pick best by height then bandwidth
    variants.sort((a,b)=> (b.height - a.height) || (b.bw - a.bw));
    const best = variants[0];
    if (best.height) out.res = `${best.height}p`;
    // Resolve variant absolute URL
    let variantUrl = best.uri;
    if (!/^https?:/i.test(variantUrl)) {
      try {
        const u = new URL(masterUrl);
        if (variantUrl.startsWith('/')) variantUrl = `${u.protocol}//${u.host}${variantUrl}`; else {
          const basePath = masterUrl.replace(/\/[^/]*$/, '/');
          variantUrl = basePath + variantUrl;
        }
      } catch {}
    }
    // Fetch variant playlist to compute duration
    const variantTxt = await this.fetchText(variantUrl, 400000);
    if (variantTxt) {
      let duration = 0;
      const rex = /#EXTINF:([0-9.]+)/g; let m: RegExpExecArray | null;
      while ((m = rex.exec(variantTxt))) {
        duration += parseFloat(m[1]) || 0;
        if (duration > 36000) break; // safety 10h
      }
      if (duration > 0 && best.bw) {
        const bytes = duration * (best.bw / 8); // bits/s -> bytes
        out.size = this.humanSize(bytes);
      }
    }
    this.hlsInfoCache.set(masterUrl, out);
    return out;
  }

  private humanSize(bytes: number): string {
    const units = ['B','KB','MB','GB','TB'];
    let i = 0; let v = bytes;
    while (v >= 1024 && i < units.length -1) { v /= 1024; i++; }
    return (i >= 2 ? v.toFixed(2) : v.toFixed(0)) + units[i];
  }

  private async fetchText(url: string, maxLen = 120000): Promise<string | null> {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (HLSInfo)' } });
      if (!r.ok) return null;
      const txt = await r.text();
      return txt.slice(0, maxLen);
    } catch { return null; }
  }

  private async resolveSupervideo(link: string): Promise<string | null> {
    try {
      const html = await this.get(link);
      if (!html) return null;
      const m = html.match(/}\('(.+?)',.+,'(.+?)'\.split/);
      if (!m) return null;
      const terms = m[2].split('|');
      const fileIndex = terms.indexOf('file');
      if (fileIndex === -1) return null;
      let hfs = '';
      for (let i = fileIndex; i < terms.length; i++) { if (terms[i].includes('hfs')) { hfs = terms[i]; break; } }
      if (!hfs) return null;
      const urlsetIndex = terms.indexOf('urlset');
      const hlsIndex = terms.indexOf('hls');
      if (urlsetIndex === -1 || hlsIndex === -1 || hlsIndex <= urlsetIndex) return null;
      const slice = terms.slice(urlsetIndex + 1, hlsIndex);
      const reversed = slice.reverse();
      let base = `https://${hfs}.serversicuro.cc/hls/`;
      if (reversed.length === 1) {
        return base + ',' + reversed[0] + '.urlset/master.m3u8';
      }
      const len = reversed.length;
      reversed.forEach((el, idx) => { base += el + ',' + (idx === len - 1 ? '.urlset/master.m3u8' : ''); });
      return base;
    } catch { return null; }
  }

  private async extractDeep(html: string): Promise<string[]> {
    const initial = this.extractFlat(html);
    const found = new Set<string>(initial.filter(u => /\.m3u8/i.test(u)));
    const iframeRe = /<iframe[^>]+src=\"([^\"]+)\"/gi;
    let m: RegExpExecArray | null;
    const iframes: string[] = [];
    while ((m = iframeRe.exec(html))) iframes.push(m[1]);
    const follow = [...new Set([...iframes, ...initial.filter(u => !/\.m3u8/i.test(u))])].slice(0, 5);
    for (const src of follow) {
      try {
        const ih = await this.get(src);
        if (!ih) continue;
        const master = ih.match(/https?:[^"'\s]+master\.m3u8/);
        if (master) found.add(master[0]);
        const any = ih.match(/https?:[^"'\s]+\.m3u8/g);
        if (any) any.forEach(u => found.add(u));
      } catch { /* ignore */ }
    }
    return Array.from(found).slice(0, 8);
  }

  private extractFlat(html: string): string[] {
    const urls = new Set<string>();
    const add = (s?: string) => {
      if (!s) return;
      if (!/^https?:/i.test(s)) return;
      urls.add(s);
    };
    const iframeRe = /<iframe[^>]+src=\"([^\"]+)\"/gi; let m: RegExpExecArray | null; while ((m = iframeRe.exec(html))) add(m[1]);
    const sourceRe = /<source[^>]+src=\"([^\"]+)\"/gi; while ((m = sourceRe.exec(html))) add(m[1]);
    const dataRe = /data-(?:file|src)=\"([^\"]+)\"/gi; while ((m = dataRe.exec(html))) add(m[1]);
    const plainRe = /(https?:[^'"\s]+?(?:m3u8|mp4)[^'"\s]*)/gi; while ((m = plainRe.exec(html))) add(m[1]);
    return Array.from(urls).slice(0, 15);
  }

  private async get(url: string): Promise<string | null> {
    const uaList = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/124.0'
    ];
    for (let attempt = 0; attempt < uaList.length; attempt++) {
      const attemptUrl = attempt === 0 ? url : url.replace(/^https:/, 'http:');
      try {
        const r = await fetch(attemptUrl, { headers: { 'User-Agent': uaList[attempt] } });
        const status = r.status;
        const isHtml = r.headers.get('content-type')?.includes('text/html');
        const text = isHtml ? await r.text() : '';
        console.log(`[GH][NET] attempt=${attempt} status=${status} url=${attemptUrl}`);
        if (!r.ok) continue;
        const block = /(cloudflare|captcha|access denied|blocked)/i.test(text.slice(0, 1200));
        if (block) {
          console.log('[GH][NET] possible block detected');
          return null;
        }
        console.log(`[GH][NET] body length=${text.length}`);
        return text;
      } catch (e) {
        console.log('[GH][NET] fetch error attempt', attempt, (e as any)?.message || e);
      }
    }
    return null;
  }

  private lev(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1));
    for (let i = 0; i <= a.length; i++) dp[i][0] = i;
    for (let j = 0; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const c = a[i - 1] === b[j - 1] ? 0 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + c
        );
      }
    }
    return dp[a.length][b.length];
  }
}
