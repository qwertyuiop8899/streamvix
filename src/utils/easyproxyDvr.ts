/**
 * EasyProxy DVR Integration for StreamVix
 *
 * This module provides functions to:
 * 1. Generate "Record" stream URLs for channels
 * 2. Fetch available recordings for a channel
 * 3. Generate playback URLs for recordings
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;

export interface Recording {
    id: string;
    name: string;
    url: string;
    file_path: string;
    status: string;
    started_at: string;
    stopped_at?: string;
    duration_seconds?: number;
    file_size_bytes?: number;
    is_active: boolean;
    elapsed_seconds?: number;
}

export interface DvrConfig {
    easyProxyUrl: string;
    apiPassword?: string;
}

/**
 * Check if DVR is enabled via environment variable
 * DVR is disabled by default and must be explicitly enabled
 */
function isDvrEnabled(): boolean {
    const envValue = (process?.env?.DVR_ENABLED || '').toString().toLowerCase().trim();
    return envValue === 'true' || envValue === '1' || envValue === 'yes';
}

/**
 * Get DVR configuration from addon config (manifest) or environment variables
 *
 * DVR is enabled when:
 * - dvrEnabled is true in addon config, OR
 * - DVR_ENABLED env var is true
 *
 * Uses mediaFlowProxyUrl/mediaFlowProxyPassword from addon config (same as EasyProxy URL)
 *
 * @param addonConfig - Optional addon config object from manifest
 */
export function getDvrConfig(addonConfig?: {
    mediaFlowProxyUrl?: string;
    mediaFlowProxyPassword?: string;
    dvrEnabled?: boolean;
}): DvrConfig | null {
    // Check if DVR is enabled via addon config OR env var
    const dvrEnabledInConfig = addonConfig?.dvrEnabled === true;
    if (!isDvrEnabled() && !dvrEnabledInConfig) {
        return null;
    }

    // Priority: addon config > environment variables
    // Use mediaFlowProxyUrl since EasyProxy uses the same field
    const easyProxyUrl = (
        addonConfig?.mediaFlowProxyUrl ||
        process?.env?.EASYPROXY_URL ||
        process?.env?.DVR_URL ||
        ''
    ).toString().trim().replace(/\/+$/, '');

    if (!easyProxyUrl) {
        return null;
    }

    const apiPassword = (
        addonConfig?.mediaFlowProxyPassword ||
        process?.env?.EASYPROXY_PASSWORD ||
        process?.env?.DVR_PASSWORD ||
        ''
    ).toString().trim() || undefined;

    return {
        easyProxyUrl,
        apiPassword
    };
}

/**
 * Build a "Record" URL that will start a recording when accessed
 */
export function buildRecordUrl(
    config: DvrConfig,
    sourceUrl: string,
    channelName: string,
    options?: {
        duration?: number;  // Duration in seconds (default: 8 hours)
    }
): string {
    const params = new URLSearchParams();
    params.set('url', sourceUrl);
    params.set('name', channelName);

    if (options?.duration) {
        params.set('duration', String(options.duration));
    }
    if (config.apiPassword) {
        params.set('api_password', config.apiPassword);
    }

    // Extract key_id and key from sourceUrl if present (for DRM-protected streams)
    try {
        const url = new URL(sourceUrl);
        const keyId = url.searchParams.get('key_id');
        const key = url.searchParams.get('key');
        if (keyId) {
            params.set('key_id', keyId);
        }
        if (key) {
            params.set('key', key);
        }
    } catch {
        // Invalid URL, skip key extraction
    }

    return `${config.easyProxyUrl}/record?${params.toString()}`;
}

/**
 * Fetch all recordings from EasyProxy
 */
