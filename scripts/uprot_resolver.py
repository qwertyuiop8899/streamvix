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

UA = ("Mozilla/5.0 (X11; Linux x86_64; rv:146.0) "
      "Gecko/20100101 Firefox/146.0")

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
# Ordine: STREAMVIX_HTTP_PROXY (esplicito, prioritario) -> PROXY + PROXY_BACKUP
# alternati round-robin per spalmare il carico (cookies/captcha possono divergere
# tra IP differenti, ma WAF ringraziano) -> HTTPS_PROXY / HTTP_PROXY (fallback).
def _build_proxy_list():
    explicit = os.environ.get('STREAMVIX_HTTP_PROXY', '').strip()
    if explicit:
        return [explicit]
    primary = os.environ.get('PROXY', '').strip()
    backup = os.environ.get('PROXY_BACKUP', '').strip()
    lst = []
    if primary: lst.append(primary)
    if backup: lst.append(backup)
    if lst:
        return lst
    fb = os.environ.get('HTTPS_PROXY', '').strip() or os.environ.get('HTTP_PROXY', '').strip()
    return [fb] if fb else []

HTTP_PROXIES = _build_proxy_list()
HTTP_PROXY = HTTP_PROXIES[0] if HTTP_PROXIES else ''
_PROXY_RR_IDX = 0

def _next_proxy():
    """Round-robin sulla lista proxy. Ritorna stringa proxy o '' se nessuno."""
    global _PROXY_RR_IDX
    if not HTTP_PROXIES:
        return ''
    p = HTTP_PROXIES[_PROXY_RR_IDX % len(HTTP_PROXIES)]
    _PROXY_RR_IDX += 1
    return p

HTTP_TIMEOUT = int(os.environ.get('UPROT_HTTP_TIMEOUT', '25'))
# Default conservativi: ogni attempt = 1 GET (+ eventuale 1 POST) sul server uprot/safego.
# Troppi tentativi -> rischio ban IP. 8 dovrebbe bastare con OCR ~30-40% hit rate.
WARMUP_MAX_ATTEMPTS = int(os.environ.get('UPROT_WARMUP_ATTEMPTS', '8'))
WARMUP_BASE_SLEEP = float(os.environ.get('UPROT_WARMUP_BASE_SLEEP', '3.0'))
WARMUP_MAX_SLEEP = float(os.environ.get('UPROT_WARMUP_MAX_SLEEP', '15.0'))
# Stop anticipato se troppi 503/429 di fila (IP probabilmente rate-limited).
WARMUP_ABORT_ON_BLOCKS = int(os.environ.get('UPROT_WARMUP_ABORT_ON_BLOCKS', '3'))
# Tentativi inline al resolve runtime (più bassi del warmup: serve risposta veloce).
RESOLVE_MAX_ATTEMPTS = int(os.environ.get('UPROT_RESOLVE_ATTEMPTS', '5'))
RESOLVE_SLEEP = float(os.environ.get('UPROT_RESOLVE_SLEEP', '3.0'))
RESOLVE_503_SLEEP = float(os.environ.get('UPROT_RESOLVE_503_SLEEP', '6.0'))

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


