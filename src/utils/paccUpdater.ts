/**
 * pa.cc channels updater
 *
 * Fetcha la lista M3U dall'env PARTITE_ENV, parsa canali e li espone per il catalogo.
 * Aggiornamento schedulato alle 11:10, 14:10, 17:10, 20:10 ora di Roma (Europe/Rome).
 */

interface PaccChannelDef {
    name: string;
    logo: string;
    streamUrl: string;
    group: string;
}

// ===== CACHE =====
let cachedChannels: any[] = [];

export function getPaccChannels() {
    return cachedChannels;
}

/**
 * Parse an M3U playlist string into channel definitions.
 * Expected format:
 *   #EXTM3U
 *   #EXTINF:-1 tvg-logo="..." group-title="...",Channel Name
 *   http://stream.url/...
 */
function parseM3u(content: string): PaccChannelDef[] {
    const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
    const channels: PaccChannelDef[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line.startsWith('#EXTINF:')) continue;
        const urlLine = lines[i + 1];
        if (!urlLine || urlLine.startsWith('#')) continue;

        // Parse EXTINF attributes
        const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
        const groupMatch = line.match(/group-title="([^"]*)"/i);
        const nameMatch = line.match(/,(.+)$/);

        const name = nameMatch ? nameMatch[1].trim() : `Channel ${channels.length + 1}`;
        const logo = logoMatch ? logoMatch[1] : '';
        const group = groupMatch ? groupMatch[1] : 'pa.cc';

        channels.push({ name, logo, streamUrl: urlLine.trim(), group });
        i++; // skip URL line
    }
    return channels;
}

export async function updatePaccChannels(): Promise<number> {
    const m3uUrl = process.env.PARTITE_ENV || '';
    if (!m3uUrl) {
        console.warn('[pa.cc] ⚠️ PARTITE_ENV non configurata, skip update');
        return 0;
    }
    try {
        console.log('[pa.cc] 🔄 Fetching M3U from PARTITE_ENV...');
        const res = await fetch(m3uUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (StreamViX pa.cc updater)' },
            signal: AbortSignal.timeout(15000)
        });
        if (!res.ok) {
            console.error(`[pa.cc] ❌ Fetch failed: ${res.status}`);
            return 0;
        }
        const body = await res.text();
        const parsed = parseM3u(body);
        if (!parsed.length) {
            console.warn('[pa.cc] ⚠️ M3U parsed 0 channels');
            return 0;
        }

        const channels = parsed.map((ch, idx) => ({
            id: `pacc_${idx}_${normalizeId(ch.name)}`,
            name: ch.name,
            description: `${ch.group} | pa.cc`,
            logo: ch.logo || '',
            poster: ch.logo || '',
            background: ch.logo || '',
            type: 'tv',
            category: 'pacc',
            posterShape: 'square',
            _dynamic: true,
            _pacc: {
                channel_name: ch.name,
                streamUrl: ch.streamUrl,
                group: ch.group,
            }
        }));

        cachedChannels = channels;
        console.log(`[pa.cc] ✅ Loaded ${channels.length} channels`);
        return channels.length;
    } catch (e: any) {
        console.error(`[pa.cc] ❌ Update failed: ${e.message}`);
        return 0;
    }
}

function normalizeId(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').substring(0, 40);
}

/**
 * Calcola i millisecondi fino al prossimo orario schedulato (11:10, 14:10, 17:10, 20:10 Europe/Rome).
 */
function msUntilNextRun(): number {
    const SCHEDULE_HOURS = [11, 14, 17, 20];
    const SCHEDULE_MINUTES = 10;

    const now = new Date();
    // Ottieni ora corrente in fuso Europe/Rome
    const romeStr = now.toLocaleString('en-US', { timeZone: 'Europe/Rome' });
    const romeNow = new Date(romeStr);

    let best = Infinity;
    // Controlla oggi e domani
    for (const dayOffset of [0, 1]) {
        for (const hour of SCHEDULE_HOURS) {
            const target = new Date(romeNow);
            target.setDate(target.getDate() + dayOffset);
            target.setHours(hour, SCHEDULE_MINUTES, 0, 0);
            const diff = target.getTime() - romeNow.getTime();
            if (diff > 1000 && diff < best) { // almeno 1s nel futuro
                best = diff;
            }
        }
    }
    return best === Infinity ? 60 * 60 * 1000 : best; // fallback 1h
}

function scheduleNextRun() {
    const ms = msUntilNextRun();
    const mins = Math.round(ms / 60000);
    console.log(`[pa.cc] ⏰ Prossimo aggiornamento tra ${mins} min`);
    setTimeout(async () => {
        await updatePaccChannels();
        scheduleNextRun(); // ricorsivo: schedula il run successivo
    }, ms);
}

export function startPaccScheduler() {
    // Run iniziale immediato
    updatePaccChannels();
    // Schedula i run successivi agli orari fissi
    scheduleNextRun();
}
