//Adapted for use in Streavix from:
//https://github.com/einars/js-beautify/blob/master/python/jsbeautifier/unpackers/packer.py
// Unpacker for Dean Edward's p.a.c.k.e.r, a part of javascript beautifier
// by Einar Lielmanis <einar@beautifier.io>
//
//     written by Stefano Sanfilippo <a.little.coder@gmail.com>
//
// usage:
//
//if detect(some_string):
//    unpacked = unpack(some_string)
//And from webstreamr in https://github.com/webstreamr/webstreamr

import { unpack } from 'unpacker';

// Exact replica of webstreamr extractUrlFromPacked (throws on failure)
export function extractUrlFromPackedWs(html: string, linkRegExps: RegExp[]): string {
  const evalMatch = html.match(/eval\(function\(p,a,c,k,e,d\).*(\)\))/);
  if (!evalMatch) throw new Error('No p.a.c.k.e.d string found');
  const unpacked = unpack(evalMatch[0]);
  for (const linkRegexp of linkRegExps) {
    const linkMatch = unpacked.match(linkRegexp);
    if (linkMatch && linkMatch[1]) {
      return `https://${linkMatch[1].replace(/^(https:)?\/\//,'')}`;
    }
  }
  throw new Error('Could not find a stream link in embed');
}
