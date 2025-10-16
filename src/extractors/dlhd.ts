import axios from 'axios';
import * as https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';

// HTTPS agent that ignores SSL verification (like dlhd.py does)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

// Debug logging (disabled by default, enable with DLHD_DEBUG=1)
const DLHD_DEBUG = /^(1|true|on)$/i.test(String(process?.env?.DLHD_DEBUG || ''));
const debugLog = (...args: any[]) => {
  if (DLHD_DEBUG) console.log('[DLHD]', ...args);
};

// Proxy management
let lastWorkingProxy: string | null = null; // Cache del proxy funzionante
let useEnvProxy = true; // Flag per usare DLHD_PROXY se disponibile
let workingMethod: 'direct' | 'env-proxy' | 'proxies-ts' | null = null; // Metodo funzionante cached
let hasLoggedSuccess = false; // Flag per log solo prima volta

/**
 * Get proxy for request with fallback logic
 */
function getProxyForRequest(): string | null {
  // Priority 1: ENV proxy (se disponibile e non ancora fallito)
  if (useEnvProxy && process.env.DLHD_PROXY) {
    return process.env.DLHD_PROXY;
  }

  // Priority 2: Last working proxy (cache)
  if (lastWorkingProxy) {
    return lastWorkingProxy;
  }

  // Priority 3: Rotate from proxies.ts
  try {
    const { nextProxyPair } = require('../config/proxies');
    const proxies = nextProxyPair();
    if (proxies.length > 0) {
      return proxies[0]; // Usa il primo del pair
    }
  } catch (err) {
    debugLog('Failed to load proxies.ts:', err);
  }

  return null;
}

/**
 * Create axios config with optional proxy
 */
function createAxiosConfig(headers: any, proxy?: string | null, timeout = 15000): any {
  // Disabilita SSL verification globalmente per questo processo
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  const config: any = {
    headers,
    timeout,
    maxRedirects: 5
  };

  if (proxy) {
    // Usa proxy con SSL verification disabilitata
    const proxyAgent = new HttpsProxyAgent(proxy, {
      rejectUnauthorized: false
    });
    config.httpsAgent = proxyAgent;
    config.proxy = false; // Disabilita auto-detection di axios
    debugLog(`Using proxy: ${proxy}`);
  } else {
    // Senza proxy
    config.httpsAgent = httpsAgent;
  }

  return config;
}

/**
 * Axios GET with automatic retry using proxy on IP block
 * Logic:
 * 1. If we already know working method → Use it immediately (no retry)
 * 2. Try direct connection (fast if IP not blocked)
 * 3. If 400/403 → Try DLHD_PROXY (ENV)
 * 4. If fails → Rotate through proxies.ts
 * 5. Cache working method for subsequent requests (no logs after first success)
 */
