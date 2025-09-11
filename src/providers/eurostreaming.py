#!/usr/bin/env python3 
"""
Script adattato a streamvix da https://github.com/UrloMythus/MammaMia/blob/main/Src/API/eurostreaming.py
grazie @urlomythus
Eurostreaming provider
 
Modalità e variabili di configurazione (DEFAULT: metodo avanzato):

1) Metodo di ricerca episodi
    - ES_SEARCH_MODE=advanced  (default se non impostato)
         * Matching multi‑fase: exact -> strict -> fallback
         * Normalizzazione titolo (accenti rimossi, stopwords filtrate)
         * Confronto token + sequence ratio + controllo sostituzione (Levenshtein distanza <=1)
         * Più pattern episodio supportati: 1×01, 1x01, 1 x 01, S01E01, S1E1, 1&#215;01 ecc.
         * Debug dettagliato: candidates, matched, rejected, phase, ratio_seq/token
    - ES_SEARCH_MODE=legacy
         * Vecchia logica minimale: singolo pattern "{season}&#215;{episode}" e controllo anno basilare
         * Nessun ranking avanzato; meno pattern episodio.

2) Recupero metadata titolo/anno da IMDb
    - TMDB_KEY=<api_key> abilita uso TMDb (endpoint /find) per risolvere (titolo ITA se disponibile + year)
    - ES_INFO_MODE=tmdb    forza TMDb (se TMDB_KEY presente, altrimenti fallback scrape)
    - ES_INFO_MODE=scrape  forza scraping diretto pagina IMDb
    - ES_INFO_MODE (vuoto / altro) AUTO: usa TMDb se disponibile, altrimenti scrape.

3) Debug
    - ES_DEBUG=1 abilita log verbose su stderr (stdout resta JSON pulito)

4) Parametro MFP (CLI --mfp)
    - Se =1 per MixDrop ritorna direttamente l'embed senza (eventuale) risoluzione JS aggiuntiva.
    - Default 0.

5) Esempi CLI
    - Ricerca avanzata (default):
         TMDB_KEY=... ES_DEBUG=1 python eurostreaming.py --imdb tt0157246 --season 11 --episode 1 --debug 1
    - Forzare legacy:
         ES_SEARCH_MODE=legacy python eurostreaming.py --imdb tt0157246 --season 11 --episode 1
    - Forzare scraping IMDb ignorando TMDb:
         ES_INFO_MODE=scrape python eurostreaming.py --imdb tt13443470 --season 1 --episode 1

Output JSON principale:
    {
      "streams": [ { url, title, player, lang, match_pct } ],
      "diag": { reason, title, imdb_tokens, matched_posts, candidates, rejected, ... }
    }

Note:
 - I film (solo ID IMDb senza season/episode) non sono supportati (reason=is_movie).
 - match_pct deriva dal ratio_seq del post scelto (solo metodo advanced).
 - I log OCR/captcha appaiono solo con ES_DEBUG=1.
"""
# Eurostreaming provider (MammaMia-style, 1:1 functions) with curl_cffi + fake_headers
import re, os, json, base64, time, random, asyncio, sys, unicodedata, html
import difflib
from typing import Dict, Tuple, Optional

from bs4 import BeautifulSoup, SoupStrainer  # type: ignore
try:
    import lxml  # type: ignore  # noqa: F401
    _HAVE_LXML = True
except Exception:
    _HAVE_LXML = False
try:
    from fake_headers import Headers  # type: ignore
except Exception:
    # Fallback minimal Headers generator if dependency missing (avoids hard failure)
    class Headers:  # type: ignore
        _UAS = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
            'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0'
        ]
        def generate(self):
            import random
            return {
                'User-Agent': random.choice(self._UAS),
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.8,it;q=0.7',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive'
            }
try:
    import pytesseract  # type: ignore
    from PIL import Image  # type: ignore
    _HAVE_PYTESSERACT = True
except Exception:
    pytesseract = None  # type: ignore
    Image = None  # type: ignore
    _HAVE_PYTESSERACT = False

# Detect presence of the external "tesseract" binary (required by pytesseract)
_HAVE_TESSERACT_BIN = False
if _HAVE_PYTESSERACT:
    try:
        # get_tesseract_version() raises if binary missing
        pytesseract.get_tesseract_version()
        _HAVE_TESSERACT_BIN = True
    except Exception:  # pragma: no cover
        _HAVE_TESSERACT_BIN = False
        # We'll log later only if ES_DEBUG enabled to avoid noise

try:
    from curl_cffi.requests import AsyncSession  # type: ignore
except Exception:
    AsyncSession = None  # type: ignore

# Domain loaded from config/domains.json (key "eurostreaming") with fallback
def _load_es_domain():
    base = 'https://eurostreaming.garden'
    try:
        # File reale è nella root del progetto: ../../.. dal file corrente porta a project root
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        cfg_path = os.path.join(project_root, 'config', 'domains.json')
        if os.path.exists(cfg_path):
            import json as _json
            with open(cfg_path, 'r', encoding='utf-8') as fh:
                data = _json.load(fh)
                dom = data.get('eurostreaming')
                if isinstance(dom, str) and dom.strip():
                    if not dom.startswith('http'):
                        dom = 'https://' + dom.strip().strip('/')
                    base = dom.rstrip('/')
    except Exception:  # pragma: no cover
        pass
    return base

ES_DOMAIN = _load_es_domain()
_ES_LAST_CHECK = 0.0  # epoch ms
_ES_TTL = 12 * 60 * 60  # 12 ore in secondi

def ensure_es_domain(force: bool = False):
    """Ricarica il dominio da config ogni 12 ore (come strategia CB01) senza env e senza fallback multipli.
    Aggiorna ES_DOMAIN solo se cambia.
    """
    global ES_DOMAIN, _ES_LAST_CHECK
    now = time.time()
    if not force and (now - _ES_LAST_CHECK) < _ES_TTL:
        return ES_DOMAIN
    new_dom = _load_es_domain()
    if new_dom != ES_DOMAIN:
        ES_DOMAIN = new_dom
        log('domain refresh ->', ES_DOMAIN)
    _ES_LAST_CHECK = now
    return ES_DOMAIN

# Proxies / ForwardProxy simplified (disabled by default)
proxies: Dict[str, str] = {}
ForwardProxy = ""

random_headers = Headers()

