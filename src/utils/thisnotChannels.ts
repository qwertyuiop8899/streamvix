// ThisNot channels updater. 
import { DynamicChannel } from './dynamicChannels';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as fs from 'fs';
import * as path from 'path';

const THISNOT_CATEGORY = 'thisnot';
const BASE_URL = "https://thisnot.business";
const PASSWORD = "2025";
const LOGO_URL = "https://github.com/qwertyuiop8899/logo/blob/main/TSNT.png?raw=true";

// File separato per ThisNot per evitare conflitti con Live.py
const THISNOT_FILE = '/tmp/thisnot_channels.json';

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
}

// Helper per fare richieste con fallback automatico
async function makeRequest(url: string, options: any = {}): Promise<any> {
    // Prima prova senza proxy
    try {
        const response = await clientDirect.get(url, options);
        return response;
    } catch (directError: any) {
        // Se c'è un proxy configurato, riprova con proxy
        if (clientProxy) {
            try {
                const response = await clientProxy.get(url, options);
                return response;
            } catch (proxyError: any) {
                console.error(`❌ [ThisNot] Errore connessione: ${proxyError.message}`);
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
            return true;
        }
        
        return false;
    } catch (e) {
        console.error(`❌ [ThisNot] Errore login: ${e}`);
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
                return { keyid: null, key: null };
            }
        } else {
            return { keyid: null, key: null };
        }
        
        return { keyid: keyid.toLowerCase(), key: key.toLowerCase() };
    } catch (e) {
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

/**
 * Verifica se una data è il giorno corrente
 */
function isToday(dateStr: string): boolean {
    try {
        // dateStr formato: "DD-MM"
        const [day, month] = dateStr.split('-');
        const today = new Date();
        const todayDay = String(today.getDate()).padStart(2, '0');
        const todayMonth = String(today.getMonth() + 1).padStart(2, '0');
        
        return day === todayDay && month === todayMonth;
    } catch (e) {
        return false;
    }
}

async function processCompetition(name: string, url: string): Promise<ThisNotChannel[]> {
    const htmlContent = await getPageContent(url);
    if (!htmlContent) {
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
        
        // FILTRO: Salta se non è oggi
        if (!isToday(currentDate)) {
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
                continue;
            }
            
            const mpdUrlMatch = iframeSrc.match(/(https?:\/\/[^\s"'#]+\.mpd(?:\/[^?\s"'#]*)*)/);
            const tokenMatch = iframeSrc.match(/ck=([A-Za-z0-9+/=_-]+)/);
            
            if (!mpdUrlMatch || !tokenMatch) {
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
            
        } catch (e) {
            // Silenziosamente continua in caso di errore su singola partita
            continue;
        }
    }
    
    return channels;
}

/**
 * Processa le tabelle HTML dalla pagina eventi.php (Calcio, Tennis, etc.)
 * Questi eventi sono sempre del giorno corrente
 */
async function processHtmlTables(): Promise<ThisNotChannel[]> {
    const eventsUrl = `${BASE_URL}/eventi.php`;
    const htmlContent = await getPageContent(eventsUrl);
    
    if (!htmlContent) {
        return [];
    }
    
    const $ = cheerio.load(htmlContent);
    const channels: ThisNotChannel[] = [];
    
    // Estrai la data dall'<h1> - formato: "Calendario Giovedi 6 Novembre"
    let currentDate = '';
    const h1Text = $('h1').first().text().trim();
    if (h1Text) {
        // Cerca pattern "6 Novembre" o "06 Novembre" dopo il giorno della settimana
        const dateMatch = h1Text.match(/(\d+)\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)/i);
        if (dateMatch) {
            currentDate = parseDate(`${dateMatch[1]} ${dateMatch[2]}`);
        }
    }
    
    // Trova tutte le sezioni con <h2> (Calcio, Tennis, etc.)
    const h2Tags = $('h2');
    
    for (let i = 0; i < h2Tags.length; i++) {
        const h2 = h2Tags.eq(i);
        const sectionName = h2.text().trim();
        
        // Trova la tabella successiva all'h2
        const table = h2.next('table');
        if (table.length === 0) {
            continue;
        }
        
        // Processa tutte le righe della tabella (escludi header)
        const rows = table.find('tr');
        
        for (let j = 0; j < rows.length; j++) {
            const row = rows.eq(j);
            
            // Skip header row
            if (row.attr('class')?.includes('mobile')) {
                continue;
            }
            
            const cells = row.find('td');
            if (cells.length < 4) {
                continue;
            }
            
            try {
                const time = cells.eq(0).text().trim();
                const competition = cells.eq(1).text().trim();
                const match = cells.eq(2).text().trim();
                const linkCell = cells.eq(3);
                const linkTag = linkCell.find('a');
                
                if (linkTag.length === 0 || !linkTag.attr('href')) {
                    continue;
                }
                
                const playerHref = linkTag.attr('href');
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
                    continue;
                }
                
                const mpdUrlMatch = iframeSrc.match(/(https?:\/\/[^\s"'#]+\.mpd(?:\/[^?\s"'#]*)*)/);
                const tokenMatch = iframeSrc.match(/ck=([A-Za-z0-9+/=_-]+)/);
                
                if (!mpdUrlMatch || !tokenMatch) {
                    continue;
                }
                
                let mpdUrl = mpdUrlMatch[1];
                mpdUrl = mpdUrl.split('?')[0].split('#')[0];
                
                const tokenRaw = tokenMatch[1];
                const { keyid, key } = decodeToken(tokenRaw);
                
                if (!keyid || !key) {
                    continue;
                }
                
                // Costruisci il nome del canale: "DD/MM ⏰ HH:MM - MATCH - COMPETITION"
                let channelName: string;
                if (currentDate && time) {
                    channelName = `${currentDate.replace('-', '/')} ⏰ ${time} - ${match} - ${competition}`;
                } else if (time) {
                    channelName = `⏰ ${time} - ${match} - ${competition}`;
                } else {
                    channelName = `${match} - ${competition}`;
                }
                
                const staticUrlMpd = createStaticUrlMpd(mpdUrl, keyid, key);
                
                channels.push({
                    name: channelName,
                    staticUrlMpd: staticUrlMpd,
                    logo: LOGO_URL
                });
                
            } catch (e) {
                // Silenziosamente continua in caso di errore su singola riga
                continue;
            }
        }
    }
    
    return channels;
}

async function fetchThisNotChannels(): Promise<ThisNotChannel[]> {
    if (!await performLogin(`${BASE_URL}/serieA.php`, PASSWORD)) {
        console.error("❌ [ThisNot] Login fallito");
        return [];
    }
    
    const allChannels: ThisNotChannel[] = [];
    
    // Processa le competizioni (Serie A, Bundesliga, etc.) - SOLO eventi di oggi
    for (const [compName, compUrl] of Object.entries(COMPETITIONS)) {
        const channels = await processCompetition(compName, compUrl);
        allChannels.push(...channels);
    }
    
    // Processa le tabelle HTML (Calcio, Tennis, etc.) - sempre del giorno corrente
    const htmlTableChannels = await processHtmlTables();
    allChannels.push(...htmlTableChannels);
    
    console.log(`✅ [ThisNot] ${allChannels.length} eventi OGGI estratti`);
    return allChannels;
}

/**
 * Converte i canali ThisNot nel formato DynamicChannel
 * MANTIENE la data nel nome del canale (es: "04-11 - JUVENTUS VS TORINO - Serie A")
 */
function convertToThisNotDynamicChannels(thisnotChannels: ThisNotChannel[]): DynamicChannel[] {
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
            
            // IMPORTANTE: Il runtime filter è DISABILITATO per ThisNot (mantiene sempre tutto)
            // Creiamo comunque eventStart per ordinamento e info, usando anno corrente
            // Usiamo offset +01:00 (CET inverno) o +02:00 (CEST estate)
            // Per novembre = inverno = +01:00
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
 * Salva i canali ThisNot nel file separato /tmp/thisnot_channels.json
 * NON tocca dynamic_channels.json per evitare conflitti con Live.py
 */
function saveThisNotChannels(channels: DynamicChannel[]): void {
    try {
        const data = JSON.stringify(channels, null, 2);
        fs.writeFileSync(THISNOT_FILE, data, 'utf-8');
    } catch (error) {
        console.error(`❌ [ThisNot] Errore salvataggio: ${error}`);
        throw error;
    }
}

/**
 * Carica i canali ThisNot dal file separato
 */
export function loadThisNotChannels(): DynamicChannel[] {
    try {
        if (!fs.existsSync(THISNOT_FILE)) {
            return [];
        }
        
        const data = fs.readFileSync(THISNOT_FILE, 'utf-8');
        const channels = JSON.parse(data) as DynamicChannel[];
        return channels;
    } catch (error) {
        console.error(`❌ [ThisNot] Errore caricamento: ${error}`);
        return [];
    }
}

/**
 * Aggiorna i canali ThisNot nel file separato /tmp/thisnot_channels.json
 * NON modifica dynamic_channels.json (usato da Live.py)
 */
export async function updateThisNotChannels(): Promise<void> {
    try {
        // Fetch nuovi canali da ThisNot (solo eventi di oggi)
        const thisnotChannels = await fetchThisNotChannels();
        
        if (thisnotChannels.length === 0) {
            console.log('⚠️ [ThisNot] Nessun evento OGGI');
            return;
        }
        
        // Converti nel formato DynamicChannel
        const newThisNotChannels = convertToThisNotDynamicChannels(thisnotChannels);
        
        // Salva nel file separato (NON tocca dynamic_channels.json)
        saveThisNotChannels(newThisNotChannels);
        
        console.log(`✅ [ThisNot] ${newThisNotChannels.length} eventi OGGI aggiornati`);
        
    } catch (error) {
        console.error('❌ [ThisNot] Errore aggiornamento:', error);
        throw error;
    }
}

/**
 * Avvia il loop di aggiornamento ogni 2 ore
 * Filtra automaticamente solo gli eventi del giorno corrente
 */
export function startThisNotUpdater(intervalHours: number = 2): void {
    const intervalMs = intervalHours * 60 * 60 * 1000;
    
    console.log(`🚀 [ThisNot] Updater avviato (ogni ${intervalHours}h, solo eventi OGGI)`);
    
    // Esegui subito il primo aggiornamento
    updateThisNotChannels().catch(err => {
        console.error('❌ [ThisNot] Errore aggiornamento:', err);
    });
    
    // Schedula gli aggiornamenti successivi
    setInterval(() => {
        updateThisNotChannels().catch(err => {
            console.error('❌ [ThisNot] Errore aggiornamento:', err);
        });
    }, intervalMs);
}
