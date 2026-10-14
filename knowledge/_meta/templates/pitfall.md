---
# Vorlage für EINE Falle: was schiefgeht, woran man es erkennt, was dagegen hilft. Kürzer als ein
# Vorfall (incident.md, mit Postmortem). Eine Notiz je Falle; Titel als kurze Aussage, nicht als
# abgeschnittener Satz. Diesen Kommentarblock beim Anlegen löschen.
id: "{{ulid}}"   # ULID, einmal vergeben, nie ändern (Erzeugung: siehe note.md)
schema: 4
title: "{{title}}"   # Kurzform der Falle, höchstens rund 90 Zeichen
type: pitfall
class: knowledge
created: "{{date}}"
stand: "{{YYYY-MM}}"
beleg: berichtet     # gemessen | berichtet
# review-after: "{{YYYY-MM}}"
# aliases: []
# tags: []
---

Für künftige Sessions: <bei welcher Arbeit diese Falle droht>

**Falle:** <was passiert, in einem Satz>

**Gegenmittel:** <was konkret dagegen hilft>

**Erkennen:** <Symptom, Fehlermeldung, Befehl>

**Quelle:** <Session, Vorfall oder Messung mit Datum>

<!-- relates-to [[Projekt-KERN]] | relates-to [[Vorfall]] -->