def _via_direct(url, method, body, headers, redirect, via_proxy=False):
    h = {'User-Agent': UA}
    h.update(headers or {})
    # Inject persisted cookies for this domain (se non gia presenti in header).
    persisted = _cookies_for(url)
    if persisted and 'Cookie' not in h and 'cookie' not in h:
        h['Cookie'] = '; '.join(f'{k}={v}' for k, v in persisted.items())
    proxies = None
    if via_proxy and HTTP_PROXIES:
        sel = _next_proxy()
        if sel:
            scheme_proxy = sel if sel.startswith('http') else f'http://{sel}'
            proxies = {'http': scheme_proxy, 'https': scheme_proxy}
    # curl_cffi.Session.request: usa impersonate='chrome' per ottenere il
    # fingerprint TLS/JA3 di Chrome, requisito per non venire challenged da
    # Cloudflare ad ogni richiesta.
    r = _cffi_session.request(method, url, data=body, headers=h,
                              allow_redirects=redirect, timeout=HTTP_TIMEOUT,
                              proxies=proxies, impersonate='chrome')
    out_hdrs = {k.lower(): v for k, v in r.headers.items()}
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
    # NOTA: default via_proxy=True (proxy WARP via PROXY env). Tutta la chain
    # uprot/maxstream/clicka esce dallo stesso IP per coerenza cookies/captcha.
    if isinstance(body, str):
        body = body.encode('utf-8')
    headers = headers or {}
    if DEBUG_BASE and DEBUG_TOKEN:
        return _via_debug(url, method, body, headers, via_proxy, redirect)
    return _via_direct(url, method, body, headers, redirect, via_proxy)


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
    """Maxstream chain (variabile nel tempo):

    Possibili percorsi:
      A) uprots -> 302 -> watchfree/<id>/<token>/ -> body con iframe emhuih/<id> -> body con m3u8
      B) uprots -> 302 -> emhuih/<id>             -> body con player + .load('premium_embed.php') -> m3u8
      C) uprots -> 200 con redirect via meta/JS al prossimo step
    """
    chain_cookies = {}

    def _absorb_cookies(html_body, hdrs_obj):
        for k, v in JQ_COOKIE_RE.findall(html_body or ''):
            chain_cookies[k] = v
        sc = (hdrs_obj or {}).get('set-cookie') if hdrs_obj else None
        if sc:
            items = sc if isinstance(sc, list) else [sc]
            for entry in items:
                mm = re.match(r'([A-Za-z0-9_\-]+)=([^;]+)', entry)
                if mm:
                    chain_cookies[mm.group(1)] = mm.group(2)

    def _cookie_header():
        return '; '.join(f'{k}={v}' for k, v in chain_cookies.items()) if chain_cookies else ''

    def _find_m3u8(body_str):
        m = M3U8_SRC_RE.search(body_str) or M3U8_FILE_RE.search(body_str) or M3U8_ANY_RE.search(body_str)
        return m.group(1) if m else None

    def _dump(name, url, status, body):
        try:
            with open(f'/tmp/uprot_debug_{name}.html', 'w') as fdbg:
                fdbg.write(f'<!-- url={url} status={status} cookies={list(chain_cookies.keys())} -->\n')
                fdbg.write(body[:24576])
            print(f'  [debug] {name} dumped to /tmp/uprot_debug_{name}.html ({len(body)} bytes)',
                  file=sys.stderr, flush=True)
        except Exception:
            pass

    # Step 1: GET uprots, follow Location o estrai dal body.
    st, hdrs, raw = http(uprots_link, 'GET', headers={'Referer': 'https://uprot.net/'})
    body = raw.decode('utf-8', 'replace') if raw else ''
    _absorb_cookies(body, hdrs)
    loc = hdrs.get('location')
    if not loc:
        cand = None
        m = WATCHFREE_URL_RE.search(body)
        if m:
            cand = m.group(0)
        if not cand:
            m = META_REFRESH_RE.search(body)
            if m:
                cand = m.group(1)
        if not cand:
            m = JS_LOC_RE.search(body)
            if m and ('maxstream' in m.group(1) or 'watchfree' in m.group(1) or 'emhuih' in m.group(1)):
                cand = m.group(1)
        if not cand:
            preview = re.sub(r'\s+', ' ', body[:300])
            return {'ok': False, 'error': f'no Location from uprots (status {st}); body preview: {preview[:200]}'}
        loc = cand
    next_url = urllib.parse.urljoin(uprots_link, loc)

    # Step 2: se next_url è già una player page (emhuih/embed/e/), saltiamo direttamente.
    # Altrimenti fetch della pagina e cerchiamo iframe emhuih oppure ripieghiamo.
    is_player_url = bool(re.search(r'maxstream\.[a-z]+/(?:emhuih|embed|e)/', next_url, re.I))
    page_url = next_url
    page_body = None

    if not is_player_url:
        st2, hdrs2, raw2 = http(next_url, 'GET', headers={'Referer': uprots_link, 'Cookie': _cookie_header()})
        wf_body = raw2.decode('utf-8', 'replace')
        _absorb_cookies(wf_body, hdrs2)
        # Prova subito m3u8 sul body intermedio.
        m3u = _find_m3u8(wf_body)
        if m3u:
            return {'ok': True, 'kind': 'maxstream', 'm3u8': m3u,
                    'headers': {'Referer': 'https://maxstream.video/'}}
        m_if = EMHUIH_RE.search(wf_body)
        if m_if:
            page_url = m_if.group(1)
        else:
            mv = WATCHFREE_VID_RE.search(next_url)
            if mv:
                page_url = f'https://maxstream.video/emhuih/{mv.group(1)}'
            else:
                # Nessun iframe trovato — magari questo body È già il player.
                page_url = next_url
                page_body = wf_body

    # Step 3: fetch della player page (se non già scaricata).
    if page_body is None:
        ref = uprots_link if is_player_url else next_url
        st3, hdrs3, raw3 = http(page_url, 'GET', headers={'Referer': ref, 'Cookie': _cookie_header()})
        page_body = raw3.decode('utf-8', 'replace')
        _absorb_cookies(page_body, hdrs3)

    # Step 4a: m3u8 diretto sulla player page.
    m3u = _find_m3u8(page_body)
    if m3u:
        return {'ok': True, 'kind': 'maxstream', 'm3u8': m3u,
                'headers': {'Referer': 'https://maxstream.video/'}}

    # Step 4b: nuova chain — body contiene $('#prediv').load('../premium_embed.php')
    load_m = EMBED_LOAD_RE.search(page_body)
    if load_m:
        embed_path = load_m.group(1)
        embed_url = urllib.parse.urljoin(page_url, embed_path)
        st4, hdrs4, raw4 = http(embed_url, 'GET', headers={
            'Referer': page_url,
            'X-Requested-With': 'XMLHttpRequest',
            'Cookie': _cookie_header(),
        })
        emb_body = raw4.decode('utf-8', 'replace')
        _absorb_cookies(emb_body, hdrs4)
        m3u = _find_m3u8(emb_body)
        if m3u:
            return {'ok': True, 'kind': 'maxstream', 'm3u8': m3u,
                    'headers': {'Referer': 'https://maxstream.video/'}}
        # Forse l'embed contiene un altro iframe verso il player vero
        m_if2 = re.search(r'<iframe[^>]+src=[\'"]([^\'"]+)[\'"]', emb_body, re.I)
        if m_if2:
            inner_iframe = urllib.parse.urljoin(embed_url, m_if2.group(1))
            st5, hdrs5, raw5 = http(inner_iframe, 'GET', headers={
                'Referer': embed_url,
                'Cookie': _cookie_header(),
            })
            inner_body = raw5.decode('utf-8', 'replace')
            m3u = _find_m3u8(inner_body)
            if m3u:
                return {'ok': True, 'kind': 'maxstream', 'm3u8': m3u,
                        'headers': {'Referer': 'https://maxstream.video/'}}
            _dump('iframe', inner_iframe, st5, inner_body)
        _dump('embed', embed_url, st4, emb_body)
        return {'ok': False, 'error': f'no m3u8 in embed ({embed_path})'}

    # Nessuna fonte trovata — dump per diagnosi
    _dump('player', page_url, '?', page_body)
    return {'ok': False, 'error': 'no m3u8/iframe/.load on player page'}


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
    headers = {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Upgrade-Insecure-Requests': '1',
    }
    if is_msfi:
        state = _uprot_state_load()
        if not state:
            return {'ok': False, 'error': 'no warmup state (uprot_state.json missing) — run warmup first'}
        # Normalizza path: msfi vuole essere msfi, msei resta msei (MammaMia trasforma
        # mse->msf solo se necessario; il POST va fatto sull'URL come arriva).
        method = 'POST'
        post_data = urllib.parse.urlencode(state['data'])
        body = post_data
        headers['Cookie'] = '; '.join(f'{k}={v}' for k, v in state['cookies'].items())
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
        headers['Origin'] = 'https://uprot.net'
        headers['Referer'] = target_url
    else:
        # msf -> mse trick (MammaMia): la variante 'mse' non chiede captcha.
        if '/msf/' in target_url:
            target_url = target_url.replace('/msf/', '/mse/')
        headers['Referer'] = 'https://uprot.net/'
        # Inietta cookies salvati dal warmup (es. captcha=<hash>) anche sui GET,
        # altrimenti uprot considera la sessione nuova e ripropone il captcha.
        state = _uprot_state_load()
        if state and state.get('cookies'):
            headers['Cookie'] = '; '.join(f'{k}={v}' for k, v in state['cookies'].items())
    st, _hdrs, raw = http(target_url, method, body, headers)
    if st != 200:
        return {'ok': False, 'error': f'GET status {st}'}
    body_text = raw.decode('utf-8', 'replace')
    # Se la prima POST/GET ritorna una pagina captcha esplicita:
    #   - per /msfi/ e /msei/: NIENTE inline OCR. L'immagine captcha su quelle
    #     pagine è praticamente illeggibile da tesseract (4-5 su 5 attempt
    #     "no candidate") e quando il warmup state non basta, lo sforzo è
    #     sprecato e fa sforare il timeout 30s del provider chiamante. Mollo
    #     subito così il caller fallisce su Mixdrop in <2s.
    #   - per altri path (msf/mse/...): tenta OCR come prima (raro).
    if _is_captcha_page(body_text):
        if is_msfi:
            return {'ok': False, 'error': 'msfi_no_warmup (captcha required, OCR disabled for /msfi|msei/)'}
        solved = _solve_captcha_inline(target_url, 'captcha', 'https://uprot.net',
                                       via_proxy=True, label='msfi')
        if solved is None:
            return {'ok': False, 'error': 'captcha_required (inline OCR failed)'}
        body_text = solved
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
    st, hdrs, _raw = http(url, 'GET', via_proxy=True)
    loc = hdrs.get('location')
    if loc and 'safego' in loc:
        safego_url = loc
        # Fast path: se abbiamo state da warmup, POST diretto con cookie+data
        # del captcha già risolto, saltando l'OCR inline.
        body = None
        state = _clicka_state_load()
        if state:
            post_data = urllib.parse.urlencode(state['data'])
            post_hdrs = {
                'Cookie': '; '.join(f'{k}={v}' for k, v in state['cookies'].items()),
                'Referer': safego_url,
                'Origin': 'https://safego.cc',
                'Content-Type': 'application/x-www-form-urlencoded',
            }
            stp, _hp, rawp = http(safego_url, 'POST', post_data, post_hdrs, via_proxy=True)
            if stp == 200:
                bodyp = rawp.decode('utf-8', 'replace')
                if ADELTA_RE.search(bodyp) and not _is_captcha_page(bodyp):
                    body = bodyp
        # Se lo state non c'era o non ha funzionato, GET normale + OCR inline.
        if body is None:
            st, hdrs, raw = http(safego_url, 'GET', via_proxy=True)
            body = raw.decode('utf-8', 'replace')
        m = ADELTA_RE.search(body)
        if not m:
            if _is_captcha_page(body):
                solved = _solve_captcha_inline(safego_url, 'captch5', 'https://safego.cc', via_proxy=True, label='clicka')
                if not solved:
                    return {'ok': False, 'error': 'captcha_required'}
                m = ADELTA_RE.search(solved)
                if not m:
                    return {'ok': False, 'error': 'captcha solved but no adelta link in body'}
            else:
                return {'ok': False, 'error': 'no adelta link on safego page'}
        adelta = m.group(0)
    else:
        m = ADELTA_RE.search(url)
        if not m:
            return {'ok': False, 'error': f'unexpected clicka response (status {st}, loc {loc})'}
        adelta = m.group(0)
    st, hdrs, _raw = http(adelta, 'GET', via_proxy=True, headers={'Referer': 'https://safego.cc/'})
    loc = hdrs.get('location')
    if not loc or 'deltabit.co' not in loc:
        return {'ok': False, 'error': f'no deltabit redirect (status {st}, loc {loc})'}
    return {'ok': True, 'kind': 'deltabit', 'deltabit': loc}


