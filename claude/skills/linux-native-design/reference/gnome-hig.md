# GNOME Human Interface Guidelines - die Kernregeln

Abgerufen am 25.08.2026 von `https://developer.gnome.org/hig/`. Die Fundstelle steht bei
jeder Aussage; wörtliche Zitate sind als solche gekennzeichnet und englisch belassen.

## Das Wichtigste zuerst: die GNOME HIG nennt fast keine Zahlen

Wer von Apple kommt, sucht hier vergeblich nach einer Tabelle mit Mindestgrößen,
Kontrastverhältnissen und Abständen. Es gibt sie nicht. Nachgesehen wurde in
`guidelines/accessibility.html`, `guidelines/pointer-touch.html`, `guidelines/ui-styling.html`,
`guidelines/typography.html`, `guidelines/adaptive.html` und `patterns/containers/windows.html`
- fünf dieser sechs Seiten enthalten überhaupt keinen Messwert.

Zu Klickzielen sagt `guidelines/pointer-touch.html` nur: "Click targets should be large
enough to be comfortably used with different pointing devices and physical abilities." Keine
Pixelzahl. Zu Kontrast sagt `guidelines/accessibility.html` keinen Wert, sondern verlangt,
den Hochkontrast-Modus zu testen.

Praktisch heißt das: Die Werte kommen nicht aus der Richtlinie, sondern aus libadwaita. Wer
die Stilklassen und Variablen aus `libadwaita.md` benutzt, hat die Abstände, Größen und
Kontraste bereits richtig, und zwar in hell, dunkel und Hochkontrast gleichzeitig. Wer sie
selbst setzt, muss jeden dieser drei Fälle selbst prüfen.

Eine Zahl aus einem Blogtext oder einem fremden Skill gilt hier nicht. Wird eine gebraucht,
wird sie bei GNOME nachgeschlagen und unten nachgetragen.

## Die Zahlen, die es wirklich gibt

| Wert | Wofür | Fundstelle |
|---|---|---|
| 1024 × 600 px | kleinste Anzeigegröße, die jede Anwendung auf dem Desktop unterstützen soll | `guidelines/adaptive.html`, "Small Size Handling" |
| 360 × 294 px | darauf muss herunterskalieren, was auch auf einem Telefon laufen soll | ebenda |
| 16 × 16 px | Nennmaß, in dem symbolische Icons gezeichnet werden | `guidelines/ui-icons.html`, "UI Icon Style" |
| 32, 64, 128 px | die einzigen weiteren Größen, in denen ein symbolisches Icon benutzt werden darf | ebenda |
| 2 px | Strichstärke für die Hauptformen eines Icons; 1 px möglichst vermeiden | ebenda |
| 15 px | `--window-radius`, die Eckenrundung des Fensters in libadwaita | `libadwaita.md` |

Wörtlich zur Anzeigegröße: "The smallest recommended display size for GNOME on desktop is
currently 1024×600px, and this size should be supported by all apps. Apps that are
appropriate for a phone form factor should scale down to 360×294px."

Wörtlich zu den Icon-Größen: "Symbolics are drawn as 16×16px SVGs and can be used at
32×32px, 64×64px and 128×128px." Andere Größen führen zu unscharfer Darstellung.

## Typografie

Fundstelle: `guidelines/typography.html`.

Die Regel, die am häufigsten gebrochen wird, steht dort wörtlich: "Don't hard-code font
styles or sizes, since this can interfere with accessibility features." Ein `font-size: 90%`
im eigenen CSS setzt genau das außer Kraft, was der Mensch in den Systemeinstellungen unter
"Große Schrift" eingestellt hat.

Stattdessen die Systemschrift (in GNOME Adwaita Sans) und die Stilklassen benutzen. Die
Klassen heißen `body`, `heading`, `caption`, `caption-heading`, `large-title`, `title-1`,
`title-2`, `title-3` und `title-4`. Sie gibt es in GTK 4, nicht in GTK 3.

Die Seite nennt außerdem die Zeichen, die im Oberflächentext richtig sind, statt der
Behelfszeichen von der Tastatur:

| Zeichen | Unicode | Statt |
|---|---|---|
| Auslassungspunkte | U+2026 | drei Punkte |
| Multiplikationszeichen | U+00D7 | Buchstabe x |
| Halbgeviertstrich | U+2013 | Bindestrich als Gedankenstrich |
| Aufzählungszeichen | U+2022 | Sternchen |
| schmales geschütztes Leerzeichen | U+202F | gewöhnliches Leerzeichen |

