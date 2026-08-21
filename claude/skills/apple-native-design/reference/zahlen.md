# Harte Zahlen, mit Fundstelle

Alle Werte stammen aus Apples Human Interface Guidelines, abgerufen am 19.08.2026. Die
maschinenlesbare Fassung einer HIG-Seite liegt unter
`https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<seite>.json`;
die Seite selbst wird im Browser erst durch JavaScript gefüllt und ist deshalb mit einem
einfachen Abruf nicht zu lesen.

Kommt eine gebrauchte Zahl hier nicht vor, wird sie bei Apple nachgeschlagen und mit
Fundstelle hier nachgetragen. Sie wird nicht geschätzt und nicht aus einem Blogtext übernommen.

## Steuerelemente: Größe

Fundstelle: HIG, „Accessibility", Abschnitt Mobility.

| Plattform | Vorgabegröße | Mindestgröße |
|---|---|---|
| iOS, iPadOS | 44 × 44 pt | 28 × 28 pt |
| macOS | 28 × 28 pt | 20 × 20 pt |
| tvOS | 66 × 66 pt | 56 × 56 pt |
| visionOS | 60 × 60 pt | 28 × 28 pt |
| watchOS | 44 × 44 pt | 28 × 28 pt |

Die 44 pt auf iOS sind Apples **Vorgabe**, nicht die Untergrenze; darunter liegt die
Mindestgröße von 28 pt. Praktisch heißt das: 44 pt bleibt der Zielwert für alles, was ein
Finger trifft, und 28 pt ist der Wert, bis zu dem ein dicht gepacktes Bedienfeld gehen darf,
ohne die Barrierefreiheitsvorgabe zu verletzen.

## Steuerelemente: Abstand

Fundstelle: HIG, „Accessibility", Abschnitt Mobility. Apple nennt den Abstand ausdrücklich so
wichtig wie die Größe.

- Etwa **12 pt** Polsterung um Elemente mit eigener Umrandung.
- Etwa **24 pt** Polsterung um die sichtbaren Kanten von Elementen ohne Umrandung.

