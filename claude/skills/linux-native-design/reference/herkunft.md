# Herkunft, Lizenzen, Prüfung

Erhebung vom 25.08.2026. Geprüft wurden der Skill, den Omarchy selbst ausliefert, und zwei
Fassungen aus der Gemeinschaft. Kein Text aus einer dieser Quellen steht in diesem Skill;
übernommen wurden Aufbau, Gliederungsideen und die Frage, welche Themen hineingehören.

Jede harte Zahl in diesem Skill stammt aus der GNOME-Dokumentation, aus der
Protokollbeschreibung oder aus einer eigenen Messung auf peer, und trägt ihre Fundstelle.

## Die Quellen

| Quelle | Lizenz | Stand | Was es ist |
|---|---|---|---|
| GNOME Human Interface Guidelines, `developer.gnome.org/hig` | CC BY-SA 4.0 | abgerufen 25.08.2026 | die Richtlinie selbst |
| libadwaita-Dokumentation, `gnome.pages.gitlab.gnome.org/libadwaita/doc/1-latest` | CC BY-SA 4.0 | abgerufen 25.08.2026 | Stilklassen und CSS-Variablen |
| `wlr-layer-shell-unstable-v1`, gelesen über `wayland.app` | Protokolltext, MIT-artig | abgerufen 25.08.2026 | Ebenen, Anker, Tastatur, beanspruchter Streifen |
| Omarchy 4.0.0-1 auf peer | MIT (`basecamp/omarchy`) | gemessen 25.08.2026 | Theme-Mechanik, Pfade, Befehle, `hyprctl layers` |
| `robzolkos/omarchy-skill` | MIT | zuletzt gesehen 25.08.2026 | Gemeinschaftsfassung des Omarchy-Skills |
| `BitYoungjae/marketplace`, Skill `omarchy-theming` (über LobeHub) | MIT | zuletzt gesehen 25.08.2026 | Theme-Bau, `colors.toml` |

Die Aussagen aus HIG und libadwaita sind paraphrasiert und mit Fundstelle belegt; die
wenigen wörtlichen Sätze sind als Zitat gekennzeichnet und im englischen Original belassen.
Das ist der Umgang, den CC BY-SA für kurze Zitate erlaubt, ohne dass dieser Skill selbst
unter die Weitergabebedingung fällt.

## Sicherheitsbefunde

Gesucht wurde nach eingebetteten Agenten-Anweisungen, nach Nachladen aus dem Netz zur
Laufzeit, nach Skripten, die außerhalb ihres Ordners schreiben, und nach allem, was Rechte
ausweitet.

**1. Ohne Befund im engeren Sinn.** In keiner der drei Skill-Quellen steht eine Wendung wie
`ignore previous`, `you are now` oder ein Satz, der sich über die Regeln des Agenten stellt.
Kein Installationsskript, kein verdeckter Netzaufruf, keine Abfrage von Zugangsdaten.

**2. Zwei Wege nach draußen, die eine Hausregel brauchen.** Der mitgelieferte Skill leitet in
`contributing.md` dazu an, GitHub-Issues anzulegen und Pull Requests zu öffnen, und
`omarchy debug` bietet ohne Flags an, das Diagnoseprotokoll zu `logs.omarchy.org`
hochzuladen. Beides ist für einen Menschen gedacht. Die Einschränkungen stehen in
`~/.claude/skills/omarchy/HAUS.md`.

**3. Dokumentation, die zur Laufzeit von fremden Hosts geholt wird.** Der mitgelieferte
Skill schickt den Agenten vor jeder Fensterregel ins Hyprland-Wiki - sachlich richtig, weil
sich die Syntax ändert. Die Gemeinschaftsfassung von `robzolkos` geht weiter: Sie verlangt,
bei jeder allgemeinen Frage zuerst eine Seite von `learn.omacom.io` zu holen, und liefert
dafür einen Index von rund vierzig Adressen mit. Was von dort kommt, liegt danach als
vermeintliche Systemdokumentation im Kontext. Nicht übernommen.

## Was aus jeder Quelle wurde

### Der von Omarchy mitgelieferte Skill

**Übernommen, und zwar vollständig und wörtlich** - aber als eigener Skill unter
`~/.claude/skills/omarchy/`, nicht in diesen hier. Er ist die einzige Fassung, die zur
installierten Maschine passt, weil er aus demselben Paket kommt und mit ihm altert. Die
Prüfung steht in `~/.claude/skills/omarchy/HERKUNFT.md`.

**Für diesen Skill übernommen:** die Theme-Mechanik als Ausgangspunkt der eigenen Messung,
und die Trennung zwischen "den Rechner einrichten" und "eine Anwendung bauen", die die
Abgrenzung in `SKILL.md` trägt.

**Verworfen:** nichts. Der Skill beschreibt das Konfigurieren, nicht das Gestalten; er ist
hier kein Wettbewerber, sondern der Nachbar.

### robzolkos/omarchy-skill

**Verworfen als Quelle für Pfade, Befehle und Konfigurationsformate.** Der Skill beschreibt
Omarchy vor der Fassung 4. Gegen die installierte Maschine gemessen ist fast jede konkrete
Angabe falsch:

