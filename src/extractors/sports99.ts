import axios from 'axios';

export interface Sports99Channel {
    name: string;
    channel_name: string;
    code: string;
    url: string;
    image: string;
    tournament?: string;
    home_team?: string;
    away_team?: string;
    match_info?: string;
    sport_category?: string;
    status?: string;
    start?: string;
    time?: string;
    stream_url?: string;
}

export class Sports99Client {
    private user: string;
    private plan: string;
    private baseApi: string;
    private playerReferer: string;
    private timeout: number;

    constructor(user: string = "cdnlivetv", plan: string = "free", timeout: number = 30000) {
        this.user = user;
        this.plan = plan;
        this.baseApi = "https://api.cdn-live.tv/api/v1";
        this.playerReferer = "https://streamsports99.su/";
        this.timeout = timeout;
    }

    // ---------------------------------------------------------
    // Utility: Convert base
    // ---------------------------------------------------------
    private convertBase(s: string, base: number): number {
        let result = 0;
        const reversed = s.split('').reverse();
        for (let i = 0; i < reversed.length; i++) {
            result += parseInt(reversed[i], 10) * Math.pow(base, i);
        }
        return result;
    }

    // ---------------------------------------------------------
    // JS Obfuscation Decoder
    // ---------------------------------------------------------
    private decodeObfuscatedJs(html: string): string | null {
        const startMarker = '}("';
        const startIdx = html.indexOf(startMarker);
        if (startIdx === -1) return null;

        const actualStart = startIdx + startMarker.length;
        const endIdx = html.indexOf('",', actualStart);
        if (endIdx === -1) return null;

        const encoded = html.substring(actualStart, endIdx);
        const paramsPos = endIdx + 2;
        const params = html.substring(paramsPos, paramsPos + 100);

        const match = params.match(/(\d+),\s*"([^"]+)",\s*(\d+),\s*(\d+),\s*(\d+)/);
        if (!match) return null;

        const charset = match[2];
        const offset = parseInt(match[3], 10);
        const base = parseInt(match[4], 10);

        let decoded = "";
        const parts = encoded.split(charset[base]);

        for (const part of parts) {
            if (part) {
                let temp = part;
                for (let idx = 0; idx < charset.length; idx++) {
                    temp = temp.split(charset[idx]).join(String(idx));
                }
                const val = this.convertBase(temp, base);
                decoded += String.fromCharCode(val - offset);
            }
        }

