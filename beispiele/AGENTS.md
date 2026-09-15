# Beispielprojekt — Anweisungen fuer Agenten

Nutze diese Datei nur für einen Harness, der `AGENTS.md` tatsächlich liest. Braucht ein anderer
Harness einen anderen Projektnamen, verweist oder generiert dessen Konfiguration nach eigener
Dokumentation. Keine Kopie wird allein wegen eines vermuteten Harness-Verhaltens angelegt.

Globale Regeln und Rollen stammen aus `~/.claude/`. Anbieter-Skills laufen über
`~/.claude/skill-adapters/index.md`; native Skills nur aus einem vorhandenen
`~/.agents/skills/` oder `~/.agent-skills/`, sonst aus `~/.agent-instructions/skills.md`.
Hier stehen nur Projektregeln.

## Was das hier ist

Ein HTTP-Dienst, der Messreihen entgegennimmt und sie nach SQLite schreibt. Python 3.12, FastAPI,
kein ORM. Ein einziger Prozess, kein Cluster.

## Bauen und pruefen, wenn der Anlass es verlangt

```bash
uv sync
uv run pytest            # 214 Tests, etwa 40 Sekunden
uv run ruff check .
uv run uvicorn app:api --reload
```

Die Befehle zeigen die passende Projektprüfung. `~/.claude/regeln/verifikation.md` entscheidet,
wann sie nötig ist; ein gültiger bestehender Nachweis zählt weiter, solange Code und relevante
Bedingungen unverändert sind.

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
