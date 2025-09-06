#!/usr/bin/env python3
import os, json, sys, re, datetime, urllib.request
from pathlib import Path

PASTEBIN_RAW = 'https://pastebin.com/raw/KgQ4jTy6'
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
    # eurostreaming handled separately via fixed position (line 4 of pastebin)
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
    reachable = True
    if not paste_txt:
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

    # eurostreaming: pick host from 4th non-empty line (1-based) of pastebin list if valid
    try:
        lines = [ln.strip() for ln in paste_txt.splitlines() if ln.strip()]
        if len(lines) >= 4:
            line4 = lines[3]
            m = re.search(r'https?://(www\.)?(eurostreaming\.[a-z]{2,})', line4, re.I)
            if m:
                euro_host = m.group(2).lower()
                old_host = updated.get('eurostreaming')
                if euro_host and old_host != euro_host:
                    updated['eurostreaming'] = euro_host
                    changed['eurostreaming'] = {'old': old_host, 'new': euro_host}
    except Exception as e:
        print('[update_domains] eurostreaming line-4 parse error', e, file=sys.stderr)

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
