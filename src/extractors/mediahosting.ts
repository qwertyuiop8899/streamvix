/**
 * MediaHosting extractor
 * 
 * Estrae stream M3U8 da mediahosting.space.
 * Semplicissimo: GET sulla pagina embed → estrai <source src="..."> dall'HTML.
 * Nessuna deobfuscazione necessaria.
 * 
 * Ref: https://github.com/mandrakodi/mandrakodi.github.io/blob/main/myResolver.py
 */
import axios from 'axios';

export interface MediaHostingChannel {
    id: number;          // stream ID su mediahosting (es. 229, 230...)
    name: string;        // nome canale (es. "DAZN 1")
    category: string;    // categoria (es. "Sky Sport", "DAZN")
    logo?: string;
}

export class MediaHostingClient {
    private baseUrl = 'https://mediahosting.space';
    private referer = 'https://mediahosting.space/';
    private userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

    /**
     * Risolve un ID mediahosting in un URL M3U8.
     * @param streamId - L'ID numerico dello stream (es. 229)
     * @returns URL M3U8 o null se non trovato
     */
    async resolve(streamId: number | string): Promise<string | null> {
        const playerUrl = `${this.baseUrl}/embed/player?stream=${streamId}&no_register=true`;
        try {
            const resp = await axios.get(playerUrl, {
                headers: {
                    'Referer': this.referer,
                    'User-Agent': this.userAgent,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                timeout: 15000,
            });
            const html: string = resp.data;

            // Pattern 1: <source src="...">
            const sourceMatch = html.match(/<source\s+src="([^"]+)"/i);
            if (sourceMatch && sourceMatch[1]) {
                console.log(`[MediaHosting] ✅ Resolved stream ${streamId} -> ${sourceMatch[1].substring(0, 80)}...`);
                return sourceMatch[1];
            }

            // Pattern 2: file:"..." (alcuni player usano questo)
            const fileMatch = html.match(/file:\s*"([^"]+\.m3u8[^"]*)"/i);
            if (fileMatch && fileMatch[1]) {
                console.log(`[MediaHosting] ✅ Resolved stream ${streamId} (file:) -> ${fileMatch[1].substring(0, 80)}...`);
                return fileMatch[1];
            }

            // Pattern 3: source: "..."
            const srcMatch = html.match(/source:\s*"([^"]+\.m3u8[^"]*)"/i);
            if (srcMatch && srcMatch[1]) {
                console.log(`[MediaHosting] ✅ Resolved stream ${streamId} (source:) -> ${srcMatch[1].substring(0, 80)}...`);
                return srcMatch[1];
            }

            console.warn(`[MediaHosting] ⚠️ No stream URL found for ID ${streamId}`);
            return null;
        } catch (e: any) {
            console.error(`[MediaHosting] ❌ Error resolving stream ${streamId}: ${e.message}`);
            return null;
        }
    }

    /** Headers necessari per il playback dello stream M3U8 */
    getPlaybackHeaders(): Record<string, string> {
        return {
            'Referer': this.referer,
            'Origin': this.baseUrl,
            'User-Agent': this.userAgent,
        };
    }
}

// ===== CHANNEL MATCHING (come getFreeshotCode) =====

// Mappa nome normalizzato -> stream ID MediaHosting
export const MEDIAHOSTING_CODE_MAP: Record<string, number> = {
    dazn1: 229,
    dazn: 229,
    zonadazn: 229,
    skysportuno: 230,
    skysportf1: 231,
    skysportcalcio: 232,
    skysporttennis: 233,
    skysportmotogp: 234,
    skysportarena: 235,
    skysportmax: 236,
    skysportgolf: 237,
    skysport24: 238,
    skysportbasket: 239,
    skysportlegend: 240,
    skysportmix: 241,
};

