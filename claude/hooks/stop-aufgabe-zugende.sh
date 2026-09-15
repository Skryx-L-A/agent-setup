#!/bin/bash
# stop-aufgabe-zugende.sh — Stop-Hook der Werkbank-Aufgaben: Wecker am Zugende.
#
# Event: Stop (Claude Code). Die gesamte Logik liegt in lib/stop_aufgabe.py;
# dieses Skript ist der schmale Einstieg, der den Prozess startet und für die
# Fristen und den lautlosen Abbruch sorgt. Siehe docs/AGENTS-PLAN.md,
# Abschnitt 3 („Die Sicherung") und Abschnitt 8 („Hooks sind Wecker, nie
# Wahrheit").
#
# NICHT REGISTRIERT: die Registrierung läuft über
# stop-aufgabe-zugende.settings-snippet.json neben dieser Datei — der
# Orchestrator trägt den Eintrag beim Ausrollen in die lebende
# ~/.claude/settings.json ein (an das bestehende hooks.Stop-Array anhängen,
# der Companion-Hook bleibt stehen). Bis dahin liegt das Skript hier, ohne
# von einer Einstellung aufgerufen zu werden.
#
# Umgebung (setzt der Träger-Worker beim Start des Hauptagenten; die Hooks
# erben sie vom Claude-Prozess):
#   WB_AUFGABE_ID        Kennung der Aufgabe — Fehlt sie, tut das Skript
#                        nichts (interaktive Sitzungen bleiben unberührt).
#   WB_AUFGABE_PROJEKT   Projektpfad der Aufgabe.
#   WB_AUFGABE_BASE      Basis (meist $HOME) für Vorrat und Wecker.
#   WB_AUFGABE_SITZUNGSENDE  „1" erlaubt den Checkpoint-Commit unabhängig
#                        vom Stand (Sitzung endet ganz).
#
# Verhalten: Exit 0, IMMER, und nie eine decision-Ausgabe — dieser Hook
# blockiert den Stop nie. Die stdout des Hook-Kerns wird verworfen, damit
# selbst ein Versehen keine decision werden kann. Der stderr des Kerns wird
# in eine Logdatei angehängt: <base>/.local/state/wb-stop-aufgabe/<id>.log
# (base aus WB_AUFGABE_BASE, sonst $HOME). So erreichen Meldungen wie
# „wb-aufgabe nicht im PATH“ die Fehlersuche, ohne je den Stop zu berühren.
# Fehlt die Kennung (interaktive Sitzung), bleibt der stderr verworfen;
# eine ungueltige Kennung darf ebenfalls keinen Logpfad bauen.
#
# Frist: `timeout` fehlt auf macOS, darum zwei Wächter — lib/stop_aufgabe.py
# setzt sich selbst per signal.alarm eine Frist von 8 Sekunden, und dieses
# Skript legt mit `perl -e alarm 9` nach. Der Alarm überlebt das exec, weil
# perl sich durch den Python-Prozess ersetzt und setitimer prozessweit gilt.
# Für den Fall greift immer einer, und keiner blockiert: Nach der Frist ist
# der Hook vorbei, egal was die Unterprozesse tun.
set -uo pipefail

HOOKS_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HOOKS_DIR/lib/stop_aufgabe.py"

[ -f "$LIB" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

# stderr-Ziel des Kerns: Logdatei, wenn die Kennung sicher ist (dieselbe
# Slug-Prüfung wie im Kern, lib/stop_aufgabe.py: keine Pfadtrenner, kein
# „..“), sonst /dev/null — eine boese Kennung darf keinen Logpfad bauen.
std_err_ziel="/dev/null"
if [ -n "${WB_AUFGABE_ID:-}" ]; then
  if [[ "$WB_AUFGABE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] \
     && [[ "$WB_AUFGABE_ID" != *..* ]]; then
    base="${WB_AUFGABE_BASE:-}"
    [ -z "$base" ] && base="$HOME"
    logdir="$base/.local/state/wb-stop-aufgabe"
    if mkdir -p "$logdir" 2>/dev/null && { : >>"$logdir/$WB_AUFGABE_ID.log"; } 2>/dev/null; then
      std_err_ziel="$logdir/$WB_AUFGABE_ID.log"
    fi
  fi
fi
if command -v perl >/dev/null 2>&1; then
  perl -e 'alarm 9; exec @ARGV' python3 "$LIB" >/dev/null 2>>"$std_err_ziel"
else
  python3 "$LIB" >/dev/null 2>>"$std_err_ziel"
fi
exit 0
