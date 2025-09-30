/* CB01 Mixdrop-only provider
thanks to @urlomythus for the code https://github.com/UrloMythus/MammaMia/blob/main/Src/API/cb01.py
 * Replica la logica essenziale di cb01.py limitandosi a:
 *  - Ricerca film: https://cb01net.lol/?s=<query>
 *  - Ricerca serie: https://cb01net.lol/serietv/?s=<query>
 *  - Film: usa iframen2 (Streaming HD) se presente, altrimenti iframen1
 *  - Serie: blocco STAGIONE X e match episodio -> prima occorrenza mixdrop/stayonline
 *  - Bypass stayonline (POST ajax) -> ottiene embed Mixdrop
 *  - Incapsula tramite MediaFlow extractor (redirect_stream=false) e ricostruisce link proxy /proxy/stream
 * Limitazioni / differenze:
 *  - Non implementa Maxstream / altri host
 *  - Titolo/anno: placeholder (usa imdbId) perché la risoluzione TMDB è già gestita da altri provider upstream
 *  - Parsing HTML fragile se cambia markup del sito
 *  - Cache semplice in-memory (TTL 6h)
 */
import type { StreamForStremio } from '../types/animeunity';

// --- Debug helpers ---
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;
function envFlag(name: string): boolean | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g: any = (typeof process !== 'undefined' && process.env) ? process.env : {};
    const v = (g[name] || g['REACT_APP_'+name] || '').toString().trim().toLowerCase();
    if(!v) return null;
    if(['1','true','on','yes','y'].includes(v)) return true;
    if(['0','false','off','no','n'].includes(v)) return false;
    return null;
  } catch { return null; }
}
const CB01_DEBUG = (() => { const f = envFlag('CB01_DEBUG'); return f===null? true : f; })();
const log = (...a: unknown[]) => { if(CB01_DEBUG) { try { console.log('[CB01]', ...a); } catch {} } };
const warn = (...a: unknown[]) => { try { console.warn('[CB01]', ...a); } catch {} };

interface Cb01Config { enabled:boolean; mfpUrl?:string; mfpPassword?:string; tmdbApiKey?: string }

export class Cb01Provider {
  private baseFilm = 'https://cb01net.lol'; // initial fallback
  private baseSerie = 'https://cb01net.lol/serietv'; // initial fallback
  private lastDomainCheck = 0;
  private domainTTL = 12*60*60*1000; // 12h cache (domain redirect check)
  private userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  private cache = new Map<string,{ ts:number; streams:StreamForStremio[] }>();
  private TTL = 6*60*60*1000;
  constructor(private config: Cb01Config){ }

  async handleImdbRequest(imdbId:string, season:number|null, episode:number|null, isMovie:boolean){
    if(!this.config.enabled) return { streams: [] };
    if(!this.config.mfpUrl || !this.config.mfpPassword) return { streams: [] };
    const key = `${imdbId}|${isMovie?'movie':'series'}|${season||''}|${episode||''}`;
    const c = this.cache.get(key); if(c && Date.now()-c.ts < this.TTL) return { streams:c.streams };
    try {
      if (isMovie) {
        log('movieFlow start', { imdbId });
        const s = await this.movieFlow(imdbId);
        log('movieFlow done', { imdbId, count: s.length });
        this.cache.set(key,{ ts:Date.now(), streams:s });
        return { streams: s };
      // Series temporarily disabled per user request
      } else if(season!=null && episode!=null){
        log('seriesFlow skipped (disabled)', { imdbId, season, episode });
        return { streams: [] };
      }
    } catch (e){ warn('handleImdbRequest error', String((e as Error).message||e)); }
    return { streams: [] };
  }
  async handleTmdbRequest(tmdbId:string, season:number|null, episode:number|null, isMovie:boolean){ return { streams: [] }; }

