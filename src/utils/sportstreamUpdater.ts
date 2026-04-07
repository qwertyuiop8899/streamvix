/**
 * SportStream channels & updater
 *
 * Canali live da SportStreaming (XUI).
 * La base URL viene letta da process.env.SPS_ENV.
 * Ogni canale ha solo l'ID numerico (es. 1600) — l'URL finale è: ${SPS_ENV}/${id}.m3u8
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;

interface SportStreamChannelDef {
    streamId: string;      // es. "1600"
    name: string;          // es. "Rai 2"
    group: string;         // es. "Standard", "Sky Sport", etc.
    logo?: string;
}

// ===== CHANNEL DEFINITIONS =====
const SPORTSTREAM_CHANNELS: SportStreamChannelDef[] = [
    // ── Standard ──
    { streamId: '1599', name: 'Rai 1',         group: 'Standard' },
    { streamId: '1600', name: 'Rai 2',         group: 'Standard' },
    { streamId: '1601', name: 'Rai 3',         group: 'Standard' },
    { streamId: '1602', name: 'Rete 4',        group: 'Standard' },
    { streamId: '1603', name: 'Canale 5',      group: 'Standard' },
    { streamId: '1604', name: 'Italia 1',      group: 'Standard' },
    { streamId: '1667', name: '20 Mediaset',   group: 'Standard' },

    // ── Sky Sport ──
    { streamId: '1606', name: 'Sky Sport Uno',    group: 'Sky Sport' },
    { streamId: '1607', name: 'Sky Sport Max',    group: 'Sky Sport' },
    { streamId: '1608', name: 'Sky Sport Arena',  group: 'Sky Sport' },
    { streamId: '1609', name: 'Sky Sport Calcio', group: 'Sky Sport' },
    { streamId: '1610', name: 'Sky Sport 251',    group: 'Sky Sport' },
    { streamId: '1611', name: 'Sky Sport 252',    group: 'Sky Sport' },
    { streamId: '1612', name: 'Sky Sport 253',    group: 'Sky Sport' },
    { streamId: '1613', name: 'Sky Sport 254',    group: 'Sky Sport' },
    { streamId: '1614', name: 'Sky Sport 255',    group: 'Sky Sport' },
    { streamId: '1615', name: 'Sky Sport 256',    group: 'Sky Sport' },
    { streamId: '1616', name: 'Sky Sport 257',    group: 'Sky Sport' },
    { streamId: '1617', name: 'Sky Sport 258',    group: 'Sky Sport' },
    { streamId: '1618', name: 'Sky Sport 259',    group: 'Sky Sport' },
    { streamId: '1619', name: 'Sky Sport 24',     group: 'Sky Sport' },
    { streamId: '1620', name: 'Sky Sport F1',     group: 'Sky Sport' },
    { streamId: '1621', name: 'Sky Sport MotoGP', group: 'Sky Sport' },
    { streamId: '1622', name: 'Sky Sport Basket',  group: 'Sky Sport' },
    { streamId: '1623', name: 'Sky Sport Tennis',  group: 'Sky Sport' },
    { streamId: '1666', name: 'Sky Sport Golf',    group: 'Sky Sport' },
    { streamId: '1669', name: 'Sky Sport Mix',     group: 'Sky Sport' },

    // ── Eurosport ──
    { streamId: '1707', name: 'Eurosport 1', group: 'Eurosport' },
    { streamId: '1708', name: 'Eurosport 2', group: 'Eurosport' },

    // ── Dazn Serie A ──
    { streamId: '1624', name: 'Zona Serie A',  group: 'Dazn Serie A' },
    { streamId: '1625', name: 'Atalanta',      group: 'Dazn Serie A' },
    { streamId: '1626', name: 'Bologna',       group: 'Dazn Serie A' },
    { streamId: '1627', name: 'Cagliari',      group: 'Dazn Serie A' },
    { streamId: '1630', name: 'Fiorentina',    group: 'Dazn Serie A' },
    { streamId: '1631', name: 'Genoa',         group: 'Dazn Serie A' },
    { streamId: '1632', name: 'Hellas Verona',  group: 'Dazn Serie A' },
    { streamId: '1633', name: 'Inter',          group: 'Dazn Serie A' },
    { streamId: '1634', name: 'Juventus',       group: 'Dazn Serie A' },
    { streamId: '1635', name: 'Lazio',          group: 'Dazn Serie A' },
    { streamId: '1636', name: 'Lecce',          group: 'Dazn Serie A' },
    { streamId: '1637', name: 'Milan',          group: 'Dazn Serie A' },
    { streamId: '1639', name: 'Napoli',         group: 'Dazn Serie A' },
    { streamId: '1640', name: 'Parma',          group: 'Dazn Serie A' },
    { streamId: '1641', name: 'Roma',           group: 'Dazn Serie A' },
    { streamId: '1642', name: 'Torino',         group: 'Dazn Serie A' },
    { streamId: '1643', name: 'Udinese',        group: 'Dazn Serie A' },
    { streamId: '1663', name: 'Sassuolo',       group: 'Dazn Serie A' },
    { streamId: '1659', name: 'Pisa',           group: 'Dazn Serie A' },
    { streamId: '1653', name: 'Cremonese',      group: 'Dazn Serie A' },
    { streamId: '1628', name: 'Como',           group: 'Dazn Serie A' },

    // ── Dazn Serie B ──
    { streamId: '1645', name: 'Zona Serie B',    group: 'Dazn Serie B' },
    { streamId: '1646', name: 'Bari',            group: 'Dazn Serie B' },
    { streamId: '1647', name: 'Pescara',         group: 'Dazn Serie B' },
    { streamId: '1648', name: 'Carrarese',       group: 'Dazn Serie B' },
    { streamId: '1649', name: 'Catanzaro',       group: 'Dazn Serie B' },
    { streamId: '1650', name: 'Cesena',          group: 'Dazn Serie B' },
    { streamId: '1651', name: 'Virtus Entella',  group: 'Dazn Serie B' },
    { streamId: '1652', name: 'Avellino',        group: 'Dazn Serie B' },
    { streamId: '1654', name: 'Frosinone',       group: 'Dazn Serie B' },
    { streamId: '1655', name: 'Juve Stabia',     group: 'Dazn Serie B' },
    { streamId: '1656', name: 'Mantova',         group: 'Dazn Serie B' },
    { streamId: '1657', name: 'Modena',          group: 'Dazn Serie B' },
    { streamId: '1658', name: 'Palermo',         group: 'Dazn Serie B' },
    { streamId: '1660', name: 'Reggiana',        group: 'Dazn Serie B' },
    { streamId: '1661', name: 'Sampdoria',       group: 'Dazn Serie B' },
    { streamId: '1662', name: 'Padova',          group: 'Dazn Serie B' },
    { streamId: '1664', name: 'Spezia',          group: 'Dazn Serie B' },
    { streamId: '1665', name: 'Sudtirol',        group: 'Dazn Serie B' },
    { streamId: '1629', name: 'Empoli',          group: 'Dazn Serie B' },
    { streamId: '1638', name: 'Monza',           group: 'Dazn Serie B' },
    { streamId: '1644', name: 'Venezia',         group: 'Dazn Serie B' },

    // ── Amazon Prime ──
    { streamId: '1605', name: 'Amazon Prime Eventi', group: 'Amazon Prime' },

    // ── Sky Intrattenimento ──
    { streamId: '1670', name: 'Sky Uno',              group: 'Sky Intrattenimento' },
    { streamId: '1671', name: 'Sky Serie',             group: 'Sky Intrattenimento' },
    { streamId: '1672', name: 'Sky Atlantic',          group: 'Sky Intrattenimento' },
    { streamId: '1673', name: 'Sky Investigation',     group: 'Sky Intrattenimento' },
    { streamId: '1674', name: 'Sky Documentaries',     group: 'Sky Intrattenimento' },
    { streamId: '1675', name: 'Sky Nature',            group: 'Sky Intrattenimento' },
    { streamId: '1676', name: 'Sky Arte',              group: 'Sky Intrattenimento' },
    { streamId: '1677', name: 'Sky Crime',             group: 'Sky Intrattenimento' },
    { streamId: '1678', name: 'Sky Adventure',         group: 'Sky Intrattenimento' },
    { streamId: '1679', name: 'Sky TG24',              group: 'Sky Intrattenimento' },

    // ── Sky Cinema ──
    { streamId: '1680', name: 'Sky Cinema Uno',         group: 'Sky Cinema' },
    { streamId: '1681', name: 'Sky Cinema Due',         group: 'Sky Cinema' },
    { streamId: '1682', name: 'Sky Cinema Action',      group: 'Sky Cinema' },
    { streamId: '1683', name: 'Sky Cinema Suspense',    group: 'Sky Cinema' },
    { streamId: '1684', name: 'Sky Cinema Family',      group: 'Sky Cinema' },
    { streamId: '1685', name: 'Sky Cinema Collection',  group: 'Sky Cinema' },
    { streamId: '1686', name: 'Sky Cinema Romance',     group: 'Sky Cinema' },
    { streamId: '1687', name: 'Sky Cinema Drama',       group: 'Sky Cinema' },
    { streamId: '1688', name: 'Sky Cinema Comedy',      group: 'Sky Cinema' },
    { streamId: '1689', name: 'Sky Cinema Uno +24',     group: 'Sky Cinema' },
    { streamId: '1690', name: 'Sky Cinema Due +24',     group: 'Sky Cinema' },

    // ── Sky Primafila ──
    { streamId: '1691', name: 'Vetrina Sky Primafila Premiere', group: 'Sky Primafila' },
    { streamId: '1692', name: 'Sky Primafila Premiere 1',       group: 'Sky Primafila' },
    { streamId: '1693', name: 'Sky Primafila Premiere 2',       group: 'Sky Primafila' },
    { streamId: '1694', name: 'Sky Primafila Premiere 3',       group: 'Sky Primafila' },
    { streamId: '1695', name: 'Sky Primafila Premiere 4',       group: 'Sky Primafila' },
    { streamId: '1696', name: 'Sky Primafila Premiere 5',       group: 'Sky Primafila' },
    { streamId: '1697', name: 'Sky Primafila Premiere 6',       group: 'Sky Primafila' },
    { streamId: '1698', name: 'Sky Primafila Premiere 7',       group: 'Sky Primafila' },
    { streamId: '1699', name: 'Sky Primafila Premiere 8',       group: 'Sky Primafila' },
    { streamId: '1700', name: 'Sky Primafila Premiere 9',       group: 'Sky Primafila' },
    { streamId: '1701', name: 'Sky Primafila Premiere 10',      group: 'Sky Primafila' },
];

// Referer / Origin da usare per lo streaming
const SPS_REFERER = 'https://xuione.sportstreaming.net/';
const SPS_ORIGIN  = 'https://xuione.sportstreaming.net';
const SPS_UA      = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ===== CACHE =====
let cachedChannels: any[] = [];
const UPDATE_INTERVAL = 30 * 60 * 1000; // 30 min

export function getSportStreamChannels() {
    return cachedChannels;
}

/** Headers necessari per il playback */
export function getSportStreamHeaders(): Record<string, string> {
    return {
        'Referer': SPS_REFERER,
        'Origin': SPS_ORIGIN,
        'User-Agent': SPS_UA,
    };
}

