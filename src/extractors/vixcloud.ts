import { HostExtractor, ExtractResult, ExtractorContext } from './base';
import type { StreamForStremio } from '../types/animeunity';
import * as cheerio from 'cheerio';

/**
 * VixCloud HLS Extractor (allineato al comportamento Kotlin):
 * - Carica pagina embed
 * - Trova window.masterPlaylist (o script contenente "masterPlaylist")
 * - Estrae url + params (token, expires) + canPlayFHD -> &h=1
 * - Restituisce HLS (m3u8). Se fallisce -> streams vuoti (provider farà fallback a MP4 se ANIMEUNITY_PREFER_MP4=1 oppure se mp4 disponibile).
 */
export class VixCloudHlsExtractor implements HostExtractor {
  id = 'vixcloud-hls';

  supports(url: string): boolean {
    return /vixcloud\./i.test(url);
  }

  async extract(url: string, ctx: ExtractorContext): Promise<ExtractResult> {
    console.log('[VixCloudHlsExtractor] START extract (kotlin-EXACT) url=', url);
    try {
      const embedUrl = url.startsWith('http') ? url : 'https://' + url.replace(/^\/\//,'');
      const headers: Record<string,string> = {
        'Accept': '*/*',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0'
      };
      const res = await fetch(embedUrl, { headers });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const html = await res.text();
      const $ = cheerio.load(html);
      const scriptTag = $('script').toArray().map(el => $(el).html() || '').find(s => s.includes('masterPlaylist'));
      if (!scriptTag) {
        console.log('[VixCloudHlsExtractor] No script with masterPlaylist');
        return { streams: [] };
      }
      const rawScript = scriptTag.replace(/\n/g,"\t");
      // --- Kotlin getSanitisedScript replication ---
      const keyRegex = /window\.(\w+)\s*=\s*/g;
      const keys: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = keyRegex.exec(rawScript)) !== null) keys.push(m[1]);
      const parts = rawScript.split(/window\.(?:\w+)\s*=\s*/).slice(1); // drop preamble
      if (!keys.length || keys.length !== parts.length) {
        console.log('[VixCloudHlsExtractor] Key/parts mismatch', { keys: keys.length, parts: parts.length });
        return { streams: [] };
      }
      const jsonObjects: string[] = [];
      for (let i = 0; i < keys.length; i++) {
        let cleaned = parts[i]
          .replace(/;/g,'')
          .replace(/(\{|\[|,)\s*(\w+)\s*:/g,'$1 "$2":')
          .replace(/,(\s*[}\]])/g,'$1')
          .trim();
        jsonObjects.push(`"${keys[i]}": ${cleaned}`);
      }
      let aggregated = '{\n' + jsonObjects.join(',\n') + '\n}';
      aggregated = aggregated.replace(/'/g,'"');
      let parsed: any;
      try { parsed = JSON.parse(aggregated); } catch (e) {
        console.log('[VixCloudHlsExtractor] JSON parse fail (trunc)=', aggregated.slice(0,160));
        return { streams: [] };
      }
      const masterPlaylist = parsed.masterPlaylist;
      if (!masterPlaylist) {
        console.log('[VixCloudHlsExtractor] masterPlaylist missing in parsed JSON');
        return { streams: [] };
      }
      const paramsObj = masterPlaylist.params || {};
      const token = paramsObj.token;
      const expires = paramsObj.expires;
      const baseUrl: string = masterPlaylist.url || '';
      if (!baseUrl) {
        console.log('[VixCloudHlsExtractor] masterPlaylist.url empty');
        return { streams: [] };
      }
      const paramStr = `token=${encodeURIComponent(token)}&expires=${encodeURIComponent(expires)}`;
      let finalUrl: string;
      if (baseUrl.includes('?b')) {
        finalUrl = baseUrl.replace('?b:1','?b=1') + `&${paramStr}`;
      } else {
        finalUrl = baseUrl + (baseUrl.includes('?') ? '&' : '?') + paramStr; // Kotlin always uses ?$params if no ?b
      }
      // Richiesta: assicurare suffisso .m3u8 dopo il numero playlist se non presente
      const beforeQuery = finalUrl.split('?')[0];
      if (!/\.m3u8$/i.test(beforeQuery)) {
        const partsF = finalUrl.split('?');
        finalUrl = beforeQuery.replace(/\/$/, '') + '.m3u8' + (partsF[1] ? '?' + partsF.slice(1).join('?') : '');
      }
      if (parsed.canPlayFHD === true) {
        finalUrl += '&h=1';
      }
      const title = ctx.titleHint ? `[VIX] ${ctx.titleHint}` : '[VIX] Stream';
      const stream: StreamForStremio = {
        title,
        url: finalUrl,
        behaviorHints: {
          notWebReady: true,
          requestHeaders: headers
        }
      };
      console.log('[VixCloudHlsExtractor] SUCCESS kotlin exact', finalUrl);
      return { streams: [stream] };
    } catch (e) {
      console.warn('[VixCloudHlsExtractor] errore:', (e as any)?.message || e);
      return { streams: [] };
    }
  }

  private async buildFromJsonBlock(_block: string, _ctx: ExtractorContext): Promise<StreamForStremio[]> { return []; }

  private cleanJson(raw: string): string {
    let s = raw.trim();
    if (s.endsWith(';')) s = s.slice(0,-1);
    // rimuovi commenti // e /**/ basici
    s = s.replace(/\/\/.*$/mg,'');
    s = s.replace(/\/\*[^*]*\*+([^/*][^*]*\*+)*\//g,'');
    // rimuovi trailing commas
    s = s.replace(/,\s*([}\]])/g,'$1');
    return s;
  }

  private wrapAndTitle(rawUrl: string, ctx: ExtractorContext, prefix: string): StreamForStremio { return { title: prefix + ' ' + (ctx.titleHint || 'Stream'), url: rawUrl, behaviorHints: { notWebReady: true } }; }

  // Kotlin-style reconstruction using split with capturing groups exactly like the original logic paradigm
  private rebuildWindowAssignmentsToJson_KotlinStyle(_script: string): string | null { return null; }

  private buildFromMasterPlaylistObject(_mp: any, _ctx: ExtractorContext, _prefix: string): StreamForStremio | null { return null; }
}

export default VixCloudHlsExtractor;
