/**
 * RM Channel Updater
 * Aggiorna automaticamente il campo staticUrlMpd2 in tv_channels.json con i link MPD
 * Sorgente: env RM_SOURCE_URL
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

// Sorgente M3U da variabile ambiente (per sicurezza)
const RM_SOURCE = process.env.RM_SOURCE_URL || '';

// Mapping nomi canale M3U → vavooName per canali con nomi diversi
const NAME_MAPPING: Record<string, string> = {
    'SKY MTV': 'MTV',
    'SKY HISTORY': 'HISTORY CHANNEL',
    'SKY SPORT BASKET': 'SKY SPORT NBA',
    'SKY TG 24': 'SKY TG24',
    'SKY COMEDY CENTRAL': 'COMEDY CENTRAL',
    'SKY SPORT GOLF': 'SKY SPORT GOLF'
};

interface RmChannel {
    tvg_id: string;
    name: string;
    group: string;
    logo: string;
    url: string;
    keyId?: string;
    key?: string;
}

interface TVChannel {
    id: string;
    name: string;
    vavooNames?: string[];
    staticUrlMpd2?: string;
    [key: string]: any;
}

/**
 * Parse formato M3U
 * Estrae EXTINF metadata: tvg-id, tvg-logo, group-title, channel name
 * Estrae anche #KODIPROP license_key (key_id:key) per DRM
 */
function parseM3U(m3uText: string): RmChannel[] {
    const channels: RmChannel[] = [];
    const lines = m3uText.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith('#EXTINF:')) {
            // Estrae metadata dalla riga EXTINF
            const tvgIdMatch = line.match(/tvg-id="([^"]+)"/);
            const tvgLogoMatch = line.match(/tvg-logo="([^"]+)"/);
            const groupMatch = line.match(/group-title="([^"]+)"/);

            // Nome canale dopo l'ultima virgola (include emoji)
            const commaIndex = line.lastIndexOf(',');
            const rawName = commaIndex >= 0 ? line.substring(commaIndex + 1).trim() : '';

            // Rimuovi (MPD) suffix dal nome
            const name = rawName.replace(/\s*\(MPD\)\s*/g, '').trim();

            // Cerca #KODIPROP license_key e URL nelle righe successive
            // IMPORTANTE: continua a leggere TUTTE le righe del blocco per prendere sia URL che key
            let url = '';
            let keyId = '';
            let key = '';

            for (let j = i + 1; j < lines.length; j++) {
                const nextLine = lines[j].trim();

                // Skip righe vuote
                if (!nextLine) continue;

                // Nuova EXTINF = fine blocco corrente
                if (nextLine.startsWith('#EXTINF:')) {
                    break;
                }

                // Estrae key_id:key da #KODIPROP (può apparire PRIMA o DOPO l'URL)
                if (nextLine.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
                    const licenseKey = nextLine.substring('#KODIPROP:inputstream.adaptive.license_key='.length);
                    const [extractedKeyId, extractedKey] = licenseKey.split(':');
                    if (extractedKeyId && extractedKey && extractedKeyId !== '0000') {
                        keyId = extractedKeyId.trim();
                        key = extractedKey.trim();
                    }
                    continue;
                }

                // Skip altre righe #KODIPROP e #EXTVLCOPT
                if (nextLine.startsWith('#')) {
                    continue;
                }

                // URL è la prima riga non-commento con http/https
                if ((nextLine.startsWith('http://') || nextLine.startsWith('https://')) && !url) {
                    url = nextLine;
                    // NON fare break qui! Continua a cercare la license_key
                }
            }

            // Aggiungi solo se ha URL valido (non vuoto)
            if (url && name) {
                // Se abbiamo key_id e key, aggiungili all'URL come query params
                if (keyId && key) {
                    // FORCE & as separator to ensure addon.ts splits it correctly
                    // Even if URL has no '?', we append &key_id=...
                    // addon.ts splits by '&', taking part[0] as baseUrl and rest as params to append to proxy.
                    // This results in valid Proxy URL: ...?d=url&key_id=...
                    url += `&key_id=${keyId}&key=${key}`;
                }

                channels.push({
                    tvg_id: tvgIdMatch ? tvgIdMatch[1] : '',
                    name: name,
                    group: groupMatch ? groupMatch[1] : '',
                    logo: tvgLogoMatch ? tvgLogoMatch[1] : '',
                    url: url,
                    keyId: keyId || undefined,
                    key: key || undefined
                });
            }
        }
    }

    return channels;
}

