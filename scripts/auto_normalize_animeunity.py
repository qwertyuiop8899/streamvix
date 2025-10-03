#!/usr/bin/env python3
"""Script di auto-normalizzazione per AnimeUnity.

AGGIORNATO: tutte le nuove normalizzazioni vengono SEMPRE inserite in exactMap
ignorando la precedente heuristica generic vs exact. Idempotenza mantenuta.
Per ripristinare l'heuristica reintrodurre il blocco di calcolo target_exact.
"""

import os, re, json, sys

mal_name = os.environ.get("MAL_NAME")
au_name = os.environ.get("AU_NAME")

if not mal_name or not au_name:
    print("Error: MAL or AnimeUnity name is empty. Exiting.")
    sys.exit(1)

provider_path = "src/providers/animeunity-provider.ts"
try:
    with open(provider_path, "r", encoding="utf-8") as f:
        content = f.read()
except FileNotFoundError:
    print("Provider file not found.")
    sys.exit(1)

# Idempotenza: se la chiave esiste già (exact o generic) non fare nulla
existing_pattern = re.compile(rf"['\"]{re.escape(mal_name)}['\"]\s*:")
if existing_pattern.search(content):
    print("Mapping already exists, nothing to do.")
    sys.exit(0)

new_line = f"    {json.dumps(mal_name)}: {json.dumps(au_name)},"

def insert_before_marker(text: str, marker_regex: str) -> tuple[str,int]:
    pattern = re.compile(marker_regex, re.MULTILINE)
    m = pattern.search(text)
    if not m:
        return text, 0
    # Mantieni l'indentazione del marker se presente nel gruppo 1
    indent = m.group(1) if m.lastindex else ''
    insertion = f"{indent}{new_line}\n" + text[m.start():m.end()]
    return text[:m.start()] + insertion + text[m.end():], 1

updated = content
replacements = 0
# Inserimento forzato sempre in exactMap
updated, replacements = insert_before_marker(updated, r"(\s*)//\s*<<\s*AUTO-INSERT-EXACT\s*>>")
if replacements == 0:
    print("Marker EXACT non trovato: abort.")

if replacements == 0:
    print("Error: nessun marker trovato per l'inserimento. Verifica i commenti nel provider.")
    snippet = '\n'.join([line for line in content.splitlines() if 'AUTO-INSERT' in line or 'AUTO-NORMALIZATION' in line])
    print('Snippet markers trovati:\n' + snippet)
    sys.exit(1)

with open(provider_path, "w", encoding="utf-8") as f:
    f.write(updated)

print(f"Successfully added normalization: {new_line.strip()} in exactMap (forced mode)")
