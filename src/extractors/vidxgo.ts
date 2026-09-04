// VidXgo extractor — port of MammaMia Src/API/extractors/vidxgo.py.
//
// Decryption logic:
//   - GET the embed page with Firefox-150 UA + altadefinizione.you referer.
//   - Parse HTML, take the 6th <script> tag (index 5).
//   - Regex match `var <name>='(KEY)',d=atob('(B64)'` inside that script.
//   - base64-decode the B64 payload, then XOR byte-by-byte with the KEY
//     (cyclic: key[i % len(key)]).
//   - In the decrypted JS, find `currentSrc.+"(https:[^";]+)"` → that's the HLS URL.
//   - Replace backslashes in the URL.
//
// Streamcore routing:
//   - Wraps the source URL or extracted HLS into the Streamcore extractor format.

import { HostExtractor, ExtractResult, ExtractorContext } from './base';
import type { StreamForStremio } from '../types/animeunity';

const VIDXGO_DEFAULT_DOMAIN = 'https://v.vidxgo.co';
const VIDXGO_HOST_RE = /vidxgo/i;

// Configurazione Streamcore (configurabile tramite variabili d'ambiente o fallback predefinito)
const STREAMCORE_BASE_URL = (process.env.STREAMCORE_URL || 'https://ep.streamcore.qzz.io').replace(/\/+$/, '');
const STREAMCORE_API_PASSWORD = process.env.STREAMCORE_PASSWORD || process.env.API_PASSWORD || '';

/**
 * Costruisce l'endpoint proxy di Streamcore formattando i parametri di query.
 */
export function buildStreamcoreUrl(
  destinationUrl: string,
  options?: {
    baseUrl?: string;
    apiPassword?: string;
    redirectStream?: boolean;
    host?: string;
  }
): string {
  const base = (options?.baseUrl || STREAMCORE_BASE_URL).replace(/\/+$/, '');
  const params = new URLSearchParams({
    host: options?.host || 'vidxgo',
    d: destinationUrl,
    redirect_stream: String(options?.redirectStream ?? true),
  });

  const pwd = options?.apiPassword !== undefined ? options.apiPassword : STREAMCORE_API_PASSWORD;
  if (pwd) {
    params.set('api_password', pwd);
  }

  return `${base}/extractor/video.m3u8?${params.toString()}`;
}

// Headers used for the embed-page GET. Copied 1:1 from MammaMia.
const VIDXGO_GET_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Sec-GPC': '1',
  'Connection': 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest': 'iframe',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'DNT': '1',
  'Referer': 'https://altadefinizione.you/',
  'Priority': 'u=0, i',
};

// Playback UA (Chrome) — different from the GET UA on purpose, as in MammaMia.
const VIDXGO_PLAYBACK_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36';

export interface VidXgoExtractResult {
  m3u8: string;
  playbackHeaders: Record<string, string>;
}

/**
 * Fetch a VidXgo embed page and extract the m3u8 URL.
 * Returns null if the page cannot be parsed/decoded.
 */
export async function fetchAndExtractVidXgo(
  url: string,
  domain: string = VIDXGO_DEFAULT_DOMAIN,
): Promise<VidXgoExtractResult | null> {
  let resp: Response;
  try {
    resp = await fetch(url, { headers: VIDXGO_GET_HEADERS as any, redirect: 'follow' as any });
  } catch (e: any) {
    console.log('[VidXgo][fetch-error]', e?.message || e);
    return null;
  }
  if (!resp.ok) {
    console.log('[VidXgo][http-error]', resp.status, 'url=', url);
    return null;
  }
  const html = await resp.text();
  const m3u8 = decodeVidXgoHtml(html);
  if (!m3u8) return null;
  return {
    m3u8,
    playbackHeaders: {
      'User-Agent': VIDXGO_PLAYBACK_UA,
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': domain + '/',
      'Origin': domain,
      'Sec-GPC': '1',
      'Connection': 'keep-alive',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'cross-site',
      'DNT': '1',
    },
  };
}

/**
 * Decode the VidXgo HTML payload to the final HLS URL. Pure function (no IO).
 */
export function decodeVidXgoHtml(html: string): string | null {
  try {
    const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    const scriptBodies: string[] = [];
    let sm: RegExpExecArray | null;
    while ((sm = scriptRe.exec(html)) !== null) {
      const attrs = sm[1] || '';
      if (/\bsrc\s*=/i.test(attrs)) {
        scriptBodies.push('');
      } else {
        scriptBodies.push(sm[2] || '');
      }
    }
    if (scriptBodies.length <= 5) {
      console.log('[VidXgo][decode] not enough <script> tags:', scriptBodies.length);
      return null;
    }

    const target = scriptBodies[5] || '';
    if (!target) {
      console.log('[VidXgo][decode] script[5] empty');
      return null;
    }
    const m = target.match(/var\s+\w+\s*=\s*'([^']*)'\s*,\s*d\s*=\s*atob\(\s*'([^']*)'/);
    if (!m) {
      console.log('[VidXgo][decode] key/payload regex did not match in script[5]');
      return null;
    }
    const key = m[1];
    const b64 = m[2];
    if (!key || !b64) return null;
    const decoded = Buffer.from(b64, 'base64');
    if (!decoded.length) return null;
    const out = Buffer.alloc(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
      out[i] = decoded[i] ^ key.charCodeAt(i % key.length);
    }
    const decrypted = out.toString('utf-8');
    const urlMatch = decrypted.match(/currentSrc.+?"(https:[^";]+)"/);
    if (!urlMatch) {
      console.log('[VidXgo][decode] no currentSrc URL in decrypted code');
      return null;
    }
    return urlMatch[1].replace(/\\/g, '');
  } catch (e: any) {
    console.log('[VidXgo][decode][err]', e?.message || e);
    return null;
  }
}

/**
 * HostExtractor wrapper so /vidxgo/ URLs flowing through `extractFromUrl`
 * also get resolved.
 */
export class VidXgoExtractor implements HostExtractor {
  id = 'vidxgo';
  supports(url: string): boolean { return VIDXGO_HOST_RE.test(url); }

  async extract(rawUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
    const baseTitle = ctx.titleHint || 'VidXgo';
    const title = `${baseTitle} • [ITA]\n💾 VidXgo`;

    // Costruisce direttamente l'URL per Streamcore passando il rawUrl come parametro d
    const streamUrl = buildStreamcoreUrl(rawUrl);

    const stream: StreamForStremio = {
      title,
      url: streamUrl,
      behaviorHints: {
        notWebReady: false,
        bingeGroup: 'vidxgo',
      } as any,
    };

    return { streams: [stream] };
  }
}
