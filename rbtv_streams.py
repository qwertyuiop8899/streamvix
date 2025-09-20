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
PREFIX_BASE = '[RB77🇮🇹]'
STATUS_THRESHOLD_MIN = 10

# --- Language filtering configuration ---
# Comma separated positive / negative keyword lists (case-insensitive)
# Defaults kept intentionally narrow to avoid false positives like 'digital'.
LANG_INCLUDE = [t.strip().lower() for t in (os.environ.get('RBTV_LANG_KEYWORDS')
                 or 'italiano,italia,italy,ita,[ita]').split(',') if t.strip()]
LANG_EXCLUDE = [t.strip().lower() for t in (os.environ.get('RBTV_EXCLUDE_KEYWORDS')
                 or 'english,inglese,spanish,espanol,español,french,francais,deutsch,german,portuguese,portugues,português,arab,arabo,turk,turco,russian,russo,polish,polacco,greek,greco,serb,serbo,croat,croato,alban,albanese,brazil,brasil,portugal').split(',') if t.strip()]
STRICT_MODE = (os.environ.get('RBTV_STRICT') or '').lower() in {'1','true','yes','on','strict'}

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
    base = toks[-1]
    # basic synonyms mapping (Serie A / B / C + comuni)
    synonyms = {
        'internazionale': 'inter', 'inter': 'inter',
        'juventus': 'juve', 'juve': 'juve',
        'atalanta': 'atalanta', 'fiorentina': 'fiorentina', 'sassuolo': 'sassuolo', 'udinese': 'udinese',
        'bologna': 'bologna', 'cagliari': 'cagliari', 'empoli': 'empoli', 'lecce': 'lecce', 'torino': 'torino',
        'verona': 'verona', 'hellas': 'verona', 'napoli': 'napoli', 'roma': 'roma', 'lazio': 'lazio',
        'milan': 'milan', 'reggiana': 'reggiana', 'catanzaro': 'catanzaro', 'palermo': 'palermo', 'cesena': 'cesena',
        'monza': 'monza', 'como': 'como', 'pisa': 'pisa', 'parma': 'parma', 'brescia': 'brescia', 'spezia': 'spezia'
    }
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

def build_prefix(now: datetime.datetime, start: datetime.datetime) -> str:
    return f"{PREFIX_BASE}{status_symbol(now, start)}"

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
    attempts = int(os.environ.get('RBTV_FETCH_RETRIES', '3'))
    last_err: Exception | None = None
    for i in range(1, attempts + 1):
        try:
            req = _build_request(url)
            with urllib.request.urlopen(req, timeout=15) as r:
                raw = r.read().decode('utf-8', 'replace')
            if raw and '#EXTM3U' in raw:
                return raw
        except Exception as e:
            last_err = e
            print(f"[RBTV][FETCH][WARN] attempt={i}/{attempts} err={e}")
            time.sleep(min(2.5, i))
    # fallback: prova requests se disponibile
    try:
        import requests  # type: ignore
        req_headers = { 'User-Agent': os.environ.get('RBTV_UA','Mozilla/5.0'), 'Referer': os.environ.get('RBTV_REFERER','https://embedsports.top/') }
        resp = requests.get(url, headers=req_headers, timeout=15)
        if resp.ok and '#EXTM3U' in resp.text:
            return resp.text
    except Exception as e:
        print(f"[RBTV][FETCH][FALLBACK][ERR] {e}")
    if last_err:
        print(f"[RBTV][FETCH][ERR] giving up: {last_err}")
    return None

