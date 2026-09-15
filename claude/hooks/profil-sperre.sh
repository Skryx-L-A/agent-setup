#!/bin/bash
# profil-sperre.sh -- PreToolUse fuer jedes Werkzeug (Matcher "*"): ein
# Agentenzug haelt Werkzeugliste, Bash-Muster, Hausliste gesperrter Programme,
# Kontextgrenze und Weltgrenze seines Profils ein (docs/AGENTS-PLAN.md,
# Abschnitt 3 "Die Sperre" und Abschnitt 8 Regel 5; docs/AGENTS-SPERREN.md).
#
# Die gesamte Logik liegt in lib/profil_sperre.py; dieses Skript ist der
# schmale Einstieg.
#
# NICHT REGISTRIERT: die Registrierung laeuft ueber
# profil-sperre.settings-snippet.json neben dieser Datei -- der Traeger oder
# der Orchestrator traegt den Eintrag beim Ausrollen ein.
#
# Umgebung (setzt der Traeger, siehe agents_skills.profil_umgebung):
# WB_AGENT_ID und WB_WELT (fehlen beide, tut das Skript nichts), dazu
# WB_AGENT_PROFIL, WB_WELT_PROJEKT, WB_AGENT_WORKTREE, WB_AGENT_TMP und aus der
# Skills-Umgebung WB_SKILL_PFADE und WB_SKILL_BIBLIOTHEK. Die Hausliste kommt
# aus wb-profil auf dem PATH (oder WB_PROFIL_BIN).
#
# Verhalten: die stdout MUSS durchgehen (Verweigerung als
# hookSpecificOutput.permissionDecision=deny-JSON); stderr geht nach
# <WB_WELT>/agents/<id>/profil-sperre.log, sonst nach /dev/null.
#
# Frist: FAIL-CLOSED wie Rollen- und Skills-Sperre. Der Kern verweigert bei
# seinem eigenen Alarm (7 s) selbst. Haengt er trotzdem, beendet diese Huelle
# nach 8 s seine Prozessgruppe samt Kindern und schreibt selbst ein deny-JSON,
# vor der 10-Sekunden-Grenze des Settings-Eintrags. Ebenso verweigert die
# Huelle, wenn der Kern fehlt oder ohne Entscheidung mit einem Fehler endet.
set -uo pipefail

HOOKS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HOOKS_DIR/lib/profil_sperre.py"
FRIST=8

verweigern() {
  printf '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Profil-Sperre: %s"}}\n' "$1"
  exit 0
}

# Ohne Agentenzug greift der Hook nicht -- keine Ausgabe.
[ -n "${WB_AGENT_ID:-}" ] || [ -n "${WB_WELT:-}" ] || exit 0

[ -f "$LIB" ] || verweigern "Pruefkern lib/profil_sperre.py fehlt -- ohne Pruefung ist nichts erlaubt."
command -v python3 >/dev/null 2>&1 || verweigern "python3 fehlt -- ohne Pruefung ist nichts erlaubt."
command -v perl >/dev/null 2>&1 || verweigern "perl fehlt, der Zeitwaechter kann den Kern nicht sicher begrenzen."

std_err_ziel="/dev/null"
if [[ "${WB_AGENT_ID:-}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] && [ -d "${WB_WELT:-}/agents/$WB_AGENT_ID" ] \
   && [ ! -L "${WB_WELT:-}/agents/$WB_AGENT_ID" ]; then
  log="$WB_WELT/agents/$WB_AGENT_ID/profil-sperre.log"
  if [ ! -L "$log" ] && { : >>"$log"; } 2>/dev/null; then
    std_err_ziel="$log"
  fi
fi

ausgabe="$(mktemp "${TMPDIR:-/tmp}/profil-sperre.XXXXXX")" \
  || verweigern "Zeitwaechter kann keine Ausgabedatei anlegen."
zeitmarker="${ausgabe}.frist"
trap 'rm -f "$ausgabe" "$zeitmarker"' EXIT

exec 3<&0
perl -e 'setpgrp(0, 0) or die "setpgrp: $!"; exec @ARGV' \
  python3 "$LIB" <&3 >"$ausgabe" 2>>"$std_err_ziel" &
pid=$!
exec 3<&-

(
  sleep "$FRIST" & schlaf=$!
  trap 'kill "$schlaf" 2>/dev/null; exit 0' TERM
  wait "$schlaf"
  if kill -0 "$pid" 2>/dev/null; then
    : >"$zeitmarker"
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    sleep 0.2
    kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
  fi
) >/dev/null 2>&1 &
waechter=$!

wait "$pid" 2>/dev/null
status=$?
kill -TERM "$waechter" 2>/dev/null
wait "$waechter" 2>/dev/null

if [ -f "$zeitmarker" ]; then
  verweigern "Pruefung hat ihre Frist ueberschritten; ihre Prozessgruppe wurde beendet, der Zugriff bleibt gesperrt."
fi
if [ "$status" -ne 0 ] && [ ! -s "$ausgabe" ]; then
  verweigern "Pruefkern endete mit Status $status ohne Entscheidung -- ohne Pruefung ist nichts erlaubt."
fi
cat "$ausgabe"
exit 0
