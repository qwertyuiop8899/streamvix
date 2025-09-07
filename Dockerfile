# Scegli un'immagine Node.js di base
FROM node:20-slim

ARG CACHE_BUST=233
RUN echo "Cache bust: $CACHE_BUST"

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

# Copia requirements.txt prima per sfruttare la cache Docker
COPY requirements.txt .

# Installa dipendenze Python da requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt

# Verifica installazione
RUN python3 -c "import asyncio, difflib, unicodedata, html; print('Standard library OK')" && \
    python3 -c "import curl_cffi, fake_headers, pytesseract, requests, bs4; print('External dependencies OK')" && \
    tesseract --version

# Copia il resto del codice sorgente
COPY . .

# Installa una versione specifica di pnpm
RUN npm install -g pnpm@8.15.5

# Assicura che l'utente node sia proprietario della directory dell'app
RUN chown -R node:node /usr/src/app

# Torna all'utente node per le operazioni di pnpm
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

# Wrapper
COPY start /start
RUN chown node:node /start
USER node

ENTRYPOINT ["node", "/start"]
