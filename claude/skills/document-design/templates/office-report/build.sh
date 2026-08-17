#!/usr/bin/env bash
# build.sh — generate the .docx, render it through LibreOffice, and check it.
#
#   ./build.sh              # builds report.py -> build/report.docx
#
# Produces: build/report.docx (deliverable), build/pages/page-N.png (what you must
# LOOK at), build/report.pdf (what LibreOffice/docrender see when they check it).

set -euo pipefail
cd "$(dirname "$0")"

OUT="build"
PPI="${PPI:-150}"

PY="${OFFICE_PY:-}"
if [ -z "$PY" ]; then
  for candidate in ../../.venv-office/bin/python3 ../.venv-office/bin/python3 .venv-office/bin/python3 "$(command -v python3)"; do
    [ -x "$candidate" ] && "$candidate" -c "import docx, pptx" >/dev/null 2>&1 && PY="$candidate" && break
  done
fi
if [ -z "$PY" ]; then
  echo "No Python with python-docx/python-pptx found." >&2
  echo "Either: pip install python-docx python-pptx fonttools" >&2
  echo "Or set OFFICE_PY=/path/to/python3 (e.g. the project's .venv-office)." >&2
  exit 2
fi

mkdir -p "$OUT/pages"
rm -f "$OUT/pages/"*.png

"$PY" report.py
soffice --headless --convert-to pdf --outdir "$OUT" "$OUT/report.docx" >/dev/null
pdftoppm -png -r "$PPI" "$OUT/report.pdf" "$OUT/pages/page"
pdftotext -layout "$OUT/report.pdf" "$OUT/report.txt"

echo
echo "Pages rendered: $(ls -1 "$OUT/pages" | wc -l | tr -d ' ')"
echo "NOW LOOK AT THEM. Reading each PNG is the review step, not an optional extra:"
echo "  $OUT/pages/page-1.png …"
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
  echo "  $DR review $OUT/report.docx --expected-fonts \"<your family>\" --json-out $OUT/review.json"
  echo "  exit 0 = nothing found, 1 = findings to judge, 2 = the tool itself failed."
else
  echo "docrender not found at $DR — check by hand: pdffonts, margins, page count."
fi
