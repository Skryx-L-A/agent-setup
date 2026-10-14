#!/bin/bash
# Claude Code statusline — eine Zeile, farbcodiert, fuer Mac und Linux (peer):
#   <model> <effort> · <dir> <branch> · ▓▓▓░░░░░░░ 46k/1.0M · 5h 12%→14:00 · 7d 3%
#
# Kanonische Quelle: claude-workbench claude/statusline-command.sh, ausgerollt nach
# ~/.claude/statusline-command.sh ueber wb-ausrollen (install_map). Bis 2026-10-07 lag die
# Datei unversioniert auf jeder Maschine, und Mac und peer hatten sich auseinanderentwickelt;
# diese Fassung fuehrt beide zusammen (jq-Suche, cwd- und Kontext-Rueckfall und
# ~/.claude/state/limits.json aus peer, Epoch-Uhrzeit fuer BSD- und GNU-date).
input=$(cat)
JQ=$(command -v jq 2>/dev/null)
if [ -z "$JQ" ]; then
  for c in /opt/homebrew/bin/jq /usr/local/bin/jq /usr/bin/jq; do
    [ -x "$c" ] && { JQ=$c; break; }
  done
fi
J() { echo "$input" | "${JQ:-jq}" -r "$1 // empty" 2>/dev/null; }
# Epoche -> HH:MM: BSD-date (Mac) mit -r, GNU-date (Linux) mit -d @.
uhr() { date -r "$1" +%H:%M 2>/dev/null || date -d "@$1" +%H:%M 2>/dev/null; }

DIM=$'\e[2m'; GRN=$'\e[32m'; YLW=$'\e[33m'; RED=$'\e[31m'; CYN=$'\e[36m'; RST=$'\e[0m'
SEP="${DIM} · ${RST}"

fmt() { n=$1
  if [ "$n" -ge 1000000 ]; then printf '%d.%dM' $((n/1000000)) $(((n%1000000)/100000))
  elif [ "$n" -ge 1000 ]; then printf '%dk' $((n/1000))
  else printf '%d' "$n"; fi; }

col_pct() { # Farbe nach Prozent
  p=${1:-0}
  if [ "$p" -ge 85 ]; then printf '%s' "$RED"
  elif [ "$p" -ge 60 ]; then printf '%s' "$YLW"
  else printf '%s' "$GRN"; fi; }

bar10() { # zehn Felder, $1 Prozent
  filled=$(($1 / 10)); [ "$filled" -gt 10 ] && filled=10
  b=""; i=0
  while [ $i -lt 10 ]; do
    if [ $i -lt $filled ]; then b="${b}▓"; else b="${b}░"; fi; i=$((i+1))
  done
  printf '%s' "$b"; }

model=$(J '.model.display_name' | awk '{print $1}')
dir=$(J '.workspace.current_dir'); [ -z "$dir" ] && dir=$(J '.cwd'); dir=${dir:-$PWD}
branch=$(git -C "$dir" branch --show-current 2>/dev/null)

