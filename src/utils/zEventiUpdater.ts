/**
 * Z-Eventi Updater
 * Fetches serieaz.m3u and coppez.m3u, parses Kodi-style M3U with ClearKey JSON,
 * stores raw URL with keys (addon builds proxy URL at runtime using user config)
 */

const fs = require('fs');
const axios = require('axios');

// Declare types for TypeScript
declare const require: (name: string) => any;
declare const process: any;
declare const __dirname: string;
declare const console: any;

interface ZEventiChannel {
    id: string;
    name: string;
    logo?: string;
    category: string;
    streams: { url: string; title: string }[];
    eventStart?: string;
    createdAt: string;
}

interface ClearKey {
    kty?: string;
    k: string;
    kid: string;
}

interface ClearKeyLicense {
    keys: ClearKey[];
    type?: string;
}

const ZEVENTI_FILE = '/tmp/z_eventi.json';
const ZEVENTI_LOGO = 'https://github.com/qwertyuiop8899/logo/blob/main/zeventi.png?raw=true';

// Source URLs from environment
function getSources(): { url: string; name: string }[] {
    const sources: { url: string; name: string }[] = [];

    const serieazUrl = (process?.env?.SEVENTIZ || '').toString().trim();
    if (serieazUrl) {
        sources.push({ url: serieazUrl, name: 'SerieAZ' });
    }

    const coppezUrl = (process?.env?.SCOPPEZ || '').toString().trim();
    if (coppezUrl) {
        sources.push({ url: coppezUrl, name: 'CoppeZ' });
    }

    return sources;
}

/**
 * Build raw URL with keys (same format as mpdzUpdater: url&key_id=X&key=Y)
 * Addon will build proxy URL at request time using user's mfpUrl config
 */
function buildRawUrlWithKeys(mpdUrl: string, kids: string, keys: string): string {
    return `${mpdUrl}&key_id=${kids}&key=${keys}`;
}

/**
 * Parse M3U content with Kodi-style ClearKey licenses
 */
function parseKodiM3u(content: string): ZEventiChannel[] {
    const channels: ZEventiChannel[] = [];
    const lines = content.split('\n');

    let currentExtinf = '';
    let currentLicenseJson = '';
    let idx = 0;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;

        if (line.startsWith('#EXTINF:')) {
            currentExtinf = line;
            currentLicenseJson = '';
        } else if (line.startsWith('#KODIPROP:inputstream.adaptive.license_key=')) {
            // Extract the JSON from the KODIPROP line
            currentLicenseJson = line.substring('#KODIPROP:inputstream.adaptive.license_key='.length);
        } else if (line.startsWith('http') && currentExtinf && currentLicenseJson) {
            // This is the MPD URL - process the complete entry
            try {
                // Parse the ClearKey JSON
                const license: ClearKeyLicense = JSON.parse(currentLicenseJson);

                if (license.keys && license.keys.length > 0) {
                    // Extract kid and k values
                    const kids = license.keys.map(k => k.kid).join(',');
                    const keys = license.keys.map(k => k.k).join(',');

                    // Build raw URL with keys (addon will build proxy at runtime)
                    const rawUrl = buildRawUrlWithKeys(line, kids, keys);

                    // Extract channel name from EXTINF
                    const nameMatch = currentExtinf.match(/,(.+)$/);
                    const channelName = nameMatch ? nameMatch[1].trim() : `Z-Event ${idx}`;

                    // Extract group-title if present
                    const groupMatch = currentExtinf.match(/group-title="([^"]+)"/);
                    const groupTitle = groupMatch ? groupMatch[1] : 'Z-Eventi';

                    // Create unique ID
                    const cleanId = channelName
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, '_')
                        .replace(/^_|_$/g, '');
                    const id = `zeventi_${cleanId}_${Date.now()}_${idx}`;

                    channels.push({
                        id,
                        name: channelName,
                        logo: ZEVENTI_LOGO,
                        category: 'Z-EVENTI',
                        streams: [{ url: rawUrl, title: groupTitle }],
                        createdAt: new Date().toISOString()
                    });

                    idx++;
                }
            } catch (e: any) {
                console.warn(`[Z-Eventi] Failed to parse license JSON: ${e.message}`);
            }

            // Reset for next entry
            currentExtinf = '';
            currentLicenseJson = '';
        }
    }

    return channels;
}

/**
 * Fetch and process all Z-Eventi sources
 */
export async function updateZEventiChannels(): Promise<number> {
    console.log('[Z-Eventi] 📥 Starting update...');

    const sources = getSources();
    if (sources.length === 0) {
        console.warn('[Z-Eventi] ⚠️ No sources configured (SEVENTIZ/SCOPPEZ env vars not set)');
        return 0;
    }

    const allChannels: ZEventiChannel[] = [];

    for (const source of sources) {
        try {
            console.log(`[Z-Eventi] Fetching ${source.name} from ${source.url}`);
            const response = await axios.get(source.url, {
                timeout: 30000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            const channels = parseKodiM3u(response.data);
            console.log(`[Z-Eventi] ✅ ${source.name}: ${channels.length} channels parsed`);
            allChannels.push(...channels);
        } catch (e: any) {
            console.error(`[Z-Eventi] ❌ Error fetching ${source.name}: ${e.message}`);
        }
    }

    // Save to file
    if (allChannels.length > 0) {
        try {
            fs.writeFileSync(ZEVENTI_FILE, JSON.stringify(allChannels, null, 2), 'utf-8');
            console.log(`[Z-Eventi] 💾 Saved ${allChannels.length} channels to ${ZEVENTI_FILE}`);
        } catch (e: any) {
            console.error(`[Z-Eventi] ❌ Error saving file: ${e.message}`);
        }
    } else {
        console.warn('[Z-Eventi] ⚠️ No channels parsed, keeping existing file');
    }

    return allChannels.length;
}

/**
 * Start scheduler for periodic updates
 */
export function startZEventiScheduler(intervalMs: number = 1500000): void {
    // Initial delayed run (60 seconds after startup)
    setTimeout(async () => {
        console.log('[Z-Eventi] 🚀 Initial update (delayed 60s)...');
        await updateZEventiChannels();
    }, 60000);

    // Periodic updates
    setInterval(async () => {
        console.log('[Z-Eventi] ⏰ Scheduled update...');
        await updateZEventiChannels();
    }, intervalMs);

    console.log(`[Z-Eventi] 📅 Scheduler started: updates every ${Math.round(intervalMs / 60000)} minutes`);
}
