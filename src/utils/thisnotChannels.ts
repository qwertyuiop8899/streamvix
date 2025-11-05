// ThisNot channels updater
import { DynamicChannel, loadDynamicChannels, saveDynamicChannels } from './dynamicChannels';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { HttpsProxyAgent } from 'https-proxy-agent';

const THISNOT_CATEGORY = 'thisnot';
const BASE_URL = "https://thisnot.business";
const PASSWORD = "2025";
const LOGO_URL = "https://github.com/qwertyuiop8899/logo/blob/main/TSNT.png?raw=true";

const COMPETITIONS: Record<string, string> = {
    "Serie A": `${BASE_URL}/serieA.php`,
    "Bundesliga": `${BASE_URL}/bundesliga.php`,
    "LaLiga": `${BASE_URL}/laliga.php`,
    "Premier League": `${BASE_URL}/premierleague.php`,
    "Champions League": `${BASE_URL}/championsleague.php`,
};

interface ThisNotChannel {
    name: string;
    staticUrlMpd: string;
    logo: string;
}

// Client HTTP con cookie e fallback proxy
const jar = new CookieJar();
const proxyUrl = process.env.DLHD_PROXY;

// Client senza proxy (default)
const clientDirectConfig = {
    jar,
    withCredentials: true,
    timeout: 15000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
};

const clientDirect = wrapper(axios.create(clientDirectConfig));

// Client con proxy (fallback)
let clientProxy: any = null;
if (proxyUrl) {
    const proxyAgent = new HttpsProxyAgent(proxyUrl);
    const clientProxyConfig = {
        jar,
        withCredentials: true,
        timeout: 30000,
        httpAgent: proxyAgent,
        httpsAgent: proxyAgent,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    };
    clientProxy = wrapper(axios.create(clientProxyConfig));
    console.log(`🔧 [ThisNot] Proxy fallback configurato: ${proxyUrl.split('@')[1] || proxyUrl}`);
} else {
    console.log(`ℹ️  [ThisNot] Nessun proxy fallback (DLHD_PROXY non impostato)`);
}

// Helper per fare richieste con fallback automatico
async function makeRequest(url: string, options: any = {}): Promise<any> {
    // Prima prova senza proxy
    try {
        console.log(`🌐 [ThisNot] Tentativo connessione diretta: ${url}`);
        const response = await clientDirect.get(url, options);
        console.log(`✅ [ThisNot] Connessione diretta riuscita`);
        return response;
    } catch (directError: any) {
        console.log(`⚠️  [ThisNot] Connessione diretta fallita: ${directError.message}`);
        
        // Se c'è un proxy configurato, riprova con proxy
        if (clientProxy) {
            try {
                console.log(`🔄 [ThisNot] Tentativo con proxy fallback...`);
                const response = await clientProxy.get(url, options);
                console.log(`✅ [ThisNot] Connessione con proxy riuscita`);
                return response;
            } catch (proxyError: any) {
                console.log(`❌ [ThisNot] Anche il proxy ha fallito: ${proxyError.message}`);
                throw proxyError;
            }
        } else {
            throw directError;
        }
    }
}

// Helper per POST con fallback automatico
async function makePostRequest(url: string, data: any, options: any = {}): Promise<any> {
    // Prima prova senza proxy
    try {
        const response = await clientDirect.post(url, data, options);
        return response;
    } catch (directError: any) {
        // Se c'è un proxy configurato, riprova con proxy
        if (clientProxy) {
            try {
                console.log(`🔄 [ThisNot] Tentativo POST con proxy fallback...`);
                const response = await clientProxy.post(url, data, options);
                return response;
            } catch (proxyError: any) {
                throw proxyError;
            }
        } else {
            throw directError;
        }
    }
}

