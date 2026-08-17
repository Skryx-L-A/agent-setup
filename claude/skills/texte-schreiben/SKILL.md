---
name: texte-schreiben
description: >-
  Wie ein Text formuliert wird, den ein Mensch liest. Verwende dieses Skill
  AUTOMATISCH und UNGEFRAGT für JEDEN Fließtext, der gelesen wird — jede Gattung,
  jedes Medium, ob er an den Nutzer geht oder an jemand anderen. E-Mails,
  Bewerbungen, Briefe, Nachrichten, Formularfelder, Dokumente, Berichte,
  Webseiten- und Oberflächentexte, README und Doku, Angebote, Beiträge,
  Präsentationen, Zusammenfassungen zum Vorlegen sind Beispiele und keine
  Abgrenzung: Im Zweifel gilt es. Eine Gattung, die hier nicht steht, ist nicht
  ausgenommen. Auch dann, wenn das Wort "Skill" nie fällt. Es steuert die
  FORMULIERUNG, nicht den Inhalt: Ton, Satzbau, Rhythmus, Typografie und die
  Muster, an denen Maschinentext erkannt wird. Gilt für Orchestrator und Worker.
---

# texte-schreiben

Ein Text, der nach Maschine klingt, wird gelesen wie einer, der nicht gemeint war. Das ist
kein Geschmacksurteil: Empfänger sortieren inzwischen aktiv aus — die Startup57-Anzeige vom
August 2026 sagt wörtlich, man werde „mit generischen mittelmässigen KI-Bewerbungen
überflutet". Der Preis für schlechte Formulierung ist nicht ein schwächerer Eindruck, sondern
gar keiner.

Dieses Skill sagt, wie formuliert wird. Was an Tatsachen im Text steht, entscheidet der
Auftrag; wo es eine Faktenbasis gibt, gilt sie (`material/profil/facts.yaml` bei Bewerbungen).

## Die zwei Regeln, die alles tragen

**1. Erst schreiben, dann messen, dann nachbessern.** Der Selbsteindruck taugt nicht: Ein
Text fühlt sich beim Schreiben flüssig an und trägt trotzdem jedes Merkmal. `pruefen.py` in
diesem Ordner zählt die mechanisch zählbaren Muster. Es ist ein Zähler, kein Urteil —
aber ein Wert außerhalb der Schwelle ist immer eine Stelle zum Nachsehen.

**2. Ein Text darf sich stoßen.** Das stärkste Gegenmittel ist ein konkretes Detail, das
niemand erfunden hätte: eine Zahl mit dem, was sie misst, ein Ort, ein Gerät, ein Fehlschlag.
Ein Absatz ohne so ein Detail ist ein Absatz, den jedes Modell geschrieben haben könnte.

## Ablauf

1. **Genre und Empfänger benennen.** Wer liest das, in welcher Stimmung, wie lange? Eine
   Bewerbung an ein überflutetes Postfach braucht einen anderen ersten Satz als ein Angebot
   an jemanden, der bereits gefragt hat.
2. **Anrede aus der Quelle übernehmen.** Duzt die Ausschreibung, wird zurückgeduzt. Steht ein
   Name da, wird er benutzt.
3. **Schreiben**, mit dem Aufbau, der zum Genre passt. Bei Bewerbungen und Anfragen:
   Anlass zuerst (die Stelle, an der er steht), dann das Gebaute mit Beleg, dann die eigenen
   Grenzen, dann eine konkrete Frage oder ein konkretes Angebot.
4. **`python3 pruefen.py <datei>` laufen lassen** und jeden Befund einzeln entscheiden.
5. **Vorlesen im Kopf.** Was man laut nicht sagen würde, streichen.

## Die Merkmale, an denen man Maschinentext erkennt

Vollständiger Katalog mit Beispielen und Ersatzformulierungen:
`reference/ki-marker.md`. Die sechs, die in der Praxis am häufigsten zutrafen:

| Merkmal | Warum es auffällt | Was stattdessen |
|---|---|---|
| Antithese „nicht X, sondern Y" | rhetorische Lieblingsfigur der Modelle, tritt gehäuft auf | höchstens einmal pro Text, sonst in zwei Aussagesätze auflösen |
| Ketten paralleler Verben („schneidet zu, wählt, verteilt, nimmt ab") | vier gleichgebaute Glieder schreibt kein Mensch am Stück | in einzelne Sätze zerlegen, Reihenfolge variieren |
| Essayistischer Aufhänger („Interessant wird es an der Stelle, an der …") | Aufsatzformel, kein Sprechdeutsch | direkt sagen, was war |
| Gestelzte Nominalisierung („Bei mir ist daraus Gebautes geworden") | Modelle nominalisieren, wenn ihnen ein Verb fehlt | Verb zurückholen: „Ich mache seit Monaten wenig anderes." |
| Geviertstrich — statt Halbgeviertstrich – | im deutschen Satz falsch, ein reines Maschinen-Artefakt | – mit Leerzeichen, und sparsam |
| Gleichförmige Satzlänge | menschliche Texte schwanken stark | kurze Sätze einstreuen, Spanne 5 bis 35 Wörter anstreben |

Dazu die Dauerverbote: keine Emojis, keine Superlative über sich selbst, keine Zahl ohne
Messung, keine Anbiederung an den Empfänger, keine Konjunktiv-Weichspüler („könnte ich mir
vorstellen", „wäre ich bereit"), keine Floskel-Schlüsse („über eine Rückmeldung würde ich
mich freuen", „abschließend lässt sich sagen").

## Selbstverbesserung — Pflicht, nicht Kür

**Jedes Mal, wenn der Nutzer eine Formulierung kritisiert, wird dieses Skill sofort und
ungefragt erweitert.** Seine Anweisung vom 03.08.2026. Auslöser ist jede Rückmeldung zur
Form: „die Formulierung stimmt nicht", „das klingt nach KI", „die Hinführung mag ich nicht",
„das ist widersprüchlich formuliert", „schöner machen" — auch wenn sie nur einen Halbsatz
betrifft.

So wird ergänzt:

1. Den Fall in `reference/ki-marker.md` unter dem passenden Muster eintragen, mit dem
   **Vorher** und dem **Nachher** im Wortlaut. Ein Muster, das es noch nicht gibt, bekommt
   einen eigenen Abschnitt.
2. Ist der Fall mechanisch zählbar, in `pruefen.py` aufnehmen.
3. Betrifft er die Tonlage grundsätzlich, in die Tabelle oben.
4. In einem Satz sagen, was ergänzt wurde.

Nicht sammeln und später nachtragen. Was nicht sofort in der Datei steht, ist beim nächsten
Text wieder weg.

## Was dieses Skill nicht regelt

Layout, Typografie im Satz, Seitenaufbau: `document-design`. Fakten, Belege und
Freigabe-Disziplin bei Bewerbungen: die Faktenbasis des Projekts. Dieses Skill hört bei der
Formulierung auf.
