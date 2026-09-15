# Omarchy-Einbindung: die Farben des Systems übernehmen

Alles hier ist am 25.08.2026 auf peer gemessen worden, gegen Omarchy 4.0.0-1. Die Pfade und
Schlüssel stammen aus dem Quelltext der ausgelieferten Befehle und aus den Themes selbst,
nicht aus einer Beschreibung im Netz. Wer gegen eine ältere Omarchy-Fassung baut, misst
nach - zwischen Omarchy 3 und 4 hat sich fast alles davon geändert.

## Wo das aktive Theme liegt

```
~/.local/state/omarchy/current/theme/        Kopie des aktiven Themes
~/.local/state/omarchy/current/theme/colors.toml
~/.local/state/omarchy/current/theme.name    Kennung, klein geschrieben, z. B. everforest
~/.local/state/omarchy/current/background    Symlink auf das aktive Hintergrundbild
```

`omarchy theme set` kopiert das gewählte Theme dorthin, zuerst aus
`/usr/share/omarchy/themes/<name>/`, danach aus `~/.config/omarchy/themes/<name>/`, sodass
eine Nutzerfassung die mitgelieferte überlagert. `omarchy theme dir <name>` gibt den
Quellordner aus und bevorzugt dabei ebenfalls die Nutzerfassung.

Eine Anwendung liest also `~/.local/state/omarchy/current/theme/colors.toml` und sonst
nichts. Der Weg über `/usr/share/omarchy/themes/` ist falsch: Dort steht der Auslieferzustand,
nicht das, was gerade eingestellt ist.

## Die Farbschlüssel in Omarchy 4

Die Schlüssel sind benannt, nicht durchnummeriert. Alle 22 mitgelieferten Themes definieren
diese 24 Schlüssel; `orange` und `brown` fehlen in dreien.

```toml
mode = "dark"                  # oder "light"

accent    = "#89b4fa"
selection = "#45475a"
muted     = "#585b70"

background         = "#1e1e2e"
dark_background    = "#161622"
darker_background  = "#101019"
lighter_background = "#313244"

foreground        = "#cdd6f4"
dark_foreground   = "#6c7086"
light_foreground  = "#bac2de"
bright_foreground = "#cdd6f4"

red = "#f38ba8"   yellow = "#f9e2af"   orange = "#f6b6ab"   green = "#a6e3a1"
cyan = "#94e2d5"  blue = "#89b4fa"     magenta = "#f5c2e7"  brown = "#7b5b55"

bright_red = "…"  bright_yellow = "…"  bright_green = "…"
bright_cyan = "…" bright_blue = "…"    bright_magenta = "…"
```

Die aus Omarchy 3 bekannten Namen `color0` bis `color15`, `cursor`,
`selection_foreground`, `selection_background`, `bg`, `fg`, `purple`, `theme_type` gibt es
weiterhin, aber nur noch als Aliasse beim Auflösen. In den Theme-Dateien selbst stehen sie
nicht mehr. Wer ein Theme schreibt, benutzt die benannten Schlüssel; wer eines liest, darf
beide Schreibweisen abfragen.

Drei Schlüssel kommen in einzelnen Themes dazu, wenn ein Theme den Fensterrahmen selbst
bestimmen will: `hyprland_active_border`, `hyprland_inactive_border` und
`active_tab_background`.

## Farben auslesen, ohne einen TOML-Parser mitzubringen

Omarchy liefert dafür einen eigenen Befehl aus. Er löst dieselbe Alias- und Rückfallkette
auf, die auch die erzeugten Konfigurationsdateien benutzen, sodass jede Anwendung dieselbe
Palette sieht:

```bash
omarchy-theme-color --all          # jeder aufgelöste Schlüssel, Tabulator, Wert
omarchy-theme-color --raw          # nur, was wirklich in der Datei steht
omarchy-theme-color accent         # ein Wert
omarchy-theme-color accent blue    # ein Wert, mit einem anderen Schlüssel als Rückfall
omarchy-theme-color --file <pfad> mode
```

Ohne `--file` liest der Befehl das aktive Theme. `--all` ist der bequemste Weg für eine
Anwendung: eine Zeile je Schlüssel, durch einen Tabulator getrennt, alphabetisch sortiert.
Das lässt sich in jeder Sprache in fünf Zeilen einlesen, und die Anwendung braucht keine
TOML-Abhängigkeit.

Gemessene Ausgabe auf dem Theme Everforest, gekürzt:

```
accent	#7fbbb3
background	#2d353b
foreground	#d3c6aa
mode	dark
muted	#475258
```

Wer den Befehl nicht aufrufen will, liest die Datei selbst. Dann fehlen aber die Aliasse und
die Modus-Ermittlung, und beides muss von Hand nachgebaut werden.

## Hell oder dunkel

Der Modus wird in dieser Reihenfolge bestimmt: der Schlüssel `mode`, dann der alte Schlüssel
`theme_type`, dann eine leere Datei `light.mode` neben der `colors.toml`, dann die Helligkeit
der Hintergrundfarbe (Summe der drei Kanäle über 382 gilt als hell), sonst dunkel.

Von den 22 mitgelieferten Themes sind fünf hell: `catppuccin-latte`, `flexoki-light`,
`lupine`, `rose-pine` und `white`. Eine Oberfläche, die eine dunkle Fläche fest einträgt, ist
also auf knapp einem Viertel der Themes falsch.

