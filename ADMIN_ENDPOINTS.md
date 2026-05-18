# Admin Endpoints — Diagnostica CPU / Memoria

Endpoint aggiunti dalle PR **#711** (`/admin/cpu-stats`) e **#712**
(`/admin/cpu-profile/*`, `/admin/heap-snapshot`).

Servono a diagnosticare problemi di CPU/memoria su un'istanza **in produzione**,
senza riavviare il container.

---

## Configurazione

### Variabile d'ambiente

| Env | Obbligatoria? | Effetto |
|---|---|---|
| `ADMIN_TOKEN` | Opzionale per `/admin/cpu-stats` (GET) — **obbligatoria** per tutto il resto | Token segreto richiesto per autenticare le chiamate |

Esempio (docker-compose):

```yaml
services:
  streamvix:
    environment:
      - ADMIN_TOKEN=cambia-questo-con-una-stringa-random-lunga
```

> ⚠️ Se non setti `ADMIN_TOKEN`:
> - `/admin/cpu-stats` (lettura) resta accessibile a chiunque raggiunga il
>   container.
> - `/admin/cpu-stats/reset`, `/admin/cpu-profile/*` e `/admin/heap-snapshot`
>   rispondono **403** (`ADMIN_TOKEN not configured on this pod`).

### Autenticazione

Tutte le chiamate autenticate accettano il token in due modi:

- **Query string:** `?token=<ADMIN_TOKEN>`
- **Header HTTP:** `X-Admin-Token: <ADMIN_TOKEN>`

(Non è Bearer/Authorization — è `X-Admin-Token`.)

---

## #711 — `/admin/cpu-stats`

Contatori in-process leggeri. Lettura veloce, **non** impatta il server.

### `GET /admin/cpu-stats`

Ritorna JSON con metriche correnti. Auth opzionale (vedi sopra).

```bash
# Senza ADMIN_TOKEN
curl http://localhost:7860/admin/cpu-stats

# Con ADMIN_TOKEN
curl "http://localhost:7860/admin/cpu-stats?token=$ADMIN_TOKEN"
# oppure
curl -H "X-Admin-Token: $ADMIN_TOKEN" http://localhost:7860/admin/cpu-stats
```

**Risposta (esempio):**

```json
{
  "ok": true,
  "uptimeMs": 3600000,
  "uptimeHumanS": 3600,
  "memory": {
    "rssMb": 412.3,
    "heapUsedMb": 187.4,
    "heapTotalMb": 240.0,
    "externalMb": 18.2,
    "arrayBuffersMb": 4.1
  },
  "catalog": {
    "requests": 1523,
    "cacheKey": "static:abc123|mtime:1715900000000",
    "cacheBuiltAgeMs": 45000,
    "cacheSize": 812
  },
  "meta": {
    "requests": 980,
    "cacheHits": 740,
    "cacheHitRate": 0.755
  },
  "stream": {
    "requests": 654
  },
  "epg": {
    "findCalls": 12450,
    "hits": 11200,
    "misses": 1250,
    "avgUs": 18.4,
    "totalMs": 229.1
  }
}
```

