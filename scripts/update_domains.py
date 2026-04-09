#!/usr/bin/env python3
import os, json, sys, re, datetime, urllib.request
from pathlib import Path

PASTEBIN_RAW = 'https://pastebin.com/raw/KgQ4jTy6'
GUARDASERIE_IT_URL = 'https://guardaserie.foo/'  # Source for guardoserie + guardaflix domains
GUARDASERIE_BLOG_URL = 'https://www.giardiniblog.it/guardaserie-nuovo-link/'  # Source for guardaserie domain
EURO_SOURCE_URL = 'https://eurostreaming-nuovo-indirizzo.com/' # Primary source for eurostreaming
DOMAINS_FILE = Path('config/domains.json')
BACKUP_FILE = Path('config/domains.jsonbk')
ATTENTION_FILE = Path('attenzione.check')

# Keys we care about and optional detection hints (regex to search in fetched sources)
KEY_ORDER = [
    'animesaturn', 'animeunity', 'animeworld', 'guardaserie', 'guardahd', 'vixsrc', 'vavoo', 'eurostreaming',
    'guardoserie', 'guardaflix'  # Added new keys
]
# Regex map for extracting canonical host from paste/site lines
HOST_RE = re.compile(r'https?://(www\.)?([^/\s]+)', re.I)
# Specific map overrides: key -> regex to pick best candidate from sources
KEY_HINTS = {
    'animesaturn': re.compile(r'animesaturn\.[a-z]{2,}'),
    'animeunity': re.compile(r'animeunity\.[a-z]{2,}'),
    'animeworld': re.compile(r'animeworld\.[a-z]{2,}'),
    'eurostreaming': re.compile(r'eurostreamings?\.[a-z]{2,}'),
    # guardaserie handled via giardiniblog scraping
    # guardoserie and guardaflix handled separately via guardaserie.foo scraping
}

def fetch(url: str) -> str:
    try:
        # Creiamo un oggetto Request con un User-Agent comune
        req = urllib.request.Request(
            url,
            headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'}
        )
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.read().decode('utf-8', 'replace')
    except Exception as e:
        print(f'[update_domains] fetch fail {url}: {e}', file=sys.stderr)
        return ''

def extract_hosts(text: str):
    hosts = set()
    for m in HOST_RE.finditer(text):
        hosts.add(m.group(2).lower())
    return hosts

def pick_host(hosts, hint_re):
    if not hint_re:
        return None
    cand = [h for h in hosts if hint_re.search(h)]
    if not cand:
        return None
    # Pick the shortest (usually base domain) deterministically
    cand.sort(key=lambda x: (len(x), x))
    return cand[0]

def load_json(path: Path):
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text('utf-8'))
    except Exception:
        return {}


def scrape_guardaserie_it(html: str):
    """
    Scrape guardoserie and guardaflix domains from guardaserie.it.com HTML.
    - guardoserie: <a href="https://guardoserie.bar/" class="btn btn-outline-success ...
    - guardaflix: <a href="https://guardaplay.bar/" class="btn btn-success fw-bold ...
    """
    result = {}

    # guardoserie: Look for btn-outline-success link with Guardaserie text
    m = re.search(r'<a\s+href="https?://([^"/]+)/?"\s+class="btn btn-outline-success[^"]*"', html, re.I)
    if m:
        result['guardoserie'] = m.group(1).lower()
        print(f'[update_domains] Found guardoserie domain: {result["guardoserie"]}')

    # guardaflix: Look for btn-success link with GuardaPlay text
    m = re.search(r'<a\s+href="https?://([^"/]+)/?"\s+class="btn btn-success[^"]*"[^>]*>GuardaPlay', html, re.I)
    if m:
        result['guardaflix'] = m.group(1).lower()
        print(f'[update_domains] Found guardaflix domain: {result["guardaflix"]}')

    return result
 
 
def scrape_guardaserie_blog(html: str):
    """
    Scrape guardaserie domain from giardiniblog.it.
    Looks for red highlighted link like: <span style="color: #ff0000;"><strong>https://guarda-serie.click/</strong></span>
    """
    m = re.search(r'<strong>\s*https?://([^/<\s]+)/?\s*</strong>', html, re.I)
    if m:
        domain = m.group(1).lower()
        print(f'[update_domains] Found guardaserie domain from giardiniblog: {domain}')
        return domain
    return None


