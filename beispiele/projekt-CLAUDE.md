# Beispielprojekt — Projektregeln

Eine Datei wie diese liegt im Wurzelverzeichnis eines Projekts und wird zusaetzlich zu
`~/.claude/CLAUDE.md` gelesen. Hier steht nur, was FUER DIESES PROJEKT anders ist. Alles, was
ueberall gilt, gehoert in die globale Datei und nicht hierher doppelt.

## Was das hier ist

Ein HTTP-Dienst, der Messreihen entgegennimmt und sie nach SQLite schreibt. Python 3.12, FastAPI,
kein ORM. Ein einziger Prozess, kein Cluster.

## Wie hier gebaut und geprueft wird

```bash
uv sync                  # Abhaengigkeiten
uv run pytest            # 214 Tests, laeuft in etwa 40 Sekunden
uv run ruff check .      # Linter, muss sauber sein vor jedem Commit
uv run uvicorn app:api --reload
```

Ein Commit ohne gruenen `pytest`-Lauf geht nicht raus. Die Tests brauchen keine Datenbank und kein
Netz; wenn einer das doch tut, ist der Test falsch gebaut.

## Was hier anders ist als sonst

- **Migrationen laufen nur vorwaerts.** Es gibt kein `downgrade`. Wer eine Spalte falsch angelegt
  hat, schreibt eine zweite Migration, die sie korrigiert.
- **Zeitstempel sind immer UTC und immer mit Zeitzone.** Ein naives `datetime` im Code ist ein
  Fehler, kein Stil. Der Linter faengt es nicht, die Review muss es fangen.
- **Die Testdatenbank ist eine Datei im Temp-Verzeichnis, nie `:memory:`.** In-Memory verhaelt
  sich bei gleichzeitigen Verbindungen anders als die echte Datei, und genau dort lagen die zwei
  Fehler, die es bis in die Produktion geschafft haben.
- **Keine neue Abhaengigkeit ohne Rueckfrage.** Der Dienst laeuft auf einem Rechner, den niemand
  wartet; jedes Paket ist eine Stelle, an der ein Update ihn stillegen kann.

## Wo die Dinge liegen

```
app/            der Dienst
app/schema/     Migrationen, aufsteigend nummeriert, nie nachtraeglich geaendert
tests/          pytest, ein Modul je Endpunkt
werkzeuge/      Skripte fuer den Betrieb, kein Teil der Auslieferung
```

## Offene Baustellen

Steht in `STATUS.md` daneben, nicht hier. Diese Datei aendert sich selten; `STATUS.md` aendert
sich jede Session.
