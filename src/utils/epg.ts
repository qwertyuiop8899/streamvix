import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { parseString } from 'xml2js'; // mantenuto per fallback
import fetch from 'node-fetch';
import * as sax from 'sax';
// Minimal declarations to avoid TS node types requirement
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;

export interface EPGProgram {
    start: string;
    stop?: string;
    title: string;
    description?: string;
    category?: string;
    channel: string;
}

export interface EPGChannel {
    id: string;
    displayName: string;
    icon?: string;
}

export interface EPGData {
    channels: EPGChannel[];
    programs: EPGProgram[];
}

export interface EPGConfig {
    epgUrl: string;
    alternativeUrls?: string[];
    channelMapping?: { [key: string]: string[] };
    updateInterval?: number;
    cacheDir?: string;
    enabled?: boolean;
    supportedFormats?: string[];
    timeout?: number;
    maxRetries?: number;
    lightMode?: boolean; // parsing streaming e dati ridotti
    keepWindowHours?: number; // finestra ore future + 2h passato
    storeDescription?: boolean; // salva descrizione
    // Nuove opzioni per correggere orari live/dynamic
    timeAdjust?: {
        liveOffsetMinutes?: number;     // correzione additiva in minuti per i canali live (EPG)
        dynamicOffsetMinutes?: number;  // correzione additiva in minuti per gli eventi dynamic
    };
    assumeZone?: string; // es. 'Europe/Rome' (default)
}

export class EPGManager {
    private epgData: EPGData | null = null;
    private lastUpdate: Date | null = null;
    private config: EPGConfig;
    private cacheFile: string;
    private updateInterval: number = 24 * 60 * 60 * 1000; // 24 ore
    private timeZoneOffset: string = '+2:00'; // Fuso orario italiano
    private offsetMinutes: number = 120; // Offset in minuti per l'Italia
    private initialized: boolean = false; // lazy load
    private lightMode: boolean = false;
    private keepWindowHours: number = 26;
    private storeDescription: boolean = true;
    private assumeZone: string = 'Europe/Rome';
    private liveOffsetMinutesAdj: number = 0;
    private dynamicOffsetMinutesAdj: number = 0;
    // Indice per canale: per ogni channelId la lista dei programmi gia' parsati
    // (start/stop in ms) e ordinati per start crescente. Viene ricostruito ad ogni
    // load/update dell'EPG. Senza indice: scan O(N*P) per ogni catalog request.
    private programsByChannel: Map<string, Array<{ startMs: number; stopMs: number; program: EPGProgram }>> | null = null;
    // Indice di normalizzazione: chiave normalizzata -> EPGChannel.
    // findEPGChannelId viene chiamato ~1 volta per canale TV ad ogni catalog
    // request; senza indice ogni chiamata normalizzava (toLowerCase + 2 regex)
    // tutti i ~200 EPGChannel per match esatto + match parziale. Con ~200 canali
    // TV in catalogo questo era O(N^2) di normalizzazioni ad ogni request.
    private channelNormalizedIndex: Map<string, EPGChannel> | null = null;

    constructor(config: EPGConfig) {
        this.config = {
            cacheDir: 'cache',
            enabled: true,
            supportedFormats: ['xml', 'xml.gz'],
            timeout: 30000,
            maxRetries: 3,
            ...config
        };
        
    this.updateInterval = this.config.updateInterval || this.updateInterval;
        this.cacheFile = path.join(this.config.cacheDir!, 'epg_cache.json');
    this.lightMode = !!this.config.lightMode;
    this.keepWindowHours = this.config.keepWindowHours || this.keepWindowHours;
    this.storeDescription = this.config.storeDescription !== undefined ? this.config.storeDescription : this.storeDescription;
    this.assumeZone = this.config.assumeZone || 'Europe/Rome';
    this.liveOffsetMinutesAdj = this.config.timeAdjust?.liveOffsetMinutes ?? 0;
    this.dynamicOffsetMinutesAdj = this.config.timeAdjust?.dynamicOffsetMinutes ?? 0;
        
        // Crea la directory cache se non esiste
        if (!fs.existsSync(this.config.cacheDir!)) {
            fs.mkdirSync(this.config.cacheDir!, { recursive: true });
        }
        
    this.validateAndSetTimezone();
    this.loadFromCache();
    // Lazy: non chiamiamo updateEPG qui
    }