  private norm(q:string){
    return q.replace(/[òò]/g,'o').replace(/[èé]/g,'e').replace(/[àá]/g,'a').replace(/[ùú]/g,'u').replace(/[ìí]/g,'i').replace(/[^a-zA-Z0-9 ]+/g,' ').trim().replace(/\s+/g,'+');
  }
  private async fetch(url:string, referer?:string){
    const res = await fetch(url,{ headers:{ 'User-Agent': this.userAgent, 'Referer': referer||this.baseFilm, 'Accept':'text/html' } });
    if(!res.ok) throw new Error('http '+res.status); return await res.text();
  }
  private async ensureDomain(){
    const now = Date.now();
    if(now - this.lastDomainCheck < this.domainTTL) return;
    this.lastDomainCheck = now;
    try {
      // Hit canonical redirect domain; just perform HEAD/GET to capture final URL
      const resp = await fetch('https://cb01official.uno/', { redirect: 'follow', headers:{ 'User-Agent': this.userAgent, 'Accept':'text/html' } });
      const finalUrl = resp.url || '';
      const m = finalUrl.match(/^(https?:\/\/[^/]+)\//);
      if(m){
        const root = m[1];
        if(root && root !== this.baseFilm){
          log('domain update', { from: this.baseFilm, to: root });
          this.baseFilm = root;
          this.baseSerie = root + '/serietv';
        }
      }
    } catch(e){ warn('ensureDomain error', String(e)); }
  }
  // Risoluzione ibrida titolo/anno: tenta TMDb (/find) poi fallback scraping IMDb (<title>) simil eurostreaming.
  private async resolveTitleYear(imdbId:string, isMovie:boolean){
    const imdbOnly = imdbId.split(':')[0];
    const apiKey = this.config.tmdbApiKey || (typeof process!=='undefined' && process.env && process.env.TMDB_API_KEY);
    const result = { title: imdbOnly, year: null as string|null, source: 'imdb-id' } as { title:string; year:string|null; source:string };
    // 1) TMDb find endpoint
    if(apiKey){
      try {
        const findUrl = `https://api.themoviedb.org/3/find/${imdbOnly}?api_key=${apiKey}&language=it&external_source=imdb_id`;
        const r = await fetch(findUrl);
        if(r.ok){
          const js = await r.json();
          const arr = isMovie? (js.movie_results||[]) : (js.tv_results||[]);
            const altArr = isMovie? (js.tv_results||[]) : (js.movie_results||[]);
          let node = arr[0] || altArr[0];
          if(node){
            const dateRaw = (node.release_date || node.first_air_date || '').toString();
            const year = dateRaw.slice(0,4) || null;
            const title = (node.title || node.name || node.original_title || node.original_name || imdbOnly).toString().trim();
            result.title = title; result.year = year; result.source = 'tmdb';
            log('meta tmdb', { imdb: imdbOnly, title, year, isMovie });
            return result;
          }
        }
      } catch(e){ warn('meta tmdb error', String(e)); }
    }
    // 2) Scrape IMDb come fallback
    try {
      const url = `https://www.imdb.com/title/${imdbOnly}/`;
      const r = await fetch(url, { headers:{ 'User-Agent': this.userAgent, 'Accept':'text/html' } });
      if(r.ok){
        const html = await r.text();
        const titleTag = html.match(/<title>([^<]+)<\/title>/i);
        if(titleTag){
          let raw = titleTag[1].replace(/- IMDb.*$/i,'').trim();
          const ym = raw.match(/\((\d{4})\)/);
          let year:string|null = null;
          if(ym){ year = ym[1]; raw = raw.replace(/\(\d{4}\)/,'').trim(); }
          result.title = raw || result.title; result.year = year; result.source = 'imdb-scrape';
          log('meta imdb scrape', { imdb: imdbOnly, title: result.title, year });
        }
      }
    } catch(e){ warn('meta imdb scrape error', String(e)); }
    return result;
  }

  private pickYearMatch(html:string, expectedYear:string|null):string|null{ // returns href
    const divRe = /<div[^>]+class="card-content"[\s\S]*?<h3[^>]*class="card-title"[\s\S]*?<a[^>]+href="([^"]+)"/gi;
    let m:RegExpExecArray|null; const yearRe = /(19|20)\d{2}/; let first:string|null=null;
    while((m=divRe.exec(html))){
      const href = m[1]; if(!first) first = href;
      const slug = href.split('/').filter(Boolean).pop()||'';
      const ym = slug.match(yearRe); if(ym && expectedYear && ym[0]===expectedYear) return href;
    }
    return first;
  }

  private async movieFlow(imdbId:string):Promise<StreamForStremio[]>{
  await this.ensureDomain();
  const meta = await this.resolveTitleYear(imdbId, true); const title = meta.title; const year = meta.year; log('meta chosen', { imdbId, source: meta.source, title, year });
    const q = this.norm(title);
    const searchUrl = `${this.baseFilm}/?s=${encodeURIComponent(q)}`;
  let searchHtml:string; try { searchHtml = await this.fetch(searchUrl); } catch (e){ warn('movie search fetch fail', searchUrl, String(e)); return []; }
    const movieHref = this.pickYearMatch(searchHtml, year);
  if(!movieHref){ log('movie no match', { imdbId, title }); return []; }
  let pageHtml:string; try { pageHtml = await this.fetch(movieHref, this.baseFilm+'/'); } catch (e){ warn('movie page fetch fail', movieHref, String(e)); return []; }
    // Preferisce blocco Streaming HD
    // Pattern semplificato: trova iframen2 (mixdrop) o iframen1 fallback
    const iframe2 = pageHtml.match(/<div[^>]+id="iframen2"[^>]*data-src="([^"]+)"/i);
    const iframe1 = pageHtml.match(/<div[^>]+id="iframen1"[^>]*data-src="([^"]+)"/i);
    let candidate = iframe2? iframe2[1]: (iframe1? iframe1[1]: null);
  if(!candidate){ log('movie no iframe found', { imdbId, movieHref }); return []; }
    // Se è un link stayonline, preleva meta (filename + size) dalla pagina /l/<id>/
    let stayMeta: { file:string|null; size:string|null } | null = null;
    if(/stayonline\./i.test(candidate)) {
      stayMeta = await this.fetchStayMeta(candidate);
    }
    const mixdrop = await this.resolveToMixdrop(candidate, pageHtml);
  if(!mixdrop){ log('movie resolveToMixdrop failed', { imdbId, candidate }); return []; }
    const stream = await this.wrapMediaFlow(mixdrop, pageHtml, undefined, stayMeta || undefined);
    return stream? [stream]: [];
  }

  // private async seriesFlow(imdbId:string, season:number, episode:number):Promise<StreamForStremio[]>{
  //   // DISABLED: series handling temporarily removed
  //   return [];
  // }
  /*
  // --- Archived seriesFlow (disabled) ---
  // private async seriesFlow(imdbId:string, season:number, episode:number):Promise<StreamForStremio[]>{
  //   const meta = await this.resolveTitleYear(imdbId, false); const title = meta.title; const year = meta.year; log('meta chosen', { imdbId, source: meta.source, title, year });
  //   const q = this.norm(title);
  //   const searchUrl = `${this.baseSerie}/?s=${encodeURIComponent(q)}`;
  //   let searchHtml:string; try { searchHtml = await this.fetch(searchUrl, this.baseSerie+'/'); } catch (e){ warn('series search fetch fail', searchUrl, String(e)); return []; }
  //   log('series search html', { url: searchUrl, len: searchHtml.length, snippet: searchHtml.slice(0,220) });
  //   const serieHref = this.pickYearMatch(searchHtml, year);
  //   if(!serieHref){ log('series no match', { imdbId, title, year }); return []; }
  //   log('series picked', { imdbId, serieHref });
  //   let pageHtml:string; try { pageHtml = await this.fetch(serieHref, this.baseSerie+'/'); } catch (e){ warn('series page fetch fail', serieHref, String(e)); return []; }
  //   log('series page html', { href: serieHref, len: pageHtml.length, snippet: pageHtml.slice(0,220) });
  //   const blocks: { seasonNum:number|null; headRaw:string; bodyHtml:string }[] = [];
  //   const headRe = /<div[^>]*class=\"sp-head[^\"]*\"[^>]*>([\s\S]*?)<\/div>\s*<div[^>]*class=\"sp-body\"[^>]*>([\s\S]*?)(?=<div[^>]*class=\"sp-head|$)/gi;
  //   let hm:RegExpExecArray|null;
  //   while((hm = headRe.exec(pageHtml))){
  //     const headHtml = hm[1];
  //     const bodyHtml = hm[2];
  //     const text = headHtml.replace(/<[^>]+>/g,' ').replace(/&nbsp;/g,' ').trim();
  //     const mSeason = text.match(/STAGIONE\s+(\d+)/i);
  //     const seasonNum = mSeason? parseInt(mSeason[1],10): null;
  //     blocks.push({ seasonNum, headRaw: text, bodyHtml });
  //   }
  //   log('series seasons parsed', { total: blocks.length, seasons: blocks.map(b=>b.seasonNum) });
  //   const chosen = blocks.find(b=> b.seasonNum === season);
  //   if(!chosen){ log('series season block not found', { imdbId, season, parsed: blocks.map(b=>b.headRaw) }); return []; }
  //   const segment = `<div class=\"sp-body\">${chosen.bodyHtml}`;
  //   log('series season segment', { len: segment.length, snippet: segment.slice(0,260) });
  //   const epPad = (n:number)=> n<10? '0'+n: ''+n;
  //   const ePad = epPad(episode);
  //   const pat = `(?:S0?${season}E${ePad}|${season}x${ePad}|${season}[×x]${ePad})`;
  //   const epBlockRe = new RegExp(pat+`[\\s\\S]{0,260}?href=\"(https?:[^"]+)\"[\\s\\S]{0,80}?Mixdrop`, 'i');
  //   const epLinkMatch = segment.match(epBlockRe);
  //   log('series episode pattern', { pattern: epBlockRe.toString(), matched: !!epLinkMatch });
  //   let candidate = epLinkMatch? epLinkMatch[1]: null;
  //   if(!candidate){
  //     const lineRe = new RegExp(pat+`[\\s\\S]{0,300}?<p>[\\s\\S]*?</p>`, 'i');
  //     const line = segment.match(lineRe);
  //     if(line){
  //       const mix = line[0].match(/href=\"(https?:[^\"]+mixdrop[^\"]*)\"/i);
  //       if(mix) candidate = mix[1];
  //       log('series episode fallback line', { foundLine: !!line, hasMix: !!mix });
  //     }
  //   }
  //   if(!candidate){ log('series episode link not found', { imdbId, season, episode }); return []; }
  //   log('series episode candidate', { candidate });
  //   const mixdrop = await this.resolveToMixdrop(candidate, pageHtml);
  //   if(!mixdrop){ log('series resolveToMixdrop failed', { imdbId, candidate }); return []; }
  //   const stream = await this.wrapMediaFlow(mixdrop, pageHtml, { season, episode });
  //   return stream? [stream]: [];
  // }
  */

  private async resolveToMixdrop(raw:string, pageHtml:string):Promise<string|null>{
    let link = raw.trim();
    // stayonline bypass
    if(/stayonline\./i.test(link)){
      try {
  log('stayonline initial link', { link });
  // Replica python: id = link.split('/')[-2]
  const rawParts = link.split('/');
  const id = rawParts.length >= 2 ? rawParts[rawParts.length - 2] : '';
  if(!id){ log('stayonline id not extracted', { link }); return null; }
  const body = new URLSearchParams({ id, ref: '' });
        const res = await fetch('https://stayonline.pro/ajax/linkEmbedView.php', { method:'POST', headers:{ 'User-Agent': this.userAgent, 'X-Requested-With':'XMLHttpRequest', 'Accept':'application/json','Origin':'https://stayonline.pro','Referer':'https://stayonline.pro/' }, body });
        log('stayonline ajax request sent', { id, status: res.status });
        if(res.ok){
          const js = await res.json();
          const v = js?.data?.value;
          if (typeof v === 'string') {
            log('stayonline ajax value', { length: v.length, snippet: v.slice(0,260) });
            const direct = v.trim();
            if(/mixdrop/i.test(direct)) { link = direct; log('stayonline ajax direct mixdrop', { link }); }
            else {
              const mm = direct.match(/https?:\/\/[^"'<>]*mixdrop[^"'<>]*/i);
              if(mm){ link = mm[0]; log('stayonline ajax html mixdrop', { link }); }
            }
          }
        } else {
          warn('stayonline ajax fail', { status: res.status });
        }
        if(!/mixdrop/i.test(link)){
          // Fallback: GET la pagina /e/ID
          try {
            const embedUrl = /\/e\//i.test(link) || /\/v\//i.test(link) ? link : `https://stayonline.pro/e/${id}/`;
            const pg = await fetch(embedUrl, { headers:{ 'User-Agent': this.userAgent, 'Referer':'https://stayonline.pro/' } });
            if(pg.ok){
              const txt = await pg.text();
              log('stayonline embed page', { embedUrl, len: txt.length, snippet: txt.slice(0,400) });
              const mm = txt.match(/https?:\/\/[^"'<>]*mixdrop[^"'<>]*/i);
              if(mm){ link = mm[0]; log('stayonline page fallback mixdrop', { link }); }
            }
          } catch {}
        }
      } catch (e){ warn('stayonline bypass error', String(e)); return null; }
    }
    // Deve essere un embed Mixdrop (contiene /e/)
  if(!/mixdrop/i.test(link)) return null;
    return link;
  }

  private extractStayonlineMeta(html:string){
    // Cerca il blocco esempio fornito con colFilename
    const col = html.match(/<div class=\"col-8[^>]+id=\"colFilename\"[\s\S]*?<\/div>/i);
    if(!col) return null;
    const nameMatch = col[0].match(/>([^<]+\.mp4)\s*<span/i);
    const sizeMatch = col[0].match(/<span[^>]*>([0-9.]+\s*(?:GB|MB|KB))<\/span>/i);
    return { file: nameMatch? nameMatch[1].trim(): null, size: sizeMatch? sizeMatch[1]: null };
  }

  private canonicalizeMixdrop(url:string):string {
    // Mantiene il dominio originale (club, ps, ecc.) e riduce a /e/<id>/
    // Esempio input: https://mixdrop.club/e/7k06e9ldtdpejq6/2/Il_nome_file.mp4
    // Output:       https://mixdrop.club/e/7k06e9ldtdpejq6/
    const m = url.match(/^(https?:\/\/[^/]+\/e\/([A-Za-z0-9]+))/);
    if(m) return m[1] + '/';
    return url.endsWith('/')? url: url + '/';
  }

  private async wrapMediaFlow(mixdropEmbed:string, pageHtml:string, ep?:{season:number;episode:number}, metaOverride?: {file:string|null; size:string|null}):Promise<StreamForStremio|null>{
  const { mfpUrl, mfpPassword } = this.config; if(!mfpUrl || !mfpPassword) return null;
  // Normalizza base URL mediaflow evitando doppio slash
  const mfpBase = mfpUrl.replace(/\/+$/, '');
    const originalEmbed = mixdropEmbed.trim();
    // Costruisci forma corta: https://dominio/e/<id>/ mantenendo dominio originale, eliminando qualunque segmento extra (/2/filename.mp4)
    let dUrl = originalEmbed;
    const idMatch = originalEmbed.match(/^(https?:\/\/[^/]+)\/e\/([A-Za-z0-9]+)/);
    if(idMatch){
      dUrl = `${idMatch[1]}/e/${idMatch[2]}/`;
      if(dUrl !== originalEmbed) log('mixdrop canonical chosen', { original: originalEmbed, canonical: dUrl });
    } else {
      log('mixdrop embed no id pattern, using original', { original: originalEmbed });
    }
    const encodedD = encodeURIComponent(dUrl);
  const extractor = `${mfpBase}/extractor/video?host=Mixdrop&api_password=${encodeURIComponent(mfpPassword)}&d=${encodedD}&redirect_stream=false`;
    log('extractor single call', { dUrl, encodedD, extractor });
    let data:any = null;
    try {
      const r = await fetch(extractor);
      log('extractor response', { status: r.status });
      if(r.ok){
        try { data = await r.json(); } catch(eJson){ warn('extractor json parse error', String(eJson)); }
        if(data){
          log('extractor ok', { used: dUrl, hasDestination: !!data.destination_url, hasProxy: !!data.mediaflow_proxy_url });
        }
      } else {
        let bodySnippet=''; try { const txt= await r.text(); bodySnippet = txt.slice(0,160); } catch {}
        warn('extractor fail', { status:r.status, url: dUrl, body: bodySnippet });
      }
    } catch(e){ warn('extractor error', String(e)); }
    if(!data){ return null; }
    // Ricostruisci URL finale
    const dest = data.destination_url || data.mediaflow_proxy_url; if(!dest){ warn('extractor missing dest'); return null; }
    const headers = data.request_headers || {};
    const ua = headers['user-agent'] || headers['User-Agent'] || this.userAgent;
    const ref = headers['referer'] || headers['Referer'] || 'https://mixdrop.ps/';
  const finalBase = `${mfpBase}/proxy/stream?api_password=${encodeURIComponent(mfpPassword)}&d=${encodeURIComponent(dest)}&h_user-agent=${encodeURIComponent(ua)}&h_referer=${encodeURIComponent(ref)}`;
  const meta = metaOverride || this.extractStayonlineMeta(pageHtml) || { file:null, size: undefined };
  // Nuovo formato richiesto:
  // Linea 1: Nome completo file (con estensione) + [ITA]
  // Linea 2: "💾 <SIZE> Mixdrop [ITA]" (se size disponibile) altrimenti "💾 Mixdrop [ITA]"
  // Legacy placeholder 'StreamViX CB' removed: unified naming layer will append provider label.
  let line1 = meta.file ? meta.file.trim() : 'File';
  // (Serie disabilitate, quindi ep ignorato; se riabilitate e si vuole aggiungere S/E si può reinserire qui)
  if(!/\[ITA\]/i.test(line1)) line1 += ' [ITA]';
  const line2 = meta.size ? `💾 ${meta.size} • Mixdrop • [ITA]` : '💾 Mixdrop • [ITA]';
  const title = `${line1}\n${line2}`;
  log('stream ready', { title, mixdrop: dUrl.substring(0,120), final: finalBase.substring(0,120) });
  return { title, url: finalBase, behaviorHints:{ notWebReady:true } } as StreamForStremio;
  }

  // Recupera filename e size dalla pagina stayonline /l/<id>/
  private async fetchStayMeta(originalLink:string): Promise<{ file:string|null; size:string|null } | null> {
    try {
      const parts = originalLink.split('/').filter(Boolean);
      const id = parts.length >= 2 ? parts[parts.length - 1] || parts[parts.length - 2] : '';
      // Se path termina con e/<id>/ allora id è penultimo
      const m = originalLink.match(/\/e\/(\w+)/i);
      const finalId = m ? m[1] : id;
      if(!finalId) { log('stayMeta no id', { originalLink }); return null; }
      const metaUrl = `https://stayonline.pro/l/${finalId}/`;
      log('stayMeta fetch', { metaUrl });
      const r = await fetch(metaUrl, { headers:{ 'User-Agent': this.userAgent, 'Referer':'https://stayonline.pro/' } });
      if(!r.ok){ warn('stayMeta http fail', { status: r.status }); return null; }
      const html = await r.text();
      // cerca bottone
      const btn = html.match(/<button[^>]*btnClickToContinueLink[^>]*>([\s\S]*?)<\/button>/i);
      if(!btn){ log('stayMeta no button'); return null; }
      const inner = btn[1];
      const nameMatch = inner.match(/([^<]+\.mp4)\s*<span/i);
      const sizeMatch = inner.match(/<span[^>]*>([0-9.,]+\s*(?:GB|MB|KB))<\/span>/i);
      const file = nameMatch ? nameMatch[1].trim() : null;
      const size = sizeMatch ? sizeMatch[1].replace(',', '.') : null;
      log('stayMeta parsed', { file, size });
      return { file, size };
    } catch(e){ warn('stayMeta error', String(e)); return null; }
  }
}
