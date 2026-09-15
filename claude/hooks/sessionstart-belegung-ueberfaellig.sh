#!/bin/bash
# Zweck: meldet beim Session-Start eine ueberfaellige Speicher-Belegung, damit
#        ein Modellserver nicht stundenlang weiterlaeuft, den niemand mehr braucht.
# Event: SessionStart.
# Anlass (2026-08-30): der MLX-Server von qwen3.8 lief nach dem Sessionende der
#        Vorsitzung 18,5 Stunden weiter und hielt dabei 15,9 GiB. Das Belegungsbuch
#        wusste es die ganze Zeit -- 'wb-belegung wer' schrieb "UEBERFAELLIG, die
#        Frist ist seit 934 min um" in seine erste Zeile. Gelesen hat es niemand,
#        weil beim Sessionstart niemand danach fragt. Genau diese Luecke schliesst
#        der Hook: die Zahl kommt von selbst in den Kontext, wie Wochenlimit und
#        Kontingente.
# Verhalten: STILL, solange keine Belegung ueberfaellig oder tot ist -- wie die
#        Geschwister-Hooks testsuite/hygiene, anders als der Limit-Hook. Eine
#        Meldung hier heisst immer: da haelt etwas Speicher, das seine Frist
#        ueberschritten hat.
# Testbar: WB_BELEGUNG_JSON=<datei> laesst den Hook aus einer Datei lesen statt
#        aus dem lebenden Buch. Nur dafuer gedacht.
# Performance: eine JSON-Ausgabe, kein Transkript. 'wb-belegung wer --json'
#        gemessen bei 0,27 s.
set -uo pipefail

if [ -n "${WB_BELEGUNG_JSON:-}" ]; then
  [ -r "$WB_BELEGUNG_JSON" ] || exit 0
  ROH="$(cat "$WB_BELEGUNG_JSON")"
else
  WB_BELEGUNG="$HOME/.local/bin/wb-belegung"
  [ -x "$WB_BELEGUNG" ] || exit 0
  ROH="$("$WB_BELEGUNG" wer --json 2>/dev/null)" || exit 0
fi
[ -n "$ROH" ] || exit 0

printf '%s' "$ROH" | python3 -c '
import json, sys, time

try:
    daten = json.load(sys.stdin)
except Exception:
    sys.exit(0)

auffaellig = [e for e in daten.get("belegungen", [])
              if e.get("_zustand") in ("ueberfaellig", "tot")]
if not auffaellig:
    sys.exit(0)

jetzt = time.time()
for e in auffaellig:
    alter = int((jetzt - float(e.get("seit", jetzt))) / 60)
    halter = (e.get("halter") or {}).get("sitzung") or "unbekannt"
    print("Belegung %s: %s, %s GiB, seit %d min, Halter %s -- %s"
          % (e.get("id", "?"),
             "UEBERFAELLIG" if e.get("_zustand") == "ueberfaellig" else "TOT",
             ("%.1f" % float(e.get("gb", 0.0))).replace(".", ","),
             alter, halter, e.get("zweck", "")))
print("Wird sie nicht mehr gebraucht: wb-mlx-server stop (bzw. ollama stop), "
      "sonst wb-belegung verlaengern.")
' 2>/dev/null
exit 0
