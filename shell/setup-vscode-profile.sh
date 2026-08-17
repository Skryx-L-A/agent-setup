#!/bin/bash
# setup-vscode-profile.sh — create the VSCode profile "Claude Workbench" and
# apply the calm workbench settings (no welcome tabs, terminal panel at the
# bottom, telemetry off). Idempotent: re-running only rewrites settings.json.
#
# Requires the `code` CLI (VSCode: "Shell Command: Install 'code' command").
#
# NICHT INSTALLIERT: einmalige Einrichtung (WERKZEUGE.md), einmal bei der
# Ersteinrichtung von Hand direkt aus dem Repo aufgerufen, kein Dauerwerkzeug
# in ~/.local/bin.
set -euo pipefail

PROFILE="Claude Workbench"
CODE_USER="$HOME/Library/Application Support/Code/User"
STORAGE="$CODE_USER/globalStorage/storage.json"
CODE_BIN="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"

[ -x "$CODE_BIN" ] || { echo "FEHLER: VSCode nicht gefunden ($CODE_BIN)" >&2; exit 1; }

profile_dir() {
  /usr/bin/python3 - "$STORAGE" "$PROFILE" <<'PY'
import json, sys
try:
    st = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
for p in st.get("userDataProfiles", []):
    if p.get("name") == sys.argv[2]:
        print(p.get("location", ""))
        sys.exit(0)
sys.exit(1)
PY
}

if ! LOC="$(profile_dir 2>/dev/null)"; then
  echo "Profil '$PROFILE' anlegen (VSCode startet kurz) ..."
  open -na "Visual Studio Code" --args --profile "$PROFILE" --new-window
  d=$(( $(date +%s) + 120 ))
  until LOC="$(profile_dir 2>/dev/null)"; do
    [ "$(date +%s)" -gt "$d" ] && { echo "FEHLER: Profil '$PROFILE' nach 120s nicht angelegt." >&2; exit 1; }
    sleep 3
  done
fi

PDIR="$CODE_USER/profiles/$LOC"
mkdir -p "$PDIR"
cat > "$PDIR/settings.json" <<'JSON'
{
  "workbench.startupEditor": "none",
  "workbench.tips.enabled": false,
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "workbench.editor.empty.hint": "hidden",
  "workbench.panel.defaultLocation": "bottom",
  "workbench.panel.opensMaximized": "always",
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "terminal.integrated.defaultLocation": "view",
  "terminal.integrated.enablePersistentSessions": false,
  "telemetry.telemetryLevel": "off",
  "update.showReleaseNotes": false,
  "window.title": "Claude Workbench — ${rootName}",
  "explorer.compactFolders": false,
  "security.workspace.trust.enabled": false,
  "chat.commandCenter.enabled": false,
  "chat.agent.enabled": false,
  "chat.disableAIFeatures": true
}
JSON
echo "Profil '$PROFILE' konfiguriert: $PDIR/settings.json"
echo "Extension installieren:  code --profile \"$PROFILE\" --install-extension <vsix> --force"