Für eine libadwaita-Anwendung ist das meist schon erledigt: `omarchy-theme-set-gnome` setzt
beim Theme-Wechsel `org.gnome.desktop.interface color-scheme` auf `prefer-light` oder
`prefer-dark` und das GTK-Theme auf `Adwaita` oder `Adwaita-dark`. `AdwStyleManager` folgt
dem ohne weiteres Zutun. Der Weg über `colors.toml` lohnt sich dann nur noch für die
Akzentfarbe und für Flächen, die genau zum Theme passen sollen.

## Den Theme-Wechsel mitbekommen

Eine Anwendung, die die Farben beim Start einliest und danach nie wieder, steht nach dem
nächsten Theme-Wechsel falsch da. Zwei Wege, beide gemessen:

1. **Ein Hook.** `omarchy theme set` ruft am Ende `omarchy-hook theme-set <kennung>` auf.
   Alles, was in `~/.config/omarchy/hooks/theme-set.d/` liegt und ausführbar ist, wird
   ausgeführt und bekommt die Kennung als erstes Argument. Installiert wird ein Skript mit
   `omarchy hook install theme-set <skript>`. Das ist der richtige Weg, wenn eine Anwendung
   von außen neu geladen werden soll.
2. **Selbst beobachten.** Die Anwendung überwacht
   `~/.local/state/omarchy/current/theme.name` mit einem Dateibeobachter (unter GTK:
   `gio::File::monitor_file`) und liest die Farben neu, wenn sich die Datei ändert. Das ist
   der richtige Weg, wenn die Anwendung ohnehin läuft und sich selbst umfärben kann, weil
   sie dann ohne Fremdskript im Nutzerordner auskommt.

Beim Neuladen wird der ganze `CssProvider` ersetzt, nicht einzelne Regeln nachgeschoben.

## Eigene Konfigurationsdateien aus dem Theme erzeugen lassen

Omarchy erzeugt beim Theme-Wechsel die Konfigurationen der mitgelieferten Programme aus
Vorlagen in `/usr/share/omarchy/default/themed/*.tpl`. Die Platzhalter haben drei
Schreibweisen, die in den Vorlagen von Omarchy 4 nachgelesen sind:

| Schreibweise | Ergebnis | Wofür |
|---|---|---|
| `{{ accent }}` | `#89b4fa` | CSS, TOML, JSON |
| `{{ accent_strip }}` | `89b4fa` | Hyprlands `rgb()` |
| `{{ accent_rgb }}` | `137,180,250` | `rgba()`-Werte |

Dazu kommen in Omarchy 4 Funktionsaufrufe wie
`{{ hypr_gradient hyprland_active_border accent }}` und
`{{ shell_gradient hyprland_active_border accent }}`, die einen Farbverlauf aus dem
Fensterrahmen bilden und auf den zweiten Schlüssel zurückfallen.

Eine eigene Anwendung braucht dieses System nicht, um sich einzufügen - der direkte Weg über
`omarchy-theme-color` ist einfacher. Interessant wird es erst, wenn ein Theme die Anwendung
mitfärben können soll, ohne dass die Anwendung etwas davon weiß.

## Hyprland-Konventionen

- Die Konfiguration liegt in `~/.config/hypr/` und ist in Omarchy 4 **Lua**, nicht mehr
  `.conf`: `hyprland.lua`, `bindings.lua`, `monitors.lua`, `input.lua`, `looknfeel.lua`,
  `autostart.lua`. Zwei Dateien sind weiterhin `.conf`, weil andere Prozesse sie lesen:
  `hyprsunset.conf` und `xdph.conf`.
- Eine Anwendung, die eine Tastenbelegung braucht, schreibt sie nicht selbst in die
  Konfiguration des Menschen. Sie nennt die Zeile in ihrer Dokumentation und überlässt ihm
  die Entscheidung.
- Wer doch eine setzt, prüft vorher mit `omarchy menu keybindings --print`, ob die Taste
  belegt ist, und setzt gegebenenfalls ein `hl.unbind(...)` davor. Sonst bricht eine
  vorhandene Belegung ohne Hinweis weg.
- Nach jeder Änderung an der Lua-Konfiguration wird mit `hyprctl reload` und danach
  `hyprctl configerrors` geprüft. Ohne die zweite Prüfung bleibt ein Fehler unbemerkt.
- Fensterregeln nie aus dem Gedächtnis: Ihre Syntax ändert sich zwischen Hyprland-Fassungen.
  Vorher im Wiki nachsehen, so wie es der Skill `omarchy` verlangt.
- Für eine layer-shell-Fläche greift `layerrule` über den Namensraum aus `set_namespace`. Ein
  sprechender Namensraum ist damit die Bedingung dafür, dass der Mensch überhaupt eine Regel
  für die Anwendung schreiben kann.

## Auf einer Maschine ohne Omarchy

Fehlt `~/.local/state/omarchy/current/theme/colors.toml`, ist das kein Fehler, sondern der
Normalfall auf jedem anderen Linux. Dann gelten die libadwaita-Variablen aus `libadwaita.md`,
und die Anwendung sieht dort genauso richtig aus. Der Rückfall wird beim Start einmal
entschieden und nicht bei jedem Zeichnen erneut geprüft.
