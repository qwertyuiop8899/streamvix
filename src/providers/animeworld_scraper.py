#!/usr/bin/env python3
# -*- coding: utf-8 -*- 
# thanks to @urlomythus for the code
"""AnimeWorld Scraper CLI

Comandi:
  search --query <titolo>
  get_episodes --anime-slug <slug_o_path>
  get_stream --anime-slug <slug_o_path> [--episode N]

Nota: implementazione minimale derivata dal tuo script root `animeworld.py` per integrazione nel provider TS.
"""
import argparse, sys, re, json, os, datetime
from typing import List, Dict, Any, Optional
import requests
from bs4 import BeautifulSoup

BASE_DIR = os.path.dirname(__file__)
with open(os.path.join(BASE_DIR, '../../config/domains.json'), encoding='utf-8') as f:
    DOMAINS = json.load(f)
AW_HOST = DOMAINS.get('animeworld', 'animeworld.so')
BASE_URL = f"https://{AW_HOST}"

TITLE_REPL = {
    "Attack on Titan": "L'attacco dei Giganti",
    "Season": "",
    "  ": " ",            # doppio spazio -> spazio singolo
    "Shippuuden": "Shippuden",
    "Solo+Leveling+2": "Solo+Leveling+2:",
    "-": "",
    # lo spazio singolo in Python lo gestiamo dopo (q_norm sostituisce gli spazi con +)
}

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"

def rand_headers():
    return {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
        "Connection": "keep-alive",
        "Referer": BASE_URL + "/"
    }

def normalize_title(title: str) -> str:
    t = title
    for k, v in TITLE_REPL.items():
        t = t.replace(k, v)
    if "Naruto:" in t:
        t = t.replace(":", "")
    if "’" in t:
        t = t.split("’")[0]
    if ":" in t:
        t = t.split(":")[0]
    return " ".join(t.split()).strip()

def security_cookie(text: str):
    m = re.search(r'SecurityAW-([A-Za-z0-9]{2})=([^;]+)', text)
    if not m:
        return {}
    return {f"SecurityAW-{m.group(1)}": m.group(2)}

def fetch(url: str, cookies=None, allow_retry=True):
    cookies = cookies or {}
    r = requests.get(url, headers=rand_headers(), cookies=cookies, timeout=25, verify=False)
    if allow_retry and r.status_code == 202:
        ck = security_cookie(r.text)
        if ck:
            cookies.update(ck)
            r = requests.get(url, headers=rand_headers(), cookies=cookies, timeout=25, verify=False)
    return r, cookies

def search(query: str, date: str = None) -> List[Dict[str, Any]]:
    # Normalizza showname come nello script
    showname = normalize_title(query)
    q_norm = showname.replace(' ', '+')
    results = []
    seen = set()
    months = {
        "Gennaio": "January", "Febbraio": "February", "Marzo": "March",
        "Aprile": "April", "Maggio": "May", "Giugno": "June",
        "Luglio": "July", "Agosto": "August", "Settembre": "September",
        "Ottobre": "October", "Novembre": "November", "Dicembre": "December"
    }
    # Prima prova con year se data fornita
    year = None
    if date:
        try:
            year = str(datetime.datetime.strptime(date, "%Y-%m-%d").year)
        except Exception:
            year = None
    urls = []
    if year:
        urls.append(f"{BASE_URL}/filter?year={year}&sort=2&keyword={q_norm}")
    urls.append(f"{BASE_URL}/filter?sort=2&keyword={q_norm}")
    for url in urls:
        try:
            print(f"[AW-DEBUG] Search URL: {url}", file=sys.stderr)
            r, ck = fetch(url)
            if not r.ok:
                continue
            soup = BeautifulSoup(r.text, 'html.parser')
            posters = soup.find_all('a', class_=['poster', 'tooltipstered'])
            for a in posters:
                href = a.get('href') or ''
                if not href.startswith('/'):
                    continue
                slug = href.strip('/').split('/')[-1]
                name = a.get('title') or a.text or slug
                # Filtro per data se fornita
                anime_info_url = f'{BASE_URL}/{a.get("data-tip")}' if a.get("data-tip") else None
                match_date = True
                if date and anime_info_url:
                    try:
                        resp, _ = fetch(anime_info_url)
                        if resp.ok:
                            pattern = r'<label>Data di uscita:</label>\s*<span>\s*(.*?)\s*</span>'
                            m = re.search(pattern, resp.text, re.S)
                            if m:
                                release_date = m.group(1).strip()
                                for ita, eng in months.items():
                                    release_date = release_date.replace(ita, eng)
                                release_date_object = datetime.datetime.strptime(release_date, "%d %B %Y")
                                date_object = datetime.datetime.strptime(date, "%Y-%m-%d")
                                release_date_fmt = release_date_object.strftime("%Y-%m-%d")
                                # accetta +/- 1 giorno
                                match_date = (release_date_fmt == date or
                                              release_date_fmt == (date_object + datetime.timedelta(days=1)).strftime("%Y-%m-%d") or
                                              release_date_fmt == (date_object - datetime.timedelta(days=1)).strftime("%Y-%m-%d"))
                                print(f"[AW-DEBUG] {name} release: {release_date_fmt} vs {date} -> {match_date}", file=sys.stderr)
                    except Exception as e:
                        print(f"[AW-DEBUG] errore data: {e}", file=sys.stderr)
                if not match_date:
                    continue
                if slug in seen:
                    continue
                seen.add(slug)
                results.append({
                    'id': slug,
                    'slug': slug,
                    'name': name.strip(),
                    'episodes_count': 0
                })
        except Exception as e:
            print(f"[AW-DEBUG] errore search: {e}", file=sys.stderr)
        if results:
            break
    return results

