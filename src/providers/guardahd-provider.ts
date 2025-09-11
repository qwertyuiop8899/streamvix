// SEMPLIFICAZIONE: Provider ora usa SOLO mostraguarda.stream e replica la logica webstreamr MostraGuarda (data-link extraction + embed resolving)
// Mantiene label / naming invariati.

/*
 * This provider adapts the behavior of the "MostraGuarda" source logic from the MIT licensed
 * webstreamr project (https://github.com/webstreamr/webstreamr) especially:
 *  - Extraction of data-link attributes from /movie/<imdbId>
 *  - Normalization of protocol and filtering self links
 *  - Delegation of embed resolution to per-host extractors
 * Only reduced to a single domain (mostraguarda.stream) and integrated with the local
 * flaresolverr helper (flaresolverr.ts) using SOLVER_URL. Thanks to webstreamr authors. MIT license retained.
 */
import type { StreamForStremio } from '../types/animeunity';
import { extractFromUrl } from '../extractors';
// Minimal import senza types (evita aggiunta @types/cheerio)
// eslint-disable-next-line @typescript-eslint/no-var-requires
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function require(name: string): any;
const cheerio = require('cheerio');
import { fetchPage, fetchPageWithProxies, readStreamCache, writeStreamCache, purgeOld } from './flaresolverr';
import { getTmdbIdFromImdbId } from '../extractor';

export interface GuardaHdConfig { enabled:boolean; mfpUrl?:string; mfpPassword?:string; tmdbApiKey?: string }

interface CacheEntry { timestamp:number; streams: StreamForStremio[] }

export class GuardaHdProvider {
  private readonly base = 'https://mostraguarda.stream';
  private readonly CACHE_TTL = 12 * 60 * 60 * 1000; // 12h come Source.ttl webstreamr

  constructor(private config: GuardaHdConfig){ }

