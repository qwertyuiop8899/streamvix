//Adapted for use in Streamvix from:
// webstreamr in https://github.com/webstreamr/webstreamr
// 

import { HostExtractor, ExtractResult, ExtractorContext, normalizeUrl, parseSizeToBytes } from './base';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: any;
import { nextProxyPair } from '../config/proxies';
import type { StreamForStremio } from '../types/animeunity';
// NOTE thanks to webstreamr for the logic
interface RawResp { status:number; text:string|null }
async function fetchRaw(url: string, referer?: string, proxy?: string): Promise<RawResp> {
  const headers: Record<string,string> = { 'User-Agent':'Mozilla/5.0' };
  if (referer) headers.Referer = referer;
  let dispatcher: any = undefined;
  if (proxy) {
    try { const { ProxyAgent } = require('undici'); dispatcher = new ProxyAgent(proxy); } catch {}
  }
  try {
    const r = await fetch(url, { headers, dispatcher } as any);
    const t = await r.text().catch(()=>null);
    return { status: r.status, text: r.ok ? t : t };
  } catch { return { status:-1, text:null }; }
}
async function fetchText(url: string, referer?: string, proxy?: string){ const r = await fetchRaw(url, referer, proxy); return r.text; }

function extractPackedFile(html: string): { m3u8?: string; size?: number; height?: number; title?: string } {
  // Look for sources:[{file:"..." pattern
  const sourceMatch = html.match(/sources:\[{file:"(.*?)"/);
  let m3u8: string | undefined; if (sourceMatch) m3u8 = sourceMatch[1];
  const sizeHeightMatch = html.match(/\d{3,}x(\d{3,}), ([\d.]+ ?[GM]B)/);
  let size: number | undefined; let height: number | undefined;
  if (sizeHeightMatch) { height = parseInt(sizeHeightMatch[1]); size = parseSizeToBytes(sizeHeightMatch[2]); }
  const titleMatch = html.match(/download__title[^>]*>([^<]+)/);
  const title = titleMatch ? titleMatch[1].trim() : undefined;
  return { m3u8, size, height, title };
}

export class SuperVideoExtractor implements HostExtractor {
  id = 'supervideo';
  supports(url: string): boolean { return /supervideo/.test(url); }

  private async resolveSupervideo(link: string, proxy?: string): Promise<string | null> {
    const html = await fetchText(link, undefined, proxy);
    if (!html) return null;
    const m = html.match(/}\('(.+?)',.+,'(.+?)'\.split/);
    if (!m) return null;
    const terms = m[2].split('|');
    const fileIndex = terms.indexOf('file');
    if (fileIndex === -1) return null;
    let hfs = '';
    for (let i=fileIndex; i<terms.length; i++){ if (terms[i].includes('hfs')) { hfs = terms[i]; break; } }
    if (!hfs) return null;
    const urlsetIndex = terms.indexOf('urlset');
    const hlsIndex = terms.indexOf('hls');
    if (urlsetIndex === -1 || hlsIndex === -1 || hlsIndex <= urlsetIndex) return null;
    const slice = terms.slice(urlsetIndex + 1, hlsIndex);
    const reversed = slice.reverse();
    let base = `https://${hfs}.serversicuro.cc/hls/`;
    if (reversed.length === 1) { return base + ',' + reversed[0] + '.urlset/master.m3u8'; }
    const len = reversed.length;
    reversed.forEach((el, idx) => { base += el + ',' + (idx === len - 1 ? '.urlset/master.m3u8' : ''); });
    return base;
  }

  async extract(rawUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
    const debug = true; // debug statico richiesto
  const normalized = normalizeUrl(rawUrl);
  const u = new URL(normalized);
  let id = u.pathname.split('/').pop() || '';
  id = id.replace(/^[e-]+/, '').replace(/\.html$/,''); // pulizia minima
  // Se l'URL originale aveva già /e/ manteniamo quell'id esatto
  const embedUrl = `${u.origin}/e/${id}`;
  if (debug) console.log('[SV][embed-url]', embedUrl, 'from', rawUrl);
  const streams: StreamForStremio[] = [];

  // Primo tentativo (senza proxy) sull'embed canonico
  const direct = await this.resolveSupervideo(embedUrl);
    if (direct) {
      // Try to enrich with size/res similar to provider getHlsInfo logic
      let resPart = '';
      let sizePart = '';
      try {
        const masterTxt = await fetchText(direct);
        if (masterTxt && /#EXTM3U/.test(masterTxt)) {
          interface Variant { bw:number; h:number; uri:string }
          const variants: Variant[] = [];
          const lines = masterTxt.split(/\r?\n/);
          for (let i=0;i<lines.length;i++) {
            const l = lines[i];
            if (l.startsWith('#EXT-X-STREAM-INF:')) {
              const attrs = l.substring('#EXT-X-STREAM-INF:'.length);
              const bw = parseInt(attrs.match(/BANDWIDTH=(\d+)/i)?.[1] || '0');
              const h = parseInt(attrs.match(/RESOLUTION=\d+x(\d+)/i)?.[1] || '0');
              const next = lines[i+1] || '';
              if (bw && next && !next.startsWith('#')) variants.push({ bw, h, uri: next.trim() });
            }
          }
          if (variants.length) {
            const filtered = variants.filter(v=> v.h>=144 || v.h===0);
            const working = filtered.length? filtered: variants;
            working.sort((a,b)=> (b.h - a.h) || (b.bw - a.bw));
            const best = working[0];
            if (best.h) resPart = `${best.h}p`;
            // approximate size via variant playlist
            let variantUrl = best.uri;
            if (!/^https?:/i.test(variantUrl)) {
              try { const u = new URL(direct); if (variantUrl.startsWith('/')) variantUrl = u.origin + variantUrl; else variantUrl = direct.replace(/\/[^/]*$/, '/') + variantUrl; } catch {}
            }
            const variantTxt = await fetchText(variantUrl);
            if (variantTxt) {
              let duration=0; const rex=/#EXTINF:([0-9.]+)/g; let mm:RegExpExecArray|null; while((mm=rex.exec(variantTxt))) { duration += parseFloat(mm[1])||0; if (duration>36000) break; }
              if (duration>0 && best.bw) { const bytes = duration * (best.bw/8); sizePart = bytes >= 1024**3 ? (bytes/1024/1024/1024).toFixed(2)+'GB' : (bytes/1024/1024).toFixed(0)+'MB'; }
            }
          }
        }
      } catch {}
  const baseTitle = ctx.titleHint || 'SuperVideo';
  const segs: string[] = [];
  if (sizePart) segs.push(sizePart);
  if (resPart) segs.push(resPart);
  // Host label capitalized per new formatting rule
  segs.push('SuperVideo');
  const title = `${baseTitle} • [ITA]` + (segs.length? `\n💾 ${segs.join(' • ')}`: '');
      streams.push({ title, url: direct, behaviorHints: { notWebReady: true } });
      if (streams.length) {
        if (debug) console.log('[SV][first-attempt direct ok]', embedUrl);
        return { streams };
      }
    }
    // Embed parse (senza proxy)
  let html = await fetchText(embedUrl, ctx.referer);
    if (html) {
      const { m3u8, size, height, title } = extractPackedFile(html);
      if (m3u8) {
        const baseTitle = ctx.titleHint || title || 'SuperVideo';
        let sizePart = '';
        if (size) sizePart = size/1024/1024/1024>1? (size/1024/1024/1024).toFixed(2)+'GB': (size/1024/1024).toFixed(0)+'MB';
        const segs: string[] = [];
        if (sizePart) segs.push(sizePart);
        if (height) segs.push(`${height}p`);
  // Host label capitalized per new formatting rule
  segs.push('SuperVideo');
        const formatted = `${baseTitle} • [ITA]` + (segs.length? `\n💾 ${segs.join(' • ')}`:'');
        streams.push({ title: formatted, url: m3u8, behaviorHints: { notWebReady: true } });
      }
    }

    if (streams.length) {
  if (debug) console.log('[SV][first-attempt embed ok]', embedUrl);
      return { streams };
    }

    // --- PROXY FALLBACK (sempre se 0 streams) ---
    if (debug) console.log('[SV][proxy trigger] 0 streams after first attempt', embedUrl);
    const proxies = nextProxyPair();
    for (let i=0;i<proxies.length;i++) {
      const p = proxies[i];
      if (debug) console.log('[SV][proxy try]', p.replace(/:\\w+@/,'://***@'));
      const viaDirect = await this.resolveSupervideo(embedUrl, p);
      if (viaDirect) {
        if (debug) console.log('[SV][proxy success direct]');
  return { streams: [{ title: (ctx.titleHint||'SuperVideo') + ' • [ITA]\n💾 SuperVideo', url: viaDirect, behaviorHints:{ notWebReady:true } }] };
      }
      const viaHtml = await fetchText(embedUrl, ctx.referer, p);
      if (viaHtml) {
        const { m3u8, size, height, title } = extractPackedFile(viaHtml);
        if (m3u8) {
          if (debug) console.log('[SV][proxy success embed]');
          let sizePart = '';
          if (size) sizePart = size/1024/1024/1024>1? (size/1024/1024/1024).toFixed(2)+'GB': (size/1024/1024).toFixed(0)+'MB';
          const segs: string[] = [];
          if (sizePart) segs.push(sizePart);
          if (height) segs.push(`${height}p`);
          // Host label capitalized per new formatting rule
          segs.push('SuperVideo');
          const baseTitle = ctx.titleHint || title || 'SuperVideo';
          const formatted = `${baseTitle} • [ITA]` + (segs.length? `\n💾 ${segs.join(' • ')}`:'');
          return { streams: [{ title: formatted, url: m3u8, behaviorHints:{ notWebReady:true } }] };
        }
      }
      if (debug) console.log('[SV][proxy fail]', i+1);
    }
  if (debug) console.log('[SV][proxy exhausted] still 0 streams', embedUrl);
    return { streams: [] };
  }
}
