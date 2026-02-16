/**
 * MPDp Channel Updater
 * Aggiorna automaticamente il campo staticUrlMpdp in tv_channels.json
 * usando la lista M3U da PSKY_ENV_URL.
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

const PSKY_ENV_URL = process.env.PSKY_ENV_URL || '';

interface MpdpChannel {
    name: string;
    url: string;
}

interface TVChannel {
    id: string;
    name: string;
    vavooNames?: string[];
    staticUrlMpdp?: string;
    [key: string]: any;
}

/**
 * Rimuove tutte le emoji (incluse quelle composte come keycaps, etc.)
 */
function removeEmojis(str: string): string {
    return str
        .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
        .replace(/[\u{2600}-\u{26FF}]/gu, '')
        .replace(/[\u{2700}-\u{27BF}]/gu, '')
        .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
        .replace(/[\u{20E3}]/gu, '')
        .replace(/[\u{E0020}-\u{E007F}]/gu, '')
        .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
        .replace(/[\u{25A0}-\u{25FF}]/gu, '')  // geometric shapes (◈ etc.)
        .replace(/^[\s\d#*]+(?=\s)/g, '')
        .trim();
}

/**
 * Pulizia specifica per nomi PSky:
 * "IT: SKY CINEMA ACTION (PSky)" → "SKY CINEMA ACTION"
 * "IT◈ Sky Primafila 1 ᴴᴰ (PSky)" → "Sky Primafila 1"
 */
function cleanPskyName(raw: string): string {
    let name = raw;
    // Rimuovi prefisso IT: o IT◈ (con qualsiasi char speciale)
    name = name.replace(/^IT\s*[:◈\u25C8]?\s*/i, '');
    // Rimuovi suffisso (PSky) o (Psky) etc.
    name = name.replace(/\s*\(PSky\)\s*$/i, '');
    // Rimuovi HD, ᴴᴰ, FHD, SD etc.
    name = name.replace(/\s+H\s*D\b/gi, '');
    name = name.replace(/\bHD\b/gi, '');
    name = name.replace(/\bFHD\b/gi, '');
    name = name.replace(/\bSD\b/gi, '');
    name = name.replace(/ᴴᴰ/g, '');
    name = name.replace(/ᴴ/g, '');
    name = name.replace(/ᴰ/g, '');
    // Rimuovi emoji residue
    name = removeEmojis(name);
    return name.replace(/\s+/g, ' ').trim();
}

/**
 * Normalizza un nome canale per il confronto
 */
function normalizeName(name: string): string {
    return cleanPskyName(name)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Normalizza rimuovendo anche gli spazi
 */
function normalizeStrict(name: string): string {
    return normalizeName(name).replace(/\s/g, '');
}

/**
 * Parsa il contenuto M3U e restituisce i canali
 * PSky non ha KODIPROP/clearkey - sono link IPTV diretti
 */
function parseM3u(content: string): MpdpChannel[] {
    const channels: MpdpChannel[] = [];
    const lines = content.split('\n').map(l => l.trim()).filter(l => l);

    let currentName = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith('#EXTINF:')) {
            const nameMatch = line.match(/,([^,]+)$/);
            currentName = nameMatch ? cleanPskyName(nameMatch[1].trim()) : '';
        } else if (line.startsWith('http')) {
            if (currentName) {
                channels.push({ name: currentName, url: line });
            }
            currentName = '';
        }
    }
    return channels;
}

/**
 * Match canale MPDp con tv_channels.json
 */
function matchChannel(tvChannels: TVChannel[], mpdpCh: MpdpChannel): TVChannel | null {
    const mpdpName = mpdpCh.name;
    const normalizedMpdp = normalizeName(mpdpName);
    const strictMpdp = normalizeStrict(mpdpName);

    // Fallback to Name Matching (PSky non ha channel() nelle URL)
    for (const channel of tvChannels) {
        // Match esatto su vavooNames
        if (channel.vavooNames) {
            for (const vn of channel.vavooNames) {
                const normalizedVavoo = normalizeName(vn);
                const strictVavoo = normalizeStrict(vn);

                if (normalizedMpdp === normalizedVavoo) return channel;
                if (strictMpdp === strictVavoo) return channel;
            }
        }

        // Match su name
        const normalizedName = normalizeName(channel.name);
        const strictName = normalizeStrict(channel.name);

        if (normalizedMpdp === normalizedName) return channel;
        if (strictMpdp === strictName) return channel;

        // Match parziale per canali numerati (es. SKY SPORT 251)
        const mpdpNumMatch = normalizedMpdp.match(/(\d{3})$/);
        const nameNumMatch = normalizedName.match(/(\d{3})$/);
        if (mpdpNumMatch && nameNumMatch && mpdpNumMatch[1] === nameNumMatch[1]) {
            const mpdpPrefix = normalizedMpdp.replace(/\s*\d{3}$/, '').trim();
            const namePrefix = normalizedName.replace(/\s*\d{3}$/, '').trim();
            if (mpdpPrefix === namePrefix) return channel;
        }

        // Match "contains" per nomi parziali (es. "SPORT UNO" in "SKY SPORT UNO")
        if (normalizedMpdp.length > 5 && normalizedName.includes(normalizedMpdp)) return channel;
        if (normalizedName.length > 5 && normalizedMpdp.includes(normalizedName)) return channel;
    }

    return null;
}

/**
 * Scarica e aggiorna tv_channels.json con staticUrlMpdp
 */
export async function updateMpdpChannels(force: boolean = false, skipReload: boolean = false): Promise<number> {
    try {
        console.log('[MPDp] Start update...');

        if (!PSKY_ENV_URL) {
            console.error('[MPDp] PSKY_ENV_URL missing');
            return 0;
        }

        const response = await axios.get(PSKY_ENV_URL, {
            timeout: 60000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const m3uContent = typeof response.data === 'string' ? response.data : String(response.data);
        let mpdpChannels = parseM3u(m3uContent);
        console.log(`[MPDp] Parsed ${mpdpChannels.length} channels`);

        if (mpdpChannels.length === 0) {
            console.log('[MPDp] No channels found');
            return 0;
        }

        // Rimuovi duplicati
        const seen = new Set<string>();
        mpdpChannels = mpdpChannels.filter(ch => {
            const key = ch.name.toUpperCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Legge tv_channels.json
        const tvChannelsPath = path.join(__dirname, '../../config/tv_channels.json');
        console.log(`[MPDp] tv_channels.json: ${tvChannelsPath}`);
        const tvChannelsData = fs.readFileSync(tvChannelsPath, 'utf-8');
        const tvChannels: TVChannel[] = JSON.parse(tvChannelsData);

        let updates = 0;
        let matches = 0;

        // Match e update
        for (const mpdpCh of mpdpChannels) {
            const matchedChannel = matchChannel(tvChannels, mpdpCh);

            if (matchedChannel) {
                matches++;
                const urlBase64 = Buffer.from(mpdpCh.url).toString('base64');
                if (force || matchedChannel.staticUrlMpdp !== urlBase64) {
                    matchedChannel.staticUrlMpdp = urlBase64;
                    updates++;
                    console.log(`[MPDp] Updated: ${matchedChannel.name} <- ${mpdpCh.name}`);
                }
            } else {
                // Log unmatched per debug
                // console.log(`[MPDp] Unmatched: ${mpdpCh.name}`);
            }
        }

        console.log(`[MPDp] Matched ${matches}/${mpdpChannels.length} channels`);

        if (updates > 0) {
            fs.writeFileSync(tvChannelsPath, JSON.stringify(tvChannels, null, 2), 'utf-8');
            console.log(`[MPDp] Updated ${updates} channels with staticUrlMpdp`);

            if (!skipReload) {
                try {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    const http = require('http');
                    const options = {
                        hostname: 'localhost',
                        port: process.env.PORT || 7000,
                        path: '/static/reload',
                        method: 'GET',
                        timeout: 3000
                    };
                    const req = http.request(options, (res: any) => {
                        let data = '';
                        res.on('data', (chunk: any) => { data += chunk; });
                        res.on('end', () => {
                            console.log('[MPDp] Reload triggered', data ? JSON.parse(data) : 'ok');
                        });
                    });
                    req.on('error', () => { console.log('[MPDp] Reload not available'); });
                    req.end();
                } catch (err) {
                    console.log('[MPDp] Reload trigger error');
                }
            }
        } else {
            console.log('[MPDp] No updates (already up to date)');
        }

        return updates;
    } catch (error) {
        console.error('[MPDp] Update error:', error);
        return 0;
    }
}

/**
 * Scheduler per aggiornamenti automatici
 */
export function startMpdpScheduler(intervalMs = 1380000) {
    setTimeout(async () => {
        console.log('[MPDp] First update on startup...');
        await updateMpdpChannels();
    }, 65000); // 65s delay (dopo MPDz a 55s)

    setInterval(async () => {
        console.log('[MPDp] Scheduled update (23min)...');
        await updateMpdpChannels();
    }, intervalMs);

    console.log('[MPDp] Scheduler active: update every 23 minutes');
}

// Mantiene compatibilita con vecchio codice
export function getMpdpChannels(): any[] { return []; }