# Chosen parser (fallback to stdlib if lxml missing)
_PARSER = 'lxml' if _HAVE_LXML else 'html.parser'

# Simple logger gated by ES_DEBUG env
def log(*args):
    if os.environ.get('ES_DEBUG', '0') in ('1', 'true', 'True'):
        # Send debug logs to stderr so stdout stays clean JSON
        print('[ES]', *args, file=sys.stderr)
log('init domain', ES_DOMAIN)

# ========= Utilities (re-implemented minimal) ========= #
async def is_movie(id_value: str) -> Tuple[int, str, Optional[int], Optional[int]]:
    """Return (ismovie, clean_id, season, episode).
    Accepts formats like 'tt19381692:1:6'. If season/episode present => series (ismovie=0)."""
    season = episode = None
    clean = id_value
    if ':' in id_value:
        parts = id_value.split(':')
        clean = parts[0]
        if len(parts) >= 3:
            try:
                season = int(parts[1])
                episode = int(parts[2])
            except Exception:
                season = episode = None
    ismovie = 1 if (season is None or episode is None) else 0
    return ismovie, clean, season, episode

async def get_info_imdb_scrape(clean_id: str, ismovie: int, _type: str, client) -> Tuple[str, int]:
    """Scrape IMDb page (fallback mode)."""
    title = clean_id
    year = 0
    try:
        log('imdb(scrape): fetching', clean_id)
        r = await client.get(f'https://www.imdb.com/title/{clean_id}/')
        if r.status_code == 200:
            m = re.search(r'<title>([^<]+)</title>', r.text, re.I)
            if m:
                full = m.group(1)
                t = re.sub(r'\s*-\s*IMDb.*$', '', full).strip()
                ym = re.search(r'\((\d{4})\)', t)
                if ym:
                    year = int(ym.group(1))
                    t = re.sub(r'\((\d{4})\)', '', t).strip()
                title = re.sub(r'\s*\([^)]*\)\s*$', '', t).strip()
                log('imdb(scrape): title/year ->', title, year)
    except Exception:
        pass
    return title, year

def get_info_tmdb(clean_id: str, ismovie: int, _type: str):
    # Not used in our flow; return placeholders
    return (clean_id, 0)

# ==== Optional TMDb-based metadata (user provided pattern) ===== #
TMDB_KEY = os.environ.get('TMDB_KEY')

async def get_info_imdb_tmdb(imdb_id: str, ismovie: int, _type: str, client) -> Tuple[str, int]:
    """Use TMDb 'find' endpoint to resolve IMDb id to (title, year) if API key present."""
    if not TMDB_KEY:
        return await get_info_imdb_scrape(imdb_id, ismovie, _type, client)
    try:
        resp = await client.get(f'https://api.themoviedb.org/3/find/{imdb_id}?api_key={TMDB_KEY}&language=it&external_source=imdb_id')
        data = resp.json()
        if ismovie == 0:
            arr = data.get('tv_results') or []
            if not arr:
                return await get_info_imdb_scrape(imdb_id, ismovie, _type, client)
            show = arr[0]
            name = show.get('name') or imdb_id
            date_full = (show.get('first_air_date') or '').split('-')[0]
            year = int(date_full) if date_full.isdigit() else 0
            return name, year
        else:
            arr = data.get('movie_results') or []
            if not arr:
                return await get_info_imdb_scrape(imdb_id, ismovie, _type, client)
            show = arr[0]
            name = show.get('title') or imdb_id
            date_full = (show.get('release_date') or '').split('-')[0]
            year = int(date_full) if date_full.isdigit() else 0
            return name, year
    except Exception as e:  # pragma: no cover
        log('imdb(tmdb): fallback scrape due to', e)
        return await get_info_imdb_scrape(imdb_id, ismovie, _type, client)

# Environment toggle: ES_INFO_MODE = scrape|tmdb (default auto: tmdb if key else scrape)
def _choose_imdb_info_func():
    mode = os.environ.get('ES_INFO_MODE', '').lower()
    if mode == 'scrape':
        return get_info_imdb_scrape
    if mode == 'tmdb':
        return get_info_imdb_tmdb
    # auto
    return get_info_imdb_tmdb if TMDB_KEY else get_info_imdb_scrape

get_info_imdb = _choose_imdb_info_func()  # initial alias (may be re-evaluated after CLI)

# ========= Core host resolvers ========= #
async def mixdrop(url, MFP, client):
    """Extract Mixdrop URL (simplified)."""
    log('mixdrop: in', url, 'MFP=', MFP)
    if "club" in url:
        url = url.replace("club", "cv").split("/2")[0]
    if "cfd" in url:
        url = url.replace("cfd", "cv").replace("emb","e").split("/2")[0]
    # Se MFP=1 restituiamo l'URL base (lo wrapperemo più avanti nel build finale in formato extractor)
    if str(MFP) == "1":
        log('mixdrop: MFP=1 base url ->', url)
        return url, ""
    # Senza MFP: ritorna diretto (nessun wrapping)
    log('mixdrop: returning direct (no MFP) ->', url)
    return url, ""

