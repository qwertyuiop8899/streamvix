![image](https://github.com/user-attachments/assets/11956b44-f742-42cc-a9f0-40fbb1c9de61)
# 🎬 StreamViX

Un addon per Stremio che estrae sorgenti streaming dai siti vixsrc e animeunity per permetterti di guardare film, serie TV e anime con la massima semplicità.

---

## ✨ Funzionalità Principali

* **✅ Supporto Film:** Trova flussi streaming per i film utilizzando il loro ID TMDB.
* **📺 Supporto Serie TV:** Trova flussi per ogni episodio di una serie TV, basandosi su ID TMDB in formato stagione/episodio.
* **⛩️ Supporto Anime:** Trova flussi per ogni episodio di una determinato Anime, basandosi su ID KITSU in formato stagione/episodio.
* **🔗 Integrazione Perfetta:** Si integra meravigliosamente con l'interfaccia di Stremio per un'esperienza utente fluida.

---

## ⚙️ Installazione

Puoi installare StreamViX-AU solamente in locale, su un server casalingo o su una VPN non flaggata o con smartdns.

### 🔍 Per animeunity bisogna cercare solamente tramite il catalogo Kitsu https://anime-kitsu.strem.fun/manifest.json

Oppure usare questa versione senza Anime, serve solo aggiungere la TMDB api key e MFP url e psw
https://streamvix-streamvix.hf.space
---

### 🚀 Metodo 1: Hugging Face (Consigliato per Tutti)

Questo metodo ti permette di avere la tua istanza personale dell'addon online, gratuitamente e con la massima semplicità.

#### Prerequisiti

* **Account Hugging Face:** Crea un account [qui](https://huggingface.co/join).
* **Chiave API di TMDB:** Ottienine una gratuitamente registrandoti su [The Movie Database (TMDB)](https://www.themoviedb.org/documentation/api).
* **URL MediaflowProxy (MFP):** Devi avere un'istanza di MediaflowProxy (o `unhide`) già deployata su Hugging Face. Assicurati che sia una versione aggiornata (post 10 Aprile).

#### Procedura di Installazione

---

### 🐳 Docker Compose (Avanzato / Self-Hosting)

Ideale se hai un server o una VPS e vuoi gestire l'addon tramite Docker.

#### Crea il file `docker-compose.yml`

Salva il seguente contenuto in un file chiamato `docker-compose.yml`, oppure aggiungi questo compose al tuo file esistente:

```yaml
services:
  streamvixau:
    build: https://github.com/qwertyuiop8899/StreamVix-AU.git#main
    container_name: streamvixau
    restart: unless-stopped
    ports:
      - '7860:7860'
```
Sostituisci il link con il tuo fork se preferisci https://github.com/qwertyuiop8899/StreamVix-AU.git#main

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
sudo docker rmi streamvixau

# Pulisci la build cache
sudo docker builder prune -f

# Ricostruisci completamente senza cache
sudo docker compose build --no-cache streamvixau

# Avvia
sudo docker compose up -d streamvixau
```


### 💻 Metodo 3: Installazione Locale (per Esperti)

Usa questo metodo se vuoi modificare il codice sorgente, testare nuove funzionalità o contribuire allo sviluppo di StreamViX.

1.  **Clona il repository:**

    ```bash
    git clone [https://github.com/qwertyuiop8899/StreamVix-AU.git](https://github.com/qwertyuiop8899/StreamVix-AU.git) # Assicurati che sia il repository corretto di StreamViX-AU
    cd StreamVix-AU # Entra nella directory del progetto appena clonata
    ```

2.  **Installa le dipendenze:**
3.  
    ```bash
    pnpm install
    ```
4.  **Setup:**

Crea il file `.env`: Crea un file chiamato `.env` nella root del progetto (nella stessa directory dove si trova `package.json`) e inserisci le variabili necessarie, come nell'esempio per Docker Compose:


    TMDB_API_KEY=la_tua_chiave_api_di_tmdb
    MFP_URL=[https://username-mfp.hf.space](https://username-mfp.hf.space)
    MFP_PSW=la_tua_password_mfp
    PORT="portacustom"
    BOTHLINK="true"   true o false (mostra entrambi i link MFP e DIRECT)    
    ANIMEUNITY_ENABLED="true" abilita animeunity

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
