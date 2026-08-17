#!/bin/bash
# Zweck: meldet ein rotes oder ueberfaelliges Ergebnis des woechentlichen
#        Hygiene-Laufs (launchd-Job wb-hygiene, siehe
#        claude-workbench/shell/wb-hygiene) direkt bei Session-Start, statt
#        dass der Bericht unter ~/.local/state/wb-hygiene-report.md ungelesen
#        liegen bleibt.
# Event: SessionStart.
# Anlass (2026-08-04): wb-hygiene laesst wb-consistency, claude-md-lint und
#        status-freshness laufen und schreibt seit heute zusaetzlich zum
#        Bericht eine maschinenlesbare Statusdatei (siehe Kopfkommentar in
#        shell/wb-hygiene). Der launchd-Job selbst war seit seiner Anlage am
#        03.08. noch nie gelaufen; ein von Hand angestossener Lauf meldete
#        sofort zwei Dinge, die sonst bis zum naechsten Montag gelegen
#        haetten. Selbes Muster wie bei Gardener/Vault-Backup/claude-md-lint/
#        wb-testsuite: ein Werkzeug ohne Aufrufer ist kein Werkzeug. Dieser
#        Hook ist der Aufrufer, gebaut nach dem Vorbild von
#        sessionstart-testsuite-status.sh.
# Verhalten: schweigt (keine Ausgabe, exit 0), wenn
#        * die Statusdatei fehlt (Normalfall vor dem allerersten Lauf),
#        * sie leer oder mit kaputten/nicht-numerischen Werten geschrieben ist,
#        * der letzte Lauf gruen (exit_code=0) UND nicht aelter als 9 Tage ist.
#        Genau EINE Zeile, wenn der letzte Lauf rot war (exit_code!=0) oder
#        aelter als 9 Tage ist. 9 Tage aus demselben Grund wie beim
#        Testsuite-Hook: der Job laeuft woechentlich (7 Tage), 9 Tage Puffer
#        gegen Fehlalarm bei einem einmalig verschobenen Lauf -- gleiche
#        Kulanz fuer gleiche Schrittweite.
# Gesamtergebnis vs. Einzelzahlen: was "rot" macht, entscheidet ausschliesslich
#        exit_code (wb-hygienes eigene harte Kriterien: Groessengrenze und
#        wb-consistency) -- nicht, ob irgendeine der drei Einzelzahlen > 0
#        ist. claude-md-lint und status-freshness sind in wb-hygiene selbst
#        bewusst als Hinweise ohne Exit-Wirkung gebaut ("sollen den Job nicht
#        dauerhaft rot faerben"); wuerde dieser Hook stattdessen auf jede
#        Einzelzahl > 0 feuern, waere er nach der Erfahrung von heute (19
#        undatierte Regeln, 1 veraltetes STATUS.md) praktisch jede Woche laut
#        -- genau das Muster, das ihn nach drei Tagen ueberlesen liesse. Die
#        drei Zahlen werden aber in der roten Zeile mit ausgegeben, damit
#        sofort sichtbar ist, welche Pruefung wie viel gefunden hat.
# Performance: nur grep/cut auf einer <10-Zeilen-Datei, keine Subprozesse
#        ausser date.
set -uo pipefail

STATUS_FILE="$HOME/.local/state/wb-hygiene-status.txt"
[ -r "$STATUS_FILE" ] || exit 0

exit_code=$(grep -m1 '^exit_code=' "$STATUS_FILE" | cut -d= -f2-)
ts_epoch=$(grep -m1 '^ts_epoch=' "$STATUS_FILE" | cut -d= -f2-)
parse_ok=$(grep -m1 '^parse_ok=' "$STATUS_FILE" | cut -d= -f2-)
consistency_count=$(grep -m1 '^consistency_count=' "$STATUS_FILE" | cut -d= -f2-)
lint_undated_count=$(grep -m1 '^lint_undated_count=' "$STATUS_FILE" | cut -d= -f2-)
freshness_stale_count=$(grep -m1 '^freshness_stale_count=' "$STATUS_FILE" | cut -d= -f2-)

# Kaputte oder unvollstaendige Datei (z.B. mitten im Schreiben abgebrochen)
# ist kein Fehler -- einfach schweigen statt zu crashen.
case "$exit_code" in
  ''|*[!0-9]*) exit 0 ;;
esac
case "$ts_epoch" in
  ''|*[!0-9]*) exit 0 ;;
esac

now_epoch=$(date +%s)
age_days=$(( (now_epoch - ts_epoch) / 86400 ))
overdue=0
[ "$age_days" -gt 9 ] && overdue=1

if [ "$exit_code" -eq 0 ] && [ "$overdue" -eq 0 ]; then
  exit 0
fi

if [ "$exit_code" -ne 0 ]; then
  if [ "$parse_ok" = "1" ]; then
    echo "Hygiene: letzter Lauf ($age_days Tage her) rot -- Widersprueche: ${consistency_count:-?}, undatierte Regeln: ${lint_undated_count:-?}, veraltete STATUS.md: ${freshness_stale_count:-?}"
  else
    echo "Hygiene: letzter Lauf ($age_days Tage her) rot (Zahlen nicht parsbar, siehe wb-hygiene-report.md)"
  fi
else
  echo "Hygiene: letzter Lauf ist $age_days Tage her (ueberfaellig, Job laeuft woechentlich)"
fi

exit 0