/** Costruisce l'URL M3U8 completo da SPS_ENV + streamId */
export function buildSportStreamUrl(streamId: string): string | null {
    const base = (process.env.SPS_ENV || '').replace(/\/+$/, '');
    if (!base) {
        console.warn('[SportStream] ⚠️ SPS_ENV non impostata');
        return null;
    }
    return `${base}/${streamId}.m3u8`;
}

export async function updateSportStreamChannels(): Promise<number> {
    try {
        const base = (process.env.SPS_ENV || '').replace(/\/+$/, '');
        if (!base) {
            console.warn('[SportStream] ⚠️ SPS_ENV non impostata, skip update');
            cachedChannels = [];
            return 0;
        }

        console.log('[SportStream] 🔄 Building channel list...');

        const defaultLogo = 'https://i.postimg.cc/htXTcZ4r/Sky-Dazn-removebg-preview.png';

        const channels = SPORTSTREAM_CHANNELS.map((ch) => ({
            id: `ss_${ch.streamId}`,
            name: ch.name,
            description: `${ch.group} | SportStream`,
            logo: ch.logo || defaultLogo,
            poster: ch.logo || defaultLogo,
            background: ch.logo || defaultLogo,
            type: 'tv',
            category: 'sportstream',
            posterShape: 'square',
            _dynamic: true,
            _sportstream: {
                stream_id: ch.streamId,
                channel_name: ch.name,
                group: ch.group,
            }
        }));

        cachedChannels = channels;
        console.log(`[SportStream] ✅ Loaded ${channels.length} channels (base: ${base.substring(0, 40)}...)`);
        return channels.length;
    } catch (e: any) {
        console.error(`[SportStream] ❌ Update failed: ${e.message}`);
        return 0;
    }
}

