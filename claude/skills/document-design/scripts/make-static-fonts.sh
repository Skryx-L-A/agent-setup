#!/usr/bin/env bash
# make-static-fonts.sh — turn a variable font into static Regular/Bold instances.
#
# Typst reads one variable file and interpolates any weight (verified, fonts.md).
# Office does not: PPTX/DOCX font embedding and Windows/macOS font rendering expect
# one FILE per style, and embedding a single variable TTF gives Word/PowerPoint only
# whatever default instance sits at wght=400 — bold text silently renders as
# synthesised (smeared) bold instead of the drawn bold, because there is no second
# file to embed as embedBold. Confirmed empirically while building the office
# templates: `fonttools varLib.instancer` produces a static file per weight with the
# correct OS/2.fsSelection / head.macStyle bold bits set, which Office needs to tell
# the embedded regular and bold apart.
#
#   scripts/make-static-fonts.sh fonts/Archivo[wdth,wght].ttf fonts/static
#   scripts/make-static-fonts.sh fonts/Faustina[wght].ttf fonts/static --weights 400,600,700
#
# Requires the venv at ../.venv-office (python-docx/python-pptx/fonttools) or any
# Python with `fonttools` installed.

set -euo pipefail

usage() {
  echo "usage: $(basename "$0") <variable-font.ttf> <out-dir> [--weights 400,700]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
SRC="$1"; OUT="$2"; shift 2
WEIGHTS="400,700"
while [ $# -gt 0 ]; do
  case "$1" in
    --weights) WEIGHTS="$2"; shift 2 ;;
    *) usage ;;
  esac
done

FT="$(dirname "$0")/../.venv-office/bin/fonttools"
[ -x "$FT" ] || FT="$(command -v fonttools || true)"
[ -n "$FT" ] || { echo "fonttools not found — pip install fonttools, or use .venv-office" >&2; exit 2; }

[ -f "$SRC" ] || { echo "no such font file: $SRC" >&2; exit 2; }
mkdir -p "$OUT"

BASE="$(basename "$SRC")"
BASE="${BASE%%\[*}"   # "Archivo[wdth,wght].ttf" -> "Archivo"
BASE="${BASE%.ttf}"

PYRUN="$(dirname "$FT")/python3"; [ -x "$PYRUN" ] || PYRUN="$(dirname "$FT")/python"

IFS=',' read -ra W <<< "$WEIGHTS"
for weight in "${W[@]}"; do
  label="Regular"; [ "$weight" -ge 600 ] && label="Bold"
  target="$OUT/${BASE}-${label}.ttf"
  if [ -s "$target" ]; then
    echo "kept     $(basename "$target")"
    continue
  fi
  # Pin EVERY axis, not only wght — a font with e.g. width left variable still
  # carries an fvar table and is not the single-master static file Office wants.
  "$PYRUN" - "$SRC" "$target" "$weight" <<'PY'
import sys
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

src, target, weight = sys.argv[1], sys.argv[2], float(sys.argv[3])
font = TTFont(src)
axes = {a.axisTag: a.defaultValue for a in font["fvar"].axes}
axes["wght"] = weight
instantiateVariableFont(font, axes, inplace=True, updateFontNames=True)
font.save(target)
PY
  echo "instanced $(basename "$target")  (wght=$weight, every other axis pinned to default)"
done

echo
echo "Static instances in $OUT:"
ls -1 "$OUT"
echo
echo "Check the bold bit landed (fsSelection bit 5, macStyle bit 0):"
echo "  python3 -c \"from fontTools.ttLib import TTFont as T; f=T('$OUT/${BASE}-Bold.ttf'); print(bin(f['OS/2'].fsSelection), bin(f['head'].macStyle))\""
