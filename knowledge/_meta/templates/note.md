---
title: "{{title}}"
type: note        # note | decision | reference | session | secret | report | asset | person | incident
branch: 10-global # 10-global | 20-projects/<project> | 30-topics/<topic>
tags: []
created: "{{date}}"
aliases: []       # optional: alternative Namen/Schreibweisen, unter denen die Note gefunden werden soll
beleg: berichtet  # gemessen | berichtet — nur diese zwei Werte; siehe unten
review-after: "{{YYYY-MM}}"  # optional: Monat, ab dem der Inhalt auf Aktualität geprüft werden sollte
related: []       # optional: Array von Wikilink-Zielen, z.B. [[note-a]], [[note-b]]
---

Für künftige Sessions: <wann diese Note relevant ist>

<!-- Body. Link liberally with typed wikilinks: -->
<!-- relates-to [[note]] | depends-on [[note]] | supersedes [[note]] | part-of [[note]] | contradicts [[note]] -->

<!-- Recency-Marker: jede wichtige, zeitabhängige Behauptung mit "Stand: YYYY-MM"
     kennzeichnen, damit künftige Sessions das Alter der Info sofort sehen. -->

<!-- beleg: gemessen | berichtet — der epistemische Status der Note als eigenes Feld.
     `gemessen` heißt: die zentralen Aussagen beruhen auf Zahlen, die jemand erhoben hat.
     `berichtet` heißt alles andere — gesagt, entschieden, beobachtet, aus einer Quelle
     übernommen. Im Zweifel `berichtet`.
     Warum als Feld und nicht im Fließtext: als benanntes Feld überlebt die Angabe eine
     Zusammenfassung deutlich besser (arXiv 2608.06953, 07.08.2026, rund 15 Prozentpunkte).
     "Gemessen am 06.08." mitten im Satz wird von der dritten Zusammenfassung zu "gilt".
     Warum nur zwei Werte: ein Feld mit fünf Abstufungen pflegt niemand, und ein
     ungepflegtes Feld sieht aus wie eine Aussage über die Belegstärke und ist keine.
     Der Traum füllt es bei seinen eigenen Seiten selbst aus; der Lint fordert es NUR
     dort ein. Bestehende handgeschriebene Notizen werden nicht nachträglich umgeschrieben. -->

<!-- Zwei Note-Klassen:
     - Session-/Quell-Notes (type: session, oder Rohmaterial aus 00-sources): IMMUTABLE
       Archiv. Nie nachträglich umschreiben — neue Erkenntnisse gehen in eine neue
       Session-Note oder in eine Themen-Note, die darauf verlinkt.
     - Themen-/Fakten-Notes (type: note/reference/decision, alles in 10-global und
       20-projects/<p>/ außer Session-Notes): REWRITE-OVER-APPEND. Bei neuem Wissen
       den bestehenden Text umschreiben statt anhängen; Widersprüche im Fließtext
       auflösen (alte Aussage korrigieren/streichen), nicht als Nachtrag stehen lassen. -->

<!-- Spezial-Typen (Brain 3.0, eigene Templates):
     - type: asset — Stub-Note pro Binärfile in <branch>/_assets/. Siehe _meta/templates/asset-stub.md.
     - type: person — Mini-CRM für Kontakte. Siehe _meta/templates/person.md.
     - type: incident — Postmortem (was schiefging/Ursache/Fix/Lehre). Siehe _meta/templates/incident.md.
     - Themen-Hubs leben in 30-topics/<thema>/MOC.md. Siehe _meta/templates/topic-moc.md. -->

<!-- aliases: [] — alternative Bezeichnungen, unter denen Suche/Gardener diese Note
     finden soll (z.B. Abkürzungen, frühere Namen).
     review-after: YYYY-MM — optionaler Monat, ab dem Inhalt geprüft werden sollte
     (z.B. bei zeitlich befristeten Entscheidungen oder sich schnell ändernden Fakten). -->

<!-- related: [] — OPTIONAL Array expliziter Wikilink-Ziele (z.B. related: ["[[shared-brain]]", "[[peer-remote-access]]"]).
     Ergänzt, ERSETZT NICHT die typisierten Inline-Wikilinks im Fließtext (relates-to/
     depends-on/supersedes/part-of/contradicts) — die bleiben Pflicht für Beziehungen,
     die eine Bedeutung tragen. `related:` ist nur eine flache, maschinenlesbare
     Zusatzliste für schnelles Auffinden verwandter Notes ohne den Body zu parsen; leer
     lassen oder weglassen ist genauso gültig wie bei bestehenden 215 Notes ohne dieses
     Feld. -->
