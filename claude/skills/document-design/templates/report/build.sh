#!/usr/bin/env bash
# build.sh — compile, rasterize, and check. One command, because a step that needs
# three commands gets skipped when the deadline is close.
#
#   ./build.sh              # builds report.typ
#   ./build.sh angebot.typ  # builds another entry file in this folder
#
# Produces: build/<name>.pdf (deliverable), build/pages/page-N.png (what you must LOOK at),
# build/<name>.txt (reading order and structure, for checking what a screen reader gets).

set -euo pipefail
cd "$(dirname "$0")"

SRC="${1:-report.typ}"
NAME="$(basename "$SRC" .typ)"
OUT="build"
PPI="${PPI:-150}"

SCRIPTS=""
for c in ./scripts ../scripts ../../scripts; do
  [ -x "$c/check-fonts.sh" ] && SCRIPTS="$c" && break
done

mkdir -p "$OUT/pages"
rm -f "$OUT/pages/"*.png

typst compile --font-path fonts --ignore-system-fonts "$SRC" "$OUT/$NAME.pdf"
typst compile --font-path fonts --ignore-system-fonts "$SRC" "$OUT/pages/page-{0p}.png" -f png --ppi "$PPI"
pdftotext -layout "$OUT/$NAME.pdf" "$OUT/$NAME.txt"

echo
if [ -n "$SCRIPTS" ]; then
  "$SCRIPTS/check-fonts.sh" "$OUT/$NAME.pdf" || true
else
  echo "check-fonts.sh not found next to this template — check the embedded fonts by hand:"
  echo "  pdffonts $OUT/$NAME.pdf"
fi

echo
echo "Pages rendered: $(ls -1 "$OUT/pages" | wc -l | tr -d ' ')"
echo "NOW LOOK AT THEM. Reading each PNG is the review step, not an optional extra:"
echo "  $OUT/pages/page-01.png …"
echo
# Prefer the wrapper on PATH; fall back to a sibling checkout's venv. A hardcoded
# absolute path was wrong on every machine but one — and this template ships.
DR="$(command -v docrender || true)"
[ -n "$DR" ] || for cand in \
      "../../../doc-render-review/.venv/bin/docrender" \
      "$HOME/AI/design-tools/doc-render-review/.venv/bin/docrender"; do
  [ -x "$cand" ] && { DR="$cand"; break; }
done
DR="${DR:-docrender}"
if [ -x "$DR" ]; then
  echo "Mechanical review (margins, fallback fonts, contrast, sizes, orphan headings):"
  echo "  $DR review $OUT/$NAME.pdf --json-out $OUT/review.json --text-out $OUT/review.txt"
  echo "  exit 0 = nothing found, 1 = findings to judge, 2 = the tool itself failed."
else
  echo "docrender not found at $DR — do the mechanical checks by hand:"
  echo "  see 'Running the catalogue' in reference/antipatterns.md"
fi