/**
 * Normalizza nome canale per matching
 * Rimuove emoji, spazi extra, case-insensitive
 */
function normalizeForMatching(name: string): string {
    return name
        // PRIMA rimuovi sequenze complete digit+variation+keycap (0️⃣-9️⃣)
        .replace(/[0-9]\uFE0F?\u20E3/g, '')
        // POI rimuovi altri emoji e simboli
        .replace(/[\u{1F300}-\u{1F9FF}]/gu, '') // Emoji Unicode BMP Supplementary
        .replace(/[\u{2600}-\u{26FF}]/gu, '') // Emoji Miscellaneous Symbols
        .replace(/[\u{2700}-\u{27BF}]/gu, '') // Dingbats
        .replace(/[\uFE00-\uFE0F]/g, '') // Variation Selectors
        .replace(/[\u20E3]/g, '') // Combining Enclosing Keycap residuo
        .replace(/[\u{E0000}-\u{E007F}]/gu, '') // Tags
        .replace(/📺|🎭|🏎️|🏀/g, '') // Emoji specifiche comuni
        .trim()
        .toUpperCase()
        .replace(/\s+/g, ' '); // Normalizza spazi
}

/**
 * Match nome canale M3U con canale in tv_channels.json
 * Usa tvg-id (priorità) e vavooNames per matching + NAME_MAPPING per nomi speciali
 */
function matchChannel(tvChannels: TVChannel[], rmChannel: RmChannel): TVChannel | null {
    // 1. Match per TVG-ID (Priorità Alta)
    if (rmChannel.tvg_id) {
        const normalizedTvgId = rmChannel.tvg_id.toLowerCase().trim();
        for (const channel of tvChannels) {
            // Match esatto con ID canale
            if (channel.id.toLowerCase() === normalizedTvgId) return channel;

            // Match con EPG IDs
            if (channel.epgChannelIds) {
                for (const epgId of channel.epgChannelIds) {
                    if (epgId.toLowerCase() === normalizedTvgId) return channel;
                }
            }
        }
    }

    const normalizedRmName = normalizeForMatching(rmChannel.name);

    // Prima controlla mapping speciale
    const mappedName = NAME_MAPPING[rmChannel.name.toUpperCase()];
    if (mappedName) {
        const normalizedMapped = normalizeForMatching(mappedName);
        for (const channel of tvChannels) {
            if (channel.vavooNames) {
                for (const vavooName of channel.vavooNames) {
                    if (normalizeForMatching(vavooName) === normalizedMapped) {
                        return channel;
                    }
                }
            }
        }
    }

    for (const channel of tvChannels) {
        // Skip se non ha vavooNames
        if (!channel.vavooNames || channel.vavooNames.length === 0) {
            continue;
        }

        for (const vavooName of channel.vavooNames) {
            const normalizedVavoo = normalizeForMatching(vavooName);

            // Match esatto
            if (normalizedVavoo === normalizedRmName) {
                return channel;
            }

            // Match su numero specifico per canali numerati (251, 252, etc.)
            const rmNumberMatch = normalizedRmName.match(/\b(\d{3})\b$/);
            const vavooNumberMatch = normalizedVavoo.match(/\b(\d{3})\b$/);

            if (rmNumberMatch && vavooNumberMatch) {
                // Se entrambi hanno numero a 3 cifre alla fine, devono matchare ESATTAMENTE
                if (rmNumberMatch[1] !== vavooNumberMatch[1]) {
                    continue;
                }
                // Se numeri matchano, verifica anche prefisso
                const rmPrefix = normalizedRmName.replace(/\s*\d{3}\s*$/, '').trim();
                const vavooPrefix = normalizedVavoo.replace(/\s*\d{3}\s*$/, '').trim();
                if (rmPrefix === vavooPrefix) {
                    return channel;
                }
            }

            // Match su parole chiave specifiche
            if (!rmNumberMatch && !vavooNumberMatch) {
                const rmWords = normalizedRmName.split(' ').filter(w => w.length > 3);
                const vavooWords = normalizedVavoo.split(' ').filter(w => w.length > 3);

                if (rmWords.length >= 2 && vavooWords.length >= 2) {
                    const commonWords = rmWords.filter(w => vavooWords.includes(w));
                    if (commonWords.length >= 2) {
                        return channel;
                    }
                }
            }
        }
    }

    return null;
}

/**
 * Scarica e parsa il file M3U
 */
