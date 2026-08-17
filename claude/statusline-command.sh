#!/bin/bash
# Claude Code statusline — one line, color-coded:
#   <model> · <dir> <branch> · ▓▓▓░░░░░░░ 46k/1.0M · 5h 12%→14:00 · 7d 3% · $0.42
input=$(cat)
J() { echo "$input" | /opt/homebrew/bin/jq -r "$1 // empty" 2>/dev/null; }

DIM=$'\e[2m'; GRN=$'\e[32m'; YLW=$'\e[33m'; RED=$'\e[31m'; CYN=$'\e[36m'; RST=$'\e[0m'
SEP="${DIM} · ${RST}"

fmt() { n=$1
  if [ "$n" -ge 1000000 ]; then printf '%d.%dM' $((n/1000000)) $(((n%1000000)/100000))
  elif [ "$n" -ge 1000 ]; then printf '%dk' $((n/1000))
  else printf '%d' "$n"; fi; }

col_pct() { # color by percentage
  p=${1:-0}
  if [ "$p" -ge 85 ]; then printf '%s' "$RED"
  elif [ "$p" -ge 60 ]; then printf '%s' "$YLW"
  else printf '%s' "$GRN"; fi; }

model=$(J '.model.display_name' | awk '{print $1}')
dir=$(J '.workspace.current_dir'); dir=${dir:-$PWD}
branch=$(git -C "$dir" branch --show-current 2>/dev/null)

effort=$(J '.effort.level')
mline="${model:-Claude}"; [ -n "$effort" ] && mline="$mline ${effort}"
sdir=${dir/#$HOME/~}
if [ ${#sdir} -gt 32 ]; then sdir="…/$(basename "$(dirname "$sdir")")/$(basename "$sdir")"; fi
if [ ${#sdir} -gt 32 ]; then sdir="…/$(basename "$sdir")"; fi
out="${CYN}${mline}${RST}${SEP}${sdir}"
[ -n "$branch" ] && out="$out ${DIM}${branch}${RST}"

used=$(J '.context_window.total_input_tokens'); size=$(J '.context_window.context_window_size')
if [ -n "$used" ] && [ -n "$size" ] && [ "$size" -gt 0 ]; then
  pct=$((used * 100 / size)); c=$(col_pct "$pct")
  filled=$((pct / 10)); [ "$filled" -gt 10 ] && filled=10
  bar=""; i=0
  while [ $i -lt 10 ]; do
    if [ $i -lt $filled ]; then bar="${bar}▓"; else bar="${bar}░"; fi; i=$((i+1))
  done
  out="$out$SEP${c}${bar} $(fmt "$used")/$(fmt "$size")${RST}"
fi

h5=$(J '.rate_limits.five_hour.used_percentage' | cut -d. -f1)
h5r=$(J '.rate_limits.five_hour.resets_at')
if [ -n "$h5" ]; then
  reset=""; [ -n "$h5r" ] && reset="→$(date -r "$h5r" +%H:%M 2>/dev/null)"
  out="$out$SEP$(col_pct "$h5")5h ${h5}%${reset}${RST}"
fi
d7=$(J '.rate_limits.seven_day.used_percentage' | cut -d. -f1)
d7r=$(J '.rate_limits.seven_day.resets_at')
[ -n "$d7" ] && out="$out$SEP$(col_pct "$d7")7d ${d7}%${RST}"

# Limitstand mitschreiben: die Prozentwerte gibt es nur hier, sonst nirgends im
# Dateisystem. Immer die Momentaufnahme, zusaetzlich eine Verlaufszeile bei Wechsel.
if [ -n "$h5$d7" ]; then
  LIMDIR="$HOME/.claude/workbench"
  sid=$(J '.session_id')
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # seven_day_resets_at seit 2026-08-10: ohne ihn ist ein Wochen-Reset im Log nur
  # am Ruecksprung der Prozentzahl zu erraten, und mehrere Sessions schreiben den
  # Uebergang unterschiedlich - die Wochenkalibrierung war daran nicht belegbar.
  line="{\"ts\":\"$ts\",\"session\":\"${sid}\",\"five_hour_pct\":${h5:-null},\"seven_day_pct\":${d7:-null},\"five_hour_resets_at\":\"${h5r}\",\"seven_day_resets_at\":\"${d7r}\"}"
  mkdir -p "$LIMDIR" 2>/dev/null
  printf '%s\n' "$line" > "$LIMDIR/limits-latest.json.tmp" 2>/dev/null &&
    mv -f "$LIMDIR/limits-latest.json.tmp" "$LIMDIR/limits-latest.json" 2>/dev/null
  prev=$(tail -n 1 "$LIMDIR/limits.jsonl" 2>/dev/null | /opt/homebrew/bin/jq -r '"\(.five_hour_pct)/\(.seven_day_pct)"' 2>/dev/null)
  if [ "$prev" != "${h5:-null}/${d7:-null}" ]; then
    printf '%s\n' "$line" >> "$LIMDIR/limits.jsonl" 2>/dev/null
  fi
fi

echo "$out"
