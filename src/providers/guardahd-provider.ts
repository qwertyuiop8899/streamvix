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
import { fetchPage, readStreamCache, writeStreamCache, purgeOld } from './flaresolverr';

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
    // CACHE lookup
    const cache = readStreamCache();
    purgeOld(cache, this.CACHE_TTL);
    const ce: CacheEntry | undefined = cache[imdbOnly];
    if (ce && Date.now() - ce.timestamp < this.CACHE_TTL) {
      return { streams: ce.streams };
    }
    // Fetch page
    let html: string;
    try {
      html = await fetchPage(`${this.base}/movie/${encodeURIComponent(imdbOnly)}`);
    } catch {
      return { streams: [] };
    }
    const streams = await this.extractStreamsFromMoviePage(html, imdbOnly);
    cache[imdbOnly] = { timestamp: Date.now(), streams };
    writeStreamCache(cache);
    return { streams };
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
        const { streams } = await extractFromUrl(eurl, { mfpUrl: this.config.mfpUrl, mfpPassword: this.config.mfpPassword, countryCode: 'IT', titleHint });
        for (const s of streams) {
          if (seen.has(s.url)) continue; seen.add(s.url);
          // Mantiene titolo così come fornito dall'extractor (come webstreamr non rietichetta qui la Source) – opzionale potremmo aggiungere country marker
          out.push(s);
        }
      } catch { /* ignore single embed */ }
    }
    return out;
  }
}

