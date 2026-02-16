/**
 * MPDz Channel Updater
 * Aggiorna automaticamente il campo staticUrlMpdz in tv_channels.json
 * usando la lista M3U da ZSKY_ENV_URL.
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

const ZSKY_ENV_URL = process.env.ZSKY_ENV_URL || '';

interface MpdzChannel {
    name: string;
    url: string; // Formato: url oppure url&key_id=X&key=Y
}

interface TVChannel {
    id: string;
    name: string;
    vavooNames?: string[];
    staticUrlMpdz?: string;
    [key: string]: any;
}

/**
 * Rimuove tutte le emoji (incluse quelle composte come keycaps, etc.)
 */
function removeEmojis(str: string): string {
    return str
        // Rimuove emoji standard, variation selectors, keycaps, etc.
        .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')
        .replace(/[\u{2600}-\u{26FF}]/gu, '')
        .replace(/[\u{2700}-\u{27BF}]/gu, '')
        .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
        .replace(/[\u{20E3}]/gu, '')
        .replace(/[\u{E0020}-\u{E007F}]/gu, '')
        .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')
        .replace(/^[\s\d#*]+(?=\s)/g, '')
        .trim();
}

/**
 * Normalizza un nome canale per il confronto
 */
function normalizeName(name: string): string {
    return removeEmojis(name)
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
 */
function parseM3u(content: string): MpdzChannel[] {
    const channels: MpdzChannel[] = [];
    const lines = content.split('\n').map(l => l.trim()).filter(l => l);

    let currentName = '';
    let currentKeyId = '';
    let currentKey = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.startsWith('#EXTINF:')) {
            const nameMatch = line.match(/,([^,]+)$/);
            currentName = nameMatch ? removeEmojis(nameMatch[1].trim()) : '';
        } else if (line.includes('license_key=')) {
            const keyMatch = line.match(/license_key=([a-f0-9]+):([a-f0-9]+)/i);
            if (keyMatch) {
                currentKeyId = keyMatch[1];
                currentKey = keyMatch[2];
            }
        } else if (line.startsWith('http')) {
            if (currentName) {
                let url = line;
                if (currentKeyId && currentKey) {
                    url = `${line}&key_id=${currentKeyId}&key=${currentKey}`;
                }
                channels.push({ name: currentName, url });
            }
            currentName = '';
            currentKeyId = '';
            currentKey = '';
        }
    }
    return channels;
}

/**
 * Match canale MPDz con tv_channels.json
 */
function matchChannel(tvChannels: TVChannel[], mpdzCh: MpdzChannel): TVChannel | null {
    const mpdzName = mpdzCh.name;
    const normalizedMpdz = normalizeName(mpdzName);
    const strictMpdz = normalizeStrict(mpdzName);

    // Extract ID from URL if possible
    // URL format: .../channel(skycinemaaction)/...
    const urlIdMatch = mpdzCh.url.match(/channel\(([^)]+)\)/);
    const urlId = urlIdMatch ? urlIdMatch[1] : null;

    if (urlId) {
        // Try to match by ID first (very reliable)
        // Check against channel.id (normalized) or epgChannelIds
        const normalizedUrlId = urlId.toLowerCase().replace(/[^a-z0-9]/g, '');

        for (const channel of tvChannels) {
            const chId = channel.id.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (chId === normalizedUrlId) return channel;

            // Flexible ID matching - require similar length to avoid skyunoplus matching skyuno
            const lenDiff = Math.abs(chId.length - normalizedUrlId.length);
            if (lenDiff <= 2) {
                if (chId.length > 3 && normalizedUrlId.includes(chId)) return channel;
                if (normalizedUrlId.length > 3 && chId.includes(normalizedUrlId)) return channel;
            }

            // Check epgChannelIds
            if (channel.epgChannelIds) {
                for (const epgId of channel.epgChannelIds) {
                    if (epgId.toLowerCase().includes(urlId.toLowerCase())) return channel;
                }
            }
        }
    }

    // Fallback to Name Matching
    for (const channel of tvChannels) {
        // Match esatto su vavooNames
        if (channel.vavooNames) {
            for (const vn of channel.vavooNames) {
                const normalizedVavoo = normalizeName(vn);
                const strictVavoo = normalizeStrict(vn);

                if (normalizedMpdz === normalizedVavoo) return channel;
                if (strictMpdz === strictVavoo) return channel;
            }
        }

        // Match su name
        const normalizedName = normalizeName(channel.name);
        const strictName = normalizeStrict(channel.name);

        if (normalizedMpdz === normalizedName) return channel;
        if (strictMpdz === strictName) return channel;

        // Match parziale per canali numerati (es. SKY SPORT 251)
        const mpdzNumMatch = normalizedMpdz.match(/(\d{3})$/);
        const nameNumMatch = normalizedName.match(/(\d{3})$/);
        if (mpdzNumMatch && nameNumMatch && mpdzNumMatch[1] === nameNumMatch[1]) {
            const mpdzPrefix = normalizedMpdz.replace(/\s*\d{3}$/, '').trim();
            const namePrefix = normalizedName.replace(/\s*\d{3}$/, '').trim();
            if (mpdzPrefix === namePrefix) return channel;
        }

        // Match "contains" per nomi parziali (es. "SPORT UNO" in "SKY SPORT UNO")
        if (normalizedMpdz.length > 5 && normalizedName.includes(normalizedMpdz)) return channel;
        if (normalizedName.length > 5 && normalizedMpdz.includes(normalizedName)) return channel;
    }

    return null;
}

