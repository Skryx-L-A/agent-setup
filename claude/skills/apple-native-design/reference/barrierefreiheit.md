# Barrierefreiheit

Fundstelle für die Zahlen: HIG, „Accessibility", abgerufen am 19.08.2026; die Tabellen stehen in
`zahlen.md`. Diese Datei beschreibt, was daraus für den Entwurf und den Code folgt.

Barrierefreiheit ist eine Entwurfsbedingung. Wer sie nachträglich einbaut, baut das Layout ein
zweites Mal, weil skalierender Text jede feste Höhe sprengt.

## Was Systemkomponenten mitbringen

Eine Standardkomponente bringt Dynamic Type, VoiceOver-Rollen, Tastaturbedienung, Fokusreihenfolge,
Kontrastanpassung und Dark Mode ohne eine Zeile Zusatzcode. Eine eigene Komponente bringt nichts
davon. Das ist der eigentliche Grund, mit Systemkomponenten anzufangen – nicht Bequemlichkeit,
sondern die Frage, wie viel man nachbauen will.

## Die fünf Einstellungen, die ein Layout brechen

```swift
@Environment(\.dynamicTypeSize)              private var typeSize
@Environment(\.legibilityWeight)             private var legibilityWeight       // Bold Text
@Environment(\.accessibilityReduceMotion)    private var reduceMotion
@Environment(\.accessibilityReduceTransparency) private var reduceTransparency
@Environment(\.colorSchemeContrast)          private var contrast               // Increase Contrast
```

In UIKit heißen die Gegenstücke `UIAccessibility.isBoldTextEnabled`,
`UIAccessibility.isReduceMotionEnabled`, `UIAccessibility.isReduceTransparencyEnabled` und
`UIAccessibility.isDarkerSystemColorsEnabled`; in AppKit
`NSWorkspace.shared.accessibilityDisplayShouldUseBoldText` und
`…ShouldIncreaseContrast`. Wer sie in UIKit abfragt, muss auf die zugehörigen
Änderungsbenachrichtigungen hören, sonst bleibt die Oberfläche auf dem Stand des Starts stehen.

## Dynamic Type

Textstile statt Punktgrößen. `.font(.body)` skaliert, `.font(.system(size: 17))` nicht.

Eigene Schriften skalieren nur, wenn man es ihnen sagt:

```swift
// SwiftUI
Text("Titel").font(.custom("MeineSchrift-Bold", size: 28, relativeTo: .title))

// UIKit
let basis = UIFont(name: "MeineSchrift-Regular", size: 17)!
label.font = UIFontMetrics(forTextStyle: .body).scaledFont(for: basis)
label.adjustsFontForContentSizeCategory = true
```

Bei den großen Barrierefreiheitsgrößen muss ein Layout umbrechen, nicht abschneiden. Eine Zeile
aus Symbol und Text wird dann zu zwei Zeilen:

```swift
if typeSize.isAccessibilitySize {
    VStack(alignment: .leading) { symbol; beschriftung }
} else {
    HStack { symbol; beschriftung }
}
```

`ViewThatFits` und `AnyLayout` nehmen einem diese Fallunterscheidung oft ab. Feste Höhen an
Textcontainern sind der häufigste Grund, warum eine App bei großer Schrift bricht.

SF Symbols skalieren mit der Schriftgröße, wenn sie über `Label` oder mit einem Textstil gesetzt
werden. Ein Symbol mit `.font(.system(size: 32))` bleibt stehen, während der Text daneben wächst.

## VoiceOver

Jede Schaltfläche ohne sichtbaren Text braucht eine Beschriftung. Ohne sie liest VoiceOver den
Symbolnamen vor, also etwa „cart.badge.plus".

```swift
Button(action: inDenWarenkorb) {
    Image(systemName: "cart.badge.plus")
}
.accessibilityLabel("In den Warenkorb")
```

Eigene Steuerelemente brauchen zusätzlich Wert und Hinweis: `.accessibilityValue()` sagt, wo ein
Regler gerade steht, `.accessibilityHint()` sagt, was beim Auslösen geschieht. Die Vorlesereihenfolge
folgt der Leserichtung; weicht die sichtbare Anordnung davon ab, korrigiert
`.accessibilitySortPriority()` sie.

Was sichtbar ist, bleibt im Barrierefreiheitsbaum. Was nur dekorativ ist, wird mit
`.accessibilityHidden(true)` daraus entfernt.

## Farbe

Farbe allein trägt keine Bedeutung. Rot und Grün für ungültig und gültig schließt einen
erheblichen Teil der Nutzer aus. Zur Farbe gehört immer ein zweites Signal: ein Symbol, eine
Form, ein Wort.

Semantische Farben statt fester Werte. `.primary`, `.secondary`, `Color(.systemBackground)` und
die Gegenstücke passen sich Hell, Dunkel und erhöhtem Kontrast von selbst an. Eigene Farben
gehören in den Asset-Katalog mit Varianten für beide Erscheinungsbilder – und, wo die
Kontrastwerte aus `zahlen.md` sonst nicht erreicht werden, mit einer kontraststärkeren Variante.

## Bewegung

```swift
.animation(reduceMotion ? nil : .bouncy, value: istOffen)
```

Bei „Reduce Motion" entfallen dekorative Animationen, Parallaxe und große Raumbewegungen. Was
bleibt, ist die Überblendung, die einen Zustandswechsel erklärt. Auf visionOS und tvOS ist das
keine Höflichkeit: Raumbewegung und Parallaxe können dort Unwohlsein auslösen.

## Weitere Eingabewege

Jede Geste braucht einen zweiten Weg. Ein Dreifingerwisch zum Zurücknehmen ist für viele
unbenutzbar, wenn daneben kein Knopf und kein Menüeintrag steht. Apple nennt dazu ausdrücklich
Voice Control, Switch Control, Full Keyboard Access, AssistiveTouch und die Zeigersteuerung.

Auf dem Mac und dem iPad heißt das zusätzlich: Tab bewegt den Fokus durch alle Elemente, in
einer Reihenfolge, die dem Layout folgt, und es gibt keine Stelle, aus der Tab nicht mehr
herausführt.

## Hören

Was über Ton mitgeteilt wird, wird auch anders mitgeteilt. Untertitel für Dialoge, Transkripte
für lange Formate, Audiodeskription für rein Sichtbares. Ein Erfolgston bekommt eine passende
Haptik daneben, damit er auch bei stummgeschaltetem Gerät ankommt.
