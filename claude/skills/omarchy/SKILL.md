---
name: omarchy
description: "Customize an installed Omarchy desktop, Hyprland configuration, terminals or themes. Applies on an Omarchy host only; source development and unrelated Linux work are outside scope."
license: >
  Unveraenderte Kopie des Skills, das Omarchy 4.0.0-1 selbst ausliefert
  (/usr/share/omarchy/default/agents/skills/omarchy, uebernommen am 25.08.2026).
  Quelle: basecamp/omarchy, MIT. Der Haus-Anhang steht in HAUS.md, die Pruefung in
  HERKUNFT.md; die sieben Upstream-Dateien bleiben bis auf diesen Kopf woertlich.
---

# omarchy

Read `HAUS.md` before changing the system and select only the topic guide needed: `hyprland.md` for window/key rules, `plugins.md` for the shell, `theming.md` for appearance, `hooks.md` for event hooks, or `capture.md` for recording.

Work on the actual Omarchy host. Keep `/usr/share/omarchy/` read-only for end-user customization; change user files under `~/.config/`. Discover current commands with `omarchy --help` and command-specific help instead of assuming a historic version's syntax. Privilege, reset and external upload steps retain existing task authorization and safeguards.

Snapshot affected configuration before resets. Diagnose without uploading logs (`omarchy debug --no-sudo --print`). Tests use isolated sessions; a requested real configuration change may be applied to its intended target, but a test must not silently restart the user's terminals or desktop. Check the affected configuration when critical live behavior changes, not through an automatic full audit.

## Details nach Bedarf

Die folgenden Abschnitte bewahren konkrete Verfahren und Herkunft. Nur den zur Handlung passenden Abschnitt laden. Relative Befehls- und Ressourcenpfade darin beziehen sich auf den ursprünglichen Skillordner. Historische Modell-/Prüfvorgaben sind durch den Einstieg und aktuelle Hausregeln ersetzt.

- [When This Skill MUST Be Used](references/review-20260912/01.md)
- [Topic Guides](references/review-20260912/02.md)
- [Critical Safety Rules](references/review-20260912/03.md)
- [Privilege Escalation](references/review-20260912/04.md)
- [System Architecture](references/review-20260912/05.md)
- [Command Discovery](references/review-20260912/06.md)
- [Command Groups](references/review-20260912/07.md)
- [Configuration Locations](references/review-20260912/08.md)
- [Terminals](references/review-20260912/09.md)
- [Other Configs](references/review-20260912/10.md)
- [Safe Customization Patterns](references/review-20260912/11.md)
- [Edit User Config Directly](references/review-20260912/12.md)
- [Reset to Defaults -- ALWAYS SEEK USER CONFIRMATION BEFORE RUNNING](references/review-20260912/13.md)
- [System Commands](references/review-20260912/14.md)
- [Troubleshooting](references/review-20260912/15.md)
- [Decision Framework](references/review-20260912/16.md)
- [Reminder Requests](references/review-20260912/17.md)
- [Out of Scope](references/review-20260912/18.md)
- [Example Requests](references/review-20260912/19.md)
