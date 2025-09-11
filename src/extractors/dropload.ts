//Adapted for use in Streamvix from:
// webstreamr in https://github.com/webstreamr/webstreamr
// 

import { HostExtractor, ExtractResult, ExtractorContext, normalizeUrl, parseSizeToBytes } from './base';
import { unpack } from 'unpacker';
import { extractUrlFromPackedWs } from '../utils/packed';
import type { StreamForStremio } from '../types/animeunity';
// NOTE thanks to webstreamr for the logic
async function fetchText(url: string, referer?: string): Promise<string | null> {
  try {
  const headers: any = { 'User-Agent': 'Mozilla/5.0 (DroploadExtractor)' };
  if (referer) headers.Referer = referer;
  const r = await fetch(url, { headers });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

function humanSize(bytes: number): string {
  const units = ['B','KB','MB','GB'];
  let i = 0; let v = bytes;
  while (v >= 1024 && i < units.length -1) { v /= 1024; i++; }
  return (i >= 2 ? v.toFixed(2) : v.toFixed(0)) + units[i];
}

export class DroploadExtractor implements HostExtractor {
  id='dropload';
  supports(url: string){ return /dropload/i.test(url); }
  async extract(rawUrl: string, _ctx: ExtractorContext): Promise<ExtractResult> {
    // Normalize but keep embed- part if present (contains script). Only collapse /e/ path.
    let url = normalizeUrl(rawUrl);
    if (/\/e\//.test(url)) url = url.replace('/e/','/');
    // Some links appear as /d/; unify
    if (/\/d\//.test(url)) url = url.replace('/d/','/');
    // If stripped accidentally, attempt to reconstruct embed form (heuristic) to maximize success
    if (!/embed-/.test(url)) {
      const m = url.match(/https?:\/\/([^/]+)\/(.+)/); // host + path
      if (m && !m[2].startsWith('embed-')) {
        // leave as is; site works without embed sometimes
      }
    }
  console.log('[DroploadExtractor] attempt url', url);
  const html = await fetchText(url, _ctx.referer);
    if (!html) return { streams: [] };
    if (/File Not Found|Pending in queue/i.test(html)) return { streams: [] };
    if (/eval\(function\(p,a,c,k,e,d\)/.test(html)) {
      console.log('[DroploadExtractor] packed script detected');
    }
    if (/sources:\[/.test(html)) {
      console.log('[DroploadExtractor] sources token present');
    }

    // Helper mimicking webstreamr extractUrlFromPacked exactly (without throwing)
    const extractPacked = (data: string): string | undefined => {
      const evalMatch = data.match(/eval\(function\(p,a,c,k,e,d\).*?\)\)/s);
      if (!evalMatch) return undefined;
      try {
        const unpacked = unpack(evalMatch[0]);
        const rx = /sources:\[{file:"(.*?)"/;
        const m = unpacked.match(rx);
        if (m && m[1]) {
          return `https://${m[1].replace(/^(https:)?\/\//,'')}`;
        }
      } catch(e){ console.log('[DroploadExtractor] webstreamr-like unpack failed', (e as any)?.message); }
      return undefined;
    };

    // Height & size patterns (multiple fallbacks)
    const heightMatch = html.match(/\d{3,}x(\d{3,}),/) || html.match(/height['"]?:\s*(\d{3,})/i);
    const sizeMatch = html.match(/([\d.]+ ?[GM]B)/i);
    const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/) || html.match(/<title>([^<]+)<\/title>/i);

    // Attempt pure webstreamr style extraction (throws if missing)
    let m3u8: string | undefined;
    try {
      m3u8 = extractUrlFromPackedWs(html, [/sources:\[{file:"(.*?)"/]);
    } catch {
      // fallback legacy local strategies below
    }

    // Advanced unpack: some pages obfuscate inside eval with altered param order.
  if (!m3u8 && /eval\(function\(p,a,c,k,e,d\)/.test(html)) {
      const evalBlockMatch = html.match(/eval\(function\(p,a,c,k,e,d\).*?\)\)/s);
      if (evalBlockMatch) {
        const packed = evalBlockMatch[0];
        // 1. library unpack attempt
        try {
          const unpacked = unpack(packed);
          if (!m3u8) { try { m3u8 = extractUrlFromPackedWs(unpacked, [/sources:\[{file:"(.*?)"/]); } catch {} }
        } catch(e){ console.log('[DroploadExtractor] primary unpack fail', (e as any)?.message); }

        // 2. manual dictionary reconstruction if still missing
        if (!m3u8) {
          try {
            // Typical pattern: eval(function(p,a,c,k,e,d){...}('payload',radix,count,'dict'.split('|'),0,{}))
            const dictMatch = packed.match(/\('(.*?[^\\])',(\d+),(\d+),'([^']+)'\.split\('\|'\)/s);
            if (dictMatch) {
              const payload = dictMatch[1];
              const dict = dictMatch[4].split('|');
              const decodeToken = (token: string) => {
                const val = parseInt(token, 36);
                return isNaN(val) ? token : (dict[val] || token);
              };
              const restored = payload.replace(/\b([0-9a-z]{1,3})\b/g, t => decodeToken(t));
              if (!m3u8) { try { m3u8 = extractUrlFromPackedWs(restored, [/sources:\[{file:"(.*?)"/]); } catch {} }
            }
          } catch(err){ console.log('[DroploadExtractor] manual dict decode fail'); }
        }

        // 2b. sandbox eval interception (capture final JS before execution)
        if (!m3u8) {
          try {
            // Some variants rely on eval executing and building a jwplayer setup with sources array.
            // We emulate environment & intercept eval argument.
            const vmLikeEval = (code: string) => {
              // Capture code for pattern search
              if (!m3u8) {
                try { m3u8 = extractUrlFromPackedWs(code, [/sources:\[{file:"(.*?)"/]); } catch {}
              }
              if (!m3u8) {
                const nested = code.match(/eval\((function\(p,a,c,k,e,d\).*?)\)/);
                if (nested) {
                  try {
                    const nestedUnpacked = unpack('eval(' + nested[1] + ')');
                    if (!m3u8) { try { m3u8 = extractUrlFromPackedWs(nestedUnpacked, [/sources:\[{file:"(.*?)"/]); } catch {} }
                  } catch {}
                }
              }
              return undefined; // prevent execution side-effects
            };
            // Replace leading 'eval(' with our interceptor call synthetically.
            // Instead of a full VM, do lightweight string surgery & Function constructor isolation.
            const intercepted = 'var window={};var document={};var navigator={};var jwplayer=function(){return {setup:function(c){if(!m3u8&&c&&c.sources){for(const s of c.sources){if(/m3u8/.test(s.file)){m3u8=s.file;}}}}}};\n' +
              packed.replace(/eval\(/g, 'vmLikeEval(');
            const fn = new Function('unpack','vmLikeEval','m3u8','extractUrlFromPackedWs', intercepted + ';return m3u8;');
            const maybe = fn(unpack, vmLikeEval, m3u8, extractUrlFromPackedWs);
            if (!m3u8 && maybe) m3u8 = maybe;
          } catch(err){ console.log('[DroploadExtractor] sandbox eval interception failed'); }
        }

  if (!m3u8) { try { m3u8 = extractUrlFromPackedWs(packed, [/sources:\[{file:"(.*?)"/]); } catch {} }
      }
    }

    // Secondary try on embed- variant only (match then packed extraction)
    if (!m3u8) {
      const embedCandidate = url.includes('/embed-') ? null : url.replace(/\/([^/]+)$/,'/embed-$1');
      if (embedCandidate) {
        const embedHtml = await fetchText(embedCandidate, _ctx.referer || url);
        if (embedHtml) {
          try { m3u8 = extractUrlFromPackedWs(embedHtml, [/sources:\[{file:"(.*?)"/]); } catch {}
        }
      }
    }

  // No fabricated URL: if we still don't have m3u8, finish empty (stay faithful to webstreamr behavior)
  if (!m3u8) { console.log('[DroploadExtractor] no m3u8 found after all strategies'); return { streams: [] }; }
    // Basic sanitize
    m3u8 = m3u8.replace(/&amp;/g,'&');

    let height = heightMatch ? parseInt(heightMatch[1]) : undefined;
    let sizeBytes = sizeMatch ? parseSizeToBytes(sizeMatch[1]) : undefined;

    // Additional HLS master analysis to refine resolution & approximate size
    try {
      const masterTxt = await fetchText(m3u8);
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
          if (best.h) height = best.h;
          // Fetch best variant playlist to approximate size if missing
          if (!sizeBytes) {
            let variantUrl = best.uri;
            if (!/^https?:/i.test(variantUrl)) {
              try {
                const u = new URL(m3u8);
                if (variantUrl.startsWith('/')) variantUrl = u.origin + variantUrl; else {
                  variantUrl = m3u8.replace(/\/[^/]*$/, '/') + variantUrl;
                }
              } catch {}
            }
            const variantTxt = await fetchText(variantUrl);
            if (variantTxt) {
              let duration=0; const rex=/#EXTINF:([0-9.]+)/g; let mm:RegExpExecArray|null; while((mm=rex.exec(variantTxt))) { duration += parseFloat(mm[1])||0; if (duration>36000) break; }
              if (duration>0 && best.bw) { const bytes = duration * (best.bw/8); sizeBytes = Math.round(bytes); }
            }
          }
        }
      }
    } catch {}

    const rawTitle = (titleMatch ? titleMatch[1] : 'Dropload').trim();
    const title = _ctx.titleHint || rawTitle;
  let sizePart = sizeBytes ? humanSize(sizeBytes) : '';
  let resPart = height ? `${height}p` : '';
  // Filter out sentinel / unreliable values
  if (/^5\.00MB$/i.test(sizePart)) sizePart = '';
  if (/^100p$/i.test(resPart)) resPart = '';
  const secondSegs: string[] = [];
  if (sizePart) secondSegs.push(sizePart);
  if (resPart) secondSegs.push(resPart);
  // Always capitalize provider label
  secondSegs.push('Dropload');
  // If we have neither size nor resolution, omit the entire second line per new rule
  const effectiveSecondLine = (sizePart || resPart) ? `\n💾 ${secondSegs.join(' • ')}` : '';
  const stream: StreamForStremio = { title: `${title} • [ITA]${effectiveSecondLine}`, url: m3u8, behaviorHints:{ notWebReady:true } };
    return { streams: [stream] };
  }
}
