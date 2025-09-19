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

import requests

PLAYLIST_URL = "https://raw.githubusercontent.com/pigzillaaa/daddylive/refs/heads/main/daddylive-channels.m3u8"  # channels (static)
EVENTS_PLAYLIST_URL = "https://raw.githubusercontent.com/pigzillaaa/daddylive/refs/heads/main/daddylive-events.m3u8"  # events (matches)

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
    # Expect something containing ' vs ' ignoring case
    m = re.split(r"\bvs\b", title, flags=re.IGNORECASE)
    if len(m) >= 2:
        left = m[0].split(':')[-1].strip()  # drop competition prefixes like 'UEFA Champions League :' if present
        right = m[1].strip()
        # Remove trailing parenthetical part from right if present
        right = re.sub(r"\s*\([^()]*\)\s*$", "", right).strip()
        # Strip any trailing competition dash segment e.g. "- Premier League"
        left = re.sub(r"\s*-\s*[A-Za-z ].*$", "", left).strip()
        right = re.sub(r"\s*-\s*[A-Za-z ].*$", "", right).strip()
        return left, right
    return None

def teams_match(a: Tuple[str, str], b: Tuple[str, str]) -> bool:
    ax = {norm_team(a[0]), norm_team(a[1])}
    bx = {norm_team(b[0]), norm_team(b[1])}
    return ax == bx and '' not in ax

def extract_channel_label_from_display(display: str) -> Optional[str]:
    """Return broadcaster label.

    Original playlist variant used parentheses (.. (SKY SPORT 252 IT)). Current
    observed variant has no parentheses, broadcaster is the whole display string or
    ends with country token ("Italy", "Spain", etc.). For our purposes we want a
    concise channel/broadcaster indicator to show in [PD] title.

    Strategy:
      1. If parentheses exist -> use inside.
      2. Else remove trailing country name (Italy/Spain/Poland/USA/France/Germany/Portugal/Israel/Croatia/Poland/Netherlands/UK) keeping rest.
      3. If result becomes empty fallback to original display trimmed.
    """
    m = re.search(r"\(([^()]+)\)\s*$", display)
    if m:
        return m.group(1).strip()
    # Remove trailing common country tokens
    base = re.sub(r"\b(Italy|Spain|Poland|France|Germany|Portugal|Israel|Croatia|USA|UK|Nederland|Netherlands)\b\s*$", "", display, flags=re.IGNORECASE).strip()
    return base or display.strip()

def is_allowed_broadcaster(label: str) -> bool:
    """Return True if label contains an allowed Italian-relevant broadcaster.

    Simplify given playlist variant (some entries lose explicit IT token):
      Accept if label contains any of SKY SPORT / SKY / DAZN / EUROSPORT / PRIME / AMAZON
      and (either contains 'IT'/'ITALY' OR label is DAZN / EUROSPORT / PRIME where we relax country).
    """
    L = label.upper()
    brands = ('SKY SPORT', 'SKY', 'DAZN', 'EUROSPORT', 'PRIME', 'AMAZON')
    if not any(b in L for b in brands):
        return False
    if any(b in L for b in ('PRIME', 'AMAZON', 'DAZN', 'EUROSPORT')):
        return True  # relax for these
    # For SKY require IT or ITALY to reduce false positives
    if 'SKY' in L and (' IT' in L or 'ITALY' in L):
        return True
    return False

