//# thanks to @urlomythus for the code
//#Adapted for use in Streamvix from:
//# Mammamia  in https://github.com/UrloMythus/MammaMia
//# 
/** GuardaSerie Provider (raw HLS, no proxy) - single clean implementation */
import type { StreamForStremio } from '../types/animeunity';
import { getFullUrl, getDomain } from '../utils/domains';
import { extractFromUrl } from '../extractors';

// Removed showSizeInfo (always include size/res with ruler icon when available)
export interface GuardaSerieConfig { enabled: boolean; tmdbApiKey?: string; baseUrl?: string; mfpUrl?: string; mfpPassword?: string; }
interface GSSearchResult { id: string; slug: string; title: string };
interface GSEpisode { season: number; number: number; url: string; embeds?: string[] };

export class GuardaSerieProvider {
  private base: string;
  private hlsInfoCache = new Map<string, { res?: string; size?: string }>();
  private lastSeriesYear: string | null = null; // anno serie estratto da TMDB per filtrare i risultati (non appeso al titolo)
  // Mappa fast-path: titolo TMDB esatto -> slug (senza base URL, con o senza prefisso serietv/)
  // Facile da aggiornare: aggiungere coppie nuove secondo necessità.
  private exactTitleMap: Record<string,string> = {
    'MONSTERS: La storia di Lyle ed Erik Menendez': 'serietv/3278-monsters-la-storia-di-lyle-ed-erik-menendez-streaming-ita.html'
  };

  constructor(private config: GuardaSerieConfig) {
  const dom = getFullUrl('guardaserie');
  this.base = (config.baseUrl || dom || `https://www.${getDomain('guardaserie') || 'guardaserie.example'}`).replace(/\/$/, '');
  }

  async handleImdbRequest(imdbId: string, season: number | null, episode: number | null, isMovie = false) {
    if (!this.config.enabled) return { streams: [] };
    try {
      if (isMovie) { // richiesto: non cercare film su Guardaserie
        console.log('[GS][handleImdbRequest] isMovie true -> skip');
        return { streams: [] };
      }
      console.log('[GS][handleImdbRequest] start', { imdbId, season, episode, isMovie });
      const imdbOnly = imdbId.split(':')[0];
      // Resolve title first so direct flow can validate results
      let resolvedTitle: string | null = null;
      try {
        resolvedTitle = await this.resolveTitle('imdb', imdbOnly, false);
      } catch (e) {
        console.log('[GS][handleImdbRequest] resolveTitle error (non‑fatal)', (e as any)?.message || e);
      }
      if (resolvedTitle) {
        const direct = await this.tryDirectImdbFlow(imdbOnly, season || 1, episode || 1, resolvedTitle);
        console.log('[GS][handleImdbRequest] direct result count', direct.length);
        if (direct.length) return { streams: direct };
      }
      const finalTitle = resolvedTitle || (await this.resolveTitle('imdb', imdbOnly, false));
      console.log('[GS][handleImdbRequest] resolved title', finalTitle);
      return this.core(finalTitle, season, episode, isMovie);
    } catch {
      console.log('[GS][handleImdbRequest] error fallback empty');
      return { streams: [] };
    }
  }

  async handleTmdbRequest(tmdbId: string, season: number | null, episode: number | null, isMovie = false) {
    if (!this.config.enabled) return { streams: [] };
    try {
  if (isMovie) { // richiesto: non cercare film su Guardaserie
    console.log('[GS][handleTmdbRequest] isMovie true -> skip');
    return { streams: [] };
  }
  // Parsing formato composito: supporta
  // 1) "123456:1:3" -> id base 123456, season=1, episode=3
  // 2) "tmdb:123456:1:3" -> id base 123456, season=1, episode=3
  // Se season/episode già passati (non null) NON vengono sovrascritti (priorità ai parametri espliciti).
  let rawId = tmdbId;
  let sSeason = season;
  let sEpisode = episode;
  // Rimuovi eventuale prefisso tmdb:
  if (/^tmdb:/i.test(rawId)) rawId = rawId.replace(/^tmdb:/i, '');
  // Match pattern numerico con stagione/episodio
  if (/^\d+:\d+:\d+$/.test(rawId)) {
    const parts = rawId.split(':');
    if (parts.length === 3) {
      const base = parts[0];
      const ps = parseInt(parts[1]);
      const pe = parseInt(parts[2]);
      if (!Number.isNaN(ps) && sSeason == null) sSeason = ps;
      if (!Number.isNaN(pe) && sEpisode == null) sEpisode = pe;
      rawId = base; // usa solo la parte ID per TMDB API
    }
  }
  console.log('[GS][handleTmdbRequest] start', { tmdbId, normalizedId: rawId, season: sSeason, episode: sEpisode, isMovie });
      const t = await this.resolveTitle('tmdb', rawId, isMovie);
  console.log('[GS][handleTmdbRequest] resolved title', t);
      return this.core(t, sSeason, sEpisode, isMovie);
    } catch {
  console.log('[GS][handleTmdbRequest] error fallback empty');
      return { streams: [] };
    }
  }

