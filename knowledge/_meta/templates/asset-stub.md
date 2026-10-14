---
# Vorlage für den STUB einer Binärdatei in <branch>/_assets/ (Graph-Node, über den die Datei auffindbar
# ist). Regeln: Vault Git-LFS Policy. Kommentarblock beim Anlegen löschen.
id: "{{ulid}}"   # ULID, einmal vergeben, nie ändern (Erzeugung: siehe note.md)
schema: 4
title: "{{title}}"
type: asset
class: knowledge
path: _assets/{{filename}}   # relativ zum Branch-Ordner
mime: "{{mime-type}}"          # z.B. application/pdf, image/png
source: "{{herkunft}}"         # woher die Datei kommt (URL, wer sie geschickt hat, Export-Quelle)
created: "{{date}}"
stand: "{{YYYY-MM}}"
beleg: berichtet     # gemessen | berichtet
---

Für künftige Sessions: <wann diese Datei geöffnet werden sollte>

<!-- Body: kurze Beschreibung des Inhalts (was ist drin, worum geht's). -->

<!-- Für künftige Sessions: wann öffnen -->
<!-- z.B. "nur bei Vertragsdetail-Fragen zu X öffnen, sonst reicht diese Stub-Note" -->

<!-- Wikilinks zu Projekt/Topic, zu denen dieses Asset gehört: -->
<!-- part-of [[Projekt-MOC]] | relates-to [[Topic-MOC]] -->

<!-- Die Datei selbst wird nur bei Bedarf gelesen — diese Stub-Note ist der
     Graph-Node, über den das Asset auffindbar und verlinkbar ist. -->
