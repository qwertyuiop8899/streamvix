#!/usr/bin/env python3
"""spso_streams.py

Enrichment script per playlist SportsOnline, aggiunge stream etichettati con prefisso [SPSO].

Motivazione aggiornamento (caso reale: "Napoli vs Sporting CP"):
    La versione originale falliva il match perché:
        1. L'evento contiene extra (orario / lega / data) es: "⏰ 21:00 : Napoli vs Sporting CP - Champions League 01/10"
        2. L'estrazione squadre non tagliava la parte dopo ' - ' ⇒ lato destro diventava "Sporting CP - Champions League 01/10".
        3. La normalizzazione sceglieva solo l'ULTIMO token ("10") invece di "sporting".
        4. Set confronto {napoli,10} ≠ {napoli,cp} ⇒ nessun match.

Nuova strategia matching:
    - Latinizzazione (rimozione accenti: Grêmio→Gremio, Škendija→Skendija, Köln→Koln)
    - Extract: rimozione prefisso orario/emoj, tag finale [HD..], tronca dopo ' - ' (lega / competizione)
    - Alias multipli per ciascuna squadra: full, primo, ultimo, ultime due parole, forma concatenata se due tokens, sinonimi (_SYNONYMS)
    - Matching gerarchico:
             a) Strict set (norm_team coppia) se entrambe le squadre estratte
             b) Alias direct (event_team1 ∩ playlist_team1 AND event_team2 ∩ playlist_team2)
             c) Alias cross (incrociato) per invertire ordine se necessario
             d) Single entity fallback (parole chiave GP / MotoGP / tennis etc.)
    - Ignora token finali puramente numerici nella normalizzazione base.
    - Logging opzionale con SPSO_MATCH_DEBUG=1 per diagnosi (mostra MISS e ragione dei match trovati).

Ordering invariato:
    - Inserimento dopo cluster iniziale (Vavoo + [P🐽D] + 🇮🇹) + blocco RB77 e prima di primo [Strd].

Environment:
    SPSO_PLAYLIST_URL  (default https://world-proxifier.xyz/sportsonline/playlist.m3u8)
    SPSO_FALLBACK_URL  (default stesso URL)
    SPSO_FORCE         (forza esecuzione) [non usato per finestre temporali attualmente]
    DYNAMIC_FILE       (default /tmp/dynamic_channels.json)
    SPSO_MATCH_DEBUG   (stampa dettagli di match/miss)
    SPSO_LANG_FILTER / SPSO_LANG_KEYWORDS opzionali come versione precedente.

Persistenza: /tmp/spso_streams_persist.json
"""
from __future__ import annotations
import os, re, json, time, datetime, sys, urllib.request, socket, unicodedata
from typing import List, Dict, Any, Tuple

PLAYLIST_URL = os.environ.get('SPSO_PLAYLIST_URL','https://world-proxifier.xyz/sportsonline/playlist.m3u8')
FALLBACK_URL = os.environ.get('SPSO_FALLBACK_URL','https://world-proxifier.xyz/sportsonline/playlist.m3u8')
DYNAMIC_FILE = os.environ.get('DYNAMIC_FILE') or '/tmp/dynamic_channels.json'
PERSIST_FILE = '/tmp/spso_streams_persist.json'
FORCE_MODE = (os.environ.get('SPSO_FORCE') or '').lower() in {'1','true','on','yes','force'} or any(a in {'-f','--force'} for a in sys.argv[1:])
PREFIX_BASE = '[SPSO]'
SOCCER_EMOJI = '⚽'

# Optional language filtering similar to RBTV (disabled by default)
LANG_FILTER = (os.environ.get('SPSO_LANG_FILTER') or '').lower() in {'1','true','on','yes'}
LANG_INCLUDE = [t.strip().lower() for t in (os.environ.get('SPSO_LANG_KEYWORDS') or 'italiano,italia,italy,ita').split(',') if t.strip()]
INCLUDE_REGEX = re.compile('|'.join(re.escape(t) for t in LANG_INCLUDE), re.IGNORECASE) if LANG_FILTER and LANG_INCLUDE else None

# Team separator pattern uses ' x ' ; we also fallback to RBTV style if not found
# Separatore ' x ' gestito via split semplice (supporta accenti). Regex precedente perdeva lettere accentate.
SEP_X = re.compile(r'\s+x\s+', re.IGNORECASE)
VS_FALLBACK = re.compile(r'\b(vs?|vs\.|v)\b', re.IGNORECASE)
TAG_SUFFIX = re.compile(r'\[[^\]]+\]\s*$')
WORD_CLEAN = re.compile(r'[^a-z0-9]+')

