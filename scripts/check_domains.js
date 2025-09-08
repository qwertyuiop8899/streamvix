#!/usr/bin/env node
/*
 * Domain reachability & challenge checker.
 * Reads config/domains.json and probes each domain.
 * Usage:
 *   node scripts/check_domains.js            (pretty table)
 *   node scripts/check_domains.js --json     (raw JSON output)
 *   node scripts/check_domains.js --timeout=5000 --concurrency=4
 */
const fs = require('fs');
const path = require('path');
const { fetchPage } = require('../dist/src/providers/flaresolverr.js');

const argv = process.argv.slice(2);
const asFlag = (name, def) => {
  const m = argv.find(a=>a.startsWith(`--${name}=`));
  if (m) return m.split('=')[1];
  return def;
};
const WANT_JSON = argv.includes('--json');
const TIMEOUT_MS = parseInt(asFlag('timeout','6000'),10) || 6000;
const CONC = Math.max(1, parseInt(asFlag('concurrency','5'),10) || 5);

function classifyChallenge(bodyOrNote, status) {
  if (!bodyOrNote) return false;
  if (/cloudflare_challenge|challenge_body|challenge_detected/i.test(bodyOrNote)) return true;
  const pats = [/cf-turnstile/i,/Just a moment/i,/__cf_chl_/i,/challenge-platform\//i];
  if (status === 403) return true;
  return pats.some(r=>r.test(String(bodyOrNote)));
}

async function probe(key, host) {
  const url = `https://${host}`;
  const started = Date.now();
  let outcome = { key, host, url, status: 'error', httpStatus: null, ms: 0, note: '' };
  try {
    // first try fetchPage
    try {
      const body = await fetchPage(url, { noCache: true });
      outcome.httpStatus = 200;
      if (classifyChallenge(body, 200)) { outcome.status = 'blocked'; outcome.note = 'challenge_body'; }
      else outcome.status = 'ok';
      outcome.ms = Date.now() - started;
      return outcome;
    } catch (e) {
      const msg = (e && e.message) ? e.message : String(e);
      outcome.note = msg;
      if (/cloudflare_challenge|http_403|blocked/i.test(msg)) {
        outcome.status = 'blocked';
        outcome.ms = Date.now() - started;
        return outcome;
      }
      // fallback raw fetch
      try {
        const controller = new AbortController();
        const to = setTimeout(()=>controller.abort(), TIMEOUT_MS);
        const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent':'Mozilla/5.0' } });
        clearTimeout(to);
        outcome.httpStatus = r.status;
        let txt = '';
        try { txt = await r.text(); } catch {}
        if (classifyChallenge(txt, r.status)) { outcome.status='blocked'; outcome.note='challenge_detected'; }
        else if (r.status >=200 && r.status <=399) outcome.status='ok';
        else outcome.status='error';
        outcome.ms = Date.now() - started;
        return outcome;
      } catch (e2){
        outcome.note += '; fallback fail: ' + (e2.message||e2);
        outcome.status = 'error';
        outcome.ms = Date.now() - started;
        return outcome;
      }
    }
  } catch (finalErr) {
    outcome.note = (finalErr && finalErr.message) ? finalErr.message : String(finalErr);
    outcome.status = outcome.status === 'blocked' ? 'blocked' : 'error';
    outcome.ms = Date.now() - started;
    return outcome;
  }
}

(async () => {
  const domainsPath = path.join(__dirname, '..', 'config', 'domains.json');
  let map;
  try { map = JSON.parse(fs.readFileSync(domainsPath, 'utf8')); } catch (e){
    console.error('Failed to read domains.json', e.message || e);
    process.exit(1);
  }
  const entries = Object.entries(map);
  const queue = entries.slice();
  const results = [];
  async function worker(){
    while(queue.length){
      const [k,h] = queue.shift();
      const r = await probe(k,h);
      results.push(r);
      if (!WANT_JSON) {
        console.log(`[${r.status.padEnd(7)}] ${k.padEnd(12)} ${r.host.padEnd(25)} ${String(r.httpStatus||'-').padStart(3)} ${String(r.ms).padStart(5)}ms ${r.note?('- '+r.note.slice(0,60)):' '}`);
      }
    }
  }
  const workers = Array(Math.min(CONC, entries.length)).fill(0).map(()=>worker());
  await Promise.all(workers);
  results.sort((a,b)=>a.key.localeCompare(b.key));
  const summary = results.reduce((acc,r)=>{acc[r.status]=(acc[r.status]||0)+1;return acc;},{});
  if (WANT_JSON) {
    console.log(JSON.stringify({ summary, results, concurrency: CONC, timeoutMs: TIMEOUT_MS }, null, 2));
  } else {
    console.log('\nSummary:', summary);
  }
})();
