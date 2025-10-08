#!/usr/bin/env python3
"""Script di auto-normalizzazione per AnimeWorld.

Inserisce nuove coppie MAL -> AnimeWorld all'interno di exactMap
nel provider TypeScript, mantenendo idempotenza come per AnimeUnity.
"""

import os
import re
import json
import sys

mal_name = os.environ.get("MAL_NAME")
aw_name = os.environ.get("AW_NAME")

if not mal_name or not aw_name:
    print("Error: MAL or AnimeWorld name is empty. Exiting.")
    sys.exit(1)

provider_path = "src/providers/animeworld-provider.ts"
try:
    with open(provider_path, "r", encoding="utf-8") as f:
        content = f.read()
except FileNotFoundError:
    print("Provider file not found.")
    sys.exit(1)

# Idempotenza: se la chiave esiste già non fare nulla
existing_pattern = re.compile(rf"['\"]{re.escape(mal_name)}['\"]\s*:")
if existing_pattern.search(content):
    print("Mapping already exists, nothing to do.")
    sys.exit(0)

new_line = f"    {json.dumps(mal_name)}: {json.dumps(aw_name)},"


def insert_before_marker(text: str, marker_regex: str) -> tuple[str, int]:
    pattern = re.compile(marker_regex, re.MULTILINE)
    match = pattern.search(text)
    if not match:
        return text, 0
    indent = match.group(1) if match.lastindex else ""
    insertion = f"{indent}{new_line}\n" + text[match.start():match.end()]
    return text[:match.start()] + insertion + text[match.end():], 1


updated = content
replacements = 0
updated, replacements = insert_before_marker(updated, r"(\s*)//\s*<<\s*AUTO-INSERT-EXACT\s*>>")
if replacements == 0:
    print("Marker EXACT non trovato: abort.")

if replacements == 0:
    print("Error: nessun marker trovato per l'inserimento. Verifica i commenti nel provider.")
    snippet = '\n'.join(
        [line for line in content.splitlines() if 'AUTO-INSERT' in line or 'AUTO-NORMALIZATION' in line]
    )
    print('Snippet markers trovati:\n' + snippet)
    sys.exit(1)

with open(provider_path, "w", encoding="utf-8") as f:
    f.write(updated)

print(f"Successfully added normalization: {new_line.strip()} in exactMap (AnimeWorld)")