/**
 * Scarica e aggiorna tv_channels.json con staticUrlMpdz
 */
export async function updateMpdzChannels(force: boolean = false, skipReload: boolean = false): Promise<number> {
    try {
        console.log('[MPDz] Start update...');

        if (!ZSKY_ENV_URL) {
            console.error('[MPDz] ZSKY_ENV_URL missing');
            return 0;
        }

        const response = await axios.get(ZSKY_ENV_URL, {
            timeout: 60000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });

        const m3uContent = typeof response.data === 'string' ? response.data : String(response.data);
        let mpdzChannels = parseM3u(m3uContent);
        console.log(`[MPDz] Parsed ${mpdzChannels.length} channels`);

        if (mpdzChannels.length === 0) {
            console.log('[MPDz] No channels found');
            return 0;
        }

        // Rimuovi duplicati
        const seen = new Set<string>();
        mpdzChannels = mpdzChannels.filter(ch => {
            const key = ch.name.toUpperCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Legge tv_channels.json
        const tvChannelsPath = path.join(__dirname, '../../config/tv_channels.json');
        console.log(`[MPDz] tv_channels.json: ${tvChannelsPath}`);
        const tvChannelsData = fs.readFileSync(tvChannelsPath, 'utf-8');
        const tvChannels: TVChannel[] = JSON.parse(tvChannelsData);

        let updates = 0;
        let matches = 0;

        // Match e update
        for (const mpdzCh of mpdzChannels) {
            const matchedChannel = matchChannel(tvChannels, mpdzCh);

            if (matchedChannel) {
                matches++;
                const urlBase64 = Buffer.from(mpdzCh.url).toString('base64');
                if (force || matchedChannel.staticUrlMpdz !== urlBase64) {
                    matchedChannel.staticUrlMpdz = urlBase64;
                    updates++;
                    console.log(`[MPDz] Updated: ${matchedChannel.name} <- ${mpdzCh.name}`);
                }
            }
        }

        console.log(`[MPDz] Matched ${matches}/${mpdzChannels.length} channels`);

        if (updates > 0) {
            fs.writeFileSync(tvChannelsPath, JSON.stringify(tvChannels, null, 2), 'utf-8');
            console.log(`[MPDz] Updated ${updates} channels with staticUrlMpdz`);

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
                            console.log('[MPDz] Reload triggered', data ? JSON.parse(data) : 'ok');
                        });
                    });
                    req.on('error', () => { console.log('[MPDz] Reload not available'); });
                    req.end();
                } catch (err) {
                    console.log('[MPDz] Reload trigger error');
                }
            }
        } else {
            console.log('[MPDz] No updates (already up to date)');
        }

        return updates;
    } catch (error) {
        console.error('[MPDz] Update error:', error);
        return 0;
    }
}

/**
 * Scheduler per aggiornamenti automatici
 */
export function startMpdzScheduler(intervalMs = 1380000) {
    setTimeout(async () => {
        console.log('[MPDz] First update on startup...');
        await updateMpdzChannels();
    }, 55000);

    setInterval(async () => {
        console.log('[MPDz] Scheduled update (23min)...');
        await updateMpdzChannels();
    }, intervalMs);

    console.log('[MPDz] Scheduler active: update every 23 minutes');
}

// Mantiene compatibilita con vecchio codice
export function getMpdzChannels(): any[] { return []; }
