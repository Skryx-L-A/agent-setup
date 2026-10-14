---
# Vorlage für EINE Entscheidung (ADR-artig): was gilt, seit wann, wer hat entschieden, was sie ablöst.
# Eine Notiz je Entscheidung. Neue Entscheidung ersetzt eine alte: die alte bekommt status: superseded
# und superseded-by, die neue supersedes; keine Notiz löschen. Diesen Kommentarblock beim Anlegen löschen.
id: "{{ulid}}"   # ULID, einmal vergeben, nie ändern (Erzeugung: siehe note.md)
schema: 4
title: "{{title}}"   # als Aussage formulieren, so wie später gefragt wird
type: decision
class: knowledge
created: "{{date}}"
stand: "{{YYYY-MM}}"
beleg: berichtet     # gemessen | berichtet
status: active       # active | superseded | archived
decided: "{{date}}"  # Tag der Entscheidung
decided-by: "{{wer}}"   # Person oder Gremium, z.B. der Nutzer
# supersedes: ["[[alte-entscheidung]]"]        # was diese Entscheidung ablöst
# superseded-by: ["[[neue-entscheidung]]"]     # nur wenn status: superseded
# review-after: "{{YYYY-MM}}"
# aliases: []
---

Für künftige Sessions: <wann diese Entscheidung relevant ist, z.B. bei welcher Frage>

## Entscheidung
<ein bis drei Sätze: was gilt>

## Grund
<warum, mit Beleg (Messung, Quelle) und verworfenen Alternativen>

## Folgen
<was dadurch verbindlich ist, was es ausschließt; wo die Entscheidung im Projekt-KERN.md steht>

<!-- relates-to [[Projekt-KERN]] | supersedes [[alte-entscheidung]] | depends-on [[...]] -->
