#!/usr/bin/env bash
# Rasterise the hand-drawn SVG layers into the PNGs the parallax driver loads.
# No model, no download: rsvg-convert only.
set -euo pipefail
cd "$(dirname "$0")/../assets/layers"

for f in src/*.svg; do
  out="$(basename "${f%.svg}").png"
  rsvg-convert -w 2560 -h 1440 -o "$out" "$f"
  printf 'png %-28s %s\n' "$out" "$(du -h "$out" | cut -f1)"
done

# The product still lives next to the clips, not in the layer set.
mv -f produkt-still.png ../produkt-still.png
echo "png ../produkt-still.png"
