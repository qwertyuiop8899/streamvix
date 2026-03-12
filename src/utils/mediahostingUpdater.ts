/**
 * MediaHosting channels & updater
 * 
 * Canali statici con ID fissi da mediahosting.space.
 * Mappatura basata su mandrakodi/StreamPhis.
 */
import { MediaHostingClient, MediaHostingChannel } from '../extractors/mediahosting';

// ===== CHANNEL MAP =====
// ID screenistream -> nome canale
const MEDIAHOSTING_CHANNELS: MediaHostingChannel[] = [
    { id: 325, name: 'DAZN 1',             category: 'DAZN',      logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a2/DAZN_1_Logo.svg/2560px-DAZN_1_Logo.svg.png' },
    { id: 326, name: 'Sky Sport Uno',       category: 'Sky Sport',  logo: 'https://it.imageservice.sky.com/pd-logo/skychb_23skysportunohddark/200/50?output-format=webp' },
    { id: 327, name: 'Sky Sport F1',        category: 'Sky Sport',  logo: 'https://it.imageservice.sky.com/pd-logo/skychb_478skysportf1hddark/200/50?output-format=webp' },
    { id: 328, name: 'Sky Sport Calcio',    category: 'Sky Sport',  logo: 'https://it.imageservice.sky.com/pd-logo/skychb_209skysportcalciodark/200/50?output-format=webp' },
    { id: 329, name: 'Sky Sport Tennis',    category: 'Sky Sport',  logo: 'https://it.imageservice.sky.com/pd-logo/skychb_559skysporttennisdark/200/50?output-format=webp' },
    { id: 330, name: 'Sky Sport MotoGP',    category: 'Sky Sport',  logo: 'https://it.imageservice.sky.com/pd-logo/skychb_483skysportmotogphddark/200/50?output-format=webp' },
    { id: 331, name: 'Sky Sport Arena',     category: 'Sky Sport',  logo: 'https://it.imageservice.sky.com/pd-logo/skychb_24skysportarenahddark/200/50?output-format=webp' },
    { id: 332, name: 'Sky Sport Max',       category: 'Sky Sport',  logo: 'https://it.imageservice.sky.com/pd-logo/skychb_248skysportmaxdark/200/50?output-format=webp' },
    { id: 333, name: 'Sky Sport Golf',      category: 'Sky Sport',  logo: 'https://it.imageservice.sky.com/pd-logo/skychb_234skysportdark/200/50?output-format=webp' },
    { id: 334, name: 'Sky Sport 24',        category: 'Sky Sport',  logo: 'https://it.imageservice.sky.com/pd-logo/skychb_35skysport24hddark/200/50?output-format=webp' },
    { id: 335, name: 'Sky Sport Basket',    category: 'Sky Sport',  logo: 'https://it.imageservice.sky.com/pd-logo/skychb_764skysportnbahddark/200/50?output-format=webp' },
    { id: 336, name: 'Sky Sport Legend',    category: 'Sky Sport',  logo: 'https://it.imageservice.sky.com/pd-logo/skychb_234skysportdark/200/50?output-format=webp' },
    { id: 337, name: 'Sky Sport Mix',       category: 'Sky Sport',  logo: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/e0/Sky_Sport_Mix_Logo_2022.svg/2560px-Sky_Sport_Mix_Logo_2022.svg.png' },
];

// --- OLD mediahosting IDs (commentato) ---
// { id: 229, name: 'DAZN 1',             category: 'DAZN' },
// { id: 230, name: 'Sky Sport Uno',       category: 'Sky Sport' },
// { id: 231, name: 'Sky Sport F1',        category: 'Sky Sport' },
// { id: 232, name: 'Sky Sport Calcio',    category: 'Sky Sport' },
// { id: 233, name: 'Sky Sport Tennis',    category: 'Sky Sport' },
// { id: 234, name: 'Sky Sport MotoGP',    category: 'Sky Sport' },
// { id: 235, name: 'Sky Sport Arena',     category: 'Sky Sport' },
// { id: 236, name: 'Sky Sport Max',       category: 'Sky Sport' },
// { id: 237, name: 'Sky Sport Golf',      category: 'Sky Sport' },
// { id: 238, name: 'Sky Sport 24',        category: 'Sky Sport' },
// { id: 239, name: 'Sky Sport Basket',    category: 'Sky Sport' },
// { id: 240, name: 'Sky Sport Legend',    category: 'Sky Sport' },
// { id: 241, name: 'Sky Sport Mix',       category: 'Sky Sport' },

// ===== CACHE =====
let cachedChannels: any[] = [];
const UPDATE_INTERVAL = 30 * 60 * 1000; // 30 min (canali statici, check solo se m3u8 cambia)

export function getMediaHostingChannels() {
    return cachedChannels;
}

export async function updateMediaHostingChannels(): Promise<number> {
    try {
        console.log('[MediaHosting] 🔄 Building channel list...');

        const channels = MEDIAHOSTING_CHANNELS.map((ch) => ({
            id: `mh_${ch.id}`,
            name: ch.name,
            description: `${ch.category} | MediaHosting`,
            logo: ch.logo || '',
            poster: ch.logo || '',
            background: ch.logo || '',
            type: 'tv',
            category: 'mediahosting',
            posterShape: 'square',
            _dynamic: true,
            _mediahosting: {
                stream_id: ch.id,
                channel_name: ch.name,
                category: ch.category,
            }
        }));

        cachedChannels = channels;
        console.log(`[MediaHosting] ✅ Loaded ${channels.length} channels`);
        return channels.length;
    } catch (e: any) {
        console.error(`[MediaHosting] ❌ Update failed: ${e.message}`);
        return 0;
    }
}

export function startMediaHostingScheduler() {
    updateMediaHostingChannels(); // Initial run
    setInterval(updateMediaHostingChannels, UPDATE_INTERVAL);
}
