//Adapted for use in Streamvix from easystreams:
// https://github.com/realbestia1/easystreams
// src/extractors/supervideo.js

import { HostExtractor, ExtractResult, ExtractorContext, normalizeUrl, parseSizeToBytes } from './base';
import { extractUrlFromPackedWs } from '../utils/packed';
import type { StreamForStremio } from '../types/animeunity';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const global: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;

const USER_AGENT = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

// Exact same unPack function as easystreams common.js
function unPack(p: string, a: number, c: number, k: any[], e: any, d: any): string {
  e = function (c2: number): string {
    return (c2 < a ? "" : e(parseInt(String(c2 / a)))) + ((c2 = c2 % a) > 35 ? String.fromCharCode(c2 + 29) : c2.toString(36));
  };
  if (!"".replace(/^/, String)) {
    while (c--) {
      d[e(c)] = k[c] || e(c);
    }
    k = [function (e2: string) {
      return d[e2] || e2;
    }];
    e = function () {
      return "\\w+";
    };
    c = 1;
  }
  while (c--) {
    if (k[c]) {
      p = p.replace(new RegExp("\\b" + e(c) + "\\b", "g"), k[c]);
    }
  }
  return p;
}

/**
 * Get a proxied URL if a Cloudflare Worker proxy is configured (same as easystreams)
 */
function getProxiedUrl(url: string): string {
  let proxyUrl: string | null = null;
  try {
    if (typeof process !== 'undefined' && process.env && process.env.CF_PROXY_URL) {
      proxyUrl = process.env.CF_PROXY_URL;
    } else if (typeof global !== 'undefined' && (global as any).CF_PROXY_URL) {
      proxyUrl = (global as any).CF_PROXY_URL;
    }
  } catch (e) {
    // Safety
  }

  if (proxyUrl && url) {
    const separator = proxyUrl.includes('?') ? '&' : '?';
    return `${proxyUrl}${separator}url=${encodeURIComponent(url)}`;
  }
  return url;
}

export class SuperVideoExtractor implements HostExtractor {
  id = 'supervideo';
  supports(url: string): boolean { return /supervideo/.test(url); }

  async extract(rawUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
    const debug = true;
    try {
      let url = rawUrl;
      if (url.startsWith("//")) url = "https:" + url;

      // Extract ID and force .tv domain and embed format
      // URLs can be: supervideo.cc/y/ID, supervideo.cc/e/ID, supervideo.cc/ID
      const id = url.split('/').pop();
      const embedUrl = `https://supervideo.tv/e/${id}`;
      const refererBase = "https://supervideo.tv/";

      if (debug) console.log('[SV][embed-url]', embedUrl, 'from', rawUrl);

      // Use CF Worker proxy if configured (same as easystreams), otherwise direct
      const proxiedUrl = getProxiedUrl(embedUrl);
      if (debug && proxiedUrl !== embedUrl) console.log('[SV][cf-proxy]', proxiedUrl);

      let response: Response;
      try {
        response = await fetch(proxiedUrl, {
          headers: {
            "User-Agent": USER_AGENT,
            "Referer": refererBase
          }
        });
      } catch (fetchErr) {
        if (debug) console.log('[SV][fetch-error]', (fetchErr as any)?.message || fetchErr);
        return { streams: [] };
      }

      const html = await response.text();

      if (html.includes("Cloudflare") || html.includes("Just a moment") || response.status === 403) {
        if (debug) console.log(`[SV][cloudflare] ${response.status} from ${proxiedUrl}`);
        return { streams: [] };
      }

      // Try the exact easystreams unpack logic
      const m3u8 = this.unpackStream(html);
      if (m3u8) {
        if (debug) console.log('[SV][success]', m3u8.substring(0, 80));
        return { streams: [this.buildStream(m3u8, html, ctx)] };
      }

      if (debug) console.log('[SV][no-packed] no eval/sources found in response');
      return { streams: [] };

    } catch (e) {
      console.error("[SV] extraction error:", e);
      return { streams: [] };
    }
  }

  private unpackStream(html: string): string | null {
    // Exact same regex as easystreams
    const packedRegex = /eval\(function\(p,a,c,k,e,d\)\{.*?\}\('(.*?)',(\d+),(\d+),'(.*?)'\.split\('\|'\)/;
    const match = packedRegex.exec(html);
    if (match) {
      const p = match[1];
      const a = parseInt(match[2]);
      const c = parseInt(match[3]);
      const k = match[4].split("|");
      const unpacked = unPack(p, a, c, k, null, {});
      const fileMatch = unpacked.match(/sources:\[\{file:"(.*?)"/);
      if (fileMatch) {
        let streamUrl = fileMatch[1];
        if (streamUrl.startsWith("//")) streamUrl = "https:" + streamUrl;
        return streamUrl;
      }
    }

    // Also try webstreamr packed approach as secondary
    try {
      const m3u8 = extractUrlFromPackedWs(html, [/sources:\[\{file:"(.*?)"/]);
      if (m3u8) return m3u8;
    } catch { /* ignore */ }

    return null;
  }

  private buildStream(m3u8: string, html: string, ctx: ExtractorContext): StreamForStremio {
    let resPart = '';
    let sizePart = '';
    const heightAndSizeMatch = html.match(/\d{3,}x(\d{3,}), ([\d.]+ ?[GM]B)/);
    if (heightAndSizeMatch) {
      resPart = `${heightAndSizeMatch[1]}p`;
      const size = parseSizeToBytes(heightAndSizeMatch[2]);
      if (size) sizePart = size / 1024 / 1024 / 1024 > 1 ? (size / 1024 / 1024 / 1024).toFixed(2) + 'GB' : (size / 1024 / 1024).toFixed(0) + 'MB';
    }
    const baseTitle = ctx.titleHint || 'SuperVideo';
    const segs: string[] = [];
    if (sizePart) segs.push(sizePart);
    if (resPart) segs.push(resPart);
    segs.push('SuperVideo');
    const title = `${baseTitle} • [ITA]` + (segs.length ? `\n💾 ${segs.join(' • ')}` : '');
    return { title, url: m3u8, behaviorHints: { notWebReady: true } };
  }
}
