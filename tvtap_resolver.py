#!/usr/bin/env python
# -*- coding: utf-8 -*- 
"""
TVTap Resolver per StreamViX MFP
Basato sul codice originale funzionante
"""

import requests
import json
import sys
import argparse
from base64 import b64decode, b64encode
from binascii import a2b_hex
import re

def logga(messaggio):
    """Funzione di logging per debug"""
    print(f"[DEBUG] {messaggio}", file=sys.stderr)

def payload():
    """Genera payload per le richieste TVTap - esatto come nel codice originale"""
    try:
        from Crypto.Cipher import PKCS1_v1_5 as Cipher_PKCS1_v1_5
        from Crypto.PublicKey import RSA
        
        _pubkey = RSA.importKey(
            a2b_hex(
                "30819f300d06092a864886f70d010101050003818d003081890281"
                "8100bfa5514aa0550688ffde568fd95ac9130fcdd8825bdecc46f1"
                "8f6c6b440c3685cc52ca03111509e262dba482d80e977a938493ae"
                "aa716818efe41b84e71a0d84cc64ad902e46dbea2ec61071958826"
                "4093e20afc589685c08f2d2ae70310b92c04f9b4c27d79c8b5dbb9"
                "bd8f2003ab6a251d25f40df08b1c1588a4380a1ce8030203010001"
            )
        )
        _msg = a2b_hex(
            "7b224d4435223a22695757786f45684237686167747948392b58563052513d3d5c6e222c22534"
            "84131223a2242577761737941713841327678435c2f5450594a74434a4a544a66593d5c6e227d"
        )
        cipher = Cipher_PKCS1_v1_5.new(_pubkey)
        ret64 = b64encode(cipher.encrypt(_msg))
        return ret64
    except ImportError:
        logga("pycryptodome not available, script cannot work without it")
        # Invece di un payload di fallback, solleva un'eccezione
        raise ImportError("pycryptodome is required but not installed. Install with: pip install pycryptodome")

def get_tvtap_channels():
    """Ottiene la lista dei canali italiani da TVTap usando il metodo originale"""
    # Controlla se pycryptodome è disponibile prima di procedere
    try:
        from Crypto.Cipher import PKCS1_v1_5 as Cipher_PKCS1_v1_5
        from Crypto.PublicKey import RSA
    except ImportError:
        logga("FATAL: pycryptodome not available. Install with: pip install pycryptodome")
        print("ERROR: pycryptodome required", file=sys.stderr)
        return []
    
    user_agent = 'USER-AGENT-tvtap-APP-V2'
    
    headers = {
        'User-Agent': user_agent,
        'app-token': '37a6259cc0c1dae299a7866489dff0bd',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Host': 'taptube.net',
    }
    
    try:
        payload_data = payload()
        r = requests.post('https://rocktalk.net/tv/index.php?case=get_all_channels', 
                         headers=headers, 
                         data={"payload": payload_data, "username": "603803577"}, 
                         timeout=15)
        
        logga(f'Response status: {r.status_code}')
        
        if r.status_code != 200:
            logga(f'HTTP error: {r.status_code}')
            return get_static_italian_channels()
            
        response_json = r.json()
        logga(f'Got response with keys: {list(response_json.keys()) if isinstance(response_json, dict) else "not a dict"}')
        
        # Controlla se c'è un errore nella risposta
        if isinstance(response_json, dict) and "msg" in response_json:
            msg = response_json["msg"]
            if isinstance(msg, str) and ("error" in msg.lower() or "occured" in msg.lower()):
                logga(f'API returned error: {msg}')
                return get_static_italian_channels()
        
        # Filtra solo i canali italiani dalla risposta
        italian_channels = []
        
        if isinstance(response_json, dict) and "msg" in response_json:
            msg = response_json["msg"]
            if isinstance(msg, dict) and "channels" in msg:
                channels = msg["channels"]
                logga(f'Found {len(channels)} total channels')
                
                for channel in channels:
                    if isinstance(channel, dict) and channel.get("country") == "IT":
                        italian_channels.append({
                            "id": channel.get("pk_id"),
                            "name": channel.get("channel_name"),
                            "country": channel.get("country"),
                            "thumbnail": channel.get("img")
                        })
                
                logga(f'Found {len(italian_channels)} Italian channels from API')
                return italian_channels if italian_channels else get_static_italian_channels()
            else:
                logga(f'Unexpected msg structure: {type(msg)}, falling back to static list')
                return get_static_italian_channels()
        else:
            logga(f'Unexpected response structure: {type(response_json)}, falling back to static list')
            return get_static_italian_channels()
        
    except ImportError as ie:
        logga(f'Import error: {ie}')
        print("ERROR: Missing required library", file=sys.stderr)
        return []
    except Exception as e:
        logga(f'Error getting channels from API: {e}, falling back to static list')
        return get_static_italian_channels()

