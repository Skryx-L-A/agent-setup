---
name: "source-command-budget"
description: "Zeigt Token-/Limit-Verbrauch (5h/Woche, Trend, Hochrechnung) via wb-budget."
---

# source-command-budget

Use this skill when the user asks to run the migrated source command `budget`.

## Command Template

Fuehre `~/.local/bin/wb-budget` aus mit dem verfügbaren Shell-Werkzeug und berichte die abgefragten Werte samt Fenster/Quelle. Ist das Werkzeug nicht installiert, nutze die native Verbrauchsabfrage, sofern vorhanden; sonst melde die fehlende Messmöglichkeit.

Kein Zahlen-Erfinden: gib genau wieder, was das Skript ausgibt, inklusive jeder
"nicht verfuegbar"-Zeile. Fuege keine eigene Kosten-/Prozent-Schaetzung hinzu, die das
Skript nicht selbst geliefert hat.