async function axiosGetWithRetry(url: string, headers: any, timeout = 15000): Promise<any> {
  let lastError: any = null;

  // FAST PATH: Se abbiamo già un metodo funzionante, usalo immediatamente
  if (workingMethod) {
    try {
      let config: any;
      
      if (workingMethod === 'direct') {
        debugLog(`[Fast-path] Using cached direct connection`);
        config = createAxiosConfig(headers, null, timeout);
      } else if (workingMethod === 'env-proxy' && process.env.DLHD_PROXY) {
        debugLog(`[Fast-path] Using cached ENV proxy`);
        config = createAxiosConfig(headers, process.env.DLHD_PROXY, timeout);
      } else if (workingMethod === 'proxies-ts' && lastWorkingProxy) {
        debugLog(`[Fast-path] Using cached proxy from proxies.ts`);
        config = createAxiosConfig(headers, lastWorkingProxy, timeout);
      } else {
        // Cache invalido, riproviamo discovery
        workingMethod = null;
        hasLoggedSuccess = false;
        throw new Error('Cached method no longer available');
      }
      
      const response = await axios.get(url, config);
      return response; // Successo silenzioso, nessun log
      
    } catch (error: any) {
      // Metodo cached fallito, reset e riprova discovery
      debugLog(`[Fast-path] Cached method failed, retrying discovery...`);
      workingMethod = null;
      hasLoggedSuccess = false;
      lastError = error;
      // Continua con discovery normale...
    }
  }

  // DISCOVERY PATH: Trova il metodo funzionante (solo prima volta o dopo fallimento)
  
  // Attempt 1: Direct connection (no proxy)
  try {
    debugLog(`[Discovery 1/4] Trying direct connection...`);
    const config = createAxiosConfig(headers, null, timeout);
    const response = await axios.get(url, config);
    
    // Success! Cache this method
    workingMethod = 'direct';
    if (!hasLoggedSuccess) {
      console.log(`[DLHD] ✅ Direct connection works, using it for all requests`);
      hasLoggedSuccess = true;
    }
    return response;
    
  } catch (error: any) {
    lastError = error;
    const status = error.response?.status;
    
    // Only retry with proxy if IP is blocked (400/403)
    if (status !== 400 && status !== 403) {
      debugLog(`❌ Direct failed with status ${status}, not IP block - throwing`);
      throw error;
    }
    
    if (!hasLoggedSuccess) {
      console.log(`[DLHD] IP blocked (${status}), trying with proxy...`);
    }
  }

  // Attempt 2: ENV proxy (DLHD_PROXY)
  if (useEnvProxy && process.env.DLHD_PROXY) {
    try {
      debugLog(`[Discovery 2/4] Trying ENV proxy...`);
      const config = createAxiosConfig(headers, process.env.DLHD_PROXY, timeout);
      const response = await axios.get(url, config);
      
      // Success! Cache this method
      workingMethod = 'env-proxy';
      lastWorkingProxy = process.env.DLHD_PROXY;
      if (!hasLoggedSuccess) {
        console.log(`[DLHD] ✅ ENV proxy works, using it for all requests`);
        hasLoggedSuccess = true;
      }
      return response;
      
    } catch (error: any) {
      lastError = error;
      if (!hasLoggedSuccess) {
        console.log(`[DLHD] ⚠️ ENV proxy failed (${error.response?.status || error.code}), trying proxies.ts`);
      }
      useEnvProxy = false; // Don't try ENV proxy again
    }
  }

  // Attempt 3-4: Rotate through proxies.ts (try up to 2)
  try {
    const { nextProxyPair } = require('../config/proxies');
    const proxies = nextProxyPair();
    
    if (proxies.length === 0) {
      console.error('[DLHD] No proxies available in proxies.ts');
      throw lastError;
    }

    for (let i = 0; i < proxies.length && i < 2; i++) {
      const proxy = proxies[i];
      try {
        debugLog(`[Discovery ${3 + i}/4] Trying proxy from proxies.ts...`);
        const config = createAxiosConfig(headers, proxy, timeout);
        const response = await axios.get(url, config);
        
        // Success! Cache this method
        workingMethod = 'proxies-ts';
        lastWorkingProxy = proxy;
        if (!hasLoggedSuccess) {
          console.log(`[DLHD] ✅ Proxy from proxies.ts works, using it for all requests`);
          hasLoggedSuccess = true;
        }
        return response;
        
      } catch (error: any) {
        lastError = error;
        debugLog(`Proxy ${i + 1}/${proxies.length} failed (${error.response?.status || error.code})`);
      }
    }
  } catch (err) {
    debugLog('Failed to load proxies.ts:', err);
  }

  // All attempts failed
  console.error('[DLHD] ❌ All connection methods failed');
  throw lastError;
}

interface AuthParams {
  auth_host: string;
  auth_php: string;
  auth_ts: string;
  auth_rnd: string;
  auth_sig: string;
}

interface StreamInfo {
  manifestUrl: string;
  keyUrl: string;
  headers: {
    'User-Agent': string;
    'Referer': string;
    'Origin': string;
  };
}

interface CachedAuth {
  auth_data: AuthParams;
  iframe_url: string;
  timestamp: number;
}

// Cache for auth data per channel
const authCache: Map<string, CachedAuth> = new Map();

/**
 * Resolve the base DaddyLive domain with proxy support
 */
async function resolveBaseUrl(preferredHost?: string, useProxy = false): Promise<string> {
  const DOMAINS = [
    'https://daddylive.sx/',
    'https://dlhd.dad/'
  ];

  let candidates = [...DOMAINS];
  if (preferredHost) {
    const ph = preferredHost.endsWith('/') ? preferredHost : preferredHost + '/';
    if (DOMAINS.includes(ph)) {
      candidates = [ph, ...DOMAINS.filter(d => d !== ph)];
    } else {
      candidates = [ph, ...DOMAINS];
    }
  }

  const proxy = useProxy ? getProxyForRequest() : null;
  const config = createAxiosConfig({}, proxy);

  for (const base of candidates) {
    try {
      const response = await axios.get(base, config);
      let finalUrl = response.request.res.responseUrl || base;
      if (!finalUrl.endsWith('/')) {
        finalUrl += '/';
      }
      return finalUrl;
    } catch (error) {
      // Silent fallback to next candidate
    }
  }

  const fallback = candidates[0];
  return fallback;
}

