# Skill-Adapter-Katalog

Stand: 2026-09-12. Der erste Katalogteil beschreibt 74 aktive, eindeutig geprüfte
Payloads. Weitere Harness-Sammlungen stehen in den Teilkatalogen unten. Er ändert keine Anbieter-Caches. Nutzeranweisung und Hausregeln haben
Vorrang. Ein Adapter ersetzt weder ein Modell noch einen Harness durch einen
anderen.

Die Prüfung richtet sich nach `~/.claude/regeln/verifikation.md`: vorhandene,
passende Belege gelten weiter; zusätzliche Tests oder Reviews nur vor
Push/Publish, bei kritischen Änderungen, bei konkretem Befund oder auf Auftrag.

## Codex-System, 6

| Payload | Quelle | Adapter |
|---|---|---|
| imagegen | `~/.codex/skills/.system/imagegen/SKILL.md` | `vendor-runtimes.md` |
| openai-docs | `~/.codex/skills/.system/openai-docs/SKILL.md` | `vendor-runtimes.md` |
| plugin-creator | `~/.codex/skills/.system/plugin-creator/SKILL.md` | `vendor-runtimes.md` |
| review-agent | `~/.codex/skills/.system/review-agent/SKILL.md` | `core.md` |
| skill-creator | `~/.codex/skills/.system/skill-creator/SKILL.md` | `core.md` |
| skill-installer | `~/.codex/skills/.system/skill-installer/SKILL.md` | `vendor-runtimes.md` |

## Caveman Codex-local, 20

Quelle je Payload: `~/.codex/plugins/cache/caveman/caveman/local/skills/<Name>/SKILL.md`.

| Zusammenführen | Unverändert | Vendor-Adapter | Auslagern |
|---|---|---|---|
| caveman | caveman-commit, caveman-review, investigate-first, lean-build, migration, safe-refactor, surgical-patch, verify-and-stop | cavecrew, caveman-compress, caveman-discover, caveman-evidence-review, caveman-explore, caveman-learn, caveman-manage, caveman-optimize, caveman-setup | caveman-help, caveman-stats |

Details: `caveman.md`.

## Zusätzliche registrierte Claude-Caveman-Payloads, 7

Quelle je Payload: `~/.claude/plugins/cache/caveman/caveman/0d95a81d35a9/skills/<Name>/SKILL.md`.

| Payload | Empfehlung |
|---|---|
| cavecrew, caveman-compress | vendor-adapter |
| caveman, caveman-commit, caveman-review | zusammenführen oder unverändert mit Hausadapter |
| caveman-help, caveman-stats | auslagern |

Diese Fassung hat andere Hashes als Codex-local; sie wird daher nicht als bloße
Kopie behandelt. Wrapper unter `.../plugins/caveman/skills/` sind Hashduplikate.

## Registrierte Claude-Commands und Rollen, 10

Diese Einträge sind über `~/.claude/plugins/installed_plugins.json` registriert
und liegen als direkte `commands/`- oder `agents/`-Dateien im jeweiligen
Installationspfad. Sie ergänzen die 74 Skill-Payloads.

| Payload | Quelle | Adapter |
|---|---|---|
| `cavecrew-builder`, `cavecrew-investigator`, `cavecrew-reviewer` | `~/.claude/plugins/cache/caveman/caveman/0d95a81d35a9/agents/<Name>.md` | `caveman.md` |
| `caveman`, `caveman-commit`, `caveman-init`, `caveman-review`, `caveman-stats` | `~/.claude/plugins/cache/caveman/caveman/0d95a81d35a9/commands/<Name>.md` | `caveman.md` |
| `code-review` | `~/.claude/plugins/cache/claude-plugins-official/code-review/3deb821cb71c/commands/code-review.md` | `vendor-runtimes.md` |
| `code-simplifier` | `~/.claude/plugins/cache/claude-plugins-official/code-simplifier/1.0.0/agents/code-simplifier.md` | `vendor-runtimes.md` |

Codex ist für dieselben Plugins aktiviert, exponiert in dieser Sitzung aber nur
Skills als native Laufzeit-Payloads. Seine `commands/`- und `agents/`-Dateien
sind deshalb nicht als Codex-Kommandos oder Rollen nachgebildet. Alle 172
Plugin-Instructions, Cache- und Marketplace-Kopien stehen mit Status, Hash und
Begründung in `inventory.json`; `.codex/.tmp` und `.codex/tasks` sind
Arbeitskopien und nicht Teil der aktiven Plugin-Quelle.

## Anbieter-Runtimes, 14

