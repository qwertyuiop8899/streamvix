import { addonBuilder, getRouter, Manifest, Stream } from "stremio-addon-sdk";
import { getStreamContent, VixCloudStreamInfo, ExtractorConfig } from "./extractor";
import * as fs from 'fs';
import { landingTemplate } from './landingPage';
import * as path from 'path';
import express, { Request, Response, NextFunction } from 'express'; // ✅ CORRETTO: Import tipizzato
import { AnimeUnityProvider } from './providers/animeunity-provider';
import { KitsuProvider } from './providers/kitsu'; 
import { formatMediaFlowUrl } from './utils/mediaflow';
import { mergeDynamic, loadDynamicChannels } from './utils/dynamicChannels';

// --- Lightweight declarations to avoid TS complaints if @types/node non installati ---
// (Non sostituiscono l'uso consigliato di @types/node, ma evitano errori bloccanti.)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Buffer: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function require(name: string): any;
import { AnimeUnityConfig } from "./types/animeunity";
import { EPGManager } from './utils/epg';
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as util from 'util';

// Funzioni utility per decodifica base64
function decodeBase64(str: string): string {
    return Buffer.from(str, 'base64').toString('utf8');
}

// Funzione per decodificare URL statici (sempre in base64)
function decodeStaticUrl(url: string): string {
    if (!url) return url;
    
    console.log(`🔧 [Base64] Decodifica URL (sempre base64): ${url.substring(0, 50)}...`);
    
    try {
        // Assicura padding corretto (lunghezza multipla di 4)
        let paddedUrl = url;
        while (paddedUrl.length % 4 !== 0) {
            paddedUrl += '=';
        }
        
        // Decodifica base64
        const decoded = decodeBase64(paddedUrl);
        console.log(`✅ [Base64] URL decodificato: ${decoded}`);
        
        return decoded;
    } catch (error) {
        console.error(`❌ [Base64] Errore nella decodifica: ${error}`);
        console.log(`🔧 [Base64] Ritorno URL originale per errore`);
        return url;
    }
}

// Promisify execFile
const execFilePromise = util.promisify(execFile);

// Interfaccia per la configurazione URL
interface AddonConfig {
  mediaFlowProxyUrl?: string;
  mediaFlowProxyPassword?: string;
  tmdbApiKey?: string;
  enableMpd?: string;
  animeunityEnabled?: string;
  animesaturnEnabled?: string;
  [key: string]: any;
}

// Cache globale per la configurazione
const configCache: AddonConfig = {
  mediaFlowProxyUrl: process.env.MFP_URL,
  mediaFlowProxyPassword: process.env.MFP_PSW,
  tmdbApiKey: process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0'
};

// Funzione globale per log di debug
const debugLog = (message: string, ...params: any[]) => {
    console.log(`🔧 ${message}`, ...params);
    
    // Scrivi anche su file di log
    try {
        const logPath = path.join(__dirname, '../logs');
        if (!fs.existsSync(logPath)) {
            fs.mkdirSync(logPath, { recursive: true });
        }
        const logFile = path.join(logPath, 'config_debug.log');
        const timestamp = new Date().toISOString();
        const logMessage = `${timestamp} - ${message} ${params.length ? JSON.stringify(params) : ''}\n`;
        fs.appendFileSync(logFile, logMessage);
    } catch (e) {
        console.error('Error writing to log file:', e);
    }
};

// Base manifest configuration
const baseManifest: Manifest = {
    id: "org.stremio.vixcloud",
    version: "4.0.1",
    name: "StreamViX",
    description: "Addon for Vixsrc, AnimeUnity streams and Live TV.", 
    icon: "/public/icon.png",
    background: "/public/backround.png",
    types: ["movie", "series", "tv"],
    idPrefixes: ["tt", "kitsu", "tv"],
    catalogs: [
        {
            type: "tv",
            id: "tv-channels",
            name: "StreamViX TV",
            extra: [
                {
                    name: "genre",
                    isRequired: false,
                    options: [
                        "RAI",
                        "Mediaset", 
                        "Sky",
                        "Bambini",
                        "News",
                        "Sport",
                        "Cinema",
                        "Generali",
                        "Documentari",
                        "Pluto",
                        "Serie A",
                        "Serie B",
                        "Serie C",
                        "Coppe",
                        "Tennis",
                        "F1",
                        "MotoGp",
                        "Basket",
                        "Volleyball",
                        "Ice Hockey",
                        "Wrestling",
                        "Boxing",
                        "Darts",
                        "Baseball",
                        "NFL"
                    ]
                },
                {
                    name: "search",
                    isRequired: false
                }
            ]
        }
    ],
    resources: ["stream", "catalog", "meta"],
    behaviorHints: {
        configurable: true
    },
    config: [
        {
            key: "tmdbApiKey",
            title: "TMDB API Key",
            type: "text"
        },
        {
            key: "mediaFlowProxyUrl", 
            title: "MediaFlow Proxy URL",
            type: "text"
        },
        {
            key: "mediaFlowProxyPassword",
            title: "MediaFlow Proxy Password", 
            type: "text"
        },
        {
            key: "enableMpd",
            title: "Enable MPD Streams",
            type: "checkbox"
        },
        {
            key: "animeunityEnabled",
            title: "Enable AnimeUnity",
            type: "checkbox"
        },
        {
            key: "animesaturnEnabled",
            title: "Enable AnimeSaturn",
            type: "checkbox"
        }
    ]
};

// Load custom configuration if available
function loadCustomConfig(): Manifest {
    try {
        const configPath = path.join(__dirname, '..', 'addon-config.json');
        
        if (fs.existsSync(configPath)) {
            const customConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            
            return {
                ...baseManifest,
                id: customConfig.addonId || baseManifest.id,
                name: customConfig.addonName || baseManifest.name,
                description: customConfig.addonDescription || baseManifest.description,
                version: customConfig.addonVersion || baseManifest.version,
                logo: customConfig.addonLogo || baseManifest.logo,
                icon: customConfig.addonLogo || baseManifest.icon,
                background: baseManifest.background
            };
        }
    } catch (error) {
        console.error('Error loading custom configuration:', error);
    }
    
    return baseManifest;
}

// Funzione per parsare la configurazione dall'URL
function parseConfigFromArgs(args: any): AddonConfig {
    const config: AddonConfig = {};
    
    // Se non ci sono args o sono vuoti, ritorna configurazione vuota
    if (!args || args === '' || args === 'undefined' || args === 'null') {
        debugLog('No configuration provided, using defaults');
        return config;
    }
    
    // Se la configurazione è già un oggetto, usala direttamente
    if (typeof args === 'object' && args !== null) {
        debugLog('Configuration provided as object');
        return args;
    }
    
    if (typeof args === 'string') {
        debugLog(`Configuration string: ${args.substring(0, 50)}... (length: ${args.length})`);
        
        // PASSO 1: Prova JSON diretto
        try {
            const parsed = JSON.parse(args);
            debugLog('Configuration parsed as direct JSON');
            return parsed;
        } catch (error) {
            debugLog('Not direct JSON, trying other methods');
        }
        
        // PASSO 2: Gestione URL encoded
        let decodedArgs = args;
        if (args.includes('%')) {
            try {
                decodedArgs = decodeURIComponent(args);
                debugLog('URL-decoded configuration');
                
                // Prova JSON dopo URL decode
                try {
                    const parsed = JSON.parse(decodedArgs);
                    debugLog('Configuration parsed from URL-decoded JSON');
                    return parsed;
                } catch (innerError) {
                    debugLog('URL-decoded content is not valid JSON');
                }
            } catch (error) {
                debugLog('URL decoding failed');
            }
        }
        
        // PASSO 3: Gestione Base64
        if (decodedArgs.startsWith('eyJ') || /^[A-Za-z0-9+\/=]+$/.test(decodedArgs)) {
            try {
                // Fix per caratteri = che potrebbero essere URL encoded
                const base64Fixed = decodedArgs
                    .replace(/%3D/g, '=')
                    .replace(/=+$/, ''); // Rimuove eventuali = alla fine
                
                // Assicura che la lunghezza sia multipla di 4 aggiungendo = se necessario
                let paddedBase64 = base64Fixed;
                while (paddedBase64.length % 4 !== 0) {
                    paddedBase64 += '=';
                }
                
                debugLog(`Trying base64 decode: ${paddedBase64.substring(0, 20)}...`);
                const decoded = Buffer.from(paddedBase64, 'base64').toString('utf-8');
                debugLog(`Base64 decoded result: ${decoded.substring(0, 50)}...`);
                
                if (decoded.includes('{') && decoded.includes('}')) {
                    try {
                        const parsed = JSON.parse(decoded);
                        debugLog('Configuration parsed from Base64');
                        return parsed;
                    } catch (jsonError) {
                        debugLog('Base64 content is not valid JSON');
                        
                        // Prova a estrarre JSON dalla stringa decodificata
                        const jsonMatch = decoded.match(/({.*})/);
                        if (jsonMatch && jsonMatch[1]) {
                            try {
                                const extractedJson = jsonMatch[1];
                                const parsed = JSON.parse(extractedJson);
                                debugLog('Extracted JSON from Base64 decoded string');
                                return parsed;
                            } catch (extractError) {
                                debugLog('Extracted JSON parsing failed');
                            }
                        }
                    }
                }
            } catch (error) {
                debugLog('Base64 decoding failed');
            }
        }
        
        debugLog('All parsing methods failed, using default configuration');
    }
    
    return config;
}

// Carica canali TV e domini da file esterni
let tvChannels: any[] = [];
let domains: any = {};
let epgConfig: any = {};
let epgManager: EPGManager | null = null;

// ✅ DICHIARAZIONE delle variabili globali del builder
let globalBuilder: any;
let globalAddonInterface: any;
let globalRouter: any;

// Cache per i link Vavoo
interface VavooCache {
    timestamp: number;
    links: Map<string, string | string[]>;
    updating: boolean;
}

