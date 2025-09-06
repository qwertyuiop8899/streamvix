#!/usr/bin/env python3
# Eurostreaming provider (MammaMia-style, 1:1 functions) with curl_cffi + fake_headers
#!/usr/bin/env python3
# -*- coding: utf-8 -*- 
# thanks to @urlomythus for the code
#Adapted for use in Streamvix from:
# Mammamia  in https://github.com/UrloMythus/MammaMia
# 

import re, os, json, base64, time, random, asyncio, sys
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

# Static domain (as requested)
ES_DOMAIN = 'https://eurostreaming.garden'

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

async def get_info_imdb(clean_id: str, ismovie: int, _type: str, client) -> Tuple[str, int]:
    """Fetch IMDb title and year. Fallback to id if fail."""
    title = clean_id
    year = 0
    try:
        log('get_info_imdb: fetching', clean_id)
        r = await client.get(f'https://www.imdb.com/title/{clean_id}/')
        if r.status_code == 200:
            m = re.search(r'<title>([^<]+)</title>', r.text, re.I)
            if m:
                full = m.group(1)
                # e.g. "Chief of War (2024) - IMDb"
                t = re.sub(r'\s*-\s*IMDb.*$', '', full).strip()
                ym = re.search(r'\((\d{4})\)', t)
                if ym:
                    year = int(ym.group(1))
                    t = re.sub(r'\((\d{4})\)', '', t).strip()
                title = t
                # extra cleanup: drop residual parentheses fragments
                title = re.sub(r'\s*\([^)]*\)\s*$', '', title).strip()
                log('get_info_imdb: title/year ->', title, year)
    except Exception:
        pass
    if year == 0:
        # best-effort default year
        year = 0
    return title, year

def get_info_tmdb(clean_id: str, ismovie: int, _type: str):
    # Not used in our flow; return placeholders
    return (clean_id, 0)

# ========= Core host resolvers ========= #
async def mixdrop(url, MFP, client):
    """Extract Mixdrop URL (simplified)."""
    log('mixdrop: in', url, 'MFP=', MFP)
    if "club" in url:
        url = url.replace("club", "cv").split("/2")[0]
    if "cfd" in url:
        url = url.replace("cfd", "cv").replace("emb","e").split("/2")[0]
    # In MFP mode, just return the embed/direct URL as-is
    if str(MFP) == "1":
        log('mixdrop: MFP=1 passthrough ->', url)
        return url, ""
    # Fallback: return the URL (no eval_solver here)
    log('mixdrop: returning (no solver) ->', url)
    return url, ""

async def deltabit(page_url, client):
    """Extract Deltabit MP4 (XFileSharing pattern)."""
    i = 0
    headers = random_headers.generate()
    headers2 = random_headers.generate()
    log('deltabit: initial', page_url)
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
    log('deltabit: waiting 2.5s before POST')
    time.sleep(2.5)
    fname = data.get('fname', '')
    response = await client.post(ForwardProxy + page_url, data=data, headers=headers, proxies=proxies)
    link = re.findall(r'sources:\s*\["([^"]+)"', response.text, re.DOTALL)
    if not link:
        log('deltabit: no sources found, retrying')
        if i < 3:
            i += 1
            return await deltabit(page_url, client)
        return None, fname
    log('deltabit: got source', link[0])
    return link[0], fname

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
    # Check available hosts; prefer DeltaBit; fallback MixDrop
    log('scraping_links: in', ('...' if len(atag)>120 else atag))
    if "MixDrop" in atag and "DeltaBit" in atag:
        soup = BeautifulSoup(atag, _PARSER, parse_only=SoupStrainer('a'))
        delta_href = None
        mix_href = None
        if soup:
            for a in soup:
                text = (a.get_text(strip=True) or '').lower()
                href = a.get('href')
                if not href:
                    continue
                if 'deltabit' in text and delta_href is None:
                    delta_href = href
                if 'mixdrop' in text and mix_href is None:
                    mix_href = href
        href = await resolve_clicka_to_host(delta_href, client) if delta_href else None
        try:
            if not href:
                raise ValueError('no_delta_href')
            full_url, name = await deltabit(href, client)
            if not full_url:
                raise ValueError('no_deltabit_mp4')
        except Exception:
            href = await resolve_clicka_to_host(mix_href, client) if mix_href else None
            if not href:
                log('scraping_links: no MixDrop href either')
                return None, ""
            full_url, name = await mixdrop(href, MFP, client)
        log('scraping_links: chosen ->', full_url)
        return full_url, name
    if "MixDrop" in atag and  "DeltaBit" not in atag:
        soup = BeautifulSoup(atag, _PARSER, parse_only=SoupStrainer('a'))
        mix_href = None
        if soup:
            for a in soup:
                text = (a.get_text(strip=True) or '').lower()
                if 'mixdrop' in text:
                    mix_href = a.get('href')
                    break
        href = await resolve_clicka_to_host(mix_href, client) if mix_href else None
        if not href:
            log('scraping_links: MixDrop pattern not found')
            return None, ""
        full_url, name = await mixdrop(href, MFP, client)
        log('scraping_links: chosen MixDrop ->', full_url)
        return full_url, name
    if 'DeltaBit' in atag and "MixDrop" not in atag:
        soup = BeautifulSoup(atag, _PARSER, parse_only=SoupStrainer('a'))
        delta_href = None
        if soup:
            for a in soup:
                text = (a.get_text(strip=True) or '').lower()
                if 'deltabit' in text:
                    delta_href = a.get('href')
                    break
        href = await resolve_clicka_to_host(delta_href, client) if delta_href else None
        if not href:
            log('scraping_links: DeltaBit pattern not found')
            return None, ""
        full_url, name = await deltabit(href, client)
        log('scraping_links: chosen DeltaBit ->', full_url)
        return full_url, name
    if 'DeltaBit' not in atag and 'MixDrop' not in atag:
        log('scraping_links: no supported hosts found')
        return None, ""

