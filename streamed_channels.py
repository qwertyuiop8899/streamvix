#!/usr/bin/env python3
"""streamed_channels.py

Periodic enrichment of dynamic_channels.json with additional streams from a remote
M3U playlist (world-proxifier/streamed source).

Environment variables:
    STREAMED_PLAYLIST_URL            (default: https://world-proxifier.xyz/streamed/playlist.m3u8)
    STREAMED_CACHE_TTL_SEC           (default: 60) cache raw playlist to avoid hammering
    STREAMED_PRE_START_WINDOW_MIN    (default: 15) legacy name (alias) for STREAMED_DISCOVERY_BEFORE_MIN
    STREAMED_POST_START_FETCH_WINDOW_MIN (default: 10) legacy name (alias) for STREAMED_DISCOVERY_AFTER_MIN
    STREAMED_DISCOVERY_BEFORE_MIN    (optional) minutes before start to begin discovery (overrides legacy if set)
    STREAMED_DISCOVERY_AFTER_MIN     (optional) minutes after start to continue discovering NEW streams
    DYNAMIC_FILE                     path override (must match addon usage if set)

Behavior change:
    - Persistenza: gli stream [Strd] rimangono per tutta la durata in cui l'evento esiste nel dynamic file.
    - Fuori dalla finestra di discovery (dopo start + AFTER_MIN) NON cerchiamo nuovi stream, ma se il file
        dynamic è stato rigenerato e gli [Strd] sono spariti, li re-iniettiamo da un archivio di persistenza.
    - Persistenza salvata in /tmp/streamed_streams_persist.json

Streams added have title: "[Strd] <OriginalTitle>" where <OriginalTitle> is the #EXTINF title (after comma).
Order policy: we append at the tail (addon already ensures PD & Vavoo ordering first).

Idempotent: avoids duplicate by URL or by identical title.

Exit codes: always 0 (non-fatal) to avoid crashing parent supervisor.

Ordering override (custom request):
    Gli stream [Strd] NON vanno più in coda; vanno inseriti subito dopo:
        1. Eventuali stream [P🐽D] di testa
        2. La prima sequenza contigua di stream con bandiera italiana ("🇮🇹")
    In questo modo restano prima le sorgenti prioritarie / italiane e gli [Strd] seguono immediatamente.
Header propagation: attivata di default sempre (non serve più STREAMED_PROPAGATE_HEADERS=1) se la playlist fornisce #EXTVLCOPT.
"""
from __future__ import annotations
import os, re, json, time, hashlib, pathlib, sys, datetime, urllib.request, socket
from typing import List, Dict, Any, Tuple

PLAYLIST_URL = os.environ.get('STREAMED_PLAYLIST_URL','https://world-proxifier.xyz/streamed/playlist.m3u8')
CACHE_TTL = int(os.environ.get('STREAMED_CACHE_TTL_SEC','60'))
_legacy_before = os.environ.get('STREAMED_PRE_START_WINDOW_MIN')
_legacy_after = os.environ.get('STREAMED_POST_START_FETCH_WINDOW_MIN')
DISCOVERY_BEFORE_MIN = int(os.environ.get('STREAMED_DISCOVERY_BEFORE_MIN', _legacy_before or '15'))
DISCOVERY_AFTER_MIN  = int(os.environ.get('STREAMED_DISCOVERY_AFTER_MIN',  _legacy_after or '10'))
PERSIST_FILE = '/tmp/streamed_streams_persist.json'
D_MIN_KEY_HITS = int(os.environ.get('STREAMED_MIN_KEYWORD_HITS', '2'))
# Header propagation now always on (legacy env kept for backward compat if someone wants to disable explicitly with 0)
_legacy_flag = (os.environ.get('STREAMED_PROPAGATE_HEADERS') or '1').lower() in {'1','true','yes','on'}
D_PROPAGATE = True if _legacy_flag else False
HEADER_MODE = (os.environ.get('STREAMED_HEADER_MODE') or 'url_params').lower()
HEADER_PARAM_PREFIX = os.environ.get('STREAMED_HEADER_PARAM_PREFIX','h_')
DYNAMIC_FILE = os.environ.get('DYNAMIC_FILE') or '/tmp/dynamic_channels.json'
CACHE_FILE = '/tmp/streamed_playlist_cache.json'

