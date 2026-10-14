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
denselben relevanten Stand genügt. Dieser Gesamtlauf muss vollständig grün sein: kein roter,
kein übersprungener Test; „einzeln grün" ersetzt das nicht. Tests werden nicht gelöscht oder
abgeschaltet, um grün zu werden; die Ursache wird behoben, ein fehlerhafter Test darf
berichtigt werden (der Nutzer, 2026-09-20). Routineänderungen erzeugen keine Pflichtprüfschleife.
Während eines Gesamtlaufs committet keine Sitzung in den geprüften Arbeitsbaum, auch keine Doku oder
Standdatei: Ein Test prüft, dass der echte Baum unberührt bleibt (2026-10-09, Gesamtlauf rot durch
einen SESSION-STATE-Commit einer anderen Sitzung). Seit 2026-10-09 trägt sich `run-all.sh`
selbst auf der Tafel ein (Plätze mac-suite und hauptbaum:<repo>); der Commit-Hook bricht dann Commits
von Agenten in diesen Baum ab, Orchestratoren brauchen `wb-tafel trotzdem`, der Mensch wird gewarnt.

## Abschnitte

- [regeln/tests-und-eingriffe.md](references/tests-und-eingriffe/00.md)
- [Standing rules — Tests und Eingriffe](references/tests-und-eingriffe/01.md)
- [Die eigene Testsuite laufen lassen](references/tests-und-eingriffe/02.md)
- [Ein tmux-Testserver erbt die Umgebung des SERVERS, nicht des Aufrufers (2026-09-05)](references/tests-und-eingriffe/03.md)

Erhaltungsnachweis: `references/tests-und-eingriffe/manifest.json` enthält Reihenfolge und SHA-256
aller Abschnitte; ihre Verkettung ergibt die vollständige vorherige Datei.
