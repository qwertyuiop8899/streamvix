import { spawn } from 'child_process';
import * as path from 'path';
import type { StreamForStremio } from '../types/animeunity';

export interface EurostreamingConfig { enabled: boolean; mfpUrl?: string; mfpPassword?: string; tmdbApiKey?: string; }

interface PyResult { streams?: Array<{ url: string; title?: string; player?: string; size?: string; res?: string; lang?: string }>; error?: string }

function runPythonEuro(argsObj: { imdb?: string; tmdb?: string; season?: number|null; episode?: number|null; mfp: boolean; isMovie: boolean; tmdbKey?: string }, timeoutMs = 35000): Promise<PyResult> {
  const script = path.join(__dirname, 'eurostreaming.py');
  return new Promise((resolve) => {
    let finished = false; let stdout = ''; let stderr = '';
    const args: string[] = [];
    if (argsObj.imdb) args.push('--imdb', argsObj.imdb);
    if (argsObj.tmdb) args.push('--tmdb', argsObj.tmdb);
    if (argsObj.season != null) args.push('--season', String(argsObj.season));
    if (argsObj.episode != null) args.push('--episode', String(argsObj.episode));
  if (argsObj.isMovie) args.push('--movie');
  if (argsObj.tmdbKey) args.push('--tmdbKey', argsObj.tmdbKey);
    args.push('--mfp', argsObj.mfp ? '1':'0');
  // Enable debug diagnostics if env flag set
  if ((process.env.ES_DEBUG || '').match(/^(1|true|on)$/i)) args.push('--debug','1');
  console.log('[Eurostreaming][PY] spawn', script, args.join(' '));
  const start = Date.now();
  // Prefer project virtualenv python if present
  const venvPy = path.join(__dirname, '..', '..', '.venv', 'bin', 'python');
  const pythonCmd = require('fs').existsSync(venvPy) ? venvPy : 'python3';
  if (pythonCmd !== 'python3') console.log('[Eurostreaming][PY] using venv python', pythonCmd);
  const py = spawn(pythonCmd, [script, ...args]);
    const killer = setTimeout(()=>{ if(!finished){ finished = true; try{py.kill('SIGKILL');}catch{}; resolve({ error: 'timeout' }); } }, timeoutMs);
  py.stdout.on('data', d=> { const chunk = d.toString(); stdout += chunk; if (chunk.length) console.log('[Eurostreaming][PY][stdout-chunk]', chunk.slice(0,200)); });
  py.stderr.on('data', d=> { const chunk = d.toString(); stderr += chunk; if (chunk.length) console.log('[Eurostreaming][PY][stderr-chunk]', chunk.trim().split('\n').slice(-3).join(' | ')); });
  py.on('close', code => { if(finished) return; finished = true; clearTimeout(killer); const dur = Date.now()-start; if(code!==0){ console.error('[Eurostreaming][PY] exit', code, 'dur=',dur,'ms stderr_head=', stderr.slice(0,400)); return resolve({ error: stderr || 'exit '+code }); }
    try {
      console.log('[Eurostreaming][PY] raw stdout length', stdout.length);
      const parsed = JSON.parse(stdout);
      console.log('[Eurostreaming][PY] parsed streams', parsed.streams ? parsed.streams.length : 0);
      if ((!parsed.streams || !parsed.streams.length) && (parsed as any).diag) {
        console.log('[Eurostreaming][PY][diag]', JSON.stringify((parsed as any).diag));
      }
      resolve(parsed);
    } catch(e){ console.error('[Eurostreaming][PY] parse error', e, 'stdout_head=', stdout.slice(0,400)); resolve({ error: 'parse error' }); } });
    py.on('error', err => { if(finished) return; finished = true; clearTimeout(killer); console.error('[Eurostreaming][PY] proc err', err); resolve({ error: 'proc error' }); });
  });
}

export class EurostreamingProvider {
  constructor(private config: EurostreamingConfig) {}

  private formatStreams(list: PyResult['streams']): StreamForStremio[] {
    if (!list) return [];
  const out: StreamForStremio[] = [];
  for (const s of list) {
      if (!s.url) continue;
      let line1: string;
      if (s.title) line1 = s.title.split('\n')[0]; else line1 = 'Eurostreaming';
      // Language labeling exactly like MammaMia: ITA uses [ITA], subbed uses [SUB ITA]
      const lang = (s.lang||'ita').toLowerCase();
      if (lang === 'sub') {
        if (!/\[SUB ITA\]/i.test(line1)) line1 = line1.replace(/\s*\[(SUB )?ITA\]$/i,'').trim()+ ' • [SUB ITA]';
      } else {
        if (!/\[ITA\]/i.test(line1)) line1 = line1.replace(/\s*\[(SUB )?ITA\]$/i,'').trim()+ ' • [ITA]';
      }
      const segs: string[] = [];
      if (s.size) segs.push(s.size);
      if (s.res) segs.push(s.res.toLowerCase());
      segs.push((s.player||'es').toLowerCase());
      if (lang==='sub') segs.push('sub');
      const title = `${line1}\n💾 ${segs.join(' • ')}`;
      out.push({ url: s.url, title, behaviorHints: { notWebReady: true } });
    }
    return out;
  }

  async handleImdbRequest(imdbId: string, season: number | null, episode: number | null, isMovie: boolean): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) { console.log('[Eurostreaming] provider disabled'); return { streams: [] }; }
    try {
      console.log('[Eurostreaming] handleImdbRequest imdbId=', imdbId, 'season=', season, 'episode=', episode, 'isMovie=', isMovie);
      const py = await runPythonEuro({ imdb: imdbId, season, episode, mfp: !!(this.config.mfpUrl && this.config.mfpPassword), isMovie, tmdbKey: this.config.tmdbApiKey });
      console.log('[Eurostreaming] python result keys=', Object.keys(py||{}));
      const formatted = this.formatStreams(py.streams);
      console.log('[Eurostreaming] formatted count=', formatted.length);
      if (!formatted.length) console.log('[Eurostreaming] EMPTY after formatting original_count=', py.streams ? py.streams.length : 0);
      return { streams: formatted };
    } catch (e) {
      console.error('[Eurostreaming] imdb handler error', e); return { streams: [] };
    }
  }

  async handleTmdbRequest(tmdbId: string, season: number | null, episode: number | null, isMovie: boolean): Promise<{ streams: StreamForStremio[] }> {
    if (!this.config.enabled) { console.log('[Eurostreaming] provider disabled'); return { streams: [] }; }
    try {
      console.log('[Eurostreaming] handleTmdbRequest tmdbId=', tmdbId, 'season=', season, 'episode=', episode, 'isMovie=', isMovie);
      const py = await runPythonEuro({ tmdb: tmdbId, season, episode, mfp: !!(this.config.mfpUrl && this.config.mfpPassword), isMovie, tmdbKey: this.config.tmdbApiKey });
      console.log('[Eurostreaming] python result keys=', Object.keys(py||{}));
      const formatted = this.formatStreams(py.streams);
      console.log('[Eurostreaming] formatted count=', formatted.length);
      if (!formatted.length) console.log('[Eurostreaming] EMPTY after formatting original_count=', py.streams ? py.streams.length : 0);
      return { streams: formatted };
    } catch (e) { console.error('[Eurostreaming] tmdb handler error', e); return { streams: [] }; }
  }
}
