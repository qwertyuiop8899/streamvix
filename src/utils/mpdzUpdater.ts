/**
 * MPDz Channel Updater
 * Aggiorna automaticamente il campo staticUrlMpdz in tv_channels.json
 * con i link MPD decriptati da  (pattern come rmUpdater/amstaffUpdater)
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import axios from 'axios';

// Helper per decodificare base64
const _d = (s: string): string => Buffer.from(s, 'base64').toString('utf8');

// URL della pagina con il JsFuck che contiene la chiave (offuscato in base64)
const _EDROID_B64 = 'aHR0cHM6Ly9odG1sLmUtZHJvaWQubmV0L2h0bWwvZ2V0X2h0bWwucGhwP2lkYT0zNzI2MTI4Jmlkcz0zNjYyMzUwOSZmdW09MTc2MzcyNzQxNQ==';

// URL del contenuto criptato (offuscato in base64)
const __B64 = 'aHR0cHM6Ly9waXJ0dXMuYWx3YXlzZGF0YS5uZXQvYmx1ZWNsb3Vkcy5waHA=';

// Chiave di fallback (offuscata in base64)
const _FALLBACK_B64 = 'U3NLR1BSN2VnVVk3dXJhUjVENkVpcDJPVGVLYXNwQmdERnRmcUZobW56NXQyMlhMa0JlZTh3ZkxjdjNQZktiOEVXekh0QkZ5VU5iS2NW';

interface MpdzChannel {
    name: string;
    url: string;  // Formato: url&key_id=X&key=Y
}

interface TVChannel {
    id: string;
    name: string;
    vavooNames?: string[];
    staticUrlMpdz?: string;
    [key: string]: any;
}

/**
 * Scarica la pagina e-droid ed estrae il codice JsFuck
 */
