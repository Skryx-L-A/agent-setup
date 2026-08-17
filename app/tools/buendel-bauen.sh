#!/bin/bash
# Baut aus diesem Programm ein macOS-Programmbuendel, das sich wie jedes andere
# Programm starten laesst: Doppelklick im Finder, Spotlight, Launchpad, Dock.
#
# Das Buendel KOPIERT den Quelltext NICHT. `Contents/Resources/app` ist ein
# Verweis auf dieses Verzeichnis, deshalb startet der Doppelklick immer den
# Stand, der gerade gebaut ist -- ein `npm run build` reicht, das Buendel muss
# dafuer nicht neu entstehen. Neu gebaut werden muss es nur, wenn Electron seine
# Hauptversion wechselt oder das Buendel woanders hin soll.
#
# Warum ein Startskript als CFBundleExecutable und nicht die Electron-Binaerdatei
# direkt: das Fenster erscheint ausschliesslich bei `--show` auf der Befehlszeile
# (main.ts, Kopf). Ein Programmsymbol kann keine Argumente mitgeben, also setzt
# das Startskript die Angabe -- ein Klick auf das Symbol IST die Absicht eines
# Menschen, ein Ereignis oder ein Steuerbefehl kommt hier nie an.
#
# Aufruf: tools/buendel-bauen.sh [Zielpfad] [--ohne-bau]
set -euo pipefail

wurzel="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ziel="/Applications/Agent Workbench.app"
bauen=1
for arg in "$@"; do
  case "$arg" in
    --ohne-bau) bauen=0 ;;
    -*) echo "Unbekannte Angabe: $arg" >&2; exit 2 ;;
    *) ziel="$arg" ;;
  esac
done

electron_app="$wurzel/node_modules/electron/dist/Electron.app"
icon="$(cd "$wurzel/.." && pwd)/assets/AppIcon.icns"
[ -d "$electron_app" ] || { echo "Electron fehlt: $electron_app (npm install)" >&2; exit 1; }
[ -f "$icon" ] || { echo "Symboldatei fehlt: $icon" >&2; exit 1; }

if [ "$bauen" = 1 ]; then
  ( cd "$wurzel" && npm run build >/dev/null )
fi
[ -f "$wurzel/dist/main/main.js" ] || { echo "dist/main/main.js fehlt -- erst bauen." >&2; exit 1; }

# Erst vollstaendig in einem Nebenverzeichnis bauen, dann in einem Zug an die
# Zielstelle bewegen: ein Abbruch mittendrin laesst so kein halbes Programm im
# Programme-Ordner zurueck.
werkstatt="$(mktemp -d)"
trap 'rm -rf "$werkstatt"' EXIT
neu="$werkstatt/Agent Workbench.app"

ditto "$electron_app" "$neu"

# Die Binaerdatei bekommt einen eigenen Namen und tritt hinter das Startskript
# zurueck. Der Name der Binaerdatei ist Electron egal -- das Rahmenwerk findet es
# ueber den relativen Pfad ../Frameworks.
mv "$neu/Contents/MacOS/Electron" "$neu/Contents/MacOS/agent-workbench-bin"
cat > "$neu/Contents/MacOS/AgentWorkbench" <<'SKRIPT'
#!/bin/sh
# Startskript des Buendels. Siehe tools/buendel-bauen.sh, Kopf, fuer --show.
verzeichnis=$(dirname "$0")
exec "$verzeichnis/agent-workbench-bin" --show "$@"
SKRIPT
chmod +x "$neu/Contents/MacOS/AgentWorkbench"

# Der Verweis auf den Quellbaum. Electron sucht Resources/app.asar, dann
# Resources/app, dann default_app.asar -- der Verweis gewinnt also.
rm -rf "$neu/Contents/Resources/app"
ln -s "$wurzel" "$neu/Contents/Resources/app"
cp "$icon" "$neu/Contents/Resources/AppIcon.icns"
rm -f "$neu/Contents/Resources/electron.icns"

version="$(node -p "require('$wurzel/package.json').version")"
plist="$neu/Contents/Info.plist"
/usr/bin/plutil -replace CFBundleExecutable -string 'AgentWorkbench' "$plist"
/usr/bin/plutil -replace CFBundleName -string 'Agent Workbench' "$plist"
/usr/bin/plutil -replace CFBundleDisplayName -string 'Agent Workbench' "$plist"
# Die Kennung ist eine Adresse im umgekehrten DNS-Namensraum dessen, der baut --
# kein Produktname. macOS haengt Berechtigungen und den Eintrag in
# LaunchServices an sie: wer sie aendert, baut kein neues Buendel, sondern ein
# ANDERES Programm, und faengt bei den erteilten Berechtigungen von vorn an.
# Deshalb steht der eigene Wert weiter als Vorgabe hier, und wer unter eigenem
# Namen baut, setzt AWB_BUNDLE_ID, statt diese Zeile zu aendern.
kennung="${AWB_BUNDLE_ID:-de.example.agent-workbench}"
/usr/bin/plutil -replace CFBundleIdentifier -string "$kennung" "$plist"
/usr/bin/plutil -replace CFBundleIconFile -string 'AppIcon' "$plist"
/usr/bin/plutil -replace CFBundleShortVersionString -string "$version" "$plist"
/usr/bin/plutil -replace CFBundleVersion -string "$version" "$plist"
# Der Eintrag prueft die Pruefsumme von Resources/default_app.asar. Die Datei
# wird nie geladen (der Verweis oben gewinnt), der Eintrag wuerde bei einem
# Electron-Wechsel aber ins Leere zeigen.
/usr/bin/plutil -remove ElectronAsarIntegrity "$plist" 2>/dev/null || true

# Das Umbenennen der Binaerdatei macht Electrons Signatur ungueltig; ohne eine
# gueltige Signatur beendet macOS auf Apple-Silicon den Prozess sofort. Eine
# eigene Signatur ("ad hoc", das Minuszeichen) reicht fuer den Eigenbedarf.
codesign --force --deep --sign - "$neu" 2>/dev/null

rm -rf "$ziel"
mv "$neu" "$ziel"
# LaunchServices von der neuen Fassung erzaehlen, sonst zeigt Spotlight das
# Programm erst nach dem naechsten Neustart des Rechners.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$ziel"

echo "Fertig: $ziel"
echo "Quelltext: $wurzel (als Verweis -- npm run build genuegt fuer Aenderungen)"