        // Try to decode URI, but some content may not be URI encoded
        try {
            return decodeURIComponent(decoded);
        } catch {
            // If URI decode fails, return the raw decoded string
            return decoded;
        }
    }

    // ---------------------------------------------------------
    // Find Stream URL
    // ---------------------------------------------------------
    private findStreamUrl(jsCode: string): string | null {
        // Try old pattern first (index.m3u8?token=)
        const oldPattern = /[\"']([^\"']*index\.m3u8\?token=[^\"']+)[\"']/;
        const oldMatch = jsCode.match(oldPattern);
        if (oldMatch) return oldMatch[1];

        // New pattern: base64-encoded URL fragments in const declarations
        // The decoded JS builds URLs from concatenated base64 parts
        const b64Pattern = /const\s+\w+\s*=\s*'([A-Za-z0-9+/_-]{2,})'/g;
        const b64Strings: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = b64Pattern.exec(jsCode)) !== null) {
            b64Strings.push(m[1]);
        }

        if (b64Strings.length === 0) return null;

        // Base64 decode (handles URL-safe base64)
        const b64decode = (str: string): string => {
            str = str.replace(/-/g, '+').replace(/_/g, '/');
            while (str.length % 4) str += '=';
            return Buffer.from(str, 'base64').toString();
        };

        // Decode all fragments
        const decoded = b64Strings.map(s => {
            try { return b64decode(s); } catch { return ''; }
        });

        // Reconstruct URLs from consecutive fragments
        const urls: string[] = [];
        let current = '';
        for (let i = 0; i < decoded.length; i++) {
            if (decoded[i] === 'https' || decoded[i] === 'http') {
                if (current && (current.includes('.m3u8') || current.includes('playlist'))) {
                    urls.push(current);
                }
                current = decoded[i];
            } else if (current) {
                current += decoded[i];
            }
        }
        if (current) urls.push(current);

        // Prefer URL with token= and m3u8
        for (const url of urls) {
            if (url.includes('token=') && (url.includes('.m3u8') || url.includes('playlist'))) {
                return url;
            }
        }
        // Fallback: any URL with m3u8
        for (const url of urls) {
            if (url.includes('.m3u8')) {
                return url;
            }
        }

        return null;
    }

    // ---------------------------------------------------------
    // Fetch Live TV Channels
    // ---------------------------------------------------------
    public async fetchLiveTvChannels(): Promise<Sports99Channel[]> {
        const url = `${this.baseApi}/channels/?user=${this.user}&plan=${this.plan}`;
        try {
            const res = await axios.get(url, { timeout: this.timeout });
            const channels = res.data.channels || [];
            return channels.map((c: any) => ({
                name: c.name,
                channel_name: c.name,
                code: c.code,
                url: c.url,
                image: c.image || "",
                status: c.status
            }));
        } catch (e: any) {
            console.error('[Sports99] Error fetching Live TV:', e.message);
            return [];
        }
    }

    // ---------------------------------------------------------
    // Fetch Sports Events
    // ---------------------------------------------------------
    public async fetchSportsEvents(): Promise<Sports99Channel[]> {
        const url = `${this.baseApi}/events/sports/?user=${this.user}&plan=${this.plan}`;
        try {
            const res = await axios.get(url, { timeout: this.timeout });
            const data = res.data;

            const flattenedChannels: Sports99Channel[] = [];

            if (data["cdn-live-tv"]) {
                for (const sportCategory of Object.keys(data["cdn-live-tv"])) {
                    const events = data["cdn-live-tv"][sportCategory];
                    if (!Array.isArray(events)) continue;

                    for (const event of events) {
                        const tournament = event.tournament || "";
                        const homeTeam = event.homeTeam || "";
                        const awayTeam = event.awayTeam || "";
                        const matchInfo = `${tournament} - ${homeTeam} vs ${awayTeam}`;

                        for (const channel of (event.channels || [])) {
                            flattenedChannels.push({
                                name: `${matchInfo} - ${channel.channel_name}`,
                                channel_name: channel.channel_name,
                                code: channel.channel_code,
                                url: channel.url,
                                image: channel.image || "",
                                tournament,
                                home_team: homeTeam,
                                away_team: awayTeam,
                                match_info: matchInfo,
                                sport_category: sportCategory,
                                status: event.status || "unknown",
                                start: event.start || "",
                                time: event.time || ""
                            });
                        }
                    }
                }
            }

            return flattenedChannels;
        } catch (e: any) {
            console.error('[Sports99] Error fetching Sports:', e.message);
            return [];
        }
    }

    // ---------------------------------------------------------
    // Resolve Stream URL
    // ---------------------------------------------------------
    public async resolveStreamUrl(playerUrl: string): Promise<string | null> {
        try {
            // Rewrite old credentials in cached player URLs
            let url = playerUrl;
            url = url.replace(/user=streamsports99/g, `user=${this.user}`);
            url = url.replace(/plan=vip/g, `plan=${this.plan}`);
            const headers = {
                Referer: this.playerReferer,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            };
            const res = await axios.get(url, { headers, timeout: this.timeout });
            const js = this.decodeObfuscatedJs(res.data);
            if (!js) {
                console.warn('[Sports99] Could not decode obfuscated JS');
                return null;
            }
            return this.findStreamUrl(js);
        } catch (e: any) {
            console.error('[Sports99] Error resolving stream:', e.message);
            return null;
        }
    }

    // ---------------------------------------------------------
    // Get All Channels (Sports + Live TV)
    // ---------------------------------------------------------
    public async getAllChannels(): Promise<Sports99Channel[]> {
        const [sports, liveTv] = await Promise.all([
            this.fetchSportsEvents(),
            this.fetchLiveTvChannels()
        ]);
        return [...sports, ...liveTv];
    }
}