effort=$(J '.effort.level')
mline="${model:-Claude}"; [ -n "$effort" ] && mline="$mline ${effort}"
sdir=${dir/#$HOME/~}
if [ ${#sdir} -gt 32 ]; then sdir="…/$(basename "$(dirname "$sdir")")/$(basename "$sdir")"; fi
if [ ${#sdir} -gt 32 ]; then sdir="…/$(basename "$sdir")"; fi
out="${CYN}${mline}${RST}${SEP}${sdir}"
[ -n "$branch" ] && out="$out ${DIM}${branch}${RST}"

# Kontext: bevorzugt Token-Zaehler; Rueckfall auf used_percentage
used=$(J '.context_window.total_input_tokens'); size=$(J '.context_window.context_window_size')
if [ -n "$used" ] && [ -n "$size" ] && [ "$size" -gt 0 ]; then
  pct=$((used * 100 / size))
  out="$out$SEP$(col_pct "$pct")$(bar10 "$pct") $(fmt "$used")/$(fmt "$size")${RST}"
else
  cpct=$(J '.context_window.used_percentage' | cut -d. -f1)
  [ -n "$cpct" ] && out="$out$SEP$(col_pct "$cpct")$(bar10 "$cpct") ctx ${cpct}%${RST}"
fi

h5=$(J '.rate_limits.five_hour.used_percentage' | cut -d. -f1)
h5r=$(J '.rate_limits.five_hour.resets_at')
if [ -n "$h5" ]; then
  reset=""; [ -n "$h5r" ] && reset="→$(uhr "$h5r")"
  out="$out$SEP$(col_pct "$h5")5h ${h5}%${reset}${RST}"
fi
d7=$(J '.rate_limits.seven_day.used_percentage' | cut -d. -f1)
d7r=$(J '.rate_limits.seven_day.resets_at')
[ -n "$d7" ] && out="$out$SEP$(col_pct "$d7")7d ${d7}%${RST}"

# ── Die Zahlen auch AUF DIE PLATTE, nicht nur auf den Schirm ────────────────────────────
# Anweisung des Nutzers 2026-08-30: "halte bei 95% Wochenlimit selber alles an und mache
# ueberall session ende". Eine Sitzung kann das nur befolgen, wenn sie den Stand LESEN
# kann; die Prozentwerte gibt es nur hier, sonst nirgends im Dateisystem.
#
# Befund 2026-09-30 (peer) und 2026-10-07 (beide Maschinen): jede Sitzung rendert mit dem
# Stand IHRER letzten API-Antwort. Eine ruhende Sitzung schreibt deshalb einen alten,
# niedrigeren Wert, eine frisch gestartete rendert zuerst mit unvollstaendiger Nutzlast
# (five_hour fehlt, seven_day alt: 20 statt 51). Wer zuletzt rendert, ueberschrieb bisher
# die Momentaufnahme -- und der Leser nahm sie fuer den Stand.
# Im selben Fenster (gleiches seven_day_resets_at) sinkt der Verbrauch nie. Die Momentaufnahme
# wird deshalb NICHT durch einen niedrigeren Wert desselben, noch laufenden Fensters ersetzt,
# und nicht durch eine Nutzlast ganz ohne seven_day. Die Verlaufszeile in limits.jsonl bleibt
# dagegen roh (jede Sitzung, jeder Wechsel): five_hour fehlt auch legitim, sobald das
# 5h-Fenster ohne Verbrauch abgelaufen ist (peer 07.10. 07:00Z, seven_day 9 korrekt), und
# die Leser (wb-budget) werten den Hoechstwert des juengsten Fensters.
if [ -n "$h5$d7" ]; then
  LIMDIR="$HOME/.claude/workbench"
  STATEDIR="$HOME/.claude/state"
  sid=$(J '.session_id')
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # seven_day_resets_at seit 2026-08-10: ohne ihn ist ein Wochen-Reset im Log nur
  # am Ruecksprung der Prozentzahl zu erraten, und mehrere Sessions schreiben den
  # Uebergang unterschiedlich - die Wochenkalibrierung war daran nicht belegbar.
  line="{\"ts\":\"$ts\",\"session\":\"${sid}\",\"five_hour_pct\":${h5:-null},\"seven_day_pct\":${d7:-null},\"five_hour_resets_at\":\"${h5r}\",\"seven_day_resets_at\":\"${d7r}\"}"
  mkdir -p "$LIMDIR" 2>/dev/null

  # Exit 0 = die vorhandene Momentaufnahme ist neuer als diese Nutzlast, also behalten.
  alt_ist_neuer() {
    [ -s "$LIMDIR/limits-latest.json" ] || return 1
    "${JQ:-jq}" -e --arg d7 "$d7" --arg d7r "$d7r" --arg h5 "$h5" --arg h5r "$h5r" \
      --argjson jetzt "$(date +%s)" '
      (.seven_day_pct) as $ap | (.seven_day_resets_at // "" | tostring) as $ar |
      ($ap != null) and (($ar | tonumber? // 0) > $jetzt) and
      ( ($d7 == "")
        or ($ar == $d7r and (
              $ap > ($d7 | tonumber)
              or ($ap == ($d7 | tonumber)
                  and (.five_hour_resets_at // "" | tostring) == $h5r and $h5r != ""
                  and .five_hour_pct != null
                  and ($h5 == "" or .five_hour_pct > ($h5 | tonumber)))))
        or ($d7r != "" and ($d7r | tonumber? // 0) < ($ar | tonumber? // 0))
      )' "$LIMDIR/limits-latest.json" >/dev/null 2>&1
  }

  if ! alt_ist_neuer; then
    # Geschrieben wird ATOMAR (tmp + mv), weil mehrere Sitzungen gleichzeitig rendern und ein
    # halb geschriebener Stand als "0 %" gelesen wuerde.
    printf '%s\n' "$line" > "$LIMDIR/limits-latest.json.$$.tmp" 2>/dev/null &&
      mv -f "$LIMDIR/limits-latest.json.$$.tmp" "$LIMDIR/limits-latest.json" 2>/dev/null
    rm -f "$LIMDIR/limits-latest.json.$$.tmp" 2>/dev/null
    # Deutsche Momentaufnahme (peer-Fassung seit 2026-08-30), dieselbe Entscheidung.
    mkdir -p "$STATEDIR" 2>/dev/null
    _lim_tmp="$STATEDIR/.limits.$$.json"
    printf '{"stand":"%s","sieben_tage_pct":%s,"fuenf_stunden_pct":%s,"fuenf_stunden_reset":%s,"sitzung":"%s"}\n' \
      "$(date +%Y-%m-%dT%H:%M:%S%z | sed 's/\(..\)$/:\1/')" "${d7:-null}" "${h5:-null}" "${h5r:-null}" "$sid" \
      > "$_lim_tmp" 2>/dev/null && mv -f "$_lim_tmp" "$STATEDIR/limits.json" 2>/dev/null
    rm -f "$_lim_tmp" 2>/dev/null
  fi

  prev=$(tail -n 1 "$LIMDIR/limits.jsonl" 2>/dev/null | "${JQ:-jq}" -r '"\(.five_hour_pct)/\(.seven_day_pct)"' 2>/dev/null)
  if [ "$prev" != "${h5:-null}/${d7:-null}" ]; then
    printf '%s\n' "$line" >> "$LIMDIR/limits.jsonl" 2>/dev/null
  fi
fi

echo "$out"
