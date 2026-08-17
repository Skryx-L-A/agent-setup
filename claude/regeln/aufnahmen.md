# regeln/aufnahmen.md

Inhalt: Aufnahmen fenstergenau, Fokus unangetastet. Gilt seit: 2026-07-25.
Diese Datei ist ausgelagert aus CLAUDE.md; sie gilt unverändert weiter.

Auslöser: bevor ein Screenshot oder eine Bildschirmaufnahme gemacht wird, auf beiden
Maschinen.

## Standing rules — Aufnahmen

- **Aufnahmen fenstergenau, Fokus unangetastet (2026-07-25), Orchestrator UND Worker, beide
  Maschinen:** NIEMALS den gesamten Bildschirm aufnehmen — jede Aufnahme wird exakt auf das gemeinte
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
- **Die eine Voraussetzung auf peer: eine angemeldete Plasma-Sitzung (gemessen 2026-08-04).**
  Der Sitzungsbus ist auch über eine reine SSH-Shell erreichbar; hängt peer dagegen im
  SDDM-Anmeldebildschirm, läuft kein `plasmashell`, KWin trägt seinen DBus-Namen nicht, und
  `peer-shot` beendet sich sauber mit Exit 4 und der Meldung „Keine grafische KDE-Sitzung
  erreichbar". Dieser Exit 4 ist der einzige Fall, in dem eine Aufnahme als offener Punkt
  gemeldet wird — sonst wird `peer-shot` benutzt statt ausgewichen. Ein Fehlschlag hier ist
  nie ein Grund, auf eine Vollbildaufnahme oder ein anderes Werkzeug auszuweichen.
