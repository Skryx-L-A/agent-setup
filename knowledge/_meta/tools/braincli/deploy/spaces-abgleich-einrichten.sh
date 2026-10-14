#!/usr/bin/env bash
# spaces-abgleich-einrichten.sh — richtet den automatischen Abgleich der geteilten Spaces ein
# (BRAIN5-PLAN Nr. 42, 2026-09-26): alle 5 Minuten `brain spaces sync --push` im Vault dieses Rechners.
# Holt fremde Commits, pusht eigene, rebased bei beidseitigen Änderungen; nie force, nie ungesicherte
# Arbeit. macOS: LaunchAgent; Linux: systemd --user Timer. Mehrfach aufrufbar (idempotent).
#   sh spaces-abgleich-einrichten.sh [VAULT]        (Standard: ~/Knowledge)
#   sh spaces-abgleich-einrichten.sh --entfernen    (Timer abbauen)
set -eu
VAULT=${1:-$HOME/Knowledge}
NAME=brain-spaces-abgleich
LOGDIR=$HOME/.local/state/brain
mkdir -p "$LOGDIR"

if [ "$VAULT" = "--entfernen" ]; then
  case "$(uname -s)" in
    Darwin) launchctl bootout "gui/$(id -u)/de.brain.$NAME" 2>/dev/null || true
            rm -f "$HOME/Library/LaunchAgents/de.brain.$NAME.plist" ;;
    *) systemctl --user disable --now "$NAME.timer" 2>/dev/null || true
       rm -f "$HOME/.config/systemd/user/$NAME.service" "$HOME/.config/systemd/user/$NAME.timer"
       systemctl --user daemon-reload ;;
  esac
  echo "entfernt"; exit 0
fi

BRAIN=$VAULT/_meta/tools/braincli/.venv/bin/brain
[ -x "$BRAIN" ] || { echo "FEHLER: $BRAIN fehlt (vorher: cd $VAULT/_meta/tools/braincli && uv sync)" >&2; exit 1; }
[ -f "$VAULT/.brain/spaces.yml" ] || { echo "FEHLER: $VAULT/.brain/spaces.yml fehlt" >&2; exit 1; }

case "$(uname -s)" in
  Darwin)
    PLIST=$HOME/Library/LaunchAgents/de.brain.$NAME.plist
    mkdir -p "$(dirname "$PLIST")"
    cat > "$PLIST" <<P
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>de.brain.$NAME</string>
  <key>ProgramArguments</key><array>
    <string>$BRAIN</string><string>--vault</string><string>$VAULT</string>
    <string>spaces</string><string>sync</string><string>--push</string>
  </array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>LC_ALL</key><string>en_US.UTF-8</string>
  </dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>LowPriorityIO</key><true/>
  <key>StandardOutPath</key><string>$LOGDIR/$NAME.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/$NAME.log</string>
</dict></plist>
P
    launchctl bootout "gui/$(id -u)/de.brain.$NAME" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "eingerichtet: LaunchAgent de.brain.$NAME (alle 5 min), Log $LOGDIR/$NAME.log"
    ;;
  *)
    U=$HOME/.config/systemd/user
    mkdir -p "$U"
    cat > "$U/$NAME.service" <<S
[Unit]
Description=Brain: geteilte Spaces in beide Richtungen abgleichen (Nr. 42)
After=network-online.target

[Service]
Type=oneshot
Environment=LC_ALL=C.UTF-8
ExecStart=$BRAIN --vault $VAULT spaces sync --push
Nice=10
S
    cat > "$U/$NAME.timer" <<T
[Unit]
Description=Brain: Spaces-Abgleich alle 5 Minuten

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
T
    systemctl --user daemon-reload
    systemctl --user enable --now "$NAME.timer"
    echo "eingerichtet: systemd --user $NAME.timer (alle 5 min), Log: journalctl --user -u $NAME"
    ;;
esac