Für deutsche Oberflächen kommen die deutschen Anführungszeichen dazu. Das englische
Zeichenpaar U+201C und U+201D, das die Seite nennt, ist im deutschen Satz falsch.

## Hell, dunkel und Hochkontrast

Fundstelle: `guidelines/ui-styling.html`.

Die meisten Anwendungen sollen voreingestellt hell sein und der Systemeinstellung folgen;
wer eine eigene Einstellung anbietet, bietet drei Möglichkeiten an: hell, dunkel und
"Systemeinstellung folgen". Eigenes Aussehen soll so wenig wie möglich sein, weil es
gepflegt werden muss und Fehler erzeugt. Vorhandene Stilklassen und CSS-Variablen passen
sich hell, dunkel und Hochkontrast von selbst an; ein fester Wert tut das nie.

Der Hochkontrast-Modus wird ausdrücklich als Testfall genannt: "All parts of the UI should be
correctly rendered in the high-contrast style." Er ist über die Systemeinstellungen oder den
GTK Inspector erreichbar.

Zwei Verbote stehen dort ausdrücklich: Farbe darf nie das einzige Unterscheidungsmerkmal
sein, und nichts in der Oberfläche blinkt oder flackert.

## Barrierefreiheit

Fundstelle: `guidelines/accessibility.html`. Die Seite gibt keine Zahlen vor, sondern fünf
Prüfungen. Sie sind die Abnahmeliste dieses Skills und stehen deshalb auch in `abnahme.md`.

1. **Zugängliche Namen.** "All interface elements should have descriptive, accessible names."
   Kurz und beschreibend. Das gilt auch für ein Symbol ohne Beschriftung und für eine Fläche,
   die nur angeklickt wird.
2. **Hochkontrast.** Jeder Teil der Oberfläche wird im Hochkontrast-Stil richtig dargestellt.
3. **Große Schrift.** Die Oberfläche bleibt bei großer Schrift benutzbar, und jede
   Beschriftung ist vollständig lesbar.
4. **Tastatur.** Jeder Teil der Oberfläche lässt sich mit der Tastatur erreichen und
   bedienen.
5. **Bildschirmleser.** Jedes Element wird vorgelesen, die Namen stimmen, und die Anwendung
   bleibt mit abgeschaltetem Bildschirm benutzbar. Dazu: Jedes Texteingabefeld muss sich mit
   der Bildschirmtastatur benutzen lassen.

## Fenster

Fundstelle: `patterns/containers/windows.html`.

- Hauptfenster sind voneinander unabhängig: Das Schließen eines Hauptfensters schließt kein
  anderes.
- Jedes Hauptfenster ist in der Größe veränderbar.
- Die Anfangsgröße richtet sich nach dem Inhalt. Ein Dokumentfenster bekommt Platz, ein
  Fenster mit wenig Oberfläche bleibt klein, statt eine leere Fläche zu zeigen.
- Ein Nebenfenster gehört zu einem Hauptfenster und schließt mit ihm. Es wird nicht größer
  als sein Hauptfenster, und Nebenfenster werden nicht übereinandergestapelt.
- Strg+W schließt ein Fenster. Ein modales Fenster schließt zusätzlich mit Esc.
- Wer die vorige Ansicht wiederherstellt, stellt auch die vorige Fenstergröße wieder her.

## Adaptive Oberflächen

Fundstelle: `guidelines/adaptive.html`.

Neben den beiden Größen oben gibt die Seite keine Bruchstellen vor. Für große Breiten
verlangt sie, den Inhalt in Containern mit einer Höchstbreite zu halten, statt ihn über den
ganzen Bildschirm zu ziehen - ohne einen Zahlenwert dafür zu nennen. In libadwaita macht das
`AdwClamp`, und die Bruchstellen setzt `AdwBreakpoint` mit den Werten, die zum eigenen
Inhalt passen.

## Icons in der Oberfläche

Fundstelle: `guidelines/ui-icons.html`.

- Ein Bedienelement trägt entweder eine Beschriftung oder ein Icon, nicht beides. Ausnahmen
  sind Seitenleisten und Ansichtswechsler.
- Nur Icons benutzen, die der Mensch zuverlässig wiedererkennt oder die durch Gewohnheit
  festliegen. Alles andere bekommt eine Beschriftung.
- Symbolische Icons sind einfarbig und werden programmatisch umgefärbt. Genau das macht sie
  themefähig; ein farbiges Bitmap ist es nicht.
- Keine Perspektive, alle Formen am Pixelraster ausgerichtet.
