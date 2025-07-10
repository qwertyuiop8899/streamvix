#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
vavoo_resolver.py
Script unico: dato il nome del canale, trova il link Vavoo e lo risolve in tempo reale.
"""
import sys
import requests
import json
import os
import re

with open(os.path.join(os.path.dirname(__file__), 'config/domains.json'), encoding='utf-8') as f:
    DOMAINS = json.load(f)

VAVOO_DOMAIN = DOMAINS.get("vavoo")

def getAuthSignature():
    """Funzione che replica esattamente quella dell'addon utils.py"""
    headers = {
        "user-agent": "okhttp/4.11.0",
        "accept": "application/json",
        "content-type": "application/json; charset=utf-8",
        "content-length": "1106",
        "accept-encoding": "gzip"
    }
    data = {
        "token": "tosFwQCJMS8qrW_AjLoHPQ41646J5dRNha6ZWHnijoYQQQoADQoXYSo7ki7O5-CsgN4CH0uRk6EEoJ0728ar9scCRQW3ZkbfrPfeCXW2VgopSW2FWDqPOoVYIuVPAOnXCZ5g",
        "reason": "app-blur",
        "locale": "de",
        "theme": "dark",
        "metadata": {
            "device": {
                "type": "Handset",
                "brand": "google",
                "model": "Nexus",
                "name": "21081111RG",
                "uniqueId": "d10e5d99ab665233"
            },
            "os": {
                "name": "android",
                "version": "7.1.2",
                "abis": ["arm64-v8a", "armeabi-v7a", "armeabi"],
                "host": "android"
            },
            "app": {
                "platform": "android",
                "version": "3.1.20",
                "buildId": "289515000",
                "engine": "hbc85",
                "signatures": ["6e8a975e3cbf07d5de823a760d4c2547f86c1403105020adee5de67ac510999e"],
                "installer": "app.revanced.manager.flutter"
            },
            "version": {
                "package": "tv.vavoo.app",
                "binary": "3.1.20",
                "js": "3.1.20"
            }
        },
        "appFocusTime": 0,
        "playerActive": False,
        "playDuration": 0,
        "devMode": False,
        "hasAddon": True,
        "castConnected": False,
        "package": "tv.vavoo.app",
        "version": "3.1.20",
        "process": "app",
        "firstAppStart": 1743962904623,
        "lastAppStart": 1743962904623,
        "ipLocation": "",
        "adblockEnabled": True,
        "proxy": {
            "supported": ["ss", "openvpn"],
            "engine": "ss",
            "ssVersion": 1,
            "enabled": True,
            "autoServer": True,
            "id": "pl-waw"
        },
        "iap": {
            "supported": False
        }
    }
    try:
        # Usa sempre il dominio ufficiale per la signature!
        resp = requests.post("https://www.vavoo.tv/api/app/ping", json=data, headers=headers, timeout=10)
        resp.raise_for_status()
        return resp.json().get("addonSig")
    except Exception as e:
        print(f"Errore nel recupero della signature: {e}", file=sys.stderr)
        return None

def get_channels():
    signature = getAuthSignature()
    if not signature:
        print("[DEBUG] Failed to get signature for channels", file=sys.stderr)
        return []
    
    headers = {
        "user-agent": "okhttp/4.11.0",
        "accept": "application/json",
        "content-type": "application/json; charset=utf-8",
        "accept-encoding": "gzip",
        "mediahubmx-signature": signature
    }
    all_channels = []
    # Lista dei gruppi da controllare per i canali TV
    groups = ["Italy"]
    for group in groups:
        cursor = 0
        while True:
            data = {
                "language": "de",
                "region": "AT",
                "catalogId": "iptv",
                "id": "iptv",
                "adult": False,
                "search": "",
                "sort": "name",
                "filter": {"group": group},
                "cursor": cursor,
                "clientVersion": "3.0.2"
            }
            try:
                resp = requests.post(f"https://{VAVOO_DOMAIN}/mediahubmx-catalog.json", json=data, headers=headers, timeout=10)
                resp.raise_for_status()
                r = resp.json()
                items = r.get("items", [])
                all_channels.extend(items)
                cursor = r.get("nextCursor")
                if not cursor:
                    break
            except Exception as e:
                print(f"[DEBUG] Error getting channels: {e}", file=sys.stderr)
                break
    return all_channels