# Force mode: ignore all timing windows, attempt to inject matches for ANY event
FORCE_MODE = False
_force_env = (os.environ.get('STREAMED_FORCE') or '').strip().lower()
if _force_env in {'1','true','on','yes','force'}:
    FORCE_MODE = True
if any(a in ('--force','-f') for a in sys.argv[1:]):
    FORCE_MODE = True

HDR_STREAMED_PREFIX = '[Strd] '
STATUS_AHEAD = '🚫'  # >10m before start
STATUS_LIVE = '🔴'    # within 10m before or after start

# Backward compatibility: earlier injected prefix
LEGACY_PREFIX = '[Streamed] '

TEAM_PREFIXES_REGEX = re.compile(r'^(?:A\.S\.|AS|A\.C\.|AC|SSC|S\.S\.C\.|SS|U\.S\.|US|U\.C\.|UC|F\.C\.|FC|S\.S\.D\.|SSD|A\.S\.D\.|ASD|U\.S\.D\.|USD|Virtus)\s+', re.IGNORECASE)
TEAM_CLEAN_WORDS = {"calcio"}
TEAM_SPECIAL = {
    'internazionale': 'inter','inter': 'inter','juventus': 'juventus','as roma': 'roma','a.s. roma': 'roma','roma': 'roma',
    'ssc napoli': 'napoli','s.s.c. napoli': 'napoli','napoli': 'napoli','ss lazio': 'lazio',
    'ac milan':'milan','a.c. milan':'milan','milan':'milan','atalanta bc':'atalanta','atalanta':'atalanta',
    'hellas verona':'verona','verona':'verona','udinese calcio':'udinese','udinese':'udinese','genoa cfc':'genoa','genoa':'genoa',
    'cagliari calcio':'cagliari','cagliari':'cagliari','fiorentina':'fiorentina','bologna fc':'bologna','bologna':'bologna','lecce':'lecce','empoli':'empoli',
    'monza':'monza','sassuolo':'sassuolo','salernitana':'salernitana','torino':'torino','sampdoria':'sampdoria','parma':'parma','venezia':'venezia','cremonese':'cremonese',
    'palermo':'palermo','bari':'bari','como':'como','cosenza':'cosenza'
}

MATCH_SPLIT = re.compile(r'\bvs\b', re.IGNORECASE)

def now_utc() -> datetime.datetime:
    # Use timezone aware API (avoid deprecated utcnow())
    return datetime.datetime.now(datetime.timezone.utc)

def parse_iso(dt: str) -> datetime.datetime | None:
    try:
        if dt.endswith('Z'): dt = dt[:-1] + '+00:00'
        return datetime.datetime.fromisoformat(dt)
    except Exception:
        return None

def strip_prefixes(team: str) -> str:
    team = TEAM_PREFIXES_REGEX.sub('', team.strip())
    words = [w for w in re.split(r'\s+', team) if w.lower() not in TEAM_CLEAN_WORDS]
    return ' '.join(words).strip()

def normalize_team(team: str) -> str:
    base = strip_prefixes(team)
    k = base.lower()
    if k in TEAM_SPECIAL:
        return TEAM_SPECIAL[k]
    # fallback last token
    toks = [t for t in re.split(r'\s+', k) if t]
    if toks:
        return toks[-1]
    return k

