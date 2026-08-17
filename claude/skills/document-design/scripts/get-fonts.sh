#!/usr/bin/env bash
# get-fonts.sh — fetch libre-licensed font files plus their license into a project.
#
# Typst, PPTX and DOCX need real TTF/OTF files. The @fontsource-variable/* packages
# named in most web guides ship WOFF2 only, which Typst cannot read — so we take the
# TTF straight from the google/fonts repository, where the license file lives next to it.
#
#   scripts/get-fonts.sh ofl/faustina ofl/archivo
#   scripts/get-fonts.sh -d beispiel/fonts ofl/faustina
#
# Downloads every .ttf/.otf in the given repository directory (that is the variable
# font for modern families) and the OFL.txt / LICENSE.txt next to it. Idempotent:
# files that already exist are kept.

set -euo pipefail

FONT_DIR="fonts"
RAW="https://raw.githubusercontent.com/google/fonts/main"
API="https://api.github.com/repos/google/fonts/contents"

usage() {
  echo "usage: $(basename "$0") [-d fonts-dir] <repo-path> [<repo-path> ...]" >&2
  echo "  repo-path e.g. ofl/faustina, ofl/archivo, apache/roboto" >&2
  exit 2
}

while getopts ":d:h" opt; do
  case "$opt" in
    d) FONT_DIR="$OPTARG" ;;
    h) usage ;;
    *) usage ;;
  esac
done
shift $((OPTIND - 1))
[ $# -ge 1 ] || usage

mkdir -p "$FONT_DIR"

for path in "$@"; do
  family="$(basename "$path")"
  echo "== $path"
  listing="$(curl -sSL --max-time 60 "$API/$path")"
  files="$(printf '%s' "$listing" | python3 -c '
import json, sys
try:
    items = json.load(sys.stdin)
except Exception:
    sys.exit("could not read directory listing")
if isinstance(items, dict):
    sys.exit(items.get("message", "directory not found"))
for it in items:
    n = it["name"]
    if n.lower().endswith((".ttf", ".otf")) or n in ("OFL.txt", "LICENSE.txt", "UFL.txt"):
        print(n)
')"
  [ -n "$files" ] || { echo "   nothing to download in $path" >&2; exit 1; }

  while IFS= read -r name; do
    case "$name" in
      OFL.txt|LICENSE.txt|UFL.txt) target="$FONT_DIR/${family}-${name}" ;;
      *)                           target="$FONT_DIR/$name" ;;
    esac
    if [ -s "$target" ]; then
      echo "   kept     $(basename "$target")"
      continue
    fi
    # variable-font file names contain [] and commas — percent-encode them
    enc="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$name")"
    curl -sSL --max-time 120 -o "$target" "$RAW/$path/$enc"
    echo "   fetched  $(basename "$target")"
  done <<< "$files"
done

echo
echo "Font files in $FONT_DIR:"
ls -1 "$FONT_DIR"
echo
echo "Next: typst fonts --font-path $FONT_DIR --ignore-system-fonts --variants"
echo "      (the family name Typst reports is the one your document must ask for —"
echo "       families with an optical-size axis are often called e.g. 'Newsreader 16pt')"