def resolve_vavoo_link(link):
    signature = getAuthSignature()
    if not signature:
        print("[DEBUG] Failed to get signature for resolution", file=sys.stderr)
        return None
        
    headers = {
        "user-agent": "MediaHubMX/2",
        "accept": "application/json",
        "content-type": "application/json; charset=utf-8",
        "content-length": "115",
        "accept-encoding": "gzip",
        "mediahubmx-signature": signature
    }
    data = {
        "language": "de",
        "region": "AT",
        "url": link,
        "clientVersion": "3.0.2"
    }
    try:
        resp = requests.post(f"https://{VAVOO_DOMAIN}/mediahubmx-resolve.json", json=data, headers=headers, timeout=10)
        resp.raise_for_status()
        result = resp.json()
        if isinstance(result, list) and result and result[0].get("url"):
            return result[0]["url"]
        elif isinstance(result, dict) and result.get("url"):
            return result["url"]
        else:
            print(f"[DEBUG] Unexpected response format: {result}", file=sys.stderr)
            return None
    except Exception as e:
        print(f"[DEBUG] Error resolving link: {e}", file=sys.stderr)
        return None

def normalize_vavoo_name(name):
    # Rimuove suffisso tipo ' .c', ' .a', ' .b' alla fine
    name = name.strip()
    name = re.sub(r'\s+\.[a-zA-Z]$', '', name)
    return name.upper()

def resolve_direct_link(link):
    """Risolve direttamente un link Vavoo (come vavoofunzionante.py)"""
    if not "vavoo" in link:
        print("[DEBUG] Il link non sembra essere un link Vavoo", file=sys.stderr)
        return None
        
    signature = getAuthSignature()
    if not signature:
        print("[DEBUG] Failed to get signature for direct resolution", file=sys.stderr)
        return None
        
    headers = {
        "user-agent": "MediaHubMX/2",
        "accept": "application/json",
        "content-type": "application/json; charset=utf-8",
        "content-length": "115",
        "accept-encoding": "gzip",
        "mediahubmx-signature": signature
    }
    data = {
        "language": "de",
        "region": "AT",
        "url": link,
        "clientVersion": "3.0.2"
    }
    try:
        resp = requests.post(f"https://{VAVOO_DOMAIN}/mediahubmx-resolve.json", json=data, headers=headers, timeout=10)
        resp.raise_for_status()
        result = resp.json()
        
        print(f"[DEBUG] Direct resolution response: {result}", file=sys.stderr)
        
        if isinstance(result, list) and result and result[0].get("url"):
            return result[0]["url"]
        elif isinstance(result, dict) and result.get("url"):
            return result["url"]
        else:
            print(f"[DEBUG] Unexpected response format in direct resolution: {result}", file=sys.stderr)
            return None
    except Exception as e:
        print(f"[DEBUG] Error in direct resolution: {e}", file=sys.stderr)
        return None

def build_vavoo_cache(channels):
    cache = {}
    for ch in channels:
        name = ch.get("name", "").strip()
        url = ch.get("url", "")
        if not name or not url:
            continue
        # Salva OGNI variante come chiave distinta, un solo link per chiave
        cache[name] = url
    return cache

def mostra_debug_cache():
    import json
    try:
        with open('vavoo_cache.json', encoding='utf-8') as f:
            cache = json.load(f)
        return json.dumps(cache, indent=2, ensure_ascii=False)
    except Exception as e:
        return f"Errore nella lettura della cache: {e}"