    /**
     * Valida e imposta il fuso orario
     */
    private validateAndSetTimezone(): void {
        const tzRegex = /^[+-]\d{1,2}:\d{2}$/;
        const timeZone = process.env.TIMEZONE_OFFSET || '+2:00';
        
        if (!tzRegex.test(timeZone)) {
            this.timeZoneOffset = '+2:00';
            this.offsetMinutes = 120;
            return;
        }
        
        this.timeZoneOffset = timeZone;
        const [hours, minutes] = this.timeZoneOffset.substring(1).split(':');
        this.offsetMinutes = (parseInt(hours) * 60 + parseInt(minutes)) * 
                             (this.timeZoneOffset.startsWith('+') ? 1 : -1);
    }

    // Calcola l'offset (in minuti) di un fuso orario specifico per un istante dato
    private tzOffsetMinutes(zone: string, at: Date): number {
        try {
            const dtf = new Intl.DateTimeFormat('en-US', {
                timeZone: zone,
                hour12: false,
                year: 'numeric', month: '2-digit', day: '2-digit',
                hour: '2-digit', minute: '2-digit', second: '2-digit'
            } as any);
            const parts = (dtf as any).formatToParts(at) as Array<{ type: string; value: string }>;
            const map: Record<string, string> = {};
            for (const p of parts) map[p.type] = p.value;
            const asUTC = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day), Number(map.hour), Number(map.minute), Number(map.second));
            return Math.round((asUTC - at.getTime()) / 60000);
        } catch {
            return 0;
        }
    }

    // Crea una Date interpretando il tempo come locale del fuso 'zone' (es. Europe/Rome)
    private makeDateFromLocalInZone(y: number, m: number, d: number, hh: number, mm: number, ss: number, zone: string): Date {
        // Primo guess: UTC con stessi componenti
        const guessUTC = Date.UTC(y, m - 1, d, hh, mm, ss);
        // Offset del fuso in quell'istante
        const off = this.tzOffsetMinutes(zone, new Date(guessUTC));
        // Per ottenere l'istante assoluto corrispondente a quell'orario locale: sottrai l'offset
        const ms = Date.UTC(y, m - 1, d, hh, mm, ss) - off * 60000;
        return new Date(ms);
    }

    /**
     * Carica l'EPG dalla cache se disponibile
     */
    private loadFromCache(): void {
        try {
            if (fs.existsSync(this.cacheFile)) {
                const cacheData = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
                this.epgData = cacheData.epgData;
                this.lastUpdate = new Date(cacheData.lastUpdate);
                this.rebuildProgramIndex();
                console.log(`📺 EPG caricato dalla cache: ${this.epgData?.channels.length} canali, ${this.epgData?.programs.length} programmi`);
            }
        } catch (error) {
            console.error('❌ Errore nel caricamento della cache EPG:', error);
        }
    }

    /**
     * Salva l'EPG nella cache
     */
    private saveToCache(): void {
        try {
            const cacheData = {
                epgData: this.epgData,
                lastUpdate: this.lastUpdate
            };
            fs.writeFileSync(this.cacheFile, JSON.stringify(cacheData, null, 2));
            console.log(`💾 EPG salvato nella cache`);
        } catch (error) {
            console.error('❌ Errore nel salvataggio della cache EPG:', error);
        }
    }

    /**
     * Controlla se l'EPG necessita di aggiornamento
     */
    private needsUpdate(): boolean {
        if (!this.epgData || !this.lastUpdate) {
            return true;
        }
        
        const now = new Date();
        const timeDiff = now.getTime() - this.lastUpdate.getTime();
        return timeDiff > this.updateInterval;
    }

    /**
     * Scarica e processa l'EPG XML con supporto per più URL e GZIP
     */
    public async updateEPG(): Promise<boolean> {
    if (!this.config.enabled) {
            console.log('📺 EPG è disabilitato nella configurazione');
            return false;
        }

    // evita concorrenza
    if (this.initialized && !this.needsUpdate()) return true;

        const urlsToTry = [this.config.epgUrl, ...(this.config.alternativeUrls || [])];
        
        for (const url of urlsToTry) {
            try {
                console.log(`🔄 Tentativo di aggiornamento EPG da: ${url}`);
                
                const response = await fetch(url, {
                    headers: {
                        'User-Agent': 'StreamViX/3.0.0 EPG Client'
                        // Rimuovo Accept-Encoding per evitare compressione automatica
                    }
                });
                
                if (!response.ok) {
                    console.error(`❌ Errore nel download EPG da ${url}: ${response.status} ${response.statusText}`);
                    continue;
                }
                
                const isGzipped = url.endsWith('.gz');
                if (this.lightMode) {
                    const buffer = await response.buffer();
                    const xmlStream = isGzipped ? zlib.createGunzip().end(buffer) : null;
                    // Non possiamo usare .end(buffer) direttamente con sax, creiamo testo (fallback streaming parziale):
                    // Per semplicità qui facciamo streaming manuale chunk → parser, ma se buffer piccolo ok.
                    const xmlData = isGzipped ? zlib.gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
                    const parsed = this.parseSaxLight(xmlData);
                    if (parsed) {
                        this.epgData = parsed;
                        this.lastUpdate = new Date();
                        this.rebuildProgramIndex();
                        this.saveToCache();
                        this.initialized = true;
                        console.log(`✅ EPG(light) ok: ${this.epgData.channels.length} canali, ${this.epgData.programs.length} programmi`);
                        return true;
                    }
                } else {
                    let xmlContent: string;
                    if (isGzipped) {
                        console.log(`📦 File EPG compresso, decompressione in corso...`);
                        const buffer = await response.buffer();
                        xmlContent = zlib.gunzipSync(buffer).toString('utf8');
                    } else {
                        xmlContent = await response.text();
                    }
                    console.log(`📥 EPG XML processato: ${xmlContent.length} caratteri`);
                    const parsedData = await this.parseXMLEPG(xmlContent);
                    if (parsedData) {
                        this.epgData = parsedData;
                        this.lastUpdate = new Date();
                        this.rebuildProgramIndex();
                        this.saveToCache();
                        this.initialized = true;
                        console.log(`✅ EPG aggiornato con successo da ${url}: ${this.epgData.channels.length} canali, ${this.epgData.programs.length} programmi`);
                        return true;
                    }
                }
                
            } catch (error) {
                console.error(`❌ Errore nell'aggiornamento EPG da ${url}:`, error);
                continue;
            }
        }
        
        console.error('❌ Impossibile aggiornare EPG da nessun URL');
        return false;
    }

    /**
     * Parsa l'XML EPG e converte in formato interno
     */
    private parseXMLEPG(xmlContent: string): Promise<EPGData | null> {
        return new Promise((resolve) => {
            parseString(xmlContent, (err: any, result: any) => {
                if (err) {
                    console.error('❌ Errore nel parsing XML EPG:', err);
                    resolve(null);
                    return;
                }

                try {
                    const channels: EPGChannel[] = [];
                    const programs: EPGProgram[] = [];
                    // Force V8 to materialize a fresh, contiguous string buffer,
                    // severing any "sliced string" parent reference. Without this,
                    // xml2js-parsed substrings retain a pointer to the entire
                    // ~40 MB XML document via Program.title slice views, leaking
                    // the whole EPG payload across the cache lifetime.
                    const _flat = EPGManager._materializeString;

                    // Parsa i canali
                    if (result.tv && result.tv.channel) {
                        for (const channel of result.tv.channel) {
                            const channelId = channel.$.id;
                            const displayName = channel['display-name'] ?
                                (Array.isArray(channel['display-name']) ? channel['display-name'][0]._ || channel['display-name'][0] : channel['display-name']) :
                                channelId;

                            const icon = channel.icon ?
                                (Array.isArray(channel.icon) ? channel.icon[0].$.src : channel.icon.$.src) :
                                undefined;

                            channels.push({
                                id: _flat(channelId)!,
                                displayName: _flat(displayName)!,
                                icon: _flat(icon),
                            });
                        }
                    }

                    // Parsa i programmi
                    if (result.tv && result.tv.programme) {
                        for (const programme of result.tv.programme) {
                            const title = programme.title ?
                                (Array.isArray(programme.title) ? programme.title[0]._ || programme.title[0] : programme.title) :
                                'Programma sconosciuto';

                            const description = programme.desc ?
                                (Array.isArray(programme.desc) ? programme.desc[0]._ || programme.desc[0] : programme.desc) :
                                undefined;

                            const category = programme.category ?
                                (Array.isArray(programme.category) ? programme.category[0]._ || programme.category[0] : programme.category) :
                                undefined;

                            programs.push({
                                start: _flat(programme.$.start)!,
                                stop: _flat(programme.$.stop),
                                title: _flat(title)!,
                                description: _flat(description),
                                category: _flat(category),
                                channel: _flat(programme.$.channel)!,
                            });
                        }
                    }

                    resolve({ channels, programs });
                } catch (parseError) {
                    console.error('❌ Errore nel processamento dati EPG:', parseError);
                    resolve(null);
                }
            });
        });
    }

    // Force V8 to materialize a fresh, contiguous string buffer, severing
    // any "sliced string" parent reference. Without this, SAX-parsed
    // substrings of the EPG XML retain a pointer to the entire ~40 MB XML
    // document — heap snapshots showed every Program.title pinning the
    // source XML. Buffer round-trip is the most reliable way to force a
    // flatten across V8 versions.
    private static _materializeString(s: string | undefined): string | undefined {
        if (s === undefined || s === null) return s;
        if (typeof s !== 'string' || s.length === 0) return s;
        return Buffer.from(s, 'utf8').toString('utf8');
    }

    // Parsing leggero SAX (lightMode)
    private parseSaxLight(xmlContent: string): EPGData | null {
        try {
            const parser = sax.parser(true, { lowercase: true, trim: true });
            const channels: EPGChannel[] = [];
            const programs: EPGProgram[] = [];
            const channelIdSet = new Set<string>();
            const windowHours = this.keepWindowHours;
            const now = Date.now();
            const _flat = EPGManager._materializeString;
            const minTs = now - 2 * 60 * 60 * 1000; // -2h
            const maxTs = now + windowHours * 60 * 60 * 1000; // + keepWindowHours
            let currentElement: string | null = null;
            let currentChannel: Partial<EPGChannel> | null = null;
            let currentProgramme: any = null;
            let textBuffer = '';
            parser.onopentag = (node: any) => {
                currentElement = node.name;
                if (node.name === 'channel') {
                    currentChannel = { id: node.attributes.id, displayName: '' };
                } else if (node.name === 'programme') {
                    currentProgramme = { channel: node.attributes.channel, start: node.attributes.start, stop: node.attributes.stop, title: '', description: '', category: '' };
                }
                textBuffer = '';
            };
            parser.onclosetag = (tag: string) => {
                if (tag === 'display-name' && currentChannel) {
                    currentChannel.displayName = currentChannel.displayName || textBuffer;
                } else if (tag === 'icon' && currentChannel) {
                    // ignored in light mode
                } else if (tag === 'channel') {
                    if (currentChannel && currentChannel.id) {
                        // Flatten strings to break sliced-string retention of source XML.
                        channels.push({
                            id: _flat(currentChannel.id)!,
                            displayName: _flat(currentChannel.displayName || currentChannel.id)!,
                        });
                        channelIdSet.add(currentChannel.id);
                    }
                    currentChannel = null;
                } else if (currentProgramme) {
                    if (tag === 'title') currentProgramme.title = currentProgramme.title || textBuffer;
                    if (tag === 'desc') currentProgramme.description = currentProgramme.description || textBuffer;
                    if (tag === 'category') currentProgramme.category = currentProgramme.category || textBuffer;
                    if (tag === 'programme') {
                        // filtro finestra temporale
                        const startDate = this.parseEPGDate(currentProgramme.start);
                        const startMs = startDate.getTime();
                        if (startMs >= minTs && startMs <= maxTs) {
                            // Flatten every persisted string. Each Program is
                            // retained across the EPG refresh cycle (12h) so any
                            // sliced-string view pins the source XML in heap.
                            programs.push({
                                start: _flat(currentProgramme.start)!,
                                stop: _flat(currentProgramme.stop),
                                title: _flat(currentProgramme.title) || 'Programma',
                                description: this.storeDescription ? _flat(currentProgramme.description) : undefined,
                                category: _flat(currentProgramme.category) || undefined,
                                channel: _flat(currentProgramme.channel)!,
                            });
                        }
                        currentProgramme = null;
                    }
                }
                textBuffer = '';
                currentElement = null;
            };
            parser.ontext = (txt: string) => {
                if (!currentElement) return;
                textBuffer += txt;
            };
            parser.onerror = (e: any) => {
                console.error('❌ SAX parse error:', e);
            };
            parser.write(xmlContent).close();
            return { channels, programs };
        } catch (e) {
            console.error('❌ Errore parseSaxLight:', e);
            return null;
        }
    }

    /**
     * Ottieni l'EPG per un canale specifico
     */
    public async getEPGForChannel(channelId: string, date?: Date): Promise<EPGProgram[]> {
        // Aggiorna l'EPG se necessario
    if (!this.initialized) await this.updateEPG();
    else if (this.needsUpdate()) await this.updateEPG();

        if (!this.epgData) {
            return [];
        }

        let programs = this.epgData.programs.filter(p => p.channel === channelId);

        // Filtra per data se specificata
        if (date) {
            const startOfDay = new Date(date);
            startOfDay.setHours(0, 0, 0, 0);
            const endOfDay = new Date(date);
            endOfDay.setHours(23, 59, 59, 999);

            programs = programs.filter(p => {
                const programDate = this.parseEPGDate(p.start);
                return programDate >= startOfDay && programDate <= endOfDay;
            });
        }

        return programs.sort((a, b) => this.parseEPGDate(a.start).getTime() - this.parseEPGDate(b.start).getTime());
    }

    /**
     * Ottieni il programma corrente per un canale
     */
    public async getCurrentProgram(channelId: string): Promise<EPGProgram | null> {
    if (!this.initialized) await this.updateEPG();
    else if (this.needsUpdate()) await this.updateEPG();

        if (!this.epgData) {
            return null;
        }

        const nowMs = Date.now();
        // Path veloce: usa indice per canale (parsing date gia' fatto una volta sola al load).
        const idx = this.programsByChannel?.get(channelId);
        if (idx && idx.length > 0) {
            // Lista ordinata per startMs crescente: scan lineare ma su pochi elementi (~50/canale).
            // Si potrebbe binary-searchare, ma il guadagno marginale non vale la complessita'.
            for (const it of idx) {
                if (it.startMs <= nowMs && (it.stopMs === 0 || it.stopMs > nowMs)) {
                    return it.program;
                }
                if (it.startMs > nowMs) break; // ordinata: niente di utile piu' avanti
            }
            return null;
        }

        // Fallback (indice non disponibile): vecchio scan O(N) sull'intero array.
        const now = new Date();
        const programs = this.epgData.programs.filter(p => p.channel === channelId);
        for (const program of programs) {
            const startTime = this.parseEPGDate(program.start);
            const endTime = program.stop ? this.parseEPGDate(program.stop) : null;
            if (startTime <= now && (!endTime || endTime > now)) {
                return program;
            }
        }
        return null;
    }

    /**
     * Ottieni il prossimo programma per un canale
     */
    public async getNextProgram(channelId: string): Promise<EPGProgram | null> {
    if (!this.initialized) await this.updateEPG();
    else if (this.needsUpdate()) await this.updateEPG();

        if (!this.epgData) {
            return null;
        }

        const nowMs = Date.now();
        const idx = this.programsByChannel?.get(channelId);
        if (idx && idx.length > 0) {
            for (const it of idx) {
                if (it.startMs > nowMs) return it.program;
            }
            return null;
        }

        // Fallback (indice non disponibile)
        const now = new Date();
        const programs = this.epgData.programs
            .filter(p => p.channel === channelId && this.parseEPGDate(p.start) > now)
            .sort((a, b) => this.parseEPGDate(a.start).getTime() - this.parseEPGDate(b.start).getTime());
        return programs.length > 0 ? programs[0] : null;
    }

    /**
     * Costruisce l'indice programmsByChannel a partire da this.epgData.
     * Parsa le date UNA VOLTA al load (non a ogni richiesta) e ordina per startMs.
     */
    private rebuildProgramIndex(): void {
        try {
            if (!this.epgData || !Array.isArray(this.epgData.programs)) {
                this.programsByChannel = null;
                return;
            }
            const map = new Map<string, Array<{ startMs: number; stopMs: number; program: EPGProgram }>>();
            for (const p of this.epgData.programs) {
                if (!p || !p.channel || !p.start) continue;
                let startMs = 0; let stopMs = 0;
                try { startMs = this.parseEPGDate(p.start).getTime(); } catch { startMs = 0; }
                if (p.stop) {
                    try { stopMs = this.parseEPGDate(p.stop).getTime(); } catch { stopMs = 0; }
                }
                if (!Number.isFinite(startMs) || startMs <= 0) continue;
                let bucket = map.get(p.channel);
                if (!bucket) { bucket = []; map.set(p.channel, bucket); }
                bucket.push({ startMs, stopMs, program: p });
            }
            for (const arr of map.values()) {
                arr.sort((a, b) => a.startMs - b.startMs);
            }
            this.programsByChannel = map;
            console.log(`📇 EPG index built: ${map.size} canali indicizzati`);
        } catch (e) {
            console.warn('⚠️ EPG index rebuild failed (fallback su scan lineare):', (e as Error)?.message || e);
            this.programsByChannel = null;
        }
        // Anche l'indice di normalizzazione canale viene ricostruito qui.
        this.rebuildChannelNormalizationIndex();
    }

    /**
     * Normalizzazione canonica usata da findEPGChannelId. Estratta come funzione
     * statica per non ricomputare la stessa stringa ad ogni iterazione.
     */
    private static _normChannelString(s: string): string {
        return s.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
    }

    /**
     * Pre-normalizza id e displayName di ogni EPGChannel UNA volta al load,
     * e costruisce una Map<normalized, EPGChannel> per i match esatti
     * (O(1) invece di O(N)). I match parziali (includes()) continuano a fare
     * scan lineare, ma leggono il campo pre-normalizzato (_normId,
     * _normDisplayName) invece di ricomputare toLowerCase + 2 regex per
     * ogni iterazione di ogni chiamata.
     */
    private rebuildChannelNormalizationIndex(): void {
        try {
            if (!this.epgData || !Array.isArray(this.epgData.channels)) {
                this.channelNormalizedIndex = null;
                return;
            }
            const index = new Map<string, EPGChannel>();
            for (const ch of this.epgData.channels) {
                if (!ch) continue;
                const normId = EPGManager._normChannelString(ch.id || '');
                const normName = EPGManager._normChannelString(ch.displayName || '');
                (ch as any)._normId = normId;
                (ch as any)._normDisplayName = normName;
                if (normId && !index.has(normId)) index.set(normId, ch);
                if (normName && !index.has(normName)) index.set(normName, ch);
            }
            this.channelNormalizedIndex = index;
            console.log(`📇 EPG channel-norm index built: ${index.size} key(s) for ${this.epgData.channels.length} canali`);
        } catch (e) {
            console.warn('⚠️ EPG channel-norm rebuild failed (fallback su scan lineare):', (e as Error)?.message || e);
            this.channelNormalizedIndex = null;
        }
    }

    /**
     * Converte la data EPG in formato Date
     */
    private parseEPGDate(epgDate: string): Date {
        // Formato EPG: YYYYMMDDHHMMSS +ZZZZ
        if (!epgDate) return new Date();
        
        try {
            const regex = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})$/;
            const match = epgDate.match(regex);
            
            if (!match) {
                // Fallback per formato senza timezone: interpreta come ora locale del fuso configurato (es. Europe/Rome)
                const year = parseInt(epgDate.substr(0, 4));
                const month = parseInt(epgDate.substr(4, 2));
                const day = parseInt(epgDate.substr(6, 2));
                const hour = parseInt(epgDate.substr(8, 2));
                const minute = parseInt(epgDate.substr(10, 2));
                const second = parseInt(epgDate.substr(12, 2));
                return this.makeDateFromLocalInZone(year, month, day, hour, minute, second, this.assumeZone);
            }
            
            const [_, year, month, day, hour, minute, second, timezone] = match;
            const tzHours = timezone.substring(0, 3);
            const tzMinutes = timezone.substring(3);
            const isoString = `${year}-${month}-${day}T${hour}:${minute}:${second}${tzHours}:${tzMinutes}`;
            
            const date = new Date(isoString);
            return isNaN(date.getTime()) ? new Date() : date;
        } catch (error) {
            console.error('Errore nel parsing della data EPG:', error);
            return new Date();
        }
    }

    /**
     * Formatta la data per la visualizzazione usando il fuso orario italiano
     */
    public formatTime(epgDate: string, mode: 'live' | 'dynamic' = 'live'): string {
        const date = this.parseEPGDate(epgDate);
        // Applica solo l'eventuale correzione configurata; il rendering usa direttamente Europe/Rome
        const adj = mode === 'dynamic' ? this.dynamicOffsetMinutesAdj : this.liveOffsetMinutesAdj;
        const d2 = new Date(date.getTime() + (adj * 60 * 1000));
        return d2.toLocaleTimeString('it-IT', { 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: false,
            timeZone: this.assumeZone
        }).replace(/\./g, ':');
    }

    // ====== Helper per eventi dinamici ======
    private normalizeDynamicDate(iso: string): Date | null {
        if (!iso) return null;
        try {
            const hasTz = /Z|[+-]\d{2}:?\d{2}$/.test(iso);
            const d = new Date(iso);
            if (isNaN(d.getTime())) return null;
            if (hasTz) return d; // assoluta
            // Interpreta come ora locale del sistema e trasla verso il fuso configurato (Europe/Rome)
            const localOff = d.getTimezoneOffset();
            const zoneOff = this.tzOffsetMinutes(this.assumeZone, d);
            // porta l'istante a rappresentare la stessa ora locale del fuso configurato
            return new Date(d.getTime() + (localOff - zoneOff) * 60000);
        } catch { return null; }
    }

    public formatDynamicHHMM(iso: string): string {
        const d = this.normalizeDynamicDate(iso) || new Date(iso);
        const d2 = new Date(d.getTime() + (this.dynamicOffsetMinutesAdj * 60 * 1000));
        return d2.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: this.assumeZone }).replace(/\./g, ':');
    }

    public formatDynamicDDMM(iso: string): string {
        const d = this.normalizeDynamicDate(iso) || new Date(iso);
        const d2 = new Date(d.getTime() + (this.dynamicOffsetMinutesAdj * 60 * 1000));
        try {
            return d2.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', timeZone: this.assumeZone });
        } catch {
            const dd = String(d2.getDate()).padStart(2, '0');
            const mm = String(d2.getMonth() + 1).padStart(2, '0');
            return `${dd}/${mm}`;
        }
    }

    /**
     * Trova il canale EPG corrispondente a un canale TV
     * Supporta epgChannelIds dal canale TV
     */
    public findEPGChannelId(tvChannelName: string, epgChannelIds?: string[]): string | null {
        if (!this.epgData) {
            return null;
        }

        // 1. Se abbiamo epgChannelIds specifici dal canale TV, provali prima
        if (epgChannelIds && Array.isArray(epgChannelIds)) {
            for (const epgId of epgChannelIds) {
                // Cerca match esatto nell'EPG
                const foundChannel = this.epgData.channels.find(ch =>
                    ch.id === epgId || ch.displayName === epgId
                );
                if (foundChannel) {
                    console.log(`📺 EPG Match found via epgChannelIds: ${tvChannelName} -> ${foundChannel.id} (${foundChannel.displayName})`);
                    return foundChannel.id;
                }
            }

            // Cerca match parziale con epgChannelIds
            for (const epgId of epgChannelIds) {
                const normalizedEpgId = EPGManager._normChannelString(epgId);
                // Fast path: match esatto via index O(1) prima dello scan.
                const direct = this.channelNormalizedIndex?.get(normalizedEpgId);
                if (direct) {
                    console.log(`📺 EPG Partial match via epgChannelIds (indexed): ${tvChannelName} -> ${direct.id} (${direct.displayName}) via ${epgId}`);
                    return direct.id;
                }
                for (const channel of this.epgData.channels) {
                    // Leggi i campi pre-normalizzati invece di ricomputare
                    // toLowerCase + 2 regex per ogni iterazione.
                    const normalizedChannelId = (channel as any)._normId || EPGManager._normChannelString(channel.id);
                    const normalizedDisplayName = (channel as any)._normDisplayName || EPGManager._normChannelString(channel.displayName);

                    if (normalizedChannelId.includes(normalizedEpgId) || normalizedEpgId.includes(normalizedChannelId) ||
                        normalizedDisplayName.includes(normalizedEpgId) || normalizedEpgId.includes(normalizedDisplayName)) {
                        console.log(`📺 EPG Partial match via epgChannelIds: ${tvChannelName} -> ${channel.id} (${channel.displayName}) via ${epgId}`);
                        return channel.id;
                    }
                }
            }
        }

        // 2. Fallback: usa il nome del canale per la ricerca automatica
        const normalizedName = EPGManager._normChannelString(tvChannelName);

        // Fast path: exact-match via index O(1).
        const directHit = this.channelNormalizedIndex?.get(normalizedName);
        if (directHit) {
            console.log(`📺 EPG Auto-match found (indexed): ${tvChannelName} -> ${directHit.id} (${directHit.displayName})`);
            return directHit.id;
        }

        // Cerca match parziale (richiede scan: .includes su entrambe le direzioni)
        for (const channel of this.epgData.channels) {
            const normalizedEPGName = (channel as any)._normDisplayName || EPGManager._normChannelString(channel.displayName);
            if (normalizedEPGName.includes(normalizedName) || normalizedName.includes(normalizedEPGName)) {
                console.log(`📺 EPG Partial auto-match found: ${tvChannelName} -> ${channel.id} (${channel.displayName})`);
                return channel.id;
            }
        }

        console.log(`⚠️ No EPG match found for: ${tvChannelName}`);
        return null;
    }

    /**
     * Ottieni tutti i canali disponibili nell'EPG
     */
    public getAvailableChannels(): EPGChannel[] {
        return this.epgData?.channels || [];
    }

    /**
     * Ottieni statistiche sull'EPG
     */
    public getStats(): { channels: number; programs: number; lastUpdate: string | null } {
        return {
            channels: this.epgData?.channels.length || 0,
            programs: this.epgData?.programs.length || 0,
            lastUpdate: this.lastUpdate?.toISOString() || null
        };
    }

}