STOPWORDS = {
    'the','la','le','lo','gli','i','il','di','da','a','in','of','and','or','serie','series','season','show','tv','la','una','un','uno','del','della','degli','delle','de','el'
}

def _normalize_title(t: str) -> str:
    t = t.lower()
    t = re.sub(r'&[a-z]+;?', ' ', t)            # html entities
    t = re.sub(r'[^a-z0-9]+', ' ', t)           # punctuation -> space
    t = re.sub(r'\s+', ' ', t).strip()
    return t

def _token_list(t: str) -> list:
    if not t:
        return []
    return [tok for tok in _normalize_title(t).split() if tok and (tok not in STOPWORDS) and (len(tok) > 2 or tok.isdigit())]

def _token_set(t: str) -> set:
    return set(_token_list(t))

async def search(showname, date, season, episode, MFP, client):
    headers = random_headers.generate()
    log('search: query', showname, 'year', date, 'S', season, 'E', episode)
    reason = None
    debug = { 'candidates': [], 'matched': [], 'filtered_tokens': [], 'rejected': [] }
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
        norm_post_title = _normalize_title(post_title)
        post_tokens = _token_set(post_title)
        inter = imdb_tokens & post_tokens
        significant_overlap = [tok for tok in inter]
        token_match_ratio = (len(inter) / max(1, len(imdb_tokens))) if imdb_tokens else 0
        seq_ratio = difflib.SequenceMatcher(None, _normalize_title(showname.replace('+',' ')), norm_post_title).ratio() if showname else 0.0
        # Base rules:
        #  - Must contain first token (if more than 1 token in imdb) to reduce false positives.
        #  - If single imdb token: require exact token and seq_ratio >= 0.85.
        #  - Else require (len(significant_overlap) >=2 AND seq_ratio>=0.55) OR token_match_ratio>=0.7 OR seq_ratio>=0.85.
        title_ok = False
        if len(imdb_tokens) == 1:
            title_ok = (len(inter) == 1 and seq_ratio >= 0.85)
        else:
            has_first = (first_token in post_tokens) if first_token else False
            if has_first and len(significant_overlap) >= 2 and seq_ratio >= 0.55:
                title_ok = True
            elif token_match_ratio >= 0.7 and has_first:
                title_ok = True
            elif seq_ratio >= 0.85 and has_first:
                title_ok = True
        cand_entry = {
            'post_id': i['id'],
            'title': post_title,
            'ratio_token': round(token_match_ratio,2),
            'ratio_seq': round(seq_ratio,2),
            'overlap': sorted(list(inter))
        }
        debug['candidates'].append(cand_entry)
        if title_ok:
            matched_any_title = True
            cand_entry['accepted'] = True
            debug['matched'].append({
                'post_id': i['id'],
                'title': post_title,
                'tokens': sorted(list(post_tokens)),
                'overlap': sorted(list(inter)),
                'ratio_token': round(token_match_ratio,2),
                'ratio_seq': round(seq_ratio,2)
            })
        else:
            debug['rejected'].append({
                'post_id': i['id'],
                'title': post_title,
                'overlap': sorted(list(inter)),
                'ratio_token': round(token_match_ratio,2),
                'ratio_seq': round(seq_ratio,2),
                'reason': 'title_mismatch'
            })
        year_pattern = re.compile(r'(?<!/)(19|20)\d{2}(?!/)')
        match = year_pattern.search(description)
        year = None
        if match:
            year = match.group(0)
        if not year:
            pattern = r'<a\s+href="([^"]+)"[^>]*>Continua a leggere</a>'
            match = re.search(pattern, description)
            if match:
                href_value = match.group(1)
                try:
                    response_2 = await client.get(ForwardProxy + href_value, proxies=proxies, headers=headers)
                    match2 = year_pattern.search(response_2.text)
                    if match2:
                        year = match2.group(0)
                except Exception:
                    pass
        log('search: post', i['id'], 'post_title=', norm_post_title, 'year', year, 'token_ratio', f"{token_match_ratio:.2f}")
        # Acceptance logic:
        # 1. If year matches AND title_ok
        # 2. If year missing, require title_ok
        # 3. If date==0 (unknown imdb year), allow title_ok
        if not title_ok:
            continue  # skip year logic/episode scan
        if year and str(year) != str(date) and date != 0:
            # reject mismatched year when both present
            continue
        ep_str = str(episode).zfill(2)
        # Accept also variations: × entity, literal x, uppercase X, S01E02 style fallback
        patterns = [
            rf'{season}&#215;{ep_str}\s*(.*?)(?=<br\s*/?>)',
            rf'{season}[xX×]{ep_str}\s*(.*?)(?=<br\s*/?>)',
            rf'S{int(season):02d}E{ep_str}\s*(.*?)(?=<br\s*/?>)'
        ]
        matches = []
        for pat in patterns:
            m = re.findall(pat, description)
            if m:
                matches = m
                break
        urls = {}
        if matches:
            log('search: episode rows found', len(matches))
            for episode_details in matches:
                if 'href' in episode_details:
                    part = episode_details
                    if ' – ' in part:
                        part = part.split(' – ', 1)[1]
                    full_url, name = await scraping_links(part, MFP, client)
                    if full_url:
                        urls[full_url] = name
            if urls:
                log('search: urls collected', len(urls))
                return urls, None, debug
        else:
            log('search: no episode row pattern for this accepted post')
    if not matched_any_title:
        reason = 'no_title_match'
    else:
        reason = 'no_episode_match'
    return None, reason, debug

