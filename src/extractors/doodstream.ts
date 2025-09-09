import * as cheerio from 'cheerio';
import randomstring from 'randomstring';
import { NotFoundError } from '../error';
import { Context, Format, Meta, UrlResult } from '../types';
import { guessSizeFromMp4 } from '../utils/size';
import { Extractor } from './Extractor';

export class DoodStream extends Extractor {
  public readonly id = 'doodstream';

  public readonly label = 'DoodStream';

  public override readonly ttl: number = 21600000; // 6h

  /** @see https://github.com/Gujal00/ResolveURL/blob/master/script.module.resolveurl/lib/resolveurl/plugins/doodstream.py */
  public supports(_ctx: Context, url: URL): boolean {
    return null !== url.host.match(/dood|do[0-9]go|doood|dooood|ds2play|ds2video|d0o0d|do0od|d0000d|d000d|vidply|all3do|doply|vide0|vvide0|d-s/);
  };

  public override normalize(url: URL): URL {
    const videoId = url.pathname.split('/').slice(-1)[0] as string;
  const normalized = new URL(`http://dood.to/e/${videoId}`);
  if ((globalThis as any).WEBSTREAMR_DEBUG) {
      console.log('[WSR][Dood] normalize input=', url.toString(), 'output=', normalized.toString());
    }
    return normalized;
  };

  protected async extractInternal(ctx: Context, url: URL, meta: Meta): Promise<UrlResult[]> {
  if ((globalThis as any).WEBSTREAMR_DEBUG) {
      console.log('[WSR][Dood] fetching embed', url.toString());
    }
    const html = await this.fetcher.text(ctx, url);
  if ((globalThis as any).WEBSTREAMR_DEBUG) {
      console.log('[WSR][Dood] embed length', html.length);
    }

    const passMd5Match = html.match(/\/pass_md5\/[\w-]+\/([\w-]+)/);
  if ((globalThis as any).WEBSTREAMR_DEBUG) {
      console.log('[WSR][Dood] pass_md5 match=', passMd5Match ? passMd5Match[0] : null);
    }
    if (!passMd5Match) {
      throw new NotFoundError();
    }

    const token = passMd5Match[1] as string;

    const passUrl = new URL(passMd5Match[0], url.origin);
  if ((globalThis as any).WEBSTREAMR_DEBUG) {
      console.log('[WSR][Dood] fetching passUrl', passUrl.toString());
    }
    const baseUrl = await this.fetcher.text(ctx, passUrl);
  if ((globalThis as any).WEBSTREAMR_DEBUG) {
      console.log('[WSR][Dood] baseUrl raw=', baseUrl.slice(0,160));
    }

    const $ = cheerio.load(html);
    const title = $('title').text().trim().replace(/ - DoodStream$/, '').trim();

    let mp4Url: URL;
    let bytes: number | undefined;
  const hasCloudflareStorage = (baseUrl.indexOf('cloudflarestorage') !== -1);
  if (hasCloudflareStorage) {
      mp4Url = new URL(baseUrl);
    } else {
      mp4Url = new URL(`${baseUrl}${randomstring.generate(10)}?token=${token}&expiry=${Date.now()}`);
      bytes = await guessSizeFromMp4(ctx, this.fetcher, mp4Url, { headers: { Referer: url.origin } });
    }
  if ((globalThis as any).WEBSTREAMR_DEBUG) {
      console.log('[WSR][Dood] final mp4=', mp4Url.toString());
    }

    return [
      {
        url: mp4Url,
        format: Format.mp4,
        label: this.label,
        sourceId: `${this.id}_${meta.countryCodes?.join('_')}`,
        ttl: this.ttl,
        meta: {
          ...meta,
          title,
          ...(bytes && { bytes }),
        },
        requestHeaders: {
          Referer: url.origin,
        },
      },
    ];
  };
}
