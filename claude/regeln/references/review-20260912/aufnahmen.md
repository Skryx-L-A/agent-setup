# regeln/aufnahmen.md

Inhalt: Aufnahmen. Gilt seit: 2026-07-25, GRUNDLEGEND GEAENDERT am 2026-08-22.
Diese Datei ist ausgelagert aus CLAUDE.md; sie gilt unverändert weiter.

Auslöser: bevor ein Screenshot oder eine Bildschirmaufnahme gemacht wird, auf beiden
Maschinen.

## Standing rules — Aufnahmen

- **VOLLBILD IST ERLAUBT (2026-08-22, Freigabe des Nutzers).** Sein Wortlaut: „Die Maschine
  gehoert Dir, Du kannst Bildschirmfotos machen, Bildschirmaufnahmen, auch vom ganzen
  Bildschirm, vollkommen egal, alles Deins, mach wie es am besten funktioniert." Damit ist
  das Vollbild-Verbot vom 2026-07-25 (unten, erster Punkt) AUFGEHOBEN — es steht weiter da,
  weil daran haengt, warum `wb-shot` so gebaut ist, wie es gebaut ist, gilt aber nicht mehr
  als Verbot.
  - Fenstergenau bleibt die bessere Wahl, wo sie ohne Aufwand zu haben ist: weniger Rauschen
    im Bild, kein fremder Inhalt, kleinere Datei. `wb-shot` bleibt also das erste Werkzeug —
    aber ein Fehlschlag dort ist jetzt ein Grund, aufs Vollbild auszuweichen, statt die
    Aufnahme zu melden und zu lassen.
  - Der Waechter `bash-guard-screencapture` wurde am selben Tag entsprechend geoeffnet
    (`~/.claude/hooks/lib/screencapture_classify.py`); die alten Deny-Texte stehen dort als
    Kommentar, damit nachvollziehbar bleibt, was galt.
  - **Der interaktive Auswahlmodus (`-i`/`-w`/`-W`) bleibt gesperrt**, aber aus einem
    TECHNISCHEN Grund statt dem alten Regelgrund: er legt ein Fadenkreuz ueber den Bildschirm
    und wartet auf eine Eingabe. Sitzt niemand davor, haengt der Aufruf.


- **(UEBERHOLT am 2026-08-22, siehe oben — bleibt als Herkunft von `wb-shot` stehen.)**
  Aufnahmen fenstergenau, Fokus unangetastet (2026-07-25), Orchestrator UND Worker, beide
  Maschinen: NIEMALS den gesamten Bildschirm aufnehmen — jede Aufnahme wird exakt auf das gemeinte
  Fenster begrenzt, damit nichts Nebenherlaufendes erfasst wird: `wb-shot <muster> <datei.png>`
  (~/.local/bin, nutzt `screencapture -l <windowid>`; `wb-shot --list` zeigt die Fenster), KEIN
  Vollbild-Fallback, mehrdeutiges Muster bricht ab. FOKUS des Nutzers wird nie verschoben: Apps/Fenster
  nur im Hintergrund starten (`open -g -na "App" --args …`), nie nach vorn holen, kein `activate`;
  die Aufnahme hebt das Fenster nicht an. Anderer Space oder minimiert = nicht erfassbar: melden,
  nicht auf Vollbild ausweichen.
- **Agent-Workbench darf zum Prüfen sichtbar laufen (2026-08-05, Freigabe des Nutzers):** „Du
  kannst das Programm wieder zum Testen benutzen und Screenshots vom wirklich laufenden
  Fenster machen, dann brauchst du mich auch nicht mehr ganz so viel." Der Grund ist ein
  gemessener: Fehler, die nur im Vollbild auftreten, sind an einem kopflosen Fenster nicht
  reproduzierbar — macOS zoomt animiert, und genau darin lag der Fehler. Es gilt weiter: kein
  `activate`, kein Anheben eines fremden Fensters, kein Fokusklau, und nach der Messung wird
  die Instanz beendet. Fotografiert wird über `capturePage()` im eigenen Prozess; für alles,
  was ohne echtes Fenster messbar ist, bleibt der kopflose Weg der bessere (volle Auflösung
  über `--force-device-scale-factor=2`, kein Fenster auf dem Bildschirm).
