// StreamHG extractor — port of MammaMia Src/Utilities/eval/streamhg.py.
//
// MammaMia behaviour:
//   link = 'https://audinifer.com/e/' + link.split('/e/')[1]
//   GET <link> → packed JS → regex r'"hls2":"([^"]+)"' → m3u8.
//
// The same network (StreamHG / Vidhide) rotates many host names. We normalise
// to audinifer.com because that mirror tends to be the most stable, exactly
// like upstream MammaMia. Domains observed in the wild and used by guardahd
// mirrors: streamhg, dhcplay, audinifer, vidhide / vidhidepro / vidhidevip,
// smoothpre, listeamed, dhtpre, ecc.

import { HostExtractor, ExtractResult, ExtractorContext } from './base';
import type { StreamForStremio } from '../types/animeunity';
// eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
declare function require(name: string): any;
// Reuse the same packer unpacker as the other extractors.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { unpack } = require('unpacker');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Host pattern: domains used by StreamHG / VidHide family of mirrors.
const STREAMHG_HOST_RE = /(streamhg|dhcplay|audinifer|vidhide|vidhidepro|vidhidevip|smoothpre|listeamed|dhtpre)\./i;

export class StreamHgExtractor implements HostExtractor {
  id = 'streamhg';
  supports(url: string): boolean {
    return STREAMHG_HOST_RE.test(url) && /\/e\//.test(url);
  }

  async extract(rawUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
    try {
      let url = rawUrl;
      if (url.startsWith('//')) url = 'https:' + url;
      // Normalise to audinifer.com/e/<id> like MammaMia. If the URL has no
      // /e/ path (defensive), fall back to original.
      const idMatch = url.split('/e/');
      let target = url;
      if (idMatch.length >= 2 && idMatch[1]) {
        const id = idMatch[1].split(/[/?#]/)[0];
        if (id) target = `https://audinifer.com/e/${id}`;
      }
      console.log('[StreamHG][embed-url]', target, 'from', rawUrl);

      let resp: Response;
      try {
        resp = await fetch(target, {
          headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.7,en;q=0.6',
            'Referer': ctx.referer || 'https://audinifer.com/',
          },
        });
      } catch (e: any) {
        console.log('[StreamHG][fetch-error]', e?.message || e);
        return { streams: [] };
      }
      if (!resp.ok) {
        console.log('[StreamHG][http-error]', resp.status);
        return { streams: [] };
      }
      const html = await resp.text();
      if (/Just a moment|Cloudflare/i.test(html)) {
        console.log('[StreamHG][cloudflare] challenge');
        return { streams: [] };
      }

      const m3u8 = this.unpackHls(html);
      if (!m3u8) {
        console.log('[StreamHG][no-hls] eval/hls2 not found');
        return { streams: [] };
      }
      console.log('[StreamHG][success]', m3u8.substring(0, 80));

      return { streams: [this.buildStream(m3u8, ctx)] };
    } catch (e: any) {
      console.log('[StreamHG][err]', e?.message || e);
      return { streams: [] };
    }
  }

  private unpackHls(html: string): string | null {
    try {
      const evalMatch = html.match(/eval\(function\(p,a,c,k,e,d\).*?\}\(.*?\.split\('\|'\)[^)]*\)\)/);
      if (!evalMatch) return null;
      const unpacked = unpack(evalMatch[0]);
      const m = unpacked.match(/"hls2"\s*:\s*"([^"]+)"/i);
      if (!m) return null;
      let u = m[1].replace(/\\\//g, '/');
      if (u.startsWith('//')) u = 'https:' + u;
      return u;
    } catch {
      return null;
    }
  }

  private buildStream(m3u8: string, ctx: ExtractorContext): StreamForStremio {
    const baseTitle = ctx.titleHint || 'StreamHG';
    let title = `${baseTitle} • [ITA]\n💾 StreamHG`;
    const playbackReferer = 'https://audinifer.com/';

    // Wrap with MediaFlow HLS proxy if the caller provided MFP creds.
    // Same pattern used by gdplayerRuntime: /proxy/hls/manifest.m3u8?api_password=...&d=...&h_*
    if (ctx.mfpUrl && ctx.mfpPassword) {
      try {
        const base = ctx.mfpUrl.replace(/\/$/, '');
        const encoded = encodeURIComponent(m3u8);
        const wrapped = `${base}/proxy/hls/manifest.m3u8?api_password=${encodeURIComponent(ctx.mfpPassword)}&d=${encoded}`
          + `&h_Referer=${encodeURIComponent(playbackReferer)}`
          + `&h_Origin=${encodeURIComponent(playbackReferer.replace(/\/$/, ''))}`
          + `&h_User-Agent=${encodeURIComponent(UA)}`;
        return {
          title,
          url: wrapped,
          behaviorHints: { notWebReady: true } as any,
        };
      } catch { /* fall through to direct */ }
    }

    return {
      title,
      url: m3u8,
      behaviorHints: {
        notWebReady: true,
        proxyHeaders: {
          request: {
            'Referer': playbackReferer,
            'Origin': playbackReferer.replace(/\/$/, ''),
            'User-Agent': UA,
          },
        },
      } as any,
    };
  }
}
