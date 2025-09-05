/** GuardaSerie Provider (raw HLS, no proxy) - single clean implementation */
import type { StreamForStremio } from '../types/animeunity';
import { getFullUrl } from '../utils/domains';
import { extractFromUrl } from '../extractors';

// Removed showSizeInfo (always include size/res with ruler icon when available)
export interface GuardaSerieConfig { enabled: boolean; tmdbApiKey?: string; baseUrl?: string; mfpUrl?: string; mfpPassword?: string; }
interface GSSearchResult { id: string; slug: string; title: string };
interface GSEpisode { number: number; url: string };

export class GuardaSerieProvider {
  private base: string;
  private hlsInfoCache = new Map<string, { res?: string; size?: string }>();

  constructor(private config: GuardaSerieConfig) {
    const dom = getFullUrl('guardaserie');
    this.base = (config.baseUrl || dom || 'https://www.guardaserie.example').replace(/\/$/, '');
  }

  async handleImdbRequest(imdbId: string, season: number | null, episode: number | null, isMovie = false) {
    if (!this.config.enabled) return { streams: [] };
    try {
      // New path: use mammamia-style direct IMDb search & supervideo resolution first
      const imdbOnly = imdbId.split(':')[0];
      if (!isMovie) {
        const direct = await this.tryDirectImdbFlow(imdbOnly, season || 1, episode || 1);
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
    // First attempt: Italian localized title
    let j: any = null;
    try {
      const rIt = await fetch(`https://api.themoviedb.org/3/${base}/${tmdbId}?api_key=${key}&language=it-IT`);
      if (rIt.ok) j = await rIt.json();
    } catch {}
    // Fallback: default (original / English) if Italian missing or empty
    if (!j || !(j.title || j.name || j.original_title || j.original_name)) {
      try {
        const rDef = await fetch(`https://api.themoviedb.org/3/${base}/${tmdbId}?api_key=${key}`);
        if (rDef.ok) j = await rDef.json();
      } catch {}
    }
    return (j?.title || j?.name || j?.original_title || j?.original_name || 'Unknown');
  }

  private async search(q: string): Promise<GSSearchResult[]> {
    try {
      const url = `${this.base}/?s=${encodeURIComponent(q.replace(/\s+/g, '+'))}`;
      const html = await this.get(url);
      if (!html) return [];
      const out: GSSearchResult[] = [];
      const re = /<a[^>]+href=\"([^\"]+)\"[^>]*class=\"[^\">]*post-thumb[^>]*>\s*<img[^>]+alt=\"([^\"]+)\"/gi;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html))) {
  const href = m[1];
  const title = m[2];
  const slug = href.split('/').filter(Boolean).pop() || href;
  out.push({ id: slug, slug, title });
  if (out.length > 40) break;
      }
      return out;
    } catch {
      return [];
    }
  }

  private pickBest(results: GSSearchResult[], wanted: string): GSSearchResult | null {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const target = norm(wanted);
    let best: GSSearchResult | null = null;
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

  private async fetchEpisodes(r: GSSearchResult): Promise<GSEpisode[]> {
    const html = await this.get(`${this.base}/${r.slug}/`);
    if (!html) return [];
    const eps: GSEpisode[] = [];
    const rx = /data-episode=\"(\d+)\"[^>]*data-url=\"([^\"]+)\"/gi;
    let m: RegExpExecArray | null;
    while ((m = rx.exec(html))) {
      const n = parseInt(m[1]);
      if (!isNaN(n)) eps.push({ number: n, url: m[2] });
      if (eps.length > 400) break;
    }
    return eps.sort((a, b) => a.number - b.number);
  }

  private selectEpisode(eps: GSEpisode[], wanted: number | null): GSEpisode | null {
    if (wanted == null) return eps[0] || null;
    return eps.find(e => e.number === wanted) || null;
  }

  private async fetchMovieStreams(r: GSSearchResult): Promise<StreamForStremio[]> {
    const html = await this.get(`${this.base}/${r.slug}/`);
    if (!html) return [];
    const embedLinks = this.collectEmbedLinks(html, true);
    const seen = new Set<string>();
    const out: StreamForStremio[] = [];
    for (const eurl of embedLinks) {
      const { streams } = await extractFromUrl(eurl, { mfpUrl: this.config.mfpUrl, mfpPassword: this.config.mfpPassword, countryCode: 'IT' });
      for (const s of streams) { if (seen.has(s.url)) continue; seen.add(s.url); const parsed = this.parseSecondLineParts(s.title); out.push({ ...s, title: this.formatStreamTitle(r.title, null, null, parsed.info, parsed.player) }); }
    }
    if (!out.length) {
      const urls = await this.extractDeep(html);
      for (const u of urls) {
        const info = await this.getHlsInfoSafe(u);
        out.push({ title: this.formatStreamTitle(r.title, null, null, info), url: u, behaviorHints:{ notWebReady:true } });
      }
    }
    // Post-processing rule for movies? Requirement only for Guardaserie episodes; leave movies untouched
    return out;
  }

  private async fetchEpisodeStreams(r: GSSearchResult, ep: GSEpisode, season: number, episode: number): Promise<StreamForStremio[]> {
    const html = await this.get(ep.url);
    if (!html) return [];
    const embedLinks = this.collectEmbedLinks(html, false);
    const seen = new Set<string>();
    const out: StreamForStremio[] = [];
    for (const eurl of embedLinks) {
      const { streams } = await extractFromUrl(eurl, { mfpUrl: this.config.mfpUrl, mfpPassword: this.config.mfpPassword, countryCode: 'IT' });
      for (const s of streams) { if (seen.has(s.url)) continue; seen.add(s.url); const parsed = this.parseSecondLineParts(s.title); out.push({ ...s, title: this.formatStreamTitle(r.title, season, episode, parsed.info, parsed.player) }); }
    }
    if (!out.length) {
      const urls = await this.extractDeep(html);
      for (const u of urls) {
        const info = await this.getHlsInfoSafe(u);
        out.push({ title: this.formatStreamTitle(r.title, season, episode, info), url: u, behaviorHints:{ notWebReady:true } });
      }
    }
    // Post-processing: remove Dropload size if no SuperVideo present
    try {
      const superSize = (() => {
        for (const s of out) {
          if (/supervideo/i.test(s.title)) {
            const p = this.parseSecondLineParts(s.title);
            if (p.info?.size) return p.info.size;
          }
        }
        return undefined;
      })();
      for (let i=0;i<out.length;i++) {
        const parsed = this.parseSecondLineParts(out[i].title);
        if (parsed.player?.toLowerCase() === 'dropload') {
          const newInfo = { res: parsed.info?.res, size: superSize || undefined };
          if (!superSize) delete (newInfo as any).size; // no size if supervideo absent
          out[i].title = this.formatStreamTitle(r.title, season, episode, newInfo, parsed.player);
        }
      }
    } catch {}
    return out;
  }

  // ==== Mammamia style flow (Guardaserie) ====
  private async tryDirectImdbFlow(imdbId: string, season: number, episode: number): Promise<StreamForStremio[]> {
    try {
      const searchUrl = `${this.base}/?story=${encodeURIComponent(imdbId)}&do=search&subaction=search`;
      console.log('[GS][Direct] search url', searchUrl);
      const html = await this.get(searchUrl);
      if (!html) return [];
      console.log('[GS][Direct] search html length', html.length);
      // collect possible detail page links
      const hrefs: string[] = [];
      const reHref = /<div[^>]+class="mlnh-2"[\s\S]*?<h2>\s*<a[^>]+href="([^"]+)"/gi;
      let m: RegExpExecArray | null; let count=0;
      while((m=reHref.exec(html)) && count<5){ hrefs.push(m[1]); count++; }
      if (!hrefs.length) {
        const reA = /<a[^>]+href="([^"]+)"[^>]*>/gi; count=0;
        while((m=reA.exec(html)) && count<5){ const u=m[1]; if(/\/\d/.test(u)){ hrefs.push(u); count++; } }
      }
      if (!hrefs.length) return [];
      const pageUrl = hrefs[1] || hrefs[0];
      console.log('[GS][Direct] chosen page', pageUrl);
      const detailHtml = await this.get(pageUrl);
      if (!detailHtml) return [];
      console.log('[GS][Direct] detail html length', detailHtml.length);
      // Locate the <li> for the requested episode id="serie-season_episode" and gather its mirrors
      const epId = `serie-${season}_${episode}`;
      const liRegex = new RegExp(`<li[^>]*>[^<]*\n?\s*<a[^>]+id="${epId}"[\\s\\S]*?<\/li>`,'i');
      const embedLinks: string[] = [];
      const liMatch = detailHtml.match(liRegex);
      if (liMatch) {
        const block = liMatch[0];
        // Mirrors inside this li (class mr)
        for (const mm of block.matchAll(/class=\"mr[^\"]*\"[^>]+data-link=\"([^\"]+)\"/g)) { let u = mm[1]; if(u.startsWith('//')) u='https:'+u; embedLinks.push(u); }
        // Also accept "me" (other players) if needed later
        for (const mm of block.matchAll(/class=\"me[^\"]*\"[^>]+data-link=\"([^\"]+)\"/g)) { let u = mm[1]; if(u.startsWith('//')) u='https:'+u; if(!embedLinks.includes(u)) embedLinks.push(u); }
        // Fallback any generic data-link in block
        for (const mm of block.matchAll(/data-link=\"([^\"]+)\"/g)) { let u=mm[1]; if(u.startsWith('//')) u='https:'+u; if(!embedLinks.includes(u)) embedLinks.push(u); }
      }
      // If nothing found inside li, some pages repeat a global mirrors block after tt_holder; capture active mirrors referencing this episode id
      if (!embedLinks.length) {
        const globalMirrors = detailHtml.match(/<div class=\"mirrors\"[\s\S]*?<\/div>/gi) || [];
        for (const gm of globalMirrors) {
          // only take if it contains at least one data-link with supervideo/dropload AND near the target episode id present earlier
          if (!new RegExp(`id=\"${epId}\"`).test(detailHtml)) continue;
          for (const mm of gm.matchAll(/data-link=\"([^\"]+)\"/g)) { let u=mm[1]; if(u.startsWith('//')) u='https:'+u; if(/supervideo|dropload|mixdrop|dood/i.test(u)) { if(!embedLinks.includes(u)) embedLinks.push(u); } }
        }
      }
      const uniqueLinks = Array.from(new Set(embedLinks)).filter(l=>/supervideo|dropload|mixdrop|dood/i.test(l)).slice(0,6);
      const pageReferer = pageUrl;
      const out: StreamForStremio[] = []; const seen = new Set<string>();
      for (const eurlRaw of uniqueLinks) {
        let eurl = eurlRaw.startsWith('//') ? 'https:' + eurlRaw : eurlRaw;
        try {
          if (/supervideo\./i.test(eurl)) {
            let finalUrl: string | null = null;
            for (let attempt=0; attempt<2 && !finalUrl; attempt++) {
              finalUrl = await this.resolveSupervideoWithHeaders(eurl, pageReferer, attempt);
              if (!finalUrl) await new Promise(r=>setTimeout(r, 350 + attempt*250));
            }
            if (finalUrl) {
              const info = await this.getHlsInfoSafe(finalUrl);
              if (!seen.has(finalUrl)) { seen.add(finalUrl); out.push({ title: this.formatStreamTitle('', season, episode, info, 'supervideo'), url: finalUrl, behaviorHints:{ notWebReady:true } }); }
              continue;
            }
          }
          const { streams } = await extractFromUrl(eurl, { mfpUrl: this.config.mfpUrl, mfpPassword: this.config.mfpPassword, countryCode: 'IT', referer: pageReferer });
          for (const s of streams) {
            if (seen.has(s.url)) continue; seen.add(s.url);
            const parsed = this.parseSecondLineParts(s.title);
            let player = parsed.player;
            if (!player) {
              player = /dropload/i.test(eurl)? 'dropload': /mixdrop/i.test(eurl)? 'mixdrop': /dood/i.test(eurl)? 'doodstream': undefined as any;
            }
            out.push({ ...s, title: this.formatStreamTitle('', season, episode, parsed.info, player) });
          }
        } catch (e) { console.log('[GS][Direct] embed error', (e as any)?.message || e); }
      }
      if (out.length) {
        // enrich with real title from TMDB
        try {
          const realTitle = await this.resolveTitle('imdb', imdbId, false);
          if (realTitle) {
            for (let i=0;i<out.length;i++) {
              const p = this.parseSecondLineParts(out[i].title);
              out[i].title = this.formatStreamTitle(realTitle, season, episode, p.info, p.player);
            }
          }
        } catch {}
        // Apply Dropload size adoption: use SuperVideo size if present else none
        try {
          // capture resolved title from previous block (may be blank if resolution failed earlier)
          let resolvedTitle = '';
          try { resolvedTitle = await this.resolveTitle('imdb', imdbId, false); } catch {}
          const superSize = (() => {
            for (const s of out) {
              if (/supervideo/i.test(s.title)) {
                const p = this.parseSecondLineParts(s.title);
                if (p.info?.size) return p.info.size;
              }
            }
            return undefined;
          })();
          if (out.some(s => /dropload/i.test(s.title))) {
            for (let i=0;i<out.length;i++) {
              const parsed = this.parseSecondLineParts(out[i].title);
              if (parsed.player?.toLowerCase() === 'dropload') {
                const newInfo = { res: parsed.info?.res, size: superSize || undefined };
                if (!superSize) delete (newInfo as any).size;
                out[i].title = this.formatStreamTitle(resolvedTitle || '', season, episode, newInfo, parsed.player);
              }
            }
          }
        } catch {}
        return out;
      }
      // Fallback legacy pattern detection for supervideo
      const patterns: RegExp[] = [
        new RegExp(`id=\\"serie-${season}_${episode}\\"[^>]*data-link=\\"([^\\"]+)\\"`, 'i'),
        new RegExp(`data-link=\\"([^\\"]+)\\"[^>]*id=\\"serie-${season}_${episode}\\"`, 'i'),
        new RegExp(`id=\\"serie-${season}_${episode}\\"[^>]*href=\\"([^\\"]+)\\"`, 'i'),
        new RegExp(`data-ep=[\\"']${season}_${episode}[\\"'][^>]*data-link=\\"([^\\"]+)\\"`, 'i'),
      ];
      for (const p of patterns) {
        const mm = detailHtml.match(p);
        if (mm) {
          const svLink = mm[1];
          const finalUrl = await this.resolveSupervideoWithHeaders(svLink, pageReferer, 0) || await this.resolveSupervideo(svLink);
          if (finalUrl) {
            const info = await this.getHlsInfoSafe(finalUrl);
            let realTitle=''; try { realTitle = await this.resolveTitle('imdb', imdbId, false);} catch{}
            return [{ title: this.formatStreamTitle(realTitle || '', season, episode, info, 'supervideo'), url: finalUrl, behaviorHints:{ notWebReady:true } }];
          }
          break;
        }
      }
      // Last resort: search any serversicuro master
      const sv = detailHtml.match(/https?:[^"'\s]+serversicuro\.cc[^"'\s]+master\.m3u8/);
      if (sv) {
        const info = await this.getHlsInfoSafe(sv[0]);
        let realTitle=''; try { realTitle = await this.resolveTitle('imdb', imdbId, false);} catch{}
        return [{ title: this.formatStreamTitle(realTitle || '', season, episode, info, 'supervideo'), url: sv[0], behaviorHints:{ notWebReady:true } }];
      }
      return [];
    } catch { return []; }
  }
  /**
   * Format stream title according to spec:
   * Line 1: Movie: "<Title> • [ITA]"  | Episode: "<Title> S<season>E<episode> • [ITA]"
   * Line 2 (only if size or res present): "� <size>[ • <res>]"
   * Always show size/res on second line like VixSrc formatting request.
   */
  private formatStreamTitle(title: string, season: number | null, episode: number | null, info?: { res?: string; size?: string }, player?: string): string {
    let line1 = (title || '').trim();
    if (season != null && episode != null) {
      if (line1) line1 += ` S${season}E${episode}`; else line1 = `S${season}E${episode}`;
    }
    if (!line1) line1 = 'Stream';
    // Ensure bullet before [ITA]
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
    const parts = rawTitle.split(/\n/);
    if (parts.length < 2) return {};
    const line2 = parts[1].replace(/^💾\s*/, '');
    const segs = line2.split(/\s*•\s*/);
    let size: string | undefined; let res: string | undefined; let player: string | undefined;
    for (const s of segs) {
      if (/^(\d+(?:\.\d+)?(GB|MB|KB))$/i.test(s)) size = s.toUpperCase();
      else if (/^\d{3,4}p$/i.test(s)) res = s.toLowerCase();
      else player = s;
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
    variants.sort((a,b)=> (b.height - a.height) || (b.bw - a.bw));
    const best = variants[0];
    if (best.height) out.res = `${best.height}p`;
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
    const variantTxt = await this.fetchText(variantUrl, 400000);
    if (variantTxt) {
      let duration = 0; let m: RegExpExecArray | null; const rex = /#EXTINF:([0-9.]+)/g;
      while ((m = rex.exec(variantTxt))) { duration += parseFloat(m[1]) || 0; if (duration > 36000) break; }
      if (duration > 0) {
        // banda media stimata dal variant selezionato
        const bw = best.bw; // bits/sec
        if (bw) {
          const bytes = duration * (bw / 8);
          out.size = this.humanSize(bytes);
        }
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
      if (!r.ok) return null; const txt = await r.text(); return txt.slice(0, maxLen);
    } catch { return null; }
  }

  private async resolveSupervideo(link: string): Promise<string | null> {
    try {
      const html = await this.get(link);
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
      if (r.status === 429) { console.log('[GS][SV][429] rate limited supervideo'); return null; }
      if (!r.ok) return null; const ct = r.headers.get('content-type') || ''; if (!/html/i.test(ct)) return null; return await r.text();
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

  private collectEmbedLinks(html: string, isMovie: boolean): string[] {
    const links = new Set<string>();
    // Guardaserie markup snippet mirrors
    const mirrorsRe = /class="mirrors"([\s\S]*?)<\/div>/gi; let m: RegExpExecArray | null;
    while((m=mirrorsRe.exec(html))) {
      const segment = m[1];
      const aRe = /data-link="(?!#)([^"]+)"/gi; let am: RegExpExecArray | null;
      while((am=aRe.exec(segment))) { let u = am[1]; if (u.startsWith('//')) u='https:'+u; links.add(u); }
    }
    // Hidden lists (ul with data-link) reused from guardahd concept
    const listRe = /<li[^>]+data-link="([^"]+)"/gi; while((m=listRe.exec(html))) { let u=m[1]; if(u.startsWith('//')) u='https:'+u; links.add(u); }
    // Iframes fallback
    const iframeRe = /<iframe[^>]+src="([^"]+)"/gi; while((m=iframeRe.exec(html))) { let u=m[1]; if(u.startsWith('//')) u='https:'+u; links.add(u); }
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
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) return null;
      return await r.text();
    } catch {
      return null;
    }
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