| Payload | Quelle | Adapter |
|---|---|---|
| frontend-design | `~/.codex/plugins/cache/claude-plugins-official/frontend-design/local/skills/frontend-design/SKILL.md` | `vendor-runtimes.md` |
| computer-history | `~/.codex/plugins/cache/openai-bundled/computer-history/1.0.1000968/skills/computer-history/SKILL.md` | `vendor-runtimes.md` |
| visualize | `~/.codex/plugins/cache/openai-bundled/visualize/1.0.37/skills/visualize/SKILL.md` | `vendor-runtimes.md` |
| deep-research | `~/.codex/plugins/cache/openai-curated-remote/deep-research-work/0.1.15/skills/deep-research/SKILL.md` | `vendor-runtimes.md` |
| plugin-management | `~/.codex/plugins/cache/openai-curated-remote/plugin-management/0.1.0/skills/plugin-management/SKILL.md` | `vendor-runtimes.md` |
| sites-building, sites-hosting, sites-preview-troubleshooting | `~/.codex/plugins/cache/openai-curated-remote/sites/0.1.62/skills/<Name>/SKILL.md` | `vendor-runtimes.md` |
| documents | `~/.codex/plugins/cache/openai-primary-runtime/documents/26.909.12148/skills/documents/SKILL.md` | `vendor-runtimes.md` |
| pdf | `~/.codex/plugins/cache/openai-primary-runtime/pdf/26.909.12148/skills/pdf/SKILL.md` | `vendor-runtimes.md` |
| presentations | `~/.codex/plugins/cache/openai-primary-runtime/presentations/26.909.12148/skills/presentations/SKILL.md` | `vendor-runtimes.md` |
| spreadsheets, excel-live-control | `~/.codex/plugins/cache/openai-primary-runtime/spreadsheets/26.909.12148/skills/spreadsheets/SKILL.md`; `~/.codex/plugins/cache/openai-primary-runtime/spreadsheets/26.909.12148/skills/excel-live-control/SKILL.md` | `vendor-runtimes.md` |
| template-creator | `~/.codex/plugins/cache/openai-primary-runtime/template-creator/26.909.12148/skills/template-creator/SKILL.md` | `vendor-runtimes.md` |

## Project-Kit, 27

Direkte Payloads: `email-manager`, `new-project`, `social-media-manager` unter
`~/.codex/plugins/cache/project-kit/project-kit/0.6.0/skills/<Name>/SKILL.md`.

Routen, je unter `~/.claude/plugins/cache/project-kit/project-kit/0.6.0/routes/<Name>/SKILL.md`:

`agency-automations`, `ai-agent-mcp`, `api-backend`, `bot-automation`,
`browser-extension`, `build-business`, `cli-tool`, `content-writing`,
`creative-media`, `data-ml`, `desktop-app`, `ecommerce-store`, `game-dev`,
`game-mod`, `generic-project`, `hardware-embedded`, `llm-app`, `mobile-app`,
`oss-library`, `quant-strategy`, `research-decision`, `saas`, `simulation`,
`website`.

Alle 27: `project-kit.md`, Empfehlung zusammenführen. Codex-Spiegelpfade der
Routen sind Hashduplikate unter `~/.codex/plugins/cache/project-kit/project-kit/0.6.0/routes/`.

## Nicht geprüfte Cachepfade

38 konkrete Pfade, 22 eindeutige Hashes: historische oder nicht exponierte Caches
und Plugin-Wrapper. Sie stehen mit Hash, Bytezahl, Status und Duplikatbezug in
`~/.codex/tasks/instruction-review-20260912/plugins/inventory.json`. Kein
eindeutiger aktiver Payload bleibt daraus offen.

## Weitere Harness-Sammlungen

- Gemini/Antigravity: `gemini-index.md` erfasst 114 verfügbare Skill-Einstiege;
  Aktivierung ist nicht belegt. Bei Nutzung gilt `gemini.md`.
- OpenHands: `openhands-index.md` erfasst 60 Primärskills, 28 Command-Aliasse
  und 43 Referenzen. Bei Nutzung gilt `openhands.md`.
- Nur auf Peer-Rechner vorhandene Vendor-Skills (`cli-anything`, `doc-coauthoring`,
  `docx`, `pdf`, `pptx`, `xlsx`): Fachverfahren nutzen, Toolverfügbarkeit
  tatsächlich prüfen; `core.md` und `vendor-runtimes.md` gelten entsprechend.

Bei gleichnamigen Skill-Creator-Fassungen ist die Hausfassung unter
`~/.claude/skills/skill-creator/SKILL.md` der gemeinsame Arbeitsvertrag.
Harness-eigene Formatvorgaben ergänzen ihn; sie erzwingen keine Evaluationsserie.

## Plugin-Commands und Rollen

`commands-roles.md` dokumentiert zehn aktive direkte Claude-Einstiege und ihre
Adapter. Pauschale Reviewer-Flotten und erneute Scoring-Runden werden nicht übernommen.

Peer-Rechner/Omarchy: `diagnose-crash` ist ein Systemskill aus `/usr/share/omarchy`,
kein Haus-Skill. Bei Nutzung `omarchy-diagnose-crash.md` lesen.