# Esegui con: python3 vavoo_resolver.py --build-cache
if "--build-cache" in sys.argv:
    channels = get_channels()
    cache = build_vavoo_cache(channels)
    with open("vavoo_cache.json", "w", encoding="utf-8") as f:
        json.dump({"links": cache}, f, ensure_ascii=False, indent=2)
    print("Cache Vavoo generata con successo!")
    # RIMOSSO: stampa debug dettagliata
    sys.exit(0)

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python3 vavoo_resolver.py <channel_name_or_vavoo_link> [--original-link] [--dump-channels]", file=sys.stderr)
        sys.exit(1)
    
    # Controllo se l'opzione per dump dei canali è presente
    if "--dump-channels" in sys.argv:
        channels = get_channels()
        # Aggiungi alias ai canali per un miglior matching
        for ch in channels:
            if "name" in ch:
                ch["aliases"] = [
                    ch["name"].replace(" HD", "").replace(" FHD", "").replace(" 4K", ""),  # Versione senza qualità
                    re.sub(r'\.[a-zA-Z]$', '', ch["name"]),  # Senza suffisso .a, .b, ecc
                ]
        print(json.dumps(channels))
        sys.exit(0)
        
    input_arg = sys.argv[1]
    return_original_link = "--original-link" in sys.argv
    
    # Controlla se l'input è un link Vavoo diretto
    if "vavoo.to" in input_arg and "/play/" in input_arg:
        print(f"[DEBUG] Direct Vavoo link detected: {input_arg}", file=sys.stderr)
        resolved = resolve_direct_link(input_arg)
        if resolved:
            print(resolved)  # Output per il caller
            sys.exit(0)
        else:
            print("[DEBUG] Failed to resolve direct link", file=sys.stderr)
            print("RESOLVE_FAIL", file=sys.stderr)
            sys.exit(4)
    
    # Altrimenti tratta come nome di canale
    wanted = normalize_vavoo_name(input_arg)
    print(f"[DEBUG] Looking for channel: {wanted}", file=sys.stderr)
    
    try:
        channels = get_channels()
        print(f"[DEBUG] Found {len(channels)} total channels", file=sys.stderr)
        
        found = None
        # Prima prova matching esatto
        for ch in channels:
            chname = normalize_vavoo_name(ch.get('name', ''))
            if chname == wanted:
                found = ch
                print(f"[DEBUG] Found exact match: {ch.get('name')}", file=sys.stderr)
                break
        
        # Se non trova matching esatto, prova matching parziale/fuzzy
        if not found:
            for ch in channels:
                original_name = ch.get('name', '').strip().upper()
                # Rimuovi suffissi comuni come .a, .b, .c, HD, etc.
                clean_name = re.sub(r'\s+\.[a-zA-Z]$', '', original_name)
                clean_name = re.sub(r'\s+(HD|FHD|4K)$', '', clean_name)
                
                # Controlla se il nome pulito contiene il nome cercato o viceversa
                if wanted in clean_name or clean_name in wanted:
                    found = ch
                    print(f"[DEBUG] Found partial match: {ch.get('name')} (cleaned: {clean_name})", file=sys.stderr)
                    break
        
        # Se ancora non trova, prova una ricerca ancora più flessibile
        if not found:
            for ch in channels:
                original_name = ch.get('name', '').strip().upper()
                # Rimuovi spazi e caratteri speciali per matching più flessibile
                name_simple = re.sub(r'[^A-Z0-9]', '', original_name)
                wanted_simple = re.sub(r'[^A-Z0-9]', '', wanted)
                
                if wanted_simple in name_simple or name_simple in wanted_simple:
                    found = ch
                    print(f"[DEBUG] Found flexible match: {ch.get('name')} (simplified: {name_simple})", file=sys.stderr)
                    break
        
        if not found:
            print(f"[DEBUG] Channel '{wanted}' not found in {len(channels)} channels", file=sys.stderr)
            # Debug: mostra alcuni nomi di canali per aiutare
            sample_names = [normalize_vavoo_name(ch.get('name', '')) for ch in channels[:10]]
            print(f"[DEBUG] Sample channel names: {sample_names}", file=sys.stderr)
            print("NOT_FOUND", file=sys.stderr)
            sys.exit(2)
            
        url = found.get('url')
        if not url:
            print("[DEBUG] No URL found for channel", file=sys.stderr)
            print("NO_URL", file=sys.stderr)
            sys.exit(3)
            
        print(f"[DEBUG] Found Vavoo URL: {url}", file=sys.stderr)
        
        # Se richiesto, restituisci solo il link originale Vavoo
        if return_original_link:
            print(url)  # Restituisce il link Vavoo originale non risolto
            sys.exit(0)
        
        # Altrimenti risolvi il link
        print(f"[DEBUG] Resolving URL: {url}", file=sys.stderr)
        resolved = resolve_vavoo_link(url)
        if resolved:
            print(resolved)  # Questo è l'output che viene letto
            sys.exit(0)
        else:
            print("[DEBUG] Failed to resolve URL", file=sys.stderr)
            print("RESOLVE_FAIL", file=sys.stderr)
            sys.exit(4)
            
    except Exception as e:
        print(f"[DEBUG] Exception: {str(e)}", file=sys.stderr)
        print("ERROR", file=sys.stderr)
        sys.exit(5) 
