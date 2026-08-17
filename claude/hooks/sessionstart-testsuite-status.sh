#!/bin/bash
# Zweck: meldet einen roten oder ueberfaelligen woechentlichen Testlauf
#        (launchd-Job wb-testsuite, siehe claude-workbench/shell/wb-testsuite-run)
#        direkt bei Session-Start, statt dass der Bericht unter
#        ~/.local/state/wb-testsuite-report.md ungelesen liegen bleibt.
# Event: SessionStart.
# Anlass (2026-08-04): der Job lief am 04.08. um 03:36 mit einer roten Suite
#        durch (exit=1) und niemand haette es vor dem naechsten Sonntag
#        bemerkt -- selbes Muster wie bei Gardener/Vault-Backup/
#        brain-extra-embed/claude-md-lint: ein Werkzeug ohne Aufrufer ist
#        kein Werkzeug.
# Verhalten: schweigt (keine Ausgabe, exit 0), wenn
#        * die Statusdatei fehlt (Normalfall vor dem allerersten Lauf),
#        * sie leer oder mit kaputten/nicht-numerischen Werten geschrieben ist,
#        * der letzte Lauf gruen UND nicht aelter als 9 Tage ist.
#        Genau EINE Zeile, wenn der letzte Lauf FAIL-Suiten hatte oder aelter
#        als 9 Tage ist (Job laeuft woechentlich = 7 Tage, 9 Tage Puffer
#        gegen Fehlalarm bei einem einmalig verschobenen Lauf).
# Performance: nur grep/cut auf einer <15-Zeilen-Datei, keine Subprozesse
#        ausser date -- Ziel ist spuerbar keine zusaetzliche Session-Start-
#        Verzoegerung (siehe Messung im Ergebnisprotokoll dieser Aufgabe).
set -uo pipefail

STATUS_FILE="$HOME/.local/state/wb-testsuite-status.txt"
[ -r "$STATUS_FILE" ] || exit 0

fail=$(grep -m1 '^fail=' "$STATUS_FILE" | cut -d= -f2-)
ts_epoch=$(grep -m1 '^ts_epoch=' "$STATUS_FILE" | cut -d= -f2-)
failed_suites=$(grep -m1 '^failed_suites=' "$STATUS_FILE" | cut -d= -f2-)

# Kaputte oder unvollstaendige Datei (z.B. mitten im Schreiben abgebrochen)
# ist kein Fehler -- einfach schweigen statt zu crashen.
case "$fail" in
  ''|*[!0-9]*) exit 0 ;;
esac
case "$ts_epoch" in
  ''|*[!0-9]*) exit 0 ;;
esac

now_epoch=$(date +%s)
age_days=$(( (now_epoch - ts_epoch) / 86400 ))
overdue=0
[ "$age_days" -gt 9 ] && overdue=1

if [ "$fail" -eq 0 ] && [ "$overdue" -eq 0 ]; then
  exit 0
fi

if [ "$fail" -gt 0 ]; then
  if [ -n "$failed_suites" ] && [ "$failed_suites" != "UNPARSED" ]; then
    echo "Testsuite: letzter Lauf ($age_days Tage her) hat $fail rote Suite(n): $failed_suites"
  else
    echo "Testsuite: letzter Lauf ($age_days Tage her) hat $fail rote Suite(n) (Namen nicht parsbar, siehe wb-testsuite-report.md)"
  fi
else
  echo "Testsuite: letzter Lauf ist $age_days Tage her (ueberfaellig, Job laeuft woechentlich)"
fi

exit 0
