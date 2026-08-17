#!/bin/bash
# Lokale Extraktion am Stueck: haengt Block an Block, bis nichts mehr offen ist.
#
# ANLASS 16.08.2026: Die Extraktion lief in Bloecken zu 900 Einheiten, und nach
# jedem Block musste ein Mensch (oder der Orchestrator) den naechsten starten.
# Am selben Abend zeigte sich, warum das nicht traegt: das 5-Stunden-Fenster der
# Wolke lief um 20:52 auf 100 Prozent, der Wolkenlauf hielt an, und der
# Wochenstand von 96 Prozent macht einen Ausfall des Orchestrators bis zum
# Reset am Montag 14:00 moeglich. Die lokale Spur kostet keine Token und darf
# von so einem Ausfall nicht beruehrt werden - sie muss allein weiterlaufen.
#
# STOPPEN:
#   touch ~/AI/traum-lauf/STOPP-EXTRAKT    # sauber, der laufende Block endet noch
#   kill <pid dieses Skripts>              # sofort
#
# Von selbst hoert er auf, wenn keine Einheit mehr offen ist.
#
#   extract-dauerlauf.sh [einheiten-je-block]      Vorgabe 900
set -u

BLOCK=${1:-900}
LAUFDIR=${TRAUM_LAUFDIR:-$HOME/AI/traum-lauf}
WERK=${TRAUM_WERK:-$HOME/Knowledge/_meta/tools/gardener}
STOPP="$LAUFDIR/STOPP-EXTRAKT"
LOG="$LAUFDIR/extract-dauerlauf-$(date +%Y%m%d-%H%M).log"

mkdir -p "$LAUFDIR"
exec >>"$LOG" 2>&1

[ -e "$STOPP" ] && { echo "alte Stoppmarke entfernt: $STOPP"; rm -f "$STOPP"; }

echo "=== Extrakt-Dauerlauf gestartet $(date '+%F %T'), $BLOCK Einheiten je Block ==="
echo "Stoppen: touch $STOPP   (oder kill $$)"

# Der Server haelt einen ganzen Tag, damit er nicht zwischen zwei Bloecken
# abgeraeumt und neu geladen wird - das Laden kostet Minuten.
export GRUG_SERVER_FRIST_MIN=1440

offene_einheiten() {
  cd "$WERK" || return 1
  python3 -c "
from gardener.dream.ledger import Ledger
from gardener.dream import config as dcfg
print(sum(1 for _ in Ledger(dcfg.LEDGER_DB, read_only=True).list_units(status='pending')))
" 2>/dev/null
}

laeuft_schon() {
  pgrep -f 'gardener.dream.cli extract' >/dev/null 2>&1
}

# Ein bereits laufender Block gehoert nicht diesem Aufseher. Er wartet auf ihn,
# statt einen zweiten daneben zu starten - zwei Extraktionen auf demselben
# Modellserver wuerden sich gegenseitig ausbremsen und den Speicher sprengen.
if laeuft_schon; then
  echo "--- ein Extrakt-Lauf laeuft bereits, warte auf sein Ende  $(date '+%F %T') ---"
  while laeuft_schon; do
    [ -e "$STOPP" ] && { echo "=== Stoppmarke waehrend des Wartens, Ende ==="; rm -f "$STOPP"; exit 0; }
    sleep 60
  done
  echo "--- der fremde Lauf ist beendet  $(date '+%F %T') ---"
fi

block_nr=0
fehler=0
while true; do
  if [ -e "$STOPP" ]; then
    echo "=== Stoppmarke gefunden, Ende $(date '+%F %T') ==="
    rm -f "$STOPP"
    break
  fi

  offen=$(offene_einheiten)
  case "$offen" in
    ''|*[!0-9]*)
      echo "WARNUNG: Zahl der offenen Einheiten nicht lesbar ('$offen') - Ende,"
      echo "damit der Aufseher nicht blind weiterfaehrt."
      break ;;
  esac
  if [ "$offen" -eq 0 ]; then
    echo "=== Nichts mehr offen. Ende $(date '+%F %T') ==="
    break
  fi

  block_nr=$((block_nr + 1))
  blocklog="$LAUFDIR/extract-lokal-block$(date +%Y%m%d-%H%M).log"
  echo "--- Block $block_nr, $offen offen, Protokoll $blocklog  $(date '+%F %T') ---"
  cd "$WERK" || exit 1
  python3 -m gardener.dream.cli extract --limit "$BLOCK" --backend local --verbose \
    >"$blocklog" 2>&1
  rc=$?
  echo "--- Block $block_nr beendet mit $rc um $(date '+%F %T') ---"

  # Ein Block, der sofort scheitert, darf keine Endlosschleife werden.
  if [ "$rc" -ne 0 ]; then
    fehler=$((fehler + 1))
    if [ "$fehler" -ge 2 ]; then
      echo "=== Zwei Bloecke hintereinander gescheitert, Ende. Letztes Protokoll:"
      tail -20 "$blocklog"
      break
    fi
    echo "    (erster Fehlschlag, ein weiterer Versuch nach 120 s)"
    sleep 120
  else
    fehler=0
  fi
done

echo "=== Extrakt-Dauerlauf beendet $(date '+%F %T'), $block_nr Bloecke ==="