def get_episodes(slug: str) -> List[Dict[str, Any]]:
    base_play = slug
    if not base_play.startswith('/play/'):
        base_play = f"/play/{base_play}"
    if not base_play.startswith('/'):
        base_play = '/' + base_play
    url = BASE_URL + base_play
    r, ck = fetch(url)
    if not r.ok:
        return []
    soup = BeautifulSoup(r.text, 'html.parser')
    eps = []
    for a in soup.select('a[data-episode-num]'):
        num = a.get('data-episode-num')
        if not num:
            continue
        try:
            n_int = int(num)
        except ValueError:
            continue
        href = a.get('href') or ''
        eps.append({
            'id': href,
            'number': n_int,
            'name': a.get('title') or ''
        })
    if not eps:
        eps.append({'id': url, 'number': 1, 'name': 'Movie'})
    return eps

def get_mp4_from_page(url: str, cookies=None) -> Optional[str]:
    r, ck = fetch(url, cookies=cookies)
    if not r.ok:
        return None
    soup = BeautifulSoup(r.text, 'html.parser')
    a_tag = soup.find('a', id='alternativeDownloadLink')
    if a_tag and a_tag.get('href'):
        test = a_tag['href']
        try:
            h = requests.head(test, timeout=15, verify=False)
            if h.status_code == 404:
                return None
        except Exception:
            pass
        return test
    return None

def get_stream(slug: str, episode: int | None):
    eps = get_episodes(slug)
    if not eps:
        return {'mp4_url': None, 'episode_page': None}
    target = None
    if episode is not None:
        for e in eps:
            if e['number'] == episode:
                target = e
                break
    if not target:
        target = eps[0]
    href = target['id']
    if href.startswith('/'):
        page_url = BASE_URL + href
    elif href.startswith('http'):
        page_url = href
    else:
        page_url = BASE_URL + '/' + href
    mp4 = get_mp4_from_page(page_url)
    return {
        'episode_page': page_url,
        'embed_url': None,
        'mp4_url': mp4
    }

def main():
    p = argparse.ArgumentParser(description='AnimeWorld Scraper CLI')
    sub = p.add_subparsers(dest='cmd', required=True)
    s1 = sub.add_parser('search')
    s1.add_argument('--query', required=True)
    s2 = sub.add_parser('get_episodes')
    s2.add_argument('--anime-slug', required=True)
    s3 = sub.add_parser('get_stream')
    s3.add_argument('--anime-slug', required=True)
    s3.add_argument('--episode', required=False, type=int)
    args = p.parse_args()
    try:
        if args.cmd == 'search':
            print(json.dumps(search(args.query), indent=4))
        elif args.cmd == 'get_episodes':
            print(json.dumps(get_episodes(args.anime_slug), indent=4))
        elif args.cmd == 'get_stream':
            print(json.dumps(get_stream(args.anime_slug, args.episode), indent=4))
    except Exception as e:
        print(json.dumps({'error': str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    main()