async def deltabit(page_url, client):
    """Extract Deltabit MP4 (XFileSharing pattern) with bounded async retries.

    Evita ricorsione e blocking sleep: usa loop + asyncio.sleep.
    Ritorna (url|None, filename).
    """
    # Perform exactly one attempt (user request: try DeltaBit first once, then fallback to MixDrop)
    max_attempts = 1
    attempt = 0
    fname = ''
    # Allow overriding wait via env (seconds)
    try:
        _wait_base = float(os.environ.get('ES_DELTABIT_WAIT', '2.5'))
    except Exception:
        _wait_base = 2.5
    while attempt < max_attempts:
        attempt += 1
        headers = random_headers.generate()
        headers2 = random_headers.generate()
        log(f'deltabit: attempt {attempt} initial {page_url}')
        try:
            page_url_response = await client.get(ForwardProxy + page_url, headers={**headers, 'Range': 'bytes=0-0'}, proxies=proxies)
            page_url = page_url_response.url
            log('deltabit: redirected url', page_url)
            headers2['referer'] = 'https://safego.cc/'
            headers2['user-agent'] = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
            response = await client.get(ForwardProxy + page_url, headers=headers2, allow_redirects=True, proxies=proxies)
            page_url = response.url
            log('deltabit: final page url', page_url)
            origin = page_url.split('/')[2]
            headers['origin'] = f'https://{origin}'
            headers['referer'] = page_url
            headers['user-agent'] = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
            soup = BeautifulSoup(response.text, _PARSER, parse_only=SoupStrainer('input'))
            data = {}
            for inp in soup:
                name = inp.get('name')
                value = inp.get('value')
                data[name] = value
            data['imhuman'] = ''
            data['referer'] = page_url
            wait_time = _wait_base + (0.15 * (attempt-1))  # small incremental backoff
            log(f'deltabit: waiting {wait_time:.2f}s before POST (async)')
            await asyncio.sleep(wait_time)
            fname = data.get('fname', '')
            response = await client.post(ForwardProxy + page_url, data=data, headers=headers, proxies=proxies)
            # Support multiple possible player markup patterns (site can change)
            patterns = [
                r'sources:\s*\["([^"\\]+)"',    # sources:["URL"]
                r'file:\s*"([^"\\]+)"',          # file:"URL"
                r'src:\s*"([^"\\]+)"',           # src:"URL"
                r'<source[^>]+src="([^"\\]+)"'    # <source src="URL">
            ]
            found_url = None
            for pat in patterns:
                m = re.search(pat, response.text, re.DOTALL | re.IGNORECASE)
                if m and m.group(1).startswith('http'):
                    found_url = m.group(1)
                    break
            if not found_url:
                # One quick second-chance re-POST after extra 0.9s (sometimes server timer)
                log('deltabit: no source first POST, retrying once after short wait')
                await asyncio.sleep(0.9)
                response2 = await client.post(ForwardProxy + page_url, data=data, headers=headers, proxies=proxies)
                for pat in patterns:
                    m2 = re.search(pat, response2.text, re.DOTALL | re.IGNORECASE)
                    if m2 and m2.group(1).startswith('http'):
                        found_url = m2.group(1)
                        break
            if found_url:
                log('deltabit: got source', found_url)
                return found_url, fname
            log('deltabit: no sources found (attempt)', attempt)
        except Exception as e:
            log('deltabit: exception', e)
        if attempt < max_attempts:
            await asyncio.sleep(0.8)
    log('deltabit: exhausted attempts')
    return None, fname

from io import BytesIO

def convert_numbers(base64_data):
    """Return OCR digits or '' if unavailable.

    We explicitly distinguish 3 states:
      1) pytesseract+binary OK -> return extracted digits
      2) pytesseract module present but binary missing -> '' (log hint)
      3) pytesseract module absent -> '' (log hint)
    """
    if not base64_data:
        return ""
    if not _HAVE_PYTESSERACT:
        log('ocr: pytesseract module not installed (install via pip + system package tesseract-ocr)')
        return ""
    if not _HAVE_TESSERACT_BIN:
        log('ocr: tesseract binary missing. Install it (e.g. apt install -y tesseract-ocr tesseract-ocr-ita)')
        return ""
    if not Image:
        log('ocr: PIL (pillow) not available')
        return ""
    try:
        image_data = base64.b64decode(base64_data)
        image = Image.open(BytesIO(image_data))
        custom_config = r'--oem 3 --psm 6 outputbase digits'
        number_string = pytesseract.image_to_string(image, config=custom_config)
        number_string = number_string.strip()
        log('ocr: raw result ->', number_string)
        # Keep only digits just in case OCR leaks stray chars
        number_string = re.sub(r'\D+', '', number_string)
        return number_string
    except Exception as e:  # pragma: no cover
        log('ocr: exception', e)
        return ""

async def get_numbers(safego_url, client):
    log('safego:get_numbers', safego_url)
    headers = random_headers.generate()
    headers['User-Agent'] = 'Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0'
    response = await client.get(ForwardProxy + safego_url, headers=headers, proxies=proxies)
    cookies = (response.cookies.get_dict())
    soup = BeautifulSoup(response.text, _PARSER, parse_only=SoupStrainer('img'))
    img = soup.img if soup else None
    if not img or not img.get('src'):
        log('safego:get_numbers: no captcha image found')
        return "", cookies
    numbers = img['src'].split(',')[1]
    return numbers, cookies

async def real_page(safego_url, client):
    try:
        current_directory = os.path.dirname(os.path.abspath(__file__))
        file_path = os.path.join(current_directory, 'cookie.txt')
        log('safego: real_page', safego_url, 'cookie_file=', file_path)
        headers = random_headers.generate()
        headers['Origin'] = 'https://safego.cc'
        headers['Referer'] = safego_url
        headers['User-Agent'] = 'Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0'
        cookies = {}
        if os.path.exists(file_path):
            with open(file_path, 'r') as file:
                cookies_raw = file.read().strip()
                if cookies_raw:
                    cookies = json.loads(cookies_raw.replace("'", '"'))
        response = await client.post(ForwardProxy + safego_url, headers=headers, cookies=cookies, proxies=proxies)
        soup = BeautifulSoup(response.text, _PARSER, parse_only=SoupStrainer('a'))
        if soup and len(soup) >= 1 and soup.a and soup.a.get('href'):
            log('safego: proceed href (cached cookies)')
            return soup.a['href']
        # Try OCR up to 2 times
        for attempt in range(2):
            log('safego: need captcha, fetching numbers (attempt', attempt+1, ')')
            numbers, cookies = await get_numbers(safego_url, client)
            numbers = convert_numbers(numbers)
            log('safego: ocr ->', numbers)
            data = {'captch4': numbers}
            response = await client.post(ForwardProxy + safego_url, headers=headers, data=data, cookies=cookies, proxies=proxies)
            cap4 = response.headers.get('set-cookie', '')
            if cap4:
                cap4 = cap4.split(';')[0]
                cookies[cap4.split('=')[0]] = cap4.split('=')[1]
                with open(file_path, 'w') as file:
                    file.write(str(cookies))
            soup = BeautifulSoup(response.text, _PARSER, parse_only=SoupStrainer('a'))
            if soup and len(soup) >= 1 and soup.a and soup.a.get('href'):
                log('safego: proceed href (after captcha)')
                return soup.a['href']
        log('safego: captcha failed after retries')
        return None
    except Exception as e:
        log('real_page: exception', e)

