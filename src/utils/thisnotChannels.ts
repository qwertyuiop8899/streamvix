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

// COMPETITIONS legacy rimosse - ora tutto su index.php

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

async function performLogin(url: string, pwd: string): Promise<string | null> {
    try {
        const response = await makeRequest(url);
        const $ = cheerio.load(response.data);
        const form = $('form').first();

        // Se non c'è form, forse siamo già loggati?
        if (form.length === 0) {
            console.log('[ThisNot] Nessun form di login trovato, assumo sessione attiva o pagina errata.');
            return response.data;
        }

        let actionUrl = url;
        const inputs: Record<string, string> = {};

        if (form.length > 0) {
            const action = form.attr('action');
            if (action) {
                actionUrl = new URL(action, BASE_URL).href;
            }

            form.find('input').each((_: any, elem: any) => {
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
            return loginResponse.data; // Restituisce l'HTML della pagina post-login
        }

        return null;
    } catch (e) {
        console.error(`❌ [ThisNot] Errore login: ${e}`);
        return null;
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

        if (decodedStr.trim().startsWith('{')) {
            const data = JSON.parse(decodedStr);
            const entries = Object.entries(data);
            if (entries.length > 0) {
                [keyid, key] = entries[0] as [string, string];
            } else {
                return { keyid: null, key: null };
            }
        } else if (decodedStr.includes(':')) {
            const parts = decodedStr.split(':', 2);
            keyid = parts[0];
            key = parts[1];
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

// Helper per mappare il giorno (Sabato, Domenica...) alla data DD-MM
function getDateFromDayName(dayName: string): string {
    const days = ['Domenica', 'Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'];
    const today = new Date();
    const todayDayIndex = today.getDay(); // 0-6

    let targetDayIndex = days.findIndex(d => d.toLowerCase() === dayName.toLowerCase());
    if (targetDayIndex === -1) return '';

    // Calcola quanti giorni mancano o sono passati per arrivare a quel giorno della settimana
    // Se oggi è Venerdì (5) e il target è Sabato (6), diff = 1
    // Se oggi è Venerdì (5) e il target è Domenica (0), diff = 2 (mod 7)
    let diff = (targetDayIndex - todayDayIndex + 7) % 7;

    // Se il giorno è oggi, ma vogliamo assicurarci di non prendere il giorno sbagliato se siamo a mezzanotte
    // In genere gli eventi sono per questa settimana.

    // Proviamo a indovinare se il giorno è "scorso" o "prossimo"
    // Di solito ThisNot mostra eventi di oggi e dei prossimi giorni.
    // Se targetDayIndex < todayDayIndex, probabilmente è per la prossima settimana o è un residuo.
    // Ma per eventi sportivi nel weekend è quasi sempre oggi o domani.

    const targetDate = new Date();
    targetDate.setDate(today.getDate() + diff);

    const day = String(targetDate.getDate()).padStart(2, '0');
    const month = String(targetDate.getMonth() + 1).padStart(2, '0');

    return `${day}-${month}`;
}

/**
 * Processa gli eventi dal JSON fornito dall'API
 */
async function processEventsJson(eventi: any[]): Promise<ThisNotChannel[]> {
    const channels: ThisNotChannel[] = [];

    for (const ev of eventi) {
        try {
            const competition = ev.competizione || '';
            const matchName = ev.evento || '';
            const time = ev.orario || ''; // HH:MM
            const channelNameRaw = ev.canale || '';
            const playerUrlRaw = ev.link || '';
            const dayName = ev.giorno || ''; // Sabato, Domenica...

            if (!playerUrlRaw) {
                console.log(`⚠️ [ThisNot] Salto evento senza link: ${matchName}`);
                continue;
            }

            const playerUrl = new URL(playerUrlRaw, BASE_URL).href;
            const currentDate = getDateFromDayName(dayName);

            // Debug log per ogni link
            // console.log(`🔍 [ThisNot] Analisi evento: ${matchName} (link: ${playerUrl})`);

            const playerContent = await getPageContent(playerUrl);

            if (!playerContent) {
                console.log(`⚠️ [ThisNot] Impossibile caricare player per: ${matchName} (${playerUrl})`);
                continue;
            }

            // Stessa logica di estrazione del player
            const iframeMatch = playerContent.match(/<iframe[^>]*src=["']([^"']+)["']/i);
            if (!iframeMatch) {
                console.log(`⚠️ [ThisNot] Nessun iframe trovato per: ${matchName}`);
                continue;
            }

            let iframeSrc = iframeMatch[1];

            if (iframeSrc.startsWith("chrome-extension://") && iframeSrc.includes("#https://")) {
                iframeSrc = iframeSrc.split("#", 2)[1];
            }

            if (iframeSrc.includes('nochannel.php')) {
                console.log(`⚠️ [ThisNot] Stream non ancora attivo per: ${matchName}`);
                continue;
            }

            const mpdUrlMatch = iframeSrc.match(/(https?:\/\/[^\s"'#]+\.mpd(?:\/[^?\s"'#]*)*)/);
            const tokenMatch = iframeSrc.match(/ck=([A-Za-z0-9+/=_-]+)/);

            if (!mpdUrlMatch || !tokenMatch) {
                console.log(`⚠️ [ThisNot] MPD o Token non trovato nell'iframe per: ${matchName}`);
                continue;
            }

            let mpdUrl = mpdUrlMatch[1];
            mpdUrl = mpdUrl.split('?')[0].split('#')[0];

            const tokenRaw = tokenMatch[1];
            const { keyid, key } = decodeToken(tokenRaw);

            if (!keyid || !key) {
                continue;
            }

            // Costruisci il nome del canale: "DD/MM ⏰ HH:MM - MATCH - COMPETITION [CHANNEL]"
            const chSuffix = channelNameRaw ? ` [${channelNameRaw}]` : '';
            let fullChannelName: string;

            if (currentDate && time) {
                fullChannelName = `${currentDate.replace('-', '/')} ⏰ ${time} - ${matchName} - ${competition}${chSuffix}`;
            } else if (time) {
                fullChannelName = `⏰ ${time} - ${matchName} - ${competition}${chSuffix}`;
            } else {
                fullChannelName = `${matchName} - ${competition}${chSuffix}`;
            }

            const staticUrlMpd = createStaticUrlMpd(mpdUrl, keyid, key);

            channels.push({
                name: fullChannelName,
                staticUrlMpd: staticUrlMpd,
                logo: LOGO_URL
            });

        } catch (e: any) {
            console.error(`❌ [ThisNot] Errore processamento evento: ${e.message}`);
            continue;
        }
    }

    return channels;
}

async function fetchThisNotChannels(): Promise<ThisNotChannel[]> {
    await performLogin(`${BASE_URL}/index.php`, PASSWORD);

    const apiUrl = `${BASE_URL}/api/eventi.json`;
    
    let response: any;
    try {
        response = await makeRequest(apiUrl);
    } catch (e: any) {
        console.error(`❌ [ThisNot] API non raggiungibile: ${e.message}`);
        return [];
    }

    if (!response || !response.data || !response.data.eventi) {
        console.error("❌ [ThisNot] Fallito caricamento API eventi");
        return [];
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
