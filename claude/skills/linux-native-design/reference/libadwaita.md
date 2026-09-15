# libadwaita: Stilklassen und CSS-Variablen

Abgerufen am 25.08.2026 von der Dokumentation zur jeweils aktuellen Fassung:
`https://gnome.pages.gitlab.gnome.org/libadwaita/doc/1-latest/css-variables.html` und
`.../style-classes.html`. Wo eine Variable erst ab einer bestimmten Fassung existiert, steht
das dabei; wer gegen eine ältere baut, prüft das vorher.

Hier stehen die Werte, die die GNOME HIG bewusst nicht nennt. Das ist der Grund, warum
libadwaita im Haus die Voreinstellung ist: Wer diese Namen benutzt, bekommt hell, dunkel und
Hochkontrast geschenkt.

## Farben nie festschreiben

Jede Farbe in der Oberfläche kommt aus einer dieser Variablen. Sie sind im CSS als
`var(--name)` benutzbar.

### Flächen und Text

| Variable | Wofür |
|---|---|
| `--window-bg-color`, `--window-fg-color` | Fensterfläche, und alles mit der Klasse `.background` |
| `--view-bg-color`, `--view-fg-color` | Textansichten und Listen, Klasse `.view` |
| `--headerbar-bg-color`, `--headerbar-fg-color` | Kopfleiste |
| `--headerbar-border-color`, `--headerbar-backdrop-color`, `--headerbar-shade-color` | Trennlinie, unfokussierter Zustand, Schatten |
| `--sidebar-bg-color`, `--sidebar-fg-color`, `--sidebar-border-color`, `--sidebar-shade-color`, `--sidebar-backdrop-color` | Seitenleiste (ab 1.4) |
| `--secondary-sidebar-*` | mittlere Spalte einer dreispaltigen Ansicht (ab 1.4) |
| `--card-bg-color`, `--card-fg-color`, `--card-shade-color` | Karten und umrandete Listen, letzteres die Zeilentrenner |
| `--popover-bg-color`, `--popover-fg-color`, `--popover-shade-color` | Aufklapper (Schattenvariable ab 1.4) |
| `--dialog-bg-color`, `--dialog-fg-color` | Meldungsfenster (ab 1.2) |
| `--overview-bg-color`, `--overview-fg-color` | Übersicht (ab 1.7) |
| `--thumbnail-bg-color`, `--thumbnail-fg-color` | Vorschaubilder (ab 1.3) |
| `--active-toggle-bg-color`, `--active-toggle-fg-color` | aktiver Umschalter (ab 1.7) |

### Akzent

`--accent-bg-color` und `--accent-fg-color` gehören zusammen und sind für Flächen gedacht,
die eine Beschriftung tragen. `--accent-color` ist die freistehende Fassung für Text und
Symbole, weil sie auf der Fensterfläche genug Kontrast hat. Wer die falsche von beiden
nimmt, bekommt farbigen Text, den man nicht mehr lesen kann.