  async handleImdbRequest(imdbId: string, _season: number | null, _episode: number | null, isMovie = false) {
    if (!this.config.enabled) return { streams: [] };
    if (!isMovie) return { streams: [] }; // MostraGuarda in webstreamr gestisce solo movie
    const imdbOnly = imdbId.split(':')[0];
    console.log('[GH][FLOW] handleImdbRequest imdb=', imdbOnly);
    // CACHE lookup
    const cache = readStreamCache();
    purgeOld(cache, this.CACHE_TTL);
    const ce: CacheEntry | undefined = cache[imdbOnly];
    if (ce && Date.now() - ce.timestamp < this.CACHE_TTL) {
      let useCache = true;
      if (this.config.tmdbApiKey) {
        const isPlaceholder = (t?: string) => {
          if (!t) return true;
          const first = t.split('\n')[0].trim();
            return first === imdbOnly || /^movie\s+tt\d+/i.test(first);
        };
        if (ce.streams.length && ce.streams.every(s => isPlaceholder((s as any).title || (s as any).name))) {
          useCache = false; // forza refresh per ottenere titolo ITA
          console.log('[GH][CACHE] forcing refresh due to placeholder titles');
        }
      }
  if (useCache) return { streams: ce.streams };
    }
    // Fetch page
    let html: string;
    try {
      html = await fetchPage(`${this.base}/movie/${encodeURIComponent(imdbOnly)}`);
      console.log('[GH][NET] fetched movie page len=', html.length);
    } catch (e:any) {
      const msg = (e?.message||'').toString();
      console.log('[GH][ERR] fetch movie page failed', msg);
      if (/^(cloudflare_challenge|http_403|blocked)/.test(msg)) {
        try {
          console.log('[GH][PROXY] proxy attempts (max 2)');
          html = await fetchPageWithProxies(`${this.base}/movie/${encodeURIComponent(imdbOnly)}`);
          console.log('[GH][PROXY][OK] len=', html.length);
        } catch (e2:any) {
          console.log('[GH][PROXY][FAIL]', e2?.message || e2);
          return { streams: [] };
        }
      } else {
        return { streams: [] };
      }
    }
    // Estrai titolo reale del film dalla pagina; se è generico o coincide con IMDb, tenta TMDB (IT)
    let realTitle = imdbOnly;
    try {
      const $t = cheerio.load(html);
      const cand = ($t('h1').first().text().trim() || $t('title').first().text().trim() || '').replace(/Streaming.*$/i,'').trim();
      if (cand) realTitle = cand;
      console.log('[GH][TITLE] extracted page title=', realTitle);
    } catch { /* ignore */ }
    // Se titolo è ancora un placeholder (solo imdb id o pattern tipo "Movie tt1234567") prova TMDB italiano
    if (this.config.tmdbApiKey && (/^tt\d{7,8}$/i.test(realTitle) || /^movie\s+tt\d+/i.test(realTitle) || realTitle.toLowerCase() === 'movie')) {
      try {
        console.log('[GH][TMDB] trying italian title lookup for', imdbOnly);
        const tmdbId = await getTmdbIdFromImdbId(imdbOnly, this.config.tmdbApiKey);
        console.log('[GH][TMDB] tmdbId=', tmdbId);
        if (tmdbId) {
          const resp = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${this.config.tmdbApiKey}&language=it`);
          if (resp.ok) {
            const data = await resp.json();
            if (data && (data.title || data.original_title)) {
              realTitle = (data.title || data.original_title).trim();
              console.log('[GH][TMDB] resolved italian title=', realTitle);
            }
          } else {
            console.log('[GH][TMDB] movie details resp status', resp.status);
          }
        }
      } catch { /* ignore tmdb fallback */ }
    }
    const streams = await this.extractStreamsFromMoviePage(html, realTitle || imdbOnly);
    console.log('[GH][STREAMS] extracted embed streams count=', streams.length);
    // Forza iniettare titolo italiano nella prima linea (se extractor ha generato placeholder)
    const finalStreams = streams.map(s => {
      try {
        const lines = (s.title || '').split('\n');
        if (!lines[0] || lines[0] === imdbOnly || /^movie\s+tt\d+/i.test(lines[0])) {
          lines[0] = realTitle || imdbOnly;
        }
        return { ...s, title: this.normalizeTitle(lines.filter(Boolean).join('\n')) } as StreamForStremio;
      } catch { return s; }
    });
    console.log('[GH][STREAMS] final streams count=', finalStreams.length);
    cache[imdbOnly] = { timestamp: Date.now(), streams: finalStreams };
    writeStreamCache(cache);
    return { streams: finalStreams };
  }

  async handleTmdbRequest(tmdbId: string, _season: number | null, _episode: number | null, isMovie = false): Promise<{ streams: StreamForStremio[] }> { 
    // Per MostraGuarda ignoriamo TMDB (solo IMDb). Manteniamo firma per compatibilità.
    return { streams: [] }; 
  }

  private async extractStreamsFromMoviePage(html: string, titleHint: string): Promise<StreamForStremio[]> {
    const $ = cheerio.load(html);
    // Identico concetto: selezionare tutti gli elementi con data-link non vuoto
  const urls = $('[data-link!=""]').map((_: number, el: any)=>{
      const raw = ($(el).attr('data-link')||'').trim();
      if(!raw) return null;
      let u = raw.replace(/^(https:)?\/\//,'https://');
      if(!/^https?:/i.test(u)) return null;
      return u;
    }).toArray().filter(Boolean) as string[];
    // Rimuove eventuali self host (non dovrebbero comparire come embed esterno)
    const external = urls.filter(u=> !/mostraguarda/gi.test(new URL(u).host));
    // Dedup
    const dedup = Array.from(new Set(external)).slice(0,40);
    const out: StreamForStremio[] = [];
    const seen = new Set<string>();
    for (const eurl of dedup) {
      try {
    console.log('[GH][EMBED] resolving', eurl);
  console.log('[GH][EMBED][CTX] mfpUrl?', !!this.config.mfpUrl, 'mfpPassword?', !!this.config.mfpPassword);
        const { streams } = await extractFromUrl(eurl, { mfpUrl: this.config.mfpUrl, mfpPassword: this.config.mfpPassword, countryCode: 'IT', titleHint });
        console.log('[GH][EMBED] got', streams.length, 'streams from', eurl);
  // Streamtape fallback rimosso: la logica specifica del player deve stare nell'extractor dedicato
        for (const s of streams) {
          if (seen.has(s.url)) continue; seen.add(s.url);
          out.push(s);
        }
      } catch { /* ignore single embed */ }
    }
  console.log('[GH][EMBED] total after dedup', out.length);
    return out;
  }

  // Normalizza capitalizzazione host nella seconda linea (se presente)
  private normalizeTitle(raw: string): string {
    if (!raw) return raw;
    const parts = raw.split('\n');
    if (parts.length > 1) {
      let second = parts[1];
      // Se la seconda linea contiene solo host senza floppy per streamtape deve rimanere senza symbol
      const hasFloppy = /^💾\s*/.test(second);
      if (hasFloppy) {
        // Rimuovi floppy se la linea riguarda streamtape e NON ci sono size/res
        const after = second.replace(/^💾\s*/, '');
        if (/\bstreamtape\b/i.test(after) && !/(\d+p|MB|GB|KB)/i.test(after)) {
          second = after; // senza icona
        }
      }
      second = second
        .replace(/\bsupervideo\b/gi, 'SuperVideo')
        .replace(/\bmixdrop\b/gi, 'Mixdrop')
        .replace(/\bdoodstream\b/gi, 'Doodstream')
        .replace(/\bstreamtape\b/gi, 'Streamtape');
      parts[1] = second;
    }
    return parts.join('\n');
  }
}

