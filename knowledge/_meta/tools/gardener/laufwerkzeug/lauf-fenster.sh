#!/bin/bash
# Ein Zeitfenster des Traum-Kaltstarts: lokale Extraktion, danach lokale Zuordnung,
# beides mit hartem Halt vor der Frist und fortsetzbar.
#
# Warum ueberhaupt ein Fenster: Die lokale Extraktion des ganzen Bestands braucht
# rund 110 Stunden (gemessen am 12.08.2026 ueber fuenf echte Fenster: 45 Einheiten
# je Stunde, also 80 s je Einheit). Das ist kein Lauf, den man an einem Stueck
# faehrt. Offene Einheiten bleiben auf `pending`, deshalb setzt
# jedes weitere Fenster genau dort an, wo das vorige aufgehoert hat - ohne Zutun,
# ohne Zustandsdatei, das Buch selbst ist der Merker.
#
# Der Halt kommt aus `--budget` (Minuten) und ist der saubere Weg: der Lauf
# beendet sein laufendes Buendel, schreibt es weg und hoert dann auf. Ein Kill
# von aussen wuerde ein halbes Buendel hinterlassen.
#
#   lauf-fenster.sh <frist-hh:mm>     z.B. lauf-fenster.sh 12:00
set -u

FRIST=${1:?Frist als HH:MM, z.B. 12:00}
WERK=$HOME/Knowledge/_meta/tools/gardener
LAUFDIR=$HOME/AI/traum-lauf
LOG="$LAUFDIR/fenster-$(date +%Y%m%d-%H%M).log"
STAND="$LAUFDIR/STAND.md"

mkdir -p "$LAUFDIR"
exec >>"$LOG" 2>&1

jetzt=$(date +%s)
ziel=$(date -j -f '%Y-%m-%d %H:%M' "$(date +%Y-%m-%d) $FRIST" +%s 2>/dev/null)
[ -z "$ziel" ] && { echo "FEHLER: Frist '$FRIST' nicht lesbar"; exit 64; }
# Eine Frist, die heute schon vorbei ist, meint morgen. Ohne diese Zeile
# scheitert jeder Durchgang, der ueber Mitternacht reicht: Um 22:00 waere die
# Frist "02:00" fuer diesen Vergleich Vergangenheit, und der Dauerlauf haette
# nach zwei Fehlschlaegen in Folge um Mitternacht aufgehoert.
if [ "$ziel" -le "$jetzt" ]; then
  ziel=$(( ziel + 86400 ))
  echo "Hinweis: Frist $FRIST ist heute vorbei, gemeint ist morgen $FRIST."
fi

gesamt_min=$(( (ziel - jetzt) / 60 ))
# Sieben Achtel fuer die Extraktion, der Rest fuer die Zuordnung. Die Zuordnung
# braucht rund 8 s je strittigem Paar und faellt bei einem Fenster dieser Groesse
# klein aus, aber sie soll nicht ausfallen, nur weil die Extraktion alles frisst.
#
# ES SEI DENN, die Marke KEINE-ZUORDNUNG liegt da. Dann bekommt die Extraktion
# das ganze Fenster. Gemessen am 12.08.2026 ueber zwei Durchgaenge des
# Dauerlaufs: Die Zuordnung ueber dem gewachsenen Bestand kommt in dreissig
# Minuten nicht einmal durch das Einbetten der Aussagen (1714 Stueck), laeuft
# jedes Mal in `gtimeout` und schreibt nie einen Plan. Der Kommentar unten
# ("das naechste Fenster holt ihn nach") stimmt deshalb nicht: Es holt ihn nie
# nach, es verliert nur wieder eine halbe Stunde. Bei den verbleibenden rund
# 92 Stunden sind das etwa 13 Stunden fuer nichts.
#
# Die Zuordnung wird stattdessen EINMAL mit richtiger Frist gefahren, bevor das
# Urteil ansteht - vorher braucht sie niemand, denn das Urteil wartet ohnehin
# auf Go des Nutzers. Marke wieder wegnehmen: rm ~/AI/traum-lauf/KEINE-ZUORDNUNG
if [ -e "$LAUFDIR/KEINE-ZUORDNUNG" ]; then
  extrakt_min=$gesamt_min
  zuordnung_min=0
else
  extrakt_min=$(( gesamt_min * 7 / 8 ))
  zuordnung_min=$(( gesamt_min - extrakt_min ))
fi

# Die Belegung bei `wb-belegung` muss das GANZE Fenster ueberdauern. Ihre
# Vorgabe sind 180 Minuten; ein Fenster ist laenger, und eine verfallene
# Belegung wird von `wb-belegung aufraeumen` entfernt. Danach haelt die
# naechste Sitzung die 20,5 GiB fuer frei und laedt ihr eigenes Modell daneben
# und geht damit den Weg in den Speichermangel, an dem die Maschine in der Nacht zum 11.08.
# zweimal gestorben ist. Am 12.08. war die Belegung eines Fensters bis 12:00
# schon um 06:55 abgelaufen; sie musste von Hand nachgezogen werden.
# `dream extract` ruft `grug-server ensure` als Unterprozess, der diese
# Variable erbt.
export GRUG_SERVER_FRIST_MIN=$(( gesamt_min + 20 ))

