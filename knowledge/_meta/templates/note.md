---
# Vorlage für eine Wissensnotiz (type: note oder reference), Schema 4. Für Entscheidung, Falle, System
# und Begriff gibt es eigene Vorlagen (decision.md, pitfall.md, system.md, term.md), für Sitzungen
# sessions/, für Personen person.md, für Vorfälle incident.md. Diesen Kommentarblock beim Anlegen löschen.
id: "{{ulid}}"   # ULID, einmal vergeben, nie ändern. Erzeugen: python3 -c "import time,secrets;A='0123456789ABCDEFGHJKMNPQRSTVWXYZ';v=(int(time.time()*1000)<<80)|secrets.randbits(80);print(''.join(A[(v>>s)&31] for s in range(125,-1,-5)))"
schema: 4
title: "{{title}}"
type: note        # note | reference (belegte Sachaussage, Messung, Setup) — Arten mit eigener Vorlage: decision | pitfall | system | term | incident | person
class: knowledge  # source (Sitzung, Rohmaterial: nie umschreiben) | knowledge (umschreibbar) | derived (erzeugt, nie von Hand)
created: "{{date}}"
stand: "{{YYYY-MM}}"   # Monat, für den der Inhalt zuletzt geprüft wurde
beleg: berichtet  # gemessen | berichtet — nur diese zwei Werte; siehe unten
# optional:
# branch: 20-projects/<project>   # aus dem Pfad ableitbar, nur nötig wenn der Pfad es nicht sagt
# tags: []
# aliases: []       # alternative Namen/Schreibweisen, unter denen die Notiz gefunden werden soll
# review-after: "{{YYYY-MM}}"   # Monat, ab dem der Inhalt auf Aktualität geprüft werden sollte
# related: []       # flache Zusatzliste, z.B. ["[[note-a]]"]; ersetzt die typisierten Links im Text nicht
---

Für künftige Sessions: <wann diese Note relevant ist>

<!-- Body. Typisierte Wikilinks: relates-to [[note]] | depends-on [[note]] | supersedes [[note]]
     | part-of [[note]] | contradicts [[note]]. Kein `permalink:` (die Identität ist `id`),
     keine Claude-Memory-Felder (`name:`, `metadata:`), genau ein Frontmatter-Block. -->

<!-- Recency-Marker: jede wichtige, zeitabhängige Behauptung mit "Stand: YYYY-MM"
     kennzeichnen, damit künftige Sessions das Alter der Info sofort sehen. -->

<!-- beleg: gemessen | berichtet — der epistemische Status der Note als eigenes Feld.
     `gemessen` heißt: die zentralen Aussagen beruhen auf Zahlen, die jemand erhoben hat.
     `berichtet` heißt alles andere — gesagt, entschieden, beobachtet, aus einer Quelle
     übernommen. Im Zweifel `berichtet`.
     Warum als Feld: als benanntes Feld überlebt die Angabe eine Zusammenfassung deutlich
     besser (arXiv 2608.06953, 07.08.2026, rund 15 Prozentpunkte). "Gemessen am 06.08."
     mitten im Satz wird von der dritten Zusammenfassung zu "gilt".
     Warum nur zwei Werte: ein Feld mit fünf Abstufungen pflegt niemand. -->

<!-- Zwei Klassen:
     - class: source (Sitzungen unter sessions/, Rohmaterial aus 00-sources): unveränderliches
       Archiv. Nie umschreiben — neue Erkenntnisse gehen in eine neue Notiz, die darauf verlinkt.
     - class: knowledge (alles andere in 10-global, 20-projects/<p>/, 30-topics, 40-people):
       REWRITE-OVER-APPEND. Bei neuem Wissen den Text umschreiben statt anhängen; Widersprüche
       im Fließtext auflösen, nicht als Nachtrag stehen lassen.
     Der Pre-commit-Lint (git-hooks/notiz_lint.py) warnt bei fehlenden Pflichtfeldern
     id/schema/class/type, unbekanntem Typ und einer Klasse, die nicht zum Pfad passt. -->

<!-- Spezial-Typen mit eigener Vorlage:
     asset (asset-stub.md), person (person.md), incident (incident.md), decision (decision.md),
     pitfall (pitfall.md), system (system.md), term (term.md). Themen-Hubs: topic-moc.md. -->
