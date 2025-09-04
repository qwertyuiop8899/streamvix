# 🎬 StreamViX | ElfHosted 

An addon for Stremio that scrapes streaming sources from the sites vixsrc and animeunity animesaturn daddy and vavoo to let you watch movies, TV series, anime and live TV with maximum simplicity.

[Installation Link](https://streamvix.hayd.uk/)

Paid ElfHosted instance WITH MEDIAFLOWProxy included (For Sports Events)

[ElfHosted instance with Mediaflow](https://store.elfhosted.com/product/streamvix/)
<img width="230" height="293" alt="icon" src="https://github.com/user-attachments/assets/11ef8b0e-6d55-44a4-9ccc-ae7031e99f34" />

# 🎬 StreamViX | ElfHosted

A Stremio addon that extracts streaming sources from vixsrc, animeunity, animesaturn, daddy and vavoo so you can watch movies, TV series, anime and live TV with maximum simplicity.

[Installation Link](https://streamvix.hayd.uk/)

Paid ElfHosted instance WITH MEDIAFLOWProxy included (For Sports Events)

[ElfHosted instance with Mediaflow](https://store.elfhosted.com/product/streamvix/)

---

## ✨ Main Features

* **✅ Movie Support:** Find streaming streams for movies using their TMDB ID.
* **📺 TV Series Support:** Find streams for every episode of a TV series, based on TMDB ID in season/episode format.
* **⛩️ Anime Support:** Find streams for every episode of a specific Anime; now supports search from cinemeta, tmdb and kitsu.
* **📡 Live TV Support:** Italian TV channels with integrated EPG.
* **📡 Sports Events Support:** Sports events updated every day.
* **🔗 Perfect Integration:** Integrates beautifully with the Stremio interface for a smooth user experience.
* **🌐 Unified Proxy:** A single MFP proxy for all content (movies, series, anime, TV).
* **⚡ Dynamic FAST Mode:** Live events with direct URLs without passing through the extractor (runtime toggle) all labeled `[Player Esterno]` (External Player).
* **🎯 Extraction Limit & Priority:** In extractor mode applies a concurrency CAP and prioritizes Italian sources.
* **📡 Live TV Support:** Italian TV channels and Sports Events viewable without Mediaflow Proxy, choose channels [Vavoo] or with 🏠.
* **🔓 Streams Without Mediaflow Proxy Support:** Italian TV channels and Sports Events, Movies and TV Series: choose streams with 🔓 to start them without needing a MediaflowProxy. (Note: to start streams without proxy you may need an external player or VLC; try the default player, if it fails use an external player like VLC.)


---
Commands for Live TV from browser

http://urladdon/live/update   update live events list

http://urladdon/live/purge    delete old events

http://urladdon/live/reload   refresh the Stremio catalog

Additional admin / diagnostic endpoints

http://urladdon/admin/mode?fast=1   enable FAST dynamic mode (uses direct URLs)

http://urladdon/admin/mode?fast=0   return to extractor mode (resolution + CAP)

Note: the toggle is not persistent across restarts (runtime only).


## 🔧 Simplified Configuration

StreamViX uses a **unified proxy system** that simplifies configuration:

### 🌐 Unified MFP Proxy
- **A single URL and password** for all content (movies, series, anime, TV)

### 📋 Required Configuration
- `MFP_URL`: URL of your MFP proxy
- `MFP_PSW`: Password of the MFP proxy
- `TMDB_API_KEY`: TMDB API key for metadata (OPTIONAL)
- `ANIMEUNITY_ENABLED`: Enable AnimeUnity (true/false)
- `ANIMESATURN_ENABLED`: Enable AnimeSaturn (true/false)
- `Enable MPD Streams`: (true/false) Not working, leave false
- `Enable Live TV`: Enable to view live TV (true/false)
  
### ⚡ Dynamic Events: FAST vs Extractor

Dynamic sports events are loaded from the file `config/dynamic_channels.json` generated periodically by `Live.py`.

Available modes:

1. FAST (direct):
    - Activate with variable `FAST_DYNAMIC=1` or runtime `/admin/mode?fast=1`.
    - Completely skips the extractor and immediately uses the URLs present in the JSON.
    - No concurrency limit, all sources are exposed as direct streams.
    - Every FAST stream is labeled with prefix `[Player Esterno]` (🇮🇹 emoji remains if title normalization requires it).
2. Extractor (default if `FAST_DYNAMIC=0`):
    - Each dynamic URL passes through resolution (if proxy MFP configured) before being shown.
    - Applies a concurrency CAP equal to `DYNAMIC_EXTRACTOR_CONC` (default 10) to limit simultaneous extractor requests.
    - Sources beyond the CAP are still exposed as leftover direct streams with `[Player Esterno]` (not extracted) so they’re not lost.
    - Priority: first titles matching `(it|ita|italy)`, then `(italian|sky|tnt|amazon|dazn|eurosport|prime|bein|canal|sportitalia|now|rai)`, then others.

Tip: set `DYNAMIC_EXTRACTOR_CONC=1` for testing: you will see exactly 2 streams (1 extracted + 1 leftover `[Player Esterno]`).

### 🧪 Quick local test example (curl)

1. Start server with: `FAST_DYNAMIC=0 DYNAMIC_EXTRACTOR_CONC=1 pnpm start`
2. Request event stream: `curl http://127.0.0.1:7860/stream/tv/<event_id>.json`
3. Enable FAST: `curl http://127.0.0.1:7860/admin/mode?fast=1`
4. Request same endpoint again: you’ll notice more streams (all direct) and no leftovers.

### ⏱️ Scheduler Live.py

`Live.py` runs automatically EVERY 2 HOURS starting from **08:10 Europe/Rome** at: 08:10, 10:10, 12:10, 14:10, 16:10, 18:10, 20:10, 22:10, 00:10, 02:10, 04:10, 06:10.

At each execution:
* Downloads / regenerates `dynamic_channels.json`.
* The in-memory dynamic cache is invalidated and reloaded.

### 📄 "JSON as-is" Behavior (no filters)

- The addon always reads `config/dynamic_channels.json` as-is on every request.
- No runtime date filter is applied by default.
- This ensures what you see in the catalog always matches the JSON content updated by the scheduler/`/live/update`.

If you later want to re-enable date filtering logic:

- `DYNAMIC_DISABLE_RUNTIME_FILTER=0` enables the runtime filter.
- `DYNAMIC_PURGE_HOUR` (default `8`): hour (Europe/Rome) after which previous-day events are NOT shown at catalog anymore.
- `DYNAMIC_KEEP_YESTERDAY` (default `0`): if `1`, keeps yesterday’s events visible until physical purge.

Expectations when you re-enable filtering:

- Before `DYNAMIC_PURGE_HOUR`: you’ll see today’s events and, if present, still yesterday’s (if `DYNAMIC_KEEP_YESTERDAY=1`).
- After `DYNAMIC_PURGE_HOUR`: you’ll only see events whose `eventStart` is today (yesterday’s disappear from catalog).
- Physical purge at 02:05 rewrites the file removing yesterday’s events regardless of runtime filter.

### 🧹 Event Cleanup & Grace Window

Removal of previous day events happens in two ways:

1. Runtime filter: if `process.env.DYNAMIC_PURGE_HOUR` (default **08**) has passed, events with previous-day `eventStart` are no longer shown in the catalog.
2. Scheduled physical purge: at **02:05** a purge rewrites the file deleting obsolete events (manual endpoint: `/live/purge`). Safety reload at **02:30**.

Note: with the default "JSON as-is" behavior active, event visibility depends only on JSON content and the physical purge; the runtime filter is disabled.

If you want to extend visibility until a certain hour just set `DYNAMIC_PURGE_HOUR` (e.g. `DYNAMIC_PURGE_HOUR=9`).

### 🏷️ Dynamic Stream Labels

* `[Player Esterno]` =
    - In FAST mode: prefix always present on all streams (all direct).
    - In extractor mode: prefix only on leftovers (streams beyond CAP not extracted). The first block (within CAP) has no prefix unless it already came that way from source.
* Emoji 🇮🇹 = recognized Italian title or source automatically.

### 🔁 Useful Endpoints Summary

| Endpoint | Description |
|----------|-------------|
| `/live/update` | Immediately runs `Live.py` and reloads dynamics |
| `/live/reload` | Invalidates cache and reloads without running script |
| `/live/purge` | Physical purge of old event file |
| `/admin/mode?fast=1` | Enable dynamic FAST |
| `/admin/mode?fast=0` | Return to extractor |

### 🌍 Relevant Environment Variables (Extended)

| Variable | Default | Description |
|----------|---------|-------------|
| `FAST_DYNAMIC` | 0 | 1 = use direct dynamic URLs |
| `DYNAMIC_EXTRACTOR_CONC` | 10 | Extractor request limit (CAP). With CAP=1 you get 1 extracted + 1 leftover |
| `DYNAMIC_PURGE_HOUR` | 8 | Hour (Rome) after which previous-day events disappear from catalog |
| `DYNAMIC_DISABLE_RUNTIME_FILTER` | 1 | 1 = don’t filter by date (use JSON as-is); 0 = enable day filter |
| `DYNAMIC_KEEP_YESTERDAY` | 0 | 1 = with filter active keeps yesterday’s events too |

---
  
---

## ⚙️ Installation

You can install StreamViX only locally, on a home server or on a non-flagged VPN or with smartdns to view animeunity. 
For the rest, animesaturn and vixsrc also work on Huggingface, but they have started banning StreamViX, so at your own risk.
For local installations you always need an https domain to install the addon. Or use a fork of mediaflow proxy EXE on Windows.
(works only if the PC stays on https://github.com/qwertyuiop8899/mediaflow-proxy_exe/ )

---

### 🚀 Method 1: Render (Recommended for Everyone)

This method lets you have your personal instance of the addon online, free and with maximum simplicity.

#### Prerequisites

* **Render Account:** Create an account [here]([render.com](https://dashboard.render.com/register)).
* **(OPTIONAL) TMDB API Key:** Get one for free by registering on [The Movie Database (TMDB)](https://www.themoviedb.org/documentation/api).
* **MediaflowProxy URL (MFP):** You must have an instance of MediaflowProxy (https://github.com/nzo66/mediaflow-proxy) already deployed on Render/Local/VPS. Make sure it’s an updated version

#### Installation Procedure

1.  **Create a New Space 🆕**
    * Go to [Render]((https://dashboard.render.com/)) and log in.
    * Click the + at top right then `Web Service`.
    * **Public Git Repository:** Paste the repo `(https://github.com/qwertyuiop8899/StreamViX)`).
    * **Connect**
    * **Choose the name**
    * **Branch** `render`
    * **Instance Type** `Free`
    * **Deploy Web Service**

2.  **Build & Deploy 🚀**
    * Render will automatically start building your addon. You can monitor progress in the `Logs` tab.
    * Once you see status "Running", your addon is ready!

3.  **Install in Stremio 🎬**
    * On the main page of your Space, top left you will see a purple link; click it and configure streamvix then install it in Stremio with the buttons provided.

---

### 🐳 Docker Compose (Advanced / Self-Hosting)

Ideal if you have a server or VPS and want to manage the addon via Docker.

#### Create the `docker-compose.yml` file

Save the following content in a file named `docker-compose.yml`, or add this compose to your existing file:

```yaml
services:
  streamvix:
    image: krystall0/streamvix:latest  
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

TMDB Api KEY, MFP link and MFP password and the two required flags will be managed from the installation page.

#### Run Docker Compose

Open a terminal in the directory where you saved `docker-compose.yml` and run the following command to build the image and start the container in background:

```bash
docker compose up -d
```
With watchtower the image will be updated automatically.

### 💻 Method 3: Local Installation (for Experts NOT TESTED)

Use this method if you want to modify the source code, test new features or contribute to StreamViX development.

1.  **Clone the repository:**

    ```bash
    git clone https://github.com/qwertyuiop8899/StreamViX.git # Make sure it is the correct StreamViX repository
    cd StreamViX # Enter the newly cloned project directory
    ```

2.  **Install dependencies:**
3.  
    ```bash
    pnpm install
    ```
4.  **Setup:**


5.  **Build the project:**
    ```
    pnpm run build
    ```
6.  **Start the addon:**
    ```
    pnpm start
    ```
The addon will be available locally at `http://localhost:7860`.

---

## 🔍 Quick Troubleshooting

| Problem | Possible Causes | Solution |
|----------|-----------------|-----------|
| No dynamic events after 07:30 | `DYNAMIC_PURGE_HOUR` too low | Increase to 8+ or remove variable |
| Few dynamic streams visible | Extractor mode with low CAP | Increase `DYNAMIC_EXTRACTOR_CONC` or enable FAST |
| URLs not transformed | MFP proxy not configured | Set `MFP_URL` and `MFP_PSW` or use FAST |
| FAST toggle does not persist reboot | Expected behavior | Export `FAST_DYNAMIC=1` in environment |

---


#### ⚠️ Disclaimer

This project is intended exclusively for educational purposes. The user is solely responsible for how it is used. Make sure you respect copyright laws and the terms of service of the sources used.


## Credits

Original extraction logic written by https://github.com/mhdzumair for the extractor code https://github.com/mhdzumair/mediaflow-proxy 
Thanks to https://github.com/ThEditor https://github.com/ThEditor/stremsrc for the main code and stremio addon
Special thanks to @UrloMythus for the extractors and kitsu logic

Dynamic FAST / CAP / purge features implemented in 2025.
