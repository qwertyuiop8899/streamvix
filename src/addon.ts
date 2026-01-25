import { addonBuilder, getRouter, Manifest, Stream } from "stremio-addon-sdk";
import { getStreamContent, VixCloudStreamInfo, ExtractorConfig } from "./extractor";
import { mapLegacyProviderName, buildUnifiedStreamName, providerLabel } from './utils/unifiedNames';
import * as fs from 'fs';
import { landingTemplate } from './landingPage';
import * as path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import { AnimeUnityProvider } from './providers/animeunity-provider';
import { AnimeWorldProvider } from './providers/animeworld-provider';
import { KitsuProvider } from './providers/kitsu';
import { formatMediaFlowUrl } from './utils/mediaflow';
import { mergeDynamic, loadDynamicChannels, purgeOldDynamicEvents, invalidateDynamicChannels, getDynamicFilePath, getDynamicFileStats } from './utils/dynamicChannels';
// --- Lightweight declarations to avoid TS complaints if @types/node non installati ---
// (Non sostituiscono l'uso consigliato di @types/node, ma evitano errori bloccanti.) 
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const __dirname: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const process: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Buffer: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare function require(name: string): any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const global: any;
import { AnimeUnityConfig } from './types/animeunity';
import { EPGManager } from './utils/epg';
import { execFile, spawn } from 'child_process';
import * as crypto from 'crypto';
import * as util from 'util';
import { fetchPage } from './providers/flaresolverr';
// Live gdplayer runtime resolver (for tagging)
import { resolveGdplayerForChannel, inferGdplayerSlug } from './extractors/gdplayerRuntime';
// Amstaff updater
// import { startAmstaffScheduler, updateAmstaffChannels } from './utils/amstaffUpdater';
// RM updater (MPD2)
import { startRmScheduler, updateRmChannels } from './utils/rmUpdater';

// ThisNot updater
// ThisNot updater
import { startThisNotUpdater, updateThisNotChannels } from './utils/thisnotChannels';
import { startSportzxScheduler, getSportzxChannels } from './utils/sportzxUpdater';
import { startSports99Scheduler, getSports99Channels } from './utils/sports99Updater';
// import { startMpdzScheduler, updateMpdzChannels } from './utils/mpdzUpdater';
import { startMpdxScheduler, updateMpdxChannels } from './utils/mpdxUpdater';
// import { startZEventiScheduler, updateZEventiChannels } from './utils/zEventiUpdater';
import { getGuardoserieStreams } from './providers/guardoserie';
import { getGuardaflixStreams } from './providers/guardaflix';
import { getTrailerStreams, isTrailerProviderAvailable } from './providers/trailerProvider';
// EasyProxy DVR integration
import { getDvrStreamsForChannel, getDvrConfig, buildDvrRecordEntry } from './utils/easyproxyDvr';

// ================= TYPES & INTERFACES =================
interface AddonConfig {
    tmdbApiKey?: string;
    mediaFlowProxyUrl?: string;
    mediaFlowProxyPassword?: string;
    enableMpd?: boolean;
    animeunityEnabled?: boolean;
    animesaturnEnabled?: boolean;
    animeworldEnabled?: boolean;
    guardaserieEnabled?: boolean;
    guardoserieEnabled?: boolean;
    guardaflixEnabled?: boolean;
    guardahdEnabled?: boolean;
    eurostreamingEnabled?: boolean;
    loonexEnabled?: boolean;
    toonitaliaEnabled?: boolean;
    disableLiveTv?: boolean;
    trailerEnabled?: boolean;
    disableVixsrc?: boolean;
    tvtapProxyEnabled?: boolean;
    vavooNoMfpEnabled?: boolean;
    // DVR setting (uses mediaFlowProxyUrl for EasyProxy)
    dvrEnabled?: boolean;
}

function debugLog(...args: any[]) { try { console.log('[DEBUG]', ...args); } catch { } }

const VAVOO_DEBUG: boolean = (() => {
    try {
        const env = (process && process.env) ? process.env : {} as any;
        const norm = (v?: string) => (v || '').toString().trim().toLowerCase();
        const v1 = norm(env.VAVOO_DEBUG); const v2 = norm(env.DEBUG_VAVOO);
        if (v1) return !(v1 === '0' || v1 === 'false' || v1 === 'off');
        if (v2) return !(v2 === '0' || v2 === 'false' || v2 === 'off');
        return true;
    } catch { return true; }
})();
function vdbg(...args: any[]) { if (!VAVOO_DEBUG) return; try { console.log('[VAVOO-DEBUG]', ...args); } catch { } }

const VAVOO_FORCE_SERVER_IP: boolean = (() => {
    try {
        const env = (process && process.env) ? process.env : {} as any;
        const norm = (v?: string) => (v || '').toString().trim().toLowerCase();
        const v1 = norm(env.VAVOO_FORCE_SERVER_IP); const v2 = norm(env.VAVOO_USE_SERVER_IP);
        if (v1) return !(v1 === '0' || v1 === 'false' || v1 === 'off');
        if (v2) return !(v2 === '0' || v2 === 'false' || v2 === 'off');
        return true;
    } catch { return true; }
})();
const VAVOO_SET_IPLOCATION_ONLY: boolean = (() => { try { const v = (process?.env?.VAVOO_SET_IPLOCATION_ONLY || '').toLowerCase(); if (!v) return true; return !(v === '0' || v === 'false' || v === 'off'); } catch { return false; } })();
const VAVOO_LOG_SIG_FULL: boolean = (() => { try { const v = (process?.env?.VAVOO_LOG_SIG_FULL || '').toLowerCase(); if (['0', 'false', 'off'].includes(v)) return false; if (['1', 'true', 'on'].includes(v)) return true; return true; } catch { return true; } })();
const VAVOO_WORKER_URLS = (process.env.VAVOO_WORKER_URL || '').split(',').map((u: string) => u.trim()).filter(Boolean);
function maskSig(sig: string, keepStart = 12, keepEnd = 6): string { try { if (!sig) return ''; const len = sig.length; const head = sig.slice(0, Math.min(keepStart, len)); const tail = len > keepStart ? sig.slice(Math.max(len - keepEnd, keepStart)) : ''; const hidden = Math.max(0, len - head.length - tail.length); const mask = hidden > 0 ? '*'.repeat(Math.min(hidden, 32)) + (hidden > 32 ? `(+${hidden - 32})` : '') : ''; return `${head}${mask}${tail}`; } catch { return ''; } }

function getClientIpFromReq(req: any): string | null {
    try {
        if (!req) return null;
        const hdr = (req.headers || {}) as Record<string, string | string[]>;
        const asStr = (v?: string | string[]) => Array.isArray(v) ? v[0] : (v || '');
        const parseIp = (v?: string) => {
            if (!v) return '';
            let s = v.trim();
            // Forwarded: for="ip:port" or for=ip
            s = s.replace(/^"|"$/g, '');
            // Remove brackets for IPv6
            s = s.replace(/^\[|\]$/g, '');
            // Split possible comma list, take raw first element for further processing outside
            return s;
        };
        const stripPort = (ip: string) => {
            // If IPv4 with :port
            if (ip.includes('.') && ip.includes(':')) return ip.split(':')[0];
            // If IPv6 with :port
            if (ip.includes(':') && ip.lastIndexOf(':') > 1 && ip.indexOf(']') === -1) {
                // best-effort: keep as-is for IPv6 (ports uncommon in headers)
                return ip;
            }
            return ip;
        };
        const isPrivate = (ip: string) => {
            const x = ip.toLowerCase();
            if (!x) return true;
            // IPv6 loopback / unique-local / link-local
            if (x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80')) return true;
            // Remove brackets/port
            const y = stripPort(x.replace(/^\[|\]$/g, ''));
            // IPv4 private/reserved ranges
            const m = y.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
            if (!m) return false;
            const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
            if (a === 10) return true; // 10.0.0.0/8
            if (a === 127) return true; // loopback
            if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
            if (a === 192 && b === 168) return true; // 192.168.0.0/16
            if (a === 169 && b === 254) return true; // link-local
            return false;
        };
        const pickFirstPublic = (list: string[]): string | null => {
            for (const raw of list) {
                const ip = stripPort(raw.replace(/^\[|\]$/g, ''));
                if (ip && !isPrivate(ip)) return ip;
            }
            return list.length ? stripPort(list[0].replace(/^\[|\]$/g, '')) : null;
        };

        // 1) X-Forwarded-For: prefer first public entry
        const xffRaw = asStr(hdr['x-forwarded-for']);
        if (xffRaw) {
            const parts = xffRaw.split(',').map(s => parseIp(s)).map(s => s.trim()).filter(Boolean);
            const chosen = pickFirstPublic(parts);
            if (chosen) { vdbg('IP pick via XFF', { chain: parts, chosen }); return chosen; }
        }
        // 2) True-Client-IP / CF-Connecting-IP / X-Real-IP / X-Client-IP
        const tci = stripPort(parseIp(asStr(hdr['true-client-ip'])));
        if (tci && !isPrivate(tci)) { vdbg('IP pick via True-Client-IP', { tci }); return tci; }
        const cfc = stripPort(parseIp(asStr(hdr['cf-connecting-ip'])));
        if (cfc && !isPrivate(cfc)) { vdbg('IP pick via CF-Connecting-IP', { cfc }); return cfc; }
        const xr = stripPort(parseIp(asStr(hdr['x-real-ip'])));
        if (xr && !isPrivate(xr)) { vdbg('IP pick via X-Real-IP', { xr }); return xr; }
        const xci = stripPort(parseIp(asStr(hdr['x-client-ip'])));
        if (xci && !isPrivate(xci)) { vdbg('IP pick via X-Client-IP', { xci }); return xci; }
        // 3) Forwarded: for=
        const fwd = asStr(hdr['forwarded']);
        if (fwd) {
            const m = fwd.match(/for=([^;]+)/i);
            if (m && m[1]) {
                const candidate = stripPort(parseIp(m[1]));
                if (candidate && !isPrivate(candidate)) { vdbg('IP pick via Forwarded', { candidate }); return candidate; }
            }
        }
        // 4) Express provided (requires trust proxy to be set elsewhere)
        const ips = Array.isArray((req as any).ips) ? (req as any).ips : [];
        if (ips.length) {
            const chosen = pickFirstPublic(ips);
            if (chosen) { vdbg('IP pick via req.ips', { ips, chosen }); return chosen; }
        }
        const ra = (req as any).ip || req.socket?.remoteAddress || req.connection?.remoteAddress;
        if (ra) {
            const v = stripPort(String(ra));
            vdbg('IP pick via remoteAddress/ip (fallback)', { v });
            return v.replace(/^\[|\]$/g, '');
        }
    } catch (e) { try { vdbg('IP detect error', String(e)); } catch { } }
    return null;
}

async function resolveVavooCleanUrl(vavooPlayUrl: string, clientIp: string | null): Promise<{ url: string; headers: Record<string, string> } | null> {
    try {
        if (!vavooPlayUrl || !vavooPlayUrl.includes('vavoo.to')) return null;
        // No cache: always resolve per request using the requester IP
        const startedAt = Date.now();
        vdbg('Clean resolve START', { url: vavooPlayUrl.substring(0, 120), ip: clientIp || '(none)' });

        const controller = new AbortController();
        const to = setTimeout(() => {
            vdbg('Ping timeout -> aborting request');
            controller.abort();
        }, 12000);
        if (VAVOO_WORKER_URLS.length > 0) {
            try {
                const selectedWorker = VAVOO_WORKER_URLS[Math.floor(Math.random() * VAVOO_WORKER_URLS.length)];
                vdbg('Resolving via Cloudflare Worker...', { worker: selectedWorker, url: (vavooPlayUrl || '').substring(0, 80) });
                const workerReqUrl = `${selectedWorker.replace(/\/$/, '')}/manifest.m3u8?url=${encodeURIComponent(vavooPlayUrl)}`;
                const workerHeaders: Record<string, string> = {};
                if (clientIp) workerHeaders['X-Forwarded-For'] = clientIp;

                const workerRes = await fetch(workerReqUrl, {
                    method: 'GET',
                    headers: workerHeaders,
                    redirect: 'manual'
                } as any);

                let resolvedUrl: string | null = null;
                if (workerRes.status === 302 || workerRes.status === 301) {
                    resolvedUrl = workerRes.headers.get('Location');
                } else if (workerRes.ok) {
                    const j: any = await workerRes.json().catch(() => ({}));
                    resolvedUrl = j.url || null;
                }

                if (resolvedUrl) {
                    vdbg('Worker resolve SUCCESS', { resolved: resolvedUrl.substring(0, 100), worker: selectedWorker });
                    return { url: resolvedUrl, headers: { 'User-Agent': DEFAULT_VAVOO_UA, 'Referer': 'https://vavoo.to/' } };
                }
                vdbg('Worker resolve failed to return URL', { status: workerRes.status, worker: selectedWorker });
            } catch (e) {
                vdbg('Worker resolve EXCEPTION', (e as any)?.message);
            }
            vdbg('Worker failed or not working, falling back to internal resolution...');
        }

        const pingBody = {
            token: '',
            reason: 'app-blur',
            locale: 'de',
            theme: 'dark',
            metadata: {
                version: { package: 'tv.vavoo.app', binary: '3.1.21', js: '3.1.21' }
            },
            ipLocation: (clientIp && (!VAVOO_FORCE_SERVER_IP || VAVOO_SET_IPLOCATION_ONLY)) ? clientIp : '',
            playerActive: false,
            playDuration: 0,
            devMode: false,
            hasAddon: true,
            castConnected: false,
            package: 'tv.vavoo.app',
            version: '3.1.21',
            process: 'app',
            firstAppStart: Date.now(),
            lastAppStart: Date.now(),
            adblockEnabled: true,
            proxy: { supported: ['ss', 'openvpn'], engine: 'ss', ssVersion: 1, enabled: true, autoServer: true, id: 'de-fra' },
            iap: { supported: false }
        } as any;
        const pingHeaders: Record<string, string> = { 'user-agent': 'okhttp/4.11.0', 'accept': 'application/json', 'content-type': 'application/json; charset=utf-8', 'accept-encoding': 'gzip' };
        if (clientIp && !VAVOO_FORCE_SERVER_IP) {
            pingHeaders['x-forwarded-for'] = clientIp;
            pingHeaders['x-real-ip'] = clientIp;
            pingHeaders['cf-connecting-ip'] = clientIp;
            // Extra standard/proxy headers to propagate client IP without tampering tokens
            pingHeaders['forwarded'] = `for=${clientIp}`; // RFC 7239
            pingHeaders['true-client-ip'] = clientIp;     // Some CDNs
            pingHeaders['x-client-ip'] = clientIp;        // Legacy
            vdbg('Ping will forward client IP', { xff: clientIp, ipLocation: pingBody.ipLocation });
        } else {
            if (clientIp && VAVOO_SET_IPLOCATION_ONLY) {
                vdbg('Ping ipLocation-only mode: set ipLocation to observed client IP, but using SERVER IP for transport (no forwarding headers).', { observedClientIp: clientIp });
            } else if (clientIp) {
                vdbg('Ping forced to use SERVER IP (no forwarding headers). Observed client IP present but NOT used.', { observedClientIp: clientIp });
            } else {
                vdbg('Ping will use SERVER IP (no client IP observed)');
            }
        }
        vdbg('Ping POST https://www.vavoo.tv/api/app/ping', { ipLocation: pingBody.ipLocation });
        const pingRes = await fetch('https://www.vavoo.tv/api/app/ping', {
            method: 'POST',
            headers: pingHeaders,
            body: JSON.stringify(pingBody),
            signal: controller.signal
        } as any);
        clearTimeout(to);
        vdbg('Ping response', { status: pingRes.status, ok: pingRes.ok, tookMs: Date.now() - startedAt });
        if (!pingRes.ok) {
            let text = '';
            try { text = await pingRes.text(); } catch { }
            vdbg('Ping NOT OK, body snippet:', text.substring(0, 300));
            return null;
        }
        const pingJson = await pingRes.json();
        let addonSig = pingJson?.addonSig as string;
        if (!addonSig) {
            vdbg('Ping OK but addonSig missing. Payload keys:', Object.keys(pingJson || {}));
            return null;
        }
        vdbg('Ping OK, addonSig len:', String(addonSig).length);
        // Show signature in logs (full by default unless disabled)
        const sigPreview = VAVOO_LOG_SIG_FULL ? String(addonSig) : maskSig(String(addonSig));
        vdbg('Ping OK, addonSig preview:', sigPreview);
        // Decode and REWRITE addonSig: replace ips with client IP, then re-encode (per user request)
        try {
            const decoded = Buffer.from(String(addonSig), 'base64').toString('utf8');
            vdbg('addonSig base64 decoded (truncated):', decoded.substring(0, 500));
            let sigObj: any = null;
            try { sigObj = JSON.parse(decoded); } catch { }
            if (sigObj) {
                let dataObj: any = {};
                try { dataObj = JSON.parse(sigObj?.data || '{}'); } catch { }
                const currentIps = Array.isArray(dataObj.ips) ? dataObj.ips : [];
                vdbg('addonSig.data ips (before):', currentIps);
                if (clientIp) {
                    // Rewrite IPs to prioritize the observed client IP
                    const newIps = [clientIp, ...currentIps.filter((x: any) => x && x !== clientIp)];
                    dataObj.ips = newIps;
                    if (typeof dataObj.ip === 'string') dataObj.ip = clientIp;
                    try {
                        sigObj.data = JSON.stringify(dataObj);
                        const reencoded = Buffer.from(JSON.stringify(sigObj), 'utf8').toString('base64');
                        vdbg('addonSig REWRITTEN with client IP', { oldLen: String(addonSig).length, newLen: String(reencoded).length });
                        vdbg('addonSig.data ips (after):', newIps);
                        addonSig = reencoded;
                    } catch (e) {
                        vdbg('addonSig rewrite failed, will use original signature', String(e));
                    }
                } else {
                    vdbg('No client IP observed, addonSig not rewritten');
                }
            }
        } catch { }

        const controller2 = new AbortController();
        const to2 = setTimeout(() => {
            vdbg('Resolve timeout -> aborting request');
            controller2.abort();
        }, 12000);
        const resolveHeaders: Record<string, string> = { 'user-agent': 'MediaHubMX/2', 'accept': 'application/json', 'content-type': 'application/json; charset=utf-8', 'accept-encoding': 'gzip', 'mediahubmx-signature': addonSig };
        if (clientIp && !VAVOO_FORCE_SERVER_IP) {
            resolveHeaders['x-forwarded-for'] = clientIp;
            resolveHeaders['x-real-ip'] = clientIp;
            resolveHeaders['cf-connecting-ip'] = clientIp;
            // Extra standard/proxy headers to propagate client IP without tampering tokens
            resolveHeaders['forwarded'] = `for=${clientIp}`; // RFC 7239
            resolveHeaders['true-client-ip'] = clientIp;     // Some CDNs
            resolveHeaders['x-client-ip'] = clientIp;        // Legacy
            vdbg('Resolve will forward client IP', { xff: clientIp, addonSigLen: String(addonSig).length });
        } else {
            if (clientIp) {
                vdbg('Resolve forced to use SERVER IP (no forwarding headers added). Observed client IP present but NOT used.', { addonSigLen: String(addonSig).length, observedClientIp: clientIp });
            } else {
                vdbg('Resolve will use SERVER IP (no client IP observed)', { addonSigLen: String(addonSig).length });
            }
        }
        // Log the signature being sent to resolve (masked by default)
        vdbg('Resolve using signature:', VAVOO_LOG_SIG_FULL ? String(addonSig) : maskSig(String(addonSig)));
        vdbg('Resolve POST https://vavoo.to/mediahubmx-resolve.json', { url: vavooPlayUrl.substring(0, 120), headers: Object.keys(resolveHeaders) });
        const resolveRes = await fetch('https://vavoo.to/mediahubmx-resolve.json', {
            method: 'POST',
            headers: resolveHeaders,
            body: JSON.stringify({ language: 'de', region: 'AT', url: vavooPlayUrl, clientVersion: '3.1.21' }),
            signal: controller2.signal
        } as any);
        clearTimeout(to2);
        vdbg('Resolve response', { status: resolveRes.status, ok: resolveRes.ok, tookMs: Date.now() - startedAt });
        if (!resolveRes.ok) {
            let text = '';
            try { text = await resolveRes.text(); } catch { }
            vdbg('Resolve NOT OK, body snippet:', text.substring(0, 300));
            return null;
        }
        const resolveJson = await resolveRes.json();
        let resolved: string | null = null;
        if (Array.isArray(resolveJson) && resolveJson.length && resolveJson[0]?.url) resolved = String(resolveJson[0].url);
        else if (resolveJson && typeof resolveJson === 'object' && resolveJson.url) resolved = String(resolveJson.url);
        if (!resolved) {
            vdbg('Resolve OK but no url field in JSON. Shape:', Array.isArray(resolveJson) ? 'array' : typeof resolveJson);
            return null;
        }
        vdbg('Clean resolve SUCCESS', { url: resolved.substring(0, 200) });
        return { url: resolved, headers: { 'User-Agent': DEFAULT_VAVOO_UA, 'Referer': 'https://vavoo.to/' } };
    } catch (e) {
        const msg = (e as any)?.message || String(e);
        vdbg('Clean resolve ERROR:', msg);
        console.error('[VAVOO] Clean resolve failed:', msg);
        return null;
    }
}

// Global runtime configuration cache (was referenced below)
const configCache: AddonConfig = {};

// === CACHE: Per-request Vavoo clean link (per client_ip + link) ===
const vavooCleanCache = new Map<string, { url: string; ts: number }>();
const VAVOO_CLEAN_TTL_MS = 10 * 60 * 1000; // 10 minuti

// Insert restored clean implementations (moved below to avoid duplication)

const DEFAULT_VAVOO_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';

// Promisify execFile for reuse
const execFilePromise = util.promisify(execFile);

// === CACHE: Dynamic event stream extraction (per d.url) ===
// Key: `${mfpUrl}|${mfpPsw}|${originalDUrl}` -> { finalUrl, ts }
const dynamicStreamCache = new Map<string, { finalUrl: string; ts: number }>();
const DYNAMIC_STREAM_TTL_MS = 5 * 60 * 1000; // 5 minuti

async function resolveDynamicEventUrl(dUrl: string, providerTitle: string, mfpUrl?: string, mfpPsw?: string): Promise<{ url: string; title: string }> {
    if (!mfpUrl) return { url: dUrl, title: providerTitle };
    // Normalizza mfpUrl per evitare doppio slash
    const mfpBase = mfpUrl.replace(/\/+$/, '');
    const cacheKey = `${mfpBase}|${mfpPsw || ''}|${dUrl}`;
    const now = Date.now();
    const cached = dynamicStreamCache.get(cacheKey);
    if (cached && (now - cached.ts) < DYNAMIC_STREAM_TTL_MS)
        return { url: cached.finalUrl, title: providerTitle };
    const passwordParam = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
    const extractorUrl = `${mfpBase}/extractor/video?host=DLHD&redirect_stream=false${passwordParam}&d=${encodeURIComponent(dUrl)}`;
    try {
        const res = await fetch(extractorUrl);
        if (res.ok) {
            const data = await res.json();
            let finalUrl = data.mediaflow_proxy_url || `${mfpBase}/proxy/hls/manifest.m3u8`;
            if (data.query_params) {
                const params = new URLSearchParams();
                for (const [k, v] of Object.entries(data.query_params)) {
                    if (v !== null) params.append(k, String(v));
                }
                finalUrl += (finalUrl.includes('?') ? '&' : '?') + params.toString();
            }
            if (data.destination_url) finalUrl += (finalUrl.includes('?') ? '&' : '?') + 'd=' + encodeURIComponent(data.destination_url);
            if (data.request_headers) {
                for (const [hk, hv] of Object.entries(data.request_headers)) {
                    if (hv !== null) finalUrl += '&h_' + hk + '=' + encodeURIComponent(String(hv));
                }
            }
            dynamicStreamCache.set(cacheKey, { finalUrl, ts: now });
            return { url: finalUrl, title: providerTitle };
        } else {
            dynamicStreamCache.set(cacheKey, { finalUrl: dUrl, ts: now });
            return { url: dUrl, title: providerTitle };
        }
    } catch {
        dynamicStreamCache.set(cacheKey, { finalUrl: dUrl, ts: now });
        return { url: dUrl, title: providerTitle };
    }
}

// Placeholder helper for categories; implement real logic later or ensure existing util present
function getChannelCategories(channel: any): string[] {
    if (!channel) return [];
    // Gestione array
    if (Array.isArray(channel.category)) return channel.category.map((c: any) => String(c).toLowerCase());
    if (Array.isArray(channel.categories)) return channel.categories.map((c: any) => String(c).toLowerCase());
    // Gestione stringa singola
    if (typeof channel.category === 'string' && channel.category.trim() !== '') return [channel.category.toLowerCase()];
    if (typeof channel.categories === 'string' && channel.categories.trim() !== '') return [channel.categories.toLowerCase()];
    return [];
}

// Funzioni utility per decodifica base64
function decodeBase64(str: string): string {
    return Buffer.from(str, 'base64').toString('utf8');
}

// Funzione per decodificare URL statici (sempre in base64)
function decodeStaticUrl(url: string): string {
    if (!url) return url;
    console.log(`🔧 [Base64] Decodifica URL (sempre base64): ${url.substring(0, 50)}...`);
    try {
        // Assicura padding corretto (lunghezza multipla di 4)
        let paddedUrl = url;
        while (paddedUrl.length % 4 !== 0) paddedUrl += '=';
        const decoded = decodeBase64(paddedUrl);
        console.log(`✅ [Base64] URL decodificato: ${decoded}`);
        return decoded;
    } catch (error) {
        console.error(`❌ [Base64] Errore nella decodifica: ${error}`);
        console.log(`🔧 [Base64] Ritorno URL originale per errore`);
        return url;
    }
}

// ===== STREAM PRIORITY ORDERING SYSTEM =====
/**
 * Calcola la priorità di uno stream basandosi su titolo e URL.
 * Priorità più BASSA = mostrato prima (1 = primo, 13 = ultimo)
 *
 * Ordine desiderato:
 * 1. Vavoo clean (senza MFP)
 * 2. D_CF (🇮🇹🔄 - CF proxy italiani)
 * 3. Freeshot
 * 4. [P🐽D]
 * 5. Daddy con 🇮🇹 (estratti nei primi 10)
 * 6. Vavoo MFP
 * 7. GDplayer [🌐Gd]
 * 8. RBTV
 * 9. SPON
 * 10. SPSO
 * 11. STRD
 * 12. Altri daddy FAST dynamic (non italiani, estratti)
 * 13. [Player Esterno] daddy leftover (oltre CAP, con MFP wrap)
 */
function getStreamPriority(stream: { url: string; title: string }): number {
    const title = (stream.title || '').toString();
    const url = (stream.url || '').toString();

    // 1. Vavoo clean (senza wrapper MFP, contiene "Vavoo" ma NON contiene mfp/proxy nel URL)
    if (/vavoo/i.test(title) && !/mfp|mediaflow|proxy.*stream/i.test(url)) return 1;

    // 2. D_CF (🇮🇹🔄 con dlhd.m3u8 o proxy.stremio.dpdns.org)
    if (/🇮🇹🔄/.test(title) && (/\/dlhd\.m3u8\?src=/i.test(url) || /proxy\.stremio\.dpdns\.org/i.test(url))) return 2;

    // 3. Freeshot (cerca [🏟 Free] o freeshot)
    if (/freeshot|\[🏟\s*Free\]|🏟.*free/i.test(title)) return 3;

    // 4. staticUrlMpd (🎬MPD - canali statici con MPD iniettati dinamicamente)
    if (/\[🎬MPD\]/i.test(title)) return 4;

    // 4.5. staticUrlMpd2 (🎬MPD2 - seconda sorgente RM)
    if (/\[🎬MPD2\]/i.test(title)) return 4.5;

    // 4.6. staticUrlMpdz (🎬MPDz -  source)
    if (/\[🎬MPDz\]/i.test(title)) return 4.6;

    // 4.7. staticUrlMpdx (🎬MPDx -  source)
    if (/\[🎬MPDx\]/i.test(title)) return 4.7;

    // 6. Daddy con 🇮🇹 (estratti, wrappati MFP o diretti ma NON 🔄 e NON [Player Esterno])
    if (/^🇮🇹(?!🔄)/.test(title) && !/\[Player Esterno\]/i.test(title) && /dlhd\.dad|mfp.*dlhd/i.test(url)) return 6;

    // 7. Vavoo MFP (contiene "Vavoo" E contiene mfp/mediaflow nel URL)
    if (/vavoo/i.test(title) && /mfp|mediaflow|proxy.*stream/i.test(url)) return 7;

    // 8. GDplayer
    if (/\[🌐Gd\]|\bGd\b|gdplayer/i.test(title)) return 8;

    // 9.5. SPON
    if (/\[?SPON\]?/i.test(title)) return 9.5;

    // 9.8. SportzX [SPZX]
    if (/\[SPZX\]/i.test(title)) return 9.8;

    // 9.9. Sports99 [SP99]
    if (/\[SP99\]/i.test(title)) return 9.9;

    // 13. Altri daddy FAST dynamic (estratti ma non italiani, non leftover)
    if (!/\[Player Esterno\]/i.test(title) && /dlhd\.dad|mfp.*dlhd/i.test(url)) return 13;

    // 14. [Player Esterno] daddy leftover (oltre CAP)
    if (/\[Player Esterno\]/i.test(title) && /dlhd\.dad|mfp.*dlhd/i.test(url)) return 14;

    // Default: altri stream non categorizzati (mettiamo dopo i daddy ma prima dei leftover)
    return 13.5;
}

/**
 * Ordina un array di stream secondo le priorità definite.
 * Modifica l'array in-place.
 */
function sortStreamsByPriority(streams: { url?: string; title?: string }[]): void {
    streams.sort((a, b) => {
        const streamA = { url: a.url || '', title: a.title || '' };
        const streamB = { url: b.url || '', title: b.title || '' };

        // DVR category: -2 = active recording, -1 = completed, 0 = live, 1 = record entry
        const getDvrCategory = (title: string): number => {
            if (title.includes('Recording...') || title.includes('Stop & Watch')) return -2;
            if (title.includes('[DVR]') && !title.includes('REC')) return -1;
            if (title.startsWith('🔴 REC')) return 1;
            return 0; // Live stream
        };

        const catA = getDvrCategory(streamA.title);
        const catB = getDvrCategory(streamB.title);

        // Different categories - sort by category
        if (catA !== catB) {
            return catA - catB;
        }

        // Same category - use stream priority
        // For DVR "REC" entries, extract the stream title and use that for priority
        let prioStreamA = streamA;
        let prioStreamB = streamB;

        if (catA === 1) {
            // Extract stream info from "🔴 REC (4h) <stream_title>"
            const extractTitle = (t: string) => t.replace(/^🔴 REC \(\d+h\) /, '');
            prioStreamA = { url: streamA.url, title: extractTitle(streamA.title) };
            prioStreamB = { url: streamB.url, title: extractTitle(streamB.title) };
        }

        const prioA = getStreamPriority(prioStreamA);
        const prioB = getStreamPriority(prioStreamB);
        if (prioA !== prioB) return prioA - prioB;

        // Same priority - alphabetical
        return prioStreamA.title.localeCompare(prioStreamB.title);
    });
}

/**
 * Determina il nome dello stream (etichetta esterna) in base alla presenza di MFP nell'URL.
 * - Con MFP (mediaflow proxy): 'Live 🔴'
 * - Senza MFP (clean/direct): 'Live 🔓'
 */
function getStreamName(url: string): string {
    if (!url) return 'Live 🔴';
    // Rileva se l'URL usa MFP/mediaflow proxy
    const hasMfp = /mfp|mediaflow|proxy\/(?:stream|hls|mpd)/i.test(url);
    return hasMfp ? 'Live 🔴' : 'Live 🔓';
}

// ===== CF DLHD PROXY HELPERS (supporta formati ?url=https://dlhd.dad/watch.php?id=123 e ?id=123) =====
function extractDlhdIdFromCf(u: string): string | null {
    if (!u) return null;
    // Normalizza senza parametri extra
    try {
        const qIndex = u.indexOf('?');
        if (qIndex === -1) return null;
        const query = u.substring(qIndex + 1);
        const params = new URLSearchParams(query);

        // Nuovo formato: /dlhd.m3u8?src=https://dlhd.dad/watch.php?id=123
        if (params.has('src')) {
            const src = decodeURIComponent(params.get('src') || '');
            const m = src.match(/watch\.php\?id=(\d+)/i);
            if (m) return m[1];
        }

        // Caso corto: ...manifest.m3u8?id=123
        if (params.has('id')) {
            const id = params.get('id') || '';
            return /^\d+$/.test(id) ? id : null;
        }

        // Caso legacy: ...manifest.m3u8?url=https://dlhd.dad/watch.php?id=123
        if (params.has('url')) {
            const inner = params.get('url') || '';
            const m = inner.match(/watch\.php\?id=(\d+)/i);
            if (m) return m[1];
        }
    } catch { }
    // Fallback regex unica
    const m2 = u.match(/manifest\.m3u8\?(?:[^\s]*?id=|[^\s]*?watch\.php\?id=)(\d+)/i);
    return m2 ? m2[1] : null;
}

function buildCfProxyFromId(id: string, addonBaseUrl?: string): string {
    // Se abbiamo addonBaseUrl, usa il nuovo formato con endpoint /dlhd.m3u8
    if (addonBaseUrl) {
        const daddyUrl = `https://dlhd.dad/watch.php?id=${id}`;
        const encodedSrc = encodeURIComponent(daddyUrl);
        return `${addonBaseUrl.replace(/\/$/, '')}/dlhd.m3u8?src=${encodedSrc}`;
    }
    // Fallback al formato legacy
    return `https://proxy.stremio.dpdns.org/manifest.m3u8?id=${id}`;
}

function isCfDlhdProxy(u: string): boolean { return extractDlhdIdFromCf(u) !== null; }

// Helper: compute Europe/Rome interpretation for eventStart even if timezone is missing
// ================= MANIFEST BASE (restored) =================
const baseManifest: Manifest = {
    id: "org.stremio.vixcloud",
    version: "10.0.23",
    name: "StreamViX | Elfhosted",
    description: "StreamViX addon con StreamingCommunity, Guardaserie, Altadefinizione, AnimeUnity, AnimeSaturn, AnimeWorld, Eurostreaming, TV ed Eventi Live",
    background: "https://raw.githubusercontent.com/qwertyuiop8899/StreamViX/refs/heads/main/public/backround.png",
    types: ["movie", "series", "tv", "anime"],
    idPrefixes: ["tt", "kitsu", "tv", "mal", "tmdb", "dvr"],
    catalogs: [
        {
            id: "streamvix_tv",
            type: "tv",
            name: "StreamViX TV",
            extra: [
                {
                    name: "genre",
                    options: [
                        "RAI",
                        "Mediaset",
                        "Sky",
                        "Sport",
                        "Cinema",
                        "Documentari",
                        "Discovery",
                        "News",
                        "Generali",
                        "Bambini",
                        "Pluto"
                    ]
                },
                { name: "genre", isRequired: false },
                { name: "search", isRequired: false }
            ]
        },
        {
            id: "streamvix_live",
            type: "tv",
            name: "StreamViX Live",
            extra: [
                {
                    name: "genre",
                    options: [
                        "X-Eventi",
                        // "Z-Eventi",
                        "THISNOT",
                        "SportzX",
                        "Sports99",
                        "Serie A",
                        "Serie B",
                        "Serie C",
                        "Coppe",
                        "Soccer",
                        "Premier League",
                        "Liga",
                        "Bundesliga",
                        "Ligue 1",
                        "Tennis",
                        "F1",
                        "MotoGp",
                        "Basket",
                        "Volleyball",
                        "Ice Hockey",
                        "Wrestling",
                        "Boxing",
                        "Darts",
                        "Baseball",
                        "NFL",
                        "PPV"
                    ]
                },
                { name: "genre", isRequired: false },
                { name: "search", isRequired: false }
            ]
        },
        {
            id: "streamvix_dvr",
            type: "tv",
            name: "StreamViX DVR",
            extra: [
                {
                    name: "genre",
                    isRequired: false,
                    options: ["All Recordings"]
                },
                { name: "search", isRequired: false }
            ]
        }
    ],
    resources: ["stream", "catalog", "meta"],
    behaviorHints: { configurable: true },
    config: [
        { key: "tmdbApiKey", title: "TMDB API Key", type: "text" },
        { key: "mediaFlowProxyUrl", title: "☂️ Proxy URL", type: "text" },
        { key: "mediaFlowProxyPassword", title: "Proxy Password (opzionale)", type: "text" },
        { key: "dvrEnabled", title: "DVR (EasyProxy only) 📹", type: "checkbox" },
        // { key: "enableMpd", title: "Enable MPD Streams", type: "checkbox" },
        { key: "disableVixsrc", title: "Disable StreamingCommunity", type: "checkbox" },
        { key: "vixDirect", title: "StreamingCommunity Direct mode", type: "checkbox" },
        { key: "vixDirectFhd", title: "StreamingCommunity Direct FHD mode", type: "checkbox" },
        { key: "vixProxy", title: "StreamingCommunity Proxy mode", type: "checkbox" },
        { key: "vixProxyFhd", title: "StreamingCommunity Proxy FHD mode", type: "checkbox" },
        { key: "disableLiveTv", title: "Live TV 📺 [Molti canali hanno bisogno di MFP]", type: "checkbox" },
        { key: "trailerEnabled", title: "🎬▶️ Trailer", type: "checkbox", default: "checked" },
        { key: "animeunityEnabled", title: "Enable AnimeUnity", type: "checkbox" },
        { key: "animeunityAuto", title: "AnimeUnity AUTO mode", type: "checkbox" },
        { key: "animeunityFhd", title: "AnimeUnity FHD mode", type: "checkbox" },
        { key: "animesaturnEnabled", title: "Enable AnimeSaturn", type: "checkbox" },
        { key: "animeworldEnabled", title: "Enable AnimeWorld", type: "checkbox" },
        { key: "guardaserieEnabled", title: "Enable GuardaSerie", type: "checkbox" },
        { key: "guardoserieEnabled", title: "Enable Guardoserie", type: "checkbox" },
        { key: "guardaflixEnabled", title: "Enable Guardaflix", type: "checkbox" },
        { key: "guardahdEnabled", title: "Enable GuardaHD", type: "checkbox" },
        { key: "eurostreamingEnabled", title: "Eurostreaming", type: "checkbox" },
        { key: "loonexEnabled", title: "Enable Loonex", type: "checkbox" },
        { key: "toonitaliaEnabled", title: "Enable ToonItalia", type: "checkbox" },
        { key: "cb01Enabled", title: "Enable CB01 Mixdrop", type: "checkbox" },
        // { key: "tvtapProxyEnabled", title: "TvTap NO MFP 🔓", type: "checkbox", default: "checked" }, // TVTAP RIMOSSO
        { key: "vavooNoMfpEnabled", title: "Vavoo NO MFP 🔓", type: "checkbox", default: false },
        // UI helper toggles (not used directly server-side but drive dynamic form logic)
        { key: "personalTmdbKey", title: "TMDB API KEY Personale", type: "checkbox" },
        { key: "mediaflowMaster", title: "MediaflowProxy", type: "checkbox" },
    ],
    stremioAddonsConfig: {
        issuer: "https://stremio-addons.net",
        signature: "eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..lq-o2JziPJNLx0ktbXf4Cg.4k4_nsv-K378IN3bdkw5AzfIMtQyhlw0v8lWwtAFNx9W0OdkP6lczmlPOYqKYQ6OA4dU6N3GicW08Wdxm78wreyU4Irtn_A_BAoVc-EGUIC-C9-N68V0J4wLvFWogSKY.OlNc0_M7cbDgDVSNBihFUQ"
    }
};

// Load custom configuration if available
function loadCustomConfig(): Manifest {
    try {
        const configPath = path.join(__dirname, '..', 'addon-config.json');

        if (fs.existsSync(configPath)) {
            const customConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

            return {
                ...baseManifest,
                id: customConfig.addonId || baseManifest.id,
                name: customConfig.addonName || baseManifest.name,
                description: customConfig.addonDescription || baseManifest.description,
                version: customConfig.addonVersion || baseManifest.version,
                logo: customConfig.addonLogo || baseManifest.logo,
                icon: customConfig.addonLogo || baseManifest.icon,
                favicon: customConfig.addonFavicon || customConfig.addonLogo || baseManifest.logo,
                background: baseManifest.background
            };
        }
    } catch (error) {
        console.error('Error loading custom configuration:', error);
    }

    return baseManifest;
}

// Funzione per parsare la configurazione dall'URL
function parseConfigFromArgs(args: any): AddonConfig {
    const config: AddonConfig = {};

    // Se non ci sono args o sono vuoti, ritorna configurazione vuota
    if (!args || args === '' || args === 'undefined' || args === 'null') {
        debugLog('No configuration provided, using defaults');
        return config;
    }

    // Se la configurazione è già un oggetto, usala direttamente
    if (typeof args === 'object' && args !== null) {
        debugLog('Configuration provided as object');
        return args;
    }

    if (typeof args === 'string') {
        debugLog(`Configuration string: ${args.substring(0, 50)}... (length: ${args.length})`);

        // PASSO 1: Prova JSON diretto
        try {
            const parsed = JSON.parse(args);
            debugLog('Configuration parsed as direct JSON');
            return parsed;
        } catch (error) {
            debugLog('Not direct JSON, trying other methods');
        }

        // PASSO 2: Gestione URL encoded
        let decodedArgs = args;
        if (args.includes('%')) {
            try {
                decodedArgs = decodeURIComponent(args);
                debugLog('URL-decoded configuration');

                // Prova JSON dopo URL decode
                try {
                    const parsed = JSON.parse(decodedArgs);
                    debugLog('Configuration parsed from URL-decoded JSON');
                    return parsed;
                } catch (innerError) {
                    debugLog('URL-decoded content is not valid JSON');
                }
            } catch (error) {
                debugLog('URL decoding failed');
            }
        }

        // PASSO 3: Gestione Base64
        if (decodedArgs.startsWith('eyJ') || /^[A-Za-z0-9+\/=]+$/.test(decodedArgs)) {
            try {
                // Fix per caratteri = che potrebbero essere URL encoded
                const base64Fixed = decodedArgs
                    .replace(/%3D/g, '=')
                    .replace(/=+$/, ''); // Rimuove eventuali = alla fine

                // Assicura che la lunghezza sia multipla di 4 aggiungendo = se necessario
                let paddedBase64 = base64Fixed;
                while (paddedBase64.length % 4 !== 0) {
                    paddedBase64 += '=';
                }

                debugLog(`Trying base64 decode: ${paddedBase64.substring(0, 20)}...`);
                const decoded = Buffer.from(paddedBase64, 'base64').toString('utf-8');
                debugLog(`Base64 decoded result: ${decoded.substring(0, 50)}...`);

                if (decoded.includes('{') && decoded.includes('}')) {
                    try {
                        const parsed = JSON.parse(decoded);
                        debugLog('Configuration parsed from Base64');
                        return parsed;
                    } catch (jsonError) {
                        debugLog('Base64 content is not valid JSON');

                        // Prova a estrarre JSON dalla stringa decodificata
                        const jsonMatch = decoded.match(/({.*})/);
                        if (jsonMatch && jsonMatch[1]) {
                            try {
                                const extractedJson = jsonMatch[1];
                                const parsed = JSON.parse(extractedJson);
                                debugLog('Extracted JSON from Base64 decoded string');
                                return parsed;
                            } catch (extractError) {
                                debugLog('Extracted JSON parsing failed');
                            }
                        }
                    }
                }
            } catch (error) {
                debugLog('Base64 decoding failed');
            }
        }

        debugLog('All parsing methods failed, using default configuration');
    }

    return config;
}

// Carica canali TV e domini da file esterni
let tvChannels: any[] = [];
let staticBaseChannels: any[] = [];
let domains: any = {};
let epgConfig: any = {};
let epgManager: EPGManager | null = null;

// ✅ DICHIARAZIONE delle variabili globali del builder
let globalBuilder: any;
let globalAddonInterface: any;
let globalRouter: any;
let lastDisableLiveTvFlag: boolean | undefined;

// === Lightweight watcher state for static tv_channels.json reload ===
let _staticFilePath: string | null = null;
let _staticFileLastMtime = 0;
let _staticFileLastHash = '';
function _computeHash(buf: Buffer): string { try { return crypto.createHash('md5').update(buf).digest('hex'); } catch { return ''; } }
function _resolveStaticPath(): string {
    if (_staticFilePath && fs.existsSync(_staticFilePath)) return _staticFilePath;
    const candidates = [
        path.join(__dirname, '..', 'config', 'tv_channels.json'),
        path.join(process.cwd(), 'config', 'tv_channels.json'),
        path.join(__dirname, 'config', 'tv_channels.json')
    ];
    for (const c of candidates) { if (fs.existsSync(c)) { _staticFilePath = c; return c; } }
    return candidates[0];
}
function _loadStaticChannelsIfChanged(force = false) {
    try {
        const p = _resolveStaticPath();
        if (!fs.existsSync(p)) return;
        const st = fs.statSync(p);
        const mtime = st.mtimeMs;
        if (!force && mtime === _staticFileLastMtime) return; // quick check
        const raw = fs.readFileSync(p);
        const h = _computeHash(raw);
        if (!force && mtime === _staticFileLastMtime && h === _staticFileLastHash) return;
        const parsed = JSON.parse(raw.toString('utf-8'));
        if (!Array.isArray(parsed)) return;
        staticBaseChannels = parsed;
        _staticFileLastMtime = mtime;
        _staticFileLastHash = h;
        // Count pdUrlF present
        let pdCount = 0; let total = parsed.length;
        for (const c of parsed) if (c && c.pdUrlF) pdCount++;
        console.log(`[TV][RELOAD] staticBaseChannels reloaded: total=${total} pdUrlF=${pdCount} mtime=${new Date(mtime).toISOString()} hash=${h.slice(0, 12)}`);
    } catch (e) {
        console.warn('[TV][RELOAD] errore reload static tv_channels:', (e as any)?.message || e);
    }
}
// WATCH UNIFICATO: controlla sia static (tv_channels.json) che dynamic (dynamic_channels.json)
//   - Intervallo configurabile con WATCH_INTERVAL_MS (fallback: TV_STATIC_WATCH_INTERVAL_MS / DYNAMIC_WATCH_INTERVAL_MS / 300000)
//   - Static: usa _loadStaticChannelsIfChanged (già fa hash/mtime e log solo se cambia)
//   - Dynamic: calcola mtime+hash e se cambia invalida+reload
(() => {
    try {
        const intervalMs = parseInt(process.env.WATCH_INTERVAL_MS || process.env.TV_STATIC_WATCH_INTERVAL_MS || process.env.DYNAMIC_WATCH_INTERVAL_MS || '300000', 10); // default 5m
        let lastDynMtime = 0; let lastDynHash = '';
        function checkDynamicOnce() {
            try {
                const p = getDynamicFilePath();
                if (!p || !fs.existsSync(p)) return;
                const st = fs.statSync(p);
                const raw = fs.readFileSync(p);
                const h = _computeHash(raw);
                if (st.mtimeMs !== lastDynMtime || h !== lastDynHash) {
                    const oldShort = lastDynHash.slice(0, 8);
                    lastDynMtime = st.mtimeMs; lastDynHash = h;
                    invalidateDynamicChannels();
                    const dyn = loadDynamicChannels(true);
                    console.log(`[WATCH][DYN] reload (changed) oldHash=${oldShort} newHash=${h.slice(0, 8)} count=${dyn.length}`);
                }
            } catch (e) {
                console.warn('[WATCH][DYN] errore controllo dynamic:', (e as any)?.message || e);
            }
        }
        function loop() {
            try {
                _loadStaticChannelsIfChanged(false);
                checkDynamicOnce();
            } finally {
                // next tick gestito da setInterval
            }
        }
        // primo giro: forziamo static + dynamic
        setTimeout(() => { _loadStaticChannelsIfChanged(true); checkDynamicOnce(); }, 1500);
        setInterval(loop, Math.max(60000, intervalMs));
        console.log(`[WATCH] unificato attivo ogni ${Math.max(60000, intervalMs)}ms (default 5m)`);
    } catch (e) {
        console.log('[WATCH] init failed', (e as any)?.message || e);
    }
})();

// (RIMOSSO) watcher dinamico separato (ora unificato sopra)
// === STREAMED playlist enrichment (RIMOSSO) ===
// === RBTV (RB77) playlist enrichment (RIMOSSO) ===
// === SPSO (SportsOnline) playlist enrichment (RIMOSSO) ===

// === PPV playlist enrichment ===
(() => {
    try {
        // Always enable PPV unless explicitly disabled
        let enableRaw = (process.env.PPV_ENABLE || '1').toString().toLowerCase();
        if (!['1', 'true', 'on', 'yes'].includes(enableRaw)) return;

        const pythonBin = process.env.PYTHON_BIN || 'python3';
        const scriptPath = path.join(__dirname, '..', 'ppv_streams.py');
        if (!fs.existsSync(scriptPath)) { console.log('[PPV][INIT] script non trovato', scriptPath); return; }

        // const intervalMs = Math.max(60000, parseInt(process.env.PPV_POLL_INTERVAL_MS || '300000', 10)); // default 5m

        function runOnce(tag: string) {
            const env: any = { ...process.env };
            const t0 = Date.now();
            const child = spawn(pythonBin, [scriptPath], { env });
            let out = ''; let err = '';
            child.stdout.on('data', d => out += d.toString());
            child.stderr.on('data', d => err += d.toString());
            child.on('close', code => {
                const ms = Date.now() - t0;
                if (out.trim()) out.split(/\r?\n/).forEach(l => console.log('[PPV][OUT]', l));
                if (err.trim()) err.split(/\r?\n/).forEach(l => console.warn('[PPV][ERR]', l));
                console.log(`[PPV][RUN] done code=${code} ms=${ms}`);
            });
        }

        // Initial run with delay
        setTimeout(() => {
            console.log('[PPV][INIT] Starting initial run...');
            runOnce('init');
        }, 10000);

        // Scheduler: Run every 5 minutes to keep LIVE/NOT LIVE status fresh
        // Since it only parses a remote M3U, it's lightweight.
        const PPV_INTERVAL = 5 * 60 * 1000; // 5 minutes
        setInterval(() => {
            console.log(`[PPV][SCHEDULER] Triggering scheduled update...`);
            runOnce('scheduled');
        }, PPV_INTERVAL);

        console.log(`[PPV][INIT] Scheduler attivo: aggiornamento ogni ${PPV_INTERVAL / 1000}s`);
    } catch (e) {
        console.log('[PPV][INIT] failed', e);
    }
})();



// (RIMOSSO) Adaptive windows: sostituito da watcher semplice costante.

// =====================================
// [P🐽D] STARTUP DIAGNOSTICS (RIMOSSO)
// =====================================

// Cache per i link Vavoo
interface VavooCache {
    timestamp: number;
    links: Map<string, string | string[]>;
    updating: boolean;
}

const vavooCache: VavooCache = {
    timestamp: 0,
    links: new Map<string, string | string[]>(),
    updating: false
};

// Path del file di cache per Vavoo
const vavaoCachePath = path.join(__dirname, '../cache/vavoo_cache.json');

// Se la cache non esiste, genera automaticamente
if (!fs.existsSync(vavaoCachePath)) {
    console.warn('⚠️ [VAVOO] Cache non trovata, provo a generarla automaticamente...');
    try {
        const { execSync } = require('child_process');
        execSync('python3 vavoo_resolver.py --build-cache', { cwd: path.join(__dirname, '..') });
        console.log('✅ [VAVOO] Cache generata automaticamente!');
    } catch (err) {
        console.error('❌ [VAVOO] Errore nella generazione automatica della cache:', err);
    }
}

// Funzione per caricare la cache Vavoo dal file
function loadVavooCache(): void {
    try {
        if (fs.existsSync(vavaoCachePath)) {
            const rawCache = fs.readFileSync(vavaoCachePath, 'utf-8');
            // RIMOSSO: console.log('🔧 [VAVOO] RAW vavoo_cache.json:', rawCache);
            const cacheData = JSON.parse(rawCache);
            vavooCache.timestamp = cacheData.timestamp || 0;
            vavooCache.links = new Map(Object.entries(cacheData.links || {}));
            console.log(`📺 Vavoo cache caricata con ${vavooCache.links.size} canali, aggiornata il: ${new Date(vavooCache.timestamp).toLocaleString()}`);
            console.log('🔧 [VAVOO] DEBUG - Cache caricata all\'avvio:', vavooCache.links.size, 'canali');
            console.log('🔧 [VAVOO] DEBUG - Path cache:', vavaoCachePath);
            // RIMOSSO: stampa dettagliata del contenuto della cache
        } else {
            console.log(`📺 File cache Vavoo non trovato, verrà creato al primo aggiornamento`);
        }
    } catch (error) {
        console.error('❌ Errore nel caricamento della cache Vavoo:', error);
    }
}

// Funzione per salvare la cache Vavoo su file
function saveVavooCache(): void {
    try {
        // Assicurati che la directory cache esista
        const cacheDir = path.dirname(vavaoCachePath);
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
        }

        const cacheData = {
            timestamp: vavooCache.timestamp,
            links: Object.fromEntries(vavooCache.links)
        };

        // Salva prima in un file temporaneo e poi rinomina per evitare file danneggiati
        const tempPath = `${vavaoCachePath}.tmp`;
        fs.writeFileSync(tempPath, JSON.stringify(cacheData, null, 2), 'utf-8');

        // Rinomina il file temporaneo nel file finale
        fs.renameSync(tempPath, vavaoCachePath);

        console.log(`📺 Vavoo cache salvata con ${vavooCache.links.size} canali, timestamp: ${new Date(vavooCache.timestamp).toLocaleString()}`);
    } catch (error) {
        console.error('❌ Errore nel salvataggio della cache Vavoo:', error);
    }
}

// Funzione per aggiornare la cache Vavoo
async function updateVavooCache(): Promise<boolean> {
    if (vavooCache.updating) {
        console.log(`📺 Aggiornamento Vavoo già in corso, skip`);
        return false;
    }

    vavooCache.updating = true;
    console.log(`📺 Avvio aggiornamento cache Vavoo...`);
    try {
        // PATCH: Prendi TUTTI i canali da Vavoo, senza filtri su tv_channels.json
        const result = await execFilePromise('python3', [
            path.join(__dirname, '../vavoo_resolver.py'),
            '--dump-channels'
        ], { timeout: 30000 });

        if (result.stdout) {
            try {
                const channels = JSON.parse(result.stdout);
                console.log(`📺 Recuperati ${channels.length} canali da Vavoo (nessun filtro)`);
                const updatedLinks = new Map<string, string>();
                for (const ch of channels) {
                    if (!ch || !ch.name || !ch.links) continue;
                    const first = Array.isArray(ch.links) ? ch.links[0] : ch.links;
                    if (first) updatedLinks.set(String(ch.name), String(first));
                }
                vavooCache.links = updatedLinks;
                vavooCache.timestamp = Date.now();
                saveVavooCache();
                console.log(`📺 Vavoo cache aggiornata: ${vavooCache.links.size} canali salvati`);
            } catch (e) {
                console.error('❌ Errore nel parsing canali Vavoo:', e);
            }
        } else {
            console.warn('⚠️ Nessun output da vavoo_resolver.py --dump-channels');
        }
        return true;
    } catch (error) {
        console.error('❌ Errore aggiornamento cache Vavoo:', error);
        return false;
    } finally {
        vavooCache.updating = false;
    }
}

const vavooAliasIndex = new Map<string, string>();

function normAlias(s: string): string {
    return (s || '')
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '') // rimuovi diacritici
        .replace(/[^a-z0-9]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function buildVavooAliasIndex(): void {
    try {
        vavooAliasIndex.clear();
        const source = Array.isArray(staticBaseChannels) && staticBaseChannels.length ? staticBaseChannels : tvChannels;
        for (const ch of (source as any[])) {
            if (!ch) continue;
            const aliases: string[] = Array.isArray(ch.vavooNames) && ch.vavooNames.length ? ch.vavooNames : (ch.name ? [ch.name] : []);
            for (const a of aliases) {
                const key = normAlias(String(a));
                if (!key) continue;
                if (!vavooAliasIndex.has(key)) vavooAliasIndex.set(key, String(a));
            }
        }
        console.log(`🧭 Vavoo alias index built: ${vavooAliasIndex.size} aliases`);
    } catch (e) {
        console.error('❌ Errore build Vavoo alias index:', e);
    }
}

function findBestAliasInTexts(texts: string[]): string | null {
    if (!texts || !texts.length || vavooAliasIndex.size === 0) return null;
    let best: { alias: string; len: number } | null = null;
    for (const raw of texts) {
        if (!raw) continue;
        const t = normAlias(String(raw));
        if (!t) continue;
        for (const [k, original] of vavooAliasIndex.entries()) {
            if (!k) continue;
            // match come parola intera o sottostringa significativa
            // costruisci regex che richiede confini di parola debole
            const pattern = new RegExp(`(?:^| )${k}(?: |$)`);
            if (pattern.test(t)) {
                const L = k.length;
                if (!best || L > best.len) best = { alias: original, len: L };
            }
        }
    }
    return best ? best.alias : null;
}

function resolveFirstVavooUrlForAlias(alias: string): string | null {
    if (!alias || !vavooCache || !vavooCache.links) return null;
    // 1) Prova varianti "Nome .<lettera>"
    try {
        const variantRegex = new RegExp(`^${alias} \\.([a-zA-Z])$`, 'i');
        for (const [key, value] of vavooCache.links.entries()) {
            if (variantRegex.test(key)) {
                const links = Array.isArray(value) ? value : [value];
                if (links.length) return String(links[0]);
            }
        }
        // 2) Prova match normalizzato sulle chiavi
        const aliasNorm = alias.toUpperCase().replace(/\s+/g, ' ').trim();
        for (const [key, value] of vavooCache.links.entries()) {
            const keyNorm = key.toUpperCase().replace(/\s+/g, ' ').trim();
            const rx = new RegExp(`^${aliasNorm} \\.([a-zA-Z])$`, 'i');
            if (rx.test(keyNorm)) {
                const links = Array.isArray(value) ? value : [value];
                if (links.length) return String(links[0]);
            }
        }
        // 3) Fallback chiave esatta
        const exact = vavooCache.links.get(alias) as any;
        if (exact) {
            const links = Array.isArray(exact) ? exact : [exact];
            if (links.length) return String(links[0]);
        }
    } catch (e) {
        console.error('[VAVOO] resolveFirstVavooUrlForAlias error:', e);
    }
    return null;
}

try {
    // Assicurati che le directory di cache esistano
    ensureCacheDirectories();

    staticBaseChannels = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/tv_channels.json'), 'utf-8'));
    tvChannels = [...staticBaseChannels];
    domains = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/domains.json'), 'utf-8'));
    epgConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/epg_config.json'), 'utf-8'));

    console.log(`✅ Loaded ${tvChannels.length} TV channels`);

    // ============ TVTAP INTEGRATION ============

    // Cache per i link TVTap
    interface TVTapCache {
        timestamp: number;
        channels: Map<string, string>;
        updating: boolean;
    }

    const tvtapCache: TVTapCache = {
        timestamp: 0,
        channels: new Map<string, string>(),
        updating: false
    };

    // Path del file di cache per TVTap
    const tvtapCachePath = path.join(__dirname, '../cache/tvtap_cache.json');

    // Funzione per caricare la cache TVTap dal file
    function loadTVTapCache(): void {
        try {
            if (fs.existsSync(tvtapCachePath)) {
                const rawCache = fs.readFileSync(tvtapCachePath, 'utf-8');
                const cacheData = JSON.parse(rawCache);
                tvtapCache.timestamp = cacheData.timestamp || 0;
                tvtapCache.channels = new Map(Object.entries(cacheData.channels || {}));
                console.log(`📺 TVTap cache caricata con ${tvtapCache.channels.size} canali, aggiornata il: ${new Date(tvtapCache.timestamp).toLocaleString()}`);
            } else {
                console.log("📺 File cache TVTap non trovato, verrà creato al primo aggiornamento");
            }
        } catch (error) {
            console.error("❌ Errore nel caricamento cache TVTap:", error);
            tvtapCache.timestamp = 0;
            tvtapCache.channels = new Map();
        }
    }

    // Funzione per aggiornare la cache TVTap
    async function updateTVTapCache(): Promise<boolean> {
        if (tvtapCache.updating) {
            console.log('🔄 TVTap cache già in aggiornamento, salto...');
            return false;
        }

        tvtapCache.updating = true;
        console.log('🔄 Aggiornamento cache TVTap...');

        try {
            const options = {
                timeout: 30000,
                env: {
                    ...process.env,
                    PYTHONPATH: '/usr/local/lib/python3.9/site-packages'
                }
            };

            const { stdout, stderr } = await execFilePromise('python3', [path.join(__dirname, '../tvtap_resolver.py'), '--build-cache'], options);

            if (stderr) {
                console.error(`[TVTap] Script stderr:`, stderr);
            }

            console.log('✅ Cache TVTap aggiornata con successo');

            // Ricarica la cache aggiornata
            loadTVTapCache();

            return true;
        } catch (error: any) {
            console.error('❌ Errore durante aggiornamento cache TVTap:', error.message || error);
            return false;
        } finally {
            tvtapCache.updating = false;
        }
    }

    // ============ END TVTAP INTEGRATION ============

    // ✅ INIZIALIZZA IL ROUTER GLOBALE SUBITO DOPO IL CARICAMENTO
    console.log('🔧 Initializing global router after loading TV channels...');
    globalBuilder = createBuilder(configCache);
    globalAddonInterface = globalBuilder.getInterface();
    globalRouter = getRouter(globalAddonInterface);
    console.log('✅ Global router initialized successfully');

    // Carica la cache Vavoo
    loadVavooCache();
    // Costruisci indice alias Vavoo
    buildVavooAliasIndex();

    // Dopo il caricamento della cache Vavoo
    if (vavooCache && vavooCache.links) {
        try {
            console.log(`[VAVOO] Cache caricata: ${vavooCache.links.size} canali`);
        } catch (e) {
            console.log('[VAVOO] ERRORE DUMP CACHE:', e);
        }
    }

    // Carica la cache TVTap solo se TVTAP_ENABLE è attivo
    const isTVTapEnabled = ['1', 'true', 'on', 'yes'].includes((process.env.TVTAP_ENABLE || '0').toString().toLowerCase());
    if (isTVTapEnabled) {
        loadTVTapCache();
    } else {
        console.log('[TVTAP] TVTAP_ENABLE=0, cache non caricata');
    }

    // Aggiorna la cache Vavoo in background all'avvio
    setTimeout(() => {
        updateVavooCache().then(success => {
            if (success) {
                console.log(`✅ Cache Vavoo aggiornata con successo all'avvio`);
                // Avvia Live.py subito dopo il successo della cache Vavoo (una volta, non bloccante)
                try {
                    const livePath = path.join(__dirname, '../Live.py');
                    const fs = require('fs');
                    if (fs.existsSync(livePath)) {
                        try {
                            const st = fs.statSync(livePath);
                            console.log('[Live.py][DIAG] path=', livePath, 'size=', st.size, 'mtime=', new Date(st.mtimeMs || st.mtime).toISOString());
                        } catch { }
                        // individua interpreti python disponibili
                        const candidateBins = [process.env.PYTHON_BIN, 'python3', 'python', 'py'].filter(Boolean) as string[];
                        let chosen: string | null = null;
                        for (const b of candidateBins) {
                            try {
                                const { spawnSync } = require('child_process');
                                const r = spawnSync(b, ['-V'], { timeout: 4000 });
                                if (r.status === 0 && String(r.stdout || r.stderr).toLowerCase().includes('python')) {
                                    chosen = b; console.log('[Live.py][DIAG] interpreter ok ->', b, 'version:', (r.stdout || r.stderr).toString().trim());
                                    break;
                                }
                            } catch { }
                        }
                        if (!chosen) {
                            console.warn('[Live.py][DIAG] nessun interprete Python funzionante trovato tra', candidateBins.join(','));
                        }
                        const trySpawn = (py: string) => {
                            try {
                                const child = require('child_process').spawn(py, [livePath], { detached: true, stdio: 'ignore' });
                                child.unref();
                                console.log(`[Live.py] avviato in background con '${py}'`);
                                return true;
                            } catch { return false; }
                        };
                        if (chosen) {
                            if (!trySpawn(chosen)) console.warn('[Live.py][DIAG] spawn fallita con', chosen);
                        } else {
                            if (!trySpawn('python3')) trySpawn('python');
                        }
                    } else {
                        console.log('[Live.py] non trovato, skip');
                    }
                } catch (e) {
                    console.log('[Live.py] errore avvio non bloccante:', (e as any)?.message || e);
                }
            } else {
                console.log(`⚠️ Aggiornamento cache Vavoo fallito all'avvio, verrà ritentato periodicamente`);
            }
        }).catch(error => {
            console.error(`❌ Errore durante l'aggiornamento cache Vavoo all'avvio:`, error);
        });
    }, 2000);

    // === TVTAP cache updates (controllato da TVTAP_ENABLE) ===
    (() => {
        try {
            let tvtapEnableRaw = (process.env.TVTAP_ENABLE || '0').toString().toLowerCase();
            const tvtapEnabled = ['1', 'true', 'on', 'yes'].includes(tvtapEnableRaw);

            if (!tvtapEnabled) {
                console.log('[TVTAP][INIT] TVTAP_ENABLE disabilitato, skip aggiornamenti cache');
                return;
            }

            // Aggiorna la cache TVTap in background all'avvio
            setTimeout(() => {
                updateTVTapCache().then(success => {
                    if (success) {
                        console.log(`✅ Cache TVTap aggiornata con successo all'avvio`);
                    } else {
                        console.log(`⚠️ Aggiornamento cache TVTap fallito all'avvio, verrà ritentato periodicamente`);
                    }
                }).catch(error => {
                    console.error(`❌ Errore durante l'aggiornamento cache TVTap all'avvio:`, error);
                });
            }, 4000); // Aspetta un po' di più per non sovraccaricare

            // Programma aggiornamenti periodici della cache TVTap (ogni 12 ore, offset di 1 ora)
            const TVTAP_UPDATE_INTERVAL = 12 * 60 * 60 * 1000; // 12 ore in millisecondi
            setInterval(() => {
                console.log(`🔄 Aggiornamento periodico cache TVTap avviato...`);
                updateTVTapCache().then(success => {
                    if (success) {
                        console.log(`✅ Cache TVTap aggiornata periodicamente con successo`);
                    } else {
                        console.log(`⚠️ Aggiornamento periodico cache TVTap fallito`);
                    }
                }).catch(error => {
                    console.error(`❌ Errore durante l'aggiornamento periodico cache TVTap:`, error);
                });
            }, TVTAP_UPDATE_INTERVAL);
        } catch (e) {
            console.error('[TVTAP][INIT][ERR]', (e as any)?.message || e);
        }
    })();

    // Programma aggiornamenti periodici della cache Vavoo (ogni 12 ore)
    const VAVOO_UPDATE_INTERVAL = 12 * 60 * 60 * 1000; // 12 ore in millisecondi
    setInterval(() => {
        console.log(`🔄 Aggiornamento periodico cache Vavoo avviato...`);
        updateVavooCache().then(success => {
            if (success) {
                console.log(`✅ Cache Vavoo aggiornata periodicamente con successo`);
            } else {
                console.log(`⚠️ Aggiornamento periodico cache Vavoo fallito`);
            }
        }).catch(error => {
            console.error(`❌ Errore durante l'aggiornamento periodico cache Vavoo:`, error);
        });
    }, VAVOO_UPDATE_INTERVAL);

    // Inizializza EPG Manager
    if (epgConfig.enabled) {
        epgManager = new EPGManager(epgConfig);
        console.log(`📺 EPG Manager inizializzato con URL: ${epgConfig.epgUrl}`);

        // Avvia aggiornamento EPG in background senza bloccare l'avvio
        setTimeout(() => {
            if (epgManager) {
                epgManager.updateEPG().then(success => {
                    if (success) {
                        console.log(`✅ EPG aggiornato con successo in background`);
                    } else {
                        console.log(`⚠️ Aggiornamento EPG fallito in background, verrà ritentato al prossimo utilizzo`);
                    }
                }).catch(error => {
                    console.error(`❌ Errore durante l'aggiornamento EPG in background:`, error);
                });
            }
        }, 1000);

        // Programma aggiornamenti periodici dell'EPG (ogni 6 ore)
        setInterval(() => {
            if (epgManager) {
                console.log(`🔄 Aggiornamento EPG periodico avviato...`);
                epgManager.updateEPG().then(success => {
                    if (success) {
                        console.log(`✅ EPG aggiornato periodicamente con successo`);
                    } else {
                        console.log(`⚠️ Aggiornamento EPG periodico fallito`);
                    }
                }).catch(error => {
                    console.error(`❌ Errore durante l'aggiornamento EPG periodico:`, error);
                });
            }
        }, epgConfig.updateInterval);
    }
} catch (error) {
    console.error('❌ Errore nel caricamento dei file di configurazione TV:', error);
}

// Funzione per determinare le categorie di un canale

function normalizeProxyUrl(url: string): string {
    return url.endsWith('/') ? url.slice(0, -1) : url;
}

// Funzione per creare il builder con configurazione dinamica
function createBuilder(initialConfig: AddonConfig = {}) {
    const manifest = loadCustomConfig();
    // Applica un filtro leggero al manifest per nascondere il catalogo TV quando disabilitato
    const effectiveManifest: Manifest = (() => {
        try {
            const filtered = { ...manifest } as Manifest;
            const cats = Array.isArray(filtered.catalogs) ? filtered.catalogs.slice() : [];

            // Rimuovi cataloghi TV quando disabilitato
            if (initialConfig && (initialConfig as any).disableLiveTv) {
                filtered.catalogs = cats.filter((c: any) =>
                    !(c && ((c as any).id === 'streamvix_tv' || (c as any).id === 'streamvix_live'))
                );
            }

            // Rimuovi catalogo DVR quando dvrEnabled non è attivo
            if (!initialConfig || !(initialConfig as any).dvrEnabled) {
                filtered.catalogs = (filtered.catalogs || []).filter((c: any) =>
                    !(c && (c as any).id === 'streamvix_dvr')
                );
            }

            return filtered;
        } catch { }
        return manifest;
    })();

    if (initialConfig.mediaFlowProxyUrl || initialConfig.enableMpd || initialConfig.tmdbApiKey) {
        effectiveManifest.name; // no-op to avoid unused warning pattern
    }

    const builder = new addonBuilder(effectiveManifest);

    // === TV CATALOG HANDLER ONLY ===
    builder.defineCatalogHandler(async ({ type, id, extra, config: requestConfig }: { type: string; id: string; extra?: any; config?: any }) => {
        if (type === "tv") {
            // Simple runtime toggle: hide TV when disabled
            try {
                const cfg = { ...configCache } as AddonConfig;
                if (cfg.disableLiveTv) {
                    console.log('📴 TV catalog disabled by config.disableLiveTv');
                    return { metas: [], cacheMaxAge: 0 };
                }
            } catch { }
            try {
                const lastReq0: any = (global as any).lastExpressRequest;
                console.log('📥 Catalog TV request:', {
                    id,
                    extra,
                    path: lastReq0?.path,
                    url: lastReq0?.url
                });
            } catch { }
            // === Catalogo TV: modalità NO CACHE per test (di default attiva) ===
            const disableCatalogCache = (() => {
                try {
                    const v = (process?.env?.NO_TV_CATALOG_CACHE ?? '1').toString().toLowerCase();
                    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
                } catch { return true; }
            })();

            if (disableCatalogCache) {
                try {
                    // Ricarica sempre dal JSON dinamico e rifai il merge ad ogni richiesta
                    loadDynamicChannels(true);
                    tvChannels = mergeDynamic([...staticBaseChannels]);
                    debugLog(`⚡ Catalog rebuilt (NO_CACHE) count=${tvChannels.length}`);
                } catch (e) {
                    console.error('❌ Merge dynamic channels failed (NO_CACHE):', e);
                }
            } else {
                // Fallback: usa cache leggera in memoria
                const staticSig = staticBaseChannels.length;
                const cacheKey = `${staticSig}`;
                const g: any = global as any;
                if (!g.__tvCatalogCache) g.__tvCatalogCache = { key: '', channels: [] };
                if (g.__tvCatalogCache.key !== cacheKey) {
                    try {
                        loadDynamicChannels(false);
                        tvChannels = mergeDynamic([...staticBaseChannels]);
                        g.__tvCatalogCache = { key: cacheKey, channels: tvChannels };
                        debugLog(`⚡ Catalog rebuild (cache miss) newKey=${cacheKey} count=${tvChannels.length}`);
                    } catch (e) {
                        console.error('❌ Merge dynamic channels failed:', e);
                    }
                } else {
                    tvChannels = g.__tvCatalogCache.channels;
                    debugLog(`⚡ Catalog served from cache key=${cacheKey} count=${tvChannels.length}`);
                }
            }
            let filteredChannels = tvChannels;

            // === NUOVO: Filtro per ID catalogo (Static vs Live/Dynamic) ===
            if (id === 'streamvix_tv') {
                // Solo canali statici (non hanno _dynamic: true)
                filteredChannels = filteredChannels.filter((c: any) => !c._dynamic);
                // console.log(`[CATALOG] streamvix_tv -> filtered static count=${filteredChannels.length}`);
            } else if (id === 'streamvix_live') {
                // Solo canali live/dinamici (hanno _dynamic: true)
                filteredChannels = filteredChannels.filter((c: any) => c._dynamic);
                // INTEGRATION: Add SportZX channels to Live catalog
                const sportzx = getSportzxChannels();
                if (sportzx.length > 0) {
                    filteredChannels = [...filteredChannels, ...sportzx];
                }
                // INTEGRATION: Add Sports99 channels to Live catalog
                const sports99 = getSports99Channels();
                if (sports99.length > 0) {
                    filteredChannels = [...filteredChannels, ...sports99];
                }
                // console.log(`[CATALOG] streamvix_live -> filtered dynamic count=${filteredChannels.length}`);
            } else if (id === 'streamvix_dvr') {
                // DVR catalog - fetch recordings from EasyProxy
                try {
                    const { getDvrConfig, formatDuration, formatFileSize } = await import('./utils/easyproxyDvr');
                    // Use request config (user's config from URL) with fallback to configCache
                    const cfg = requestConfig && Object.keys(requestConfig).length > 0
                        ? { ...requestConfig }
                        : { ...configCache };
                    console.log(`📹 DVR catalog: Using config dvrEnabled=${cfg.dvrEnabled}, mediaFlowProxyUrl=${cfg.mediaFlowProxyUrl?.substring(0, 30)}...`);
                    const dvrConfig = getDvrConfig(cfg);

                    if (!dvrConfig) {
                        console.log('📹 DVR catalog: DVR not configured');
                        return { metas: [], cacheMaxAge: 60 };
                    }

                    // Fetch all recordings from EasyProxy
                    const params = new URLSearchParams();
                    if (dvrConfig.apiPassword) {
                        params.set('api_password', dvrConfig.apiPassword);
                    }
                    const url = `${dvrConfig.easyProxyUrl}/api/recordings?${params.toString()}`;

                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 10000);

                    const response = await fetch(url, {
                        method: 'GET',
                        headers: {
                            'Accept': 'application/json',
                            ...(dvrConfig.apiPassword ? { 'x-api-password': dvrConfig.apiPassword } : {})
                        },
                        signal: controller.signal
                    });
                    clearTimeout(timeout);

                    if (!response.ok) {
                        console.warn(`📹 DVR catalog: Failed to fetch recordings: ${response.status}`);
                        return { metas: [], cacheMaxAge: 60 };
                    }

                    const data = await response.json();
                    const recordings = data.recordings || [];

                    console.log(`📹 DVR catalog: API returned ${recordings.length} recordings`);
                    if (recordings.length > 0) {
                        console.log(`📹 DVR catalog: First recording:`, JSON.stringify(recordings[0], null, 2));
                    }

                    // Filter to only completed/stopped recordings with files
                    const validRecordings = recordings.filter((rec: any) => {
                        const hasValidFile = rec.file_size_bytes && rec.file_size_bytes > 0;
                        const isFinished = ['completed', 'stopped', 'failed'].includes(rec.status);
                        return isFinished && hasValidFile && !rec.is_active;
                    });

                    // Also include active recordings (check is_active OR status)
                    const activeRecordings = recordings.filter((rec: any) =>
                        rec.is_active || rec.status === 'recording' || rec.status === 'starting'
                    );

                    console.log(`📹 DVR catalog: ${activeRecordings.length} active, ${validRecordings.length} completed`);

                    // Convert to Stremio meta format
                    const metas = [...activeRecordings, ...validRecordings].map((rec: any) => {
                        const isActive = rec.is_active || rec.status === 'recording' || rec.status === 'starting';
                        const elapsed = rec.elapsed_seconds ? formatDuration(rec.elapsed_seconds) : '';
                        const duration = rec.duration_seconds ? formatDuration(rec.duration_seconds) : '';
                        const size = rec.file_size_bytes ? formatFileSize(rec.file_size_bytes) : '';
                        const date = rec.started_at ? new Date(rec.started_at).toLocaleDateString() : '';
                        const time = rec.started_at ? new Date(rec.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

                        // Build display name - strip source tags like [FREE], [MPD2] etc
                        let displayName = (rec.name || 'Recording').replace(/^\[([^\]]+)\]\s*/, '');

                        // For active recordings, show elapsed time
                        // For completed recordings, show duration
                        const timeInfo = isActive ? elapsed : duration;
                        if (timeInfo) {
                            displayName = `[${timeInfo}] ${displayName}`;
                        }

                        const statusPrefix = isActive ? '🔴 ' : '📹 ';

                        // Build description with more details
                        let details: string;
                        if (isActive) {
                            const startedInfo = time ? `Started ${time}` : '';
                            details = [startedInfo, elapsed ? `${elapsed} elapsed` : 'Starting...'].filter(Boolean).join(' • ');
                        } else {
                            details = [duration, size, date].filter(Boolean).join(' • ');
                        }

                        return {
                            id: `dvr:${rec.id}`,
                            type: 'tv',
                            name: `${statusPrefix}${displayName}`,
                            poster: 'https://raw.githubusercontent.com/qwertyuiop8899/StreamViX/refs/heads/main/public/logo.png',
                            posterShape: 'landscape',
                            description: details,
                            genres: ['DVR'],
                            // Store recording data for stream handler
                            _dvrRecording: rec
                        };
                    });

                    console.log(`📹 DVR catalog: Returning ${metas.length} recordings`);
                    return { metas, cacheMaxAge: 30 }; // Short cache for DVR

                } catch (error) {
                    console.error('📹 DVR catalog error:', error);
                    return { metas: [], cacheMaxAge: 60 };
                }
            }

            let requestedSlug: string | null = null;
            let isPlaceholder = false;

            // === SEARCH HANDLER ===
            if (extra && typeof extra.search === 'string' && extra.search.trim().length > 0) {
                const rawQ = extra.search.trim();
                const tokens = rawQ.toLowerCase().split(/\s+/).filter(Boolean);
                console.log(`🔎 Search (OR+fuzzy) query tokens:`, tokens);
                const seen = new Set<string>();

                const simpleLevenshtein = (a: string, b: string): number => {
                    if (a === b) return 0;
                    const al = a.length, bl = b.length;
                    if (Math.abs(al - bl) > 1) return 99; // prune (we only care distance 0/1)
                    const dp: number[] = Array(bl + 1).fill(0);
                    for (let j = 0; j <= bl; j++) dp[j] = j;
                    for (let i = 1; i <= al; i++) {
                        let prev = dp[0];
                        dp[0] = i;
                        for (let j = 1; j <= bl; j++) {
                            const tmp = dp[j];
                            if (a[i - 1] === b[j - 1]) dp[j] = prev; else dp[j] = Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
                            prev = tmp;
                        }
                    }
                    return dp[bl];
                };

                const tokenMatches = (token: string, hay: string, words: string[]): boolean => {
                    if (!token) return false;
                    if (hay.includes(token)) return true; // substring
                    // prefix match on any word
                    if (words.some(w => w.startsWith(token))) return true;
                    // fuzzy distance 1 on words (only if token length > 3 to avoid noise)
                    if (token.length > 3) {
                        for (const w of words) {
                            if (Math.abs(w.length - token.length) > 1) continue;
                            if (simpleLevenshtein(token, w) <= 1) return true;
                        }
                    }
                    return false;
                };

                filteredChannels = filteredChannels.filter((c: any) => {
                    const categories = getChannelCategories(c); // include category slugs
                    const categoryStr = categories.join(' ');
                    const hayRaw = `${c.name || ''} ${(c.description || '')} ${categoryStr}`.toLowerCase();
                    const words = hayRaw.split(/[^a-z0-9]+/).filter(Boolean);
                    const ok = tokens.some((t: string) => tokenMatches(t, hayRaw, words)); // OR logic
                    if (ok) {
                        if (seen.has(c.id)) return false;
                        seen.add(c.id);
                        return true;
                    }
                    return false;
                }).slice(0, 200);
                console.log(`🔎 Search results (OR+fuzzy): ${filteredChannels.length}`);
            } else {
                // === GENRE FILTERING (robusto) ===
                let genreInput: string | undefined;
                // extra come stringa: "genre=coppe&x=y"
                if (typeof extra === 'string') {
                    const parts = extra.split('&');
                    for (const p of parts) {
                        const [k, v] = p.split('=');
                        if (k === 'genre' && v) genreInput = decodeURIComponent(v);
                    }
                }
                // extra oggetto
                if (!genreInput && extra && typeof extra === 'object' && extra.genre) genreInput = String(extra.genre);
                // fallback ultima richiesta express
                const lastReq: any = (global as any).lastExpressRequest;
                if (!genreInput && lastReq?.query) {
                    if (typeof lastReq.query.genre === 'string') genreInput = lastReq.query.genre;
                    else if (typeof lastReq.query.extra === 'string') {
                        const m = lastReq.query.extra.match(/genre=([^&]+)/i); if (m) genreInput = decodeURIComponent(m[1]);
                    } else if (lastReq.query.extra && typeof lastReq.query.extra === 'object' && lastReq.query.extra.genre) {
                        genreInput = String(lastReq.query.extra.genre);
                    }
                }
                // Fallback: prova ad estrarre genre anche dal path/URL se non presente
                if (!genreInput) {
                    try {
                        const lastReq2: any = (global as any).lastExpressRequest;
                        const fromUrl = (lastReq2?.url || '') as string;
                        const fromPath = (lastReq2?.path || '') as string;
                        let extracted: string | undefined;
                        // 1) Query string
                        const qMatch = fromUrl.match(/genre=([^&]+)/i);
                        if (qMatch) extracted = decodeURIComponent(qMatch[1]);
                        // 2) Extra nel path: /catalog/tv/tv-channels/genre=Coppe.json oppure .../genre=Coppe&...
                        if (!extracted) {
                            const pMatch = fromPath.match(/\/catalog\/[^/]+\/[^/]+\/([^?]+)\.json/i);
                            if (pMatch && pMatch[1]) {
                                const extraSeg = decodeURIComponent(pMatch[1]);
                                const g2 = extraSeg.match(/(?:^|&)genre=([^&]+)/i);
                                if (g2) extracted = g2[1];
                                else if (extraSeg.startsWith('genre=')) extracted = extraSeg.split('=')[1];
                                else if (extraSeg && !extraSeg.includes('=')) extracted = extraSeg; // support /.../Coppe.json
                            }
                        }
                        if (extracted) {
                            genreInput = extracted;
                            console.log(`🔎 Fallback genre extracted from URL/path: '${genreInput}'`);
                        }
                    } catch { }
                }

                if (genreInput) {
                    // Normalizza spazi invisibili e accenti
                    genreInput = genreInput.replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, ' ').replace(/\s+/g, ' ').trim();
                    const norm = genreInput.trim().toLowerCase()
                        .replace(/[àáâãä]/g, 'a').replace(/[èéêë]/g, 'e')
                        .replace(/[ìíîï]/g, 'i').replace(/[òóôõö]/g, 'o')
                        .replace(/[ùúûü]/g, 'u');
                    const genreMap: { [key: string]: string } = {
                        'rai': 'rai', 'mediaset': 'mediaset', 'sky': 'sky', 'bambini': 'kids', 'news': 'news', 'sport': 'sport', 'cinema': 'movies', 'generali': 'general', 'documentari': 'documentari', 'discovery': 'discovery', 'pluto': 'pluto', 'serie a': 'seriea', 'serie b': 'serieb', 'serie c': 'seriec', 'coppe': 'coppe', 'soccer': 'soccer', 'tennis': 'tennis', 'f1': 'f1', 'motogp': 'motogp', 'basket': 'basket', 'volleyball': 'volleyball', 'ice hockey': 'icehockey', 'wrestling': 'wrestling', 'boxing': 'boxing', 'darts': 'darts', 'baseball': 'baseball', 'nfl': 'nfl'
                    };
                    // Aggiungi mapping per nuove leghe
                    genreMap['premier league'] = 'premierleague';
                    genreMap['liga'] = 'liga';
                    genreMap['bundesliga'] = 'bundesliga';
                    genreMap['ligue 1'] = 'ligue1';
                    genreMap['thisnot'] = 'thisnot';
                    genreMap['ligue 1'] = 'ligue1';
                    genreMap['thisnot'] = 'thisnot';
                    genreMap['ppv'] = 'ppv';
                    genreMap['sportzx'] = 'sportzx'; // lowercase to match getChannelCategories() output
                    genreMap['sports99'] = 'sports99'; // Sports99 channels
                    const target = genreMap[norm] || norm;
                    requestedSlug = target;

                    // DEBUG: Log primi 5 canali ThisNot PRIMA del filtro
                    if (target === 'thisnot') {
                        const thisnotChannels = filteredChannels.filter((ch: any) => {
                            const catRaw = ch.category;
                            return catRaw === 'thisnot' || catRaw === 'THISNOT' || (Array.isArray(catRaw) && catRaw.includes('thisnot'));
                        }).slice(0, 5);
                        console.log(`🔍 DEBUG: Trovati ${thisnotChannels.length} canali con category='thisnot' (pre-filter)`);
                        thisnotChannels.forEach((ch: any, idx: number) => {
                            console.log(`  [${idx}] id=${ch.id}, name="${ch.name}", category=${JSON.stringify(ch.category)}, getChannelCategories=${JSON.stringify(getChannelCategories(ch))}`);
                        });
                    }

                    filteredChannels = filteredChannels.filter(ch => getChannelCategories(ch).includes(target));
                    console.log(`🔍 Genre='${norm}' -> slug='${target}' results=${filteredChannels.length}`);
                } else {
                    console.log(`📺 No genre filter, showing all ${tvChannels.length} channels`);
                }
            }

            // Se filtro richiesto e nessun canale trovato -> aggiungi placeholder
            if (requestedSlug && filteredChannels.length === 0) {
                const PLACEHOLDER_ID = `placeholder-${requestedSlug}`;
                const PLACEHOLDER_LOGO_BASE = 'https://raw.githubusercontent.com/qwertyuiop8899/logo/main';
                const placeholderLogo = `${PLACEHOLDER_LOGO_BASE}/nostream.png`;
                filteredChannels = [{
                    id: PLACEHOLDER_ID,
                    name: 'Nessuno Stream disponibile oggi',
                    logo: placeholderLogo,
                    poster: placeholderLogo,
                    type: 'tv',
                    category: [requestedSlug],
                    genres: [requestedSlug],
                    description: 'Nessuno Stream disponibile oggi. Live 🔴',
                    _placeholder: true,
                    placeholderVideo: `${PLACEHOLDER_LOGO_BASE}/nostream.mp4`
                }];
                isPlaceholder = true;
            }

            // Ordina SOLO gli eventi dinamici per eventStart (asc) quando è presente un filtro di categoria
            try {
                if (requestedSlug && filteredChannels.length) {
                    const dynWithIndex = filteredChannels
                        .map((ch: any, idx: number) => ({ ch, idx }))
                        .filter(x => !!x.ch && (x.ch as any)._dynamic);
                    const compare = (a: any, b: any) => {
                        const aS = a?.eventStart || a?.eventstart;
                        const bS = b?.eventStart || b?.eventstart;
                        const ap = aS ? Date.parse(aS) : NaN;
                        const bp = bS ? Date.parse(bS) : NaN;
                        const aHas = !isNaN(ap);
                        const bHas = !isNaN(bp);
                        if (aHas && bHas) return ap - bp;
                        if (aHas && !bHas) return -1;
                        if (!aHas && bHas) return 1;
                        return (a?.name || '').localeCompare(b?.name || '');
                    };
                    dynWithIndex.sort((A, B) => compare(A.ch, B.ch));
                    const sortedDyn = dynWithIndex.map(x => x.ch);
                    let di = 0;
                    filteredChannels = filteredChannels.map((ch: any) => ch && (ch as any)._dynamic ? sortedDyn[di++] : ch);
                    console.log(`⏱️ Sorted only dynamic events within category '${requestedSlug}' (asc)`);
                }
            } catch { }

            // Aggiungi prefisso tv: agli ID, posterShape landscape e EPG
            const tvChannelsWithPrefix = await Promise.all(filteredChannels.map(async (channel: any) => {
                const channelWithPrefix = {
                    ...channel,
                    id: `tv:${channel.id}`,
                    posterShape: "landscape",
                    poster: (channel as any).poster || (channel as any).logo || '',
                    logo: (channel as any).logo || (channel as any).poster || '',
                    background: (channel as any).background || (channel as any).poster || ''
                };

                // Preserve original name for dynamic rename logic
                (channelWithPrefix as any)._originalName = channel.name;

                // === GDPLAYER TAGGING (catalog) BEFORE dynamic rename ===
                let gdTagged = false;
                try {
                    // CHANGED: Use GDPLAYER_ENABLE for clarity (default OFF, independent from D_CF)
                    const enableTag = /^(1|true|on)$/i.test(String(process?.env?.GDPLAYER_ENABLE || ''));
                    if (enableTag && channel && channel.name && !/\[Gd\]/i.test(channel.name)) {
                        const strict = /^(1|true|on)$/i.test(String(process?.env?.GDPLAYER_STRICT || ''));
                        let shouldTag = false;
                        let inferredSlug: string | null = null;
                        const logEnabled = /^(1|true|on)$/i.test(String(process?.env?.GDPLAYER_LOG || '1'));
                        if (logEnabled) {
                            console.log('[GD][TAG][CAT] candidate', { id: channel.id, name: channel.name, dynamic: !!(channel as any)._dynamic, strict, enableTag });
                        }
                        if (strict) {
                            const gd = await resolveGdplayerForChannel(channel, { mfpUrl: process.env.MFP_URL, mfpPassword: process.env.MFP_PASSWORD });
                            shouldTag = !!(gd && gd.url && !gd.error);
                            if (logEnabled) console.log('[GD][TAG][CAT] strict result', { ok: shouldTag, error: gd?.error });
                        } else {
                            inferredSlug = inferGdplayerSlug(channel);
                            shouldTag = !!inferredSlug;
                            if (logEnabled) console.log('[GD][TAG][CAT] optimistic', { inferredSlug, tag: shouldTag });
                        }
                        if (shouldTag) {
                            // Preserve original visible name (no [Gd] prefix per user requirement)
                            gdTagged = true;
                            (channelWithPrefix as any)._gdTagged = true; // internal flag
                            if (!(channel as any)._dynamic) {
                                const origDesc = channelWithPrefix.description || channel.description || '';
                                // Append source note only in description
                                channelWithPrefix.description = `${origDesc}\n[Gd]${strict ? '' : ' (slug)'} source`.trim();
                            }
                        } else if (logEnabled) {
                            console.log('[GD][TAG][CAT] skip', { reason: 'no-match', strict, inferredSlug });
                        }
                    }
                } catch { }

                // Per canali dinamici: niente EPG, mostra solo ora inizio evento
                if ((channel as any)._dynamic) {
                    const eventStart = (channel as any).eventStart || (channel as any).eventstart; // fallback
                    const isThisNot = ((channel as any).category || '').toLowerCase() === 'thisnot';

                    // Per canali THISNOT: usa il formato originale senza manipolazioni
                    if (isThisNot) {
                        // Nome canale già nel formato: "04/11 ⏰ 21:00 - JUVENTUS VS SPORTING LISBONA"
                        console.log(`[THISNOT] Processing channel: "${channel.name}"`);

                        // Estrai le parti per la descrizione
                        const nameMatch = channel.name.match(/^(\d{2}\/\d{2})\s*⏰\s*(\d{2}:\d{2})\s*-\s*(.+?)(?:\s*-\s*\d{2}\/\d{2})?$/);
                        if (nameMatch) {
                            const dateStr = nameMatch[1];  // "04/11"
                            const timeStr = nameMatch[2];  // "21:00"
                            let teams = nameMatch[3];      // "JUVENTUS VS SPORTING LISBONA"

                            // Rimuovi eventuali competizioni e date finali
                            teams = teams
                                .replace(/\s*-\s*(Serie A|Bundesliga|LaLiga|Premier League|Champions League)\s*$/i, '')
                                .replace(/\s*-\s*\d{2}\/\d{2}\s*$/g, '')
                                .trim();

                            // Nome: mantieni originale
                            channelWithPrefix.name = channel.name;
                            // Descrizione: 🔴 Inizio: HH:MM - DD/MM ⏰ TEAMS
                            channelWithPrefix.description = `🔴 Inizio: ${timeStr} - ${dateStr} ⏰ ${teams}`;
                            console.log(`[THISNOT] Description: "${channelWithPrefix.description}"`);
                        } else {
                            console.log(`[THISNOT] No match for: "${channel.name}"`);
                            // Fallback: mantieni nome originale e crea descrizione semplice
                            channelWithPrefix.name = channel.name;
                            channelWithPrefix.description = `🔴 ${channel.name}`;
                        }
                    } else {
                        // Logica originale per altri canali dinamici
                        const stripTimePrefix = (t: string): string => t.replace(/^\s*([⏰🕒]?\s*)?\d{1,2}[\.:]\d{2}\s*[:\-]\s*/i, '').trim();
                        if (eventStart) {
                            try {
                                const hhmm = epgManager ? epgManager.formatDynamicHHMM(eventStart) : new Date(eventStart).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\./g, ':');
                                const ddmm = epgManager ? epgManager.formatDynamicDDMM(eventStart) : '';
                                const rawTitle = stripTimePrefix(channel.name || '');
                                const parts = rawTitle.split(' - ').map(s => s.trim()).filter(Boolean);
                                const eventTitle = parts[0] || rawTitle;
                                // Deriva league + date + country dal resto
                                let tail = parts.slice(1).join(' - ');
                                const dateMatch = rawTitle.match(/\b(\d{1,2}\/\d{1,2})\b/);
                                const dateStr = dateMatch?.[1] || ddmm;
                                const hasItaly = /\bitaly\b/i.test(rawTitle);
                                // Rimuovi date/country dal tail per ottenere la lega pulita
                                let league = tail
                                    .replace(/\b(\d{1,2}\/\d{1,2})\b/gi, '')
                                    .replace(/\bitaly\b/gi, '')
                                    .replace(/\s{2,}/g, ' ')
                                    .replace(/^[-–—\s]+|[-–—\s]+$/g, '')
                                    .trim();
                                // Titolo canale: Evento ⏰ HH:MM - DD/MM (senza Italy, senza lega)
                                // (Removed [Gd] visual prefix; retain internal flag only)
                                const baseEventName = `${eventTitle} ⏰ ${hhmm}${dateStr ? ` - ${dateStr}` : ''}`;
                                (channelWithPrefix as any).name = baseEventName;
                                // Summary: 🔴 Inizio: HH:MM - Evento - Lega - DD/MM Italy
                                channelWithPrefix.description = `🔴 Inizio: ${hhmm} - ${eventTitle}${league ? ` - ${league}` : ''}${dateStr ? ` - ${dateStr}` : ''}${hasItaly ? ' Italy' : ''}`.trim();
                            } catch {
                                channelWithPrefix.description = channel.name || '';
                            }
                        } else {
                            // Se manca l'orario, mantieni nome e descrizione originali
                            channelWithPrefix.description = channel.name || '';
                        }
                    }
                } else if (epgManager) {
                    // Canali tradizionali: EPG
                    try {
                        const epgChannelIds = (channel as any).epgChannelIds;
                        const epgChannelId = epgManager.findEPGChannelId(channel.name, epgChannelIds);
                        if (epgChannelId) {
                            const currentProgram = await epgManager.getCurrentProgram(epgChannelId);
                            if (currentProgram) {
                                const startTime = epgManager.formatTime(currentProgram.start, 'live');
                                const endTime = currentProgram.stop ? epgManager.formatTime(currentProgram.stop, 'live') : '';
                                const epgInfo = `🔴 ORA: ${currentProgram.title} (${startTime}${endTime ? `-${endTime}` : ''})`;
                                channelWithPrefix.description = `${channel.description || ''}\n\n${epgInfo}`;
                            }
                        }
                    } catch (epgError) {
                        console.error(`❌ Catalog: EPG error for ${channel.name}:`, epgError);
                    }
                }

                // Final post-tag log (only if enabled)
                try {
                    const logEnabled = /^(1|true|on)$/i.test(String(process?.env?.GDPLAYER_LOG || '1'));
                    if (logEnabled) {
                        console.log('[GD][TAG][CAT][FINAL]', { id: channel.id, finalName: channelWithPrefix.name, gdTagged, dynamic: !!(channel as any)._dynamic });
                    }
                } catch { }
                return channelWithPrefix;
            }));

            console.log(`✅ Returning ${tvChannelsWithPrefix.length} TV channels for catalog ${id}${isPlaceholder ? ' (placeholder, cacheMaxAge=0)' : ''}`);
            return isPlaceholder
                ? { metas: tvChannelsWithPrefix, cacheMaxAge: 0 }
                : { metas: tvChannelsWithPrefix };
        }
        console.log(`❌ No catalog found for type=${type}, id=${id}`);
        return { metas: [] };
    });

    // === HANDLER META ===
    builder.defineMetaHandler(async ({ type, id, config: requestConfig }: { type: string; id: string; config?: any }) => {
        console.log(`📺 META REQUEST: type=${type}, id=${id}`);
        if (type === "tv") {
            // Gestisci tutti i possibili formati di ID che Stremio può inviare
            let cleanId = id;
            if (id.startsWith('tv:')) {
                cleanId = id.replace('tv:', '');
            } else if (id.startsWith('tv%3A')) {
                cleanId = id.replace('tv%3A', '');
            } else if (id.includes('%3A')) {
                // Decodifica URL-encoded (:)
                cleanId = decodeURIComponent(id);
                if (cleanId.startsWith('tv:')) {
                    cleanId = cleanId.replace('tv:', '');
                }
            }

            // === DVR META HANDLER ===
            // Handle DVR recording meta requests (IDs starting with dvr:)
            if (id.startsWith('dvr:') || id.startsWith('dvr%3A') || cleanId.startsWith('dvr:')) {
                // Extract recording ID - handle both encoded (dvr%3A) and unencoded (dvr:) formats
                const recordingId = id.replace(/^dvr%3A/i, '').replace(/^dvr:/i, '');
                console.log(`📹 DVR meta request for recording: ${recordingId} (original id: ${id})`);

                try {
                    const { getDvrConfig, formatDuration, formatFileSize } = await import('./utils/easyproxyDvr');
                    // Use request config with fallback to configCache
                    const cfg = requestConfig && Object.keys(requestConfig).length > 0
                        ? { ...requestConfig }
                        : { ...configCache };
                    console.log(`📹 DVR meta: Using config dvrEnabled=${cfg.dvrEnabled}, mediaFlowProxyUrl=${cfg.mediaFlowProxyUrl?.substring(0, 30)}...`);
                    const dvrConfig = getDvrConfig(cfg);

                    if (!dvrConfig) {
                        console.warn('📹 DVR meta: DVR not configured');
                        return { meta: null };
                    }

                    // Fetch recording details
                    const params = new URLSearchParams();
                    if (dvrConfig.apiPassword) {
                        params.set('api_password', dvrConfig.apiPassword);
                    }
                    const apiUrl = `${dvrConfig.easyProxyUrl}/api/recordings/${recordingId}?${params.toString()}`;

                    const response = await fetch(apiUrl, {
                        method: 'GET',
                        headers: {
                            'Accept': 'application/json',
                            ...(dvrConfig.apiPassword ? { 'x-api-password': dvrConfig.apiPassword } : {})
                        }
                    });

                    if (!response.ok) {
                        console.warn(`📹 DVR meta: Recording not found: ${response.status}`);
                        return { meta: null };
                    }

                    const recording = await response.json();
                    const duration = recording.duration_seconds ? formatDuration(recording.duration_seconds) : '';
                    const size = recording.file_size_bytes ? formatFileSize(recording.file_size_bytes) : '';
                    const date = recording.started_at ? new Date(recording.started_at).toLocaleDateString() : '';
                    const isActive = recording.is_active;

                    let displayName = recording.name || 'Recording';
                    if (duration) {
                        const tagPattern = /^\[([^\]]+)\]\s*/;
                        if (tagPattern.test(displayName)) {
                            displayName = displayName.replace(tagPattern, `[${duration}] `);
                        } else {
                            displayName = `[${duration}] ${displayName}`;
                        }
                    }

                    const statusPrefix = isActive ? '🔴 ' : '📹 ';
                    const details = isActive
                        ? `Recording in progress...`
                        : [size, date].filter(Boolean).join(' | ');

                    console.log(`📹 DVR meta: Returning meta for ${recordingId}`);
                    return {
                        meta: {
                            id: `dvr:${recordingId}`,
                            type: 'tv',
                            name: `${statusPrefix}${displayName}`,
                            poster: 'https://raw.githubusercontent.com/qwertyuiop8899/StreamViX/refs/heads/main/public/logo.png',
                            posterShape: 'landscape',
                            background: 'https://raw.githubusercontent.com/qwertyuiop8899/StreamViX/refs/heads/main/public/logo.png',
                            description: details,
                            genres: ['DVR']
                        }
                    };

                } catch (error) {
                    console.error('📹 DVR meta error:', error);
                    return { meta: null };
                }
            }

            // === SPORTZX META HANDLER ===
            if (cleanId.startsWith('sportzx_')) {
                const { getSportzxChannels } = await import('./utils/sportzxUpdater');
                const sportzxChannel = getSportzxChannels().find((c: any) => c.id === cleanId);
                if (sportzxChannel) {
                    console.log(`✅ Found SportzX channel for meta: ${sportzxChannel.name}`);
                    return {
                        meta: {
                            id: `tv:${sportzxChannel.id}`,
                            type: 'tv',
                            name: sportzxChannel.name,
                            poster: sportzxChannel.logo,
                            posterShape: 'square',
                            background: sportzxChannel.logo,
                            description: sportzxChannel.description || 'SportzX Live Stream',
                            genres: ['SportzX', 'Live', 'Sport'],
                            releaseInfo: 'Live Event'
                        }
                    };
                }
            }

            // === SPORTS99 META HANDLER ===
            if (cleanId.startsWith('sports99_')) {
                const { getSports99Channels } = await import('./utils/sports99Updater');
                const sports99Channel = getSports99Channels().find((c: any) => c.id === cleanId);
                if (sports99Channel) {
                    console.log(`✅ Found Sports99 channel for meta: ${sports99Channel.name}`);
                    return {
                        meta: {
                            id: `tv:${sports99Channel.id}`,
                            type: 'tv',
                            name: sports99Channel.name,
                            poster: sports99Channel.logo,
                            posterShape: 'square',
                            background: sports99Channel.logo,
                            description: sports99Channel.description || 'Sports99 Live Stream',
                            genres: ['Sports99', 'Live', 'Sport'],
                            releaseInfo: 'Live Event'
                        }
                    };
                }
            }

            // === THISNOT META HANDLER ===
            // Prima controlla se è un canale ThisNot
            const allChannels = loadDynamicChannels(false);

            // Match ThisNot channels by ID prefix (thisnot_XX_) ignoring timestamp, or by category if exact match fails
            let thisnotChannel = allChannels.find((c: any) => c.id === cleanId && (c.category || '').toLowerCase() === 'thisnot');

            // Se non trovato con ID esatto, prova con prefisso (ignora timestamp finale)
            if (!thisnotChannel && cleanId.startsWith('thisnot_')) {
                const idPrefix = cleanId.substring(0, cleanId.lastIndexOf('_') + 1); // "thisnot_45_"
                thisnotChannel = allChannels.find((c: any) =>
                    c.id.startsWith(idPrefix) && (c.category || '').toLowerCase() === 'thisnot'
                );
                if (thisnotChannel) {
                    console.log(`✅ Found ThisNot channel by prefix match: ${cleanId} -> ${thisnotChannel.id}`);
                }
            }

            if (thisnotChannel) {
                console.log(`✅ Found ThisNot channel for meta: ${thisnotChannel.name}`);

                // Crea la descrizione usando lo stesso formato del catalog
                let description = `🔴 Live Sports Event: ${thisnotChannel.name}\n\nStreaming MPD con DRM Clearkey`;
                const nameMatch = thisnotChannel.name.match(/^(\d{2}\/\d{2})\s*⏰\s*(\d{2}:\d{2})\s*-\s*(.+?)(?:\s*-\s*\d{2}\/\d{2})?$/);
                if (nameMatch) {
                    const dateStr = nameMatch[1];  // "04/11"
                    const timeStr = nameMatch[2];  // "21:00"
                    let teams = nameMatch[3];      // "ATLETICO MADRID VS ROYALE UNION SG"

                    // Rimuovi eventuali competizioni e date finali
                    teams = teams
                        .replace(/\s*-\s*(Serie A|Bundesliga|LaLiga|Premier League|Champions League)\s*$/i, '')
                        .replace(/\s*-\s*\d{2}\/\d{2}\s*$/g, '')
                        .trim();

                    description = `🔴 Inizio: ${timeStr} - ${dateStr} ⏰ ${teams}`;
                }

                const meta = {
                    id: `tv:${thisnotChannel.id}`,
                    type: 'tv',
                    name: thisnotChannel.name || 'Unknown',
                    poster: thisnotChannel.logo || 'https://github.com/qwertyuiop8899/logo/blob/main/TSNT.png?raw=true',
                    posterShape: 'square',
                    background: thisnotChannel.logo,
                    description: description,
                    genres: ['Sport', 'Live', 'ThisNot'],
                    year: new Date().getFullYear().toString(),
                    releaseInfo: "Live Event",
                    country: "IT",
                    language: "it"
                };
                return { meta };
            }

            // Se non è ThisNot, continua con la logica normale
            try {
                const cfg = { ...configCache } as AddonConfig;
                if (cfg.disableLiveTv) {
                    console.log('📴 TV meta disabled by config.disableLiveTv');
                    return { meta: null };
                }
            } catch { }

            const channel = tvChannels.find((c: any) => c.id === cleanId);
            if (channel) {
                console.log(`✅ Found channel for meta: ${channel.name}`);

                // Pre-tag base name (meta) con stessa logica ottimistica
                let baseName = channel.name;
                try {
                    // CHANGED: Use GDPLAYER_ENABLE for clarity (default OFF, independent from D_CF)
                    const enableTag = /^(1|true|on)$/i.test(String(process?.env?.GDPLAYER_ENABLE || ''));
                    if (enableTag && baseName && !/\[Gd\]/i.test(baseName)) {
                        const strict = /^(1|true|on)$/i.test(String(process?.env?.GDPLAYER_STRICT || ''));
                        let shouldTag = false;
                        let inferredSlug: string | null = null;
                        const logEnabled = /^(1|true|on)$/i.test(String(process?.env?.GDPLAYER_LOG || '1'));
                        if (logEnabled) {
                            console.log('[GD][TAG][META] candidate', { id: channel.id, name: channel.name, strict, enableTag });
                        }
                        if (strict) {
                            const gd = await resolveGdplayerForChannel(channel, { mfpUrl: process.env.MFP_URL, mfpPassword: process.env.MFP_PASSWORD });
                            shouldTag = !!(gd && gd.url && !gd.error);
                            if (logEnabled) console.log('[GD][TAG][META] strict result', { ok: shouldTag, error: gd?.error });
                        } else {
                            inferredSlug = inferGdplayerSlug(channel);
                            shouldTag = !!inferredSlug;
                            if (logEnabled) console.log('[GD][TAG][META] optimistic', { inferredSlug, tag: shouldTag });
                        }
                        if (shouldTag) { (channel as any)._gdTagged = true; /* no visual prefix */ } else if (logEnabled) console.log('[GD][TAG][META] skip', { reason: 'no-match', strict, inferredSlug });
                    }
                } catch { }

                const metaWithPrefix = {
                    ...channel,
                    id: `tv:${channel.id}`,
                    posterShape: "landscape",
                    poster: (channel as any).poster || (channel as any).logo || '',
                    logo: (channel as any).logo || (channel as any).poster || '',
                    background: (channel as any).background || (channel as any).poster || '',
                    genre: Array.isArray((channel as any).category) ? (channel as any).category : [(channel as any).category || 'general'],
                    genres: Array.isArray((channel as any).category) ? (channel as any).category : [(channel as any).category || 'general'],
                    year: new Date().getFullYear().toString(),
                    imdbRating: null,
                    releaseInfo: "Live TV",
                    country: "IT",
                    language: "it",
                    name: baseName
                };

                // Meta: canali dinamici senza EPG con ora inizio
                if ((channel as any)._dynamic) {
                    const eventStart = (channel as any).eventStart || (channel as any).eventstart;
                    let finalDesc = channel.name || '';
                    const stripTimePrefix = (t: string): string => t.replace(/^\s*([⏰🕒]?\s*)?\d{1,2}[\.:]\d{2}\s*[:\-]\s*/i, '').trim();
                    if (eventStart) {
                        try {
                            const hhmm = epgManager ? epgManager.formatDynamicHHMM(eventStart) : new Date(eventStart).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', hour12: false }).replace(/\./g, ':');
                            const ddmm = epgManager ? epgManager.formatDynamicDDMM(eventStart) : '';
                            const rawTitle = stripTimePrefix(channel.name || '');
                            const parts = rawTitle.split(' - ').map(s => s.trim()).filter(Boolean);
                            const eventTitle = parts[0] || rawTitle;
                            let tail = parts.slice(1).join(' - ');
                            const dateMatch = rawTitle.match(/\b(\d{1,2}\/\d{1,2})\b/);
                            const dateStr = dateMatch?.[1] || ddmm;
                            const hasItaly = /\bitaly\b/i.test(rawTitle);
                            let league = tail
                                .replace(/\b(\d{1,2}\/\d{1,2})\b/gi, '')
                                .replace(/\bitaly\b/gi, '')
                                .replace(/\s{2,}/g, ' ')
                                .replace(/^[-–—\s]+|[-–—\s]+$/g, '')
                                .trim();
                            // Nome coerente anche nel meta: Evento ⏰ HH:MM - DD/MM
                            const baseMetaEventName = `${eventTitle} ⏰ ${hhmm}${dateStr ? ` - ${dateStr}` : ''}`;
                            (metaWithPrefix as any).name = baseMetaEventName; // no [Gd] prefix
                            finalDesc = `🔴 Inizio: ${hhmm} - ${eventTitle}${league ? ` - ${league}` : ''}${dateStr ? ` - ${dateStr}` : ''}${hasItaly ? ' Italy' : ''}`.trim();
                        } catch {/* ignore */ }
                    }
                    (metaWithPrefix as any).description = finalDesc;
                } else if (epgManager) {
                    // Meta: canali tradizionali con EPG
                    try {
                        const epgChannelIds = (channel as any).epgChannelIds;
                        const epgChannelId = epgManager.findEPGChannelId(channel.name, epgChannelIds);
                        if (epgChannelId) {
                            const currentProgram = await epgManager.getCurrentProgram(epgChannelId);
                            const nextProgram = await epgManager.getNextProgram(epgChannelId);
                            let epgDescription = channel.description || '';
                            if (currentProgram) {
                                const startTime = epgManager.formatTime(currentProgram.start, 'live');
                                const endTime = currentProgram.stop ? epgManager.formatTime(currentProgram.stop, 'live') : '';
                                epgDescription += `\n\n🔴 IN ONDA ORA (${startTime}${endTime ? `-${endTime}` : ''}): ${currentProgram.title}`;
                                if (currentProgram.description) epgDescription += `\n${currentProgram.description}`;
                            }
                            if (nextProgram) {
                                const nextStartTime = epgManager.formatTime(nextProgram.start, 'live');
                                const nextEndTime = nextProgram.stop ? epgManager.formatTime(nextProgram.stop, 'live') : '';
                                epgDescription += `\n\n⏭️ A SEGUIRE (${nextStartTime}${nextEndTime ? `-${nextEndTime}` : ''}): ${nextProgram.title}`;
                                if (nextProgram.description) epgDescription += `\n${nextProgram.description}`;
                            }
                            metaWithPrefix.description = epgDescription;
                        }
                    } catch (epgError) {
                        console.error(`❌ Meta: EPG error for ${channel.name}:`, epgError);
                    }
                }

                return { meta: metaWithPrefix };
            } else {
                // Fallback per placeholder non persistiti in tvChannels
                if (cleanId.startsWith('placeholder-')) {
                    const slug = cleanId.replace('placeholder-', '') || 'general';
                    const PLACEHOLDER_LOGO_BASE = 'https://raw.githubusercontent.com/qwertyuiop8899/logo/main';
                    const placeholderLogo = `${PLACEHOLDER_LOGO_BASE}/nostream.png`;
                    const placeholderVideo = `${PLACEHOLDER_LOGO_BASE}/nostream.mp4`;
                    const name = 'Nessuno Stream disponibile oggi';
                    const meta = {
                        id: `tv:${cleanId}`,
                        type: 'tv',
                        name,
                        posterShape: 'landscape',
                        poster: placeholderLogo,
                        logo: placeholderLogo,
                        background: placeholderLogo,
                        description: 'Nessuno Stream disponibile oggi. Live 🔴',
                        genre: [slug],
                        genres: [slug],
                        year: new Date().getFullYear().toString(),
                        imdbRating: null,
                        releaseInfo: 'Live TV',
                        country: 'IT',
                        language: 'it',
                        _placeholder: true,
                        placeholderVideo
                    } as any;
                    console.log(`🧩 Generated dynamic placeholder meta for missing channel ${cleanId}`);
                    return { meta };
                }
                console.log(`❌ No meta found for channel ID: ${id}`);
                return { meta: null };
            }
        }

        // Meta handler per film/serie (logica originale)
        return { meta: null };
    });

    // === HANDLER STREAM ===
    builder.defineStreamHandler(
        async ({
            id,
            type,
            config: requestConfig
        }: {
            id: string;
            type: string;
            config?: any;
        }): Promise<{
            streams: Stream[];
        }> => {
            try {
                // Normalize type: handle Italian endpoint names (film->movie, serie->series)
                let normalizedType = type;
                if (type === 'film') normalizedType = 'movie';
                if (type === 'serie') normalizedType = 'series';
                // Use normalized type for all downstream logic
                type = normalizedType;

                console.log(`🔍 Stream request: ${normalizedType}/${id}`);

                // === SPORTZX STREAM HANDLER ===
                const cleanIdForSportzx = id.startsWith('tv:') ? id.replace('tv:', '') : id;
                if (cleanIdForSportzx.startsWith('sportzx_')) {
                    const { getSportzxChannels } = await import('./utils/sportzxUpdater');
                    const sportzxChannel = getSportzxChannels().find((c: any) => c.id === cleanIdForSportzx);
                    if (sportzxChannel && sportzxChannel._sportzx) {
                        const match = sportzxChannel._sportzx;
                        console.log(`✅ Found SportzX stream for: ${sportzxChannel.name}`);

                        let finalUrl = match.stream_url;
                        let title = '🔴 LIVE (Direct)';

                        // Get MFP config
                        const mfpUrlRaw = requestConfig?.mediaFlowProxyUrl || configCache?.mediaFlowProxyUrl || process.env.MFP_URL;
                        const mfpUrl = mfpUrlRaw ? mfpUrlRaw.replace(/\/+$/, '') : ''; // Remove trailing slash
                        const mfpPsw = requestConfig?.mediaFlowProxyPassword || configCache?.mediaFlowProxyPassword || process.env.MFP_PSW;

                        // 1. MPD with Keys -> Proxy
                        if (match.keyid && match.key && mfpUrl) {
                            const passwordParam = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
                            const encodedUrl = encodeURIComponent(match.stream_url);
                            finalUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?d=${encodedUrl}${passwordParam}&key_id=${match.keyid}&key=${match.key}`;
                            title = '🌐 🔴 LIVE (Proxy MPD)';
                        }
                        // 2. M3U with Headers -> Proxy
                        else if (match.headers && match.headers.trim() && mfpUrl) {
                            const headersObj: any = {};
                            (match.headers as string).split('&').forEach((pair: string) => {
                                const [k, v] = pair.split('=');
                                if (k && v) headersObj[k] = decodeURIComponent(v);
                            });
                            const headersJson = encodeURIComponent(JSON.stringify(headersObj));
                            const passwordParam = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
                            const encodedUrl = encodeURIComponent(match.stream_url);
                            finalUrl = `${mfpUrl}/proxy/hls/manifest.m3u8?d=${encodedUrl}${passwordParam}&headers=${headersJson}`;
                            title = '🌐 🔴 LIVE (Proxy HLS)';
                        }
                        // 3. Plain -> Direct

                        return {
                            streams: [{
                                url: finalUrl,
                                title: title,
                                name: 'SportzX',
                                behaviorHints: {
                                    notWebReady: true
                                }
                            }]
                        };
                    }
                }

                // === SPORTS99 STREAM HANDLER ===
                if (cleanIdForSportzx.startsWith('sports99_')) {
                    const { getSports99Channels } = await import('./utils/sports99Updater');
                    const { Sports99Client } = await import('./extractors/sports99');
                    const sports99Channel = getSports99Channels().find((c: any) => c.id === cleanIdForSportzx);
                    if (sports99Channel && sports99Channel._sports99) {
                        const match = sports99Channel._sports99;
                        console.log(`✅ Found Sports99 stream for: ${sports99Channel.name}`);

                        // Resolve the player URL to get M3U8
                        const client = new Sports99Client();
                        const streamUrl = await client.resolveStreamUrl(match.player_url);

                        if (streamUrl) {
                            return {
                                streams: [{
                                    url: streamUrl,
                                    title: '🔴 LIVE',
                                    name: match.channel_name || 'Sports99',
                                    behaviorHints: {
                                        notWebReady: true
                                    }
                                }]
                            };
                        } else {
                            console.warn(`[Sports99] Could not resolve stream for ${sports99Channel.name}`);
                            return { streams: [] };
                        }
                    }
                }

                // FIX DEFINITIVO: L'MFP viene preso dalla config dell'utente (requestConfig)
                // Se l'utente non ha MFP configurato, usa env vars come fallback (per installazioni locali)
                // MAI dalla configCache globale (che era il bug - veniva contaminata da altri utenti)
                let config: any = {};
                if (requestConfig && Object.keys(requestConfig).length > 0) {
                    config = { ...requestConfig };
                }
                // === SPORTZX DEBUG ENDPOINT ===


                // NOTE: Il middleware ora converte Base64→JSON prima che l'SDK processi la request,
                // quindi requestConfig dovrebbe sempre contenere la config utente correttamente.

                // MFP: prima dalla config utente, poi da env vars (per installazioni locali)
                // NORMALIZZA: rimuovi trailing slash per evitare doppi slash in URL tipo /proxy/...
                const mfpUrl = (config.mediaFlowProxyUrl || process.env.MFP_URL || '').toString().trim().replace(/\/+$/, '');
                const mfpPsw = (config.mediaFlowProxyPassword || process.env.MFP_PSW || process.env.MFP_PASSWORD || '').toString().trim();
                console.log(`🔧 [MFP] User config: url=${mfpUrl || '(none)'} pass=${mfpPsw ? 'SET' : '(none)'}`);

                const allStreams: Stream[] = [];

                // === DVR STREAM HANDLER ===
                // Handle DVR recording playback (IDs starting with dvr:)
                if (id.startsWith('dvr:') || id.startsWith('dvr%3A')) {
                    // Extract recording ID - handle both encoded (dvr%3A) and unencoded (dvr:) formats
                    const recordingId = id.replace(/^dvr%3A/i, '').replace(/^dvr:/i, '');
                    console.log(`📹 DVR stream request for recording: ${recordingId} (original id: ${id})`);

                    try {
                        const { getDvrConfig, buildRecordingStreamUrl, buildStopAndStreamUrl, buildRecordingDeleteUrl } = await import('./utils/easyproxyDvr');
                        const dvrConfig = getDvrConfig(config);

                        if (!dvrConfig) {
                            console.warn('📹 DVR stream: DVR not configured');
                            return { streams: [] };
                        }

                        // Fetch recording details to check if active
                        const params = new URLSearchParams();
                        if (dvrConfig.apiPassword) {
                            params.set('api_password', dvrConfig.apiPassword);
                        }
                        const apiUrl = `${dvrConfig.easyProxyUrl}/api/recordings/${recordingId}?${params.toString()}`;

                        const response = await fetch(apiUrl, {
                            method: 'GET',
                            headers: {
                                'Accept': 'application/json',
                                ...(dvrConfig.apiPassword ? { 'x-api-password': dvrConfig.apiPassword } : {})
                            }
                        });

                        if (!response.ok) {
                            console.warn(`📹 DVR stream: Recording not found: ${response.status}`);
                            return { streams: [] };
                        }

                        const recording = await response.json();
                        const streams: Stream[] = [];

                        const isActive = recording.is_active || recording.status === 'recording' || recording.status === 'starting';
                        console.log(`📹 DVR stream: recording status=${recording.status}, is_active=${recording.is_active}, isActive=${isActive}`);

                        if (isActive) {
                            // Active recording - offer stop & watch
                            const stopStreamUrl = buildStopAndStreamUrl(dvrConfig, recordingId);
                            streams.push({
                                url: stopStreamUrl,
                                title: '🔴 Stop Recording & Watch',
                                behaviorHints: { notWebReady: false }
                            });
                        } else {
                            // Completed recording - stream directly
                            const streamUrl = buildRecordingStreamUrl(dvrConfig, recordingId);
                            streams.push({
                                url: streamUrl,
                                title: `📹 Play Recording`,
                                behaviorHints: { notWebReady: false }
                            });
                        }

                        // Add delete option for all recordings
                        const deleteUrl = buildRecordingDeleteUrl(dvrConfig, recordingId);
                        streams.push({
                            url: deleteUrl,
                            title: `🗑️ DELETE Recording`,
                            behaviorHints: { notWebReady: true }
                        });

                        console.log(`📹 DVR stream: Returning ${streams.length} streams for ${recordingId}`);
                        return { streams };

                    } catch (error) {
                        console.error('📹 DVR stream error:', error);
                        return { streams: [] };
                    }
                }

                // === LOGICA TV ===
                if (type === "tv") {
                    // Improved channel ID parsing to handle different formats from Stremio
                    let cleanId = id;

                    // Gestisci tutti i possibili formati di ID che Stremio può inviare
                    if (id.startsWith('tv:')) {
                        cleanId = id.replace('tv:', '');
                    } else if (id.startsWith('tv%3A')) {
                        cleanId = id.replace('tv%3A', '');
                    } else if (id.includes('%3A')) {
                        // Decodifica URL-encoded (:)
                        cleanId = decodeURIComponent(id);
                        if (cleanId.startsWith('tv:')) {
                            cleanId = cleanId.replace('tv:', '');
                        }
                    }

                    // === THISNOT STREAM HANDLER ===
                    // Prima controlla se è un canale ThisNot
                    const allChannels = loadDynamicChannels(false);

                    // Match ThisNot channels by ID prefix (thisnot_XX_) ignoring timestamp, or by category if exact match fails
                    let thisnotChannel = allChannels.find((c: any) => c.id === cleanId && (c.category || '').toLowerCase() === 'thisnot');

                    // Se non trovato con ID esatto, prova con prefisso (ignora timestamp finale)
                    if (!thisnotChannel && cleanId.startsWith('thisnot_')) {
                        const idPrefix = cleanId.substring(0, cleanId.lastIndexOf('_') + 1); // "thisnot_45_"
                        thisnotChannel = allChannels.find((c: any) =>
                            c.id.startsWith(idPrefix) && (c.category || '').toLowerCase() === 'thisnot'
                        );
                        if (thisnotChannel) {
                            console.log(`✅ Found ThisNot channel by prefix match: ${cleanId} -> ${thisnotChannel.id}`);
                        }
                    }

                    if (thisnotChannel) {
                        console.log(`✅ Found ThisNot channel for stream: ${thisnotChannel.name}`);
                        const streams: Stream[] = [];

                        if (thisnotChannel.streams && Array.isArray(thisnotChannel.streams)) {
                            for (const stream of thisnotChannel.streams) {
                                if (stream.url) {
                                    // Decodifica la staticUrlMpd da base64
                                    let decodedUrl = '';
                                    try {
                                        decodedUrl = Buffer.from(stream.url, 'base64').toString('utf-8');
                                        console.log(`🔓 Decoded ThisNot stream URL: ${decodedUrl.substring(0, 100)}...`);
                                    } catch (e) {
                                        console.error('❌ Error decoding ThisNot stream URL:', e);
                                        continue;
                                    }

                                    // Formato decodificato: https://url.mpd&key_id=xxx&key=yyy
                                    let finalUrl = decodedUrl;
                                    let proxyUsed = false;

                                    // Wrappa con MediaflowProxy se disponibile
                                    if (mfpUrl) {
                                        const urlParts = decodedUrl.split('&');
                                        const baseUrl = urlParts[0]; // URL MPD base
                                        const additionalParams = urlParts.slice(1); // key_id e key
                                        const passwordParam = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';
                                        finalUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?${passwordParam}d=${encodeURIComponent(baseUrl)}`;
                                        // Aggiungi i parametri DRM
                                        for (const param of additionalParams) {
                                            if (param) finalUrl += `&${param}`;
                                        }
                                        proxyUsed = true;
                                        console.log(`🔒 Wrapped ThisNot with MFP: ${finalUrl.substring(0, 100)}...`);
                                    } else {
                                        console.warn('⚠️ MediaflowProxy not configured for ThisNot streams');
                                    }

                                    streams.push({
                                        url: finalUrl,
                                        title: `${proxyUsed ? '' : '[❌Proxy]'}🏆 ThisNot [ITA]`,
                                        behaviorHints: {
                                            notWebReady: true,
                                            bingeGroup: `thisnot-${cleanId}`
                                        }
                                    });
                                }
                            }
                        }

                        console.log(`✅ Returning ${streams.length} ThisNot streams (MFP: ${mfpUrl ? 'SET' : 'MISSING'})`);
                        return { streams };
                    }

                    // Runtime disable live TV (solo per canali normali)
                    // FIX: usa config dell'utente, NON configCache globale
                    try {
                        if ((config as any).disableLiveTv) {
                            console.log('📴 TV streams disabled by config.disableLiveTv');
                            return { streams: [] };
                        }
                    } catch { }
                    // Assicura che i canali dinamici siano presenti anche se la prima richiesta è uno stream (senza passare dal catalog)
                    try {
                        loadDynamicChannels(false);
                        tvChannels = mergeDynamic([...staticBaseChannels]);
                    } catch (e) {
                        console.error('❌ Stream handler: mergeDynamic failed:', e);
                    }

                    debugLog(`Looking for channel with ID: ${cleanId} (original ID: ${id})`);



                    const channel = tvChannels.find((c: any) => c.id === cleanId);

                    if (!channel) {
                        // Gestione placeholder non presente in tvChannels
                        if (cleanId.startsWith('placeholder-')) {
                            const PLACEHOLDER_LOGO_BASE = 'https://raw.githubusercontent.com/qwertyuiop8899/logo/main';
                            const placeholderVideo = `${PLACEHOLDER_LOGO_BASE}/nostream.mp4`;
                            console.log(`🧩 Placeholder channel requested (ephemeral): ${cleanId}`);
                            return { streams: [{ url: placeholderVideo, title: 'Nessuno Stream' }] };
                        }
                        console.log(`❌ Channel ${id} not found`);
                        debugLog(`❌ Channel not found in the TV channels list. Original ID: ${id}, Clean ID: ${cleanId}`);
                        return { streams: [] };
                    }

                    // Gestione placeholder: ritorna un singolo "stream" fittizio (immagine)
                    if ((channel as any)._placeholder) {
                        const vid = (channel as any).placeholderVideo || (channel as any).logo || (channel as any).poster || '';
                        return {
                            streams: [{
                                url: vid,
                                title: 'Nessuno Stream'
                            }]
                        };
                    }

                    console.log(`✅ Found channel: ${channel.name}`);

                    // (GDPLAYER injection spostato dopo la dichiarazione di 'streams')

                    // Debug della configurazione proxy
                    debugLog(`Config DEBUG - mediaFlowProxyUrl: ${config.mediaFlowProxyUrl}`);
                    debugLog(`Config DEBUG - mediaFlowProxyPassword: ${config.mediaFlowProxyPassword ? '***' : 'NOT SET'}`);

                    let streams: { url: string; title: string }[] = [];
                    // Preparazione: risoluzione GD statica ritardata (inserimento dopo PD/Vavoo/free)
                    let gdStaticPending: { url: string; title: string } | null = null;
                    // Helper per nome canale pulito da slug gdplayer (senza orario / evento)
                    const GD_SLUG_DISPLAY: Record<string, string> = {
                        'sky-uno': 'Sky Uno',
                        'sky-sport-tennis': 'Sky Sport Tennis',
                        'sky-sport-24': 'Sky Sport 24',
                        'sky-sport-f1': 'Sky Sport F1',
                        'sky-sport-motogp': 'Sky Sport MotoGP',
                        'sky-sport-nba': 'Sky Sport NBA',
                        'sky-sport-arena': 'Sky Sport Arena',
                        'sky-sport-calcio': 'Sky Sport Calcio',
                        'sky-sport-max': 'Sky Sport Max',
                        'sky-sport-uno': 'Sky Sport Uno',
                        'sky-cinema-uno': 'Sky Cinema Uno',
                        'sky-cinema-comedy': 'Sky Cinema Comedy',
                        'sky-cinema-family': 'Sky Cinema Family',
                        'sky-cinema-romance': 'Sky Cinema Romance',
                        'sky-cinema-suspence': 'Sky Cinema Suspense',
                        'eurosport-1-it': 'Eurosport 1',
                        'eurosport-2-it': 'Eurosport 2'
                    };
                    function gdDisplayNameFromSlug(slug?: string): string | null {
                        if (!slug) return null;
                        const s = slug.toLowerCase();
                        if (GD_SLUG_DISPLAY[s]) return GD_SLUG_DISPLAY[s];
                        // Generic formatter: split by '-' and capitalize
                        const parts = s.split('-').filter(Boolean).filter(p => p !== 'it');
                        const mapped = parts.map(p => {
                            if (p === 'f1') return 'F1';
                            if (p === 'nba') return 'NBA';
                            if (p === 'motogp') return 'MotoGP';
                            return p.charAt(0).toUpperCase() + p.slice(1);
                        });
                        // Heuristic join for sky sport / sky cinema grouping
                        return mapped.join(' ');
                    }
                    try {
                        const enableGdPlayer = /^(1|true|on)$/i.test(String(process?.env?.GDPLAYER_ENABLE || '1'));
                        if (enableGdPlayer && mfpUrl && !(channel as any)._dynamic) { // richiede MFP URL configurato
                            const logEnabled = /^(1|true|on)$/i.test(String(process?.env?.GDPLAYER_LOG || '1'));
                            const inferredSlug = inferGdplayerSlug(channel as any);
                            if (inferredSlug) {
                                try {
                                    const gd = await resolveGdplayerForChannel(channel as any, { mfpUrl: mfpUrl, mfpPassword: mfpPsw });
                                    if (gd && gd.url && !gd.error) {
                                        const finalUrl = gd.wrappedUrl || gd.url;
                                        const cleanName = gdDisplayNameFromSlug(gd.slug) || channel.name;
                                        gdStaticPending = { url: finalUrl, title: `[🌐Gd] ${cleanName} [ITA]` };
                                    }
                                } catch {/* silent */ }
                            }
                        }
                    } catch {/* ignore gdplayer static errors */ }
                    const vavooCleanPromises: Promise<void>[] = [];
                    // Collect clean Vavoo results per variant index to prepend in order later
                    const vavooCleanPrepend: Array<{ url: string; title: string } | undefined> = [];
                    // Keep track of found Vavoo variant URLs to allow fallback insertion
                    const vavooFoundUrls: string[] = [];
                    // Stato toggle MPD (solo da config checkbox, niente override da env per evitare comportamento inatteso)
                    const mpdEnabled = !!config.enableMpd;

                    // Dynamic event channels: dynamicDUrls -> usa stessa logica avanzata di staticUrlD per estrarre link finale
                    if ((channel as any)._dynamic) {
                        // === PPV EARLY RETURN: solo stream originali PPV, niente extra ===
                        const channelCategory = ((channel as any).category || '').toString().toUpperCase();
                        const isPPV = channelCategory === 'PPV' || (channel as any).id?.startsWith('ppv_');
                        if (isPPV) {
                            console.log(`[PPV] ✅ Canale PPV rilevato: ${channel.id} - restituisco solo stream originali`);
                            const ppvStreams: Stream[] = [];
                            const dArr = Array.isArray((channel as any).dynamicDUrls) ? (channel as any).dynamicDUrls : [];
                            for (const d of dArr) {
                                if (d.url) {
                                    // Determina se LIVE o NOT LIVE basandosi su eventStart
                                    let liveStatus = '🔴 LIVE'; // default
                                    try {
                                        const evStart = (channel as any).eventStart || (channel as any).eventstart;
                                        if (evStart) {
                                            const startDate = new Date(evStart);
                                            const now = Date.now();
                                            const diffMs = startDate.getTime() - now;
                                            // NOT LIVE se mancano più di 30 minuti (1800000 ms)
                                            if (diffMs > 1800000) {
                                                liveStatus = '🚫 NOT LIVE';
                                            } else {
                                                liveStatus = '🔴 LIVE';
                                            }
                                        }
                                    } catch { }
                                    // name = LIVE/NOT LIVE status (come 'Live 🔴' in altri stream)
                                    // title = 🇬🇧 PPV (descrizione stream)
                                    ppvStreams.push({
                                        url: d.url,
                                        name: liveStatus,
                                        title: '🇬🇧 PPV'
                                    } as any);
                                }
                            }
                            console.log(`[PPV] Returning ${ppvStreams.length} PPV-only streams`);
                            return { streams: ppvStreams };
                        }



                        // === ThisNot EARLY RETURN: Proxy via MFP ===
                        const isThisNot = channelCategory === 'THISNOT' || (channel as any).id?.startsWith('thisnot_');
                        if (isThisNot) {
                            // Canali ThisNot: dynamicDUrls contiene il link base64 (staticUrlMpd) in "url"
                            // Dobbiamo costruire il link proxato: {mfpUrl}/proxy/stream?d={base64}&api_password={psw}...
                            const tStreams: Stream[] = [];
                            const dArr = Array.isArray((channel as any).dynamicDUrls) ? (channel as any).dynamicDUrls : [];

                            if (mfpUrl) {
                                const passwordParam = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
                                const headersParam = `&headers=${encodeURIComponent('{"User-Agent":"Mozilla/5.0"}')}`;

                                for (const d of dArr) {
                                    if (d.url) {
                                        // d.url è già il base64 (MPD&key...), lo usiamo come parametro d
                                        // Attenzione: se d.url contiene già parametri, ok, è stringa opaca per noi
                                        const finalUrl = `${mfpUrl}/proxy/stream?d=${d.url}${passwordParam}${headersParam}`;

                                        tStreams.push({
                                            url: finalUrl,
                                            name: '🔴 LIVE',
                                            title: 'ThisNot'
                                        } as any);
                                    }
                                }
                                console.log(`[ThisNot] ✅ Canale ThisNot rilevato: ${channel.id} - restituisco ${tStreams.length} stream proxati`);
                                return { streams: tStreams };
                            } else {
                                console.log(`[ThisNot] ⚠️ MFP URL mancante, impossibile proxare canali ThisNot`);
                                // Fallback: restituisci diretto (non funzionerà per CORS/mixed content probabilmente, ma meglio di niente)
                                // O forse meglio non restituire nulla se manca proxy?
                                // Proviamo a restituire link diretto decodificato nel caso serva debug
                            }
                        }

                        // === Z-Eventi & X-Eventi EARLY RETURN: MPD con chiavi - costruisce URL proxy usando config utente ===
                        /* Z-Eventi DISABLED
                        const isZEventi = channelCategory === 'Z-EVENTI' || (channel as any).id?.startsWith('zeventi_');
                        */
                        const isZEventi = false;
                        const isXEventi = channelCategory === 'X-Eventi' || channelCategory === 'X-EVENTI' || (channel as any).id?.startsWith('xeventi_');

                        if (isZEventi || isXEventi) {
                            const zStreams: Stream[] = [];
                            const dArr = [
                                ...(Array.isArray((channel as any).streams) ? (channel as any).streams : []),
                                ...(Array.isArray((channel as any).dynamicDUrls) ? (channel as any).dynamicDUrls : [])
                            ];
                            const groupTitle = isZEventi ? 'Z-Eventi' : 'X-Eventi';
                            const logPrefix = isZEventi ? '[Z-Eventi]' : '[X-Eventi]';

                            if (mfpUrl) {
                                const passwordParam = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';

                                for (const d of dArr) {
                                    if (d.url) {
                                        // d.url è nel formato: mpdUrl&key_id=kids&key=keys
                                        // Dobbiamo costruire: {mfpUrl}/proxy/mpd/manifest.m3u8?{passwordParam}d={encodedMpdUrl}&key_id=...&key=...
                                        // Verifica se ci sono chiavi:
                                        if (d.url.includes('key_id=') && d.url.includes('key=')) {
                                            // HA CHIAVI -> PROXY
                                            const urlParts = d.url.split('&');
                                            const baseUrl = urlParts[0];
                                            const additionalParams = urlParts.slice(1);

                                            let proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?${passwordParam}d=${encodeURIComponent(baseUrl)}`;

                                            for (const param of additionalParams) {
                                                if (param) {
                                                    proxyUrl += `&${param}`;
                                                }
                                            }

                                            zStreams.push({
                                                url: proxyUrl,
                                                name: '🌐 🔴 LIVE',
                                                title: (channel as any).name || groupTitle
                                            } as any);
                                        } else {
                                            // NON HA CHIAVI -> DIRETTO (Clean)
                                            // Anche se c'è MFP, se il link è clean non serve proxarlo (risparmia banda proxy)
                                            zStreams.push({
                                                url: d.url,
                                                name: '🔴 LIVE',
                                                title: (channel as any).name || groupTitle
                                            } as any);
                                        }
                                    }
                                }
                                console.log(`${logPrefix} ✅ Canale rilevato: ${channel.id} - restituisco ${zStreams.length} stream (mix proxy/direct)`);
                                return { streams: zStreams };
                            } else {
                                console.log(`${logPrefix} ⚠️ MFP URL mancante. Verifico se i link richiedono proxy.`);
                                const errorStreams: Stream[] = [];
                                const dArrError = [
                                    ...(Array.isArray((channel as any).streams) ? (channel as any).streams : []),
                                    ...(Array.isArray((channel as any).dynamicDUrls) ? (channel as any).dynamicDUrls : [])
                                ];

                                for (const d of dArrError) {
                                    if (d.url) {
                                        // Se l'URL ha chiavi (key_id), ALLORA serve per forza il proxy -> Errore se manca MFP
                                        if (d.url.includes('key_id=') && d.url.includes('key=')) {
                                            errorStreams.push({
                                                url: d.url,
                                                name: '❌ [Missing Proxy]',
                                                title: 'Serve MFP Config'
                                            } as any);
                                        } else {
                                            // Se NON ha chiavi, proviamo a darlo diretto (comportamento originale)
                                            // Questo rispetta "se link senza proxy allora lascia come funziona ora"
                                            errorStreams.push({
                                                url: d.url,
                                                name: '🔴 LIVE', // Titolo standard
                                                title: (channel as any).name || groupTitle
                                            } as any);
                                        }
                                    }
                                }
                                return { streams: errorStreams };
                            }
                        }

                        const dArr = Array.isArray((channel as any).dynamicDUrls) ? (channel as any).dynamicDUrls : [];
                        console.log(`[DynamicStreams] Channel ${channel.id} dynamicDUrls count=${dArr.length}`);
                        if (dArr.length === 0) {
                            console.log(`[DynamicStreams] ⚠️ Nessuno stream dinamico presente nel canale (dynamicDUrls vuoto)`);
                        }
                        // Click-time Vavoo injection: se trovi un canale "con la bandierina" (titolo provider), prova a mappare su Vavoo
                        try {
                            const providerTitles = dArr.map((e: any) => String(e?.title || '')).filter(Boolean);
                            // dai la priorità a titoli che contengono indicatori italiani
                            const itaPrefer = providerTitles.filter((t: string) => /\b(it|ita|italy|italia|italian|italiano|sky|dazn|eurosport|rai|now)\b/i.test(t));
                            const candidateTexts = itaPrefer.length ? itaPrefer : providerTitles;
                            const alias = findBestAliasInTexts(candidateTexts);
                            if (alias) {
                                const vUrl = resolveFirstVavooUrlForAlias(alias);
                                if (vUrl) {
                                    // Only prepend the CLEAN non-MFP link (per-request, with headers)
                                    const reqObj: any = (global as any).lastExpressRequest;
                                    const clientIp = getClientIpFromReq(reqObj);
                                    let vavooCleanResolved: { url: string; headers: Record<string, string> } | null = null;
                                    try {
                                        const clean = await resolveVavooCleanUrl(vUrl, clientIp);
                                        if (clean && clean.url) {
                                            vavooCleanResolved = clean;
                                            vdbg('Alias clean resolved', { alias, url: clean.url.substring(0, 140) });
                                            const title2 = `🏠 ${alias} (Vavoo🔓) [ITA]`;
                                            // stash headers via behaviorHints when pushing later
                                            streams.unshift({ url: clean.url + `#headers#` + Buffer.from(JSON.stringify(clean.headers)).toString('base64'), title: title2 });
                                        }
                                    } catch (ee) {
                                        const msg = (ee as any)?.message || ee;
                                        vdbg('Alias clean resolve failed', { alias, error: msg });
                                        console.log('[VAVOO] Clean resolve skipped/failed:', msg);
                                    }
                                    // Iniezione Vavoo/MFP: incapsula SEMPRE l'URL vavoo.to originale (come in Live TV), senza extractor
                                    try {
                                        if (mfpUrl) {
                                            const passwordParam = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
                                            const finalUrl2 = `${mfpUrl}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(vUrl)}${passwordParam}`;
                                            const title3 = `🌐 ${alias} (Vavoo/MFP) [ITA]`;
                                            let insertAt = 0;
                                            try { if (streams.length && /(\(Vavoo\))/i.test(streams[0].title)) insertAt = 1; } catch { }
                                            try { streams.splice(insertAt, 0, { url: finalUrl2, title: title3 }); } catch { streams.push({ url: finalUrl2, title: title3 }); }
                                            vdbg('Alias Vavoo/MFP injected (direct proxy/hls on vUrl)', { alias, url: finalUrl2.substring(0, 140) });
                                        } else {
                                            vdbg('Skip Vavoo/MFP injection: MFP config missing');
                                        }
                                    } catch (e2) {
                                        vdbg('Vavoo/MFP injection error', String((e2 as any)?.message || e2));
                                    }
                                    console.log(`✅ [VAVOO] Injected first stream from alias='${alias}' -> ${vUrl.substring(0, 60)}...`);
                                } else {
                                    console.log(`⚠️ [VAVOO] Alias trovato ma nessun URL in cache: '${alias}'`);
                                }
                            } else {
                                console.log('[VAVOO] Nessun alias broadcaster riconosciuto nei titoli provider');
                            }
                        } catch (e) {
                            console.error('❌ [VAVOO] Errore injection dinamico:', (e as any)?.message || e);
                        }
                    }
                    let dynamicHandled = false;
                    // FAST MODE RIMOSSO: pubblichiamo sempre link avvolti MFP /extractor/video per DLHD on-demand
                    // (Branch FAST completamente eliminato - vedi ON-DEMAND mode)
                    if ((channel as any)._dynamic && Array.isArray((channel as any).dynamicDUrls) && (channel as any).dynamicDUrls.length) {
                        debugLog(`[DynamicStreams][ON-DEMAND] mode attiva (link DLHD avvolti con extractor) canale=${channel.id}`);
                        const startDyn = Date.now();
                        let entries: { url: string; title?: string }[] = (channel as any).dynamicDUrls.map((e: any) => ({
                            url: e.url,
                            title: (e.title || 'Stream').replace(/^\s*\[(FAST|Player Esterno)\]\s*/i, '').trim()
                        }));

                        // === ESENZIONE P🐽D DAL CAP: estrai P🐽D PRIMA del tiering per priorità assoluta ===
                        const pdStreams: typeof entries = [];
                        const nonPdStreams: typeof entries = [];
                        for (const e of entries) {
                            if (/\[P🐽D\]/i.test(e.title || '')) {
                                pdStreams.push(e);
                            } else {
                                nonPdStreams.push(e);
                            }
                        }
                        entries = nonPdStreams; // Applica CAP solo ai non-P🐽D
                        debugLog(`[DynamicStreams][ON-DEMAND] P🐽D separati: ${pdStreams.length} stream P🐽D, ${entries.length} altri`);

                        const maxConcRaw = parseInt(process.env.DYNAMIC_EXTRACTOR_CONC || '10', 10);
                        const CAP = Math.min(Math.max(1, isNaN(maxConcRaw) ? 10 : maxConcRaw), 50);
                        let extraFast: { url: string; title?: string }[] = [];
                        if (entries.length > CAP) {
                            // Tiered priority: tier1 strictly (it|ita|italy) first, then tier2 broader providers, then rest
                            const tier1Regex = /\b(it|ita|italy|italia)\b/i;
                            // Aggiunto vavoo per evitare esclusione dal CAP
                            const tier2Regex = /\b(italian|italiano|sky|tnt|amazon|dazn|eurosport|prime|bein|canal|sportitalia|now|rai|vavoo)\b/i;
                            const tier1: typeof entries = [];
                            const tier2: typeof entries = [];
                            const others: typeof entries = [];
                            for (const e of entries) {
                                const t = (e.title || '').toLowerCase();
                                if (tier1Regex.test(t)) tier1.push(e);
                                else if (tier2Regex.test(t)) tier2.push(e);
                                else others.push(e);
                            }
                            const ordered = [...tier1, ...tier2, ...others];
                            entries = ordered.slice(0, CAP);
                            extraFast = ordered.slice(CAP); // fallback direct for remaining
                            debugLog(`[DynamicStreams][ON-DEMAND] cap ${CAP} applied tier1=${tier1.length} tier2=${tier2.length} extraFast=${extraFast.length} total=${(channel as any).dynamicDUrls.length}`);
                        }
                        const resolved: { url: string; title: string }[] = [];
                        const providerTitlesExt: string[] = [];
                        const itaRegex = /\b(it|ita|italy|italia|italian|italiano)$/i;

                        // NUOVA LOGICA: costruiamo direttamente URL /proxy/hls/manifest.m3u8?api_password=X&d=URL_DLHD
                        for (const d of entries) {
                            if (!d || !d.url) continue;

                            // SKIP placeholder Vavoo (verranno gestiti separatamente dalla logica Vavoo sopra)
                            if (d.url.startsWith('vavoo://')) {
                                debugLog(`[DynamicStreams][ON-DEMAND] SKIP placeholder Vavoo: ${d.url}`);
                                continue;
                            }

                            let providerTitle = (d.title || 'Stream').trim().replace(/^\((.*)\)$/, '$1').trim();
                            providerTitlesExt.push(providerTitle);
                            if (itaRegex.test(providerTitle) && !providerTitle.startsWith('🇮🇹')) providerTitle = `🇮🇹 ${providerTitle}`;

                            // Costruiamo direttamente il link proxy/hls (NIENTE extractor, NIENTE redirect)
                            if (mfpUrl) {
                                const passwordParam = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';
                                const finalUrl = `${mfpUrl}/proxy/hls/manifest.m3u8?${passwordParam}d=${encodeURIComponent(d.url)}`;
                                resolved.push({ url: finalUrl, title: providerTitle });
                                debugLog(`[DynamicStreams][ON-DEMAND] Link DLHD diretto proxy/hls: ${providerTitle} -> ${finalUrl}`);
                            } else {
                                // Niente MFP URL
                                // Se è un canale PPV o l'URL è già un proxy, lo permettiamo diretto
                                if (d.url.includes('/proxy/') || (channel as any).id.startsWith('ppv_')) {
                                    resolved.push({ url: d.url, title: providerTitle });
                                    debugLog(`[DynamicStreams][ON-DEMAND] MFP mancante, ma URL proxy/PPV consentito diretto: ${providerTitle}`);
                                } else {
                                    // Niente MFP = skip (come richiesto per evitare link diretti DLHD)
                                    debugLog(`[DynamicStreams][ON-DEMAND] MFP mancante, skip link DLHD: ${providerTitle}`);
                                }
                            }
                        }

                        resolved.sort((a, b) => {
                            const itaA = a.title.startsWith('🇮🇹') ? 0 : 1;
                            const itaB = b.title.startsWith('🇮🇹') ? 0 : 1;
                            if (itaA !== itaB) return itaA - itaB;
                            return a.title.localeCompare(b.title);
                        });

                        // === P🐽D: Processa SENZA CAP, aggiungi in TESTA (priorità assoluta) ===
                        const pdResolved: { url: string; title: string }[] = [];
                        for (const pd of pdStreams) {
                            if (!pd || !pd.url) continue;
                            // SKIP placeholder Vavoo (anche se teoricamente P🐽D non dovrebbero essere vavoo://)
                            if (pd.url.startsWith('vavoo://')) {
                                debugLog(`[P🐽D][ON-DEMAND] SKIP placeholder Vavoo: ${pd.url}`);
                                continue;
                            }

                            let providerTitle = (pd.title || 'Stream').trim();
                            // Costruiamo direttamente il link proxy/hls (NIENTE extractor)
                            if (mfpUrl) {
                                const passwordParam = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';
                                const finalUrl = `${mfpUrl}/proxy/hls/manifest.m3u8?${passwordParam}d=${encodeURIComponent(pd.url)}`;
                                pdResolved.push({ url: finalUrl, title: providerTitle });
                                debugLog(`[P🐽D][ON-DEMAND] Link P🐽D diretto proxy/hls: ${providerTitle} -> ${finalUrl}`);
                            } else {
                                debugLog(`[P🐽D][ON-DEMAND] MFP URL mancante, skip link P🐽D: ${providerTitle}`);
                            }
                        }
                        // Aggiungi P🐽D in TESTA (unshift = priorità massima)
                        for (const pd of pdResolved) streams.unshift(pd);
                        debugLog(`[P🐽D][ON-DEMAND] Aggiunti ${pdResolved.length} stream P🐽D in TESTA (esenzione CAP)`);

                        // Aggiungiamo tutti i link risolti DLHD (già avvolti con proxy/hls)
                        for (const r of resolved) streams.push(r);

                        // === Freeshot (iniezione DOPO DLHD resolved, PRIMA dei leftover) ===
                        try {
                            const { resolveFreeshotForChannel, getFreeshotCode } = await import('./extractors/freeshotRuntime');
                            const reqObj: any = (global as any).lastExpressRequest;
                            const clientIp = getClientIpFromReq(reqObj);

                            let frUrl: string | undefined;
                            let frName = (channel as any).name || 'Canale';
                            let frError: string | undefined;

                            // Se abbiamo MFP, usiamo la risoluzione lato proxy (Server-Side Resolution)
                            // Questo risolve il problema dell'IP mismatch: il proxy genera il token e lo usa.
                            if (mfpUrl) {
                                const match = getFreeshotCode({ id: (channel as any).id, name: (channel as any).name, epgChannelIds: (channel as any).epgChannelIds, extraTexts: providerTitlesExt });
                                if (match) {
                                    const { code } = match;
                                    // Costruiamo l'URL che il proxy dovrà risolvere
                                    const popcdnUrl = `https://popcdn.day/go.php?stream=${encodeURIComponent(code)}`;

                                    // Aggiungiamo parametro filename fittizio per far generare un URL .m3u8 al formatMediaFlowUrl
                                    const popcdnUrlWithFilename = `${popcdnUrl}&filename=manifest.m3u8`;

                                    // Avvolgiamo in MFP
                                    frUrl = formatMediaFlowUrl(popcdnUrlWithFilename, mfpUrl, mfpPsw || '');

                                    // Forziamo endpoint HLS per compatibilità player
                                    if (frUrl.includes('/proxy/stream/')) {
                                        frUrl = frUrl.replace('/proxy/stream/', '/proxy/hls/');
                                    }

                                    debugLog(`Freeshot (Proxy-Side) aggiunto per ${frName}: ${frUrl}`);
                                }
                            } else {
                                // Fallback: risoluzione locale (funziona solo se Addon e Player sono sullo stesso IP)
                                const fr = await resolveFreeshotForChannel({ id: (channel as any).id, name: (channel as any).name, epgChannelIds: (channel as any).epgChannelIds, extraTexts: providerTitlesExt }, clientIp || undefined);
                                if (fr && fr.url && !fr.error) {
                                    frUrl = fr.url;
                                    frName = (fr as any).displayName || frName;
                                    debugLog(`Freeshot (Local) aggiunto per ${frName}: ${frUrl}`);
                                } else if (fr && fr.error) {
                                    frError = fr.error;
                                }
                            }

                            if (frUrl) {
                                streams.push({
                                    url: frUrl,
                                    title: `[🏟 Free] ${frName} [ITA]`
                                });
                            } else if (frError) {
                                debugLog(`Freeshot errore ${channel.name}: ${frError}`);
                            }
                        } catch (e) {
                            debugLog(`Freeshot import/fetch fallito: ${e}`);
                        }

                        // === INJECTION GENERICO staticUrlMpd (come Vavoo) - Posizione #4 dopo Freeshot ===
                        try {
                            const mpdInjectedChannels = new Set<string>(); // Track per evitare duplicati

                            // Loop su TUTTI i canali statici con staticUrlMpd
                            for (const staticCh of staticBaseChannels) {
                                if (!staticCh || !staticCh.staticUrlMpd) continue;
                                if (mpdInjectedChannels.has(staticCh.id)) continue; // Skip già iniettati

                                const aliases = staticCh.vavooNames || [staticCh.name];

                                // Match fuzzy (come Vavoo)
                                let matched = false;
                                for (const alias of aliases) {
                                    if (matched) break;
                                    const normalizedAlias = normAlias(alias);

                                    const matches = providerTitlesExt.some((pt: string) => {
                                        const normalizedProvider = normAlias(pt);
                                        return normalizedProvider.includes(normalizedAlias) || normalizedAlias.includes(normalizedProvider);
                                    });

                                    if (matches) {
                                        // TROVATO! Inietta MPD (legge SEMPRE da staticBaseChannels fresh)
                                        try {
                                            const decodedUrl = decodeStaticUrl(staticCh.staticUrlMpd);
                                            let finalUrl = decodedUrl;
                                            let proxyUsed = false;

                                            if (mfpUrl) {
                                                const urlParts = decodedUrl.split('&');
                                                const baseUrl = urlParts[0];
                                                const additionalParams = urlParts.slice(1);
                                                const passwordParam = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';
                                                finalUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?${passwordParam}d=${encodeURIComponent(baseUrl)}`;
                                                for (const param of additionalParams) if (param) finalUrl += `&${param}`;
                                                proxyUsed = true;
                                            }

                                            const title = `${proxyUsed ? '' : '[❌Proxy]'}[🎬MPD] ${staticCh.name} [ITA]`;

                                            // Inserisce in posizione #4: dopo Vavoo Clean, D_CF, Freeshot
                                            let insertAt = 0;
                                            try {
                                                while (insertAt < streams.length && /(\(Vavoo🔓\))/i.test(streams[insertAt].title)) insertAt++;
                                                while (insertAt < streams.length && /🇮🇹🔄/i.test(streams[insertAt].title)) insertAt++;
                                                while (insertAt < streams.length && /\[🏟\s*Free\]/i.test(streams[insertAt].title)) insertAt++;
                                            } catch { }

                                            try {
                                                streams.splice(insertAt, 0, { url: finalUrl, title });
                                            } catch {
                                                streams.push({ url: finalUrl, title });
                                            }

                                            mpdInjectedChannels.add(staticCh.id);
                                            matched = true;
                                            console.log(`✅ [MPD] Injected ${staticCh.name} (matched alias: ${alias}) for dynamic event`);
                                        } catch (injectErr) {
                                            debugLog(`[MPD] Injection failed for ${staticCh.name}:`, injectErr);
                                        }
                                    }
                                }
                            }

                            if (mpdInjectedChannels.size > 0) {
                                console.log(`✅ [MPD] Total injected: ${mpdInjectedChannels.size} channels with staticUrlMpd`);
                            }
                        } catch (e) {
                            console.error('[MPD] Injection error:', (e as any)?.message || e);
                        }

                        // === INJECTION staticUrlMpd2 (RM - 🎬MPD2) - Posizione #5 dopo MPD ===
                        try {
                            const mpd2InjectedChannels = new Set<string>();

                            // Loop su TUTTI i canali statici con staticUrlMpd2
                            for (const staticCh of staticBaseChannels) {
                                if (!staticCh || !staticCh.staticUrlMpd2) continue;
                                if (mpd2InjectedChannels.has(staticCh.id)) continue;

                                const aliases = staticCh.vavooNames || [staticCh.name];

                                // Match fuzzy (come MPD)
                                let matched = false;
                                for (const alias of aliases) {
                                    if (matched) break;
                                    const normalizedAlias = normAlias(alias);

                                    const matches = providerTitlesExt.some((pt: string) => {
                                        const normalizedProvider = normAlias(pt);
                                        return normalizedProvider.includes(normalizedAlias) || normalizedAlias.includes(normalizedProvider);
                                    });

                                    if (matches) {
                                        try {
                                            const decodedUrl = decodeStaticUrl(staticCh.staticUrlMpd2);
                                            let finalUrl = decodedUrl;
                                            let proxyUsed = false;

                                            if (mfpUrl) {
                                                const urlParts = decodedUrl.split('&');
                                                const baseUrl = urlParts[0];
                                                const additionalParams = urlParts.slice(1);
                                                const passwordParam = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';
                                                finalUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?${passwordParam}d=${encodeURIComponent(baseUrl)}`;
                                                for (const param of additionalParams) if (param) finalUrl += `&${param}`;
                                                proxyUsed = true;
                                            }

                                            const title = `${proxyUsed ? '' : '[❌Proxy]'}[🎬MPD2] ${staticCh.name} [ITA]`;

                                            // Inserisce in posizione #5: dopo MPD
                                            let insertAt = 0;
                                            try {
                                                while (insertAt < streams.length && /(\(Vavoo🔓\))/i.test(streams[insertAt].title)) insertAt++;
                                                while (insertAt < streams.length && /🇮🇹🔄/i.test(streams[insertAt].title)) insertAt++;
                                                while (insertAt < streams.length && /\[🏟\s*Free\]/i.test(streams[insertAt].title)) insertAt++;
                                                while (insertAt < streams.length && /\[🎬MPD\]/i.test(streams[insertAt].title)) insertAt++;
                                            } catch { }

                                            try {
                                                streams.splice(insertAt, 0, { url: finalUrl, title });
                                            } catch {
                                                streams.push({ url: finalUrl, title });
                                            }

                                            mpd2InjectedChannels.add(staticCh.id);
                                            matched = true;
                                            console.log(`✅ [MPD2] Injected ${staticCh.name} (matched alias: ${alias}) - RM source`);
                                        } catch (injectErr) {
                                            debugLog(`[MPD2] Injection failed for ${staticCh.name}:`, injectErr);
                                        }
                                    }
                                }
                            }

                            if (mpd2InjectedChannels.size > 0) {
                                console.log(`✅ [MPD2] Total injected: ${mpd2InjectedChannels.size} channels with staticUrlMpd2 (RM)`);
                            }
                        } catch (e) {
                            console.error('[MPD2] Injection error:', (e as any)?.message || e);
                        }

                        // === INJECTION staticUrlMpdz ( - 🎬MPDz) - Posizione #6 dopo MPD2 ===
                        try {
                            const mpdzInjectedChannels = new Set<string>();

                            for (const staticCh of staticBaseChannels) {
                                if (!staticCh || !(staticCh as any).staticUrlMpdz) continue;
                                if (mpdzInjectedChannels.has(staticCh.id)) continue;

                                const aliases = staticCh.vavooNames || [staticCh.name];

                                let matched = false;
                                for (const alias of aliases) {
                                    if (matched) break;
                                    const normalizedAlias = normAlias(alias);

                                    const matches = providerTitlesExt.some((pt: string) => {
                                        const normalizedProvider = normAlias(pt);
                                        return normalizedProvider.includes(normalizedAlias) || normalizedAlias.includes(normalizedProvider);
                                    });

                                    if (matches) {
                                        try {
                                            const decodedUrl = decodeStaticUrl((staticCh as any).staticUrlMpdz);
                                            let finalUrl = decodedUrl;
                                            let proxyUsed = false;

                                            if (mfpUrl) {
                                                const urlParts = decodedUrl.split('&');
                                                const baseUrl = urlParts[0];
                                                const additionalParams = urlParts.slice(1);
                                                const passwordParam = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';
                                                finalUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?${passwordParam}d=${encodeURIComponent(baseUrl)}`;
                                                for (const param of additionalParams) if (param) finalUrl += `&${param}`;
                                                proxyUsed = true;
                                            }

                                            const title = `${proxyUsed ? '' : '[❌Proxy]'}[🎬MPDz] ${staticCh.name} [ITA]`;

                                            let insertAt = 0;
                                            try {
                                                while (insertAt < streams.length && /(\(Vavoo🔓\))/i.test(streams[insertAt].title)) insertAt++;
                                                while (insertAt < streams.length && /🇮🇹🔄/i.test(streams[insertAt].title)) insertAt++;
                                                while (insertAt < streams.length && /\[🏟\s*Free\]/i.test(streams[insertAt].title)) insertAt++;
                                                while (insertAt < streams.length && /\[🎬MPD\]/i.test(streams[insertAt].title)) insertAt++;
                                                while (insertAt < streams.length && /\[🎬MPD2\]/i.test(streams[insertAt].title)) insertAt++;
                                            } catch { }

                                            try {
                                                streams.splice(insertAt, 0, { url: finalUrl, title });
                                            } catch {
                                                streams.push({ url: finalUrl, title });
                                            }

                                            mpdzInjectedChannels.add(staticCh.id);
                                            matched = true;
                                            console.log(`✅ [MPDz] Injected ${staticCh.name} (matched alias: ${alias}) -  source`);
                                        } catch (injectErr) {
                                            debugLog(`[MPDz] Injection failed for ${staticCh.name}:`, injectErr);
                                        }
                                    }
                                }
                            }

                            if (mpdzInjectedChannels.size > 0) {
                                console.log(`✅ [MPDz] Total injected: ${mpdzInjectedChannels.size} channels with staticUrlMpdz ()`);
                            }
                        } catch (e) {
                            console.error('[MPDz] Injection error:', (e as any)?.message || e);
                        }

                        // === INJECTION staticUrlMpdx ( - 🎬MPDx) - Posizione #7 dopo MPDz ===
                        try {
                            const mpdxInjectedChannels = new Set<string>();

                            for (const staticCh of staticBaseChannels) {
                                if (!staticCh || !(staticCh as any).staticUrlMpdx) continue;
                                if (mpdxInjectedChannels.has(staticCh.id)) continue;

                                const aliases = staticCh.vavooNames || [staticCh.name];

                                let matched = false;
                                for (const alias of aliases) {
                                    if (matched) break;
                                    const normalizedAlias = normAlias(alias);

                                    const matches = providerTitlesExt.some((pt: string) => {
                                        const normalizedProvider = normAlias(pt);
                                        return normalizedProvider.includes(normalizedAlias) || normalizedAlias.includes(normalizedProvider);
                                    });

                                    if (matches) {
                                        try {
                                            const decodedUrl = decodeStaticUrl((staticCh as any).staticUrlMpdx);
                                            let finalUrl = decodedUrl;
                                            let proxyUsed = false;

                                            if (mfpUrl) {
                                                const urlParts = decodedUrl.split('&');
                                                const baseUrl = urlParts[0];
                                                const additionalParams = urlParts.slice(1);
                                                const passwordParam = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';
                                                finalUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?${passwordParam}d=${encodeURIComponent(baseUrl)}`;
                                                for (const param of additionalParams) if (param) finalUrl += `&${param}`;
                                                proxyUsed = true;
                                            }

                                            const title = `${proxyUsed ? '' : '[❌Proxy]'}[🎬MPDx] ${staticCh.name} [ITA]`;

                                            let insertAt = 0;
                                            try {
                                                while (insertAt < streams.length && /(\(Vavoo🔓\))/i.test(streams[insertAt].title)) insertAt++;
                                                while (insertAt < streams.length && /🇮🇹🔄/i.test(streams[insertAt].title)) insertAt++;
                                                while (insertAt < streams.length && /\[🏟\s*Free\]/i.test(streams[insertAt].title)) insertAt++;
                                                while (insertAt < streams.length && /\[🎬MPD\]/i.test(streams[insertAt].title)) insertAt++;
                                                while (insertAt < streams.length && /\[🎬MPD2\]/i.test(streams[insertAt].title)) insertAt++;
                                                while (insertAt < streams.length && /\[🎬MPDz\]/i.test(streams[insertAt].title)) insertAt++;
                                            } catch { }

                                            try {
                                                streams.splice(insertAt, 0, { url: finalUrl, title });
                                            } catch {
                                                streams.push({ url: finalUrl, title });
                                            }

                                            mpdxInjectedChannels.add(staticCh.id);
                                            matched = true;
                                            console.log(`✅ [MPDx] Injected ${staticCh.name} (matched alias: ${alias}) -  source`);
                                        } catch (injectErr) {
                                            debugLog(`[MPDx] Injection failed for ${staticCh.name}:`, injectErr);
                                        }
                                    }
                                }
                            }

                            if (mpdxInjectedChannels.size > 0) {
                                console.log(`✅ [MPDx] Total injected: ${mpdxInjectedChannels.size} channels with staticUrlMpdx ()`);
                            }
                        } catch (e) {
                            console.error('[MPDx] Injection error:', (e as any)?.message || e);
                        }


                        // (Normalizzazione CF rimossa: ora pubblichiamo link avvolti con extractor on-demand)
                        // Append leftover entries (beyond CAP) con stessa logica on-demand (proxy/hls diretto)
                        if (extraFast.length && mfpUrl) {
                            const leftoversToShow = CAP === 1 ? extraFast.slice(0, 1) : extraFast;
                            let appended = 0;
                            for (const e of leftoversToShow) {
                                if (!e || !e.url) continue;
                                let t = (e.title || 'Stream').trim();
                                if (!t) t = 'Stream';
                                t = t.replace(/^\s*\[(FAST|Player Esterno)\]\s*/i, '').trim();
                                // NON aggiungiamo più [Player Esterno]: tutti i daddy ora usano proxy/hls
                                // Costruiamo direttamente proxy/hls (NIENTE extractor)
                                const passwordParam = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';
                                const finalUrl = `${mfpUrl}/proxy/hls/manifest.m3u8?${passwordParam}d=${encodeURIComponent(e.url)}`;
                                streams.push({ url: finalUrl, title: t });
                                appended++;
                            }
                            debugLog(`[DynamicStreams][ON-DEMAND] appended ${appended}/${extraFast.length} leftover proxy/hls diretti (CAP=${CAP})`);
                        }
                        debugLog(`[DynamicStreams][ON-DEMAND] Pubblicati ${resolved.length}/${entries.length} link avvolti MFP in ${Date.now() - startDyn}ms`);
                        // Filtro minimale senza MFP: rimuovi solo gli URL diretti dlhd.dad (duplicati CF restano)
                        if (!mfpUrl) {
                            const beforeExt = streams.length;
                            for (let i = streams.length - 1; i >= 0; i--) {
                                if (/^https?:\/\/dlhd\.dad\/watch\.php\?id=\d+/i.test(streams[i].url)) streams.splice(i, 1);
                            }
                            if (beforeExt !== streams.length) debugLog(`[DynamicStreams][EXTRACTOR][NO_MFP] rimossi ${beforeExt - streams.length} dlhd.dad, rimasti=${streams.length}`);
                        }
                        // === GDPLAYER injection for dynamic (EXTRACTOR) dopo PD/Vavoo ===
                        try {
                            const enableGdPlayer = /^(1|true|on)$/i.test(String(process?.env?.GDPLAYER_ENABLE || ''));
                            if (enableGdPlayer && mfpUrl) { // richiede MFP URL
                                const logEnabled = /^(1|true|on)$/i.test(String(process?.env?.GDPLAYER_LOG || '1'));
                                // Popola extraTexts con providerTitles extractor se mancante
                                if (!(channel as any).extraTexts || !Array.isArray((channel as any).extraTexts)) {
                                    (channel as any).extraTexts = providerTitlesExt;
                                } else {
                                    const set = new Set<string>((channel as any).extraTexts);
                                    for (const pt of providerTitlesExt) set.add(pt);
                                    (channel as any).extraTexts = Array.from(set);
                                }
                                const inferredSlug = inferGdplayerSlug(channel as any);
                                if (inferredSlug) {
                                    try {
                                        const gd = await resolveGdplayerForChannel(channel as any, { mfpUrl: mfpUrl, mfpPassword: mfpPsw });
                                        if (gd && gd.url && !gd.error) {
                                            const finalUrl = gd.wrappedUrl || gd.url;
                                            const cleanName = gdDisplayNameFromSlug(gd.slug) || channel.name;
                                            const title = `[🌐Gd] ${cleanName} [ITA]`;
                                            let insertAt = 0;
                                            while (insertAt < streams.length) {
                                                const t = streams[insertAt].title || '';
                                                if (/^\[P🐽D]/i.test(t) || /Vavoo/i.test(t)) insertAt++; else break;
                                            }
                                            streams.splice(insertAt, 0, { url: finalUrl, title });
                                            // Sintesi D_CF dinamico dal code GD se non presente (richiede GDPLAYER_ENABLE per GD + DCF_ENABLE per D_CF)
                                            try {
                                                const enableGdPlayer = /^(1|true|on)$/i.test(String(process?.env?.GDPLAYER_ENABLE || ''));
                                                const enableDcf = /^(1|true|on)$/i.test(String(process?.env?.DCF_ENABLE || ''));
                                                if (enableGdPlayer && enableDcf && gd.code && !(channel as any).staticUrlD_CF && /^\d+$/.test(gd.code)) {
                                                    // Costruisci addonBaseUrl dalla richiesta corrente
                                                    let addonBaseUrl = '';
                                                    try {
                                                        const lastReq: any = (global as any).lastExpressRequest;
                                                        if (lastReq) {
                                                            const protocol = lastReq.protocol || 'https';
                                                            const host = lastReq.get('host') || lastReq.headers?.host || '';
                                                            if (host) addonBaseUrl = `${protocol}://${host}`;
                                                        }
                                                    } catch { }
                                                    (channel as any).staticUrlD_CF = buildCfProxyFromId(gd.code, addonBaseUrl);
                                                    debugLog(`[DynamicStreams][D_CF] sintetizzato da GD code=${gd.code} base=${addonBaseUrl} (EXTRACTOR)`);
                                                }
                                            } catch (e) {
                                                const errorMsg = (e as any)?.message || String(e);
                                                console.error(`[DLHD][FAIL][SYNTHESIS-GD-EXTRACTOR] Canale: ${channel.name || 'N/A'} | GD code: ${gd.code || 'N/A'} | Errore: ${errorMsg}`);
                                            }
                                        }
                                    } catch {/* silent */ }
                                }
                            }
                        } catch { }
                        // === ORDINAMENTO FINALE STREAM DINAMICI (EXTRACTOR) ===
                        try {
                            if (streams.length > 1) {
                                sortStreamsByPriority(streams);
                                debugLog(`[DynamicStreams][EXTRACTOR] Stream ordinati per priorità: ${streams.length} totali`);
                            }
                        } catch (sortErr) {
                            debugLog(`[DynamicStreams][EXTRACTOR] Errore ordinamento:`, String((sortErr as any)?.message || sortErr));
                        }
                        dynamicHandled = true;
                    } else if ((channel as any)._dynamic) {
                        // Dynamic channel ma senza dynamicDUrls -> placeholder stream
                        // Prova comunque GD per sintetizzare eventuale D_CF (richiede GDPLAYER_ENABLE per GD + DCF_ENABLE per D_CF)
                        try {
                            const enableGdPlayer = /^(1|true|on)$/i.test(String(process?.env?.GDPLAYER_ENABLE || ''));
                            const enableDcf = /^(1|true|on)$/i.test(String(process?.env?.DCF_ENABLE || ''));
                            if (enableGdPlayer && enableDcf && mfpUrl) {
                                const gd = await resolveGdplayerForChannel(channel as any, { mfpUrl: mfpUrl, mfpPassword: mfpPsw });
                                if (gd && gd.code && !(channel as any).staticUrlD_CF && /^\d+$/.test(gd.code)) {
                                    // Costruisci addonBaseUrl dalla richiesta corrente
                                    let addonBaseUrl = '';
                                    try {
                                        const lastReq: any = (global as any).lastExpressRequest;
                                        if (lastReq) {
                                            const protocol = lastReq.protocol || 'https';
                                            const host = lastReq.get('host') || lastReq.headers?.host || '';
                                            if (host) addonBaseUrl = `${protocol}://${host}`;
                                        }
                                    } catch { }
                                    (channel as any).staticUrlD_CF = buildCfProxyFromId(gd.code, addonBaseUrl);
                                    debugLog(`[DynamicStreams][D_CF] sintetizzato da GD code=${gd.code} base=${addonBaseUrl} (PLACEHOLDER)`);
                                }
                            }
                        } catch (e) {
                            const errorMsg = (e as any)?.message || String(e);
                            console.error(`[DLHD][FAIL][SYNTHESIS-GD-PLACEHOLDER] Canale: ${channel.name || 'N/A'} | Errore: ${errorMsg}`);
                        }
                        streams.push({ url: (channel as any).placeholderVideo || (channel as any).logo || (channel as any).poster || '', title: 'Nessuno Stream' });
                        dynamicHandled = true;
                    } else {
                        // staticUrlF: Direct for non-dynamic
                        // pdUrlF: nuovo flusso provider [PD] (derivato da playlist) da mostrare sempre se presente
                        if ((channel as any).pdUrlF) {
                            try {
                                const pdUrl = (channel as any).pdUrlF;
                                if (pdUrl && !streams.some(s => s.url === pdUrl)) {
                                    const pdStream = { url: pdUrl, title: `[P🐽D] ${channel.name}` };
                                    // Se il primo è già un GD, inserisci dopo, altrimenti in testa
                                    if (streams.length && /^\[Gd\]/i.test(streams[0].title)) streams.splice(1, 0, pdStream); else streams.unshift(pdStream);
                                    debugLog(`Aggiunto pdUrlF Direct: ${pdUrl}`);
                                }
                            } catch (e) {
                                debugLog('Errore aggiunta pdUrlF', (e as any)?.message || e);
                            }
                        }
                        if ((channel as any).staticUrlF) {
                            const originalF = (channel as any).staticUrlF;
                            const nameLower = (channel.name || '').toLowerCase().trim();
                            const raiMpdSet = new Set(['']); // Solo questi devono passare da proxy MPD before 'rai 1','rai 2','rai 3'
                            // Altri canali RAI (4,5,Movie,Premium, ecc.) restano DIRECT (niente proxy HLS come richiesto)
                            let finalFUrl = originalF;
                            if (mfpUrl && raiMpdSet.has(nameLower)) {
                                if (!originalF.startsWith(mfpUrl)) {
                                    const passwordParamRai = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';
                                    finalFUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?${passwordParamRai}d=${encodeURIComponent(originalF)}`;
                                }
                            }
                            streams.push({
                                url: finalFUrl,
                                title: `[🌍dTV] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrlF ${finalFUrl === originalF ? 'Direct' : 'Proxy(MPD)'}: ${finalFUrl}`);
                        }

                        // --- FREESHOT per canali statici ---
                        try {
                            const { resolveFreeshotForChannel, getFreeshotCode } = await import('./extractors/freeshotRuntime');
                            const reqObj: any = (global as any).lastExpressRequest;
                            const clientIp = getClientIpFromReq(reqObj);

                            let frUrl: string | undefined;
                            let frName = (channel as any).name || 'Canale';
                            let frError: string | undefined;

                            // Proxy-Side Resolution (se MFP attivo)
                            if (mfpUrl) {
                                const match = getFreeshotCode({
                                    id: (channel as any).id,
                                    name: (channel as any).name,
                                    epgChannelIds: (channel as any).epgChannelIds,
                                    extraTexts: []
                                });
                                if (match) {
                                    const { code } = match;
                                    const popcdnUrl = `https://popcdn.day/go.php?stream=${encodeURIComponent(code)}`;
                                    const popcdnUrlWithFilename = `${popcdnUrl}&filename=manifest.m3u8`;
                                    frUrl = formatMediaFlowUrl(popcdnUrlWithFilename, mfpUrl, mfpPsw || '');
                                    if (frUrl.includes('/proxy/stream/')) {
                                        frUrl = frUrl.replace('/proxy/stream/', '/proxy/hls/');
                                    }
                                    debugLog(`Freeshot (Proxy-Side Static) aggiunto per ${frName}: ${frUrl}`);
                                }
                            }

                            // Fallback Local Resolution (se MFP assente o getFreeshotCode fallito)
                            if (!frUrl) {
                                const fr = await resolveFreeshotForChannel({
                                    id: (channel as any).id,
                                    name: (channel as any).name,
                                    epgChannelIds: (channel as any).epgChannelIds,
                                    extraTexts: []
                                }, clientIp || undefined);

                                if (fr && fr.url && !fr.error) {
                                    frName = (fr as any).displayName || frName;
                                    frUrl = fr.url;
                                } else if (fr && fr.error) {
                                    frError = fr.error;
                                }
                            }

                            if (frUrl) {
                                streams.push({
                                    url: frUrl,
                                    title: `[🏟 Free] ${frName} [ITA]`
                                });
                            } else if (frError) {
                                debugLog(`Freeshot errore su canale statico ${channel.name}: ${frError}`);
                            }
                        } catch (e) {
                            debugLog('Freeshot import/fetch fallito per canale statico', (e as any)?.message || e);
                        }
                    }

                    // staticUrl (solo se enableMpd è attivo)
                    if ((channel as any).staticUrl && mpdEnabled) {
                        console.log(`🔧 [staticUrl] Raw URL: ${(channel as any).staticUrl}`);
                        const decodedUrl = decodeStaticUrl((channel as any).staticUrl);
                        console.log(`🔧 [staticUrl] Decoded URL: ${decodedUrl}`);
                        console.log(`🔧 [staticUrl] mfpUrl: ${mfpUrl}`);
                        console.log(`🔧 [staticUrl] mfpPsw: ${mfpPsw ? '***' : 'NOT SET'}`);

                        if (mfpUrl) {
                            // Parse l'URL decodificato per separare l'URL base dai parametri
                            const urlParts = decodedUrl.split('&');
                            const baseUrl = urlParts[0]; // Primo elemento è l'URL base
                            const additionalParams = urlParts.slice(1); // Resto sono i parametri aggiuntivi

                            // Costruisci l'URL del proxy con l'URL base nel parametro d
                            const passwordParam = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';
                            let proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?${passwordParam}d=${encodeURIComponent(baseUrl)}`;

                            // Aggiungi i parametri aggiuntivi (key_id, key, etc.) direttamente all'URL del proxy
                            for (const param of additionalParams) {
                                if (param) {
                                    proxyUrl += `&${param}`;
                                }
                            }

                            streams.push({
                                url: proxyUrl,
                                title: `[📺HD] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrl Proxy (MFP): ${proxyUrl}`);
                        } else {
                            // Richiesta: non mostrare stream senza proxy (titolo con [❌Proxy]) quando mancano credenziali MFP
                            debugLog(`(NASCONDI) staticUrl Direct senza MFP: ${decodedUrl}`);
                        }
                    }
                    // Inserimento ritardato stream GD statico (dopo PD/Vavoo/free)
                    if (gdStaticPending) {
                        try {
                            let insertAt = 0;
                            while (insertAt < streams.length) {
                                const t = streams[insertAt].title || '';
                                if (/^\[P🐽D]/i.test(t) || /Vavoo/i.test(t) || /\[🌍dTV]/i.test(t)) insertAt++; else break;
                            }
                            streams.splice(insertAt, 0, gdStaticPending);
                            const logEnabled = /^(1|true|on)$/i.test(String(process?.env?.GDPLAYER_LOG || '1'));
                            // (GD static inserted)
                        } catch { }
                    }
                    // staticUrl2 (solo se enableMpd è attivo)
                    if ((channel as any).staticUrl2 && mpdEnabled) {
                        console.log(`🔧 [staticUrl2] Raw URL: ${(channel as any).staticUrl2}`);
                        const decodedUrl = decodeStaticUrl((channel as any).staticUrl2);
                        console.log(`🔧 [staticUrl2] Decoded URL: ${decodedUrl}`);
                        console.log(`🔧 [staticUrl2] mfpUrl: ${mfpUrl}`);
                        console.log(`🔧 [staticUrl2] mfpPsw: ${mfpPsw ? '***' : 'NOT SET'}`);

                        if (mfpUrl) {
                            // Parse l'URL decodificato per separare l'URL base dai parametri
                            const urlParts = decodedUrl.split('&');
                            const baseUrl = urlParts[0]; // Primo elemento è l'URL base
                            const additionalParams = urlParts.slice(1); // Resto sono i parametri aggiuntivi

                            // Costruisci l'URL del proxy con l'URL base nel parametro d
                            const passwordParam = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';
                            let proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?${passwordParam}d=${encodeURIComponent(baseUrl)}`;

                            // Aggiungi i parametri aggiuntivi (key_id, key, etc.) direttamente all'URL del proxy
                            for (const param of additionalParams) {
                                if (param) {
                                    proxyUrl += `&${param}`;
                                }
                            }

                            streams.push({
                                url: proxyUrl,
                                title: `[📽️] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrl2 Proxy (MFP): ${proxyUrl}`);
                        } else {
                            // Richiesta: nascondere versione direct senza MFP
                            debugLog(`(NASCONDI) staticUrl2 Direct senza MFP: ${decodedUrl}`);
                        }
                    }

                    // staticUrlMpd (sempre attivo se presente, non dipende da enableMpd)
                    console.log(`🔧 [staticUrlMpd] DEBUG - channel has staticUrlMpd? ${!!(channel as any).staticUrlMpd}`);
                    if ((channel as any).staticUrlMpd) {
                        console.log(`🔧 [staticUrlMpd] Raw URL: ${(channel as any).staticUrlMpd}`);
                        const decodedUrl = decodeStaticUrl((channel as any).staticUrlMpd);
                        console.log(`🔧 [staticUrlMpd] Decoded URL: ${decodedUrl}`);
                        console.log(`🔧 [staticUrlMpd] mfpUrl: ${mfpUrl}`);
                        console.log(`🔧 [staticUrlMpd] mfpPsw: ${mfpPsw ? '***' : 'NOT SET'}`);

                        if (mfpUrl) {
                            // Parse l'URL decodificato per separare l'URL base dai parametri
                            const urlParts = decodedUrl.split('&');
                            const baseUrl = urlParts[0]; // Primo elemento è l'URL base
                            const additionalParams = urlParts.slice(1); // Resto sono i parametri aggiuntivi

                            // Costruisci l'URL del proxy con l'URL base nel parametro d
                            const passwordParam = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';
                            let proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?${passwordParam}d=${encodeURIComponent(baseUrl)}`;

                            // Aggiungi i parametri aggiuntivi (key_id, key, etc.) direttamente all'URL del proxy
                            for (const param of additionalParams) {
                                if (param) {
                                    proxyUrl += `&${param}`;
                                }
                            }

                            streams.push({
                                url: proxyUrl,
                                title: `[🎬MPD] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrlMpd Proxy (MFP): ${proxyUrl}`);
                        } else {
                            // Richiesta: nascondere versione direct senza MFP
                            debugLog(`(NASCONDI) staticUrlMpd Direct senza MFP: ${decodedUrl}`);
                        }
                    }

                    // staticUrlMpd2 (RM - seconda sorgente MPD)
                    console.log(`🔧 [staticUrlMpd2] DEBUG - channel has staticUrlMpd2? ${!!(channel as any).staticUrlMpd2}`);
                    if ((channel as any).staticUrlMpd2) {
                        console.log(`🔧 [staticUrlMpd2] Raw URL: ${(channel as any).staticUrlMpd2}`);
                        const decodedUrl2 = decodeStaticUrl((channel as any).staticUrlMpd2);
                        console.log(`🔧 [staticUrlMpd2] Decoded URL: ${decodedUrl2.substring(0, 100)}...`);

                        if (mfpUrl) {
                            const urlParts = decodedUrl2.split('&');
                            const baseUrl = urlParts[0];
                            const additionalParams = urlParts.slice(1);

                            const passwordParam = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';
                            let proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?${passwordParam}d=${encodeURIComponent(baseUrl)}`;

                            for (const param of additionalParams) {
                                if (param) {
                                    proxyUrl += `&${param}`;
                                }
                            }

                            streams.push({
                                url: proxyUrl,
                                title: `[🎬MPD2] ${channel.name} [ITA]`
                            });
                            console.log(`[DEBUG] Aggiunto staticUrlMpd2 Proxy (MFP): ${proxyUrl.substring(0, 150)}...`);
                        } else {
                            debugLog(`(NASCONDI) staticUrlMpd2 Direct senza MFP: ${decodedUrl2}`);
                        }
                    }

                    // staticUrlMpdz ()
                    if ((channel as any).staticUrlMpdz) {
                        const decodedUrlz = decodeStaticUrl((channel as any).staticUrlMpdz);

                        if (mfpUrl) {
                            const urlParts = decodedUrlz.split('&');
                            const baseUrl = urlParts[0];
                            const additionalParams = urlParts.slice(1);

                            const passwordParam = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';
                            let proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?${passwordParam}d=${encodeURIComponent(baseUrl)}`;

                            for (const param of additionalParams) {
                                if (param) {
                                    proxyUrl += `&${param}`;
                                }
                            }

                            streams.push({
                                url: proxyUrl,
                                title: `[🎬MPDz] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrlMpdz Proxy (MFP): ${proxyUrl.substring(0, 150)}...`);
                        } else {
                            debugLog(`(NASCONDI) staticUrlMpdz Direct senza MFP: ${decodedUrlz}`);
                        }
                    }

                    // staticUrlMpdx ()
                    if ((channel as any).staticUrlMpdx) {
                        const decodedUrlx = decodeStaticUrl((channel as any).staticUrlMpdx);

                        if (mfpUrl) {
                            const urlParts = decodedUrlx.split('&');
                            const baseUrl = urlParts[0];
                            const additionalParams = urlParts.slice(1);

                            const passwordParam = mfpPsw ? `api_password=${encodeURIComponent(mfpPsw)}&` : '';
                            let proxyUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?${passwordParam}d=${encodeURIComponent(baseUrl)}`;

                            for (const param of additionalParams) {
                                if (param) {
                                    proxyUrl += `&${param}`;
                                }
                            }

                            streams.push({
                                url: proxyUrl,
                                title: `[🎬MPDx] ${channel.name} [ITA]`
                            });
                            debugLog(`Aggiunto staticUrlMpdx Proxy (MFP): ${proxyUrl.substring(0, 150)}...`);
                        } else {
                            debugLog(`(NASCONDI) staticUrlMpdx Direct senza MFP: ${decodedUrlx}`);
                        }
                    }

                    // staticUrlD / staticUrlD_CF
                    // Richiesta: i canali D_CF devono essere SEMPRE visibili anche senza MFP (perché già proxy CF pronto)
                    // Formato titolo aggiornato: 🇮🇹🔄 <Nome>  (manteniamo [ITA] finale per coerenza)
                    // IMPORTANTE: Controllato da DCF_ENABLE (separato da GDPLAYER_ENABLE)
                    const enableDcf = /^(1|true|on)$/i.test(String(process?.env?.DCF_ENABLE || '1'));

                    // SINTESI D_CF PER DINAMICI: Se dinamico senza staticUrlD_CF, crea D_CF per TUTTI i link DLHD italiani presenti
                    if ((channel as any)._dynamic && enableDcf && !(channel as any).staticUrlD_CF && streams.length) {
                        try {
                            // Per canali dinamici, cerca PRIMA del wrapping MFP negli URL originali dynamicDUrls
                            const dlhdIds = new Set<string>();
                            const dlhdIdToTitle = new Map<string, string>(); // Mappa ID -> Nome provider originale

                            // Metodo 1: Cerca in dynamicDUrls (URL originali PRIMA del wrapping)
                            if ((channel as any).dynamicDUrls && Array.isArray((channel as any).dynamicDUrls)) {
                                for (const d of (channel as any).dynamicDUrls) {
                                    if (!d || !d.url) continue;

                                    // Cerca link DLHD diretti: https://dlhd.dad/watch.php?id=XXX
                                    const directMatch = d.url.match(/^https?:\/\/dlhd\.dad\/watch\.php\?id=(\d+)/i);
                                    if (directMatch && directMatch[1]) {
                                        // Verifica se è italiano controllando il titolo
                                        const isItalian = d.title && /🇮🇹|IT\s*$|\[ITA\]/i.test(d.title);
                                        if (isItalian) {
                                            const id = directMatch[1];
                                            dlhdIds.add(id);
                                            // Salva il nome provider originale (rimuovi emoji e [ITA])
                                            let providerName = (d.title || '').replace(/^🇮🇹\s*/, '').trim();
                                            providerName = providerName.replace(/\s*\[ITA\]\s*$/i, '').trim();
                                            dlhdIdToTitle.set(id, providerName);
                                            debugLog(`[DynamicStreams][D_CF][PRE-WRAP] Trovato DLHD italiano id=${id} title="${d.title}" -> providerName="${providerName}"`);
                                        }
                                    }
                                }
                            }

                            // Metodo 2 (fallback): Cerca negli stream già wrappati (meno affidabile)
                            if (dlhdIds.size === 0) {
                                const dlhdStreams = streams.filter(s => /^🇮🇹(?!🔄)/.test(s.title || '') && /^https?:\/\/.*proxy\/hls\/manifest\.m3u8.*[?&]d=.*dlhd\.dad.*id[=%](\d+)/i.test(s.url));
                                for (const dlhdStream of dlhdStreams) {
                                    const match = dlhdStream.url.match(/id[=%](\d+)/i);
                                    if (match && match[1]) {
                                        const id = match[1];
                                        dlhdIds.add(id);
                                        // Estrai nome dal titolo wrappato
                                        let providerName = (dlhdStream.title || '').replace(/^🇮🇹\s*/, '').trim();
                                        providerName = providerName.replace(/\s*\[ITA\]\s*$/i, '').trim();
                                        dlhdIdToTitle.set(id, providerName);
                                    }
                                }
                            }

                            if (dlhdIds.size > 0) {
                                // Costruisci addonBaseUrl dalla richiesta corrente
                                let addonBaseUrl = '';
                                try {
                                    const lastReq: any = (global as any).lastExpressRequest;
                                    if (lastReq) {
                                        const protocol = lastReq.protocol || 'https';
                                        const host = lastReq.get('host') || lastReq.headers?.host || '';
                                        if (host) addonBaseUrl = `${protocol}://${host}`;
                                    }
                                } catch { }

                                // Crea array di staticUrlD_CF per ogni ID con metadata
                                const dcfData: Array<{ url: string; id: string; providerName: string }> = [];
                                for (const id of dlhdIds) {
                                    dcfData.push({
                                        url: buildCfProxyFromId(id, addonBaseUrl),
                                        id,
                                        providerName: dlhdIdToTitle.get(id) || 'Canale'
                                    });
                                }

                                // Salva il primo come staticUrlD_CF (per compatibilità) e gli altri in un array separato
                                if (dcfData.length > 0) {
                                    (channel as any).staticUrlD_CF = dcfData[0].url;
                                    (channel as any)._dcfMeta = dcfData; // Salva TUTTI i metadata (incluso primo)
                                    if (dcfData.length > 1) {
                                        (channel as any)._extraD_CF = dcfData.slice(1).map(d => d.url);
                                    }
                                    debugLog(`[DynamicStreams][D_CF] sintetizzati ${dcfData.length} stream D_CF da DLHD ids=${Array.from(dlhdIds).join(',')} base=${addonBaseUrl}`);
                                }
                            }
                        } catch (e) {
                            const errorMsg = (e as any)?.message || String(e);
                            console.error(`[DLHD][FAIL][SYNTHESIS-STREAM] Canale: ${channel.name || 'N/A'} | ID: ${channel.id || 'N/A'} | Errore: ${errorMsg}`);
                            debugLog(`[DynamicStreams][D_CF] errore sintesi da stream DLHD:`, e);
                        }
                    }

                    if ((channel as any).staticUrlD_CF && enableDcf) {
                        try {
                            let cfUrl = (channel as any).staticUrlD_CF as string;

                            // Sostituisci placeholder {usableAddonBase} con l'URL reale dell'addon
                            if (cfUrl.includes('{usableAddonBase}')) {
                                let addonBaseUrl = '';

                                // Tentativo 1: Rilevamento automatico dalla richiesta corrente (PRIORITÀ MASSIMA)
                                try {
                                    const lastReq: any = (global as any).lastExpressRequest;
                                    if (lastReq) {
                                        const protocol = lastReq.protocol || 'https';
                                        const host = lastReq.get('host') || lastReq.headers?.host || '';
                                        if (host) {
                                            addonBaseUrl = `${protocol}://${host}`;
                                            debugLog(`[DLHD] addonBase rilevato automaticamente dalla richiesta: ${addonBaseUrl}`);
                                        }
                                    }
                                } catch (e) {
                                    debugLog(`[DLHD] Errore rilevamento automatico addonBase:`, e);
                                }

                                // Fallback 2: Variabile ambiente ADDON_BASE_URL
                                if (!addonBaseUrl) {
                                    const envBase = (process && process.env && process.env.ADDON_BASE_URL) ? String(process.env.ADDON_BASE_URL).trim() : '';
                                    if (envBase) {
                                        addonBaseUrl = envBase;
                                        debugLog(`[DLHD] addonBase da variabile ambiente: ${addonBaseUrl}`);
                                    }
                                }

                                // Fallback 3: Config runtime (landing page)
                                if (!addonBaseUrl) {
                                    const configBase = (config as any).addonBase || '';
                                    if (configBase) {
                                        addonBaseUrl = configBase;
                                        debugLog(`[DLHD] addonBase da config runtime: ${addonBaseUrl}`);
                                    }
                                }

                                // Fallback 4: Dominio pubblico default (come VixSrc)
                                if (!addonBaseUrl) {
                                    addonBaseUrl = 'https://streamvix.hayd.uk';
                                    console.log(`[DLHD] Fallback a dominio pubblico default: ${addonBaseUrl}`);
                                }

                                cfUrl = cfUrl.replace('{usableAddonBase}', addonBaseUrl.replace(/\/$/, ''));
                                debugLog(`[DLHD] Placeholder sostituito: {usableAddonBase} -> ${addonBaseUrl}`);
                            }

                            // Normalizza solo formati legacy
                            const legacyMatch = cfUrl.match(/manifest\.m3u8\?url=https?:\/\/dlhd\.dad\/watch\.php\?id=(\d+)/i);
                            if (legacyMatch) {
                                // Legacy format senza addonBase: usa proxy esterno
                                cfUrl = buildCfProxyFromId(legacyMatch[1]);
                            } else if (cfUrl.includes('proxy.stremio.dpdns.org')) {
                                // Legacy proxy esterno: normalizza se necessario
                                const id0 = extractDlhdIdFromCf(cfUrl);
                                if (id0) cfUrl = buildCfProxyFromId(id0);
                            }
                            // Altrimenti mantieni l'URL com'è (nuovo formato /dlhd.m3u8?src=...)

                            const newId = extractDlhdIdFromCf(cfUrl);
                            if (!newId) throw new Error('id non estratto da CF');

                            // Se dinamico ed esiste già CF ben formattato, salta (già inserito nel ramo dynamic)
                            const existingCfIndex = streams.findIndex(s => extractDlhdIdFromCf(s.url) === newId);

                            // Costruzione base name: usa metadata _dcfMeta se disponibile, altrimenti fallback
                            let baseName: string | undefined;
                            if ((channel as any)._dynamic) {
                                // NUOVO: Cerca il nome provider nei metadata salvati
                                if ((channel as any)._dcfMeta && Array.isArray((channel as any)._dcfMeta)) {
                                    const dcfMeta = (channel as any)._dcfMeta;
                                    const metaEntry = dcfMeta.find((m: any) => m.id === newId);
                                    if (metaEntry && metaEntry.providerName) {
                                        baseName = metaEntry.providerName;
                                        debugLog(`[D_CF][TITLE] Usando nome provider da metadata: "${baseName}" per id=${newId}`);
                                    }
                                }

                                // Fallback 1: prova stream GD
                                if (!baseName) {
                                    const gdStream = streams.find(s => /^\[🌐Gd\]\s+(.+?)\s+\[ITA\]/i.test(s.title || ''));
                                    if (gdStream) {
                                        const m = (gdStream.title || '').match(/^\[🌐Gd\]\s+(.+?)\s+\[ITA\]/i);
                                        if (m) baseName = m[1].trim();
                                    }
                                }
                                // Fallback 2: prova un diretto daddy ITA (titolo inizia 🇮🇹 ma non 🇮🇹🔄)
                                if (!baseName) {
                                    const directIt = streams.find(s => /^🇮🇹(?!🔄)/.test(s.title || '') && /^https?:\/\/dlhd\.dad\/watch\.php\?id=\d+/i.test(s.url));
                                    if (directIt) {
                                        // rimuovi emoji + spazi + [ITA]
                                        let t = (directIt.title || '').replace(/^🇮🇹\s*/, '').trim();
                                        t = t.replace(/\s*\[ITA\]\s*$/i, '').trim();
                                        baseName = t;
                                    }
                                }
                            }
                            if (!baseName) baseName = channel.name || 'Canale';
                            // Titolo richiesto con doppio spazio dopo la sequenza emoji
                            let finalTitle = `🇮🇹🔄  ${baseName}`;
                            if (!/\bITA\b/i.test(finalTitle)) finalTitle += ' [ITA]';

                            if ((channel as any)._dynamic) {
                                // Trova il PRIMO daddy italiano diretto (🇮🇹 ma NON 🇮🇹🔄)
                                let firstDaddyIdx = -1;
                                for (let i = 0; i < streams.length; i++) {
                                    const s = streams[i];
                                    if (!s) continue;
                                    // Match: URL daddy diretto E titolo inizia con 🇮🇹 ma NON 🇮🇹🔄
                                    if (/^https?:\/\/.*(?:dlhd\.dad\/watch\.php|proxy\/hls\/manifest\.m3u8.*dlhd\.dad)/i.test(s.url) &&
                                        /^🇮🇹(?!🔄)/.test(s.title || '')) {
                                        firstDaddyIdx = i;
                                        debugLog(`[D_CF][POS] Trovato primo daddy italiano all'indice ${i}: "${s.title}"`);
                                        break;
                                    }
                                }

                                // insertionIndex punta PRIMA del primo daddy (o 0 se non trovato)
                                const insertionIndex = firstDaddyIdx >= 0 ? firstDaddyIdx : 0;
                                debugLog(`[D_CF][POS] insertionIndex=${insertionIndex} (firstDaddyIdx=${firstDaddyIdx})`);

                                if (existingCfIndex !== -1) {
                                    // Aggiorna titolo e riposiziona se necessario
                                    const cfEntry = streams[existingCfIndex];
                                    cfEntry.title = finalTitle;
                                    if (existingCfIndex !== insertionIndex) {
                                        streams.splice(existingCfIndex, 1);
                                        // Adjust insertionIndex if removal shifts indices
                                        const adjIndex = existingCfIndex < insertionIndex ? insertionIndex - 1 : insertionIndex;
                                        streams.splice(adjIndex, 0, cfEntry);
                                        debugLog(`Aggiunto/Riposizionato D_CF dinamico id=${newId} da indice ${existingCfIndex} a ${adjIndex} (title='${finalTitle}')`);
                                    }
                                } else {
                                    const entry = { url: cfUrl, title: finalTitle };
                                    streams.splice(insertionIndex, 0, entry);
                                    debugLog(`Aggiunto D_CF dinamico id=${newId} all'indice ${insertionIndex} PRIMA dei daddy (title='${finalTitle}')`);
                                }

                                // NUOVO: Processa anche _extraD_CF (gli altri DLHD dello stesso canale dinamico)
                                if ((channel as any)._extraD_CF && Array.isArray((channel as any)._extraD_CF)) {
                                    const extraUrls = (channel as any)._extraD_CF as string[];
                                    // Inserisci subito dopo il primo D_CF appena inserito
                                    // Dopo splice sopra, il primo D_CF è a insertionIndex, quindi extra inizia a insertionIndex+1
                                    let currentInsertPos = insertionIndex + 1;

                                    for (const extraCfUrl of extraUrls) {
                                        try {
                                            let processedUrl = extraCfUrl;

                                            // Sostituisci placeholder se presente
                                            if (processedUrl.includes('{usableAddonBase}')) {
                                                let addonBaseUrl = '';
                                                try {
                                                    const lastReq: any = (global as any).lastExpressRequest;
                                                    if (lastReq) {
                                                        const protocol = lastReq.protocol || 'https';
                                                        const host = lastReq.get('host') || lastReq.headers?.host || '';
                                                        if (host) addonBaseUrl = `${protocol}://${host}`;
                                                    }
                                                } catch { }
                                                if (!addonBaseUrl) {
                                                    addonBaseUrl = (process && process.env && process.env.ADDON_BASE_URL) ? String(process.env.ADDON_BASE_URL).trim() : '';
                                                }
                                                if (!addonBaseUrl) {
                                                    addonBaseUrl = (config as any).addonBase || 'https://streamvix.hayd.uk';
                                                }
                                                processedUrl = processedUrl.replace('{usableAddonBase}', addonBaseUrl.replace(/\/$/, ''));
                                            }

                                            const extraId = extractDlhdIdFromCf(processedUrl);
                                            if (!extraId) continue;

                                            // Verifica se già esiste
                                            const existingExtraIdx = streams.findIndex(s => extractDlhdIdFromCf(s.url) === extraId);
                                            if (existingExtraIdx !== -1) continue; // Skip se già presente

                                            // Costruisci titolo usando metadata se disponibile
                                            let extraBaseName = baseName; // Fallback al nome generico
                                            if ((channel as any)._dcfMeta && Array.isArray((channel as any)._dcfMeta)) {
                                                const dcfMeta = (channel as any)._dcfMeta;
                                                const metaEntry = dcfMeta.find((m: any) => m.id === extraId);
                                                if (metaEntry && metaEntry.providerName) {
                                                    extraBaseName = metaEntry.providerName;
                                                    debugLog(`[D_CF][EXTRA][TITLE] Usando nome provider da metadata: "${extraBaseName}" per id=${extraId}`);
                                                }
                                            }

                                            let extraTitle = `🇮🇹🔄  ${extraBaseName}`;
                                            if (!/\bITA\b/i.test(extraTitle)) extraTitle += ' [ITA]';

                                            // Inserisci alla posizione corrente
                                            const extraEntry = { url: processedUrl, title: extraTitle };
                                            streams.splice(currentInsertPos, 0, extraEntry);
                                            debugLog(`Aggiunto extra D_CF dinamico id=${extraId} all'indice ${currentInsertPos} (title='${extraTitle}')`);
                                            currentInsertPos++; // Incrementa per il prossimo extra
                                        } catch (extraErr) {
                                            debugLog(`Errore processando extra D_CF:`, extraErr);
                                        }
                                    }
                                }
                            } else {
                                // Statico: mantieni comportamento precedente (replace o append in fondo)
                                const entry = { url: cfUrl, title: finalTitle };
                                if (existingCfIndex !== -1) streams.splice(existingCfIndex, 1, entry); else streams.push(entry);
                                debugLog(`Aggiunto staticUrlD_CF normalizzato static id=${newId} (title='${finalTitle}')`);
                            }
                        } catch (e) {
                            const errorMsg = (e as any)?.message || String(e);
                            const errorCode = errorMsg.includes('addonBase non disponibile') ? 'NO_ADDON_BASE'
                                : errorMsg.includes('id non estratto') ? 'ID_EXTRACTION_FAILED'
                                    : 'UNKNOWN';
                            console.error(`[DLHD][FAIL] Canale: ${channel.name || 'N/A'} | ID: ${channel.id || 'N/A'} | Errore: ${errorCode} | Dettagli: ${errorMsg}`);
                            debugLog(`Errore gestione staticUrlD_CF: ${e}`);
                        }
                    }
                    // La versione D classica resta condizionata alla presenza MFP URL (altrimenti occultata come prima)
                    if ((channel as any).staticUrlD) {
                        if (mfpUrl) {
                            // LAZY MODE: wrap diretto come dynamic (veloce), MFP estrae al click
                            // EAGER MODE: estrazione preventiva (lento ma completo)
                            // Controllato da env STATIC_DADDY_LAZY (default: 1 = lazy/veloce)
                            const lazyMode = (() => {
                                try {
                                    const val = (process?.env?.STATIC_DADDY_LAZY ?? '1').toString().toLowerCase();
                                    return val !== '0' && val !== 'false' && val !== 'off' && val !== 'no';
                                } catch { return true; } // default lazy
                            })();

                            if (lazyMode) {
                                // LAZY: wrap diretto (come dynamic channels), MFP estrae on-demand al playback
                                const passwordParam = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
                                const wrappedUrl = `${mfpUrl}/proxy/hls/manifest.m3u8?d=${encodeURIComponent((channel as any).staticUrlD)}${passwordParam}`;
                                streams.push({
                                    url: wrappedUrl,
                                    title: `[🌐D] ${channel.name} [ITA]`
                                });
                                debugLog(`Aggiunto staticUrlD LAZY (wrap diretto): ${wrappedUrl}`);
                            } else {
                                // EAGER: estrazione preventiva con extractor/video (comportamento precedente)
                                const passwordParam = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
                                const daddyApiBase = `${mfpUrl}/extractor/video?host=DLHD&redirect_stream=false${passwordParam}&d=${encodeURIComponent((channel as any).staticUrlD)}`;
                                try {
                                    const res = await fetch(daddyApiBase);
                                    if (res.ok) {
                                        const data = await res.json();
                                        let finalUrl = data.mediaflow_proxy_url || `${mfpUrl}/proxy/hls/manifest.m3u8`;
                                        // Aggiungi i parametri di query se presenti
                                        if (data.query_params) {
                                            const params = new URLSearchParams();
                                            for (const [key, value] of Object.entries(data.query_params)) {
                                                if (value !== null) {
                                                    params.append(key, String(value));
                                                }
                                            }
                                            finalUrl += (finalUrl.includes('?') ? '&' : '?') + params.toString();
                                        }
                                        // Aggiungi il parametro d per il destination_url
                                        if (data.destination_url) {
                                            const destParam = 'd=' + encodeURIComponent(data.destination_url);
                                            finalUrl += (finalUrl.includes('?') ? '&' : '?') + destParam;
                                        }
                                        // Aggiungi gli header come parametri h_
                                        if (data.request_headers) {
                                            for (const [key, value] of Object.entries(data.request_headers)) {
                                                if (value !== null) {
                                                    const headerParam = `h_${key}=${encodeURIComponent(String(value))}`;
                                                    finalUrl += '&' + headerParam;
                                                }
                                            }
                                        }
                                        streams.push({
                                            url: finalUrl,
                                            title: `[🌐D] ${channel.name} [ITA]`
                                        });
                                        debugLog(`Aggiunto staticUrlD EAGER (estrazione preventiva): ${finalUrl}`);
                                    } else {
                                        // Nothing returned; avoid adding extractor/video fallback
                                        debugLog(`staticUrlD EAGER: extractor response not OK (status ${res.status})`);
                                    }
                                } catch (err) {
                                    // Error; skip extractor/video fallback altogether
                                    debugLog(`staticUrlD EAGER: extractor error: ${(err as any)?.message || err}`);
                                }
                            }
                        } else {
                            // Richiesta: nascondere versione direct senza MFP
                            debugLog(`(NASCONDI) staticUrlD Direct senza MFP: ${(channel as any).staticUrlD}`);
                        }
                    }
                    // Vavoo
                    if (!dynamicHandled && (channel as any).name) {
                        // DEBUG LOGS
                        console.log('🔧 [VAVOO] DEBUG - channel.name:', (channel as any).name);
                        const baseName = (channel as any).name.replace(/\s*(\(\d+\)|\d+)$/, '').trim();
                        console.log('🔧 [VAVOO] DEBUG - baseName:', baseName);
                        const variant2 = `${baseName} (2)`;
                        const variantNum = `${baseName} 2`;
                        console.log('🔧 [VAVOO] DEBUG - variant2:', variant2);
                        console.log('🔧 [VAVOO] DEBUG - variantNum:', variantNum);
                        // --- VAVOO: cerca tutte le varianti .<lettera> per ogni nome in vavooNames (case-insensitive), sia originale che normalizzato ---
                        const vavooNamesArr = (channel as any).vavooNames || [channel.name];
                        // LOG RAW delle chiavi della cache
                        console.log('[VAVOO] CACHE KEYS RAW:', Array.from(vavooCache.links.keys()));
                        console.log(`[VAVOO] CERCA: vavooNamesArr =`, vavooNamesArr);
                        const allCacheKeys = Array.from(vavooCache.links.keys());
                        console.log(`[VAVOO] CACHE KEYS:`, allCacheKeys);
                        const foundVavooLinks: { url: string, key: string }[] = [];
                        for (const vavooName of vavooNamesArr) {
                            // Cerca con nome originale
                            console.log(`[VAVOO] CERCA (original): '${vavooName} .<lettera>'`);
                            const variantRegex = new RegExp(`^${vavooName} \.([a-zA-Z])$`, 'i');
                            for (const [key, value] of vavooCache.links.entries()) {
                                if (variantRegex.test(key)) {
                                    console.log(`[VAVOO] MATCH (original): chiave trovata '${key}' per vavooName '${vavooName}'`);
                                    const links = Array.isArray(value) ? value : [value];
                                    for (const url of links) {
                                        foundVavooLinks.push({ url, key });
                                        console.log(`[VAVOO] LINK trovato (original): ${url} (chiave: ${key})`);
                                    }
                                }
                            }
                            // Cerca anche con nome normalizzato (SEMPRE, per gestire SPORTS->SPORT e altre varianti)
                            // Normalizzazione: uppercase, collassa spazi, SPORTS->SPORT
                            let vavooNameNorm = vavooName.toUpperCase().replace(/\s+/g, ' ').trim();
                            vavooNameNorm = vavooNameNorm.replace(/\bSPORTS\b/g, 'SPORT'); // Fix: Sky Sports F1 -> Sky Sport F1
                            console.log(`[VAVOO] CERCA (normalizzato): '${vavooNameNorm} .<lettera>'`);
                            const variantRegexNorm = new RegExp(`^${vavooNameNorm} \.([a-zA-Z])$`, 'i');
                            for (const [key, value] of vavooCache.links.entries()) {
                                let keyNorm = key.toUpperCase().replace(/\s+/g, ' ').trim();
                                keyNorm = keyNorm.replace(/\bSPORTS\b/g, 'SPORT'); // Fix: normalizza anche cache key
                                if (variantRegexNorm.test(keyNorm)) {
                                    console.log(`[VAVOO] MATCH (normalizzato): chiave trovata '${key}' per vavooNameNorm '${vavooNameNorm}'`);
                                    const links = Array.isArray(value) ? value : [value];
                                    for (const url of links) {
                                        foundVavooLinks.push({ url, key });
                                        console.log(`[VAVOO] LINK trovato (normalizzato): ${url} (chiave: ${key})`);
                                    }
                                }
                            }
                        }

                        // (RIMOSSO blocco test SPON static: test completato)
                        // Se trovi almeno un link, aggiungi tutti come stream separati numerati
                        if (foundVavooLinks.length > 0) {
                            foundVavooLinks.forEach(({ url, key }, idx) => {
                                const streamTitle = `[✌️ V-${idx + 1}] ${channel.name} [ITA]`;
                                if (mfpUrl) {
                                    const passwordParam = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
                                    const vavooProxyUrl = `${mfpUrl}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(url)}${passwordParam}`;
                                    streams.push({
                                        title: streamTitle,
                                        url: vavooProxyUrl
                                    });
                                } else {
                                    // Richiesta: nascondere stream Vavoo direct senza MFP URL
                                }
                                vavooFoundUrls.push(url);
                                // For each found link, also prepare a clean variant labeled per index (➡️ V-1, V-2, ...)
                                const reqObj: any = (global as any).lastExpressRequest;
                                const clientIp = getClientIpFromReq(reqObj);
                                vavooCleanPromises.push((async () => {
                                    vdbg('Variant clean resolve attempt', { index: idx + 1, url: url.substring(0, 140) });
                                    try {
                                        const clean = await resolveVavooCleanUrl(url, clientIp);
                                        if (clean && clean.url) {
                                            const title = `[🏠 V-${idx + 1}] ${channel.name} [ITA]`;
                                            const urlWithHeaders = clean.url + `#headers#` + Buffer.from(JSON.stringify(clean.headers)).toString('base64');
                                            vavooCleanPrepend[idx] = { title, url: urlWithHeaders };
                                        }
                                    } catch (err) {
                                        vdbg('Variant clean failed', { index: idx + 1, error: (err as any)?.message || err });
                                    }
                                })());
                            });
                            console.log(`[VAVOO] RISULTATO: trovati ${foundVavooLinks.length} link, stream generati:`, streams.map(s => s.title));
                        } else {
                            // fallback: chiave esatta
                            const exact = vavooCache.links.get(channel.name);
                            if (exact) {
                                const links = Array.isArray(exact) ? exact : [exact];
                                links.forEach((url, idx) => {
                                    const streamTitle = `[✌️ V-${idx + 1}] ${channel.name} [ITA]`;
                                    if (mfpUrl) {
                                        const passwordParam = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
                                        const vavooProxyUrl = `${mfpUrl}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(url)}${passwordParam}`;
                                        streams.push({
                                            title: streamTitle,
                                            url: vavooProxyUrl
                                        });
                                    } else {
                                        // Richiesta: nascondere stream Vavoo direct senza MFP URL
                                    }
                                    vavooFoundUrls.push(url);
                                    // Prepare clean variant per index as well
                                    const reqObj: any = (global as any).lastExpressRequest;
                                    const clientIp = getClientIpFromReq(reqObj);
                                    vavooCleanPromises.push((async () => {
                                        vdbg('Variant clean resolve attempt', { index: idx + 1, url: url.substring(0, 140) });
                                        try {
                                            const clean = await resolveVavooCleanUrl(url, clientIp);
                                            if (clean && clean.url) {
                                                const title = `[🏠 V-${idx + 1}] ${channel.name} [ITA]`;
                                                const urlWithHeaders = clean.url + `#headers#` + Buffer.from(JSON.stringify(clean.headers)).toString('base64');
                                                vavooCleanPrepend[idx] = { title, url: urlWithHeaders };
                                            }
                                        } catch (err) {
                                            vdbg('Variant clean failed', { index: idx + 1, error: (err as any)?.message || err });
                                        }
                                    })());
                                });
                                console.log(`[VAVOO] RISULTATO: fallback chiave esatta, trovati ${links.length} link, stream generati:`, streams.map(s => s.title));
                            } else {
                                console.log(`[VAVOO] RISULTATO: nessun link trovato per questo canale.`);
                            }
                        }
                    }

                    // Se già gestito come evento dinamico, salta Vavoo/TVTap e ritorna subito
                    if (dynamicHandled) {
                        // Se dynamicHandled è true, gli stream raccolti in 'streams' non sono ancora stati trasferiti in allStreams.
                        // Cerchiamo eventuale Freeshot appena aggiunto (titolo che inizia con [🏟 Free]) e lo mettiamo all'inizio (dopo eventuali D_CF/D se presenti).
                        try {
                            const freeshotIdx = streams.findIndex(s => /\[🏟\s*Free\]/i.test(s.title));
                            if (freeshotIdx > -1) {
                                const freeshotStream = streams.splice(freeshotIdx, 1)[0];
                                // Trova posizione dopo eventuali D_CF / D
                                let insertPos = 0;
                                for (let i = 0; i < streams.length; i++) {
                                    if (/\[🌐D_CF\]/.test(streams[i].title) || /\[🌐D\]/.test(streams[i].title)) {
                                        insertPos = i + 1; // dopo l'ultimo D/D_CF
                                    }
                                }
                                streams.splice(insertPos, 0, freeshotStream);
                            }
                        } catch { }
                        // === SPORTZX & SPORTS99 STREAM INJECTION (Fuzzy Match) ===
                        try {
                            // Helper Fuzzy Match (locale per lo stream handler)
                            const fuzzyMatch = (eventTitle: string, channelTitle: string): boolean => {
                                const TEAM_ALIASES: Record<string, string> = {
                                    'juve': 'juventus',
                                    'fc juventus': 'juventus',
                                    'inter': 'internazionale',
                                    'fc inter': 'internazionale',
                                    'lazio': 'sslazio',
                                    'ss lazio': 'sslazio',
                                    'roma': 'asroma',
                                    'as roma': 'asroma',
                                    'milan': 'acmilan',
                                    'ac milan': 'acmilan',
                                    'napoli': 'sscnapoli',
                                    'ssc napoli': 'sscnapoli',
                                    'atalanta': 'atalanta',
                                    'fiorentina': 'acffiorentina',
                                    'acf fiorentina': 'acffiorentina'
                                };

                                const normalize = (s: string) => {
                                    let clean = s.toLowerCase()
                                        // Rimuovi parole comuni, date (NN/NN), e termini generici di leghe
                                        .replace(/\b(vs|v|-|live|hd|it|ita|italy|italia|match|serie|semifinal|quarterfinal|round|cup|league|football|st|nd|rd|th)\b/g, ' ')
                                        .replace(/\b\d{1,2}[\/-]\d{1,2}\b/g, '') // remove DD/MM or DD-MM
                                        .replace(/\b[a-z]?\d{1,4}[a-z]?\b/g, '') // remove standalone numbers (years, times, simple numbers)
                                        .replace(/[^\w\s]/g, '')
                                        .replace(/\s+/g, ' ')
                                        .trim();

                                    for (const [alias, target] of Object.entries(TEAM_ALIASES)) {
                                        const regex = new RegExp(`\\b${alias}\\b`, 'g');
                                        if (regex.test(clean)) {
                                            clean = clean.replace(regex, target);
                                        }
                                    }
                                    return clean;
                                };

                                const t1 = normalize(eventTitle);
                                const t2 = normalize(channelTitle);

                                const tokens1 = t1.split(' ').filter(t => t.length > 3);
                                const tokens2 = t2.split(' ').filter(t => t.length > 3);

                                if (tokens1.length === 0 || tokens2.length === 0) return false;

                                const sourceTokens = tokens1.length < tokens2.length ? tokens1 : tokens2;
                                const targetTokens = tokens1.length < tokens2.length ? tokens2 : tokens1;

                                const ms = sourceTokens.filter(st => targetTokens.some(tt => tt.includes(st) || st.includes(tt)));

                                if (sourceTokens.length === 1) return ms.length === 1;
                                return ms.length >= 2;
                            };

                            const eventName = (channel as any).name || '';
                            if (eventName) {
                                // 1. SPORTZX Injection
                                try {
                                    const { getSportzxChannels } = await import('./utils/sportzxUpdater');
                                    const spzxChannels = getSportzxChannels();
                                    const matchedSpzx = spzxChannels.filter((c: any) => fuzzyMatch(eventName, c.name));

                                    for (const c of matchedSpzx) {
                                        if (c._sportzx) {
                                            const match = c._sportzx;
                                            let finalUrl = match.stream_url;
                                            let proxyUsed = false;

                                            // Proxy Logic (reuse generic logic)
                                            if (mfpUrl) {
                                                if (match.keyid && match.key) {
                                                    const passwordParam = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
                                                    finalUrl = `${mfpUrl}/proxy/mpd/manifest.m3u8?d=${encodeURIComponent(match.stream_url)}${passwordParam}&key_id=${match.keyid}&key=${match.key}`;
                                                    proxyUsed = true;
                                                } else if (match.headers && match.headers.trim()) {
                                                    const headersObj: any = {};
                                                    (match.headers as string).split('&').forEach((pair: string) => {
                                                        const [k, v] = pair.split('=');
                                                        if (k && v) headersObj[k] = decodeURIComponent(v);
                                                    });
                                                    const headersJson = encodeURIComponent(JSON.stringify(headersObj));
                                                    const passwordParam = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
                                                    finalUrl = `${mfpUrl}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(match.stream_url)}${passwordParam}&headers=${headersJson}`;
                                                    proxyUsed = true;
                                                }
                                            }

                                            streams.push({
                                                url: finalUrl,
                                                title: `[SPZX] ${c._sportzx.channel_title || c.name}`,
                                                behaviorHints: { notWebReady: true }
                                            } as any);
                                            console.log(`✅ [SPZX] Injected stream for ${eventName} -> ${c.name}`);
                                        }
                                    }
                                } catch (e) { console.error('Error injecting SportzX', e); }

                                // 2. SPORTS99 Injection
                                try {
                                    const { getSports99Channels } = await import('./utils/sports99Updater');
                                    const { Sports99Client } = await import('./extractors/sports99');
                                    const sp99Channels = getSports99Channels();
                                    const matchedSp99 = sp99Channels.filter((c: any) => fuzzyMatch(eventName, c.name));

                                    if (matchedSp99.length > 0) {
                                        const client99 = new Sports99Client();
                                        // Resolve async
                                        for (const c of matchedSp99) {
                                            if (c._sports99 && c._sports99.player_url) {
                                                const sUrl = await client99.resolveStreamUrl(c._sports99.player_url);
                                                if (sUrl) {
                                                    streams.push({
                                                        url: sUrl,
                                                        title: `[SP99] ${c._sports99.channel_name || c.name}`,
                                                        behaviorHints: { notWebReady: true }
                                                    } as any);
                                                    console.log(`✅ [SP99] Injected stream for ${eventName} -> ${c.name}`);
                                                }
                                            }
                                        }
                                    }
                                } catch (e) { console.error('Error injecting Sports99', e); }
                            }

                        } catch (e) {
                            console.error('Generic injection error', e);
                        }

                        // === SPON (sportzonline) injection (always-on, no placeholders / no time gating) ===
                        try {
                            const eventNameRaw = (channel as any).name || '';

                            if (!eventNameRaw) {
                                // skip silently
                            } else {
                                const { fetchSponSchedule, matchRowsForEvent, debugExtractTeams } = await import('./extractors/sponSchedule');
                                const { extractSportzonlineStream } = await import('./extractors/sportsonline');

                                const schedule = await fetchSponSchedule(false).catch((err) => { console.log('[SPON] ❌ Schedule fetch failed:', err.message); return [] as any[]; });

                                if (!Array.isArray(schedule) || !schedule.length) {
                                    console.log(`[SPON] ⚠️ No schedule data available`);
                                    debugLog(`[SPON][DEBUG] schedule empty/invalid for '${eventNameRaw}'`);
                                } else {
                                    const matched = matchRowsForEvent({ name: eventNameRaw }, schedule as any) || [];

                                    if (!matched.length) {
                                        console.log(`[SPON] 🔍 Event NOT found: "${eventNameRaw}"`);
                                        debugLog(`[SPON][DEBUG] matched=0 for '${eventNameRaw}'`);
                                    } else {
                                        console.log(`[SPON] ✅ Event found: "${eventNameRaw}" → ${matched.length} streams`);
                                        // FIX DEFINITIVO: MFP viene SOLO dalla config utente, mai da cache o env
                                        // Le variabili mfpUrl e mfpPsw sono già estratte all'inizio dello stream handler

                                        if (!mfpUrl) {
                                            // Skip silently (seconda chiamata senza config)
                                            debugLog(`[SPON] MFP URL non configurato -> salto wrap per '${eventNameRaw}'`);
                                        } else {
                                            console.log('[SPON] ✓ MFP OK');
                                            const seen = new Set<string>();
                                            const collected: Stream[] = [];
                                            for (const row of matched.slice(0, 12)) {
                                                const tag = row.channelCode.toUpperCase();
                                                try {
                                                    // LOGICA PRINCIPALE: wrap diretto dell'URL sportzonline in MFP (veloce, no estrazione)
                                                    debugLog(`[SPON][ROW][MFP-WRAP] ${tag} ${row.url}`);
                                                    if (seen.has(row.url)) { debugLog(`[SPON][ROW] dup skip ${tag}`); continue; }
                                                    seen.add(row.url);
                                                    const italianFlag = /^(hd7|hd8)$/i.test(row.channelCode) ? ' 🇮🇹' : '';
                                                    // Wrap diretto: MFP gestirà estrazione iframe + unpacking server-side
                                                    const passwordParamSpon = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
                                                    const wrapped = `${mfpUrl.replace(/\/$/, '')}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(row.url)}${passwordParamSpon}`;
                                                    // Titolo semplificato: solo [SPON 🇮🇹] (TAG) senza dettagli evento
                                                    collected.push({ url: wrapped, title: `[SPON${italianFlag}] (${tag})` } as any);
                                                    debugLog(`[SPON][ROW] wrapped ${tag}`);
                                                } catch (err: any) { debugLog(`[SPON][ROW] unexpected error ${tag} ${(err?.message) || err}`); }
                                            }
                                            // FALLBACK: se MFP wrap non ha prodotto stream, prova estrazione TypeScript
                                            if (collected.length === 0 && matched.length > 0) {
                                                debugLog(`[SPON][FALLBACK] MFP wrap non ha prodotto stream, tentativo estrazione TypeScript...`);
                                                for (const row of matched.slice(0, 3)) { // limita a 3 per performance
                                                    const tag = row.channelCode.toUpperCase();
                                                    try {
                                                        if (seen.has(row.url)) continue;
                                                        seen.add(row.url);
                                                        debugLog(`[SPON][FALLBACK][ROW] extracting ${tag} ${row.url}`);
                                                        const res = await extractSportzonlineStream(row.url);
                                                        if (!res || !res.url) { debugLog(`[SPON][FALLBACK][ROW] empty result ${tag}`); continue; }
                                                        const italianFlag = /^(hd7|hd8)$/i.test(row.channelCode) ? ' 🇮🇹' : '';
                                                        const hdr = res.headers || {};
                                                        let finalUrl = res.url;
                                                        if (Object.keys(hdr).length && mfpUrl) {
                                                            const passwordParamFallback = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
                                                            const wrappedFallback = `${mfpUrl.replace(/\/$/, '')}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(res.url)}${passwordParamFallback}`;
                                                            finalUrl = wrappedFallback;
                                                            debugLog(`[SPON][FALLBACK][ROW] wrapped extracted m3u8 in MFP ${tag}`);
                                                        }
                                                        // Titolo semplificato: solo [SPON 🇮🇹] (TAG) senza dettagli evento
                                                        collected.push({ url: finalUrl, title: `[SPON${italianFlag}] (${tag})` } as any);
                                                        debugLog(`[SPON][FALLBACK][ROW] extracted ${tag}`);
                                                    } catch (err: any) { debugLog(`[SPON][FALLBACK][ROW] failed ${tag} ${(err?.message) || err}`); }
                                                }
                                            }
                                            if (collected.length) {
                                                collected.sort((a, b) => {
                                                    const aKey = /(HD7\)|HD8\))/i.test(a.title || '') ? 0 : /\(HD7\)|\(HD8\)/i.test(a.title || '') ? 0 : /\(HD7\)/i.test(a.title || '') ? 0 : /\(HD8\)/i.test(a.title || '') ? 0 : 1;
                                                    const bKey = /(HD7\)|HD8\))/i.test(b.title || '') ? 0 : /\(HD7\)|\(HD8\)/i.test(b.title || '') ? 0 : /\(HD7\)/i.test(b.title || '') ? 0 : /\(HD8\)/i.test(b.title || '') ? 0 : 1;
                                                    if (aKey !== bKey) return aKey - bKey; return (a.title || '').localeCompare(b.title || '');
                                                });
                                                let insertAt = streams.length;
                                                // 1. (SPSO rimosso)
                                                // 2. Place right AFTER last Daddy (with 🇮🇹 or rotating arrows emoji) if any
                                                const rotatingRegex = /[↻🔄🔁⟳🌀]/;
                                                for (let i = streams.length - 1; i >= 0; i--) {
                                                    const t = streams[i].title || '';
                                                    if (/daddy/i.test(t) && (t.includes('🇮🇹') || rotatingRegex.test(t))) { insertAt = i + 1; break; }
                                                }
                                                const existing = new Set(streams.map(s => s.url));
                                                const finalIns = collected.filter(s => s.url && !existing.has(s.url));
                                                if (finalIns.length) { streams.splice(insertAt, 0, ...(finalIns as any)); debugLog(`[SPON] Injected ${finalIns.length} SPON streams (always-on) per '${eventNameRaw}'`); }
                                                else debugLog(`[SPON] Nessun nuovo stream (duplicati) per '${eventNameRaw}'`);
                                            } else {
                                                debugLog(`[SPON] Nessun stream estratto per '${eventNameRaw}' (no placeholder)`);
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (e) {
                            console.log('[SPON] ❌ Error:', (e as any)?.message || e);
                            debugLog('[SPON] injection error', e);
                        }


                        const allowVavooClean = true; // simplified: always allow clean Vavoo variant
                        for (const s of streams) {
                            // Support special marker '#headers#<b64json>' to attach headers properly
                            const marker = '#headers#';
                            if (s.url.includes(marker)) {
                                const [pureUrl, b64] = s.url.split(marker);
                                let hdrs: Record<string, string> | undefined;
                                try { hdrs = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch { }
                                const isVavooClean = !!hdrs && hdrs['Referer'] === 'https://vavoo.to/' && hdrs['User-Agent'] === DEFAULT_VAVOO_UA;
                                if (isVavooClean && !allowVavooClean) { continue; }
                                allStreams.push({ name: getStreamName(pureUrl), title: s.title, url: pureUrl, behaviorHints: { notWebReady: true, headers: hdrs || {}, proxyHeaders: hdrs || {}, proxyUseFallback: true } as any });
                            } else {
                                // Fallback: if this looks like a clean Vavoo sunshine URL and title starts with a variant tag, attach default headers
                                const looksVavoo = /\b(sunshine|hls\/index\.m3u8)\b/.test(s.url) && !/\bproxy\/hls\//.test(s.url);
                                const variantTitle = /^\s*\[?\s*(➡️|🏠|✌️)\s*V/i.test(s.title);
                                if (variantTitle && looksVavoo) {
                                    const hdrs = { 'User-Agent': DEFAULT_VAVOO_UA, 'Referer': 'https://vavoo.to/' } as Record<string, string>;
                                    if (!allowVavooClean) { continue; }
                                    allStreams.push({ name: getStreamName(s.url), title: s.title, url: s.url, behaviorHints: { notWebReady: true, headers: hdrs, proxyHeaders: hdrs, proxyUseFallback: true } as any });
                                } else {
                                    allStreams.push({ name: getStreamName(s.url), title: s.title, url: s.url });
                                }
                            }
                        }
                        // === ORDINAMENTO FINALE STREAM EVENTI DINAMICI ===
                        try {
                            if (allStreams.length > 1) {
                                sortStreamsByPriority(allStreams);
                                debugLog(`[DynamicEvents] Stream ordinati per priorità: ${allStreams.length} totali`);
                            }
                        } catch (sortErr) {
                            debugLog(`[DynamicEvents] Errore ordinamento:`, String((sortErr as any)?.message || sortErr));
                        }

                        // === DVR INTEGRATION FOR DYNAMIC EVENTS ===
                        const dynDvrConfig = getDvrConfig(config as any);
                        const dynDvrEnabled = dynDvrConfig && ((config as any).dvrEnabled !== false);
                        if (dynDvrEnabled && allStreams.length > 0) {
                            try {
                                const dvrRecordStreams: typeof allStreams = [];

                                // Add a DVR record entry for each valid stream
                                for (const stream of allStreams) {
                                    if (!stream.url || stream.url.includes('nostream')) continue;

                                    // Extract the source URL from proxied stream if applicable
                                    // Also preserve key_id and key parameters for DRM-protected streams
                                    let recordUrl = stream.url;
                                    const dMatch = stream.url.match(/[?&]d=([^&]+)/);
                                    if (dMatch) {
                                        recordUrl = decodeURIComponent(dMatch[1]);
                                        // Extract and append key_id and key if present
                                        const keyIdMatch = stream.url.match(/[?&]key_id=([^&]+)/);
                                        const keyMatch = stream.url.match(/[?&]key=([^&]+)/);
                                        if (keyIdMatch && keyMatch) {
                                            const separator = recordUrl.includes('?') ? '&' : '?';
                                            recordUrl += `${separator}key_id=${keyIdMatch[1]}&key=${keyMatch[1]}`;
                                        }
                                    }

                                    const dvrEntry = buildDvrRecordEntry(
                                        recordUrl,
                                        stream.title || 'Stream',
                                        channel.name || cleanId,
                                        { addonConfig: config as any }
                                    );

                                    if (dvrEntry) {
                                        dvrRecordStreams.push({
                                            name: 'DVR',
                                            title: dvrEntry.title,
                                            url: dvrEntry.url,
                                            behaviorHints: { notWebReady: false } as any
                                        });
                                    }
                                }

                                // Also add active/completed recordings
                                const firstStream = allStreams.find(s => s.url && !s.url.includes('nostream'));
                                if (firstStream) {
                                    let recordUrl = firstStream.url;
                                    const dMatch = firstStream.url.match(/[?&]d=([^&]+)/);
                                    if (dMatch) {
                                        recordUrl = decodeURIComponent(dMatch[1]);
                                        // Extract and append key_id and key if present
                                        const keyIdMatch = firstStream.url.match(/[?&]key_id=([^&]+)/);
                                        const keyMatch = firstStream.url.match(/[?&]key=([^&]+)/);
                                        if (keyIdMatch && keyMatch) {
                                            const separator = recordUrl.includes('?') ? '&' : '?';
                                            recordUrl += `${separator}key_id=${keyIdMatch[1]}&key=${keyMatch[1]}`;
                                        }
                                    }

                                    const dvrStreams = await getDvrStreamsForChannel(
                                        channel.name || cleanId,
                                        recordUrl,
                                        { addonConfig: config as any }
                                    );
                                    for (const dvrStream of dvrStreams) {
                                        dvrRecordStreams.push({
                                            name: 'DVR',
                                            title: dvrStream.title,
                                            url: dvrStream.url,
                                            behaviorHints: { notWebReady: false } as any
                                        });
                                    }
                                }

                                // Add all DVR streams
                                for (const dvrStream of dvrRecordStreams) {
                                    allStreams.push(dvrStream);
                                }

                                if (dvrRecordStreams.length > 0) {
                                    console.log(`[DVR] Added ${dvrRecordStreams.length} DVR stream(s) for dynamic event ${channel.name}`);
                                }
                            } catch (dvrErr) {
                                console.warn('[DVR] Error adding DVR streams to dynamic event:', (dvrErr as any)?.message || dvrErr);
                            }
                        }

                        console.log(`✅ Returning ${allStreams.length} dynamic event streams`);
                        return { streams: allStreams };
                    }
                    // --- TVTAP: cerca usando vavooNames ---
                    // Check se TVTAP è abilitato
                    const isTVTapEnabled = ['1', 'true', 'on', 'yes'].includes((process.env.TVTAP_ENABLE || '0').toString().toLowerCase());
                    if (isTVTapEnabled) {
                        const vavooNamesArr = (channel as any).vavooNames || [channel.name];
                        console.log(`[TVTap] Cerco canale con vavooNames:`, vavooNamesArr);
                        // tvtapProxyEnabled: TRUE = NO PROXY (mostra 🔓), FALSE = usa proxy se possibile
                        const tvtapNoProxy = !!config.tvtapProxyEnabled;

                        // Prova ogni nome nei vavooNames
                        for (const vavooName of vavooNamesArr) {
                            try {
                                console.log(`[TVTap] Provo con nome: ${vavooName}`);

                                const tvtapUrl = await new Promise<string | null>((resolve) => {
                                    const timeout = setTimeout(() => {
                                        console.log(`[TVTap] Timeout per canale: ${vavooName}`);
                                        resolve(null);
                                    }, 5000);

                                    const options = {
                                        timeout: 5000,
                                        env: {
                                            ...process.env,
                                            PYTHONPATH: '/usr/local/lib/python3.9/site-packages'
                                        }
                                    };

                                    execFile('python3', [path.join(__dirname, '../tvtap_resolver.py'), vavooName], options, (error: Error | null, stdout: string, stderr: string) => {
                                        clearTimeout(timeout);

                                        if (error) {
                                            console.error(`[TVTap] Error for ${vavooName}:`, error.message);
                                            return resolve(null);
                                        }

                                        if (!stdout || stdout.trim() === '') {
                                            console.log(`[TVTap] No output for ${vavooName}`);
                                            return resolve(null);
                                        }

                                        const result = stdout.trim();
                                        if (result === 'NOT_FOUND' || result === 'NO_CHANNELS' || result === 'NO_ID' || result === 'STREAM_FAIL') {
                                            console.log(`[TVTap] Channel not found: ${vavooName} (${result})`);
                                            return resolve(null);
                                        }

                                        if (result.startsWith('http')) {
                                            console.log(`[TVTap] Trovato stream per ${vavooName}: ${result}`);
                                            resolve(result);
                                        } else {
                                            console.log(`[TVTap] Output non valido per ${vavooName}: ${result}`);
                                            resolve(null);
                                        }
                                    });
                                });

                                if (tvtapUrl) {
                                    const baseTitle = `[📺 TvTap SD] ${channel.name} [ITA]`;
                                    if (tvtapNoProxy || !mfpUrl) {
                                        // NO Proxy mode scelto (checkbox ON) oppure manca URL proxy -> link diretto con icona 🔓
                                        streams.push({
                                            title: `🔓 ${baseTitle}`,
                                            url: tvtapUrl
                                        });
                                        console.log(`[TVTap] DIRECT (NO PROXY mode=${tvtapNoProxy}) per ${channel.name} tramite ${vavooName}`);
                                    } else {
                                        // Checkbox OFF e credenziali presenti -> usa proxy
                                        const passwordParamTvtap = mfpPsw ? `&api_password=${encodeURIComponent(mfpPsw)}` : '';
                                        const tvtapProxyUrl = `${mfpUrl}/proxy/hls/manifest.m3u8?d=${encodeURIComponent(tvtapUrl)}${passwordParamTvtap}`;
                                        streams.push({
                                            title: baseTitle,
                                            url: tvtapProxyUrl
                                        });
                                        console.log(`[TVTap] PROXY stream per ${channel.name} tramite ${vavooName}`);
                                    }
                                    break; // Esci dal loop se trovi un risultato
                                }
                            } catch (error) {
                                console.error(`[TVTap] Errore per vavooName ${vavooName}:`, error);
                            }
                        }

                        if (streams.length === 0) {
                            console.log(`[TVTap] RISULTATO: nessun stream trovato per ${channel.name}`);
                        }
                    } else {
                        console.log(`[TVTap] TVTAP_ENABLE=0, skip risoluzione per ${channel.name}`);
                    }

                    // ============ END INTEGRATION SECTIONS ============

                    // Attendi eventuali risoluzioni clean Vavoo prima di restituire
                    if (vavooCleanPromises.length) {
                        try { await Promise.allSettled(vavooCleanPromises); } catch { }
                        // Prepend clean Vavoo variants in order (V-1 first)
                        let inserted = 0;
                        vdbg('Clean prepend result', { inserted, totalVariants: vavooCleanPrepend.length });
                        for (let i = vavooCleanPrepend.length - 1; i >= 0; i--) {
                            const entry = vavooCleanPrepend[i];
                            if (entry) { streams.unshift(entry); inserted++; }
                        }
                        // If none resolved clean, add numbered fallbacks with default headers for visibility
                        if (inserted === 0 && vavooFoundUrls.length > 0) {
                            for (let i = vavooFoundUrls.length - 1; i >= 0; i--) {
                                const u = vavooFoundUrls[i];
                                const hdrs = { 'User-Agent': DEFAULT_VAVOO_UA, 'Referer': 'https://vavoo.to/' } as Record<string, string>;
                                const urlWithHeaders = u + `#headers#` + Buffer.from(JSON.stringify(hdrs)).toString('base64');
                                streams.unshift({ title: `[🏠 V-${i + 1}] ${channel.name} [ITA]`, url: urlWithHeaders });
                            }
                        }
                    }
                    // Dopo aver popolato streams (nella logica TV):
                    for (const s of streams) {
                        const allowVavooClean = config.vavooNoMfpEnabled === true; // default false se non specificato
                        const marker = '#headers#';
                        if (s.url.includes(marker)) {
                            const [pureUrl, b64] = s.url.split(marker);
                            let hdrs: Record<string, string> | undefined;
                            try { hdrs = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')); } catch { }
                            const isVavooClean = !!hdrs && hdrs['Referer'] === 'https://vavoo.to/' && hdrs['User-Agent'] === DEFAULT_VAVOO_UA;
                            if (isVavooClean && !allowVavooClean) { continue; }
                            allStreams.push({ name: getStreamName(pureUrl), title: s.title, url: pureUrl, behaviorHints: { notWebReady: true, headers: hdrs || {}, proxyHeaders: hdrs || {}, proxyUseFallback: true } as any });
                        } else {
                            const looksVavoo = /\b(sunshine|hls\/index\.m3u8)\b/.test(s.url) && !/\bproxy\/hls\//.test(s.url);
                            const variantTitle = /^\s*\[?\s*(➡️|🏠|✌️)\s*V/i.test(s.title);
                            if (variantTitle && looksVavoo) {
                                const hdrs = { 'User-Agent': DEFAULT_VAVOO_UA, 'Referer': 'https://vavoo.to/' } as Record<string, string>;
                                if (!allowVavooClean) { continue; }
                                allStreams.push({ name: getStreamName(s.url), title: s.title, url: s.url, behaviorHints: { notWebReady: true, headers: hdrs, proxyHeaders: hdrs, proxyUseFallback: true } as any });
                            } else {
                                allStreams.push({ name: getStreamName(s.url), title: s.title, url: s.url });
                            }
                        }
                    }

                    // 5. AGGIUNGI STREAM ALTERNATIVI/FALLBACK per canali specifici
                    // RIMOSSO: Blocco che aggiunge fallback stream alternativi per canali Sky (skyFallbackUrls) se finalStreams.length < 3
                    // return { streams: finalStreamsWithRealUrls };

                    // === DVR INTEGRATION ===
                    // Add DVR streams (Record option for each stream + active/completed recordings)
                    const dvrConfig = getDvrConfig(config as any);
                    const dvrEnabled = dvrConfig && ((config as any).dvrEnabled !== false);
                    if (dvrEnabled && allStreams.length > 0) {
                        try {
                            const dvrRecordStreams: typeof allStreams = [];

                            // Add a DVR record entry for each valid stream
                            for (const stream of allStreams) {
                                if (!stream.url || stream.url.includes('nostream')) continue;

                                // Extract the source URL from proxied stream if applicable
                                // Also preserve key_id and key parameters for DRM-protected streams
                                let recordUrl = stream.url;
                                const dMatch = stream.url.match(/[?&]d=([^&]+)/);
                                if (dMatch) {
                                    recordUrl = decodeURIComponent(dMatch[1]);
                                    // Extract and append key_id and key if present
                                    const keyIdMatch = stream.url.match(/[?&]key_id=([^&]+)/);
                                    const keyMatch = stream.url.match(/[?&]key=([^&]+)/);
                                    if (keyIdMatch && keyMatch) {
                                        const separator = recordUrl.includes('?') ? '&' : '?';
                                        recordUrl += `${separator}key_id=${keyIdMatch[1]}&key=${keyMatch[1]}`;
                                    }
                                }

                                const dvrEntry = buildDvrRecordEntry(
                                    recordUrl,
                                    stream.title || 'Stream',
                                    channel.name || cleanId,
                                    { addonConfig: config as any }
                                );

                                if (dvrEntry) {
                                    dvrRecordStreams.push({
                                        name: 'DVR',
                                        title: dvrEntry.title,
                                        url: dvrEntry.url,
                                        behaviorHints: { notWebReady: false } as any
                                    });
                                }
                            }

                            // Also add active/completed recordings
                            const firstStream = allStreams.find(s => s.url && !s.url.includes('nostream'));
                            if (firstStream) {
                                let recordUrl = firstStream.url;
                                const dMatch = firstStream.url.match(/[?&]d=([^&]+)/);
                                if (dMatch) {
                                    recordUrl = decodeURIComponent(dMatch[1]);
                                    // Extract and append key_id and key if present
                                    const keyIdMatch = firstStream.url.match(/[?&]key_id=([^&]+)/);
                                    const keyMatch = firstStream.url.match(/[?&]key=([^&]+)/);
                                    if (keyIdMatch && keyMatch) {
                                        const separator = recordUrl.includes('?') ? '&' : '?';
                                        recordUrl += `${separator}key_id=${keyIdMatch[1]}&key=${keyMatch[1]}`;
                                    }
                                }

                                const dvrStreams = await getDvrStreamsForChannel(
                                    channel.name || cleanId,
                                    recordUrl,
                                    { addonConfig: config as any }
                                );
                                for (const dvrStream of dvrStreams) {
                                    dvrRecordStreams.push({
                                        name: 'DVR',
                                        title: dvrStream.title,
                                        url: dvrStream.url,
                                        behaviorHints: { notWebReady: false } as any
                                    });
                                }
                            }

                            // Add all DVR streams
                            for (const dvrStream of dvrRecordStreams) {
                                allStreams.push(dvrStream);
                            }

                            if (dvrRecordStreams.length > 0) {
                                console.log(`[DVR] Added ${dvrRecordStreams.length} DVR stream(s) for ${channel.name}`);
                            }
                        } catch (dvrErr) {
                            console.warn('[DVR] Error adding DVR streams:', (dvrErr as any)?.message || dvrErr);
                        }
                    }
                }

                // === LOGICA ANIME/FILM (originale) ===
                // Per tutto il resto, usa solo mediaFlowProxyUrl/mediaFlowProxyPassword
                // Gestione AnimeUnity per ID Kitsu o MAL con fallback variabile ambiente

                // API Mode detection: when config has NO explicit provider settings, assume direct API call
                // Direct API call = curl to /stream/movie/xxx.json without any config
                // User with config (even without MFP) should NOT trigger API mode
                const hasAnyProviderSetting = (() => {
                    const cfg = config as any;
                    // Check if user has explicitly set any provider or flag
                    const providerKeys = [
                        'trailerEnabled', 'disableVixsrc', 'vixDirect', 'vixDirectFhd', 'vixProxy', 'vixProxyFhd',
                        'guardahdEnabled', 'guardaserieEnabled', 'guardoserieEnabled', 'guardaflixEnabled',
                        'eurostreamingEnabled', 'loonexEnabled', 'toonitaliaEnabled', 'cb01Enabled',
                        'animesaturnEnabled', 'animeworldEnabled', 'animeunityEnabled'
                    ];
                    return providerKeys.some(k => cfg[k] !== undefined);
                })();
                const isDirectAPICall = !hasAnyProviderSetting;
                if (isDirectAPICall) {
                    console.log('[API Mode] Direct API call detected (no config) - enabling all providers (non-FHD/direct only)');
                }

                // Provider flags: default ON unless explicitly disabled
                const envFlag = (name: string) => {
                    const v = process.env[name];
                    if (v == null) return undefined;
                    return v.toLowerCase() === 'true';
                };
                // New rule: enabled only when checkbox true (or env forces true)
                // API Mode: enable by default for all providers
                const animeUnityEnabled = envFlag('ANIMEUNITY_ENABLED') ?? (isDirectAPICall || config.animeunityEnabled === true);
                const animeSaturnEnabled = envFlag('ANIMESATURN_ENABLED') ?? (isDirectAPICall || config.animesaturnEnabled === true);
                const animeWorldEnabled = envFlag('ANIMEWORLD_ENABLED') ?? (isDirectAPICall || config.animeworldEnabled === true);
                const guardaSerieEnabled = envFlag('GUARDASERIE_ENABLED') ?? (isDirectAPICall || config.guardaserieEnabled === true);
                const guardaHdEnabled = envFlag('GUARDAHD_ENABLED') ?? (isDirectAPICall || config.guardahdEnabled === true);
                const cb01Enabled = envFlag('CB01_ENABLED') ?? (isDirectAPICall || (config as any).cb01Enabled === true);
                // Eurostreaming: default ON unless explicitly disabled (config false) or env sets true/false
                const eurostreamingEnv = envFlag('EUROSTREAMING_ENABLED');
                const eurostreamingEnabled = eurostreamingEnv !== undefined
                    ? eurostreamingEnv
                    : (isDirectAPICall || config.eurostreamingEnabled !== false); // default true
                // Loonex: default OFF (nuovo provider) - API mode enables it
                const loonexEnabled = envFlag('LOONEX_ENABLED') ?? (isDirectAPICall || config.loonexEnabled === true);
                // ToonItalia: default OFF (nuovo provider) - API mode enables it
                const toonitaliaEnabled = envFlag('TOONITALIA_ENABLED') ?? (isDirectAPICall || config.toonitaliaEnabled === true);
                console.log(`[ToonItalia] Flag status: ${toonitaliaEnabled} (env: ${envFlag('TOONITALIA_ENABLED')}, config: ${config.toonitaliaEnabled})`);
                // Nuovo flag per inserire VixSrc nell'esecuzione parallela (prima era fuori e poteva saltare)
                // FIX: usa config dell'utente, NON configCache globale
                const vixsrcEnabled = (() => {
                    try {
                        if ((config as any).disableVixsrc === true) return false;
                    } catch { }
                    return true; // default ON (also in API mode)
                })();
                let vixsrcScheduled = false; // per evitare doppia esecuzione nel blocco sequenziale più sotto

                // API Mode: enable Guardoserie and Guardaflix by default
                const guardoserieEnabled = isDirectAPICall || (config.guardoserieEnabled === true);
                const guardaflixEnabled = isDirectAPICall || (config.guardaflixEnabled === true);

                // Gestione parallela AnimeUnity / AnimeSaturn / AnimeWorld + Loonex
                // IMPORTANTE: includere trailerEnabled per permettere trailer standalone
                const trailerEnabled = (config as any).trailerEnabled !== false;
                if ((id.startsWith('kitsu:') || id.startsWith('mal:') || id.startsWith('tt') || id.startsWith('tmdb:')) && (trailerEnabled || animeUnityEnabled || animeSaturnEnabled || animeWorldEnabled || guardaSerieEnabled || guardoserieEnabled || guardaflixEnabled || guardaHdEnabled || eurostreamingEnabled || loonexEnabled || toonitaliaEnabled || cb01Enabled || vixsrcEnabled)) {
                    const animeUnityConfig: AnimeUnityConfig = {
                        enabled: animeUnityEnabled,
                        mfpUrl: mfpUrl,
                        mfpPassword: mfpPsw,
                        tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0',
                        animeunityAuto: (() => { const v = (config as any).animeunityAuto; if (v === undefined) return undefined; return v === true || v === 'true' || v === 'on' || v === 1; })(),
                        animeunityFhd: (() => { const v = (config as any).animeunityFhd; if (v === undefined) return undefined; return v === true || v === 'true' || v === 'on' || v === 1; })(),
                    };
                    const animeSaturnConfig = {
                        enabled: animeSaturnEnabled,
                        mfpUrl: mfpUrl,
                        mfpPassword: mfpPsw,
                        mfpProxyUrl: mfpUrl,
                        mfpProxyPassword: mfpPsw,
                        tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0'
                    };
                    const animeWorldConfig = {
                        enabled: animeWorldEnabled,
                        mfpUrl: mfpUrl,
                        mfpPassword: mfpPsw,
                        tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0'
                    };
                    // Parsing stagione/episodio per IMDB/TMDB
                    let seasonNumber: number | null = null;
                    let episodeNumber: number | null = null;
                    let isMovie = false;
                    if (id.startsWith('tt') || id.startsWith('tmdb:')) {
                        // Esempio: tt1234567:1:2 oppure tmdb:12345:1:2
                        const parts = id.split(':');
                        // IMDB: tt12345 (1 part) = movie, tt12345:S:E (3 parts) = series
                        // TMDB: tmdb:12345 (2 parts) = movie, tmdb:12345:S:E (4 parts) = series
                        if (id.startsWith('tt')) {
                            if (parts.length === 1) {
                                isMovie = true;
                            } else if (parts.length === 2) {
                                episodeNumber = parseInt(parts[1]);
                            } else if (parts.length === 3) {
                                seasonNumber = parseInt(parts[1]);
                                episodeNumber = parseInt(parts[2]);
                            }
                        } else if (id.startsWith('tmdb:')) {
                            if (parts.length === 2) {
                                // tmdb:12345 = movie
                                isMovie = true;
                            } else if (parts.length === 3) {
                                // tmdb:12345:E
                                episodeNumber = parseInt(parts[2]);
                            } else if (parts.length === 4) {
                                // tmdb:12345:S:E
                                seasonNumber = parseInt(parts[2]);
                                episodeNumber = parseInt(parts[3]);
                            }
                        }
                    }
                    const providerPromises: Promise<void>[] = [];

                    // Map legacy streamName label (used for ordering) to internal provider key
                    const reverseProviderKey = (label: string): string => {
                        const l = label.toLowerCase();
                        if (l.includes('vixsrc') || l.includes('streamingcommunity')) return 'vixsrc';
                        if (l.includes('anime unity')) return 'animeunity';
                        if (l.includes('anime saturn')) return 'animesaturn';
                        if (l.includes('anime world')) return 'animeworld';
                        if (l.includes('guardaserie')) return 'guardaserie';
                        if (l.includes('guardahd')) return 'guardahd';
                        if (l.includes('cb01')) return 'cb01';
                        if (l.includes('eurostreaming')) return 'eurostreaming';
                        if (l.includes('loonex')) return 'loonex';
                        if (l.includes('toonitalia')) return 'toonitalia';
                        if (l.includes('guardaflix')) return 'guardaflix';
                        if (l.includes('guardoserie')) return 'guardoserie';
                        return 'generic';
                    };
                    const unifyStreams = (original: Stream[], providerLabelName: string): Stream[] => {
                        if (type === 'tv') return original; // Live TV untouched (no binge group logic)
                        const providerKey = reverseProviderKey(providerLabelName);
                        // Pre-scan for canonical base title (vixsrc) excluding synthetic placeholder names
                        let canonicalVixBase: string | null = null;
                        if (providerKey === 'vixsrc') {
                            for (const st of original) {
                                const first = (st.title || '').toString().split('\n')[0];
                                if (first && !/Synthetic FHD|Proxy FHD/i.test(first)) {
                                    canonicalVixBase = first
                                        .replace(/^\s*🎬\s*/, '')
                                        .replace(/\[?(ITA|SUB)\]?/ig, '')
                                        .replace(/🔒|🔓FHD?|🔓/g, '')
                                        .replace(/\s*•\s*/g, ' ')
                                        .replace(/\s{2,}/g, ' ')
                                        .trim();
                                    if (canonicalVixBase) break;
                                }
                            }
                            // Se non trovato (tutte placeholder), prova a prendere originalName dai synthetic
                            if (!canonicalVixBase) {
                                for (const st of original) {
                                    const orig = (st as any).originalName;
                                    if (orig && typeof orig === 'string') { canonicalVixBase = orig; break; }
                                }
                            }
                        }
                        const hostMap: Record<string, string> = {
                            'mixdrop': 'Mixdrop', 'dropload': 'Dropload', 'streamtape': 'Streamtape', 'supervideo': 'SuperVideo', 'doodstream': 'Doodstream', 'deltabit': 'Deltabit', 'delta bit': 'Deltabit', 'loadm': 'LoadM'
                        };
                        return original.map(st => {
                            const url = (st as any).url || '';
                            const rawTitle: string = (st.title || '').toString();
                            const lines = rawTitle.split('\n');
                            let baseLine = lines[0] || '';
                            // Remove duplicated leading icons / tags
                            baseLine = baseLine.replace(/^\s*🎬\s*/, '');
                            for (let i = 0; i < 3; i++) baseLine = baseLine.replace(/^\s*\[[^\]]+\]\s*/, '').trim();
                            // Strip language markers or bullet language artifacts from base line
                            baseLine = baseLine
                                .replace(/\s*[•▪]\s*\[?(ITA|SUB)\]?/ig, '')
                                .replace(/\s*\b(ITA|SUB)\b/ig, '')
                                .replace(/\s*•\s*\[SUB ITA\]/ig, '')
                                .replace(/\s{2,}/g, ' ') // collapse spaces
                                .trim();
                            // Replace synthetic placeholder names with canonical title
                            if (providerKey === 'vixsrc' && /^(Synthetic FHD|Proxy FHD)$/i.test(baseLine)) {
                                if (canonicalVixBase) {
                                    baseLine = canonicalVixBase;
                                } else if ((st as any).originalName) {
                                    baseLine = (st as any).originalName;
                                }
                            }
                            // Extra cleanup for VixSrc: rimuovi eventuali marker lingua / lock rimasti nel baseLine
                            if (providerKey === 'vixsrc') {
                                baseLine = baseLine
                                    .replace(/\[?(ITA|SUB)\]?/ig, '')
                                    .replace(/🔒|🔓FHD?|🔓/g, '')
                                    .replace(/\s*•\s*/g, ' ')
                                    .replace(/\s{2,}/g, ' ')
                                    .trim();
                            }
                            // Cleanup universale aggiuntivo: rimuovi eventuali [ITA]/[SUB] residui attaccati senza spazio e lock icon per qualsiasi provider
                            baseLine = baseLine
                                .replace(/\[ITA\]/ig, '')
                                .replace(/\[SUB\]/ig, '')
                                .replace(/🔒|🔓FHD?|🔓/g, '')
                                .replace(/\s{2,}/g, ' ')
                                .replace(/\s+$/, '')
                                .trim();
                            // Language detection (from whole raw title)
                            const isSub = /\bsub\b|\[sub\]/i.test(rawTitle);
                            // Proxy detection (broadened):
                            //  - /proxy/ path segment
                            //  - presence of api_password= (MediaFlow proxy wrapper)
                            //  - extractor/video path (our mfp encapsulation pattern)
                            //  - behaviorHints.proxyHeaders flag
                            const proxyOn = /\/proxy\//i.test(url)
                                || /api_password=/i.test(url)
                                || /extractor\/video/i.test(url)
                                || !!(st as any)?.behaviorHints?.proxyHeaders;
                            // Player host detection (not for vixsrc)
                            let playerName: string | undefined;
                            let sizeHuman: string | undefined; // already formatted (e.g. 1.58Gb / 850MB)
                            let resHuman: string | undefined;  // e.g. 1080p
                            if (providerKey !== 'vixsrc') {
                                const lowerAll = rawTitle.toLowerCase();
                                for (const k of Object.keys(hostMap)) {
                                    if (lowerAll.includes(k)) { playerName = hostMap[k]; break; }
                                }
                                // Try to preserve existing player name line if not found
                                if (!playerName) {
                                    for (const l of lines) {
                                        if (l.includes('▶️')) {
                                            playerName = l.replace('▶️', '').trim();
                                            break;
                                        }
                                    }
                                }
                                // Try to parse existing size/res lines produced by extractors (line starting with 💾)
                                // Patterns we expect from extractors: "💾 <SIZE> • <RES>", "💾 <SIZE>", "💾 <SIZE> • <somethingp>", or combined tokens separated by spaces or bullets.
                                for (const l of lines) {
                                    if (/^\s*💾/i.test(l)) {
                                        // Remove leading icon
                                        let rest = l.replace(/^\s*💾\s*/, '').trim();
                                        // Split by separators (bullet • or whitespace)
                                        const parts = rest.split(/\s*[•|]\s*|\s+/).filter(Boolean);
                                        // Heuristics: first part maybe size (contains MB/GB), any part matching \d{3,4}p is resolution
                                        for (const p of parts) {
                                            if (!sizeHuman && /([0-9]+(?:\.[0-9]+)?\s*(?:GB|MB))/i.test(p)) sizeHuman = p.replace(/gb$/i, 'GB').replace(/mb$/i, 'MB');
                                            if (!resHuman && /^(\d{3,4})p$/i.test(p)) resHuman = p.toLowerCase();
                                        }
                                    }
                                }
                            }
                            // If resolution appears split like "1080p" inside raw title second line without 💾, catch it
                            if (!resHuman) {
                                const m = rawTitle.match(/\b(\d{3,4})p\b/);
                                if (m) resHuman = m[1] + 'p';
                            }
                            // HD flag ONLY if synthetic flag propagated
                            const isSynthetic = !!(st as any).isSyntheticFhd;
                            const isFhdOrDual = providerKey === 'vixsrc' && isSynthetic;
                            // Assemble lines manually per new spec:
                            // 1 Title (🎬 prefix added later by builder or we add manually)
                            // 2 Language line 🗣 [ITA|SUB]
                            // 3 Player line ▶️ <Player> (if any)
                            // 4 Size/Res line (💾 <SIZE> 🎦 <RES> | only if at least one present)
                            // 5 Proxy line 🌐 Proxy (ON|OFF)
                            // (Provider label removed from multiline)
                            const outLines: string[] = [];
                            outLines.push(`🎬 ${baseLine}`);
                            outLines.push(`🗣 [${isSub ? 'SUB' : 'ITA'}]`);
                            if (playerName) outLines.push(`▶️ ${playerName}`);
                            // Build size/res combined line before proxy if present
                            let sizeResLine = '';
                            if (sizeHuman || resHuman) {
                                if (sizeHuman && resHuman) {
                                    sizeResLine = `💾 ${sizeHuman.replace(/B$/, 'B')} 🎦 ${resHuman}`;
                                } else if (sizeHuman) {
                                    sizeResLine = `💾 ${sizeHuman.replace(/B$/, 'B')}`;
                                } else if (resHuman) {
                                    sizeResLine = `🎦 ${resHuman}`; // resolution only
                                }
                            }
                            if (sizeResLine) outLines.push(sizeResLine);
                            outLines.push(`🌐 Proxy (${proxyOn ? 'ON' : 'OFF'})`);
                            const unifiedTitle = outLines.join('\n');
                            // ---------------- BINGE GROUP LOGIC (CUSTOM MAP) ----------------
                            // Richiesta utente:
                            // vixsrc: (invariato) vixsrc-(direct|directFHD|proxy|proxyFHD)
                            // animeunity:  animeunity-std-ita | animeunity-std-sub
                            // animeworld:  animeworld-std-ita | animeworld-std-sub
                            // animesaturn: animesaturn-std-ita | animesaturn-std-sub
                            // eurostreaming: eurostreaming-ita | eurostreaming-sub
                            // cb01: cb01-std
                            // guardahd: guardahd-std (tutti) | guardahd-prx (solo mixdrop)
                            // guardaserie: guardaserie-std
                            // Altri provider (fallback): providerKey-std
                            // Nota: determinazione lingua basata su isSub (SUB vs ITA)
                            let bingeGroup: string;
                            if (providerKey === 'vixsrc') {
                                // Manteniamo la logica esistente per le 4 varianti
                                let variant = 'base';
                                const isFhdVariant = isSynthetic || /FHD/i.test(rawTitle) || /1080p/i.test(rawTitle);
                                if (isFhdVariant) variant = proxyOn ? 'proxyFHD' : 'directFHD';
                                else variant = proxyOn ? 'proxy' : 'direct';
                                bingeGroup = `${providerKey}-${variant}`;
                            } else {
                                switch (providerKey) {
                                    case 'animeunity':
                                    case 'animeworld':
                                    case 'animesaturn':
                                        bingeGroup = `${providerKey}-std-${isSub ? 'sub' : 'ita'}`;
                                        break;
                                    case 'eurostreaming':
                                        bingeGroup = `eurostreaming-${isSub ? 'sub' : 'ita'}`;
                                        break;
                                    case 'cb01':
                                        bingeGroup = 'cb01-std';
                                        break;
                                    case 'guardahd': {
                                        // Identifica mixdrop (playerName o rawTitle)
                                        const isMix = /mixdrop/i.test(playerName || '') || /mixdrop/i.test(rawTitle);
                                        bingeGroup = isMix ? 'guardahd-prx' : 'guardahd-std';
                                        break;
                                    }
                                    case 'guardaserie':
                                        bingeGroup = 'guardaserie-std';
                                        break;
                                    case 'loonex':
                                        bingeGroup = 'loonex-std';
                                        break;
                                    case 'toonitalia':
                                        bingeGroup = 'toonitalia-std';
                                        break;
                                    default:
                                        bingeGroup = `${providerKey}-std`;
                                }
                            }
                            const existingHints = (st as any).behaviorHints || {};
                            const mergedHints = { ...existingHints, bingeGroup };
                            return { ...st, title: unifiedTitle, name: providerLabel(providerKey, isFhdOrDual), behaviorHints: mergedHints } as Stream;
                        });
                    };
                    const runProvider = async (name: string, enabled: boolean, handler: () => Promise<{ streams: Stream[] }>, streamName: string, isMixdropSensitive = false, timeoutMs: number | null = null) => {
                        if (enabled) {
                            try {
                                let result;

                                if (timeoutMs !== null && timeoutMs > 0) {
                                    // Provider con timeout personalizzato
                                    const timeoutPromise = new Promise<{ streams: Stream[] }>((_, reject) => {
                                        setTimeout(() => reject(new Error(`${name} timeout after ${timeoutMs}ms`)), timeoutMs);
                                    });
                                    result = await Promise.race([handler(), timeoutPromise]);
                                } else {
                                    // Provider senza timeout (comportamento attuale)
                                    result = await handler();
                                }

                                if (result && result.streams) {
                                    const prepared = result.streams.map(s => {
                                        if (isMixdropSensitive) {
                                            const isMixdrop = s.title ? /\b(mixdrop|streamtape)\b/i.test(s.title) : false;
                                            return { ...s, name: isMixdrop ? streamName.replace(' 🔓', '') : streamName } as Stream;
                                        }
                                        return { ...s, name: streamName } as Stream;
                                    });
                                    const unified = unifyStreams(prepared, streamName);
                                    for (const u of unified) allStreams.push(u);
                                }
                            } catch (error) {
                                console.error(`🚨 ${name} error:`, error);
                            }
                        }
                    };

                    // VixSrc PRIMA di tutti (se abilitato)
                    if (vixsrcEnabled && !id.startsWith('kitsu:') && !id.startsWith('mal:') && !id.startsWith('tv:')) {
                        vixsrcScheduled = true;
                        providerPromises.push(runProvider('VixSrc', true, async () => {
                            const finalConfig: ExtractorConfig = {
                                tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0',
                                mfpUrl: mfpUrl,
                                mfpPsw: mfpPsw,
                                // vixLocal flag removed (property not in config)
                                vixDual: !!(config as any)?.vixDual,
                                // API Mode: force vixDirect=true, disable FHD (no proxy needed)
                                vixDirect: isDirectAPICall ? true : ((config as any)?.vixDirect === true),
                                vixDirectFhd: isDirectAPICall ? false : ((config as any)?.vixDirectFhd === true),
                                vixProxy: isDirectAPICall ? false : ((config as any)?.vixProxy === true),
                                vixProxyFhd: isDirectAPICall ? false : ((config as any)?.vixProxyFhd === true),
                                addonBase: (config as any)?.addonBase || (() => {
                                    try {
                                        const proto = (process.env.EXTERNAL_PROTOCOL || 'https');
                                        const host = (process.env.EXTERNAL_HOST || process.env.HOST || process.env.VERCEL_URL || '').replace(/\/$/, '');
                                        if (host) return `${proto}://${host}`;
                                        return '';
                                    } catch { return ''; }
                                })()
                            };
                            console.log('[VixSrc][ParallelConfig]', { vixLocal: finalConfig.vixLocal, vixDual: finalConfig.vixDual, addonBase: finalConfig.addonBase });
                            const res: VixCloudStreamInfo[] | null = await getStreamContent(id, type, finalConfig);
                            if (!res) return { streams: [] };
                            const fmtBytes = (n: number): string => {
                                const units = ['B', 'KB', 'MB', 'GB', 'TB'];
                                let v = n; let u = 0; while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
                                return `${v.toFixed(v >= 10 || u === 0 ? 0 : 1)} ${units[u]}`;
                            };
                            const streams: Stream[] = [];
                            for (const st of res) {
                                if (!st.streamUrl) continue;
                                let adjustedName = st.name || '';
                                adjustedName = adjustedName.replace(/\s*•\s*\[ITA\]$/i, ' • [ITA]');
                                adjustedName = adjustedName.replace(/\s*\[ITA\]$/i, ' • [ITA]');
                                let finalTitle = adjustedName;
                                if (typeof st.sizeBytes === 'number') {
                                    const sizeLabel = st.sizeBytes > 0 ? fmtBytes(st.sizeBytes) : '?';
                                    finalTitle = `${adjustedName}\n💾 ${sizeLabel}`;
                                }
                                streams.push({ title: finalTitle, url: st.streamUrl, behaviorHints: { notWebReady: true, headers: { Referer: st.referer } } as any, isSyntheticFhd: st.isSyntheticFhd, originalName: (st as any).originalName } as any);
                            }
                            return { streams };
                        }, providerLabel('vixsrc'), false, 30000));  // VixSrc: timeout 30s
                    }


                    // === GUARDOSERIE PROVIDER (Movie/Series) ===
                    if (guardoserieEnabled && ((type as string) === 'movie' || (type as string) === 'series')) {
                        providerPromises.push(runProvider('Guardoserie', true, async () => {
                            try {
                                const gsStreams = await getGuardoserieStreams(type, id, (config as any).tmdbApiKey, mfpUrl, mfpPsw);
                                if (gsStreams && gsStreams.length > 0) {
                                    console.log(`✅ [Guardoserie] Found ${gsStreams.length} streams for ${id}`);
                                    return { streams: gsStreams };
                                }
                            } catch (e) {
                                console.error(`❌ [Guardoserie] Error processing ${id}:`, e);
                            }
                            return { streams: [] };
                        }, providerLabel('guardoserie'), false, 30000));
                    }

                    // === GUARDAFLIX PROVIDER (Movie Only) ===
                    if (guardaflixEnabled && ((type as string) === 'movie')) {
                        providerPromises.push(runProvider('Guardaflix', true, async () => {
                            try {
                                const gfStreams = await getGuardaflixStreams(type, id, (config as any).tmdbApiKey, mfpUrl, mfpPsw);
                                if (gfStreams && gfStreams.length > 0) {
                                    console.log(`✅ [Guardaflix] Found ${gfStreams.length} streams for ${id}`);
                                    return { streams: gfStreams };
                                }
                            } catch (e) {
                                console.error(`❌ [Guardaflix] Error processing ${id}:`, e);
                            }
                            return { streams: [] };
                        }, providerLabel('guardaflix'), false, 30000));
                    }

                    // AnimeUnity
                    providerPromises.push(runProvider('AnimeUnity', animeUnityEnabled, async () => {
                        const animeUnityProvider = new AnimeUnityProvider(animeUnityConfig);
                        let res;
                        if (id.startsWith('kitsu:')) res = await animeUnityProvider.handleKitsuRequest(id);
                        else if (id.startsWith('mal:')) res = await animeUnityProvider.handleMalRequest(id);
                        else if (id.startsWith('tt')) res = await animeUnityProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                        else if (id.startsWith('tmdb:')) res = await animeUnityProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                        else res = { streams: [] };
                        // Uniforma pattern VixSrc: non manipolare multi-line title qui; providerLabel userà isSyntheticFhd
                        return res;
                    }, providerLabel('animeunity'), false, 30000));  // AnimeUnity: timeout 30s

                    // AnimeSaturn
                    providerPromises.push(runProvider('AnimeSaturn', animeSaturnEnabled, async () => {
                        const { AnimeSaturnProvider } = await import('./providers/animesaturn-provider');
                        const animeSaturnProvider = new AnimeSaturnProvider(animeSaturnConfig);
                        if (id.startsWith('kitsu:')) return animeSaturnProvider.handleKitsuRequest(id);
                        if (id.startsWith('mal:')) return animeSaturnProvider.handleMalRequest(id);
                        if (id.startsWith('tt')) return animeSaturnProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                        if (id.startsWith('tmdb:')) return animeSaturnProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                        return { streams: [] };
                    }, providerLabel('animesaturn'), false, 30000));  // AnimeSaturn: timeout 30s

                    // AnimeWorld
                    providerPromises.push(runProvider('AnimeWorld', animeWorldEnabled, async () => {
                        const { AnimeWorldProvider } = await import('./providers/animeworld-provider');
                        const animeWorldProvider = new AnimeWorldProvider(animeWorldConfig);
                        if (id.startsWith('kitsu:')) return animeWorldProvider.handleKitsuRequest(id);
                        if (id.startsWith('mal:')) return animeWorldProvider.handleMalRequest(id);
                        if (id.startsWith('tt')) return animeWorldProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                        if (id.startsWith('tmdb:')) return animeWorldProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                        return { streams: [] };
                    }, providerLabel('animeworld'), false, 30000));  // AnimeWorld: timeout 30s

                    // GuardaSerie
                    if (guardaSerieEnabled && (id.startsWith('tt') || id.startsWith('tmdb:'))) {
                        providerPromises.push(runProvider('GuardaSerie', true, async () => {
                            const { GuardaSerieProvider } = await import('./providers/guardaserie-provider');
                            const gsProvider = new GuardaSerieProvider({
                                enabled: true,
                                tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0',
                                mfpUrl: mfpUrl,
                                mfpPassword: mfpPsw
                            });
                            if (id.startsWith('tt')) return gsProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                            if (id.startsWith('tmdb:')) return gsProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                            return { streams: [] };
                        }, providerLabel('guardaserie'), false, 30000));  // GuardaSerie: timeout 30s
                    }

                    // GuardaHD
                    if (guardaHdEnabled && (id.startsWith('tt') || id.startsWith('tmdb:'))) {
                        providerPromises.push(runProvider('GuardaHD', true, async () => {
                            const { GuardaHdProvider } = await import('./providers/guardahd-provider');
                            const ghProvider = new GuardaHdProvider({
                                enabled: true,
                                tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0',
                                mfpUrl: mfpUrl,
                                mfpPassword: mfpPsw
                            });
                            if (id.startsWith('tt')) return ghProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                            if (id.startsWith('tmdb:')) return ghProvider.handleTmdbRequest(id.replace('tmdb:', ''), seasonNumber, episodeNumber, isMovie);
                            return { streams: [] };
                        }, providerLabel('guardahd'), true, 30000));  // GuardaHD: timeout 30s
                    }

                    // CB01 (Mixdrop only)
                    if (cb01Enabled && (id.startsWith('tt'))) {
                        providerPromises.push(runProvider('CB01', true, async () => {
                            const { Cb01Provider } = await import('./providers/cb01-provider');
                            const cbProvider = new Cb01Provider({
                                enabled: true,
                                mfpUrl: mfpUrl,
                                mfpPassword: mfpPsw,
                                tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0'
                            });
                            return cbProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                        }, providerLabel('cb01'), true, 30000));  // CB01: timeout 30s
                    }

                    // Eurostreaming
                    if (eurostreamingEnabled && id.startsWith('tt') && seasonNumber != null && episodeNumber != null) {
                        providerPromises.push(runProvider('Eurostreaming', true, async () => {
                            const { EurostreamingProvider } = await import('./providers/eurostreaming-provider');
                            const esProvider = new EurostreamingProvider({
                                enabled: true,
                                mfpUrl: mfpUrl,
                                mfpPassword: mfpPsw,
                                tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0'
                            });
                            return esProvider.handleImdbRequest(id, seasonNumber, episodeNumber, isMovie);
                        }, providerLabel('eurostreaming'), true, 30000));  // Eurostreaming: timeout 30s
                    }

                    // Loonex (serie TV)
                    if (loonexEnabled && type === 'series' && seasonNumber != null && episodeNumber != null && (id.startsWith('tt') || id.startsWith('tmdb:'))) {
                        providerPromises.push(runProvider('Loonex', true, async () => {
                            const { getLoonexStreams } = await import('./providers/loonex-provider');
                            // Extract IDs from the request
                            const tmdbId = id.startsWith('tmdb:') ? id.replace('tmdb:', '').split(':')[0] : undefined;
                            const imdbId = id.startsWith('tt') ? id.split(':')[0] : '';
                            console.log(`[DEBUG-LOONEX] Calling getLoonexStreams: type=${type}, imdbId=${imdbId}, tmdbId=${tmdbId}, S${seasonNumber}E${episodeNumber}`);
                            // Non passiamo il titolo, lo recupererà da TMDb
                            const streams = await getLoonexStreams(type, imdbId, undefined, seasonNumber, episodeNumber, tmdbId);
                            return { streams };
                        }, providerLabel('loonex'), false, 30000));  // Loonex: timeout 30s
                    }

                    // ToonItalia (serie TV/Anime) - Ricerca dinamica via TMDb
                    if (toonitaliaEnabled && seasonNumber != null && episodeNumber != null) {
                        providerPromises.push(runProvider('ToonItalia', true, async () => {
                            const { toonitalia } = await import('./providers/toonitalia-provider');

                            // Costruisci ID nel formato appropriato
                            let requestId: string;
                            if (id.startsWith('tt')) {
                                // IMDb ID: "tt1234567:season:episode"
                                requestId = `${id.split(':')[0]}:${seasonNumber}:${episodeNumber}`;
                            } else if (id.startsWith('tmdb:')) {
                                // TMDb ID: "tmdb:12345:season:episode"
                                const tmdbId = id.replace('tmdb:', '').split(':')[0];
                                requestId = `tmdb:${tmdbId}:${seasonNumber}:${episodeNumber}`;
                            } else {
                                // Fallback (shouldn't happen)
                                console.log('[ToonItalia] Unknown ID format:', id);
                                return { streams: [] };
                            }

                            console.log(`[ToonItalia] Calling provider with: ${requestId}`);
                            const streams = await toonitalia({
                                id: requestId,
                                type: type as 'movie' | 'series',
                                config: {
                                    mfpUrl: mfpUrl || '',
                                    mfpPsw: mfpPsw || '',
                                    tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0'
                                }
                            });
                            return { streams };
                        }, 'ToonItalia', false, 30000));  // ToonItalia: timeout 30s
                    }


                    await Promise.all(providerPromises);

                    // Post-process AnimeUnity streams to apply FHD badge similarly to VixSrc
                    try {
                        let auAdjusted = 0;
                        for (const s of allStreams) {
                            const lowerName = (s.name || s.title || '').toLowerCase();
                            if (lowerName.includes('anime unity')) {
                                const isFhd = !!((s as any).isSyntheticFhd || s.behaviorHints?.animeunityQuality === 'FHD' || /fhd/.test(s.title || ''));
                                const before = s.name;
                                s.name = providerLabel('animeunity', isFhd);
                                if (isFhd) auAdjusted++;
                                if (isFhd) {
                                    try { console.log('[AnimeUnity][LabelPass] Marked FHD stream name:', before, '->', s.name); } catch { }
                                }
                            }
                        }
                        if (auAdjusted) console.log(`[AnimeUnity][LabelPass] FHD badge applied to ${auAdjusted} stream(s)`);
                        else console.log('[AnimeUnity][LabelPass] Nessun stream FHD marcato (controllare estrazione variante)');
                    } catch (e) {
                        console.warn('[AnimeUnity][LabelPass] errore post-process badge FHD:', (e as any)?.message || e);
                    }

                    // Post-process ToonItalia streams to apply unified label
                    try {
                        for (const s of allStreams) {
                            const lowerName = (s.name || s.title || '').toLowerCase();
                            if (lowerName.includes('toonitalia')) {
                                s.name = mapLegacyProviderName(s.name || 'ToonItalia');
                            }
                        }
                    } catch (e) {
                        console.warn('[ToonItalia][LabelPass] errore post-process label:', (e as any)?.message || e);
                    }
                }

                if (!vixsrcScheduled && !id.startsWith('kitsu:') && !id.startsWith('mal:') && !id.startsWith('tv:')) {
                    // FIX: se disableVixsrc è true, salta solo VixSrc ma non fare early return (blocca trailer!)
                    const skipVixsrc = (config as any).disableVixsrc === true;
                    if (!skipVixsrc) {
                        const finalConfig: ExtractorConfig = {
                            tmdbApiKey: config.tmdbApiKey || process.env.TMDB_API_KEY || '40a9faa1f6741afb2c0c40238d85f8d0',
                            mfpUrl: mfpUrl,
                            mfpPsw: mfpPsw,
                            // vixLocal flag removed
                            vixDual: !!(config as any)?.vixDual,
                            vixDirect: (config as any)?.vixDirect === true,
                            vixDirectFhd: (config as any)?.vixDirectFhd === true,
                            vixProxy: (config as any)?.vixProxy === true,
                            vixProxyFhd: (config as any)?.vixProxyFhd === true,
                            addonBase: (config as any)?.addonBase || ''
                        };
                        const res: VixCloudStreamInfo[] | null = await getStreamContent(id, type, finalConfig);
                        if (res) {
                            for (const st of res) {
                                if (!st.streamUrl) continue;
                                let rawBase = (st.name || '').replace(/\s*•\s*\[ITA\]$/i, '').replace(/\s*\[ITA\]$/i, '').trim();
                                if (/^(Synthetic FHD|Proxy FHD)$/i.test(rawBase) && (st as any).originalName) {
                                    rawBase = (st as any).originalName;
                                }
                                let unified = buildUnifiedStreamName({
                                    baseTitle: rawBase || 'VixSrc',
                                    isSub: /\bsub\b|\[sub\]/i.test(st.name || ''),
                                    sizeBytes: undefined, // non includere size per coerenza esempio
                                    playerName: undefined,
                                    proxyOn: st.source === 'proxy',
                                    provider: 'vixsrc',
                                    isFhdOrDual: !!st.isSyntheticFhd
                                });
                                const parts = unified.split('\n');
                                if (parts.length && /^🤌\s/.test(parts[parts.length - 1])) parts.pop();
                                unified = parts.join('\n');
                                allStreams.push({ title: unified, name: providerLabel('vixsrc', !!st.isSyntheticFhd), url: st.streamUrl, behaviorHints: { notWebReady: true, headers: { Referer: st.referer } } as any, originalName: (st as any).originalName });
                            }
                        }
                    } // close if (!skipVixsrc)
                } // close if (!vixsrcScheduled && ...)
                // === ORDINAMENTO STREAM TV STATICI PER PRIORITÀ ===
                // Applica ordinamento priorità per canali TV (prima di ordinamento provider)
                try {
                    if (type === 'tv' && allStreams.length > 1) {
                        sortStreamsByPriority(allStreams);
                        debugLog(`[StaticStreams][TV] Stream ordinati per priorità: ${allStreams.length} totali`);
                    }
                } catch (sortErr) {
                    debugLog(`[StaticStreams][TV] Errore ordinamento:`, String((sortErr as any)?.message || sortErr));
                }
                // Global provider ordering (VixSrc first) - per serie/film
                try {
                    const rank = (n: string): number => {
                        const l = n.toLowerCase();
                        if (l.includes('vixsrc') || l.includes('streamingcommunity')) return 0;
                        if (l.includes('anime unity')) return 1;
                        if (l.includes('anime saturn')) return 2;
                        if (l.includes('anime world')) return 3;
                        if (l.includes('guardaserie')) return 4;
                        if (l.includes('guardahd')) return 5;
                        if (l.includes('cb01')) return 6;
                        if (l.includes('eurostreaming')) return 8;
                        return 50;
                    };
                    // Ordina per provider solo se NON è TV (movie/series mantengono ordinamento provider)
                    if (type !== 'tv') {
                        allStreams.sort((a, b) => rank((a.name || a.title || '').toString()) - rank((b.name || b.title || '').toString()));
                    }
                } catch { }

                // === TRAILER ITALIANO (TMDB) - Prima posizione ===
                // Aggiungi trailer SOLO per movie/series (non TV live) se abilitato
                // trailerEnabled already defined above (default: true if undefined)
                if (type !== 'tv' && trailerEnabled && isTrailerProviderAvailable()) {
                    try {
                        // Estrai imdbId, season, episode dall'id (formato: tt123456:season:episode)
                        const idParts = id.split(':');
                        const imdbId = idParts[0];
                        const season = idParts.length > 1 ? parseInt(idParts[1], 10) : undefined;
                        const episode = idParts.length > 2 ? parseInt(idParts[2], 10) : undefined;

                        // Per le serie: mostra trailer SOLO per episodi 1 e 2 di ogni stagione
                        if (type === 'series' && episode !== undefined && episode > 2) {
                            // Skip trailer for episodes 3+
                        } else if (imdbId.startsWith('tt')) {
                            const contentType = type === 'series' ? 'series' : 'movie';
                            // Pass undefined for contentName (fallback format), season for series-specific trailer
                            const trailerStreams = await getTrailerStreams(contentType, imdbId, undefined, season);
                            if (trailerStreams && trailerStreams.length > 0) {
                                // Prependi trailer come primo stream
                                allStreams.unshift(...trailerStreams as any);
                                console.log(`🎬 Added ${trailerStreams.length} trailer(s) for ${imdbId}${season ? ` S${season}` : ''}`);
                            }
                        }
                    } catch (trailerErr) {
                        console.warn('[Trailer] Error fetching trailer:', (trailerErr as any)?.message || trailerErr);
                    }
                }

                console.log(`✅ Total streams returned: ${allStreams.length}`);
                return { streams: allStreams };
            } catch (error) {
                console.error('Stream extraction failed:', error);
                return { streams: [] };
            }
        }
    );

    return builder;
}

// Server Express
const app = express();
// Trust proxy chain so req.ip / req.ips use X-Forwarded-For correctly when behind a proxy/CDN
try { (app as any).set('trust proxy', true); } catch { }

// PRIORITY: Configure routes must be first to avoid conflicts with global router
// Single, minimal Configure handler: '/{config}/configure'
app.get(/^\/(.+)\/configure\/?$/, (req: Request, res: Response) => {
    try {
        const base = loadCustomConfig();
        // First capture group includes everything between the first slash and '/configure'
        const between = (req.params as any)[0] as string;
        const rawQueryCfg = typeof req.query.config === 'string' ? (req.query.config as string) : undefined;
        const cfgFromUrl = between ? parseConfigFromArgs(between) : (rawQueryCfg ? parseConfigFromArgs(rawQueryCfg) : {});
        const manifestWithDefaults: any = { ...base };
        if (Array.isArray(manifestWithDefaults.config)) {
            manifestWithDefaults.config = manifestWithDefaults.config.map((c: any) => {
                const val = (cfgFromUrl as any)?.[c?.key];
                if (typeof val !== 'undefined') return { ...c, default: c.type === 'checkbox' ? !!val : String(val) };
                return c;
            });
        }
        res.setHeader('Content-Type', 'text/html');
        return res.send(landingTemplate(manifestWithDefaults));
    } catch (e) {
        console.error('❌ Configure (regex) error:', (e as any)?.message || e);
        const manifest = loadCustomConfig();
        res.setHeader('Content-Type', 'text/html');
        return res.send(landingTemplate(manifest));
    }
});


app.use('/public', express.static(path.join(__dirname, '..', 'public')));

// Redirect convenience: allow /stream/tv/<id> (no .json) -> proper .json endpoint
app.get('/stream/tv/:id', (req: Request, res: Response, next: NextFunction) => {
    // Se già termina con .json non fare nulla
    if (req.originalUrl.endsWith('.json')) return next();
    const id = req.params.id;
    const q = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
    const target = `/stream/tv/${id}.json${q}`;
    res.redirect(302, target);
});

// Salva l'ultima request Express per fallback nel catalog handler (quando il router interno non passa req)
app.use((req: Request, _res: Response, next: NextFunction) => {
    (global as any).lastExpressRequest = req;
    next();
});

// ✅ CORRETTO: Annotazioni di tipo esplicite per Express
app.get('/', (_: Request, res: Response) => {
    const manifest: any = loadCustomConfig();
    try {
        // Resolve addon base exactly like extractor fallback chain
        const envBase = process.env.ADDON_BASE_URL || process.env.STREAMVIX_ADDON_BASE || '';
        const DEFAULT_ADDON_BASE = 'https://streamvix.hayd.uk';
        let resolved = '';
        if (manifest && typeof manifest === 'object' && manifest.addonBase) {
            resolved = String(manifest.addonBase);
        }
        if (!resolved && envBase && envBase.startsWith('http')) {
            resolved = envBase.replace(/\/$/, '');
        }
        if (!resolved) {
            resolved = DEFAULT_ADDON_BASE; // final fallback (mirrors extractor.ts logic)
        }
        manifest.__resolvedAddonBase = resolved; // inject for landing page display only (not part of config serialization)
    } catch (e) {
        console.warn('[Landing] addonBase resolution failed:', (e as any)?.message || e);
    }
    const landingHTML = landingTemplate(manifest);
    res.setHeader('Content-Type', 'text/html');
    res.send(landingHTML);
});

// Serve manifest dynamically so we can hide TV catalog when disableLiveTv is true
// Also supports config passed via path segment or query string (?config=...)
// CORS for manifest endpoints
app.options(['/manifest.json', '/:config/manifest.json', '/cfg/:config/manifest.json'], (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.sendStatus(204);
});

app.get(['/manifest.json', '/:config/manifest.json', '/cfg/:config/manifest.json'], (req: Request, res: Response) => {
    try {
        const base = loadCustomConfig();
        // Parse optional config from URL segment OR query string (?config=...)
        const rawParamCfg = (req.params as any)?.config;
        const rawQueryCfg = typeof req.query.config === 'string' ? (req.query.config as string) : undefined;
        const cfgFromUrl = rawParamCfg ? parseConfigFromArgs(rawParamCfg) : (rawQueryCfg ? parseConfigFromArgs(rawQueryCfg) : {});
        // Build a manifest copy with defaults prefilled from cfgFromUrl or runtime cache
        const manifestWithDefaults: any = { ...base };
        const sourceCfg = (cfgFromUrl && Object.keys(cfgFromUrl).length) ? cfgFromUrl : (configCache as any);
        if (Array.isArray(manifestWithDefaults.config) && manifestWithDefaults.config.length) {
            manifestWithDefaults.config = manifestWithDefaults.config.map((c: any) => {
                const key = c?.key;
                if (!key) return c;
                const val = (sourceCfg as any)?.[key];
                if (typeof val !== 'undefined') {
                    if (c.type === 'checkbox') return { ...c, default: !!val };
                    else return { ...c, default: String(val) };
                }
                return c;
            });
        }
        const effectiveDisable = (cfgFromUrl as any)?.disableLiveTv ?? (configCache as any)?.disableLiveTv;
        const filtered: Manifest = { ...manifestWithDefaults } as Manifest;
        if (!Array.isArray((filtered as any).catalogs)) (filtered as any).catalogs = [];
        if (effectiveDisable) {
            const cats = Array.isArray(filtered.catalogs) ? filtered.catalogs.slice() : [];
            // Rimuovi ENTRAMBI i cataloghi TV (streamvix_tv + streamvix_live) quando disabilitato
            filtered.catalogs = cats.filter((c: any) =>
                !(c && ((c as any).id === 'streamvix_tv' || (c as any).id === 'streamvix_live'))
            );
        }

        // Rimuovi catalogo DVR quando dvrEnabled non è attivo
        const effectiveDvr = (cfgFromUrl as any)?.dvrEnabled ?? (configCache as any)?.dvrEnabled;
        if (!effectiveDvr) {
            filtered.catalogs = (filtered.catalogs || []).filter((c: any) =>
                !(c && (c as any).id === 'streamvix_dvr')
            );
        }
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
        res.json(filtered);
    } catch (e: any) {
        console.error('❌ Manifest route error:', e?.message || e);
        const fallback = loadCustomConfig();
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
        res.json(fallback);
    }
});

// Endpoint sintetico: genera mini-master con sola variante video massima e traccia AUDIO italiana
// Supporta sia /vixsynthetic che /vixsynthetic.m3u8 per compatibilità player
app.get(['/vixsynthetic', '/vixsynthetic.m3u8'], async (req: Request, res: Response) => {
    try {
        const src = typeof req.query.src === 'string' ? req.query.src : '';
        if (!src) return res.status(400).send('#EXTM3U\n# Missing src');
        const langPref = ((req.query.lang as string) || 'it').toLowerCase();
        const multiFlag = (() => {
            const m = String(req.query.multi || '').toLowerCase();
            if (['1', 'true', 'on', 'yes', 'all'].includes(m)) return true;
            if (String(req.query.languages || '').toLowerCase() === 'all') return true;
            return false;
        })();
        if (multiFlag) console.log('[vixsynthetic] multi-language mode attivo');
        const r = await fetch(src, { headers: { 'Accept': 'application/vnd.apple.mpegurl, application/x-mpegURL, */*' } as any });
        if (!r.ok) return res.status(502).send('#EXTM3U\n# Upstream error');
        const text = await r.text();
        // Se non è master, restituisci com'è
        if (!/#EXT-X-STREAM-INF:/i.test(text)) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(text);
        }
        const lines = text.split(/\r?\n/);
        interface Variant { url: string; height: number; bandwidth: number; info: string; };
        const variants: Variant[] = [];
        const media: { line: string; attrs: Record<string, string>; }[] = [];
        const parseAttrs = (l: string): Record<string, string> => {
            const out: Record<string, string> = {}; l.replace(/([A-Z0-9-]+)=(("[^"]+")|([^,]+))/g, (_m, k, v) => { const val = String(v).replace(/^"|"$/g, ''); out[k] = val; return ''; }); return out;
        };
        for (let i = 0; i < lines.length; i++) {
            const l = lines[i];
            if (l.startsWith('#EXT-X-MEDIA:')) {
                media.push({ line: l, attrs: parseAttrs(l) });
            }
            if (l.startsWith('#EXT-X-STREAM-INF:')) {
                const info = l;
                const next = lines[i + 1] || '';
                if (!next || next.startsWith('#')) continue;
                const attrs = parseAttrs(info);
                let h = 0; let bw = 0;
                if (attrs['RESOLUTION']) {
                    const m = attrs['RESOLUTION'].match(/(\d+)x(\d+)/); if (m) h = parseInt(m[2], 10) || 0;
                }
                if (attrs['BANDWIDTH']) bw = parseInt(attrs['BANDWIDTH'], 10) || 0;
                // Resolve relative
                let vUrl = next.trim();
                try { vUrl = new URL(vUrl, src).toString(); } catch { }
                variants.push({ url: vUrl, height: h, bandwidth: bw, info });
            }
        }
        if (!variants.length) {
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
            return res.send(text);
        }
        variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
        const best = variants[0];
        const header: string[] = ['#EXTM3U'];
        const copyTags = ['#EXT-X-VERSION', '#EXT-X-INDEPENDENT-SEGMENTS'];
        for (const t of copyTags) { if (text.includes(t)) header.push(t); }

        if (multiFlag) {
            // In modalità multi includiamo tutte le righe #EXT-X-MEDIA (AUDIO e SUBTITLES) e manteniamo il GROUP-ID originale.
            const audioGroupsEncountered: Set<string> = new Set();
            const subtitleGroupsEncountered: Set<string> = new Set();
            for (const m of media) {
                const type = (m.attrs['TYPE'] || '').toUpperCase();
                if (type === 'AUDIO') {
                    header.push(m.line);
                    if (m.attrs['GROUP-ID']) audioGroupsEncountered.add(m.attrs['GROUP-ID']);
                } else if (type === 'SUBTITLES') {
                    header.push(m.line);
                    if (m.attrs['GROUP-ID']) subtitleGroupsEncountered.add(m.attrs['GROUP-ID']);
                }
            }
            // Forziamo la variante best ad usare il primo gruppo audio se presente
            let streamInf = best.info;
            if (audioGroupsEncountered.size) {
                const firstAudio = [...audioGroupsEncountered][0];
                if (/AUDIO="/.test(streamInf)) streamInf = streamInf.replace(/AUDIO="[^"]+"/, `AUDIO="${firstAudio}"`);
                else streamInf = streamInf.replace('#EXT-X-STREAM-INF:', `#EXT-X-STREAM-INF:AUDIO="${firstAudio}",`);
            }
            header.push(streamInf);
            header.push(best.url);
        } else {
            // Modalità singola (compatibile precedente): seleziona solo la traccia richiesta (langPref)
            let chosenGroup: string | null = null;
            let chosenMediaLine: string | null = null;
            for (const m of media) {
                const type = (m.attrs['TYPE'] || '').toUpperCase();
                if (type !== 'AUDIO') continue;
                const lang = (m.attrs['LANGUAGE'] || '').toLowerCase();
                const name = (m.attrs['NAME'] || '').toLowerCase();
                if (lang === langPref || name.includes(langPref)) {
                    chosenGroup = m.attrs['GROUP-ID'] || null;
                    chosenMediaLine = m.line;
                    break;
                }
            }
            if (!chosenGroup && media.length) {
                const firstAudio = media.find(m => (m.attrs['TYPE'] || '').toUpperCase() === 'AUDIO');
                if (firstAudio) { chosenGroup = firstAudio.attrs['GROUP-ID'] || null; chosenMediaLine = firstAudio.line; }
            }
            if (chosenMediaLine && chosenGroup) header.push(chosenMediaLine);
            let streamInf = best.info;
            if (chosenGroup) {
                if (/AUDIO="/.test(streamInf)) streamInf = streamInf.replace(/AUDIO="[^"]+"/, `AUDIO="${chosenGroup}"`);
                else streamInf = streamInf.replace('#EXT-X-STREAM-INF:', `#EXT-X-STREAM-INF:AUDIO="${chosenGroup}",`);
            }
            header.push(streamInf);
            header.push(best.url);
        }
        const mini = header.join('\n') + '\n';
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        res.send(mini);
    } catch (e) {
        console.error('[vixsynthetic] error:', (e as any)?.message || e);
        res.status(500).send('#EXTM3U\n# internal error');
    }
});

// ========== DLHD ENDPOINTS ==========
// Endpoint principale: genera manifest con chiave proxata
app.get(['/dlhd', '/dlhd.m3u8'], async (req: Request, res: Response) => {
    try {
        const src = typeof req.query.src === 'string' ? req.query.src : '';
        if (!src) {
            console.error('[DLHD] Missing src parameter');
            return res.status(400).send('#EXTM3U\n# Missing src parameter');
        }

        // No logging in production - completely silent

        // Import dynamically to avoid issues
        const { extractDaddyLiveStream, fetchAndModifyManifest } = await import('./extractors/dlhd');

        // Get addon base URL
        const protocol = req.protocol;
        const host = req.get('host');
        const addonBase = `${protocol}://${host}`;

        // Extract stream info
        const streamInfo = await extractDaddyLiveStream(src);

        // Fetch and modify manifest
        const modifiedManifest = await fetchAndModifyManifest(
            streamInfo.manifestUrl,
            streamInfo.keyUrl,
            streamInfo.headers,
            addonBase
        );

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-store');
        res.send(modifiedManifest);
    } catch (error) {
        console.error('[DLHD] Error processing request:', (error as any)?.message || error);
        res.status(500).send('#EXTM3U\n# Error: ' + ((error as any)?.message || 'Internal error'));
    }
});

// Endpoint per proxare la chiave AES
app.get('/dlhd_key', async (req: Request, res: Response) => {
    try {
        const keyUrl = typeof req.query.keyUrl === 'string' ? req.query.keyUrl : '';
        const userAgent = typeof req.query['h_User-Agent'] === 'string' ? req.query['h_User-Agent'] : '';
        const referer = typeof req.query['h_Referer'] === 'string' ? req.query['h_Referer'] : '';
        const origin = typeof req.query['h_Origin'] === 'string' ? req.query['h_Origin'] : '';

        if (!keyUrl || !userAgent || !referer || !origin) {
            return res.status(400).send('Missing required parameters');
        }

        // Import dynamically
        const { fetchKey } = await import('./extractors/dlhd');

        // Fetch key with headers
        const keyBuffer = await fetchKey(keyUrl, {
            'User-Agent': userAgent,
            'Referer': referer,
            'Origin': origin
        });

        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Cache-Control', 'no-store'); // NO CACHE - keys change frequently!
        res.send(keyBuffer);
    } catch (error) {
        console.error('[DLHD_KEY] ❌ Error:', (error as any)?.message || error);
        res.status(500).send('Error fetching key: ' + ((error as any)?.message || 'Internal error'));
    }
});

// ✅ Middleware semplificato che usa sempre il router globale
app.use((req: Request, res: Response, next: NextFunction) => {
    // ...
    debugLog(`Incoming request: ${req.method} ${req.path}`);
    debugLog(`Full URL: ${req.url}`);
    debugLog(`Path segments:`, req.path.split('/'));
    try {
        const observedIp = getClientIpFromReq(req);
        if (observedIp) vdbg('Observed client IP', { observedIp, reqIp: (req as any).ip, reqIps: (req as any).ips });
    } catch { }

    const configString = req.path.split('/')[1];
    debugLog(`Config string extracted: "${configString}" (length: ${configString ? configString.length : 0})`);

    // ...

    // Parse configuration from URL path segment once (before TV logic)
    // FIX DEFINITIVO: NON scrivere MAI la config dell'utente nella cache globale!
    // Ogni utente ha la sua config nel URL, non deve inquinare quella degli altri.
    // La configCache è per settings del SERVER (env vars), non per config utente.
    if (configString && configString.length > 10 && !configString.startsWith('stream') && !configString.startsWith('meta') && !configString.startsWith('manifest')) {
        const parsedConfig = parseConfigFromArgs(configString);
        if (Object.keys(parsedConfig).length > 0) {
            debugLog('🔧 Found valid config in URL (NOT updating global cache - user-specific)');
            // NON FARE PIÙ: Object.assign(configCache, parsedConfig);

            // ✅ FIX: Se la config era Base64, riscrivi l'URL con JSON per l'SDK Stremio
            // L'SDK Stremio fa JSON.parse() diretto sul segmento, quindi dobbiamo dargli JSON valido
            if (!configString.startsWith('{') && !configString.startsWith('%7B')) {
                // Era Base64, riscrivi URL con JSON
                const jsonConfig = JSON.stringify(parsedConfig);
                const encodedJsonConfig = encodeURIComponent(jsonConfig);
                const oldPath = req.path;
                const newPath = oldPath.replace('/' + configString, '/' + encodedJsonConfig);
                req.url = req.url.replace(oldPath, newPath);
                // NOTE: req.path è read-only, ma il router Stremio SDK usa req.url, quindi basta riscrivere quello
                // Invalida la cache interna di Express per forzare il re-parsing
                (req as any)._parsedUrl = undefined;
                debugLog(`🔄 [Base64→JSON] Rewritten URL for SDK: ${configString.substring(0, 30)}... → ${encodedJsonConfig.substring(0, 50)}...`);
            }
        }
    }

    // Per le richieste di stream TV, assicurati che la configurazione proxy sia sempre presente
    if (req.url.includes('/stream/tv/') || req.url.includes('/stream/tv%3A')) {
        debugLog('📺 TV Stream request detected, ensuring MFP configuration');
        // Non applicare più nessun fallback hardcoded
        // if (!configCache.mfpProxyUrl || !configCache.mfpProxyPassword) { ... } // RIMOSSO
        debugLog('📺 Current proxy config for TV streams:', configCache);
    }

    // ...

    // PATCH: Inject full search query for AnimeWorld catalog search
    if (
        req.path === '/catalog/animeworld/anime/search.json' &&
        req.query && typeof req.query.query === 'string'
    ) {
        debugLog('🔎 PATCH: Injecting full search query from req.query.query:', req.query.query);
        // Ensure req.query.extra is always an object
        let extraObj: any = {};
        if (req.query.extra) {
            if (typeof req.query.extra === 'string') {
                try {
                    extraObj = JSON.parse(req.query.extra);
                } catch (e) {
                    extraObj = {};
                }
            } else if (typeof req.query.extra === 'object') {
                extraObj = req.query.extra;
            }
        }
        extraObj.search = req.query.query;
        req.query.extra = extraObj;
    }

    // ✅ Inizializza il router globale se non è ancora stato fatto
    const currentDisable = !!(configCache as any)?.disableLiveTv;
    const needRebuild = (!globalRouter) || (lastDisableLiveTvFlag !== currentDisable);
    if (needRebuild) {
        if (globalRouter) console.log('🔁 Rebuilding addon router due to config change (disableLiveTv=%s)', currentDisable);
        else console.log('🔧 Initializing global router...');
        globalBuilder = createBuilder(configCache);
        globalAddonInterface = globalBuilder.getInterface();
        globalRouter = getRouter(globalAddonInterface);
        lastDisableLiveTvFlag = currentDisable;
        console.log('✅ Global router %s', needRebuild ? 'initialized/updated' : 'initialized');
    }

    // USA SEMPRE il router globale
    globalRouter(req, res, next);
});


// ============ TVTAP RESOLVE ENDPOINT ============
// Endpoint per risolvere i link TVTap in tempo reale
app.get('/tvtap-resolve/:channelId', async (req: Request, res: Response) => {
    const { channelId } = req.params;
    console.log(`[TVTap] Richiesta risoluzione per canale ID: ${channelId}`);

    try {
        // Chiama lo script Python per ottenere il link stream
        const timeout = setTimeout(() => {
            console.log(`[TVTap] Timeout per canale ID: ${channelId}`);
            res.status(408).json({ error: 'TVTap timeout' });
        }, 10000);

        const options = {
            timeout: 10000,
            env: {
                ...process.env,
                PYTHONPATH: '/usr/local/lib/python3.9/site-packages'
            }
        };

        execFile('python3', [
            path.join(__dirname, '../tvtap_resolver.py'),
            // Se channelId è un numero, usa il formato tvtap_id:, altrimenti cerca per nome
            /^\d+$/.test(channelId) ? `tvtap_id:${channelId}` : channelId
        ], options, (error: Error | null, stdout: string, stderr: string) => {
            clearTimeout(timeout);

            if (error) {
                console.error(`[TVTap] Error resolving channel ${channelId}:`, error.message);
                if (stderr) console.error(`[TVTap] Stderr:`, stderr);
                return res.status(500).json({ error: 'TVTap resolution failed' });
            }

            if (!stdout || stdout.trim() === '') {
                console.log(`[TVTap] No output for channel ${channelId}`);
                return res.status(404).json({ error: 'TVTap stream not found' });
            }

            const streamUrl = stdout.trim();
            console.log(`[TVTap] Resolved channel ${channelId} to: ${streamUrl.substring(0, 50)}...`);

            // Redirigi al link stream
            res.redirect(streamUrl);
        });

    } catch (error) {
        console.error(`[TVTap] Exception resolving channel ${channelId}:`, error);
        res.status(500).json({ error: 'TVTap resolution exception' });
    }
});

// ================= SIMPLE IP HEALTH CHECK =================
// Parity with upstream webstreamr /live ipStatus logic but limited to MostraGuarda only.
let liveProbeLastTs = 0;
let liveProbeBlocked = 0;
let liveProbeErrors = 0;
async function runIpProbe(force = false) {
    if (!force && Date.now() - liveProbeLastTs < 60000) return; // throttle 60s
    liveProbeBlocked = 0;
    liveProbeErrors = 0;
    try {
        await fetchPage('https://mostraguarda.stream', { noCache: true });
    } catch (e: any) {
        const msg = (e?.message || '').toString();
        if (/cloudflare_challenge/i.test(msg) || /http_403/.test(msg) || /(^|[^0-9])403([^0-9]|$)/.test(msg)) liveProbeBlocked++;
        else liveProbeErrors++;
    }
    liveProbeLastTs = Date.now();
}

// GET /live[?forceIpCheck]
app.get('/live', async (req: Request, res: Response) => {
    const force = 'forceIpCheck' in req.query;
    await runIpProbe(force);
    if (liveProbeBlocked > 0) {
        return res.json({ status: 'ok', ipStatus: 'error' });
    }
    if (liveProbeErrors > 0) {
        return res.status(503).json({ status: 'error' });
    }
    return res.json({ status: 'ok', ipStatus: 'ok' });
});

// ================= MANUAL LIVE UPDATE ENDPOINT =================
// GET /live/update?token=XYZ (token optional if LIVE_UPDATE_TOKEN not set)
app.get('/live/update', async (req: Request, res: Response) => {
    try {
        const requiredToken = process?.env?.LIVE_UPDATE_TOKEN;
        const provided = (req.query.token as string) || '';
        if (requiredToken && provided !== requiredToken) {
            return res.status(403).json({ ok: false, error: 'Forbidden' });
        }
        // Esegue Live.py immediatamente (se esiste)
        // Riutilizza executeLiveScript già definita nello scheduler e recupera stdout/stderr
        const execRes = await (async () => { try { return await (executeLiveScript as any)(); } catch { return undefined; } })();
        // Subito dopo Live.py: esegui purge per rimuovere eventi vecchi, mantenendo IERI fino alle 08:00 Rome
        const purgeResult = purgeOldDynamicEvents();
        // Ricarica sempre i canali dinamici dopo il purge
        const dyn = loadDynamicChannels(true);
        const dynPath = getDynamicFilePath();
        const dynStats = getDynamicFileStats();
        // Risposta arricchita con conteggio e uno snippet di stdout/stderr
        const liveStdout: string | undefined = execRes?.stdout ? String(execRes.stdout) : undefined;
        const liveStderr: string | undefined = execRes?.stderr ? String(execRes.stderr) : undefined;
        // Prova a estrarre "Creati X eventi dinamici" dall'output di Live.py
        let createdCount: number | undefined;
        if (liveStdout) {
            try {
                const m = liveStdout.match(/Creati\s+(\d+)\s+eventi\s+dinamici/i);
                if (m) createdCount = parseInt(m[1], 10);
            } catch { }
        }
        const clip = (s?: string) => s ? (s.length > 800 ? s.slice(-800) : s) : undefined; // prendi ultime 800 chars
        return res.json({
            ok: true,
            message: `Live.py eseguito (se presente), purge effettuato e canali ricaricati: eventi dinamici=${dyn.length}${createdCount != null ? ` (creati=${createdCount})` : ''}`,
            dynamicCount: dyn.length,
            createdCount,
            purge: purgeResult,
            dynamicFile: {
                path: dynPath,
                exists: dynStats.exists,
                size: dynStats.size,
                mtime: dynStats.mtimeMs ? new Date(dynStats.mtimeMs).toISOString() : null
            },
            liveStdout: clip(liveStdout),
            liveStderr: clip(liveStderr),
            // eventsRaw: ritorna gli eventi dinamici "grezzi" come richiesto.
            // Per evitare payload eccessivi si può passare ?truncate=1 per includere solo campi chiave.
            eventsRaw: (() => {
                const wantTrunc = 'truncate' in req.query && req.query.truncate !== '0';
                if (!Array.isArray(dyn)) return [];
                if (!wantTrunc) return dyn; // full objects
                return dyn.map(ev => ({
                    id: ev.id,
                    name: ev.name,
                    eventStart: ev.eventStart,
                    category: ev.category,
                    streamsCount: Array.isArray(ev.streams) ? ev.streams.length : 0
                }));
            })()
        });
    } catch (e: any) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});

// ================= MANUAL RELOAD ENDPOINT =====================
// Invalida la cache dinamica e forza una ricarica
app.get('/live/reload', (_: Request, res: Response) => {
    try {
        invalidateDynamicChannels();
        const dyn = loadDynamicChannels(true);
        console.log(`🔄 /live/reload eseguito: canali dinamici attuali=${dyn.length}`);
        res.json({ ok: true, dynamicCount: dyn.length });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
// =============================================================

// ================= THISNOT RELOAD ENDPOINT ====================
// Esegue manualmente l'aggiornamento dei canali ThisNot
app.get('/tn/reload', async (_: Request, res: Response) => {
    try {
        console.log('🔄 [ThisNot] Reload manuale richiesto via endpoint /tn/reload');

        // Importa la funzione di aggiornamento
        const { updateThisNotChannels } = await import('./utils/thisnotChannels');

        // Esegue l'aggiornamento
        await updateThisNotChannels();

        // Ricarica i canali dinamici per ottenere il conteggio aggiornato
        const dyn = loadDynamicChannels(true);
        const thisnotCount = dyn.filter((c: any) => {
            const cat = (c.category || '').toString().toLowerCase();
            return cat === 'thisnot';
        }).length;

        console.log(`✅ [ThisNot] Reload completato: ${thisnotCount} canali ThisNot attivi`);

        res.json({
            ok: true,
            thisnotChannels: thisnotCount,
            totalDynamicChannels: dyn.length,
            message: `ThisNot aggiornato con successo! ${thisnotCount} eventi di oggi disponibili.`
        });
    } catch (e: any) {
        console.error('❌ [ThisNot] Errore durante reload:', e);
        res.status(500).json({
            ok: false,
            error: e?.message || String(e),
            stack: e?.stack
        });
    }
});
// =============================================================



// ================= STREAMED FORCED RELOAD ENDPOINT (RIMOSSO) =====================
// ================= RBTV FORCED RELOAD ENDPOINT (RIMOSSO) =====================
// ================= SPSO FORCED RELOAD ENDPOINT (RIMOSSO) =====================
// =============================================================

// ================= PPV FORCED RELOAD ENDPOINT =====================
// GET /ppv/reload?token=XYZ
// Esegue ppv_streams.py una volta
app.get('/ppv/reload', async (req: Request, res: Response) => {
    try {
        const requiredToken = process?.env?.PPV_RELOAD_TOKEN;
        const provided = (req.query.token as string) || '';
        if (requiredToken && provided !== requiredToken) {
            return res.status(403).json({ ok: false, error: 'Forbidden' });
        }

        const scriptPath = path.join(__dirname, '..', 'ppv_streams.py');
        if (!fs.existsSync(scriptPath)) {
            return res.status(404).json({ ok: false, error: 'ppv_streams.py not found' });
        }

        const pythonBin = process.env.PYTHON_BIN || 'python3';
        const env: any = { ...process.env };

        const started = Date.now();
        const { execFile } = require('child_process');

        const execResult = await new Promise<{ stdout: string; stderr: string; code: number }>(resolve => {
            const child = execFile(pythonBin, [scriptPath], { env }, (err: any, stdout: string, stderr: string) => {
                resolve({ stdout, stderr, code: err && typeof err.code === 'number' ? err.code : 0 });
            });
            child.on('error', (e: any) => {
                console.log('[PPV][RELOAD][ERR]', e?.message || e);
            });
        });

        // Ricarica dynamic in memoria
        try { invalidateDynamicChannels(); loadDynamicChannels(true); } catch { }

        const took = Date.now() - started;
        const clip = (s: string) => s && s.length > 1200 ? s.slice(-1200) : s;

        return res.json({
            ok: true,
            ms: took,
            stdout: clip(execResult.stdout),
            stderr: clip(execResult.stderr),
            channels: loadDynamicChannels(true).filter((c: any) => c.category === 'PPV').length
        });
    } catch (e: any) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
// =============================================================

// ================= AMSTAFF FORCED RELOAD ENDPOINT =====================
// GET /amstaff/reload?token=XYZ
// Triggera manualmente l'aggiornamento dei canali Amstaff e restituisce statistiche
// app.get('/amstaff/reload', async (req: Request, res: Response) => {
//     try {
//         const requiredToken = process?.env?.AMSTAFF_RELOAD_TOKEN;
//         const provided = (req.query.token as string) || '';
//         if (requiredToken && provided !== requiredToken) {
//             return res.status(403).json({ ok: false, error: 'Forbidden' });
//         }

//         console.log('[AMSTAFF][RELOAD][API] Manual trigger requested');
//         const started = Date.now();

//         // Importa dinamicamente la funzione di aggiornamento
//         const { updateAmstaffChannels } = await import('./utils/amstaffUpdater');

//         // Esegue l'aggiornamento
//         const channelsUpdated = await updateAmstaffChannels();

//         const took = Date.now() - started;

//         // Forza reload di tv_channels.json dopo l'update
//         try {
//             _loadStaticChannelsIfChanged(true);
//         } catch (e) {
//             console.warn('[AMSTAFF][RELOAD][API] Warning: static reload failed', e);
//         }

//         // Conta canali con staticUrlMpd
//         let mpdCount = 0;
//         for (const c of staticBaseChannels) {
//             if (c && (c as any).staticUrlMpd) mpdCount++;
//         }

//         console.log(`[AMSTAFF][RELOAD][API] Updated ${channelsUpdated} channels in ${took}ms, total staticUrlMpd=${mpdCount}`);

//         return res.json({
//             ok: true,
//             channelsUpdated,
//             totalChannels: staticBaseChannels.length,
//             staticUrlMpdCount: mpdCount,
//             ms: took,
//             timestamp: new Date().toISOString()
//         });
//     } catch (e: any) {
//         console.error('[AMSTAFF][RELOAD][API] Error:', e);
//         return res.status(500).json({ ok: false, error: e?.message || String(e) });
//     }
// });
// =============================================================

// ================= MANUAL STATIC CHANNELS RELOAD ===============
// GET /static/reload?token=XYZ (token optional if STATIC_RELOAD_TOKEN set)
// Forza il ricaricamento di config/tv_channels.json (anche se mtime identico) e restituisce statistiche
app.get('/static/reload', (req: Request, res: Response) => {
    try {
        const requiredToken = process?.env?.STATIC_RELOAD_TOKEN;
        const provided = (req.query.token as string) || '';
        if (requiredToken && provided !== requiredToken) {
            return res.status(403).json({ ok: false, error: 'Forbidden' });
        }
        const beforeHash = _staticFileLastHash;
        const beforeMtime = _staticFileLastMtime;
        _loadStaticChannelsIfChanged(true); // forza reload
        const changed = (_staticFileLastHash !== beforeHash) || (_staticFileLastMtime !== beforeMtime);
        let pdCount = 0;
        let mpdCount = 0;
        for (const c of staticBaseChannels) {
            if (c && (c as any).pdUrlF) pdCount++;
            if (c && (c as any).staticUrlMpd) mpdCount++;
        }
        const total = staticBaseChannels.length;
        console.log(`[TV][RELOAD][API] /static/reload changed=${changed} total=${total} pdUrlF=${pdCount} staticUrlMpd=${mpdCount} hash=${_staticFileLastHash.slice(0, 12)}`);
        return res.json({
            ok: true,
            changed,
            total,
            pdUrlF: pdCount,
            staticUrlMpd: mpdCount,
            mtime: _staticFileLastMtime ? new Date(_staticFileLastMtime).toISOString() : null,
            hash: _staticFileLastHash,
        });
    } catch (e: any) {
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
// =============================================================

// ================= MANUAL RM UPDATE ENDPOINT =================
// GET /rm/update?token=XYZ - Forza aggiornamento canali RM (MPD2)
app.get('/rm/update', async (req: Request, res: Response) => {
    try {
        const requiredToken = process?.env?.STATIC_RELOAD_TOKEN;
        const provided = (req.query.token as string) || '';
        if (requiredToken && provided !== requiredToken) {
            return res.status(403).json({ ok: false, error: 'Forbidden' });
        }

        console.log('[RM][API] Manual update triggered via /rm/update');
        const { updateRmChannels } = await import('./utils/rmUpdater');
        const updated = await updateRmChannels();

        return res.json({
            ok: true,
            updated: updated,
            message: `Updated ${updated} channels with staticUrlMpd2`
        });
    } catch (e: any) {
        console.error('[RM][API] Error:', e);
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
// =============================================================

// ================= MANUAL AMSTAFF UPDATE ENDPOINT ============
// GET /amstaff/update?token=XYZ - Forza aggiornamento canali Amstaff (MPD)
// app.get('/amstaff/update', async (req: Request, res: Response) => {
//     try {
//         const requiredToken = process?.env?.STATIC_RELOAD_TOKEN;
//         const provided = (req.query.token as string) || '';
//         if (requiredToken && provided !== requiredToken) {
//             return res.status(403).json({ ok: false, error: 'Forbidden' });
//         }

//         console.log('[AMSTAFF][API] Manual update triggered via /amstaff/update');
//         const { updateAmstaffChannels } = await import('./utils/amstaffUpdater');
//         const updated = await updateAmstaffChannels();

//         return res.json({
//             ok: true,
//             updated: updated,
//             message: `Updated ${updated} channels with staticUrlMpd`
//         });
//     } catch (e: any) {
//         console.error('[AMSTAFF][API] Error:', e);
//         return res.status(500).json({ ok: false, error: e?.message || String(e) });
//     }
// });
// =============================================================

// ================= MANUAL MPDZ UPDATE ENDPOINT ==============
// GET /mpdz/update - Forza aggiornamento canali MPDz ()
// app.get('/mpdz/update', async (req: Request, res: Response) => {
//     try {
//         console.log('[MPDz][API] Manual update triggered via /mpdz/update');
//         const { updateMpdzChannels } = await import('./utils/mpdzUpdater');
//         const count = await updateMpdzChannels();

//         return res.json({
//             ok: true,
//             count,
//             message: `Updated ${count} MPDz channels in tv_channels.json`
//         });
//     } catch (e: any) {
//         console.error('[MPDz][API] Error:', e);
//         return res.status(500).json({ ok: false, error: e?.message || String(e) });
//     }
// });
// =============================================================

// ================= MANUAL MPDX UPDATE ENDPOINT ==============
// GET /mpdx/update - Forza aggiornamento canali MPDx
app.get('/mpdx/update', async (req: Request, res: Response) => {
    try {
        console.log('[MPDx][API] Manual update triggered via /mpdx/update');
        const { updateMpdxChannels } = await import('./utils/mpdxUpdater');
        const count = await updateMpdxChannels();

        return res.json({
            ok: true,
            count,
            message: `Updated ${count} MPDx channels in tv_channels.json`
        });
    } catch (e: any) {
        console.error('[MPDx][API] Error:', e);
        return res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
// =============================================================

// ================= MANUAL ZEVENTI UPDATE ENDPOINT ==============
// GET /zeventi/update - Forza aggiornamento canali Z-Eventi (serieaz + coppez)
// app.get('/zeventi/update', async (req: Request, res: Response) => {
//     try {
//         console.log('[Z-Eventi][API] Manual update triggered via /zeventi/update');
//         const { updateZEventiChannels } = await import('./utils/zEventiUpdater');
//         const count = await updateZEventiChannels();

//         // Force reload dynamic channels
//         loadDynamicChannels(true);

//         return res.json({
//             ok: true,
//             count,
//             message: `Updated ${count} Z-Eventi channels`
//         });
//     } catch (e: any) {
//         console.error('[Z-Eventi][API] Error:', e);
//         return res.status(500).json({ ok: false, error: e?.message || String(e) });
//     }
// });
// =============================================================

// ================= MANUAL PURGE ENDPOINT =====================
// Esegue la stessa logica delle 02:00: rimuove dal file gli eventi del giorno precedente
// Alias: /tv/update per comodità
app.get(['/static/fupdate', '/tv/update'], async (req: Request, res: Response) => {
    try {
        const htmlLog: string[] = [];
        htmlLog.push('<html><body style="font-family: sans-serif;">');
        htmlLog.push('<h1>🚀 Force Update All Channels</h1>');
        htmlLog.push('<ul>');

        let totalUpdates = 0;

        // Amstaff (skipReload=true per evitare reload multipli)
        // try {
        //     const { updateAmstaffChannels } = await import('./utils/amstaffUpdater');
        //     const c = await updateAmstaffChannels(true, true); // force=true, skipReload=true
        //     totalUpdates += c;
        //     htmlLog.push(`<li>✅ <strong>Amstaff</strong>: ${c} channels updated (FORCED)</li>`);
        // } catch (e: any) {
        //     htmlLog.push(`<li>❌ <strong>Amstaff</strong>: Error: ${e.message}</li>`);
        // }

        // RM (MPD)
        try {
            const { updateRmChannels } = await import('./utils/rmUpdater');
            const c = await updateRmChannels(true, true); // force=true, skipReload=true
            totalUpdates += c;
            htmlLog.push(`<li>✅ <strong>RM (MPD)</strong>: ${c} channels updated (FORCED)</li>`);
        } catch (e: any) {
            htmlLog.push(`<li>❌ <strong>RM (MPD)</strong>: Error: ${e.message}</li>`);
        }

        // MPDz
        // try {
        //     const { updateMpdzChannels } = await import('./utils/mpdzUpdater');
        //     const c = await updateMpdzChannels(true, true); // force=true, skipReload=true
        //     totalUpdates += c;
        //     htmlLog.push(`<li>✅ <strong>MPDz</strong>: ${c} channels updated (FORCED)</li>`);
        // } catch (e: any) {
        //     htmlLog.push(`<li>❌ <strong>MPDz</strong>: Error: ${e.message}</li>`);
        // }

        // MPDx
        try {
            const { updateMpdxChannels } = await import('./utils/mpdxUpdater');
            const c = await updateMpdxChannels(true, true); // force=true, skipReload=true
            totalUpdates += c;
            htmlLog.push(`<li>✅ <strong>MPDx</strong>: ${c} channels updated (FORCED)</li>`);
        } catch (e: any) {
            htmlLog.push(`<li>❌ <strong>MPDx</strong>: Error: ${e.message}</li>`);
        }

        // ThisNot (non scrive su tv_channels.json, scrive su /tmp/thisnot_channels.json)
        try {
            const { updateThisNotChannels } = await import('./utils/thisnotChannels');
            await updateThisNotChannels();
            htmlLog.push(`<li>✅ <strong>ThisNot</strong>: Updated (FORCED)</li>`);
        } catch (e: any) {
            htmlLog.push(`<li>❌ <strong>ThisNot</strong>: Error: ${e.message}</li>`);
        }

        // Z-Eventi (scrive su /tmp/z_eventi.json)
        // try {
        //     const { updateZEventiChannels } = await import('./utils/zEventiUpdater');
        //     const c = await updateZEventiChannels();
        //     htmlLog.push(`<li>✅ <strong>Z-Eventi</strong>: ${c} channels updated (FORCED)</li>`);
        // } catch (e: any) {
        //     htmlLog.push(`<li>❌ <strong>Z-Eventi</strong>: Error: ${e.message}</li>`);
        // }

        // X-Eventi (runs Python script x_eventi.py -> writes to /tmp/x_eventi.json)
        try {
            const pythonBin = process.env.PYTHON_BIN || 'python3';
            const scriptPath = path.join(__dirname, '..', 'x_eventi.py');
            if (fs.existsSync(scriptPath)) {
                const { execSync } = await import('child_process');
                execSync(`${pythonBin} ${scriptPath}`, { timeout: 60000 });
                htmlLog.push(`<li>✅ <strong>X-Eventi</strong>: Script executed (FORCED)</li>`);
            } else {
                htmlLog.push(`<li>⚠️ <strong>X-Eventi</strong>: Script not found (skipped)</li>`);
            }
        } catch (e: any) {
            htmlLog.push(`<li>❌ <strong>X-Eventi</strong>: Error: ${e.message}</li>`);
        }

        // Live/Update (runs Live.py -> dynamic events)
        try {
            // executeLiveScript is already defined in the addon
            const execRes = await (async () => { try { return await (executeLiveScript as any)(); } catch { return undefined; } })();
            const liveOk = execRes?.code === 0 || (execRes?.stdout && !execRes?.code);
            if (liveOk) {
                htmlLog.push(`<li>✅ <strong>Live (Dynamic Events)</strong>: Script executed (FORCED)</li>`);
            } else {
                htmlLog.push(`<li>⚠️ <strong>Live (Dynamic Events)</strong>: ${execRes?.stderr || 'Unknown result'}</li>`);
            }
        } catch (e: any) {
            htmlLog.push(`<li>❌ <strong>Live (Dynamic Events)</strong>: Error: ${e.message}</li>`);
        }

        // SportZX (in-memory cache)
        try {
            const { updateSportzxChannels, getSportzxChannels } = await import('./utils/sportzxUpdater');
            await updateSportzxChannels();
            const count = getSportzxChannels().length;
            htmlLog.push(`<li>✅ <strong>SportzX</strong>: ${count} channels updated (FORCED)</li>`);
        } catch (e: any) {
            htmlLog.push(`<li>❌ <strong>SportzX</strong>: Error: ${e.message}</li>`);
        }

        // Sports99 (in-memory cache)
        try {
            const { updateSports99Channels, getSports99Channels } = await import('./utils/sports99Updater');
            await updateSports99Channels();
            const count = getSports99Channels().length;
            htmlLog.push(`<li>✅ <strong>Sports99</strong>: ${count} channels updated (FORCED)</li>`);
        } catch (e: any) {
            htmlLog.push(`<li>❌ <strong>Sports99</strong>: Error: ${e.message}</li>`);
        }

        htmlLog.push('</ul>');

        // === UNICO RELOAD FINALE ===
        htmlLog.push('<h2>🔄 Final Reload</h2>');
        try {
            // Forza reload dei canali statici in memoria
            _loadStaticChannelsIfChanged(true);

            // Conta canali con vari campi MPD
            let mpdCount = 0, mpd2Count = 0, mpdzCount = 0, mpdxCount = 0;
            for (const c of staticBaseChannels) {
                if (c && (c as any).staticUrlMpd) mpdCount++;
                if (c && (c as any).staticUrlMpd2) mpd2Count++;
                if (c && (c as any).staticUrlMpdz) mpdzCount++;
                if (c && (c as any).staticUrlMpdx) mpdxCount++;
            }

            htmlLog.push(`<p>✅ <strong>Reload completato!</strong></p>`);
            htmlLog.push(`<ul>`);
            htmlLog.push(`<li>Total channels in memory: <strong>${staticBaseChannels.length}</strong></li>`);
            htmlLog.push(`<li>staticUrlMpd (RM/MPD): <strong>${mpdCount}</strong></li>`);
            // htmlLog.push(`<li>staticUrlMpd2 (DEPRECATED): <strong>${mpd2Count}</strong></li>`);
            htmlLog.push(`<li>staticUrlMpdx (MPDx): <strong>${mpdxCount}</strong></li>`);
            htmlLog.push(`</ul>`);
            htmlLog.push(`<p>Total updates this run: <strong>${totalUpdates}</strong></p>`);
        } catch (e: any) {
            htmlLog.push(`<p>❌ Reload error: ${e.message}</p>`);
        }

        htmlLog.push('<p><em>All updaters completed and channels reloaded in memory.</em></p>');
        htmlLog.push('</body></html>');
        res.send(htmlLog.join(''));
    } catch (e: any) {
        res.status(500).send(`Global Error: ${e.message}`);
    }
});

app.get('/live/purge', (req: Request, res: Response) => {
    try {
        const result = purgeOldDynamicEvents();
        // Ricarica cache in memoria
        loadDynamicChannels(true);
        res.json({ ok: true, ...result });
    } catch (e: any) {
        res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
});
// =============================================================
// ================================================================

// ================= RUNTIME TOGGLE FAST/EXTRACTOR ================
// /admin/mode?fast=1 abilita fast mode (diretto); ?fast=0 torna extractor
// Restituisce lo stato corrente. Non persiste su restart (solo runtime)
app.get('/admin/mode', (req: Request, res: Response) => {
    const q = (req.query.fast || '').toString().trim();
    if (q === '1' || q.toLowerCase() === 'true') {
        (process as any).env.FAST_DYNAMIC = '1';
    } else if (q === '0' || q.toLowerCase() === 'false') {
        (process as any).env.FAST_DYNAMIC = '0';
    }
    const fastDynamic = (process.env.FAST_DYNAMIC === '1' || process.env.FAST_DYNAMIC === 'true');
    res.json({ ok: true, fastDynamic });
});
// ================================================================

// Porta con auto-retry se occupata (fino a +10 tentativi)
function startServer(basePort: number, attempts = 0) {
    const PORT = basePort + attempts;
    const server = app.listen(PORT, () => {
        console.log(`Addon server running on http://127.0.0.1:${PORT}`);
    });
    server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE' && attempts < 10) {
            console.log(`⚠️ Porta ${PORT} occupata, provo con ${PORT + 1}...`);
            setTimeout(() => startServer(basePort, attempts + 1), 300);
        } else if (err.code === 'EADDRINUSE') {
            console.error(`❌ Nessuna porta libera trovata dopo ${attempts + 1} tentativi partendo da ${basePort}`);
        } else {
            console.error('❌ Errore server:', err);
        }
    });
}
const basePort = parseInt(process.env.PORT || '7860', 10);
startServer(basePort);

// ================= STARTUP AUTO-PURGE CHECK =====================
// Esegue un controllo una sola volta ~20s dopo l'avvio per:
//  - Forzare un loadDynamicChannels(true) (applicando il filtro runtime se abilitato)
//  - Loggare quanti eventi sono stati rimossi rispetto al file grezzo
//  - Evitare sorprese se l'utente non ha impostato variabili env (comportamento di default atteso)
setTimeout(() => {
    try {
        const dynPath = getDynamicFilePath();
        const beforeRaw = (() => {
            try {
                if (!dynPath || !fs.existsSync(dynPath)) return 0;
                const raw = JSON.parse(fs.readFileSync(dynPath, 'utf-8'));
                return Array.isArray(raw) ? raw.length : 0;
            } catch { return 0; }
        })();
        // Forza reload applicando eventuale filtro runtime
        const filtered = loadDynamicChannels(true);
        const after = filtered.length;
        if (beforeRaw && after <= beforeRaw) {
            console.log(`[STARTUP][PURGE-CHECK] path=${dynPath} before=${beforeRaw} afterFilter=${after} removed=${beforeRaw - after}`);
        } else {
            console.log(`[STARTUP][PURGE-CHECK] path=${dynPath} count=${after} (no removals or file empty)`);
        }
    } catch (e: any) {
        console.log('[STARTUP][PURGE-CHECK][ERR]', e?.message || e);
    }
}, 20000);
// ================================================================

// Funzione per assicurarsi che le directory di cache esistano
function ensureCacheDirectories(): void {
    try {
        // Directory per la cache Vavoo
        const cacheDir = path.join(__dirname, '../cache');
        if (!fs.existsSync(cacheDir)) {
            fs.mkdirSync(cacheDir, { recursive: true });
            console.log(`📁 Directory cache creata: ${cacheDir}`);
        }
    } catch (error) {
        console.error('❌ Errore nella creazione delle directory di cache:', error);
    }
}

// Assicurati che le directory di cache esistano all'avvio
ensureCacheDirectories();

// ================== LIVE EVENTS SCHEDULER (Live.py) ==================
// Esegue Live.py OGNI 2 ORE a partire dalle 08:10 Europe/Rome (08:10, 10:10, 12:10, ... fino a 06:10).
// Lo script aggiorna config/dynamic_channels.json; dopo ogni run forziamo reload cache dinamica.

interface ScheduledRun {
    hour: number;
    minute: number;
}

const LIVE_SCRIPT_PATH = path.join(__dirname, '..', 'Live.py');
const LIVE_LOG_DIR = path.join(__dirname, '../logs');
const LIVE_LOG_FILE = path.join(LIVE_LOG_DIR, 'live_scheduler.log');
if (!fs.existsSync(LIVE_LOG_DIR)) {
    try { fs.mkdirSync(LIVE_LOG_DIR, { recursive: true }); } catch { /* ignore */ }
}

const liveRuns: ScheduledRun[] = [
    { hour: 8, minute: 10 }, // 08:10
    { hour: 10, minute: 10 }, // 10:10
    { hour: 12, minute: 10 }, // 12:10
    { hour: 14, minute: 10 }, // 14:10
    { hour: 16, minute: 10 }, // 16:10
    { hour: 18, minute: 10 }, // 18:10
    { hour: 20, minute: 10 }, // 20:10
    { hour: 22, minute: 10 }, // 22:10
    { hour: 0, minute: 10 }, // 00:10
    { hour: 2, minute: 10 }, // 02:10
    { hour: 4, minute: 10 }, // 04:10
    { hour: 6, minute: 10 }  // 06:10
];

function logLive(msg: string, ...extra: any[]) {
    const stamp = new Date().toISOString();
    const line = `${stamp} [LIVE] ${msg} ${extra.length ? JSON.stringify(extra) : ''}\n`;
    try { fs.appendFileSync(LIVE_LOG_FILE, line); } catch { /* ignore */ }
    console.log(line.trim());
}

function nowRome(): Date {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
}

function computeDelayToNextRun(): number {
    const romeNow = nowRome();
    let nextDiff = Number.MAX_SAFE_INTEGER;
    for (const run of liveRuns) {
        const target = new Date(romeNow.getTime());
        target.setHours(run.hour, run.minute, 0, 0);
        let diff = target.getTime() - romeNow.getTime();
        if (diff < 0) diff += 24 * 60 * 60 * 1000; // giorno successivo
        if (diff < nextDiff) nextDiff = diff;
    }
    return nextDiff === Number.MAX_SAFE_INTEGER ? 60 * 60 * 1000 : nextDiff;
}

async function executeLiveScript(): Promise<{ stdout?: string; stderr?: string; error?: string }> {
    if (!fs.existsSync(LIVE_SCRIPT_PATH)) {
        logLive('Live.py non trovato, skip esecuzione');
        return { error: 'Live.py not found' };
    }
    logLive('Esecuzione Live.py avviata');
    try {
        const { execFile } = require('child_process');
        const result = await new Promise<{ stdout?: string; stderr?: string; error?: string }>((resolve) => {
            const child = execFile('python3', [LIVE_SCRIPT_PATH], {
                timeout: 1000 * 60 * 4,
                env: { ...process.env, DYNAMIC_FILE: '/tmp/dynamic_channels.json' }
            }, (err: any, stdout: string, stderr: string) => {
                if (stdout) logLive('Output Live.py', stdout.slice(0, 800));
                if (stderr) logLive('Stderr Live.py', stderr.slice(0, 800));
                if (err) logLive('Errore Live.py', err.message || err);
                resolve({ stdout, stderr, error: err ? (err.message || String(err)) : undefined });
            });
            // Safety: se child resta appeso oltre timeout integrato execFile lancerà errore
            child.on('error', (e: any) => logLive('Errore processo Live.py', e.message || e));
        });
        // Ricarica canali dinamici (force) e svuota cache tvChannels merge (ricarico solo dynamic parte)
        loadDynamicChannels(true);
        logLive('Reload canali dinamici completato dopo Live.py');
        return result;
    } catch (e: any) {
        logLive('Eccezione esecuzione Live.py', e?.message || String(e));
        return { error: e?.message || String(e) };
    }
}

function scheduleNextLiveRun() {
    const delay = computeDelayToNextRun();
    logLive('Prossima esecuzione Live.py tra ms', delay);
    setTimeout(async () => {
        await executeLiveScript();
        try {
            const r = purgeOldDynamicEvents();
            loadDynamicChannels(true);
            logLive('Purge post-run Live.py eseguito', r);
        } catch (e: any) {
            logLive('Errore purge post-run Live.py', e?.message || String(e));
        }
        scheduleNextLiveRun();
    }, delay);
}

// Avvia scheduler dopo avvio server (dopo breve delay per evitare conflitto startup)
setTimeout(() => {
    logLive('Scheduler Live eventi attivato');
    scheduleNextLiveRun();
}, 5000);

// ================== BOOTSTRAP LIVE RUN (se file mancante o vuoto) ==================
setTimeout(async () => {
    try {
        const dynPath = getDynamicFilePath();
        let needBootstrap = false;
        try {
            if (!fs.existsSync(dynPath)) needBootstrap = true; else {
                const st = fs.statSync(dynPath);
                if (st.size < 50) { // heuristica: file troppo piccolo per contenere array eventi
                    needBootstrap = true;
                }
            }
        } catch { needBootstrap = true; }
        if (needBootstrap) {
            logLive('BOOTSTRAP: dynamic_channels.json assente o vuoto -> eseguo Live.py immediato');
            await executeLiveScript();
            try {
                const r = purgeOldDynamicEvents();
                loadDynamicChannels(true);
                logLive('BOOTSTRAP: purge post Live.py eseguito', r);
            } catch (e: any) {
                logLive('BOOTSTRAP: errore purge post Live.py', e?.message || String(e));
            }
        } else {
            logLive('BOOTSTRAP: dynamic_channels.json presente, skip run iniziale');
        }
    } catch (e: any) {
        logLive('BOOTSTRAP: errore controllo iniziale', e?.message || String(e));
    }
}, 8000);
// ==============================================================================
// Esecuzione automatica /live/update dopo 2 minuti dall'avvio per garantire prima popolazione dinamici
setTimeout(async () => {
    try {
        console.log('[LIVE][AUTO-120s] Avvio aggiornamento iniziale forzato');
        // Riutilizza executeLiveScript + purge come fa l'endpoint /live/update
        const execRes = await (async () => { try { return await (executeLiveScript as any)(); } catch { return undefined; } })();
        const purgeResult = purgeOldDynamicEvents();
        loadDynamicChannels(true);
        console.log('[LIVE][AUTO-120s] Completato', { purgeRemoved: purgeResult.removed, dynamicCount: loadDynamicChannels(true).length });
    } catch (e: any) {
        console.error('[LIVE][AUTO-120s][ERR]', e?.message || e);
    }
}, 120000);
// ==============================================================================
// ====================================================================

// ================== AUTO PURGE SCHEDULER ============================
function computeDelayToNextPurge(): number {
    const romeNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
    const target = new Date(romeNow.getTime());
    target.setHours(2, 5, 0, 0); // 02:05 Rome
    let diff = target.getTime() - romeNow.getTime();
    if (diff < 0) diff += 24 * 60 * 60 * 1000; // domani
    return diff;
}

function scheduleNextAutoPurge() {
    const delay = computeDelayToNextPurge();
    console.log(`🗓️ Prossimo purge automatico alle 02:05 Rome tra ms: ${delay}`);
    setTimeout(() => {
        try {
            const result = purgeOldDynamicEvents();
            loadDynamicChannels(true);
            console.log(`🧹 Purge automatico eseguito: removed=${result.removed} after=${result.after}`);
        } catch (e) {
            console.error('❌ Errore purge automatico:', e);
        } finally {
            scheduleNextAutoPurge();
        }
    }, delay);
}

// Avvia scheduling purge dopo avvio server (leggero delay per startup)
setTimeout(() => scheduleNextAutoPurge(), 7000);
// ====================================================================

// =============== WATCHER dynamic_channels.json =======================
try {
    const dynamicFilePath = path.join(__dirname, '../config/dynamic_channels.json');
    if (fs.existsSync(dynamicFilePath)) {
        fs.watch(dynamicFilePath, { persistent: false }, (evt: any) => {
            if (evt === 'change') {
                console.log('🔄 Detected change in dynamic_channels.json -> invalidate & reload');
                invalidateDynamicChannels();
                loadDynamicChannels(true);
            }
        });
        console.log('👁️  Watch attivo su dynamic_channels.json');
    }
} catch (e) {
    console.error('❌ Impossibile attivare watcher dynamic_channels.json:', e);
}
// ====================================================================

// =============== DAILY 02:30 ROME RELOAD =============================
function computeDelayToDailyReload(): number {
    const romeNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
    const target = new Date(romeNow.getTime());
    target.setHours(2, 30, 0, 0); // 02:30 Rome
    let diff = target.getTime() - romeNow.getTime();
    if (diff < 0) diff += 24 * 60 * 60 * 1000;
    return diff;
}
function scheduleDailyReload() {
    const delay = computeDelayToDailyReload();
    console.log(`🗓️ Prossimo reload dinamici alle 02:30 Rome tra ms: ${delay}`);
    setTimeout(() => {
        try {
            invalidateDynamicChannels();
            const dyn = loadDynamicChannels(true);
            console.log(`🔁 Reload automatico 02:30 completato: dynamicCount=${dyn.length}`);
        } catch (e) {
            console.error('❌ Errore reload automatico 02:30:', e);
        } finally {
            scheduleDailyReload();
        }
    }, delay);
}
setTimeout(() => scheduleDailyReload(), 9000);
// ====================================================================

// =============== AMSTAFF AUTO-UPDATER ================================
// Avvia aggiornamento automatico canali Amstaff ogni ora
// try {
//     startSportzxScheduler(); // SportZX



console.log(`✅ Addon active on port ${process.env.PORT || 7000}`);
// } catch (e) {
//     console.error('❌ Errore avvio Amstaff updater:', e);
// }

// =============== RM AUTO-UPDATER (MPD) ============================
// Avvia aggiornamento automatico canali RM ogni 15 minuti
try {
    startRmScheduler();
    console.log('✅ RM auto-updater attivato (MPD)');
} catch (e) {
    console.error('❌ Errore avvio RM updater:', e);
}
// ====================================================================



// =============== THISNOT AUTO-UPDATER ==============================
// Avvia aggiornamento automatico canali ThisNot ogni 2 ore
try {
    startThisNotUpdater(2);
    console.log('✅ ThisNot auto-updater attivato (ogni 2 ore)');
} catch (e) {
    console.error('❌ Errore avvio ThisNot updater:', e);
}
// ====================================================================

// =============== SPORTZX AUTO-UPDATER ==============================
// Avvia aggiornamento automatico canali SportzX ogni 15 minuti
try {
    startSportzxScheduler();
    console.log('✅ SportzX auto-updater attivato (ogni 15 min)');
} catch (e) {
    console.error('❌ Errore avvio SportzX updater:', e);
}
// ====================================================================

// =============== SPORTS99 AUTO-UPDATER ==============================
// Avvia aggiornamento automatico canali Sports99 ogni 15 minuti
try {
    startSports99Scheduler();
    console.log('✅ Sports99 auto-updater attivato (ogni 15 min)');
} catch (e) {
    console.error('❌ Errore avvio Sports99 updater:', e);
}

// =============== MPDZ AUTO-UPDATER ==============================
// Avvia aggiornamento automatico canali MPDz () ogni 23 minuti
// try {
//     startMpdzScheduler(1380000);
//     console.log('✅ MPDz auto-updater attivato (ogni 23 min)');
// } catch (e) {
//     console.error('❌ Errore avvio MPDz updater:', e);
// }
// ====================================================================

// =============== MPDX AUTO-UPDATER ==============================
// Avvia aggiornamento automatico canali MPDx ( worker) ogni 23 minuti
try {
    startMpdxScheduler(1380000);
    console.log('✅ MPDx auto-updater attivato (ogni 23 min)');
} catch (e) {
    console.error('❌ Errore avvio MPDx updater:', e);
}
// ====================================================================

// =============== ZEVENTI AUTO-UPDATER ==============================
// Avvia aggiornamento automatico canali Z-Eventi (serieaz + coppez) ogni 25 minuti
// try {
//     startZEventiScheduler(1500000);
//     console.log('✅ Z-Eventi auto-updater attivato (ogni 25 min)');
// } catch (e) {
//     console.error('❌ Errore avvio Z-Eventi updater:', e);
// }
// ====================================================================

// === X-Eventi playlist enrichment & Endpoint ===
(() => {
    try {
        // Check env var enabling
        const xUrl = process.env.X_EVENTI_URL;

        const pythonBin = process.env.PYTHON_BIN || 'python3';
        const scriptPath = path.join(__dirname, '..', 'x_eventi.py');

        // Funzione helper per eseguire lo script
        // Restituisce una promise per poter attendere nell'endpoint
        const runXEventiUpdate = (tag: string): Promise<{ ok: boolean; output: string; error: string }> => {
            return new Promise(resolve => {
                if (!fs.existsSync(scriptPath)) {
                    console.log('[X-Events][INIT] script non trovato', scriptPath);
                    resolve({ ok: false, output: '', error: 'Script not found' });
                    return;
                }

                const env: any = { ...process.env };
                const t0 = Date.now();
                const child = spawn(pythonBin, [scriptPath], { env });
                let out = ''; let err = '';

                child.stdout.on('data', d => out += d.toString());
                child.stderr.on('data', d => err += d.toString());

                child.on('close', code => {
                    const ms = Date.now() - t0;
                    if (out.trim()) out.split(/\r?\n/).forEach(l => console.log('[X-Events][OUT]', l));
                    if (err.trim()) err.split(/\r?\n/).forEach(l => console.warn('[X-Events][ERR]', l));
                    console.log(`[X-Events][RUN] done code=${code} ms=${ms}`);

                    if (code === 0) {
                        // Ricarica dynamic channels per rendere effettive le modifiche
                        loadDynamicChannels(true);
                        resolve({ ok: true, output: out, error: err });
                    } else {
                        resolve({ ok: false, output: out, error: err || `Exit code ${code}` });
                    }
                });

                child.on('error', (e) => {
                    console.error('[X-Events] Spawn error:', e);
                    resolve({ ok: false, output: out, error: e.message });
                });
            });
        };

        // 1. Configurazione Endpoint manuale (aggiunto all'app Express esistente)
        if (app) {
            app.get('/xeventi/update', async (req: Request, res: Response) => {
                console.log('[X-Events][API] Trigger manual update...');
                try {
                    const result = await runXEventiUpdate('manual-api');
                    res.json({ success: result.ok, output: result.output, error: result.error });
                } catch (e: any) {
                    res.status(500).json({ success: false, error: e.message });
                }
            });
            console.log('[X-Events][INIT] Endpoint /xeventi/update registrato');
        } else {
            console.warn('[X-Events][INIT] VARNING: app Express non trovata, endpoint non registrato');
        }

        // 2. Scheduler Automatico (solo se URL presente)
        if (xUrl) {
            // Initial run with delay 90s
            setTimeout(() => {
                console.log('[X-Events][INIT] Starting initial run (90s delayed)...');
                runXEventiUpdate('init');
            }, 90000);

            // Scheduler: Run every 20 minutes
            const X_INTERVAL = 20 * 60 * 1000;
            setInterval(() => {
                console.log(`[X-Events][SCHEDULER] Triggering scheduled update...`);
                runXEventiUpdate('scheduled');
            }, X_INTERVAL);

            console.log(`[X-Events][INIT] Scheduler attivo: aggiornamento ogni ${X_INTERVAL / 1000}s`);
        } else {
            console.log('[X-Events][INIT] X_EVENTI_URL non presente, scheduler automatico disabilitato.');
        }

    } catch (e) {
        console.log('[X-Events][INIT][ERR]', (e as any)?.message || e);
    }
})();