- **Volle Auflösung ohne sichtbares Fenster: `--force-device-scale-factor=2` (2026-08-04,
  gemessen).** Ein kopflos gestartetes Electron-Fenster fotografiert sich standardmäßig bei
  Pixelverhältnis 1 — 1100x638 statt der 2200x1276, die ein sichtbares Fenster liefert. Alle
  Oberflächen-Belege eines halben Tages entstanden dadurch in halber Auflösung, und eine
  1-Pixel-Kante, die die Verkleinerung nicht überlebte, wurde als Layoutfehler gedeutet. Mit
  erzwungenem Skalierungsfaktor liefert der **kopflose** Lauf exakt dasselbe Bild wie das
  sichtbare Fenster. Damit bleibt es bei der strengen Regel: kein sichtbares Fenster, kein
  `show()`, kein `showInactive()`, kein Anheben — kopflos ist nicht die Einschränkung, sondern
  der bessere Weg. Freigabe des Nutzers, ein Fenster sichtbar zu starten, wird dadurch
  gegenstandslos; sie war an „auf einem freien screen" gebunden, und diese Maschine hat nur
  einen Bildschirm. Ein sichtbar gestartetes Fenster landete prompt dort, wo er gerade
  arbeitete.
  gegenläufig. `peer-shot <titel-muster> <ziel.png>` liegt NUR auf peer selbst
  (`~/.local/bin/peer-shot`, KDE Plasma 6/Wayland) und macht dort die fenstergenaue Aufnahme —
  kein Vollbild-Fallback, mehrdeutiges Muster bricht ab, genau wie bei `wb-shot`. Vom Mac aus
  ruft **`wb-shot-remote <titel-muster> <ziel.png>`** `peer-shot` per SSH auf, holt NUR die
  entstandene PNG per SCP herüber und löscht sie auf peer wieder — Auslöser: eine Aufnahme wird
  auf peer gebraucht, während gerade vom Mac aus gearbeitet wird.
- **Auf peer gilt seit dem Omarchy-Umstieg `grim`, nicht `peer-shot` (gemessen 2026-08-25, am
  2026-09-05 erneut bestätigt — `command -v peer-shot` findet dort nichts, `grim` liegt in
  `/usr/bin/grim`).** peer fährt jetzt Hyprland statt KDE Plasma. `peer-shot` ruft intern
  `org.kde.KWin.ScreenShot2` auf und scheitert dort mit
  `org.freedesktop.DBus.Error.ServiceUnknown` — nicht weil niemand angemeldet ist, sondern weil
  es KWin auf dieser Maschine nicht mehr gibt. Der Absatz darunter beschreibt insoweit den
  Nobara-Stand; die REGEL bleibt unverändert, nur das Werkzeug wechselt. Fenstergenau geht es so:
  ```bash
  export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1
  export HYPRLAND_INSTANCE_SIGNATURE=$(ls -t /run/user/1000/hypr/ | head -1)
  hyprctl clients                      # liefert je Fenster at: X,Y und size: B,H
  grim -g "<X>,<Y> <B>x<H>" ziel.png   # exakt dieses Fenster, kein Vollbild
  ```
  Ohne `XDG_RUNTIME_DIR` bricht `grim` mit „XDG_RUNTIME_DIR is invalid or not set" ab, ohne
  `HYPRLAND_INSTANCE_SIGNATURE` liefert `hyprctl` nichts — beides in derselben Session gemessen.
  Fenster können sich überlappen: `grim` fotografiert, was oben liegt, nicht das gemeinte
  Fenster. Vor der Aufnahme prüfen, ob ein anderes Fenster dieselbe Fläche belegt, und das
  Ergebnis ansehen, statt es für bare Münze zu nehmen.
- **Der folgende Absatz gilt für die KDE-Zeit (gemessen 2026-08-04), nicht mehr für peer heute
  — er hieß bis 2026-09-05 „Die eine Voraussetzung auf peer: eine angemeldete Plasma-Sitzung":**
  Der Sitzungsbus ist auch über eine reine SSH-Shell erreichbar; hängt peer dagegen im
  SDDM-Anmeldebildschirm, läuft kein `plasmashell`, KWin trägt seinen DBus-Namen nicht, und
  `peer-shot` beendet sich sauber mit Exit 4 und der Meldung „Keine grafische KDE-Sitzung
  erreichbar". Dieser Exit 4 ist der einzige Fall, in dem eine Aufnahme als offener Punkt
  gemeldet wird — sonst wird `peer-shot` benutzt statt ausgewichen. Ein Fehlschlag hier ist
  nie ein Grund, auf eine Vollbildaufnahme oder ein anderes Werkzeug auszuweichen.