def get_tvtap_stream(channel_id):
    """Ottiene lo stream di un canale specifico usando il metodo originale"""
    logga(f'Stream request for channel {channel_id}')
    
    # Controlla se pycryptodome è disponibile per la decrittazione
    try:
        from Crypto.Cipher import PKCS1_v1_5 as Cipher_PKCS1_v1_5
        from Crypto.PublicKey import RSA
    except ImportError:
        logga("FATAL: pycryptodome not available. Install with: pip install pycryptodome")
        return None
    
    try:
        payload_data = payload()
        r = requests.post('https://rocktalk.net/tv/index.php?case=get_channel_link_with_token_latest', 
            headers={"app-token": "37a6259cc0c1dae299a7866489dff0bd"},
            data={"payload": payload_data, "channel_id": channel_id, "username": "603803577"},
            timeout=15)

        logga(f'Stream request for channel {channel_id}: {r.status_code}')
        
        if r.status_code != 200:
            logga(f'HTTP error: {r.status_code}')
            return None
            
        response_json = r.json()
        logga(f'Response keys: {list(response_json.keys()) if isinstance(response_json, dict) else "not a dict"}')
        
        if "msg" not in response_json:
            logga('No msg in response')
            return None
            
        msgRes = response_json["msg"]
        logga(f'Message response type: {type(msgRes)}, content: {str(msgRes)[:50]}...')
        
        if isinstance(msgRes, str):
            if "error" in msgRes.lower() or "occured" in msgRes.lower():
                logga(f'API returned error: {msgRes}')
                return None
            else:
                logga(f'Got string response: {msgRes}')
                return None
        
        if not isinstance(msgRes, dict) or "channel" not in msgRes:
            logga('No channel in response')
            return None
            
        # Prova a decrittare usando pyDes (come nel codice originale)
        try:
            from pyDes import des, PAD_PKCS5
            
            key = b"98221122"
            jch = msgRes["channel"][0]
            
            for stream in jch.keys():
                if "stream" in stream or "chrome_cast" in stream:
                    d = des(key)
                    link = d.decrypt(b64decode(jch[stream]), padmode=PAD_PKCS5)
            
                    if link:
                        link = link.decode("utf-8")
                        if not link == "dummytext" and link:
                            logga(f'Found stream link for channel {channel_id}')
                            return link
            
        except ImportError:
            logga("pyDes not available, cannot decrypt TVTap streams")
            return None
        except Exception as e:
            logga(f'Decryption error: {e}')
            return None
            
    except ImportError as ie:
        logga(f'Import error: {ie}')
        return None
    except Exception as e:
        logga(f'Error getting stream: {e}')
        return None
    
    logga('Failed to get stream for TVTap ID')
    return None

def normalize_channel_name(name):
    """Normalizza il nome del canale per matching flessibile"""
    if not name:
        return ""
    
    # Converte in maiuscolo e rimuove spazi extra
    name = name.strip().upper()
    
    # Rimuove suffissi comuni
    name = re.sub(r'\s+(HD|FHD|4K|\.A|\.B|\.C)$', '', name)
    
    # Rimuove caratteri speciali per matching più flessibile
    name = re.sub(r'[^\w\s]', '', name)
    
    return name