echo "=== Traum-Fenster gestartet $(date '+%F %T') ==="
echo "Frist $FRIST, also $gesamt_min Minuten: $extrakt_min fuer die Extraktion, $zuordnung_min fuer die Zuordnung."
echo "Belegungsfrist: $GRUG_SERVER_FRIST_MIN Minuten."

cd "$WERK" || exit 70

echo "--- freier Speicher vor dem Start ---"
check-resources 2>/dev/null | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d["vram"]["free_mib"], "MiB frei")' || true

echo "--- Extraktion, lokal, Rueckfall Sonnet  $(date +%T) ---"
uv run python -m gardener.dream.cli extract \
  --backend local --limit 100000 --budget "$extrakt_min" --verbose
echo "--- Extraktion beendet mit $? um $(date +%T) ---"

if [ "$zuordnung_min" -ge 2 ]; then
  # `reconcile` kennt keine Minuten-Frist, nur --limit und --budget-points. Die
  # Frist kommt deshalb von aussen ueber gtimeout. Das ist hier unbedenklich:
  # der Schritt ist lokal, kostenlos und schreibt seinen Plan erst am Ende, ein
  # Abbruch laesst also nichts Halbes zurueck und das naechste Fenster holt ihn
  # nach.
  echo "--- Zuordnung, lokal, Frist $zuordnung_min min  $(date +%T) ---"
  gtimeout "${zuordnung_min}m" uv run python -m gardener.dream.cli reconcile --verbose
  rc=$?
  [ "$rc" = 124 ] && echo "--- Zuordnung an der Frist abgebrochen, wird im naechsten Fenster nachgeholt ---"
  echo "--- Zuordnung beendet mit $rc um $(date +%T) ---"
elif [ -e "$LAUFDIR/KEINE-ZUORDNUNG" ]; then
  echo "--- Zuordnung uebersprungen: Marke KEINE-ZUORDNUNG, das ganze Fenster gehoert der Extraktion ---"
else
  echo "--- Zuordnung uebersprungen: nur $zuordnung_min Minuten uebrig ---"
fi

echo "--- Server freigeben ---"
grug-server stop || true

# Stand fortschreiben, damit die naechste Sitzung ohne Nachfrage weitermachen kann.
uv run python - "$STAND" "$LOG" <<'PY'
import sys, datetime, collections
from gardener.dream.ledger import Ledger
from gardener.dream import config as dcfg

stand, log = sys.argv[1], sys.argv[2]
p = getattr(dcfg, "DREAM_LEDGER_DB", None) or (dcfg.DREAM_STATE_DIR / "dream.db")
z = collections.Counter(r.get("status") for r in Ledger(p).list_units())
offen = z.get("pending", 0)
fertig = z.get("extracted", 0)
gesamt = sum(z.values())
stunden = offen * 80 / 3600

with open(stand, "w", encoding="utf-8") as f:
    f.write("# Traum-Kaltstart: Stand\n\n")
    f.write(f"Fortgeschrieben am {datetime.datetime.now():%d.%m.%Y um %H:%M} vom Fensterlauf.\n\n")
    f.write(f"- Einheiten insgesamt: **{gesamt}**\n")
    f.write(f"- extrahiert, mit Aussagen: **{fertig}**\n")
    f.write(f"- bearbeitet, aber ohne Aussage (`leer`): {z.get('leer', 0)}\n")
    f.write(f"- offen: **{offen}**\n")
    f.write(f"- Quelle seit der Ernte geaendert (`stale`): {z.get('stale', 0)}\n")
    f.write(f"- vom Vorfilter verworfen: {z.get('skipped', 0)}\n\n")
    f.write(f"Bei gemessenen 80 Sekunden je Einheit stehen noch rund **{stunden:.0f} Stunden**\n")
    f.write("lokaler Extraktion aus. Das naechste Fenster setzt von selbst dort an, wo dieses\n")
    f.write("aufgehoert hat - offene Einheiten stehen auf `pending`, das Buch ist der Merker.\n\n")
    f.write("## Weiter geht es so\n\n")
    f.write("    ~/AI/traum-lauf/lauf-fenster.sh <HH:MM>\n\n")
    f.write("Das Urteil ist NICHT Teil dieser Fenster. Es laeuft auf claude-sonnet-5 und wartet\n")
    f.write("auf Go des Nutzers, nachdem der lokale Teil sich als tragfaehig gezeigt hat.\n\n")
    f.write(f"Protokoll dieses Fensters: `{log}`\n")
print("Stand fortgeschrieben:", stand)
PY

echo "=== Fenster beendet $(date '+%F %T') ==="