export function startSportStreamScheduler() {
    updateSportStreamChannels(); // Initial run
    setInterval(updateSportStreamChannels, UPDATE_INTERVAL);
}

// ===== CHANNEL MATCHING (per iniezione dinamica negli eventi) =====

// Mappa nome normalizzato -> stream ID SportStream
export const SPORTSTREAM_CODE_MAP: Record<string, string> = {
    // Dazn / Zona
    dazn1: '1624',      // Zona Serie A (il "DAZN 1" generico)
    dazn: '1624',
    zonadazn: '1624',
    zonaseriea: '1624',
    zonaserieb: '1645',
    // Sky Sport
    skysportuno: '1606',
    skysport1: '1606',
    skysportmax: '1607',
    skysportarena: '1608',
    skysportcalcio: '1609',
    skysport251: '1610',
    skysport252: '1611',
    skysport253: '1612',
    skysport254: '1613',
    skysport255: '1614',
    skysport256: '1615',
    skysport257: '1616',
    skysport258: '1617',
    skysport259: '1618',
    skysport24: '1619',
    skysportf1: '1620',
    skysportmotogp: '1621',
    skysportbasket: '1622',
    skysporttennis: '1623',
    skysportgolf: '1666',
    skysportmix: '1669',
    // Eurosport
    eurosport1: '1707',
    eurosport2: '1708',
    // Amazon
    amazonprime: '1605',
    amazonprimeeventi: '1605',
};

