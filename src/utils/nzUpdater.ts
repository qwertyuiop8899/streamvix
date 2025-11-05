/**
 * NZ (Dazn) Channel Updater
 * Aggiorna automaticamente il campo staticUrlMpd in tv_channels.json con link MPD da pagina Dazn
 * Check ogni 20 minuti
 */

import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

// URL pagina Dazn (base64 encoded per nasconderlo)
const DAZN_PAGE_URL = 'aHR0cHM6Ly9zcGFnbmEubmV0bGlmeS5hcHAvZGF6bi9kYXpuMS5odG1s';

interface TVChannel {
    id: string;
    name: string;
    vavooNames?: string[];
    staticUrlMpd?: string;
    [key: string]: any;
}

/**
 * Aggiorna il canale DAZN 1 con link MPD estratto dalla pagina
 */
export async function updateNzChannel(): Promise<boolean> {
    try {
        const pageUrl = Buffer.from(DAZN_PAGE_URL, 'base64').toString('utf-8');
        console.log('[NZ] 📥 Controllo pagina Dazn...');
        
        const response = await axios.get(pageUrl, { 
            timeout: 15000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        const html = response.data;
        
        // Estrai MPD URL (cerca pattern .mpd)
        const mpdMatch = html.match(/https?:\/\/[^\s"'<>]+\.mpd/i);
        if (!mpdMatch) {
            console.log('[NZ] ⚠️  MPD link non trovato nella pagina');
            return false;
        }
        const mpdUrl = mpdMatch[0];
        console.log(`[NZ] ✅ MPD trovato`);
        
        // Estrai key_id e key dal clearKeys object
        // Formato: clearKeys: { "key_id":"key" }
        const clearKeysMatch = html.match(/clearKeys:\s*\{\s*"([a-f0-9]{32})"\s*:\s*"([a-f0-9]{32})"\s*\}/i);
        
        let keyId: string;
        let key: string;
        
        if (clearKeysMatch) {
            keyId = clearKeysMatch[1];
            key = clearKeysMatch[2];
            console.log(`[NZ] ✅ DRM keys estratte`);
        } else {
            // Fallback: cerca due sequenze hex32 consecutive
            const hexSequences = html.match(/([a-f0-9]{32})/gi);
            if (!hexSequences || hexSequences.length < 2) {
                console.log('[NZ] ❌ Impossibile estrarre DRM keys');
                return false;
            }
            keyId = hexSequences[0];
            key = hexSequences[1];
            console.log(`[NZ] ✅ DRM keys estratte (fallback)`);
        }
        
        // Costruisci URL completo: mpd&key_id=xxx&key=yyy
        const fullUrl = `${mpdUrl}&key_id=${keyId}&key=${key}`;
        const base64Url = Buffer.from(fullUrl).toString('base64');
        
        // Aggiorna tv_channels.json
        const tvChannelsPath = path.join(__dirname, '../../config/tv_channels.json');
        
        if (!fs.existsSync(tvChannelsPath)) {
            console.log('[NZ] ❌ File tv_channels.json non trovato');
            return false;
        }
        
        const tvChannelsData = fs.readFileSync(tvChannelsPath, 'utf-8');
        const tvChannels: TVChannel[] = JSON.parse(tvChannelsData);
        
        // Cerca canale DAZN 1 (cerca nei vavooNames)
        const daznChannel = tvChannels.find(ch => 
            ch.vavooNames?.some(v => {
                const normalized = v.toUpperCase().replace(/\s+/g, '');
                return normalized.includes('DAZN1') || normalized === 'DAZN1';
            })
        );
        
        if (!daznChannel) {
            console.log('[NZ] ⚠️  Canale DAZN 1 non trovato in tv_channels.json');
            return false;
        }
        
        // Aggiorna il campo staticUrlMpd
        daznChannel.staticUrlMpd = base64Url;
        
        // Salva il file aggiornato
        fs.writeFileSync(tvChannelsPath, JSON.stringify(tvChannels, null, 2), 'utf-8');
        
        console.log(`[NZ] ✅ Aggiornato canale "${daznChannel.name}" con nuovo link MPD`);
        
        // Trigger reload endpoint /static/reload (come altri updater)
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
                    console.log('[NZ] 🔄 Reload triggerato', data ? JSON.parse(data) : 'ok');
                });
            });
            
            req.on('error', () => {
                console.log('[NZ] ℹ️  Reload non disponibile (normale in dev)');
            });
            
            req.end();
        } catch (err) {
            console.log('[NZ] ⚠️  Errore trigger reload');
        }
        
        return true;
        
    } catch (error: any) {
        console.error('[NZ] ❌ Errore aggiornamento:', error.message);
        return false;
    }
}

/**
 * Scheduler per aggiornamenti automatici ogni 20 minuti
 */
export function startNzScheduler() {
    // Primo check dopo 30 secondi (dopo l'avvio)
    setTimeout(async () => {
        console.log('[NZ] 🚀 Primo check Dazn all\'avvio...');
        await updateNzChannel();
    }, 30000);
    
    // Poi ogni 20 minuti (1200000 ms = 20 * 60 * 1000)
    setInterval(async () => {
        console.log('[NZ] 🔄 Check programmato Dazn (20min)...');
        await updateNzChannel();
    }, 1200000);
    
    console.log('[NZ] 📅 Scheduler NZ attivato: check ogni 20 minuti');
}
