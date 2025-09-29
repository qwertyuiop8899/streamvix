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
import time
from typing import Optional

# Carica domini configurati
with open(os.path.join(os.path.dirname(__file__), '../../config/domains.json'), encoding='utf-8') as f:
    DOMAINS = json.load(f)

_RAW_DOMAIN = DOMAINS['animesaturn']
BASE_URL = f"https://{_RAW_DOMAIN}"
# Preferisci variante www (i redirect la usano) senza modificare file domini.
if not _RAW_DOMAIN.startswith('www.'):
    WWW_BASE_URL = f"https://www.{_RAW_DOMAIN}"
else:
    WWW_BASE_URL = BASE_URL
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
COMMON_HEADERS = {
    "User-Agent": USER_AGENT,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1"
}
HEADERS = {"User-Agent": USER_AGENT}
SESSION = requests.Session()  # sessione globale condivisa
DEBUG_MODE = os.getenv("ANIMESATURN_DEBUG", "0") == "1"
TIMEOUT = 30

def debug(msg: str):
    if DEBUG_MODE:
        print(f"[DEBUG] {msg}", file=sys.stderr)

def safe_ascii_header(value: str) -> str:
    """Rende sicuro un valore header rimpiazzando caratteri non ASCII."""
    return ''.join(c if 32 <= ord(c) < 127 else '?' for c in value)

def _set_cookie_variants(session: requests.Session, name: str, value: str):
    host_main = urllib.parse.urlparse(BASE_URL).hostname
    if not host_main:
        return
    variants = {host_main}
    if not host_main.startswith('www.'):
        variants.add('www.' + host_main)
    for d in variants:
        try:
            session.cookies.set(name, value, domain=d)
        except Exception as ce:
            debug(f"_set_cookie_variants errore {d}: {ce}")

def _sanitize_redirect(url: str) -> str:
    # Rimuovi :80 da URL https errati
    if url.startswith('https://') and ':80/' in url:
        return url.replace(':80/', '/')
    return url