| Der Skill sagt | Auf peer gemessen |
|---|---|
| Kerndateien liegen in `~/.local/share/omarchy/` | `/usr/share/omarchy/`, und `~/.local/share/omarchy` existiert nicht |
| Befehle heißen `omarchy-<gruppe>-<aktion>`, rund 145 Stück | ein `omarchy`-Kommando mit Untergruppen, `omarchy commands` listet sie; die alten Binärdateien liegen weiter im Pfad |
| Hyprland-Konfiguration ist `.conf` | `.lua`, bis auf `hyprsunset.conf` und `xdph.conf` |
| Statusleiste ist Waybar, `~/.config/waybar/` | Quickshell (`omarchy-shell`), `~/.config/omarchy/shell.json`; kein Waybar installiert |
| Starter ist Walker, `~/.config/walker/` | Quickshell-Menü, `~/.config/omarchy/extensions/omarchy-menu.jsonc` |

**Übernommen:** ein Gedanke, und der steht ohnehin schon im mitgelieferten Skill - Befehle
werden entdeckt statt abgeschrieben, weil eine abgeschriebene Liste veraltet. Genau dieser
Skill ist der Beleg dafür.

**Ebenfalls brauchbar, aber nicht hierher gehörig:** das Muster, nach einer Änderung in
zwei, drei Sätzen zu erklären, welche Datei geändert wurde und was die Einstellung bewirkt.
Das ist im Haus schon durch die Berichtsform abgedeckt.

### BitYoungjae, Skill omarchy-theming

**Übernommen:** der Aufbau der Theme-Dokumentation. Ein Schlüsselverzeichnis mit
Bedeutungsspalte, die Trennung zwischen den Schreibweisen eines Platzhalters und eine
Aufzählung der erzeugten Konfigurationen - diese Gliederung liegt `omarchy.md` zugrunde.
Übernommen auch der Hinweis, dass ein Theme eine fertige Datei mitliefern kann, um die
erzeugte zu überstimmen.

**Verworfen: die 22 Farbvariablen.** Der Skill nennt sie als Pflichtschema:
`accent`, `cursor`, `foreground`, `background`, `selection_foreground`,
`selection_background` und `color0` bis `color15`. Auf peer gemessen definiert kein einziges
der 22 mitgelieferten Themes auch nur einen dieser `color`-Schlüssel. Omarchy 4 benutzt
benannte Schlüssel (`red`, `bright_red`, `muted`, `dark_background` und so fort); die alten
Namen existieren nur noch als Aliasse beim Auflösen, nicht in den Dateien. Wer nach dem
fremden Schema ein Theme schreibt, bekommt ein Theme, in dem `muted`, `selection` und die
vier Hintergrundstufen fehlen.

Dass die Zahl 22 zufällig auch die Anzahl der mitgelieferten Themes ist, hat die Prüfung
kurz in die Irre geführt. Es ist keine Verbindung, nur ein Zusammentreffen.

**Verworfen: der Marker `light.mode`.** Der Skill nennt eine leere Datei dieses Namens als
den Weg zum hellen Theme. In Omarchy 4 steht der Modus als `mode = "light"` in der
`colors.toml`; die Datei wird noch gelesen, aber erst an dritter Stelle der Rückfallkette und
im Quelltext ausdrücklich als "legacy" bezeichnet. Kein mitgeliefertes Theme benutzt sie.

**Verworfen: die Befehlsnamen** (`omarchy-theme-set`, `omarchy-theme-remove` und so fort) zu
Gunsten der Form `omarchy theme set`. Die alten Namen funktionieren weiter, sind aber nicht
mehr die dokumentierte Schnittstelle.

**Verworfen: die Kontrastempfehlungen.** Der Skill empfiehlt Bereiche für Hintergrund- und
Vordergrundfarben ("background should be #1a-#2e range"). Das ist keine Messung, sondern
eine Faustregel ohne Quelle, und sie kollidiert mit dem, was die GNOME HIG zum
Hochkontrast-Modus verlangt.

### GNOME HIG und libadwaita

**Übernommen:** die Regeln, mit Fundstelle. **Der wichtigste Befund ist ein negativer:** Die
GNOME HIG nennt fast keine Zahlen - keine Mindestgröße für Klickziele, kein
Kontrastverhältnis, keine Abstandstabelle. Fünf der sechs durchgesehenen Seiten enthalten
überhaupt keinen Messwert. Wer aus einem Blogtext eine GNOME-Zahlentabelle übernimmt,
übernimmt eine Erfindung. Deshalb steht dieser Befund in `gnome-hig.md` ganz oben und nicht
in einer Fußnote.

## Was keine Quelle hatte

1. Die gemessene Feststellung, dass Omarchy 4 die durchnummerierten Farbschlüssel nur noch
   als Alias führt - beide Gemeinschaftsfassungen behaupten das Gegenteil.
2. Die Ebenenwahl für layer-shell mit dem Argument aus dem Protokolltext, dass die
   Reihenfolge innerhalb einer Ebene undefiniert ist, samt der Messung, dass Omarchy selbst
   die Ebene `overlay` im laufenden Betrieb leer lässt.
3. Der Weg, `omarchy-theme-color --all` als Schnittstelle für eine eigene Anwendung zu
   benutzen, statt `colors.toml` selbst zu parsen.
4. Die Zusammenstellung von GNOME-HIG-Regel, libadwaita-Werkzeug und Omarchy-Anbindung in
   einem Skill. Die Quellen decken je eine der drei Ebenen ab, keine zwei.