// Nome visuale canonico da usare nel titolo stream
export const MEDIAHOSTING_DISPLAY_NAME: Record<number, string> = {
    229: 'DAZN 1',
    230: 'Sky Sport Uno',
    231: 'Sky Sport F1',
    232: 'Sky Sport Calcio',
    233: 'Sky Sport Tennis',
    234: 'Sky Sport MotoGP',
    235: 'Sky Sport Arena',
    236: 'Sky Sport Max',
    237: 'Sky Sport Golf',
    238: 'Sky Sport 24',
    239: 'Sky Sport Basket',
    240: 'Sky Sport Legend',
    241: 'Sky Sport Mix',
};

function normalizeKey(s?: string): string | null {
    if (!s || typeof s !== 'string') return null;
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Dato un canale (id, name, epgChannelIds, extraTexts), restituisce lo stream ID
 * MediaHosting corrispondente — oppure null se nessun match.
 * Pattern identico a getFreeshotCode() in freeshotRuntime.ts.
 */
export function getMediaHostingCode(channel: {
    id?: string;
    name?: string;
    epgChannelIds?: string[];
    extraTexts?: string[];
}): { streamId: number; displayName: string; matchHint: string } | null {
    const idKey = normalizeKey(channel.id);
    const nameKey = normalizeKey(channel.name);
    let streamId: number | undefined;
    let matchHint = '';

    // 1. Match diretto per id
    if (!streamId && idKey && MEDIAHOSTING_CODE_MAP[idKey] !== undefined) {
        streamId = MEDIAHOSTING_CODE_MAP[idKey];
        matchHint = `id:${idKey}`;
    }
    // 2. Match diretto per name
    if (!streamId && nameKey && MEDIAHOSTING_CODE_MAP[nameKey] !== undefined) {
        streamId = MEDIAHOSTING_CODE_MAP[nameKey];
        matchHint = `name:${nameKey}`;
    }
    // 3. epgChannelIds
    if (!streamId && Array.isArray(channel.epgChannelIds)) {
        for (const epg of channel.epgChannelIds) {
            const ek = normalizeKey(epg);
            if (ek && MEDIAHOSTING_CODE_MAP[ek] !== undefined) {
                streamId = MEDIAHOSTING_CODE_MAP[ek];
                matchHint = `epg:${ek}`;
                break;
            }
        }
    }

    // Helper: verifica se testo contiene marker italiano
    const hasItaMarker = (txt: string) => /(\b(it|ita|italia|italian)\b|🇮🇹)/i.test(txt);

    // 4. Substring match su name (chiavi lunghe prima per match preciso)
    const keysOrdered = Object.keys(MEDIAHOSTING_CODE_MAP).sort((a, b) => b.length - a.length);
    if (!streamId && nameKey) {
        for (const k of keysOrdered) {
            if (nameKey.includes(k)) {
                const candidate = MEDIAHOSTING_CODE_MAP[k];
                // Per DAZN: richiede marker italiano
                if (/dazn/i.test(k)) {
                    if (!hasItaMarker(channel.name || '')) continue;
                }
                streamId = candidate;
                matchHint = `substrName:${k}`;
                break;
            }
        }
    }
    // 5. Substring match su extraTexts
    if (!streamId && Array.isArray(channel.extraTexts)) {
        for (const raw of channel.extraTexts) {
            const nk = normalizeKey(raw || '');
            if (!nk) continue;
            for (const k of keysOrdered) {
                if (nk.includes(k)) {
                    const candidate = MEDIAHOSTING_CODE_MAP[k];
                    if (/dazn/i.test(k)) {
                        if (!hasItaMarker(raw)) continue;
                    }
                    streamId = candidate;
                    matchHint = `substrExtra:${k}`;
                    break;
                }
            }
            if (streamId) break;
        }
    }

    if (streamId === undefined) return null;
    const displayName = MEDIAHOSTING_DISPLAY_NAME[streamId] || `MH ${streamId}`;
    return { streamId, displayName, matchHint };
}