def get_static_italian_channels():
    """Restituisce una lista statica dei canali italiani TVTap"""
    return [
        {"id": "813", "name": "Baby TV", "country": "IT"},
        {"id": "812", "name": "Boomerang", "country": "IT"},
        {"id": "438", "name": "Canale 5", "country": "IT"},
        {"id": "439", "name": "Cartoon Network", "country": "IT"},
        {"id": "810", "name": "Classica", "country": "IT"},
        {"id": "700", "name": "Discovery", "country": "IT"},
        {"id": "731", "name": "Discovery Real Time", "country": "IT"},
        {"id": "737", "name": "Discovery Science", "country": "IT"},
        {"id": "713", "name": "Discovery Travel & Living", "country": "IT"},
        {"id": "830", "name": "Dazn 1", "country": "IT"},
        {"id": "819", "name": "Dazn 10", "country": "IT"},
        {"id": "820", "name": "Dazn 11", "country": "IT"},
        {"id": "768", "name": "Dazn 2", "country": "IT"},
        {"id": "769", "name": "Dazn 3", "country": "IT"},
        {"id": "770", "name": "Dazn 4", "country": "IT"},
        {"id": "771", "name": "Dazn 5", "country": "IT"},
        {"id": "815", "name": "Dazn 6", "country": "IT"},
        {"id": "816", "name": "Dazn 7", "country": "IT"},
        {"id": "817", "name": "Dazn 8", "country": "IT"},
        {"id": "818", "name": "Dazn 9", "country": "IT"},
        {"id": "811", "name": "Dea Kids", "country": "IT"},
        {"id": "711", "name": "Euro Sport", "country": "IT"},
        {"id": "712", "name": "Euro Sport 2", "country": "IT"},
        {"id": "442", "name": "History", "country": "IT"},
        {"id": "739", "name": "Inter Tv", "country": "IT"},
        {"id": "443", "name": "Italia 1", "country": "IT"},
        {"id": "466", "name": "La 7", "country": "IT"},
        {"id": "794", "name": "Lazio Style", "country": "IT"},
        {"id": "718", "name": "Mediaset 2", "country": "IT"},
        {"id": "749", "name": "Mediaset Extra", "country": "IT"},
        {"id": "797", "name": "MediaSet Focus", "country": "IT"},
        {"id": "729", "name": "Milan tv", "country": "IT"},
        {"id": "801", "name": "Nove", "country": "IT"},
        {"id": "791", "name": "Nicklodean", "country": "IT"},
        {"id": "426", "name": "Rai 1", "country": "IT"},
        {"id": "427", "name": "Rai 2", "country": "IT"},
        {"id": "428", "name": "Rai 3", "country": "IT"},
        {"id": "429", "name": "Rai 4", "country": "IT"},
        {"id": "430", "name": "Rai 5", "country": "IT"},
        {"id": "800", "name": "Rai Movie", "country": "IT"},
        {"id": "698", "name": "Rai news 24", "country": "IT"},
        {"id": "784", "name": "Rai Premium", "country": "IT"},
        {"id": "465", "name": "Rete 4", "country": "IT"},
        {"id": "792", "name": "TG Com 24", "country": "IT"},
        {"id": "809", "name": "TV 2000", "country": "IT"},
        {"id": "798", "name": "TV8", "country": "IT"},
        {"id": "776", "name": "Comedy Central", "country": "IT"},
        {"id": "710", "name": "Sky Atlantic", "country": "IT"},
        {"id": "582", "name": "Sky Calcio 1", "country": "IT"},
        {"id": "583", "name": "Sky Calcio 2", "country": "IT"},
        {"id": "706", "name": "Sky Calcio 3", "country": "IT"},
        {"id": "707", "name": "Sky Calcio 4", "country": "IT"},
        {"id": "708", "name": "Sky Calcio 5", "country": "IT"},
        {"id": "709", "name": "Sky Calcio 6", "country": "IT"},
        {"id": "876", "name": "Sky Calcio 7", "country": "IT"},
        {"id": "877", "name": "Sky Calcio 8", "country": "IT"},
        {"id": "878", "name": "Sky Calcio 9", "country": "IT"},
        {"id": "590", "name": "Sky Cinema Action", "country": "IT"},
        {"id": "589", "name": "Sky Cinema Collection", "country": "IT"},
        {"id": "586", "name": "Sky Cinema Comedy", "country": "IT"},
        {"id": "587", "name": "Sky Cinema Due", "country": "IT"},
        {"id": "588", "name": "Sky Cinema Family", "country": "IT"},
        {"id": "591", "name": "Sky Cinema Romance", "country": "IT"},
        {"id": "584", "name": "Sky Cinema UNO", "country": "IT"},
        {"id": "629", "name": "Sky Sport 24", "country": "IT"},
        {"id": "579", "name": "Sky Sport Arena", "country": "IT"},
        {"id": "705", "name": "Sky Sport Calcio", "country": "IT"},
        {"id": "581", "name": "Sky Sport F1", "country": "IT"},
        {"id": "580", "name": "Sky Sport Football", "country": "IT"},
        {"id": "668", "name": "Sky Sport Motogp", "country": "IT"},
        {"id": "704", "name": "Sky Sport NBA", "country": "IT"},
        {"id": "578", "name": "Sky Sport Uno", "country": "IT"},
        {"id": "592", "name": "Sky TG24", "country": "IT"},
        {"id": "593", "name": "Sky Uno", "country": "IT"}
    ]

