# lokale-modelle

Auslöser: bevor ein lokales Modell gestartet, gewechselt oder eingeplant wird.

Stand der Gliederung: 2026-09-12. Vor der Handlung die passenden Abschnitte unten lesen,
keine Volllektüre aller Referenzen. Die bisherigen Inhalte sind wortgetreu ausgelagert;
neuere ausdrückliche Entscheidungen ersetzen ältere abweichende Absätze.
Für Prüfbedarf gilt immer `~/.claude/regeln/verifikation.md`: keine automatische Doppelprüfung.

Aktueller Betriebsstand: Ressourcen vor Modellstart prüfen, nur ein großes Modell zugleich,
keine fremde Belegung verdrängen. Worker-Gespräche nach dem Abschnitt vom 10.09. über
mlx_lm.server mit Prompt-Cache; MTP-/APC-Messungen anderer Betriebsarten nicht darauf übertragen.
Maschinen unterscheiden: MLX gehört zu Apple Silicon, Peer-Rechner hat eigene Motoren und Speichergrenzen.
Ein Modell oder eine Fähigkeit zählt erst, wenn der aktuelle Endpunkt sie tatsächlich bereitstellt.

## Abschnitte

- [regeln/lokale-modelle.md](references/lokale-modelle/00.md)
- [So wird qwen38 benutzt – der ganze Handgriff (Stand 2026-09-01)](references/lokale-modelle/01.md)
- [Local model standards (2026-07-12) — orchestrator + all agents](references/lokale-modelle/02.md)
- [Immer nur EIN Modell gleichzeitig (2026-08-18, Anweisung des Nutzers)](references/lokale-modelle/03.md)
- [Speicher, Kontext und Denken bei MLX-Modellen (2026-08-19, Vorgaben des Nutzers)](references/lokale-modelle/04.md)
- [Auf peer gelten zwei der vier Hausentscheidungen ANDERS (gemessen 2026-09-01)](references/lokale-modelle/05.md)
- [`grug` – Messwerte und Betrieb (hierher verschoben 2026-08-28)](references/lokale-modelle/06.md)
- [Worker-Gespraeche laufen ueber mlx_lm.server, nicht ueber den MTP-Kopf (2026-09-10, live gemessen)](references/lokale-modelle/07.md)
- [Werkzeugparser von mlx-lm und mlx-vlm braucht den Nachsicht-Patch (2026-09-10, gemessen)](references/lokale-modelle/08.md)
- [Ein pi-Worker bleibt nie an einer Ankündigung stehen (2026-09-10)](references/lokale-modelle/09.md)

Erhaltungsnachweis: `references/lokale-modelle/manifest.json` enthält Reihenfolge und SHA-256
aller Abschnitte; ihre Verkettung ergibt die vollständige vorherige Datei.
