import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { parseString } from 'xml2js';
import fetch from 'node-fetch';

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
}

export class EPGManager {
    private epgData: EPGData | null = null;
    private lastUpdate: Date | null = null;
    private config: EPGConfig;
    private cacheFile: string;
    private updateInterval: number = 24 * 60 * 60 * 1000; // 24 ore
    private timeZoneOffset: string = '+2:00'; // Fuso orario italiano
    private offsetMinutes: number = 120; // Offset in minuti per l'Italia

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
        
        // Crea la directory cache se non esiste
        if (!fs.existsSync(this.config.cacheDir!)) {
            fs.mkdirSync(this.config.cacheDir!, { recursive: true });
        }
        
        this.validateAndSetTimezone();
        this.loadFromCache();
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

    /**
     * Carica l'EPG dalla cache se disponibile
     */
    private loadFromCache(): void {
        try {
            if (fs.existsSync(this.cacheFile)) {
                const cacheData = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
                this.epgData = cacheData.epgData;
                this.lastUpdate = new Date(cacheData.lastUpdate);
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
                
                // Determina se il file è compresso (solo se URL finisce con .gz)
                const isGzipped = url.endsWith('.gz');
                
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
                    this.saveToCache();
                    console.log(`✅ EPG aggiornato con successo da ${url}: ${this.epgData.channels.length} canali, ${this.epgData.programs.length} programmi`);
                    return true;
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
                                id: channelId,
                                displayName: displayName,
                                icon: icon
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
                                start: programme.$.start,
                                stop: programme.$.stop,
                                title: title,
                                description: description,
                                category: category,
                                channel: programme.$.channel
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

    /**
     * Ottieni l'EPG per un canale specifico
     */
    public async getEPGForChannel(channelId: string, date?: Date): Promise<EPGProgram[]> {
        // Aggiorna l'EPG se necessario
        if (this.needsUpdate()) {
            await this.updateEPG();
        }

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
        if (this.needsUpdate()) {
            await this.updateEPG();
        }

        if (!this.epgData) {
            return null;
        }

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
        if (this.needsUpdate()) {
            await this.updateEPG();
        }

        if (!this.epgData) {
            return null;
        }

        const now = new Date();
        const programs = this.epgData.programs
            .filter(p => p.channel === channelId && this.parseEPGDate(p.start) > now)
            .sort((a, b) => this.parseEPGDate(a.start).getTime() - this.parseEPGDate(b.start).getTime());

        return programs.length > 0 ? programs[0] : null;
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
                // Fallback per formato senza timezone
                const year = parseInt(epgDate.substr(0, 4));
                const month = parseInt(epgDate.substr(4, 2)) - 1; // Month is 0-indexed
                const day = parseInt(epgDate.substr(6, 2));
                const hour = parseInt(epgDate.substr(8, 2));
                const minute = parseInt(epgDate.substr(10, 2));
                const second = parseInt(epgDate.substr(12, 2));
                
                // Assumiamo UTC e convertiamo al fuso orario italiano
                const utcDate = new Date(Date.UTC(year, month, day, hour, minute, second));
                return new Date(utcDate.getTime() + (this.offsetMinutes * 60 * 1000));
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
    public formatTime(epgDate: string): string {
        const date = this.parseEPGDate(epgDate);
        // Applica l'offset del fuso orario italiano se non è già stato applicato
        const localDate = new Date(date.getTime() + (this.offsetMinutes * 60 * 1000));
        return localDate.toLocaleTimeString('it-IT', { 
            hour: '2-digit', 
            minute: '2-digit',
            hour12: false
        }).replace(/\./g, ':');
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
                const normalizedEpgId = epgId.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
                for (const channel of this.epgData.channels) {
                    const normalizedChannelId = channel.id.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
                    const normalizedDisplayName = channel.displayName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
                    
                    if (normalizedChannelId.includes(normalizedEpgId) || normalizedEpgId.includes(normalizedChannelId) ||
                        normalizedDisplayName.includes(normalizedEpgId) || normalizedEpgId.includes(normalizedDisplayName)) {
                        console.log(`📺 EPG Partial match via epgChannelIds: ${tvChannelName} -> ${channel.id} (${channel.displayName}) via ${epgId}`);
                        return channel.id;
                    }
                }
            }
        }

        // 2. Fallback: usa il nome del canale per la ricerca automatica
        const normalizedName = tvChannelName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');

        // Cerca match esatto
        for (const channel of this.epgData.channels) {
            const normalizedEPGName = channel.displayName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
            if (normalizedEPGName === normalizedName) {
                console.log(`📺 EPG Auto-match found: ${tvChannelName} -> ${channel.id} (${channel.displayName})`);
                return channel.id;
            }
        }

        // Cerca match parziale
        for (const channel of this.epgData.channels) {
            const normalizedEPGName = channel.displayName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9]/g, '');
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
