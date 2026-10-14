#!/bin/bash
# Zweck: legt bei jedem Session-Start in den Kontext, welche Modell-Spuren gerade
#        erschoepft oder knapp sind -- damit der Orchestrator Aufgaben nur dorthin
#        vergibt, wo sie auch durchlaufen.
# Event: SessionStart.
# Anlass (2026-08-27): An einem Vormittag fielen VIER laufende Antigravity-Worker binnen
#        Minuten gemeinsam aus ("Individual quota reached. Resets in 167h40m52s") -- das
#        Kontingent gilt fuer das ganze Konto, nicht je Modell. Am selben Tag verbrauchte
#        ein einziger Rauchtest 34 von 50 taeglichen OpenRouter-Anfragen, weil das
#        Tageslimit nirgends stand. Beides war erst NACH dem Ausfall sichtbar.
#        Die Vorgabe dazu (2026-08-27): "Schreibe auch immer dazu, wie grosszuegig das kostenlose
#        Limit ist, damit ein Orchestrator nicht ploetzlich von Workern ueberrascht wird,
#        die stillstehen -- und das muss sessionuebergreifend getrackt werden, so dass eine
#        spaetere Session nicht immer von 0 ausgeht."
# Verhalten: schweigt, wenn alle Spuren frei sind. Meldet sich nur, wenn etwas erschoepft
#        oder knapp ist -- anders als der Geschwister-Hook fuers Claude-Wochenlimit, wo
#        die Zahl immer gebraucht wird. Hier ist die Nachricht selbst die Ausnahme.
# Performance: liest ein paar kleine Zustandsdateien, kein Netzaufruf.
set -uo pipefail

WB_KONTINGENT="$HOME/.local/bin/wb-kontingent"
[ -x "$WB_KONTINGENT" ] || exit 0

AUSGABE="$("$WB_KONTINGENT" --knapp 2>/dev/null)" || exit 0
[ -n "$AUSGABE" ] && {
  printf '%s\n' "$AUSGABE"
  printf 'Voller Stand und die Herkunft jeder Zahl: wb-kontingent\n'
}

# Ein unbekannter Stand ist kein Freibetrag. Der Hook misst weiterhin nichts und
# bleibt bei vollstaendig bekanntem, freiem Stand still; nur diese Lage bekommt
# den klaren Handlungs-Hinweis fuer die naechste Vergabe.
STAND="$("$WB_KONTINGENT" zeigen 2>/dev/null)" || exit 0
case "$STAND" in
  *unbekannt*)
    printf 'Kontingent-Hinweis: "unbekannt" heisst nicht frei, sondern nicht gemessen. Vor der Vergabe: wb-kontingent auffrischen\n'
    ;;
esac
exit 0