SINGLE_KEYWORDS = ['grand prix','gp','formula 1','f1','motogp','qualifying','practice','free practice','fp1','fp2','fp3','sprint','volley','volleyball','tennis']

def now_utc():
    return datetime.datetime.now(datetime.timezone.utc)

def _latinize(txt: str) -> str:
    return ''.join(c for c in unicodedata.normalize('NFKD', txt) if not unicodedata.combining(c))

_SYNONYMS = {
    'internazionale': 'inter', 'inter': 'inter', 'juventus': 'juve', 'juve': 'juve', 'napoli': 'napoli',
    'sporting cp': 'sporting', 'sporting clube': 'sporting', 'sporting': 'sporting',
    'psg': 'psg', 'paris': 'psg', 'paris saint germain': 'psg', 'saint-germain': 'psg', 'paris sg': 'psg',
    'manchester city': 'city', 'man city': 'city', 'mancity': 'city', 'city': 'city',
    'atletico madrid': 'atletico', 'atlético madrid': 'atletico', 'athletic club': 'athletic', 'athletic bilbao': 'athletic',
    'crvena zvezda': 'zvezda', 'red star': 'zvezda', 'köln': 'koln', 'koln': 'koln',
    'bayer leverkusen': 'leverkusen', 'fc porto': 'porto', 'porto': 'porto'
}

def norm_team(name: str) -> str:
    n = _latinize(name).lower().strip()
    n = WORD_CLEAN.sub(' ', n)
    toks = [t for t in n.split() if t]
    if not toks:
        return ''
    full = ' '.join(toks)
    if full in _SYNONYMS:
        return _SYNONYMS[full]
    # Evita token numerici finali come identificatore principale
    filtered = [t for t in toks if not t.isdigit()]
    base_tokens = filtered or toks
    last = base_tokens[-1]
    if last in _SYNONYMS:
        return _SYNONYMS[last]
    return last

def team_aliases(name: str) -> set[str]:
    n = _latinize(name).lower()
    n = WORD_CLEAN.sub(' ', n).strip()
    toks = [t for t in n.split() if t]
    if not toks:
        return set()
    aliases: set[str] = set()
    full = ' '.join(toks)
    aliases.add(full)
    if full in _SYNONYMS:
        aliases.add(_SYNONYMS[full])
    # primi / ultimi
    aliases.add(toks[0])
    aliases.add(toks[-1])
    if len(toks) >= 2:
        aliases.add(' '.join(toks[-2:]))
    if len(toks) == 2:
        aliases.add(''.join(toks))  # mancity, redstar
    for t in toks:
        if t in _SYNONYMS:
            aliases.add(_SYNONYMS[t])
    return {a for a in aliases if a and not a.isdigit()}

def extract_teams(title: str) -> Tuple[str|None,str|None]:
    core = TAG_SUFFIX.sub('', title).strip()
    # Rimuove prefisso orario / emoji (es "⏰ 21:00 : ") se presente
    core = re.sub(r'^.+?:\s+', '', core) if ' : ' in core else core
    # Tronca dopo ' - ' (lega / competizione / data)
    if ' - ' in core:
        core = core.split(' - ', 1)[0].strip()
    low = core.lower()
    if ' x ' in low:
        parts = core.split(' x ', 1)
        if len(parts) == 2:
            l, r = parts[0].strip(), parts[1].strip()
            if l and r:
                return l, r
    matches = list(VS_FALLBACK.finditer(core))
    if matches:
        mv = matches[-1]
        left = core[:mv.start()].strip()
        right = core[mv.end():].strip()
        if left and right:
            return left, right
    return None, None

def is_single_entity(title: str) -> bool:
    t = title.lower()
    return any(kw in t for kw in SINGLE_KEYWORDS)

FETCH_ATTEMPTS = int(os.environ.get('SPSO_FETCH_ATTEMPTS','3') or '3')
FETCH_TIMEOUT = float(os.environ.get('SPSO_FETCH_TIMEOUT','12') or '12')
FAST_FORCE = (os.environ.get('SPSO_FAST_FORCE') or '').lower() in {'1','true','on','yes'} and FORCE_MODE
if FAST_FORCE:
    FETCH_ATTEMPTS = min(FETCH_ATTEMPTS, 1)
    FETCH_TIMEOUT = min(FETCH_TIMEOUT, 5.0)
DEBUG_FETCH = (os.environ.get('SPSO_DEBUG_FETCH') or '').lower() in {'1','true','on','yes'}