def _is_italian(title: str) -> bool:
    tl = title.lower()
    # Accept ANY variant (HDD *, SD, VDO, MOVISTAR ecc.) ONLY if at least one bracket tag contains an Italian token
    bracket_tags = re.findall(r'\[[^\]]+\]', title)
    if not bracket_tags:
        return False
    tag_join = ' '.join(bracket_tags).lower()
    if not re.search(r'\b(ita|italy|italia|italiano|ital)\b', tag_join):
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
        return []
    lines = [l.strip() for l in raw.splitlines() if l.strip()]
    out: List[Dict[str,Any]] = []
    i = 0
    while i < len(lines):
        if lines[i].startswith('#EXTINF'):
            title = lines[i].split(',', 1)[-1].strip()
            url = None
            if i + 1 < len(lines) and lines[i + 1].startswith('http'):
                url = lines[i + 1].strip()
                i += 1
            if url and _is_italian(title):
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
                sym_pref = build_prefix(now, dt)
                updated_any = False
                for s in ev_streams:
                    if isinstance(s, dict):
                        tt = s.get('title','')
                        if tt.startswith(PREFIX_BASE):
                            # Replace dynamic symbol part
                            # Pattern: [RB77🇮🇹]<emoji>
                            new_head = sym_pref
                            # Remove existing head token up to first space after emoji if present
                            rest = tt
                            # Identify old prefix base + possible emoji
                            if tt.startswith(PREFIX_BASE):
                                # Strip base
                                rest_part = tt[len(PREFIX_BASE):]
                                # remove leading emoji + space patterns
                                rest_part = re.sub(r'^[^ ]+\s*', '', rest_part)
                                rest = rest_part
                            new_title = f"{new_head} {rest}".strip()
                            if new_title != tt:
                                s['title'] = new_title
                                updated_any = True
                if updated_any:
                    ev['streams'] = ev_streams
                    changed = True
                if any(str(t).startswith(PREFIX_BASE) for t in existing_titles):
                    continue
                ev_id = str(ev.get('id'))
                stored = persist.get(ev_id,{}).get('streams') if ev_id in persist else None
                if stored:
                    # insertion point (after PD + 🇮🇹 cluster, prima di [Strd])
                    pd_end = 0
                    for i,s in enumerate(ev_streams):
                        if isinstance(s,dict) and str(s.get('title','')).startswith('[P🐽D]'):
                            pd_end = i+1
                        else:
                            break
                    it_end = pd_end
                    for j in range(pd_end,len(ev_streams)):
                        t = str(ev_streams[j].get('title','')) if isinstance(ev_streams[j],dict) else ''
                        if '🇮🇹' in t and not t.startswith(PREFIX_BASE):
                            it_end = j+1
                        else:
                            break
                    # Skip over existing RBTV if any (shouldn't since we restore) but ensure we insert before [Strd]
                    strd_start = it_end
                    for k in range(it_end,len(ev_streams)):
                        t = str(ev_streams[k].get('title','')) if isinstance(ev_streams[k],dict) else ''
                        if t.startswith('[Strd]'):
                            strd_start = k
                            break
                    insert_idx = strd_start
                    restored = 0
                    for rs in stored:
                        u = rs.get('url'); tt = rs.get('title')
                        if u in existing_urls or tt in existing_titles:
                            continue
                        # Update symbol on restore
                        if isinstance(rs, dict):
                            rs_title = rs.get('title','')
                            head = build_prefix(now, dt)
                            # Remove any old base prefix occurrences
                            rs_core = re.sub(r'^\[RB77🇮🇹\][^ ]*\s*', '', rs_title)
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
                else:
                    if summary_enabled:
                        if reason == 'exact': stat_counts['exact'] += 1
                        elif reason == 'partial': stat_counts['partial'] += 1
                        elif reason == 'single_side': stat_counts['single_side'] += 1
                        elif reason.startswith('fuzzy_pair_ok'): stat_counts['fuzzy'] += 1
                final_url = pl['url']
                display_title = pl['title']
                prefix = build_prefix(now, dt)
                new_title = f"{prefix} {display_title}"
                if final_url in existing_urls or new_title in existing_titles:
                    continue
                # insertion point before [Strd]
                pd_end = 0
                for i,s in enumerate(ev_streams):
                    if isinstance(s,dict) and str(s.get('title','')).startswith('[P🐽D]'):
                        pd_end = i+1
                    else:
                        break
                it_end = pd_end
                for j in range(pd_end,len(ev_streams)):
                    t = str(ev_streams[j].get('title','')) if isinstance(ev_streams[j],dict) else ''
                    if '🇮🇹' in t and not t.startswith(PREFIX_BASE):
                        it_end = j+1
                    else:
                        break
                # find first [Strd]
                strd_start = len(ev_streams)
                for k in range(it_end,len(ev_streams)):
                    t = str(ev_streams[k].get('title','')) if isinstance(ev_streams[k],dict) else ''
                    if t.startswith('[Strd]'):
                        strd_start = k
                        break
                insert_idx = strd_start
                ev_streams.insert(insert_idx, {'url': final_url, 'title': new_title})
                existing_urls.add(final_url); existing_titles.add(new_title)
                added_this += 1
            if summary_enabled and (added_this or any(stat_counts.values())):
                print(f"[RBTV][SUMMARY] event={ev.get('id')} added={added_this} counts={stat_counts} fuzzy_thr={fuzzy_thresh}")
            if added_this:
                ev['streams'] = ev_streams
                # persist only RB entries
                ev_id = str(ev.get('id'))
                stored_rb = [s for s in ev_streams if isinstance(s,dict) and str(s.get('title','')).startswith(PREFIX_BASE)]
                persist[ev_id] = {'ts': int(time.time()), 'streams': stored_rb}
                persist_changed = True
                added_total += added_this
                print(f"[RBTV][INJECT]{'[FORCE]' if FORCE_MODE else ''} event={ev.get('id')} added={added_this} mode={'SINGLE' if single_mode else 'DUO'}")
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
