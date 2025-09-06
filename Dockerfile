# Scegli un'immagine Node.js di base
FROM node:20-slim

# Installa git, python3, pip e dipendenze per compilazione
USER root 
RUN apt-get update && apt-get install -y \
    git \
    python3 python3-pip python3-dev \
    build-essential ca-certificates \
    tesseract-ocr tesseract-ocr-ita tesseract-ocr-eng \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Imposta la directory di lavoro nell'immagine
WORKDIR /usr/src/app

# Installa le dipendenze Python necessarie (inclusi OCR e curl_cffi)
RUN pip3 install --no-cache-dir --break-system-packages \
    requests beautifulsoup4 pycryptodome pyDes \
    pillow pytesseract curl_cffi fake-headers lxml

# Installa una versione specifica di pnpm per evitare problemi di compatibilità della piattaforma
RUN npm install -g pnpm@8.15.5

# Copia tutto il codice sorgente dalla directory locale
COPY . .

# Assicura che l'utente node sia proprietario della directory dell'app e del suo contenuto
RUN chown -R node:node /usr/src/app

# Torna all'utente node per le operazioni di pnpm e l'esecuzione dell'app
USER node

# Pulisci eventuali directory preesistenti
RUN rm -rf node_modules .pnpm-store dist 2>/dev/null || true

# Installa le dipendenze del progetto
RUN pnpm install --prod=false

# Fix per il problema undici su ARM/Raspberry Pi
RUN pnpm add undici@6.19.8

# Esegui il build dell'applicazione TypeScript
RUN pnpm run build

# Wrapper: alcune piattaforme avviano forzatamente `node /start`, quindi includiamo script start nella root
USER root
COPY start /start
RUN chown node:node /start
USER node

ENTRYPOINT ["node", "/start"]

# Definisci il comando per avviare l'applicazione
#CMD [ "pnpm", "start" ]