  private async core(title: string, season: number | null, episode: number | null, isMovie: boolean): Promise<{ streams: StreamForStremio[] }> {
  console.log('[GS][core] start', { title, season, episode, isMovie });
    if (isMovie) { // difensivo: anche qui evitare elaborazione film
      return { streams: [] };
    }
  // FAST-PATH exact match: se il titolo corrisponde esattamente a una chiave mappata salta la search.
  const mappedSlug = this.exactTitleMap[title];
  if (mappedSlug) {
    try {
      const normalizedSlug = mappedSlug.replace(/^\/*/, '');
      const slugWithSection = /^(serietv|serie|tv)\//i.test(normalizedSlug) ? normalizedSlug : `serietv/${normalizedSlug}`;
      const seriesUrl = `${this.base}/${slugWithSection.replace(/\/+$/,'')}/`;
      console.log('[GS][fastPath] exactMatch hit ->', title, '->', seriesUrl);
      // Recupera episodi direttamente
      const html = await this.get(seriesUrl);
      if (html) {
        // Costruiamo un oggetto fittizio GSSearchResult per riusare fetchEpisodes
        const pseudo: GSSearchResult = { id: slugWithSection, slug: slugWithSection, title };
        const eps = await this.fetchEpisodes(pseudo);
        console.log('[GS][fastPath] episodes found', eps.length);
        if (!eps.length) return { streams: [] };
        // Se stagione/episodio non specificati, seleziona come fa core
        const target = this.selectEpisode(eps, season, episode);
        if (!target) return { streams: [] };
        const effSeason = season ?? target.season;
        const effEpisode = episode ?? target.number;
        return { streams: await this.fetchEpisodeStreams(pseudo, target, effSeason, effEpisode) };
      } else {
        console.log('[GS][fastPath] page fetch failed, fallback to standard search');
      }
    } catch (e) {
      console.log('[GS][fastPath] error fallback to search', (e as any)?.message || e);
    }
  }
  let results = await this.search(title, this.lastSeriesYear);
  console.log('[GS][core] initial results', results.length);

    if (!results.length) {
      const np = title.replace(/[:\-_.]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  console.log('[GS][core] normalized attempt', np);
  if (np && np !== title) results = await this.search(np, this.lastSeriesYear);
  console.log('[GS][core] normalized results', results.length);
    }

    if (!results.length) {
      const w = title.split(/\s+/);
  if (w.length > 3) results = await this.search(w.slice(0, 3).join(' '), this.lastSeriesYear);
  console.log('[GS][core] first3 results', results.length);
    }

    if (!results.length) return { streams: [] };

    const picked = this.pickBest(results, title);
  console.log('[GS][core] picked', picked);
    if (!picked) return { streams: [] };

    if (isMovie) {
      return { streams: await this.fetchMovieStreams(picked) };
    }

    const eps = await this.fetchEpisodes(picked);
    console.log('[GS][core] episodes found', eps.length);
    if (!eps.length) return { streams: [] };
    // If a specific season was requested, verify it exists; otherwise return none (avoid mapping to another season)
    if (season != null) {
      const seasonExists = eps.some(e => e.season === season);
      if (!seasonExists) {
        console.log('[GS][core] requested season missing -> no streams', season);
        return { streams: [] };
      }
    }
    const target = this.selectEpisode(eps, season, episode);
    console.log('[GS][core] target episode', target);
    if (!target) return { streams: [] };
    const effSeason = season ?? target.season;
    const effEpisode = episode ?? target.number;
    return { streams: await this.fetchEpisodeStreams(picked, target, effSeason, effEpisode) };
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
    const raw = (j?.title || j?.name || j?.original_title || j?.original_name || 'Unknown');
    if (!isMovie) {
      const year = (j?.first_air_date || j?.release_date || '').slice(0,4);
      this.lastSeriesYear = /^(19|20)\d{2}$/.test(year) ? year : null;
    } else {
      this.lastSeriesYear = null;
    }
    return raw;
  }

  private async search(q: string, expectedYear?: string | null): Promise<GSSearchResult[]> {
    /* Python parity search logic:
       1. Build query variants (original, without year, sanitized, first 3 words)
       2. For each variant perform story search (?story=...&do=search&subaction=search)
       3. Parse first valid result block (class mlnew -> mlnh-2 h2 a)
       4. (Optional) If original query contained a year, prefer matches containing that year; else accept first.
       5. If all story variants fail, fallback once to legacy /?s= search as last resort.
       Return at most a small list (first few) but picking logic upstream now permissive.
    */
    try {
      console.log('[GS][search] start', q);
      const original = q.trim();
  // Se passato expectedYear (dal TMDB) usalo come anno preferito, altrimenti tenta di estrarre dall query.
  const yearMatch = original.match(/(19\d{2}|20\d{2})/);
  const year = (expectedYear && /^(19|20)\d{2}$/.test(expectedYear)) ? expectedYear : (yearMatch ? yearMatch[1] : null);
      const noYear = original.replace(/(19\d{2}|20\d{2})/g, '').replace(/\(\s*\)/g,'').trim();
      const simple = noYear.replace(/[^A-Za-z0-9]+/g,' ').trim();
      const first3 = simple.split(/\s+/).slice(0,3).join(' ');
      const variants = Array.from(new Set([original, noYear, simple, first3].filter(v => v && v.length > 1)));
      console.log('[GS][search] variants', variants);

      // We keep two buckets: preferred (contains year when year is requested) and others.
      for (const variant of variants) {
        const collectedPreferred: GSSearchResult[] = [];
        const collectedOthers: GSSearchResult[] = [];
        const storyUrl = `${this.base}/?story=${encodeURIComponent(variant)}&do=search&subaction=search`;
        console.log('[GS][search] story url', storyUrl);
        const storyHtml = await this.get(storyUrl);
        console.log('[GS][search] story html length', storyHtml ? storyHtml.length : 0);
        if (!storyHtml) continue;
        // Previous approach tried to isolate each <div class="mlnew"> block with a reluctant .*? ending at the first </div>, truncating nested content and missing the <h2><a> link.
        // New approach: directly scan the whole HTML for mlnew items (excluding the heading row) and capture the first <h2><a> inside.
        const itemRe = /<div[^>]+class="mlnew(?![^"']*heading)[^"]*"[\s\S]*?<h2>\s*<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
        // Cache for detail page years to avoid refetching same slug
        const detailYearCache = new Map<string,string|null>();
        let detailFetches = 0;
        let m: RegExpExecArray | null; let count = 0;
        while ((m = itemRe.exec(storyHtml)) && count < 40) {
          count++;
          const href = m[1];
          const rawTitle = m[2];
          const title = rawTitle.trim();
          const slug = href.split('/').filter(Boolean).pop() || href;
          // Extract year from the surrounding mlnew block (search limited forward slice) because the year is in a sibling div like <div class="mlnh-3 hdn">2022 - ...</div>
          let extractedYear: string | null = null;
          if (year) {
            const slice = storyHtml.slice(m.index, Math.min(storyHtml.length, m.index + 800));
            const yMatch = slice.match(/<div[^>]+class="[^"']*mlnh-3[^"']*hdn[^"']*"[^>]*>\s*(19\d{2}|20\d{2})/i);
            if (yMatch) extractedYear = yMatch[1];
          }
          let extractionPhase: 'block' | 'detail' | 'fallback-block-scan' | 'none' = extractedYear ? 'block' : 'none';
          // If not found yet and year expected, fetch detail page and look for the Anno list pattern
          if (year && !extractedYear && detailFetches < 6) {
            if (!detailYearCache.has(slug)) {
              const detailUrl = href.startsWith('http') ? href : `${this.base}${href.startsWith('/') ? '' : '/'}${href}`;
              const detailHtml = await this.get(detailUrl);
              let dy: string | null = null;
              if (detailHtml) {
                const dMatch = detailHtml.match(/<li>\s*<b>\s*Anno\s*:<\/b>\s*<\/li>\s*<li>\s*((19|20)\d{2})/i);
                if (dMatch) dy = dMatch[1];
                else {
                  // some pages repeat the Anno block differently; broader scan for first year inside a list preceded by Anno label
                  const alt = detailHtml.match(/Anno[^\n]{0,120}?((19|20)\d{2})/i);
                  if (alt) dy = alt[1];
                }
              }
              detailYearCache.set(slug, dy);
              detailFetches++;
            }
            const dyCached = detailYearCache.get(slug) || null;
            if (dyCached) { extractedYear = dyCached; extractionPhase = 'detail'; }
          }
          // Fallback: scan the local mlnew block slice for any year token if still missing
          if (year && !extractedYear) {
            const slice = storyHtml.slice(m.index, Math.min(storyHtml.length, m.index + 2000));
            const anyY = slice.match(/(19|20)\d{2}/);
            if (anyY) { extractedYear = anyY[0]; extractionPhase = 'fallback-block-scan'; }
          }
          let accept = true;
          if (year) {
            // Strict: accept only if extractedYear matches expected year exactly
            if (!extractedYear || extractedYear !== year) accept = false;
          }
          console.log('[GS][search] candidate', { variant, title, slug, expectedYear: year || null, extractedYear, phase: extractionPhase, accept });
          if (!accept) continue;
          if (year) collectedPreferred.push({ id: slug, slug, title }); else collectedPreferred.push({ id: slug, slug, title });
          if (!year && collectedPreferred.length >= 10) break;
          if (year && collectedPreferred.length >= 15) break;
        }
        if (collectedPreferred.length || collectedOthers.length) {
          const finalList = collectedPreferred.length ? collectedPreferred : collectedOthers;
          console.log('[GS][search] collected (story)', finalList.length, 'preferred', collectedPreferred.length, 'others', collectedOthers.length);
          return finalList.slice(0, 10);
        }
      }
      // Legacy fallback single pass /?s= only if story searches failed entirely
      const fallbackUrl = `${this.base}/?s=${encodeURIComponent(simple.replace(/\s+/g,'+'))}`;
  console.log('[GS][search] fallback url', fallbackUrl);
      const html = await this.get(fallbackUrl);
  console.log('[GS][search] fallback html length', html ? html.length : 0);
      if (!html) return [];
      const re = /<a[^>]+href=\"([^\"]+)\"[^>]*class=\"[^\">]*post-thumb[^>]*>\s*<img[^>]+alt=\"([^\"]+)\"/gi;
      let m: RegExpExecArray | null; let count = 0;
      const fbPreferred: GSSearchResult[] = [];
      const fbOthers: GSSearchResult[] = [];
      while ((m = re.exec(html)) && count < 25) {
        count++;
        const href = m[1];
        const title = m[2];
        const slug = href.split('/').filter(Boolean).pop() || href;
        let extractedYear: string | null = null;
        if (year) {
          const yearInTitle = title.match(/(19\d{2}|20\d{2})/);
          if (yearInTitle) extractedYear = yearInTitle[0];
        }
        let accept = true;
        if (year) {
          if (!extractedYear || extractedYear !== year) accept = false;
        }
        console.log('[GS][search] fallback candidate', { title, slug, expectedYear: year || null, extractedYear, accept });
        if (!accept) continue;
        if (year) fbPreferred.push({ id: slug, slug, title }); else fbPreferred.push({ id: slug, slug, title });
        if (!year && fbPreferred.length >= 10) break;
      }
      const finalFb = fbPreferred.length ? fbPreferred : fbOthers;
      console.log('[GS][search] fallback total', finalFb.length, 'preferred', fbPreferred.length, 'others', fbOthers.length);
      return finalFb.slice(0, 10);
    } catch { return []; }
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
  // Apply a minimum similarity threshold to prevent false positives
  if (!best) return null;
  const threshold = Math.max(2, Math.floor(target.length * 0.25));
  if (bestScore <= threshold) return best;
  // Permissive fallback (match Python script behavior: pick first available result even if fuzzy score high)
  return results[0] || best;
  }

  private async fetchEpisodes(r: GSSearchResult): Promise<GSEpisode[]> {
    const seriesUrl = `${this.base}/${r.slug}/`;
    const html = await this.get(seriesUrl);
    console.log('[GS][fetchEpisodes] url', seriesUrl, 'len', html ? html.length : 0);
    if (!html) return [];
  const eps: GSEpisode[] = [];
    // 1. Old pattern (data-episode / data-url) support kept for backwards compatibility
    const legacyRx = /data-episode=\"(\d+)\"[^>]*data-url=\"([^\"]+)\"/gi;
    let lm: RegExpExecArray | null; let legacyCount = 0;
    while ((lm = legacyRx.exec(html)) && legacyCount < 600) {
      legacyCount++;
      const n = parseInt(lm[1]);
      if (!isNaN(n)) eps.push({ season: 1, number: n, url: lm[2] });
    }
    if (eps.length) {
      console.log('[GS][fetchEpisodes] legacy parsed', eps.length);
      return eps.sort((a,b)=>a.number-b.number);
    }
    // 2. New pattern: anchors with id="serie-<season>_<ep>" and data-link plus inline mirrors
    // We'll parse each <li> containing that anchor and collect all data-link values in its mirrors div.
  const liBlockRe = /<li[^>]*>([\s\S]*?<a[^>]+id=\"serie-(\d+)_(\d+)\"[\s\S]*?)<\/li>/gi;
    let m: RegExpExecArray | null; let count = 0;
    while ((m = liBlockRe.exec(html)) && count < 800) {
      count++;
      const block = m[1];
  const seasonStr = m[2];
  const epNumStr = m[3];
      const epNum = parseInt(epNumStr);
  const seasonNum = parseInt(seasonStr);
      if (isNaN(epNum)) continue;
      // main anchor data-link
      const mainLinkMatch = block.match(/id=\"serie-\d+_\d+\"[^>]*data-link=\"([^\"]+)\"/i);
      const links = new Set<string>();
      if (mainLinkMatch) {
        let u = mainLinkMatch[1]; if (u.startsWith('//')) u = 'https:' + u; links.add(u);
      }
      // mirrors inside this block
      for (const mm of block.matchAll(/data-link=\"([^\"]+)\"/g)) { let u = mm[1]; if (u.startsWith('//')) u='https:'+u; links.add(u); }
      if (!links.size) continue;
  eps.push({ season: isNaN(seasonNum)? 1 : seasonNum, number: epNum, url: seriesUrl, embeds: Array.from(links).filter(l=>/supervideo|dropload|mixdrop|dood/i.test(l)) });
      if (eps.length > 500) break;
    }
    console.log('[GS][fetchEpisodes] new-pattern parsed', eps.length);
    return eps.sort((a,b)=>a.number-b.number);
  }

  private selectEpisode(eps: GSEpisode[], seasonWanted: number | null, episodeWanted: number | null): GSEpisode | null {
    if (seasonWanted != null) {
      const seasonEpisodes = eps.filter(e => e.season === seasonWanted);
      if (!seasonEpisodes.length) return null;
      if (episodeWanted == null) return seasonEpisodes.sort((a,b)=>a.number-b.number)[0] || null;
      return seasonEpisodes.find(e => e.number === episodeWanted) || null;
    }
    if (episodeWanted == null) return eps[0] || null;
    return eps.find(e => e.number === episodeWanted) || null;
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
    // If we already extracted embeds from the episode list (new pattern), use them directly.
    if (ep.embeds && ep.embeds.length) {
      console.log('[GS][fetchEpisodeStreams] using pre-parsed embeds', ep.embeds.length);
      const seen = new Set<string>();
      const out: StreamForStremio[] = [];
      for (const raw of ep.embeds.slice(0,10)) {
        let eurl = raw.startsWith('//') ? 'https:' + raw : raw;
        try {
          const { streams } = await extractFromUrl(eurl, { mfpUrl: this.config.mfpUrl, mfpPassword: this.config.mfpPassword, countryCode: 'IT' });
          for (const s of streams) {
            if (seen.has(s.url)) continue; seen.add(s.url);
            const parsed = this.parseSecondLineParts(s.title);
            out.push({ ...s, title: this.formatStreamTitle(r.title, season, episode, parsed.info, parsed.player) });
          }
        } catch (e) { console.log('[GS][fetchEpisodeStreams] pre-embed error', (e as any)?.message || e); }
      }
      console.log('[GS][fetchEpisodeStreams] total streams (pre-parsed)', out.length);
      return out;
    }
    // Legacy path: need to fetch the per-episode URL page and scrape
    const html = await this.get(ep.url);
    console.log('[GS][fetchEpisodeStreams] ep url', ep.url, 'len', html ? html.length : 0);
    if (!html) return [];
    const embedLinks = this.collectEmbedLinks(html, false);
    console.log('[GS][fetchEpisodeStreams] embed links', embedLinks.length);
    const seen = new Set<string>();
    const out: StreamForStremio[] = [];
    for (const eurl of embedLinks) {
      console.log('[GS][fetchEpisodeStreams] extracting', eurl);
      const { streams } = await extractFromUrl(eurl, { mfpUrl: this.config.mfpUrl, mfpPassword: this.config.mfpPassword, countryCode: 'IT' });
      for (const s of streams) { if (seen.has(s.url)) continue; seen.add(s.url); const parsed = this.parseSecondLineParts(s.title); out.push({ ...s, title: this.formatStreamTitle(r.title, season, episode, parsed.info, parsed.player) }); }
    }
    if (!out.length) {
      const urls = await this.extractDeep(html);
      console.log('[GS][fetchEpisodeStreams] deep urls', urls.length);
      for (const u of urls) {
        const info = await this.getHlsInfoSafe(u);
        out.push({ title: this.formatStreamTitle(r.title, season, episode, info), url: u, behaviorHints:{ notWebReady:true } });
      }
    }
    console.log('[GS][fetchEpisodeStreams] total streams', out.length);
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
  private async tryDirectImdbFlow(imdbId: string, season: number, episode: number, expectedTitle?: string): Promise<StreamForStremio[]> {
    try {
      const searchUrl = `${this.base}/?story=${encodeURIComponent(imdbId)}&do=search&subaction=search`;
      console.log('[GS][Direct] search url', searchUrl);
      const html = await this.get(searchUrl);
      if (!html) return [];
      console.log('[GS][Direct] search html length', html.length);
      const hrefs: string[] = [];
      const reHref = /<div[^>]+class="mlnh-2"[\s\S]*?<h2>\s*<a[^>]+href="([^"]+)"/gi;
      let m: RegExpExecArray | null; let count=0;
      while((m=reHref.exec(html)) && count<5){ hrefs.push(m[1]); count++; }
      if (!hrefs.length) {
        const reA = /<a[^>]+href="([^"]+)"[^>]*>/gi; count=0;
        while((m=reA.exec(html)) && count<5){ const u=m[1]; if(/\/\d/.test(u)){ hrefs.push(u); count++; } }
      }
      if (!hrefs.length) return [];
      interface CandidatePage { url: string; html: string; score: number; title: string; }
      const candidates: CandidatePage[] = [];
      const norm = (s:string)=> s.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
      const lev = (a:string,b:string)=>{ if(a===b) return 0; const al=a.length, bl=b.length; const dp=Array.from({length:al+1},()=>Array(bl+1).fill(0)); for(let i=0;i<=al;i++) dp[i][0]=i; for(let j=0;j<=bl;j++) dp[0][j]=j; for(let i=1;i<=al;i++){ for(let j=1;j<=bl;j++){ const c=a[i-1]===b[j-1]?0:1; dp[i][j]=Math.min(dp[i-1][j]+1, dp[i][j-1]+1, dp[i-1][j-1]+c); } } return dp[al][bl]; };
      const expectedNorm = expectedTitle? norm(expectedTitle): null;
      for (const href of hrefs.slice(0,5)) {
        const u = href.startsWith('http') ? href : `${this.base}${href.startsWith('/') ? '' : '/'}${href}`;
        const h = await this.get(u);
        if (!h) continue;
        const titleMatch = h.match(/<title>([^<]+)<\/title>/i);
        let pageTitle = titleMatch ? titleMatch[1].replace(/-\s*GuardaSerie.*$/i,'').trim() : '';
        pageTitle = pageTitle.replace(/Streaming .*$/i,'').trim();
        let score = 9999;
        if (expectedNorm) score = lev(norm(pageTitle), expectedNorm);
        candidates.push({ url: u, html: h, score, title: pageTitle });
      }
      if (expectedNorm) {
        candidates.sort((a,b)=> a.score - b.score);
        // threshold: allow at most 40% of expected length distance
        const best = candidates[0];
        if (!best || best.score > Math.max(2, Math.floor(expectedNorm.length * 0.4))) {
          console.log('[GS][Direct] no sufficiently similar page (best score)', best? best.score : 'n/a');
          return [];
        }
        console.log('[GS][Direct] chosen page', best.url, 'score', best.score, 'title', best.title);
        return await this.extractDirect(best.html, best.url, imdbId, season, episode, expectedTitle || '');
      }
      // fallback old behaviour (no expected title)
      const first = candidates[0];
      if (!first) return [];
      console.log('[GS][Direct] chosen page', first.url, 'no expected title');
      return await this.extractDirect(first.html, first.url, imdbId, season, episode, expectedTitle || '');
    } catch { return []; }
  }


  private async extractDirect(detailHtml: string, pageUrl: string, imdbId: string, season: number, episode: number, resolvedTitle: string): Promise<StreamForStremio[]> {
    try {
      console.log('[GS][Direct] detail html length', detailHtml.length);
      const epId = `serie-${season}_${episode}`;
      const liRegex = new RegExp(`<li[^>]*>[^<]*\n?\s*<a[^>]+id="${epId}"[\\s\\S]*?</li>`,'i');
      const embedLinks: string[] = [];
      const liMatch = detailHtml.match(liRegex);
      if (liMatch) {
        const block = liMatch[0];
        for (const mm of block.matchAll(/class=\"mr[^\"]*\"[^>]+data-link=\"([^\"]+)\"/g)) { let u = mm[1]; if(u.startsWith('//')) u='https:'+u; embedLinks.push(u); }
        for (const mm of block.matchAll(/class=\"me[^\"]*\"[^>]+data-link=\"([^\"]+)\"/g)) { let u = mm[1]; if(u.startsWith('//')) u='https:'+u; if(!embedLinks.includes(u)) embedLinks.push(u); }
        for (const mm of block.matchAll(/data-link=\"([^\"]+)\"/g)) { let u=mm[1]; if(u.startsWith('//')) u='https:'+u; if(!embedLinks.includes(u)) embedLinks.push(u); }
      }
      if (!embedLinks.length) {
        const globalMirrors = detailHtml.match(/<div class=\"mirrors\"[\s\S]*?<\/div>/gi) || [];
        for (const gm of globalMirrors) {
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
              if (!seen.has(finalUrl)) { seen.add(finalUrl); out.push({ title: this.formatStreamTitle(resolvedTitle || '', season, episode, info, 'supervideo'), url: finalUrl, behaviorHints:{ notWebReady:true } }); }
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
            out.push({ ...s, title: this.formatStreamTitle(resolvedTitle || '', season, episode, parsed.info, player) });
          }
        } catch (e) { console.log('[GS][Direct] embed error', (e as any)?.message || e); }
      }
      if (!out.length) return [];
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
  let playerPart = player ? player : undefined;
  if (playerPart && /supervideo/i.test(playerPart)) playerPart = 'SuperVideo';
    const segments: string[] = [];
  // Apply Dropload / general filters: skip sentinel size 5.00MB and fake 100p resolution
  const filteredSize = sizePart && /^(5\.00MB)$/i.test(sizePart) ? undefined : sizePart;
  const filteredRes = resPart && /^100p$/i.test(resPart) ? undefined : resPart;
  if (filteredSize) segments.push(filteredSize);
  if (filteredRes) segments.push(filteredRes);
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
