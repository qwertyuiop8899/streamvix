/**
 * Amstaff Channel Updater
 * Aggiorna automaticamente i link staticUrlMpd in tv_channels.json con i link freschi da Amstaff
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

// Mappatura nomi canali Amstaff -> tv_channels.json
const CHANNEL_NAME_MAPPING: Record<string, string> = {
    "SKY CALCIO": "SKY SPORT CALCIO",
    "SKY SPORTS ARENA": "SKY SPORT ARENA",
    "SKY SPORTS MOTOGP": "SKY SPORT MOTOGP",
    "SKY MTV": "MTV",
    "SKY COMEDY CENTRAL": "COMEDY CENTRAL",
    "SKY TG 24": "SKY TG24",
    "SKY SPORT BASKET": "SKY SPORT NBA",
    "SKY CALCIO HD": "SKY SPORT CALCIO",
    // Canali calcio numerati
    "SKY CALCIO 251": "SKY SPORT 251",
    "SKY CALCIO 252": "SKY SPORT 252",
    "SKY CALCIO 253": "SKY SPORT 253",
    "SKY CALCIO 254": "SKY SPORT 254",
    "SKY CALCIO 255": "SKY SPORT 255",
    "SKY CALCIO 256": "SKY SPORT 256",
    "SKY CALCIO 257": "SKY SPORT 257",
    "SKY CALCIO 258": "SKY SPORT 258",
    "SKY CALCIO 259": "SKY SPORT 259",
    "SKY HISTORY": "HISTORY CHANNEL",
    "SKY COLLECTION": "SKY COLLECTION"
};

interface AmstaffChannel {
    title: string;
    encoded: string;
}

interface TVChannel {
    id: string;
    name: string;
    vavooNames?: string[];
    staticUrlMpd?: string;
    [key: string]: any;
}

/**
 * Normalizza il nome del canale
 */
function normalizeChannelName(name: string): string {
    // Cerca prima nel mapping case-insensitive
    const upperName = name.toUpperCase();
    const mappingKey = Object.keys(CHANNEL_NAME_MAPPING).find(
        key => key.toUpperCase() === upperName
    );

    if (mappingKey) {
        return CHANNEL_NAME_MAPPING[mappingKey];
    }

    return name;
}

/**
 * Decodifica URL Amstaff e trasforma formato
 */
function decodeAmstaffUrl(encodedUrl: string): Buffer | null {
    try {
        // Rimuove prefisso amstaff@@
        let base64Str = encodedUrl.startsWith('amstaff@@') ? encodedUrl.substring(9) : encodedUrl;

        // Pulisce newlines e spazi
        base64Str = base64Str.replace(/\n|\r|\s/g, '');

        // Aggiunge padding se necessario
        const missingPadding = base64Str.length % 4;
        if (missingPadding) {
            base64Str += '='.repeat(4 - missingPadding);
        }

        // Decodifica base64
        const decoded = Buffer.from(base64Str, 'base64');

        // Trasforma formato: url|key_id:key -> url&key_id=xxx&key=yyy
        const pipeIndex = decoded.indexOf('|');
        if (pipeIndex !== -1) {
            const baseUrl = decoded.slice(0, pipeIndex);
            const keysPartBuf = decoded.slice(pipeIndex + 1);
            const colonIndex = keysPartBuf.indexOf(':');

            if (colonIndex !== -1) {
                const keyId = keysPartBuf.slice(0, colonIndex);
                const key = keysPartBuf.slice(colonIndex + 1);

                // Costruisce nuovo formato
                return Buffer.concat([
                    baseUrl,
                    Buffer.from('&key_id='),
                    keyId,
                    Buffer.from('&key='),
                    key
                ]);
            }
        }

        return decoded;
    } catch (error) {
        console.error('[AMSTAFF] Errore decodifica URL:', error);
        return null;
    }
}

/**
 * Estrae canali dal JSON Amstaff
 */
function extractChannelsFromJson(data: any): AmstaffChannel[] {
    const channels: AmstaffChannel[] = [];

    function extractRecursive(obj: any) {
        if (typeof obj === 'object' && obj !== null) {
            if ('title' in obj && 'myresolve' in obj) {
                let title = obj.title;
                // Pulisce TUTTI i tag COLOR (cyan, lime, red, ecc.)
                title = title.replace(/\[COLOR [^\]]+\]/gi, '').replace(/\[\/COLOR\]/gi, '').trim();

                const myresolve = obj.myresolve;
                if (myresolve && myresolve.startsWith('amstaff@@')) {
                    channels.push({ title, encoded: myresolve });
                }
            }

            // Continua ricerca ricorsiva
            for (const key of Object.keys(obj)) {
                if (key === 'items' || key === 'channels') {
                    if (Array.isArray(obj[key])) {
                        obj[key].forEach(extractRecursive);
                    }
                } else {
                    extractRecursive(obj[key]);
                }
            }
        } else if (Array.isArray(obj)) {
            obj.forEach(extractRecursive);
        }
    }

    extractRecursive(data);
    return channels;
}

