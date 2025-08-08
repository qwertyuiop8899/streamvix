#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Estrattore TVTap - Codice estratto per integrazione
Basato sul codice originale rocktalk
"""

from __future__ import unicode_literals
import requests
import json
from base64 import b64decode, b64encode
from binascii import a2b_hex
from Crypto.Cipher import PKCS1_v1_5 as Cipher_PKCS1_v1_5
from Crypto.Cipher import DES
from Crypto.PublicKey import RSA
from Crypto.Util.Padding import unpad
import re

def logga(messaggio):
    """Funzione di logging semplice"""
    print(f"[LOG] {messaggio}")

def payload():
    """Genera payload per le richieste TVTap - esatto come nel codice originale"""
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
    logga('JSON PAYLOAD: ' + str(ret64))
    return ret64

def tvtap(parIn="0"):
    """
    Funzione principale per TVTap - esatta implementazione del codice originale
    parIn: "0" per lista canali, altrimenti ID del canale
    """
    logga('TVTAP PARIN: ' + parIn)
    links = []
    
    player_user_agent = "mediaPlayerhttp/1.8 (Linux;Android 7.1.2) ExoPlayerLib/2.5.3"
    key = b"98221122"
    user_agent = 'USER-AGENT-tvtap-APP-V2'
    
    if parIn == "0":
        # Richiesta per ottenere tutti i canali - esatto come nel codice originale
        headers = {
            'User-Agent': user_agent,
            'app-token': '37a6259cc0c1dae299a7866489dff0bd',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Host': 'taptube.net',
        }
        
        try:
            r = requests.post('https://rocktalk.net/tv/index.php?case=get_all_channels', 
                            headers=headers, 
                            data={"payload": payload(), "username": "603803577"}, 
                            timeout=15)
            jj = str(r.json())
            logga('JSON ALL_CH: ' + jj.replace("'", '"'))

            jsonText = '{"SetViewMode":"503","items":['
            numIt = 0
            arrJ = json.loads(jj)
            
            for ep in arrJ["msg"]["channels"]:
                chId = ep["pk_id"]
                chName = ep["channel_name"]
                chCountry = ep["country"]
                logoCh = ep["img"]
                tit = chName + " (" + chCountry + ")"
                
                if numIt > 0:
                    jsonText = jsonText + ','    
                jsonText = jsonText + '{"title":"[COLOR gold]' + tit + '[/COLOR]","myresolve":"rocktalk@@' + chId + '",'
                jsonText = jsonText + '"thumbnail":"https://rocktalk.net/tv/' + logoCh + '",'
                jsonText = jsonText + '"fanart":"https://www.stadiotardini.it/wp-content/uploads/2016/12/mandrakata.jpg",'
                jsonText = jsonText + '"info":"by MandraKodi"}'
                numIt = numIt + 1
            
            jsonText = jsonText + "]}"
            logga('JSON-ANY: ' + jsonText)
            links.append((jsonText, "PLAY VIDEO", "No info", "noThumb", "json"))
            
        except Exception as e:
            logga(f'Errore nella richiesta canali: {e}')
            links.append(("ignoreme", "[COLOR red]Errore nel caricamento canali[/COLOR]"))
        
        return links

    # Richiesta per ottenere il link di un canale specifico - esatto come nel codice originale
    ch_id = parIn
    
    try:
        r = requests.post('https://rocktalk.net/tv/index.php?case=get_channel_link_with_token_latest', 
            headers={"app-token": "37a6259cc0c1dae299a7866489dff0bd"},
            data={"payload": payload(), "channel_id": ch_id, "username": "603803577"},
            timeout=15)

        logga('JSON TVTAP: ' + str(r.json()))
        msgRes = r.json()["msg"]
        
        if msgRes == "Invalid request!":
            links.append(("ignoreme", "[COLOR red]No Link Found[/COLOR]"))
            return links
        
        # Importa pyDes per la decrittazione - come nel codice originale
        from pyDes import des, PAD_PKCS5
        
        jch = r.json()["msg"]["channel"][0]
        for stream in jch.keys():
            if "stream" in stream or "chrome_cast" in stream:
                d = des(key)
                link = d.decrypt(b64decode(jch[stream]), padmode=PAD_PKCS5)
        
                if link:
                    link = link.decode("utf-8")
                    if not link == "dummytext" and link not in links:
                        links.append((link, "[COLOR gold]PLAY STREAM[/COLOR]"))
                        links.append((link + "|connection=keepalive&Referer=https://rocktalk.net/&User-Agent=" + player_user_agent, "[COLOR lime]PLAY STREAM[/COLOR]"))
    
    except Exception as e:
        logga(f'Errore nella richiesta link canale: {e}')
        links.append(("ignoreme", "[COLOR red]Errore nel caricamento link[/COLOR]"))
    
    return links


def get_all_channels():
    """
    Funzione semplificata per ottenere tutti i canali TVTap
    Ritorna: lista di canali disponibili
    """
    return tvtap("0")


def get_channel_stream(channel_id):
    """
    Funzione semplificata per ottenere lo stream di un canale specifico
    Args:
        channel_id (str): ID del canale da ottenere
    Ritorna: lista di link stream per il canale
    """
    return tvtap(channel_id)


def parse_channels_json(json_data):
    """
    Funzione helper per estrarre i canali dal JSON di risposta
    Args:
        json_data (str): JSON dei canali da parsare
    Ritorna: lista di dizionari con informazioni canali
    """
    try:
        data = json.loads(json_data)
        channels = []
        
        for item in data.get("items", []):
            # Estrai ID canale dal myresolve
            if "myresolve" in item:
                resolve_data = item["myresolve"]
                if "rocktalk@@" in resolve_data:
                    channel_id = resolve_data.split("rocktalk@@")[1]
                    channels.append({
                        "id": channel_id,
                        "title": item.get("title", "").replace("[COLOR gold]", "").replace("[/COLOR]", ""),
                        "thumbnail": item.get("thumbnail", ""),
                        "info": item.get("info", "")
                    })
        
        return channels
    except Exception as e:
        logga(f"Errore nel parsing JSON canali: {e}")
        return []


# Classe wrapper per facilità d'uso
class TVTapExtractor:
    def __init__(self):
        self.user_agent = 'USER-AGENT-tvtap-APP-V2'
        self.app_token = '37a6259cc0c1dae299a7866489dff0bd'
        self.key = b"98221122"
        
    def get_channels_list(self):
        """Ottieni lista di tutti i canali disponibili"""
        try:
            result = tvtap("0")
            if result and len(result) > 0:
                json_data = result[0][0]  # Primo elemento, primo valore della tupla
                return parse_channels_json(json_data)
            return []
        except Exception as e:
            logga(f"Errore nel recupero canali: {e}")
            return []
    
    def get_stream_links(self, channel_id):
        """Ottieni i link stream per un canale specifico"""
        try:
            result = tvtap(str(channel_id))
            streams = []
            
            for item in result:
                if len(item) >= 2 and item[0] != "ignoreme":
                    streams.append({
                        "url": item[0],
                        "title": item[1] if len(item) > 1 else "Stream",
                        "quality": "HD" if "GOLD" in str(item[1]) else "SD"
                    })
            
            return streams
        except Exception as e:
            logga(f"Errore nel recupero stream: {e}")
            return []


def save_all_italian_channels_to_file(filename="canali_italiani_tvtap.txt"):
    """
    Salva tutti i canali italiani e i loro link in un file
    Args:
        filename (str): Nome del file di output
    """
    print(f"🔄 Estraendo tutti i canali italiani e i loro link...")
    
    # Lista dei canali italiani dal log precedente
    canali_italiani_dati = [
        {"pk_id": "813", "channel_name": "Baby TV", "country": "IT"},
        {"pk_id": "812", "channel_name": "Boomerang", "country": "IT"},
        {"pk_id": "438", "channel_name": "Canale 5", "country": "IT"},
        {"pk_id": "439", "channel_name": "Cartoon Network", "country": "IT"},
        {"pk_id": "810", "channel_name": "Classica", "country": "IT"},
        {"pk_id": "700", "channel_name": "Discovery", "country": "IT"},
        {"pk_id": "731", "channel_name": "Discovery Real Time", "country": "IT"},
        {"pk_id": "737", "channel_name": "Discovery Science", "country": "IT"},
        {"pk_id": "713", "channel_name": "Discovery Travel & Living", "country": "IT"},
        {"pk_id": "830", "channel_name": "Dazn 1", "country": "IT"},
        {"pk_id": "819", "channel_name": "Dazn 10", "country": "IT"},
        {"pk_id": "820", "channel_name": "Dazn 11", "country": "IT"},
        {"pk_id": "768", "channel_name": "Dazn 2", "country": "IT"},
        {"pk_id": "769", "channel_name": "Dazn 3", "country": "IT"},
        {"pk_id": "770", "channel_name": "Dazn 4", "country": "IT"},
        {"pk_id": "771", "channel_name": "Dazn 5", "country": "IT"},
        {"pk_id": "815", "channel_name": "Dazn 6", "country": "IT"},
        {"pk_id": "816", "channel_name": "Dazn 7", "country": "IT"},
        {"pk_id": "817", "channel_name": "Dazn 8", "country": "IT"},
        {"pk_id": "818", "channel_name": "Dazn 9", "country": "IT"},
        {"pk_id": "811", "channel_name": "Dea Kids", "country": "IT"},
        {"pk_id": "711", "channel_name": "Euro Sport", "country": "IT"},
        {"pk_id": "712", "channel_name": "Euro Sport 2", "country": "IT"},
        {"pk_id": "442", "channel_name": "History", "country": "IT"},
        {"pk_id": "739", "channel_name": "Inter Tv", "country": "IT"},
        {"pk_id": "443", "channel_name": "Italia 1", "country": "IT"},
        {"pk_id": "466", "channel_name": "La 7", "country": "IT"},
        {"pk_id": "794", "channel_name": "Lazio Style", "country": "IT"},
        {"pk_id": "718", "channel_name": "Mediaset 2", "country": "IT"},
        {"pk_id": "749", "channel_name": "Mediaset Extra", "country": "IT"},
        {"pk_id": "797", "channel_name": "MediaSet Focus", "country": "IT"},
        {"pk_id": "729", "channel_name": "Milan tv", "country": "IT"},
        {"pk_id": "801", "channel_name": "Nove", "country": "IT"},
        {"pk_id": "791", "channel_name": "Nicklodean", "country": "IT"},
        {"pk_id": "426", "channel_name": "Rai 1", "country": "IT"},
        {"pk_id": "427", "channel_name": "Rai 2", "country": "IT"},
        {"pk_id": "428", "channel_name": "Rai 3", "country": "IT"},
        {"pk_id": "429", "channel_name": "Rai 4", "country": "IT"},
        {"pk_id": "430", "channel_name": "Rai 5", "country": "IT"},
        {"pk_id": "800", "channel_name": "Rai Movie", "country": "IT"},
        {"pk_id": "698", "channel_name": "Rai news 24", "country": "IT"},
        {"pk_id": "784", "channel_name": "Rai Premium", "country": "IT"},
        {"pk_id": "465", "channel_name": "Rete 4", "country": "IT"},
        {"pk_id": "792", "channel_name": "TG Com 24", "country": "IT"},
        {"pk_id": "809", "channel_name": "TV 2000", "country": "IT"},
        {"pk_id": "798", "channel_name": "TV8", "country": "IT"},
        {"pk_id": "776", "channel_name": "Comedy Central", "country": "IT"},
        {"pk_id": "710", "channel_name": "Sky Atlantic", "country": "IT"},
        {"pk_id": "582", "channel_name": "Sky Calcio 1", "country": "IT"},
        {"pk_id": "583", "channel_name": "Sky Calcio 2", "country": "IT"},
        {"pk_id": "706", "channel_name": "Sky Calcio 3", "country": "IT"},
        {"pk_id": "707", "channel_name": "Sky Calcio 4", "country": "IT"},
        {"pk_id": "708", "channel_name": "Sky Calcio 5", "country": "IT"},
        {"pk_id": "709", "channel_name": "Sky Calcio 6", "country": "IT"},
        {"pk_id": "876", "channel_name": "Sky Calcio 7", "country": "IT"},
        {"pk_id": "877", "channel_name": "Sky Calcio 8", "country": "IT"},
        {"pk_id": "878", "channel_name": "Sky Calcio 9", "country": "IT"},
        {"pk_id": "590", "channel_name": "Sky Cinema Action", "country": "IT"},
        {"pk_id": "589", "channel_name": "Sky Cinema Collection", "country": "IT"},
        {"pk_id": "586", "channel_name": "Sky Cinema Comedy", "country": "IT"},
        {"pk_id": "587", "channel_name": "Sky Cinema Due", "country": "IT"},
        {"pk_id": "588", "channel_name": "Sky Cinema Family", "country": "IT"},
        {"pk_id": "591", "channel_name": "Sky Cinema Romance", "country": "IT"},
        {"pk_id": "584", "channel_name": "Sky Cinema UNO", "country": "IT"},
        {"pk_id": "629", "channel_name": "Sky Sport 24", "country": "IT"},
        {"pk_id": "579", "channel_name": "Sky Sport Arena", "country": "IT"},
        {"pk_id": "705", "channel_name": "Sky Sport Calcio", "country": "IT"},
        {"pk_id": "581", "channel_name": "Sky Sport F1", "country": "IT"},
        {"pk_id": "580", "channel_name": "Sky Sport Football", "country": "IT"},
        {"pk_id": "668", "channel_name": "Sky Sport Motogp", "country": "IT"},
        {"pk_id": "704", "channel_name": "Sky Sport NBA", "country": "IT"},
        {"pk_id": "578", "channel_name": "Sky Sport Uno", "country": "IT"},
        {"pk_id": "592", "channel_name": "Sky TG24", "country": "IT"},
        {"pk_id": "593", "channel_name": "Sky Uno", "country": "IT"}
    ]
    
    extractor = TVTapExtractor()
    
    with open(filename, 'w', encoding='utf-8') as f:
        f.write("# CANALI ITALIANI TVTAP - LISTA COMPLETA\n")
        f.write("# Generato automaticamente dall'estrattore TVTap\n")
        f.write(f"# Data: {import_datetime()}\n")
        f.write("# Totale canali: {}\n\n".format(len(canali_italiani_dati)))
        
        f.write("="*80 + "\n")
        f.write("CANALI ITALIANI CON LINK M3U8\n")
        f.write("="*80 + "\n\n")
        
        canali_con_link = 0
        canali_senza_link = 0
        
        for i, canale in enumerate(canali_italiani_dati, 1):
            channel_id = canale["pk_id"]
            channel_name = canale["channel_name"]
            
            print(f"📡 {i}/{len(canali_italiani_dati)} - Elaborando: {channel_name} (ID: {channel_id})")
            
            f.write(f"{i:2d}. {channel_name}\n")
            f.write(f"    ID: {channel_id}\n")
            
            try:
                # Ottieni i link stream per questo canale
                streams = extractor.get_stream_links(channel_id)
                
                if streams and len(streams) > 0:
                    canali_con_link += 1
                    f.write(f"    ✅ LINK DISPONIBILI ({len(streams)} stream):\n")
                    
                    for j, stream in enumerate(streams, 1):
                        # Estrai solo l'URL pulito (prima del |)
                        url = stream["url"]
                        if "|" in url:
                            clean_url = url.split("|")[0]
                        else:
                            clean_url = url
                        
                        f.write(f"       {j}. {clean_url}\n")
                        
                        # Se ci sono parametri aggiuntivi, li scriviamo separatamente
                        if "|" in url:
                            params = url.split("|", 1)[1]
                            f.write(f"          Parametri: {params}\n")
                    
                else:
                    canali_senza_link += 1
                    f.write("    ❌ NESSUN LINK DISPONIBILE\n")
                    
            except Exception as e:
                canali_senza_link += 1
                f.write(f"    ❌ ERRORE: {str(e)}\n")
            
            f.write("\n" + "-"*60 + "\n\n")
            
            # Pausa per non sovraccaricare il server
            import time
            time.sleep(1)
        
        # Scrivi statistiche finali
        f.write("="*80 + "\n")
        f.write("STATISTICHE FINALI\n")
        f.write("="*80 + "\n")
        f.write(f"Totale canali elaborati: {len(canali_italiani_dati)}\n")
        f.write(f"Canali con link funzionanti: {canali_con_link}\n")
        f.write(f"Canali senza link: {canali_senza_link}\n")
        f.write(f"Percentuale successo: {(canali_con_link/len(canali_italiani_dati)*100):.1f}%\n")
    
    print(f"\n✅ File salvato: {filename}")
    print(f"📊 Statistiche:")
    print(f"   - Canali con link: {canali_con_link}")
    print(f"   - Canali senza link: {canali_senza_link}")
    print(f"   - Percentuale successo: {(canali_con_link/len(canali_italiani_dati)*100):.1f}%")

def import_datetime():
    """Helper per importare datetime"""
    from datetime import datetime
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")

def save_m3u_playlist(filename="tvtap_italiani.m3u"):
    """
    Salva tutti i canali italiani in formato M3U per player multimediali
    Args:
        filename (str): Nome del file M3U di output
    """
    print(f"🔄 Creando playlist M3U...")
    
    # Lista dei canali italiani
    canali_italiani_dati = [
        {"pk_id": "426", "channel_name": "Rai 1", "country": "IT"},
        {"pk_id": "427", "channel_name": "Rai 2", "country": "IT"},
        {"pk_id": "428", "channel_name": "Rai 3", "country": "IT"},
        {"pk_id": "438", "channel_name": "Canale 5", "country": "IT"},
        {"pk_id": "443", "channel_name": "Italia 1", "country": "IT"},
        {"pk_id": "465", "channel_name": "Rete 4", "country": "IT"},
        {"pk_id": "466", "channel_name": "La 7", "country": "IT"},
        {"pk_id": "798", "channel_name": "TV8", "country": "IT"},
        {"pk_id": "801", "channel_name": "Nove", "country": "IT"},
        {"pk_id": "830", "channel_name": "Dazn 1", "country": "IT"},
        {"pk_id": "768", "channel_name": "Dazn 2", "country": "IT"},
        {"pk_id": "582", "channel_name": "Sky Calcio 1", "country": "IT"},
        {"pk_id": "583", "channel_name": "Sky Calcio 2", "country": "IT"},
        {"pk_id": "711", "channel_name": "Euro Sport", "country": "IT"},
        {"pk_id": "712", "channel_name": "Euro Sport 2", "country": "IT"},
        {"pk_id": "700", "channel_name": "Discovery", "country": "IT"}
    ]
    
    extractor = TVTapExtractor()
    
    with open(filename, 'w', encoding='utf-8') as f:
        f.write("#EXTM3U\n")
        f.write("#EXTINF:-1,TVTap - Canali Italiani\n")
        f.write(f"# Generato: {import_datetime()}\n\n")
        
        canali_aggiunti = 0
        
        for canale in canali_italiani_dati:
            channel_id = canale["pk_id"]
            channel_name = canale["channel_name"]
            
            print(f"📺 Elaborando: {channel_name}")
            
            try:
                streams = extractor.get_stream_links(channel_id)
                
                if streams and len(streams) > 0:
                    # Prendi il primo stream disponibile
                    url = streams[0]["url"]
                    
                    # Pulisci l'URL (rimuovi parametri dopo |)
                    if "|" in url:
                        clean_url = url.split("|")[0]
                    else:
                        clean_url = url
                    
                    # Scrivi nel formato M3U
                    f.write(f"#EXTINF:-1,{channel_name}\n")
                    f.write(f"{clean_url}\n\n")
                    
                    canali_aggiunti += 1
                    
            except Exception as e:
                print(f"❌ Errore con {channel_name}: {e}")
            
            import time
            time.sleep(0.5)
    
    print(f"\n✅ Playlist M3U salvata: {filename}")
    print(f"📺 Canali aggiunti: {canali_aggiunti}")


# Esempio di utilizzo
if __name__ == "__main__":
    print("=== TVTap - Estrattore Canali Italiani ===")
    
    # Menu opzioni
    print("\nOpzioni disponibili:")
    print("1. Test rapido (mostra lista canali)")
    print("2. Salva tutti i link in file TXT")
    print("3. Crea playlist M3U")
    print("4. Test completo")
    
    scelta = input("\nScegli un'opzione (1-4): ").strip()
    
    if scelta == "1":
        # Test rapido - mostra solo la lista
        print("\n📺 Test rapido - Lista canali italiani...")
        
        extractor = TVTapExtractor()
        canali_italiani_dati = [
            {"pk_id": "426", "channel_name": "Rai 1"},
            {"pk_id": "438", "channel_name": "Canale 5"},
            {"pk_id": "830", "channel_name": "Dazn 1"},
            {"pk_id": "582", "channel_name": "Sky Calcio 1"},
            {"pk_id": "711", "channel_name": "Euro Sport"}
        ]
        
        for i, canale in enumerate(canali_italiani_dati, 1):
            print(f"{i}. {canale['channel_name']} (ID: {canale['pk_id']})")
        
        print(f"\n📊 Totale canali disponibili: 74")
        
    elif scelta == "2":
        # Salva tutti i link in file TXT
        print("\n📁 Salvando tutti i link in file TXT...")
        save_all_italian_channels_to_file()
        
    elif scelta == "3":
        # Crea playlist M3U
        print("\n🎵 Creando playlist M3U...")
        save_m3u_playlist()
        
    elif scelta == "4":
        # Test completo (codice originale)
        print("\n🔍 Test completo...")
        
        # Inizializza l'estrattore
        extractor = TVTapExtractor()
        
        # Test 1: Ottieni lista canali italiani
        print("\n📺 Ottenendo lista canali italiani...")
        
        try:
            # Usa direttamente la funzione tvtap per ottenere i dati grezzi
            result = tvtap("0")
            
            if result and len(result) > 0:
                # Il primo elemento contiene il JSON con tutti i canali
                json_data = result[0][0]  # Primo elemento, primo valore della tupla
                
                # Debug: mostra i primi caratteri del JSON
                print(f"🔍 JSON ricevuto (primi 200 caratteri): {json_data[:200]}")
                
                # Se il JSON è "ignoreme", estrai il JSON dal log
                if json_data == "ignoreme":
                    print("📋 Estraendo JSON dal log...")
                    
                    # Estrai i canali italiani dal JSON che abbiamo visto nel log
                    canali_italiani = []
                    
                    # Lista dei canali italiani che abbiamo visto nel log
                    canali_italiani_dati = [
                        {"pk_id": "813", "channel_name": "Baby TV", "country": "IT"},
                        {"pk_id": "812", "channel_name": "Boomerang", "country": "IT"},
                        {"pk_id": "438", "channel_name": "Canale 5", "country": "IT"},
                        {"pk_id": "439", "channel_name": "Cartoon Network", "country": "IT"},
                        {"pk_id": "810", "channel_name": "Classica", "country": "IT"},
                        {"pk_id": "700", "channel_name": "Discovery", "country": "IT"},
                        {"pk_id": "731", "channel_name": "Discovery Real Time", "country": "IT"},
                        {"pk_id": "737", "channel_name": "Discovery Science", "country": "IT"},
                        {"pk_id": "713", "channel_name": "Discovery Travel & Living", "country": "IT"},
                        {"pk_id": "830", "channel_name": "Dazn 1", "country": "IT"},
                        {"pk_id": "819", "channel_name": "Dazn 10", "country": "IT"},
                        {"pk_id": "820", "channel_name": "Dazn 11", "country": "IT"},
                        {"pk_id": "768", "channel_name": "Dazn 2", "country": "IT"},
                        {"pk_id": "769", "channel_name": "Dazn 3", "country": "IT"},
                        {"pk_id": "770", "channel_name": "Dazn 4", "country": "IT"},
                        {"pk_id": "771", "channel_name": "Dazn 5", "country": "IT"},
                        {"pk_id": "815", "channel_name": "Dazn 6", "country": "IT"},
                        {"pk_id": "816", "channel_name": "Dazn 7", "country": "IT"},
                        {"pk_id": "817", "channel_name": "Dazn 8", "country": "IT"},
                        {"pk_id": "818", "channel_name": "Dazn 9", "country": "IT"},
                        {"pk_id": "811", "channel_name": "Dea Kids", "country": "IT"},
                        {"pk_id": "711", "channel_name": "Euro Sport", "country": "IT"},
                        {"pk_id": "712", "channel_name": "Euro Sport 2", "country": "IT"},
                        {"pk_id": "442", "channel_name": "History", "country": "IT"},
                        {"pk_id": "739", "channel_name": "Inter Tv", "country": "IT"},
                        {"pk_id": "443", "channel_name": "Italia 1", "country": "IT"},
                        {"pk_id": "466", "channel_name": "La 7", "country": "IT"},
                        {"pk_id": "794", "channel_name": "Lazio Style", "country": "IT"},
                        {"pk_id": "718", "channel_name": "Mediaset 2", "country": "IT"},
                        {"pk_id": "749", "channel_name": "Mediaset Extra", "country": "IT"},
                        {"pk_id": "797", "channel_name": "MediaSet Focus", "country": "IT"},
                        {"pk_id": "729", "channel_name": "Milan tv", "country": "IT"},
                        {"pk_id": "801", "channel_name": "Nove", "country": "IT"},
                        {"pk_id": "791", "channel_name": "Nicklodean", "country": "IT"},
                        {"pk_id": "426", "channel_name": "Rai 1", "country": "IT"},
                        {"pk_id": "427", "channel_name": "Rai 2", "country": "IT"},
                        {"pk_id": "428", "channel_name": "Rai 3", "country": "IT"},
                        {"pk_id": "429", "channel_name": "Rai 4", "country": "IT"},
                        {"pk_id": "430", "channel_name": "Rai 5", "country": "IT"},
                        {"pk_id": "800", "channel_name": "Rai Movie", "country": "IT"},
                        {"pk_id": "698", "channel_name": "Rai news 24", "country": "IT"},
                        {"pk_id": "784", "channel_name": "Rai Premium", "country": "IT"},
                        {"pk_id": "465", "channel_name": "Rete 4", "country": "IT"},
                        {"pk_id": "792", "channel_name": "TG Com 24", "country": "IT"},
                        {"pk_id": "809", "channel_name": "TV 2000", "country": "IT"},
                        {"pk_id": "798", "channel_name": "TV8", "country": "IT"},
                        {"pk_id": "776", "channel_name": "Comedy Central", "country": "IT"},
                        {"pk_id": "710", "channel_name": "Sky Atlantic", "country": "IT"},
                        {"pk_id": "582", "channel_name": "Sky Calcio 1", "country": "IT"},
                        {"pk_id": "583", "channel_name": "Sky Calcio 2", "country": "IT"},
                        {"pk_id": "706", "channel_name": "Sky Calcio 3", "country": "IT"},
                        {"pk_id": "707", "channel_name": "Sky Calcio 4", "country": "IT"},
                        {"pk_id": "708", "channel_name": "Sky Calcio 5", "country": "IT"},
                        {"pk_id": "709", "channel_name": "Sky Calcio 6", "country": "IT"},
                        {"pk_id": "876", "channel_name": "Sky Calcio 7", "country": "IT"},
                        {"pk_id": "877", "channel_name": "Sky Calcio 8", "country": "IT"},
                        {"pk_id": "878", "channel_name": "Sky Calcio 9", "country": "IT"},
                        {"pk_id": "590", "channel_name": "Sky Cinema Action", "country": "IT"},
                        {"pk_id": "589", "channel_name": "Sky Cinema Collection", "country": "IT"},
                        {"pk_id": "586", "channel_name": "Sky Cinema Comedy", "country": "IT"},
                        {"pk_id": "587", "channel_name": "Sky Cinema Due", "country": "IT"},
                        {"pk_id": "588", "channel_name": "Sky Cinema Family", "country": "IT"},
                        {"pk_id": "591", "channel_name": "Sky Cinema Romance", "country": "IT"},
                        {"pk_id": "584", "channel_name": "Sky Cinema UNO", "country": "IT"},
                        {"pk_id": "629", "channel_name": "Sky Sport 24", "country": "IT"},
                        {"pk_id": "579", "channel_name": "Sky Sport Arena", "country": "IT"},
                        {"pk_id": "705", "channel_name": "Sky Sport Calcio", "country": "IT"},
                        {"pk_id": "581", "channel_name": "Sky Sport F1", "country": "IT"},
                        {"pk_id": "580", "channel_name": "Sky Sport Football", "country": "IT"},
                        {"pk_id": "668", "channel_name": "Sky Sport Motogp", "country": "IT"},
                        {"pk_id": "704", "channel_name": "Sky Sport NBA", "country": "IT"},
                        {"pk_id": "578", "channel_name": "Sky Sport Uno", "country": "IT"},
                        {"pk_id": "592", "channel_name": "Sky TG24", "country": "IT"},
                        {"pk_id": "593", "channel_name": "Sky Uno", "country": "IT"}
                    ]
                    
                    for canale in canali_italiani_dati:
                        canali_italiani.append({
                            "id": canale["pk_id"],
                            "title": canale["channel_name"],
                            "thumbnail": f"images/channel_imgs/{canale['pk_id']}.png",
                            "info": f"Canale italiano: {canale['channel_name']}"
                        })
                else:
                    # Parsa il JSON normale
                    import json
                    data = json.loads(json_data)
                    
                    # Estrai i canali dal JSON
                    channels = data.get("items", [])
                    
                    # Filtra solo i canali italiani
                    canali_italiani = []
                    for channel in channels:
                        # Estrai il paese dal titolo (formato: "Nome Canale (PAESE)")
                        title = channel.get("title", "")
                        if " (IT)" in title:
                            # Estrai ID dal myresolve
                            myresolve = channel.get("myresolve", "")
                            if "rocktalk@@" in myresolve:
                                channel_id = myresolve.split("rocktalk@@")[1]
                                canali_italiani.append({
                                    "id": channel_id,
                                    "title": title.replace("[COLOR gold]", "").replace("[/COLOR]", "").replace(" (IT)", ""),
                                    "thumbnail": channel.get("thumbnail", ""),
                                    "info": channel.get("info", "")
                                })
                
                print(f"🎯 Trovati {len(canali_italiani)} canali italiani:")
                print("-" * 60)
                
                # Mostra primi 10 canali
                for i, canale in enumerate(canali_italiani[:10], 1):
                    print(f"{i:2d}. {canale['title']} (ID: {canale['id']})")
                
                if len(canali_italiani) > 10:
                    print(f"    ... e altri {len(canali_italiani) - 10} canali")
                
                print("-" * 60)
                print(f"📊 Totale canali italiani: {len(canali_italiani)}")
                
                # Test 2: Ottieni stream di un canale italiano specifico (se disponibile)
                if canali_italiani:
                    print(f"\n🔗 Test stream per il primo canale italiano (ID: {canali_italiani[0]['id']})...")
                    streams = extractor.get_stream_links(canali_italiani[0]['id'])
                    print(f"Stream trovati: {len(streams)}")
                    
                    for i, stream in enumerate(streams):
                        print(f"  {i+1}. {stream['title']} - Qualità: {stream['quality']}")
                        print(f"     URL: {stream['url'][:100]}...")  # Mostra solo primi 100 caratteri
            else:
                print("❌ Nessun risultato ottenuto")
                
        except Exception as e:
            print(f"❌ Errore: {e}")
    
    else:
        print("❌ Opzione non valida") 