async def eurostreaming(id_value, client, MFP):
    debug: Dict[str, object] = {}
    try:
        # Parse id and ensure it's a series
        ismovie, clean_id, season_i, episode_i = await is_movie(id_value)
        if ismovie == 1 or season_i is None or episode_i is None:
            return None, 'is_movie', { 'note': 'movies not supported' }
        season = str(season_i)
        episode = str(episode_i)
        # Fetch canonical title/year
        if "tmdb" in id_value:
            showname, date = get_info_tmdb(clean_id, 0, "Eurostreaming")
        else:
            showname, date = await get_info_imdb(clean_id, 0, "Eurostreaming", client)
        showname = re.sub(r'\s+', ' ', showname).strip()
        debug['imdb_title'] = showname
        debug['imdb_year'] = date
        log('eurostreaming: title/date', showname, date)
        showname_q = showname.replace(' ', '+')
        urls, reason, search_debug = await search(showname_q, date, season, episode, MFP, client)
        if isinstance(search_debug, dict):
            debug.update(search_debug)
        log('eurostreaming: urls_found', 0 if not urls else len(urls), 'reason', reason)
        return urls, reason, debug
    except Exception as e:  # pragma: no cover
        log('eurostreaming: exception', e)
        debug['error'] = str(e)
        return None, 'exception', debug

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
        idv = None
        if args.imdb:
            idv = args.imdb
        elif args.tmdb:
            # basic support: prefix 'tmdb:' to let is_movie pass; season/episode still apply if provided
            idv = f"tmdb:{args.tmdb}"
        else:
            print(json.dumps(result)); return
        # Attach season/episode to idv if provided
        if args.season is not None and args.episode is not None:
            idv = f"{idv}:{args.season}:{args.episode}"
        async with AsyncSession() as client:
            res = await eurostreaming(idv, client, args.mfp)
            if isinstance(res, tuple) and len(res) == 3:
                urls, reason, debug = res
            else:
                # backward safety
                urls, reason, debug = (res, None, {})
            streams = []
            if isinstance(urls, dict):
                for u, fname in urls.items():
                    if not u:
                        continue
                    fn = (fname or '')
                    low = fn.lower()
                    # Language detection patterns (inspired by MammaMia)
                    sub_patterns = [r'\bsub\b', r'subbed', r'subs', r'ita[-_. ]?sub', r'sub[-_. ]?ita']
                    lang = 'ita'
                    for pat in sub_patterns:
                        if re.search(pat, low, re.I):
                            lang = 'sub'
                            break
                    streams.append({ 'url': u, 'title': fn or None, 'player': 'deltabit', 'lang': lang })
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
