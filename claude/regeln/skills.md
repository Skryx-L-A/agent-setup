# regeln/skills.md

Inhalt: welches Skill bei welcher Taetigkeit von selbst greift, und wie fremde Skills
aufgenommen werden. Ausgelagert am 01.09.2026 aus `CLAUDE.md` (Groessengrenze), inhaltlich
UNVERAENDERT — die fuenf Regeln stehen unten im Wortlaut, mit ihren Daten.

Ausloeser: bevor Du ein neues Projekt anfaengst, eine Webseite oder eine native Apple-Anwendung
baust, ein Projekt wesentlich aenderst, oder einem fremden Skill begegnest.

- **grill-me at every NEW project start** (skill `~/.claude/skills/grill-me/`): interview one
  question at a time with recommended answers, before code or architecture. Unprompted.

- **Scout-Themen wachsen mit den Projekten (2026-08-13):** bei jedem neuen Projekt und bei
  jeder wesentlichen Projektänderung erweitert/aktualisiert der Orchestrator ungefragt
  `topics.yaml` im Repo `~/AI/scout` (news-scout-Themenliste) und pusht.

- **framer-inspiration bei neuen Webentwürfen und wesentlichen Redesigns (2026-06-14)** (skill + `framer-inspo` CLI): design inspiration
  from Framer's public galleries, automatically, before a new web design; reuse references for small iterations. Inspiration only –
  never copy assets/code, never build inside Framer.

- **apple-native-design bei jeder nativen Apple-Anwendung (2026-08-19):** Arbeit an nativen Apple-Oberflächen startet mit dem Skill; reine Swift-Änderungen ohne Oberflächenwirkung laden ihn nicht – wie `framer-inspiration` bei Webseiten. Nicht
  fuer Web-UI und nicht fuer Dokumente.

- **Skills auf Vorrat, aber nur gute (2026-08-23):** ein brauchbares Skill wird uebernommen,
  sobald es begegnet – auch fuer Themen, die gerade niemand braucht. Nur wirklich Gutes,
  nichts ungeprueft; Verfahren in `regeln/arbeitsweise.md`.

- **SkillSpector vor jedem fremden Skill (2026-09-10, Vorschlag des Nutzers „wäre denke ich gut
  wenn wir zukünftig öffentliche Skills downloaden wollen"):** NVIDIA/SkillSpector
  (https://github.com/NVIDIA/SkillSpector) ist ein Sicherheits-Scanner für Agenten-Skills
  (Schadmuster, Prompt-Injektion, riskante Befehle). Vorgemerkt, noch nicht installiert und
  nicht selbst geprüft. Beim nächsten fremden Skill: SkillSpector zuerst nach
  `regeln/arbeitsweise.md` und der Installer-Regel prüfen (Skript lesen, Nachwirkungen in
  Shell-Profilen und LaunchAgents ansehen), dann den Kandidaten damit scannen, BEVOR er nach
  `~/.agent-skills` oder `~/.claude/skills` kommt. Der Scan ersetzt die eigene Lektüre nicht;
  er kommt davor. Hinweis aus derselben Suche: `huawei-csl/KillSkillSpector` ist ein
  Angreiferspiel gegen den Scanner, also ist ein sauberer Scan kein Freibrief.


## Pflege und Harnesswechsel (2026-09-12)

Skillauslöser und Standardablauf stehen im jeweiligen SKILL.md, Details in bedarfsweise geladenen Referenzen. Kein automatisches Team, keine mehrfache Prüfung und kein neues Nutzerinterview für eine bekannte Routine. Bereits erteilte Änderungsfreigabe gilt; `verifikation.md` bestimmt den Prüfumfang.

Haus-Skills liegen kanonisch unter `~/.claude/skills/`; die nativen Verzeichnisse `~/.agents/skills/` und `~/.agent-skills/` verweisen darauf. Vorhandene abweichende Kopien vor Zusammenführung vergleichen und sichern. Plugin-/System-Skills bleiben beim Anbieter; `~/.claude/skill-adapters/index.md` vermittelt Fachverfahren und verfügbare Fähigkeiten. Kein globales Ersetzen von Claude durch einen Harnessnamen.