def handle_challenge(resp: requests.Response, session: requests.Session, original_headers: dict) -> bool:
    """Gestisce pagina challenge ASFast/ASFast1-Cd impostando cookie e seguendo eventuale redirect.
    Ritorna True se viene trovato e impostato un cookie challenge."""
    try:
        text = resp.text
        # 1) Tentativo semplice: pattern diretto document.cookie="ASFast...=VAL" (non ofuscato)
        # Pattern più permissivo: cattura sia ASFast-XYZ= sia ASFast1-Cd=
        cookie_match = re.search(r'document.cookie="((?:ASFast1?-)[^=]+=[^";\s]+)', text)
        if cookie_match:
            cookie_kv = cookie_match.group(1).strip()
            if '=' in cookie_kv:
                name, value = cookie_kv.split('=', 1)
                _set_cookie_variants(session, name, value)
                debug(f"handle_challenge: impostato cookie {name}={value[:10]}... (inline)")
        else:
            # 2) Caso ofuscato: cookie costruito con slowAES.decrypt + toHex e concatenazione
            #   Esempio osservato (accorciato):
            #   var _0xdb1b=["push",...,"YjM2MTQx...="]; ... b2=atob(_0xdb1b[7]), b1=toNumbers(b2),
            #   c1=atob("ODJlYmY2..."), c2=toNumbers(c1), a3=toNumbers("e5b85d9a...");
            #   document.cookie="ASFast1-Bq="+toHex(slowAES.decrypt(a3,2,b1,c2))+";  path=/";
            if 'slowAES.decrypt' in text and 'toHex(slowAES.decrypt' in text:
                try:
                    # Estrai array _0xdb1b per ricavare indice 7 (chiave base64 ofuscata)
                    arr_match = re.search(r'var\s+_0xdb1b=\[(.*?)\];', text, re.DOTALL)
                    key_b64 = None
                    if arr_match:
                        # Split tenendo conto di possibili virgole; semplice perché valori sono stringhe senza virgole grezze
                        raw_items = arr_match.group(1).split(',')
                        items = []
                        for it in raw_items:
                            it = it.strip()
                            if it.startswith('"') and it.endswith('"'):
                                it = it[1:-1]
                            # decodifica escape tipo \x59
                            it_dec = bytes(it, 'utf-8').decode('unicode_escape')
                            items.append(it_dec)
                        if len(items) > 7:
                            key_b64 = items[7]
                    # Estrai c1 base64
                    c1_match = re.search(r'c1=atob\("([A-Za-z0-9+/=]+)"\)', text)
                    # Estrai a3 hex
                    a3_match = re.search(r'a3=toNumbers\("([0-9a-fA-F]+)"\)', text)
                    # Estrai nome cookie (ASFast1-XYZ) dal frammento document.cookie="ASFast1-...="+toHex(
                    name_match = re.search(r'document.cookie="((?:ASFast1?-)[^=+]+)="\+toHex', text)
                    if key_b64 and c1_match and a3_match and name_match:
                        import base64
                        from Crypto.Cipher import AES  # pycryptodome
                        def to_numbers(hex_str: str):
                            return [int(hex_str[i:i+2], 16) for i in range(0, len(hex_str), 2)]
                        # key
                        key_hex = base64.b64decode(key_b64).decode('utf-8')
                        iv_hex = base64.b64decode(c1_match.group(1)).decode('utf-8')
                        cipher_hex = a3_match.group(1)
                        key_bytes = bytes(to_numbers(key_hex))
                        iv_bytes = bytes(to_numbers(iv_hex))
                        cipher_bytes = bytes(to_numbers(cipher_hex))
                        # Mode 2 => CBC
                        cipher = AES.new(key_bytes, AES.MODE_CBC, iv_bytes)
                        plain = cipher.decrypt(cipher_bytes)
                        # toHex in JS: concat ogni byte in hex (sempre lowercase, no delimitatori)
                        cookie_value = ''.join(f'{b:02x}' for b in plain)
                        cookie_name = name_match.group(1)
                        _set_cookie_variants(session, cookie_name, cookie_value)
                        debug(f"handle_challenge: cookie AES calcolato {cookie_name}={cookie_value[:16]}...")
                except Exception as ce:
                    debug(f"handle_challenge: errore decode AES challenge: {ce}")
        # Se non trovato inline ma presenta script min.js prova fetch separato
        if 'min.js' in text and 'ASFast' not in text:
            try:
                js_resp = session.get(WWW_BASE_URL + '/min.js', headers=original_headers, timeout=(5, 10))
                if js_resp.status_code == 200:
                    js_text = js_resp.text
                    js_cookie = re.search(r'document.cookie="((?:ASFast1?-)[^=]+=[^";\s]+)', js_text)
                    if js_cookie:
                        kv = js_cookie.group(1)
                        if '=' in kv:
                            n,v = kv.split('=',1)
                            _set_cookie_variants(session, n, v)
                            debug(f"handle_challenge: impostato cookie {n} da min.js")
            except Exception as e:
                debug(f"handle_challenge: errore fetch min.js: {e}")
        # Gestione redirect (alcuni challenge rimandano a http://www.)
        redir = re.search(r'location.href=\"([^\"]+)\"', text)
        if redir:
            url = redir.group(1)
            # Forza https se necessario
            if url.startswith('http://'):
                url = url.replace('http://', 'https://')
            url = _sanitize_redirect(url)
            debug(f"handle_challenge: follow redirect -> {url}")
            try:
                session.get(url, headers=original_headers, timeout=(5, 10))
            except Exception as e:
                debug(f"handle_challenge: errore follow redirect: {e}")
        return True if 'ASFast' in text else False
    except Exception as e:
        debug(f"handle_challenge exception: {e}")
        return False


def prime_session(session: requests.Session):
    """Effettua richieste preliminari per ottenere cookie validi (homepage + www)."""
    for host in {BASE_URL, WWW_BASE_URL}:
        try:
            r = session.get(host + '/', headers=COMMON_HEADERS, timeout=(5,10))
            if (r.status_code in (200,202)) and 'document.cookie="ASFast' in r.text:
                handle_challenge(r, session, COMMON_HEADERS)
        except Exception as e:
            debug(f"prime_session errore {host}: {e}")

