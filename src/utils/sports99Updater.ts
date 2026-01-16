import { Sports99Client, Sports99Channel } from '../extractors/sports99';

// Config
const UPDATE_INTERVAL = 15 * 60 * 1000; // 15 minutes
const LOGO_URL = "https://raw.githubusercontent.com/AlessandroZ/BeRoot/master/Linux/beroot/modules/icons/sport.png";

// Cache
let cachedChannels: any[] = [];
const client = new Sports99Client();

export function getSports99Channels() {
    return cachedChannels;
}

export async function updateSports99Channels() {
    try {
        console.log('[Sports99] 🔄 Updating channels...');
        const channels = await client.fetchSportsEvents();

        // Transform into Stremio-compatible format
        const validChannels = channels
            .filter(ch => ch.status !== 'offline')
            .map((ch, index) => {
                // Format: [DD/MM HH:MM] Event - Channel
                let timeStr = "";
                if (ch.start) {
                    // start format: "2026-01-16 19:45"
                    const parts = ch.start.split(' ');
                    if (parts.length === 2) {
                        try {
                            // Parse date explicitly to avoid timezone issues with Date constructor on different systems
                            // Format: YYYY-MM-DD HH:MM
                            const [y, m, d] = parts[0].split('-').map(Number);
                            const [hh, mm] = parts[1].split(':').map(Number);

                            // Create date object (months are 0-indexed)
                            // Treat as UTC or just raw numbers to avoid local timezone offset shifts if server is not UTC
                            // But simplest is to just use Date methods.
                            const date = new Date(y, m - 1, d, hh, mm);

                            // Add 1 hour
                            date.setHours(date.getHours() + 1);

                            // Format output: [DD/MM HH:MM]
                            const day = String(date.getDate()).padStart(2, '0');
                            const month = String(date.getMonth() + 1).padStart(2, '0');
                            const hours = String(date.getHours()).padStart(2, '0');
                            const minutes = String(date.getMinutes()).padStart(2, '0');

                            timeStr = `[${day}/${month} ${hours}:${minutes}] `;
                        } catch (e) {
                            // Fallback to original if parsing fails
                            const dateParts = parts[0].split('-');
                            const timePart = parts[1].substring(0, 5);
                            if (dateParts.length === 3) {
                                timeStr = `[${dateParts[2]}/${dateParts[1]} ${timePart}] `;
                            }
                        }
                    }
                }

                const eventName = ch.match_info || ch.name || "Unknown Event";
                const channelName = ch.channel_name || "";
                const name = `${timeStr}${eventName} - ${channelName}`;

                return {
                    id: `sports99_${ch.code}_${index}`,
                    name: name,
                    description: `${ch.sport_category || 'Sport'} | ${eventName}`,
                    logo: ch.image || LOGO_URL,
                    poster: ch.image || LOGO_URL,
                    background: ch.image || LOGO_URL,
                    type: 'tv',
                    category: 'sports99', // lowercase for getChannelCategories()
                    posterShape: 'square',
                    _dynamic: true,
                    // Store raw data for stream resolution
                    _sports99: {
                        player_url: ch.url,
                        channel_name: ch.channel_name,
                        match_info: ch.match_info,
                        sport_category: ch.sport_category
                    }
                };
            });

        cachedChannels = validChannels;
        console.log(`[Sports99] ✅ Updated ${validChannels.length} channels`);
        return validChannels.length;
    } catch (e: any) {
        console.error(`[Sports99] ❌ Update failed: ${e.message}`);
        return 0;
    }
}

export function startSports99Scheduler() {
    updateSports99Channels(); // Initial run
    setInterval(updateSports99Channels, UPDATE_INTERVAL);
}
