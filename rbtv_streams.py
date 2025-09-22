#!/usr/bin/env python3
"""rbtv_streams.py

Enrichment script for RB77 playlist (RBTV) adding Italian-labelled streams.

Discovery window:
  start - RBTV_DISCOVERY_BEFORE_MIN (default 15)
  to     start + RBTV_DISCOVERY_AFTER_MIN (default 10)
Poll interval handled externally (addon.ts) every ~120s.
Streams once discovered persist for lifetime of the event (restored if lost).

Filters:
  - Only entries containing any of: ITALIANO, ITALIA, ITALY, ITA, ITAL, IT (case-insensitive)
  - Team vs parsing: prefer pattern "A vs B"; if not present, attempt extraction after first ' - ' (segment may contain vs).
  - If no vs at all, treat as single-entity (F1/MotoGP/Tennis/Volley) using keyword detection similar to streamed_channels.

Tag prefix: [RB77🇮🇹] with dynamic status symbol:
    - 🚫 if now < start - 10min
    - 🔴 if now >= start - 10min (and remains after start)
Ordering: inserted after PD + 🇮🇹 cluster and BEFORE [Strd] streams.
Persistence file: /tmp/rbtv_streams_persist.json

Environment:
  RBTV_PLAYLIST_URL (default https://world-proxifier.xyz/rbtv/playlist.m3u8)
  RBTV_DISCOVERY_BEFORE_MIN (default 15)
  RBTV_DISCOVERY_AFTER_MIN (default 10)
  DYNAMIC_FILE (default /tmp/dynamic_channels.json)
  RBTV_FORCE (force discovery ignoring windows)
"""
from __future__ import annotations
import os, re, json, time, datetime, sys, urllib.request, socket
from typing import List, Dict, Any, Tuple

PLAYLIST_URL = os.environ.get('RBTV_PLAYLIST_URL','https://world-proxifier.xyz/rbtv/playlist.m3u8')
# Fallback URL (può essere identico o diverso, configurabile). Se il fetch principale fallisce, tenteremo questo.
FALLBACK_URL = os.environ.get('RBTV_FALLBACK_URL','https://world-proxifier.xyz/rbtv/playlist.m3u8')
BEFORE_MIN = int(os.environ.get('RBTV_DISCOVERY_BEFORE_MIN','15'))
AFTER_MIN = int(os.environ.get('RBTV_DISCOVERY_AFTER_MIN','10'))
DYNAMIC_FILE = os.environ.get('DYNAMIC_FILE') or '/tmp/dynamic_channels.json'
PERSIST_FILE = '/tmp/rbtv_streams_persist.json'
FORCE_MODE = (os.environ.get('RBTV_FORCE') or '').lower() in {'1','true','on','yes','force'} or any(a in {'-f','--force'} for a in sys.argv[1:])
PREFIX_BASE_ITA = '[RB77🇮🇹]'
PREFIX_BASE_FALLBACK = '[RB77]'
SOCCER_EMOJI = '⚽'
STATUS_THRESHOLD_MIN = 10

# --- Language filtering configuration ---
# Comma separated positive / negative keyword lists (case-insensitive)
# Defaults kept intentionally narrow to avoid false positives like 'digital'.
LANG_INCLUDE = [t.strip().lower() for t in (os.environ.get('RBTV_LANG_KEYWORDS')
                 or 'italiano,italia,italy,ita,[ita]').split(',') if t.strip()]
LANG_EXCLUDE = [t.strip().lower() for t in (os.environ.get('RBTV_EXCLUDE_KEYWORDS')
                 or 'english,inglese,spanish,espanol,español,french,francais,deutsch,german,portuguese,portugues,português,arab,arabo,turk,turco,russian,russo,polish,polacco,greek,greco,serb,serbo,croat,croato,alban,albanese,brazil,brasil,portugal').split(',') if t.strip()]
STRICT_MODE = (os.environ.get('RBTV_STRICT') or '').lower() in {'1','true','yes','on','strict'}
LENIENT_TEXT_ITALIAN = (os.environ.get('RBTV_LENIENT_TEXT_ITALIAN') or '').lower() in {'1','true','yes','on'}