# ---------------------------------------------------------------------------
# WARMUP — solves captcha with spaced retries (background only)
# ---------------------------------------------------------------------------

def _captcha_solve_attempt(url, field, origin, via_proxy):
    st, hdrs, raw = http(url, 'GET', via_proxy=via_proxy)
    if st != 200:
        return {'ok': False, 'error': f'GET status {st}'}
    body = raw.decode('utf-8', 'replace')
    if UPROTS_RE.search(body) or ADELTA_RE.search(body):
        return {'ok': True, 'body': body, 'already_open': True, 'cookies': {}, 'data': {}}
    cookie = cookies_from(hdrs)
    png = _extract_captcha_png(body)
    if not png:
        return {'ok': False, 'error': 'no captcha png on GET'}
    guess = _ocr_one(png)
    if not guess:
        return {'ok': False, 'error': 'OCR produced no candidate'}
    post_data = {field: guess}
    post_body = urllib.parse.urlencode(post_data)
    post_hdrs = {
        'Cookie': cookie,
        'Referer': url,
        'Origin': origin,
        'Content-Type': 'application/x-www-form-urlencoded',
    }
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


def warmup_uprot(url):
    diag = {'attempts': []}
    print(f'warmup_uprot start url={url} max_attempts={WARMUP_MAX_ATTEMPTS}', file=sys.stderr, flush=True)
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
            # Salva state (cookies + POST data) per riuso runtime sui link msfi/msei.
            if r.get('cookies') or r.get('data'):
                _uprot_state_save(r.get('cookies'), r.get('data'))
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
        st, hdrs, _raw = http(url, 'GET', via_proxy=True)
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
            # Salva state (cookies + POST data) per riuso runtime sui link clicka/safego.
            if r.get('cookies') or r.get('data'):
                _clicka_state_save(r.get('cookies'), r.get('data'))
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
    st, _hdrs, raw = http(url, 'GET')
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--resolve', help='URL to resolve (fast path, no captcha)')
    ap.add_argument('--warmup', help='URL for warmup (OCR captcha solve)')
    ap.add_argument('--folder', help='Folder URL to parse (uprot /msfld/)')
    args = ap.parse_args()
    try:
        if args.folder:
            print(json.dumps(parse_folder(args.folder))); return
        if args.warmup:
            print(json.dumps(warmup(args.warmup))); return
        if args.resolve:
            print(json.dumps(resolve(args.resolve))); return
    except Exception as e:
        print(json.dumps({'ok': False, 'error': f'exception: {e}'}))
        return
    ap.print_help()
    sys.exit(2)


if __name__ == '__main__':
    main()