def _build_request(url: str) -> urllib.request.Request:
    """Replica il modello RBTV per massimizzare compatibilità col medesimo server."""
    ua = os.environ.get('SPSO_UA') or os.environ.get('RBTV_UA') or os.environ.get('STREAMED_UA') or 'Mozilla/5.0 (compatible; SPSOFetcher/1.0)'
    referer = os.environ.get('SPSO_REFERER') or os.environ.get('RBTV_REFERER') or os.environ.get('STREAMED_REFERER') or 'https://embedsports.top/'
    headers = {
        'User-Agent': ua,
        'Referer': referer,
        'Accept': '*/*',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache'
    }
    extra = os.environ.get('SPSO_PLAYLIST_HEADERS')  # formato Key:Value;Key2:Value2
    if extra:
        for pair in re.split(r'[;\n]+', extra):
            if not pair.strip():
                continue
            if ':' in pair:
                k, v = pair.split(':', 1)
                headers[k.strip()] = v.strip()
    return urllib.request.Request(url, headers=headers, method='GET')

def _download_playlist(url: str) -> str | None:
    """Metodo di download allineato a RBTV: tentativi con urllib, poi requests (se disponibile), infine curl."""
    attempts = max(1, FETCH_ATTEMPTS)
    timeout = max(2.0, FETCH_TIMEOUT)
    last_err: Exception | None = None
    for i in range(1, attempts + 1):
        try:
            start_ts = time.time()
            req = _build_request(url)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw_bytes = r.read()
            dur_ms = int((time.time() - start_ts) * 1000)
            raw = raw_bytes.decode('utf-8', 'replace')
            if DEBUG_FETCH:
                print(f"[SPSO][FETCH][DBG] attempt={i} status=OK ms={dur_ms} bytes={len(raw_bytes)} has_extm3u={('#EXTM3U' in raw)}")
            if raw and '#EXTM3U' in raw:
                return raw
        except Exception as e:
            last_err = e
            print(f"[SPSO][FETCH][WARN] attempt={i}/{attempts} err={e}")
            if i < attempts:
                time.sleep(min(2.5, i))
    # fallback: requests se non in FAST_FORCE
    if not FAST_FORCE:
        try:
            import requests  # type: ignore
            req_headers = {
                'User-Agent': os.environ.get('SPSO_UA','Mozilla/5.0'),
                'Referer': os.environ.get('SPSO_REFERER','https://embedsports.top/'),
                'Accept': '*/*',
                'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
                'Connection': 'keep-alive'
            }
            rstart = time.time()
            resp = requests.get(url, headers=req_headers, timeout=timeout)
            dur_ms = int((time.time()-rstart)*1000)
            if DEBUG_FETCH:
                print(f"[SPSO][FETCH][REQ] code={resp.status_code} ms={dur_ms} bytes={len(resp.text)}")
            if resp.ok and '#EXTM3U' in resp.text:
                return resp.text
        except Exception as e:
            print(f"[SPSO][FETCH][FALLBACK][ERR] {e}")
    if last_err and DEBUG_FETCH:
        print(f"[SPSO][FETCH][ERR] giving up: {last_err}")
    # fallback finale curl
    try:
        import subprocess, shlex
        curl_timeout = int(min(25, timeout + 10))
        cmd = os.environ.get('SPSO_CURL_CMD', f"curl -L --max-time {curl_timeout} -A 'Mozilla/5.0 (SPSOCurl)' -H 'Referer: https://embedsports.top/' --fail --silent --show-error {shlex.quote(url)}")
        start_ts = time.time()
        r = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=curl_timeout+5)
        if r.returncode == 0:
            txt = r.stdout.decode('utf-8','replace')
            if '#EXTM3U' in txt:
                dur = int((time.time()-start_ts)*1000)
                print(f"[SPSO][FETCH][CURL][OK] ms={dur} bytes={len(txt)}")
                return txt
            else:
                print(f"[SPSO][FETCH][CURL][WARN] no #EXTM3U rc=0 bytes={len(txt)}")
        else:
            print(f"[SPSO][FETCH][CURL][ERR] rc={r.returncode} stderr={r.stderr.decode('utf-8','replace')[:180]}")
    except Exception as e2:
        print(f"[SPSO][FETCH][CURL][EXC] {e2}")
    return None

def _dns_log(host: str):
    try:
        ips = socket.gethostbyname_ex(host)[2]
        print(f"[SPSO][DNS] {host} -> {','.join(ips)}")
    except Exception as e:
        if DEBUG_FETCH:
            print(f"[SPSO][DNS][ERR] {host} {e}")