def search_anime(query, session: Optional[requests.Session] = None):
    """Ricerca anime tramite la barra di ricerca di AnimeSaturn, con paginazione"""
    # Usa sessione persistente per mantenere cookie e headers
    if session is None:
        # Usa sessione globale per conservare cookie challenge fra invocazioni
        session = SESSION
    global BASE_URL  # necessario per eventuale switch host
    results = []
    page = 1
    # Modalità strict: se settata ANIMESATURN_STRICT=1 alza eccezioni invece di restituire lista vuota
    STRICT_MODE = os.getenv("ANIMESATURN_STRICT", "0") == "1"
    MAX_RETRIES = 2  # ritenta su errori transitori (rete / JSON decode / content-type errato)
    challenge_saved = False  # salviamo solo la prima pagina challenge
    # Priming prima di iniziare
    prime_session(session)
    tried_www_switch = False
    while True:
        search_url = f"{BASE_URL}/index.php?search=1&key={query.replace(' ', '+')}&page={page}"
        referer_query = urllib.parse.quote_plus(query)
        headers = {
            "User-Agent": USER_AGENT,
            "Referer": safe_ascii_header(f"{BASE_URL}/animelist?search={referer_query}"),
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
            "Connection": "keep-alive"
        }
        debug(f"Search page={page} URL={search_url}")
        attempt = 0
        page_results = []
        while True:
            error_to_raise = None
            try:
                # timeout (connect, read) per evitare blocchi lunghi
                resp = session.get(search_url, headers=headers, timeout=(5, 20))
            except requests.exceptions.RequestException as e:
                error_to_raise = f"Errore rete: {e}"
            else:
                status = resp.status_code
                ctype = resp.headers.get('Content-Type', '')
                # Rilevamento page anti-bot / HTML imprevisto
                body_start = resp.text[:200]
                is_probably_html = '<html' in body_start.lower() and 'json' not in ctype.lower()
                # Bypass challenge: se status 202 o 200 HTML con script cookie
                challenge_cookie = None
                if (status == 202 or status == 200) and ('document.cookie="ASFast' in resp.text):
                    if not challenge_saved:
                        try:
                            with open('challenge_page.html', 'w', encoding='utf-8') as fch:
                                fch.write(resp.text)
                            debug("Salvata pagina challenge in challenge_page.html")
                        except Exception as fe:
                            debug(f"Impossibile salvare challenge_page.html: {fe}")
                        challenge_saved = True
                    # Prova gestione challenge
                    handled = handle_challenge(resp, session, headers)
                    if handled:
                        try:
                            resp = session.get(search_url, headers=headers, timeout=(5, 20))
                            status = resp.status_code
                            ctype = resp.headers.get('Content-Type', '')
                            body_start = resp.text[:200]
                            is_probably_html = '<html' in body_start.lower() and 'json' not in ctype.lower()
                        except Exception as e2:
                            error_to_raise = f"Errore rete dopo handle_challenge: {e2}"
                        else:
                            debug(f"Retry post-challenge status={status}")
                    else:
                        debug("Challenge pattern rilevato ma non gestito (regex mismatch)")

                if not error_to_raise:
                    if status != 200 and 'document.cookie="ASFast' not in resp.text:
                        snippet = body_start.replace('\n', ' ')[:160]
                        error_to_raise = f"HTTP {status} non-200 snippet='{snippet}...'"
                    else:
                        body_trim = body_start.lstrip()
                        looks_like_json = body_trim.startswith('{') or body_trim.startswith('[')
                        content_is_json = 'json' in ctype.lower()
                        if content_is_json or looks_like_json:
                            try:
                                page_results = resp.json()
                            except Exception as e:
                                snippet = body_start.replace('\n', ' ')[:160]
                                error_to_raise = f"JSONDecodeError: {e} snippet='{snippet}...'"
                            else:
                                if not content_is_json:
                                    debug(f"Forzato parsing JSON (ctype={ctype})")
                                break
                        else:
                            snippet = body_start.replace('\n', ' ')[:160]
                            error_to_raise = f"Content-Type={ctype} non-json e body non riconosciuto come JSON snippet='{snippet}...'"

            if error_to_raise:
                debug(f"Tentativo {attempt+1}/{MAX_RETRIES+1} fallito page={page}: {error_to_raise}")
                if attempt < MAX_RETRIES:
                    attempt += 1
                    time.sleep(1 + attempt * 0.5)
                    continue
                # Esauriti tentativi
                if STRICT_MODE:
                    raise RuntimeError(f"search_anime fallita page={page}: {error_to_raise}")
                # Modalità non-strict: interrompe la paginazione. Se page==1 results resterà vuoto
                page_results = []
                break
        # Fine while retry
        if not page_results:
            if page == 1 and not tried_www_switch and BASE_URL != WWW_BASE_URL:
                debug("Prima pagina vuota: provo switch host WWW")
                BASE_URL = WWW_BASE_URL
                prime_session(session)
                tried_www_switch = True
                continue
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

