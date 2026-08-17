# Beispielprojekt — Anweisungen fuer Agenten

Diese Datei sagt dasselbe wie `projekt-CLAUDE.md` daneben, nur unter dem Namen, den Codex, aider,
opencode und die uebrigen Harnesses beim Start lesen. Wer beide Namen bedient, kommt an einer
Kopie nicht vorbei — jedes dieser Programme liest genau eine Datei und keine zweite.

Die GLOBALEN Anweisungen musst Du dafuer nicht abschreiben: `wb-instructions sync` legt aus
`~/.claude/CLAUDE.md`, den beiden Rollendateien und dem Verzeichnis der Skills je Harness eine
Datei unter dem Namen an, den dieser Harness erwartet. Ein zweiter Lauf ist wirkungslos, solange
sich nichts geaendert hat, und eine von Hand bearbeitete Zieldatei wird gemeldet statt
ueberschrieben. Nur die PROJEKT-Regeln — die hier — schreibst Du selbst.

## Was das hier ist

Ein HTTP-Dienst, der Messreihen entgegennimmt und sie nach SQLite schreibt. Python 3.12, FastAPI,
kein ORM. Ein einziger Prozess, kein Cluster.

## Bauen und pruefen

```bash
uv sync
uv run pytest            # 214 Tests, etwa 40 Sekunden
uv run ruff check .
uv run uvicorn app:api --reload
```

Ein Commit ohne gruenen `pytest`-Lauf geht nicht raus.

## Regeln, die nur hier gelten

- Migrationen laufen nur vorwaerts. Kein `downgrade`; ein Fehler wird durch eine zweite Migration
  korrigiert.
- Zeitstempel immer UTC, immer mit Zeitzone. Ein naives `datetime` ist ein Fehler, kein Stil.
- Die Testdatenbank ist eine Datei im Temp-Verzeichnis, nie `:memory:`.
- Keine neue Abhaengigkeit ohne Rueckfrage.

## Ergebnisse

Jede abgeschlossene Aufgabe endet in einer Ergebnisdatei mit den drei Abschnitten WAS,
WIE-VERIFIZIERT und OFFEN. Unter WIE-VERIFIZIERT steht, was wirklich gelaufen ist, mit der
Ausgabe — ein uebersprungener Schritt wird genannt, nicht verschwiegen.