**Cosa guardare:**
- `memory.rssMb` cresce nel tempo → possibile memory leak (usa l'heap-snapshot).
- `meta.cacheHitRate` basso → cache meta inefficace o TTL troppo corto.
- `epg.avgUs` alto (>100µs) → ricerca EPG lenta.
- `catalog.cacheBuiltAgeMs` molto basso e che si azzera spesso → `dynamic_channels.json` viene riscritto in continuazione.

### `GET /admin/cpu-stats/reset`

Azzera i contatori (per fare misure pulite). Auth **obbligatoria**.

```bash
curl "http://localhost:7860/admin/cpu-stats/reset?token=$ADMIN_TOKEN"
```

---

## #712 — `/admin/cpu-profile/*` e `/admin/heap-snapshot`

Strumenti pesanti per debug avanzato. **Sempre auth obbligatoria.**

> ⚠️ Multi-replica: lo stato del profiler vive in RAM del singolo
> container. Start e stop devono colpire **lo stesso pod**. In
> Kubernetes usa `sessionAffinity: ClientIP` o riduci a 1 replica
> mentre profili.

### `GET /admin/cpu-profile/start?durationMs=N`

Avvia un profilo CPU V8. Parametro `durationMs` opzionale (default
**30000** = 30s, min 1s, max 600000 = 10min). Auto-stop di sicurezza
scatta dopo `durationMs + 60s` se ti dimentichi di chiamare `/stop`.

```bash
# Avvia profilo da 30 secondi
curl "http://localhost:7860/admin/cpu-profile/start?durationMs=30000&token=$ADMIN_TOKEN"
```

Risposta:
```json
{ "ok": true, "startedAt": 1715900000000, "autoStopAfterMs": 90000 }
```

Se un profilo è già in corso ritorna **409**.

### `GET /admin/cpu-profile/stop`

Ferma il profilo e **scarica il file `.cpuprofile`**.

```bash
curl -o profilo.cpuprofile \
  "http://localhost:7860/admin/cpu-profile/stop?token=$ADMIN_TOKEN"
```

**Come analizzarlo:**
1. Apri Chrome / Edge.
2. F12 → tab **Performance** (o **JavaScript Profiler**).
3. Click destro nel pannello → **Load profile…** → seleziona `profilo.cpuprofile`.
4. Cerca le funzioni con più "self time" (le ammazza-CPU).

### `GET /admin/heap-snapshot`

Dump della heap V8 per cercare memory leak.

> ⚠️ **Bloccante** (blocca l'event loop per qualche secondo) e richiede
> ~2.5× la heap corrente come RAM libera. Se non c'è abbastanza headroom
> l'endpoint **rifiuta** con 409 per evitare OOMKill.

```bash
curl "http://localhost:7860/admin/heap-snapshot?token=$ADMIN_TOKEN"
```

Risposta:
```json
{ "ok": true, "path": "/tmp/streamvix-1715900000000.heapsnapshot", "sizeMb": 245.3 }
```

Il file viene scritto **dentro il container in `/tmp/`** — **non** viene
restituito via HTTP (sarebbe troppo grosso). Va copiato fuori:

```bash
# Docker
docker cp streamvix:/tmp/streamvix-1715900000000.heapsnapshot ./heap.heapsnapshot

# Kubernetes
kubectl cp <namespace>/<pod>:/tmp/streamvix-1715900000000.heapsnapshot ./heap.heapsnapshot
```

Se serve forzare lo snapshot anche con poca RAM libera (rischio OOMKill):

```bash
curl "http://localhost:7860/admin/heap-snapshot?force=1&token=$ADMIN_TOKEN"
```

**Come analizzarlo:**
1. Chrome → F12 → tab **Memory**.
2. Pulsante **Load** → seleziona `heap.heapsnapshot`.
3. Ordina per **Retained Size** → trova gli oggetti che trattengono più RAM.

---

## Workflow tipico di debug

**"Il container consuma troppa CPU"**
```bash
# 1) snapshot iniziale
curl "http://localhost:7860/admin/cpu-stats?token=$T" | jq

# 2) profila 60s mentre arrivano richieste reali
curl "http://localhost:7860/admin/cpu-profile/start?durationMs=60000&token=$T"
sleep 65
curl -o cpu.cpuprofile "http://localhost:7860/admin/cpu-profile/stop?token=$T"

# 3) apri cpu.cpuprofile in Chrome DevTools → Performance
```

**"Il container cresce di RAM senza fermarsi"**
```bash
# 1) verifica trend rss
watch -n 10 'curl -s "http://localhost:7860/admin/cpu-stats?token=$T" | jq .memory'

# 2) snapshot heap quando rss è alta
curl "http://localhost:7860/admin/heap-snapshot?token=$T"

# 3) copia fuori dal container e apri in Chrome DevTools → Memory
```

---

## Sicurezza

- Non esporre questi endpoint a internet pubblico senza `ADMIN_TOKEN`.
- Usa un token lungo e random (`openssl rand -hex 32`).
- I profili e gli snapshot possono contenere **dati sensibili** (URL con
  token MFP/VixSrc, configurazioni utente in memoria, ecc.). Trattali
  come segreti e cancellali dopo l'analisi.
- `heap-snapshot` lascia il file su `/tmp/` del container: ricordati di
  pulirlo (`rm /tmp/streamvix-*.heapsnapshot`) dopo aver copiato fuori.
