#!/bin/bash
# ergebnis-beleg-gate.sh -- PreToolUse/Write|Edit: verweigert eine
# Ergebnisdatei, solange die Sitzung keine Belegdatei GELESEN hat.
#
# Event: PreToolUse, Matcher Write|Edit. Die gesamte Logik liegt in
# lib/ergebnis_beleg.py; dieses Skript ist der schmale Einstieg. Siehe
# docs/AGENTS-PLAN.md, Abschnitt 4 "Vergeben und pruefen".
#
# NICHT REGISTRIERT: die Registrierung laeuft ueber
# ergebnis-beleg-gate.settings-snippet.json neben dieser Datei -- der
# Orchestrator traegt den Eintrag beim Ausrollen in die lebende
# ~/.claude/settings.json ein.
#
# Umgebung (setzt der Traeger-Worker beim Start des Hauptagenten; die
# Hooks erben sie vom Claude-Prozess):
#   WB_AUFGABE_ID     Kennung der Aufgabe -- fehlt sie, tut das Skript
#                     nichts (interaktive Sitzungen bleiben unberuehrt).
#   WB_AUFGABE_BASE   Basis (meist $HOME) fuer wb-aufgabe --base.
#
# Verhalten: anders als der Stop-Hook MUSS die stdout dieses Hooks
# durchgehen -- eine Verweigerung ist ein JSON-Objekt auf stdout
# (hookSpecificOutput.permissionDecision=deny), das Claude Code lesen muss.
# Nur stderr wird in eine Logdatei umgeleitet:
# <base>/.local/state/wb-ergebnis-beleg/<id>.log (base aus WB_AUFGABE_BASE,
# sonst $HOME).
#
# Frist: wie beim Stop-Hook zwei Waechter, weil `timeout` auf macOS fehlt --
# lib/ergebnis_beleg.py setzt sich selbst per signal.alarm eine Frist von
# 8 Sekunden, dieses Skript legt mit `perl -e alarm 9` nach. Laeuft die
# Frist ab, kommt KEINE Ausgabe -- das Werkzeug bleibt erlaubt (fail-open,
# siehe Kopf-Kommentar von lib/ergebnis_beleg.py: dieser Hook ist ein
# Wecker, nie die letzte Instanz).
set -uo pipefail

HOOKS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HOOKS_DIR/lib/ergebnis_beleg.py"

[ -f "$LIB" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

std_err_ziel="/dev/null"
if [ -n "${WB_AUFGABE_ID:-}" ]; then
  if [[ "$WB_AUFGABE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
     && [[ "$WB_AUFGABE_ID" != *..* ]]; then
    base="${WB_AUFGABE_BASE:-}"
    [ -z "$base" ] && base="$HOME"
    logdir="$base/.local/state/wb-ergebnis-beleg"
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
