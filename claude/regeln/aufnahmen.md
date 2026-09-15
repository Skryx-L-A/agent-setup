# Aufnahmen

Auslöser: Screenshot oder Bildschirmaufnahme. Stand: 2026-09-12.

Fenstergenau aufnehmen, wenn das Ziel damit einfach erfasst wird. Vollbild ist seit Freigabe des Nutzers vom 22.08.2026 erlaubt; die früheren Verbote sind aufgehoben. Die Erlaubnis für eine Aufnahme erlaubt keinen Fokuswechsel oder Eingriff in fremde Fenster.

- macOS: vorhandenes Browser-Screenshotwerkzeug oder `wb-shot <muster> <datei.png>`, Fensterliste mit `wb-shot --list`. Interaktive screencapture-Auswahl (-i/-w/-W) vermeiden: sie wartet auf einen Menschen.
- Eigene Electron-Tests: `capturePage()` im eigenen Prozess; bei Bedarf Skalierung explizit setzen. Sichtbare Tests nur im eigenen Fenster ohne Fokuswechsel, entsprechend `tests-und-eingriffe.md`. Ein echter Vollbild-Test ist von einer Vollbildaufnahme zu unterscheiden.
- Omarchy/Hyprland: Geometrie des Zielfensters aus `hyprctl clients`, dann `grim -g "<X>,<Y> <B>x<H>" <datei.png>`. Laufende Wayland-/Hyprland-Umgebung ermitteln, keine alte Instanzkennung annehmen. Grim erfasst sichtbare Überdeckungen; das Bild kann daher ein anderes Fenster zeigen. `peer-shot` war ein KDE-Werkzeug und ist dort kein gültiger Standard mehr.
- Nur notwendige Bilder aufnehmen; keine zusätzliche Screenshot-Runde für unveränderte Inhalte. Nach Eingabe eines Geheimnisses keine Aufnahme mit unmaskiertem Wert.

Frühere Messwerte und Verfahren: [Herkunft](references/review-20260912/aufnahmen.md). Ihre überholten Verbote und Systemannahmen gelten nicht.