async function fetchAllRecordings(config: DvrConfig): Promise<Recording[]> {
    try {
        const params = new URLSearchParams();
        if (config.apiPassword) {
            params.set('api_password', config.apiPassword);
        }

        const url = `${config.easyProxyUrl}/api/recordings?${params.toString()}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                ...(config.apiPassword ? { 'x-api-password': config.apiPassword } : {})
            },
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
            console.warn(`[DVR] Failed to fetch recordings: ${response.status}`);
            return [];
        }

        const data = await response.json();
        return data.recordings || [];
    } catch (error) {
        console.warn(`[DVR] Error fetching recordings:`, (error as any)?.message || error);
        return [];
    }
}

/**
 * Check if a recording matches a channel
 */
function recordingMatchesChannel(rec: Recording, channelName: string, sourceUrl?: string): boolean {
    // Match by source URL if provided
    if (sourceUrl && rec.url === sourceUrl) {
        return true;
    }
    // Match by name (fuzzy)
    const normalizedChannelName = normalizeForMatch(channelName);
    const normalizedRecName = normalizeForMatch(rec.name);
    return normalizedRecName.includes(normalizedChannelName) ||
           normalizedChannelName.includes(normalizedRecName);
}

/**
 * Fetch recordings from EasyProxy that match a channel
 * @param config DVR configuration
 * @param channelName Channel name to search for (fuzzy match)
 * @param sourceUrl Optional source URL to match exactly
 */
export async function getRecordingsForChannel(
    config: DvrConfig,
    channelName: string,
    sourceUrl?: string
): Promise<Recording[]> {
    const recordings = await fetchAllRecordings(config);

    return recordings.filter(rec => recordingMatchesChannel(rec, channelName, sourceUrl))
        .filter(rec => {
            // Return completed/stopped recordings, or failed recordings that have valid files
            // (failed can happen when FFmpeg is killed during stop, but file is still valid)
            const hasValidFile = rec.file_size_bytes && rec.file_size_bytes > 0;
            const isFinishedStatus = ['completed', 'stopped', 'failed'].includes(rec.status);
            return isFinishedStatus && hasValidFile && !rec.is_active;
        });
}

/**
 * Get active recordings for a channel
 */
export async function getActiveRecordingsForChannel(
    config: DvrConfig,
    channelName: string,
    sourceUrl?: string
): Promise<Recording[]> {
    const recordings = await fetchAllRecordings(config);

    return recordings.filter(rec => recordingMatchesChannel(rec, channelName, sourceUrl))
        .filter(rec => rec.is_active && rec.status === 'recording');
}

/**
 * Build a stop-and-stream URL for an active recording
 * When accessed, this stops the recording and redirects to stream the recorded content
 */
export function buildStopAndStreamUrl(config: DvrConfig, recordingId: string): string {
    const params = new URLSearchParams();
    if (config.apiPassword) {
        params.set('api_password', config.apiPassword);
    }
    return `${config.easyProxyUrl}/record/stop/${recordingId}?${params.toString()}`;
}

/**
 * Build a stream URL for a recording
 */
export function buildRecordingStreamUrl(config: DvrConfig, recordingId: string): string {
    const params = new URLSearchParams();
    if (config.apiPassword) {
        params.set('api_password', config.apiPassword);
    }
    return `${config.easyProxyUrl}/api/recordings/${recordingId}/stream?${params.toString()}`;
}

/**
 * Build a delete URL for a recording (GET-based for Stremio compatibility)
 */
export function buildRecordingDeleteUrl(config: DvrConfig, recordingId: string): string {
    const params = new URLSearchParams();
    if (config.apiPassword) {
        params.set('api_password', config.apiPassword);
    }
    return `${config.easyProxyUrl}/api/recordings/${recordingId}/delete?${params.toString()}`;
}

/**
 * Format duration in a human-readable way
 */
export function formatDuration(seconds: number): string {
    if (!seconds) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h${m}m`;
    return `${m}m`;
}

/**
 * Format file size in a human-readable way
 */
export function formatFileSize(bytes: number): string {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    return `${size.toFixed(1)}${units[unitIndex]}`;
}

/**
 * Normalize a string for fuzzy matching
 */
function normalizeForMatch(str: string): string {
    return str
        .toLowerCase()
        .replace(/[^\w\s]/g, '')  // Remove special characters
        .replace(/\s+/g, ' ')     // Normalize whitespace
        .trim();
}

/**
 * Replace the first [TAG] in a channel name with the duration
 * e.g., "[FREE] Sky Sport F1" with 90 min -> "[1h30m] Sky Sport F1"
 */
function replaceSourceTagWithDuration(name: string, durationSeconds?: number): string {
    const duration = durationSeconds ? formatDuration(durationSeconds) : '';

    // Match first [TAG] pattern (e.g., [FREE], [MPD2], [HD], etc.)
    const tagPattern = /^\[([^\]]+)\]\s*/;

    if (duration && tagPattern.test(name)) {
        // Replace first tag with duration
        return name.replace(tagPattern, `[${duration}] `);
    } else if (duration) {
        // No tag found, prepend duration
        return `[${duration}] ${name}`;
    } else {
        // No duration, just remove the first tag if present
        return name.replace(tagPattern, '');
    }
}

