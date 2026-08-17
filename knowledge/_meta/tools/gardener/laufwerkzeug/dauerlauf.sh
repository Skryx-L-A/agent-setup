#!/bin/bash
# Traum-Kaltstart am Stueck: faehrt Fenster hintereinander, bis jemand stoppt
# oder nichts mehr offen ist.
#
# Warum ein Aufseher und nicht ein einziges langes Fenster (Anweisung des Nutzers
# vom 12.08.2026: "in der zwischenzeit soll es einfach die ganze zeit laufen"):
#
#   - Jeder Durchgang endet mit der ZUORDNUNG und einem frischen `STAND.md`.
#     Ein Lauf ueber zwoelf Stunden am Stueck haette nur ganz am Ende einen
#     Plan; so gibt es alle paar Stunden einen brauchbaren Zwischenstand.
#   - Der Modellserver wird zwischen den Durchgaengen freigegeben. Wer den
#     Speicher fuer Bild- oder Videoarbeit braucht, bekommt regelmaessig ein
#     Fenster dafuer, ohne dass jemand eingreifen muss.
#   - Ein Durchgang, der schiefgeht, kostet einen Durchgang und nicht den Tag.
#
# STOPPEN, zwei Wege:
#   touch ~/AI/traum-lauf/STOPP      # sauber: der laufende Durchgang endet noch
#   kill <pid dieses Skripts>        # sofort, kostet die laufende Einheit
#
# Von selbst hoert er auf, wenn keine Einheit mehr offen ist.
#
#   dauerlauf.sh [stunden-je-durchgang]      Vorgabe 4
set -u

STUNDEN=${1:-4}
LAUFDIR=$HOME/AI/traum-lauf
WERK=$HOME/Knowledge/_meta/tools/gardener
FENSTER="$LAUFDIR/lauf-fenster.sh"
STOPP="$LAUFDIR/STOPP"
LOG="$LAUFDIR/dauerlauf-$(date +%Y%m%d-%H%M).log"

mkdir -p "$LAUFDIR"
exec >>"$LOG" 2>&1

# Eine alte Stoppmarke wuerde den Dauerlauf sofort wieder beenden. Sie zu
# entfernen ist richtig: Wer JETZT startet, will laufen lassen.
[ -e "$STOPP" ] && { echo "alte Stoppmarke entfernt: $STOPP"; rm -f "$STOPP"; }

echo "=== Dauerlauf gestartet $(date '+%F %T'), $STUNDEN h je Durchgang ==="
echo "Stoppen: touch $STOPP   (oder kill $$)"

offene_einheiten() {
  cd "$WERK" || return 1
  uv run python -c "
from gardener.dream.ledger import Ledger
from gardener.dream import config as dcfg
print(sum(1 for _ in Ledger(dcfg.LEDGER_DB, read_only=True).list_units(status='pending')))
" 2>/dev/null
}

durchgang=0
while true; do
  if [ -e "$STOPP" ]; then
    echo "=== Stoppmarke gefunden, Dauerlauf endet $(date '+%F %T') ==="
    rm -f "$STOPP"
    break
  fi

  offen=$(offene_einheiten)
  case "$offen" in
    ''|*[!0-9]*)
      echo "WARNUNG: Zahl der offenen Einheiten nicht lesbar ('$offen') - "
      echo "Dauerlauf endet, damit er nicht blind weiterfaehrt."
      break ;;
  esac
  if [ "$offen" -eq 0 ]; then
    echo "=== Nichts mehr offen. Dauerlauf endet $(date '+%F %T') ==="
    break
  fi

  durchgang=$((durchgang + 1))
  frist=$(date -v "+${STUNDEN}H" +%H:%M)
  echo "--- Durchgang $durchgang, $offen offen, Frist $frist  $(date '+%F %T') ---"
  "$FENSTER" "$frist"
  rc=$?
  echo "--- Durchgang $durchgang beendet mit $rc um $(date '+%F %T') ---"

  # Ein Durchgang, der SOFORT scheitert, darf keine Endlosschleife werden.
  # Zwei Fehlschlaege hintereinander beenden den Dauerlauf; ein einzelner
  # (etwa ein belegter Port) darf sich noch einmal fangen.
  if [ "$rc" -ne 0 ]; then
    fehler=$((${fehler:-0} + 1))
    if [ "$fehler" -ge 2 ]; then
      echo "=== Zwei Durchgaenge hintereinander gescheitert, Dauerlauf endet ==="
      break
    fi
    echo "    (erster Fehlschlag, ein weiterer Versuch)"
    sleep 60
  else
    fehler=0
  fi
done

echo "=== Dauerlauf beendet $(date '+%F %T'), $durchgang Durchgaenge ==="
