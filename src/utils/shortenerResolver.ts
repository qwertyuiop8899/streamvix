/// <reference types="node" />
/**
 * Wrapper for scripts/uprot_resolver.py — resolves uprot.net / clicka.cc shorteners.
 *
 * Design: uprot/clicka whitelist the caller IP after one successful captcha
 * solve. We run an OCR-based **warmup** periodically (in the background, with
 * spaced retries to avoid CDN rate limits) and runtime stream resolution is
 * pure GET — fast and captcha-free.
 *
 *   - resolveShortener(url): fast path. Spawns the python script with
 *     --resolve. Returns the resolved playable URL (m3u8 for maxstream) or
 *     a deltabit.co URL (for clicka), or { error: 'captcha_required' } if
 *     the IP is not whitelisted yet — in which case the caller should
 *     trigger a background warmup and skip this stream.
 *
 *   - warmupShortener(url): runs the OCR-based warmup. Long-running (~5 min
 *     budget). Used on addon startup and on a 2h timer.
 *
 *   - parseUprotFolder(url): parses a /msfld/ folder page; no captcha.
 */
import { spawn, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export type MaxstreamResolved = {
  ok: true;
  kind: 'maxstream';
  m3u8: string;
  headers: Record<string, string>;
};
export type DeltabitResolved = {
  ok: true;
  kind: 'deltabit';
  deltabit: string;
};
export type FolderEntry = {
  filename: string;
  msfi: string;
  season: number | null;
  episode: number | null;
};
export type FolderResolved = {
  ok: true;
  kind: 'folder';
  entries: FolderEntry[];
};
export type ResolverFailure = {
  ok: false;
  error: string;
  diag?: unknown;
};
export type ResolverResult =
  | MaxstreamResolved
  | DeltabitResolved
  | FolderResolved
  | ResolverFailure;

let cachedPythonCmd: string | null = null;
function resolvePython(): string {
  if (cachedPythonCmd) return cachedPythonCmd;
  const candidates = ['/usr/bin/python3', '/usr/local/bin/python3', 'python3', 'python'];
  for (const c of candidates) {
    try {
      if (c.startsWith('/') && !fs.existsSync(c)) continue;
      const r = spawnSync(c, ['-c', 'import sys;print("ok")'], { timeout: 1500 });
      if (r.status === 0 && r.stdout.toString().includes('ok')) {
        cachedPythonCmd = c;
        return c;
      }
    } catch { /* ignore */ }
  }
  cachedPythonCmd = 'python3';
  return cachedPythonCmd;
}

function scriptPath(): string {
  // Repo layout: scripts/uprot_resolver.py at repo root.
  // From dist/utils/shortenerResolver.js -> ../../scripts/uprot_resolver.py
  const candidates = [
    path.join(__dirname, '..', '..', 'scripts', 'uprot_resolver.py'),
    path.join(__dirname, '..', '..', '..', 'scripts', 'uprot_resolver.py'),
    path.join(process.cwd(), 'scripts', 'uprot_resolver.py'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function runResolverArgs(args: string[], timeoutMs: number,
                        envExtra?: Record<string, string>): Promise<ResolverResult> {
  return new Promise((resolve) => {
    const py = resolvePython();
    const script = scriptPath();
    let finished = false;
    let stdout = '';
    let stderr = '';
    const proc = spawn(py, [script, ...args], {
      env: { ...process.env, ...(envExtra || {}) },
    });
    const killer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      if (chunk.trim()) process.stderr.write('[shortenerResolver][py] ' + chunk);
    });
    proc.on('close', (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(killer);
      if (code !== 0) {
        resolve({ ok: false, error: `python exit ${code}: ${stderr.slice(0, 200)}` });
        return;
      }
      try {
        const parsed = JSON.parse(stdout.trim());
        resolve(parsed as ResolverResult);
      } catch (e) {
        resolve({ ok: false, error: `parse error: ${(e as Error).message}` });
      }
    });
    proc.on('error', (err: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(killer);
      resolve({ ok: false, error: `spawn error: ${err.message}` });
    });
  });
}

function runResolver(flag: '--resolve' | '--warmup' | '--folder', url: string,
                     timeoutMs: number): Promise<ResolverResult> {
  return runResolverArgs([flag, url], timeoutMs);
}

// ---------------------------------------------------------------------------
// State file freshness check (NO Python spawn if state is stale or missing)
// ---------------------------------------------------------------------------
// I file di state vengono scritti dal warmup Python. Se non esistono o sono
// troppo vecchi (>8h) saltiamo lo spawn Python: l'addon ha migliaia di
// request al minuto, spawnare Python per ognuna quando il proxy e' bannato
// = bomba di risorse + timeout 10s lato provider. Skip immediato.
const UPROT_STATE_PATH = process.env.UPROT_STATE_PATH || '/tmp/uprot_state.json';
const CLICKA_STATE_PATH = process.env.CLICKA_STATE_PATH || '/tmp/clicka_state.json';
const STATE_MAX_AGE_MS = parseInt(process.env.UPROT_STATE_MAX_AGE_MS || '', 10) || (8 * 60 * 60 * 1000); // 8h

function _isStateFresh(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    return (Date.now() - st.mtimeMs) <= STATE_MAX_AGE_MS;
  } catch {
    return false;
  }
}

function _stateForUrl(url: string): string | null {
  if (/uprot\.net\//i.test(url)) return UPROT_STATE_PATH;
  if (/clicka\.cc\/|safego\.cc\/|deltabit\.co\//i.test(url)) return CLICKA_STATE_PATH;
  return null;
}

/** Fast-path resolve. Pre-check state file freshness, then spawn python. */
export function resolveShortener(url: string, timeoutMs = 10000): Promise<ResolverResult> {
  // Pre-check: se non c'e' state file fresco, skip immediato senza spawn.
  const statePath = _stateForUrl(url);
  if (statePath && !_isStateFresh(statePath)) {
    return Promise.resolve({ ok: false, error: 'no_warmup_state' });
  }
  return runResolver('--resolve', url, timeoutMs);
}

/** OCR-based warmup. Long-running. Use periodically to keep IP whitelisted. */
export function warmupShortener(url: string, timeoutMs = 5 * 60 * 1000): Promise<ResolverResult> {
  return runResolver('--warmup', url, timeoutMs);
}

/** Parse a uprot /msfld/ folder (no captcha needed). */
export function parseUprotFolder(url: string, timeoutMs = 20000): Promise<ResolverResult> {
  return runResolver('--folder', url, timeoutMs);
}

// ---------------------------------------------------------------------------
// Background warmup loop
// ---------------------------------------------------------------------------

let warmupTimer: NodeJS.Timeout | null = null;
let warmupRunning = false;
let lastWarmupOk: number = 0;

interface WarmupState {
  uprot: { lastAttempt: number; lastOk: number; lastError?: string };
  clicka: { lastAttempt: number; lastOk: number; lastError?: string };
}
const warmupState: WarmupState = {
  uprot: { lastAttempt: 0, lastOk: 0 },
  clicka: { lastAttempt: 0, lastOk: 0 },
};

export function getWarmupState(): WarmupState & { lastWarmupOk: number } {
  return { ...warmupState, lastWarmupOk };
}

// ---------------------------------------------------------------------------
// Background warmup loop — per-domain scheduler
// ---------------------------------------------------------------------------
// Strategia:
//   - Ogni dominio (uprot, clicka) ha il suo nextRetry indipendente.
//   - OK     -> nextRetry = now + WARMUP_PERIOD_OK     (default 7h30min)
//   - FAIL   -> nextRetry = now + WARMUP_PERIOD_FAIL   (default 30min)
//     L'IP/slot vincente rimane lo stesso per tutta la finestra OK;
//     solo i FAIL ruotano lo slot (PROXY -> PROXY_BACKUP -> DIRECT -> ...).
//     Quindi: trovato un IP che funziona, lo si tiene per 7h30.
//   - tick ogni 60s sceglie quale dominio rilanciare in base a nextRetry.
//   - Un solo warmup attivo alla volta (lock globale `warmupRunning`).
//   - Niente trigger on-demand dal runtime: l'unica fonte di richieste a
//     uprot/clicka e' questo loop -> protegge dal bombardamento.

const WARMUP_PERIOD_OK = parseInt(process.env.UPROT_WARMUP_PERIOD_OK_MS || '', 10) || ((7 * 60 + 30) * 60 * 1000); // 7h30min
const WARMUP_PERIOD_FAIL = parseInt(process.env.UPROT_WARMUP_PERIOD_FAIL_MS || '', 10) || (30 * 60 * 1000); // 30min
const WARMUP_TICK_MS = parseInt(process.env.UPROT_WARMUP_TICK_MS || '', 10) || (60 * 1000); // 60s

type DomainKey = 'uprot' | 'clicka';
const nextRetry: Record<DomainKey, number> = { uprot: 0, clicka: 0 };

async function _warmupDomain(dom: DomainKey): Promise<void> {
  const seed = dom === 'uprot'
    ? (process.env.STREAMVIX_UPROT_WARMUP_URL || 'https://uprot.net/msf/rizwh38f389b')
    : (process.env.STREAMVIX_CLICKA_WARMUP_URL || 'https://clicka.cc/delta/mfua6zl4cb9p');
  console.log(`[shortenerResolver] warmup START ${dom}=`, seed);
  warmupState[dom].lastAttempt = Date.now();
  const r = await warmupShortener(seed);
  if (r.ok) {
    warmupState[dom].lastOk = Date.now();
    lastWarmupOk = Date.now();
    nextRetry[dom] = Date.now() + WARMUP_PERIOD_OK;
    console.log(`[shortenerResolver] ${dom} warmup OK -> next in ${Math.round(WARMUP_PERIOD_OK / 60000)} min`);
  } else {
    warmupState[dom].lastError = (r as ResolverFailure).error;
    nextRetry[dom] = Date.now() + WARMUP_PERIOD_FAIL;
    // RUOTA proxy slot per il prossimo tentativo: PROXY -> PROXY_BACKUP ->
    // DIRECT -> PROXY -> ... . Cosi' anche il warmup runtime, il resolve
    // dei link e /chapta usciranno dal nuovo IP.
    // Invalidiamo anche lo state file vecchio (era legato al proxy precedente).
    try {
      const next = flipProxySlot(dom);
      const statePath = dom === 'uprot' ? UPROT_STATE_PATH : CLICKA_STATE_PATH;
      try { if (fs.existsSync(statePath)) fs.unlinkSync(statePath); } catch { /* ignore */ }
      console.warn(`[shortenerResolver] ${dom} warmup FAIL ${warmupState[dom].lastError}`,
        `-> flipped proxy slot to ${next}, retry in ${Math.round(WARMUP_PERIOD_FAIL / 60000)} min`);
    } catch (e) {
      console.warn(`[shortenerResolver] ${dom} warmup FAIL ${warmupState[dom].lastError}`,
        `(slot flip error: ${(e as Error).message}) retry in ${Math.round(WARMUP_PERIOD_FAIL / 60000)} min`);
    }
  }
}

async function runWarmupTick(): Promise<void> {
  if (warmupRunning) return;
  warmupRunning = true;
  try {
    const now = Date.now();
    // Sceglie i domini scaduti. Se ce ne sono piu' di uno scaduto, li lancia
    // in sequenza (no parallel: rispetta il lock e gli IP del proxy).
    const due: DomainKey[] = [];
    if (now >= nextRetry.uprot) due.push('uprot');
    if (now >= nextRetry.clicka) due.push('clicka');
    for (const dom of due) {
      await _warmupDomain(dom);
    }
  } finally {
    warmupRunning = false;
  }
}

/**
 * Deprecato: il warmup runtime on-demand e' stato rimosso per evitare
 * di bombardare uprot/clicka. Il loop periodico (OK 2h / FAIL 30min) e'
 * l'unica fonte di richieste. Mantenuto come no-op per compatibilita'
 * con i provider che lo chiamavano (eurostreaming, toon).
 */
export function triggerWarmupAsync(): void {
  // no-op: il loop periodico gestisce tutto.
}

/** Start the periodic warmup loop. Called from addon.ts on boot. */
export function startWarmupLoop(_periodMs?: number): void {
  if (process.env.STREAMVIX_DISABLE_UPROT_WARMUP === '1') {
    console.log('[shortenerResolver] warmup disabled by STREAMVIX_DISABLE_UPROT_WARMUP=1');
    return;
  }
  if (warmupTimer) {
    clearInterval(warmupTimer);
    warmupTimer = null;
  }
  // First run shortly after boot (give the addon time to bind). Forza
  // entrambi i domini come due immediatamente (nextRetry = 0 by init).
  setTimeout(() => { void runWarmupTick().catch(e => console.error('[shortenerResolver] tick error', e)); }, 5000);
  warmupTimer = setInterval(() => {
    void runWarmupTick().catch(e => console.error('[shortenerResolver] tick error', e));
  }, WARMUP_TICK_MS);
  console.log(`[shortenerResolver] warmup loop started, tick=${WARMUP_TICK_MS}ms,`,
    `period OK=${Math.round(WARMUP_PERIOD_OK / 60000)}min FAIL=${Math.round(WARMUP_PERIOD_FAIL / 60000)}min`);
}

// ---------------------------------------------------------------------------
// Per-domain active proxy slot (file-based, shared with Python script)
// ---------------------------------------------------------------------------
// Python (uprot_resolver.py) legge gli stessi file per scegliere il proxy a
// runtime. Cosi' warmup, resolve dei link e /chapta escono dallo stesso IP
// per dominio. Se un warmup fallisce, ruotiamo lo slot e ritentiamo dopo
// 30 min sul prossimo (--> rotazione circolare PROXY -> PROXY_BACKUP -> DIRECT).
//
// I valori scritti nel file sono: 'PROXY' (env), 'PROXY_BACKUP' (env) o
// 'DIRECT' (bypass proxy: usa l'egress diretto del container).

export type ProxySlot = 'PROXY' | 'PROXY_BACKUP' | 'DIRECT';
const VALID_SLOTS: ProxySlot[] = ['PROXY', 'PROXY_BACKUP', 'DIRECT'];
// Ordine di rotazione su fallimento warmup (circolare).
const SLOT_ROTATION: ProxySlot[] = ['PROXY', 'PROXY_BACKUP', 'DIRECT'];

const UPROT_ACTIVE_SLOT_PATH = process.env.UPROT_ACTIVE_SLOT_PATH || '/tmp/uprot_active_proxy_slot.txt';
const CLICKA_ACTIVE_SLOT_PATH = process.env.CLICKA_ACTIVE_SLOT_PATH || '/tmp/clicka_active_proxy_slot.txt';

function slotPathFor(domain: DomainKey): string {
  return domain === 'uprot' ? UPROT_ACTIVE_SLOT_PATH : CLICKA_ACTIVE_SLOT_PATH;
}

export function getActiveSlot(domain: DomainKey): ProxySlot {
  try {
    const v = fs.readFileSync(slotPathFor(domain), 'utf8').trim();
    if ((VALID_SLOTS as string[]).includes(v)) return v as ProxySlot;
  } catch { /* file mancante: default */ }
  return 'PROXY';
}

export function setActiveSlot(domain: DomainKey, slot: ProxySlot): void {
  try {
    fs.writeFileSync(slotPathFor(domain), slot);
  } catch (e) {
    console.warn(`[shortenerResolver] setActiveSlot(${domain}, ${slot}) failed:`, (e as Error).message);
  }
}

/**
 * Ruota lo slot attivo al prossimo nella sequenza SLOT_ROTATION
 * (PROXY -> PROXY_BACKUP -> DIRECT -> PROXY -> ...). Cosi' su fallimento
 * warmup proviamo prima il backup, poi l'egress diretto del container.
 */
export function flipProxySlot(domain: DomainKey): ProxySlot {
  const cur = getActiveSlot(domain);
  const idx = SLOT_ROTATION.indexOf(cur);
  const next: ProxySlot = SLOT_ROTATION[(idx + 1) % SLOT_ROTATION.length] || 'PROXY';
  setActiveSlot(domain, next);
  return next;
}

// ---------------------------------------------------------------------------
// Manual captcha solve API (per /chapta endpoint)
// ---------------------------------------------------------------------------

export interface ChaptaSession {
  domain: 'uprot' | 'clicka';
  url: string;
  field: string;
  origin: string;
  cookie: string;
  proxy_slot: ProxySlot;
  created_ms: number;
}

export interface ChaptaPrepareResult {
  ok: boolean;
  domain: 'uprot' | 'clicka';
  alreadyWhitelisted?: boolean;
  pngB64?: string;
  session?: ChaptaSession;
  proxySlot: ProxySlot;
  proxyHost: string;
  error?: string;
}

export interface ChaptaSubmitResult {
  ok: boolean;
  domain: 'uprot' | 'clicka';
  proxySlot: ProxySlot;
  error?: string;
  guess?: string;
}

function _proxyHostForSlot(slot: ProxySlot): string {
  const v = (process.env[slot] || '').trim();
  if (!v) return '(unset)';
  try {
    return v.split('@').pop()!.split('/')[0] || '(unset)';
  } catch { return '(unset)'; }
}

/** Scarica il captcha per `domain` attraverso lo slot proxy attivo. */
export async function prepareManualSolve(domain: DomainKey): Promise<ChaptaPrepareResult> {
  const slot = getActiveSlot(domain);
  const proxyHost = _proxyHostForSlot(slot);
  const r = await runResolverArgs(['--prepare-manual', domain], 30000) as any;
  if (!r || !r.ok) {
    return {
      ok: false, domain, proxySlot: slot, proxyHost,
      error: (r && r.error) ? String(r.error) : 'prepare failed (no payload)',
    };
  }
  if (r.already_whitelisted) {
    return { ok: true, domain, alreadyWhitelisted: true, proxySlot: slot, proxyHost };
  }
  if (!r.png_b64 || !r.session) {
    return { ok: false, domain, proxySlot: slot, proxyHost, error: 'prepare: missing png/session in python output' };
  }
  return { ok: true, domain, pngB64: r.png_b64, session: r.session as ChaptaSession, proxySlot: slot, proxyHost };
}

/** Invia il guess. Forza il proxy slot salvato nella session per coerenza IP. */
export async function submitManualSolve(sessionFilePath: string, guess: string): Promise<ChaptaSubmitResult> {
  // Leggiamo la session per estrarre domain+slot (per il return value, anche
  // se fallisce). Il Python rilegge a sua volta.
  let domain: 'uprot' | 'clicka' = 'uprot';
  let slot: ProxySlot = 'PROXY';
  try {
    const sess = JSON.parse(fs.readFileSync(sessionFilePath, 'utf8'));
    if (sess && (sess.domain === 'uprot' || sess.domain === 'clicka')) domain = sess.domain;
    if (sess && (sess.proxy_slot === 'PROXY' || sess.proxy_slot === 'PROXY_BACKUP')) slot = sess.proxy_slot;
  } catch { /* ignore */ }
  const r = await runResolverArgs(['--submit-manual', sessionFilePath, '--guess', guess], 30000) as any;
  if (!r || !r.ok) {
    return {
      ok: false, domain, proxySlot: slot,
      error: (r && r.error) ? String(r.error) : 'submit failed (no payload)',
      guess,
    };
  }
  // SUCCESS: aggiorna warmupState cosi' il loop non ricalcia subito.
  try {
    warmupState[domain].lastOk = Date.now();
    lastWarmupOk = Date.now();
    nextRetry[domain] = Date.now() + WARMUP_PERIOD_OK;
  } catch { /* ignore */ }
  return { ok: true, domain, proxySlot: slot, guess: r.guess || guess };
}

/** Stato di whitelisting per la pagina /chapta. */
export interface WhitelistDomainStatus {
  domain: 'uprot' | 'clicka';
  whitelisted: boolean;
  stateAgeMs: number | null;
  activeSlot: ProxySlot;
  activeProxyHost: string;
  lastError?: string;
}

export function getWhitelistStatus(): { uprot: WhitelistDomainStatus; clicka: WhitelistDomainStatus } {
  const build = (domain: DomainKey): WhitelistDomainStatus => {
    const p = domain === 'uprot' ? UPROT_STATE_PATH : CLICKA_STATE_PATH;
    let age: number | null = null;
    let wl = false;
    try {
      const st = fs.statSync(p);
      if (st.isFile()) {
        age = Date.now() - st.mtimeMs;
        wl = age <= STATE_MAX_AGE_MS;
      }
    } catch { /* missing */ }
    const slot = getActiveSlot(domain);
    return {
      domain,
      whitelisted: wl,
      stateAgeMs: age,
      activeSlot: slot,
      activeProxyHost: _proxyHostForSlot(slot),
      lastError: warmupState[domain].lastError,
    };
  };
  return { uprot: build('uprot'), clicka: build('clicka') };
}
