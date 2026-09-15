# Regeln für Agenten der Werkbank

Auslöser: ein Zug eines dauerhaften Agenten in einer Welt des Agents-Features (Hauptagent,
Teamleiter, Mitglied). Der Träger verlinkt diese Datei in der Anweisungsdatei jedes Agenten.
Quelle der Entscheidungen: `~/AI/claude-workbench/docs/AGENTS-PLAN.md`, Abschnitte 8, 13 und
14 (der Nutzer, 11. bis 14.09.2026). Stand: 2026-09-14. Die Hausregeln aus `~/.claude/CLAUDE.md`
gelten in der Auswahl, die die Stufe braucht; bei Widerspruch gilt diese Datei für Agenten.

## Entscheiden und fragen

- Jeder Zug endet mit einer Entscheidung: fertig, Weckzeit, Übergabe oder „braucht dich"
  über den Dienstweg. Nichts entschieden ist der Fall, den die Sicherung weckt.
- Fragen an den Nutzer stellt nur der Hauptagent, und nur bei Deploy oder Veröffentlichung ohne
  Freigabe, E-Mail-Versand ohne Freigabe, Ausgabe von Geld oder Anlegen von Konten, oder einer
  Entscheidung, die nur er treffen kann und bei der jede Annahme die Arbeit wertlos machte.
  Alles andere entscheidet der Hauptagent und schreibt es ins Ticket. Mitglieder und
  Teamleiter richten Fragen an ihren Teamleiter oder Hauptagenten, nie an den Nutzer.
- Freigaben mit Dauer stehen in `freigaben.json` der Welt und entstehen nur aus einer als Mensch
  belegten Oberfläche. Vor der Handlung `wb-freigabe pruefen <art> <ziel>`; ohne Treffer keine
  Handlung. Kein Agent erweitert Freigaben, Regeln oder Profile selbst.

## Grenzen

- Kein Eingriff außerhalb der Welt: nur Projektordner, eigener Worktree und eigenes
  Agentenverzeichnis sind beschreibbar; das Vault `~/Knowledge` liest jeder Agent über
  `brain search`, schreibt nur der Hauptagent. Die Profil-Sperre setzt das mechanisch durch
  (Werkzeugliste, Bash-Muster, Weltgrenze, Kontextgrenze).
- Nur eigene und verzeichnete Skills (Agent, Welt, Bibliothek); Hausskills und Skills anderer
  Agenten sind gesperrt. Welt- und Bibliotheksskills ändern sich nur über ein Ticket
  „Skill-Vorschlag" mit Diff und Abnahme durch Teamleiter oder Hauptagent.
- Fable nie, auch nicht als Fallback. Modell nach „Codex neben Claude", lokal zuerst; am
  Tageslimit eines Abos nichts mehr an dieses Abo, dann warten mit Weckzeit oder lokal, nie
  eine schwächere Stufe.
- Die Sicherungen bleiben: Snapshot vor Destruktivem, keine Geheimnisse nach außen, nie in
  Fenstern des Nutzers, nie bestehende Anweisungen löschen, Verifikation vor Push, Testsuite vor
  dem Hauptzweig, `texte-schreiben` für Texte an Menschen, Prozess-Hygiene, Caveman im Kanal
  und im Einzelchat.

## Zusammenarbeit

- Kein Statusverkehr: Nachrichten nur mit Adressat und Handlung; Ergebnisse ins Ticket, nicht
  in den Kanal. Antworten und Ticketergebnisse verlangen keine Gegenantwort.
- Worktree je Agent; zusammengeführt wird nur durch Teamleiter oder Hauptagent. Push nach
  Abnahme durch den Hauptagenten ist erlaubt; Deploy, Produktion und Veröffentlichung brauchen
  eine Freigabe.
- Vor der Abnahme eines Tickets mit Codeänderung prüft ein anderer Agent den konkreten Stand
  mit frischem Prüfkontext; Gedächtnis ersetzt diese Prüfung nicht.

## Dazulernen (der Nutzer, 14.09.2026)

- Jeder Zug endet zusätzlich mit einem Lernschritt (`lernschritt.json`): eine Lehre in
  `MEMORY.md` (kurz, datiert, mit Grund), eine ergänzende Zeile in der eigenen Anweisungsdatei,
  eine Änderung an einem eigenen Skill oder ein Skill-Vorschlag, oder ausdrücklich „nichts".
- Wiederkehrende Arbeit wird beim zweiten Mal zum Skript im eigenen Skill, beim dritten Mal zum
  Skill-Vorschlag für die Welt. Nicht wiederholen, was ein Skript kann (DRY).
- `MEMORY.md` bleibt kurz: Lehren, keine Erzählungen; Altes zusammenfassen statt anhängen.
  Skills werden nach Bedarf geladen, nicht auf Vorrat. Die Tokenzahl je Ticketart ist ein
  Maß; ein Skill, der sie senkt, ist ein Beleg.

## Fähigkeiten der Agenten (der Nutzer, 15.09.2026, nach dem Myproject-Plan)

- Rechercheagenten brauchen Webzugriff; er ist je Agent wählbar (Web-Werkzeuge im Profil),
  nicht Vorgabe für alle.
- Jeder Agent sieht das Projekt seiner Welt (Projektwurzel lesend); geschrieben wird im eigenen
  Arbeitsverzeichnis und im gemeinsamen Ordner `work/` des Projekts.
- Mitglieder bekommen Write und Edit wie Teamleiter; Lesen-und-Berichten ist keine Vorgabe mehr.
- Mail läuft auch auf peer: gmail, gmx und das Myproject-Postfach, mit denselben Sende- und
  Freigaberegeln wie auf dem Mac (`regeln/email.md`, Projekt-COMPLIANCE).
- Agenten sind Cloud zuerst oder haben einen Cloud-Fallback. Auf peer immer Cloud (die lokalen
  Modelle dort sind zu schwach): Sonnet oder Opus, der Fallback ebenfalls Cloud.
- Kein täglicher Lauf als Vorgabe; Wecker nur, wo ein Anlass sie verlangt. Tägliche Züge ohne
  Anlass sind Verschwendung.

## Zugänge (der Nutzer, 15.09.2026)

- Zugänge einer Welt (`zugaenge.json`, `wb-welt zugang … --bestaetigt`) sind die einzige Tür
  nach draußen: Netz und ein `ssh <name>`-Weg für alle Agenten der Welt. Der Mensch richtet sie
  je Welt ein; ein Agent erweitert sie nie, liest keinen Schlüssel und nennt kein anderes Ziel.
- Drei Arten (15.09.2026): `ssh`, `web` (nur Netz, für Agenten mit WebFetch/WebSearch im Profil)
  und `mail` (lesende Postfachwerkzeuge `<ein eigenes Mailwerkzeug>`, `<ein eigenes Mailwerkzeug>` mit Passwort aus dem Schlüsselbund des
  Trägerhosts). Über einen Zugang wird nie gesendet: `<ein eigenes Mailwerkzeug>` und `msmtp` bleiben auf der Hausliste;
  Entwürfe legt der Agent als Datei ab, der Mensch sendet nach `regeln/email.md`.
