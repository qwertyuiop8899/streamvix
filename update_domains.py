#!/usr/bin/env python3
import os, json, sys, re, datetime, urllib.request
from pathlib import Path

PASTEBIN_RAW = 'https://pastebin.com/raw/KgQ4jTy6'
EUROSTREAMING_CHECK_URL = 'https://eurostreaming-nuovo-indirizzo.online/'
DOMAINS_FILE = Path('config/domains.json')
BACKUP_FILE = Path('config/domains.jsonbk')
ATTENTION_FILE = Path('attenzione.check')

# Keys we care about and optional detection hints (regex to search in fetched sources)
KEY_ORDER = [
    'animesaturn', 'animeunity', 'animeworld', 'guardaserie', 'guardahd', 'vixsrc', 'vavoo', 'eurostreaming'
]
# Regex map for extracting canonical host from paste/site lines
HOST_RE = re.compile(r'https?://(www\.)?([^/\s]+)', re.I)
# Specific map overrides: key -> regex to pick best candidate from sources
KEY_HINTS = {
    'animesaturn': re.compile(r'animesaturn\.[a-z]{2,}'),
    'animeunity': re.compile(r'animeunity\.[a-z]{2,}'),
    'animeworld': re.compile(r'animeworld\.[a-z]{2,}'),
    'guardaserie': re.compile(r'guardaserie[a-z]*\.[a-z]{2,}'),
    'eurostreaming': re.compile(r'eurostreaming\.[a-z]{2,}'),
}

def fetch(url: str) -> str:
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
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


def main():
    paste_txt = fetch(PASTEBIN_RAW)
    euro_page = fetch(EUROSTREAMING_CHECK_URL)
    reachable = True
    if not paste_txt or not euro_page:
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
            'eurostreaming': 'eurostreaming.garden'
        }

    if not reachable:
        # create attention file (overwrite with empty or warning text)
        ATTENTION_FILE.write_text('ATTENZIONE: pastebin o sito non raggiungibili. Nessun aggiornamento eseguito.\n', 'utf-8')
        print('pastebin/site unreachable -> written attenzione.check')
        return 2  # special code to allow workflow to still commit

    paste_hosts = extract_hosts(paste_txt)
    euro_hosts = extract_hosts(euro_page)
    all_hosts = paste_hosts | euro_hosts

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

    # eurostreaming explicit extraction from anchor tag if present
    if 'eurostreaming' in updated:
        # Try to parse explicit <a href="https://eurostreaming.garden/">
        m = re.search(r'https?://(www\.)?(eurostreaming\.[a-z]{2,})/?', euro_page, re.I)
        if m:
            new_euro = m.group(2).lower()
            if updated['eurostreaming'] != new_euro:
                changed['eurostreaming'] = {'old': updated['eurostreaming'], 'new': new_euro}
                updated['eurostreaming'] = new_euro

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
