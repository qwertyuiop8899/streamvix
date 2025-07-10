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
import os
with open(os.path.join(os.path.dirname(__file__), '../../config/domains.json'), encoding='utf-8') as f:
    DOMAINS = json.load(f)
BASE_URL = f"https://{DOMAINS['animesaturn']}"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
HEADERS = {"User-Agent": USER_AGENT}
TIMEOUT = 20

def safe_ascii_header(value):
    # Remove or replace non-latin-1 characters (e.g., typographic apostrophes)
    return value.encode('latin-1', 'ignore').decode('latin-1')

def search_anime(query):
    """Ricerca anime tramite la barra di ricerca di AnimeSaturn, con paginazione"""
    results = []
    page = 1
    while True:
        search_url = f"{BASE_URL}/index.php?search=1&key={query.replace(' ', '+')}&page={page}"
        referer_query = urllib.parse.quote_plus(query)
        headers = {
            "User-Agent": USER_AGENT,
            "Referer": safe_ascii_header(f"{BASE_URL}/animelist?search={referer_query}"),
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/javascript, */*; q=0.01"
        }
        resp = requests.get(search_url, headers=headers, timeout=TIMEOUT)
        resp.raise_for_status()
        page_results = resp.json()
        if not page_results:
            break
        for item in page_results:
            results.append({
                "title": item["name"],
                "url": f"{BASE_URL}/anime/{item['link']}"
            })
        # Se meno di 20 risultati (o la quantità che AnimeSaturn mostra per pagina), siamo all'ultima pagina
        if len(page_results) < 20:
            break
        page += 1
    return results

def get_watch_url(episode_url):
    print(f"[DEBUG] GET watch URL da: {episode_url}", file=sys.stderr)
    resp = requests.get(episode_url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    html_content = resp.text
    soup = BeautifulSoup(html_content, "html.parser")
    
    # Stampa tutti i link per debug
    print("[DEBUG] Lista di tutti i link nella pagina:", file=sys.stderr)
    for a in soup.find_all("a", href=True):
        if "/watch" in a["href"]:
            print(f"[DEBUG] LINK TROVATO: {a.get_text().strip()[:30]} => {a['href']}", file=sys.stderr)
    
    # Cerca il link con testo "Guarda lo streaming"
    for a in soup.find_all("a", href=True):
        div = a.find("div")
        if div and "Guarda lo streaming" in div.get_text():
            url = a["href"] if a["href"].startswith("http") else BASE_URL + a["href"]
            print(f"[DEBUG] Trovato link 'Guarda lo streaming': {url}", file=sys.stderr)
            return url
    
    # Cerca qualsiasi link che contenga "/watch"
    for a in soup.find_all("a", href=True):
        if "/watch" in a["href"]:
            url = a["href"] if a["href"].startswith("http") else BASE_URL + a["href"]
            print(f"[DEBUG] Trovato link generico watch: {url}", file=sys.stderr)
            return url
    
    # Fallback: cerca il link alla pagina watch
    watch_link = soup.find("a", href=re.compile(r"/watch"))
    if watch_link:
        url = watch_link["href"] if watch_link["href"].startswith("http") else BASE_URL + watch_link["href"]
        print(f"[DEBUG] Trovato link watch (a): {url}", file=sys.stderr)
        return url
    
    # Cerca in iframe
    iframe = soup.find("iframe", src=re.compile(r"/watch"))
    if iframe:
        url = iframe["src"] if iframe["src"].startswith("http") else BASE_URL + iframe["src"]
        print(f"[DEBUG] Trovato link watch (iframe): {url}", file=sys.stderr)
        return url
    
    # Cerca pulsanti con "Guarda" nel testo
    for button in soup.find_all(["button", "a"], class_=re.compile(r"btn|button")):
        if "Guarda" in button.get_text():
            print(f"[DEBUG] Trovato pulsante con 'Guarda': {button}", file=sys.stderr)
            if button.name == "a" and button.get("href"):
                url = button["href"] if button["href"].startswith("http") else BASE_URL + button["href"]
                print(f"[DEBUG] Trovato link nel pulsante: {url}", file=sys.stderr)
                return url
    
    # Debug se non trova nulla
    print(f"[DEBUG] Nessun link watch trovato nella pagina", file=sys.stderr)
    with open("debug_page.html", "w", encoding="utf-8") as f:
        f.write(html_content)
    print(f"[DEBUG] Salvata pagina di debug in debug_page.html", file=sys.stderr)
    return None

def extract_mp4_url(watch_url):
    print(f"[DEBUG] Analisi URL: {watch_url}", file=sys.stderr)
    resp = requests.get(watch_url, headers=HEADERS, timeout=TIMEOUT)
    resp.raise_for_status()
    html_content = resp.text
    soup = BeautifulSoup(html_content, "html.parser")
    
    print(f"[DEBUG] Dimensione HTML: {len(html_content)} caratteri", file=sys.stderr)
    
    # Metodo 1: Cerca direttamente il link mp4 nel sorgente (metodo originale)
    mp4_match = re.search(r'https://[\w\.-]+/[^"\']+\.mp4', html_content)
    if mp4_match:
        print(f"[DEBUG] Trovato MP4 con metodo 1: {mp4_match.group(0)}", file=sys.stderr)
        return mp4_match.group(0)
    
    # Metodo 2: Analizza i tag video/source (metodo originale)
    video = soup.find("video", class_="vjs-tech")
    if video:
        print(f"[DEBUG] Trovato video con classe vjs-tech", file=sys.stderr)
        source = video.find("source")
        if source and source.get("src"):
            print(f"[DEBUG] Trovato source in vjs-tech: {source['src']}", file=sys.stderr)
            return source["src"]
    else:
        print("[DEBUG] Nessun video con classe vjs-tech trovato", file=sys.stderr)
    
    # Metodo 3: Cerca nel tag video con classe jw-video (nuovo metodo)
    jw_video = soup.find("video", class_="jw-video")
    if jw_video:
        print(f"[DEBUG] Trovato video con classe jw-video", file=sys.stderr)
        if jw_video.get("src"):
            print(f"[DEBUG] Trovato src in jw-video: {jw_video['src']}", file=sys.stderr)
            return jw_video["src"]
    else:
        print("[DEBUG] Nessun video con classe jw-video trovato", file=sys.stderr)
    
    # Metodo 4: Cerca link m3u8 nel jwplayer setup
    m3u8_match = re.search(r'jwplayer\([\'"]player_hls[\'"]\)\.setup\(\{\s*file:\s*[\'"]([^"\']+\.m3u8)[\'"]', html_content)
    if m3u8_match:
        print(f"[DEBUG] Trovato m3u8 con metodo jwplayer: {m3u8_match.group(1)}", file=sys.stderr)
        return m3u8_match.group(1)
    
    # Cercare in altri posti della pagina per link alternativi
    player_alternativo = None
    for a in soup.find_all("a", href=True):
        if a.text and "Player alternativo" in a.text:
            player_alternativo = a["href"]
            if not player_alternativo.startswith('http'):
                player_alternativo = BASE_URL + player_alternativo
            print(f"[DEBUG] Trovato link a player alternativo: {player_alternativo}", file=sys.stderr)
            break
    
    # Se trovato un link al player alternativo, visita quella pagina
    if player_alternativo:
        try:
            alt_resp = requests.get(player_alternativo, headers=HEADERS, timeout=TIMEOUT)
            alt_resp.raise_for_status()
            alt_soup = BeautifulSoup(alt_resp.text, "html.parser")
            alt_html = alt_resp.text
            
            print(f"[DEBUG] Dimensione HTML player alternativo: {len(alt_html)} caratteri", file=sys.stderr)
            
            # Cerca mp4 nei metodi alternativi
            alt_mp4_match = re.search(r'https://[\w\.-]+/[^"\']+\.mp4', alt_html)
            if alt_mp4_match:
                print(f"[DEBUG] Trovato MP4 nel player alternativo: {alt_mp4_match.group(0)}", file=sys.stderr)
                return alt_mp4_match.group(0)
            
            # Cerca source in video
            alt_video = alt_soup.find("video")
            if alt_video:
                print(f"[DEBUG] Trovato video nel player alternativo", file=sys.stderr)
                alt_source = alt_video.find("source")
                if alt_source and alt_source.get("src"):
                    print(f"[DEBUG] Trovato source nel player alternativo: {alt_source['src']}", file=sys.stderr)
                    return alt_source["src"]
            
            # Cerca m3u8 nel player alternativo
            m3u8_match = re.search(r'src=[\'"]([^"\']+\.m3u8)[\'"]', alt_html)
            if m3u8_match:
                print(f"[DEBUG] Trovato m3u8 nel player alternativo: {m3u8_match.group(1)}", file=sys.stderr)
                return m3u8_match.group(1)
            
            # Stampa i primi server disponibili per debug
            server_dropdown = alt_soup.find("div", class_="dropdown-menu")
            if server_dropdown:
                print("[DEBUG] Server disponibili nel player alternativo:", file=sys.stderr)
                for a in server_dropdown.find_all("a", href=True):
                    print(f"[DEBUG] - {a.text.strip()}: {a['href']}", file=sys.stderr)
            
            # Prova a trovare iframe con video
            iframe = alt_soup.find("iframe")
            if iframe and iframe.get("src"):
                print(f"[DEBUG] Trovato iframe nel player alternativo: {iframe['src']}", file=sys.stderr)
            
        except Exception as e:
            print(f"[DEBUG] Errore cercando nel player alternativo: {e}", file=sys.stderr)
    else:
        print("[DEBUG] Nessun player alternativo trovato", file=sys.stderr)
    
    # Debug finale
    print("[DEBUG] Nessun link trovato dopo tutti i tentativi", file=sys.stderr)
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

def search_anime_html(query, max_pages=3):
    """Ricerca anime tramite la pagina HTML di AnimeSaturn, con paginazione solo se necessario"""
    results = []
    page = 1
    while page <= max_pages:
        url = f'{BASE_URL}/animelist?search={urllib.parse.quote_plus(query)}&page={page}'
        resp = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        soup = BeautifulSoup(resp.text, 'html.parser')
        # Seleziona solo i link principali ai dettagli anime
        for a in soup.select('div.item-archivio h3 a[href^="/anime/"], div.item-archivio h3 a[href^="https://www.animesaturn.cx/anime/"]'):
            title = a.get_text(strip=True)
            href = a['href']
            if not href.startswith('http'):
                href = BASE_URL + href
            if not any(r['url'] == href for r in results):
                results.append({'title': title, 'url': href, 'page': page})
                print(f"[DEBUG] Trovato titolo: {title} (url: {href})", file=sys.stderr)
        pagination = soup.select_one('ul.pagination')
        next_btn = soup.select_one('li.page-item.next:not(.disabled)')
        if not (pagination and next_btn):
            break
        page += 1
    return results

def search_anime_by_title_or_malid(title, mal_id):
    print(f"[DEBUG] INIZIO: title={title}, mal_id={mal_id}", file=sys.stderr)

    # Helper function to check a list of results for a MAL ID match
    def check_results_for_mal_id(results_list, target_mal_id, search_step_name):
        if not results_list:
            print(f"[DEBUG] {search_step_name}: Nessun risultato da controllare.", file=sys.stderr)
            return None
        
        print(f"[DEBUG] {search_step_name}: Controllo {len(results_list)} risultati...", file=sys.stderr)
        matched_items = []
        for item in results_list:
            try:
                resp = requests.get(item["url"], headers=HEADERS, timeout=TIMEOUT)
                resp.raise_for_status()
                soup = BeautifulSoup(resp.text, "html.parser")
                mal_btn = soup.find("a", href=re.compile(r"myanimelist\.net/anime/(\d+)"))
                if mal_btn:
                    found_id_match = re.search(r"myanimelist\.net/anime/(\d+)", mal_btn["href"])
                    if found_id_match:
                        found_id = found_id_match.group(1)
                        print(f"[DEBUG] -> Controllo '{item['title']}': trovato MAL ID {found_id} (cerco {target_mal_id})", file=sys.stderr)
                        if found_id == str(target_mal_id):
                            print(f"[DEBUG] MATCH TROVATO!", file=sys.stderr)
                            matched_items.append(item)
            except Exception as e:
                print(f"[DEBUG] Errore visitando '{item['title']}': {e}", file=sys.stderr)
        if matched_items:
            return matched_items
        print(f"[DEBUG] {search_step_name}: Nessun match trovato.", file=sys.stderr)
        return None  # No match in this batch

    # --- Fallback Chain ---

    # 1. Ricerca diretta per titolo completo
    direct_results = search_anime(title)
    matches = check_results_for_mal_id(direct_results, mal_id, "Step 1: Ricerca Diretta") or []
    print(f"[DEBUG] matches dopo ricerca diretta: {matches}", file=sys.stderr)

    # 2. Fallback: Titolo troncato all'apostrofo
    if not matches and ("'" in title or "’" in title or "‘" in title):
        last_apos = max(title.rfind(c) for c in ["'", "’", "‘"])
        if last_apos != -1:
            truncated_title = title[:last_apos].strip()
            print(f"[DEBUG] Titolo troncato per Fallback #1: '{truncated_title}'", file=sys.stderr)
            truncated_results = search_anime(truncated_title)
            matches += check_results_for_mal_id(truncated_results, mal_id, "Step 2: Ricerca Titolo Troncato") or []
    print(f"[DEBUG] matches dopo troncato: {matches}", file=sys.stderr)

    # 3. Fallback finale: Ricerca fuzzy con prime 3 lettere
    if not matches:
        print(f"[DEBUG] PRIMA DELLA FUZZY: matches={matches}", file=sys.stderr)
        short_key = title[:3]
        print(f"[DEBUG] Avvio fallback fuzzy: chiave '{short_key}'", file=sys.stderr)
        # Usa la ricerca HTML per la fuzzy search
        fuzzy_results = search_anime_html(short_key)
        print(f"[DEBUG] Fuzzy search ha trovato {len(fuzzy_results)} risultati", file=sys.stderr)
        # Evita duplicati
        urls_to_skip = {r['url'] for r in (direct_results or [])}
        unique_fuzzy_results = [r for r in fuzzy_results if r['url'] not in urls_to_skip]
        fuzzy_matches = []
        found_normal = None
        found_ita = None
        found_cr = None
        found_count = 0
        for item in unique_fuzzy_results:
            try:
                print(f"[DEBUG] Visito URL: {item['url']}", file=sys.stderr)
                resp = requests.get(item["url"], headers=HEADERS, timeout=TIMEOUT)
                resp.raise_for_status()
                soup = BeautifulSoup(resp.text, "html.parser")
                mal_btn = soup.find("a", href=re.compile(r"myanimelist\.net/anime/(\d+)"))
                if mal_btn:
                    found_id_match = re.search(r"myanimelist\.net/anime/(\d+)", mal_btn["href"])
                    if found_id_match:
                        found_id = found_id_match.group(1)
                        print(f"[DEBUG] -> Controllo '{item['title']}': trovato MAL ID {found_id} (cerco {mal_id})", file=sys.stderr)
                        if found_id == str(mal_id):
                            print(f"[DEBUG] MATCH TROVATO!", file=sys.stderr)
                            t_upper = item['title'].upper()
                            if not found_normal and '(ITA' not in t_upper and '(CR' not in t_upper:
                                found_normal = item
                                found_count += 1
                            elif not found_ita and '(ITA' in t_upper:
                                found_ita = item
                                found_count += 1
                            elif not found_cr and '(CR' in t_upper:
                                found_cr = item
                            # Se hai trovato normal e ita, continua a cercare CR fino a fine terza pagina
                            if found_normal and found_ita and found_cr:
                                break
            except Exception as e:
                print(f"[DEBUG] Errore visitando '{item['title']}': {e}", file=sys.stderr)
            # Se hai già trovato normal e ita e sei oltre la terza pagina, esci
            if item.get('page', 1) >= 3 and found_normal and found_ita:
                break
        # Aggiungi le versioni trovate
        if found_normal:
            fuzzy_matches.append(found_normal)
        if found_ita:
            fuzzy_matches.append(found_ita)
        if found_cr:
            fuzzy_matches.append(found_cr)
        print(f"[DEBUG] fuzzy_matches trovati: {fuzzy_matches}", file=sys.stderr)
        if fuzzy_matches and len(fuzzy_matches) >= 2:
            seen = set()
            deduped = []
            for m in fuzzy_matches:
                if m['url'] not in seen:
                    deduped.append(m)
                    seen.add(m['url'])
            return deduped
        matches += fuzzy_matches
    print(f"[DEBUG] matches finali: {matches}", file=sys.stderr)

    if matches:
        # Deduplica per url
        seen = set()
        deduped = []
        for m in matches:
            if m['url'] not in seen:
                deduped.append(m)
                seen.add(m['url'])
        return deduped

    print(f"[DEBUG] NESSUN MATCH TROVATO dopo tutti i tentativi.", file=sys.stderr)
    return []

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
    search_parser.add_argument("--mal-id", required=False, help="MAL ID to match in fallback search")

    # Get episodes command
    episodes_parser = subparsers.add_parser("get_episodes", help="Get episode list for an anime")
    episodes_parser.add_argument("--anime-url", required=True, help="AnimeSaturn URL of the anime")

    # Get stream command
    stream_parser = subparsers.add_parser("get_stream", help="Get stream URL for an episode")
    stream_parser.add_argument("--episode-url", required=True, help="AnimeSaturn episode URL")
    stream_parser.add_argument("--mfp-proxy-url", required=False, help="MediaFlow Proxy URL for m3u8 streams")
    stream_parser.add_argument("--mfp-proxy-password", required=False, help="MediaFlow Proxy Password for m3u8 streams")

    args = parser.parse_args()

    if args.command == "search":
        if getattr(args, "mal_id", None):
            results = search_anime_by_title_or_malid(args.query, args.mal_id)
        else:
            results = search_anime(args.query)
        print(json.dumps(results, indent=2))
    elif args.command == "get_episodes":
        results = get_episodes_list(args.anime_url)
        print(json.dumps(results, indent=2))
    elif args.command == "get_stream":
        watch_url = get_watch_url(args.episode_url)
        stream_url = extract_mp4_url(watch_url) if watch_url else None
        stremio_stream = None
        
        if stream_url:
            # Verificare se è un URL m3u8
            if stream_url.endswith(".m3u8"):
                # Leggi i parametri di proxy MFP (se sono stati passati come argomento)
                mfp_proxy_url = getattr(args, "mfp_proxy_url", None)
                mfp_proxy_password = getattr(args, "mfp_proxy_password", None)
                
                if mfp_proxy_url and mfp_proxy_password:
                    # Costruisci URL proxy per l'm3u8, rimuovendo eventuali https:// già presenti nell'URL
                    mfp_url_normalized = mfp_proxy_url.replace("https://", "").replace("http://", "")
                    if mfp_url_normalized.endswith("/"):
                        mfp_url_normalized = mfp_url_normalized[:-1]
                    proxy_url = f"https://{mfp_url_normalized}/proxy/hls/manifest.m3u8?d={stream_url}&api_password={mfp_proxy_password}"
                    stremio_stream = {
                        "url": proxy_url,
                        "headers": {
                            "Referer": watch_url,
                            "User-Agent": USER_AGENT
                        }
                    }
                else:
                    # Se non ci sono parametri proxy, usa l'URL diretto
                    stremio_stream = {
                        "url": stream_url,
                        "headers": {
                            "Referer": watch_url,
                            "User-Agent": USER_AGENT
                        }
                    }
            else:
                # Per gli URL MP4, usa il formato originale
                stremio_stream = {
                    "url": stream_url,
                    "headers": {
                        "Referer": watch_url,
                        "User-Agent": USER_AGENT
                    }
                }
                
        # Test: se vuoi solo il link, restituisci {"url": stream_url}
        print(json.dumps(stremio_stream if stremio_stream else {"url": stream_url}, indent=2))

if __name__ == "__main__":
    if len(sys.argv) > 1:
        main_cli()
    else:
        main()
