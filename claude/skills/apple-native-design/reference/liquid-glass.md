# Liquid Glass

Seit System 26 (iOS, iPadOS, macOS Tahoe, watchOS, tvOS und visionOS) ist Liquid Glass das
verbindende Material der Apple-Plattformen. Fundstelle für alles Folgende, soweit nicht anders
vermerkt: Apple, HIG, „Materials", abgerufen am 19.08.2026. Der Liquid-Glass-Eintrag im
Änderungsprotokoll der Layout-Seite stammt vom 9. Juni 2025.

## Die Regel, aus der alle anderen folgen

Liquid Glass bildet die **Steuerungsebene**: Registerleisten, Seitenleisten, Symbolleisten,
Bedienelemente. Sie schwebt über der Inhaltsebene, und der Inhalt scheint durch. Damit trennt
das Material Bedienung von Inhalt, ohne den Inhalt zu verdecken.

**Kein Glas in der Inhaltsebene.** Karten, Listen, Textblöcke, Medien und App-Hintergründe
bekommen kein Glas, sondern die Standardmaterialien. Glas dort erzeugt eine Hierarchie, die
niemand mehr lesen kann.

Apple nennt genau eine Ausnahme, und sie steht in keinem der geprüften Fremd-Skills: Ein
Bedienelement in der Inhaltsebene mit kurzlebigem Zustand – ein Schieberegler, ein Schalter –
nimmt während der Berührung Glas an, um seine Bedienbarkeit zu zeigen.

## Sparsam, und meistens von selbst

Systemkomponenten übernehmen Aussehen und Verhalten ohne Zutun. Wer Glas auf ein eigenes
Steuerelement legt, tut das für die wichtigsten Elemente der App und für sonst nichts. Das
Material soll die Aufmerksamkeit auf den Inhalt lenken; auf vielen eigenen Elementen tut es das
Gegenteil.

## Die beiden Varianten

| Variante | Wofür | Verhalten |
|---|---|---|
| `.regular` | fast alles: Symbolleisten, Seitenleisten, Warnhinweise, Popover, alles mit viel Text | verwischt den Hintergrund und passt seine Helligkeit an, damit Text lesbar bleibt |
| `.clear` | Bedienelemente über Fotos, Video, Karten | stark durchsichtig, damit das Bild darunter wirkt |

Über hellem Inhalt braucht die klare Variante eine dunkle Abdunklungsschicht mit 35 Prozent
Deckkraft. Über ausreichend dunklem Inhalt entfällt sie, und die Standard-Wiedergabesteuerung
aus AVKit bringt eine eigene mit.

`.identity` ist keine dritte Variante aus der HIG, sondern ein API-Wert, mit dem sich Glas
bedingt abschalten lässt.

## SwiftUI

```swift
// Grundform: reguläres Glas, Kapselform
Text("Aktion")
    .padding()
    .glassEffect()

// Mit Form und Tönung
Button("Sichern") { }
    .padding()
    .glassEffect(.regular.tint(.accentColor), in: .rect(cornerRadius: 16))

// Interaktiv: skaliert und schimmert bei Berührung
Button("Tippen") { }
    .glassEffect(.regular.interactive())

// Form, die der Gehäuse- oder Containerrundung folgt
.glassEffect(.regular, in: .rect(cornerRadius: .containerConcentric))

// Bedingt abschalten
.glassEffect(isActive ? .regular : .identity)
```

Fertige Schaltflächenstile statt selbstgebauter Flächen:

```swift
Button("Aktion") { }.buttonStyle(.glass)
Button("Sichern") { }.buttonStyle(.glassProminent)
```

Glas kann kein Glas abtasten. Mehrere Glaselemente nebeneinander gehören deshalb in einen
gemeinsamen Container, der zugleich die Verformung beim Zusammen- und Auseinanderlaufen trägt:

```swift
@Namespace private var namespace

GlassEffectContainer(spacing: 24) {
    HStack(spacing: 24) {
        ForEach(actions) { action in
            Button(action.title, systemImage: action.icon) { }
                .frame(width: 44, height: 44)
                .glassEffect(.regular.interactive())
                .glassEffectID(action.id, in: namespace)
        }
    }
}
```

Läuft Bildmaterial hinter eine Seitenleiste oder einen Inspektor, sorgt
`.backgroundExtensionEffect()` dafür, dass es dahinter weiterläuft, statt an einer Kante
abzubrechen. Apple nennt das in der Layout-Seite als Weg, den Bereich neben dem Inhalt zu
füllen, und verweist für UIKit auf `UIBackgroundExtensionView`.

Der Übergang zwischen Inhalt und Steuerungsebene entsteht nicht durch einen eigenen Hintergrund,
sondern durch den Scroll-Kanteneffekt, den das System liefert.

## Farbe auf Glas

Farbe wird in der Steuerungsebene sparsam eingesetzt und dient dort der Hervorhebung, nicht der
Marke. Die Marke lebt in der Inhaltsebene. Apple warnt in der Registerleisten-Seite ausdrücklich
davor, den Registerbeschriftungen eine Farbe zu geben, die dem Hintergrund der Inhaltsebene
ähnelt; bei farbstarken Inhalten ist eine einfarbige Leiste die bessere Wahl.

## Barrierefreiheit

Glas passt sich von selbst an: Bei „Reduce Transparency" wird es milchiger, bei „Increase
Contrast" bekommt es harte Kanten, bei „Reduce Motion" wird die Bewegung zurückgenommen. Wer
eigene Glaselemente baut, prüft alle drei Einstellungen und liest zusätzlich den
Nutzerwunsch ab:

```swift
@Environment(\.accessibilityReduceTransparency) private var reduceTransparency
@Environment(\.accessibilityReduceMotion) private var reduceMotion
@Environment(\.colorSchemeContrast) private var contrast
```

## Systemfassungen

Alle hier genannten APIs setzen System 26 voraus. Für ältere Zielsysteme gilt entweder eine
Verfügbarkeitsprüfung oder der Verzicht; ein Nachbau aus `blur` und halbdurchsichtigen Flächen
sieht nicht wie Liquid Glass aus und ignoriert die Barrierefreiheitseinstellungen.