# Fetch tuning (nuovi parametri)
RAW_ATTEMPTS = int(os.environ.get('RBTV_FETCH_ATTEMPTS', '3') or '3')
RAW_TIMEOUT = float(os.environ.get('RBTV_FETCH_TIMEOUT', '15') or '15')  # seconds per attempt
FAST_FORCE = (os.environ.get('RBTV_FAST_FORCE') or '').lower() in {'1','true','yes','on'}
if FAST_FORCE and ('force' in sys.argv or (os.environ.get('RBTV_FORCE') or '').lower() in {'1','true','on','yes','force'}):
    # Modalità test veloce: un solo tentativo con timeout ridotto
    RAW_ATTEMPTS = min(RAW_ATTEMPTS, 1)
    RAW_TIMEOUT = min(RAW_TIMEOUT, 5.0)
LOG_FETCH_DEBUG = (os.environ.get('RBTV_DEBUG_FETCH') or '').lower() in {'1','true','yes','on'}
FALLBACK_ALLOW_SD = (os.environ.get('RBTV_FALLBACK_ALLOW_SD') or '').lower() in {'1','true','yes','on'}

# Pre-compile inclusive regex patterns. We treat special tokens:
#  - '[ita]' bracket tag
#  - whole word 'ita'
#  - words starting with 'italia', 'italiano', 'italy'
#  - if STRICT_MODE False we also allow 'ital' followed by (y|ia|iano) ignoring accents
_INC_PATTERNS = []
for tok in LANG_INCLUDE:
    if not tok:
        continue
    if tok == '[ita]':
        _INC_PATTERNS.append(r'\[\s*ita\s*\]')
    elif tok in {'ita'}:
        _INC_PATTERNS.append(r'\bita\b')
    elif tok.startswith('ital'):
        # Accept variants italy / italia / italiano
        _INC_PATTERNS.append(r'ital(?:y|ia|iano)?')
    else:
        # escape general token
        _INC_PATTERNS.append(re.escape(tok))
INCLUDE_REGEX = re.compile('|'.join(_INC_PATTERNS), re.IGNORECASE) if _INC_PATTERNS else None
EXCLUDE_REGEX = re.compile('|'.join(re.escape(t) for t in LANG_EXCLUDE), re.IGNORECASE) if LANG_EXCLUDE else None
SINGLE_KEYWORDS = ['grand prix','gp','formula 1','f1','motogp','qualifying','practice','free practice','fp1','fp2','fp3','sprint','roland garros','wimbledon','us open','australian open','atp','wta','masters','final','semifinal','quarterfinal','volley','volleyball']

MATCH_SPLIT = re.compile(r'\b(vs?|vs\.|v)\b', re.IGNORECASE)

WORD_CLEAN = re.compile(r'[^a-z0-9]+')
TAG_SUFFIX = re.compile(r'\[[^\]]+\]\s*$')

def now_utc():
    return datetime.datetime.now(datetime.timezone.utc)

def parse_iso(dt: str):
    try:
        if dt.endswith('Z'): dt = dt[:-1] + '+00:00'
        return datetime.datetime.fromisoformat(dt)
    except Exception:
        return None

def norm_team(name: str) -> str:
    n = name.lower().strip()
    n = WORD_CLEAN.sub(' ', n)
    # remove common prefixes / noise tokens and trailing foundation years
    noise = {
        'fc','ssd','asd','usd','calcio','club','a','ac','ss','af','afc','as',
        'a.c','a.c.','s.s','s.s.','a.f','a.f.','a.f.c','a.f.c.','a.s','a.s.'
    }
    toks = [t for t in n.split() if t and t not in noise]
    # drop tokens that are pure years (1850-2099)
    cleaned: list[str] = []
    for t in toks:
        if re.fullmatch(r'(18[5-9]\d|19\d{2}|20\d{2})', t):
            continue
        cleaned.append(t)
    toks = cleaned
    if not toks:
        return ''
    # synonyms mapping (Serie A/B/C + comuni)
    synonyms = {
        'internazionale': 'inter', 'inter': 'inter',
        'juventus': 'juve', 'juve': 'juve',
        'atalanta': 'atalanta', 'fiorentina': 'fiorentina', 'sassuolo': 'sassuolo', 'udinese': 'udinese',
        'bologna': 'bologna', 'cagliari': 'cagliari', 'empoli': 'empoli', 'lecce': 'lecce', 'torino': 'torino',
        'verona': 'verona', 'hellas': 'verona', 'napoli': 'napoli', 'roma': 'roma', 'lazio': 'lazio',
        'milan': 'milan', 'reggiana': 'reggiana', 'catanzaro': 'catanzaro', 'palermo': 'palermo', 'cesena': 'cesena',
        'monza': 'monza', 'como': 'como', 'pisa': 'pisa', 'parma': 'parma', 'brescia': 'brescia', 'spezia': 'spezia',
        'virtus': 'virtus', 'entella': 'entella'
    }
    tokset = set(toks)
    # Special composite cases first
    if {'inter','milan'} <= tokset:
        return 'inter'  # "Inter Milan" deve combaciare con "Inter" / "Internazionale"
    # Try priority order: if any token maps directly choose earliest meaningful
    for t in toks:
        if t in synonyms:
            return synonyms[t]
    # fallback to last token
    base = toks[-1]
    return synonyms.get(base, base)