# ---------------------------------------------------------------------------
# Static channels update (pdUrlF)
# ---------------------------------------------------------------------------
ITALIAN_CHANNEL_NAME_RE = re.compile(r"\b(Rai ?[0-9A-Z]?|Rai ?[A-Z][a-z]+|Sky ?Sport ?[0-9A-Za-z]*|Sky ?Cinema ?[A-Za-z]*|Canale 5|Italia 1|Rete 4|Mediaset|Eurosport ?[12]?|DAZN ?[0-9]?|Dazn ?[0-9]?|Cine34|Top ?Crime|Motor Trend)\b", re.IGNORECASE)

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
        # Remove trailing spaces and repeated tokens
        base_name = re.sub(r"\s+", " ", base_name)
        # Some playlist entries append country again; remove trailing ' Italy'
        base_name = re.sub(r"\s+Italy$", "", base_name, flags=re.IGNORECASE)
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

    injected = 0
    candidate_events = 0
    allowed_broadcaster_events = 0
    for pe in playlist_entries:
        attrs = pe['attrs']
        gtitle = attrs.get('group-title', '')
        if gtitle == 'ITALY':  # skip pure channel lines
            continue
        display = pe['display']
        teams = extract_teams_from_title(display)
        if not teams:
            continue
        channel_label = extract_channel_label_from_display(display) or ''
        if not channel_label or not is_allowed_broadcaster(channel_label):
            continue
        allowed_broadcaster_events += 1
        k = team_pair_key(teams)
        if not k or k not in event_index:
            continue
        candidate_events += 1
        url = pe['url']
        if not url:
            continue
        for ev in event_index[k]:
            streams = ev.setdefault('streams', [])
            already = any(s for s in streams if isinstance(s, dict) and s.get('url') == url)
            if already:
                continue
            # Inserisci sempre in testa per priorità
            streams.insert(0, {'url': url, 'title': f'[P🐽D] {channel_label}'})
            injected += 1
    # SECOND PASS: single-event (no vs) token-based matching.
    # Build index of dynamic events without vs by token set (minimum 2 tokens to reduce noise).
    single_events: List[Dict[str, Any]] = []
    single_index: Dict[str, List[Dict[str, Any]]] = {}
    for ev in entries:
        if extract_teams_from_dynamic_name(ev.get('name','') or ''):
            continue  # skip those with vs (already processed)
        raw_name = ev.get('name','')
        # Strip clock and league suffix
        core = re.sub(r"^⏰\s*\d{1,2}:\d{2}\s*:\s*", "", raw_name)
        core = core.split(' - ')[0]
        tokens = [t for t in re.split(r"[^A-Za-z0-9]+", core) if t]
        if len(tokens) < 2:
            continue
        key = '::'.join(sorted(set(t.lower() for t in tokens)))
        single_index.setdefault(key, []).append(ev)
        single_events.append(ev)

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
        if attrs.get('group-title') == 'ITALY':
            continue
        display = pe['display']
        channel_label = extract_channel_label_from_display(display) or ''
        if not channel_label or not is_allowed_broadcaster(channel_label):
            continue
        skey = build_single_key_from_playlist(display)
        if not skey or skey not in single_index:
            continue
        url = pe['url']
        if not url:
            continue
        for ev in single_index[skey]:
            streams = ev.setdefault('streams', [])
            if any(s for s in streams if isinstance(s, dict) and s.get('url') == url):
                continue
            # Inserisci sempre in testa per priorità (single-event)
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

    # 1. Channels playlist (static enrichment)
    try:
        print(f"[PD][HTTP] GET channels playlist: {PLAYLIST_URL}")
        ch_resp = requests.get(PLAYLIST_URL, timeout=25)
        print(f"[PD][HTTP] channels status={ch_resp.status_code} bytes={len(ch_resp.text)}")
        ch_resp.raise_for_status()
        channels_entries = parse_m3u(ch_resp.text)
        print(f"[PD][PARSE] channels entries={len(channels_entries)}")
    except Exception as e:
        print(f"[PD][ERR] Failed to download channels playlist: {e}")
        traceback.print_exc()
        channels_entries = []

    if channels_entries:
        update_static_channels(channels_entries, tv_p, dry_run=dry_run)
    else:
        print("[PD] Skipping static enrichment (no channels entries)")

    # 2. Events playlist (dynamic injection)
    try:
        print(f"[PD][HTTP] GET events playlist: {EVENTS_PLAYLIST_URL}")
        ev_resp = requests.get(EVENTS_PLAYLIST_URL, timeout=25)
        print(f"[PD][HTTP] events status={ev_resp.status_code} bytes={len(ev_resp.text)}")
        ev_resp.raise_for_status()
        events_entries = parse_m3u(ev_resp.text)
        print(f"[PD][PARSE] events entries={len(events_entries)}")
    except Exception as e:
        print(f"[PD][ERR] Failed to download events playlist: {e}")
        traceback.print_exc()
        events_entries = []

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
        print("[PD][INFO] Events playlist empty -> no PD injections this run")
    else:
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
