# regeln/wissensspeicher.md

Auslöser: vor nichttrivialer Arbeit (Suche), vor Arbeit in einem Projekt (KERN), bei der
Nachbereitung einer Session (Ablage) und vor Vault-Filing-Delegation. Stand: 2026-09-23.
Die Mechanik (Suche, Schichten, Schreiben, Git, Maschinen) steht maßgeblich in
`~/Knowledge/AGENTS.md`; hier stehen nur die Hausregeln dazu. Frühere Fassung:
`~/.local/trash-snapshots/2026-09-23-vault-anweisungen/wissensspeicher.md`.

## Suchen, bevor gearbeitet wird

- `brain search "<frage>" -k 5` vor jeder nichttrivialen Aufgabe (2026-07-29), besten Treffer
  öffnen und ausweiten, bis die Antwort keine Lücke mehr hat. Nie den ganzen Korpus laden.
  `INDEX.md` ist der Katalog, `rg` nur für exakte Zeichenketten.
- Im Projekt zuerst `20-projects/<projekt>/KERN.md` beachten: geltende Entscheidungen und
  bekannte Fallen (2026-09-23, Anlass: wiederholte Fehler und vergessene Entscheidungen in
  ProjectX). Der SessionStart-Hook spielt sie ein, wenn der Arbeitsordner zugeordnet ist.

## Ablegen nach der Arbeit

- Nach jeder Session mit dauerhaftem Wissen (Entscheidung, Setup, Fix, Regel, Messung): eine
  destillierte, verlinkte Notiz im richtigen Branch. Nicht optional.
- Entscheidungen und wiederholbare Fehler eines Projekts zusätzlich in dessen `KERN.md`
  (Abschnitte „Gilt" / „Nie wieder", mit Quelle); nicht mehr Geltendes dort streichen.
- **Vault-Filing macht immer der Orchestrator selbst** (der Nutzer, 2026-07-27): nie an einen
  Worker delegieren, auch nicht bei knappem Kontingent oder großem Manifest. Wer die Session
  geführt hat, kennt Zusammenhänge und Widersprüche; ein Worker legt nur ab, was im Manifest
  steht. Worker dürfen Entwürfe und Analysen liefern, abgelegt wird vom Orchestrator.
- Kein passendes Thema in `30-topics/`: selbst eines eröffnen, ohne Rückfrage (2026-07-29).
- Vault nach sinnvollen Änderungen committen und pushen (Push nur Hauptagent); ein nicht
  committeter sinnvoller Stand am Sessionende ist ein Fehler.
- Auto-Memory bleibt minimal: Dauerwissen in den Vault, Memory zeigt höchstens dorthin.
