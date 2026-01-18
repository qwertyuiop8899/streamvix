
import { SportzxClient } from '../extractors/sportzx';
import { Stream } from 'stremio-addon-sdk';

// Config
const UPDATE_INTERVAL = 15 * 60 * 1000; // 15 minutes
const LOGO_URL = "https://github.com/qwertyuiop8899/logo/blob/main/sportzx.png?raw=true";

// Cache
let cachedChannels: any[] = [];
const client = new SportzxClient();

export function getSportzxChannels() {
    return cachedChannels;
}

export async function updateSportzxChannels() {
    try {
        console.log('[SportzX] 🔄 Updating channels...');
        const channels = await client.getChannels();

        // Transform into Stremio-compatible objects or internal format
        // We will store them in a format similar to dynamicChannels generic format
        // so they can be easily merged in addon.ts

        const validChannels = channels.map((ch, index) => {
            // Format Title: [TIME] Event - Channel (if time exists)
            // Time is often "2025/11/10 16:00" string or empty
            let timeStr = "";
            if (ch.event_time) {
                // Try to extract HH:MM if possible, or use as is
                const parts = ch.event_time.split(' ');
                if (parts.length > 1) {
                    const timePart = parts[1].substring(0, 5); // "16:00"
                    timeStr = `[${timePart}] `;
                }
            }

            const name = `${timeStr}${ch.event_title} - ${ch.channel_title}`;

            return {
                id: `sportzx_${ch.event_id}_${index}`,
                name: name,
                description: `${ch.event_cat} | ${ch.event_name}`,
                logo: LOGO_URL,
                poster: LOGO_URL,
                background: LOGO_URL,
                type: 'tv',
                category: 'sportzx', // lowercase to match getChannelCategories() normalization
                posterShape: 'square',
                _dynamic: true, // Mark as dynamic channel
                // Store raw data for stream generation in addon.ts
                _sportzx: {
                    stream_url: ch.stream_url,
                    keyid: ch.keyid,
                    key: ch.key,
                    headers: ch.headers,
                    channel_title: ch.channel_title
                }
            };
        });

        cachedChannels = validChannels;
        console.log(`[SportzX] ✅ Updated ${validChannels.length} channels`);
        return validChannels.length;
    } catch (e: any) {
        console.error(`[SportzX] ❌ Update failed: ${e.message}`);
        return 0;
    }
}

export function startSportzxScheduler() {
    updateSportzxChannels(); // Initial run
    setInterval(updateSportzxChannels, UPDATE_INTERVAL);
}