async def get_host_link(pattern, atag, client):
    match = re.search(pattern, atag)
    headers = random_headers.generate()
    if not match:
        log('get_host_link: pattern not found')
        return None
    href_value = match.group(1)
    log('get_host_link: clicka', href_value)
    response = await client.head(ForwardProxy + href_value, headers={**headers, 'Range': 'bytes=0-0'}, proxies=proxies)
    href_value = response.url
    log('get_host_link: safego', href_value)
    href = await real_page(href_value, client)
    log('get_host_link: host page', href)
    return href

async def resolve_clicka_to_host(href_value, client):
    headers = random_headers.generate()
    if not href_value:
        return None
    href_value = str(href_value).strip()
    log('get_host_link: clicka', href_value)
    response = await client.get(ForwardProxy + href_value, headers={**headers, 'Range': 'bytes=0-0'}, allow_redirects=True, proxies=proxies)
    safego_url = response.url
    if isinstance(safego_url, str):
        safego_url = safego_url.strip()
    log('get_host_link: safego', safego_url)
    href = await real_page(safego_url, client)
    log('get_host_link: host page', href)
    return href

async def scraping_links(atag, MFP, client):
    """Raccoglie TUTTI i link DeltaBit e MixDrop (entrambi).

    Return:
        list[ (url, name, hostType) ]  hostType in {'deltabit','mixdrop'}.
        Mantiene l'ordine: prima tutti i DeltaBit risolti nell'ordine trovato, poi i MixDrop.
    """
    log('scraping_links: in', ('...' if len(atag)>120 else atag))
    soup = BeautifulSoup(atag, _PARSER, parse_only=SoupStrainer('a'))
    if not soup:
        return []
    # Store tuples (href, anchor_text_original)
    delta_raw = []
    mix_raw = []
    for a in soup:
        original_text = a.get_text(strip=True) or ''
        text = original_text.lower()
        href = a.get('href')
        if not href:
            continue
        combo = f"{text} {href.lower()}"
        if 'deltabit' in combo:
            delta_raw.append((href, original_text))
        elif 'mixdrop' in combo:
            mix_raw.append((href, original_text))
    results = []
    # DeltaBit first (collect all)
    seen = set()
    for raw, anchor_text in delta_raw:
        if raw in seen:
            continue
        seen.add(raw)
        try:
            resolved = await resolve_clicka_to_host(raw, client)
            if not resolved:
                continue
            url, name = await deltabit(resolved, client)
            if url:
                # Prefer extracted filename (name) else fallback to anchor text
                results.append((url, name or anchor_text, 'deltabit'))
        except Exception as e:
            log('scraping_links: delta error', e)
    # MixDrop (collect all distinct)
    seen_mix = set()
    for raw, anchor_text in mix_raw:
        if raw in seen_mix:
            continue
        seen_mix.add(raw)
        try:
            resolved = await resolve_clicka_to_host(raw, client)
            if not resolved:
                continue
            url, name = await mixdrop(resolved, MFP, client)
            if url:
                # Mixdrop returns (url, '') so use anchor text if name empty
                results.append((url, name or anchor_text, 'mixdrop'))
        except Exception as e:
            log('scraping_links: mixdrop error', e)
    if results:
        log('scraping_links: collected hosts', len(results))
    else:
        log('scraping_links: no supported hosts found')
    return results

STOPWORDS = {
    'the','la','le','lo','gli','i','il','di','da','a','in','of','and','or','serie','series','season','show','tv','la','una','un','uno','del','della','degli','delle','de','el',
    # aggiunte per evitare interferenze con entità HTML / codici
    'amp','038'
}

def _normalize_title(t: str) -> str:
    # Unicode normalize + strip accents so 'Mercoledì' -> 'Mercoledi'
    if not t:
        return ''
    # Decode common HTML entities (&amp; -> &; &#038; -> & etc.) then remove '&'
    t = html.unescape(t)
    t = unicodedata.normalize('NFD', t)
    t = ''.join(ch for ch in t if unicodedata.category(ch) != 'Mn')
    t = t.lower()
    # Remove residual named entities &word; and numeric &#123; forms
    t = re.sub(r'&[#a-z0-9]+;?', ' ', t)
    t = re.sub(r'[^a-z0-9]+', ' ', t)           # punctuation / non-ascii -> space
    t = re.sub(r'\s+', ' ', t).strip()
    return t

def _token_list(t: str) -> list:
    if not t:
        return []
    return [tok for tok in _normalize_title(t).split() if tok and (tok not in STOPWORDS) and (len(tok) > 2 or tok.isdigit())]

def _token_set(t: str) -> set:
    return set(_token_list(t))

# Simple Levenshtein distance (iterative, O(min(n,m)) space)
def _levenshtein(a: str, b: str) -> int:
    if a == b:
        return 0
    la, lb = len(a), len(b)
    if la == 0:
        return lb
    if lb == 0:
        return la
    # Ensure a is shorter
    if la > lb:
        a, b = b, a
        la, lb = lb, la
    prev = list(range(la + 1))
    for j in range(1, lb + 1):
        cur = [j] + [0]*la
        bj = b[j-1]
        for i in range(1, la + 1):
            cost = 0 if a[i-1] == bj else 1
            cur[i] = min(prev[i] + 1,      # deletion
                         cur[i-1] + 1,     # insertion
                         prev[i-1] + cost) # substitution
        prev = cur
    return prev[la]

