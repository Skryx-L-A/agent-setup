# regeln/wissensspeicher.md

Inhalt: Knowledge base `~/Knowledge`, vollständiger Abschnitt aus CLAUDE.md. Gilt seit: 2026-07-10.
Ausgelagert aus `~/.claude/CLAUDE.md` am 2026-08-17, weil die Datei an ihrer Größengrenze stand.
Diese Datei ist ausgelagert aus CLAUDE.md; sie gilt unverändert weiter.

Auslöser: bevor Du im Vault `~/Knowledge` suchst, etwas darin ablegst, ein neues Thema
eröffnest oder das Vault-Filing delegieren willst — also vor jeder nicht-trivialen Aufgabe
(Suchleiter) und vor jeder Session-Nachbereitung (Session-Note). Der Merksatz bleibt im
SessionStart-Hook: `brain search "<frage>" -k 5` vor Tasks, Note nach Sessions.

## Knowledge base `~/Knowledge` — brain always updated, no knowledge loss (2026-07-10)

Single source of truth (markdown vault; INDEX.md explains the layout).
- **Suchleiter — vor jeder nicht-trivialen Aufgabe (2026-07-29):**
  1. **`brain search "<frage>" -k 5`** — Hybridsuche (BM25 + Embeddings, lokal, ~0,3 s). Das ist
     die vorgeschriebene Suche. `rg` ist der Notnagel für exakte Zeichenketten (Dateiname,
     Fehlermeldung, Bezeichner), nicht für Fragen. Wer grept statt zu suchen, findet nur, was er
     wörtlich erraten hat.
  2. Findet die Suche nichts Brauchbares: `~/Knowledge/INDEX.md` (Katalog, ~120 Zeilen) sagt, wo
     das Thema überhaupt liegen müsste, und der Branch wird gezielt durchgesehen.
  3. Besten Treffer öffnen, **dann so weit ausweiten, wie die Antwort noch Lücken hat** — eine
     unvollständige Antwort kostet mehr als die zweite Datei. Themenseiten aus `30-topics/` sind
     verdichtet, aber ABGELEITET: bei Entscheidung, Zahl oder Zusage gilt die Quellnotiz. Voller
     Wortlaut der Leiter: `INDEX.md`.
  4. Antworten, mit Angabe, worauf die Antwort beruht. Nie den ganzen Korpus laden — abfragen.
- **Themen wachsen automatisch (2026-07-29):** wer etwas ablegt, das zu keinem bestehenden
  `30-topics/`-Thema gehört, eröffnet selbst eins, ohne Rückfrage. Verfahren: `INDEX.md`.
- **Vault-Filing macht IMMER der Orchestrator selbst (2026-07-27, Anweisung des Nutzers):** das
  Ablegen im Vault wird NIE an einen Worker delegiert — nicht an `haiku45`, nicht an einen
  lokalen pi-Worker, auch nicht bei knappem Kontingent oder großem Harvest-Manifest. Wer die
  Session geführt hat, kennt die Zusammenhänge und die Widersprüche zu bestehenden Notes; ein
  billiger Worker legt nur ab, was im Manifest steht, und der Rest fällt still weg. Ersetzt die
  frühere Delegationsregel im `session-end`-Skill.
- **After** every session that produced durable knowledge (decisions, setups, fixes, rules,
  credentials-pointers): ONE distilled, linked session note in the right branch
  (`20-projects/<project>/` or `10-global/`), via `templates/note.md`, typed wikilinks. Not optional.
- Vault stays committed and pushed to the private remote (<your-github-user>/knowledge-vault) after
  meaningful changes; uncommitted vault state at session end is a bug. Git snapshot before risky
  vault operations.
- Auto-memory bleibt minimal: Dauerwissen in den Vault, Memory zeigt höchstens dorthin.