def _all_team_tokens(raw: str) -> set[str]:
    if not raw:
        return set()
    raw = raw.lower()
    raw = WORD_CLEAN.sub(' ', raw)
    toks = {t for t in raw.split() if len(t) > 2}
    return toks

def extract_teams(title: str) -> Tuple[str|None,str|None]:
    """Robustly extract the two team names from a title string.

    Strategy:
      1. Strip trailing bracket tags (variant / lang markers).
      2. Locate the LAST occurrence of the vs separator (v / vs / vs.). We do this
         with finditer so we can get real span boundaries instead of relying on
         split() captured groups which previously led to 'vs' being mistaken as
         a team token.
      3. Left team = substring before separator, Right team = substring after.
      4. Trim league / competition fragments separated by ' - ' (keep the last
         segment on the left side and the first on the right side) because many
         titles are like "Serie A - Udinese vs Milan - Round 3".
      5. Strip leading emoji / punctuation / time prefixes (e.g. "⏰ 20:45 :").
    """
    core = TAG_SUFFIX.sub('', title).strip()
    matches = list(MATCH_SPLIT.finditer(core))
    if not matches:
        return None, None
    m = matches[-1]
    left = core[:m.start()].strip()
    right = core[m.end():].strip()
    # Reduce league prefix fragments
    if ' - ' in left:
        left = left.split(' - ')[-1].strip()
    if ' - ' in right:
        right = right.split(' - ')[0].strip()
    # Remove leading non-alnum / emoji
    left = re.sub(r'^[^A-Za-z0-9]+', '', left).strip()
    right = re.sub(r'^[^A-Za-z0-9]+', '', right).strip()
    # Basic sanity: require at least one letter in each side
    if not re.search(r'[A-Za-z]', left) or not re.search(r'[A-Za-z]', right):
        return None, None
    return left or None, right or None

def status_symbol(now: datetime.datetime, start: datetime.datetime) -> str:
    if now < start - datetime.timedelta(minutes=STATUS_THRESHOLD_MIN):
        return '🚫'
    return '🔴'

def build_prefix(now: datetime.datetime, start: datetime.datetime, italian: bool) -> str:
    base = PREFIX_BASE_ITA if italian else PREFIX_BASE_FALLBACK
    return f"{base} {SOCCER_EMOJI} {status_symbol(now, start)}"

def is_single_entity(title: str) -> bool:
    t = title.lower()
    return any(kw in t for kw in SINGLE_KEYWORDS)

def _dns_log(host: str):
    try:
        ips = socket.gethostbyname_ex(host)[2]
        print(f"[RBTV][DNS] {host} -> {','.join(ips)}")
    except Exception as e:
        print(f"[RBTV][DNS][ERR] {host} {e}")

def _build_request(url: str) -> urllib.request.Request:
    # Header model mutuato da streamed_channels.py per mitigare blocchi
    ua = os.environ.get('RBTV_UA') or os.environ.get('STREAMED_UA') or 'Mozilla/5.0 (compatible; RBTVFetcher/1.0)'
    referer = os.environ.get('RBTV_REFERER') or os.environ.get('STREAMED_REFERER') or 'https://embedsports.top/'
    headers = {
        'User-Agent': ua,
        'Referer': referer,
        'Accept': '*/*',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache'
    }
    extra = os.environ.get('RBTV_PLAYLIST_HEADERS')  # formato Key:Value;Key2:Value2
    if extra:
        for pair in re.split(r'[;\n]+', extra):
            if not pair.strip():
                continue
            if ':' in pair:
                k, v = pair.split(':', 1)
                headers[k.strip()] = v.strip()
    return urllib.request.Request(url, headers=headers, method='GET')