#############################################
# ADVANCED SEARCH (current default)
# Can be forced via ES_SEARCH_MODE=advanced
#############################################
async def search_advanced(showname, date, season, episode, MFP, client):
    headers = random_headers.generate()
    log('search: query', showname, 'year', date, 'S', season, 'E', episode)
    reason = None
    debug = { 'candidates': [], 'matched': [], 'filtered_tokens': [], 'rejected': [], 'phase': None }
    try:
        response = await client.get(ForwardProxy + f"{ES_DOMAIN}/wp-json/wp/v2/search?search={showname}&_fields=id", proxies=proxies, headers=headers)
    except Exception as e:
        log('search: wp search exception', e)
        return None, 'search_request_failed', debug
    results = response.json()
    if not isinstance(results, list) or not results:
        log('search: no results')
        return None, 'no_search_results', debug
    log('search: ids', [r.get('id') for r in results])
    imdb_tokens = _token_set(showname.replace('+', ' '))
    debug['imdb_tokens'] = sorted(list(imdb_tokens))
    matched_any_title = False
    imdb_tokens_list = list(imdb_tokens)
    first_token = imdb_tokens_list[0] if imdb_tokens_list else None
    imdb_norm_title = _normalize_title(showname.replace('+',' '))

    # We'll accumulate all posts first, then decide phase (strict vs fallback) and only then parse episode rows
    posts_data = []  # each entry: { 'id', 'title', 'description', metrics..., 'strict_ok', 'fallback_ok', 'year' }

    for i in results:
        try:
            response = await client.get(ForwardProxy + f"{ES_DOMAIN}/wp-json/wp/v2/posts/{i['id']}?_fields=title,content", proxies=proxies, headers=headers)
        except Exception as e:  # pragma: no cover
            log('search: post fetch exception', i.get('id'), e)
            continue
        if f'ID articolo non valido' in response.text:
            continue
        jp = response.json()
        description = jp.get('content', {}).get('rendered', '')
        post_title = jp.get('title', {}).get('rendered', '')
        cleaned_post_title = re.sub(r'\([^)]*\)', ' ', post_title)
        norm_post_title = _normalize_title(cleaned_post_title)
        post_tokens = _token_set(cleaned_post_title)
        inter = imdb_tokens & post_tokens
        significant_overlap = [tok for tok in inter]
        token_match_ratio = (len(inter) / max(1, len(imdb_tokens))) if imdb_tokens else 0
        seq_ratio = difflib.SequenceMatcher(None, _normalize_title(showname.replace('+',' ')), norm_post_title).ratio() if showname else 0.0
        year = None
        title_ok = False
        if len(imdb_tokens) == 1:
            single_tok = imdb_tokens_list[0]
            has_token = (len(inter) == 1)
            if has_token:
                paren_relax = ('(' in post_title and ')' in post_title and len(single_tok) >= 6)
                if seq_ratio >= 0.85:
                    title_ok = True
                elif len(single_tok) >= 6 and seq_ratio >= 0.67:
                    title_ok = True
                elif paren_relax and seq_ratio >= 0.60:
                    title_ok = True
        else:
            has_first = (first_token in post_tokens) if first_token else False
            if has_first and len(significant_overlap) >= 2 and seq_ratio >= 0.55:
                title_ok = True
            elif token_match_ratio >= 0.7 and has_first:
                title_ok = True
            elif seq_ratio >= 0.85 and has_first:
                title_ok = True
        strict_ok = False
        if len(imdb_tokens) > 1:
            if post_tokens == imdb_tokens or norm_post_title == imdb_norm_title:
                strict_ok = True
            else:
                sym_diff = (post_tokens ^ imdb_tokens)
                if len(sym_diff) == 1:
                    strict_ok = True
        if strict_ok and len(post_tokens) == len(imdb_tokens) and len(post_tokens & imdb_tokens) == len(imdb_tokens) - 1:
            strict_ok = False
        fallback_ok = title_ok
        posts_data.append({
            'id': i['id'],
            'title': post_title,
            'description': description,
            'norm_title': norm_post_title,
            'tokens': post_tokens,
            'overlap': inter,
            'ratio_token': token_match_ratio,
            'ratio_seq': seq_ratio,
            'strict_ok': strict_ok,
            'fallback_ok': fallback_ok,
            'year': year
        })
        cand_entry = {
            'post_id': i['id'],
            'title': post_title,
            'ratio_token': round(token_match_ratio,2),
            'ratio_seq': round(seq_ratio,2),
            'overlap': sorted(list(inter)),
            'strict_ok': strict_ok,
            'fallback_ok': fallback_ok
        }
        debug['candidates'].append(cand_entry)
        year_pattern = re.compile(r'(?<!/)(19|20)\d{2}(?!/)')
        match_year = year_pattern.search(description)
        if match_year:
            posts_data[-1]['year'] = match_year.group(0)
        if not posts_data[-1]['year']:
            pattern = r'<a\s+href="([^"]+)"[^>]*>Continua a leggere</a>'
            match_more = re.search(pattern, description)
            if match_more:
                href_value = match_more.group(1)
                try:
                    response_2 = await client.get(ForwardProxy + href_value, proxies=proxies, headers=headers)
                    match2 = year_pattern.search(response_2.text)
                    if match2:
                        posts_data[-1]['year'] = match2.group(0)
                except Exception:
                    pass
        log('search: post', i['id'], 'post_title=', norm_post_title, 'token_ratio', f"{token_match_ratio:.2f}")

    # Phase 0: exact normalized title matches (full string equality) - highest priority
    exact_matches = [p for p in posts_data if p['norm_title'] == imdb_norm_title]
    chosen = []
    if exact_matches:
        debug['phase'] = 'exact'
        chosen = exact_matches
    else:
        # Decide phase: prefer strict matches (token set equality or near) if any
        strict_matches = [p for p in posts_data if p['strict_ok']]
        if strict_matches:
            debug['phase'] = 'strict'
            chosen = strict_matches
        else:
            # fallback phase
            debug['phase'] = 'fallback'
            for p in posts_data:
                if not p['fallback_ok']:
                    continue
                # Levenshtein-based single-token substitution penalty
                if len(imdb_tokens) > 1 and len(p['tokens']) == len(imdb_tokens) and len(p['tokens'] & imdb_tokens) == len(imdb_tokens)-1:
                    diff_tokens = list(p['tokens'] ^ imdb_tokens)
                    if len(diff_tokens) == 2:
                        dist = _levenshtein(diff_tokens[0], diff_tokens[1])
                        if dist > 1:  # allow only typo-level (distance 1) differences
                            debug['rejected'].append({
                                'post_id': p['id'],
                                'title': p['title'],
                                'reason': f'replacement_distance({dist})',
                                'ratio_token': round(p['ratio_token'],2),
                                'ratio_seq': round(p['ratio_seq'],2),
                                'overlap': sorted(list(p['overlap']))
                            })
                            continue
                chosen.append(p)

    # Populate matched / rejected debug lists
    for p in posts_data:
        if p in chosen:
            matched_any_title = True
            debug['matched'].append({
                'post_id': p['id'],
                'title': p['title'],
                'tokens': sorted(list(p['tokens'])),
                'overlap': sorted(list(p['overlap'])),
                'ratio_token': round(p['ratio_token'],2),
                'ratio_seq': round(p['ratio_seq'],2),
                'phase': debug['phase']
            })
        else:
            # Avoid double-adding entries already in rejected (like explicit substitution conflict)
            already = any(r.get('post_id') == p['id'] for r in debug['rejected'])
            if not already:
                rej_reason = 'title_mismatch'
                if len(imdb_tokens) == 1 and len(p['overlap']) == 1:
                    # Use double quotes inside f-string to avoid quote collision causing SyntaxError
                    rej_reason = f"single_token_low_seq({p['ratio_seq']:.2f})"
                # Extra context: if near substitution with distance <=1 but still not chosen (e.g. year mismatch later), tag
                if len(imdb_tokens) > 1 and len(p['tokens']) == len(imdb_tokens) and len(p['tokens'] & imdb_tokens) == len(imdb_tokens)-1:
                    diff_tokens = list(p['tokens'] ^ imdb_tokens)
                    if len(diff_tokens) == 2:
                        dist = _levenshtein(diff_tokens[0], diff_tokens[1])
                        rej_reason += f'_replacement_dist({dist})'
                debug['rejected'].append({
                    'post_id': p['id'],
                    'title': p['title'],
                    'overlap': sorted(list(p['overlap'])),
                    'ratio_token': round(p['ratio_token'],2),
                    'ratio_seq': round(p['ratio_seq'],2),
                    'reason': rej_reason
                })

    if not chosen:
        return None, 'no_title_match', debug

    # Now attempt episode extraction over chosen posts
    ep_str = str(episode).zfill(2)
    # Episode line patterns: include multiple variants (HTML entity ×, plain x, unicode ×, padded/unpadded, optional spaces)
    # Examples we want to catch: 1×01, 1x01, 1x1, 1 × 01, S01E01, S1E1, 1&#215;01
    patterns = [
        # HTML entity multiplication sign with padded episode
        rf'{season}&#215;{ep_str}\s*(.*?)(?=<br\s*/?>)',
        # HTML entity with unpadded episode
        rf'{season}&#215;{int(episode)}\s*(.*?)(?=<br\s*/?>)',
        # Plain/Unicode x with padded ep (no spaces)
        rf'{season}[xX×]{ep_str}\s*(.*?)(?=<br\s*/?>)',
        # Plain/Unicode x with unpadded ep
        rf'{season}[xX×]{int(episode)}\s*(.*?)(?=<br\s*/?>)',
        # Allow optional spaces around x and optional zero padding on episode
        rf'{season}\s*[xX×]\s*0?{int(episode)}\s*(.*?)(?=<br\s*/?>)',
        # SxxExx padded
        rf'S{int(season):02d}E{ep_str}\s*(.*?)(?=<br\s*/?>)',
        # SxEx (un/padded)
        rf'S{int(season)}E0?{int(episode)}\s*(.*?)(?=<br\s*/?>)',
    ]
    # --- Robust episode extraction with year tolerance & dual pass ---
    # 1) First pass: prefer exact year (if site year present) OR no year present.
    # 2) Second pass (fallback): allow slight year drift (<=1) or any year if still nothing.
    #    This addresses cases like Chicago Fire (site year 2013 vs IMDb 2012) while avoiding gross mismatches.

    def _year_distance(site_year: Optional[str], imdb_year: int) -> Optional[int]:
        try:
            if not site_year or not imdb_year:
                return None
            return abs(int(site_year) - int(imdb_year))
        except Exception:
            return None

    primary_candidates = []  # posts passing strict year (equal) OR missing year
    secondary_candidates = []  # posts with small drift (dist<=1)
    drift_rejected = []  # posts with large drift

    for p in chosen:
        dist = _year_distance(p.get('year'), date)
        if date and p.get('year'):
            if dist == 0:
                primary_candidates.append(p)
            elif dist is not None and dist <= 1:
                secondary_candidates.append(p)
            else:
                drift_rejected.append({'post_id': p['id'], 'post_year': p.get('year'), 'imdb_year': date, 'dist': dist})
        else:
            # No year on site or no imdb year -> treat as primary to keep behavior permissive
            primary_candidates.append(p)

    if drift_rejected:
        debug['year_drift_rejected'] = drift_rejected

    passes = [
        ('primary', primary_candidates),
        ('secondary_year_tolerant', secondary_candidates)
    ]

    # Extend episode patterns with variants that terminate at </div>|</p> if <br> missing (last line of block)
    extra_suffix = r'(?=(?:<br\s*/?>|</div>|</p>))'
    extended_patterns = []
    for base in patterns:
        if base.endswith(')') and base.rfind('(?=') == -1:
            # Insert alternative lookahead if not already present
            extended_patterns.append(base.replace('(?=<br', extra_suffix))
        extended_patterns.append(base)
    # De-duplicate while preserving order
    seen_pat = set()
    final_patterns = []
    for pat in extended_patterns:
        if pat in seen_pat:
            continue
        seen_pat.add(pat)
        final_patterns.append(pat)

    for pass_name, candidate_list in passes:
        for p in candidate_list:
            description = p['description']
            matches = []
            for pat in final_patterns:
                m = re.findall(pat, description)
                if m:
                    matches = m
                    break
            if not matches:
                continue
            urls = {}
            log(f'search: episode rows found (post {p["id"]}) pass={pass_name} count={len(matches)}')
            for episode_details in matches:
                if 'href' not in episode_details:
                    continue
                part = episode_details
                # Normalize dash variants (EN dash / hyphen) and split only on first occurrence
                if ' – ' in part:
                    part = part.split(' – ', 1)[1]
                elif ' - ' in part:
                    part = part.split(' - ', 1)[1]
                # Determina se la riga appartiene a una sezione SUB consultando l'ultimo spoiler-title precedente
                idx_line = description.find(episode_details)
                sub_section_flag = False
                if idx_line != -1:
                    pre = description[:idx_line]
                    titles = re.findall(r'<div class="su-spoiler-title"[^>]*>(.*?)</div>', pre, re.IGNORECASE|re.DOTALL)
                    if titles:
                        last_title = titles[-1]
                        last_title_txt = html.unescape(re.sub(r'<[^>]+>', ' ', last_title)).lower()
                        norm_title = re.sub(r'[^a-z0-9]+', ' ', last_title_txt)
                        tokens_title = set(norm_title.split())
                        if 'sub' in tokens_title:  # 'sub', 'sub', 'sub ita', '(SUB ITA)' ecc.
                            sub_section_flag = True
                host_list = await scraping_links(part, MFP, client)
                for item in host_list:
                    if not item or not isinstance(item, tuple):
                        continue
                    full_url, name, _host_type = item
                    if full_url:
                        # Preserve host type by embedding a sentinel prefix in the stored name so we can recover it later in CLI output.
                        # Format: "__HT__{host}__::{original_name}". This avoids changing the downstream structure mid-search.
                        host_tag = f"__HT__{_host_type}__::"
                        stored_name = name or ''
                        if sub_section_flag and 'sub' not in stored_name.lower():
                            stored_name = (stored_name + ' SUB ITA').strip()
                        urls[full_url] = host_tag + stored_name
            if urls:
                log('search: urls collected', len(urls), 'pass', pass_name)
                debug['used_match_ratio_seq'] = round(p['ratio_seq'],4)
                debug['year_pass'] = pass_name
                return urls, None, debug

    # If we reach here, nothing matched even after tolerant pass
    debug['episode_search_passes'] = {
        'primary_candidates': len(primary_candidates),
        'secondary_candidates': len(secondary_candidates)
    }
    return None, 'no_episode_match', debug