/**
 * Build a DVR record URL for a specific stream.
 * This creates a record URL that starts recording AND redirects to watch the stream.
 *
 * @param streamUrl - The stream URL to record
 * @param streamTitle - The original stream title (used for naming the recording)
 * @param channelName - The channel name
 * @param options - Recording options
 */
export function buildDvrRecordEntry(
    streamUrl: string,
    streamTitle: string,
    channelName: string,
    options?: {
        duration?: number;
        addonConfig?: { mediaFlowProxyUrl?: string; mediaFlowProxyPassword?: string; dvrEnabled?: boolean };
    }
): { url: string; title: string } | null {
    const config = getDvrConfig(options?.addonConfig);
    if (!config) {
        return null;
    }

    const duration = options?.duration || 14400; // 4 hours default
    const durationHours = Math.round(duration / 3600);

    // Use stream title as recording name (avoid repetition with channel name)
    const recordingName = streamTitle.substring(0, 100);

    const recordUrl = buildRecordUrl(config, streamUrl, recordingName, { duration });

    return {
        url: recordUrl,
        title: `🔴 REC (${durationHours}h) ${streamTitle}`
    };
}

/**
 * Generate DVR streams for a channel (Active recordings + Completed recordings)
 * Note: Individual "Record" options should be added per-stream using buildDvrRecordEntry()
 *
 * @param channelName - Display name of the channel
 * @param sourceUrl - Source stream URL (for matching recordings)
 * @param options - Recording options
 * @param options.addonConfig - Addon config from manifest (mediaFlowProxyUrl, mediaFlowProxyPassword, dvrEnabled)
 */
export async function getDvrStreamsForChannel(
    channelName: string,
    sourceUrl: string,
    options?: {
        defaultDuration?: number;
        isDynamicEvent?: boolean;
        eventStart?: string;
        addonConfig?: { mediaFlowProxyUrl?: string; mediaFlowProxyPassword?: string; dvrEnabled?: boolean };
    }
): Promise<Array<{ url: string; title: string }>> {
    const config = getDvrConfig(options?.addonConfig);
    if (!config) {
        return [];
    }

    const streams: Array<{ url: string; title: string }> = [];

    try {
        // 1. Check for active recordings first
        const activeRecordings = await getActiveRecordingsForChannel(config, channelName, sourceUrl);

        for (const activeRec of activeRecordings) {
            const elapsed = activeRec.elapsed_seconds ? formatDuration(activeRec.elapsed_seconds) : '';
            const stopStreamUrl = buildStopAndStreamUrl(config, activeRec.id);

            streams.push({
                url: stopStreamUrl,
                title: `🔴 Recording... ${elapsed ? `(${elapsed})` : ''} - Stop & Watch`
            });
        }

        // 2. Fetch completed recordings for this channel
        const recordings = await getRecordingsForChannel(config, channelName, sourceUrl);

        for (const rec of recordings) {
            const size = rec.file_size_bytes ? formatFileSize(rec.file_size_bytes) : '';
            const date = rec.started_at ? new Date(rec.started_at).toLocaleDateString() : '';

            // Replace source tag (e.g., [FREE]) with duration (e.g., [1h30m])
            const displayName = replaceSourceTagWithDuration(rec.name, rec.duration_seconds);
            const details = [size, date].filter(Boolean).join(' | ');
            const streamUrl = buildRecordingStreamUrl(config, rec.id);

            streams.push({
                url: streamUrl,
                title: `[DVR] ${displayName}${details ? ` (${details})` : ''}`
            });
        }
    } catch (error) {
        console.warn(`[DVR] Error generating DVR streams:`, (error as any)?.message || error);
    }

    return streams;
}