Auf visionOS kommt eine eigene Regel dazu (HIG, „Layout", Abschnitt visionOS): Die Mittelpunkte
zweier Schaltflächen sollen mindestens **60 pt** auseinanderliegen, damit das Blickziel
eindeutig bleibt und der Hover-Effekt nichts verdeckt.

## Text: Größen

Fundstelle: HIG, „Accessibility" und „Typography", jeweils Abschnitt zur Lesbarkeit.

| Plattform | Vorgabegröße | Mindestgröße |
|---|---|---|
| iOS, iPadOS | 17 pt | 11 pt |
| macOS | 13 pt | 10 pt |
| tvOS | 29 pt | 23 pt |
| visionOS | 17 pt | 12 pt |
| watchOS | 16 pt | 12 pt |

Diese Werte gelten für **eigene** Typenstile. Wer die Systemtextstile benutzt, braucht sie
nicht: Die Stile bringen die richtige Größe pro Plattform und die Dynamic-Type-Skalierung mit.

Vergrößerung, die eine Oberfläche aushalten muss: mindestens **200 Prozent**, auf watchOS
mindestens **140 Prozent**.

## Text: Kontrast

Fundstelle: HIG, „Accessibility", Abschnitt Vision. Apple gibt die Werte an, die der
Accessibility Inspector als WCAG-AA-Richtwerte verwendet.

| Textgröße | Schnitt | Mindestkontrast |
|---|---|---|
| bis 17 pt | jeder | 4,5 : 1 |
| 18 pt | jeder | 3 : 1 |
| jede | fett | 3 : 1 |

Apple nennt daneben APCA als zweiten verbreiteten Maßstab, legt sich aber nicht darauf fest.
Wer die Mindestwerte nicht überall erreicht, muss wenigstens ein kontraststärkeres Farbschema
liefern, sobald „Increase Contrast" eingeschaltet ist – und in hellem wie dunklem Erscheinungsbild
prüfen.

## tvOS: Sicherheitsbereich und Leisten

Fundstelle: HIG, „Layout", Abschnitt tvOS, und „Tab bars", Abschnitt tvOS.

- Sicherheitsbereich: Hauptinhalt **60 pt** von oben und unten, **80 pt** von den Seiten
  einrücken. Die Seiten sind der größere Wert, das wird oft falsch wiedergegeben.
- Höhe der Registerleiste: **68 pt**, Oberkante **46 pt** unter dem oberen Bildschirmrand.
  Beide Werte sind unveränderlich.
- Apple TV passt Layouts nicht an die Bildschirmgröße an. Jedes Fernsehgerät bekommt dieselbe
  Oberfläche.

## Liquid Glass: Abdunklung

Fundstelle: HIG, „Materials", Abschnitt Liquid Glass.

Liegt die klare Variante über hellem Inhalt, gehört eine dunkle Abdunklungsschicht mit
**35 Prozent** Deckkraft darunter. Über ausreichend dunklem Inhalt entfällt sie; die
Standard-Wiedergabesteuerung aus AVKit bringt eine eigene mit.

## Bildschirmgrößen

Fundstelle: HIG, „Layout", Abschnitt Specifications. Der jüngste Eintrag im Änderungsprotokoll
der Seite stammt vom 9. September 2025 und ergänzte iPhone 17, iPhone Air, Apple Watch Series 11
und Apple Watch Ultra 3.

iPhone, in Punkt, Hochformat, Auswahl der aktuellen Geräte:

| Modell | Punkte |
|---|---|
| iPhone 17 Pro Max, 16 Pro Max | 440 × 956 |
| iPhone Air | 420 × 912 |
| iPhone 17, 17 Pro, 16 Pro | 402 × 874 |
| iPhone 16 Plus, 15 Pro Max | 430 × 932 |
| iPhone 16 | 393 × 852 |
| iPhone 16e | 390 × 844 |

Die schmalste Breite, für die eine neue App noch auslegen muss, ist damit **390 pt**, die
breiteste **440 pt**. Wer noch iPhone SE der ersten Bauart unterstützt, kommt auf 320 pt.

Apple Watch, in **Pixeln** – Apple gibt für die Uhr keine Punktwerte an:

| Gehäuse | Pixel |
|---|---|
| Ultra 3, 49 mm | 422 × 514 |
| Series 10 und 11, 42 mm | 374 × 446 |
| Series 10 und 11, 46 mm | 416 × 496 |
| Ultra 1 und 2, 49 mm | 410 × 502 |
| Series 7 bis 9, 41 mm | 352 × 430 |
| Series 7 bis 9, 45 mm | 396 × 484 |

## Verbreitete Zahlen, die nicht stimmen

Jede Zeile hier stand in einem der geprüften Fremd-Skills und ist an Apples Dokumentation
gescheitert.

| Behauptung | Quelle | Was Apple sagt |
|---|---|---|
| visionOS: Mindestgröße für Tippziele 60 pt | `ehmo` (Regel EH-02), `axiaoge2` | 60 × 60 pt ist die **Vorgabe**, die Mindestgröße liegt bei 28 × 28 pt. Die 60 pt tauchen zusätzlich als Mindestabstand zwischen Schaltflächenmittelpunkten auf – zwei verschiedene Aussagen, in beiden Skills zu einer verschmolzen. |
| tvOS: Mindestgröße für Karten 250 × 150 pt | `ehmo` (Regel FOCUS-05) | Keine Apple-Zahl. Apples Werte sind 66 × 66 pt Vorgabe und 56 × 56 pt Mindestgröße. |
| tvOS: Sicherheitsbereich 60 pt rundum | `ehmo` (Regel DISTANCE-06) | 60 pt oben und unten, aber 80 pt an den Seiten. |
| tvOS: Fließtext mindestens 29 pt | `ehmo` (Regel DISTANCE-01) | 29 pt ist die Vorgabe, 23 pt die Mindestgröße. Der Stil „Body" hat 29 pt bei 36 pt Zeilenabstand. |
| watchOS: Fließtext mindestens 16 pt | `ehmo` (Regel W-GL-03) | 16 pt ist die Vorgabe, 12 pt die Mindestgröße. |
| watchOS: Series 10, 42 mm misst 180 × 220 px | `ehmo` | 374 × 446 px. Die Tabelle dort ist mit „px" überschrieben, führt aber Punktwerte, und der 42-mm-Wert ist auch als Punktwert falsch. |
| iPhone-Spanne: 375 pt (SE) bis 430 pt (Pro Max) | `ehmo` (Regel 1.4) | Aktuell 390 pt bis 440 pt. Das iPhone 17 Pro Max hat 440 pt. |
| Hamburger-Menüs senken die Auffindbarkeit „um bis zu 50 Prozent" | `ehmo` (Anti-Muster 1) | Keine Zahl bei Apple und keine Quelle im Skill. Der Rat selbst ist richtig, die Zahl ist erfunden. |
| Kontrast: 3 : 1 ab 18 pt **oder** 14 pt fett | `ehmo`, `dickwu` | Das ist die WCAG-Formulierung. Apples Tabelle sagt: bis 17 pt 4,5 : 1, ab 18 pt 3 : 1, und fett bei **jeder** Größe 3 : 1. |
| iOS: 3 bis 5 Registerkarten | `ehmo` (Regel 2.1), `Ksanbal` | Apple nennt inzwischen keine Zahl mehr, sondern verlangt „so viele, wie nötig", warnt vor der Überlauf-Registerkarte und empfiehlt für anpassbare Leisten auf iPadOS als Voreinstellung fünf oder weniger. Drei bis fünf bleibt eine brauchbare Faustregel, ist aber keine Apple-Vorgabe. |
| macOS: Steuerelemente 22 bis 28 pt hoch | `ehmo` (Anti-Muster 4) | Apples Werte sind 28 × 28 pt Vorgabe und 20 × 20 pt Mindestgröße. |
| iOS-Registerleiste 49 pt hoch, fest am unteren Rand | `axiaoge2` | Seit System 26 schwebt die Registerleiste auf Liquid Glass über dem Inhalt und kann beim Scrollen einklappen. Die feste Höhe von 49 pt beschreibt den Stand vor System 26. |

## Zahlen, die Apple nicht liefert

Für den iOS-Typenstufen-Katalog (Large Title, Title 1 bis 3, Headline, Body, Callout,
Subheadline, Footnote, Caption 1 und 2) veröffentlicht Apple die Punktwerte als Bildtabelle und
als Download unter „Design Resources", nicht als lesbaren Text auf der HIG-Seite. Maschinell
nachprüfbar sind dort nur Vorgabe- und Mindestgröße (17 pt und 11 pt).

Daraus folgt die Arbeitsanweisung, die ohnehin die bessere ist: **die Textstile benutzen, nicht
die Punktwerte.** `Text("…").font(.body)` skaliert mit Dynamic Type,
`.font(.system(size: 17))` nicht. Wer den Katalog wirklich als Zahlen braucht, holt ihn bei
Apple unter „Design Resources" und schreibt ihn dann hier mit Datum hinein.

Nachprüfbar sind dagegen die Textstile für macOS und tvOS, weil Apple sie als Text ausliefert:

macOS, Auswahl: Large Title 26 pt bei 32 pt Zeilenhöhe, Title 1 22/26, Title 2 17/22,
Title 3 15/20, Headline 13/16 fett, Body 13/16, Callout 12/15, Subheadline 11/14,
Footnote 10/13, Caption 1 und 2 je 10/13.

tvOS, vollständig: Title 1 76 pt bei 96 pt Zeilenabstand, Title 2 57/66, Title 3 48/56,
Headline 38/46, Subtitle 1 38/46, Callout 31/38, Body 29/36, Caption 1 25/32, Caption 2 23/30.
