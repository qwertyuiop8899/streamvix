/**
 * RM Channel Updater
 * Aggiorna automaticamente il campo staticUrlMpd2 in tv_channels.json con i link MPD
 * Parsing di playlist M3U con emoji nei nomi
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

// URL base64-encoded dei 3 file M3U (come amstaff pattern)
const RM_SOURCES = [
    'aHR0cHM6Ly9hbWF0aWF6LmNvbS9pdGFsaWEvREFMTEFTL0xBS0VSUy9YUk9NL0pTLVBMQVlFUi1MSVNUL0VQRy1MSVNULU0zVS94cm9tLWl0YWxpYS1pbnRyYXR0ZW5pbWVudG9fLV90Zy5qc29u',
    'aHR0cHM6Ly9hbWF0aWF6LmNvbS9pdGFsaWEvREFMTEFTL0xBS0VSUy9YUk9NL0pTLVBMQVlFUi1MSVNUL0VQRy1MSVNULU0zVS94cm9tLWl0YWxpYS1zcG9ydHNfLV90Zy5qc29u',
    'aHR0cHM6Ly9hbWF0aWF6LmNvbS9pdGFsaWEvREFMTEFTL0xBS0VSUy9YUk9NL0pTLVBMQVlFUi1MSVNUL0VQRy1MSVNULU0zVS94cm9tLWl0YWxpYS1jaW5lbWFfLV90Zy5qc29u'
];

// Mapping tvg-id → vavooName per canali con nomi diversi
const TVG_ID_MAPPING: Record<string, string> = {
    'Sky.Sport.24.it': 'SKY SPORT 24',
    'Sky.Sport.NBA.it': 'SKY SPORT NBA',
    'Sky.Sport.Golf.it': 'SKY SPORT GOLF',  // TODO: aggiungere in tv_channels se non presente
    'sky.tg24.it': 'SKY TG24',  // RM ha "SKY TG 24" (con spazio), vavooName è "SKY TG24" (senza)
    'history.it': 'HISTORY CHANNEL',
    'MTV.HD.it': 'MTV',
    'Sky.Serie.Maratone.it': 'SKY COLLECTION'  // Sky Collection = Sky Serie Maratone
};

interface RmChannel {
    tvg_id: string;
    name: string;
    group: string;
    logo: string;
    url: string;
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
            const name = commaIndex >= 0 ? line.substring(commaIndex + 1).trim() : '';
            
            // Cerca #KODIPROP license_key e URL nelle righe successive
            let url = '';
            let keyId = '';
            let key = '';
            
            for (let j = i + 1; j < lines.length; j++) {
                const nextLine = lines[j].trim();
                
                // Skip righe vuote
                if (!nextLine) continue;
                
                // Estrae key_id:key da #KODIPROP
                if (nextLine.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
                    const licenseKey = nextLine.substring('#KODIPROP:inputstream.adaptive.license_key='.length);
                    const [extractedKeyId, extractedKey] = licenseKey.split(':');
                    if (extractedKeyId && extractedKey) {
                        keyId = extractedKeyId.trim();
                        key = extractedKey.trim();
                    }
                    continue;
                }
                
                // URL è la prima riga non-commento
                if (!nextLine.startsWith('#')) {
                    url = nextLine;
                    
                    // Se abbiamo key_id e key, aggiungili all'URL
                    if (keyId && key) {
                        url += `&key_id=${keyId}&key=${key}`;
                    }
                    break;
                }
            }
            
            if (url && tvgIdMatch) {
                channels.push({
                    tvg_id: tvgIdMatch[1],
                    name: name,
                    group: groupMatch ? groupMatch[1] : '',
                    logo: tvgLogoMatch ? tvgLogoMatch[1] : '',
                    url: url
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
        .replace(/[\u{2600}-\u{26FF}]/gu, '') // Emoji Miscellaneous Symbols (⚽, ⛳, etc.)
        .replace(/[\u{2700}-\u{27BF}]/gu, '') // Dingbats (✂️, ✏️, etc.)
        .replace(/[\uFE00-\uFE0F]/g, '') // Variation Selectors (FE0F per emoji colorate)
        .replace(/[\u20E3]/g, '') // Combining Enclosing Keycap residuo
        .replace(/[\u{E0000}-\u{E007F}]/gu, '') // Tags
        .replace(/📺|🎭|🏎️|🏀/g, '') // Emoji specifiche comuni
        .trim()
        .toUpperCase()
        .replace(/\s+/g, ' '); // Normalizza spazi
}

/**
 * Match tvg-id con canale in tv_channels.json
 * Usa SOLO vavooNames per evitare false positive
 */
