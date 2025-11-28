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

import os
import re
import json
import urllib.request
import hashlib
from datetime import datetime

# URL of the M3U list
# ...existing code...
def process_channels(raw_channels):
    processed = []
    # Use local time or UTC depending on how the scraper writes it. 
    # The scraper writes local time of the machine running it (GitHub Actions = UTC usually)
    # But we added +1 hour in scraper, so it's effectively CET/BST roughly.
    # Let's use system time here.
    now = datetime.now()

    for ch in raw_channels:
        group = ch["group"]
        emoji = EMOJI_MAP.get(group, "")
        
        name_raw = ch["name_raw"]
        
        # Clean up potential existing prefixes from scraper if any, to be safe
        name_clean = name_raw.replace("[LIVE] ", "").replace("[NOT LIVE] ", "")
        
        # Parse name and date/time: "Event Name [YYYY-MM-DD HH:MM]"
        match = re.match(r'(.*) \[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\]', name_clean)
        
        final_name = name_clean
        event_start = None
        
        if match:
            event_name = match.group(1).strip()
            date_str = match.group(2)
            time_str = match.group(3)
            
            try:
                # Parse event time
                dt_str = f"{date_str} {time_str}"
                event_dt = datetime.strptime(dt_str, "%Y-%m-%d %H:%M")
                
                # Logic: LIVE if within 30 mins (1800s) of start or started
                # NOT LIVE if > 30 mins to start
                # Note: This depends on 'now' and 'event_dt' being in same timezone context
                time_diff = (event_dt - now).total_seconds()
                
                if time_diff > 1800: # More than 30 mins to go
                    final_name = "🚫 NOT LIVE"
                else:
                    final_name = "🔴 LIVE"

                # Create ISO eventStart
                event_start = f"{date_str}T{time_str}:00Z"
            except Exception as e:
                print(f"Error parsing date for {event_name}: {e}")
                # Fallback if date parsing fails
                final_name = f"{emoji} {event_name}".strip()
            
        else:
            # If regex doesn't match, just prepend emoji (no date info)
            final_name = f"{emoji} {name_clean}".strip()

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
                "title": "🇬🇧 PPV"
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
