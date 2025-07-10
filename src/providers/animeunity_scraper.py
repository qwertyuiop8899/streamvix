#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AnimeUnity MP4 Link Extractor - Versione Modific        results = search_anime(query.replace("'", "").replace("'", ""), dubbed)ta
Mostra sia l'embed URL VixCloud che il link MP4 finale
Dipendenze: requests, beautifulsoup4 (pip install requests beautifulsoup4)
"""

import requests
import json
import re
import time
import argparse
import sys
from bs4 import BeautifulSoup
from urllib.parse import urlparse, urljoin, unquote
import json, os
with open(os.path.join(os.path.dirname(__file__), '../../config/domains.json'), encoding='utf-8') as f:
    DOMAINS = json.load(f)
BASE_URL = f"https://www.{DOMAINS['animeunity']}"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1"
}
TIMEOUT = 20

def get_session_tokens():
    """Recupera token di sessione per le richieste API"""
    response = requests.get(f"{BASE_URL}/", headers=HEADERS, timeout=TIMEOUT)
    response.raise_for_status()

    soup = BeautifulSoup(response.text, "html.parser")
    csrf_token = soup.select_one("meta[name=csrf-token]")["content"]
    cookies = response.cookies.get_dict()

    return {
        "csrf_token": csrf_token,
        "cookies": cookies,
        "session_headers": {
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/json;charset=utf-8",
            "X-CSRF-Token": csrf_token,
            "Referer": BASE_URL,
            "User-Agent": USER_AGENT
        }
    }

def search_anime(query, dubbed=False):
    """Ricerca anime tramite API livesearch e archivio"""
    try:
        session_data = get_session_tokens()
    except Exception as e:
        print(f"⚠️ Errore ottenimento token di sessione: {e}", file=sys.stderr)
        return []

    results = []
    seen_ids = set()

    # Endpoint di ricerca
    search_endpoints = [
        {"url": f"{BASE_URL}/livesearch", "payload": {"title": query}},
        {"url": f"{BASE_URL}/archivio/get-animes", "payload": {
            "title": query, "type": False, "year": False,
            "order": "Lista A-Z", "status": False, "genres": False,
            "season": False, "offset": 0, "dubbed": dubbed
        }}
    ]

    for endpoint in search_endpoints:
        try:
            response = requests.post(
                endpoint["url"],
                json=endpoint["payload"],
                headers=session_data["session_headers"],
                cookies=session_data["cookies"],
                timeout=TIMEOUT
            )
            response.raise_for_status()
            
            data = response.json()
            print(f"Debug: Risposta da {endpoint['url']}: {data.get('records', [])[:2]}", file=sys.stderr)

            for record in data.get("records", []):
                if not record or not record.get("id"):
                    continue
                anime_id = record["id"]
                if anime_id not in seen_ids:
                    seen_ids.add(anime_id)
                    title = (record.get("title_it") or
                            record.get("title_eng") or
                            record.get("title") or "")
                    if title.strip():
                        results.append({
                            "id": anime_id,
                            "slug": record.get("slug", ""),
                            "name": title.strip(),
                            "episodes_count": record.get("episodes_count", 0)
                        })
        except Exception as e:
            # Print error to stderr so it doesn't interfere with JSON output
            print(f"⚠️ Errore ricerca {endpoint['url']}: {e}", file=sys.stderr)
            continue

    print(f"Debug: Trovati {len(results)} risultati per '{query}'", file=sys.stderr)
    return results

def search_anime_with_fallback(query, dubbed=False):
    results = search_anime(query, dubbed)
    if results:
        return results
    # Fallback: senza apostrofi
    if "'" in query or "’" in query:
        results = search_anime(query.replace("'", "").replace("’", ""))
        if results:
            return results
    # Fallback: senza parentesi
    if "(" in query:
        results = search_anime(query.split("(")[0].strip(), dubbed)
        if results:
            return results
    # Fallback: prime 3 parole
    words = query.split()
    if len(words) > 3:
        results = search_anime(" ".join(words[:3]), dubbed)
        if results:
            return results
    return []

def get_episodes_list(anime_id):
    """Recupera lista episodi tramite API info_api"""
    episodes = []

    try:
        # Ottieni conteggio episodi
        count_response = requests.get(
            f"{BASE_URL}/info_api/{anime_id}/",
            headers=HEADERS,
            timeout=TIMEOUT
        )
        count_response.raise_for_status()
        total_episodes = count_response.json().get("episodes_count", 0)

        # Recupera episodi in batch
        start = 1
        while start <= total_episodes:
            end = min(start + 119, total_episodes)

            episodes_response = requests.get(
                f"{BASE_URL}/info_api/{anime_id}/1",
                params={"start_range": start, "end_range": end},
                headers=HEADERS,
                timeout=TIMEOUT
            )
            episodes_response.raise_for_status()
            episodes.extend(episodes_response.json().get("episodes", []))
            start = end + 1

    except Exception as e:
        print(f"⚠️ Errore recupero episodi: {e}", file=sys.stderr)

    return episodes

def get_video_page_content(anime_id, anime_slug, episode_id):
    """Ottiene contenuto pagina episodio per estrazione embed URL"""
    episode_url = f"{BASE_URL}/anime/{anime_id}-{anime_slug}/{episode_id}"

    try:
        response = requests.get(episode_url, headers=HEADERS, timeout=TIMEOUT)
        response.raise_for_status()
        return response.text
    except Exception as e:
        print(f"⚠️ Errore caricamento pagina episodio: {e}", file=sys.stderr)
        return None

def extract_mp4_from_vixcloud(embed_url):
    """
    Estrae link MP4 diretto da VixCloud
    """
    try:
        # Headers specifici per VixCloud
        parsed_url = urlparse(embed_url)
        vixcloud_headers = {
            "Host": parsed_url.netloc,
            "Referer": BASE_URL,
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }

        # Richiesta pagina embed con SSL disabilitato
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        response = requests.get(
            embed_url,
            headers=vixcloud_headers,
            timeout=TIMEOUT,
            verify=False
        )
        response.raise_for_status()

        soup = BeautifulSoup(response.text, "html.parser")

        # Metodo 1: Cerca script con src_mp4 (logica MP4_downloader)
        scripts = soup.find_all("script")
        for script in scripts:
            if script.string:
                # Pattern per link MP4 diretto
                mp4_match = re.search(r"(?:src_mp4|file)\s*[:=]\s*[\"']([^\"']+\.mp4[^\"']*)[\"']", script.string)
                if mp4_match:
                    mp4_url = mp4_match.group(1)
                    # Decodifica eventuali escape sequences
                    mp4_url = mp4_url.replace("\\/", "/")
                    if mp4_url.startswith("http"):
                        return mp4_url

        # Metodo 2: Cerca variabili JavaScript con URL MP4
        full_text = response.text
        mp4_patterns = [
            r"(?:file|source|src)\s*[:=]\s*[\"']([^\"']*au-d1-[^\"']*\.mp4[^\"']*)[\"']",
            r"[\"']([^\"']*scws-content\.net[^\"']*\.mp4[^\"']*)[\"']",
            r"(?:mp4|video)(?:Url|Source|File)\s*[:=]\s*[\"']([^\"']+\.mp4[^\"']*)[\"']"
        ]

        for pattern in mp4_patterns:
            matches = re.findall(pattern, full_text, re.IGNORECASE)
            for match in matches:
                clean_url = match.replace("\\/", "/")
                if "token=" in clean_url and "expires=" in clean_url:
                    return clean_url

        # Metodo 3: Parsing JSON configuration (fallback per M3U8->MP4)
        json_match = re.search(r'(?:config|window\.config)\s*=\s*(\{.*?\});', full_text, re.DOTALL)
        if json_match:
            try:
                config = json.loads(json_match.group(1))

                # Cerca URL base e converti da M3U8 a MP4
                for key in ["masterPlaylist", "window_parameter", "streams"]:
                    if key in config and isinstance(config[key], dict):
                        base_url = config[key].get("url", "")
                        if "playlist" in base_url and "vixcloud.co" in base_url:
                            # Sostituisci /playlist/ con /download/ per ottenere MP4
                            mp4_url = base_url.replace("/playlist/", "/download/")
                            mp4_url = mp4_url.replace("m3u8", "mp4")

                            # Aggiungi parametri di qualità se disponibili
                            params = config[key].get("params", {})
                            if params:
                                token = params.get("token", "")
                                expires = params.get("expires", "")
                                if token and expires:
                                    separator = "&" if "?" in mp4_url else "?"
                                    mp4_url += f"{separator}token={token}&expires={expires}"

                                    # Aggiungi qualità se FHD disponibile
                                    if config.get("canPlayFHD", False):
                                        mp4_url += "&quality=1080p"

                                    return mp4_url
            except json.JSONDecodeError:
                pass

        return None

    except Exception as e:
        print(f"⚠️ Errore estrazione VixCloud: {e}", file=sys.stderr)
        return None

def get_stream(anime_id, anime_slug, episode_id):
    """
    Estrae sia embed URL che MP4 link
    Restituisce un dizionario con entrambi i link
    """
    # Ottieni contenuto pagina episodio
    page_content = get_video_page_content(anime_id, anime_slug, episode_id)
    if not page_content:
        return {"embed_url": None, "mp4_url": None, "episode_page": None}

    episode_page_url = f"{BASE_URL}/anime/{anime_id}-{anime_slug}/{episode_id}"

    # Cerca embed URL di VixCloud
    soup = BeautifulSoup(page_content, "html.parser")
    embed_url = None

    # Cerca video-player tag con embed_url
    video_player = soup.select_one("video-player")
    if video_player and video_player.get("embed_url"):
        embed_url = video_player["embed_url"]

        # Normalizza URL se necessario
        if embed_url.startswith("//"):
            embed_url = "https:" + embed_url
        elif embed_url.startswith("/"):
            embed_url = urljoin(BASE_URL, embed_url)

    # Fallback: cerca iframe VixCloud
    if not embed_url:
        iframe_match = re.search(r'<iframe[^>]+src="([^"]*vixcloud[^"]+)"', page_content)
        if iframe_match:
            embed_url = iframe_match.group(1)
            if embed_url.startswith("//"):
                embed_url = "https:" + embed_url
            elif embed_url.startswith("/"):
                embed_url = urljoin(BASE_URL, embed_url)

    # Estrai MP4 dall'embed URL (se trovato)
    mp4_url = None
    if embed_url:
        mp4_url = extract_mp4_from_vixcloud(embed_url)

    return {
        "episode_page": episode_page_url,
        "embed_url": embed_url,
        "mp4_url": mp4_url
    }

def main():
    parser = argparse.ArgumentParser(description="AnimeUnity Scraper CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Search command
    search_parser = subparsers.add_parser("search", help="Search for an anime")
    search_parser.add_argument("--query", required=True, help="Anime title to search for")
    search_parser.add_argument("--dubbed", action="store_true", help="Search for dubbed version")

    # Get episodes command
    episodes_parser = subparsers.add_parser("get_episodes", help="Get episode list for an anime")
    episodes_parser.add_argument("--anime-id", required=True, help="AnimeUnity ID of the anime")

    # Get stream command
    stream_parser = subparsers.add_parser("get_stream", help="Get stream URL for an episode")
    stream_parser.add_argument("--anime-id", required=True, help="AnimeUnity ID of the anime")
    stream_parser.add_argument("--anime-slug", required=True, help="Anime slug")
    stream_parser.add_argument("--episode-id", required=True, help="Episode ID")

    args = parser.parse_args()
    
    # Disable SSL warnings
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    if args.command == "search":
        results = search_anime_with_fallback(args.query, args.dubbed)
        print(json.dumps(results, indent=4))
    elif args.command == "get_episodes":
        results = get_episodes_list(args.anime_id)
        print(json.dumps(results, indent=4))
    elif args.command == "get_stream":
        results = get_stream(args.anime_id, args.anime_slug, args.episode_id)
        print(json.dumps(results, indent=4))

if __name__ == "__main__":
    main()
