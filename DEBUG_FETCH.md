# Debug Fetch Endpoint

Endpoint diagnostico per testare connettività e risposte HTTP dal server StreamViX (utile per verificare bypass Cloudflare, cookie challenge, IP ban, ecc.).

> ⚠️ Richiede la env `DEBUG_PROXY_TOKEN` impostata sul server. Se non è impostata, l'endpoint risponde **404**. Se il token non corrisponde, risponde **401**.

## Route

```
GET  /debug/fetch
POST /debug/fetch
```

Implementazione: [src/addon.ts](src/addon.ts#L8115-L8265)

## Query parameters

| Param        | Tipo    | Default | Descrizione                                                                 |
|--------------|---------|---------|-----------------------------------------------------------------------------|
| `token`      | string  | —       | **Obbligatorio**. Deve coincidere con `DEBUG_PROXY_TOKEN`. URL-encode i caratteri speciali (es. `?` → `%3F`). |
| `url`        | string  | —       | **Obbligatorio**. URL upstream da contattare.                               |
| `method`     | string  | `GET`   | Metodo HTTP (`GET`, `POST`, ecc.).                                          |
| `raw`        | `0`/`1` | `0`     | Se `1`, risponde con il body raw + header `X-Debug-Upstream-Status` / `X-Debug-Elapsed-Ms`. Altrimenti JSON. |
| `redirect`   | `0`/`1` | `1`     | Se `0`, non segue i redirect.                                               |
| `timeout`    | number  | `10000` | Timeout in ms.                                                              |
| `viaProxy`   | `0`/`1` | `0`     | Se `1`, instrada via proxy upstream (se configurato).                       |
| `h_<name>`   | string  | —       | Aggiunge un header alla richiesta upstream. Es. `h_user-agent=Mozilla/5.0`. |
| `headers`    | JSON    | —       | Alternativa a `h_*`: oggetto JSON con headers.                              |

Per `POST`, il body è quello della richiesta (handled by `express.raw`).

## Risposta

### `raw=1`
- Body upstream as-is (bytes).
- Header `X-Debug-Upstream-Status`: status code upstream.
- Header `X-Debug-Elapsed-Ms`: tempo totale.

### `raw=0` (JSON)
```json
{
  "status": 200,
  "elapsedMs": 234,
  "headers": { "...": "..." },
  "body": "..."
}
```

## Esempi (senza token — sostituisci `TOKEN`)

Sostituisci `TOKEN` con il valore URL-encoded della tua `DEBUG_PROXY_TOKEN`.

### 1. Test base GET (raw)
```bash
curl -sS "https://streamvix.hayd.uk/debug/fetch?token=TOKEN&url=https://www.animeworld.ac/play/dr-stone-future-arc.6yPF_&raw=1"
```

### 2. Test SecurityAW2 challenge (AnimeWorld)
Prima fetch — restituisce lo stub HTTP 202 con il cookie:
```bash
curl -sS -D - "https://streamvix.hayd.uk/debug/fetch?token=TOKEN&url=https://www.animeworld.ac/play/dr-stone-future-arc.6yPF_&raw=1&redirect=0" -o /tmp/aw_stub.html
```

Replay con cookie + `?d=1`:
```bash
curl -sS "https://streamvix.hayd.uk/debug/fetch?token=TOKEN&url=https://www.animeworld.ac/play/dr-stone-future-arc.6yPF_?d=1&raw=1&h_cookie=SecurityAW2-os=<HASH>" -o /tmp/aw_real.html
```

### 3. Header custom + JSON response
```bash
curl -sS "https://streamvix.hayd.uk/debug/fetch?token=TOKEN&url=https://httpbin.org/headers&h_x-test=hello&h_user-agent=StreamVixDebug/1.0" | python3 -m json.tool
```

### 4. POST con body
```bash
curl -sS -X POST \
  -H 'Content-Type: application/json' \
  --data '{"hello":"world"}' \
  "https://streamvix.hayd.uk/debug/fetch?token=TOKEN&url=https://httpbin.org/post&method=POST&raw=1"
```

### 5. Forza via proxy upstream
```bash
curl -sS "https://streamvix.hayd.uk/debug/fetch?token=TOKEN&url=https://ifconfig.me/ip&viaProxy=1&raw=1"
```

### 6. No-redirect (vede 301/302 direttamente)
```bash
curl -sS -D - "https://streamvix.hayd.uk/debug/fetch?token=TOKEN&url=https://animeworld.ac/&redirect=0&raw=1"
```

### 7. Timeout esteso
```bash
curl -sS "https://streamvix.hayd.uk/debug/fetch?token=TOKEN&url=https://slow.example.com/&timeout=30000&raw=1"
```

### 8. Headers via JSON
```bash
HEADERS=$(python3 -c 'import json,urllib.parse;print(urllib.parse.quote(json.dumps({"user-agent":"Mozilla/5.0","accept-language":"it-IT"})))')
curl -sS "https://streamvix.hayd.uk/debug/fetch?token=TOKEN&url=https://httpbin.org/headers&headers=${HEADERS}" | python3 -m json.tool
```

## Note di sicurezza

- L'endpoint è un **open proxy autenticato**: chiunque conosca il token può proxare richieste arbitrarie dal tuo server. Usa token lunghi e ruotali periodicamente.
- Non logga il token, ma logga gli URL contattati: occhio se condividi i log.
- Disabilita l'endpoint in produzione lasciando `DEBUG_PROXY_TOKEN` vuoto.
