import axios from 'axios';

/**
 * Script per generare gli URL HLS lovecdn dai codici freeshot.
 * Deriva dalla logica Python di myResolver.freeshot:
 *   1. GET https://popcdn.day/go.php?stream=<code>
 *      Referer: https://freeshot.live/embed/<code>.php
 *   2. Estrarre dall'HTML l'iframe frameborder="0" src="...token=XYZ&..."
 *   3. Costruire https://beautifulpeople.lovecdn.ru/<code>/index.fmp4.m3u8?token=XYZ
 *
 * Modalità CLI:
 *   ts-node src/scripts/freeshot_fetch.ts one <code>
 *   ts-node src/scripts/freeshot_fetch.ts multi <code1,code2,...>
 *   ts-node src/scripts/freeshot_fetch.ts file <file_con_lista_codici>
 *   ts-node src/scripts/freeshot_fetch.ts validate <c1,c2,...>    (risolve + HEAD/GET prima parte playlist)
 *   ts-node src/scripts/freeshot_fetch.ts validatefile <file>     (come sopra da file)
 */

interface FreeShotResult {
  code: string;
  m3u8?: string;
  token?: string;
  error?: string;
  iframe?: string;
  reachable?: boolean; // true se la playlist restituisce #EXTM3U
  httpStatus?: number;
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';

async function resolveCode(code: string): Promise<FreeShotResult> {
  const ret: FreeShotResult = { code };
  try {
    const urlAuth = `https://popcdn.day/go.php?stream=${encodeURIComponent(code)}`;
    const html = await axios.get(urlAuth, {
      timeout: 15000,
      headers: {
        'User-Agent': UA,
        'Referer': `https://freeshot.live/embed/${code}.php`,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      }
    });

    const body = html.data as string;
    const iframeMatch = body.match(/frameborder="0"\s+src="([^"]+)"/i);
    if (!iframeMatch) {
      ret.error = 'iframe non trovato';
      return ret;
    }
    const iframeUrl = iframeMatch[1];
    ret.iframe = iframeUrl;

    const tokenMatch = iframeUrl.match(/token=([A-Za-z0-9_-]+)/);
    if (!tokenMatch) {
      ret.error = 'token non trovato';
      return ret;
    }
    const token = tokenMatch[1];
    ret.token = token;

    // Costruzione URL finale HLS come da Python
    ret.m3u8 = `https://beautifulpeople.lovecdn.ru/${code}/index.fmp4.m3u8?token=${token}`;
    return ret;
  } catch (err: any) {
    ret.error = err?.message || String(err);
    return ret;
  }
}

async function checkPlaylist(res: FreeShotResult, timeoutMs = 10000): Promise<FreeShotResult> {
  if (!res.m3u8 || res.error) return res;
  try {
    // Facciamo una GET limitata (range bytes) per evitare di scaricare tutto.
    const r = await axios.get(res.m3u8, {
      timeout: timeoutMs,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*;q=0.8',
        // alcuni server supportano Range; se no ignora
        'Range': 'bytes=0-2048'
      },
      responseType: 'text',
      validateStatus: () => true
    });
    res.httpStatus = r.status;
    const txt: string = typeof r.data === 'string' ? r.data : r.data?.toString?.() || '';
    if (r.status >= 200 && r.status < 400 && /#EXTM3U/.test(txt)) {
      res.reachable = true;
    } else {
      res.reachable = false;
      if (!res.error) res.error = 'playlist non valida';
    }
    return res;
  } catch (e: any) {
    res.reachable = false;
    if (!res.error) res.error = 'errore fetch playlist: ' + (e?.message || e);
    return res;
  }
}

async function runCli() {
  const mode = process.argv[2];
  if (!mode || ['-h','--help','help'].includes(mode)) {
    console.log('Uso:\n  one <code>                     -> risolve singolo codice\n  multi <c1,c2,...>              -> risolve lista separata da virgole\n  file <pathfile>                -> ogni linea un codice\n  validate <c1,c2,...>           -> risolve + verifica #EXTM3U\n  validatefile <pathfile>        -> come validate da file\n');
    process.exit(0);
  }

  if (mode === 'one') {
    const code = process.argv[3];
    if (!code) { console.error('Manca <code>'); process.exit(1); }
    const res = await resolveCode(code.trim());
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (mode === 'multi') {
    const list = process.argv[3];
    if (!list) { console.error('Manca lista codici'); process.exit(1); }
    const codes = list.split(',').map(s => s.trim()).filter(Boolean);
    const out: FreeShotResult[] = [];
    for (const c of codes) {
      // eslint-disable-next-line no-await-in-loop
      out.push(await resolveCode(c));
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  if (mode === 'file') {
    const file = process.argv[3];
    if (!file) { console.error('Manca path file'); process.exit(1); }
    const fs = await import('fs');
    const content = fs.readFileSync(file, 'utf-8');
    const codes = content.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const out: FreeShotResult[] = [];
    for (const c of codes) {
      // eslint-disable-next-line no-await-in-loop
      out.push(await resolveCode(c));
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (mode === 'validate') {
    const list = process.argv[3];
    if (!list) { console.error('Manca lista codici'); process.exit(1); }
    const codes = list.split(',').map(s => s.trim()).filter(Boolean);
    const out: FreeShotResult[] = [];
    for (const c of codes) {
      // eslint-disable-next-line no-await-in-loop
      const r = await resolveCode(c);
      // eslint-disable-next-line no-await-in-loop
      out.push(await checkPlaylist(r));
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (mode === 'validatefile') {
    const file = process.argv[3];
    if (!file) { console.error('Manca path file'); process.exit(1); }
    const fs = await import('fs');
    const content = fs.readFileSync(file, 'utf-8');
    const codes = content.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const out: FreeShotResult[] = [];
    for (const c of codes) {
      // eslint-disable-next-line no-await-in-loop
      const r = await resolveCode(c);
      // eslint-disable-next-line no-await-in-loop
      out.push(await checkPlaylist(r));
    }
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  console.error('Modo non riconosciuto');
  process.exit(1);
}

if (require.main === module) {
  runCli();
}
