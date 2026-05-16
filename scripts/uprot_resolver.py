#!/usr/bin/env python3
"""
Uprot / Clicka shortener resolver — IP-whitelist design.

Concept:
  * Uprot/clicka whitelist the caller IP after one successful captcha solve.
  * Subsequent GETs from the same IP skip the captcha and return the final
    link inline.
  * So we run a periodic **warmup** that solves the captcha (with patient,
    spaced retries to dodge OCR/CDN rate limits) and then at runtime every
    stream request does only fast GETs — no OCR, no POST.

Modes:
  --resolve <url>     Fast path. GET the URL; if it already contains the
                      maxstream/clicka link follow the chain and return the
                      playable URL. If the page still shows a captcha, exit
                      with {"ok": false, "error": "captcha_required"} — the
                      caller should trigger a background warmup and skip
                      this stream.
  --warmup <url>      Full captcha solve via Tesseract OCR with spaced retries.
                      Use this on a periodic timer (every ~2h) on a known
                      seed URL to refresh the IP whitelist.
  --folder <url>      Parse a /msfld/ folder page (no captcha) and return its
                      episode list.

Output: JSON to stdout on a single line.

Network modes (env vars):
  STREAMVIX_HTTP_PROXY=user:pass@host:port    — route HTTP via this proxy
  STREAMVIX_DEBUG_BASE + STREAMVIX_DEBUG_TOKEN — route HTTP through streamvix
                                                  /debug/fetch (testing only)
  (neither set) — direct requests (production default on streamvix server)
"""

from __future__ import annotations
import argparse
import base64
import io
import json
import os
import re
import sys
import time
import urllib.parse
from collections import Counter
from typing import Any

import requests as _requests_legacy  # only for STREAMVIX_DEBUG_BASE fallback
from PIL import Image, ImageFilter  # type: ignore

try:
    import pytesseract  # type: ignore
except Exception:
    pytesseract = None

# curl_cffi: TLS/JA3 Chrome impersonation. Senza questo, Cloudflare/uprot
# riconosce il client come bot ad ogni richiesta e ripropone il captcha.
from curl_cffi import requests as _cffi_requests  # type: ignore

UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36")

# Headers "full browser" per le POST captcha verso uprot.net — copiati 1:1 da
# MammaMia (Src/API/extractors/uprot.py). Servono per non differire dal pattern
# che uprot accetta: alcuni endpoint diventano piu' rigidi senza Sec-Fetch-*/DNT.
UPROT_FULL_HEADERS = {
    'User-Agent': UA,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Content-Type': 'application/x-www-form-urlencoded',
    'Origin': 'https://uprot.net',
    'Sec-GPC': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-User': '?1',
    'DNT': '1',
    'Priority': 'u=0, i',
}

# Sessione curl_cffi persistente in-process (cookies condivisi tra le call).
_cffi_session = _cffi_requests.Session()

# Stato condiviso uprot — MammaMia-style. Salva cookies + POST data ottenuti
# dopo la prima risoluzione del captcha, per riusarli su tutti i link successivi.
UPROT_STATE_PATH = os.environ.get('UPROT_STATE_PATH', '/tmp/uprot_state.json')


def _uprot_state_load():
    try:
        with open(UPROT_STATE_PATH, 'r') as f:
            j = json.load(f)
        if isinstance(j, dict) and isinstance(j.get('cookies'), dict) and isinstance(j.get('data'), dict):
            return j
    except Exception:
        pass
    return None


def _uprot_state_save(cookies, data):
    try:
        with open(UPROT_STATE_PATH, 'w') as f:
            json.dump({'cookies': dict(cookies or {}), 'data': dict(data or {})}, f)
    except Exception:
        pass


# Stato condiviso clicka/safego — stesso pattern di uprot. Salva i cookies e
# i POST data della captcha risolta, per riusarli a runtime su qualsiasi link
# clicka/safego e saltare l'OCR inline.
CLICKA_STATE_PATH = os.environ.get('CLICKA_STATE_PATH', '/tmp/clicka_state.json')


def _clicka_state_load():
    try:
        with open(CLICKA_STATE_PATH, 'r') as f:
            j = json.load(f)
        if isinstance(j, dict) and isinstance(j.get('cookies'), dict) and isinstance(j.get('data'), dict):
            return j
    except Exception:
        pass
    return None


def _clicka_state_save(cookies, data):
    try:
        with open(CLICKA_STATE_PATH, 'w') as f:
            json.dump({'cookies': dict(cookies or {}), 'data': dict(data or {})}, f)
    except Exception:
        pass

DEBUG_BASE = os.environ.get('STREAMVIX_DEBUG_BASE', '').rstrip('/')
DEBUG_TOKEN = os.environ.get('STREAMVIX_DEBUG_TOKEN', '')
# Proxy HTTP per uscire da IP whitelistato verso clicka/uprot/maxstream.
#
# Modello "sticky per-dominio":
#   - Slot disponibili: 'PROXY' (env PROXY) e 'PROXY_BACKUP' (env PROXY_BACKUP).
#   - Slot attivo per uprot:  letto da /tmp/uprot_active_proxy_slot.txt
#   - Slot attivo per clicka: letto da /tmp/clicka_active_proxy_slot.txt
#   - Default se file mancante: 'PROXY'.
#   - Lo slot file viene scritto/ruotato dal lato Node (warmup loop o /chapta)
#     quando un warmup/solve fallisce: cosi' garantiamo che warmup, resolve
#     runtime e captcha manuale escano TUTTI dallo stesso IP per dominio.
#   - urls maxstream.video usano lo slot di uprot (sono il next-hop della chain).
#   - Per i comandi --submit-manual che devono usare LO STESSO proxy della
#     prepare-manual (anche se nel frattempo lo slot e' cambiato), si puo'
#     forzare via env _FORCE_PROXY_SLOT=PROXY|PROXY_BACKUP.
# Env legacy ancora supportati (override su tutto): STREAMVIX_HTTP_PROXY.

UPROT_ACTIVE_SLOT_PATH = os.environ.get('UPROT_ACTIVE_SLOT_PATH', '/tmp/uprot_active_proxy_slot.txt')
CLICKA_ACTIVE_SLOT_PATH = os.environ.get('CLICKA_ACTIVE_SLOT_PATH', '/tmp/clicka_active_proxy_slot.txt')
_VALID_SLOTS = ('PROXY', 'PROXY_BACKUP', 'DIRECT')


def _read_slot(path: str) -> str:
    try:
        with open(path, 'r') as f:
            v = f.read().strip()
        if v in _VALID_SLOTS:
            return v
    except Exception:
        pass
    return 'PROXY'


def _proxy_for(url: str) -> str:
    """Ritorna l'URL del proxy da usare per `url` in base allo slot attivo.
    Override (in ordine): _FORCE_PROXY_SLOT > STREAMVIX_HTTP_PROXY > slot file."""
    forced = os.environ.get('_FORCE_PROXY_SLOT', '').strip()
    if forced in _VALID_SLOTS:
        return os.environ.get(forced, '').strip()
    explicit = os.environ.get('STREAMVIX_HTTP_PROXY', '').strip()
    if explicit:
        return explicit
    host = ''
    try:
        host = (urllib.parse.urlparse(url).hostname or '').lower()
    except Exception:
        pass
    if 'clicka' in host or 'safego' in host or 'deltabit' in host:
        slot = _read_slot(CLICKA_ACTIVE_SLOT_PATH)
    else:
        # uprot.net, maxstream.video, e qualsiasi altro host della chain uprot
        slot = _read_slot(UPROT_ACTIVE_SLOT_PATH)
    if slot == 'DIRECT':
        # Bypass proxy: usa l'egress diretto del container (WARP).
        return ''
    return os.environ.get(slot, '').strip()


