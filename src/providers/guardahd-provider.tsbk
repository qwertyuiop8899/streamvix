//# thanks to @urlomythus for the code
//#Adapted for use in Streamvix from:
//# Mammamia  in https://github.com/UrloMythus/MammaMia
//# 

/** GuardaHD Provider (raw HLS, no proxy) - single clean implementation */
import type { StreamForStremio } from '../types/animeunity';
import { getFullUrl } from '../utils/domains';
import { extractFromUrl } from '../extractors';

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
  // Request Italian localized title first; fallback to default if missing
  let r = await fetch(`https://api.themoviedb.org/3/${base}/${tmdbId}?api_key=${key}&language=it-IT`);
  if (!r.ok) r = await fetch(`https://api.themoviedb.org/3/${base}/${tmdbId}?api_key=${key}`);
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
  if (!best) return null;
  const threshold = Math.max(2, Math.floor(target.length * 0.25));
  return bestScore <= threshold ? best : null;
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
    // Try Italian localized title based on TMDB if possible (movie context)
    let italianTitle = r.title;
    try {
      // Attempt to map slug via search again for better matching already done; fallback to r.title
      const tmdbTitle = await this.resolveTitle('imdb', r.id, true).catch(()=>null);
      if (tmdbTitle) italianTitle = tmdbTitle;
    } catch {}
  // Collect all embed links then drop mostraguarda unless it's the only host
  let embedLinks = this.collectEmbedLinks(html);
  const nonMostra = embedLinks.filter(l => !/mostraguarda\.stream/i.test(l));
  if (nonMostra.length) embedLinks = nonMostra; // enforce "use mostraguarda only if nothing else"
    const seen = new Set<string>();
    const out: StreamForStremio[] = [];
    for (const eurl of embedLinks) {
      const { streams } = await extractFromUrl(eurl, { mfpUrl: this.config.mfpUrl, mfpPassword: this.config.mfpPassword, countryCode: 'IT', titleHint: italianTitle });
      for (const s of streams) {
        if (seen.has(s.url)) continue; seen.add(s.url);
        const parsed = this.parseSecondLineParts(s.title);
        out.push({ ...s, title: this.formatStreamTitle(italianTitle, null, null, parsed.info, parsed.player) });
      }
    }
    if (!out.length) {
      // fallback vecchio metodo
      const urls = await this.extractDeep(html);
      for (const u of urls) {
        const info = await this.getHlsInfoSafe(u);
        out.push({ title: this.formatStreamTitle(r.title, null, null, info), url: u, behaviorHints:{ notWebReady:true } });
      }
    }
    // Ensure Mixdrop last ordering for consistency
    const order: Record<string,number> = { supervideo:0, dropload:1, dood:2, mixdrop:99 };
    out.sort((a,b)=>{
      const pa = this.parseSecondLineParts(a.title).player?.toLowerCase() || '';
      const pb = this.parseSecondLineParts(b.title).player?.toLowerCase() || '';
      return (order[pa] ?? 50) - (order[pb] ?? 50);
    });
    return out;
  }

  private async fetchEpisodeStreams(r: GHDSearchResult, ep: GHDEpisode, season: number, episode: number): Promise<StreamForStremio[]> {
    const html = await this.get(ep.url);
    if (!html) return [];
  let embedLinks = this.collectEmbedLinks(html);
  const nonMostra = embedLinks.filter(l => !/mostraguarda\.stream/i.test(l));
  if (nonMostra.length) embedLinks = nonMostra;
    const seen = new Set<string>();
    const out: StreamForStremio[] = [];
    // Italian title for episodes (we already have series title r.title, keep it)
    for (const eurl of embedLinks) {
      const { streams } = await extractFromUrl(eurl, { mfpUrl: this.config.mfpUrl, mfpPassword: this.config.mfpPassword, countryCode: 'IT', titleHint: r.title });
      for (const s of streams) {
        if (seen.has(s.url)) continue; seen.add(s.url);
        const parsed = this.parseSecondLineParts(s.title);
        out.push({ ...s, title: this.formatStreamTitle(r.title, season, episode, parsed.info, parsed.player) });
      }
    }
    if (!out.length) {
      const urls = await this.extractDeep(html);
      for (const u of urls) {
        const info = await this.getHlsInfoSafe(u);
        out.push({ title: this.formatStreamTitle(r.title, season, episode, info), url: u, behaviorHints:{ notWebReady:true } });
      }
    }
    const order: Record<string,number> = { supervideo:0, dropload:1, dood:2, mixdrop:99 };
    out.sort((a,b)=>{
      const pa = this.parseSecondLineParts(a.title).player?.toLowerCase() || '';
      const pb = this.parseSecondLineParts(b.title).player?.toLowerCase() || '';
      return (order[pa] ?? 50) - (order[pb] ?? 50);
    });
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
  // Pre-fetch localized Italian title so every host uses it directly
  let italianTitle = '';
  try { italianTitle = await this.resolveTitle('imdb', imdbId, true); } catch {}
      // Collect ALL embed links (not only the first) so we can try multiple hosts
  let embedLinks: string[] = [];
  const g = html.matchAll(/<li[^>]+data-link=\"([^\"]+)\"/g);
  for (const m of g) { let u = m[1]; if (u.startsWith('//')) u = 'https:' + u; embedLinks.push(u); }
  // Apply mostraguarda suppression (keep only if it's the sole source)
  const nonMostra = embedLinks.filter(u => !/mostraguarda\.stream/i.test(u));
  if (nonMostra.length) embedLinks = nonMostra;
  console.log('[GH][Direct] embedLinks found', embedLinks);
      // If none found on this special imdb page, try alternate domain and scrape again
      if (!embedLinks.length) {
        const sv = html.match(/https?:[^"'\s]+serversicuro\.cc[^"'\s]+master\.m3u8/);
        if (sv) {
          console.log('[GH][Direct] fallback serversicuro master found (no data-link list)');
          const info = await this.getHlsInfoSafe(sv[0]);
          return [{ title: this.formatStreamTitle('', null, null, info), url: sv[0], behaviorHints: { notWebReady: true } }];
        }
        try {
          const altUrl = `https://mostraguarda.stream/movie/${encodeURIComponent(imdbId)}`;
          console.log('[GH][Direct][ALT] trying', altUrl);
          const altHtml = await this.get(altUrl);
            if (altHtml) {
              const g2 = altHtml.matchAll(/<li[^>]+data-link="([^"]+)"/g);
              for (const m2 of g2) { let u = m2[1]; if (u.startsWith('//')) u='https:'+u; embedLinks.push(u); }
              if (!embedLinks.length) {
                const sv2 = altHtml.match(/https?:[^"'\s]+serversicuro\.cc[^"'\s]+master\.m3u8/);
                if (sv2) {
                  const info = await this.getHlsInfoSafe(sv2[0]);
                  return [{ title: this.formatStreamTitle('', null, null, info), url: sv2[0], behaviorHints: { notWebReady: true } }];
                }
              }
            }
        } catch (e) { console.log('[GH][Direct][ALT] error', (e as any)?.message || e); }
      }
      const out: StreamForStremio[] = [];
      const seen = new Set<string>(); // dedupe by final URL
  const playersFound: { player: string; url: string; info?: { res?: string; size?: string } }[] = [];
      const pageReferer = searchUrl;
      // Process order as given (original page order) so user ordering is respected
  for (let rawUrl of embedLinks.slice(0,25)) {
        let eurl = rawUrl;
        if (eurl.startsWith('//')) eurl = 'https:' + eurl;
        try {
          if (/supervideo\./i.test(eurl)) {
            // Try resolve supervideo (2 attempts max); if fails, simply skip (do not show)
            let finalUrl: string | null = null;
            for (let attempt=0; attempt<2 && !finalUrl; attempt++) {
              finalUrl = await this.resolveSupervideoWithHeaders(eurl, pageReferer, attempt);
              if (!finalUrl) await new Promise(r=>setTimeout(r, 350 + attempt*250));
            }
            if (finalUrl) {
              const info = await this.getHlsInfoSafe(finalUrl);
              seen.add(finalUrl);
              playersFound.push({ player: 'SuperVideo', url: finalUrl, info });
              continue;
            }
          }
          const { streams } = await extractFromUrl(eurl, { mfpUrl: this.config.mfpUrl, mfpPassword: this.config.mfpPassword, countryCode: 'IT', referer: pageReferer, titleHint: italianTitle });
          for (const s of streams) {
            if (seen.has(s.url)) continue; seen.add(s.url);
            const parsed = this.parseSecondLineParts(s.title);
            const hostName = parsed.player ? capitalize(parsed.player) : (
              /mixdrop/i.test(eurl)? 'Mixdrop' :
              /dropload/i.test(eurl)? 'Dropload' :
              /dood/i.test(eurl)? 'Doodstream' :
              /supervideo/i.test(eurl)? 'SuperVideo' :
              undefined
            );
            playersFound.push({ player: hostName || 'Stream', url: s.url, info: parsed.info });
          }
        } catch (e) {
          console.log('[GH][Direct] embed extraction error', (e as any)?.message || e);
        }
      }
      // Build output from playersFound (preserve per-extractor base title when italianTitle not resolved)
      for (const p of playersFound) {
        const base = italianTitle || 'Stream';
        out.push({ title: this.formatStreamTitle(base, null, null, p.info, p.player), url: p.url, behaviorHints:{ notWebReady:true } });
      }
      // If nothing extracted (maybe 429 on supervideo), attempt deep scan of original html for any master m3u8
  if (!out.length) {
        // Try alternate domain imdb mapping quickly
        try {
          const altUrl = `https://mostraguarda.stream/movie/${encodeURIComponent(imdbId)}`;
          const altHtml = await this.get(altUrl);
          if (altHtml) {
            const altEmbeds: string[] = [];
            for (const mm of altHtml.matchAll(/<li[^>]+data-link="([^"]+)"/g)) { let u=mm[1]; if(u.startsWith('//')) u='https:'+u; altEmbeds.push(u); }
            for (const raw of altEmbeds) {
              let u = raw; if (u.startsWith('//')) u='https:'+u;
              try {
                if (/supervideo\./i.test(u)) {
                  const svx = await this.resolveSupervideo(u) || await this.resolveSupervideoWithHeaders(u, altUrl, 0);
                  if (svx) { const info = await this.getHlsInfoSafe(svx); out.push({ title: this.formatStreamTitle('', null, null, info, 'SuperVideo'), url: svx, behaviorHints:{ notWebReady:true } }); }
                  continue;
                }
                const { streams } = await extractFromUrl(u, { mfpUrl: this.config.mfpUrl, mfpPassword: this.config.mfpPassword, countryCode:'IT', referer: altUrl });
                for (const s of streams) {
                  if (seen.has(s.url)) continue; seen.add(s.url);
                  const parsed = this.parseSecondLineParts(s.title);
                  const hostName = parsed.player ? capitalize(parsed.player) : undefined;
                  out.push({ ...s, title: this.formatStreamTitle('', null, null, parsed.info, hostName) });
                }
              } catch {}
            }
          }
        } catch {}
        // Final deep scan only if still empty
        if (!out.length) {
          const sv3 = html.match(/https?:[^"'\s]+serversicuro\.cc[^"'\s]+master\.m3u8/);
          if (sv3) {
            const info = await this.getHlsInfoSafe(sv3[0]);
            out.push({ title: this.formatStreamTitle('', null, null, info, 'supervideo'), url: sv3[0], behaviorHints:{ notWebReady:true } });
          }
          if (!out.length) {
            const deep = await this.extractDeep(html);
            for (const u of deep) {
              if (seen.has(u)) continue; seen.add(u);
              const info = await this.getHlsInfoSafe(u);
              out.push({ title: this.formatStreamTitle('', null, null, info), url: u, behaviorHints:{ notWebReady:true } });
            }
          }
        }
      }
      // Apply early-fetched Italian title (if available) and always enforce ordering with Mixdrop last
      if (out.length) {
        if (italianTitle) {
          for (let i=0;i<out.length;i++) {
            const p = this.parseSecondLineParts(out[i].title);
            out[i].title = this.formatStreamTitle(italianTitle, null, null, p.info, p.player);
          }
        }
        const order: Record<string,number> = { supervideo:0, dropload:1, dood:2, doodstream:2, mixdrop:99 };
        out.sort((a,b)=>{
          const pa = this.parseSecondLineParts(a.title).player?.toLowerCase() || '';
          const pb = this.parseSecondLineParts(b.title).player?.toLowerCase() || '';
          return (order[pa] ?? 50) - (order[pb] ?? 50);
        });
      }
      return out;
    } catch { return [] }
  }

  private async resolveSupervideoWithHeaders(link: string, referer: string, attempt: number): Promise<string | null> {
    try {
      const ualist = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
      ];
      const ua = ualist[attempt % ualist.length];
      const html = await this.fetchWithHeaders(link, ua, referer);
      if (!html) return null;
      const m = html.match(/}\('(.+?)',.+,'(.+?)'\.split/);
      if (!m) return null;
      const terms = m[2].split('|');
      const fileIndex = terms.indexOf('file'); if (fileIndex === -1) return null;
      let hfs=''; for (let i=fileIndex;i<terms.length;i++){ if(terms[i].includes('hfs')){ hfs=terms[i]; break; } }
      if (!hfs) return null;
      const urlsetIndex = terms.indexOf('urlset'); const hlsIndex = terms.indexOf('hls');
      if (urlsetIndex === -1 || hlsIndex === -1 || hlsIndex <= urlsetIndex) return null;
      const slice = terms.slice(urlsetIndex + 1, hlsIndex).reverse();
      let base = `https://${hfs}.serversicuro.cc/hls/`;
      if (slice.length === 1) return base + ',' + slice[0] + '.urlset/master.m3u8';
      slice.forEach((el,idx)=>{ base += el + ',' + (idx === slice.length -1 ? '.urlset/master.m3u8' : ''); });
      return base;
    } catch { return null; }
  }

  private async fetchWithHeaders(url: string, ua: string, referer?: string): Promise<string | null> {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': ua, 'Accept':'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language':'it-IT,it;q=0.9,en-US;q=0.7,en;q=0.6', ...(referer? { Referer: referer }: {}), 'Cache-Control':'no-cache', 'Pragma':'no-cache' } as any });
      if (r.status === 429) { console.log('[GH][SV][429] rate limited supervideo'); return null; }
      if (!r.ok) return null; const ct = r.headers.get('content-type') || ''; if (!/html/i.test(ct)) return null; return await r.text();
    } catch { return null; }
  }
  /**
   * Line 1: Movie: "<Title> • [ITA]"  | Episode: "<Title> S<season>E<episode> • [ITA]"
   * Line 2 (optional): "� <size>[ • <res>]" when size or resolution present.
   */
  private formatStreamTitle(title: string, season: number | null, episode: number | null, info?: { res?: string; size?: string }, player?: string): string {
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
    const playerPart = player ? player : undefined;
    const segments: string[] = [];
    if (sizePart) segments.push(sizePart);
    if (resPart) segments.push(resPart);
    if (playerPart) segments.push(playerPart);
    const line2 = segments.length ? '💾 ' + segments.join(' • ') : '';
    return line2 ? `${line1}\n${line2}` : line1;
  }

  private parseSecondLineParts(rawTitle: string): { info?: { res?: string; size?: string }; player?: string } {
    // Expect possible lines: first line + optional second line starting with 💾
    const parts = rawTitle.split(/\n/);
    if (parts.length < 2) return {};
    const line2 = parts[1].replace(/^💾\s*/, '');
    const segs = line2.split(/\s*•\s*/);
    let size: string | undefined; let res: string | undefined; let player: string | undefined;
    for (const s of segs) {
      if (/^(\d+(?:\.\d+)?(GB|MB|KB))$/i.test(s)) size = s.toUpperCase();
      else if (/^\d{3,4}p$/i.test(s)) res = s.toLowerCase();
      else player = s; // last fallback
    }
    const info = (size || res) ? { size, res } : undefined;
    return { info, player };
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
  // Filter out obviously bogus tiny heights (<144p) that yield confusing labels like 100p
  const filtered = variants.filter(v => v.height >= 144 || v.height === 0);
  const working = filtered.length ? filtered : variants;
  working.sort((a,b)=> (b.height - a.height) || (b.bw - a.bw));
  const best = working[0];
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

  private collectEmbedLinks(html: string): string[] {
    const links = new Set<string>();
    // Lista player dichiarata dall'utente <ul class="_player-mirrors"> li[data-link]
    const listRe = /<li[^>]+data-link="([^"]+)"/gi; let m: RegExpExecArray | null; while((m=listRe.exec(html))) { let u = m[1]; if (u.startsWith('//')) u = 'https:' + u; links.add(u); }
    // mirrors generic iframe/data-link fallback
    const dataLinkRe = /data-link="(https?:[^"\s]+)"/gi; while((m=dataLinkRe.exec(html))) links.add(m[1]);
    // iframe embed fallback
    const iframeRe = /<iframe[^>]+src="([^"]+)"/gi; while((m=iframeRe.exec(html))) { let u = m[1]; if (u.startsWith('//')) u='https:'+u; links.add(u); }
    return Array.from(links).slice(0,10);
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

function capitalize(s?: string){ if(!s) return s as any; return s.charAt(0).toUpperCase()+s.slice(1); }
