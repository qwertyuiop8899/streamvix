# 🎬 StreamViX | ElfHosted 

An addon for Stremio that scrapes streaming sources from the sites vixsrc and animeunity animesaturn daddy and vavoo to let you watch movies, TV series, anime and live TV with maximum simplicity.

[Installation Link](https://streamvix.hayd.uk/)

Paid ElfHosted instance WITH MEDIAFLOWProxy included (For Sports Events)

[ElfHosted instance with Mediaflow](https://store.elfhosted.com/product/streamvix/)

## ✨ Main Features
* **✅ Movie Support:** Finds streaming sources for movies using their TMDB ID.
* **📺 TV Series Support:** Finds streams for each episode of a TV series, based on TMDB ID in season/episode format.
* **⛩️ Anime Support:** Finds streams for each episode of a given Anime, now supports search from both cinemeta, tmdb, and kitsu.
* **📡 Live TV Support:** Italian TV channels with integrated EPG.
* **📡 Sports Events Support:** Sports events updated daily.
* **🔗 Seamless Integration:** Integrates beautifully with the Stremio interface for a smooth user experience.
* **🌐 Unified Proxy:** A single MFP proxy for all content (movies, series, anime, TV).
* **⚡ Dynamic FAST Mode: Live events with direct URLs bypassing the extractor (runtime toggle), all labeled [External Player].
* **🎯 Extraction Limits & Priority: In extractor mode, applies concurrency CAP and prioritizes Italian sources.
* **📡 Live TV Support: Italian TV channels and Sports Events viewable without Mediaflow Proxy; choose channels marked [Vavoo] or with 🏠.



---
Commands for Live TV from browser
http://urladdon/live/update   update live events list
http://urladdon/live/purge    clear old events
http://urladdon/live/reload   update the stremio catalog

## 🔧 Simplified Configuration
StreamViX uses a **unified proxy system** that simplifies configuration:
### 🌐 Unified MFP Proxy
- **A single URL and password** for all content (movies, series, anime, TV)
### 📋 Required Configuration
- `MFP_URL`: Your MFP proxy URL
- `MFP_PSW`: MFP proxy password
- `TMDB_API_KEY`: TMDB API Key for metadata (OPTIONAL)
- `ANIMEUNITY_ENABLED`: Enable AnimeUnity (true/false)
- `ANIMESATURN_ENABLED`: Enable AnimeSaturn (true/false)
- `Enable MPD Streams`: (true/false) Not working, leave false
- `Enable Live TV`: Enable to watch live tv (true/false)
---
## ⚙️ Installation
You can only install StreamViX locally, on a home server, or on a non-flagged VPN or with smartdns to watch animeunity,  
for the rest, animesaturn and vixsrc work fine also on Huggingface, but they have started banning StreamViX, so use at your own risk.  
For local installations, you always need an https domain to install the addon. Or use a fork of mediaflow proxy EXE on Windows.  
(works only if the PC stays on [https://github.com/qwertyuiop8899/mediaflow-proxy_exe/](https://github.com/qwertyuiop8899/mediaflow-proxy_exe/))
---
### 🚀 Method 1: Render (Recommended for Everyone)
This method lets you have your personal instance of the addon online, for free and with maximum simplicity.
#### Prerequisites
* **Render Account:** Create an account [here]([render.com](https://dashboard.render.com/register)).
* **(OPTIONAL) TMDB API Key:** Obtain one for free by registering at [The Movie Database (TMDB)](https://www.themoviedb.org/documentation/api).
* **MediaflowProxy (MFP) URL:** You need to have an instance of MediaflowProxy (https://github.com/nzo66/mediaflow-proxy) already deployed on Render/Local/VPS. Make sure it's an updated version  
#### Installation Procedure
1.  **Create a New Space 🆕**
    * Go to [Render]((https://dashboard.render.com/)) and log in.
    * Click the + in the top right and then `Web Service`.
    * **Public Git Repository:** Paste the repo `(https://github.com/qwertyuiop8899/StreamViX)`.
    * **Connect**
    * **Choose a name**
    * **Branch** `render`
    * **Instance Type** `Free`
    * **Deploy Web Service**
2.  **Build and Deploy 🚀**
    * Render will automatically start building your addon. You can monitor the process in the `Logs` tab.
    * Once you see the status "Running", your addon is ready!
3.  **Install in Stremio 🎬**
    * On your Space's main page, top left, you will see a purple link, click it and configure streamvix then install it on Stremio with the appropriate buttons.
---
### 🐳 Docker Compose (Advanced / Self-Hosting)
Ideal if you have a server or VPS and want to manage the addon via Docker.
#### Create the `docker-compose.yml` file
Save the following content in a file called `docker-compose.yml`, or add this compose to your existing file:
```yaml
services:
  streamvix:
    build: [https://github.com/qwertyuiop8899/StreamViX.git#main](https://github.com/qwertyuiop8899/StreamViX.git#main)
    container_name: streamvix
    restart: unless-stopped
    ports:
      - '7860:7860'
```
Replace the link with your fork if preferred [https://github.com/qwertyuiop8899/StreamViX_MFP.git#main](https://github.com/qwertyuiop8899/StreamViX_MFP.git#main)  
TMDB Api KEY, MFP link, MFP password, and the two flags will be managed from the installation page.  
#### Run Docker Compose  
Open a terminal in the directory where you saved the `docker-compose.yml` and run the following command to build and start the container in background:  
```bash
docker compose up -d --build
```
If updates are available, run:  
```bash
# Stop everything
sudo docker compose down streamvixau
# Remove the specific image
sudo docker rmi streamvix
# Clear build cache
sudo docker builder prune -f
# Rebuild completely without cache
sudo docker compose build --no-cache streamvix
# Start
sudo docker compose up -d streamvix
```
### 💻 Method 3: Local Installation (for Experts NOT TESTED)
Use this if you want to modify the source code, test new features or contribute to StreamViX development.  
1.  **Clone the repository:**
    ```bash
    git clone [https://github.com/qwertyuiop8899/StreamViX.git](https://github.com/qwertyuiop8899/StreamViX.git) # Make sure it's the correct StreamViX repo
    cd StreamViX # Enter the newly cloned project directory
    ```
2.  **Install dependencies:**
    ```bash
    pnpm install
    ```
3.  **Set up:**
4.  **Build the project:**
    ```
    pnpm run build
    ```
5.  **Start the addon:**
    ```
    pnpm start
    ```
The addon will be available locally at `http://localhost:7860`.  
#### ⚠️ Disclaimer
This project is intended for educational purposes only. The user is solely responsible for usage. Ensure you respect copyright laws and terms of service of the sources used.
## Credits
Original extraction logic written by [https://github.com/mhdzumair](https://github.com/mhdzumair) for the extractor code [https://github.com/mhdzumair/mediaflow-proxy](https://github.com/mhdzumair/mediaflow-proxy)  
Thanks to [https://github.com/ThEditor](https://github.com/ThEditor) [https://github.com/ThEditor/stremsrc](https://github.com/ThEditor/stremsrc) for the main code and Stremio addon  
A special thanks to @UrloMythus for the extractors and kitsu logic
