
<img width="230" height="293" alt="icon" src="https://github.com/user-attachments/assets/11ef8b0e-6d55-44a4-9ccc-ae7031e99f34" />

# 🎬 StreamViX

Un addon per Stremio che estrae sorgenti streaming dai siti vixsrc e animeunity animesaturn daddy e vavoo per permetterti di guardare film, serie TV, anime e tv con la massima semplicità.

---

## ✨ Funzionalità Principali

* **✅ Supporto Film:** Trova flussi streaming per i film utilizzando il loro ID TMDB.
* **📺 Supporto Serie TV:** Trova flussi per ogni episodio di una serie TV, basandosi su ID TMDB in formato stagione/episodio.
* **⛩️ Supporto Anime:** Trova flussi per ogni episodio di una determinato Anime, ora supporta ricerca sia da cinemeta, sia da tmdb che da kitsu.
* **📡 Supporto Live TV:** Canali TV italiani con EPG integrato.
* **📡 Supporto Eventi Sportivi:** Eventi sportivi aggiornati ogni giorno.
* **🔗 Integrazione Perfetta:** Si integra meravigliosamente con l'interfaccia di Stremio per un'esperienza utente fluida.
* **🌐 Proxy Unificato:** Un solo proxy MFP per tutti i contenuti (film, serie, anime, TV).
* **⚡ Modalità FAST Dinamica:** Eventi Live con URL dirette senza passare dall'extractor (toggle runtime) tutte etichettate `[Player Esterno]`.
* **🎯 Limite & Priorità Estrazioni:** In modalità extractor applica CAP di concorrenza e priorità per sorgenti italiane.

---
Comandi per Live TV da browser

http://urladdon/live/update   aggiorna lista live events

http://urladdon/live/purge    cancella vecchi eventi

http://urladdon/live/reload   aggiorna il catalogo stremio 

Endpoint aggiuntivi amministrazione / diagnostica

http://urladdon/admin/mode?fast=1   abilita modalità FAST dinamica (usa URL dirette)
http://urladdon/admin/mode?fast=0   torna alla modalità extractor (risoluzione + CAP)

Note: il toggle non è persistente al riavvio (solo runtime).


## 🔧 Configurazione Semplificata

StreamViX utilizza un **sistema di proxy unificato** che semplifica la configurazione:

### 🌐 Proxy MFP Unificato
- **Un solo URL e password** per tutti i contenuti (film, serie, anime, TV)

### 📋 Configurazione Richiesta
- `MFP_URL`: URL del tuo proxy MFP
- `MFP_PSW`: Password del proxy MFP
- `TMDB_API_KEY`: Chiave API TMDB per metadati (OPZIONALE)
- `ANIMEUNITY_ENABLED`: Abilita AnimeUnity (true/false)
- `ANIMESATURN_ENABLED`: Abilita AnimeSaturn (true/false)
- `Enable MPD Streams`: (true/false) Non funzionanti lasciare false
- `Enable Live TV`: Abilita per vedere live tv (true/false)
  
### ⚡ Eventi Dinamici: FAST vs Extractor

Gli eventi sportivi dinamici vengono caricati dal file `config/dynamic_channels.json` generato periodicamente da `Live.py`.

Modalità disponibili:

