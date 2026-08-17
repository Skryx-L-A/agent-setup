#!/bin/bash
# Zweck: vergleicht bei Session-Ende den aktuellen Zustand (Ports, ollama-
#        Modelle) gegen den SessionStart-Baseline-Snapshot und druckt eine
#        Warnliste, was diese Session neu gestartet und nicht beendet hat.
# Event: SessionEnd.
# Warum: siehe sessionstart-baseline.sh — rein informierend, blockiert nie
#        (SessionEnd kann laut Doku ohnehin nicht blockieren: "No decision
#        control. Exit codes and output are ignored [for blocking]" — nur
#        stderr wird dem User gezeigt).
# Budget: < 1s Laufzeit — lsof/ollama ps sind lokale, schnelle Abfragen ohne
#        Netzwerk; kein `find`/Repo-Scan.
set -uo pipefail

input=$(cat)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$session_id" ] && exit 0

state_dir="$HOME/.local/state"
baseline_file="$state_dir/wb-session-baseline-${session_id}.json"
[ -f "$baseline_file" ] || exit 0

base_ports=$(jq -r '.ports[]?' "$baseline_file" 2>/dev/null)
base_ollama=$(jq -r '.ollama_models[]?' "$baseline_file" 2>/dev/null)

now_ports=""
if command -v lsof >/dev/null 2>&1; then
  now_ports=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $1":"$9}' | sort -u)
fi

now_ollama=""
if command -v ollama >/dev/null 2>&1; then
  now_ollama=$(ollama ps 2>/dev/null | awk 'NR>1{print $1}')
fi

new_ports=$(comm -13 <(echo "$base_ports" | sort -u) <(echo "$now_ports" | sort -u) 2>/dev/null | sed '/^$/d')
new_ollama=$(comm -13 <(echo "$base_ollama" | sort -u) <(echo "$now_ollama" | sort -u) 2>/dev/null | sed '/^$/d')

if [ -n "$new_ports" ] || [ -n "$new_ollama" ]; then
  echo "sessionend-orphan-check: diese Session hat evtl. noch laufende Prozesse hinterlassen:" >&2
  [ -n "$new_ports" ] && printf '  neuer offener Port: %s\n' $new_ports >&2
  [ -n "$new_ollama" ] && printf '  noch geladenes ollama-Modell: %s\n' $new_ollama >&2
fi

rm -f "$baseline_file" 2>/dev/null
exit 0
