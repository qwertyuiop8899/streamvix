#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AnimeSaturn MP4 Link Extractor
Estrae il link MP4 diretto dagli episodi di animesaturn.cx
Dipendenze: requests, beautifulsoup4 (pip install requests beautifulsoup4)
"""

import requests
from bs4 import BeautifulSoup
import re
import sys
import json
import urllib.parse
import argparse

BASE_URL = "https://www.animesaturn.cx"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
HEADERS = {"User-Agent": USER_AGENT}
TIMEOUT = 20

def search_anime(query):
    """Ricerca anime tramite la barra di ricerca di AnimeSaturn"""
    search_url = f"{BASE_URL}/index.php?search=1&key={query.replace(' ', '+')}"
    headers = {
        "User-Agent": USER_AGENT,
        "Referer": f"{BASE_URL}/animelist?search={query.replace(' ', '+')}",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01"
    }
    resp = requests.get(search_url, headers=headers, timeout=TIMEOUT)
    resp.raise_for_status()
    results = []
    for item in resp.json():
        results.append({
            "title": item["name"],
            "url": f"{BASE_URL}/anime/{item['link']}"
        })
    return results

def get_watch_url(episode_url):
    resp = requests.get(episode_url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    # Cerca il link con testo "Guarda lo streaming"
    for a in soup.find_all("a", href=True):
        div = a.find("div")
        if div and "Guarda lo streaming" in div.get_text():
            return a["href"] if a["href"].startswith("http") else BASE_URL + a["href"]
    # Fallback: cerca il link alla pagina watch come prima
    watch_link = soup.find("a", href=re.compile(r"^/watch\\?file="))
    if watch_link:
        return BASE_URL + watch_link["href"]
    iframe = soup.find("iframe", src=re.compile(r"^/watch\\?file="))
    if iframe:
        return BASE_URL + iframe["src"]
    return None

def extract_mp4_url(watch_url):
    resp = requests.get(watch_url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    # Cerca direttamente il link mp4 nel sorgente
    mp4_match = re.search(r'https://[\w\.-]+/[^"\']+\\.mp4', resp.text)
    if mp4_match:
        return mp4_match.group(0)
    # In alternativa, analizza i tag video/source
    soup = BeautifulSoup(resp.text, "html.parser")
    video = soup.find("video")
    if video:
        source = video.find("source")
        if source and source.get("src"):
            return source["src"]
    return None

def get_episodes_list(anime_url):
    resp = requests.get(anime_url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")
    episodes = []
    for a in soup.select("a.bottone-ep"):
        title = a.get_text(strip=True)
        href = a["href"]
        # Se il link è assoluto, usalo così, altrimenti aggiungi BASE_URL
        if href.startswith("http"):
            url = href
        else:
            url = BASE_URL + href
        episodes.append({"title": title, "url": url})
    return episodes

def download_mp4(mp4_url, referer_url, filename=None):
    headers = {
        "User-Agent": USER_AGENT,
        "Referer": referer_url
    }
    if not filename:
        filename = mp4_url.split("/")[-1].split("?")[0]
    print(f"\n⬇️ Download in corso: {filename}\n")
    r = requests.get(mp4_url, headers=headers, stream=True)
    r.raise_for_status()
    with open(filename, "wb") as f:
        for chunk in r.iter_content(chunk_size=8192):
            if chunk:
                f.write(chunk)
    print(f"✅ Download completato: {filename}\n")

def main():
    print("🎬 === AnimeSaturn MP4 Link Extractor === 🎬")
    print("Estrae il link MP4 diretto dagli episodi di animesaturn.cx\n")
    query = input("🔍 Nome anime da cercare: ").strip()
    if not query:
        print("❌ Query vuota, uscita.")
        return
    print(f"\n⏳ Ricerca di '{query}' in corso...")
    anime_results = search_anime(query)
    if not anime_results:
        print("❌ Nessun risultato trovato.")
        return
    print(f"\n✅ Trovati {len(anime_results)} risultati:")
    for i, a in enumerate(anime_results, 1):
        print(f"{i}) {a['title']}")
    try:
        idx = int(input("\n👆 Seleziona anime: ")) - 1
        selected = anime_results[idx]
    except Exception:
        print("❌ Selezione non valida.")
        return
    print(f"\n⏳ Recupero episodi di '{selected['title']}'...")
    episodes = get_episodes_list(selected["url"])
    if not episodes:
        print("❌ Nessun episodio trovato.")
        return
    print(f"\n✅ Trovati {len(episodes)} episodi:")
    for i, ep in enumerate(episodes, 1):
        print(f"{i}) {ep['title']}")
    try:
        ep_idx = int(input("\n👆 Seleziona episodio: ")) - 1
        ep_selected = episodes[ep_idx]
    except Exception:
        print("❌ Selezione non valida.")
        return
    print(f"\n⏳ Recupero link stream per '{ep_selected['title']}'...")
    watch_url = get_watch_url(ep_selected["url"])
    if not watch_url:
        print("❌ Link stream non trovato nella pagina episodio.")
        return
    print(f"\n🔗 Pagina stream: {watch_url}")
    mp4_url = extract_mp4_url(watch_url)
    if mp4_url:
        print(f"\n🎬 LINK MP4 FINALE:\n   {mp4_url}\n")
        print("🎉 ✅ Estrazione completata con successo!")
        # Oggetto stream per Stremio
        stremio_stream = {
            "url": mp4_url,
            "headers": {
                "Referer": watch_url,
                "User-Agent": USER_AGENT
            }
        }
        print("\n🔗 Oggetto stream per Stremio:")
        print(json.dumps(stremio_stream, indent=2))
        # Link proxy universale
        proxy_base = "https://mfpi.pizzapi.uk/proxy/stream/"
        filename = mp4_url.split("/")[-1].split("?")[0]
        proxy_url = (
            f"{proxy_base}{urllib.parse.quote(filename)}?d={urllib.parse.quote(mp4_url)}"
            f"&api_password=mfp"
            f"&h_user-agent={urllib.parse.quote(USER_AGENT)}"
            f"&h_referer={urllib.parse.quote(watch_url)}"
        )
        print("\n🔗 Link proxy universale (VLC/Stremio/Browser):")
        print(proxy_url)
        # Download automatico (opzionale)
        # download_mp4(mp4_url, watch_url)
    else:
        print("❌ LINK MP4 FINALE: Estrazione fallita")
        print("\n💡 Possibili cause dell'errore:")
        print("   • Episodio non disponibile")
        print("   • Struttura della pagina cambiata")
        print("   • Problemi di connessione")

def main_cli():
    parser = argparse.ArgumentParser(description="AnimeSaturn Scraper CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    # Search command
    search_parser = subparsers.add_parser("search", help="Search for an anime")
    search_parser.add_argument("--query", required=True, help="Anime title to search for")

    # Get episodes command
    episodes_parser = subparsers.add_parser("get_episodes", help="Get episode list for an anime")
    episodes_parser.add_argument("--anime-url", required=True, help="AnimeSaturn URL of the anime")

    # Get stream command
    stream_parser = subparsers.add_parser("get_stream", help="Get stream URL for an episode")
    stream_parser.add_argument("--episode-url", required=True, help="AnimeSaturn episode URL")

    args = parser.parse_args()

    if args.command == "search":
        results = search_anime(args.query)
        print(json.dumps(results, indent=2))
    elif args.command == "get_episodes":
        results = get_episodes_list(args.anime_url)
        print(json.dumps(results, indent=2))
    elif args.command == "get_stream":
        watch_url = get_watch_url(args.episode_url)
        mp4_url = extract_mp4_url(watch_url) if watch_url else None
        stremio_stream = None
        if mp4_url:
            stremio_stream = {
                "url": mp4_url,
                "headers": {
                    "Referer": watch_url,
                    "User-Agent": USER_AGENT
                }
            }
        # Test: se vuoi solo il link mp4, restituisci {"url": mp4_url}
        print(json.dumps(stremio_stream if stremio_stream else {"url": mp4_url}, indent=2))

if __name__ == "__main__":
    if len(sys.argv) > 1:
        main_cli()
    else:
        main()