async function fetchRmChannels(): Promise<RmChannel[]> {
    if (!RM_SOURCE) {
        console.log('[RM] ⚠️  RM_SOURCE_URL non configurato, skip update');
        return [];
    }

    try {
        console.log(`[RM] 📥 Downloading from RM_SOURCE_URL...`);
        const response = await axios.get(RM_SOURCE, {
            timeout: 60000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*'
            }
        });

        const channels = parseM3U(response.data);
        console.log(`[RM] ✅ Parsed ${channels.length} channels`);

        return channels;
    } catch (error: any) {
        console.error(`[RM] ❌ Error downloading: ${error.message}`);
        return [];
    }
}

/**
 * Aggiorna tv_channels.json con campo staticUrlMpd2
 */
export async function updateRmChannels(force: boolean = false, skipReload: boolean = false): Promise<number> {
    try {
        console.log('[RM] 📥 Inizio aggiornamento canali MPD2...');

        // Scarica canali RM
        const rmChannels = await fetchRmChannels();

        if (rmChannels.length === 0) {
            console.log('[RM] ⚠️  Nessun canale scaricato');
            return 0;
        }

        // Filtra solo canali Sky (per questo updater)
        const skyChannels = rmChannels.filter(ch =>
            ch.name.toUpperCase().includes('SKY') ||
            ch.tvg_id.toLowerCase().includes('sky')
        );
        console.log(`[RM] 🎯 Canali Sky trovati: ${skyChannels.length}`);

        // Legge tv_channels.json
        const tvChannelsPath = path.join(__dirname, '../../config/tv_channels.json');
        console.log(`[RM] 📁 Percorso file: ${tvChannelsPath}`);
        const tvChannelsData = fs.readFileSync(tvChannelsPath, 'utf-8');
        const tvChannels: TVChannel[] = JSON.parse(tvChannelsData);

        let updates = 0;
        let matches = 0;
        const matched: string[] = [];
        const unmatched: string[] = [];

        // Match e update
        for (const rmChannel of skyChannels) {
            const matchedChannel = matchChannel(tvChannels, rmChannel);

            if (matchedChannel) {
                matches++;
                const urlBase64 = Buffer.from(rmChannel.url).toString('base64');
                // Aggiorna solo se il link è effettivamente cambiato o se forzato
                if (force || matchedChannel.staticUrlMpd2 !== urlBase64) {
                    matchedChannel.staticUrlMpd2 = urlBase64;
                    updates++;
                    matched.push(`${matchedChannel.name} <- ${rmChannel.name} (UPDATED)`);
                }
            } else {
                unmatched.push(rmChannel.name);
            }
        }

        console.log(`[RM] 📊 Matched ${matches}/${skyChannels.length} channels`);

        // Log risultati
        console.log(`[RM] ✅ Updated ${updates} canali:`);
        for (const m of matched) {
            console.log(`[RM]   ✅ ${m}`);
        }

        if (unmatched.length > 0) {
            console.log(`[RM] ⚠️  Unmatched ${unmatched.length} canali:`);
            for (const u of unmatched) {
                console.log(`[RM]   ❌ ${u}`);
            }
        }

        if (updates > 0) {
            // Salva file aggiornato
            fs.writeFileSync(tvChannelsPath, JSON.stringify(tvChannels, null, 2), 'utf-8');
            console.log(`[RM] ✅ Aggiornati ${updates} canali con staticUrlMpd2`);

            // Trigger reload (se non skipReload)
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
                            console.log('[RM] 🔄 Reload triggerato', data ? JSON.parse(data) : 'ok');
                        });
                    });

                    req.on('error', () => {
                        console.log('[RM] ℹ️  Reload non disponibile');
                    });

                    req.end();
                } catch (err) {
                    console.log('[RM] ⚠️  Errore trigger reload');
                }
            }
        } else {
            console.log('[RM] ℹ️  Nessun canale aggiornato (tutti già aggiornati)');
        }

        return updates;
    } catch (error) {
        console.error('[RM] ❌ Errore aggiornamento:', error);
        return 0;
    }
}

/**
 * Scheduler per aggiornamenti automatici ogni 15 minuti
 */
export function startRmScheduler() {
    // Esegue aggiornamento iniziale dopo 45 secondi (dopo amstaff)
    setTimeout(async () => {
        console.log('[RM] 🚀 Primo aggiornamento all\'avvio...');
        await updateRmChannels();
    }, 45000);

    // Poi ogni 15 minuti (900000 ms)
    setInterval(async () => {
        console.log('[RM] 🔄 Aggiornamento programmato (15min)...');
        await updateRmChannels();
    }, 900000);

    console.log('[RM] 📅 Scheduler attivato: aggiornamenti ogni 15 minuti');
}
