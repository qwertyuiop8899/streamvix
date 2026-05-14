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

function runResolver(flag: '--resolve' | '--warmup' | '--folder', url: string,
                     timeoutMs: number): Promise<ResolverResult> {
  return new Promise((resolve) => {
    const py = resolvePython();
    const script = scriptPath();
    let finished = false;
    let stdout = '';
    let stderr = '';
    const proc = spawn(py, [script, flag, url], {
      env: {
        ...process.env,
        // Ensure script picks up debug/proxy env vars from parent process.
      },
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

/** Fast-path resolve. Spawns python, returns resolved playable URL or error. */
export function resolveShortener(url: string, timeoutMs = 30000): Promise<ResolverResult> {
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

async function runWarmupOnce(): Promise<void> {
  if (warmupRunning) return;
  warmupRunning = true;
  const uprotSeed = process.env.STREAMVIX_UPROT_WARMUP_URL
    || 'https://uprot.net/msf/rizwh38f389b';
  const clickaSeed = process.env.STREAMVIX_CLICKA_WARMUP_URL
    || 'https://clicka.cc/delta/mfua6zl4cb9p';
  try {
    console.log('[shortenerResolver] warmup START uprot=', uprotSeed);
    warmupState.uprot.lastAttempt = Date.now();
    const u = await warmupShortener(uprotSeed);
    if (u.ok) {
      warmupState.uprot.lastOk = Date.now();
      lastWarmupOk = Date.now();
      console.log('[shortenerResolver] uprot warmup OK');
    } else {
      warmupState.uprot.lastError = (u as ResolverFailure).error;
      console.warn('[shortenerResolver] uprot warmup FAIL', warmupState.uprot.lastError);
    }
    console.log('[shortenerResolver] warmup START clicka=', clickaSeed);
    warmupState.clicka.lastAttempt = Date.now();
    const c = await warmupShortener(clickaSeed);
    if (c.ok) {
      warmupState.clicka.lastOk = Date.now();
      lastWarmupOk = Date.now();
      console.log('[shortenerResolver] clicka warmup OK');
    } else {
      warmupState.clicka.lastError = (c as ResolverFailure).error;
      console.warn('[shortenerResolver] clicka warmup FAIL', warmupState.clicka.lastError);
    }
  } finally {
    warmupRunning = false;
  }
}

/** Trigger a single warmup pass in the background (non-blocking). */
export function triggerWarmupAsync(): void {
  void runWarmupOnce().catch((e) => {
    console.error('[shortenerResolver] warmup error', e);
  });
}

/** Start the periodic warmup loop. Called from addon.ts on boot. */
export function startWarmupLoop(periodMs: number = 2 * 60 * 60 * 1000): void {
  if (process.env.STREAMVIX_DISABLE_UPROT_WARMUP === '1') {
    console.log('[shortenerResolver] warmup disabled by STREAMVIX_DISABLE_UPROT_WARMUP=1');
    return;
  }
  if (warmupTimer) {
    clearInterval(warmupTimer);
    warmupTimer = null;
  }
  // First run shortly after boot (give the addon time to bind).
  setTimeout(() => { triggerWarmupAsync(); }, 5000);
  warmupTimer = setInterval(triggerWarmupAsync, periodMs);
  console.log('[shortenerResolver] warmup loop started, period', periodMs, 'ms');
}
