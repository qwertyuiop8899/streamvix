#!/usr/bin/env python3
import os
import re
import json
import urllib.request
import hashlib
from datetime import datetime

# URL of the M3U list from ENV
# Default to string for safety if not set, though it should be set
X_EVENTI_URL = os.environ.get("X_EVENTI_URL", "")
OUTPUT_FILE = "/tmp/x_eventi.json"

def fetch_m3u(url):
    if not url:
        print("X_EVENTI_URL is not set.")
        return None
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
            
            # Extract title (everything after the comma)
            title_match = re.search(r',(.+)$', line)
            title_text = title_match.group(1).strip() if title_match else ""

            logo = tvg_logo.group(1) if tvg_logo else ""
            group = group_title.group(1) if group_title else ""
            # Fallback to group title if default is used
            if not group:
                group = "X-Eventi"
                
            # Get URL (next line, skipping KODIPROPS)
            url = ""
            kodiprops = {}
            
            j = i + 1
            while j < len(lines):
                next_line = lines[j].strip()
                if not next_line:
                    j += 1
                    continue
                
                if next_line.startswith("#KODIPROP:"):
                    # Parse KODIPROP if needed in future
                    # For now we just skip/log them
                    # key=value
                    try:
                        k, v = next_line.replace("#KODIPROP:", "").split("=", 1)
                        kodiprops[k.strip()] = v.strip()
                    except:
                        pass
                elif next_line.startswith("#"):
                    # Other comments
                    pass
                else:
                    # Found URL
                    url = next_line
                    i = j 
                    break
                j += 1
            
            if url:
                # Store valid channel
                channels.append({
                    "logo": logo,
                    "group": group,
                    "name_raw": title_text,
                    "url": url,
                    "kodiprops": kodiprops
                })
        i += 1
    return channels

def process_channels(raw_channels):
    processed = []
    # Similar logic to PPV but simpler since names are usually "Team vs Team Oggi 15h00"
    
    for ch in raw_channels:
        group = "X-Eventi" # Force category name as requested
        
        name_raw = ch["name_raw"]
        
        # Determine live status or just use name
        # User example: "Sassuolo vs Fiorentina Oggi 15h00"
        # We can try to keep it as is.
        final_name = "🔴 " + name_raw 
        
        # Generate stable ID
        id_hash = hashlib.md5(ch["url"].encode('utf-8')).hexdigest()[:12]
        
        channel_obj = {
            "id": f"xeventi_{id_hash}",
            "name": final_name,
            "description": f"{name_raw} - {group}",
            "logo": ch["logo"] or "https://i.imgur.com/ngOzxVP.png", # Default logo if missing
            "poster": ch["logo"],
            "background": ch["logo"],
            "type": "tv",
            "category": "X-Eventi",
            "streams": [{
                "url": ch["url"],
                "title": "🔴 LIVE" 
            }]
        }
        
        
        processed.append(channel_obj)
        
    return processed

def main():
    print("Fetching X-Eventi M3U...")
    if not X_EVENTI_URL:
        print("Skipping X-Eventi: X_EVENTI_URL env var not set")
        return

    content = fetch_m3u(X_EVENTI_URL)
    if content:
        print("Parsing M3U...")
        raw_channels = parse_m3u(content)
        print(f"Found {len(raw_channels)} raw entries.")
        processed_channels = process_channels(raw_channels)
        
        with open(OUTPUT_FILE, "w") as f:
            json.dump(processed_channels, f, indent=2)
        print(f"Saved {len(processed_channels)} channels to {OUTPUT_FILE}")
    else:
        print("Failed to fetch M3U.")

if __name__ == "__main__":
    main()