def fetch_playlist() -> List[Dict[str,Any]]:
    # DNS diag simile a RBTV
    try:
        # Manteniamo stessa chiamata stilisticamente (anche se urlparse sta in urllib.parse)
        import urllib.parse
        host = urllib.parse.urlparse(PLAYLIST_URL).hostname
        if host:
            _dns_log(host)
    except Exception:
        pass
    raw = _download_playlist(PLAYLIST_URL)
    if raw is None and FALLBACK_URL and FALLBACK_URL != PLAYLIST_URL:
        print('[SPSO][FETCH] trying fallback URL')
        try:
            import urllib.parse
            host2 = urllib.parse.urlparse(FALLBACK_URL).hostname
            if host2:
                _dns_log(host2)
        except Exception:
            pass
        raw = _download_playlist(FALLBACK_URL)
    if not raw:
        if DEBUG_FETCH:
            print('[SPSO][FETCH][EMPTY] playlist download failed (raw is None)')
        return []
    lines = [l.strip() for l in raw.splitlines() if l.strip()]
    out: List[Dict[str,Any]] = []
    i = 0
    while i < len(lines):
        if lines[i].startswith('#EXTINF'):
            title = lines[i].split(',',1)[-1].strip()
            url = None
            if i+1 < len(lines) and lines[i+1].startswith('http'):
                url = lines[i+1].strip(); i += 1
            if url:
                if INCLUDE_REGEX and not INCLUDE_REGEX.search(title.lower()):
                    pass
                else:
                    out.append({'title': title, 'url': url})
        i += 1
    return out

def load_dynamic():
    if not os.path.exists(DYNAMIC_FILE):
        return []
    try:
        with open(DYNAMIC_FILE,'r',encoding='utf-8') as f:
            data = json.load(f)
        if isinstance(data,list):
            return data
    except Exception:
        pass
    return []

def save_dynamic(data):
    try:
        tmp = DYNAMIC_FILE + '.spso.tmp'
        with open(tmp,'w',encoding='utf-8') as f:
            json.dump(data,f,ensure_ascii=False, indent=2)
        os.replace(tmp,DYNAMIC_FILE)
    except Exception as e:
        print(f"[SPSO][ERR] write dynamic: {e}")

def load_persist():
    try:
        if os.path.exists(PERSIST_FILE):
            with open(PERSIST_FILE,'r',encoding='utf-8') as f:
                p = json.load(f)
            if isinstance(p,dict):
                return p
    except Exception:
        pass
    return {}

def save_persist(p: Dict[str,Any]):
    try:
        tmp = PERSIST_FILE + '.tmp'
        with open(tmp,'w',encoding='utf-8') as f:
            json.dump(p,f,ensure_ascii=False, indent=2)
        os.replace(tmp,PERSIST_FILE)
    except Exception as e:
        print(f"[SPSO][PERSIST][ERR] {e}")