def extract_match_teams_from_event_name(event_name: str) -> Tuple[str|None,str|None]:
    # pattern: "⏰ HH:MM : <Match> - <League> dd/mm"
    # Remove leading clock
    try:
        part = event_name
        if ' : ' in part:
            part = part.split(' : ',1)[1]
        # split at first ' - '
        if ' - ' in part:
            part = part.split(' - ',1)[0]
        # now should contain "Team1 vs Team2" maybe
        seg = part.strip()
        pts = MATCH_SPLIT.split(seg)
        if len(pts) >= 2:
            return pts[0].strip(), pts[1].strip()
    except Exception:
        pass
    return None, None

# Single entity / tournament style keywords (F1, MotoGP, Tennis, generic cups)
SINGLE_ENTITY_KEYWORDS = [
    'grand prix','gp','formula 1','f1','motogp','qualifying','practice','free practice','fp1','fp2','fp3','sprint',
    'roland garros','wimbledon','us open','australian open','atp','wta','masters','final','finale','semifinal','quarterfinal',
    'cup','supercoppa','super cup','champions league','europa league','conference league','friendly','amichevole'
]

def is_single_entity_event(name: str) -> bool:
    n = _norm_text(name)
    hits = sum(1 for kw in SINGLE_ENTITY_KEYWORDS if kw in n)
    return hits >= 1

def single_entity_match(entry_title: str, event_name: str, min_hits: int, debug: bool) -> bool:
    # Build keyword bag from event name (excluding time and vs part)
    en = _norm_text(event_name)
    # Remove clock prefix
    if ' : ' in event_name:
        en2 = event_name.split(' : ',1)[1]
    else:
        en2 = event_name
    # cut after dash league if present
    if ' - ' in en2:
        en2 = en2.split(' - ',1)[0]
    en2n = _norm_text(en2)
    # Tokenize keywords > 2 chars
    ev_tokens = [t for t in en2n.split() if len(t) > 2 and t not in {'vs','the'}]
    ev_tokens = list(dict.fromkeys(ev_tokens))  # uniqueness preserving order
    if not ev_tokens:
        return False
    title_norm = _norm_text(entry_title)
    hits = 0
    for tok in ev_tokens:
        if tok in title_norm:
            hits += 1
    if hits >= max(1, min_hits):
        if debug:
            print(f"[STREAMED][MATCH][FUZZ][SINGLE] hits={hits} title='{entry_title}' event='{event_name}' tokens={ev_tokens[:8]}")
        return True
    return False

def parse_playlist(raw: str) -> List[Dict[str,Any]]:
    lines = [l.rstrip() for l in raw.splitlines() if l.strip()]
    out: List[Dict[str,Any]] = []
    i=0
    while i < len(lines):
        line = lines[i]
        if line.startswith('#EXTINF'):
            title = line.split(',',1)[-1].strip()
            headers: Dict[str,str] = {}
            j = i+1
            while j < len(lines) and lines[j].startswith('#EXTVLCOPT:'):
                m = re.match(r'#EXTVLCOPT:http-([^=]+)=(.*)', lines[j])
                if m:
                    k = m.group(1).strip()
                    v = m.group(2).strip()
                    canon = {
                        'origin':'Origin','referrer':'Referer','referer':'Referer','user-agent':'User-Agent'
                    }.get(k.lower(), k)
                    headers[canon] = v
                j += 1
            url = None
            if j < len(lines) and lines[j].startswith('http'):
                url = lines[j].strip()
                i = j + 1
            else:
                i = j
            if url:
                entry: Dict[str,Any] = {'title': title, 'url': url}
                if headers:
                    entry['headers'] = headers
                out.append(entry)
            continue
        i += 1
    return out