const vavooCache: VavooCache = {
    timestamp: 0,
    links: new Map<string, string | string[]>(),
    updating: false
};

// Path del file di cache per Vavoo
const vavaoCachePath = path.join(__dirname, '../cache/vavoo_cache.json');

// Se la cache non esiste, genera automaticamente
if (!fs.existsSync(vavaoCachePath)) {
    console.warn('⚠️ [VAVOO] Cache non trovata, provo a generarla automaticamente...');
    try {
        const { execSync } = require('child_process');
        execSync('python3 vavoo_resolver.py --build-cache', { cwd: path.join(__dirname, '..') });
        console.log('✅ [VAVOO] Cache generata automaticamente!');
    } catch (err) {
        console.error('❌ [VAVOO] Errore nella generazione automatica della cache:', err);
    }
}

// Funzione per caricare la cache Vavoo dal file
function loadVavooCache(): void {
    try {
        if (fs.existsSync(vavaoCachePath)) {
            const rawCache = fs.readFileSync(vavaoCachePath, 'utf-8');
            // RIMOSSO: console.log('🔧 [VAVOO] RAW vavoo_cache.json:', rawCache);
            const cacheData = JSON.parse(rawCache);
            vavooCache.timestamp = cacheData.timestamp || 0;
            vavooCache.links = new Map(Object.entries(cacheData.links || {}));
            console.log(`📺 Vavoo cache caricata con ${vavooCache.links.size} canali, aggiornata il: ${new Date(vavooCache.timestamp).toLocaleString()}`);
            console.log('🔧 [VAVOO] DEBUG - Cache caricata all\'avvio:', vavooCache.links.size, 'canali');
            console.log('🔧 [VAVOO] DEBUG - Path cache:', vavaoCachePath);
            // RIMOSSO: stampa dettagliata del contenuto della cache
        } else {
            console.log(`📺 File cache Vavoo non trovato, verrà creato al primo aggiornamento`);
        }
    } catch (error) {
        console.error('❌ Errore nel caricamento della cache Vavoo:', error);
    }
}

// Funzione per salvare la cache Vavoo su file
function saveVavooCache(): void {
    try {
        // Assicurati che la directory cache esista
        const cacheDir = path.dirname(vavaoCachePath);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }

        const cacheData = {
            timestamp: vavooCache.timestamp,
            links: Object.fromEntries(vavooCache.links)
        };
        
        // Salva prima in un file temporaneo e poi rinomina per evitare file danneggiati
        const tempPath = `${vavaoCachePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(cacheData, null, 2), 'utf-8');
        
        // Rinomina il file temporaneo nel file finale
        fs.renameSync(tempPath, vavaoCachePath);
        
        console.log(`📺 Vavoo cache salvata con ${vavooCache.links.size} canali, timestamp: ${new Date(vavooCache.timestamp).toLocaleString()}`);
    } catch (error) {
        console.error('❌ Errore nel salvataggio della cache Vavoo:', error);
    }
}

// Funzione per aggiornare la cache Vavoo
async function updateVavooCache(): Promise<boolean> {
    if (vavooCache.updating) {
        console.log(`📺 Aggiornamento Vavoo già in corso, skip`);
        return false;
    }

    vavooCache.updating = true;
    console.log(`📺 Avvio aggiornamento cache Vavoo...`);
    try {
        // PATCH: Prendi TUTTI i canali da Vavoo, senza filtri su tv_channels.json
        const result = await execFilePromise('python3', [
            path.join(__dirname, '../vavoo_resolver.py'),
            '--dump-channels'
        ], { timeout: 30000 });

        if (result.stdout) {
            try {
                const channels = JSON.parse(result.stdout);
                console.log(`📺 Recuperati ${channels.length} canali da Vavoo (nessun filtro)`);
                const updatedLinks = new Map<string, string>();
                for (const ch of channels) {
                    if (ch.name && ch.url) {
                        updatedLinks.set(ch.name, ch.url);
                    }
                }
                vavooCache.links = updatedLinks;
                vavooCache.timestamp = Date.now();
                saveVavooCache();
                console.log(`✅ Cache Vavoo aggiornata: ${updatedLinks.size} canali in cache (tutti)`);
                return true;
            } catch (jsonError) {
                console.error('❌ Errore nel parsing del risultato JSON di Vavoo:', jsonError);
                throw jsonError;
            }
        }
    } catch (error) {
        console.error('❌ Errore durante l\'aggiornamento della cache Vavoo:', error);
        return false;
    } finally {
        vavooCache.updating = false;
    }
    return false;
}

try {
    // Assicurati che le directory di cache esistano
    ensureCacheDirectories();
    
    tvChannels = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tv_channels.json'), 'utf-8'));
    domains = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/domains.json'), 'utf-8'));
    epgConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/epg_config.json'), 'utf-8'));
    
    console.log(`✅ Loaded ${tvChannels.length} TV channels`);
    
    // ============ TVTAP INTEGRATION ============

    // Cache per i link TVTap
    interface TVTapCache {
        timestamp: number;
        channels: Map<string, string>;
        updating: boolean;
    }

    const tvtapCache: TVTapCache = {
        timestamp: 0,
        channels: new Map<string, string>(),
        updating: false
    };

    // Path del file di cache per TVTap
    const tvtapCachePath = path.join(__dirname, '../cache/tvtap_cache.json');

    // Funzione per caricare la cache TVTap dal file
    function loadTVTapCache(): void {
        try {
            if (fs.existsSync(tvtapCachePath)) {
                const rawCache = fs.readFileSync(tvtapCachePath, 'utf-8');
                const cacheData = JSON.parse(rawCache);
                tvtapCache.timestamp = cacheData.timestamp || 0;
                tvtapCache.channels = new Map(Object.entries(cacheData.channels || {}));
                console.log(`📺 TVTap cache caricata con ${tvtapCache.channels.size} canali, aggiornata il: ${new Date(tvtapCache.timestamp).toLocaleString()}`);
            } else {
                console.log("📺 File cache TVTap non trovato, verrà creato al primo aggiornamento");
            }
        } catch (error) {
            console.error("❌ Errore nel caricamento cache TVTap:", error);
            tvtapCache.timestamp = 0;
            tvtapCache.channels = new Map();
        }
    }

    // Funzione per aggiornare la cache TVTap
    async function updateTVTapCache(): Promise<boolean> {
        if (tvtapCache.updating) {
            console.log('🔄 TVTap cache già in aggiornamento, salto...');
            return false;
        }

        tvtapCache.updating = true;
        console.log('🔄 Aggiornamento cache TVTap...');

        try {
            const options = {
                timeout: 30000,
                env: {
                    ...process.env,
                    PYTHONPATH: '/usr/local/lib/python3.9/site-packages'
                }
            };
            
            const { stdout, stderr } = await execFilePromise('python3', [path.join(__dirname, '../tvtap_resolver.py'), '--build-cache'], options);
            
            if (stderr) {
                console.error(`[TVTap] Script stderr:`, stderr);
            }
            
            console.log('✅ Cache TVTap aggiornata con successo');
            
            // Ricarica la cache aggiornata
            loadTVTapCache();
            
            return true;
        } catch (error: any) {
            console.error('❌ Errore durante aggiornamento cache TVTap:', error.message || error);
            return false;
        } finally {
            tvtapCache.updating = false;
        }
    }

    // ============ END TVTAP INTEGRATION ============
    
    // ✅ INIZIALIZZA IL ROUTER GLOBALE SUBITO DOPO IL CARICAMENTO
    console.log('🔧 Initializing global router after loading TV channels...');
    globalBuilder = createBuilder(configCache);
    globalAddonInterface = globalBuilder.getInterface();
    globalRouter = getRouter(globalAddonInterface);
    console.log('✅ Global router initialized successfully');
    
    // Carica la cache Vavoo
    loadVavooCache();

    // Dopo il caricamento della cache Vavoo
    if (vavooCache && vavooCache.links) {
        try {
            console.log(`[VAVOO] Cache caricata: ${vavooCache.links.size} canali`);
        } catch (e) {
            console.log('[VAVOO] ERRORE DUMP CACHE:', e);
        }
    }
    
    // Carica la cache TVTap
    loadTVTapCache();
    
    // Aggiorna la cache Vavoo in background all'avvio
    setTimeout(() => {
        updateVavooCache().then(success => {
            if (success) {
                console.log(`✅ Cache Vavoo aggiornata con successo all'avvio`);
            } else {
                console.log(`⚠️ Aggiornamento cache Vavoo fallito all'avvio, verrà ritentato periodicamente`);
            }
        }).catch(error => {
            console.error(`❌ Errore durante l'aggiornamento cache Vavoo all'avvio:`, error);
        });
    }, 2000);
    
    // Aggiorna la cache TVTap in background all'avvio
    setTimeout(() => {
        updateTVTapCache().then(success => {
            if (success) {
                console.log(`✅ Cache TVTap aggiornata con successo all'avvio`);
            } else {
                console.log(`⚠️ Aggiornamento cache TVTap fallito all'avvio, verrà ritentato periodicamente`);
            }
        }).catch(error => {
            console.error(`❌ Errore durante l'aggiornamento cache TVTap all'avvio:`, error);
        });
    }, 4000); // Aspetta un po' di più per non sovraccaricare
    
    // Programma aggiornamenti periodici della cache Vavoo (ogni 12 ore)
    const VAVOO_UPDATE_INTERVAL = 12 * 60 * 60 * 1000; // 12 ore in millisecondi
    setInterval(() => {
        console.log(`🔄 Aggiornamento periodico cache Vavoo avviato...`);
        updateVavooCache().then(success => {
            if (success) {
                console.log(`✅ Cache Vavoo aggiornata periodicamente con successo`);
            } else {
                console.log(`⚠️ Aggiornamento periodico cache Vavoo fallito`);
            }
        }).catch(error => {
            console.error(`❌ Errore durante l'aggiornamento periodico cache Vavoo:`, error);
        });
    }, VAVOO_UPDATE_INTERVAL);
    
    // Programma aggiornamenti periodici della cache TVTap (ogni 12 ore, offset di 1 ora)
    const TVTAP_UPDATE_INTERVAL = 12 * 60 * 60 * 1000; // 12 ore in millisecondi
    setInterval(() => {
        console.log(`🔄 Aggiornamento periodico cache TVTap avviato...`);
        updateTVTapCache().then(success => {
            if (success) {
                console.log(`✅ Cache TVTap aggiornata periodicamente con successo`);
            } else {
                console.log(`⚠️ Aggiornamento periodico cache TVTap fallito`);
            }
        }).catch(error => {
            console.error(`❌ Errore durante l'aggiornamento periodico cache TVTap:`, error);
        });
    }, TVTAP_UPDATE_INTERVAL);
    
    // Inizializza EPG Manager
    if (epgConfig.enabled) {
        epgManager = new EPGManager(epgConfig);
        console.log(`📺 EPG Manager inizializzato con URL: ${epgConfig.epgUrl}`);
        
        // Avvia aggiornamento EPG in background senza bloccare l'avvio
        setTimeout(() => {
            if (epgManager) {
                epgManager.updateEPG().then(success => {
                    if (success) {
                        console.log(`✅ EPG aggiornato con successo in background`);
                    } else {
                        console.log(`⚠️ Aggiornamento EPG fallito in background, verrà ritentato al prossimo utilizzo`);
                    }
                }).catch(error => {
                    console.error(`❌ Errore durante l'aggiornamento EPG in background:`, error);
                });
            }
        }, 1000);
        
        // Programma aggiornamenti periodici dell'EPG (ogni 6 ore)
        setInterval(() => {
            if (epgManager) {
                console.log(`🔄 Aggiornamento EPG periodico avviato...`);
                epgManager.updateEPG().then(success => {
                    if (success) {
                        console.log(`✅ EPG aggiornato periodicamente con successo`);
                    } else {
                        console.log(`⚠️ Aggiornamento EPG periodico fallito`);
                    }
                }).catch(error => {
                    console.error(`❌ Errore durante l'aggiornamento EPG periodico:`, error);
                });
            }
        }, epgConfig.updateInterval);
    }
} catch (error) {
    console.error('❌ Errore nel caricamento dei file di configurazione TV:', error);
}

