#!/usr/bin/env bash
# nachbetten-nachholen-einrichten.sh — OPTIONALES Netz unter den git-Hooks (b6-einbett, 2026-09-28).
# Die Hooks (git-hooks/install-nachbetten.sh) bringen geaenderte Notizen nach jedem Commit/Merge in den
# Suchindex. Was sie verpassen (Ollama war beim Commit aus, Akku unter 20 %, Rechner aus), holt dieser
# Timer nach: alle 30 Minuten EIN kurzer Lauf `python -m braincli.nachbetten --sofort`, der Ollama und
# Akku prueft, nur Veraltetes einbettet und endet. Kein Dauerdienst. macOS: LaunchAgent; Linux: systemd --user.
#   sh nachbetten-nachholen-einrichten.sh [VAULT]        (Standard: ~/Knowledge)
#   sh nachbetten-nachholen-einrichten.sh --entfernen
set -eu
VAULT=${1:-$HOME/Knowledge}
NAME=brain-nachbetten
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

TOOL=$VAULT/_meta/tools/braincli
PY=$TOOL/.venv/bin/python
[ -x "$PY" ] || { echo "FEHLER: $PY fehlt (vorher: cd $TOOL && uv sync)" >&2; exit 1; }
[ -f "$TOOL/braincli/nachbetten.py" ] || { echo "FEHLER: braincli/nachbetten.py fehlt im Vault" >&2; exit 1; }

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
    <string>$PY</string><string>-m</string><string>braincli.nachbetten</string>
    <string>--vault</string><string>$VAULT</string><string>--sofort</string>
  </array>
  <key>WorkingDirectory</key><string>$TOOL</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>LC_ALL</key><string>en_US.UTF-8</string>
  </dict>
  <key>StartInterval</key><integer>1800</integer>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>$LOGDIR/$NAME.log</string>
  <key>StandardErrorPath</key><string>$LOGDIR/$NAME.log</string>
</dict></plist>
P
    launchctl bootout "gui/$(id -u)/de.brain.$NAME" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
    echo "eingerichtet: LaunchAgent de.brain.$NAME (alle 30 min, Lauf endet selbst), Log $LOGDIR/$NAME.log"
    ;;
  *)
    U=$HOME/.config/systemd/user
    mkdir -p "$U"
    cat > "$U/$NAME.service" <<S
[Unit]
Description=Brain: veraltete Notizen nachbetten (Netz unter den git-Hooks)

[Service]
Type=oneshot
Environment=LC_ALL=C.UTF-8
WorkingDirectory=$TOOL
ExecStart=$PY -m braincli.nachbetten --vault $VAULT --sofort
Nice=10
S
    cat > "$U/$NAME.timer" <<T
[Unit]
Description=Brain: Nachbetten alle 30 Minuten

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min

[Install]
WantedBy=timers.target
T
    systemctl --user daemon-reload
    systemctl --user enable --now "$NAME.timer"
    echo "eingerichtet: systemd --user $NAME.timer (alle 30 min), Log: journalctl --user -u $NAME"
    ;;
esac
