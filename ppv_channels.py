#!/usr/bin/env python3
import os
import re
import json
import urllib.request
import hashlib

# URL of the M3U list
M3U_URL = "https://raw.githubusercontent.com/qwertyuiop8899/logo/main/ppv_proxy.m3u"
OUTPUT_FILE = "/tmp/ppv_channels.json"

# Emoji mapping
EMOJI_MAP = {
    "Basketball": "🏀",
    "Combat Sports": "🥊",
    "Football": "⚽",
    "Motorsports": "🏎️"
}

def fetch_m3u(url):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
        with urllib.request.urlopen(req) as response:
            return response.read().decode('utf-8')
    except Exception as e:
        print(f"Error fetching M3U: {e}")
        return None

def parse_m3u(content):
    channels = []
    lines = content.splitlines()
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if line.startswith("#EXTINF:"):
            # Extract attributes
            tvg_logo = re.search(r'tvg-logo="([^"]+)"', line)
            group_title = re.search(r'group-title="([^"]+)"', line)
            tvg_name = re.search(r'tvg-name="([^"]+)"', line)
            
            logo = tvg_logo.group(1) if tvg_logo else ""
            group = group_title.group(1) if group_title else ""
            name_raw = tvg_name.group(1) if tvg_name else ""
            
            # Get URL (next line)
            url = ""
            # Skip comments/empty lines until URL
            j = i + 1
            while j < len(lines):
                next_line = lines[j].strip()
                if next_line and not next_line.startswith("#"):
                    url = next_line
                    i = j # Advance main loop
                    break
                j += 1
            
            if url:
                channels.append({
                    "logo": logo,
                    "group": group,
                    "name_raw": name_raw,
                    "url": url
                })
        i += 1
    return channels

def process_channels(raw_channels):
    processed = []
    for ch in raw_channels:
        group = ch["group"]
        emoji = EMOJI_MAP.get(group, "")
        
        name_raw = ch["name_raw"]
        # Parse name and date/time: "Event Name [YYYY-MM-DD HH:MM]"
        # User wants to invert time and date.
        # Regex to capture name, date, time
        match = re.match(r'(.*) \[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\]', name_raw)
        
        final_name = name_raw
        event_start = None
        
        if match:
            event_name = match.group(1).strip()
            date_str = match.group(2)
            time_str = match.group(3)
            
            # User request: remove date from final name (kept only in eventStart)
            final_name = f"{emoji} {event_name}".strip()
            
            # Create ISO eventStart
            try:
                dt_str = f"{date_str}T{time_str}:00"
                # Assuming UTC as is common in these lists
                event_start = dt_str + "Z" 
            except:
                pass
        else:
            # If regex doesn't match, just prepend emoji
            final_name = f"{emoji} {name_raw}".strip()

        # Generate a stable ID based on URL
        id_hash = hashlib.md5(ch["url"].encode('utf-8')).hexdigest()[:12]
        
        # Create channel object
        channel_obj = {
            "id": f"ppv_{id_hash}",
            "name": final_name,
            "description": f"PPV Event - {group}",
            "logo": ch["logo"],
            "poster": ch["logo"],
            "background": ch["logo"],
            "type": "tv",
            "category": "PPV", # The main category
            "streams": [{
                "url": ch["url"],
                "title": "PPV Stream"
            }]
        }
        
        if event_start:
            channel_obj["eventStart"] = event_start
        
        processed.append(channel_obj)
    return processed

def main():
    print("Fetching PPV M3U...")
    content = fetch_m3u(M3U_URL)
    if content:
        print("Parsing M3U...")
        raw_channels = parse_m3u(content)
        print(f"Found {len(raw_channels)} raw entries.")
        processed_channels = process_channels(raw_channels)
        
        with open(OUTPUT_FILE, "w") as f:
            json.dump(processed_channels, f, indent=2)
        print(f"Saved {len(processed_channels)} PPV channels to {OUTPUT_FILE}")
    else:
        print("Failed to fetch M3U.")

if __name__ == "__main__":
    main()
