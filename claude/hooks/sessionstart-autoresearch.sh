#!/bin/bash
# Zweck: meldet beim Session-Start, ob ein autoresearch-Lauf laeuft oder
#        gelaufen ist, und wie er steht.
# Event: SessionStart.
# Warum: ausdrueckliche Anweisung vom 01.09.2026 -- beim naechsten Kontakt ist
#        ZUERST auf den Lauf hinzuweisen und sein Stand zu nennen, egal was
#        sonst geschrieben wurde, und danach wird weitergearbeitet. Ein Lauf
#        ueber Nacht ist genau die Sache, die sonst
#        untergeht: er hinterlaesst kein Fenster, keine Meldung und keinen
#        Fehler, nur eine Tabelle, in die niemand sieht.
# Nicht-blockierend: SessionStart kann ohnehin nicht blockieren; dieser Hook
#        schreibt nur Text nach stdout und beruehrt nichts.
# Stillhalten: wenn es weder einen laufenden Prozess noch eine Ergebnistabelle
#        gibt, sagt er GAR NICHTS -- ein Hook, der bei jeder Session dieselbe
#        Leermeldung macht, wird nach drei Tagen ueberlesen.
set -uo pipefail

WURZEL="$HOME/AI/autoresearch"
TABELLE="$WURZEL/results.tsv"
[ -f "$TABELLE" ] || exit 0

# Laeuft gerade einer? Die Schleife traegt ihren Namen in der Kommandozeile.
laeuft=""
pid=$(pgrep -f "wb_autoresearch.py schleife" 2>/dev/null | head -1)
[ -n "$pid" ] && laeuft="$pid"

zeilen=$(( $(wc -l < "$TABELLE") - 1 ))
[ "$zeilen" -lt 1 ] && exit 0

# Verfallen (2026-09-10, Betreiber: "Autoresearch hinweis kannst du entfernen, der ist
# alt"): ein beendeter Lauf wird nur so lange gemeldet, wie seine Tabelle juenger als
# drei Tage ist. Danach ist der Hinweis Rauschen -- der Stand bleibt ueber
# `wb-autoresearch stand` abrufbar. Ein LAUFENDER Lauf wird immer gemeldet.
if [ -z "$laeuft" ]; then
  alter=$(( $(date +%s) - $(stat -f %m "$TABELLE" 2>/dev/null || stat -c %Y "$TABELLE") ))
  [ "$alter" -gt $((3*86400)) ] && exit 0
fi

bester=$(awk -F'\t' 'NR>1 && $4=="keep" && $2+0>0 {if (b=="" || $2+0<b+0) {b=$2; d=$5}} END{if (b!="") print b"\t"d}' "$TABELLE")
grund=$(awk -F'\t' 'NR>1 && $2+0>0 {print $2; exit}' "$TABELLE")
behalten=$(awk -F'\t' 'NR>1 && $4=="keep"' "$TABELLE" | wc -l | tr -d ' ')
abstuerze=$(awk -F'\t' 'NR>1 && $4=="crash"' "$TABELLE" | wc -l | tr -d ' ')

echo "AUTORESEARCH — darauf hinweisen, BEVOR etwas anderes beantwortet wird (Anweisung"
echo "vom 01.09.2026): der Lauf im Hintergrund verbessert ein Sprachmodell,"
echo "das in fuenf Minuten trainiert wird; die Zielgroesse ist val_bpb, niedriger ist besser."
if [ -n "$laeuft" ]; then
  echo "  Zustand:    LAEUFT NOCH (PID $laeuft) — beenden mit: kill $laeuft"
else
  echo "  Zustand:    beendet"
fi
echo "  Experimente: $zeilen, davon $behalten behalten$([ "$abstuerze" -gt 0 ] && echo ", $abstuerze abgestuerzt")"
[ -n "$grund" ] && echo "  Grundwert:   $grund"
if [ -n "$bester" ]; then
  echo "  Bester Wert: $(printf '%s' "$bester" | cut -f1)  ($(printf '%s' "$bester" | cut -f2 | cut -c1-70))"
fi
echo "  Voller Stand: wb-autoresearch stand   |   jeder Schritt: ~/AI/autoresearch/lauf.jsonl"
exit 0