def _build_request(url: str) -> urllib.request.Request:
    # Emulate a modern browser (user may have origin restrictions)
    headers = {
        'User-Agent': os.environ.get('STREAMED_UA', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'),
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Connection': 'close',
        # Some origins expect same site ref
        'Referer': os.environ.get('STREAMED_REFERER', 'https://embedsports.top/'),
        'Origin': os.environ.get('STREAMED_ORIGIN', 'https://embedsports.top'),
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache'
    }
    # Allow arbitrary header injection via env STREAMED_PLAYLIST_HEADERS as JSON ("Key:Value;Key2:Value2")
    extra = os.environ.get('STREAMED_PLAYLIST_HEADERS')
    if extra:
        for pair in re.split(r'[;\n]+', extra):
            if not pair.strip():
                continue
            if ':' in pair:
                k,v = pair.split(':',1)
                headers[k.strip()] = v.strip()
    return urllib.request.Request(url, headers=headers, method='GET')

def _dns_log(host: str):
    try:
        ips = socket.gethostbyname_ex(host)[2]
        print(f"[STREAMED][DNS] {host} -> {','.join(ips)}")
    except Exception as e:
        print(f"[STREAMED][DNS][ERR] {host} {e}")

def fetch_playlist() -> List[Dict[str,Any]]:
    now = time.time()
    # Serve cached content if still fresh
    if os.path.exists(CACHE_FILE):
        try:
            with open(CACHE_FILE,'r',encoding='utf-8') as f:
                data = json.load(f)
            if now - data.get('ts',0) < CACHE_TTL and isinstance(data.get('raw'), str):
                return parse_playlist(data['raw'])
        except Exception:
            pass
    # Resolve host for diagnostics
    try:
        host = urllib.request.urlparse(PLAYLIST_URL).hostname
        if host:
            _dns_log(host)
    except Exception:
        pass

    attempts = int(os.environ.get('STREAMED_FETCH_RETRIES','3'))
    last_err = None
    raw = None
    for i in range(1, attempts+1):
        try:
            req = _build_request(PLAYLIST_URL)
            with urllib.request.urlopen(req, timeout=15) as r:
                raw = r.read().decode('utf-8','replace')
            if raw and '#EXTM3U' in raw:
                break
        except Exception as e:
            last_err = e
            print(f"[STREAMED][FETCH][WARN] attempt={i}/{attempts} err={e}")
            time.sleep(min(3, i))
    # Optional fallback using requests if installed
    if (not raw or '#EXTM3U' not in raw):
        try:
            import requests  # type: ignore
            ua = os.environ.get('STREAMED_UA','Mozilla/5.0')
            headers = {'User-Agent': ua, 'Referer': os.environ.get('STREAMED_REFERER','https://embedsports.top/')}
            resp = requests.get(PLAYLIST_URL, headers=headers, timeout=15)
            if resp.ok:
                raw = resp.text
        except Exception as e:
            print(f"[STREAMED][FETCH][FALLBACK][ERR] {e}")
    if not raw:
        if last_err:
            print(f"[STREAMED][FETCH][ERR] giving up: {last_err}")
        return []
    try:
        with open(CACHE_FILE,'w',encoding='utf-8') as f:
            json.dump({'ts': now, 'raw': raw}, f)
    except Exception:
        pass
    return parse_playlist(raw)

_WORD_CLEAN_RE = re.compile(r'[^a-z0-9]+')
_TAG_SUFFIX_RE = re.compile(r'\[[^\]]+\]\s*$')

def _norm_text(s: str) -> str:
    s = s.lower().strip()
    s = _TAG_SUFFIX_RE.sub('', s)  # remove trailing [ECHO] like tags
    s = _WORD_CLEAN_RE.sub(' ', s)
    return re.sub(r'\s+', ' ', s).strip()

def _team_aliases(raw: str) -> List[str]:
    base = normalize_team(raw)
    raw_n = _norm_text(raw)
    parts = [p for p in raw_n.split() if p not in ('fc','ssd','asd','usd','calcio','club')]
    aliases = {base}
    if parts:
        aliases.add(parts[-1])
    if len(parts) > 1:
        aliases.add(' '.join(parts))
    return [a for a in aliases if a]

def _contains_token_variants(text: str, aliases: List[str], allow_subtoken: bool) -> bool:
    for a in aliases:
        if not a:
            continue
        if allow_subtoken:
            if a in text:
                return True
        # word boundary match
        if re.search(rf'\b{re.escape(a)}\b', text):
            return True
    return False

def fuzzy_match_entry(entry_title: str, t1: str, t2: str, debug: bool, allow_subtoken: bool) -> bool:
    # Normalize playlist title
    nt = _norm_text(entry_title)
    aliases1 = _team_aliases(t1)
    aliases2 = _team_aliases(t2)
    ok1 = _contains_token_variants(nt, aliases1, allow_subtoken)
    ok2 = _contains_token_variants(nt, aliases2, allow_subtoken)
    if ok1 and ok2:
        if debug:
            print(f"[STREAMED][MATCH][FUZZ] teams '{t1}' '{t2}' title='{entry_title}'")
        return True
    return False

def match_entry_to_event(entry_title: str, event_teams: Tuple[str|None,str|None], debug: bool=False, allow_subtoken: bool=True) -> bool:
    t1, t2 = event_teams
    if not t1 or not t2:
        return False
    pts = MATCH_SPLIT.split(entry_title)
    if len(pts) >= 2:
        et1 = normalize_team(pts[0])
        et2 = normalize_team(pts[1].split('[',1)[0].strip())
        ev1 = normalize_team(t1)
        ev2 = normalize_team(t2)
        set_entry = {et1, et2}
        set_event = {ev1, ev2}
        if set_entry == set_event:
            return True
    # Fuzzy fallback
    return fuzzy_match_entry(entry_title, t1, t2, debug, allow_subtoken)

def _load_persist() -> Dict[str, Any]:
    try:
        if os.path.exists(PERSIST_FILE):
            with open(PERSIST_FILE,'r',encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
    except Exception:
        pass
    return {}

def _save_persist(p: Dict[str, Any]):
    try:
        tmp = PERSIST_FILE + '.tmp'
        with open(tmp,'w',encoding='utf-8') as f:
            json.dump(p, f, ensure_ascii=False, indent=2)
        os.replace(tmp, PERSIST_FILE)
    except Exception as e:
        print(f"[STREAMED][PERSIST][ERR] {e}")

def enrich():
    if not os.path.exists(DYNAMIC_FILE):
        return
    try:
        with open(DYNAMIC_FILE,'r',encoding='utf-8') as f:
            data = json.load(f)
        if not isinstance(data, list):
            return
    except Exception as e:
        print(f"[STREAMED][ERR] read dynamic: {e}")
        return

    now = now_utc()
    playlist = fetch_playlist()
    if not playlist:
        return
    changed = False
    added_total = 0

    match_debug = (os.environ.get('STREAMED_MATCH_DEBUG') or '').lower() in {'1','true','yes','on'}
    allow_subtoken = (os.environ.get('STREAMED_ALLOW_SUBTOKEN') or '1').lower() in {'1','true','yes','on'}

    persist = _load_persist()
    persist_changed = False

    for ev in data:
        try:
            ev_start_iso = ev.get('eventStart')
            dt = parse_iso(ev_start_iso) if isinstance(ev_start_iso,str) else None
            if not dt: continue
            # Discovery window (unless forced). We separate discovery vs retention.
            if not FORCE_MODE:
                if now < dt - datetime.timedelta(minutes=DISCOVERY_BEFORE_MIN):
                    # Too early for discovery or persistence (event not yet active in UI timeframe)
                    continue
                within_discovery = now <= dt + datetime.timedelta(minutes=DISCOVERY_AFTER_MIN)
            else:
                within_discovery = True
            # Extract teams from event
            ev_name = ev.get('name','')
            ev_t1, ev_t2 = extract_match_teams_from_event_name(ev_name)
            single_mode = False
            if not ev_t1 or not ev_t2:
                # Attempt single-entity detection (tournament / session / race / tennis match without explicit vs)
                if is_single_entity_event(ev_name):
                    single_mode = True
                else:
                    continue
            streams = ev.get('streams') or []
            existing_urls = { s.get('url') for s in streams if isinstance(s, dict) }
            existing_titles = { s.get('title') for s in streams if isinstance(s, dict) }
            # Retention: fuori discovery ma vogliamo mantenere ciò che avevamo.
            if not FORCE_MODE and not within_discovery:
                # Se abbiamo già stream [Strd] nulla da fare.
                if any(str(t).startswith(HDR_STREAMED_PREFIX) or str(t).startswith(LEGACY_PREFIX) for t in existing_titles):
                    continue
                # Se non ci sono più (file rigenerato) ma esistono in persistenza: re-iniettiamoli rispettando l'ordine.
                ev_id = str(ev.get('id'))
                persisted = persist.get(ev_id, {}).get('streams') if ev_id in persist else None
                if persisted and isinstance(persisted, list):
                    streams_list = ev.get('streams') or []
                    # Calcola insertion index (stessa logica usata per nuovi stream)
                    pd_end = 0
                    for i,s in enumerate(streams_list):
                        if isinstance(s, dict) and str(s.get('title','')).startswith('[P🐽D]'):
                            pd_end = i+1
                        else:
                            break
                    it_end = pd_end
                    for j in range(pd_end, len(streams_list)):
                        t = str(streams_list[j].get('title','')) if isinstance(streams_list[j], dict) else ''
                        if '🇮🇹' in t:
                            it_end = j+1
                        else:
                            break
                    insert_idx = it_end
                    restored = 0
                    for ps in persisted:
                        tu = ps.get('url'); tt = ps.get('title')
                        if tu in existing_urls:
                            continue
                        # Aggiorna simbolo dinamico sul titolo ripristinato
                        base_title = tt
                        # Rimuovi eventuali simboli precedenti dopo prefisso
                        if base_title.startswith(HDR_STREAMED_PREFIX):
                            rest = base_title[len(HDR_STREAMED_PREFIX):].lstrip()
                        else:
                            rest = base_title
                        # Se inizia con status emoji rimuovi
                        if rest.startswith(STATUS_AHEAD) or rest.startswith(STATUS_LIVE):
                            rest = rest[1:].lstrip()
                        # Calcola nuovo simbolo rispetto al tempo attuale
                        sym = ''
                        if dt:
                            if now < dt - datetime.timedelta(minutes=10):
                                sym = STATUS_AHEAD
                            else:
                                sym = STATUS_LIVE
                        new_title = f"{HDR_STREAMED_PREFIX}{sym} {rest}".strip()
                        ps['title'] = new_title
                        streams_list.insert(insert_idx, ps)
                        insert_idx += 1  # preserve persisted order
                        existing_urls.add(tu)
                        existing_titles.add(new_title)
                        restored += 1
                    if restored:
                        ev['streams'] = streams_list
                        changed = True
                        print(f"[STREAMED][RESTORE] event={ev.get('id')} restored={restored}")
                # Nessuna discovery fuori finestra
                continue
            added_this_event = 0
            for entry in playlist:
                title = entry['title']
                url = entry['url']
                if not title or not url:
                    continue
                good = False
                if single_mode:
                    if single_entity_match(title, ev_name, D_MIN_KEY_HITS, match_debug):
                        good = True
                else:
                    if match_entry_to_event(title, (ev_t1, ev_t2), debug=match_debug, allow_subtoken=allow_subtoken):
                        good = True
                if not good:
                    continue
                final_url = url
                if D_PROPAGATE and 'headers' in entry and HEADER_MODE == 'url_params':
                    try:
                        from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse
                        parsed = urlparse(url)
                        q = dict(parse_qsl(parsed.query))
                        for hk, hv in entry['headers'].items():
                            q[f"{HEADER_PARAM_PREFIX}{hk}"] = hv
                        nq = urlencode(q, doseq=True)
                        final_url = urlunparse((parsed.scheme, parsed.netloc, parsed.path, parsed.params, nq, parsed.fragment))
                    except Exception as e:
                        if match_debug:
                            print(f"[STREAMED][HDR][ERR] {e}")
                # If legacy prefix already present from previous run keep consistent new prefix
                display_title = title
                # Remove old legacy prefix if present before re-adding new
                if display_title.startswith(LEGACY_PREFIX):
                    display_title = display_title[len(LEGACY_PREFIX):].lstrip()
                # Status symbol at injection time
                sym = ''
                if dt:
                    if now < dt - datetime.timedelta(minutes=10):
                        sym = STATUS_AHEAD
                    else:
                        sym = STATUS_LIVE
                new_title = f"{HDR_STREAMED_PREFIX}{sym} {display_title}".strip()
                if final_url in existing_urls or new_title in existing_titles:
                    continue
                # Build stream object (header propagation forced now if headers exist)
                s_obj = {'url': final_url, 'title': new_title}
                if 'headers' in entry:
                    s_obj['xHeaders'] = entry['headers']
                # Determine insertion point: after any [P🐽D] + 🇮🇹 cluster + any RB77 entries (RB77 must precede Strd)
                insert_idx = len(streams)  # fallback end
                # 1) count leading [P🐽D]
                pd_end = 0
                for i,s in enumerate(streams):
                    if isinstance(s, dict) and str(s.get('title','')).startswith('[P🐽D]'):
                        pd_end = i+1
                    else:
                        break
                # 2) from pd_end forward count contiguous italian flag 🇮🇹
                it_end = pd_end
                for j in range(pd_end, len(streams)):
                    t = str(streams[j].get('title','')) if isinstance(streams[j], dict) else ''
                    if '🇮🇹' in t:
                        it_end = j+1
                    else:
                        break
                # 3) skip over any RB77 block (prefix [RB77🇮🇹]) so Strd go after them
                rb_end = it_end
                for k in range(it_end, len(streams)):
                    t = str(streams[k].get('title','')) if isinstance(streams[k], dict) else ''
                    if t.startswith('[RB77🇮🇹]'):
                        rb_end = k+1
                    else:
                        break
                insert_idx = rb_end
                streams.insert(insert_idx, s_obj)
                existing_urls.add(final_url)
                existing_titles.add(new_title)
                added_this_event += 1
            if added_this_event:
                ev['streams'] = streams
                added_total += added_this_event
                changed = True
                mode_tag = 'SINGLE' if single_mode else 'DUO'
                # Aggiorna persistenza
                ev_id = str(ev.get('id'))
                # Salva solo gli stream [Strd] dell'evento corrente
                persisted_streams = [s for s in streams if isinstance(s, dict) and str(s.get('title','')).startswith(HDR_STREAMED_PREFIX)]
                persist[ev_id] = {
                    'ts': int(time.time()),
                    'streams': persisted_streams
                }
                persist_changed = True
                print(f"[STREAMED][INJECT]{'[FORCE]' if FORCE_MODE else ''} event={ev.get('id')} added={added_this_event} mode={mode_tag}")

        except Exception as e:
            print(f"[STREAMED][ERR] event loop: {e}")
            continue

    if persist_changed:
        _save_persist(persist)

    if changed:
        try:
            # Write back
            tmp_path = DYNAMIC_FILE + '.streamed.tmp'
            with open(tmp_path,'w',encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            os.replace(tmp_path, DYNAMIC_FILE)
            print(f"[STREAMED][DONE] added_total={added_total} file={DYNAMIC_FILE}")
        except Exception as e:
            print(f"[STREAMED][ERR] write: {e}")


if __name__ == '__main__':
    try:
        enrich()
    except Exception as e:
        print(f"[STREAMED][FATAL] {e}")
        sys.exit(0)
