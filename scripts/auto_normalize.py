#!/usr/bin/env python3
"""Auto-normalizzazione AnimeSaturn.

AGGIORNATO: tutte le nuove normalizzazioni vengono ora inserite SEMPRE in exactMap
(ignorata l'heuristica precedente generic vs exact). Manteniamo idempotenza.
Per tornare al comportamento precedente ripristinare la logica heuristic target_exact.
"""

import os, re, json, sys

mal_name = os.environ.get("MAL_NAME")
as_name = os.environ.get("AS_NAME")

if not mal_name or not as_name:
    print("Error: MAL or AnimeSaturn name is empty. Exiting.")
    sys.exit(1)

provider_path = "src/providers/animesaturn-provider.ts"
try:
    with open(provider_path, "r", encoding="utf-8") as f:
        content = f.read()
except FileNotFoundError:
    print("Provider file not found.")
    sys.exit(1)

# Idempotency
existing_pattern = re.compile(rf"['\"]{re.escape(mal_name)}['\"]\s*:")
if existing_pattern.search(content):
    print("Mapping already exists, nothing to do.")
    sys.exit(0)

new_line = f"    {json.dumps(mal_name)}: {json.dumps(as_name)},"

def insert_before_marker(text: str, marker_regex: str) -> tuple[str,int]:
    pattern = re.compile(marker_regex, re.MULTILINE)
    m = pattern.search(text)
    if not m:
        return text, 0
    indent = m.group(1) if m.lastindex else ''
    insertion = f"{indent}{new_line}\n" + text[m.start():m.end()]
    return text[:m.start()] + insertion + text[m.end():], 1

updated = content
replacements = 0
# Inserisci sempre in exactMap
updated, replacements = insert_before_marker(updated, r"(\s*)//\s*<<\s*AUTO-INSERT-EXACT\s*>>")
if replacements == 0:
    print("Marker EXACT non trovato: abort")

if replacements == 0:
    print("Error: nessun marker trovato per l'inserimento.")
    snippet = '\n'.join([line for line in content.splitlines() if 'AUTO-INSERT' in line or 'AUTO-NORMALIZATION' in line])
    print('Snippet markers trovati:\n' + snippet)
    sys.exit(1)

with open(provider_path, "w", encoding="utf-8") as f:
    f.write(updated)

print(f"Successfully added normalization: {new_line.strip()} in exactMap (forced mode)")
