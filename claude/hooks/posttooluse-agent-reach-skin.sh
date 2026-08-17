#!/bin/bash
# PostToolUse/Bash — stellt die Haus-Fassung des agent-reach-Skills wieder her, sobald ein
# Befehl gelaufen ist, der sie ueberschrieben haben koennte.
#
# Hintergrund: `agent-reach skill --install` (und jede Neuinstallation des Pakets) kopiert
# SKILL.md und references/ aus dem Paket nach ~/.claude/skills/agent-reach. Ohne diesen Hook
# faellt der Skill dabei still auf die chinesische Fremdfassung mit dem aggressiven Trigger
# zurueck — ein Agent, der "nur mal aktualisiert", merkt davon nichts.
#
# Der Hook liest den ausgefuehrten Befehl aus dem Hook-JSON, prueft ihn gegen die wenigen
# Muster, die den Skill anfassen koennen, und laesst sonst alles unberuehrt.
set -uo pipefail

input=$(cat 2>/dev/null)
[ -n "$input" ] || exit 0

cmd=$(printf '%s' "$input" | /usr/bin/python3 -c \
  'import json,sys
try:
    print(json.load(sys.stdin).get("tool_input", {}).get("command", ""))
except Exception:
    print("")' 2>/dev/null)

case "$cmd" in
  *agent-reach*|*"skills add"*|*Agent-Reach*) ;;
  *) exit 0 ;;
esac

command -v agent-reach-skin >/dev/null 2>&1 || exit 0
agent-reach-skin apply --quiet >/dev/null 2>&1 || true
exit 0