def enrich():
    dyn = load_dynamic()
    if not dyn:
        return
    playlist = fetch_playlist()
    if not playlist:
        return
    persist = load_persist()
    persist_changed = False
    changed = False
    added_total = 0

    for ev in dyn:
        try:
            name = ev.get('name','')
            ev_streams = ev.get('streams') or []
            existing_urls = {s.get('url') for s in ev_streams if isinstance(s, dict)}
            existing_titles = {s.get('title') for s in ev_streams if isinstance(s, dict)}

            # restore path: if any previously stored SPSO entries missing re-insert in correct spot
            ev_id = str(ev.get('id'))
            stored = persist.get(ev_id,{}).get('streams') if ev_id in persist else None
            if stored:
                restored = 0
                insert_idx = compute_insert_index(ev_streams)
                for rs in stored:
                    u = rs.get('url'); tt = rs.get('title')
                    if u in existing_urls or tt in existing_titles:
                        continue
                    ev_streams.insert(insert_idx, rs)
                    insert_idx += 1
                    existing_urls.add(u); existing_titles.add(tt)
                    restored += 1
                if restored:
                    ev['streams'] = ev_streams
                    changed = True
                    print(f"[SPSO][RESTORE] event={ev.get('id')} restored={restored}")

            t1,t2 = extract_teams(name)
            single_mode = False
            if not t1 or not t2:
                if is_single_entity(name):
                    single_mode = True
                else:
                    continue
            ev_alias_1 = team_aliases(t1) if t1 else set()
            ev_alias_2 = team_aliases(t2) if t2 else set()
            ev_norm = {norm_team(t1), norm_team(t2)} if not single_mode and t1 and t2 else set()
            debug_match = (os.environ.get('SPSO_MATCH_DEBUG') or '').lower() in {'1','true','on','yes'}
            added_this = 0
            for pl in playlist:
                pt1,pt2 = extract_teams(pl['title'])
                match_ok = False
                reason = ''
                if single_mode:
                    if is_single_entity(pl['title']):
                        match_ok = True; reason = 'single'
                else:
                    if pt1 and pt2:
                        pls = {norm_team(pt1), norm_team(pt2)}
                        if pls == ev_norm and '' not in pls:
                            match_ok = True; reason = 'strict'
                        else:
                            p1a = team_aliases(pt1)
                            p2a = team_aliases(pt2)
                            direct = (ev_alias_1 & p1a) and (ev_alias_2 & p2a)
                            cross  = (ev_alias_1 & p2a) and (ev_alias_2 & p1a)
                            if direct or cross:
                                match_ok = True; reason = 'alias-direct' if direct else 'alias-cross'
                if not match_ok:
                    if debug_match:
                        print(f"[SPSO][MATCH][MISS] ev='{name}' pl='{pl['title']}' ev1={list(ev_alias_1)[:5]} ev2={list(ev_alias_2)[:5]}")
                    continue
                final_url = pl['url']
                # Estrarre solo la parte variante (es: [HDD A], [HDD B], [SD], [VDO], ecc.) se presente
                display_title = pl['title']
                variant_match = re.findall(r'\[[^\]]+\]', display_title)
                variant_part = variant_match[-1] if variant_match else display_title  # ultima tag come variante
                # Costruiamo titolo compatto: [SPSO] ⚽ <VARIANTE>
                new_title = f"{PREFIX_BASE} {SOCCER_EMOJI} {variant_part}".strip()
                if final_url in existing_urls or new_title in existing_titles:
                    continue
                insert_idx = compute_insert_index(ev_streams)
                ev_streams.insert(insert_idx, {'url': final_url, 'title': new_title})
                existing_urls.add(final_url); existing_titles.add(new_title)
                added_this += 1
            if added_this:
                ev['streams'] = ev_streams
                persist[ev_id] = {'ts': int(time.time()), 'streams': [s for s in ev_streams if isinstance(s,dict) and str(s.get('title','')).startswith(PREFIX_BASE)]}
                persist_changed = True
                added_total += added_this
                print(f"[SPSO][INJECT]{'[FORCE]' if FORCE_MODE else ''} event={ev.get('id')} added={added_this} mode={'SINGLE' if single_mode else 'DUO'}")
            elif debug_match and not added_this:
                print(f"[SPSO][MATCH][NONE] ev='{name}' nessun match playlist")
        except Exception as e:
            print(f"[SPSO][ERR] event loop: {e}")
            continue

    if persist_changed:
        save_persist(persist)
    if changed or added_total:
        save_dynamic(dyn)
        print(f"[SPSO][DONE] total_added={added_total}")

# Ordering helper

def compute_insert_index(ev_streams: list) -> int:
    # cluster_end like RBTV (Vavoo + [P🐽D] + 🇮🇹 flag)
    def _is_vavoo(st):
        if not isinstance(st, dict): return False
        t = str(st.get('title','')); u = str(st.get('url',''))
        return u.startswith('vavoo://') or t.startswith('[🏠]')
    def _is_pd(st):
        return isinstance(st, dict) and str(st.get('title','')).startswith('[P🐽D]')
    def _is_italian_flag(st):
        return isinstance(st, dict) and ('🇮🇹' in str(st.get('title','')))
    def _is_rbtv(st):
        return isinstance(st, dict) and (str(st.get('title','')).startswith('[RB77') or '[RB77🇮🇹]' in str(st.get('title','')))
    def _is_strd(st):
        return isinstance(st, dict) and str(st.get('title','')).startswith('[Strd]')

    cluster_end = 0
    for idx,s in enumerate(ev_streams):
        if _is_vavoo(s) or _is_pd(s) or _is_italian_flag(s):
            cluster_end = idx + 1
        else:
            break
    # After RBTV group (any contiguous RBTV entries immediately after cluster_end)
    after_rb = cluster_end
    for idx in range(cluster_end, len(ev_streams)):
        if _is_rbtv(ev_streams[idx]):
            after_rb = idx + 1
        else:
            break
    # Insert before first [Strd] after after_rb
    first_strd = None
    for idx in range(after_rb, len(ev_streams)):
        if _is_strd(ev_streams[idx]):
            first_strd = idx; break
    insert_idx = first_strd if first_strd is not None else after_rb
    return insert_idx

if __name__ == '__main__':
    try:
        enrich()
    except Exception as e:
        print(f"[SPSO][FATAL] {e}")
        sys.exit(0)
