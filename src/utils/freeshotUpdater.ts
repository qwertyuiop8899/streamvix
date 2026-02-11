/**
 * Freeshot channels & updater
 * 
 * Canali statici basati su FREESHOT_CODE_MAP (popcdn / beautifulpeople).
 * Stessa lista di freeshotRuntime.ts ma strutturata per il catalogo.
 */

interface FreeshotChannelDef {
    code: string;    // codice Freeshot (es. SkySportUnoIT)
    name: string;    // nome visuale
    category: string;
    logo: string;
}

const FREESHOT_CHANNELS: FreeshotChannelDef[] = [
    { code: 'ZonaDAZN',        name: 'Zona DAZN',        category: 'DAZN',      logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a2/DAZN_1_Logo.svg/2560px-DAZN_1_Logo.svg.png' },
    { code: 'SkySportUnoIT',   name: 'Sky Sport Uno',    category: 'Sky Sport', logo: 'https://it.imageservice.sky.com/pd-logo/skychb_23skysportunohddark/200/50?output-format=webp' },
    { code: 'SkySportCalcioIT', name: 'Sky Sport Calcio', category: 'Sky Sport', logo: 'https://it.imageservice.sky.com/pd-logo/skychb_209skysportcalciodark/200/50?output-format=webp' },
    { code: 'SkySportF1IT',    name: 'Sky Sport F1',     category: 'Sky Sport', logo: 'https://it.imageservice.sky.com/pd-logo/skychb_478skysportf1hddark/200/50?output-format=webp' },
    { code: 'SkySportMotoGPIT', name: 'Sky Sport MotoGP', category: 'Sky Sport', logo: 'https://it.imageservice.sky.com/pd-logo/skychb_483skysportmotogphddark/200/50?output-format=webp' },
    { code: 'SkySportTennisIT', name: 'Sky Sport Tennis', category: 'Sky Sport', logo: 'https://it.imageservice.sky.com/pd-logo/skychb_559skysporttennisdark/200/50?output-format=webp' },
    { code: 'SkySportArenaIT', name: 'Sky Sport Arena',  category: 'Sky Sport', logo: 'https://it.imageservice.sky.com/pd-logo/skychb_24skysportarenahddark/200/50?output-format=webp' },
    { code: 'SkySportMaxIT',   name: 'Sky Sport Max',    category: 'Sky Sport', logo: 'https://it.imageservice.sky.com/pd-logo/skychb_248skysportmaxdark/200/50?output-format=webp' },
    { code: 'SkySport24IT',    name: 'Sky Sport 24',     category: 'Sky Sport', logo: 'https://it.imageservice.sky.com/pd-logo/skychb_35skysport24hddark/200/50?output-format=webp' },
    { code: 'SkySportGolfIT',  name: 'Sky Sport Golf',   category: 'Sky Sport', logo: 'https://it.imageservice.sky.com/pd-logo/skychb_234skysportdark/200/50?output-format=webp' },
];

// ===== CACHE =====
let cachedChannels: any[] = [];
const UPDATE_INTERVAL = 30 * 60 * 1000; // 30 min

export function getFreeshotChannels() {
    return cachedChannels;
}

export async function updateFreeshotChannels(): Promise<number> {
    try {
        console.log('[Freeshot] 🔄 Building channel list...');

        const channels = FREESHOT_CHANNELS.map((ch) => ({
            id: `fs_${ch.code}`,
            name: ch.name,
            description: `${ch.category} | Freeshot`,
            logo: ch.logo || '',
            poster: ch.logo || '',
            background: ch.logo || '',
            type: 'tv',
            category: 'freeshot',
            posterShape: 'square',
            _dynamic: true,
            _freeshot: {
                code: ch.code,
                channel_name: ch.name,
                category: ch.category,
            }
        }));

        cachedChannels = channels;
        console.log(`[Freeshot] ✅ Loaded ${channels.length} channels`);
        return channels.length;
    } catch (e: any) {
        console.error(`[Freeshot] ❌ Update failed: ${e.message}`);
        return 0;
    }
}

export function startFreeshotScheduler() {
    updateFreeshotChannels(); // Initial run
    setInterval(updateFreeshotChannels, UPDATE_INTERVAL);
}