try:
    _u_slot = _read_slot(UPROT_ACTIVE_SLOT_PATH)
    _c_slot = _read_slot(CLICKA_ACTIVE_SLOT_PATH)
    _u_host = (os.environ.get(_u_slot, '').split('@')[-1].split('/')[0]) or '(unset)'
    _c_host = (os.environ.get(_c_slot, '').split('@')[-1].split('/')[0]) or '(unset)'
    print(f'[proxy] uprot slot={_u_slot} ({_u_host})  clicka slot={_c_slot} ({_c_host})',
          file=sys.stderr, flush=True)
    # Warning: se PROXY e PROXY_BACKUP puntano allo stesso endpoint, il flip
    # slot e' inutile e qualsiasi rotazione esce sempre dallo stesso IP. Lo
    # segnaliamo a startup cosi' l'operatore se ne accorge subito.
    _ep_main = (os.environ.get('PROXY', '').split('@')[-1].strip()) or ''
    _ep_back = (os.environ.get('PROXY_BACKUP', '').split('@')[-1].strip()) or ''
    if _ep_main and _ep_back and _ep_main == _ep_back:
        print(f'[proxy] WARNING: PROXY and PROXY_BACKUP point to the SAME endpoint '
              f'({_ep_main}). Slot rotation has no effect — configure a different '
              f'PROXY_BACKUP to enable real IP failover.',
              file=sys.stderr, flush=True)
except Exception:
    pass

HTTP_TIMEOUT = int(os.environ.get('UPROT_HTTP_TIMEOUT', '10'))
# Warmup: budget 10 tentativi OCR. Default abbassato da 8->10 per dare margine
# all'OCR (hit rate ~30-40%). Sleep tra tentativi 3-15s -> max ~2.5 min totali.
WARMUP_MAX_ATTEMPTS = int(os.environ.get('UPROT_WARMUP_ATTEMPTS', '10'))
WARMUP_BASE_SLEEP = float(os.environ.get('UPROT_WARMUP_BASE_SLEEP', '3.0'))
WARMUP_MAX_SLEEP = float(os.environ.get('UPROT_WARMUP_MAX_SLEEP', '15.0'))
# Stop anticipato se troppi 503/429 di fila (IP probabilmente rate-limited).
WARMUP_ABORT_ON_BLOCKS = int(os.environ.get('UPROT_WARMUP_ABORT_ON_BLOCKS', '3'))
# Runtime: 1 attempt, NIENTE OCR, NIENTE retry. Se la prima richiesta fallisce
# (captcha page o errore HTTP) il provider chiamante deve fare skip immediato.
# Il warmup periodico (ogni 2h se OK, ogni 30min se KO) e' l'UNICO responsabile
# di ripopolare lo state. Cosi' evitiamo di bombardare uprot con migliaia di
# request al minuto quando il proxy e' bannato.
RESOLVE_MAX_ATTEMPTS = int(os.environ.get('UPROT_RESOLVE_ATTEMPTS', '1'))
RESOLVE_SLEEP = float(os.environ.get('UPROT_RESOLVE_SLEEP', '0'))
RESOLVE_503_SLEEP = float(os.environ.get('UPROT_RESOLVE_503_SLEEP', '0'))

# Cookie-jar persistente su file. Il warmup salva i cookies dopo aver risolto il
# captcha; resolve_uprot_fast li carica così le successive richieste runtime
# "vedono" la sessione già autenticata (PHPSESSID / cf_clearance / ecc.).
COOKIE_JAR_PATH = os.environ.get('UPROT_COOKIE_JAR', '/tmp/uprot_cookies.json')


def _domain_key(url: str) -> str:
    try:
        h = urllib.parse.urlparse(url).hostname or ''
        # raggruppa per "etld" semplificata: usa gli ultimi due token
        parts = h.split('.')
        if len(parts) >= 2:
            return '.'.join(parts[-2:]).lower()
        return h.lower()
    except Exception:
        return ''


def _cookie_jar_load() -> dict:
    try:
        with open(COOKIE_JAR_PATH, 'r') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _cookie_jar_save(jar: dict) -> None:
    try:
        with open(COOKIE_JAR_PATH, 'w') as f:
            json.dump(jar, f)
    except Exception:
        pass


def _cookies_for(url: str) -> dict:
    jar = _cookie_jar_load()
    return jar.get(_domain_key(url), {}) if isinstance(jar.get(_domain_key(url), {}), dict) else {}


def _cookies_update(url: str, new_cookies: dict) -> None:
    if not new_cookies:
        return
    key = _domain_key(url)
    if not key:
        return
    jar = _cookie_jar_load()
    cur = jar.get(key, {})
    if not isinstance(cur, dict):
        cur = {}
    cur.update({k: v for k, v in new_cookies.items() if k and v})
    jar[key] = cur
    _cookie_jar_save(jar)


# ---------------------------------------------------------------------------
# HTTP layer
# ---------------------------------------------------------------------------

def _via_debug(url, method, body, headers, via_proxy, redirect):
    params = {
        'token': DEBUG_TOKEN,
        'url': url,
        'method': method,
        'raw': '0',
        'redirect': '1' if redirect else '0',
        'timeout': str(HTTP_TIMEOUT * 1000),
    }
    if via_proxy:
        params['viaProxy'] = '1'
    for k, v in (headers or {}).items():
        params[f'h_{k}'] = v
    full = DEBUG_BASE + '/debug/fetch?' + urllib.parse.urlencode(params)
    r = _requests_legacy.request(method, full, data=body,
                         headers={'User-Agent': UA}, timeout=HTTP_TIMEOUT + 5)
    r.raise_for_status()
    j = r.json()
    resp = j['response']
    bd = resp['body']
    data = base64.b64decode(bd['data']) if bd['encoding'] == 'base64' else bd['data'].encode('utf-8', 'replace')
    out_hdrs = {k.lower(): v for k, v in (resp.get('headers') or {}).items()}
    return int(resp['status']), out_hdrs, data


def _via_direct(url, method, body, headers, redirect, via_proxy=True):
    h = {'User-Agent': UA}
    h.update(headers or {})
    # Inject persisted cookies for this domain (se non gia presenti in header).
    persisted = _cookies_for(url)
    if persisted and 'Cookie' not in h and 'cookie' not in h:
        h['Cookie'] = '; '.join(f'{k}={v}' for k, v in persisted.items())
    proxies = None
    if via_proxy:
        proxy_url = _proxy_for(url)
        if proxy_url:
            scheme_proxy = proxy_url if proxy_url.startswith('http') else f'http://{proxy_url}'
            proxies = {'http': scheme_proxy, 'https': scheme_proxy}
    # curl_cffi.Session.request: usa impersonate='chrome' per ottenere il
    # fingerprint TLS/JA3 di Chrome, requisito per non venire challenged da
    # Cloudflare ad ogni richiesta.
    r = _cffi_session.request(method, url, data=body, headers=h,
                              allow_redirects=redirect, timeout=HTTP_TIMEOUT,
                              proxies=proxies, impersonate='chrome')
    out_hdrs = {k.lower(): v for k, v in r.headers.items()}
    # Esponi l'URL finale post-redirect (key custom, non-HTTP) cosi' il caller
    # puo' ricostruire path tipo /emvvv/<id> da watchfree/X/Y/.
    try:
        out_hdrs['_final_url'] = str(r.url)
    except Exception:
        pass
    # curl_cffi expone i Set-Cookie come stringa singola sotto 'set-cookie',
    # ma noi vogliamo una lista. Ricostruiamo dai cookies della session.
    try:
        sc_list = [f'{c.name}={c.value}' for c in r.cookies]
        if sc_list:
            out_hdrs['set-cookie'] = sc_list
    except Exception:
        pass
    if getattr(r, 'cookies', None):
        try:
            _cookies_update(url, {c.name: c.value for c in r.cookies if c.name})
        except Exception:
            pass
    return r.status_code, out_hdrs, r.content