def _download_playlist(url: str) -> str | None:
    attempts = max(1, RAW_ATTEMPTS)
    timeout = max(2.0, RAW_TIMEOUT)
    last_err: Exception | None = None
    for i in range(1, attempts + 1):
        try:
            start_ts = time.time()
            req = _build_request(url)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw_bytes = r.read()
            dur_ms = int((time.time() - start_ts) * 1000)
            raw = raw_bytes.decode('utf-8', 'replace')
            if LOG_FETCH_DEBUG:
                print(f"[RBTV][FETCH][DBG] attempt={i} status=OK ms={dur_ms} bytes={len(raw_bytes)} has_extm3u={('#EXTM3U' in raw)}")
            if raw and '#EXTM3U' in raw:
                return raw
        except Exception as e:
            last_err = e
            print(f"[RBTV][FETCH][WARN] attempt={i}/{attempts} err={e}")
            if i < attempts:
                time.sleep(min(2.5, i))
    # fallback: prova requests se disponibile (solo se non FAST_FORCE o se esplicitamente abilitato)
    if not FAST_FORCE:
        try:
            import requests  # type: ignore
            req_headers = {
                'User-Agent': os.environ.get('RBTV_UA','Mozilla/5.0'),
                'Referer': os.environ.get('RBTV_REFERER','https://embedsports.top/'),
                'Accept': '*/*',
                'Accept-Language': 'it-IT,it;q=0.9,en;q=0.8',
                'Connection': 'keep-alive'
            }
            rstart = time.time()
            resp = requests.get(url, headers=req_headers, timeout=timeout)
            dur_ms = int((time.time()-rstart)*1000)
            if LOG_FETCH_DEBUG:
                print(f"[RBTV][FETCH][REQ] code={resp.status_code} ms={dur_ms} bytes={len(resp.text)}")
            if resp.ok and '#EXTM3U' in resp.text:
                return resp.text
        except Exception as e:
            print(f"[RBTV][FETCH][FALLBACK][ERR] {e}")
    if last_err:
        print(f"[RBTV][FETCH][ERR] giving up: {last_err}")
    # Final fallback: try invoking curl if present (curl spesso bypassa problemi SSL in container)
    try:
        import subprocess, shlex
        curl_timeout = int(min(25, timeout + 10))
        cmd = os.environ.get('RBTV_CURL_CMD', f"curl -L --max-time {curl_timeout} -A 'Mozilla/5.0 (RBTVCurl)' -H 'Referer: https://embedsports.top/' --fail --silent --show-error {shlex.quote(url)}")
        start_ts = time.time()
        r = subprocess.run(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=curl_timeout+5)
        if r.returncode == 0:
            txt = r.stdout.decode('utf-8','replace')
            if '#EXTM3U' in txt:
                dur = int((time.time()-start_ts)*1000)
                print(f"[RBTV][FETCH][CURL][OK] ms={dur} bytes={len(txt)}")
                return txt
            else:
                print(f"[RBTV][FETCH][CURL][WARN] no #EXTM3U rc=0 bytes={len(txt)}")
        else:
            print(f"[RBTV][FETCH][CURL][ERR] rc={r.returncode} stderr={r.stderr.decode('utf-8','replace')[:180]}")
    except Exception as e2:
        print(f"[RBTV][FETCH][CURL][EXC] {e2}")
    return None

def _is_italian(title: str) -> bool:
    tl = title.lower()
    # Accept ANY variant (HDD *, SD, VDO, MOVISTAR ecc.) ONLY if at least one bracket tag contains an Italian token
    bracket_tags = re.findall(r'\[[^\]]+\]', title)
    if not bracket_tags:
        # Possibile modalità lenient se non ci sono tag ma testo contiene parola piena 'italian' / 'italiano'
        if LENIENT_TEXT_ITALIAN and re.search(r'\bitalian(?:o|a)?\b', tl) and 'digital' not in tl:
            return True
        return False
    tag_join = ' '.join(bracket_tags).lower()
    if not re.search(r'\b(ita|italy|italia|italiano|ital)\b', tag_join):
        # Se non c'è il token italiano nei tag, in modalità lenient accettiamo se nel testo principale compare 'Italian Serie'
        if LENIENT_TEXT_ITALIAN:
            core_no_tags = TAG_SUFFIX.sub('', tl)
            if re.search(r'\bitalian\b.*\bserie\b', core_no_tags) and 'digital' not in core_no_tags:
                return True
        return False
    # Fast negative filter first
    if EXCLUDE_REGEX and EXCLUDE_REGEX.search(tl):
        return False
    if not INCLUDE_REGEX:
        return False
    if not INCLUDE_REGEX.search(tl):
        return False
    if STRICT_MODE:
        # In strict mode require a stronger signal: either bracket [ITA] or full words italy/italia/italiano
        if not re.search(r'(\[\s*ita\s*\]|\bital(?:y|ia|iano)\b)', tl, re.IGNORECASE):
            return False
    # Avoid accidental match inside 'digital'
    if re.search(r'digital', tl) and not re.search(r'\bital(?:y|ia|iano)\b', tl):
        return False
    return True

