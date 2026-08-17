#!/usr/bin/env bash
# check-fonts.sh — prove that an exported PDF really uses the fonts you chose.
#
# A misspelled family name does not fail the build. Typst prints a warning and
# silently falls back to its bundled Libertinus (or, with system fonts enabled,
# to whatever is installed on this machine — which the next machine will not have).
# The PDF looks fine to the compiler and wrong to the reader. This check closes that gap.
#
#   scripts/check-fonts.sh build/report.pdf
#   scripts/check-fonts.sh --expect Faustina,Archivo build/report.pdf build/deck.pdf
#
# Exit 0: every embedded font is expected. Exit 1: a fallback or a stranger got in.

set -uo pipefail

EXPECT=""
usage() { echo "usage: $(basename "$0") [--expect Fam1,Fam2] <file.pdf> [...]" >&2; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --expect) EXPECT="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) break ;;
  esac
done
[ $# -ge 1 ] || usage
command -v pdffonts >/dev/null || { echo "pdffonts missing (brew install poppler)" >&2; exit 2; }

# Typst's built-in fallbacks. Seeing one of these means a family name did not resolve.
FALLBACKS="Libertinus|DejaVu|NewCM|NewComputerModern"

status=0
for pdf in "$@"; do
  [ -s "$pdf" ] || { echo "FAIL $pdf — file missing or empty"; status=1; continue; }
  echo "== $pdf"
  # pdffonts prints a two-line header, then one line per font: "SUBSET+Name  type ..."
  fonts="$(pdffonts "$pdf" | tail -n +3 | awk 'NF {print $1}' | sed 's/^[A-Z]\{6\}+//' | sort -u)"
  if [ -z "$fonts" ]; then
    echo "   no fonts embedded — the page has no text?"
    status=1
    continue
  fi
  while IFS= read -r f; do
    verdict="ok"
    if printf '%s' "$f" | grep -qE "$FALLBACKS"; then
      verdict="FALLBACK — a family name did not resolve"
      status=1
    elif [ -n "$EXPECT" ]; then
      hit=0
      IFS=',' read -ra want <<< "$EXPECT"
      for w in "${want[@]}"; do
        w="$(printf '%s' "$w" | tr -d ' ')"
        [ -n "$w" ] || continue
        printf '%s' "$f" | grep -qi -- "$w" && hit=1
      done
      [ "$hit" -eq 1 ] || { verdict="UNEXPECTED — not in --expect list"; status=1; }
    fi
    printf '   %-42s %s\n' "$f" "$verdict"
  done <<< "$fonts"
  # A font that is not embedded travels badly: the reader's machine substitutes it.
  # pdffonts is column-aligned, and the "type" column contains spaces — so read the
  # "emb" column by its position in the header instead of by field number.
  notembedded="$(pdffonts "$pdf" | awk '
    NR == 1 { col = index($0, "emb"); next }
    NR == 2 { next }
    NF && col && substr($0, col, 2) == "no" { print $1 }
  ')"
  if [ -n "$notembedded" ]; then
    echo "   NOT embedded: $notembedded — the recipient will see a substitute"
    status=1
  fi
done

if [ "$status" -eq 0 ]; then
  echo "OK — only the intended fonts are embedded."
else
  echo "PROBLEM — fix the family name (typst fonts --font-path ./fonts --variants) and re-export."
fi
exit "$status"
