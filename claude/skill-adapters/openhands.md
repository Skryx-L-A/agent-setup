# OpenHands: neutraler Harness-Adapter

Geltungsbereich: Lokaler, registrierter Public-Skills-Cache unter `~/.openhands/cache/skills/public-skills/skills/`. Die vollständige hashbasierte Inventur steht unter `~/.codex/tasks/instruction-review-20260912/projects/inventory-openhands.json`.

## Einordnung

`openhands` ist ein eigener Agenten-Harness. Eine Skilldatei beschreibt eine Fähigkeit oder einen Auslöser; sie ist kein universell ausführbarer Shell-Befehl. Dateien unter `commands/` sind OpenHands-Command-Aliasse, Referenzen unter `references/` werden nur zusammen mit ihrem Primärskill gelesen.

| Werkzeug | Fähigkeit | Sichere Wahl, falls nicht ausdrücklich beauftragt |
|---|---|---|
| `openhands` | Interaktive lokale Agentensitzung mit Rückfragen als Vorgabe | Keine Sitzung starten; die vorhandenen Harness-Werkzeuge verwenden. |
| `openhands view <id>` | Eine bekannte Trajektorie ansehen | Nur bei expliziter ID lesen, sonst berichten, dass keine Ansicht geöffnet wurde. |
| `openhands cloud` | Neue Cloud-Unterhaltung erzeugen | Nur auf ausdrücklichen Auftrag; keine Cloud-Sitzung als Delegationsersatz erfinden. |
| `openhands serve`, `web`, `acp` | GUI-, Web- oder ACP-Prozess starten | Nur bei explizitem Bedarf; Prozess nach dem Anlass beenden. |
| `openhands mcp` | MCP-Konfiguration verwalten | Nur bei explizitem Konfigurationsauftrag; vorhandene Connectoren bevorzugen. |

Die Standardfreigabe der CLI ist interaktiv. `--headless`, `--always-approve`, `--yolo`, `--llm-approve` und `--override-with-envs` werden nie aus diesem Adapter abgeleitet.

## Skill-Grenzen

- Automations-, Monitor- und Digest-Skills erzeugen nur nach einem ausdrücklichen Auftrag eine Planung, einen Poller, Cron, Webhook oder Hintergrundjob.
- GitHub-, GitLab-, Bitbucket-, Azure-, Linear-, Notion-, Slack-, Discord- und Vercel-Skills können Nachrichten, Reviews, Tickets, PRs oder Deployments auslösen. Ohne konkrete Außenwirkungsfreigabe bleibt es bei Analyse, Entwurf oder lokalem Diff.
- `iterate`, `code-review`, `code-simplifier` und `qa-changes` sind auf eine konkret angeforderte Änderung oder einen PR begrenzt. Sie begründen keine pauschale Gegenprüfung oder Dauerschleife.
- `add-skill`, `agent-memory`, Agenten- und SDK-Skills schreiben oder laden nur bei passendem ausdrücklichen Auftrag. Fremde Skillquellen werden vorher wie Fremdcode gelesen und bewertet.
- Angaben zu Tokens, API-Schlüsseln, Profilen, Sitzungen oder Authentisierung bleiben unbeachtet, außer ein konkreter Auftrag verlangt ihre Konfiguration. Werte werden weder gelesen noch ausgegeben.

Bei nicht verfügbarem OpenHands-Cache oder auf Peer-Rechner ohne diese Wurzel ist der Fallback die bestehende Workbench samt deren installierten Skills und Connectoren. Keine gleichnamigen OpenHands-Commands werden nachgebaut.
