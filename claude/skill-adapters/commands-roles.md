# Plugin-Commands und Rollen — Teilkatalog

Stand: 2026-09-12. Grundlage: `inventory-after.json`; `.codex/.tmp` und
`.codex/tasks` sind Scratch-/Ergebnis-Kopien und ausgeschlossen.

| Gruppe | Rohpfade | Eindeutige Hashes | Aktiv semantisch geprüft |
|---|---:|---:|---:|
| `~/.claude/plugins` + `~/.codex/plugins` Instructions | 172 | 118 | 10 direkte Claude-Entries |

Die 10 aktiven Claude-Einstiegspunkte folgen aus
`~/.claude/plugins/installed_plugins.json` und liegen direkt unter dem
registrierten `commands/`- oder `agents/`-Pfad:

- Caveman-Rollen: `cavecrew-builder`, `cavecrew-investigator`,
  `cavecrew-reviewer`.
- Caveman-Commands: `caveman`, `caveman-commit`, `caveman-init`,
  `caveman-review`, `caveman-stats`.
- Offizielle Plugin-Entries: `code-review`, `code-simplifier`.

Empfehlung: alle als Vendor-Adapter, mit zwei Ausnahmen: `caveman-commit`
und `caveman-review` behalten ihre Fachabsicht im Hausadapter;
`caveman-stats` wird ausgelagert. `caveman-init` darf keinen Remote-Download
mit Pipe-Ausführung und keine automatische Projektanweisungsänderung auslösen.
`code-review` fordert fünf Sonnet-Reviewer, weitere Haiku-Scorer, einen
Wiederholungscheck und einen PR-Kommentar; der Adapter ersetzt das durch
risikobasierten Review und bestehende Außenwirkungsbefugnisse.

Codex aktiviert die überlappenden Plugins laut `~/.codex/config.toml`, stellt
in dieser Sitzung jedoch ihre SKILL-Payloads bereit, keine nativen
Claude-Commands oder Agent-Rollen. Alte Cacheversionen, Marketplace-Bäume,
nicht-direkte Unterordner und Root-`CLAUDE.md`/`AGENTS.md` sind damit keine
weiteren Einstiegspunkte. Die vollständigen 172 Pfade samt Hash, Status und
Duplikatbezug stehen in `inventory.json` unter `plugin_commands_roles_audit`.

Adapter: `~/.claude/skill-adapters/caveman.md` und
`~/.claude/skill-adapters/vendor-runtimes.md`.