def find_channel_by_name(channel_name, channels):
    """Trova un canale per nome con matching flessibile"""
    if not channel_name or not channels:
        return None
    
    normalized_search = normalize_channel_name(channel_name)
    logga(f'Looking for normalized name: {normalized_search}')
    
    # Matching esatto
    for channel in channels:
        normalized_channel = normalize_channel_name(channel.get("name", ""))
        if normalized_channel == normalized_search:
            logga(f'Exact match found: {channel.get("name")}')
            return channel
    
    # Matching parziale - cerca se il nome cercato è contenuto nel nome del canale
    for channel in channels:
        normalized_channel = normalize_channel_name(channel.get("name", ""))
        if normalized_search in normalized_channel or normalized_channel in normalized_search:
            logga(f'Partial match found: {channel.get("name")}')
            return channel
    
    # Matching ancora più flessibile - rimuove spazi e caratteri speciali
    search_simple = re.sub(r'[^A-Z0-9]', '', normalized_search)
    for channel in channels:
        channel_simple = re.sub(r'[^A-Z0-9]', '', normalize_channel_name(channel.get("name", "")))
        if search_simple in channel_simple or channel_simple in search_simple:
            logga(f'Flexible match found: {channel.get("name")}')
            return channel
    
    logga(f'No match found for: {channel_name}')
    return None

def build_tvtap_cache(channels):
    """Costruisce una cache dei canali TVTap"""
    cache = {}
    for ch in channels:
        name = ch.get("name", "").strip()
        channel_id = ch.get("id", "")
        if name and channel_id:
            cache[name] = channel_id
    return cache