/**
 * Scarica credenziali dal GitHub di Mandrakodi
 */
async function getGithubCredentials(): Promise<{ password: string; deviceId: string }> {
    // aHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL21hbmRyYWtvZGkvbWFuZHJha29kaS5naXRodWIuaW8vbWFpbi9sYXVuY2hlci5weQ==
    const launcherUrl = Buffer.from('aHR0cHM6Ly9yYXcuZ2l0aHVidXNlcmNvbnRlbnQuY29tL21hbmRyYWtvZGkvbWFuZHJha29kaS5naXRodWIuaW8vbWFpbi9sYXVuY2hlci5weQ==', 'base64').toString('utf-8');

    try {
        console.log('[AMSTAFF] 📥 Scaricamento credenziali da GitHub...');
        const response = await axios.get(launcherUrl, { timeout: 10000 });

        // TWFuZHJhS29kaTM= / MksxV1BO
        const password = Buffer.from('TWFuZHJhS29kaTM=', 'base64').toString('utf-8');
        const deviceId = Buffer.from('MksxV1BO', 'base64').toString('utf-8');

        console.log(`[AMSTAFF] ✅ Credenziali: ${password} / ${deviceId}`);
        return { password, deviceId };
    } catch (error) {
        console.log('[AMSTAFF] ⚠️  Usando credenziali di backup...');
        return {
            password: Buffer.from('TWFuZHJhS29kaTM=', 'base64').toString('utf-8'),
            deviceId: Buffer.from('MksxV1BO', 'base64').toString('utf-8')
        };
    }
}

interface AmstaffProcessedChannel {
    name: string;
    url: string; // Base64 encoded
    decodedUrl: string; // Plain text URL for ID extraction
}

/**
 * Match canale Amstaff con tv_channels.json
 */
function matchChannel(tvChannels: TVChannel[], amstaffCh: AmstaffProcessedChannel): TVChannel | null {
    const amstaffName = amstaffCh.name;
    const normalizedAmstaff = normalizeChannelName(amstaffName).toUpperCase();

    // Extract ID from URL if possible
    // URL format: .../channel(skycinemaaction)/...
    const urlIdMatch = amstaffCh.decodedUrl.match(/channel\(([^)]+)\)/);
    const urlId = urlIdMatch ? urlIdMatch[1] : null;

    if (urlId) {
        // Try to match by ID first (very reliable)
        const normalizedUrlId = urlId.toLowerCase().replace(/[^a-z0-9]/g, '');

        for (const channel of tvChannels) {
            const chId = channel.id.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (chId === normalizedUrlId) return channel;

            // Flexible ID matching
            if (chId.length > 3 && normalizedUrlId.includes(chId)) return channel;
            if (normalizedUrlId.length > 3 && chId.includes(normalizedUrlId)) return channel;

            // Check epgChannelIds
            if (channel.epgChannelIds) {
                for (const epgId of channel.epgChannelIds) {
                    if (epgId.toLowerCase().includes(urlId.toLowerCase())) return channel;
                }
            }
        }
    }

    // Fallback to Name Matching (using existing logic)
    for (const channel of tvChannels) {
        if (channel.vavooNames && Array.isArray(channel.vavooNames)) {
            for (const vavooName of channel.vavooNames) {
                // Cerca match case-insensitive
                const normalizedVavooName = vavooName.toUpperCase();
                if (normalizedAmstaff === normalizedVavooName) return channel;
            }
        }
    }
    return null;
}

/**
 * Scarica canali da Amstaff con autenticazione
 */
async function fetchAmstaffChannels(): Promise<AmstaffProcessedChannel[]> {
    // aHR0cHM6Ly90ZXN0MzQzNDQuaGVyb2t1YXBwLmNvbS9maWx0ZXIucGhw
    const BASE_URL = Buffer.from('aHR0cHM6Ly90ZXN0MzQzNDQuaGVyb2t1YXBwLmNvbS9maWx0ZXIucGhw', 'base64').toString('utf-8');
    const VERSION = Buffer.from('Mi4wLjA=', 'base64').toString('utf-8'); // 2.0.0
    const NUM_TEST = Buffer.from('QTFBMjYw', 'base64').toString('utf-8'); // A1A260

    try {
        // Ottieni credenziali
        const { password, deviceId } = await getGithubCredentials();

        // Costruisci User-Agent con autenticazione
        // TWFuZHJhS29kaTI= = MandraKodi2
        const userAgentPrefix = Buffer.from('TWFuZHJhS29kaTI=', 'base64').toString('utf-8');
        const userAgent = `${userAgentPrefix}@@${VERSION}@@${password}@@${deviceId}`;

        // Scarica canali
        const url = `${BASE_URL}?numTest=${NUM_TEST}`;
        console.log(`[AMSTAFF] 🔗 Richiesta: ${url}`);

        const response = await axios.get(url, {
            timeout: 30000,
            headers: {
                'User-Agent': userAgent
            }
        });

        const channels = extractChannelsFromJson(response.data);

        const processedChannels: AmstaffProcessedChannel[] = [];

        for (const channel of channels) {
            const decodedBuffer = decodeAmstaffUrl(channel.encoded);

            if (decodedBuffer) {
                // Ricodifica in base64
                const reencodedBase64 = decodedBuffer.toString('base64');
                const decodedUrlString = decodedBuffer.toString('utf-8');

                // Normalizza nome canale
                const normalizedName = normalizeChannelName(channel.title);

                processedChannels.push({
                    name: normalizedName,
                    url: reencodedBase64,
                    decodedUrl: decodedUrlString
                });
            }
        }

        return processedChannels;
    } catch (error) {
        console.error('[AMSTAFF] Errore download canali:', error);
        return [];
    }
}

