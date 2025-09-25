#!/usr/bin/env python3
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

# Idempotency: skip if already present (either exact or generic)
existing_pattern = re.compile(rf"['\"]{re.escape(mal_name)}['\"]\s*:")
if existing_pattern.search(content):
    print("Mapping already exists, nothing to do.")
    sys.exit(0)

# Decide target map: if mal_name contains any existing generic key -> exactMap
generic_section = re.search(r"AUTO-NORMALIZATION-GENERIC-MAP-START[\s\S]*?AUTO-INSERT-GENERIC[\s\S]*?AUTO-NORMALIZATION-GENERIC-MAP-END", content)

target_is_exact = False
if generic_section:
    keys = re.findall(r"^\s*(['\"])(.+?)\1:\s*", generic_section.group(0), re.MULTILINE)
    generic_keys = [k[1] for k in keys]
    lower_mal = mal_name.lower()
    for gk in generic_keys:
        if gk and gk != mal_name and gk.lower() in lower_mal:
            target_is_exact = True
            break

new_line = f"    {json.dumps(mal_name)}: {json.dumps(as_name)},"

if target_is_exact:
    print("Inserisco in exactMap (match con generic key)")
    pattern_exact = re.compile(r"(\s*)// << AUTO-INSERT-EXACT >>")
    new_content, num_replacements = pattern_exact.subn(rf"{new_line}\n\g<0>", content, 1)
else:
    print("Inserisco in generic map")
    pattern_generic = re.compile(r"(\s*)// << AUTO-INSERT-GENERIC >>")
    new_content, num_replacements = pattern_generic.subn(rf"{new_line}\n\g<0>", content, 1)

if num_replacements == 0:
    print("Error: insertion marker not found")
    sys.exit(1)

with open(provider_path, "w", encoding="utf-8") as f:
    f.write(new_content)

print(f"Successfully added normalization: {new_line.strip()}")
