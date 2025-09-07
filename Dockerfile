# Scegli un'immagine Node.js di base
FROM node:20-slim

ARG CACHE_BUST=233
RUN echo "Cache bust: $CACHE_BUST"

# Installa git, python3, pip e dipendenze per compilazione
USER root 
RUN apt-get update && apt-get install -y \
    git \
    python3 python3-pip python3-dev python3-venv \
    build-essential ca-certificates \
    tesseract-ocr tesseract-ocr-ita tesseract-ocr-eng \
    curl wget \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Imposta la directory di lavoro nell'immagine
WORKDIR /usr/src/app

# Copia il codice sorgente dell'applicazione nella directory di lavoro
COPY . .

# Installa le dipendenze Python necessarie (inclusi OCR e curl_cffi)
RUN pip3 install --no-cache-dir --break-system-packages \
    requests beautifulsoup4 pycryptodome pyDes \
    pillow pytesseract curl_cffi fake-headers lxml \
    asyncio-compat unicodedata2

# Verifica installazione Python e dipendenze
RUN python3 --version && \
    python3 -c "import curl_cffi, fake_headers, pytesseract, difflib, unicodedata, html; print('All Python dependencies OK')" && \
    tesseract --version

# Installa una versione specifica di pnpm per evitare problemi di compatibilità della piattaforma
RUN npm install -g pnpm@8.15.5

# Assicura che l'utente node sia proprietario della directory dell'app e del suo contenuto
RUN chown -R node:node /usr/src/app

# Rendi eseguibili gli script Python
RUN chmod +x /usr/src/app/dist/providers/eurostreaming.py 2>/dev/null || true

# Torna all'utente node per le operazioni di pnpm e l'esecuzione dell'app
USER node

ARG BUILD_CACHE_BUST=233
RUN echo "Build cache bust: $BUILD_CACHE_BUST"

RUN rm -rf node_modules .pnpm-store dist 2>/dev/null || true
RUN pnpm install --prod=false

# Fix per il problema undici su ARM/Raspberry Pi
RUN pnpm add undici@6.19.8

# Esegui il build dell'applicazione TypeScript
RUN pnpm run build

# Rendi eseguibile il file eurostreaming.py dopo il build
USER root
RUN chmod +x /usr/src/app/dist/providers/eurostreaming.py 2>/dev/null || true
RUN chown node:node /usr/src/app/dist/providers/eurostreaming.py 2>/dev/null || true

# Wrapper: alcune piattaforme avviano forzatamente `node /start`
COPY start /start
RUN chown node:node /start
USER node

ENTRYPOINT ["node", "/start"]