#############################################
# LEGACY SEARCH (simplified year + single pattern)
# Activated with ES_SEARCH_MODE=legacy
# Returns same tuple signature: (urls|None, reason, debug)
#############################################
async def search_legacy(showname, date, season, episode, MFP, client):
    debug = { 'mode': 'legacy', 'year': date }
    headers = random_headers.generate()
    try:
        response = await client.get(ForwardProxy + f"{ES_DOMAIN}/wp-json/wp/v2/search?search={showname}&_fields=id", proxies=proxies, headers=headers)
    except Exception as e:
        debug['error'] = str(e)
        return None, 'search_request_failed', debug
    results = response.json()
    if not isinstance(results, list) or not results:
        return None, 'no_search_results', debug
    season_s = str(season)
    episode_s = str(episode).zfill(2)
    pattern_primary = rf'{season_s}&#215;{episode_s}\s*(.*?)(?=<br\s*/?>)'
    year_pattern = re.compile(r'(?<!/)(19|20)\d{2}(?!/)')
    for i in results:
        try:
            r = await client.get(ForwardProxy + f"{ES_DOMAIN}/wp-json/wp/v2/posts/{i['id']}?_fields=content", proxies=proxies, headers=headers)
        except Exception:
            continue
        if 'ID articolo non valido' in r.text:
            continue
        try:
            desc = r.json().get('content', {}).get('rendered', '')
        except Exception:
            continue
        # Year extraction
        match_year = year_pattern.search(desc)
        post_year = None
        if match_year:
            post_year = match_year.group(0)
        else:
            more = re.search(r'<a\s+href="([^\"]+)"[^>]*>Continua a leggere</a>', desc)
            if more:
                try:
                    r2 = await client.get(ForwardProxy + more.group(1), proxies=proxies, headers=headers)
                    match2 = year_pattern.search(r2.text)
                    if match2:
                        post_year = match2.group(0)
                except Exception:
                    pass
        if date and post_year and str(post_year) != str(date):
            continue
        matches = re.findall(pattern_primary, desc)
        if not matches:
            continue
        urls = {}
        for ep_details in matches:
            if 'href' not in ep_details:
                continue
            part = ep_details
            if ' – ' in part:
                part = part.split(' – ', 1)[1]
            # Per-episode section context detection
            idx_line = desc.find(ep_details)
            sub_section_flag = False
            if idx_line != -1:
                pre = desc[:idx_line]
                titles = re.findall(r'<div class="su-spoiler-title"[^>]*>(.*?)</div>', pre, re.IGNORECASE|re.DOTALL)
                if titles:
                    last_title = titles[-1]
                    last_title_txt = html.unescape(re.sub(r'<[^>]+>', ' ', last_title)).lower()
                    norm_title = re.sub(r'[^a-z0-9]+', ' ', last_title_txt)
                    tokens_title = set(norm_title.split())
                    if 'sub' in tokens_title:
                        sub_section_flag = True
            host_list = await scraping_links(part, MFP, client)
            for item in host_list:
                if not item or not isinstance(item, tuple):
                    continue
                full_url, name, _host_type = item
                if full_url:
                    host_tag = f"__HT__{_host_type}__::"
                    stored_name = name or ''
                    if sub_section_flag and 'sub' not in stored_name.lower():
                        stored_name = (stored_name + ' SUB ITA').strip()
                    urls[full_url] = host_tag + stored_name
        if urls:
            debug['used_pattern'] = 'primary'
            return urls, None, debug
    return None, 'no_episode_match', debug