/**
 * Extract channel ID from URL
 */
function extractChannelId(url: string): string | null {
  // Match premium streams
  let match = url.match(/\/premium(\d+)\/mono\.m3u8$/);
  if (match) return match[1];

  // Match player links
  match = url.match(/\/(?:watch|stream|cast|player)\/stream-(\d+)\.php/);
  if (match) return match[1];

  // Match watch.php?id=
  match = url.match(/watch\.php\?id=(\d+)/);
  if (match) return match[1];

  // Match encoded URLs
  match = url.match(/(?:%2F|\/)stream-(\d+)\.php/i);
  if (match) return match[1];

  // Match direct stream-X.php
  match = url.match(/stream-(\d+)\.php/);
  if (match) return match[1];

  return null;
}

/**
 * Extract auth parameters from obfuscated JavaScript
 */
function extractAuthParams(jsContent: string): Partial<AuthParams> {
  const params: Partial<AuthParams> = {};

  // Pattern for base64 encoded data (minimum 50 characters)
  const pattern = /(?:const|var|let)\s+[A-Z0-9_]+\s*=\s*["']([a-zA-Z0-9+/=]{50,})["']/g;
  let match;

  while ((match = pattern.exec(jsContent)) !== null) {
    const b64Data = match[1];
    try {
      const decoded = Buffer.from(b64Data, 'base64').toString('utf-8');
      
      // Try to parse as JSON
      try {
        const jsonData = JSON.parse(decoded);
        
        // Decode base64 values if they are base64-encoded (double encoding!)
        const decodeIfBase64 = (val: string): string => {
          try {
            // Check if it looks like base64 (only alphanumeric, +, /, =)
            if (/^[A-Za-z0-9+/]+=*$/.test(val)) {
              const decoded = Buffer.from(val, 'base64').toString('utf-8');
              // If decoded contains readable text (no control chars), use it
              if (!/[\x00-\x08\x0E-\x1F\x7F-\x9F]/.test(decoded)) {
                return decoded;
              }
            }
          } catch {
            // Not valid base64, return as-is
          }
          return val;
        };
        
        if (jsonData.b_host) params.auth_host = decodeIfBase64(jsonData.b_host);
        if (jsonData.b_script) params.auth_php = decodeIfBase64(jsonData.b_script);
        if (jsonData.b_ts) params.auth_ts = decodeIfBase64(jsonData.b_ts);
        if (jsonData.b_rnd) params.auth_rnd = decodeIfBase64(jsonData.b_rnd);
        if (jsonData.b_sig) params.auth_sig = decodeIfBase64(jsonData.b_sig);
        
        if (Object.keys(params).length === 5) {
          return params;
        }
      } catch {
        // Not JSON, try other patterns
      }

      // Try individual patterns in decoded string
      const patterns = {
        auth_host: /["']?(?:b_host|host)["']?\s*:\s*["']([^"']+)["']/,
        auth_php: /["']?(?:b_script|script)["']?\s*:\s*["']([^"']+)["']/,
        auth_ts: /["']?(?:b_ts|ts)["']?\s*:\s*["']([^"']+)["']/,
        auth_rnd: /["']?(?:b_rnd|rnd)["']?\s*:\s*["']([^"']+)["']/,
        auth_sig: /["']?(?:b_sig|sig)["']?\s*:\s*["']([^"']+)["']/
      };

      for (const [key, regex] of Object.entries(patterns)) {
        const m = decoded.match(regex);
        if (m && !params[key as keyof AuthParams]) {
          params[key as keyof AuthParams] = m[1];
        }
      }

      if (Object.keys(params).length === 5) {
        return params;
      }
    } catch (error) {
      // Continue to next match
    }
  }

  // Fallback: try shorter base64 strings (>30 characters)
  const patternShort = /(?:const|var|let)\s+[A-Z0-9_]+\s*=\s*["']([a-zA-Z0-9+/=]{30,})["']/g;
  while ((match = patternShort.exec(jsContent)) !== null) {
    const b64Data = match[1];
    try {
      const decoded = Buffer.from(b64Data, 'base64').toString('utf-8');
      
      const patterns = {
        auth_host: /["']?(?:b_host|host)["']?\s*:\s*["']([^"']+)["']/,
        auth_php: /["']?(?:b_script|script)["']?\s*:\s*["']([^"']+)["']/,
        auth_ts: /["']?(?:b_ts|ts)["']?\s*:\s*["']([^"']+)["']/,
        auth_rnd: /["']?(?:b_rnd|rnd)["']?\s*:\s*["']([^"']+)["']/,
        auth_sig: /["']?(?:b_sig|sig)["']?\s*:\s*["']([^"']+)["']/
      };

      for (const [key, regex] of Object.entries(patterns)) {
        const m = decoded.match(regex);
        if (m && !params[key as keyof AuthParams]) {
          params[key as keyof AuthParams] = m[1];
        }
      }

      if (Object.keys(params).length === 5) {
        return params;
      }
    } catch {
      // Continue
    }
  }

  return params;
}

/**
 * Main extraction function - reproduces dlhd.py logic
 */
export async function extractDaddyLiveStream(url: string): Promise<StreamInfo> {
  // Determine preferred host from URL
  const parsedUrl = new URL(url);
  const hostLower = parsedUrl.hostname.toLowerCase();
  let preferred: string | undefined;
  if (hostLower.includes('daddylive.sx')) {
    preferred = 'https://daddylive.sx/';
  } else if (hostLower.includes('dlhd.dad')) {
    preferred = 'https://dlhd.dad/';
  }

  // Resolve base URL
  const baseUrl = await resolveBaseUrl(preferred);
  const baseOrigin = new URL(baseUrl).origin;

  // Extract channel ID
  const channelId = extractChannelId(url);
  if (!channelId) {
    throw new Error(`Unable to extract channel ID from ${url}`);
  }

  debugLog(`Processing request for: ${url}`);

  const daddyliveHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Referer': baseUrl,
    'Origin': baseOrigin
  };

  // Step 1: Request initial page (with automatic proxy retry on IP block)
  const initialUrl = url.startsWith('http') ? url : baseUrl + url.replace(/^\//, '');
  const response1 = await axiosGetWithRetry(initialUrl, daddyliveHeaders, 15000);

  // Extract player links
  const playerLinkRegex = /<button[^>]*data-url="([^"]+)"[^>]*>Player\s*\d+<\/button>/g;
  const playerLinks: string[] = [];
  let match;
  while ((match = playerLinkRegex.exec(response1.data)) !== null) {
    playerLinks.push(match[1]);
  }

  if (playerLinks.length === 0) {
    throw new Error('No player links found on the page');
  }

  // Step 2: Try all players to find valid iframes (with automatic proxy retry)
  const iframeCandidates: string[] = [];
  for (const playerUrl of playerLinks) {
    try {
      const fullPlayerUrl = playerUrl.startsWith('http') ? playerUrl : baseUrl + playerUrl.replace(/^\//, '');
      
      const response2 = await axiosGetWithRetry(fullPlayerUrl, {
        ...daddyliveHeaders,
        'Referer': fullPlayerUrl,
        'Origin': fullPlayerUrl
      }, 12000);

      const iframeRegex = /iframe src="([^"]*)"/g;
      let iframeMatch;
      while ((iframeMatch = iframeRegex.exec(response2.data)) !== null) {
        const iframe = iframeMatch[1];
        if (!iframeCandidates.includes(iframe)) {
          iframeCandidates.push(iframe);
        }
      }
    } catch (error) {
      console.warn(`[DLHD] Failed to process player link ${playerUrl}:`, (error as any)?.message || error);
    }
  }

  if (iframeCandidates.length === 0) {
    throw new Error('No valid iframe found in any player page');
  }

  // Step 3: Try each iframe until one works
  let iframeUrl: string | null = null;
  let iframeContent: string | null = null;

  for (const iframe of iframeCandidates) {
    try {
      const iframeDomain = new URL(iframe).hostname;
      if (!iframeDomain) {
        continue;
      }

      const response3 = await axiosGetWithRetry(iframe, daddyliveHeaders, 12000);

      iframeUrl = iframe;
      iframeContent = response3.data;
      break;
    } catch (error) {
      // Silent fallback to next iframe
    }
  }

  if (!iframeUrl || !iframeContent) {
    throw new Error('All iframe candidates failed');
  }

  // Step 4: Extract authentication parameters
  const params = extractAuthParams(iframeContent);

  // Extract channel key
  let channelKey: string | null = null;
  const channelKeyPatterns = [
    /const\s+CHANNEL_KEY\s*=\s*["']([^"']+)["']/,
    /var\s+CHANNEL_KEY\s*=\s*["']([^"']+)["']/,
    /let\s+CHANNEL_KEY\s*=\s*["']([^"']+)["']/,
    /channelKey\s*=\s*["']([^"']+)["']/,
    /var\s+channelKey\s*=\s*["']([^"']+)["']/,
    /(?:let|const)\s+channelKey\s*=\s*["']([^"']+)["']/
  ];

  for (const pattern of channelKeyPatterns) {
    const m = iframeContent.match(pattern);
    if (m) {
      channelKey = m[1];
      break;
    }
  }

  // Validate parameters
  const missingParams: string[] = [];
  if (!channelKey) missingParams.push('channel_key/CHANNEL_KEY');
  if (!params.auth_ts) missingParams.push('auth_ts');
  if (!params.auth_rnd) missingParams.push('auth_rnd');
  if (!params.auth_sig) missingParams.push('auth_sig');
  if (!params.auth_host) missingParams.push('auth_host');
  if (!params.auth_php) missingParams.push('auth_php');

  if (missingParams.length > 0) {
    throw new Error(`Missing parameters: ${missingParams.join(', ')}`);
  }

  // Normalize auth_php
  let authPhp = params.auth_php!;
  if (authPhp.trim().replace(/^\//, '') === 'a.php') {
    authPhp = '/auth.php';
  }

  // Build auth URL with error handling
  let authHost = params.auth_host!;
  
  // Ensure auth_host is a valid URL
  if (!authHost.startsWith('http://') && !authHost.startsWith('https://')) {
    authHost = 'https://' + authHost;
  }
  
  if (!authHost.endsWith('/')) {
    authHost += '/';
  }
  
  let authUrl: URL;
  try {
    authUrl = new URL(authPhp.replace(/^\//, ''), authHost);
  } catch (urlError) {
    console.error('[DLHD] Failed to construct auth URL:', {
      authHost,
      authPhp,
      error: (urlError as any)?.message
    });
    throw new Error(`Failed to construct auth URL: ${(urlError as any)?.message}`);
  }
  
  authUrl.searchParams.set('channel_id', channelKey!);
  authUrl.searchParams.set('ts', params.auth_ts!);
  authUrl.searchParams.set('rnd', params.auth_rnd!);
  authUrl.searchParams.set('sig', params.auth_sig!);

  const iframeOrigin = new URL(iframeUrl).origin;
  const authHeaders = {
    ...daddyliveHeaders,
    'Referer': iframeUrl,
    'Origin': iframeOrigin
  };

  // Step 5: Perform authentication (with automatic proxy retry)
  try {
    await axiosGetWithRetry(authUrl.toString(), authHeaders, 12000);
  } catch (error) {
    throw new Error(`Authentication failed: ${(error as any)?.message || error}`);
  }

  // Step 6: Server lookup
  let serverLookup = '/server_lookup.js?channel_id=';
  if (!iframeContent.includes('fetchWithRetry(\'/server_lookup.js?channel_id=\'')) {
    // Try to find alternative server lookup URL
    const lines = iframeContent.split('\n');
    for (const line of lines) {
      if (line.includes('server_lookup.') && line.includes('fetchWithRetry')) {
        const lookupMatch = line.match(/['"]([^'"]*server_lookup[^'"]*)['"]/);
        if (lookupMatch) {
          serverLookup = lookupMatch[1];
          break;
        }
      }
    }
  }

  const serverLookupUrl = `https://${new URL(iframeUrl).hostname}${serverLookup}${channelKey}`;

  const lookupResponse = await axiosGetWithRetry(serverLookupUrl, daddyliveHeaders, 10000);

  const serverData = lookupResponse.data;
  const serverKey = serverData.server_key;
  
  if (!serverKey) {
    throw new Error(`No server_key in response: ${JSON.stringify(serverData)}`);
  }

  // Step 7: Build final stream URL
  let cleanM3u8Url: string;
  if (serverKey === 'top1/cdn') {
    cleanM3u8Url = `https://top1.newkso.ru/top1/cdn/${channelKey}/mono.m3u8`;
  } else if (serverKey.includes('/')) {
    const parts = serverKey.split('/');
    const domain = parts[0];
    cleanM3u8Url = `https://${domain}.newkso.ru/${serverKey}/${channelKey}/mono.m3u8`;
  } else {
    cleanM3u8Url = `https://${serverKey}new.newkso.ru/${serverKey}/${channelKey}/mono.m3u8`;
  }

  // Extract key URL pattern from manifest URL
  // Key URL will be something like: https://top2.newkso.ru/wmsxx.php?test=true&name=premium881&number=1
  // Note: We need to fetch the manifest first to get the actual key URL with the correct number parameter
  const keyUrlBase = cleanM3u8Url.replace(/\/[^\/]+\/mono\.m3u8$/, '/wmsxx.php');
  
  // channelKey is already "premium881" from the server lookup, don't add "premium" again!
  const channelName = channelKey;
  
  // We'll extract the actual key URL from the manifest in fetchAndModifyManifest
  // For now, use a placeholder with number=1 (will be replaced with actual URL from manifest)
  const keyUrl = `${keyUrlBase}?test=true&name=${channelName}&number=1`;

  // Headers for newkso.ru requests
  const streamHeaders = {
    'User-Agent': daddyliveHeaders['User-Agent'],
    'Referer': iframeUrl,
    'Origin': iframeOrigin
  };

  debugLog(`✅ Extraction completed successfully -> ${cleanM3u8Url}`);

  return {
    manifestUrl: cleanM3u8Url,
    keyUrl,
    headers: streamHeaders
  };
}

/**
 * Fetch the original manifest and modify it to proxy only the key
 */
export async function fetchAndModifyManifest(
  manifestUrl: string,
  keyUrl: string,
  headers: { 'User-Agent': string; 'Referer': string; 'Origin': string },
  addonBase: string
): Promise<string> {
  // Fetch original manifest WITH headers (required for newkso.ru to avoid 403)
  // Use automatic proxy retry if IP is blocked
  const response = await axiosGetWithRetry(manifestUrl, headers, 10000);

  let manifest = response.data;

  // Find and replace the #EXT-X-KEY line
  const keyLineRegex = /#EXT-X-KEY:METHOD=AES-128,URI="([^"]+)"(,IV=[^,\n]+)?(,KEYFORMAT="[^"]+")?\n?/;
  const match = manifest.match(keyLineRegex);

  if (!match) {
    console.warn('[DLHD] No AES-128 key found in manifest, returning original');
    return manifest;
  }

  const originalKeyUrl = match[1];
  const iv = match[2] || '';
  const keyFormat = match[3] || ',KEYFORMAT="identity"';

  // Use the ACTUAL key URL from the manifest, not our placeholder!
  // This ensures we get the correct number parameter
  const encodedKeyUrl = encodeURIComponent(originalKeyUrl);
  const encodedUserAgent = encodeURIComponent(headers['User-Agent']);
  const encodedReferer = encodeURIComponent(headers['Referer']);
  const encodedOrigin = encodeURIComponent(headers['Origin']);

  const proxiedKeyUrl = `${addonBase}/dlhd_key?keyUrl=${encodedKeyUrl}&h_User-Agent=${encodedUserAgent}&h_Referer=${encodedReferer}&h_Origin=${encodedOrigin}`;

  // Replace the key line
  const newKeyLine = `#EXT-X-KEY:METHOD=AES-128,URI="${proxiedKeyUrl}"${iv}${keyFormat}`;
  manifest = manifest.replace(keyLineRegex, newKeyLine + '\n');

  return manifest;
}

/**
 * Fetch the encryption key with proper headers
 * Uses cached working method for silent subsequent requests (no logs)
 */
export async function fetchKey(
  keyUrl: string,
  headers: { 'User-Agent': string; 'Referer': string; 'Origin': string }
): Promise<Buffer> {
  // Usa lo stesso metodo cached per consistency (no retry, no logs)
  let proxy: string | null = null;
  
  if (workingMethod === 'env-proxy' && process.env.DLHD_PROXY) {
    proxy = process.env.DLHD_PROXY;
  } else if (workingMethod === 'proxies-ts' && lastWorkingProxy) {
    proxy = lastWorkingProxy;
  }
  // Se workingMethod === 'direct' → proxy rimane null
  
  const config = createAxiosConfig(headers, proxy, 10000);
  config.responseType = 'arraybuffer';

  const response = await axios.get(keyUrl, config);

  return Buffer.from(response.data);
}
