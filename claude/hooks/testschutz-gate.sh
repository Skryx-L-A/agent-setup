#!/bin/bash
# testschutz-gate.sh -- PreToolUse/Bash und PreToolUse/Write|Edit: sperrt
# das Loeschen, Umbenennen und Aushoehlen von Tests einer Aufgabe mit
# Gate-Befehlen.
#
# Event: PreToolUse, Matcher Bash UND Write|Edit (zwei Eintraege im
# Settings-Snippet, derselbe Aufruf). Die gesamte Logik liegt in
# lib/testschutz.py; dieses Skript ist der schmale Einstieg. Siehe
# docs/AGENTS-PLAN.md, Abschnitt 4 "Vergeben und pruefen".
#
# NICHT REGISTRIERT: die Registrierung laeuft ueber
# testschutz-gate.settings-snippet.json neben dieser Datei -- der
# Orchestrator traegt die Eintraege beim Ausrollen in die lebende
# ~/.claude/settings.json ein.
#
# Umgebung: WB_AUFGABE_ID (fehlt sie, tut das Skript nichts),
# WB_AUFGABE_BASE (Basis fuer wb-aufgabe --base, sonst $HOME).
#
# Verhalten: die stdout MUSS durchgehen (Verweigerung als
# hookSpecificOutput.permissionDecision=deny-JSON); nur stderr geht in
# eine Logdatei: <base>/.local/state/wb-testschutz/<id>.log.
#
# Frist: wie die uebrigen neuen Hooks zwei Waechter (signal.alarm im
# Python-Kern, `perl -e alarm 9` als Rueckversicherung, weil `timeout` auf
# macOS fehlt). Laeuft die Frist ab, kommt keine Ausgabe -- das Werkzeug
# bleibt erlaubt (fail-open, siehe Kopf-Kommentar von lib/testschutz.py).
set -uo pipefail

HOOKS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HOOKS_DIR/lib/testschutz.py"

[ -f "$LIB" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

std_err_ziel="/dev/null"
if [ -n "${WB_AUFGABE_ID:-}" ]; then
  if [[ "$WB_AUFGABE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
     && [[ "$WB_AUFGABE_ID" != *..* ]]; then
    base="${WB_AUFGABE_BASE:-}"
    [ -z "$base" ] && base="$HOME"
    logdir="$base/.local/state/wb-testschutz"
    if mkdir -p "$logdir" 2>/dev/null && { : >>"$logdir/$WB_AUFGABE_ID.log"; } 2>/dev/null; then
      std_err_ziel="$logdir/$WB_AUFGABE_ID.log"
    fi
  fi
fi
if command -v perl >/dev/null 2>&1; then
  perl -e 'alarm 9; exec @ARGV' python3 "$LIB" 2>>"$std_err_ziel"
else
  python3 "$LIB" 2>>"$std_err_ziel"
fi
exit 0
