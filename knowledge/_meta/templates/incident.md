---
# Vorlage für einen VORFALL mit Postmortem (was schiefging, Ursache, Fix, Lehre). Für eine kurze Falle mit
# Gegenmittel pitfall.md nehmen. Kommentarblock beim Anlegen löschen.
id: "{{ulid}}"   # ULID, einmal vergeben, nie ändern (Erzeugung: siehe note.md)
schema: 4
title: "{{title}}"
type: incident
class: knowledge
created: "{{date}}"
stand: "{{YYYY-MM}}"
beleg: berichtet     # gemessen | berichtet
# branch: 20-projects/<project>   # optional, aus dem Pfad ableitbar
---

Für künftige Sessions: <wann dieser Incident relevant wird — z.B. bei ähnlichem Symptom>.

## Postmortem
- **Was schiefging:** <Symptom, Auswirkung, Zeitpunkt>
- **Ursache:** <Root Cause>
- **Fix:** <was konkret behoben hat>
- **Lehre:** <was künftig anders gemacht wird, welche Standing Rule daraus folgt>

<!-- relates-to [[Projekt-MOC]] | relates-to [[Standing-Rule-Note]] -->