// Funzione per determinare le categorie di un canale
function getChannelCategories(channel: any): string[] {
    const categories: string[] = [];
    
    if (Array.isArray(channel.categories)) {
        categories.push(...channel.categories);
    } else if (Array.isArray(channel.category)) {
        categories.push(...channel.category);
    } else if (channel.category) {
        categories.push(channel.category);
    }
    
    if (categories.length === 0) {
        const name = channel.name.toLowerCase();
        const description = channel.description.toLowerCase();
        
        if (name.includes('rai') || description.includes('rai')) {
            categories.push('rai');
        }
        if (name.includes('mediaset') || description.includes('mediaset') || 
            name.includes('canale 5') || name.includes('italia') || name.includes('rete 4')) {
            categories.push('mediaset');
        }
        if (name.includes('sky') || description.includes('sky')) {
            categories.push('sky');
        }
        if (name.includes('gulp') || name.includes('yoyo') || name.includes('boing') || name.includes('cartoonito')) {
            categories.push('kids');
        }
        if (name.includes('news') || name.includes('tg') || name.includes('focus')) {
            categories.push('news');
        }
        if (name.includes('sport') || name.includes('tennis') || name.includes('eurosport')) {
            categories.push('sport');
        }
        if (name.includes('cinema') || name.includes('movie') || name.includes('warner')) {
            categories.push('movies');
        }
        if (name.includes('pluto') || description.includes('pluto')) {
            categories.push('pluto');
        }
        
        if (categories.length === 0) {
            categories.push('general');
        }
    }
    
    return categories;
}

// Funzione per risolvere un canale Vavoo usando la cache
function resolveVavooChannelByName(channelName: string): Promise<string | null> {
    return new Promise((resolve) => {
        // Check cache age
        const cacheAge = Date.now() - vavooCache.timestamp;
        const CACHE_MAX_AGE = 12 * 60 * 60 * 1000; // 12 ore in millisecondi
        
        // Se la cache è troppo vecchia o vuota, forzane l'aggiornamento (ma continua comunque a usarla)
        if (cacheAge > CACHE_MAX_AGE || vavooCache.links.size === 0) {
            console.log(`[Vavoo] Cache obsoleta o vuota (età: ${Math.round(cacheAge/3600000)}h), avvio aggiornamento in background...`);
            // Non blocchiamo la risposta, aggiorniamo in background
            updateVavooCache().catch(error => {
                console.error(`[Vavoo] Errore nell'aggiornamento cache:`, error);
            });
        }
        
        // Cerca il canale nella cache
        if (channelName && vavooCache.links.has(channelName)) {
            const cachedUrlRaw = vavooCache.links.get(channelName);
            let cachedUrl: string | null = null;
            if (Array.isArray(cachedUrlRaw)) {
                cachedUrl = cachedUrlRaw[0] || null;
            } else if (typeof cachedUrlRaw === 'string') {
                cachedUrl = cachedUrlRaw;
            }
            console.log(`[Vavoo] Trovato in cache: ${channelName} -> ${cachedUrl ? cachedUrl.substring(0, 50) : 'null'}...`);
            return resolve(cachedUrl);
        }
        
        // Se non è nella cache ma la cache è stata inizializzata
        if (vavooCache.timestamp > 0) {
            console.log(`[Vavoo] Canale ${channelName} non trovato in cache, aggiornamento necessario`);
            // Tenta di aggiornare la cache in background se non è già in corso
            if (!vavooCache.updating) {
                updateVavooCache().catch(error => {
                    console.error(`[Vavoo] Errore nell'aggiornamento cache:`, error);
                });
            }
            return resolve(null);
        }
        
        // Se la cache non è ancora stata inizializzata, chiama lo script Python come fallback
        console.log(`[Vavoo] Cache non inizializzata, chiamo script Python per ${channelName}`);
        const timeout = setTimeout(() => {
            console.log(`[Vavoo] Timeout per canale: ${channelName}`);
            resolve(null);
        }, 5000);

        const options = {
            timeout: 5000,
            env: {
                ...process.env,
                PYTHONPATH: '/usr/local/lib/python3.9/site-packages'
            }
        };
        
        execFile('python3', [path.join(__dirname, '../vavoo_resolver.py'), channelName, '--original-link'], options, (error: Error | null, stdout: string, stderr: string) => {
            clearTimeout(timeout);
            
            if (error) {
                console.error(`[Vavoo] Error for ${channelName}:`, error.message);
                if (stderr) console.error(`[Vavoo] Stderr:`, stderr);
                return resolve(null);
            }
            
            if (!stdout || stdout.trim() === '') {
                console.log(`[Vavoo] No output for ${channelName}`);
                return resolve(null);
            }
            
            const result = stdout.trim();
            console.log(`[Vavoo] Resolved ${channelName} to: ${result.substring(0, 50)}...`);
            
            // Aggiorna la cache con questo risultato
            vavooCache.links.set(channelName, result);
            
            resolve(result);
        });
    });
}

