
<img width="230" height="293" alt="icon" src="https://github.com/user-attachments/assets/11ef8b0e-6d55-44a4-9ccc-ae7031e99f34" />

# 🎬 StreamViX | ElfHosted 

Un addon per Stremio che estrae sorgenti streaming dai siti vixsrc e animeunity animesaturn daddy e vavoo per permetterti di guardare film, serie TV, anime e tv con la massima semplicità.

[Link di Installazione](https://streamvix.hayd.uk/)

Oppure, ottieni un'[istanza StreamViX gestita via ElfHosted](https://store.elfhosted.com/product/streamvix/?utm_source=github&utm_medium=readme&utm_campaign=streamvix-readme), con MediaFlow Proxy incluso (per eventi sportivi).


---

## ✨ Funzionalità Principali 

* **✅ Supporto Film:** Trova flussi streaming per i film utilizzando il loro ID TMDB. 
* **📺 Supporto Serie TV:** Trova flussi per ogni episodio di una serie TV, basandosi su ID TMDB in formato stagione/episodio.
* **⛩️ Supporto Anime:** Trova flussi per ogni episodio di una determinato Anime, ora supporta ricerca sia da cinemeta, sia da tmdb che da kitsu.
* **📡 Supporto Eventi Sportivi:** Eventi sportivi aggiornati ogni giorno.
* **🎯 Ottimizzazione Automatica:** MFP wrap diretto per massima velocità, estrattori TypeScript come fallback sicuro
* **📡 Supporto Live TV:** Canali TV italiani e Eventi Sportivi visibili senza Mediaflow Proxy, scegliere i canali [Vavoo] o con 🏠.


---
Comandi per Live TV da browser

http://urladdon/live/update   aggiorna lista live events (include processing SPON)

http://urladdon/live/purge    cancella vecchi eventi

http://urladdon/live/reload   aggiorna il catalogo stremio

http://urladdon/static/reload ricarica canali TV statici

Endpoint aggiuntivi per arricchimento

http://urladdon/static/fupdate       avvia arricchimento mpd FORCED, senza check su esistenza

http://urladdon/tv/update       avvia arricchimento ALL

## 🔧 Configurazione Semplificata

StreamViX utilizza un **sistema di proxy unificato** che semplifica la configurazione:

### 🌐 Proxy MFP Unificato
- **Un solo URL e password** per tutti i contenuti (film, serie, anime, TV)

### 🔄 Proxy Anime (Opzionale, per VPS / Datacenter IP)

Se Streamvix gira su una VPS / server cloud il cui IP viene bloccato da Cloudflare (errore 403 su AnimeUnity, AnimeSaturn o AnimeWorld), puoi instradare il traffico verso quei siti attraverso un proxy SOCKS5 o HTTPS.

| Variabile | Provider | Descrizione |
|-----------|----------|-------------|
| `PROXY` | Tutti | Proxy generale (usato anche da CB01/GuardoSerie come fallback) |
| `AU_PROXY` | AnimeUnity | Proxy specifico (priorità su `PROXY`) |
| `AS_PROXY` | AnimeSaturn | Proxy specifico (priorità su `PROXY`) |
| `AW_PROXY` | AnimeWorld | Proxy specifico (priorità su `PROXY`) |

Formati accettati: `socks5h://host:port` · `socks5://host:port` · `http://host:port` · `https://host:port`

Esempio con container **Cloudflare WARP** già presente nel tuo `docker-compose.yml`:
```env
PROXY=socks5h://warp:1080
```
Se vuoi specificare il proxy solo per il provider che dà problemi:
```env
AU_PROXY=socks5h://warp:1080
```

Esempio blocco environment in `docker-compose.yml`:
```yaml
environment:
    - MFP_URL=https://mfp.miodominio.xyz
    - MFP_PSW=supersecret
    - TMDB_API_KEY=xxxxx
```

### ⚽ Architettura Eventi Sportivi (SPON + Integrazioni)

Gli eventi sportivi utilizzano un sistema multi-layer con wrap MFP diretto e fallback intelligenti:

### ⏱️ Scheduler Live.py

`Live.py` viene eseguito automaticamente OGNI 2 ORE a partire dalle **08:10 Europe/Rome** nelle seguenti fasce: 08:10, 10:10, 12:10, 14:10, 16:10, 18:10, 20:10, 22:10, 00:10, 02:10, 04:10, 06:10.

Ad ogni esecuzione:
* Scarica / rigenera `dynamic_channels.json`.
* La cache dinamica in memoria viene invalidata e ricaricata.

### 📄 Comportamento "JSON as-is" (senza filtri)

- L'addon legge sempre `config/dynamic_channels.json` così com'è ad ogni richiesta.
- Nessun filtro runtime per data è applicato di default.
- Questo garantisce che ciò che vedi nel catalogo corrisponde sempre al contenuto del file JSON aggiornato dallo scheduler/`/live/update`.

Se in futuro vuoi riattivare la logica di filtro per data:

- `DYNAMIC_DISABLE_RUNTIME_FILTER=0` abilita il filtro runtime.
- `DYNAMIC_PURGE_HOUR` (default `8`): ora (Europe/Rome) dopo cui gli eventi del giorno precedente NON vengono più mostrati a catalogo.
- `DYNAMIC_KEEP_YESTERDAY` (default `0`): se `1`, mantiene visibili anche gli eventi di ieri fino al purge fisico.
- `DYNAMIC_EVENT_MAX_AGE_HOURS` (default `0` disabilitato): se > 0, rimuove (runtime filter + purge fisico) qualsiasi evento il cui `eventStart` è più vecchio di N ore rispetto all'orario corrente (Europe/Rome). Esempio: impostando `DYNAMIC_EVENT_MAX_AGE_HOURS=8` un evento iniziato alle 10:00 sparirà dopo le 18:00 anche se è ancora “oggi”.

Aspettative quando riattivi il filtro:

- Prima di `DYNAMIC_PURGE_HOUR`: vedrai eventi di oggi e, se presenti, ancora quelli di ieri (se `DYNAMIC_KEEP_YESTERDAY=1`).
- Dopo `DYNAMIC_PURGE_HOUR`: vedrai solo gli eventi con `eventStart` di oggi (quelli di ieri spariscono dal catalogo).
- Purge fisico alle 02:05 riscrive il file rimuovendo definitivamente gli eventi di ieri a prescindere dal filtro runtime.

### 🧹 Pulizia Eventi & Finestra di Grazia

La rimozione degli eventi del giorno precedente avviene in due modi:

1. Filtro runtime: se `process.env.DYNAMIC_PURGE_HOUR` (default **08**) è passato, gli eventi con `eventStart` del giorno precedente non vengono più mostrati a catalogo.
2. Purge fisico programmato: alle **02:05** viene eseguito un purge che riscrive il file eliminando gli eventi obsoleti (endpoint manuale: `/live/purge`). Reload di sicurezza alle **02:30**.

Nota: con il comportamento "JSON as-is" attivo (default), la visibilità degli eventi dipende solo dal contenuto del JSON e dal purge fisico; il filtro runtime è disabilitato.

Se vuoi modificare solo la finestra di visibilità estesa fino a una certa ora, imposta `DYNAMIC_PURGE_HOUR` (es. `DYNAMIC_PURGE_HOUR=9`).

### 🔁 Endpoints Utili Riepilogo

| Endpoint | Descrizione |
|----------|-------------|
| `/live/update` | Esegue subito `Live.py` e ricarica dinamici (include SPON) |
| `/live/reload` | Invalida cache e ricarica senza rieseguire script |
| `/live/purge` | Purge fisico file eventi vecchi |
| `/static/reload` | Ricarica canali TV statici |


### 🌍 Variabili Ambiente Eventi Sportivi (Principali)

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `MFP_URL` | - | **OBBLIGATORIO** - URL MediaFlow Proxy per wrap SPON |
| `MFP_PASSWORD` / `MFP_PSW` | - | **OBBLIGATORIO** - Password MediaFlow Proxy |
| `DYNAMIC_PURGE_HOUR` | 8 | Ora (Rome) dopo cui gli eventi del giorno precedente spariscono dal catalogo |
| `DYNAMIC_DISABLE_RUNTIME_FILTER` | 1 | 1 = non filtrare per data (usa JSON as-is); 0 = abilita filtro giorno |
| `SPSO_PLAYLIST_URL` | auto | URL playlist SPSO custom |
| `STATIC_DADDY_LAZY` | 1 | **Estrazione DaddyHD canali statici**: 1 (default) = lazy/veloce (link diretto, non estratto, estrazione al play), 0 = eager/lento (estrazione preventiva prima di mostrare lista) |

---

### Flusso di Esecuzione
`Live.py` genera `dynamic_channels.json` → viene eseguito `pig_channels.py` → aggiorna `tv_channels.json` (pdUrlF) + inietta `[P🐽D]` negli eventi → l'addon carica/merge e serve.

---

  
---

## ⚙️ Installazione

Puoi installare StreamViX solamente in locale, su un server casalingo o su una VPN non flaggata o con smartdns per verdere animeunity, 
per il resto, animesaturn e vixsrc va bene anche Huggingface, ma hanno iniziato a bannare StreamViX, quindi a tuo rischio e pericolo.
per Le installazioni locali serve sempre un dominio https per installare l'addon. Oppure utilizzare un fork di mediaflow proxy EXE su windows.
(funziona solo se il pc rimane acceso https://github.com/qwertyuiop8899/mediaflow-proxy_exe/ )

---

---

### 🐳 Docker Compose (Avanzato / Self-Hosting)

Ideale se hai un server o una VPS e vuoi gestire l'addon tramite Docker.

#### Crea il file `docker-compose.yml`

Salva il seguente contenuto in un file chiamato `docker-compose.yml`, oppure aggiungi questo compose al tuo file esistente:

```yaml
services:
  streamvix:
    image: qwertyuiop8899/streamvix:latest
    container_name: streamvix
    ports:
      - "7860:7860"
    environment:
      # Configurazione Base (OBBLIGATORIA)
      - BOTHLINK=true
      - MFP_URL=https://mfp.tuodominio.com  # MediaFlow Proxy URL
      - MFP_PASSWORD=tuapassword            # MediaFlow Proxy password
      - TMDB_API_KEY=tua_chiave_tmdb        # https://www.themoviedb.org/settings/api
      
      # Anime (opzionale)
      - ANIMEUNITY_ENABLED=true
      - ANIMESATURN_ENABLED=true
      
      # Live TV & Eventi Sportivi
      - Enable_Live_TV=true
      
      # Eventi Sportivi Avanzati (opzionale - configurazione automatica se omesso)
      # - SPON_PROG_URL=https://sportzonline.st/prog.txt
      # - RBTV_DISCOVERY_BEFORE_MIN=15
      # - STREAMED_ENABLE=1
      
      # Installazione Locale/VPS (opzionale - per FHD VixSrc synthetic)
      # - ADDON_BASE_URL=https://streamvix.tuodominio.com
    restart: always
    
  # Watchtower per aggiornamenti automatici immagine (opzionale)
  # watchtower:
  #   image: containrrr/watchtower
  #   container_name: watchtower
  #   volumes:
  #     - /var/run/docker.sock:/var/run/docker.sock
  #   restart: always
```

TMDB Api KEY, MFP link e MFP password e i due flag necessari verranno gestiti dalla pagina di installazione.

#### Esegui Docker Compose

Apri un terminale nella directory dove hai salvato il `docker-compose.yml` ed esegui il seguente comando per costruire l'immagine e avviare il container in background:

```bash
docker compose up -d
```
Con watchtower l'immagine sara' aggiornata automaticamente.

### 💻 Metodo 3: Installazione Locale (per Esperti NON TESTATO)

Usa questo metodo se vuoi modificare il codice sorgente, testare nuove funzionalità o contribuire allo sviluppo di StreamViX.

1.  **Clona il repository:**

    ```bash
    git clone https://github.com/qwertyuiop8899/StreamViX.git # Assicurati che sia il repository corretto di StreamViX
    cd StreamViX # Entra nella directory del progetto appena clonata
    ```

2.  **Installa le dipendenze:**
    ```bash
	pip install -r requirements.txt
    pnpm install
    ```
	
3.  **Compila il progetto:**
    ```
    pnpm run build
    ```
4.  **Avvia l'addon:**
    ```
    pnpm start
    ```
L'addon sarà disponibile localmente all'indirizzo `http://localhost:7860`.

---

## 🔍 Troubleshooting Rapido

| Problema | Possibili Cause | Soluzione |
|----------|-----------------|-----------|
| Nessun stream SPON negli eventi | MFP non configurato | Verifica `MFP_URL` e `MFP_PASSWORD` nelle env vars |
| Stream SPON non funzionano | MFP non raggiungibile o password errata | Testa MFP direttamente, controlla logs `[SPON][FALLBACK]` |
| Pochi canali SPON | File prog.txt vuoto o non scaricato | Controlla logs `[SPON][SCHEDULE]`, verifica `sportzonline.st` raggiungibile |
| Eventi spariscono troppo presto | `DYNAMIC_PURGE_HOUR` troppo basso | Aumenta a 8+ o imposta `DYNAMIC_DISABLE_RUNTIME_FILTER=1` |
| Download prog.txt fallisce | Dominio sportzonline.st temporaneamente down | Imposta `SPON_PROG_URL` custom o `SPON_PROG_FALLBACKS` |
| Estrattore TypeScript non viene chiamato | MFP wrap funziona sempre | Comportamento normale (fallback solo se wrap MFP fallisce) |

---


#### ⚠️ Disclaimer

Questo progetto è inteso esclusivamente a scopo educativo. L'utente è l'unico responsabile dell'utilizzo che ne fa. Assicurati di rispettare le leggi sul copyright e i termini di servizio delle fonti utilizzate.


---

## Credits

Original extraction logic written by https://github.com/mhdzumair for the extractor code https://github.com/mhdzumair/mediaflow-proxy 
Thanks to https://github.com/ThEditor https://github.com/ThEditor/stremsrc for the main code and stremio addon
Un ringraziamento speciale a @UrloMythus per gli extractor e per la logica kitsu

Funzionalità dinamiche FAST / CAP / purge implementate nel 2025.
































