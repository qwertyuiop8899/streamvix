/**
 * Runtime resolver per canali pa.cc
 *
 * Cerca tra i canali pa.cc caricati dall'M3U un match per nome/id con un canale TV esistente.
 * Restituisce direttamente l'URL stream (già presente nell'M3U, nessun MFP necessario).
 */

function normalizeKey(s?: string): string | null {
    if (!s || typeof s !== 'string') return null;
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export interface PaccMatch {
    channelName: string;
    streamUrl: string;
    matchHint: string;
}

/**
 * Cerca se per un dato canale TV esiste un canale pa.cc corrispondente.
 * Matching per normalizedName substring (bidirezionale).
 * @param channel - il canale TV da cercare
 * @param paccChannels - la lista canali pa.cc (da getPaccChannels())
 */
export function getPaccCode(channel: { id?: string; name?: string; epgChannelIds?: string[]; extraTexts?: string[] }, paccChannels: any[]): PaccMatch | null {
    if (!paccChannels.length) return null;

    const channelNameNorm = normalizeKey(channel.name);
    const channelIdNorm = normalizeKey(channel.id);

    for (const pc of paccChannels) {
        const meta = pc._pacc;
        if (!meta || !meta.streamUrl) continue;
        const paccNameNorm = normalizeKey(meta.channel_name);
        if (!paccNameNorm) continue;

        // 1. Match diretto nome normalizzato
        if (channelNameNorm && channelNameNorm === paccNameNorm) {
            return { channelName: meta.channel_name, streamUrl: meta.streamUrl, matchHint: `exactName:${paccNameNorm}` };
        }

        // 2. Match diretto id normalizzato
        if (channelIdNorm && channelIdNorm === paccNameNorm) {
            return { channelName: meta.channel_name, streamUrl: meta.streamUrl, matchHint: `exactId:${paccNameNorm}` };
        }

        // 3. Substring match bidirezionale su nome (il più lungo contiene il più corto)
        if (channelNameNorm && paccNameNorm.length >= 3) {
            if (channelNameNorm.includes(paccNameNorm) || paccNameNorm.includes(channelNameNorm)) {
                return { channelName: meta.channel_name, streamUrl: meta.streamUrl, matchHint: `substrName:${paccNameNorm}` };
            }
        }

        // 4. epgChannelIds
        if (Array.isArray(channel.epgChannelIds)) {
            for (const epg of channel.epgChannelIds) {
                const ek = normalizeKey(epg);
                if (ek && (ek === paccNameNorm || (ek.length >= 3 && (ek.includes(paccNameNorm) || paccNameNorm.includes(ek))))) {
                    return { channelName: meta.channel_name, streamUrl: meta.streamUrl, matchHint: `epg:${ek}` };
                }
            }
        }

        // 5. extraTexts substring
        if (Array.isArray(channel.extraTexts)) {
            for (const raw of channel.extraTexts) {
                const nk = normalizeKey(raw);
                if (nk && paccNameNorm.length >= 3 && (nk.includes(paccNameNorm) || paccNameNorm.includes(nk))) {
                    return { channelName: meta.channel_name, streamUrl: meta.streamUrl, matchHint: `substrExtra:${paccNameNorm}` };
                }
            }
        }
    }

    return null;
}
