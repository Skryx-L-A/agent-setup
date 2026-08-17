#!/bin/bash
# ÜBERHOLT SEIT 2026-08-10 — NICHT MEHR AUSFÜHREN.
#
# Dieses Skript baut die Dock-App der VSCode-Zeit. Sie ist abgelöst: die Werkbank ist seit
# August 2026 ein eigenes Electron-Programm unter /Applications/Agent Workbench.app, dessen
# Resources/app ein Symlink auf app/ in diesem Repo ist. Das hier gebaute Bündel startet nur
# VSCode mit einem alten Profil.
#
# der Nutzer hatte am 10.08. beide Symbole im Dock und klickte auf das falsche. Das alte Bündel
# ist entfernt (Sicherung: ~/.local/trash-snapshots/2026-08-10-altes-workbench-bundle/), der
# Dock-Eintrag ebenfalls. Wer dieses Skript ausführt, holt genau diese Verwechslung zurück.
#
# Das Skript bleibt für den Nachvollzug stehen — die Icon-Erzeugung darin ist weiterhin die
# Vorlage, falls das Symbol des Electron-Programms je neu gebaut werden muss.
#
# make-app.sh — (re)build ~/Applications/Claude Workbench.app.
# The bundle just launches VSCode with the "Claude Workbench" profile.
# Icon source: assets/AppIcon.icns (generated locally with `bild` + sips/iconutil).
#
# NICHT INSTALLIERT: einmalige Einrichtung (WERKZEUGE.md), von Hand direkt aus
# dem Repo aufgerufen nach einer Icon-/Launcher-Aenderung, kein Dauerwerkzeug
# in ~/.local/bin.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
APP="$HOME/Applications/Claude Workbench.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/MacOS/ClaudeWorkbench" <<'EOF'
#!/bin/bash
# Launch VSCode with the dedicated "Claude Workbench" profile in a new window.
exec open -na "Visual Studio Code" --args --profile "Claude Workbench" --new-window --disable-workspace-trust
EOF
chmod +x "$APP/Contents/MacOS/ClaudeWorkbench"

cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>Claude Workbench</string>
	<key>CFBundleDisplayName</key><string>Claude Workbench</string>
	<key>CFBundleIdentifier</key><string>de.the user.claude-workbench</string>
	<key>CFBundleVersion</key><string>1.0</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>CFBundleExecutable</key><string>ClaudeWorkbench</string>
	<key>CFBundleIconFile</key><string>AppIcon</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>LSMinimumSystemVersion</key><string>13.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>LSUIElement</key><false/>
</dict>
</plist>
EOF
printf 'APPL????' > "$APP/Contents/PkgInfo"
cp "$REPO/assets/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
touch "$APP"
echo "Gebaut: $APP"