def http(url, method='GET', body=None, headers=None, redirect=False, via_proxy=True):
    # NOTA: via_proxy e' SEMPRE forzato True. Tutta la chain uprot/maxstream/
    # clicka deve uscire dall'IP del proxy (PROXY env / PROXY_BACKUP, RR) per
    # coerenza cookies/captcha e per non bruciare l'IP del VPS.
    # Il parametro via_proxy resta per compatibilita' ma viene ignorato.
    if isinstance(body, str):
        body = body.encode('utf-8')
    headers = headers or {}
    if DEBUG_BASE and DEBUG_TOKEN:
        return _via_debug(url, method, body, headers, True, redirect)
    return _via_direct(url, method, body, headers, redirect, True)


def cookies_from(hdrs):
    sc = hdrs.get('set-cookie')
    if not sc:
        return ''
    if isinstance(sc, list):
        pairs = sc
    else:
        pairs = [f'{k}={v}' for k, v in re.findall(r'([A-Za-z0-9_\-]+)=([^;,]+)', sc)]
    seen = {}
    for entry in pairs:
        if '=' not in entry:
            continue
        k, v = entry.split('=', 1)
        k = k.strip()
        v = v.split(';', 1)[0].strip()
        if k.lower() in ('expires', 'path', 'domain', 'max-age', 'samesite', 'httponly', 'secure'):
            continue
        if k and v:
            seen[k] = v
    return '; '.join(f'{k}={v}' for k, v in seen.items())


# ---------------------------------------------------------------------------
# OCR (used only by warmup)
# ---------------------------------------------------------------------------

def _ocr_one(image_bytes):
    """3-digit numeric captcha OCR. Color-aware: keeps only dark pixels (digits)."""
    if pytesseract is None:
        return None
    rgb = Image.open(io.BytesIO(image_bytes)).convert('RGB')
    w, h = rgb.size
    px = rgb.load()
    mask = Image.new('L', (w, h), 255)
    mpx = mask.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            if r < 110 and g < 110 and b < 170 and max(r, g, b) - min(r, g, b) < 80:
                mpx[x, y] = 0
            else:
                mpx[x, y] = 255
    base = mask.resize((w * 5, h * 5), Image.LANCZOS)
    variants = [
        base,
        base.filter(ImageFilter.MedianFilter(3)),
        base.filter(ImageFilter.MedianFilter(5)),
        base.filter(ImageFilter.MaxFilter(3)),
    ]
    candidates = []
    for vimg in variants:
        for psm in (6, 7, 8, 10, 11, 13):
            try:
                out = pytesseract.image_to_string(
                    vimg, config=f'-c tessedit_char_whitelist=0123456789 --psm {psm}')
                digits = ''.join(c for c in out if c.isdigit())
                # Captcha uprot può essere 3 o 4 cifre (msf=3, msei=4 osservato).
                if 3 <= len(digits) <= 6:
                    candidates.append(digits[:4] if len(digits) >= 4 else digits[:3])
            except Exception:
                pass
    if not candidates:
        return None
    best, _n = Counter(candidates).most_common(1)[0]
    return best


def _extract_captcha_png(body):
    m = re.search(r'data:image/(?:png|jpe?g);base64,([A-Za-z0-9+/=]+)', body, re.I)
    if not m:
        return None
    try:
        return base64.b64decode(m.group(1))
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Page parsers
# ---------------------------------------------------------------------------

UPROTS_RE = re.compile(r'https?://maxstream\.video/uprots/[A-Za-z0-9=]+', re.I)
ADELTA_RE = re.compile(r'https?://clicka\.cc/adelta/[A-Za-z0-9=]+', re.I)
M3U8_SRC_RE = re.compile(r'sources:\s*\[\s*\{\s*src:\s*"(https?://[^"]+\.m3u8[^"]*)"')
M3U8_ANY_RE = re.compile(r'(https?://[^"\']+\.m3u8[^"\']*)')
# Iframe verso la pagina player maxstream. Il path storico era /emhuih/<id> ma
# maxstream cambia spesso path (es. /e/, /v/, /watch/, ecc.) e anche il TLD
# (.video/.to/.cc). Accettiamo qualsiasi iframe su un host *maxstream*.
EMHUIH_RE = re.compile(r"<iframe[^>]+src=['\"](https?://[^'\"]*maxstream[^'\"]*?/[a-z0-9_-]+/[a-z0-9]+)['\"]", re.I)
WATCHFREE_VID_RE = re.compile(r'/watchfree/[^/]+/([a-z0-9]+)/', re.I)
# Pattern generico m3u8 in JSON/JS (file: "..." oppure src: "...")
M3U8_FILE_RE = re.compile(r'(?:file|src|url)\s*[:=]\s*["\'](https?://[^"\']+\.m3u8[^"\']*)["\']', re.I)
# Eval/packed JS spesso contiene il link m3u8 dopo unpacking; cerchiamo anche su raw.


def _is_captcha_page(body):
    has_img = 'data:image' in body
    has_target = bool(UPROTS_RE.search(body) or ADELTA_RE.search(body))
    return has_img and not has_target


# ---------------------------------------------------------------------------
# Maxstream chain (uprots -> watchfree -> emhuih -> m3u8)
# ---------------------------------------------------------------------------

WATCHFREE_URL_RE = re.compile(r'https?://(?:[a-z0-9.-]*maxstream\.video|maxstream\.video)/watchfree/[^\s\'"<>]+', re.I)
META_REFRESH_RE = re.compile(r'<meta[^>]+http-equiv=["\']?refresh["\']?[^>]+url=([^"\'>\s]+)', re.I)
JS_LOC_RE = re.compile(r'(?:window\.|document\.)?location(?:\.href)?\s*=\s*["\']([^"\']+)["\']', re.I)
# Nuova chain: emhuih/<id> setta cookies e carica via $().load('../premium_embed.php')
# (oppure embed.php). Estraiamo il path AJAX dal body.
EMBED_LOAD_RE = re.compile(r"""\.load\(\s*['"]([^'"]+\.php[^'"]*)['"]""", re.I)
# Cookie file_id / aff / ref_url come setta `$.cookie('name','value', ...)`.
JQ_COOKIE_RE = re.compile(r"""\$\.cookie\(\s*['"]([A-Za-z0-9_-]+)['"]\s*,\s*['"]([^'"]+)['"]""", re.I)