def get_watch_url(episode_url, session: Optional[requests.Session] = None):
    if session is None:
        session = SESSION
    print(f"[DEBUG] GET watch URL da: {episode_url}", file=sys.stderr)
    resp = session.get(episode_url, headers=HEADERS, timeout=TIMEOUT)
    if (resp.status_code in (200,202)) and 'document.cookie="ASFast' in resp.text:
        handled = handle_challenge(resp, session, HEADERS)
        if handled:
            try:
                resp = session.get(episode_url, headers=HEADERS, timeout=TIMEOUT)
            except Exception as e:
                debug(f"get_watch_url retry errore: {e}")
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

def extract_mp4_url(watch_url, session: Optional[requests.Session] = None):
    if session is None:
        session = SESSION
    print(f"[DEBUG] Analisi URL: {watch_url}", file=sys.stderr)
    resp = session.get(watch_url, headers=HEADERS, timeout=TIMEOUT)
    if (resp.status_code in (200,202)) and 'document.cookie="ASFast' in resp.text:
        handled = handle_challenge(resp, session, HEADERS)
        if handled:
            try:
                resp = session.get(watch_url, headers=HEADERS, timeout=TIMEOUT)
            except Exception as e:
                debug(f"extract_mp4_url retry errore: {e}")
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
            alt_resp = session.get(player_alternativo, headers=HEADERS, timeout=TIMEOUT)
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

def get_episodes_list(anime_url, session: Optional[requests.Session] = None):
    if session is None:
        session = SESSION
    # Retry robusto per mitigare ConnectionResetError / reset TLS
    attempts = 0
    max_attempts = 4
    last_exc = None
    while attempts < max_attempts:
        try:
            # Alcuni reset avvengono con keep-alive: forziamo header Connection
            headers = dict(HEADERS)
            headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            headers["Connection"] = "close" if attempts > 0 else "keep-alive"
            headers["Referer"] = BASE_URL + "/"
            resp = session.get(anime_url, headers=headers, timeout=(5, TIMEOUT))
            if (resp.status_code in (200,202)) and 'document.cookie="ASFast' in resp.text:
                handled = handle_challenge(resp, session, headers)
                if handled:
                    resp = session.get(anime_url, headers=headers, timeout=(5, TIMEOUT))
            resp.raise_for_status()
            soup = BeautifulSoup(resp.text, "html.parser")
            break
        except requests.exceptions.ConnectionError as ce:
            last_exc = ce
            debug(f"get_episodes_list ConnectionError attempt={attempts+1}: {ce}")
        except Exception as e:
            last_exc = e
            debug(f"get_episodes_list generic error attempt={attempts+1}: {e}")
        attempts += 1
        time.sleep(0.6 * attempts)
    else:
        # Exhausted attempts
        raise last_exc if last_exc else RuntimeError("get_episodes_list fallita senza eccezione specifica")
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

## RIMOSSO: ricerca HTML separata (non più necessaria con bypass robusto)

