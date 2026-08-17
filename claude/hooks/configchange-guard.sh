#!/bin/bash
# Zweck: loggt/warnt bei jeder Aenderung an user_settings/project_settings/
#        local_settings (~/.claude/settings.json bzw. .claude/settings.json
#        bzw. .claude/settings.local.json), damit Config-Drift ausserhalb des
#        update-config-Skills sichtbar wird.
# Event: ConfigChange, matcher user_settings|project_settings|local_settings.
# Beleg (verifiziert an code.claude.com/docs/en/hooks, 2026-07-28): das Event
#        existiert, feuert bei Aenderung der genannten Settings-Dateien,
#        stdin liefert NUR config_source (kein Delta/alte-neue-Werte-Feld) —
#        daher kann dieser Hook nur "etwas hat sich geaendert (Quelle X)"
#        melden, nicht WAS sich geaendert hat oder ob es ueber update-config
#        lief. Policy laut Auftrag: "Nur Log/Warnung" — passt zu dieser
#        Datenlage, kein Blockversuch.
# Nicht-blockierend: gibt absichtlich nie {"decision":"block"} zurueck.
set -uo pipefail

input=$(cat)
config_source=$(printf '%s' "$input" | jq -r '.config_source // empty' 2>/dev/null)
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$config_source" ] && exit 0

log_dir="$HOME/.claude/hooks/logs"
mkdir -p "$log_dir" 2>/dev/null
printf '%s\tsource=%s\tcwd=%s\tsession=%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$config_source" "$cwd" "$session_id" \
  >> "$log_dir/configchange.log" 2>/dev/null

echo "configchange-guard: Settings-Aenderung erkannt (Quelle: $config_source). Falls das nicht ueber den update-config-Skill lief: pruefen, ob die Aenderung gewollt war." >&2
exit 0
