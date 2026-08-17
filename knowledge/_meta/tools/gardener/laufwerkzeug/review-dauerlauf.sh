#!/bin/bash
# Wolken-Urteil am Stueck: startet `dream review` neu, sobald die Wolke wieder
# antwortet, und hoert zur Frist auf.
#
# ANLASS 16.08.2026, 20:52: Der Volllauf hielt nach 476 Paketen an, mit der
# Meldung "3 Pakete in Folge ohne lesbare Antwort (exit 1: )". Die Ursache stand
# nicht im Protokoll des Laufs, sondern im Limit-Log der Werkbank: zur selben
# Minute stand das 5-Stunden-Fenster auf 100 Prozent. Die Bremse hat also genau
# richtig gegriffen - nur war danach eine Stunde lang niemand da, der um 21:50
# den Neustart gedrueckt haette, als das Fenster zuruecksetzte.
#
# Ein Lauf ueber achtzehn Stunden kreuzt drei bis vier solcher Fenster. Ohne
# Aufseher kostet jedes davon bis zu fuenf Stunden Stillstand.
#
# Warum ein Probe-Aufruf und nicht die Limit-Datei: ~/.claude/workbench/
# limits-latest.json schreibt die Statuszeile, und die schreibt nur, solange
# eine Sitzung aktiv ist. Faellt der Orchestrator selbst aus, veraltet die Datei
# genau dann, wenn der Aufseher sie braeuchte. Ein winziger Aufruf gegen die
# Wolke misst dagegen das, worauf es ankommt: ob der naechste Auftrag durchkommt.
#
# Das Journal (journal.jsonl im Changeset-Ordner) macht jeden Neustart billig -
# was bezahlt und beurteilt ist, wird nicht noch einmal gefragt.
#
# STOPPEN:
#   touch ~/AI/traum-lauf/STOPP-REVIEW    # sauber, der laufende Lauf endet noch
#   kill <pid dieses Skripts>             # sofort
#
#   review-dauerlauf.sh <changeset.json> <frist "YYYY-MM-DD HH:MM">
set -u

CHANGESET=${1:?changeset.json fehlt}
FRIST_TEXT=${2:?Frist fehlt, Form "YYYY-MM-DD HH:MM"}

LAUFDIR=${TRAUM_LAUFDIR:-$HOME/AI/traum-lauf}
WERK=${TRAUM_WERK:-$HOME/Knowledge/_meta/tools/gardener}
STOPP="$LAUFDIR/STOPP-REVIEW"
LOG="$LAUFDIR/review-dauerlauf-$(date +%Y%m%d-%H%M).log"

FRIST=$(date -j -f "%Y-%m-%d %H:%M" "$FRIST_TEXT" +%s) || {
  echo "Frist nicht lesbar: $FRIST_TEXT" >&2; exit 2; }

# Alle Laeufe dieses Changesets schreiben in EIN Protokoll, damit die Pakete
# durchgehend nachlesbar sind und nicht ueber ein Dutzend Dateien verstreut.
LAUFNAME=$(basename "$(dirname "$CHANGESET")")
REVIEWLOG="$LAUFDIR/review-$LAUFNAME.log"

mkdir -p "$LAUFDIR"
exec >>"$LOG" 2>&1

[ -e "$STOPP" ] && { echo "alte Stoppmarke entfernt: $STOPP"; rm -f "$STOPP"; }

echo "=== Review-Dauerlauf gestartet $(date '+%F %T') ==="
echo "Changeset: $CHANGESET"
echo "Frist:     $FRIST_TEXT  ($FRIST)"
echo "Stoppen:   touch $STOPP   (oder kill $$)"

# Ein Aufruf, der so klein ist, dass sein Verbrauch im Rauschen verschwindet,
# aber gross genug, dass er dieselbe Strecke nimmt wie ein echter Auftrag.
# `local out=$(...)` waere hier falsch: `local` setzt $? auf seinen EIGENEN
# Erfolg und verschluckt den Rueckgabewert des Aufrufs. Deshalb getrennt.
wolke_antwortet() {
  local out rc
  out=$(echo "antworte nur: ok" | timeout 120 claude --model claude-sonnet-5 -p 2>&1)
  rc=$?
  [ "$rc" -eq 0 ] && [ -n "$out" ]
}

lauf_nr=0
schnell_gescheitert=0
while true; do
  jetzt=$(date +%s)
  if [ -e "$STOPP" ]; then
    echo "=== Stoppmarke gefunden, Ende $(date '+%F %T') ==="
    rm -f "$STOPP"
    break
  fi
  if [ "$jetzt" -ge "$FRIST" ]; then
    echo "=== Frist erreicht, Ende $(date '+%F %T') ==="
    break
  fi

  if ! wolke_antwortet; then
    echo "--- Wolke antwortet nicht (Limit oder Stoerung), warte 10 min  $(date '+%F %T') ---"
    sleep 600
    continue
  fi

  rest=$((FRIST - $(date +%s)))
  [ "$rest" -lt 120 ] && { echo "=== weniger als 2 min bis zur Frist, Ende ==="; break; }

  lauf_nr=$((lauf_nr + 1))
  laufbeginn=$(date +%s)
  echo "--- Lauf $lauf_nr, ${rest} s bis zur Frist  $(date '+%F %T') ---"
  cd "$WERK" || exit 1
  python3 -m gardener.dream.cli review \
    --changeset "$CHANGESET" \
    --budget-points 12 --wochenmarke 100 \
    --time-budget "$rest" --verbose \
    >>"$REVIEWLOG" 2>&1
  rc=$?
  dauer=$(( $(date +%s) - laufbeginn ))
  echo "--- Lauf $lauf_nr beendet mit $rc nach ${dauer} s um $(date '+%F %T') ---"

  # Ein Lauf, der nach Sekunden zurueckkommt, hat nichts geschafft. Drei davon
  # hintereinander heissen: die Wolke laesst zwar den Probe-Aufruf durch, aber
  # keine echte Arbeit. Dann ist eine lange Pause richtig, keine Schleife.
  if [ "$dauer" -lt 120 ]; then
    schnell_gescheitert=$((schnell_gescheitert + 1))
    if [ "$schnell_gescheitert" -ge 3 ]; then
      echo "    (drei kurze Laeufe hintereinander - 30 min Pause)"
      sleep 1800
      schnell_gescheitert=0
    else
      sleep 60
    fi
  else
    schnell_gescheitert=0
    sleep 30
  fi
done

echo "=== Review-Dauerlauf beendet $(date '+%F %T'), $lauf_nr Laeufe ==="
