#!/usr/bin/env python3
"""Script di auto-normalizzazione per AnimeUnity.

Correzioni principali:
 - Heuristica stile AnimeSaturn: se mal_name contiene una chiave esistente di genericMap → inserisci in exactMap, altrimenti genericMap.
 - Rimozione backreference letterale (evita scrittura di \\g<0>).
 - Inserimento sicuro prima del marker mantenendo il commento marker.
 - Idempotenza (nessun duplicato se chiave già presente).
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

"""Heuristica (parità con AnimeSaturn):
Se mal_name contiene (case insensitive) una chiave già in genericMap (diversa da sé) → esegue inserimento in exactMap (titolo più specifico/completo).
Altrimenti va in genericMap.
"""

target_exact = False

# Estrai la sezione generic per ricavare le chiavi esistenti
generic_section_match = re.search(
    r"AUTO-NORMALIZATION-GENERIC-MAP-START[\s\S]*?AUTO-NORMALIZATION-GENERIC-MAP-END",
    content
)
generic_keys: list[str] = []
if generic_section_match:
    sec = generic_section_match.group(0)
    generic_keys = [k[1] for k in re.findall(r"^\s*(['\"])(.+?)\1:\s*", sec, re.MULTILINE)]

lower_mal = mal_name.lower()
for gk in generic_keys:
    if gk and gk != mal_name and gk.lower() in lower_mal:
        target_exact = True
        break

print(
    f"Heuristica: generic_keys={len(generic_keys)} → target={'exactMap' if target_exact else 'genericMap'}"
)

updated = content
replacements = 0

if target_exact:
    updated, replacements = insert_before_marker(updated, r"(\s*)//\s*<<\s*AUTO-INSERT-EXACT\s*>>")
    if replacements == 0:
        print("Marker EXACT non trovato: abort.")
else:
    # Prova marker principale generic
    updated, replacements = insert_before_marker(updated, r"(\s*)//\s*<<\s*AUTO-INSERT-GENERIC\s*>>")
    if replacements == 0:
        print("Marker GENERIC non trovato, provo commento placeholder")
        updated, replacements = insert_before_marker(updated, r"(\s*)//\s*Qui puoi aggiungere altre normalizzazioni custom")
    if replacements == 0:
        print("Placeholder non trovato, provo fine blocco GENERIC")
        # Inserisci prima dell'END (non abbiamo indentazione sicura, usiamo semplice regex)
        end_pattern = re.compile(r"//\s*==== AUTO-NORMALIZATION-GENERIC-MAP-END ====")
        m = end_pattern.search(updated)
        if m:
            updated = updated[:m.start()] + f"{new_line}\n" + updated[m.start():]
            replacements = 1

if replacements == 0:
    print("Error: nessun marker trovato per l'inserimento. Verifica i commenti nel provider.")
    snippet = '\n'.join([line for line in content.splitlines() if 'AUTO-INSERT' in line or 'AUTO-NORMALIZATION' in line])
    print('Snippet markers trovati:\n' + snippet)
    sys.exit(1)

with open(provider_path, "w", encoding="utf-8") as f:
    f.write(updated)

print(f"Successfully added normalization: {new_line.strip()} in {'exactMap' if target_exact else 'genericMap'}")
