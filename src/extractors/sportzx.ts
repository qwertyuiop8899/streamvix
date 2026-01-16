import axios from 'axios';
import * as crypto from 'crypto';

export interface SportzxChannel {
    event_title: string;
    event_id: string;
    event_cat: string;
    event_name: string;
    event_time: string;
    channel_title?: string;
    stream_url: string;
    keyid?: string;
    key?: string;
    api?: string;
    headers?: string;
    referer?: string;
    origin?: string;
}

export class SportzxClient {
    private static APP_PASSWORD = "oAR80SGuX3EEjUGFRwLFKBTiris=";
    private excludedCategories: Set<string>;
    private timeout: number;

    constructor(excludedCategories: string[] = [], timeout: number = 10000) {
        this.excludedCategories = new Set(excludedCategories.map(c => c.toLowerCase()));
        this.timeout = timeout;
    }

    // ---------------------------------------------------------
    // Custom AES Key/IV Derivation
    // ---------------------------------------------------------
    private generateAesKeyIv(s: string): { key: Buffer, iv: Buffer } {
        const CHARSET = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+!@#$%&=");

        // Helper for 32-bit unsigned integer arithmetic
        const u32 = (x: number) => x >>> 0;

        const data = Buffer.from(s, 'utf-8');
        const n = data.length;

        // FNV-1a like hashing for Key
        let u = 0x811c9dc5;
        for (const b of data) {
            u = u32(Math.imul(u ^ b, 0x1000193));
        }

        const key = Buffer.alloc(16);
        for (let i = 0; i < 16; i++) {
            const b = data[i % n];
            u = u32(Math.imul(u, 0x1f) + (i ^ b)); // Mix
            key[i] = CHARSET[u % CHARSET.length];
        }

        // FNV-1a like hashing for IV
        u = 0x811c832a;
        for (const b of data) {
            u = u32(Math.imul(u ^ b, 0x1000193));
        }

        const iv = Buffer.alloc(16);
        let idx = 0;
        let acc = 0;
        while (idx !== 0x30) { // 48 iterations? The python loop is: while idx != 0x30 (48). so 16 iterations of +3?
            // Python: idx starts 0, increments by 3. 0, 3, 6 ... 45. Loop runs 16 times.
            // Wait, python code: 
            // while idx != 0x30:
            //    b = data[idx % n] ...
            //    iv.append(...)
            //    idx += 3
            // Validates: 16 * 3 = 48. Correct.

            const b = data[idx % n];
            u = u32(Math.imul(u, 0x1d) + (acc ^ b));
            iv[idx / 3] = CHARSET[u % CHARSET.length]; // idx is 0, 3, 6... so idx/3 is 0, 1, 2...

            idx += 3;
            acc = u32(acc + 7);
        }

        return { key, iv };
    }

    // ---------------------------------------------------------
    // Decrypt
    // ---------------------------------------------------------
    private decryptData(b64Data: string): string {
        try {
            const ct = Buffer.from(b64Data, 'base64');
            if (ct.length === 0) return "";

            const { key, iv } = this.generateAesKeyIv(SportzxClient.APP_PASSWORD);

            const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
            decipher.setAutoPadding(false); // Manual padding removal as in Python code

            let pt = Buffer.concat([decipher.update(ct), decipher.final()]);

            // Remove PKCS7-like padding (Python code does: pad = pt[-1], return pt[:-pad])
            const pad = pt[pt.length - 1];
            if (pad > 0 && pad <= 16) {
                pt = pt.subarray(0, pt.length - pad);
            }

            return pt.toString('utf-8');
        } catch (error) {
            console.error('Error decrypting data:', error);
            return "";
        }
    }

    private async fetchAndDecrypt(url: string): Promise<any> {
        const response = await axios.get(url, { timeout: this.timeout });
        const encryptedData = response.data.data;
        const decryptedJson = this.decryptData(encryptedData);
        return JSON.parse(decryptedJson);
    }