if "--build-cache" in sys.argv:
    """Costruisce la cache dei canali TVTap"""
    channels = get_tvtap_channels()
    cache = build_tvtap_cache(channels)
    with open("tvtap_cache.json", "w", encoding="utf-8") as f:
        json.dump({"channels": cache}, f, ensure_ascii=False, indent=2)
    print("Cache TVTap generata con successo!")
    sys.exit(0)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 tvtap_resolver.py <channel_name> [--original-link] [--dump-channels] [--find-channel <name>]", file=sys.stderr)
        sys.exit(1)
    
    # Controllo se l'opzione per dump dei canali è presente
    if "--dump-channels" in sys.argv:
        channels = get_tvtap_channels()
        print(json.dumps(channels, ensure_ascii=False, indent=2))
        sys.exit(0)
    
    # Controllo se l'opzione per risolvere stream tramite ID è presente
    if "--resolve-stream" in sys.argv:
        resolve_idx = sys.argv.index("--resolve-stream")
        if resolve_idx + 1 >= len(sys.argv):
            print("Error: --resolve-stream requires a channel ID", file=sys.stderr)
            sys.exit(1)
        
        channel_id = sys.argv[resolve_idx + 1]
        logga(f"Resolving stream for channel ID: {channel_id}")
        
        try:
            stream_url = get_tvtap_stream(channel_id)
            if stream_url:
                print(stream_url)
                sys.exit(0)
            else:
                logga("Failed to get stream URL")
                print("STREAM_FAIL", file=sys.stderr)
                sys.exit(5)
        except Exception as e:
            logga(f"Exception: {str(e)}")
            print("ERROR", file=sys.stderr)
            sys.exit(6)
    
    # Controllo se l'opzione per trovare un canale specifico è presente
    if "--find-channel" in sys.argv:
        find_idx = sys.argv.index("--find-channel")
        if find_idx + 1 >= len(sys.argv):
            print("Error: --find-channel requires a channel name", file=sys.stderr)
            sys.exit(1)
        
        search_name = sys.argv[find_idx + 1]
        channels = get_tvtap_channels()
        found_channel = find_channel_by_name(search_name, channels)
        
        if found_channel:
            print(json.dumps(found_channel, ensure_ascii=False, indent=2))
            sys.exit(0)
        else:
            logga(f"Channel '{search_name}' not found in {len(channels)} channels")
            # Debug: mostra alcuni nomi di canali per aiutare
            sample_names = [ch.get("name", "") for ch in channels[:10]]
            logga(f"Sample channel names: {sample_names}")
            print("NOT_FOUND", file=sys.stderr)
            sys.exit(3)
    
    channel_name = sys.argv[1]
    return_original_link = "--original-link" in sys.argv
    
    # Controlla se l'input è un ID TVTap diretto (formato: tvtap_id:123)
    if channel_name.startswith("tvtap_id:"):
        tvtap_id = channel_name.split(":", 1)[1]
        logga(f"Direct TVTap ID detected: {tvtap_id}")
        
        # Ottieni direttamente il link stream
        stream_url = get_tvtap_stream(tvtap_id)
        if stream_url:
            print(stream_url)
            sys.exit(0)
        else:
            logga("Failed to get stream for TVTap ID")
            print("STREAM_FAIL", file=sys.stderr)
            sys.exit(5)
    
    try:
        # Ottieni tutti i canali
        channels = get_tvtap_channels()
        if not channels:
            logga("No channels retrieved")
            print("NO_CHANNELS", file=sys.stderr)
            sys.exit(2)
        
        # Trova il canale
        found_channel = find_channel_by_name(channel_name, channels)
        if not found_channel:
            logga(f"Channel '{channel_name}' not found in {len(channels)} channels")
            # Debug: mostra alcuni nomi di canali per aiutare
            sample_names = [ch.get("name", "") for ch in channels[:10]]
            logga(f"Sample channel names: {sample_names}")
            print("NOT_FOUND", file=sys.stderr)
            sys.exit(3)
        
        channel_id = found_channel.get("id")
        if not channel_id:
            logga("No ID found for channel")
            print("NO_ID", file=sys.stderr)
            sys.exit(4)
        
        logga(f"Found channel: {found_channel.get('name')} (ID: {channel_id})")
        
        # Se richiesto, restituisci solo l'ID del canale (equivalente al link originale Vavoo)
        if return_original_link:
            print(f"tvtap://{channel_id}")
            sys.exit(0)
        
        # Altrimenti ottieni il link stream
        stream_url = get_tvtap_stream(channel_id)
        if stream_url:
            print(stream_url)
            sys.exit(0)
        else:
            logga("Failed to get stream URL")
            print("STREAM_FAIL", file=sys.stderr)
            sys.exit(5)
            
    except Exception as e:
        logga(f"Exception: {str(e)}")
        print("ERROR", file=sys.stderr)
        sys.exit(6)