async function fetchJsFuckFromEdroid(): Promise<string | null> {
    try {
        const edroidUrl = _d(_EDROID_B64);
        console.log('[MPDz] Fetching e-droid page for JsFuck...');
        
        const response = await axios.get(edroidUrl, { 
            timeout: 60000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        let html = response.data;
        
        // Applica le sostituzioni
        html = html.replace(/@CCORCH@/g, ']').replace(/@MNQ@/g, '<');
        
        // Estrai lo script JsFuck
        const scriptMatches = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
        
        for (const scriptTag of scriptMatches) {
            const script = scriptTag.replace(/<\/?script>/g, '').trim();
            if (script.length > 10000) {
                // Verifica che sia JsFuck (solo []()!+ e spazi)
                const jsfuckChars = new Set(['[', ']', '(', ')', '!', '+']);
                let otherChars = 0;
                for (const c of script) {
                    if (!jsfuckChars.has(c) && !/\s/.test(c)) {
                        otherChars++;
                    }
                }
                if (otherChars < script.length * 0.01) {
                    console.log(`[MPDz] JsFuck found: ${script.length} chars`);
                    return script;
                }
            }
        }
        
        return null;
    } catch (e) {
        console.error('[MPDz] Failed to fetch e-droid:', e);
        return null;
    }
}

/**
 * Decodifica JsFuck usando Node.js
 */
function decodeJsFuck(jsfuckCode: string): string | null {
    console.log('[MPDz] Decoding JsFuck...');
    
    const tmpDir = os.tmpdir();
    const jsfuckFile = path.join(tmpDir, `jsfuck_${Date.now()}.js`);
    const nodeScript = path.join(tmpDir, `decoder_${Date.now()}.js`);
    
    const decoderCode = `
const fs = require('fs');
function jsfuckdecode(text) {
    var jsFuckText = text.trim();
    var start = jsFuckText.indexOf("()");
    var len = jsFuckText.length;
    try {
        var result = '';
        if (jsFuckText.length > 3 && jsFuckText.slice(len - 3) == ')()') {
            var txt = jsFuckText.substring(0, len - 2);
            var evaled = eval(txt);
            if (typeof evaled === 'function') result = evaled.toString();
            else if (typeof evaled === 'string') {
                var match = /\\n(.+)/.exec(evaled);
                result = match ? match[1] : evaled;
            } else result = String(evaled);
        } else if (jsFuckText.substring(0, 2) == '[]' && start >= 0) {
            result = eval(jsFuckText.substring(start + 2));
        } else result = eval(jsFuckText);
        return typeof result === 'function' ? result.toString() : String(result);
    } catch (e) { return "error: " + e.message; }
}
console.log(jsfuckdecode(fs.readFileSync(process.argv[2], 'utf8')));
`;
    
    try {
        fs.writeFileSync(jsfuckFile, jsfuckCode);
        fs.writeFileSync(nodeScript, decoderCode);
        
        // Usa process.execPath per il percorso assoluto di Node.js (funziona in Docker/K8s)
        const nodeExec = process.execPath;
        const result = execSync(`"${nodeExec}" "${nodeScript}" "${jsfuckFile}"`, {
            timeout: 60000, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024
        });
        
        if (result && !result.startsWith('error:')) return result;
    } catch (e) {
        console.error('[MPDz] JsFuck decode error:', e);
    } finally {
        try { fs.unlinkSync(jsfuckFile); } catch {}
        try { fs.unlinkSync(nodeScript); } catch {}
    }
    return null;
}

/**
 * Estrae la passphrase dal JavaScript decodificato
 */
function extractKeyFromDecodedJs(decodedJs: string): string | null {
    if (!decodedJs) return null;
    const patterns = [
        /CryptoJS\.SHA256\(["']([^"']+)["']\)/,
        /SHA256\(["']([^"']+)["']\)/,
        /passphrase\s*=\s*["']([^"']+)["']/,
    ];
    for (const pattern of patterns) {
        const match = decodedJs.match(pattern);
        if (match && match[1] && match[1].length > 50) return match[1];
    }
    return null;
}

/**
 * Ottiene la passphrase (automatica o fallback)
 */
async function getPassphrase(): Promise<string> {
    try {
        const jsfuck = await fetchJsFuckFromEdroid();
        if (jsfuck) {
            const decoded = decodeJsFuck(jsfuck);
            if (decoded) {
                const key = extractKeyFromDecodedJs(decoded);
                if (key) {
                    console.log('[MPDz] Key extracted automatically!');
                    return key;
                }
            }
        }
    } catch (e) {
        console.error('[MPDz] Auto key extraction failed:', e);
    }
    console.log('[MPDz] Using fallback key');
    return _d(_FALLBACK_B64);
}

/**
 * Decripta il payload AES-256-CBC
 */
function decryptPayload(encryptedB64: string, passphrase: string): string {
    const key = crypto.createHash('sha256').update(passphrase).digest();
    const rawData = Buffer.from(encryptedB64, 'base64');
    const iv = rawData.subarray(0, 16);
    const ciphertext = rawData.subarray(16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString('utf8');
}

/**
 * Rimuove tutte le emoji (incluse quelle composte come 1️⃣, 📺, #️⃣, etc.)
 */
function removeEmojis(str: string): string {
    return str
        .replace(/[\u{1F300}-\u{1F9FF}]/gu, '')  // Simboli ed emoji
        .replace(/[\u{2600}-\u{26FF}]/gu, '')    // Simboli misc
        .replace(/[\u{2700}-\u{27BF}]/gu, '')    // Dingbats
        .replace(/[\u{FE00}-\u{FE0F}]/gu, '')    // Variation Selectors
        .replace(/[\u{20E3}]/gu, '')             // Combining Enclosing Keycap
        .replace(/[\u{E0020}-\u{E007F}]/gu, '')  // Tags
        .replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '')  // Flags
        .replace(/^[\s\d#*]+(?=\s)/g, '')        // Rimuove numeri/simboli iniziali seguiti da spazio
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
        } else if (line.startsWith('http') && line.includes('.mpd')) {
            if (currentName && currentKeyId && currentKey) {
                const url = `${line}&key_id=${currentKeyId}&key=${currentKey}`;
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
    
    // Extract ID from URL if possible
    // URL format: .../channel(skycinemaaction)/...
    const urlIdMatch = mpdzCh.url.match(/channel\(([^)]+)\)/);
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

    for (const channel of tvChannels) {
        // Match esatto su vavooNames
        if (channel.vavooNames) {
            for (const vn of channel.vavooNames) {
                const normalizedVavoo = normalizeName(vn);
                if (normalizedMpdz === normalizedVavoo) return channel;
            }
        }
        
        // Match su name
        const normalizedName = normalizeName(channel.name);
        if (normalizedMpdz === normalizedName) return channel;
        
        // Match parziale per canali numerati (es. SKY SPORT 251)
        const mpdzNumMatch = normalizedMpdz.match(/(\d{3})$/);
        const nameNumMatch = normalizedName.match(/(\d{3})$/);
        if (mpdzNumMatch && nameNumMatch && mpdzNumMatch[1] === nameNumMatch[1]) {
            const mpdzPrefix = normalizedMpdz.replace(/\s*\d{3}$/, '').trim();
            const namePrefix = normalizedName.replace(/\s*\d{3}$/, '').trim();
            if (mpdzPrefix === namePrefix) return channel;
        }
        
        // Match "contains" per nomi parziali
        if (normalizedMpdz.length > 5 && normalizedName.includes(normalizedMpdz)) return channel;
        if (normalizedName.length > 5 && normalizedMpdz.includes(normalizedName)) return channel;
    }
    return null;
}

/**
 * Scarica, decripta e aggiorna tv_channels.json con staticUrlMpdz
 */
export async function updateMpdzChannels(): Promise<number> {
    try {
        console.log('[MPDz] 📥 Inizio aggiornamento canali MPDz...');
        
        // Scarica e decripta
        const Url = _d(__B64);
        const response = await axios.get(Url, { 
            timeout: 60000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const encrypted = response.data;
        console.log(`[MPDz] Downloaded ${encrypted.length} chars`);
        
        const passphrase = await getPassphrase();
        const decrypted = decryptPayload(encrypted.trim(), passphrase);
        console.log(`[MPDz] Decrypted ${decrypted.length} chars`);
        
        const mpdzChannels = parseM3u(decrypted);
        console.log(`[MPDz] ✅ Parsed ${mpdzChannels.length} channels`);
        
        if (mpdzChannels.length === 0) {
            console.log('[MPDz] ⚠️  Nessun canale scaricato');
            return 0;
        }
        
        // Legge tv_channels.json
        const tvChannelsPath = path.join(__dirname, '../../config/tv_channels.json');
        console.log(`[MPDz] 📁 Percorso file: ${tvChannelsPath}`);
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
                // Aggiorna solo se il link è effettivamente cambiato
                if (matchedChannel.staticUrlMpdz !== urlBase64) {
                    matchedChannel.staticUrlMpdz = urlBase64;
                    updates++;
                    console.log(`[MPDz]   ✅ ${matchedChannel.name} <- ${mpdzCh.name} (UPDATED)`);
                }
            }
        }
        
        console.log(`[MPDz] 📊 Matched ${matches}/${mpdzChannels.length} channels`);

        if (updates > 0) {
            // Salva file aggiornato
            fs.writeFileSync(tvChannelsPath, JSON.stringify(tvChannels, null, 2), 'utf-8');
            console.log(`[MPDz] ✅ Aggiornati ${updates} canali con staticUrlMpdz`);
            
            // Trigger reload
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
                        console.log('[MPDz] 🔄 Reload triggerato', data ? JSON.parse(data) : 'ok');
                    });
                });
                req.on('error', () => { console.log('[MPDz] ℹ️  Reload non disponibile'); });
                req.end();
            } catch (err) {
                console.log('[MPDz] ⚠️  Errore trigger reload');
            }
        } else {
            console.log('[MPDz] ℹ️  Nessun canale aggiornato (tutti già aggiornati)');
        }
        
        return updates;
    } catch (error) {
        console.error('[MPDz] ❌ Errore aggiornamento:', error);
        return 0;
    }
}

/**
 * Scheduler per aggiornamenti automatici
 */
export function startMpdzScheduler(intervalMs = 1380000) {
    // Esegue aggiornamento iniziale dopo 50 secondi (dopo amstaff e rm)
    setTimeout(async () => {
        console.log('[MPDz] 🚀 Primo aggiornamento all\'avvio...');
        await updateMpdzChannels();
    }, 50000);
    
    // Poi ogni 23 minuti
    setInterval(async () => {
        console.log('[MPDz] 🔄 Aggiornamento programmato (23min)...');
        await updateMpdzChannels();
    }, intervalMs);
    
    console.log('[MPDz] 📅 Scheduler attivato: aggiornamenti ogni 23 minuti');
}

// Mantiene compatibilità con vecchio codice (getMpdzChannels non più usato)
export function getMpdzChannels(): any[] { return []; }