    // ---------------------------------------------------------
    // Get API URL
    // ---------------------------------------------------------
    private async getApiUrl(): Promise<string | null> {
        const installUrl = "https://firebaseinstallations.googleapis.com/v1/projects/sportzx-7cc3f/installations";
        const installHeaders = {
            "Accept": "application/json",
            "Accept-Encoding": "gzip",
            "Cache-Control": "no-cache",
            "Connection": "Keep-Alive",
            "Content-Type": "application/json",
            "User-Agent": "Dalvik/2.1.0 (Linux; Android 13)",
            "X-Android-Cert": "A0047CD121AE5F71048D41854702C52814E2AE2B",
            "X-Android-Package": "com.sportzx.live",
            "x-firebase-client": "H4sIAAAAAAAAAKtWykhNLCpJSk0sKVayio7VUSpLLSrOzM9TslIyUqoFAFyivEQfAAAA",
            "x-goog-api-key": "AIzaSyBa5qiq95T97xe4uSYlKo0Wosmye_UEf6w"
        };
        const installBody = {
            "fid": "eOaLWBo8S7S1oN-vb23mkf",
            "appId": "1:446339309956:android:b26582b5d2ad841861bdd1",
            "authVersion": "FIS_v2",
            "sdkVersion": "a:18.0.0"
        };

        let authToken: string;
        try {
            const res = await axios.post(installUrl, installBody, { headers: installHeaders, timeout: this.timeout });
            authToken = res.data.authToken?.token;
            if (!authToken) throw new Error("Auth token not found");
        } catch (e: any) {
            console.error("Error fetching auth token:", e.message);
            return null;
        }

        const configUrl = "https://firebaseremoteconfig.googleapis.com/v1/projects/446339309956/namespaces/firebase:fetch";
        const configHeaders = {
            "Content-Type": "application/json",
            "User-Agent": "Dalvik/2.1.0 (Linux; Android 13)",
            "X-Android-Cert": "A0047CD121AE5F71048D41854702C52814E2AE2B",
            "X-Android-Package": "com.sportzx.live",
            "X-Firebase-RC-Fetch-Type": "BASE/1",
            "X-Goog-Api-Key": "AIzaSyBa5qiq95T97xe4uSYlKo0Wosmye_UEf6w",
            "X-Goog-Firebase-Installations-Auth": authToken,
        };
        const configBody = {
            "appVersion": "2.1",
            "firstOpenTime": "2025-11-10T16:00:00.000Z",
            "timeZone": "Europe/Rome",
            "appInstanceIdToken": authToken,
            "languageCode": "it-IT",
            "appBuild": "12",
            "appInstanceId": "eOaLWBo8S7S1oN-vb23mkf",
            "countryCode": "IT",
            "appId": "1:446339309956:android:b26582b5d2ad841861bdd1",
            "platformVersion": "33",
            "sdkVersion": "22.1.2",
            "packageName": "com.sportzx.live"
        };

        try {
            const res = await axios.post(configUrl, configBody, { headers: configHeaders, timeout: this.timeout });
            return res.data.entries?.api_url;
        } catch (e: any) {
            console.error("Error fetching API URL:", e.message);
            return null;
        }
    }

    // ---------------------------------------------------------
    // Get Channels
    // ---------------------------------------------------------
    public async getChannels(): Promise<SportzxChannel[]> {
        const apiUrl = await this.getApiUrl();
        if (!apiUrl) return [];

        const channelsList: SportzxChannel[] = [];
        const urlEvent = `${apiUrl}/events.json`;

        try {
            let events = await this.fetchAndDecrypt(urlEvent);
            if (!Array.isArray(events)) events = [];

            // Filter events
            const validEvents = events.filter((e: any) =>
                e.cat && !this.excludedCategories.has(e.cat.toLowerCase())
            );

            for (const event of validEvents) {
                try {
                    const channels = await this.fetchAndDecrypt(`${apiUrl}/channels/${event.id}.json`);
                    if (!Array.isArray(channels)) continue;

                    for (const ch of channels) {
                        const linkParts = (ch.link || "").split("|");
                        const streamLink = linkParts[0];
                        const headerPart = linkParts[1] || "";

                        let referer: string | undefined;
                        let origin: string | undefined;

                        if (headerPart) {
                            const hParts = headerPart.replace(/\|/g, "").split("&");
                            for (const p of hParts) {
                                if (p.toLowerCase().startsWith("referer=")) referer = p.split("=", 2)[1];
                                else if (p.toLowerCase().startsWith("origin=")) origin = p.split("=", 2)[1];
                            }
                        }

                        let keyid: string | undefined;
                        let key: string | undefined;
                        if (ch.api && ch.api.includes(":")) {
                            [keyid, key] = ch.api.split(":", 2);
                        }

                        // event.eventInfo.startTime format: "2025/11/10 16:00:00 +0000"
                        const startTime = event.eventInfo?.startTime || "";
                        const timeSt = startTime.substring(0, 16);

                        channelsList.push({
                            event_title: event.title,
                            event_id: event.id,
                            event_cat: event.cat,
                            event_name: event.eventInfo?.eventName,
                            event_time: timeSt,
                            channel_title: ch.title,
                            stream_url: streamLink.trim(),
                            keyid,
                            key,
                            api: ch.api,
                            headers: headerPart,
                            referer,
                            origin
                        });
                    }
                } catch (err) {
                    console.error(`Error fetching channels for event ${event.id}`, err);
                }
            }
        } catch (err) {
            console.error("Error in main loop", err);
        }

        return channelsList;
    }
}
