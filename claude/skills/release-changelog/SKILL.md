---
name: release-changelog
description: Generates a CHANGELOG entry, a suggested semantic-version bump, and a release draft (title + notes) from the commits since the last release tag. Works with Conventional Commits (feat/fix/BREAKING CHANGE drive the version bump) and falls back to a plain grouped commit list with a conservative patch-bump suggestion when they aren't used. Use before tagging a release on a repo that is NOT a project-kit oss-library package (that project type already has its own release-engineer for CHANGELOG/SemVer — this skill is for everything else: website, saas, api-backend, app, or any other repo). Triggers include "generate a changelog", "what changed since the last release", "bump the version", "draft a release", "CHANGELOG erstellen", "Versionssprung", "was hat sich seit dem letzten Release geaendert", "Release-Notizen schreiben".
---

# Release Changelog

Turns the commits since the last release tag into a CHANGELOG entry, a version-bump suggestion,
and a release draft. Read-only against git history — never tags, commits, pushes, or creates a
GitHub release itself; it drafts text for a human (or the orchestrator) to apply.

## Vor dem Nutzen: Dopplung vermeiden

Wenn das Repo bereits mit `project-kit:oss-library` aufgesetzt wurde, hat es schon einen
**release-engineer**-Subagenten, der SemVer-Bumps und CHANGELOG-Eintraege (Keep-a-Changelog)
selbst uebernimmt und vor rotem CI/schmutzigem Changelog blockt. Kurzer Check zuerst:

- Existiert `CHANGELOG.md` bereits im Keep-a-Changelog-Format UND eine `release.yml`/
  `release-engineer`-Referenz im Repo? Dann diesen bestehenden Weg nutzen, nicht doppeln.
- Sonst (kein oss-library-Setup, oder ein Projekt-Typ, den project-kit nicht fuer Releases
  vorgesehen hat — Website, SaaS, API-Backend, App, generisches Tool): dieses Skill nutzen.

## Ablauf

### 1. Letzten Release-Tag finden

```
git describe --tags --abbrev=0
```

Kein Tag vorhanden: alle Commits ab dem ersten Commit verwenden, Version startet bei `0.1.0`.

### 2. Commits seit dem letzten Tag sammeln

```
git log <letzter-tag>..HEAD --format='%h|%s|%b' --no-merges
```

### 3. Conventional Commits erkennen

Anteil der Commits pruefen, die auf `^(feat|fix|docs|style|refactor|perf|test|build|ci|chore)(\(.+\))?!?:`
matchen. Mehrheit matcht -> Conventional-Commits-Pfad (3a). Sonst -> Fallback-Pfad (3b).

**3a. Conventional-Commits-Pfad**

- Gruppieren: `feat:` -> Added, `fix:` -> Fixed, `perf:`/`refactor:` -> Changed, Rest -> Sonstiges.
- Versions-Bump: irgendein Commit mit `!` nach dem Typ ODER `BREAKING CHANGE:` im Body -> **major**.
  Sonst mindestens ein `feat:` -> **minor**. Sonst -> **patch**.
- Bei Pre-1.0-Versionen (`0.x.y`): major-Signal faellt auf **minor** zurueck (SemVer-Konvention:
  0.x gilt als instabil, Breaking Changes bumpen dort minor, nicht major) — das explizit sagen,
  nicht stillschweigend anwenden.

**3b. Fallback ohne Conventional Commits**

- Keine verlaessliche Typ-Erkennung moeglich — Commits als flache Liste der Subject-Zeilen zeigen,
  Autor/Datum optional, keine erfundene Kategorisierung.
- Versions-Bump: **patch** als konservativer Default. Nur wenn eine Commit-Nachricht Woerter wie
  "breaking", "incompatible", "removes support" (oder deutsch: "inkompatibel", "entfernt
  Unterstuetzung") explizit enthaelt, stattdessen **minor** vorschlagen und das begruenden.
- Diese Einordnung explizit als UNSICHER kennzeichnen — ohne Konvention in den Commit-Nachrichten
  kann kein Werkzeug die semantische Wirkung zuverlaessig ableiten. Der Vorschlag ist ein
  Ausgangspunkt fuer eine menschliche Entscheidung, keine Tatsachenbehauptung.

### 4. CHANGELOG-Eintrag komponieren (Keep-a-Changelog-Format)

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- ...

### Changed
- ...

### Fixed
- ...
```

Im Fallback-Pfad (3b) ersatzweise ein einzelner Abschnitt `### Changes` mit der flachen Liste.
Diesen Eintrag OBEN in ein bestehendes `CHANGELOG.md` einfuegen (als Vorschlag/Diff zeigen), nicht
automatisch schreiben, ohne dass Nutzer/Orchestrator den Diff gesehen hat.

### 5. Release-Draft

- Titel: `vX.Y.Z` (oder Projekt-Konvention, falls im Repo ersichtlich, z.B. bestehende Tags ohne
  `v`-Praefix).
- Body: der CHANGELOG-Eintrag aus Schritt 4, ggf. um einen kurzen einleitenden Satz ergaenzt.
- Ausgabeform, die sich direkt weiterverwenden laesst: `gh release create <tag> --title "..."
  --notes-file <datei>` — den Befehl NENNEN, nicht selbst ausfuehren (Tag setzen/Release
  veroeffentlichen ist eine Push-artige, nach aussen wirkende Aktion).

## Nie automatisch

Dieses Skill tagged nie, committet nie ins `CHANGELOG.md`, pusht nie und erstellt nie selbst ein
GitHub-Release. Es liefert Text (Changelog-Eintrag + Versions-Vorschlag + Release-Draft) zum
Gegenlesen. Anwenden/Taggen/Veroeffentlichen bleibt eine bewusste, separate Aktion.
