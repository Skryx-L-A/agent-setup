---
# Vorlage für ein SYSTEM: Maschine, Dienst oder Werkzeug (peer, Mac, Forgejo, Brain-Dienst, Splash).
# Eine kanonische Seite je System: wo es läuft, wie man es erreicht, was es tut, wer es pflegt.
# Veraltet schneller als andere Seiten (Prüfschwelle 2 Monate): stand pflegen. Diesen Kommentarblock löschen.
id: "{{ulid}}"   # ULID, einmal vergeben, nie ändern (Erzeugung: siehe note.md)
schema: 4
title: "{{title}}"   # der Name, unter dem das System gesucht wird
type: system
class: knowledge
created: "{{date}}"
stand: "{{YYYY-MM}}"
beleg: gemessen     # gemessen | berichtet; Systemangaben nur mit Belegen aus dem Lauf
review-after: "{{YYYY-MM}}"   # bei Systemen setzen, höchstens 3 Monate
# aliases: []       # Kurznamen, alte Namen, Hostnamen
# tags: []
---

Für künftige Sessions: <wann man dieses System braucht, z.B. bei welcher Frage>

## Was und wo
- **Art:** <Maschine | Dienst | Werkzeug>
- **Läuft auf:** <Host, Port, Pfad (mit `~/`, maschinengebunden kennzeichnen: "nur macOS", "peer")>
- **Zugang:** <wie man hinkommt; nie Geheimnisse, nur Zeiger auf secrets>
- **Zuständig:** <wer es pflegt>

## Verhalten und Grenzen
<was es tut, was nicht, bekannte Fallen mit Verweis auf pitfall-Notizen>

<!-- part-of [[Projekt-KERN]] | depends-on [[anderes-System]] | relates-to [[pitfall-note]] -->
