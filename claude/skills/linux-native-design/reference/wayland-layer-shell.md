# Wayland und layer-shell: Etikette für alles, was kein Fenster ist

Grundlage ist das Protokoll `wlr-layer-shell-unstable-v1`, abgerufen am 25.08.2026 von
`https://wayland.app/protocols/wlr-layer-shell-unstable-v1`. Die Zitate sind wörtlich aus
der Protokollbeschreibung. Unter GTK4 heißt die Anbindung `gtk4-layer-shell`.

Ein gewöhnliches Fenster braucht das alles nicht. Gebraucht wird es für Panels, Docks,
Statusleisten, Hintergrundbilder, Benachrichtigungen, Bildschirmsperren und für alles, was
auf dem Desktop sitzt, statt in der Fensterverwaltung aufzutauchen.

## Die vier Ebenen, und warum `overlay` fast nie stimmt

Es gibt `background` (0), `bottom` (1), `top` (2) und `overlay` (3). Sie sind "ordered by z
depth, bottom-most first". Entscheidend ist der zweite Satz: "multiple surfaces can share a
single layer, and ordering within a single layer is undefined."

Daraus folgt die wichtigste Regel dieses Abschnitts. Innerhalb einer Ebene entscheidet
nichts, wer oben liegt. Wer seine Fläche auf `overlay` legt, konkurriert also mit der
Bildschirmsperre und mit allem, was im Notfall sichtbar sein muss - und wer dann gewinnt,
ist nicht festgelegt. Eine dekorative Fläche auf `overlay` kann über der Sperre landen.

Wonach die Ebene gewählt wird:

| Ebene | Wofür |
|---|---|
| `background` | Hintergrundbild, alles unter den Fenstern |
| `bottom` | etwas, das auf dem Desktop liegt, aber von Fenstern verdeckt werden darf |
| `top` | Panels, Docks, Statusleisten: über den Fenstern, unter dem, was den Bildschirm sperrt |
| `overlay` | Bildschirmsperre, Notabschaltung, Bedienung während einer Vollbildwiedergabe |

Gemessen auf peer am 25.08.2026 (`hyprctl layers`) benutzt Omarchy selbst im laufenden
Betrieb genau zwei Ebenen: das Hintergrundbild liegt auf `background`, die eigene Bar
(`namespace: omarchy-bar`) auf `top`. `overlay` ist leer. Eine eigene Fläche auf `overlay`
liegt damit über der Systemleiste des Systems, in das sie sich einfügen soll.

## Platz beanspruchen oder nicht

`set_exclusive_zone` regelt, ob andere Flächen ausweichen müssen. Ein positiver Wert "is the
distance from the edge in surface-local coordinates to consider exclusive"; er reserviert
also diesen Streifen, und Fenster werden daneben angeordnet. Null bedeutet, die Fläche
"would like to be moved to avoid occluding surfaces with a positive exclusive zone" - sie
beansprucht nichts und weicht selbst aus. Minus eins bedeutet, sie "would not like to be
moved to accommodate for other surfaces", und der Compositor zieht sie bis an die Kanten,
an denen sie verankert ist.

Praktisch: Ein Panel, das dauerhaft am Rand steht, nimmt einen positiven Wert. Alles, was
über dem Inhalt schwebt und ihn nicht verdrängen soll, nimmt null. Minus eins ist für
Vollflächiges wie das Hintergrundbild oder die Sperre und sonst für nichts.

Wichtig beim Rechnen: "the exclusive zone includes the margin." Der Rand zählt mit, er kommt
nicht obendrauf.

## Tastatur

`set_keyboard_interactivity` hat drei Werte. `none` (0) ist die Voreinstellung und heißt "no
keyboard focus is possible". `exclusive` (1) fordert den Fokus an und nimmt ihn allem
anderen weg. `on_demand` (2) gibt es seit Fassung 4 des Protokolls und "requests the
compositor to allow this surface to be focused and unfocused by the user in an
implementation-defined manner".

Die Etikette ist einfach: `on_demand` für alles, was Eingaben entgegennimmt, `none` für alles
andere. `exclusive` ist für die Bildschirmsperre und für Passworteingaben da. Eine Fläche,
die dem Menschen die Tastatur wegnimmt, während er in einem anderen Fenster tippt, ist ein
Fehler.

Daraus folgt die Gegenprobe für die Barrierefreiheit: Eine Fläche mit `none`, die man
anklicken kann, ist mit der Tastatur nicht erreichbar. Entweder sie bekommt `on_demand`,
oder es gibt einen zweiten Weg zu ihrer Funktion - eine Tastenbelegung im
Fenstermanager, ein Kommandozeilenaufruf, ein Eintrag im Menü. Der Weg wird dokumentiert,
sonst gibt es ihn für den Menschen nicht.

## Verankern und Rand

`set_anchor` verankert die Fläche "to the specified edges and corners". Bei zwei
rechtwinklig zueinander stehenden Kanten ist der Ankerpunkt ihr Schnittpunkt, bei einer
Kante die Mitte dieser Kante, ohne Angabe die Bildschirmmitte. `set_margin` setzt die Fläche
"some distance away from the anchor point on the output".

Zwei Flächen derselben Anwendung, die nebeneinander stehen sollen, werden über denselben
Anker und einen um die Breite der ersten erhöhten Rand gesetzt. Wer stattdessen absolute
Bildschirmkoordinaten rechnet, hat bei jedem zweiten Monitor und jeder anderen Skalierung
ein Problem.

## Namensraum

`set_namespace` gibt der Fläche einen Namen, den der Compositor sieht. Auf Hyprland ist das
der Name, über den `layerrule` greift, und der Name, unter dem die Fläche in
`hyprctl layers` auftaucht. Jede layer-shell-Fläche bekommt einen, und zwar einen, der die
Anwendung erkennbar macht - sonst kann der Mensch keine Regel dafür schreiben und niemand
sieht in der Diagnose, wem die Fläche gehört.

## Was nicht vergessen wird

- **Mehrere Monitore.** Eine layer-shell-Fläche gehört zu einem Ausgang. Wird keiner gesetzt,
  entscheidet der Compositor, und die Fläche kann bei jedem Start woanders erscheinen. Der
  Ausgang wird über seinen Namen gewählt, nicht über seinen Index, weil der Index sich beim
  Anstecken eines Monitors verschiebt.
- **Skalierung.** Alle Werte sind in Oberflächenkoordinaten. Auf einem Bildschirm mit
  doppelter Skalierung wird nichts von Hand verdoppelt.
- **Kein X11-Rückfall.** `gtk4-layer-shell` funktioniert nur unter Wayland. Startet die
  Anwendung unter X11 in einen Rückfall, entsteht ein gewöhnliches Fenster an einer
  zufälligen Stelle. Besser ist, den Start abzulehnen und zu sagen, warum.