async function performLogin(url: string, pwd: string): Promise<boolean> {
    console.log(`\n🔑 Tentativo di login su ${url}`);
    try {
        const response = await makeRequest(url);
        const $ = cheerio.load(response.data);
        const form = $('form').first();
        
        let actionUrl = url;
        const inputs: Record<string, string> = {};
        
        if (form.length > 0) {
            const action = form.attr('action');
            if (action) {
                actionUrl = new URL(action, BASE_URL).href;
            }
            
            form.find('input').each((_, elem) => {
                const name = $(elem).attr('name');
                if (name) {
                    inputs[name] = $(elem).attr('value') || '';
                }
            });
        }
        
        inputs['password'] = pwd;
        
        const loginResponse = await makePostRequest(actionUrl, new URLSearchParams(inputs), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        
        if (!loginResponse.data.toUpperCase().includes("INSERIRE PASSWORD")) {
            console.log("✅ Login riuscito");
            return true;
        }
        
        console.log("❌ Password non accettata");
        return false;
    } catch (e) {
        console.log(`Errore nel login: ${e}`);
        return false;
    }
}

async function getPageContent(url: string): Promise<string | null> {
    try {
        const response = await makeRequest(url);
        return response.data;
    } catch (e) {
        console.log(`Errore nel caricamento di ${url}: ${e}`);
        return null;
    }
}

function decodeToken(tokenRaw: string): { keyid: string | null, key: string | null } {
    try {
        const missingPadding = tokenRaw.length % 4;
        if (missingPadding) {
            tokenRaw += "=".repeat(4 - missingPadding);
        }
        
        const decodedBytes = Buffer.from(tokenRaw, 'base64');
        const decodedStr = decodedBytes.toString('utf-8');
        
        let keyid: string, key: string;
        
        if (decodedStr.includes(':')) {
            const parts = decodedStr.split(':', 2);
            keyid = parts[0];
            key = parts[1];
        } else if (decodedStr.trim().startsWith('{')) {
            const data = JSON.parse(decodedStr);
            const entries = Object.entries(data);
            if (entries.length > 0) {
                [keyid, key] = entries[0] as [string, string];
            } else {
                console.log(`⚠️ Formato token sconosciuto: ${decodedStr}`);
                return { keyid: null, key: null };
            }
        } else {
            console.log(`⚠️ Formato token sconosciuto: ${decodedStr}`);
            return { keyid: null, key: null };
        }
        
        return { keyid: keyid.toLowerCase(), key: key.toLowerCase() };
    } catch (e) {
        console.log(`❌ Errore decodifica token '${tokenRaw}': ${e}`);
        return { keyid: null, key: null };
    }
}

function createStaticUrlMpd(mpdUrl: string, keyid: string, key: string): string {
    const urlWithKeys = `${mpdUrl}&key_id=${keyid}&key=${key}`;
    return Buffer.from(urlWithKeys).toString('base64');
}

function parseDate(dateText: string): string {
    try {
        const match = dateText.match(/(\d+)\s+(\w+)/i);
        if (!match) return '';
        
        const day = match[1].padStart(2, '0');
        const monthMap: Record<string, string> = {
            'gennaio': '01', 'febbraio': '02', 'marzo': '03', 'aprile': '04',
            'maggio': '05', 'giugno': '06', 'luglio': '07', 'agosto': '08',
            'settembre': '09', 'ottobre': '10', 'novembre': '11', 'dicembre': '12'
        };
        
        const monthName = match[2].toLowerCase();
        const month = monthMap[monthName] || '00';
        
        return `${day}-${month}`;
    } catch (e) {
        return '';
    }
}

async function processCompetition(name: string, url: string): Promise<ThisNotChannel[]> {
    console.log(`\n🏆 Elaborazione competizione: ${name} (${url})`);
    
    const htmlContent = await getPageContent(url);
    if (!htmlContent) {
        console.log(`❌ Impossibile caricare la pagina di ${name}`);
        return [];
    }
    
    const $ = cheerio.load(htmlContent);
    const channels: ThisNotChannel[] = [];
    
    let currentDate = '';
    const allElements: any[] = [];
    
    $('body').find('.data, .match-row').each((_, elem) => {
        allElements.push(elem);
    });
    
    for (let i = 0; i < allElements.length; i++) {
        const elem = allElements[i];
        
        if ($(elem).hasClass('data')) {
            const dateText = $(elem).text().trim();
            currentDate = parseDate(dateText);
            continue;
        }
        
        try {
            const homeDiv = $(elem).find('.home.team');
            const awayDiv = $(elem).find('.away.team');
            
            if (homeDiv.length === 0 || awayDiv.length === 0) {
                continue;
            }
            
            const homeTeam = homeDiv.find('span').text().trim() || "Sconosciuta";
            const awayTeam = awayDiv.find('span').text().trim() || "Sconosciuta";
            const matchName = `${homeTeam} VS ${awayTeam}`;
            
            // Estrai l'orario dalla classe .tile.time
            const timeDiv = $(elem).find('.tile.time');
            const matchTime = timeDiv.length > 0 ? timeDiv.text().trim() : '';
            
            console.log(`\n⚽ ${matchName}${matchTime ? ` (${matchTime})` : ''}`);
            
            const playerTag = $(elem).find('a[href]');
            if (playerTag.length === 0) {
                continue;
            }
            
            const playerHref = playerTag.attr('href');
            if (!playerHref) {
                continue;
            }
            
            const playerUrl = new URL(playerHref, BASE_URL).href;
            const playerContent = await getPageContent(playerUrl);
            
            if (!playerContent) {
                continue;
            }
            
            const iframeMatch = playerContent.match(/<iframe[^>]*src=["']([^"']+)["']/i);
            if (!iframeMatch) {
                continue;
            }
            
            let iframeSrc = iframeMatch[1];
            
            if (iframeSrc.startsWith("chrome-extension://") && iframeSrc.includes("#https://")) {
                iframeSrc = iframeSrc.split("#", 2)[1];
            }
            
            if (iframeSrc.includes('nochannel.php')) {
                console.log(`⚠️ Nessun canale disponibile per ${matchName}`);
                continue;
            }
            
            const mpdUrlMatch = iframeSrc.match(/(https?:\/\/[^\s"'#]+\.mpd(?:\/[^?\s"'#]*)*)/);
            const tokenMatch = iframeSrc.match(/ck=([A-Za-z0-9+/=_-]+)/);
            
            if (!mpdUrlMatch || !tokenMatch) {
                console.log(`❌ MPD o token mancanti per ${matchName}`);
                continue;
            }
            
            let mpdUrl = mpdUrlMatch[1];
            mpdUrl = mpdUrl.split('?')[0].split('#')[0];
            
            const tokenRaw = tokenMatch[1];
            const { keyid, key } = decodeToken(tokenRaw);
            
            if (!keyid || !key) {
                continue;
            }
            
            // Costruisci il nome del canale con formato: "DD/MM ⏰ HH:MM - TEAM VS TEAM"
            let channelName: string;
            if (currentDate && matchTime) {
                // Formato completo: "04/11 ⏰ 21:00 - ATLETICO MADRID VS ROYALE UNION SG"
                channelName = `${currentDate.replace('-', '/')} ⏰ ${matchTime} - ${matchName}`;
            } else if (currentDate) {
                // Formato con data (senza orario)
                channelName = `${currentDate.replace('-', '/')} - ${matchName}`;
            } else {
                // Fallback senza data
                channelName = matchName;
            }
            
            const staticUrlMpd = createStaticUrlMpd(mpdUrl, keyid, key);
            
            channels.push({
                name: channelName,
                staticUrlMpd: staticUrlMpd,
                logo: LOGO_URL
            });
            
            console.log(`✅ Aggiunto: ${channelName}`);
            
        } catch (e) {
            console.log(`Errore partita ${i + 1}: ${e}`);
            continue;
        }
    }
    
    console.log(`\n✅ ${name}: ${channels.length} canali estratti`);
    return channels;
}

async function fetchThisNotChannels(): Promise<ThisNotChannel[]> {
    if (!await performLogin(`${BASE_URL}/serieA.php`, PASSWORD)) {
        console.log("FATAL: Login fallito. Interrompo.");
        return [];
    }
    
    const allChannels: ThisNotChannel[] = [];
    
    for (const [compName, compUrl] of Object.entries(COMPETITIONS)) {
        const channels = await processCompetition(compName, compUrl);
        allChannels.push(...channels);
    }
    
    console.log(`\n🎉 Totale: ${allChannels.length} canali estratti da tutte le competizioni!`);
    return allChannels;
}

/**
 * Converte i canali ThisNot nel formato DynamicChannel
 * MANTIENE la data nel nome del canale (es: "04-11 - JUVENTUS VS TORINO - Serie A")
 */
function convertToThisNotDynamicChannels(thisnotChannels: ThisNotChannel[]): DynamicChannel[] {
    console.log(`✅ [ThisNot] Conversione ${thisnotChannels.length} canali (mantenendo data nel nome)`);
    
    return thisnotChannels.map((channel, index) => {
        // Estrai data e orario dal nome del canale
        // Formato: "04/11 ⏰ 21:00 - ATLETICO MADRID VS ROYALE UNION SG"
        let eventStart: string | undefined;
        
        const formatMatch = channel.name.match(/^(\d{2})\/(\d{2})\s*⏰\s*(\d{2}):(\d{2})\s*-/);
        if (formatMatch) {
            const day = formatMatch[1];
            const month = formatMatch[2];
            const hour = formatMatch[3];
            const minute = formatMatch[4];
            const year = new Date().getFullYear();
            // Crea una data ISO con orario in timezone Europe/Rome
            eventStart = `${year}-${month}-${day}T${hour}:${minute}:00+01:00`;
        }
        
        return {
            id: `thisnot_${index}_${Date.now()}`,
            name: channel.name,
            logo: channel.logo,
            category: THISNOT_CATEGORY,
            streams: [{
                url: channel.staticUrlMpd,
                title: 'MPD'
            }],
            createdAt: new Date().toISOString(),
            eventStart: eventStart // Aggiungi eventStart per proteggere dal filtro
        };
    });
}

/**
 * Aggiorna i canali ThisNot nel file dynamic_channels.json
 * Rimuove i vecchi canali ThisNot e aggiunge quelli nuovi
 */
export async function updateThisNotChannels(): Promise<void> {
    try {
        console.log('\n🔄 [ThisNot] Inizio aggiornamento canali ThisNot...');
        
        // Carica i canali esistenti (NON forzare reload per evitare race conditions)
        const existingChannels = loadDynamicChannels(false);
        
        // Rimuovi i vecchi canali ThisNot (sia 'thisnot' che 'THISNOT' per retrocompatibilità)
        const otherChannels = existingChannels.filter(ch => {
            const cat = (ch.category || '').toLowerCase();
            return cat !== 'thisnot';
        });
        console.log(`📊 [ThisNot] Rimossi ${existingChannels.length - otherChannels.length} vecchi canali ThisNot`);
        
        // Fetch nuovi canali da ThisNot
        const thisnotChannels = await fetchThisNotChannels();
        console.log(`📡 [ThisNot] Estratti ${thisnotChannels.length} nuovi canali`);
        
        if (thisnotChannels.length === 0) {
            console.warn('⚠️ [ThisNot] Nessun canale estratto, mantengo canali esistenti');
            return;
        }
        
        // Converti nel formato DynamicChannel
        const newThisNotChannels = convertToThisNotDynamicChannels(thisnotChannels);
        
        // Unisci con i canali esistenti (non ThisNot)
        const updatedChannels = [...otherChannels, ...newThisNotChannels];
        
        // Salva nel file
        saveDynamicChannels(updatedChannels);
        
        console.log(`✅ [ThisNot] Aggiornamento completato: ${newThisNotChannels.length} canali ThisNot attivi`);
        console.log(`📊 [ThisNot] Totale canali dinamici: ${updatedChannels.length}`);
        
    } catch (error) {
        console.error('❌ [ThisNot] Errore durante l\'aggiornamento:', error);
        throw error;
    }
}

/**
 * Avvia il loop di aggiornamento ogni 2 ore
 */
export function startThisNotUpdater(intervalHours: number = 2): void {
    const intervalMs = intervalHours * 60 * 60 * 1000;
    
    console.log(`🚀 [ThisNot] Avvio updater con intervallo di ${intervalHours} ore`);
    
    // Esegui subito il primo aggiornamento
    updateThisNotChannels().catch(err => {
        console.error('❌ [ThisNot] Errore nel primo aggiornamento:', err);
    });
    
    // Schedula gli aggiornamenti successivi
    setInterval(() => {
        console.log(`⏰ [ThisNot] Avvio aggiornamento schedulato...`);
        updateThisNotChannels().catch(err => {
            console.error('❌ [ThisNot] Errore nell\'aggiornamento schedulato:', err);
        });
    }, intervalMs);
    
    console.log(`✅ [ThisNot] Updater avviato con successo`);
}
