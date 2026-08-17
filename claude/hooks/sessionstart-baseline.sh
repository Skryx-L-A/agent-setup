#!/bin/bash
# Zweck: schreibt bei Session-Start einen Baseline-Snapshot (offene Ports,
#        geladene ollama-Modelle, PIDs) — Grundlage fuer
#        sessionend-orphan-check.sh, das am Session-Ende diff't, was diese
#        Session gestartet und nicht wieder beendet hat.
# Event: SessionStart.
# Warum: "Prozess-Hygiene: was gestartet wird, wird auch beendet" ist eine
#        der am meisten wiederholten Regeln im Regelwerk (CLAUDE.md + beide
#        Worker-Rollen), bisher komplett manuell/Erinnerungs-basiert.
# Nicht-blockierend: SessionStart kann laut Doku ohnehin nicht blockieren
#        (nur additionalContext/stderr), dieser Hook schreibt nur eine Datei.
# Aufraeumen: die Snapshot-Datei wird von sessionend-orphan-check.sh am Ende
#        wieder geloescht; bricht die Session vorher hart ab, bleibt hoechstens
#        eine kleine JSON-Datei unter ~/.local/state/ liegen (harmlos).
set -uo pipefail

input=$(cat)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$session_id" ] && exit 0

state_dir="$HOME/.local/state"
mkdir -p "$state_dir" 2>/dev/null

ports_json="[]"
if command -v lsof >/dev/null 2>&1; then
  ports_json=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $1":"$9}' | sort -u | jq -R -s -c 'split("\n") | map(select(length > 0))' 2>/dev/null) || ports_json="[]"
fi

ollama_json="[]"
if command -v ollama >/dev/null 2>&1; then
  ollama_json=$(ollama ps 2>/dev/null | awk 'NR>1{print $1}' | jq -R -s -c 'split("\n") | map(select(length > 0))' 2>/dev/null) || ollama_json="[]"
fi

# Nur PID+Prozessname (comm), NIE die volle Kommandozeile (koennte Secrets/
# Nutzerdaten in argv enthalten).
pids_json=$(ps -u "$(id -u)" -o pid=,comm= 2>/dev/null | awk '{pid=$1; $1=""; sub(/^ /,""); print pid"\t"$0}' | jq -R -s -c '
  split("\n") | map(select(length > 0) | split("\t") | {pid: .[0], comm: (.[1] // "")})
' 2>/dev/null) || pids_json="[]"

jq -n --argjson ports "$ports_json" --argjson ollama "$ollama_json" --argjson pids "$pids_json" \
  --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{ts: $ts, ports: $ports, ollama_models: $ollama, pids: $pids}' \
  > "$state_dir/wb-session-baseline-${session_id}.json" 2>/dev/null

exit 0
