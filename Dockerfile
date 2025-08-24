# Scegli un'immagine Node.js di base
FROM node:20-slim

ARG CACHE_BUST=233
RUN echo "Cache bust: $CACHE_BUST"

# Installa git, python3, pip e dipendenze per compilazione
USER root 
RUN apt-get update && apt-get install -y git python3 python3-pip python3-dev build-essential ca-certificates --no-install-recommends && rm -rf /var/lib/apt/lists/*
# Imposta la directory di lavoro nell'immagine
WORKDIR /usr/src/app


# Clona il repository Git
# Sostituisci con l'URL del tuo repository e opzionalmente un branch o tag

ARG GIT_REPO_URL="https://github.com/qwertyuiop8899/streamvix.git"
ARG GIT_BRANCH="main"

ARG CACHE_BUST2=233
RUN echo "Cache bust: $CACHE_BUST"

# Forza git a non usare cache aggiungendo timestamp
RUN rm -rf ./* ./.* 2>/dev/null || true && \
    echo "Cloning fresh at $(date +%s)" && \
    git -c http.sslVerify=false clone --branch ${GIT_BRANCH} --depth 1 --no-single-branch ${GIT_REPO_URL} . && \
    echo "Clone completed at $(date +%s)"
#RUN git -c http.sslVerify=false clone --branch ${GIT_BRANCH} --depth 1 ${GIT_REPO_URL} .
# Il "." alla fine clona il contenuto della repo direttamente in /usr/src/app



# Installa le dipendenze Python necessarie per TVTap, filtrando quelle problematiche
RUN pip3 install --no-cache-dir --break-system-packages requests beautifulsoup4 pycryptodome pyDes

# Installa una versione specifica di pnpm per evitare problemi di compatibilità della piattaforma
RUN npm install -g pnpm@8.15.5

# Se il package.json non è alla root del repo clonato, dovrai aggiustare i percorsi
# Ad esempio, se è in una sottocartella "my-app":
# WORKDIR /usr/src/app/my-app

# Copia package.json e pnpm-lock.yaml (questo passaggio potrebbe non essere più necessario se sono nel repo)
# Se sono già presenti dopo il git clone, puoi ometterlo o assicurarti che i percorsi siano corretti.
# COPY package.json pnpm-lock.yaml ./ 

# Assicura che l'utente node sia proprietario della directory dell'app e del suo contenuto
RUN chown -R node:node /usr/src/app
# Torna all'utente node per le operazioni di pnpm e l'esecuzione dell'app
USER node
# Modifica temporanea: rimuovi --frozen-lockfile per permettere l'aggiornamento del lockfile
ARG BUILD_CACHE_BUST=233
RUN echo "Build cache bust: $BUILD_CACHE_BUST"

RUN rm -rf node_modules .pnpm-store dist 2>/dev/null || true
# se package.json è stato modificato nel repo ma il lockfile no.
RUN pnpm install --prod=false
# Copia il resto del codice sorgente (questo non è più necessario se tutto viene da git clone)
# COPY . . 
# Fix per il problema undici su ARM/Raspberry Pi
RUN pnpm add undici@6.19.8
# Esegui il build dell'applicazione TypeScript
RUN pnpm run build

# Rimuovi le devDependencies dopo il build se vuoi ridurre la dimensione dell'immagine
# RUN pnpm prune --prod

## RIMOZIONE symlink precedente: ora usiamo wrapper /start.js direttamente

# Esponi la porta su cui l'applicazione ascolterà (Hugging Face la mapperà)
# Avvia l'addon StreamViX
# Wrapper: alcune piattaforme avviano forzatamente `node /start`, quindi includiamo script start nella root
USER root
COPY start /start
RUN chown node:node /start
USER node
ENTRYPOINT ["node", "/start"]
# Non è strettamente necessario EXPOSE qui perché HF assegna la porta tramite env var
# EXPOSE 3000 

# Definisci il comando per avviare l'applicazione
#CMD [ "pnpm", "start" ]




























