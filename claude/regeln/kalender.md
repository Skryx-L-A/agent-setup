# Kalender – wie ein Termin eingetragen wird

Ausloeser: Du traegst etwas in Apple Kalender ein oder aenderst einen Eintrag.

**Zeit und Ort gehoeren in den Termin, sobald sie feststehen (2026-09-07, Anweisung des Nutzers:
„wenn eine bestimmte zeit und ort neben dem datum für die termine schon feststeht, trage beides
direkt mit ein").** Ein Ganztagestermin ist nur richtig, wenn es wirklich keine Uhrzeit gibt –
eine Frist, ein Semesterbeginn, ein Selbstlernkurs ohne Sitzungen. Sobald eine Veranstaltung
eine Anfangszeit hat, wird sie als Zeittermin angelegt, mit Ort im Ortsfeld.

Daraus folgen drei Handgriffe:

- **Eine mehrtaegige Veranstaltung mit taeglichen Zeiten wird zu mehreren Terminen**, einer je
  Tag, nicht zu einem ganztaegigen Block. Beispiel vom 07.09.2026: der Programmiervorkurs vom
  28.09. bis 02.10. mit 9-12 Uhr Vorlesung und 13-16 Uhr Uebung wurde als fuenf Tagestermine
  9:00-16:00 eingetragen, die Aufteilung steht in der Notiz.
- **Was nur online stattfindet, bekommt die Adresse ins Ortsfeld** (Moodle-Kurs, Meeting-Link),
  damit im Kalender steht, wohin man geht.
- **In die Notiz kommt, was am Termin haengt:** Buchungs- oder Bestellnummern, was mitzubringen
  ist, Kontodaten bei einer Zahlungsfrist. Fehlt eine Angabe noch, wird das dort vermerkt statt
  geraten.

## Mechanik, gemessen am 2026-09-07

- **Ueber alle Ereignisse eines Kalenders zu iterieren, haengt.** `repeat with e in (every event
  of fam)` lief bei einem gefuellten Familienkalender ueber zwei Minuten ohne Ergebnis und musste
  abgebrochen werden. Statt dessen filtert man in EINER Abfrage:
  `set location of (every event whose summary is "…") to "…"`. Das antwortet in Sekunden.
- **Ein `whose`-Filter ohne Treffer wirft Fehler -1728**, wenn direkt darueber iteriert wird.
  Erst in eine Variable holen, dann `count` pruefen.
- **Datumsangaben** baut man ueber den AppleScript-Ausdruck »current date« und setzt `day` auf 1, bevor `month` und `day`
  gesetzt werden – sonst laeuft der Monatswechsel ueber.
- Nach dem Schreiben wird gegengelesen: Titel, Startzeit und Ort je Termin einmal ausgeben, und
  auf Doppelungen achten.
