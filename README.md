
<img width="230" height="293" alt="icon" src="https://github.com/user-attachments/assets/11ef8b0e-6d55-44a4-9ccc-ae7031e99f34" />

# 🎬 StreamViX | ElfHosted

Un addon per Stremio che estrae sorgenti streaming dai siti vixsrc e animeunity animesaturn daddy e vavoo per permetterti di guardare film, serie TV, anime e tv con la massima semplicità.

[Link di Installazione](https://streamvix.hayd.uk/)

Istanza ElfHosted a pagamento CON Mediaflo Proxy incluso (Per Eventi Sportivi) 

[Istanza ElfHosted con Mediaflow](https://store.elfhosted.com/product/streamvix/)


---

## ✨ Funzionalità Principali 

* **✅ Supporto Film:** Trova flussi streaming per i film utilizzando il loro ID TMDB.
* **📺 Supporto Serie TV:** Trova flussi per ogni episodio di una serie TV, basandosi su ID TMDB in formato stagione/episodio.
* **🇪🇺 Eurostreaming (ES) Episodi:** Integrazione sperimentale per episodi tramite pulsante toggle (titolo StreamViX ES) con estrazione Python dedicata.
* **⛩️ Supporto Anime:** Trova flussi per ogni episodio di una determinato Anime, ora supporta ricerca sia da cinemeta, sia da tmdb che da kitsu.
* **📡 Supporto Live TV:** Canali TV italiani con EPG integrato.
* **📡 Supporto Eventi Sportivi:** Eventi sportivi aggiornati ogni giorno.
* **🔗 Integrazione Perfetta:** Si integra meravigliosamente con l'interfaccia di Stremio per un'esperienza utente fluida.
* **🌐 Proxy Unificato:** Un solo proxy MFP per tutti i contenuti (film, serie, anime, TV).
* **⚡ Modalità FAST Dinamica:** Eventi Live con URL dirette senza passare dall'extractor (toggle runtime) tutte etichettate `[Player Esterno]`.
* **🎯 Limite & Priorità Estrazioni:** In modalità extractor applica CAP di concorrenza e priorità per sorgenti italiane.
* **📡 Supporto Live TV:** Canali TV italiani e Eventi Sportivi visibili senza Mediaflow Proxy, scegliere i canali [Vavoo] o con 🏠.
* **🔓 Supporto Stream Senza Mediaflow Proxy:** Canali TV italiani e Eventi Sportivi, Film e Serie TV, scegliere gli stream con 🔓 per avviarli senza aver bisogno di un MediaflowProx. (Nota Bene, per avviare gli stream senza proxy ci potrebbe essere bisogno di un player esterno o VLC, prova con il player di default, se non va usa un player esterno tipo VLC)


---
Comandi per Live TV da browser

http://urladdon/live/update   aggiorna lista live events

http://urladdon/live/purge    cancella vecchi eventi

http://urladdon/live/reload   aggiorna il catalogo stremio 

https://streamvix.hayd.uk/live?forceIpCheck check mostraguarda

Endpoint aggiuntivi amministrazione / diagnostica

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
## 🐽 Integrazione Provider [P🐽D]

L'integrazione [P🐽D] aggiunge flussi prioritari provenienti da playlist esterne per:

1. Canali TV statici italiani esistenti (`tv_channels.json`): viene aggiunto il campo `pdUrlF` se il canale è presente anche nella playlist ITALY (nessuna creazione di nuovi canali).
2. Eventi sportivi dinamici (`dynamic_channels.json`): vengono iniettati uno o più stream `[P🐽D] <Broadcaster>` in testa alla lista degli stream dell'evento se esiste una corrispondenza tra le squadre (match "Team A vs Team B").

### Caratteristiche
* Mai creati canali nuovi: solo arricchimento di quelli già presenti.
* Idempotente: riesecuzioni non duplicano `pdUrlF` né gli stream `[P🐽D]`.
* Ordinamento: gli stream `[P🐽D]` sono sempre in cima; seguono eventuali stream Vavoo, poi gli altri.
* Mapping speciale Sky Calcio: nomi tipo `Sky Calcio 1 (251)` → `Sky Sport 251` (esteso automaticamente 251–269).
* Filtri broadcaster: accetta solo etichette contenenti SKY SPORT / SKY (con IT/ITALY), DAZN, EUROSPORT, PRIME, AMAZON.

### Flusso di Esecuzione
`Live.py` genera `dynamic_channels.json` → viene eseguito `pig_channels.py` → aggiorna `tv_channels.json` (pdUrlF) + inietta `[P🐽D]` negli eventi → l'addon carica/merge e serve.

### Variabili Ambiente Rilevanti
| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `WATCH_INTERVAL_MS` | 300000 | Intervallo (ms) loop watcher unificato che ricarica static/dynamic se i file cambiano (fallback: `TV_STATIC_WATCH_INTERVAL_MS` / `DYNAMIC_WATCH_INTERVAL_MS`). |
| `TV_STATIC_WATCH_INTERVAL_MS` | – | Fallback legacy per l'intervallo static (usato se `WATCH_INTERVAL_MS` non presente). |
| `DYNAMIC_WATCH_INTERVAL_MS` | – | Fallback legacy per l'intervallo dynamic (usato se `WATCH_INTERVAL_MS` non presente). |
| `DIAG_PD` | 1 | Abilita diagnostica startup: stampa hash/presenza di `pig_channels.py`, `tv_channels.json`, `dynamic_channels.json` e conteggio label `[P🐽D]`. Mettere `0` per disattivare. |
| `PYTHON_BIN` | python3 | Binario Python usato per script di arricchimento opzionali. |
| `DYNAMIC_FILE` | autodetect | Path al file dinamico (passato anche agli script figli se definito). |

### Esecuzione Manuale
Per rieseguire post-processing manuale:
```
python3 pig_channels.py --dynamic /percorso/dynamic_channels.json --tv-config config/tv_channels.json
```

### Log Principali
Prefissi:
* `[PD][BOOT]` avvio script
* `[PD][HTTP]` download playlist
* `[PD][PARSE]` parsing M3U
* `[PD][PATH]` diagnostica file input
* `[PD][STATE]` riepilogo eventi dinamici trovati
* `[PD][DONE]` completamento iniezione

### Entry Points / Endpoints [P🐽D]

| Endpoint / Script | Azione | Note |
|-------------------|--------|------|
| `/live/update` | Esegue `Live.py` quindi il post-processing `pig_channels.py` | Rigenera completamente `dynamic_channels.json` e re-inietta gli stream `[P🐽D]`. Aggiorna anche `pdUrlF` nei canali statici. |
| `/live/reload` | Ricarica in memoria il file dinamico già processato | Non rilancia gli script: mantiene le ultime iniezioni `[P🐽D]`. |
| `/static/reload` | Ricarica i canali statici (`tv_channels.json`) | Utile dopo modifiche manuali a `pdUrlF` o mapping Sky Calcio. |
| `python3 pig_channels.py --dynamic /path/dynamic_channels.json --tv-config config/tv_channels.json` | Post-processing manuale standalone | Non rigenera gli eventi: ri-applica solo l'arricchimento `[P🐽D]` e `pdUrlF`. |

Re-iniezione rapida senza aspettare la prossima finestra schedulata:
1. Modifica playlist esterna / mapping.
2. Chiama `/live/update` (o esegui `Live.py` manualmente) per pipeline completa, oppure esegui direttamente `pig_channels.py` se vuoi solo reiniettare.

Diagnostica iniziale (se `DIAG_PD=1`) mostra:
* Conteggio stream `[P🐽D]` trovati negli eventi
* Quanti canali statici hanno `pdUrlF`
* Hash/mtime dei file coinvolti

---
## 🛰️ Integrazione RB77 / RBTV (Streams `[RB77🇮🇹]`)

La sorgente RB77 (script `rbtv_streams.py`) arricchisce gli eventi dinamici con flussi marcati esplicitamente come italiani tramite tag tra parentesi quadre (es. `[HDD B ITALIANO]`, `[SD ITA]`, `[VDO ITALY]`).

### Obiettivi
* Iniettare solo varianti chiaramente italiane (riducendo falsi positivi tipo “digital”).
* Persistenza dei flussi: una volta scoperti restano associati all'evento anche fuori finestra (con simbolo aggiornato).
* Matching squadre molto preciso per evitare contaminazioni tra partite diverse (nessun cross-match Udinese↔Verona ecc.).
* Supporto eventi single-entity (MotoGP / F1 / Tennis) tramite elenco keyword.

### Finestra Discovery
| Parametro | Descrizione |
|-----------|-------------|
| `RBTV_DISCOVERY_BEFORE_MIN` | Minuti prima dell'`eventStart` in cui iniziare a cercare (default 15) |
| `RBTV_DISCOVERY_AFTER_MIN` | Minuti dopo l'inizio evento in cui continuare ad aggiungere nuove varianti (default 10) |
| `RBTV_FORCE` | Se impostata (1/true) ignora completamente le finestre e prova per tutti gli eventi (utile test) |

Fuori finestra (e non in force) lo script aggiorna solo l'emoji (🚫 / 🔴) dei flussi già presenti e prova un restore da cache se il titolo è scomparso.

### Filtraggio Lingua
Accetta SOLO titoli che abbiano almeno un tag tra parentesi quadre contenente token italiani:
`ita`, `italy`, `italia`, `italiano`, oppure forme parziali `ital` se configurate.

Variabili:
| Variabile | Default | Note |
|-----------|---------|------|
| `RBTV_LANG_KEYWORDS` | `italiano,italia,italy,ita,[ita]` | Lista include (csv, case-insensitive) |
| `RBTV_EXCLUDE_KEYWORDS` | (lista lingue estere) | Esclude se matcha (evita english, spanish, ecc.) |
| `RBTV_STRICT` | 0 | Se 1 richiede presenza `[ITA]` o parola intera italy/italia/italiano |

### Matching Squadre (Duo)
1. Parse nome evento (pattern `Team A vs Team B`) usando l'ULTIMO separatore `v|vs|vs.` presente nel titolo (elimina prefissi tipo "Serie A - ").
2. Normalizzazione: minuscole, rimozione rumore (ac, fc, calcio, club, anni), mapping sinonimi (`internazionale→inter`, `hellas→verona`, `juventus→juve`, ecc.).
3. Confronto ordine-indipendente (set esatto). Solo se entrambe le coppie coincidono viene accettato direttamente.
4. (Opzionale) Fuzzy: se il match esatto fallisce e fuzzy abilitato verifica due possibili accoppiamenti con `difflib.SequenceMatcher` usando soglia media e minima per singolo team.
5. Partial / single-side matching DISATTIVATI di default (riduce rumorosità). Possono essere riattivati con `RBTV_ALLOW_PARTIAL=1`.

### Variabili Matching / Debug
| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `RBTV_FUZZY_RATIO` | 0.75 | Soglia media fuzzy (clamp 0.5–0.95). Per-team min = max(0.55, soglia-0.2) |
| `RBTV_ALLOW_PARTIAL` | 0 | Se 1 riabilita match parziali / single-side (sconsigliato in produzione) |
| `RBTV_DEBUG_MATCH` | 0 | Log dettagli per ogni titolo saltato / accettato |
| `RBTV_DEBUG_SUMMARY` | 0 | Riepilogo per evento (conteggio exact/partial/single/fuzzy) |
| `RBTV_MAX_VARIANTS` | 0 | Limita numero varianti per stesso incontro (scoring HDD B > HDD A > VDO > SD) |

### Simboli Dinamici
| Simbolo | Significato |
|---------|-------------|
| 🚫 | Mancano >10 minuti allo start evento |
| 🔴 | Evento imminente (≤10 min) o iniziato |

Aggiornati anche fuori discovery per flussi già persistiti.

### Ordinamento Configurato
Gli stream `[RB77🇮🇹]` si inseriscono:
1. Dopo blocco iniziale `[P🐽D]` (broadcaster ufficiali) + eventuali altri 🇮🇹 non RB77 già presenti all’inizio.
2. Prima dei flussi `[Strd]`.
3. Prima di eventuali leftover dinamici.

### Persistenza
File cache: `/tmp/rbtv_streams_persist.json` contiene per-evento i flussi RB77 già scoperti; se il file dinamico viene rigenerato gli stessi stream vengono reiniettati (con prefisso aggiornato) purché l’evento esista ancora.

### Esempio Tuning
| Obiettivo | Azione |
|----------|--------|
| Rendere matching ancora più severo | Aumenta `RBTV_FUZZY_RATIO` a 0.8–0.85 e lascia `RBTV_ALLOW_PARTIAL=0` |
| Consentire varianti parziali (nomi incompleti) | `RBTV_ALLOW_PARTIAL=1` (attenzione a possibili cross-match) |
| Limitare varianti per pulizia UI | `RBTV_MAX_VARIANTS=2` |
| Debug profondo | `RBTV_DEBUG_MATCH=1 RBTV_DEBUG_SUMMARY=1` |

### Troubleshooting Rapido RB77
| Sintomo | Possibile Causa | Soluzione |
|---------|-----------------|-----------|
| Nessun flusso RB77 appare | Fuori discovery e `RBTV_FORCE` non impostato | Imposta `RBTV_FORCE=1` per test oppure attendi finestra |
| Flussi non marcati 🚫 / 🔴 correttamente | Clock server timezone non UTC o `eventStart` formattato male | Verifica ISO `eventStart` (termina con Z) |
| Cross-match tra partite | `RBTV_ALLOW_PARTIAL=1` attivo + fuzzy troppo basso | Disabilita partial o alza soglia fuzzy |
| Varianti eccessive stesso match | Nessun limite e playlist include A/B/SD/VDO | Imposta `RBTV_MAX_VARIANTS` |
| Playlist vuota | URL non raggiungibile o filtri italiani troppo stretti | Disabilita `RBTV_STRICT` temporaneamente e controlla log fetch |

### Roadmap Facoltativa
* De-duplicazione tra eventi invertiti (A vs B / B vs A) selezionando evento primario.
* Lista sinonimi estesa (Serie B/C) caricabile da file esterno.
* Modalità “audit” che salva CSV con motivazioni di skip.

---
## 🌊 Integrazione Playlist Streamed ([Strd])

Arricchisce gli eventi sportivi dinamici con stream provenienti da una playlist M3U esterna. Funzione disabilitata di default. (Vecchio prefisso legacy `[Streamed]` ancora riconosciuto per evitare duplicati durante la transizione.)

### Novità / Miglioramenti
* Prefisso più corto: `[Strd]`.
* Matching fuzzy tollerante: ordine squadre invertito, descrizioni aggiuntive, tag finali vengono ignorati.
* Supporto eventi single-entity / tournament (F1, MotoGP, Tennis, coppe, practice/qualifying): matching per parole chiave con soglia configurabile.
* Modalità debug per vedere i match fuzzy accettati.
* Sottotoken opzionali (es: "man" dentro "manchester") disattivabili.

### Matching Squadre (Duo)
1. Parse del nome evento `⏰ HH:MM : Team A vs Team B - League ...` per estrarre `Team A`, `Team B`.
2. Normalizzazione: rimozione prefissi (AC/AS/FC/US/SSC...), mapping speciali (Inter, Milan, Juventus, ecc.), fallback ultimo token.
3. Match diretto esatto ordine-indipendente se il titolo playlist contiene esplicitamente le due parti separate da `vs`.
4. Fallback fuzzy: il titolo della playlist deve contenere almeno un alias per Team A e uno per Team B (con o senza sottotoken, configurabile).

Log fuzzy (se `STREAMED_MATCH_DEBUG=1`):
`[STREAMED][MATCH][FUZZ] teams 'milan' 'inter' title='Serie A - Inter vs AC Milan [ECHO]'`

### Matching Single-Entity / Tournament
Usato quando non si trovano due squadre chiare. Esempi: `Qatar Airways Azerbaijan GP : Practice 1`, `Roland Garros - Day 3`.

1. Identificazione evento single-entity se contiene almeno una keyword (gp, grand prix, formula 1, motogp, qualifying, roland garros, wimbledon, atp, wta, masters, cup, champions league, ecc.).
2. Costruzione bag di token significativi (>2 caratteri) dal segmento principale del nome evento (prima di ` - League`).
3. Un titolo playlist è accettato se contiene almeno `STREAMED_MIN_KEYWORD_HITS` di quei token (default 2). Soglia minima reale 1.
4. Log debug (se attivo):
`[STREAMED][MATCH][FUZZ][SINGLE] hits=3 title='Azerbaijan GP Practice 1 HD' event='⏰ 10:30 : Qatar Airways Azerbaijan GP vs Practice 1 - Motorsport 19/09' tokens=['azerbaijan','practice','gp',...]`

### Finestre Temporali
| Fase | Finestra | Descrizione |
|------|----------|-------------|
| Pre-start fetch | da `start - PRE_START` a `start` | Inizio matching prima dell'evento |
| Post-start fetch | `start` → `start + POST_FETCH` | Continua a cercare nuove varianti |
| Keep window | `start + POST_FETCH` → `start + POST_KEEP` | Mantiene ma non aggiunge dopo keep se già popolato |

Default: PRE_START=15, POST_FETCH=10, POST_KEEP=20 (minuti).

### Ordinamento Finale Streams
1. `[P🐽D]`
2. Vavoo
3. Originali dinamici
4. `[Strd] ...`

### Variabili Ambiente Streamed (Aggiornate)
| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `STREAMED_ENABLE` | 0 | Abilita polling/enrichment |
| `STREAMED_POLL_INTERVAL_MS` | 60000 | Intervallo polling (>=30000) |
| `STREAMED_PLAYLIST_URL` | https://world-proxifier.xyz/streamed/playlist.m3u8 | URL playlist |
| `STREAMED_CACHE_TTL_SEC` | 60 | Cache locale M3U |
| `STREAMED_PRE_START_WINDOW_MIN` | 15 | Finestra pre-start |
| `STREAMED_POST_START_FETCH_WINDOW_MIN` | 10 | Finestra fetch dopo start |
| `STREAMED_POST_START_KEEP_MIN` | 20 | Mantieni fino a |
| `STREAMED_MIN_KEYWORD_HITS` | 2 | Soglia keyword per single-entity (min 1) |
| `STREAMED_MATCH_DEBUG` | 0 | 1 abilita log match fuzzy |
| `STREAMED_ALLOW_SUBTOKEN` | 1 | 0 richiede match parola intera; 1 permette sottostringhe |
| `STREAMED_UA` | browser UA | Header User-Agent |
| `STREAMED_REFERER` | https://embedsports.top/ | Header Referer |
| `STREAMED_ORIGIN` | https://embedsports.top | Header Origin |
| `STREAMED_PLAYLIST_HEADERS` | – | Extra headers `K:V;K2:V2` |
| `STREAMED_FETCH_RETRIES` | 3 | Tentativi fetch |
| `STREAMED_PROPAGATE_HEADERS` | 0 | 1 = propaga eventuali header estratti nel link stream finale |
| `STREAMED_HEADER_MODE` | url_params | Modalità propagazione (solo `url_params` supportata ora) |
| `STREAMED_HEADER_PARAM_PREFIX` | h_ | Prefisso parametri query header (es: `h_Origin=`) |
| `DYNAMIC_FILE` | autodetect | Path file dinamico |
| `PYTHON_BIN` | python3 | Binario script |

### Force Mode
| Metodo | Come |
|--------|------|
| Query Param | `/streamed/reload?force=1` |
| Env | `STREAMED_FORCE=1 python3 streamed_channels.py` |
| CLI | `python3 streamed_channels.py --force` |

In force mode ignora le finestre, prova a matchare TUTTI gli eventi (`[STREAMED][INJECT][FORCE]`).

### Deduplicate & Cache
* Evita duplicati per URL o titolo completo `[Strd] ...`.
* Riconosce e converte eventuali vecchi titoli `[Streamed]` → `[Strd]` senza duplicare.
* Cache disco `/tmp/streamed_playlist_cache.json`.

### Robustezza Fetch
Browser-like headers, DNS log, retry con backoff, fallback `requests`, cache TTL.

### Rigenerazione Eventi
Ogni `/live/update` resetta gli stream `[Strd]`; serve un nuovo ciclo polling / reload per reiniettarli.

### Propagazione Header Playback (Opzionale)
Alcuni flussi necessitano header HTTP specifici (Origin, Referer, User-Agent) per funzionare correttamente quando aperti direttamente da un player.

Quando `STREAMED_PROPAGATE_HEADERS=1` e la playlist M3U contiene direttive `#EXTVLCOPT:http-<header>=<valore>`, questi header vengono incorporati nell'URL finale come parametri di query:

Esempio URL trasformato:
```
https://cdn.example.xyz/abcd/index.m3u8?h_Origin=https%3A%2F%2Fembedsports.top&h_Referer=https%3A%2F%2Fembedsports.top%2F&h_User-Agent=Mozilla%2F5.0...
```

Dettagli:
* Modalità attuale: `STREAMED_HEADER_MODE=url_params` (unica implementata).
* Prefisso configurabile: `STREAMED_HEADER_PARAM_PREFIX` (default `h_`).
* Viene anche aggiunto il campo `xHeaders` nello stream (metadato) con la mappa originale per client che vogliono ricostruire gli header.
* Nessuna logica lato server di re-fetch con header al momento: il player deve gestire (o ignorare) i parametri.

Motivazione: evitare un proxy interno dedicato finché non strettamente necessario, mantenendo link diretti ma auto-descrittivi.

#### Variabili Coinvolte
| Variabile | Effetto |
|-----------|---------|
| `STREAMED_PROPAGATE_HEADERS=1` | Abilita trasformazione URL con parametri header |
| `STREAMED_HEADER_MODE=url_params` | Usa parametri di query (futuro: `proxy`) |
| `STREAMED_HEADER_PARAM_PREFIX=h_` | Cambia prefisso (`h_Origin`, `h_Referer`, ecc.) |

#### Esempio JSON Enriched (Estratto)
```json
{
    "id": "evt123",
    "name": "⏰ 20:45 : Inter vs Milan - Serie A 19/09",
    "streams": [
        { "title": "[P🐽D] SKY SPORT", "url": "https://.../sky.m3u8" },
        { "title": "[Strd] Inter vs Milan HD", "url": "https://edge.cdn/foo/index.m3u8?h_Origin=https%3A%2F%2Fembedsports.top&h_Referer=https%3A%2F%2Fembedsports.top%2F", "xHeaders": { "Origin": "https://embedsports.top", "Referer": "https://embedsports.top/" } }
    ]
}
```

#### Caveat & Best Practice
* Alcuni player ignorano parametri informativi: se un flusso non parte, prova un player esterno (VLC) o l'uso del proxy MFP.
* Non inserire header sensibili (token auth) — diventano visibili nel link.
* Se l'URL originale aveva query params, vengono preservati e merge-ati.
* In caso di conflitto di chiavi, l'ultima scrittura (header propagato) prevale.

#### Strategia Fallback (Futura)
Se emergono molti player che non rispettano i parametri, verrà introdotta una modalità `STREAMED_HEADER_MODE=proxy` che:
1. Riconosce parametri `h_*`.
2. Effettua fetch server-side con header reali.
3. Risponde con passthrough (senza esporre header al client).

Attualmente questa modalità NON è implementata per ridurre complessità e latenza.

#### Troubleshooting Rapido
| Sintomo | Possibile Causa | Azione |
|--------|-----------------|--------|
| Stream `[Strd]` non parte, altri sì | Player ignora header | Testa con VLC / abilita proxy MFP |
| Header non appaiono in URL | `STREAMED_PROPAGATE_HEADERS` non impostato | Esporta variabile a `1` e reinietta (reload/force) |
| Parametri duplicati | Prefisso cambiato più volte | Uniforma `STREAMED_HEADER_PARAM_PREFIX` |
| Troppi parametri lunghi | User-Agent molto esteso | Usa UA più corto tramite `STREAMED_UA` |

---

---
## ⏱️ Scheduler & Watcher Recap (PD + Streamed)

| Meccanismo | Orari / Intervallo (Europe/Rome) | Cosa fa | Coinvolge |
|------------|----------------------------------|---------|-----------|
| Live.py cron interno | Ogni 2h: 08:10,10:10,...,06:10 | Rigenera eventi dinamici + post-processing `[P🐽D]` | Dynamic + PD |
| Purge fisico | 02:05 | Rimuove eventi giorno precedente dal file | Dynamic |
| Reload sicurezza | 02:30 | Ricarica cache addon | Dynamic |
| Watcher unificato | `WATCH_INTERVAL_MS` (default 5m) | Rileva mtime cambiato e ricarica in memoria statici/dinamici | Static + Dynamic |
| Streamed poller | `STREAMED_POLL_INTERVAL_MS` (default 60s) se abilitato | Aggiunge `[Streamed]` durante finestre | Streamed |
| `/streamed/reload` | On demand | Singolo arricchimento Streamed | Streamed |
| `/streamed/reload?force=1` | On demand | Forza arricchimento completo | Streamed |
| `/live/update` | On demand | Rigenera + PD injection (poi serve run Streamed) | PD + Dynamic |
| `/live/reload` | On demand | Ricarica file già arricchito | Dynamic |
| `/static/reload` | On demand | Ricarica canali statici (pdUrlF compresi) | Static + PD |

Note:
* Gli stream `[P🐽D]` sono persistiti nel file rigenerato a ogni `/live/update` (non serve un endpoint dedicato PD).
* Gli stream `[Streamed]` non sono persistiti tra rigenerazioni: ogni nuova rigenerazione richiede un nuovo ciclo Streamed.
* Force mode Streamed è pensato solo per test / validazione; in produzione lasciare alla logica temporale per evitare clutter.

---
## 🆕 Integrazioni Recenti (Sintesi Rapida)

| Feature | Dettagli | Ordering Impatto |
|---------|----------|------------------|
| RBTV / RB77 | Nuova sorgente playlist italiana (poll ~120s). Filtra solo titoli con token IT (italiano/italia/italy/ital/ita/ it ). Persistenza per evento. Prefisso `[RB77🇮🇹]` + simbolo dinamico (🚫 / 🔴). | Inserito dopo blocco `[P🐽D]` + cluster 🇮🇹 e prima di `[Strd]`. |
| PD Relax Competizioni | Per Serie A/B/C, coppe, F1, MotoGP, Tennis, Volley ecc: ignorato brand allowlist; richiesti team match (o single-entity) + token italiano nel broadcaster. Altre competizioni: brand + token IT obbligatori. (Nessun simbolo dinamico per PD). | Mantiene blocco iniziale in cima agli stream evento. |
| Streamed `[Strd]` | Aggiunti simboli dinamici (🚫 >10m prima, 🔴 da -10m in poi). Persistenza fuori discovery conservata + refresh simboli. | Continua a posizionarsi dopo RB77. |
| Simboli Dinamici | Applicati solo a RB77 e Strd (🚫 / 🔴). | Non altera logica ordering, solo titoli (PD escluso). |

### Stato Simboli
* 🚫 = evento non ancora in finestra di start (mancano >10 minuti)
* 🔴 = evento imminente (<10 minuti) o già iniziato

### Ordine Finale Streams per Evento
1. `[P🐽D]` (con simboli)
2. 🇮🇹 altri stream prioritari (se presenti)
3. `[RB77🇮🇹]`
4. `[Strd]`
5. Restanti dinamici / leftover

### Variabili Chiave Nuove / Modificate
| Variabile | Default | Uso |
|-----------|---------|-----|
| `RBTV_PLAYLIST_URL` | https://world-proxifier.xyz/rbtv/playlist.m3u8 | Sorgente RB77 |
| `RBTV_DISCOVERY_BEFORE_MIN` | 15 | Minuti prima start per discovery RB77 |
| `RBTV_DISCOVERY_AFTER_MIN` | 10 | Minuti dopo start per discovery RB77 |
| `RBTV_FORCE` | (off) | Ignora finestre RB77 |
| `STREAMED_POLL_INTERVAL_MS` | 120000 (se aggiornato in addon) | Cadenza polling playlist Streamed |

### Nota Fallback PD (Eventi)
Definito un secondo URL identico di backup (non ancora usato automaticamente): se la sorgente primaria eventi risultasse indisponibile si può estendere lo script PD per provarlo come fallback.

---

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
    image: qwertyuiop8899/streamvix:latest  
    container_name: streamvix
    ports:
      - "7860:7860"
    environment:
      - BOTHLINK=true
      - MFP_URL= # your mediaflow proxy instance url or http://container-name:port
      - MFP_PSW= # The password of your mediaflow proxy instance
      - TMDB_API_KEY= #https://www.themoviedb.org/settings/api
    restart: always
#   Use watchtower for automatic image updates

#   watchtower:
#     image: containrrr/watchtower
#     container_name: watchtower
#     volumes:
#     - /var/run/docker.sock:/var/run/docker.sock
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





















