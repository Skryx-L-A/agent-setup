# maschinen

Auslöser: bevor etwas auf der anderen Maschine läuft (`ssh peer`, `run-on`, Offload,
Maschinenwechsel), ein Projekt dorthin geroutet wird oder dort orchestriert wird, und
bevor Worker der anderen Maschine sichtbar gemacht werden. Die Konfliktregel beim
Ressourcenstreit steht weiter unten in dieser Datei, im Abschnitt Cross-Machine Compute.

Stand der Gliederung: 2026-09-12. Vor der Handlung die passenden Abschnitte unten lesen,
keine Volllektüre aller Referenzen. Die bisherigen Inhalte sind wortgetreu ausgelagert;
neuere ausdrückliche Entscheidungen ersetzen ältere abweichende Absätze.
Für Prüfbedarf gilt immer `~/.claude/regeln/verifikation.md`: keine automatische Doppelprüfung.

**Modelle der anderen Maschine nur nach Absprache (der Nutzer, 2026-09-14).** peer startet oder
benutzt keine Modelle auf dem Mac (weder Ollama/MLX über Tunnel noch `ssh mac`/`run-on mac`),
außer der Nutzer stimmt dem konkreten Einsatz vorher zu; peer startet Modelle bei sich selbst. Das
ersetzt für diese Richtung das automatische best-fit-Routing in „Cross-Machine Compute". Anlass:
der seit 19.07. dauerhaft aktive `mac-ollama-tunnel.service` auf peer lud nach einem Mac-Neustart
`ornith:35b-256k` (24 GB) neben qwen38; der Dienst ist seit 14.09. gestoppt und deaktiviert.

## Abschnitte

- [regeln/maschinen.md](references/maschinen/00.md)
- [Standing grants — Maschinen](references/maschinen/01.md)
- [Aus der Orchestrator-Rolle ausgelagert (2026-08-03)](references/maschinen/02.md)
- [Worker der anderen Maschine sichtbar machen](references/maschinen/03.md)
- [Peer-Rechner — zweite Live-Maschine (Zugang + Projekt-Routing: oben in dieser Datei)](references/maschinen/04.md)
- [Cross-Machine Compute — Ressourcen-Check + best-fit Routing (2026-07-19)](references/maschinen/05.md)
- [Text mit Backticks nie durch eine Shell-Ebene schicken (2026-07-30)](references/maschinen/06.md)
- [Die Electron-Werkbank auf peer vom Mac aus neu starten (2026-09-08, gemessen)](references/maschinen/07.md)
- [Modell-Registry: geteilt und lokal (2026-09-10, Entscheidung des Nutzers per Frage)](references/maschinen/08.md)

Erhaltungsnachweis: `references/maschinen/manifest.json` enthält Reihenfolge und SHA-256
aller Abschnitte; ihre Verkettung ergibt die vollständige vorherige Datei.
