#!/bin/bash
# Zweck: legt das Tagesbudget des Wochenlimits bei jedem Session-Start in den
#        Kontext, damit die Zahl nie aus dem Gedaechtnis kommt.
# Event: SessionStart.
# Anlass (2026-08-22): die Rechnung musste zweimal korrigiert werden. Erst
#        stand im Rollen-Prompt eine starre Marke ("ab 40 % keine Cloud-Worker"),
#        die am Samstag dieselbe Zahl ansetzte wie am Montag. Dann rechnete die
#        Nachfolgeregel zwar anteilig, nahm aber den bis JETZT verstrichenen
#        Fensteranteil als Maszstab (Samstagmorgen 64 %) statt das Ende des
#        laufenden Tages (86 %). Beide Male hat der Orchestrator daraufhin Worker
#        gespart, wo Luft war -- ein Fehler, der nichts kaputtmacht und deshalb
#        nie von selbst auffaellt. Die Vorgabe dazu: "Ich will, dass Du das mit
#        dem Limit so aenderst, dass Du ab jetzt immer weiszt, wie viel Limit
#        bis zum Ende des Tages verbraucht werden darf."
# Verhalten: GENAU EINE Zeile, IMMER -- anders als die Geschwister-Hooks
#        (testsuite/hygiene), die bei gruen schweigen. Hier ist das Schweigen
#        selbst der Fehlerfall: eine fehlende Zahl wird durch eine geratene
#        ersetzt, und genau das ist zweimal passiert. Still bleibt der Hook nur,
#        wenn gar nichts messbar ist (kein wb-budget, kein Betriebslog) -- dann
#        waere jede Ausgabe erfunden.
# Performance: liest eine einzige Datei, kein Transkript, kein jq. Gemessen:
#        28 ms (der volle wb-budget-Report braucht rund neun Sekunden und haette
#        an dieser Stelle nichts zu suchen).
set -uo pipefail

WB_BUDGET="$HOME/.local/bin/wb-budget"
[ -x "$WB_BUDGET" ] || exit 0

# --knapp gibt genau eine Zeile aus und endet mit 1, wenn nichts messbar ist.
ZEILE="$("$WB_BUDGET" --limit --knapp 2>/dev/null)" || exit 0
[ -n "$ZEILE" ] || exit 0

printf '%s\n' "$ZEILE"
exit 0