def _follow_maxstream_chain(uprots_link):
    """Maxstream chain MammaMia-style.

    Strategia (allineata a Src/API/extractors/maxstream.py + uprot.py upstream):
      1) GET <uprots_link> con allow_redirects=True. curl_cffi+impersonate=chrome
         segue la catena uprots -> watchfree -> player automaticamente. Sul body
         finale cerchiamo m3u8 con la stessa regex di MammaMia (sources/src).
      2) Se non lo troviamo nel body finale, estraiamo l'id da `watchfree/X/Y/`
         (presente nel final URL o nel body) e costruiamo
         https://maxstream.video/emvvv/<Y>, poi GET e cerchiamo m3u8.
    Niente piu' chain .load('premium_embed.php'): MammaMia non la usa, e il
    player attuale espone l'm3u8 inline.
    """
    # Full browser headers anche qui: la chain uprots/ esce da uprot.net e
    # passa per maxstream.video, entrambi dietro CF. Header minimi -> 403.
    headers = dict(UPROT_FULL_HEADERS)
    headers['Referer'] = 'https://uprot.net/'

    def _find_m3u8(body_str):
        m = M3U8_SRC_RE.search(body_str) or M3U8_FILE_RE.search(body_str) or M3U8_ANY_RE.search(body_str)
        return m.group(1) if m else None

    def _dump(name, url, status, body):
        try:
            with open(f'/tmp/uprot_debug_{name}.html', 'w') as fdbg:
                fdbg.write(f'<!-- url={url} status={status} -->\n')
                fdbg.write(body[:24576])
            print(f'  [debug] {name} dumped to /tmp/uprot_debug_{name}.html ({len(body)} bytes)',
                  file=sys.stderr, flush=True)
        except Exception:
            pass

    # Step 1: GET uprots con redirect=True (delega chain redirect a curl_cffi).
    try:
        st, hdrs, raw = http(uprots_link, 'GET', headers=headers, redirect=True)
    except Exception as e:
        return {'ok': False, 'error': f'uprots GET failed: {e}'}
    if st != 200:
        return {'ok': False, 'error': f'uprots GET status {st}'}
    body = raw.decode('utf-8', 'replace') if raw else ''
    final_url = hdrs.get('_final_url') or uprots_link

    # Step 2: m3u8 sul body finale (caso comune MammaMia per /msf/->/mse/).
    m3u = _find_m3u8(body)
    if m3u:
        return {'ok': True, 'kind': 'maxstream', 'm3u8': m3u,
                'headers': {'Referer': 'https://maxstream.video/'}}

    # Step 3: ricostruisci /emvvv/<id> da watchfree path (MammaMia get_maxstream_link).
    target = None
    src_for_target = ''
    if 'watchfree/' in final_url:
        src_for_target = final_url
    else:
        mw = WATCHFREE_URL_RE.search(body)
        if mw:
            src_for_target = mw.group(0)
    if src_for_target:
        try:
            parts = src_for_target.split('watchfree/', 1)[1].split('/')
            # MammaMia: response.url.split('watchfree/')[1].split('/')[1]
            if len(parts) >= 2 and parts[1]:
                target = f'https://maxstream.video/emvvv/{parts[1]}'
        except Exception:
            pass
    if not target:
        # Fallback: iframe maxstream nel body finale
        m_if = EMHUIH_RE.search(body)
        if m_if:
            target = m_if.group(1)
    if not target:
        _dump('player', final_url, st, body)
        return {'ok': False, 'error': f'no m3u8/watchfree on final page (final_url={final_url[:80]})'}

    # Step 4: GET player page con redirect=True e cerca m3u8.
    player_hdrs = dict(UPROT_FULL_HEADERS)
    player_hdrs['Referer'] = final_url
    player_hdrs['Origin'] = 'https://maxstream.video'
    try:
        st2, hdrs2, raw2 = http(target, 'GET', headers=player_hdrs, redirect=True)
    except Exception as e:
        return {'ok': False, 'error': f'player GET failed: {e}'}
    body2 = raw2.decode('utf-8', 'replace') if raw2 else ''
    m3u = _find_m3u8(body2)
    if m3u:
        return {'ok': True, 'kind': 'maxstream', 'm3u8': m3u,
                'headers': {'Referer': 'https://maxstream.video/'}}
    _dump('player', target, st2, body2)
    return {'ok': False, 'error': f'no m3u8 on player page ({target[:80]})'}


# ---------------------------------------------------------------------------
# FAST RESOLVE — no captcha; assumes IP is whitelisted by previous warmup
# ---------------------------------------------------------------------------

