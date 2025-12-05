/**
 * MPDx Channel Updater
 * Aggiorna automaticamente il campo staticUrlMpdx in tv_channels.json
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

// URL base64-encoded
const _MPDX_URL_B64 = 'aHR0cHM6Ly9zcG9ydC5hbGVtYWdubzE5OTRhbGV4LndvcmtlcnMuZGV2Lw==';

const _d = (s: string): string => Buffer.from(s, 'base64').toString('utf8');

interface MpdxChannel {
    name: string;
    url: string;  // Formato: url&key_id=X&key=Y
}

interface TVChannel {
    id: string;
    name: string;
    vavooNames?: string[];
    staticUrlMpdx?: string;
    [key: string]: any;
}

/**
 * Rimuove tutte le emoji (incluse quelle composte come 1️⃣, 📺, #️⃣, etc.)
 */
function removeEmojis(str: string): string {
    return str
        // Rimuove emoji standard, variation selectors, keycaps, etc.
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
 * Parsa il contenuto M3U e restituisce i canali
 */
function parseM3u(content: string): MpdxChannel[] {
    const channels: MpdxChannel[] = [];
    const lines = content.split('\n').map(l => l.trim()).filter(l => l);
    
    let currentName = '';
    let currentKeyId = '';
    let currentKey = '';
    
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        if (line.startsWith('#EXTINF:')) {
            const nameMatch = line.match(/,([^,]+)$/);
            currentName = nameMatch ? nameMatch[1].trim() : '';
            // Rimuovi emoji iniziali (incluse quelle composte)
            currentName = removeEmojis(currentName);
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
 * Match canale MPDx con tv_channels.json
 */
function matchChannel(tvChannels: TVChannel[], mpdxCh: MpdxChannel): TVChannel | null {
    const mpdxName = mpdxCh.name;
    const normalizedMpdx = normalizeName(mpdxName);
    const strictMpdx = normalizeStrict(mpdxName);
    
    // Extract ID from URL if possible
    // URL format: .../channel(skycinemaaction)/...
    const urlIdMatch = mpdxCh.url.match(/channel\(([^)]+)\)/);
    const urlId = urlIdMatch ? urlIdMatch[1] : null;

    if (urlId) {
        // Try to match by ID first (very reliable)
        // Check against channel.id (normalized) or epgChannelIds
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
        // If we found an ID but didn't match, log it
        // if (mpdxName.toUpperCase().includes('CINEMA')) {
        //      console.log(`[DEBUG] URL ID found: '${urlId}' (Norm: ${normalizedUrlId}) but no match in tv_channels.json`);
        // }
    } else {
        // if (mpdxName.toUpperCase().includes('CINEMA')) {
        //    console.log(`[DEBUG] No URL ID found for '${mpdxName}' in URL: ${mpdxCh.url}`);
        // }
    }

    // Fallback to Name Matching
    for (const channel of tvChannels) {
        // Match esatto su vavooNames
        if (channel.vavooNames) {
            for (const vn of channel.vavooNames) {
                const normalizedVavoo = normalizeName(vn);
                const strictVavoo = normalizeStrict(vn);
                
                if (normalizedMpdx === normalizedVavoo) return channel;
                if (strictMpdx === strictVavoo) return channel;
            }
        }
        
        // Match su name
        const normalizedName = normalizeName(channel.name);
        const strictName = normalizeStrict(channel.name);
        
        if (normalizedMpdx === normalizedName) return channel;
        if (strictMpdx === strictName) return channel;
        
        // Match parziale per canali numerati (es. SKY SPORT 251)
        const mpdxNumMatch = normalizedMpdx.match(/(\d{3})$/);
        const nameNumMatch = normalizedName.match(/(\d{3})$/);
        if (mpdxNumMatch && nameNumMatch && mpdxNumMatch[1] === nameNumMatch[1]) {
            const mpdxPrefix = normalizedMpdx.replace(/\s*\d{3}$/, '').trim();
            const namePrefix = normalizedName.replace(/\s*\d{3}$/, '').trim();
            if (mpdxPrefix === namePrefix) return channel;
        }
        
        // Match "contains" per nomi parziali (es. "SPORT UNO" in "SKY SPORT UNO")
        if (normalizedMpdx.length > 5 && normalizedName.includes(normalizedMpdx)) return channel;
        if (normalizedName.length > 5 && normalizedMpdx.includes(normalizedName)) return channel;
    }
    
    // if (mpdxName.toUpperCase().includes('CINEMA')) {
    //    console.log(`[DEBUG] Name match failed for '${mpdxName}' (Norm: '${normalizedMpdx}')`);
    //    console.log(`[DEBUG] Full URL: ${mpdxCh.url}`);
    // }
    return null;
}

/**
 * Scarica e aggiorna tv_channels.json con staticUrlMpdx
 */
export async function updateMpdxChannels(): Promise<number> {
    try {
        console.log('[MPDx] 📥 Inizio aggiornamento canali MPDx...');
        
        const url = _d(_MPDX_URL_B64);
        const response = await axios.get(url, { 
            timeout: 60000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const jsonData = response.data as Array<{ text: string; idx: number }>;
        console.log(`[MPDx] Downloaded ${jsonData.length} sections`);
        
        // Combina tutti i testi M3U
        let mpdxChannels: MpdxChannel[] = [];
        for (const section of jsonData) {
            if (section.text) {
                const m3uContent = section.text.replace(/\\n/g, '\n');
                mpdxChannels = mpdxChannels.concat(parseM3u(m3uContent));
            }
        }
        
        // Rimuovi duplicati
        const seen = new Set<string>();
        mpdxChannels = mpdxChannels.filter(ch => {
            const key = ch.name.toUpperCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        
        console.log(`[MPDx] ✅ Parsed ${mpdxChannels.length} unique channels`);
        
        if (mpdxChannels.length === 0) {
            console.log('[MPDx] ⚠️  Nessun canale scaricato');
            return 0;
        }
        
        // Legge tv_channels.json
        const tvChannelsPath = path.join(__dirname, '../../config/tv_channels.json');
        console.log(`[MPDx] 📁 Percorso file: ${tvChannelsPath}`);
        const tvChannelsData = fs.readFileSync(tvChannelsPath, 'utf-8');
        const tvChannels: TVChannel[] = JSON.parse(tvChannelsData);
        
        let updates = 0;
        let matches = 0;
        
        // Match e update
        for (const mpdxCh of mpdxChannels) {
            const matchedChannel = matchChannel(tvChannels, mpdxCh);
            
            if (matchedChannel) {
                matches++;
                const urlBase64 = Buffer.from(mpdxCh.url).toString('base64');
                // Aggiorna solo se il link è effettivamente cambiato
                if (matchedChannel.staticUrlMpdx !== urlBase64) {
                    matchedChannel.staticUrlMpdx = urlBase64;
                    updates++;
                    console.log(`[MPDx]   ✅ ${matchedChannel.name} <- ${mpdxCh.name} (UPDATED)`);
                } else {
                     // Debug per verificare che il match avvenga
                     // console.log(`[MPDx]   ℹ️  ${matchedChannel.name} matched (already up to date)`);
                }
            } else {
                console.log(`[MPDx] ⚠️ Unmatched: '${mpdxCh.name}'`);
            }
        }
        
        console.log(`[MPDx] 📊 Matched ${matches}/${mpdxChannels.length} channels`);

        if (updates > 0) {
            // Salva file aggiornato
            fs.writeFileSync(tvChannelsPath, JSON.stringify(tvChannels, null, 2), 'utf-8');
            console.log(`[MPDx] ✅ Aggiornati ${updates} canali con staticUrlMpdx`);
            
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
                        console.log('[MPDx] 🔄 Reload triggerato', data ? JSON.parse(data) : 'ok');
                    });
                });
                req.on('error', () => { console.log('[MPDx] ℹ️  Reload non disponibile'); });
                req.end();
            } catch (err) {
                console.log('[MPDx] ⚠️  Errore trigger reload');
            }
        } else {
            console.log('[MPDx] ℹ️  Nessun canale aggiornato (tutti già aggiornati)');
        }
        
        return updates;
    } catch (error) {
        console.error('[MPDx] ❌ Errore aggiornamento:', error);
        return 0;
    }
}

/**
 * Scheduler per aggiornamenti automatici
 */
export function startMpdxScheduler(intervalMs = 1380000) {
    // Esegue aggiornamento iniziale dopo 55 secondi (dopo mpdz)
    setTimeout(async () => {
        console.log('[MPDx] 🚀 Primo aggiornamento all\'avvio...');
        await updateMpdxChannels();
    }, 55000);
    
    // Poi ogni 23 minuti
    setInterval(async () => {
        console.log('[MPDx] 🔄 Aggiornamento programmato (23min)...');
        await updateMpdxChannels();
    }, intervalMs);
    
    console.log('[MPDx] 📅 Scheduler attivato: aggiornamenti ogni 23 minuti');
}

// Mantiene compatibilità con vecchio codice
export function getMpdxChannels(): any[] { return []; }
