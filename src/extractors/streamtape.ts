// Streamtape extractor: incapsula solo l'URL embed dentro MFP (stile Mixdrop)
// Richiesta: input https://streamtape.com/e/<id>
// Output:  <MFP>/extractor/video?host=Streamtape&api_password=<psw>&d=<ENCODED>&redirect_stream=true
// Nessun fetch pagina originale.

import { HostExtractor, ExtractResult, ExtractorContext, normalizeUrl } from './base';
import type { StreamForStremio } from '../types/animeunity';

export class StreamtapeExtractor implements HostExtractor {
  id = 'streamtape';
  supports(url: string) { return /streamtape\.com\//i.test(url); }

  async extract(rawUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
  console.log('[STAPE][BEGIN]', rawUrl, 'mfp?', !!ctx.mfpUrl && !!ctx.mfpPassword);
    if (!ctx.mfpUrl || !ctx.mfpPassword) {
      console.log('[STAPE][SKIP] MFP missing, no streams');
      return { streams: [] };
    }
    const embedUrl = normalizeUrl(rawUrl);
    const encoded = encodeURIComponent(embedUrl);
    const base = ctx.mfpUrl.replace(/\/$/, '');
    const finalUrl = `${base}/extractor/video?host=Streamtape&api_password=${encodeURIComponent(ctx.mfpPassword)}&d=${encoded}&redirect_stream=true`;
    console.log('[STAPE][WRAP]', embedUrl, '->', finalUrl);
    let line1 = (ctx.titleHint || 'Streamtape').trim();
    if (!/\[ITA\]$/i.test(line1)) line1 = line1 + ' • [ITA]';
    const line2 = '💾 streamtape';
    const title = `${line1}\n${line2}`;
    // Allineato a Mixdrop: notWebReady true (addon rimuove lock via nome host)
    const streams: StreamForStremio[] = [{ title, url: finalUrl, behaviorHints: { notWebReady: true } as any }];
    return { streams };
  }
}