Die neun Akzentfarben, die der Mensch in den Systemeinstellungen wählen kann, sind
`--accent-blue` (#3584e4), `--accent-teal` (#2190a4), `--accent-green` (#3a944a),
`--accent-yellow` (#c88800), `--accent-orange` (#ed5b00), `--accent-red` (#e62d42),
`--accent-pink` (#d56199), `--accent-purple` (#9141ac) und `--accent-slate` (#6f8396). Diese
Werte werden nicht abgeschrieben, sondern über `--accent-bg-color` benutzt - sonst folgt die
Anwendung der Wahl des Menschen nicht mehr.

### Bedeutungsfarben

Für jede der vier gibt es dasselbe Dreigespann aus Fläche, Schrift darauf und freistehender
Fassung: `--destructive-bg-color` / `--destructive-fg-color` / `--destructive-color`, und
ebenso für `--success-`, `--warning-` und `--error-`.

Eine Warnung bekommt also `--warning-color`, keinen selbst gewählten Bernsteinton.

### Hilfswerte

| Variable | Wert | Bemerkung |
|---|---|---|
| `--border-opacity` | 15 % normal, 50 % im Hochkontrast | |
| `--dim-opacity` | 55 % normal, 90 % im Hochkontrast | das ist der Wert hinter `.dimmed` |
| `--disabled-opacity` | 50 % normal, 40 % im Hochkontrast | |
| `--window-radius` | 15 px | passt sich an maximiert und Vollbild an |
| `--border-color` | aus der aktuellen Vordergrundfarbe abgeleitet | trägt den Hochkontrast mit |
| `--shade-color`, `--scrollbar-outline-color` | Übergänge und Sichtbarkeit der Bildlaufleiste | |

Die drei Deckkraftwerte sind der Grund, warum `rgba(255, 255, 255, 0.55)` im eigenen CSS ein
Fehler ist und nicht nur eine Geschmacksfrage: Im Hochkontrast-Modus soll daraus 90 % werden,
und ein fester Wert macht das nicht mit.

## Stilklassen statt eigener Werte

### Schrift

`.title-1` bis `.title-4` für Überschriften, `.heading` für eine Überschrift in normaler
Textgröße, `.document` für längeren Fließtext (größere Schrift und mehr Zeilenabstand),
`.body` für Beschreibungstexte, `.caption-heading` und `.caption` für kleineren Beitext,
`.monospace` für Code, Protokolle und Befehle, `.numeric` für Zahlen, die sich ändern oder
untereinander stehen sollen.

`.caption` ersetzt jedes `font-size: 90%`.

### Schaltflächen

`.suggested-action` für die eine naheliegende Handlung, `.destructive-action` für die, die
etwas zerstört, `.flat` für flach bis zum Überfahren, `.raised` für das Gegenteil,
`.circular` für runde Symbolschaltflächen, `.pill` für die freistehende große Schaltfläche.

### Behälter

`.boxed-list` für eine Liste als eine Karte mit Zeilentrennern, `.boxed-list-separate` für
je eine Karte pro Zeile, `.card` für eine beliebige Karte, `.activatable` gibt einer Karte
die Zustände beim Überfahren und Drücken, `.toolbar` flacht Symbolschaltflächen darin
automatisch ab, `.navigation-sidebar` für die Liste in einer Seitenleiste, `.linked` fasst
mehrere Bedienelemente optisch zu einem zusammen.

### Zustand und Farbe

`.accent`, `.success`, `.warning`, `.error` färben ein Element in die jeweilige
Bedeutungsfarbe. `.dimmed` macht ein Element blasser und ersetzt die von Hand gesetzte
Deckkraft. `.osd` gibt die dunkle, halbdurchsichtige Fläche mit hellem Akzent, wie sie
Bedienelemente über einem Video haben - das ist die richtige Klasse für ein Overlay, das
über beliebigem Inhalt liegt, statt einer selbst gemischten Fläche.

## Der Hell-Dunkel-Wechsel

`AdwStyleManager` liest die Systemeinstellung und schaltet die Variablen um. Eine Anwendung,
die libadwaita einbindet und initialisiert, folgt damit dem Wechsel ohne weitere Zeile. Eine
eigene Einstellung setzt `color-scheme` auf `default`, `force-light` oder `force-dark`; die
GNOME HIG verlangt genau diese drei Möglichkeiten.

Auf Omarchy setzt `omarchy-theme-set-gnome` beim Theme-Wechsel
`org.gnome.desktop.interface color-scheme` auf `prefer-light` oder `prefer-dark`. Eine
libadwaita-Anwendung schaltet dadurch von selbst mit. Das ist der billigste Weg zu einer
Anwendung, die auf hellen und dunklen Themes richtig aussieht, und der Grund, warum
`omarchy.md` die Farbanbindung darüber hinaus nur für die Fälle beschreibt, in denen es die
Akzentfarbe des Themes wirklich braucht.