# Dispatcher
def _choose_search_fn():
    mode = os.environ.get('ES_SEARCH_MODE', '').lower()
    if mode == 'legacy':
        return search_legacy
    if mode == 'advanced':
        return search_advanced
    return search_advanced  # default

search = _choose_search_fn()

async def eurostreaming(id_value, client, MFP):
    """Main Eurostreaming orchestrator returning (urls|None, reason, debug)."""
    debug: Dict[str, object] = {}
    # Refresh dominio se necessario (TTL 12h)
    ensure_es_domain()
    # Parse id and ensure it's a series (movies unsupported)
    try:
        ismovie, clean_id, season_i, episode_i = await is_movie(id_value)
    except Exception as e:  # pragma: no cover
        return None, 'parse_error', { 'error': str(e) }
    if ismovie == 1 or season_i is None or episode_i is None:
        return None, 'is_movie', { 'note': 'movies not supported' }
    season = str(season_i)
    episode = str(episode_i)
    # Metadata fetch (IMDb via tmdb API or scrape depending on env)
    try:
        if "tmdb" in id_value:
            showname, date = get_info_tmdb(clean_id, 0, "Eurostreaming")
        else:
            showname, date = await get_info_imdb(clean_id, 0, "Eurostreaming", client)
    except Exception as e:  # pragma: no cover
        debug['meta_error'] = str(e)
        showname, date = (clean_id, 0)
    # Normalize title for searching
    showname = re.sub(r'\s+', ' ', showname).strip()
    showname = re.sub(r'[^\w\s]', ' ', showname)
    showname = re.sub(r'\s+', ' ', showname).strip()
    debug['imdb_title'] = showname
    debug['imdb_year'] = date
    log('eurostreaming: title/date', showname, date)
    showname_q = showname.replace(' ', '+')
    try:
        urls, reason, search_debug = await search(showname_q, date, season, episode, MFP, client)
    except Exception as e:  # pragma: no cover
        log('eurostreaming: search exception', e)
        debug['search_error'] = str(e)
        return None, 'search_exception', debug
    if isinstance(search_debug, dict):
        debug.update(search_debug)
    log('eurostreaming: urls_found', 0 if not urls else len(urls), 'reason', reason)
    return urls, reason, debug

