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
- **Formati URL supportati:**
  - `/proxy/stream/` per file MP4 (film, serie, anime)
  - `/proxy/mpd/manifest.m3u8` per stream MPD (TV staticUrl/staticUrl2)
  - `/proxy/hls/manifest.m3u8` per stream HLS (TV staticUrlD, Vavoo)

### 📋 Configurazione Richiesta
- `MFP_URL`: URL del tuo proxy MFP (es. `https://username-mfp.hf.space`)
- `MFP_PSW`: Password del proxy MFP
- `TMDB_API_KEY`: Chiave API TMDB per metadati
- `BOTHLINK`: Mostra link diretti e proxy (true/false)
- `ANIMEUNITY_ENABLED`: Abilita AnimeUnity (true/false)
- `ANIMESATURN_ENABLED`: Abilita AnimeSaturn (true/false)

### 🔄 Logica BothLink
- **Se `BOTHLINK=true`**: Mostra sia link proxy che diretti
- **Se `BOTHLINK=false`**: Mostra solo link proxy (se configurato) o solo diretti (se proxy non configurato)

---

## ⚙️ Installazione

Puoi installare StreamViX solamente in locale, su un server casalingo o su una VPN non flaggata o con smartdns per verdere animeunity, 
per il resto, animesaturn e vixsrc va bene anche Huggingface, ma hanno iniziato a bannare StreamViX, quindi a tuo rischio e pericolo.
per Le installazioni locali serve sempre un dominio https per installare l'addon.

---

### 🚀 Metodo 1: Hugging Face (Consigliato per Tutti) MA A RISCHIO BAN! ACCOUNT E SPAZIO

Questo metodo ti permette di avere la tua istanza personale dell'addon online, gratuitamente e con la massima semplicità.

#### Prerequisiti

* **Account Hugging Face:** Crea un account [qui](https://huggingface.co/join).
* **Chiave API di TMDB:** Ottienine una gratuitamente registrandoti su [The Movie Database (TMDB)](https://www.themoviedb.org/documentation/api).
* **URL MediaflowProxy (MFP):** Devi avere un'istanza di MediaflowProxy (o `unhide`) già deployata su Hugging Face. Assicurati che sia una versione aggiornata (post 10 Aprile).

#### Procedura di Installazione

1.  **Crea un Nuovo Space 🆕**
    * Vai su [Hugging Face](https://huggingface.co/) e accedi.
    * Clicca sul tuo profilo e poi su `New Space`.
    * **Space name:** Scegli un nome (es. `StreamViX-tuo-username`).
    * **Select the Space SDK:** Scegli `Docker`.
    * **Visibilità:** Assicurati che sia `Public`.
    * Clicca su `Create Space`.

2.  **Aggiungi i Secrets 🔐** (Opzionale se inseriti durate l'installazione)
    * Nel tuo nuovo Space, vai sulla scheda `Settings`.
    * Nella sezione `Variables and secrets`, clicca su `New secret`.
    * Aggiungi i seguenti tre secrets, uno alla volta, facendo attenzione a scrivere correttamente i nomi:
        * `Name: TMDB_API_KEY` -> `Value: la_tua_chiave_api_di_tmdb`
        * `Name: MFP_URL` -> `Value: l_url_della_tua_istanza_mfp` (es. `https://username-mfp.hf.space`, **senza la `/` finale**)
        * `Name: MFP_PSW` -> `Value: la_password_che_hai_impostato_per_mfp`
        * `Name: MPD` -> `Value: "false"` (true o false - mostra o nascondi i link MPD)
        * `Name: ANIMEUNITY_ENABLED` -> `Value: "true"` (abilita AnimeUnity)
        * `Name: ANIMESATURN_ENABLED` -> `Value: "true"` (abilita AnimeSaturn)    

3.  **Configura il Dockerfile 📝**
    * Torna alla scheda `Files` del tuo Space.
    * Clicca su `Add file` e seleziona `Create a new file`.
    * Chiamalo `Dockerfile` (senza estensioni, con la "D" maiuscola).
    * Fai un fork del repo e sostituisci il link di github nel docker file con il tuo fork, oppure Incolla all'interno il contenuto del [Dockerfile](https://github.com/qwertyuiop8899/StreamViX/blob/main/Dockerfile) che trovi nel repository ufficiale di StreamViX.
    * Clicca su `Commit new file to main`.

4.  **Build e Deploy 🚀**
    * Hugging Face avvierà automaticamente la build del tuo addon. Puoi monitorare il processo nella scheda `Logs`.
    * Una volta che vedi lo stato "Running", il tuo addon è pronto!

5.  **Installa in Stremio 🎬**
    * Nella pagina principale del tuo Space, vedrai un pulsante per installare l'addon (solitamente "Install"). Cliccaci sopra per installarlo automaticamente.


---

### 🐳 Docker Compose (Avanzato / Self-Hosting)

Ideale se hai un server o una VPS e vuoi gestire l'addon tramite Docker.

#### Crea il file `docker-compose.yml`

Salva il seguente contenuto in un file chiamato `docker-compose.yml`, oppure aggiungi questo compose al tuo file esistente:

```yaml
services:
  streamvix:
    build: https://github.com/qwertyuiop8899/StreamViX_MFP.git#main
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

Crea il file `.env`: Crea un file chiamato `.env` nella root del progetto (nella stessa directory dove si trova `package.json`) e inserisci le variabili necessarie, come nell'esempio per Docker Compose:


    TMDB_API_KEY=la_tua_chiave_api_di_tmdb
    MFP_URL=https://username-mfp.hf.space
    MFP_PSW=la_tua_password_mfp
    PORT=7860
    BOTHLINK=true
    ANIMEUNITY_ENABLED=true
    ANIMESATURN_ENABLED=true

4.  **Compila il progetto:**
    ```
    pnpm run build
    ```
5.  **Avvia l'addon:**
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


