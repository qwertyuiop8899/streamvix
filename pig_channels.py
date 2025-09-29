#!/usr/bin/env python3
"""pig_channels.py

Post-processing utility to:
 1. Fetch the DaddyLive derived M3U playlist (GitHub raw) and update existing
    TV channels in config/tv_channels.json adding/updating field `pdUrlF` for
    Italian (group-title="ITALY") channels ONLY if the channel already exists
    (no new channels are created).
 2. Inject provider ([PD]) streams into the freshly generated dynamic events
    file (dynamic channels JSON produced by Live.py) by matching event titles
    (teams) and allowed broadcaster labels and attaching the corresponding
    playlist stream URL. Multiple PD streams (one per matching broadcaster) are allowed.

Usage:
  python pig_channels.py --dynamic /tmp/dynamic_channels.json \
      --tv-config config/tv_channels.json [--dry-run]

When imported, call run_post_live(dynamic_path, tv_channels_path, dry_run=False)
after Live.py finishes writing the dynamic file.

Idempotency:
  - Re-running will NOT duplicate `pdUrlF` (updates if URL changed)
  - Will NOT duplicate [PD] streams in events (matched by exact URL or by title prefix + URL)

Assumptions:
  - tv_channels.json is a JSON list of channel objects each having at least a `name`.
  - dynamic file is a JSON list of event objects with `name` and `streams` (list of {url,title}).

Author: post-live integration helper.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import traceback
from pathlib import Path
from typing import List, Dict, Any, Tuple, Optional

import requests, socket, urllib.request, time

# ========================= UNIFIED COMBINED PLAYLIST SOURCES =========================
# Ora esiste un unico file M3U che contiene sia canali (group-title contiene ITALY) che eventi live.
# Strategia fetch:
#   1. Tenta PRIMARY_COMBINED_URL (CDN)
#   2. Se fallisce tenta SECONDARY_COMBINED_URL (raw GitHub)
# Partizionamento:
#   group-title contenente 'ITALY' (case-insensitive) => CANALE statico (aggiorniamo pdUrlF se esiste nel json)
#   altrimenti => EVENTO per injection
PRIMARY_COMBINED_URL = "https://world-proxifier.xyz/daddylive/playlist.m3u8"
SECONDARY_COMBINED_URL = "https://raw.githubusercontent.com/pigzillaaa/daddylive/refs/heads/main/daddylive-channels-events.m3u8"

# ---------------------------------------------------------------------------
# Parsing M3U
# ---------------------------------------------------------------------------
EXTINF_RE = re.compile(r"^#EXTINF:-?1\s+([^,]*),(.*)$")
# Attribute regex needed to include keys with hyphens (e.g., group-title)
ATTR_RE = re.compile(r"([A-Za-z0-9_-]+)=\"(.*?)\"")

def parse_m3u(text: str) -> List[Dict[str, Any]]:
    """Return list of entries: each has attrs, name, url.
    We expect pattern: #EXTINF ... ,Display Name  \n URL
    """
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    out: List[Dict[str, Any]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith('#EXTINF:'):
            m = EXTINF_RE.match(line)
            if m:
                attr_blob = m.group(1)
                display = m.group(2).strip()
                attrs = {k: v for k, v in ATTR_RE.findall(attr_blob)}
                url = None
                if i + 1 < len(lines) and not lines[i+1].startswith('#'):
                    url = lines[i+1].strip()
                    i += 1
                out.append({
                    'attrs': attrs,
                    'display': display,
                    'url': url
                })
        i += 1
    return out
RELAX_KEYWORDS = [
    'SERIE A','SERIE B','SERIE C','COPPA','CHAMPIONS LEAGUE','EUROPA LEAGUE','CONFERENCE LEAGUE','SUPERCOPPA',
    'FORMULA 1','F1','MOTOGP','ROLAND GARROS','WIMBLEDON','US OPEN','AUSTRALIAN OPEN','ATP','WTA','TENNIS',
    'VOLLEY','VOLLEYBALL'
]
# ---------------------------------------------------------------------------
# Normalization helpers
# ---------------------------------------------------------------------------
def norm_key(name: str) -> str:
    if not name:
        return ''
    s = name.lower()
    # Remove common suffixes / tokens
    s = re.sub(r"\b(italy|it|hd|fhd|uhd|4k|sd)\b", "", s)
    s = re.sub(r"[^a-z0-9]+", "", s)
    return s

TEAM_SYNONYMS = {
    'internazionale': 'inter', 'inter': 'inter',
    'manchestercity': 'manchestercity', 'mancity': 'manchestercity',
    'manchesterunited': 'manchesterunited', 'manutd': 'manchesterunited', 'manut': 'manchesterunited',
    'atleticomadrid': 'atleticomadrid', 'atletico': 'atleticomadrid',
    'juventus': 'juventus', 'napoli': 'napoli', 'sscnapoli': 'napoli',
}

def norm_team(raw: str) -> str:
    if not raw:
        return ''
    s = raw.lower()
    s = re.sub(r"[^a-z0-9]+", "", s)
    return TEAM_SYNONYMS.get(s, s)

def extract_teams_from_title(title: str) -> Optional[Tuple[str, str]]:
    """Estrae TeamA, TeamB dal display playlist.
    Pulizia:
      - Rimuove broadcaster finale in quadre [ ... ]
      - Rimuove orario finale tra parentesi (HH:MM ...)
      - Elimina prefisso competizione prima del primo ':'
      - Split su 'vs' (case-insensitive)
    """
    work = re.sub(r"\[[^\[\]]+\]\s*$", "", title).strip()
    work = re.sub(r"\([^()]*\)\s*$", "", work).strip()
    if ':' in work:
        work = work.split(':', 1)[1].strip()
    parts = re.split(r"\bvs\b", work, flags=re.IGNORECASE)
    if len(parts) >= 2:
        left = parts[0].strip()
        right = parts[1].strip()
        left = re.sub(r"\s*-\s*[A-Za-z ].*$", "", left).strip()
        right = re.sub(r"\s*-\s*[A-Za-z ].*$", "", right).strip()
        return left, right
    return None

def teams_match(a: Tuple[str, str], b: Tuple[str, str]) -> bool:
    ax = {norm_team(a[0]), norm_team(a[1])}
    bx = {norm_team(b[0]), norm_team(b[1])}
    return ax == bx and '' not in ax

def extract_channel_label_from_display(display: str) -> Optional[str]:
    """Estrae label broadcaster per titolo stream PD.
    Priorità: quadre finali -> parentesi finali -> rimozione country token.
    """
    m_sq = re.search(r"\[([^\[\]]+)\]\s*$", display)
    if m_sq:
        return m_sq.group(1).strip()
    m = re.search(r"\(([^()]+)\)\s*$", display)
    if m:
        return m.group(1).strip()
    base = re.sub(r"\b(Italy|Spain|Poland|France|Germany|Portugal|Israel|Croatia|USA|UK|Nederland|Netherlands)\b\s*$", "", display, flags=re.IGNORECASE).strip()
    return base or display.strip()

ITAL_TOKEN_RE = re.compile(r"(\bIT\b|ITALY|ITALIA|ITALIANO|\bITA\b|ITAL)", re.IGNORECASE)
def is_allowed_broadcaster(label: str) -> bool:
    """Return True if label contains an allowed broadcaster + italian token.

    Richiesta: accetta solo se (brand in lista) E (token italiano IT / ITA / ITALY / ITALIA / ITAL / ITALIANO).
    Brand list: SKY SPORT, SKY, DAZN, EUROSPORT, PRIME, AMAZON.
    """
    L = label.upper()
    brands = ('SKY SPORT', 'SKY', 'DAZN', 'EUROSPORT', 'PRIME', 'AMAZON')
    if not any(b in L for b in brands):
        return False
    if not ITAL_TOKEN_RE.search(label):
        return False
    return True

# Relax competitions: if event belongs to these competition keywords, bypass broadcaster requirement (still need team match)
RELAX_KEYWORDS = [
    'SERIE A','SERIE B','SERIE C','COPPA','CHAMPIONS LEAGUE','EUROPA LEAGUE','CONFERENCE LEAGUE','SUPERCOPPA',
    'FORMULA 1','F1','MOTOGP','ROLAND GARROS','WIMBLEDON','US OPEN','AUSTRALIAN OPEN','ATP','WTA','TENNIS',
    'VOLLEY','VOLLEYBALL'
]
def event_is_relax(name: str) -> bool:
    up = name.upper()
    return any(k in up for k in RELAX_KEYWORDS)

# ---------------------------------------------------------------------------
# Static channels update (pdUrlF)
# ---------------------------------------------------------------------------
ITALIAN_CHANNEL_NAME_RE = re.compile(r"\b(Rai ?[0-9A-Z]?|Rai ?[A-Z][a-z]+|Sky ?Sport ?[0-9A-Za-z]*|Sky ?Cinema ?[A-Za-z]*|Canale 5|Italia 1|Rete 4|Mediaset|Eurosport ?[12]?|DAZN ?[0-9]?|Dazn ?[0-9]?|Cine34|Top ?Crime|Motor Trend)\b", re.IGNORECASE)

# Whitelist mapping per nomi playlist speciali che devono corrispondere a canali statici esistenti.
# In particolare: "Sky Calcio 1 (251)" .. "Sky Calcio 1 (257)" -> "Sky Sport 251" .. "Sky Sport 257".
# Estendiamo il mapping preventivamente fino a 269 per coprire future assegnazioni
SKY_CALCIO_SPECIAL_MAP = { str(n): f"Sky Sport {n}" for n in range(251, 270) }

def update_static_channels(entries: List[Dict[str, Any]], tv_channels_path: Path, dry_run: bool) -> int:
    if not tv_channels_path.exists():
        print(f"[PD] tv_channels.json not found at {tv_channels_path}")
        return 0
    try:
        data = json.loads(tv_channels_path.read_text(encoding='utf-8'))
        if not isinstance(data, list):
            print("[PD] tv_channels.json is not a list - abort static update")
            return 0
    except Exception as e:
        print(f"[PD] Failed to parse tv_channels.json: {e}")
        return 0

    # Build index by normalized key
    index = {}
    for ch in data:
        name = ch.get('name') or ''
        index.setdefault(norm_key(name), []).append(ch)

    updated = 0
    attempted = 0
    italy_playlist_count = 0
    not_found_samples = []  # keep up to 15 samples of keys not found for diagnostics
    # Detect if playlist actually exposes ITALY group (some variants may omit or use different casing)
    has_italy_group = any(e['attrs'].get('group-title') == 'ITALY' for e in entries)
    for e in entries:
        attrs = e['attrs']
        gtitle = attrs.get('group-title')
        if has_italy_group:
            if gtitle != 'ITALY':
                continue
        else:
            # Fallback heuristic: match by name tokens if group missing or different
            if not ITALIAN_CHANNEL_NAME_RE.search(e['display']):
                continue
        italy_playlist_count += 1
        disp = e['display']
        # Remove channel suffix tokens for match
        base_name = re.sub(r"\b(Italy|IT)\b", "", disp, flags=re.IGNORECASE).strip()
        # Normalization specifica per nuove denominazioni SKY CALCIO -> SKY SPORT 25x
        # Esempio playlist: "Sky Calcio 1 (251)" -> static channel name: "Sky Sport 251"
        # Cattura pattern Sky Calcio <n> (<25x>)
        m_calcio = re.match(r"(?i)^Sky\s+Calcio\s+\d+\s*\((25\d)\)", base_name)
        if m_calcio:
            num = m_calcio.group(1)
            mapped = SKY_CALCIO_SPECIAL_MAP.get(num)
            if mapped:
                base_name = mapped
                # Log minimal debug once per match key (avoid flooding) -> print only in dry_run to surface mapping quickly
                if dry_run:
                    print(f"[PD][MAP] Playlist '{disp}' mappato -> '{base_name}'")
        # Rimuove eventuale doppia occorrenza country
        base_name = re.sub(r"\s+Italy$", "", base_name, flags=re.IGNORECASE)
        # Riduci spazi
        base_name = re.sub(r"\s+", " ", base_name)
        key = norm_key(base_name)
        if not key:
            continue
        matches = index.get(key)
        if not matches:
            # collect a few samples to help refine normalization later
            if len(not_found_samples) < 15:
                not_found_samples.append({'playlist': disp, 'derived_key': key})
            continue  # channel not present -> skip (per requirements)
        attempted += 1
        for ch in matches:
            old = ch.get('pdUrlF')
            url = e['url']
            if not url:
                continue
            if old != url:
                ch['pdUrlF'] = url
                updated += 1
    if updated and not dry_run:
        tv_channels_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"[PD] Static channels updated: {updated} / attempted matches {attempted} / ITALY playlist entries {italy_playlist_count} (changes{' not' if dry_run else ''} written)")
    if not updated:
        print(f"[PD] Diagnostics: 0 updates. Showing up to {len(not_found_samples)} unmatched playlist entries (normalized key):")
        for sm in not_found_samples:
            print(f"    - {sm['playlist']} -> key={sm['derived_key']}")
    return updated

# ---------------------------------------------------------------------------
# Dynamic events injection
# ---------------------------------------------------------------------------
def load_dynamic(dynamic_path: Path) -> List[Dict[str, Any]]:
    if not dynamic_path.exists():
        return []
    try:
        data = json.loads(dynamic_path.read_text(encoding='utf-8'))
        if isinstance(data, list):
            return data
    except Exception:
        pass
    return []

def save_dynamic(dynamic_path: Path, events: List[Dict[str, Any]], dry_run: bool):
    if dry_run:
        print("[PD] Dry-run: dynamic file NOT written")
        return
    dynamic_path.write_text(json.dumps(events, ensure_ascii=False, indent=2), encoding='utf-8')

def extract_teams_from_dynamic_name(name: str) -> Optional[Tuple[str, str]]:
    # dynamic 'name' format: "⏰ HH:MM : Team A vs Team B - League DD/MM"
    # Remove leading clock marker
    core = re.sub(r"^⏰\s*\d{1,2}:\d{2}\s*:\s*", "", name)
    # Cut off after ' - '
    core = core.split(' - ')[0].strip()
    m = re.split(r"\bvs\b", core, flags=re.IGNORECASE)
    if len(m) >= 2:
        return m[0].strip(), m[1].strip()
    return None

def inject_pd_streams(entries: List[Dict[str, Any]], playlist_entries: List[Dict[str, Any]], dry_run: bool) -> int:
    # Precompute event index by team pair key
    def team_pair_key(teams: Tuple[str, str]) -> str:
        a, b = norm_team(teams[0]), norm_team(teams[1])
        if not a or not b:
            return ''
        return '::'.join(sorted([a, b]))

    event_index: Dict[str, List[Dict[str, Any]]] = {}
    for ev in entries:
        teams = extract_teams_from_dynamic_name(ev.get('name', '') or '')
        if teams:
            k = team_pair_key(teams)
            if k:
                event_index.setdefault(k, []).append(ev)

    # Normalizza eventuali simboli dinamici pre-esistenti (🚫/🔴) rimossi dalla logica PD
    pd_prefix = '[P🐽D]'
    for ev in entries:
        streams = ev.get('streams') or []
        for s in streams:
            if isinstance(s, dict):
                tt = s.get('title','')
                if tt.startswith(pd_prefix):
                    rest = tt[len(pd_prefix):].lstrip()
                    # Rimuovi eventuale emoji iniziale ora deprecata
                    if rest.startswith('🚫') or rest.startswith('🔴'):
                        rest = rest[1:].lstrip()
                        s['title'] = f'{pd_prefix} {rest}'.rstrip() if rest else pd_prefix

    injected = 0
    candidate_events = 0
    allowed_broadcaster_events = 0
    for pe in playlist_entries:
        attrs = pe['attrs']
        gtitle = (attrs.get('group-title') or '').upper()
        if 'ITALY' in gtitle:
            continue
        display = pe['display']
        teams = extract_teams_from_title(display)
        if not teams:
            continue
        channel_label = extract_channel_label_from_display(display) or ''
        if not channel_label:
            continue
        has_it_token = bool(ITAL_TOKEN_RE.search(channel_label))
        k = team_pair_key(teams)
        if not k or k not in event_index:
            continue
        url = pe.get('url')
        if not url:
            continue
        candidate_events += 1
        for ev in event_index[k]:
            streams = ev.setdefault('streams', [])
            rel = event_is_relax(ev.get('name',''))
            if rel:
                if not has_it_token:
                    continue
            else:
                if not is_allowed_broadcaster(channel_label):
                    continue
            already = any(s for s in streams if isinstance(s, dict) and s.get('url') == url)
            if already:
                continue
            streams.insert(0, {'url': url, 'title': f'[P🐽D] {channel_label}'})
            injected += 1
    # SECOND PASS: single-event (no vs) token-based matching.
    # Build index of dynamic events without vs by token set (minimum 2 tokens to reduce noise).
    single_index: Dict[str, List[Dict[str, Any]]] = {}
    for ev in entries:
        if extract_teams_from_dynamic_name(ev.get('name','') or ''):
            continue  # skip those with vs (already processed)
        raw_name = ev.get('name','') or ''
        core = re.sub(r"^⏰\s*\d{1,2}:\d{2}\s*:\s*", "", raw_name)
        core = core.split(' - ')[0]
        base = core
        if ':' in base:
            base = base.split(':', 1)[1].strip()
        tokens = [t for t in re.split(r"[^A-Za-z0-9]+", base) if t]
        if len(tokens) < 2:
            continue
        key = '::'.join(sorted(set(t.lower() for t in tokens)))
        single_index.setdefault(key, []).append(ev)
    def build_single_key_from_playlist(display: str) -> Optional[str]:
        # Remove broadcaster parentheses and competition colons, take first segment
        base = re.sub(r"\([^()]*\)$", "", display).strip()
        # If it contains vs it's not single-event mode
        if re.search(r"\bvs\b", base, flags=re.IGNORECASE):
            return None
        # Take trailing segment after ':' if competition prefix present
        if ':' in base:
            base = base.split(':', 1)[1].strip()
        tokens = [t for t in re.split(r"[^A-Za-z0-9]+", base) if t]
        if len(tokens) < 2:
            return None
        return '::'.join(sorted(set(t.lower() for t in tokens)))

    for pe in playlist_entries:
        attrs = pe['attrs']
        if 'ITALY' in (attrs.get('group-title') or '').upper():
            continue
        display = pe['display']
        channel_label = extract_channel_label_from_display(display) or ''
        if not channel_label:
            continue
        has_it_token = bool(ITAL_TOKEN_RE.search(channel_label))
        skey = build_single_key_from_playlist(display)
        if not skey or skey not in single_index:
            continue
        url = pe.get('url')
        if not url:
            continue
        passed_filter = False
        for ev in single_index[skey]:
            streams = ev.setdefault('streams', [])
            rel = event_is_relax(ev.get('name',''))
            if rel:
                if not has_it_token:
                    continue
            else:
                if not is_allowed_broadcaster(channel_label):
                    continue
            if not passed_filter:
                allowed_broadcaster_events += 1
                passed_filter = True
            if any(s for s in streams if isinstance(s, dict) and s.get('url') == url):
                continue
            streams.insert(0, {'url': url, 'title': f'[P🐽D] {channel_label}'})
            injected += 1

    print(f"[PD] Dynamic events injected streams: {injected} (candidates matched: {candidate_events}, allowed broadcaster sports: {allowed_broadcaster_events}){' (dry-run only)' if dry_run else ''}")
    if injected == 0:
        # Provide quick hint if we saw zero allowed broadcasters
        if allowed_broadcaster_events == 0:
            print("[PD] Diagnostics: No playlist sports entries with allowed broadcasters matched current whitelist. Consider revising is_allowed_broadcaster().")
    return injected

# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------
def run_post_live(dynamic_path: str | Path, tv_channels_path: str | Path, dry_run: bool = False):
    print(f"[PD][BOOT] pig_channels.run_post_live start dry_run={dry_run}")
    dynamic_p = Path(dynamic_path)
    tv_p = Path(tv_channels_path)
    print(f"[PD][PATH] dynamic={dynamic_p} exists={dynamic_p.exists()} size={dynamic_p.stat().st_size if dynamic_p.exists() else 'NA'}")
    print(f"[PD][PATH] tv_channels={tv_p} exists={tv_p.exists()} size={tv_p.stat().st_size if tv_p.exists() else 'NA'}")

    # --- Unified combined playlist fetch ---
    def _dns_log(host: str, tag: str):
        try:
            ips = socket.gethostbyname_ex(host)[2]
            print(f"[PD][DNS][{tag}] {host} -> {','.join(ips)}")
        except Exception as _e:
            print(f"[PD][DNS][{tag}][ERR] {host} {_e}")
    def _fetch(url: str, tag: str) -> str | None:
        attempts = 3
        last_err = None
        headers = {
            'User-Agent': 'Mozilla/5.0 (compatible; PDFetcher/1.0)',
            'Accept': '*/*',
            'Pragma': 'no-cache',
            'Cache-Control': 'no-cache'
        }
        for i in range(1, attempts+1):
            try:
                resp = requests.get(url, headers=headers, timeout=25)
                if resp.ok and '#EXTM3U' in resp.text:
                    print(f"[PD][HTTP][{tag}] status={resp.status_code} bytes={len(resp.text)}")
                    return resp.text
                last_err = RuntimeError(f"status={resp.status_code}")
            except Exception as ee:
                last_err = ee
            time.sleep(min(2, i))
        # urllib fallback
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=25) as r:
                raw = r.read().decode('utf-8','replace')
            if '#EXTM3U' in raw:
                print(f"[PD][HTTP][{tag}][URLLIB] bytes={len(raw)}")
                return raw
        except Exception as ee2:
            last_err = ee2
        if last_err:
            print(f"[PD][FETCH][{tag}][ERR] {last_err}")
        return None

    combined_raw = None
    try:
        host_p = urllib.request.urlparse(PRIMARY_COMBINED_URL).hostname
        if host_p: _dns_log(host_p, 'PRIMARY')
    except Exception:
        pass
    print(f"[PD][HTTP] GET combined playlist (primary): {PRIMARY_COMBINED_URL}")
    combined_raw = _fetch(PRIMARY_COMBINED_URL, 'PRIMARY')
    if not combined_raw:
        print(f"[PD][HTTP][FALLBACK] trying combined secondary: {SECONDARY_COMBINED_URL}")
        try:
            host_s = urllib.request.urlparse(SECONDARY_COMBINED_URL).hostname
            if host_s: _dns_log(host_s, 'SECONDARY')
        except Exception:
            pass
        combined_raw = _fetch(SECONDARY_COMBINED_URL, 'SECONDARY')

    channels_entries: List[Dict[str, Any]] = []
    events_entries: List[Dict[str, Any]] = []
    if combined_raw:
        all_entries = parse_m3u(combined_raw)
        for e in all_entries:
            gt = (e['attrs'].get('group-title') or '').upper()
            if 'ITALY' in gt:
                channels_entries.append(e)
            else:
                events_entries.append(e)
        print(f"[PD][PARSE] combined entries={len(all_entries)} channels={len(channels_entries)} events={len(events_entries)}")
    else:
        print("[PD][ERR] Combined playlist fetch failed (primary + secondary)")

    # Static enrichment
    if channels_entries:
        update_static_channels(channels_entries, tv_p, dry_run=dry_run)
    else:
        print("[PD] Skipping static enrichment (no ITALY channel entries)")

    # Dynamic injection
    dynamic_events = load_dynamic(dynamic_p)
    print(f"[PD][STATE] dynamic_events={len(dynamic_events) if dynamic_events else 0} events_entries={len(events_entries) if events_entries else 0}")
    if dynamic_events and events_entries:
        try:
            inject_pd_streams(dynamic_events, events_entries, dry_run=dry_run)
            save_dynamic(dynamic_p, dynamic_events, dry_run=dry_run)
            print("[PD][DONE] Injection + save complete")
        except Exception as e:
            print(f"[PD][ERR] Injection failed: {e}")
            traceback.print_exc()
    elif dynamic_events and not events_entries:
        print("[PD][INFO] Combined playlist senza eventi -> no injection")
    else:
        if not dynamic_events:
            print("[PD][INFO] Dynamic file empty or not found, skipping injection")
    print("[PD][END] run_post_live finished")


def _parse_args(argv: List[str]) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Post Live.py PD streams updater")
    ap.add_argument('--dynamic', default='/tmp/dynamic_channels.json', help='Path to dynamic channels JSON produced by Live.py')
    ap.add_argument('--tv-config', default='config/tv_channels.json', help='Path to tv_channels.json')
    ap.add_argument('--dry-run', action='store_true', help='Do not write changes')
    return ap.parse_args(argv)


def main(argv: List[str] | None = None):
    ns = _parse_args(argv or sys.argv[1:])
    run_post_live(ns.dynamic, ns.tv_config, dry_run=ns.dry_run)


if __name__ == '__main__':  # CLI execution
    main()
