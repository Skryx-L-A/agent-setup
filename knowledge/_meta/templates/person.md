---
# Vorlage für eine PERSON (Mini-CRM): Rolle, Organisation, Kontext, letzter Stand. Notizen von ein Mitnutzer
# ändert kein Agent vom Nutzer. Kommentarblock beim Anlegen löschen.
id: "{{ulid}}"   # ULID, einmal vergeben, nie ändern (Erzeugung: siehe note.md)
schema: 4
title: "{{name}}"
type: person
class: knowledge
role: "{{rolle}}"
organisation: "{{organisation}}"
created: "{{date}}"
stand: "{{YYYY-MM}}"
beleg: berichtet     # gemessen | berichtet
---

Für künftige Sessions: <wann diese Person relevant wird>.

## Mini-CRM
- **Rolle:** {{rolle}}
- **Organisation:** {{organisation}}
- **Kontext:** <wie/warum kennengelernt, welche Beziehung>
- **Letzter Stand (Stand: {{YYYY-MM}}):** <letzter bekannter Status/Kontakt>

<!-- relates-to [[Projekt-MOC]] | relates-to [[andere Person]] -->