def _find_continue_link(body):
    """Trova il link 'CONTINUE' (maxstream o clicka) nel body uprot post-bypass.

    NOTA: la pagina post-bypass può contenere PIU' uprots/<id> URLs, alcuni
    dummy nascosti in <div style="display:none"> o in commenti, e altri
    legittimi (es. backup mirrors). Quello REALE è normalmente l'href
    dell'anchor con testo "CONTINUE"; quindi diamo precedenza a quello
    rispetto al primo match regex.
    """
    # 1) Anchor con testo CONTINUE / C O N T I N U E (priorità: è il link
    #    che il browser seguirebbe cliccando il pulsante).
    for a_m in re.finditer(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', body, re.I | re.S):
        href = a_m.group(1)
        text = re.sub(r'\s+', '', a_m.group(2)).upper()
        if 'CONTINUE' in text and ('maxstream' in href or 'clicka' in href or 'uprots' in href or 'adelta' in href):
            return href
    # 2) Fallback: primo uprots/adelta URL nel body (può essere dummy se la
    #    pagina ne contiene più d'uno, ma è meglio di niente).
    m = UPROTS_RE.search(body)
    if m:
        return m.group(0)
    m = ADELTA_RE.search(body)
    if m:
        return m.group(0)
    # 3) Fallback finale: anchor CONTINUE senza filtro host.
    for a_m in re.finditer(r'<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', body, re.I | re.S):
        href = a_m.group(1)
        text = re.sub(r'\s+', '', a_m.group(2)).upper()
        if 'CONTINUE' in text:
            return href
    return None


def resolve_uprot_fast(url):
    """Resolver runtime stile MammaMia: NIENTE captcha runtime.

    * Path con 'msfi': POST con cookies + data salvati dal warmup (/tmp/uprot_state.json).
    * Path con 'msf' (non 'msfi'): trasforma in 'mse' e GET semplice.
      curl_cffi + impersonate='chrome' fa passare il bot-check di Cloudflare,
      quindi uprot serve direttamente la pagina con il link maxstream/clicka.
    * Path con 'mse'/'msei'/'msdi': GET semplice (stesso meccanismo).
    """
    is_msfi = bool(re.search(r'/(?:msfi|msei)/', url, re.I))
    target_url = url
    method = 'GET'
    body = None
    # Full browser headers (MammaMia-style): Cloudflare su uprot.net rifiuta
    # con 403 anche con curl_cffi+chrome impersonation se mancano Sec-Fetch-*,
    # DNT, Priority, Upgrade-Insecure-Requests, ecc. Vedi UPROT_FULL_HEADERS.
    headers = dict(UPROT_FULL_HEADERS)
    if is_msfi:
        state = _uprot_state_load()
        if not state:
            return {'ok': False, 'error': 'no warmup state (uprot_state.json missing) — run warmup first'}
        # Normalizza msei -> msfi (MammaMia fa l'analogo mse->msf prima del POST).
        if '/msei/' in target_url:
            target_url = target_url.replace('/msei/', '/msfi/')
        method = 'POST'
        post_data = urllib.parse.urlencode(state['data'])
        body = post_data
        # Headers "full browser" MammaMia-style + state cookies + Referer al target.
        headers = dict(UPROT_FULL_HEADERS)
        headers['Cookie'] = '; '.join(f'{k}={v}' for k, v in state['cookies'].items())
        headers['Referer'] = target_url
    else:
        # msf -> mse trick (MammaMia): la variante 'mse' non chiede captcha.
        if '/msf/' in target_url:
            target_url = target_url.replace('/msf/', '/mse/')
        headers['Referer'] = 'https://uprot.net/'
        # NIENTE Cookie header: MammaMia su /mse/ fa GET pulita, lascia solo
        # curl_cffi+impersonate='chrome' a bypassare CF. Iniettare i cookies
        # del warmup qui rompeva la sessione (cookie IP-bound da un IP, GET
        # da un altro).
    st, _hdrs, raw = http(target_url, method, body, headers)
    # 403 = IP bloccato lato uprot (MammaMia bypass_uprot: logger.info 'Uprot
    # blocked the request: 403'). Skip immediato senza altre richieste.
    if st == 403:
        return {'ok': False, 'error': 'uprot 403 (ip blocked) — flip proxy slot'}
    # IP whitelistato: uprot risponde 30x verso il next-hop senza body. Segui
    # direttamente la Location se punta a maxstream/clicka.
    if st in (301, 302, 303, 307, 308):
        loc = _hdrs.get('location') or ''
        loc_low = loc.lower()
        if 'maxstream' in loc_low or '/uprots/' in loc_low:
            return _follow_maxstream_chain(loc)
        if 'clicka' in loc_low and '/adelta/' in loc_low:
            return resolve_clicka_fast(loc)
        return {'ok': False, 'error': f'GET status {st} loc={loc[:80]}'}
    if st != 200:
        return {'ok': False, 'error': f'GET status {st}'}
    body_text = raw.decode('utf-8', 'replace')
    # Se la prima POST/GET ritorna una pagina captcha esplicita: NIENTE OCR
    # inline runtime. Il provider chiamante deve fare skip immediato dello
    # stream. Il warmup periodico ripopolera' lo state.
    if _is_captcha_page(body_text):
        return {'ok': False, 'error': 'captcha_required'}
    cont = _find_continue_link(body_text)
    if not cont:
        preview = re.sub(r'\s+', ' ', body_text[:200])
        return {'ok': False, 'error': f'no continue link in body: {preview[:160]}'}
    if 'maxstream' in cont or '/uprots/' in cont:
        # Può essere un uprots/<id> o un redirect chain. Risolvi via chain.
        if '/uprots/' not in cont:
            # Segui i redirect finché non trovi /uprots/ o esci
            return _follow_maxstream_chain(cont) if 'maxstream' in cont else {'ok': False, 'error': 'unexpected maxstream link shape'}
        return _follow_maxstream_chain(cont)
    if 'clicka' in cont and '/adelta/' in cont:
        # Inietta nel resolver clicka.
        return resolve_clicka_fast(cont)
    return {'ok': False, 'error': f'unsupported continue link: {cont[:120]}'}


def resolve_clicka_fast(url):
    # Full browser headers su entry GET (CF su clicka.cc).
    seed_hdrs = dict(UPROT_FULL_HEADERS)
    seed_hdrs['Origin'] = 'https://clicka.cc'
    seed_hdrs['Referer'] = url
    st, hdrs, _raw = http(url, 'GET', headers=seed_hdrs, via_proxy=True)
    loc = hdrs.get('location')
    if loc and 'safego' in loc:
        safego_url = loc
        # Fast path: se abbiamo state da warmup, POST diretto con cookie+data
        # del captcha già risolto, saltando l'OCR inline.
        body = None
        state = _clicka_state_load()
        if state:
            post_data = urllib.parse.urlencode(state['data'])
            post_hdrs = dict(UPROT_FULL_HEADERS)
            post_hdrs['Cookie'] = '; '.join(f'{k}={v}' for k, v in state['cookies'].items())
            post_hdrs['Referer'] = safego_url
            post_hdrs['Origin'] = 'https://safego.cc'
            post_hdrs['Content-Type'] = 'application/x-www-form-urlencoded'
            stp, _hp, rawp = http(safego_url, 'POST', post_data, post_hdrs, via_proxy=True)
            if stp == 200:
                bodyp = rawp.decode('utf-8', 'replace')
                if ADELTA_RE.search(bodyp) and not _is_captcha_page(bodyp):
                    body = bodyp
        # Se lo state non c'era o non ha funzionato, GET normale + OCR inline.
        if body is None:
            safego_hdrs = dict(UPROT_FULL_HEADERS)
            safego_hdrs['Origin'] = 'https://safego.cc'
            safego_hdrs['Referer'] = safego_url
            st, hdrs, raw = http(safego_url, 'GET', headers=safego_hdrs, via_proxy=True)
            body = raw.decode('utf-8', 'replace')
        m = ADELTA_RE.search(body)
        if not m:
            if _is_captcha_page(body):
                # NIENTE OCR inline runtime. Skip immediato.
                return {'ok': False, 'error': 'captcha_required'}
            else:
                return {'ok': False, 'error': 'no adelta link on safego page'}
        adelta = m.group(0)
    else:
        m = ADELTA_RE.search(url)
        if not m:
            return {'ok': False, 'error': f'unexpected clicka response (status {st}, loc {loc})'}
        adelta = m.group(0)
    # Full headers anche sull'adelta GET: CF su clicka.cc applica gli stessi
    # check WAF dell'entry GET, header minimi -> 403.
    adelta_hdrs = dict(UPROT_FULL_HEADERS)
    adelta_hdrs['Origin'] = 'https://safego.cc'
    adelta_hdrs['Referer'] = 'https://safego.cc/'
    st, hdrs, _raw = http(adelta, 'GET', via_proxy=True, headers=adelta_hdrs)
    loc = hdrs.get('location')
    if not loc or 'deltabit.co' not in loc:
        return {'ok': False, 'error': f'no deltabit redirect (status {st}, loc {loc})'}
    return {'ok': True, 'kind': 'deltabit', 'deltabit': loc}


# ---------------------------------------------------------------------------
# WARMUP — solves captcha with spaced retries (background only)
# ---------------------------------------------------------------------------

def _captcha_solve_attempt(url, field, origin, via_proxy):
    # Full browser headers: CF su uprot.net/safego.cc richiede l'header set
    # completo anche con TLS chrome impersonation. Vedi prepare_manual().
    get_hdrs = dict(UPROT_FULL_HEADERS)
    get_hdrs['Origin'] = origin
    get_hdrs['Referer'] = url
    st, hdrs, raw = http(url, 'GET', headers=get_hdrs, via_proxy=via_proxy)
    # IP gia' whitelistato: uprot/clicka non mostra il captcha, ma reindirizza
    # direttamente al next-hop della chain. Trattiamo come success.
    if st in (301, 302, 303, 307, 308):
        loc = hdrs.get('location') or ''
        loc_low = loc.lower()
        next_hop_markers = ('uprots/', 'adelta/', 'maxstream.video', 'clicka.cc', 'safego')
        if loc and any(mk in loc_low for mk in next_hop_markers):
            # Cookie correnti dal jar persistito (set durante questa GET).
            current_cookies = dict(_cookies_for(url))
            return {'ok': True, 'body': loc, 'already_open': True,
                    'cookies': current_cookies, 'data': {}}
        return {'ok': False, 'error': f'GET status {st} loc={loc[:80]}'}
    if st != 200:
        return {'ok': False, 'error': f'GET status {st}'}
    body = raw.decode('utf-8', 'replace')
    if UPROTS_RE.search(body) or ADELTA_RE.search(body):
        # Body gia' contiene il link bypass: l'IP e' whitelistato. Popoliamo i
        # cookies dal jar persistito cosi' il caller puo' salvare uno state
        # coerente (mtime fresca per la UI /chapta).
        current_cookies = dict(_cookies_for(url))
        return {'ok': True, 'body': body, 'already_open': True,
                'cookies': current_cookies, 'data': {}}
    cookie = cookies_from(hdrs)
    png = _extract_captcha_png(body)
    if not png:
        return {'ok': False, 'error': 'no captcha png on GET'}
    guess = _ocr_one(png)
    if not guess:
        return {'ok': False, 'error': 'OCR produced no candidate'}
    post_data = {field: guess}
    post_body = urllib.parse.urlencode(post_data)
    # Full headers anche per la POST (allineato a MammaMia).
    post_hdrs = dict(UPROT_FULL_HEADERS)
    post_hdrs['Cookie'] = cookie
    post_hdrs['Referer'] = url
    post_hdrs['Origin'] = origin
    post_hdrs['Content-Type'] = 'application/x-www-form-urlencoded'
    st2, hdrs2, raw2 = http(url, 'POST', post_body, post_hdrs, via_proxy=via_proxy)
    body2 = raw2.decode('utf-8', 'replace')
    if UPROTS_RE.search(body2) or ADELTA_RE.search(body2):
        # Cookies dopo solve: ricostruiamo dal cookie jar persistito + eventuali
        # nuovi set-cookie ritornati nella POST response.
        merged_cookies = dict(_cookies_for(url))
        sc = hdrs2.get('set-cookie')
        if sc:
            items = sc if isinstance(sc, list) else [sc]
            for entry in items:
                m_kv = re.match(r'([A-Za-z0-9_\-]+)=([^;]+)', entry)
                if m_kv:
                    merged_cookies[m_kv.group(1)] = m_kv.group(2)
        return {'ok': True, 'body': body2, 'guess': guess,
                'cookies': merged_cookies, 'data': post_data}
    return {'ok': False, 'error': f'wrong guess {guess}', 'guess': guess}


def _solve_captcha_inline(url, field, origin, via_proxy, label):
    """Tenta OCR+POST fino a RESOLVE_MAX_ATTEMPTS. Restituisce body sbloccato o None."""
    print(f'  inline-solve {label} url={url[:120]} max={RESOLVE_MAX_ATTEMPTS}', file=sys.stderr, flush=True)
    for i in range(1, RESOLVE_MAX_ATTEMPTS + 1):
        try:
            r = _captcha_solve_attempt(url, field, origin, via_proxy=via_proxy)
        except Exception as e:
            r = {'ok': False, 'error': f'exception: {e}'}
        short = 'OK' if r.get('ok') else f"FAIL {r.get('error','?')[:60]}"
        print(f'    {label} attempt {i}/{RESOLVE_MAX_ATTEMPTS} guess={r.get("guess","-")} -> {short}',
              file=sys.stderr, flush=True)
        if r.get('ok'):
            return r['body']
        # Backoff più aggressivo se l'origin sta rate-limitando (503/429).
        err = r.get('error', '')
        if 'status 503' in err or 'status 429' in err:
            time.sleep(RESOLVE_503_SLEEP)
        else:
            time.sleep(RESOLVE_SLEEP)
    return None


def _uprot_whitelist_probe(url):
    """Probe "whitelist reale" senza captcha: trasforma /msf/<id> in /mse/<id>
    (trick MammaMia) e fa GET. Se il body contiene un link maxstream/clicka
    significa che l'IP corrente e' whitelistato e uprot ha servito direttamente
    la pagina post-bypass.

    Returns: dict {ok: bool, body?: str, error?: str}.
    Non solleva eccezioni.
    """
    target = url
    if '/msf/' in target and '/msfi/' not in target:
        target = target.replace('/msf/', '/mse/')
    elif '/msei/' in target:
        target = target.replace('/msei/', '/msdi/')
    # Se l'URL e' gia' una variante bypass (/mse/, /msdi/) usalo tale e quale.
    # Full headers MammaMia: senza Sec-Fetch-*/DNT/Priority CF risponde 403.
    headers = dict(UPROT_FULL_HEADERS)
    headers['Referer'] = 'https://uprot.net/'
    try:
        st, hdrs, raw = http(target, 'GET', headers=headers, via_proxy=True)
    except Exception as e:
        return {'ok': False, 'error': f'probe exception: {e}'}
    if st in (301, 302, 303, 307, 308):
        loc = (hdrs.get('location') or '').lower()
        if any(mk in loc for mk in ('uprots/', 'adelta/', 'maxstream.video', 'clicka.cc', 'safego')):
            return {'ok': True, 'body': hdrs.get('location') or ''}
        return {'ok': False, 'error': f'probe status {st} loc={loc[:80]}'}
    if st == 403:
        return {'ok': False, 'error': 'probe 403 (ip blocked)'}
    if st != 200:
        return {'ok': False, 'error': f'probe status {st}'}
    body = raw.decode('utf-8', 'replace') if raw else ''
    if UPROTS_RE.search(body) or ADELTA_RE.search(body):
        return {'ok': True, 'body': body}
    return {'ok': False, 'error': 'probe: no maxstream/clicka link (not whitelisted)'}


def warmup_uprot(url):
    diag = {'attempts': []}
    print(f'warmup_uprot start url={url} max_attempts={WARMUP_MAX_ATTEMPTS}', file=sys.stderr, flush=True)
    # STEP 0: probe whitelist reale via /mse/ trick. Se l'IP corrente vede
    # gia' la pagina post-bypass senza captcha, saltiamo l'intero loop OCR
    # e salviamo uno state "vuoto" (cookies dal jar, data={}) sufficiente a
    # rinfrescare la mtime del file di state per la UI /chapta.
    probe = _uprot_whitelist_probe(url)
    if probe.get('ok'):
        body0 = probe.get('body') or ''
        merged = dict(_cookies_for(url))
        _uprot_state_save(merged, {})
        print(f'warmup_uprot SUCCESS (whitelist probe) state refreshed cookies={list(merged.keys())}',
              file=sys.stderr, flush=True)
        m = UPROTS_RE.search(body0)
        if m:
            chain = _follow_maxstream_chain(m.group(0))
            if chain.get('ok'):
                return {'ok': True, 'kind': 'maxstream', 'm3u8': chain['m3u8'],
                        'headers': chain['headers'], 'diag': {'probe': True}}
        return {'ok': True, 'kind': 'whitelisted', 'diag': {'probe': True}}
    print(f'  whitelist probe FAIL: {probe.get("error","?")[:80]} — falling back to OCR loop',
          file=sys.stderr, flush=True)
    diag['probe_error'] = probe.get('error')
    consecutive_blocks = 0
    for attempt in range(1, WARMUP_MAX_ATTEMPTS + 1):
        try:
            r = _captcha_solve_attempt(url, 'captcha', 'https://uprot.net', via_proxy=True)
        except Exception as e:
            r = {'ok': False, 'error': f'exception: {e}'}
        diag['attempts'].append({'i': attempt, **{k: v for k, v in r.items() if k != 'body'}})
        status_short = 'OK' if r.get('ok') else f"FAIL {r.get('error','?')[:80]}"
        print(f'  attempt {attempt}/{WARMUP_MAX_ATTEMPTS} guess={r.get("guess","-")} -> {status_short}',
              file=sys.stderr, flush=True)
        # Early abort: se vediamo 503/429 ripetuti, l'IP è già rate-limited.
        err_str = str(r.get('error', ''))
        if (not r.get('ok')) and ('status 503' in err_str or 'status 429' in err_str):
            consecutive_blocks += 1
            if consecutive_blocks >= WARMUP_ABORT_ON_BLOCKS:
                print(f'warmup_uprot ABORT: {consecutive_blocks} consecutive blocks (503/429) — IP rate-limited',
                      file=sys.stderr, flush=True)
                return {'ok': False, 'error': f'rate-limited ({consecutive_blocks}x 503/429)', 'diag': diag}
        else:
            consecutive_blocks = 0
        if r.get('ok'):
            # Salva SEMPRE lo state (anche con cookies/data vuoti): il file di
            # state e' il marker che la UI /chapta usa per dire "whitelisted"
            # (controlla mtime). Se non lo aggiorniamo, la UI continua a dire
            # "non whitelistato" anche dopo un warmup OK su ramo already_open.
            _uprot_state_save(r.get('cookies') or {}, r.get('data') or {})
            print(f'  state saved: cookies={list((r.get("cookies") or {}).keys())} data={r.get("data")}',
                  file=sys.stderr, flush=True)
            # IP è ora whitelistato (il captcha è stato accettato). Indipendentemente
            # dal fatto che il chain maxstream completi o meno, il goal del warmup
            # è raggiunto: non ci servono altri tentativi.
            m = UPROTS_RE.search(r['body'])
            if m:
                chain = _follow_maxstream_chain(m.group(0))
                if chain.get('ok'):
                    print(f'warmup_uprot SUCCESS m3u8 ok', file=sys.stderr, flush=True)
                    return {'ok': True, 'kind': 'maxstream', 'm3u8': chain['m3u8'],
                            'headers': chain['headers'], 'diag': diag}
                diag['attempts'].append({'chain_err': chain.get('error')})
                print(f'warmup_uprot SUCCESS (captcha accepted, chain failed: {chain.get("error","?")[:80]})',
                      file=sys.stderr, flush=True)
                return {'ok': True, 'kind': 'whitelisted', 'diag': diag}
            print(f'warmup_uprot SUCCESS (whitelisted)', file=sys.stderr, flush=True)
            return {'ok': True, 'kind': 'whitelisted', 'diag': diag}
        sleep_for = min(WARMUP_BASE_SLEEP + attempt, WARMUP_MAX_SLEEP)
        time.sleep(sleep_for)
    print(f'warmup_uprot EXHAUSTED after {WARMUP_MAX_ATTEMPTS} attempts', file=sys.stderr, flush=True)
    return {'ok': False, 'error': 'warmup attempts exhausted', 'diag': diag}


def warmup_clicka(url):
    diag = {'attempts': []}
    print(f'warmup_clicka start url={url} max_attempts={WARMUP_MAX_ATTEMPTS}', file=sys.stderr, flush=True)
    try:
        seed_hdrs = dict(UPROT_FULL_HEADERS)
        seed_hdrs['Origin'] = 'https://clicka.cc'
        seed_hdrs['Referer'] = url
        st, hdrs, _raw = http(url, 'GET', headers=seed_hdrs, via_proxy=True)
    except Exception as e:
        print(f'warmup_clicka FAILED at GET: {e}', file=sys.stderr, flush=True)
        return {'ok': False, 'error': f'clicka GET failed: {e}'}
    loc = hdrs.get('location')
    if not loc or 'safego' not in loc:
        print(f'warmup_clicka FAILED no safego redirect status={st} loc={loc}', file=sys.stderr, flush=True)
        return {'ok': False, 'error': f'no safego redirect (status {st}, loc {loc})'}
    safego = loc
    print(f'warmup_clicka safego={safego[:120]}', file=sys.stderr, flush=True)
    consecutive_blocks = 0
    for attempt in range(1, WARMUP_MAX_ATTEMPTS + 1):
        try:
            r = _captcha_solve_attempt(safego, 'captch5', 'https://safego.cc', via_proxy=True)
        except Exception as e:
            r = {'ok': False, 'error': f'exception: {e}'}
        diag['attempts'].append({'i': attempt, **{k: v for k, v in r.items() if k != 'body'}})
        status_short = 'OK' if r.get('ok') else f"FAIL {r.get('error','?')[:80]}"
        print(f'  clicka attempt {attempt}/{WARMUP_MAX_ATTEMPTS} guess={r.get("guess","-")} -> {status_short}',
              file=sys.stderr, flush=True)
        if r.get('ok'):
            # Salva SEMPRE lo state (anche con cookies/data vuoti) per
            # refresh mtime: la UI /chapta usa questo come marker whitelist.
            _clicka_state_save(r.get('cookies') or {}, r.get('data') or {})
            print(f'  clicka state saved: cookies={list((r.get("cookies") or {}).keys())} data={r.get("data")}',
                  file=sys.stderr, flush=True)
            print(f'warmup_clicka SUCCESS (whitelisted)', file=sys.stderr, flush=True)
            return {'ok': True, 'kind': 'whitelisted', 'safego': safego, 'diag': diag}
        err_str = str(r.get('error', ''))
        if 'status 503' in err_str or 'status 429' in err_str:
            consecutive_blocks += 1
            if consecutive_blocks >= WARMUP_ABORT_ON_BLOCKS:
                print(f'warmup_clicka ABORT: {consecutive_blocks} consecutive blocks (503/429) \u2014 IP rate-limited',
                      file=sys.stderr, flush=True)
                return {'ok': False, 'error': f'rate-limited ({consecutive_blocks}x 503/429)', 'diag': diag}
        else:
            consecutive_blocks = 0
        time.sleep(min(WARMUP_BASE_SLEEP + attempt, WARMUP_MAX_SLEEP))
    print(f'warmup_clicka EXHAUSTED after {WARMUP_MAX_ATTEMPTS} attempts', file=sys.stderr, flush=True)
    return {'ok': False, 'error': 'warmup attempts exhausted', 'diag': diag}


# ---------------------------------------------------------------------------
# Folder parser
# ---------------------------------------------------------------------------

def parse_folder(url):
    # Full browser headers anche sul folder GET: uprot.net e' dietro CF.
    folder_hdrs = dict(UPROT_FULL_HEADERS)
    folder_hdrs['Referer'] = 'https://uprot.net/'
    st, _hdrs, raw = http(url, 'GET', headers=folder_hdrs)
    if st != 200:
        return {'ok': False, 'error': f'folder GET returned {st}'}
    body = raw.decode('utf-8', 'replace')
    pairs_raw = re.findall(
        r'([A-Za-z0-9._\- ]+\.(?:mp4|mkv|avi|m4v))\s*<td[^>]*>[\s\S]{0,400}?<a[^>]+href=[\'"]([^\'\"]*msfi[^\'\"]+)',
        body, re.I)
    seen = {}
    for fname, link in pairs_raw:
        if link in seen:
            continue
        seen[link] = fname.strip()
    entries = []
    for link, fname in seen.items():
        season = episode = None
        m_se = re.search(r'S(\d{1,3})\s*E(\d{1,4})', fname, re.I)
        if m_se:
            season = int(m_se.group(1))
            episode = int(m_se.group(2))
        else:
            # Formato CB01/Scrubs-style: "Scrubs.01x01.Titolo.avi", "1x03", "02x3" ecc.
            # Match NxE con boundary non-alfanumerici per evitare collisioni con
            # codici tipo "1080x720" o hash. Limiti: season 1-99, episode 1-999.
            m_nxe = re.search(r'(?<![A-Za-z0-9])(\d{1,2})x(\d{1,3})(?![A-Za-z0-9])', fname, re.I)
            if m_nxe:
                season = int(m_nxe.group(1))
                episode = int(m_nxe.group(2))
        entries.append({'filename': fname, 'msfi': link, 'season': season, 'episode': episode})
    return {'ok': True, 'kind': 'folder', 'entries': entries}


# ---------------------------------------------------------------------------
# Public dispatch
# ---------------------------------------------------------------------------

def resolve(url):
    u = url.strip()
    if re.search(r'uprot\.net/msfld/', u, re.I):
        return parse_folder(u)
    if re.search(r'uprot\.net/(?:msf|msfi|msei|msdi)/', u, re.I):
        return resolve_uprot_fast(u)
    if re.search(r'maxstream\.video/uprots/', u, re.I):
        return _follow_maxstream_chain(u)
    if re.search(r'clicka\.cc/(?:delta|adelta)/', u, re.I):
        return resolve_clicka_fast(u)
    return {'ok': False, 'error': f'unsupported url: {u[:120]}'}


def warmup(url):
    u = url.strip()
    if re.search(r'uprot\.net/(?:msf|msfi|msei|msdi)/', u, re.I):
        return warmup_uprot(u)
    if re.search(r'clicka\.cc/(?:delta|adelta)/', u, re.I):
        return warmup_clicka(u)
    if re.search(r'uprot\.net/msfld/', u, re.I):
        return parse_folder(u)
    return {'ok': False, 'error': f'unsupported warmup url: {u[:120]}'}


# ---------------------------------------------------------------------------
# Manual captcha solve (per /chapta endpoint)
# ---------------------------------------------------------------------------
# Flusso:
#   1) Node chiama --prepare-manual <uprot|clicka>: il Python scarica la pagina
#      captcha attraverso lo slot proxy attivo del dominio, estrae il PNG e
#      ritorna { ok, png_b64, session: { url, field, origin, cookie, proxy_slot } }.
#      Node memorizza la session su file (/tmp/chapta_sess_<sid>.json) e mostra
#      l'immagine all'utente.
#   2) Node chiama --submit-manual <session_path> --guess <NNN>: il Python
#      ricarica la session, FORZA il proxy slot salvato (cosi' anche se nel
#      frattempo lo slot del dominio e' stato ruotato, la POST esce dallo
#      stesso IP della prepare) e tenta la POST captcha. Se accettata, scrive
#      il file di state (uprot_state.json / clicka_state.json) come warmup.


def prepare_manual(domain):
    domain = (domain or '').strip().lower()
    if domain == 'uprot':
        url = os.environ.get('STREAMVIX_UPROT_WARMUP_URL', 'https://uprot.net/msf/rizwh38f389b')
        field = 'captcha'
        origin = 'https://uprot.net'
        slot = _read_slot(UPROT_ACTIVE_SLOT_PATH)
        # Probe whitelist reale prima di scaricare la captcha PNG: se l'IP
        # corrente bypassa gia' /mse/, segnala already_whitelisted e refresh
        # state mtime cosi' la UI /chapta resta coerente.
        probe = _uprot_whitelist_probe(url)
        if probe.get('ok'):
            merged = dict(_cookies_for(url))
            _uprot_state_save(merged, {})
            return {'ok': True, 'already_whitelisted': True, 'domain': domain}
    elif domain == 'clicka':
        seed = os.environ.get('STREAMVIX_CLICKA_WARMUP_URL', 'https://clicka.cc/delta/mfua6zl4cb9p')
        try:
            # Full browser headers anche per il seed clicka: stesso motivo
            # (CF su clicka.cc accetta solo richieste con header completi).
            seed_hdrs = dict(UPROT_FULL_HEADERS)
            seed_hdrs['Origin'] = 'https://clicka.cc'
            seed_hdrs['Referer'] = seed
            st, hdrs, _raw = http(seed, 'GET', headers=seed_hdrs, via_proxy=True)
        except Exception as e:
            return {'ok': False, 'error': f'clicka GET failed: {e}'}
        loc = hdrs.get('location')
        if not loc or 'safego' not in loc:
            return {'ok': False, 'error': f'no safego redirect (status {st})'}
        url = loc
        field = 'captch5'
        origin = 'https://safego.cc'
        slot = _read_slot(CLICKA_ACTIVE_SLOT_PATH)
    else:
        return {'ok': False, 'error': f'unknown domain: {domain}'}
    try:
        # Pass FULL browser headers (UPROT_FULL_HEADERS-style) on the GET.
        # Without these, Cloudflare on uprot.net/safego.cc replies 403 even
        # with curl_cffi+chrome impersonation. MammaMia (Src/API/extractors/
        # uprot.py) uses the same header set and it works behind the same
        # WARP egress that fails for us when only User-Agent is sent.
        get_hdrs = dict(UPROT_FULL_HEADERS)
        get_hdrs['Origin'] = origin
        get_hdrs['Referer'] = url
        st, hdrs, raw = http(url, 'GET', headers=get_hdrs, via_proxy=True)
    except Exception as e:
        return {'ok': False, 'error': f'GET failed: {e}'}
    if st in (301, 302, 303, 307, 308):
        loc = hdrs.get('location') or ''
        if any(mk in loc.lower() for mk in ('uprots/', 'adelta/', 'maxstream.video', 'clicka.cc', 'safego')):
            return {'ok': True, 'already_whitelisted': True, 'domain': domain}
        return {'ok': False, 'error': f'GET status {st} loc={loc[:80]}'}
    if st != 200:
        return {'ok': False, 'error': f'GET status {st}'}
    body = raw.decode('utf-8', 'replace')
    if UPROTS_RE.search(body) or ADELTA_RE.search(body):
        return {'ok': True, 'already_whitelisted': True, 'domain': domain}
    png = _extract_captcha_png(body)
    if not png:
        return {'ok': False, 'error': 'no captcha png on GET'}
    cookie = cookies_from(hdrs)
    session = {
        'domain': domain,
        'url': url,
        'field': field,
        'origin': origin,
        'cookie': cookie,
        'proxy_slot': slot,
        'created_ms': int(time.time() * 1000),
    }
    return {
        'ok': True,
        'domain': domain,
        'png_b64': base64.b64encode(png).decode('ascii'),
        'session': session,
    }


def submit_manual(session_path, guess):
    try:
        with open(session_path, 'r') as f:
            sess = json.load(f)
    except Exception as e:
        return {'ok': False, 'error': f'session load failed: {e}'}
    if not isinstance(sess, dict):
        return {'ok': False, 'error': 'invalid session file'}
    domain = sess.get('domain')
    url = sess.get('url')
    field = sess.get('field')
    origin = sess.get('origin')
    cookie = sess.get('cookie') or ''
    slot = sess.get('proxy_slot') or 'PROXY'
    if not (domain and url and field and origin):
        return {'ok': False, 'error': 'session missing required fields'}
    guess = (guess or '').strip()
    if not re.match(r'^\d{1,6}$', guess):
        return {'ok': False, 'error': 'invalid guess (digits only)'}
    # Forza lo slot della session: anche se nel frattempo il file slot e' stato
    # ruotato, la POST esce dallo stesso IP della GET fatta da prepare_manual.
    if slot in _VALID_SLOTS:
        os.environ['_FORCE_PROXY_SLOT'] = slot
    post_data = {field: guess}
    post_body = urllib.parse.urlencode(post_data)
    # Full browser headers (allineato a MammaMia / prepare_manual GET).
    post_hdrs = dict(UPROT_FULL_HEADERS)
    post_hdrs['Cookie'] = cookie
    post_hdrs['Referer'] = url
    post_hdrs['Origin'] = origin
    post_hdrs['Content-Type'] = 'application/x-www-form-urlencoded'
    try:
        st, hdrs, raw = http(url, 'POST', post_body, post_hdrs, via_proxy=True)
    except Exception as e:
        return {'ok': False, 'error': f'POST failed: {e}'}
    body = raw.decode('utf-8', 'replace')
    if UPROTS_RE.search(body) or ADELTA_RE.search(body):
        # Salva state esattamente come fa warmup_uprot / warmup_clicka.
        merged_cookies = dict(_cookies_for(url))
        sc = hdrs.get('set-cookie')
        if sc:
            items = sc if isinstance(sc, list) else [sc]
            for entry in items:
                m_kv = re.match(r'([A-Za-z0-9_\-]+)=([^;]+)', entry)
                if m_kv:
                    merged_cookies[m_kv.group(1)] = m_kv.group(2)
        if domain == 'uprot':
            _uprot_state_save(merged_cookies, post_data)
        elif domain == 'clicka':
            _clicka_state_save(merged_cookies, post_data)
        return {'ok': True, 'domain': domain, 'guess': guess, 'proxy_slot': slot}
    # Distingui errori upstream (IP bloccato/rate-limit) dal vero "guess sbagliato".
    # 503/429: rate-limit. 403: IP bloccato. In questi casi la captcha non e' mai
    # stata valutata: dire "wrong guess" e' fuorviante.
    if st in (403, 429, 503, 502, 504):
        kind = 'ip blocked' if st == 403 else 'rate-limited / upstream busy'
        return {'ok': False,
                'error': f'upstream {st} ({kind}) — captcha non valutato; cambia proxy/IP',
                'guess': guess, 'proxy_slot': slot, 'upstream_status': st}
    if st != 200:
        return {'ok': False, 'error': f'POST status {st}', 'guess': guess, 'proxy_slot': slot}
    return {'ok': False, 'error': f'wrong guess (status {st})', 'guess': guess, 'proxy_slot': slot}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--resolve', help='URL to resolve (fast path, no captcha)')
    ap.add_argument('--warmup', help='URL for warmup (OCR captcha solve)')
    ap.add_argument('--folder', help='Folder URL to parse (uprot /msfld/)')
    ap.add_argument('--prepare-manual', dest='prepare_manual',
                    help='Domain (uprot|clicka): scarica captcha tramite proxy attivo, ritorna PNG b64 + session')
    ap.add_argument('--submit-manual', dest='submit_manual',
                    help='Path al session JSON salvato da --prepare-manual')
    ap.add_argument('--guess', help='Captcha guess (cifre) per --submit-manual')
    args = ap.parse_args()
    try:
        if args.folder:
            print(json.dumps(parse_folder(args.folder))); return
        if args.warmup:
            print(json.dumps(warmup(args.warmup))); return
        if args.resolve:
            print(json.dumps(resolve(args.resolve))); return
        if args.prepare_manual:
            print(json.dumps(prepare_manual(args.prepare_manual))); return
        if args.submit_manual:
            print(json.dumps(submit_manual(args.submit_manual, args.guess or ''))); return
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'exception: {e}'}))
        return
    ap.print_help()
    sys.exit(2)


if __name__ == '__main__':
    main()
