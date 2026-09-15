# tests-und-eingriffe

Auslöser: bevor ein Test geschrieben oder ausgeführt wird, der die Live-Umgebung, eine
laufende tmux-Session, ein Fenster vom Nutzer, fremde Prozesse oder die Umgebung
(Ton, Kamera, Vollbild) berührt — und bevor eine fremde CLI mit Autonomie-Flags startet.

Stand der Gliederung: 2026-09-12. Vor der Handlung die passenden Abschnitte unten lesen,
keine Volllektüre aller Referenzen. Die bisherigen Inhalte sind wortgetreu ausgelagert;
neuere ausdrückliche Entscheidungen ersetzen ältere abweichende Absätze.
Für Prüfbedarf gilt immer `~/.claude/regeln/verifikation.md`: keine automatische Doppelprüfung.

Vor einem nötigen Test die einschlägigen Isolationsregeln lesen: eigenes Testverzeichnis,
eigene Sockets/Ports, keine Nutzersitzung oder Nutzerfenster, keine fremden Prozesse.
Vor Push nach main ist eine vollständige Suite erforderlich; ein bestandener Lauf für
denselben relevanten Stand genügt. Routineänderungen erzeugen keine Pflichtprüfschleife.

## Abschnitte

- [regeln/tests-und-eingriffe.md](references/tests-und-eingriffe/00.md)
- [Standing rules — Tests und Eingriffe](references/tests-und-eingriffe/01.md)
- [Die eigene Testsuite laufen lassen](references/tests-und-eingriffe/02.md)
- [Ein tmux-Testserver erbt die Umgebung des SERVERS, nicht des Aufrufers (2026-09-05)](references/tests-und-eingriffe/03.md)

Erhaltungsnachweis: `references/tests-und-eingriffe/manifest.json` enthält Reihenfolge und SHA-256
aller Abschnitte; ihre Verkettung ergibt die vollständige vorherige Datei.