def fetch_playlist() -> List[Dict[str,Any]]:
    # DNS diag
    try:
        host = urllib.request.urlparse(PLAYLIST_URL).hostname
        if host:
            _dns_log(host)
    except Exception:
        pass
    raw = _download_playlist(PLAYLIST_URL)
    if raw is None and FALLBACK_URL and FALLBACK_URL != PLAYLIST_URL:
        print('[RBTV][FETCH] trying fallback URL')
        try:
            host2 = urllib.request.urlparse(FALLBACK_URL).hostname
            if host2:
                _dns_log(host2)
        except Exception:
            pass
        raw = _download_playlist(FALLBACK_URL)
    if not raw:
        if LOG_FETCH_DEBUG:
            print('[RBTV][FETCH][EMPTY] playlist download failed (raw is None)')
        return []
    lines = [l.strip() for l in raw.splitlines() if l.strip()]
    out: List[Dict[str,Any]] = []
    i = 0
    italian_count = 0
    while i < len(lines):
        if lines[i].startswith('#EXTINF'):
            title = lines[i].split(',', 1)[-1].strip()
            url = None
            if i + 1 < len(lines) and lines[i + 1].startswith('http'):
                url = lines[i + 1].strip()
                i += 1
            if url:
                out.append({'title': title, 'url': url})
                if _is_italian(title):
                    italian_count += 1
        i += 1
    if LOG_FETCH_DEBUG:
        print(f"[RBTV][FETCH][PARSE] total_lines={len(lines)} entries={len(out)} italian_tagged={italian_count}")
        if italian_count == 0:
            print('[RBTV][FETCH][NO_MATCH] Nessun titolo con tag italiano trovato (STRICT_MODE=' + ('1' if STRICT_MODE else '0') + ') -- fallback pronto se categoria target')
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
        tmp = DYNAMIC_FILE + '.rbtv.tmp'
        with open(tmp,'w',encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp,DYNAMIC_FILE)
    except Exception as e:
        print(f"[RBTV][ERR] write dynamic: {e}")

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
        print(f"[RBTV][PERSIST][ERR] {e}")