def search_anime_by_title_or_malid(title, mal_id, session: Optional[requests.Session] = None):
    debug(f"INIZIO: title={title}, mal_id={mal_id}")
    if session is None:
        session = requests.Session()

    def fetch_with_challenge(url: str, max_challenge: int = 2):
        """Recupera una pagina anime gestendo eventuale challenge ASFast e restituisce BeautifulSoup o None."""
        attempts = 0
        headers = {
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
            "Connection": "keep-alive",
            "Referer": BASE_URL + "/"
        }
        while attempts <= max_challenge:
            try:
                r = session.get(url, headers=headers, timeout=(5, TIMEOUT))
            except Exception as e:
                debug(f"fetch_with_challenge errore rete ({attempts}): {e}")
                return None
            status = r.status_code
            if (status == 202 or status == 200) and 'document.cookie="ASFast' in r.text and attempts < max_challenge:
                debug(f"fetch_with_challenge challenge detail status={status} url={url}")
                handled = handle_challenge(r, session, headers)
                attempts += 1
                if handled:
                    continue
                else:
                    break
            # Se 200 normale
            if status == 200:
                return BeautifulSoup(r.text, 'html.parser')
            debug(f"fetch_with_challenge status={status} non gestito url={url}")
            break
        return None

    # Helper function to check a list of results for a MAL ID match
    def check_results_for_mal_id(results_list, target_mal_id, search_step_name):
        if not results_list:
            debug(f"{search_step_name}: Nessun risultato da controllare.")
            return None
        
        debug(f"{search_step_name}: Controllo {len(results_list)} risultati...")
        matched_items = []
        for item in results_list:
            try:
                soup = fetch_with_challenge(item["url"])
                if soup is None:
                    debug(f"Errore fetch '{item['title']}' (soup None)")
                    continue
                mal_btn = soup.find("a", href=re.compile(r"myanimelist\.net/anime/(\d+)"))
                if mal_btn:
                    found_id_match = re.search(r"myanimelist\.net/anime/(\d+)", mal_btn["href"])
                    if found_id_match:
                        found_id = found_id_match.group(1)
                        debug(f"-> Controllo '{item['title']}': trovato MAL ID {found_id} (cerco {target_mal_id})")
                        if found_id == str(target_mal_id):
                            debug("MATCH TROVATO!")
                            matched_items.append(item)
            except Exception as e:
                debug(f"Errore visitando '{item['title']}': {e}")
        if matched_items:
            return matched_items
        debug(f"{search_step_name}: Nessun match trovato.")
        return None  # No match in this batch

    # --- Fallback Chain ---

    # 1. Ricerca diretta per titolo completo
    direct_results = search_anime(title, session=session)
    matches = check_results_for_mal_id(direct_results, mal_id, "Ricerca Diretta") or []
    debug(f"matches finali: {matches}")

    if matches:
        # Deduplica per url
        seen = set()
        deduped = []
        for m in matches:
            if m['url'] not in seen:
                deduped.append(m)
                seen.add(m['url'])
        return deduped

    debug("NESSUN MATCH TROVATO.")
    return []

def main():
    print("🎬 === AnimeSaturn MP4 Link Extractor === 🎬")
    print("Estrae il link MP4 diretto dagli episodi di animesaturn.cx\n")
    query = input("🔍 Nome anime da cercare: ").strip()
    if not query:
        print("❌ Query vuota, uscita.")
        return
    print(f"\n⏳ Ricerca di '{query}' in corso...")
    anime_results = search_anime(query, session=SESSION)
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
    episodes = get_episodes_list(selected["url"], session=SESSION)
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
    watch_url = get_watch_url(ep_selected["url"], session=SESSION)
    if not watch_url:
        print("❌ Link stream non trovato nella pagina episodio.")
        return
    print(f"\n🔗 Pagina stream: {watch_url}")
    mp4_url = extract_mp4_url(watch_url, session=SESSION)
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
            results = search_anime_by_title_or_malid(args.query, args.mal_id, session=SESSION)
        else:
            results = search_anime(args.query, session=SESSION)
        print(json.dumps(results, indent=2))
        return
    if args.command == "get_episodes":
        results = get_episodes_list(args.anime_url, session=SESSION)
        print(json.dumps(results, indent=2))
        return
    if args.command == "get_stream":
        watch_url = get_watch_url(args.episode_url, session=SESSION)
        stream_url = extract_mp4_url(watch_url, session=SESSION) if watch_url else None
        stremio_stream = None
        if stream_url:
            if stream_url.endswith('.m3u8'):
                mfp_proxy_url = getattr(args, "mfp_proxy_url", None)
                mfp_proxy_password = getattr(args, "mfp_proxy_password", None)
                if mfp_proxy_url and mfp_proxy_password:
                    mfp_url_normalized = mfp_proxy_url.replace('https://','').replace('http://','')
                    if mfp_url_normalized.endswith('/'):
                        mfp_url_normalized = mfp_url_normalized[:-1]
                    proxy_url = f"https://{mfp_url_normalized}/proxy/hls/manifest.m3u8?d={stream_url}&api_password={mfp_proxy_password}"
                    stremio_stream = {"url": proxy_url, "headers": {"Referer": watch_url, "User-Agent": USER_AGENT}}
                else:
                    stremio_stream = {"url": stream_url, "headers": {"Referer": watch_url, "User-Agent": USER_AGENT}}
            else:
                stremio_stream = {"url": stream_url, "headers": {"Referer": watch_url, "User-Agent": USER_AGENT}}
        print(json.dumps(stremio_stream if stremio_stream else {"url": stream_url}, indent=2))
        return

if __name__ == "__main__":
    if len(sys.argv) > 1:
        main_cli()
    else:
        main()