function matchChannel(tvChannels: TVChannel[], rmChannel: RmChannel): TVChannel | null {
    const normalizedRmName = normalizeForMatching(rmChannel.name);
    const tvgIdLower = rmChannel.tvg_id.toLowerCase();
    
    // Prima controlla mapping speciale tvg-id
    const mappedName = TVG_ID_MAPPING[rmChannel.tvg_id];
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
        // Skip se non ha vavooNames (troppo rischioso fare match generico)
        if (!channel.vavooNames || channel.vavooNames.length === 0) {
            continue;
        }
        
        // 1. Matching ESATTO su tvg-id (se presente in vavooNames)
        if (channel.vavooNames.some(v => v.toLowerCase() === tvgIdLower)) {
            return channel;
        }
        
        // 2. Matching ESATTO su nome normalizzato (vavooNames)
        for (const vavooName of channel.vavooNames) {
            const normalizedVavoo = normalizeForMatching(vavooName);
            
            // Match esatto
            if (normalizedVavoo === normalizedRmName) {
                return channel;
            }
            
            // NUOVO: Match su numero specifico per canali numerati (251, 252, etc.)
            // Estrae numeri a 3 cifre dalla fine del nome (es. "SKY SPORT 251" -> "251")
            const rmNumberMatch = normalizedRmName.match(/\b(\d{3})\b$/);
            const vavooNumberMatch = normalizedVavoo.match(/\b(\d{3})\b$/);
            
            if (rmNumberMatch && vavooNumberMatch) {
                // Se entrambi hanno numero a 3 cifre alla fine, devono matchare ESATTAMENTE
                if (rmNumberMatch[1] !== vavooNumberMatch[1]) {
                    continue; // Numeri diversi = NO match
                }
                // Se numeri matchano, verifica anche prefisso (es. "SKY SPORT")
                const rmPrefix = normalizedRmName.replace(/\s*\d{3}\s*$/, '').trim();
                const vavooPrefix = normalizedVavoo.replace(/\s*\d{3}\s*$/, '').trim();
                if (rmPrefix === vavooPrefix) {
                    return channel; // Match perfetto: stesso prefisso + stesso numero
                }
            }
            
            // Match su parole chiave specifiche (evita match generico "SKY" o "SPORT")
            // IMPORTANTE: Solo se NON ci sono numeri a 3 cifre (evita match generico "SKY SPORT" per canali numerati)
            if (!rmNumberMatch && !vavooNumberMatch) {
                // Richiede almeno 2 parole in comune E lunghezza nome > 8 caratteri
                const rmWords = normalizedRmName.split(' ').filter(w => w.length > 3);
                const vavooWords = normalizedVavoo.split(' ').filter(w => w.length > 3);
                
                if (rmWords.length >= 2 && vavooWords.length >= 2) {
                    const commonWords = rmWords.filter(w => vavooWords.includes(w));
                    
                    // Se hanno almeno 2 parole significative in comune
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
 * Scarica e parsa tutti i file M3U
 */
async function fetchRmChannels(): Promise<Record<string, string>> {
    const allChannels: RmChannel[] = [];
    
    for (let i = 0; i < RM_SOURCES.length; i++) {
        const url = Buffer.from(RM_SOURCES[i], 'base64').toString('utf-8');
        
        try {
            console.log(`[RM] 📥 Downloading source ${i + 1}/3...`);
            const response = await axios.get(url, { timeout: 30000 });
            
            const channels = parseM3U(response.data);
            console.log(`[RM]   ✅ Parsed ${channels.length} channels`);
            
            allChannels.push(...channels);
        } catch (error: any) {
            console.error(`[RM]   ❌ Error source ${i + 1}:`, error.message);
        }
    }
    
    console.log(`[RM] ✅ Total channels: ${allChannels.length}`);
    
    // Converti in Record<tvg_id, base64_url>
    const processedChannels: Record<string, string> = {};
    
    for (const channel of allChannels) {
        // Codifica URL in base64 (come amstaff)
        const urlBase64 = Buffer.from(channel.url).toString('base64');
        processedChannels[channel.tvg_id] = urlBase64;
    }
    
    return processedChannels;
}

/**
 * Aggiorna tv_channels.json con campo staticUrlMpd2
 */
export async function updateRmChannels(): Promise<number> {
    try {
        console.log('[RM] 📥 Inizio aggiornamento canali MPD2...');
        
        // Scarica canali RM
        const rmChannels = await fetchRmChannels();
        const rmCount = Object.keys(rmChannels).length;
        
        if (rmCount === 0) {
            console.log('[RM] ⚠️  Nessun canale scaricato');
            return 0;
        }
        
        console.log(`[RM] ✅ Scaricati ${rmCount} canali`);
        
        // Legge tv_channels.json (stesso path di amstaff)
        const tvChannelsPath = path.join(__dirname, '../../config/tv_channels.json');
        console.log(`[RM] 📁 Percorso file: ${tvChannelsPath}`);
        const tvChannelsData = fs.readFileSync(tvChannelsPath, 'utf-8');
        const tvChannels: TVChannel[] = JSON.parse(tvChannelsData);
        
        let updates = 0;
        
        // Parsing completo delle sorgenti per matching migliore
        const allRmChannels: RmChannel[] = [];
        for (const sourceBase64 of RM_SOURCES) {
            const url = Buffer.from(sourceBase64, 'base64').toString('utf-8');
            try {
                const response = await axios.get(url, { timeout: 30000 });
                const channels = parseM3U(response.data);
                allRmChannels.push(...channels);
            } catch (e) {
                // Già loggato sopra
            }
        }
        
        // Match e update
        for (const rmChannel of allRmChannels) {
            const matchedChannel = matchChannel(tvChannels, rmChannel);
            
            if (matchedChannel) {
                const urlBase64 = Buffer.from(rmChannel.url).toString('base64');
                matchedChannel.staticUrlMpd2 = urlBase64;
                updates++;
                console.log(`[RM]   ✅ ${matchedChannel.name} <- ${rmChannel.name} (${rmChannel.tvg_id})`);
            }
        }
        
        if (updates > 0) {
            // Salva file aggiornato
            fs.writeFileSync(tvChannelsPath, JSON.stringify(tvChannels, null, 2), 'utf-8');
            console.log(`[RM] ✅ Aggiornati ${updates} canali con staticUrlMpd2`);
            
            // Trigger reload (come amstaff)
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
        } else {
            console.log('[RM] ⚠️  Nessun canale matchato');
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