1. FAST (diretta):
    - Attiva con variabile `FAST_DYNAMIC=1` oppure runtime `/admin/mode?fast=1`.
    - Salta completamente l'extractor e usa immediatamente le URL presenti nel JSON.
    - Nessun limite di concorrenza, tutte le sorgenti vengono esposte come stream diretti.
    - Ogni stream FAST è etichettato con prefisso `[Player Esterno]` (l'emoji 🇮🇹 resta se il titolo normalizzato lo richiede).
2. Extractor (predefinita se `FAST_DYNAMIC=0`):
    - Ogni URL dinamica passa per la risoluzione (se configurato proxy MFP) prima di essere mostrata.
    - Applica un CAP di concorrenza pari a `DYNAMIC_EXTRACTOR_CONC` (default 10) per limitare numero di richieste simultanee all'extractor.
    - Le sorgenti oltre il CAP vengono comunque esposte come leftover diretti con etichetta `[Player Esterno]` (non estratti) così da non perderle.
    - Priorità: prima i titoli che matchano `(it|ita|italy)`, poi `(italian|sky|tnt|amazon|dazn|eurosport|prime|bein|canal|sportitalia|now|rai)`, infine gli altri.

Suggerimento: imposta `DYNAMIC_EXTRACTOR_CONC=1` per test: vedrai esattamente 2 stream (1 estratto + 1 leftover `[Player Esterno]`).

### 🧪 Esempio rapido test locale (curl)

1. Avvia server con: `FAST_DYNAMIC=0 DYNAMIC_EXTRACTOR_CONC=1 pnpm start`
2. Richiedi stream evento: `curl http://127.0.0.1:7860/stream/tv/<id_evento>.json`
3. Abilita FAST: `curl http://127.0.0.1:7860/admin/mode?fast=1`
4. Ririchiedi stesso endpoint: noterai più stream (tutti diretti) e nessun leftover.

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

### 🏷️ Etichette Stream Dinamici

* `[Player Esterno]` =
    - In modalità FAST: prefisso sempre presente su tutti i flussi (tutti diretti).
    - In modalità extractor: prefisso solo sui leftover (flussi oltre il CAP non estratti). Il primo blocco di flussi (fino al CAP) non ha il prefisso a meno che non provenga già così dal sorgente.
* Emoji 🇮🇹 = titolo o sorgente italiana riconosciuta automaticamente.

### 🔁 Endpoints Utili Riepilogo

| Endpoint | Descrizione |
|----------|-------------|
| `/live/update` | Esegue subito `Live.py` e ricarica dinamici |
| `/live/reload` | Invalida cache e ricarica senza rieseguire script |
| `/live/purge` | Purge fisico file eventi vecchi |
| `/admin/mode?fast=1` | Abilita FAST dinamico |
| `/admin/mode?fast=0` | Torna extractor |

### 🌍 Variabili Ambiente Rilevanti (Estese)

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `FAST_DYNAMIC` | 0 | 1 = usa URL dirette dinamiche |
| `DYNAMIC_EXTRACTOR_CONC` | 10 | Limite richieste extractor (CAP). Con CAP=1 ottieni 1 estratto + 1 leftover |
| `DYNAMIC_PURGE_HOUR` | 8 | Ora (Rome) dopo cui gli eventi del giorno precedente spariscono dal catalogo |
| `DYNAMIC_DISABLE_RUNTIME_FILTER` | 1 | 1 = non filtrare per data (usa JSON as-is); 0 = abilita filtro giorno |
| `DYNAMIC_KEEP_YESTERDAY` | 0 | 1 = con filtro attivo, mantiene anche gli eventi di ieri |

---
  
---

## ⚙️ Installazione

Puoi installare StreamViX solamente in locale, su un server casalingo o su una VPN non flaggata o con smartdns per verdere animeunity, 
per il resto, animesaturn e vixsrc va bene anche Huggingface, ma hanno iniziato a bannare StreamViX, quindi a tuo rischio e pericolo.
per Le installazioni locali serve sempre un dominio https per installare l'addon. Oppure utilizzare un fork di mediaflow proxy EXE su windows.
(funziona solo se il pc rimane acceso https://github.com/qwertyuiop8899/mediaflow-proxy_exe/ )

---

### 🚀 Metodo 1: Render (Consigliato per Tutti)

Questo metodo ti permette di avere la tua istanza personale dell'addon online, gratuitamente e con la massima semplicità.

#### Prerequisiti

* **Account Render:** Crea un account [qui]([render.com](https://dashboard.render.com/register)).
* **(OPZIONALE) Chiave API di TMDB:** Ottienine una gratuitamente registrandoti su [The Movie Database (TMDB)](https://www.themoviedb.org/documentation/api).
* **URL MediaflowProxy (MFP):** Devi avere un'istanza di MediaflowProxy (https://github.com/nzo66/mediaflow-proxy) già deployata su Render/Locale/VPS. Assicurati che sia una versione aggiornata 

#### Procedura di Installazione

1.  **Crea un Nuovo Space 🆕**
    * Vai su [Render]((https://dashboard.render.com/)) e accedi.
    * Clicca sul + in alto a destra e poi su `Web Service`.
    * **Public Git Repository:** Incolla il repo `(https://github.com/qwertyuiop8899/StreamViX)`).
    * **Connect**
    * **Scegli il nome**
    * **Branch** `render`
    * **Instance Type** `Free`
    * **Deploy Web Service**

2.  **Build e Deploy 🚀**
    * Render avvierà automaticamente la build del tuo addon. Puoi monitorare il processo nella scheda `Logs`.
    * Una volta che vedi lo stato "Running", il tuo addon è pronto!

3.  **Installa in Stremio 🎬**
    * Nella pagina principale del tuo Space, in alto a sinistra vedrai un link viola, clicca e configura streamvix per poi installarlo su stremio con gli appositi pulsanti.


---

### 🐳 Docker Compose (Avanzato / Self-Hosting)

Ideale se hai un server o una VPS e vuoi gestire l'addon tramite Docker.

#### Crea il file `docker-compose.yml`

Salva il seguente contenuto in un file chiamato `docker-compose.yml`, oppure aggiungi questo compose al tuo file esistente:

```yaml
services:
  streamvix:
    build: https://github.com/qwertyuiop8899/StreamViX.git#main
    container_name: streamvix
    restart: unless-stopped
    ports:
      - '7860:7860'
```
Sostituisci il link con il tuo fork se preferisci https://github.com/qwertyuiop8899/StreamViX_MFP.git#main

TMDB Api KEY, MFP link e MFP password e i due flag necessari verranno gestiti dalla pagina di installazione.

#### Esegui Docker Compose

Apri un terminale nella directory dove hai salvato il `docker-compose.yml` ed esegui il seguente comando per costruire l'immagine e avviare il container in background:

```bash
docker compose up -d --build
```
Se ci saranno aggiornamenti, eseguire i seguenti comandi :

```bash
# Ferma tutto
sudo docker compose down streamvixau

# Rimuovi l'immagine specifica
sudo docker rmi streamvix

# Pulisci la build cache
sudo docker builder prune -f

# Ricostruisci completamente senza cache
sudo docker compose build --no-cache streamvix

# Avvia
sudo docker compose up -d streamvix
```


### 💻 Metodo 3: Installazione Locale (per Esperti NON TESTATO)

Usa questo metodo se vuoi modificare il codice sorgente, testare nuove funzionalità o contribuire allo sviluppo di StreamViX.

1.  **Clona il repository:**

    ```bash
    git clone https://github.com/qwertyuiop8899/StreamViX.git # Assicurati che sia il repository corretto di StreamViX
    cd StreamViX # Entra nella directory del progetto appena clonata
    ```

2.  **Installa le dipendenze:**
3.  
    ```bash
    pnpm install
    ```
4.  **Setup:**


5.  **Compila il progetto:**
    ```
    pnpm run build
    ```
6.  **Avvia l'addon:**
    ```
    pnpm start
    ```
L'addon sarà disponibile localmente all'indirizzo `http://localhost:7860`.

---

## 🔍 Troubleshooting Rapido

| Problema | Possibili Cause | Soluzione |
|----------|-----------------|-----------|
| Nessun evento dinamico dopo le 07:30 | `DYNAMIC_PURGE_HOUR` troppo basso | Aumenta a 8+ o rimuovi variabile |
| Vedi pochi stream dinamici | Modalità extractor con CAP basso | Aumenta `DYNAMIC_EXTRACTOR_CONC` o abilita FAST |
| URL non trasformate | Proxy MFP non configurato | Imposta `MFP_URL` e `MFP_PSW` oppure usa FAST |
| Toggle FAST non persiste al reboot | Funzionamento previsto | Esporta `FAST_DYNAMIC=1` nell'ambiente |

---


#### ⚠️ Disclaimer

Questo progetto è inteso esclusivamente a scopo educativo. L'utente è l'unico responsabile dell'utilizzo che ne fa. Assicurati di rispettare le leggi sul copyright e i termini di servizio delle fonti utilizzate.


## Credits

Original extraction logic written by https://github.com/mhdzumair for the extractor code https://github.com/mhdzumair/mediaflow-proxy 
Thanks to https://github.com/ThEditor https://github.com/ThEditor/stremsrc for the main code and stremio addon
Un ringraziamento speciale a @UrloMythus per gli extractor e per la logica kitsu

Funzionalità dinamiche FAST / CAP / purge implementate nel 2025.