def enrich():
    dyn = load_dynamic()
    if not dyn:
        return
    now = now_utc()
    playlist = fetch_playlist()
    if not playlist:
        if LOG_FETCH_DEBUG:
            print('[RBTV][ABORT] Nessuna entry utilizzabile (playlist vuota o nessun match lingua)')
        return
    # Optional variant limiting: we may have multiple variants (HDD A, HDD B, SD, VDO)
    max_variants_env = os.environ.get('RBTV_MAX_VARIANTS')
    try:
        max_variants = int(max_variants_env) if max_variants_env else 0
    except ValueError:
        max_variants = 0
    if max_variants > 0:
        # Group by a normalized base name without variant tokens
        variant_pattern = re.compile(r'\b(HDD\s*[AB]|SD|VDO)\b', re.IGNORECASE)
        groups: Dict[str, list] = {}
        for item in playlist:
            base = variant_pattern.sub('', item['title'])
            base_key = re.sub(r'\s+', ' ', base.lower()).strip()
            groups.setdefault(base_key, []).append(item)
        ranked: List[Dict[str,Any]] = []
        def score(title: str) -> int:
            tl = title.lower()
            # Higher is better
            if 'hdd b' in tl: return 400
            if 'hdd a' in tl: return 300
            if 'vdo' in tl: return 200
            if 'sd' in tl: return 100
            return 10
        for base_key, items in groups.items():
            items.sort(key=lambda x: score(x['title']), reverse=True)
            ranked.extend(items[:max_variants])
        playlist = ranked
    persist = load_persist()
    persist_changed = False
    changed = False
    added_total = 0

    for ev in dyn:
        try:
            ev_start_iso = ev.get('eventStart')
            dt = parse_iso(ev_start_iso) if isinstance(ev_start_iso,str) else None
            if not dt:
                continue
            if not FORCE_MODE:
                if now < dt - datetime.timedelta(minutes=BEFORE_MIN):
                    continue
                within = now <= dt + datetime.timedelta(minutes=AFTER_MIN)
            else:
                within = True
            name = ev.get('name','')
            ev_streams = ev.get('streams') or []
            existing_urls = {s.get('url') for s in ev_streams if isinstance(s, dict)}
            existing_titles = {s.get('title') for s in ev_streams if isinstance(s, dict)}

            # fuori discovery: solo restore se necessario
            if not within and not FORCE_MODE:
                # Update symbol on existing RB77 streams if present
                # update only RB prefixes (both ita + fallback)
                sym_pref_ita = build_prefix(now, dt, True)
                sym_pref_fallback = build_prefix(now, dt, False)
                updated_any = False
                for s in ev_streams:
                    if isinstance(s, dict):
                        tt = s.get('title','')
                        if tt.startswith(PREFIX_BASE_ITA) or tt.startswith(PREFIX_BASE_FALLBACK):
                            # Replace dynamic symbol part
                            is_ita = tt.startswith(PREFIX_BASE_ITA)
                            new_head = sym_pref_ita if is_ita else sym_pref_fallback
                            # Remove existing head token up to first space after emoji if present
                            rest = tt
                            if is_ita:
                                rest_part = tt[len(PREFIX_BASE_ITA):]
                            else:
                                rest_part = tt[len(PREFIX_BASE_FALLBACK):]
                            # rimuovi eventuale simbolo precedente + testo evento: manteniamo solo ultima variante tra []
                            variant_tags = re.findall(r'\[[^\]]+\]', rest_part)
                            variant = variant_tags[-1] if variant_tags else rest_part
                            new_title = f"{new_head} {variant}".strip()
                            if new_title != tt:
                                s['title'] = new_title
                                updated_any = True
                if updated_any:
                    ev['streams'] = ev_streams
                    changed = True
                if any(str(t).startswith(PREFIX_BASE_ITA) or str(t).startswith(PREFIX_BASE_FALLBACK) for t in existing_titles):
                    continue
                ev_id = str(ev.get('id'))
                stored = persist.get(ev_id,{}).get('streams') if ev_id in persist else None
                if stored:
                    # New ordering specification:
                    # 1. Cluster prioritario = Vavoo (+MFP), [P🐽D], 🇮🇹 channels (flag) nell'ordine in cui compaiono a testa
                    # 2. RB77 sempre subito dopo il cluster
                    # 3. Se esistono già [Strd], questi devono restare DOPO RB77 (quindi inseriamo prima del primo [Strd])
                    def _is_vavoo(st):
                        if not isinstance(st, dict): return False
                        t = str(st.get('title',''))
                        u = str(st.get('url',''))
                        return u.startswith('vavoo://') or t.startswith('[🏠]')
                    def _is_pd(st):
                        return isinstance(st, dict) and str(st.get('title','')).startswith('[P🐽D]')
                    def _is_italian_flag(st):
                        return isinstance(st, dict) and ('🇮🇹' in str(st.get('title','')))
                    def _is_strd(st):
                        return isinstance(st, dict) and str(st.get('title','')).startswith('[Strd]')
                    # calcola fine cluster
                    cluster_end = 0
                    for idx,s in enumerate(ev_streams):
                        if _is_vavoo(s) or _is_pd(s) or _is_italian_flag(s):
                            cluster_end = idx + 1
                        else:
                            break
                    # primo Strd dopo cluster (se presente) – RB77 deve stare prima
                    first_strd = None
                    for idx in range(cluster_end, len(ev_streams)):
                        if _is_strd(ev_streams[idx]):
                            first_strd = idx
                            break
                    # Se Strd esiste ma (per errore) compare prima del cluster_end, lo ignoriamo (verrà riordinato altrove)
                    insert_idx = first_strd if first_strd is not None else cluster_end
                    # Se cluster vuoto e nessun Strd: RB77 in testa (insert_idx=0 già ok)
                    restored = 0
                    for rs in stored:
                        u = rs.get('url'); tt = rs.get('title')
                        if u in existing_urls or tt in existing_titles:
                            continue
                        # Update symbol on restore
                        if isinstance(rs, dict):
                            rs_title = rs.get('title','')
                            head = build_prefix(now, dt, True if rs.get('title','').startswith(PREFIX_BASE_ITA) else False)
                            # Remove any old base prefix occurrences
                            rs_core = re.sub(r'^\[RB77(?:🇮🇹)?\][^ ]*\s*', '', rs_title)
                            rs['title'] = f"{head} {rs_core}".strip()
                        ev_streams.insert(insert_idx, rs)
                        insert_idx += 1
                        existing_urls.add(u); existing_titles.add(tt)
                        restored += 1
                    if restored:
                        ev['streams'] = ev_streams
                        changed = True
                        print(f"[RBTV][RESTORE] event={ev.get('id')} restored={restored}")
                continue

            # Discovery path
            t1,t2 = None,None
            t1,t2 = extract_teams(name)
            single_mode = False
            if not t1 or not t2:
                # try second pattern: after first ' - '
                t1,t2 = extract_teams(name)
                if not t1 or not t2:
                    if is_single_entity(name):
                        single_mode = True
                    else:
                        continue
            added_this = 0
            # Pre-normalize event teams for faster comparison
            ev_norm_set = {norm_team(t1), norm_team(t2)} if not single_mode and t1 and t2 else set()
            debug_match = (os.environ.get('RBTV_DEBUG_MATCH') or '').lower() in {'1','true','yes','on'}
            fuzzy_ratio_env = os.environ.get('RBTV_FUZZY_RATIO') or '0.75'
            try:
                fuzzy_thresh = float(fuzzy_ratio_env)
            except ValueError:
                fuzzy_thresh = 0.7
            if fuzzy_thresh < 0.5:  # clamp sane bounds
                fuzzy_thresh = 0.5
            if fuzzy_thresh > 0.95:
                fuzzy_thresh = 0.95
            try:
                from difflib import SequenceMatcher
            except Exception:
                SequenceMatcher = None  # type: ignore
            summary_enabled = (os.environ.get('RBTV_DEBUG_SUMMARY') or '').lower() in {'1','true','yes','on'}
            allow_partial = (os.environ.get('RBTV_ALLOW_PARTIAL') or '').lower() in {'1','true','yes','on'}
            stat_counts = {'exact':0,'partial':0,'single_side':0,'fuzzy':0}
            italian_candidates = []
            fallback_candidates = []  # all matching (non-italian) for potential fallback
            # esteso 'volley' oltre 'volleyball'
            target_cats = {'seriea','serieb','seriec','tennis','f1','motogp','volleyball','volley'}
            event_cat = (ev.get('category') or '').lower()
            for pl in playlist:
                pt1,pt2 = extract_teams(pl['title'])
                good = False
                reason = ''
                if single_mode:
                    if is_single_entity(pl['title']):
                        good = True
                    else:
                        reason = 'single_mode_mismatch'
                else:
                    if pt1 and pt2:
                        pl_norm_set = {norm_team(pt1), norm_team(pt2)}
                        if pl_norm_set == ev_norm_set:
                            good = True
                            reason = 'exact'
                        elif allow_partial and (ev_norm_set & pl_norm_set):
                            good = True
                            reason = 'partial'
                        else:
                            reason = f'set_mismatch ev={ev_norm_set} pl={pl_norm_set}'
                    else:
                        # Only one side parsed: accept ONLY if partial allowed, else skip
                        single_pl_team = norm_team(pt1 or pt2 or '')
                        if allow_partial and single_pl_team and single_pl_team in ev_norm_set:
                            good = True
                            reason = 'single_side'
                        else:
                            reason = f'single_parsed_no_match={single_pl_team}'
                # Fuzzy fallback (per-team) if still not good and we have two teams both sides
                if not good and not single_mode and SequenceMatcher and pt1 and pt2 and t1 and t2:
                    def sim(a: str, b: str) -> float:
                        return SequenceMatcher(None, norm_team(a), norm_team(b)).ratio()
                    # compute best pairing similarity (ev teams vs pl teams in both assignments)
                    cand1_a = sim(t1, pt1); cand1_b = sim(t2, pt2)
                    cand2_a = sim(t1, pt2); cand2_b = sim(t2, pt1)
                    cand1 = (cand1_a + cand1_b) / 2.0
                    cand2 = (cand2_a + cand2_b) / 2.0
                    best = cand1; pair = 'cand1'; a1=cand1_a; b1=cand1_b
                    if cand2 > cand1:
                        best = cand2; pair='cand2'; a1=cand2_a; b1=cand2_b
                    per_team_min = max(0.55, fuzzy_thresh - 0.2)
                    if best >= fuzzy_thresh and a1 >= per_team_min and b1 >= per_team_min:
                        good = True
                        reason = f'fuzzy_pair_ok pair={pair} avg={best:.2f} a={a1:.2f} b={b1:.2f} thr={fuzzy_thresh:.2f} min={per_team_min:.2f}'
                if not good:
                    if debug_match:
                        print(f"[RBTV][DEBUG][SKIP] title='{pl['title']}' reason={reason}")
                    continue
                # classified as matching candidate
                is_italian_pl = _is_italian(pl['title'])
                if is_italian_pl:
                    italian_candidates.append(pl)
                else:
                    fallback_candidates.append(pl)
                if summary_enabled:
                    if reason == 'exact': stat_counts['exact'] += 1
                    elif reason == 'partial': stat_counts['partial'] += 1
                    elif reason == 'single_side': stat_counts['single_side'] += 1
                    elif reason.startswith('fuzzy_pair_ok'): stat_counts['fuzzy'] += 1
            # Decide which list to use
            chosen_list = []
            italian_mode = False
            if italian_candidates:
                chosen_list = italian_candidates
                italian_mode = True
            elif event_cat in target_cats and fallback_candidates:
                # fallback: use all non-italian variants except clearly low quality (SD/LOW)
                filtered = [pl for pl in fallback_candidates if not re.search(r'\b(SD|LOW)\b', pl['title'], re.IGNORECASE)]
                if not filtered and FALLBACK_ALLOW_SD:
                    # Se l'unica variante è SD o LOW e l'utente ha abilitato l'override, usala
                    filtered = fallback_candidates
                    if LOG_FETCH_DEBUG:
                        print(f"[RBTV][FALLBACK][ALLOW_SD] event={ev.get('id')} cat={event_cat} includo variante SD/LOW per mancanza di alternative")
                chosen_list = filtered
                italian_mode = False
                if LOG_FETCH_DEBUG:
                    print(f"[RBTV][FALLBACK] event={ev.get('id')} cat={event_cat} no_italian_variants using_non_sd count={len(chosen_list)} total_non_it={len(fallback_candidates)}")
            else:
                chosen_list = italian_candidates  # empty or non-target category: only italians (possibly none)
            for pl in chosen_list:
                final_url = pl['url']
                display_title = pl['title']
                prefix = build_prefix(now, dt, italian_mode)
                # Estrarre solo variante finale (es: [HDD A], [SD], [VDO])
                variant_tags = re.findall(r'\[[^\]]+\]', display_title)
                variant = variant_tags[-1] if variant_tags else display_title
                new_title = f"{prefix} {variant}".strip()
                if final_url in existing_urls or new_title in existing_titles:
                    continue
                # Nuovo calcolo indice inserimento RB77 (vedi specifica sopra)
                def _is_vavoo(st):
                    if not isinstance(st, dict): return False
                    t = str(st.get('title',''))
                    u = str(st.get('url',''))
                    return u.startswith('vavoo://') or t.startswith('[🏠]')
                def _is_pd(st):
                    return isinstance(st, dict) and str(st.get('title','')).startswith('[P🐽D]')
                def _is_italian_flag(st):
                    return isinstance(st, dict) and ('🇮🇹' in str(st.get('title','')))
                def _is_strd(st):
                    return isinstance(st, dict) and str(st.get('title','')).startswith('[Strd]')
                cluster_end = 0
                for idx,s in enumerate(ev_streams):
                    if _is_vavoo(s) or _is_pd(s) or _is_italian_flag(s):
                        cluster_end = idx + 1
                    else:
                        break
                first_strd = None
                for idx in range(cluster_end, len(ev_streams)):
                    if _is_strd(ev_streams[idx]):
                        first_strd = idx
                        break
                insert_idx = first_strd if first_strd is not None else cluster_end
                ev_streams.insert(insert_idx, {'url': final_url, 'title': new_title})
                existing_urls.add(final_url); existing_titles.add(new_title)
                added_this += 1
            if summary_enabled and (added_this or any(stat_counts.values())):
                print(f"[RBTV][SUMMARY] event={ev.get('id')} added={added_this} ita_mode={italian_mode} counts={stat_counts} fuzzy_thr={fuzzy_thresh}")
            if added_this:
                ev['streams'] = ev_streams
                # persist only RB entries
                ev_id = str(ev.get('id'))
                stored_rb = [s for s in ev_streams if isinstance(s,dict) and (str(s.get('title','')).startswith(PREFIX_BASE_ITA) or str(s.get('title','')).startswith(PREFIX_BASE_FALLBACK))]
                persist[ev_id] = {'ts': int(time.time()), 'streams': stored_rb}
                persist_changed = True
                added_total += added_this
                print(f"[RBTV][INJECT]{'[FORCE]' if FORCE_MODE else ''} event={ev.get('id')} added={added_this} mode={'SINGLE' if single_mode else 'DUO'} ita_mode={italian_mode}")
        except Exception as e:
            print(f"[RBTV][ERR] event loop: {e}")
            continue

    if persist_changed:
        save_persist(persist)
    if changed or added_total:
        save_dynamic(dyn)
        print(f"[RBTV][DONE] total_added={added_total}")

if __name__ == '__main__':
    try:
        enrich()
    except Exception as e:
        print(f"[RBTV][FATAL] {e}")
        sys.exit(0)
