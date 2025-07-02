import { addonBuilder, getRouter, Manifest, Stream } from "stremio-addon-sdk";
import { getStreamContent, VixCloudStreamInfo, ExtractorConfig } from "./extractor";
import * as fs from 'fs';
import { landingTemplate } from './landingPage';
import * as path from 'path';
import express, { Request, Response, NextFunction } from 'express'; // ✅ CORRETTO: Import tipizzato
import { AnimeUnityProvider } from './providers/animeunity-provider';
import { KitsuProvider } from './providers/kitsu'; 
import { formatMediaFlowUrl } from './utils/mediaflow';
import { AnimeUnityConfig } from "./types/animeunity";

// Interfaccia per la configurazione URL
interface AddonConfig {
  mediaFlowProxyUrl?: string;
  mediaFlowProxyPassword?: string;
  tmdbApiKey?: string;
  bothLinks?: string;
  animeunityEnabled?: string;
  animesaturnEnabled?: string;
  [key: string]: any;
}

// Base manifest configuration
const baseManifest: Manifest = {
    id: "org.stremio.vixcloud",
    version: "2.0.1",
    name: "StreamViX",
    description: "Addon for Vixsrc and AnimeUnity streams.", 
    icon: "/public/icon.png",
    background: "/public/backround.png",
    types: ["movie", "series"],
    idPrefixes: ["tt", "kitsu"],
    catalogs: [],
    resources: ["stream"],
    behaviorHints: {
        configurable: true
    },
    config: [
        {
            key: "tmdbApiKey",
            title: "TMDB API Key",
            type: "password"
        },
        {
            key: "mediaFlowProxyUrl", 
            title: "MediaFlow Proxy URL",
            type: "text"
        },
        {
            key: "mediaFlowProxyPassword",
            title: "MediaFlow Proxy Password ", 
            type: "password"
        },
        {
            key: "bothLinks",
            title: "Mostra entrambi i link (Proxy e Direct)",
            type: "checkbox"
        },
        {
            key: "animeunityEnabled",
            title: "Enable AnimeUnity (Kitsu Catalog)",
            type: "checkbox"
        },
        {
            key: "animesaturnEnabled",
            title: "Enable AnimeSaturn (Kitsu/MAL Catalog)",
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
    
    if (typeof args === 'string') {
        try {
            const decoded = decodeURIComponent(args);
            const parsed = JSON.parse(decoded);
            return parsed;
        } catch (error) {
            return {};
        }
    }
    
    if (typeof args === 'object' && args !== null) {
        return args;
    }
    
    return config;
}

// Funzione per creare il builder con configurazione dinamica
function createBuilder(config: AddonConfig = {}) {
    const manifest = loadCustomConfig();
    
    if (config.mediaFlowProxyUrl || config.bothLinks || config.tmdbApiKey) {
        manifest.name;
    }
    
    const builder = new addonBuilder(manifest);

    builder.defineStreamHandler(
        async ({
            id,
            type,
        }: {  // ✅ CORRETTO: Annotazioni di tipo esplicite
            id: string;
            type: string;
        }): Promise<{
            streams: Stream[];
        }> => {
            try {
                console.log(`🔍 Stream request: ${type}/${id}`);
                
                const allStreams: Stream[] = [];
                
                // Gestione AnimeUnity per ID Kitsu o MAL con fallback variabile ambiente
                const animeUnityEnabled = (config.animeunityEnabled === 'on') || 
                                        (process.env.ANIMEUNITY_ENABLED?.toLowerCase() === 'true');
                
                // Gestione parallela AnimeUnity e AnimeSaturn per ID Kitsu o MAL
                if ((id.startsWith('kitsu:') || id.startsWith('mal:')) && (animeUnityEnabled || config.animesaturnEnabled === 'on')) {
                    const bothLinkValue = config.bothLinks === 'on';
                    const animeUnityConfig: AnimeUnityConfig = {
                        enabled: animeUnityEnabled,
                        mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                        mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                        bothLink: bothLinkValue
                    };
                    const animeSaturnConfig = {
                        enabled: config.animesaturnEnabled === 'on',
                        mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL || '',
                        mfpPassword: config.mediaFlowProxyPassword || process.env.MFP_PSW || '',
                        bothLink: bothLinkValue
                    };
                    let animeUnityStreams: Stream[] = [];
                    let animeSaturnStreams: Stream[] = [];
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
                            }
                            if (animeUnityResult && animeUnityResult.streams) {
                                animeUnityStreams = animeUnityResult.streams;
                                allStreams.push(...animeUnityResult.streams);
                            }
                        } catch (error) {
                            console.error('🚨 AnimeUnity error:', error);
                        }
                    }
                    // AnimeSaturn
                    if (config.animesaturnEnabled === 'on') {
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
                            }
                            if (animeSaturnResult && animeSaturnResult.streams) {
                                animeSaturnStreams = animeSaturnResult.streams;
                                allStreams.push(...animeSaturnResult.streams);
                            }
                        } catch (error) {
                            console.error('[AnimeSaturn] Errore:', error);
                        }
                    }
                }
                
                // Mantieni logica VixSrc per tutti gli altri ID
                if (!id.startsWith('kitsu:') && !id.startsWith('mal:')) {
                    console.log(`📺 Processing non-Kitsu or MAL ID with VixSrc: ${id}`);
                    
                    let bothLinkValue: boolean;
                    if (config.bothLinks !== undefined) {
                        bothLinkValue = config.bothLinks === 'on';
                    } else {
                        bothLinkValue = process.env.BOTHLINK?.toLowerCase() === 'true';
                    }

                    const finalConfig: ExtractorConfig = {
                        tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY,
                        mfpUrl: config.mediaFlowProxyUrl || process.env.MFP_URL,
                        mfpPsw: config.mediaFlowProxyPassword || process.env.MFP_PSW,
                        bothLink: bothLinkValue
                    };

                    const res: VixCloudStreamInfo[] | null = await getStreamContent(id, type, finalConfig);

                    if (res) {
                        for (const st of res) {
                            if (st.streamUrl == null) continue;
                            
                            console.log(`Adding stream with title: "${st.name}"`);

                            const streamName = st.source === 'proxy' ? 'StreamViX (Proxy)' : 'StreamViX';
                            
                            allStreams.push({
                                title: st.name,
                                name: streamName,
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

app.use((req: Request, res: Response, next: NextFunction) => {
    const configString = req.path.split('/')[1];
    const config = parseConfigFromArgs(configString);
    const builder = createBuilder(config);
    
    const addonInterface = builder.getInterface();
    const router = getRouter(addonInterface);
    
    router(req, res, next);
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => {
    console.log(`Addon server running on http://127.0.0.1:${PORT}`);
});