def scrape_eurostreaming_nuovo(html: str):
    """
    Scrape eurostreaming domain from eurostreaming-nuovo-indirizzo.com.
    Looks for the main link with title="nuovo indirizzo eurostreaming".
    """
    m = re.search(r'<a\s+href="https?://([^"/]+)/?"\s+title="nuovo indirizzo eurostreaming"', html, re.I)
    if m:
        domain = m.group(1).lower()
        print(f'[update_domains] Found official eurostreaming domain: {domain}')
        return domain
    return None


def main():
    paste_txt = fetch(PASTEBIN_RAW)
    guardaserie_it_html = fetch(GUARDASERIE_IT_URL)
    guardaserie_blog_html = fetch(GUARDASERIE_BLOG_URL)
    euro_nuovo_html = fetch(EURO_SOURCE_URL)

    reachable = True
    if not paste_txt and not guardaserie_it_html and not guardaserie_blog_html:
        reachable = False

    current = load_json(DOMAINS_FILE)
    if not current:
        # initialize with default if empty
        current = {
            'animesaturn': 'animesaturn.cx',
            'vixsrc': 'vixsrc.to',
            'animeunity': 'animeunity.so',
            'animeworld': 'animeworld.ac',
            'vavoo': 'vavoo.to',
            'guardaserie': 'guardaserie.qpon',
            'guardahd': 'guardahd.stream',
            'eurostreaming': 'eurostreaming.garden',
            'guardoserie': 'guardoserie.bar',
            'guardaflix': 'guardaplay.bar'
        }

    if not reachable:
        # create attention file (overwrite with empty or warning text)
        ATTENTION_FILE.write_text('ATTENZIONE: pastebin o sito non raggiungibili. Nessun aggiornamento eseguito.\n', 'utf-8')
        print('pastebin/site unreachable -> written attenzione.check')
        return 2  # special code to allow workflow to still commit
    else:
        # If previously an attenzione.check exists from an outage, remove it (not part of normal state)
        try:
            if ATTENTION_FILE.exists():
                ATTENTION_FILE.unlink()
        except Exception:
            pass

    paste_hosts = extract_hosts(paste_txt) if paste_txt else set()
    all_hosts = paste_hosts

    updated = dict(current)
    changed = {}

    for key in KEY_ORDER:
        hint_re = KEY_HINTS.get(key)
        if not hint_re:
            continue
        new_host = pick_host(all_hosts, hint_re)
        if not new_host:
            continue  # don't remove if missing
        old_host = current.get(key)
        if old_host != new_host:
            updated[key] = new_host
            changed[key] = {'old': old_host, 'new': new_host}

    # eurostreaming is now handled via KEY_HINTS search across the entire pastebin
    # but we PRIORITIZE the official euro-nuovo source if available
    if euro_nuovo_html:
        official_euro = scrape_eurostreaming_nuovo(euro_nuovo_html)
        if official_euro:
            old_host = updated.get('eurostreaming')
            if old_host != official_euro:
                updated['eurostreaming'] = official_euro
                changed['eurostreaming'] = {'old': old_host, 'new': official_euro}
 
    # guardaserie: scrape from giardiniblog
    if guardaserie_blog_html:
        gs_domain = scrape_guardaserie_blog(guardaserie_blog_html)
        if gs_domain:
            old_host = updated.get('guardaserie')
            if old_host != gs_domain:
                updated['guardaserie'] = gs_domain
                changed['guardaserie'] = {'old': old_host, 'new': gs_domain}

    # guardoserie + guardaflix: scrape from guardaserie.foo
    if guardaserie_it_html:
        scraped = scrape_guardaserie_it(guardaserie_it_html)
        for key in ['guardoserie', 'guardaflix']:
            if key in scraped:
                new_host = scraped[key]
                old_host = updated.get(key)
                if old_host != new_host:
                    updated[key] = new_host
                    changed[key] = {'old': old_host, 'new': new_host}

    if not changed:
        print('No domain changes detected.')
        return 0

    # write backup with previous state
    BACKUP_FILE.write_text(json.dumps(current, indent=2, ensure_ascii=False) + '\n', 'utf-8')
    # write updated domains
    DOMAINS_FILE.write_text(json.dumps(updated, indent=2, ensure_ascii=False) + '\n', 'utf-8')

    print('Updated domains:', json.dumps(changed, indent=2))
    return 1

if __name__ == '__main__':
    rc = main()
    sys.exit(0)