// Nome visuale da mostrare nello stream
export const SPORTSTREAM_DISPLAY_NAME: Record<string, string> = {};
// Popola automaticamente dalla lista canali
for (const ch of SPORTSTREAM_CHANNELS) {
    SPORTSTREAM_DISPLAY_NAME[ch.streamId] = ch.name;
}

function normalizeKey(s?: string): string | null {
    if (!s || typeof s !== 'string') return null;
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Dato un canale (id, name, epgChannelIds, extraTexts), restituisce lo stream ID
 * SportStream corrispondente — oppure null se nessun match.
 * Pattern identico a getMediaHostingCode() in mediahosting.ts.
 */
export function getSportStreamCode(channel: {
    id?: string;
    name?: string;
    epgChannelIds?: string[];
    extraTexts?: string[];
}): { streamId: string; displayName: string; matchHint: string } | null {
    const idKey = normalizeKey(channel.id);
    const nameKey = normalizeKey(channel.name);
    let streamId: string | undefined;
    let matchHint = '';

    // 1. Match diretto per id
    if (!streamId && idKey && SPORTSTREAM_CODE_MAP[idKey] !== undefined) {
        streamId = SPORTSTREAM_CODE_MAP[idKey];
        matchHint = `id:${idKey}`;
    }
    // 2. Match diretto per name
    if (!streamId && nameKey && SPORTSTREAM_CODE_MAP[nameKey] !== undefined) {
        streamId = SPORTSTREAM_CODE_MAP[nameKey];
        matchHint = `name:${nameKey}`;
    }
    // 3. epgChannelIds
    if (!streamId && Array.isArray(channel.epgChannelIds)) {
        for (const epg of channel.epgChannelIds) {
            const ek = normalizeKey(epg);
            if (ek && SPORTSTREAM_CODE_MAP[ek] !== undefined) {
                streamId = SPORTSTREAM_CODE_MAP[ek];
                matchHint = `epg:${ek}`;
                break;
            }
        }
    }

    // Helper: verifica marker italiano
    const hasItaMarker = (txt: string) => /(\b(it|ita|italia|italian)\b|🇮🇹)/i.test(txt);

    // 4. Substring match su name (chiavi più lunghe prima)
    const keysOrdered = Object.keys(SPORTSTREAM_CODE_MAP).sort((a, b) => b.length - a.length);
    if (!streamId && nameKey) {
        for (const k of keysOrdered) {
            if (nameKey.includes(k)) {
                const candidate = SPORTSTREAM_CODE_MAP[k];
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
                    const candidate = SPORTSTREAM_CODE_MAP[k];
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
    const displayName = SPORTSTREAM_DISPLAY_NAME[streamId] || `SS ${streamId}`;
    return { streamId, displayName, matchHint };
}

// ===== TEAM MATCHING: cerca nomi squadre nel titolo evento =====
// Mappa normalizzata nome squadra → streamId (solo canali DAZN squadra, escluse Zone generiche)
const TEAM_NAME_MAP: Record<string, string> = {};
for (const ch of SPORTSTREAM_CHANNELS) {
    if ((ch.group === 'Dazn Serie A' || ch.group === 'Dazn Serie B') && !/zona/i.test(ch.name)) {
        const key = ch.name.toLowerCase().replace(/[^a-z0-9]+/g, '');
        TEAM_NAME_MAP[key] = ch.streamId;
    }
}
// Alias comuni (nomi alternativi/abbreviazioni)
TEAM_NAME_MAP['acmilan'] = '1637';
TEAM_NAME_MAP['sscnapoli'] = '1639';
TEAM_NAME_MAP['juve'] = '1634';
TEAM_NAME_MAP['hellasverona'] = '1632';
TEAM_NAME_MAP['verona'] = '1632';
TEAM_NAME_MAP['juvestabia'] = '1655';
TEAM_NAME_MAP['virtusentella'] = '1651';
TEAM_NAME_MAP['entella'] = '1651';

/**
 * Dato il nome di un evento (es. "Milan - Napoli"), ritorna tutti i canali DAZN squadra
 * corrispondenti alle squadre menzionate, escludendo canali già trovati da getSportStreamCode.
 * @param eventName - Nome evento (es. "Milan - Napoli", "Inter vs Juventus")
 * @param excludeStreamIds - Set di streamId già iniettati (per evitare doppioni)
 * @returns Array di { streamId, displayName, matchHint }
 */
export function getSportStreamTeamMatches(
    eventName: string,
    excludeStreamIds?: Set<string>
): { streamId: string; displayName: string; matchHint: string }[] {
    if (!eventName || typeof eventName !== 'string') return [];
    const results: { streamId: string; displayName: string; matchHint: string }[] = [];
    const seen = new Set<string>(excludeStreamIds || []);
    // Normalizza nome evento
    const normalized = eventName.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
    // Ordina chiavi per lunghezza decrescente (match più specifici prima)
    const teamKeys = Object.keys(TEAM_NAME_MAP).sort((a, b) => b.length - a.length);
    for (const key of teamKeys) {
        const sid = TEAM_NAME_MAP[key];
        if (seen.has(sid)) continue;
        // Word boundary match: cerca il nome squadra come parola intera nel nome evento
        const regex = new RegExp(`\\b${key}\\b`, 'i');
        if (regex.test(normalized)) {
            seen.add(sid);
            const display = SPORTSTREAM_DISPLAY_NAME[sid] || `DAZN ${key}`;
            results.push({ streamId: sid, displayName: display, matchHint: `team:${key}` });
        }
    }
    return results;
}