# ======== Test helpers ======== #
async def test_euro():
    if AsyncSession is None:
        print("curl_cffi not available")
        return
    async with AsyncSession() as client:
        results = await eurostreaming("tt6156584:4:5", client, 0)
        print(results)

async def test_deltabit():
    if AsyncSession is None:
        print("curl_cffi not available")
        return
    async with AsyncSession() as client:
        results = await deltabit("https://deltabit.co/fgeki2456ab1", client)
        print(results)

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description='Eurostreaming provider (JSON CLI)')
    parser.add_argument('--imdb')
    parser.add_argument('--tmdb')
    parser.add_argument('--season', type=int)
    parser.add_argument('--episode', type=int)
    parser.add_argument('--mfp', default='0')
    parser.add_argument('--movie', action='store_true')
    parser.add_argument('--tmdbKey')
    parser.add_argument('--debug', default='0')
    args = parser.parse_args()
    os.environ['ES_DEBUG'] = args.debug
    async def _run_cli():
        result = { 'streams': [] }
        if args.movie:
            # Always include diagnostics block even for movie early-exit
            result['diag'] = {
                'py': sys.executable,
                'version': sys.version.split()[0],
                'curl_cffi': AsyncSession is not None,
                'pytesseract': _HAVE_PYTESSERACT,
                'tesseract_bin': _HAVE_TESSERACT_BIN,
                'cwd': os.getcwd()
            }
            print(json.dumps(result))
            return
        if AsyncSession is None:
            print(json.dumps({
                'error': 'curl_cffi not available',
                'diag': {
                    'py': sys.executable,
                    'version': sys.version.split()[0],
                    'curl_cffi': False,
                    'pytesseract': _HAVE_PYTESSERACT,
                    'tesseract_bin': _HAVE_TESSERACT_BIN,
                    'cwd': os.getcwd(),
                    'sys_path_head': sys.path[:5]
                }
            }))
            return
        # Apply TMDb key if passed via CLI (overrides existing env) THEN rebind metadata function
        global TMDB_KEY, get_info_imdb
        if args.tmdbKey:
            os.environ['TMDB_KEY'] = args.tmdbKey
            TMDB_KEY = args.tmdbKey
            get_info_imdb = _choose_imdb_info_func()
        idv = None
        if args.imdb:
            idv = args.imdb
        elif args.tmdb:
            # basic support: prefix 'tmdb:' to let is_movie pass; season/episode still apply if provided
            idv = f"tmdb:{args.tmdb}"
        else:
            print(json.dumps(result)); return
        # Attach season/episode only if NOT already embedded (avoid double :S:E)
        if args.season is not None and args.episode is not None:
            parts = idv.split(':')
            # IMDb IDs start with 'tt' or 'tmdb'; if already 3 segments, assume season/ep present
            if len(parts) < 3:
                idv = f"{idv}:{args.season}:{args.episode}"
        async with AsyncSession() as client:
            try:
                res = await eurostreaming(idv, client, args.mfp)
            except Exception as e:  # broad catch to always output JSON
                print(json.dumps({
                    'error': 'provider_exception',
                    'detail': str(e)
                }))
                return
            if isinstance(res, tuple) and len(res) == 3:
                urls, reason, debug = res
            else:
                # backward safety
                urls, reason, debug = (res, None, {})
            streams = []
            if isinstance(urls, dict):
                match_pct = None
                if isinstance(debug, dict) and debug.get('used_match_ratio_seq') is not None:
                    try:
                        match_pct = int(round(float(debug['used_match_ratio_seq']) * 100))
                    except Exception:
                        match_pct = None
                for u, fname in urls.items():
                    if not u:
                        continue
                    raw_name = (fname or '')
                    host_type = 'deltabit'
                    original_name = raw_name
                    # Recover host type if sentinel present
                    m_ht = re.match(r'^__HT__(deltabit|mixdrop)__::(.*)$', raw_name, re.IGNORECASE)
                    if m_ht:
                        host_type = m_ht.group(1).lower()
                        original_name = m_ht.group(2)
                    low = original_name.lower()
                    sub_patterns = [r'\bsub\b', r'subbed', r'subs', r'ita[-_. ]?sub', r'sub[-_. ]?ita']
                    lang = 'ita'
                    for pat in sub_patterns:
                        if re.search(pat, low, re.I):
                            lang = 'sub'
                            break
                    player_label = 'Deltabit' if host_type == 'deltabit' else 'Mixdrop'
                    streams.append({ 'url': u, 'title': (original_name or None), 'player': player_label, 'lang': lang, 'match_pct': match_pct })
            out = { 'streams': streams }
            # Attach diagnostics to aid Node integration debugging
            out['diag'] = {
                'py': sys.executable,
                'version': sys.version.split()[0],
                'curl_cffi': AsyncSession is not None,
                'pytesseract': _HAVE_PYTESSERACT,
                'tesseract_bin': _HAVE_TESSERACT_BIN,
                'streams_count': len(streams),
                'args': {
                    'imdb': args.imdb,
                    'season': args.season,
                    'episode': args.episode
                },
                'reason': reason,
                'title': debug.get('imdb_title') if isinstance(debug, dict) else None,
                'imdb_tokens': debug.get('imdb_tokens') if isinstance(debug, dict) else None,
                'matched_posts': debug.get('matched') if isinstance(debug, dict) else None,
                'candidates': debug.get('candidates')[:5] if isinstance(debug, dict) and debug.get('candidates') else None,
                'rejected': debug.get('rejected')[:5] if isinstance(debug, dict) and debug.get('rejected') else None
            }
            print(json.dumps(out))
    try:
        asyncio.run(_run_cli())
    except Exception:
        try:
            loop = asyncio.get_event_loop()
            loop.run_until_complete(_run_cli())
        except Exception as e:
            # Final fallback: emit JSON error (still valid JSON)
            print(json.dumps({ 'error': str(e) }))
