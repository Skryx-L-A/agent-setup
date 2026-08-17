#!/bin/bash
# Zweck: BLOCKT einen `git commit`, dessen Nachricht einen Claude-Co-Author-Trailer
#        oder eine Generated-with-Zeile traegt.
# Event: PreToolUse, matcher Bash.
# Warum: Stehende Regel (CLAUDE.md, Standing rules): Commits laufen auf dem
#        Git-Handle des Repo-Besitzers, englische Nachricht, nie ein Claude-
#        Co-Author-Trailer — sie ueberschreibt ausdruecklich die Voreinstellung
#        des Harness, der solche Trailer von sich aus anhaengt. Bis 2026-08-03
#        stand die Regel nur als Prosa da: weder bash-guard-secrets noch
#        push-gate-worker sehen sich die
#        Commit-NACHRICHT an, beide pruefen nur, OB committet wird.
#        Ein einmal gesetzter Trailer laesst sich nach dem Push nicht mehr still
#        entfernen — deshalb Deny statt Warnung.
# Grenze: Erkennt nur Nachrichten, die im Kommando stehen (-m/-F-Text). Ein
#        Commit ueber den Editor oder eine Datei sieht dieser Guard nicht; das
#        ist bewusst so, weil er sonst Dateien lesen muesste, die es zur
#        Pruefzeit noch gar nicht gibt.
set -uo pipefail

input=$(cat)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)
[ "$tool_name" = "Bash" ] || exit 0

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0

# Nur wenn ueberhaupt committet wird.
# '(' und ')' stehen mit in der Zeichenklasse davor: eine Unterschale ist ein
# gueltiger Platz fuer einen Commit, `(git commit -m "…")` ist derselbe Commit
# wie ohne Klammer. Bis 2026-08-05 fehlten sie, und beide protokollierten
# Trailer-Ablehnungen liefen in der geklebten Form `(git commit …)` durch
# (gemessen am echten Guard-Verlauf).
printf '%s' "$cmd" | grep -qE '(^|[;&|()[:space:]])git([[:space:]]+-[^[:space:]]+)*[[:space:]]+commit([[:space:]]|$)' || exit 0

# Die Muster, die der Harness von sich aus setzt, plus die uebliche Schreibweise.
if printf '%s' "$cmd" | grep -qiE 'Co-Authored-By:[[:space:]]*Claude|Generated with \[?Claude Code|noreply@anthropic\.com|Claude-Session:[[:space:]]*https'; then
  cat <<'EOF' >&2
git commit mit Claude-Trailer abgelehnt.
  Stehende Regel (CLAUDE.md, Standing rules): Commits laufen auf dem Git-Handle
  des Repo-Besitzers, die Nachricht ist englisch, und ein Claude-Co-Author-
  Trailer kommt NIE hinein — diese Regel ueberschreibt die Voreinstellung des
  Harness.
  Gefunden wurde eines von: "Co-Authored-By: Claude", "Generated with Claude Code",
  "noreply@anthropic.com", "Claude-Session: https...".
  Richtig: dieselbe Nachricht ohne Trailer-Zeilen committen.
  Nach dem Push laesst sich so ein Trailer nicht mehr still entfernen - deshalb
  wird hier abgelehnt statt gewarnt.
EOF
  exit 2
fi
exit 0