function normalizeProxyUrl(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

// Funzione per creare il builder con configurazione dinamica
function createBuilder(initialConfig: AddonConfig = {}) {
    const manifest = loadCustomConfig();
    
    if (initialConfig.mediaFlowProxyUrl || initialConfig.enableMpd || initialConfig.tmdbApiKey) {
        manifest.name;
    }
    
    const builder = new addonBuilder(manifest);

    // === HANDLER CATALOGO TV ===
    builder.defineCatalogHandler(async ({ type, id, extra }: { type: string; id: string; extra?: any }) => {
        console.log(`📺 CATALOG REQUEST: type=${type}, id=${id}, extra=${JSON.stringify(extra)}`);
        if (type === "tv") {
            // Merge dynamic channels before filtering
            try {
                tvChannels = mergeDynamic(tvChannels);
            } catch (e) {
                console.error('❌ Merge dynamic channels failed:', e);
            }
            let filteredChannels = tvChannels;
            let requestedSlug: string | null = null;

            // === SEARCH HANDLER ===
            if (extra && typeof extra.search === 'string' && extra.search.trim().length > 0) {
                const rawQ = extra.search.trim();
                const tokens = rawQ.toLowerCase().split(/\s+/).filter(Boolean);
                console.log(`🔎 Search (OR+fuzzy) query tokens:`, tokens);
                const seen = new Set<string>();

                const simpleLevenshtein = (a: string, b: string): number => {
                    if (a === b) return 0;
                    const al = a.length, bl = b.length;
                    if (Math.abs(al - bl) > 1) return 99; // prune (we only care distance 0/1)
                    const dp: number[] = Array(bl + 1).fill(0);
                    for (let j = 0; j <= bl; j++) dp[j] = j;
                    for (let i = 1; i <= al; i++) {
                        let prev = dp[0];
                        dp[0] = i;
                        for (let j = 1; j <= bl; j++) {
                            const tmp = dp[j];
                            if (a[i - 1] === b[j - 1]) dp[j] = prev; else dp[j] = Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
                            prev = tmp;
                        }
                    }
                    return dp[bl];
                };

                const tokenMatches = (token: string, hay: string, words: string[]): boolean => {
                    if (!token) return false;
                    if (hay.includes(token)) return true; // substring
                    // prefix match on any word
                    if (words.some(w => w.startsWith(token))) return true;
                    // fuzzy distance 1 on words (only if token length > 3 to avoid noise)
                    if (token.length > 3) {
                        for (const w of words) {
                            if (Math.abs(w.length - token.length) > 1) continue;
                            if (simpleLevenshtein(token, w) <= 1) return true;
                        }
                    }
                    return false;
                };

                filteredChannels = tvChannels.filter((c: any) => {
                    const categories = getChannelCategories(c); // include category slugs
                    const categoryStr = categories.join(' ');
                    const hayRaw = `${c.name || ''} ${(c.description || '')} ${categoryStr}`.toLowerCase();
                    const words = hayRaw.split(/[^a-z0-9]+/).filter(Boolean);
                    const ok = tokens.some((t: string) => tokenMatches(t, hayRaw, words)); // OR logic
                    if (ok) {
                        if (seen.has(c.id)) return false;
                        seen.add(c.id);
                        return true;
                    }
                    return false;
                }).slice(0, 200);
                console.log(`🔎 Search results (OR+fuzzy): ${filteredChannels.length}`);
            } else {
                // === GENRE FILTERING ===
            
            // Filtra per genere se specificato
            if (extra && extra.genre) {
                const genre = extra.genre;
                console.log(`🔍 Filtering by genre: ${genre}`);
                
                // Mappa i nomi dei generi dal manifest ai nomi delle categorie
                const genreMap: { [key: string]: string } = {
                    "RAI": "rai",
                    "Mediaset": "mediaset", 
                    "Sky": "sky",
                    "Bambini": "kids",
                    "News": "news",
                    "Sport": "sport",
                    "Cinema": "movies",
                    "Generali": "general",
                    "Documentari": "documentari",
                    "Pluto": "pluto",
                    "Serie A": "seriea",
                    "Serie B": "serieb",
                    "Serie C": "seriec",
                    "Coppe": "coppe",
                    "Tennis": "tennis",
                    "F1": "f1",
                    "MotoGp": "motogp",
                    "Basket": "basket",
                    "Volleyball": "volleyball",
                    "Ice Hockey": "icehockey",
                    "Wrestling": "wrestling",
                    "Boxing": "boxing",
                    "Darts": "darts",
                    "Baseball": "baseball",
                    "NFL": "nfl"
                };
                
                const targetCategory = genreMap[genre];
                if (targetCategory) {
                    requestedSlug = targetCategory;
                    filteredChannels = tvChannels.filter((channel: any) => {
                        const categories = getChannelCategories(channel);
                        return categories.includes(targetCategory);
                    });
                    console.log(`✅ Filtered to ${filteredChannels.length} channels in category: ${targetCategory}`);
                } else {
                    console.log(`⚠️ Unknown genre: ${genre}`);
                }
            } else {
                console.log(`📺 No genre filter, showing all ${tvChannels.length} channels`);
            }
            }

            // Se filtro richiesto e nessun canale trovato -> aggiungi placeholder
            if (requestedSlug && filteredChannels.length === 0) {
                const PLACEHOLDER_ID = `placeholder-${requestedSlug}`;
                const PLACEHOLDER_LOGO_BASE = 'https://raw.githubusercontent.com/qwertyuiop8899/logo/main';
                const placeholderLogo = `${PLACEHOLDER_LOGO_BASE}/nostream.png`;
                filteredChannels = [{
                    id: PLACEHOLDER_ID,
                    name: 'Nessuno Stream disponibile oggi',
                    logo: placeholderLogo,
                    poster: placeholderLogo,
                    type: 'tv',
                    category: [requestedSlug],
                    description: 'Nessuno Stream disponibile oggi. Live 🔴',
                    _placeholder: true,
                    placeholderVideo: `${PLACEHOLDER_LOGO_BASE}/nostream.mp4`
                }];
            }
            
            // Aggiungi prefisso tv: agli ID, posterShape landscape e EPG
            const tvChannelsWithPrefix = await Promise.all(filteredChannels.map(async (channel: any) => {
                const channelWithPrefix = {
                    ...channel,
                    id: `tv:${channel.id}`,
                    posterShape: "landscape",
                    poster: (channel as any).poster || (channel as any).logo || '',
                    logo: (channel as any).logo || (channel as any).poster || '',
                    background: (channel as any).background || (channel as any).poster || ''
                };
                
                // Per canali dinamici: niente EPG, mostra solo ora inizio evento
                if ((channel as any)._dynamic) {
                    const eventStart = (channel as any).eventStart || (channel as any).eventstart; // fallback
                    const baseDesc = channel.description || '';
                    if (eventStart) {
                        try {
                            const dt = new Date(eventStart);
                            const hhmm = dt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Rome' }).replace(/\./g, ':');
                            // Richiesto: linea unica iniziale con icona e orario + titolo evento
                            channelWithPrefix.description = `🔴 Inizio: ${hhmm} ${channel.name}${baseDesc ? `\n${baseDesc}` : ''}`.trim();
                        } catch {
                            channelWithPrefix.description = baseDesc || channel.name;
                        }
                    } else {
                        channelWithPrefix.description = baseDesc || channel.name;
                    }
                } else if (epgManager) {
                    // Canali tradizionali: EPG
                    try {
                        const epgChannelIds = (channel as any).epgChannelIds;
                        const epgChannelId = epgManager.findEPGChannelId(channel.name, epgChannelIds);
                        if (epgChannelId) {
                            const currentProgram = await epgManager.getCurrentProgram(epgChannelId);
                            if (currentProgram) {
                                const startTime = epgManager.formatTime(currentProgram.start);
                                const endTime = currentProgram.stop ? epgManager.formatTime(currentProgram.stop) : '';
                                const epgInfo = `🔴 ORA: ${currentProgram.title} (${startTime}${endTime ? `-${endTime}` : ''})`;
                                channelWithPrefix.description = `${channel.description || ''}\n\n${epgInfo}`;
                            }
                        }
                    } catch (epgError) {
                        console.error(`❌ Catalog: EPG error for ${channel.name}:`, epgError);
                    }
                }
                
                return channelWithPrefix;
            }));
            
            console.log(`✅ Returning ${tvChannelsWithPrefix.length} TV channels for catalog ${id}`);
            return { metas: tvChannelsWithPrefix };
        }
        console.log(`❌ No catalog found for type=${type}, id=${id}`);
        return { metas: [] };
    });

    // === HANDLER META ===
    builder.defineMetaHandler(async ({ type, id }: { type: string; id: string }) => {
        console.log(`📺 META REQUEST: type=${type}, id=${id}`);
        if (type === "tv") {
            // Gestisci tutti i possibili formati di ID che Stremio può inviare
            let cleanId = id;
            if (id.startsWith('tv:')) {
                cleanId = id.replace('tv:', '');
            } else if (id.startsWith('tv%3A')) {
                cleanId = id.replace('tv%3A', '');
            } else if (id.includes('%3A')) {
                // Decodifica URL-encoded (:)
                cleanId = decodeURIComponent(id);
                if (cleanId.startsWith('tv:')) {
                    cleanId = cleanId.replace('tv:', '');
                }
            }
            
            const channel = tvChannels.find((c: any) => c.id === cleanId);
            if (channel) {
                console.log(`✅ Found channel for meta: ${channel.name}`);
                
                const metaWithPrefix = {
                    ...channel,
                    id: `tv:${channel.id}`,
                    posterShape: "landscape",
                    poster: (channel as any).poster || (channel as any).logo || '',
                    logo: (channel as any).logo || (channel as any).poster || '',
                    background: (channel as any).background || (channel as any).poster || '',
                    genre: Array.isArray((channel as any).category) ? (channel as any).category : [(channel as any).category || 'general'],
                    genres: Array.isArray((channel as any).category) ? (channel as any).category : [(channel as any).category || 'general'],
                    year: new Date().getFullYear().toString(),
                    imdbRating: null,
                    releaseInfo: "Live TV",
                    country: "IT",
                    language: "it"
                };
                
                // Meta: canali dinamici senza EPG con ora inizio
                if ((channel as any)._dynamic) {
                    const eventStart = (channel as any).eventStart || (channel as any).eventstart;
                    const baseDesc = channel.description || '';
                    let finalDesc = baseDesc || channel.name;
                    if (eventStart) {
                        try {
                            const dt = new Date(eventStart);
                            const hhmm = dt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Rome' }).replace(/\./g, ':');
                            finalDesc = `🔴 Inizio: ${hhmm} ${channel.name}${baseDesc ? `\n${baseDesc}` : ''}`.trim();
                        } catch {/* ignore */}
                    }
                    (metaWithPrefix as any).description = finalDesc;
                } else if (epgManager) {
                    // Meta: canali tradizionali con EPG
                    try {
                        const epgChannelIds = (channel as any).epgChannelIds;
                        const epgChannelId = epgManager.findEPGChannelId(channel.name, epgChannelIds);
                        if (epgChannelId) {
                            const currentProgram = await epgManager.getCurrentProgram(epgChannelId);
                            const nextProgram = await epgManager.getNextProgram(epgChannelId);
                            let epgDescription = channel.description || '';
                            if (currentProgram) {
                                const startTime = epgManager.formatTime(currentProgram.start);
                                const endTime = currentProgram.stop ? epgManager.formatTime(currentProgram.stop) : '';
                                epgDescription += `\n\n🔴 IN ONDA ORA (${startTime}${endTime ? `-${endTime}` : ''}): ${currentProgram.title}`;
                                if (currentProgram.description) epgDescription += `\n${currentProgram.description}`;
                            }
                            if (nextProgram) {
                                const nextStartTime = epgManager.formatTime(nextProgram.start);
                                const nextEndTime = nextProgram.stop ? epgManager.formatTime(nextProgram.stop) : '';
                                epgDescription += `\n\n⏭️ A SEGUIRE (${nextStartTime}${nextEndTime ? `-${nextEndTime}` : ''}): ${nextProgram.title}`;
                                if (nextProgram.description) epgDescription += `\n${nextProgram.description}`;
                            }
                            metaWithPrefix.description = epgDescription;
                        }
                    } catch (epgError) {
                        console.error(`❌ Meta: EPG error for ${channel.name}:`, epgError);
                    }
                }
                
                return { meta: metaWithPrefix };
            } else {
                // Fallback per placeholder non persistiti in tvChannels
                if (cleanId.startsWith('placeholder-')) {
                    const slug = cleanId.replace('placeholder-', '') || 'general';
                    const PLACEHOLDER_LOGO_BASE = 'https://raw.githubusercontent.com/qwertyuiop8899/logo/main';
                    const placeholderLogo = `${PLACEHOLDER_LOGO_BASE}/nostream.png`;
                    const placeholderVideo = `${PLACEHOLDER_LOGO_BASE}/nostream.mp4`;
                    const name = 'Nessuno Stream disponibile oggi';
                    const meta = {
                        id: `tv:${cleanId}`,
                        type: 'tv',
                        name,
                        posterShape: 'landscape',
                        poster: placeholderLogo,
                        logo: placeholderLogo,
                        background: placeholderLogo,
                        description: 'Nessuno Stream disponibile oggi. Live 🔴',
                        genre: [slug],
                        genres: [slug],
                        year: new Date().getFullYear().toString(),
                        imdbRating: null,
                        releaseInfo: 'Live TV',
                        country: 'IT',
                        language: 'it',
                        _placeholder: true,
                        placeholderVideo
                    } as any;
                    console.log(`🧩 Generated dynamic placeholder meta for missing channel ${cleanId}`);
                    return { meta };
                }
                console.log(`❌ No meta found for channel ID: ${id}`);
                return { meta: null };
            }
        }
        
        // Meta handler per film/serie (logica originale)
        return { meta: null };
    });

    // === HANDLER STREAM ===
    builder.defineStreamHandler(
        async ({
            id,
            type,
        }: {
            id: string;
            type: string;
        }): Promise<{
            streams: Stream[];
        }> => {
            try {
                console.log(`🔍 Stream request: ${type}/${id}`);
                
                // ✅ USA SEMPRE la configurazione dalla cache globale più aggiornata
                const config = { ...configCache };
                console.log(`🔧 Using global config cache for stream:`, config);
                
                const allStreams: Stream[] = [];
                
                // Prima della logica degli stream TV, aggiungi:
                // Usa sempre lo stesso proxy per tutto
                let mfpUrl = config.mediaFlowProxyUrl ? normalizeProxyUrl(config.mediaFlowProxyUrl) : '';
                let mfpPsw = config.mediaFlowProxyPassword || '';

                // === LOGICA TV ===
                if (type === "tv") {
                    // Improved channel ID parsing to handle different formats from Stremio
                    let cleanId = id;
                    
                    // Gestisci tutti i possibili formati di ID che Stremio può inviare
                    if (id.startsWith('tv:')) {
                        cleanId = id.replace('tv:', '');
                    } else if (id.startsWith('tv%3A')) {
                        cleanId = id.replace('tv%3A', '');
                    } else if (id.includes('%3A')) {
                        // Decodifica URL-encoded (:)
                        cleanId = decodeURIComponent(id);
                        if (cleanId.startsWith('tv:')) {
                            cleanId = cleanId.replace('tv:', '');
                        }
                    }
                    
                    debugLog(`Looking for channel with ID: ${cleanId} (original ID: ${id})`);
                    const channel = tvChannels.find((c: any) => c.id === cleanId);
                    
                    if (!channel) {
                        // Gestione placeholder non presente in tvChannels
                        if (cleanId.startsWith('placeholder-')) {
                            const PLACEHOLDER_LOGO_BASE = 'https://raw.githubusercontent.com/qwertyuiop8899/logo/main';
                            const placeholderVideo = `${PLACEHOLDER_LOGO_BASE}/nostream.mp4`;
                            console.log(`🧩 Placeholder channel requested (ephemeral): ${cleanId}`);
                            return { streams: [ { url: placeholderVideo, title: 'Nessuno Stream' } ] };
                        }
                        console.log(`❌ Channel ${id} not found`);
                        debugLog(`❌ Channel not found in the TV channels list. Original ID: ${id}, Clean ID: ${cleanId}`);
                        return { streams: [] };
                    }

                    // Gestione placeholder: ritorna un singolo "stream" fittizio (immagine)
                    if ((channel as any)._placeholder) {
                        const vid = (channel as any).placeholderVideo || (channel as any).logo || (channel as any).poster || '';
                        return { streams: [ {
                            url: vid,
                            title: 'Nessuno Stream'
                        } ] };
                    }
                    
                    console.log(`✅ Found channel: ${channel.name}`);
                    
                    // Debug della configurazione proxy
                    debugLog(`Config DEBUG - mediaFlowProxyUrl: ${config.mediaFlowProxyUrl}`);
                    debugLog(`Config DEBUG - mediaFlowProxyPassword: ${config.mediaFlowProxyPassword ? '***' : 'NOT SET'}`);
                    
                    let streams: { url: string; title: string }[] = [];

                    // Dynamic event channels: use dynamicDUrls list -> treat each as staticUrlD style
                    if ((channel as any)._dynamic && Array.isArray((channel as any).dynamicDUrls) && (channel as any).dynamicDUrls.length) {
                        for (const d of (channel as any).dynamicDUrls) {
                            if (!d.url) continue;
                            const provider = (d.title || '').trim();
                            const evtTitle = channel.name || '';
                            // nuovo formato: (provider) // Evento  oppure solo Evento se provider mancante
                            const baseTitle = provider ? `(${provider}) // ${evtTitle}` : evtTitle;
                            if (mfpUrl && mfpPsw) {
                                const daddyProxyUrl = `${mfpUrl}/extractor/video?host=DLHD&redirect_stream=true&api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(d.url)}`;
                                streams.push({
                                    url: daddyProxyUrl,
                                    title: baseTitle.trim()
                                });
                            } else {
                                streams.push({
                                    url: d.url,
                                    title: baseTitle.trim()
                                });
                            }
                        }
                    } else {
                        // staticUrlF: Direct for non-dynamic
                        if ((channel as any).staticUrlF) {
                            streams.push({
                                url: (channel as any).staticUrlF,
                                title: `[🌍dTV] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrlF Direct: ${(channel as any).staticUrlF}`);
                        }
                    }

                    // staticUrl (solo se enableMpd è attivo)
                    if ((channel as any).staticUrl && (config.enableMpd === 'on' || process.env.ENABLE_MPD?.toLowerCase() === 'true')) {
                        console.log(`🔧 [staticUrl] Raw URL: ${(channel as any).staticUrl}`);
                        const decodedUrl = decodeStaticUrl((channel as any).staticUrl);
                        console.log(`🔧 [staticUrl] Decoded URL: ${decodedUrl}`);
                        console.log(`🔧 [staticUrl] mfpUrl: ${mfpUrl}`);
                        console.log(`🔧 [staticUrl] mfpPsw: ${mfpPsw ? '***' : 'NOT SET'}`);
                        
                        if (mfpUrl && mfpPsw) {
                            // Parse l'URL decodificato per separare l'URL base dai parametri
                            const urlParts = decodedUrl.split('&');
                            const baseUrl = urlParts[0]; // Primo elemento è l'URL base
                            const additionalParams = urlParts.slice(1); // Resto sono i parametri aggiuntivi
                            
                            // Costruisci l'URL del proxy con l'URL base nel parametro d
                            let proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(baseUrl)}`;
                            
                            // Aggiungi i parametri aggiuntivi (key_id, key, etc.) direttamente all'URL del proxy
                            for (const param of additionalParams) {
                                if (param) {
                                    proxyUrl += `&${param}`;
                                }
                            }
                            
                            streams.push({
                                url: proxyUrl,
                                title: `[📺HD] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrl Proxy (MFP): ${proxyUrl}`);
                        } else {
                            streams.push({
                                url: decodedUrl,
                                title: `[❌Proxy][📺HD] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrl Direct: ${decodedUrl}`);
                        }
                    }
                    // staticUrl2 (solo se enableMpd è attivo)
                    if ((channel as any).staticUrl2 && (config.enableMpd === 'on' || process.env.ENABLE_MPD?.toLowerCase() === 'true')) {
                        console.log(`🔧 [staticUrl2] Raw URL: ${(channel as any).staticUrl2}`);
                        const decodedUrl = decodeStaticUrl((channel as any).staticUrl2);
                        console.log(`🔧 [staticUrl2] Decoded URL: ${decodedUrl}`);
                        console.log(`🔧 [staticUrl2] mfpUrl: ${mfpUrl}`);
                        console.log(`🔧 [staticUrl2] mfpPsw: ${mfpPsw ? '***' : 'NOT SET'}`);
                        
                        if (mfpUrl && mfpPsw) {
                            // Parse l'URL decodificato per separare l'URL base dai parametri
                            const urlParts = decodedUrl.split('&');
                            const baseUrl = urlParts[0]; // Primo elemento è l'URL base
                            const additionalParams = urlParts.slice(1); // Resto sono i parametri aggiuntivi
                            
                            // Costruisci l'URL del proxy con l'URL base nel parametro d
                            let proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(baseUrl)}`;
                            
                            // Aggiungi i parametri aggiuntivi (key_id, key, etc.) direttamente all'URL del proxy
                            for (const param of additionalParams) {
                                if (param) {
                                    proxyUrl += `&${param}`;
                                }
                            }
                            
                            streams.push({
                                url: proxyUrl,
                                title: `[📽️FHD] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrl2 Proxy (MFP): ${proxyUrl}`);
                        } else {
                            streams.push({
                                url: decodedUrl,
                                title: `[❌Proxy][📽️FHD] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrl2 Direct: ${decodedUrl}`);
                        }
                    }

                    // staticUrlMpd (sempre attivo se presente, non dipende da enableMpd)
                    if ((channel as any).staticUrlMpd) {
                        console.log(`🔧 [staticUrlMpd] Raw URL: ${(channel as any).staticUrlMpd}`);
                        const decodedUrl = decodeStaticUrl((channel as any).staticUrlMpd);
                        console.log(`🔧 [staticUrlMpd] Decoded URL: ${decodedUrl}`);
                        console.log(`🔧 [staticUrlMpd] mfpUrl: ${mfpUrl}`);
                        console.log(`🔧 [staticUrlMpd] mfpPsw: ${mfpPsw ? '***' : 'NOT SET'}`);
                        
                        if (mfpUrl && mfpPsw) {
                            // Parse l'URL decodificato per separare l'URL base dai parametri
                            const urlParts = decodedUrl.split('&');
                            const baseUrl = urlParts[0]; // Primo elemento è l'URL base
                            const additionalParams = urlParts.slice(1); // Resto sono i parametri aggiuntivi
                            
                            // Costruisci l'URL del proxy con l'URL base nel parametro d
                            let proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent(baseUrl)}`;
                            
                            // Aggiungi i parametri aggiuntivi (key_id, key, etc.) direttamente all'URL del proxy
                            for (const param of additionalParams) {
                                if (param) {
                                    proxyUrl += `&${param}`;
                                }
                            }
                            
                            streams.push({
                                url: proxyUrl,
                                title: `[🎬MPD] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrlMpd Proxy (MFP): ${proxyUrl}`);
                        } else {
                            streams.push({
                                url: decodedUrl,
                                title: `[❌Proxy][🎬MPD] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrlMpd Direct: ${decodedUrl}`);
                        }
                    }
                    
                    // staticUrlD
                    if ((channel as any).staticUrlD) {
                        if (mfpUrl && mfpPsw) {
                            // Nuova logica: chiama extractor/video con redirect_stream=false, poi costruisci il link proxy/hls/manifest.m3u8
                            const daddyApiBase = `${mfpUrl}/extractor/video?host=DLHD&redirect_stream=false&api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent((channel as any).staticUrlD)}`;
                            try {
                                const res = await fetch(daddyApiBase);
                                if (res.ok) {
                                    const data = await res.json();
                                    let finalUrl = data.mediaflow_proxy_url || `${mfpUrl}/proxy/hls/manifest.m3u8`;
                                    // Aggiungi i parametri di query se presenti
                                    if (data.query_params) {
                                        const params = new URLSearchParams();
                                        for (const [key, value] of Object.entries(data.query_params)) {
                                            if (value !== null) {
                                                params.append(key, String(value));
                                            }
                                        }
                                        finalUrl += (finalUrl.includes('?') ? '&' : '?') + params.toString();
                                    }
                                    // Aggiungi il parametro d per il destination_url
                                    if (data.destination_url) {
                                        const destParam = 'd=' + encodeURIComponent(data.destination_url);
                                        finalUrl += (finalUrl.includes('?') ? '&' : '?') + destParam;
                                    }
                                    // Aggiungi gli header come parametri h_
                                    if (data.request_headers) {
                                        for (const [key, value] of Object.entries(data.request_headers)) {
                                            if (value !== null) {
                                                const headerParam = `h_${key}=${encodeURIComponent(String(value))}`;
                                                finalUrl += '&' + headerParam;
                                            }
                                        }
                                    }
                                    streams.push({
                                        url: finalUrl,
                                        title: `[🌐D] ${channel.name} [ITA]`
                                    });
                                    debugLog(`Aggiunto staticUrlD Proxy (MFP, nuova logica): ${finalUrl}`);
                                } else {
                                    // Fallback: vecchio link
                                    const daddyProxyUrl = `${mfpUrl}/extractor/video?host=DLHD&redirect_stream=true&api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent((channel as any).staticUrlD)}`;
                                    streams.push({
                                        url: daddyProxyUrl,
                                        title: `[🌐D] ${channel.name} [ITA]`
                                    });
                                    debugLog(`Aggiunto staticUrlD Proxy (MFP, fallback): ${daddyProxyUrl}`);
                                }
                            } catch (err) {
                                // Fallback: vecchio link
                                const daddyProxyUrl = `${mfpUrl}/extractor/video?host=DLHD&redirect_stream=true&api_password=${encodeURIComponent(mfpPsw)}&d=${encodeURIComponent((channel as any).staticUrlD)}`;
                                streams.push({
                                    url: daddyProxyUrl,
                                    title: `[🌐D] ${channel.name} [ITA]`
                                });
                                debugLog(`Aggiunto staticUrlD Proxy (MFP, errore): ${daddyProxyUrl}`);
                            }
                        } else {
                            streams.push({
                                url: (channel as any).staticUrlD,
                                title: `[❌Proxy][🌐D] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrlD Direct: ${(channel as any).staticUrlD}`);
                        }
                    }
                    // Vavoo
                    if ((channel as any).name) {
                        // DEBUG LOGS
                        console.log('🔧 [VAVOO] DEBUG - channel.name:', (channel as any).name);
                        const baseName = (channel as any).name.replace(/\s*(\(\d+\)|\d+)$/, '').trim();
                        console.log('🔧 [VAVOO] DEBUG - baseName:', baseName);
                        const variant2 = `${baseName} (2)`;
                        const variantNum = `${baseName} 2`;
                        console.log('🔧 [VAVOO] DEBUG - variant2:', variant2);
                        console.log('🔧 [VAVOO] DEBUG - variantNum:', variantNum);
                        // --- VAVOO: cerca tutte le varianti .<lettera> per ogni nome in vavooNames (case-insensitive), sia originale che normalizzato ---
                        const vavooNamesArr = (channel as any).vavooNames || [channel.name];
                        // LOG RAW delle chiavi della cache
                        console.log('[VAVOO] CACHE KEYS RAW:', Array.from(vavooCache.links.keys()));
                        console.log(`[VAVOO] CERCA: vavooNamesArr =`, vavooNamesArr);
                        const allCacheKeys = Array.from(vavooCache.links.keys());
                        console.log(`[VAVOO] CACHE KEYS:`, allCacheKeys);
                        const foundVavooLinks: { url: string, key: string }[] = [];
                        for (const vavooName of vavooNamesArr) {
                            // Cerca con nome originale
                            console.log(`[VAVOO] CERCA (original): '${vavooName} .<lettera>'`);
                            const variantRegex = new RegExp(`^${vavooName} \.([a-zA-Z])$`, 'i');
                            for (const [key, value] of vavooCache.links.entries()) {
                                if (variantRegex.test(key)) {
                                    console.log(`[VAVOO] MATCH (original): chiave trovata '${key}' per vavooName '${vavooName}'`);
                                    const links = Array.isArray(value) ? value : [value];
                                    for (const url of links) {
                                        foundVavooLinks.push({ url, key });
                                        console.log(`[VAVOO] LINK trovato (original): ${url} (chiave: ${key})`);
                                    }
                                }
                            }
                            // Cerca anche con nome normalizzato (ma solo se diverso)
                            const vavooNameNorm = vavooName.toUpperCase().replace(/\s+/g, ' ').trim();
                            if (vavooNameNorm !== vavooName) {
                                console.log(`[VAVOO] CERCA (normalizzato): '${vavooNameNorm} .<lettera>'`);
                                const variantRegexNorm = new RegExp(`^${vavooNameNorm} \.([a-zA-Z])$`, 'i');
                                for (const [key, value] of vavooCache.links.entries()) {
                                    const keyNorm = key.toUpperCase().replace(/\s+/g, ' ').trim();
                                    if (variantRegexNorm.test(keyNorm)) {
                                        console.log(`[VAVOO] MATCH (normalizzato): chiave trovata '${key}' per vavooNameNorm '${vavooNameNorm}'`);
                                        const links = Array.isArray(value) ? value : [value];
                                        for (const url of links) {
                                            foundVavooLinks.push({ url, key });
                                            console.log(`[VAVOO] LINK trovato (normalizzato): ${url} (chiave: ${key})`);
                                        }
                                    }
                                }
                            }
                        }
                        // Se trovi almeno un link, aggiungi tutti come stream separati numerati
                        if (foundVavooLinks.length > 0) {
                            foundVavooLinks.forEach(({ url, key }, idx) => {
                                const streamTitle = `[✌️V-${idx + 1}] ${channel.name} [ITA]`;
                                if (mfpUrl && mfpPsw) {
                                    const vavooProxyUrl = `${mfpUrl}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(url)}&api_password=${encodeURIComponent(mfpPsw)}`;
                                    streams.push({
                                        title: streamTitle,
                                        url: vavooProxyUrl
                                    });
                                } else {
                                    streams.push({
                                        title: `[❌Proxy]${streamTitle}`,
                                        url
                                    });
                                }
                            });
                            console.log(`[VAVOO] RISULTATO: trovati ${foundVavooLinks.length} link, stream generati:`, streams.map(s => s.title));
                        } else {
                            // fallback: chiave esatta
                            const exact = vavooCache.links.get(channel.name);
                            if (exact) {
                                const links = Array.isArray(exact) ? exact : [exact];
                                links.forEach((url, idx) => {
                                    const streamTitle = `[✌️V-${idx + 1}] ${channel.name} [ITA]`;
                                    if (mfpUrl && mfpPsw) {
                                        const vavooProxyUrl = `${mfpUrl}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(url)}&api_password=${encodeURIComponent(mfpPsw)}`;
                                        streams.push({
                                            title: streamTitle,
                                            url: vavooProxyUrl
                                        });
                                    } else {
                                        streams.push({
                                            title: `[❌Proxy]${streamTitle}`,
                                            url
                                        });
                                    }
                                });
                                console.log(`[VAVOO] RISULTATO: fallback chiave esatta, trovati ${links.length} link, stream generati:`, streams.map(s => s.title));
                            } else {
                                console.log(`[VAVOO] RISULTATO: nessun link trovato per questo canale.`);
                            }
                        }
                    }

                    // --- TVTAP: cerca usando vavooNames ---
                    const vavooNamesArr = (channel as any).vavooNames || [channel.name];
                    console.log(`[TVTap] Cerco canale con vavooNames:`, vavooNamesArr);
                    
                    // Prova ogni nome nei vavooNames
                    for (const vavooName of vavooNamesArr) {
                        try {
                            console.log(`[TVTap] Provo con nome: ${vavooName}`);
                            
                            const tvtapUrl = await new Promise<string | null>((resolve) => {
                                const timeout = setTimeout(() => {
                                    console.log(`[TVTap] Timeout per canale: ${vavooName}`);
                                    resolve(null);
                                }, 5000);

                                const options = {
                                    timeout: 5000,
                                    env: {
                                        ...process.env,
                                        PYTHONPATH: '/usr/local/lib/python3.9/site-packages'
                                    }
                                };
                                
                                execFile('python3', [path.join(__dirname, '../tvtap_resolver.py'), vavooName], options, (error: Error | null, stdout: string, stderr: string) => {
                                    clearTimeout(timeout);
                                    
                                    if (error) {
                                        console.error(`[TVTap] Error for ${vavooName}:`, error.message);
                                        return resolve(null);
                                    }
                                    
                                    if (!stdout || stdout.trim() === '') {
                                        console.log(`[TVTap] No output for ${vavooName}`);
                                        return resolve(null);
                                    }
                                    
                                    const result = stdout.trim();
                                    if (result === 'NOT_FOUND' || result === 'NO_CHANNELS' || result === 'NO_ID' || result === 'STREAM_FAIL') {
                                        console.log(`[TVTap] Channel not found: ${vavooName} (${result})`);
                                        return resolve(null);
                                    }
                                    
                                    if (result.startsWith('http')) {
                                        console.log(`[TVTap] Trovato stream per ${vavooName}: ${result}`);
                                        resolve(result);
                                    } else {
                                        console.log(`[TVTap] Output non valido per ${vavooName}: ${result}`);
                                        resolve(null);
                                    }
                                });
                            });
                            
                            if (tvtapUrl) {
                                const streamTitle = `[📺 TvTap SD] ${channel.name} [ITA]`;
                                if (mfpUrl && mfpPsw) {
                                    const tvtapProxyUrl = `${mfpUrl}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(tvtapUrl)}&api_password=${encodeURIComponent(mfpPsw)}`;
                                    streams.push({
                                        title: streamTitle,
                                        url: tvtapProxyUrl
                                    });
                                } else {
                                    streams.push({
                                        title: `[❌Proxy]${streamTitle}`,
                                        url: tvtapUrl
                                    });
                                }
                                console.log(`[TVTap] RISULTATO: stream aggiunto per ${channel.name} tramite ${vavooName}`);
                                break; // Esci dal loop se trovi un risultato
                            }
                        } catch (error) {
                            console.error(`[TVTap] Errore per vavooName ${vavooName}:`, error);
                        }
                    }
                    
                    if (streams.length === 0) {
                        console.log(`[TVTap] RISULTATO: nessun stream trovato per ${channel.name}`);
                    }

                    // ============ END INTEGRATION SECTIONS ============

                    // Dopo aver popolato streams (nella logica TV):
                    for (const s of streams) {
                        allStreams.push({
                            name: 'Live 🔴',
                            title: s.title,
                            url: s.url
                        });
                    }

                    // 5. AGGIUNGI STREAM ALTERNATIVI/FALLBACK per canali specifici
                    // RIMOSSO: Blocco che aggiunge fallback stream alternativi per canali Sky (skyFallbackUrls) se finalStreams.length < 3
                    // return { streams: finalStreamsWithRealUrls };
                }
                
                // === LOGICA ANIME/FILM (originale) ===
                // Per tutto il resto, usa solo mediaFlowProxyUrl/mediaFlowProxyPassword
                // Gestione AnimeUnity per ID Kitsu o MAL con fallback variabile ambiente
                const animeUnityEnabled = (config.animeunityEnabled === 'on') || 
                                        (process.env.ANIMEUNITY_ENABLED?.toLowerCase() === 'true');
                
                // Gestione AnimeSaturn per ID Kitsu o MAL con fallback variabile ambiente
                const animeSaturnEnabled = (config.animesaturnEnabled === 'on') || 
                                        (process.env.ANIMESATURN_ENABLED?.toLowerCase() === 'true');
                
                // Gestione parallela AnimeUnity e AnimeSaturn per ID Kitsu, MAL, IMDB, TMDB
                if ((id.startsWith('kitsu:') || id.startsWith('mal:') || id.startsWith('tt') || id.startsWith('tmdb:')) && (animeUnityEnabled || animeSaturnEnabled)) {
                    const animeUnityConfig: AnimeUnityConfig = {
                        enabled: animeUnityEnabled,
                        mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                        mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                        tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0'
                    };
                    const animeSaturnConfig = {
                        enabled: animeSaturnEnabled,
                        mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                        mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                        mfpProxyUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                        mfpProxyPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                        tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0'
                    };
                    let animeUnityStreams: Stream[] = [];
                    let animeSaturnStreams: Stream[] = [];
                    // Parsing stagione/episodio per IMDB/TMDB
                    let seasonNumber: number | null = null;
                    let episodeNumber: number | null = null;
                    let isMovie = false;
                    if (id.startsWith('tt') || id.startsWith('tmdb:')) {
                        // Esempio: tt1234567:1:2 oppure tmdb:12345:1:2
                        const parts = id.split(':');
                        if (parts.length === 1) {
                            isMovie = true;
                        } else if (parts.length === 2) {
                            episodeNumber = parseInt(parts[1]);
                        } else if (parts.length === 3) {
                            seasonNumber = parseInt(parts[1]);
                            episodeNumber = parseInt(parts[2]);
                        }
                    }
                    // AnimeUnity
                    if (animeUnityEnabled) {
                        try {
                            const animeUnityProvider = new AnimeUnityProvider(animeUnityConfig);
                            let animeUnityResult;
                            if (id.startsWith('kitsu:')) {
                                console.log(`[AnimeUnity] Processing Kitsu ID: ${id}`);
                                animeUnityResult = await animeUnityProvider.handleKitsuRequest(id);
                            } else if (id.startsWith('mal:')) {
                                console.log(`[AnimeUnity] Processing MAL ID: ${id}`);
                                animeUnityResult = await animeUnityProvider.handleMalRequest(id);
                            } else if (id.startsWith('tt')) {
                                console.log(`[AnimeUnity] Processing IMDB ID: ${id}`);
                                animeUnityResult = await animeUnityProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                            } else if (id.startsWith('tmdb:')) {
                                console.log(`[AnimeUnity] Processing TMDB ID: ${id}`);
                                animeUnityResult = await animeUnityProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                            }
                            if (animeUnityResult && animeUnityResult.streams) {
                                animeUnityStreams = animeUnityResult.streams;
                                for (const s of animeUnityResult.streams) {
                                    allStreams.push({ ...s, name: 'StreamViX AU' });
                                }
                            }
                        } catch (error) {
                            console.error('🚨 AnimeUnity error:', error);
                        }
                    }
                    // AnimeSaturn
                    if (animeSaturnEnabled) {
                        try {
                            const { AnimeSaturnProvider } = await import('./providers/animesaturn-provider');
                            const animeSaturnProvider = new AnimeSaturnProvider(animeSaturnConfig);
                            let animeSaturnResult;
                            if (id.startsWith('kitsu:')) {
                                console.log(`[AnimeSaturn] Processing Kitsu ID: ${id}`);
                                animeSaturnResult = await animeSaturnProvider.handleKitsuRequest(id);
                            } else if (id.startsWith('mal:')) {
                                console.log(`[AnimeSaturn] Processing MAL ID: ${id}`);
                                animeSaturnResult = await animeSaturnProvider.handleMalRequest(id);
                            } else if (id.startsWith('tt')) {
                                console.log(`[AnimeSaturn] Processing IMDB ID: ${id}`);
                                animeSaturnResult = await animeSaturnProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                            } else if (id.startsWith('tmdb:')) {
                                console.log(`[AnimeSaturn] Processing TMDB ID: ${id}`);
                                animeSaturnResult = await animeSaturnProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                            }
                            if (animeSaturnResult && animeSaturnResult.streams) {
                                animeSaturnStreams = animeSaturnResult.streams;
                                for (const s of animeSaturnResult.streams) {
                                    allStreams.push({ ...s, name: 'StreamViX AS' });
                                }
                            }
                        } catch (error) {
                            console.error('[AnimeSaturn] Errore:', error);
                        }
                    }
                }
                
                // Mantieni logica VixSrc per tutti gli altri ID
                if (!id.startsWith('kitsu:') && !id.startsWith('mal:') && !id.startsWith('tv:')) {
                    console.log(`📺 Processing non-Kitsu or MAL ID with VixSrc: ${id}`);
                    
                    const finalConfig: ExtractorConfig = {
                        tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0',
                        mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL,
                        mfpPsw: config.mediaFlowProxyPassword || process.env.MFP_PSW
                    };

                    const res: VixCloudStreamInfo[] | null = await getStreamContent(id, type, finalConfig);

                    if (res) {
                        for (const st of res) {
                            if (st.streamUrl == null) continue;
                            
                            console.log(`Adding stream with title: "${st.name}"`);

                            allStreams.push({
                                title: st.name,
                                name: 'StreamViX Vx',
                                url: st.streamUrl,
                                behaviorHints: {
                                    notWebReady: true,
                                    headers: { "Referer": st.referer },
                                },
                            });
                        }
                        console.log(`📺 VixSrc streams found: ${res.length}`);
                    }
                }
                
                console.log(`✅ Total streams returned: ${allStreams.length}`);
                return { streams: allStreams };
            } catch (error) {
                console.error('Stream extraction failed:', error);
                return { streams: [] };
            }
        }
    );

    return builder;
}

// Server Express
const app = express();

app.use('/public', express.static(path.join(__dirname, '..', 'public')));

// ✅ CORRETTO: Annotazioni di tipo esplicite per Express
app.get('/', (_: Request, res: Response) => {
    const manifest = loadCustomConfig();
    const landingHTML = landingTemplate(manifest);
    res.setHeader('Content-Type', 'text/html');
    res.send(landingHTML);
});

// ✅ Middleware semplificato che usa sempre il router globale
app.use((req: Request, res: Response, next: NextFunction) => {
    debugLog(`Incoming request: ${req.method} ${req.path}`);
    debugLog(`Full URL: ${req.url}`);
    debugLog(`Path segments:`, req.path.split('/'));
    
    const configString = req.path.split('/')[1];
    debugLog(`Config string extracted: "${configString}" (length: ${configString ? configString.length : 0})`);
    
    // AGGIORNA SOLO LA CACHE GLOBALE senza ricreare il builder
    if (configString && configString.includes('eyJtZnBQcm94eVVybCI6Imh0dHA6Ly8xOTIuMTY4LjEuMTAwOjkwMDAi')) {
        debugLog('📌 Found known MFP config pattern, updating global cache');
        // Non forzare più nessun valore hardcoded, lascia solo la configurazione fornita
        // Object.assign(configCache, { ... }); // RIMOSSO
    }
    
    // Altri parsing di configurazione (PRIMA della logica TV)
    if (configString && configString.length > 10 && !configString.startsWith('stream') && !configString.startsWith('meta') && !configString.startsWith('manifest')) {
        const parsedConfig = parseConfigFromArgs(configString);
        if (Object.keys(parsedConfig).length > 0) {
            debugLog('� Found valid config in URL, updating global cache');
            Object.assign(configCache, parsedConfig);
            debugLog('� Updated global config cache:', configCache);
        }
    }
    
    // Per le richieste di stream TV, assicurati che la configurazione proxy sia sempre presente
    if (req.url.includes('/stream/tv/') || req.url.includes('/stream/tv%3A')) {
        debugLog('📺 TV Stream request detected, ensuring MFP configuration');
        // Non applicare più nessun fallback hardcoded
        // if (!configCache.mfpProxyUrl || !configCache.mfpProxyPassword) { ... } // RIMOSSO
        debugLog('📺 Current proxy config for TV streams:', configCache);
    }
    
    // Altri parsing di configurazione
    if (configString && configString.length > 10 && !configString.startsWith('stream') && !configString.startsWith('meta') && !configString.startsWith('manifest')) {
        const parsedConfig = parseConfigFromArgs(configString);
        if (Object.keys(parsedConfig).length > 0) {
            debugLog('� Found valid config in URL, updating global cache');
            Object.assign(configCache, parsedConfig);
            debugLog('� Updated global config cache:', configCache);
        }
    }
    
    // ✅ Inizializza il router globale se non è ancora stato fatto
    if (!globalRouter) {
        console.log('🔧 Initializing global router...');
        globalBuilder = createBuilder(configCache);
        globalAddonInterface = globalBuilder.getInterface();
        globalRouter = getRouter(globalAddonInterface);
        console.log('✅ Global router initialized');
    }
    
    // USA SEMPRE il router globale
    globalRouter(req, res, next);
});

// ============ TVTAP RESOLVE ENDPOINT ============
// Endpoint per risolvere i link TVTap in tempo reale
app.get('/tvtap-resolve/:channelId', async (req: Request, res: Response) => {
    const { channelId } = req.params;
    console.log(`[TVTap] Richiesta risoluzione per canale ID: ${channelId}`);
    
    try {
        // Chiama lo script Python per ottenere il link stream
        const timeout = setTimeout(() => {
            console.log(`[TVTap] Timeout per canale ID: ${channelId}`);
            res.status(408).json({ error: 'TVTap timeout' });
        }, 10000);

        const options = {
            timeout: 10000,
            env: {
                ...process.env,
                PYTHONPATH: '/usr/local/lib/python3.9/site-packages'
            }
        };
        
        execFile('python3', [
            path.join(__dirname, '../tvtap_resolver.py'), 
            // Se channelId è un numero, usa il formato tvtap_id:, altrimenti cerca per nome
            /^\d+$/.test(channelId) ? `tvtap_id:${channelId}` : channelId
        ], options, (error: Error | null, stdout: string, stderr: string) => {
            clearTimeout(timeout);
            
            if (error) {
                console.error(`[TVTap] Error resolving channel ${channelId}:`, error.message);
                if (stderr) console.error(`[TVTap] Stderr:`, stderr);
                return res.status(500).json({ error: 'TVTap resolution failed' });
            }
            
            if (!stdout || stdout.trim() === '') {
                console.log(`[TVTap] No output for channel ${channelId}`);
                return res.status(404).json({ error: 'TVTap stream not found' });
            }
            
            const streamUrl = stdout.trim();
            console.log(`[TVTap] Resolved channel ${channelId} to: ${streamUrl.substring(0, 50)}...`);
            
            // Redirigi al link stream
            res.redirect(streamUrl);
        });
        
    } catch (error) {
        console.error(`[TVTap] Exception resolving channel ${channelId}:`, error);
        res.status(500).json({ error: 'TVTap resolution exception' });
    }
});

// ================= MANUAL LIVE UPDATE ENDPOINT =================
// GET /live/update?token=XYZ (token optional if LIVE_UPDATE_TOKEN not set)
app.get('/live/update', async (req: Request, res: Response) => {
    try {
        const requiredToken = process?.env?.LIVE_UPDATE_TOKEN;
        const provided = (req.query.token as string) || '';
        if (requiredToken && provided !== requiredToken) {
            return res.status(403).json({ ok: false, error: 'Forbidden' });
        }
        // Esegue Live.py immediatamente (se esiste) e ricarica i canali
        // riutilizza executeLiveScript già definita nello scheduler.
        // Per evitare race con scheduler, non serve lock: executeLiveScript usa una singola run.
        await (async () => { try { await (executeLiveScript as any)(); } catch {} })();
        return res.json({ ok: true, message: 'Live.py eseguito (se presente) e canali ricaricati' });
    } catch (e: any) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
// ================================================================

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
    console.log(`Addon server running on http://127.0.0.1:${PORT}`);
});

// Funzione per assicurarsi che le directory di cache esistano
function ensureCacheDirectories(): void {
    try {
        // Directory per la cache Vavoo
        const cacheDir = path.join(__dirname, '../cache');
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
            console.log(`📁 Directory cache creata: ${cacheDir}`);
        }
    } catch (error) {
        console.error('❌ Errore nella creazione delle directory di cache:', error);
    }
}

// Assicurati che le directory di cache esistano all'avvio
ensureCacheDirectories();

// ================== LIVE EVENTS SCHEDULER (Live.py) ==================
// Esegue lo script Live.py alle 10:00 e 15:00 Europe/Rome, ricarica i canali dinamici
// Lo script Python dovrà scrivere config/dynamic_channels.json con il formato previsto.

interface ScheduledRun {
    hour: number;
    minute: number;
}

const LIVE_SCRIPT_PATH = path.join(__dirname, '..', 'Live.py');
const LIVE_LOG_DIR = path.join(__dirname, '../logs');
const LIVE_LOG_FILE = path.join(LIVE_LOG_DIR, 'live_scheduler.log');
if (!fs.existsSync(LIVE_LOG_DIR)) {
    try { fs.mkdirSync(LIVE_LOG_DIR, { recursive: true }); } catch { /* ignore */ }
}

const liveRuns: ScheduledRun[] = [
    { hour: 10, minute: 0 }, // 10:00 CET/CEST
    { hour: 15, minute: 0 }  // 15:00 CET/CEST
];

function logLive(msg: string, ...extra: any[]) {
    const stamp = new Date().toISOString();
    const line = `${stamp} [LIVE] ${msg} ${extra.length ? JSON.stringify(extra) : ''}\n`;
    try { fs.appendFileSync(LIVE_LOG_FILE, line); } catch { /* ignore */ }
    console.log(line.trim());
}

function nowRome(): Date {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
}

function computeDelayToNextRun(): number {
    const romeNow = nowRome();
    let nextDiff = Number.MAX_SAFE_INTEGER;
    for (const run of liveRuns) {
        const target = new Date(romeNow.getTime());
        target.setHours(run.hour, run.minute, 0, 0);
        let diff = target.getTime() - romeNow.getTime();
        if (diff < 0) diff += 24 * 60 * 60 * 1000; // giorno successivo
        if (diff < nextDiff) nextDiff = diff;
    }
    return nextDiff === Number.MAX_SAFE_INTEGER ? 60 * 60 * 1000 : nextDiff;
}

async function executeLiveScript() {
    if (!fs.existsSync(LIVE_SCRIPT_PATH)) {
        logLive('Live.py non trovato, skip esecuzione');
        return;
    }
    logLive('Esecuzione Live.py avviata');
    try {
        const { execFile } = require('child_process');
        await new Promise<void>((resolve) => {
            const child = execFile('python3', [LIVE_SCRIPT_PATH], { timeout: 1000 * 60 * 4 }, (err: any, stdout: string, stderr: string) => {
                if (stdout) logLive('Output Live.py', stdout.slice(0, 800));
                if (stderr) logLive('Stderr Live.py', stderr.slice(0, 800));
                if (err) logLive('Errore Live.py', err.message || err);
                resolve();
            });
            // Safety: se child resta appeso oltre timeout integrato execFile lancerà errore
            child.on('error', (e: any) => logLive('Errore processo Live.py', e.message || e));
        });
        // Ricarica canali dinamici (force) e svuota cache tvChannels merge (ricarico solo dynamic parte)
        loadDynamicChannels(true);
        logLive('Reload canali dinamici completato dopo Live.py');
    } catch (e: any) {
        logLive('Eccezione esecuzione Live.py', e?.message || String(e));
    }
}

function scheduleNextLiveRun() {
    const delay = computeDelayToNextRun();
    logLive('Prossima esecuzione Live.py tra ms', delay);
    setTimeout(async () => {
        await executeLiveScript();
        scheduleNextLiveRun();
    }, delay);
}

// Avvia scheduler dopo avvio server (dopo breve delay per evitare conflitto startup)
setTimeout(() => {
    logLive('Scheduler Live eventi attivato');
    scheduleNextLiveRun();
}, 5000);
// ====================================================================
