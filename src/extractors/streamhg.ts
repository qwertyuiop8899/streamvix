// StreamHG extractor — EasyProxy-only.
//
// StreamHG/dhcplay/vibuxer rotate the m3u8 token bound to the *extracting*
// client ASN. Streamvix runs behind Cloudflare so the token it would extract
// locally is unusable from the player's ASN → 403. The only viable path is
// to delegate extraction and segment fetching to EasyProxy, which lives on a
// stable ASN and rewrites segment URLs on the fly.
//
// Domains observed in the wild and used by guardahd mirrors:
//   streamhg, dhcplay, audinifer, vidhide, vidhidepro, vidhidevip,
//   smoothpre, listeamed, dhtpre.
//
// Final wrapped URL form:
//   {EP_URL}/extractor/video.m3u8?host=streamhg&d=<embed>&redirect_stream=true
//   (+ optional &api_password=...)
//
// If the caller did not configure an EasyProxy URL, or explicitly selected
// the MediaFlow backend (useMediaFlow=true), the extractor returns no
// streams — there is no MFP path that works for this host family.

import { HostExtractor, ExtractResult, ExtractorContext } from './base';
import type { StreamForStremio } from '../types/animeunity';

// Host pattern: domains used by StreamHG / VidHide family of mirrors.
const STREAMHG_HOST_RE = /(streamhg|dhcplay|audinifer|vidhide|vidhidepro|vidhidevip|smoothpre|listeamed|dhtpre)\./i;

export class StreamHgExtractor implements HostExtractor {
  id = 'streamhg';
  supports(url: string): boolean {
    return STREAMHG_HOST_RE.test(url) && /\/e\//.test(url);
  }

  async extract(rawUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
    // EP-only: skip if MFP backend selected or no EP url configured.
    if (ctx.useMediaFlow === true) {
      console.log('[StreamHG][skip] MFP backend not supported');
      return { streams: [] };
    }
    if (!ctx.mfpUrl) {
      console.log('[StreamHG][skip] no EasyProxy URL configured');
      return { streams: [] };
    }

    let url = rawUrl;
    if (url.startsWith('//')) url = 'https:' + url;
    // Pass the original embed URL through to EP. EP will try the original
    // host and fall back to vibuxer.com automatically.
    console.log('[StreamHG][ep-wrap]', url);

    return { streams: [this.buildEpStream(url, ctx)] };
  }

  private buildEpStream(embedUrl: string, ctx: ExtractorContext): StreamForStremio {
    const baseTitle = ctx.titleHint || 'StreamHG';
    const title = `${baseTitle} • [ITA]\n💾 StreamHG`;

    const base = (ctx.mfpUrl as string).replace(/\/$/, '');
    const params = new URLSearchParams();
    params.set('host', 'streamhg');
    params.set('d', embedUrl);
    params.set('redirect_stream', 'true');
    if (ctx.mfpPassword) params.set('api_password', ctx.mfpPassword);

    const wrapped = `${base}/extractor/video.m3u8?${params.toString()}`;

    return {
      title,
      url: wrapped,
      behaviorHints: { notWebReady: true } as any,
    };
  }
}

