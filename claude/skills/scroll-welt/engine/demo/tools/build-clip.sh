#!/usr/bin/env bash
# Build the demo's placeholder connector clip.
#
# The point of this file is the SEAM, not the footage: frame 0 of the clip is
# byte-for-composition the frame the 'hof' scene ends on (exportFrame(t=1)), and
# the last frame is the frame the 'werkstatt' scene starts on (exportFrame(t=0)).
# In a real build those two stills would be handed to a video model as start and
# end image; here a plain ffmpeg dissolve stands in, so the demo runs with no
# model, no download and no cost.
#
# Encoding follows pipeline.md: crf 20, GOP 8, no audio, +faststart — a short
# GOP is what makes scrubbing cheap, because a seek costs frames-from-keyframe.
set -euo pipefail
cd "$(dirname "$0")/.."

A=assets/seams/hof-t1.png
B=assets/seams/werkstatt-t0.png
OUT=assets/vid/hof-zur-werkstatt.mp4
OUTM=assets/vid/hof-zur-werkstatt-m.mp4

for f in "$A" "$B"; do
  [ -f "$f" ] || { echo "missing $f — run the seam export first (tools/export-seams.js)" >&2; exit 1; }
done
mkdir -p assets/vid

ffmpeg -y -loglevel error \
  -loop 1 -t 2.0 -i "$A" \
  -loop 1 -t 2.0 -i "$B" \
  -filter_complex "[0:v]format=yuv420p,fps=30[a];[1:v]format=yuv420p,fps=30[b];[a][b]xfade=transition=fade:duration=1.7:offset=0.15[v]" \
  -map "[v]" -an \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
  -g 8 -keyint_min 8 -sc_threshold 0 -movflags +faststart "$OUT"

# Mobile variant: 720p is already the master here, so only the GOP halves.
ffmpeg -y -loglevel error -i "$OUT" \
  -vf "scale=-2:540" -an \
  -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p \
  -g 4 -keyint_min 4 -sc_threshold 0 -movflags +faststart "$OUTM"

for f in "$OUT" "$OUTM"; do
  printf 'clip %-40s %s  %s\n' "$f" "$(du -h "$f" | cut -f1)" \
    "$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height,nb_frames,duration -of csv=p=0 "$f")"
done
