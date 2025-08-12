![image](https://github.com/user-attachments/assets/11956b44-f742-42cc-a9f0-40fbb1c9de61)
# 🎬 StreamViX

Un addon per Stremio che estrae sorgenti streaming dai siti vixsrc e animeunity animesaturn daddy e vavoo per permetterti di guardare film, serie TV, anime e tv con la massima semplicità.

---

## ✨ Funzionalità Principali

* **✅ Supporto Film:** Trova flussi streaming per i film utilizzando il loro ID TMDB.
* **📺 Supporto Serie TV:** Trova flussi per ogni episodio di una serie TV, basandosi su ID TMDB in formato stagione/episodio.
* **⛩️ Supporto Anime:** Trova flussi per ogni episodio di una determinato Anime, ora supporta ricerca sia da cinemeta, sia da tmdb che da kitsu.
* **📡 Supporto Live TV:** Canali TV italiani con EPG integrato.
* **🔗 Integrazione Perfetta:** Si integra meravigliosamente con l'interfaccia di Stremio per un'esperienza utente fluida.
* **🌐 Proxy Unificato:** Un solo proxy MFP per tutti i contenuti (film, serie, anime, TV).

---

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


#### ⚠️ Disclaimer

Questo progetto è inteso esclusivamente a scopo educativo. L'utente è l'unico responsabile dell'utilizzo che ne fa. Assicurati di rispettare le leggi sul copyright e i termini di servizio delle fonti utilizzate.


## Credits

Original extraction logic written by https://github.com/mhdzumair for the extractor code https://github.com/mhdzumair/mediaflow-proxy 
Thanks to https://github.com/ThEditor https://github.com/ThEditor/stremsrc for the main code and stremio addon
Un ringraziamento speciale a @UrloMythus per gli extractor e per la logica kitsu