/**
 * Aggiorna tv_channels.json con i link Amstaff
 */
export async function updateAmstaffChannels(force: boolean = false): Promise<number> {
    try {
        console.log('[AMSTAFF] 📥 Inizio aggiornamento canali...');

        // Scarica canali Amstaff
        const amstaffChannels = await fetchAmstaffChannels();
        const amstaffCount = amstaffChannels.length;

        if (amstaffCount === 0) {
            console.log('[AMSTAFF] ⚠️  Nessun canale scaricato');
            return 0;
        }

        console.log(`[AMSTAFF] ✅ Scaricati ${amstaffCount} canali`);

        // Legge tv_channels.json dalla STESSA posizione che usa l'addon
        // __dirname è dist/utils/, quindi andiamo a ../../config/ (non ../config/)
        const tvChannelsPath = path.join(__dirname, '../../config/tv_channels.json');
        console.log(`[AMSTAFF] 📁 Percorso file: ${tvChannelsPath}`);
        const tvChannelsData = fs.readFileSync(tvChannelsPath, 'utf-8');
        const tvChannels: TVChannel[] = JSON.parse(tvChannelsData);

        let updates = 0;
        let matches = 0;

        // Aggiorna canali
        for (const amstaffCh of amstaffChannels) {
            const matchedChannel = matchChannel(tvChannels, amstaffCh);

            if (matchedChannel) {
                matches++;
                const newUrl = amstaffCh.url;
                // Aggiorna solo se il link è effettivamente cambiato o se forzato
                if (force || matchedChannel.staticUrlMpd !== newUrl) {
                    matchedChannel.staticUrlMpd = newUrl;
                    updates++;
                    console.log(`[AMSTAFF]   ✅ ${matchedChannel.name} <- ${amstaffCh.name} (UPDATED)`);
                }
            }
        }

        console.log(`[AMSTAFF] 📊 Matched ${matches}/${amstaffChannels.length} channels`);

        if (updates > 0) {
            // Salva file aggiornato
            fs.writeFileSync(tvChannelsPath, JSON.stringify(tvChannels, null, 2), 'utf-8');
            console.log(`[AMSTAFF] ✅ Aggiornati ${updates} canali in tv_channels.json`);

            // Forza il reload dell'addon chiamando l'endpoint interno
            try {
                // Aspetta 1 secondo per assicurarsi che il file sia scritto
                await new Promise(resolve => setTimeout(resolve, 1000));

                // Triggera il reload via HTTP locale (se l'addon è in esecuzione)
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
                        console.log('[AMSTAFF] 🔄 Reload triggerat', data ? JSON.parse(data) : 'ok');
                    });
                });

                req.on('error', (err: any) => {
                    // Silently ignore - addon might not be running yet
                    console.log('[AMSTAFF] ℹ️  Reload non disponibile (addon non ancora avviato?)');
                });

                req.end();
            } catch (err) {
                console.log('[AMSTAFF] ⚠️  Errore trigger reload:', err);
            }
        } else {
            console.log('[AMSTAFF] ℹ️  Nessun canale aggiornato (tutti già aggiornati)');
        }

        return updates;
    } catch (error) {
        console.error('[AMSTAFF] ❌ Errore aggiornamento:', error);
        return 0;
    }
}

/**
 * Scheduler per aggiornamenti automatici ogni ora
 */
export function startAmstaffScheduler() {
    // Esegue aggiornamento iniziale dopo 30 secondi dall'avvio
    setTimeout(async () => {
        console.log('[AMSTAFF] 🚀 Primo aggiornamento all\'avvio...');
        await updateAmstaffChannels();
    }, 30000);

    // Poi ogni ora (3600000 ms)
    setInterval(async () => {
        console.log('[AMSTAFF] 🔄 Aggiornamento orario programmato...');
        await updateAmstaffChannels();
    }, 1200000);

    console.log('[AMSTAFF] 📅 Scheduler attivato: aggiornamenti ogni ora');
}
