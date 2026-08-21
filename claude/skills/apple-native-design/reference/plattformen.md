# Die sechs Plattformen

Ein Informationsmodell wird einmal entworfen und pro Gerät anders dargestellt. Was gleich
bleibt, sind die Namen der Dinge, die Bedeutung der Farben und der Zustand des Nutzers. Was
sich ändert, sind Eingabe, Navigation, Dichte und die Zeit, die jemand vor dem Gerät verbringt.

| Plattform | Eingabe | Aufmerksamkeit | Navigation |
|---|---|---|---|
| iOS | ein Daumen, unterwegs | Sekunden bis Minuten | Registerleiste unten, Navigationsstapel, Sheets |
| iPadOS | Finger, Stift, Zeiger, Tastatur | Minuten bis Stunden | Registerleiste oben, umschaltbar auf Seitenleiste, Split View |
| macOS | Zeiger und Tastatur | Stunden | Menüleiste, Seitenleiste, Symbolleiste, mehrere Fenster |
| watchOS | ein Finger, Digital Crown | zwei bis fünf Sekunden | senkrechtes Blättern, flacher Stapel |
| tvOS | Fokus über die Siri Remote | passiv, aus drei Metern | Registerleiste oben, Fokus-Engine |
| visionOS | Blick und Fingertippen | Minuten | Fenster im Raum, Ornamente |

---

## iOS

Ein Daumen, ein Bildschirm, wenig Zeit. Die wichtigste Handlung gehört dorthin, wo der Daumen
ruht, also in die untere Bildschirmhälfte. Oben stehen Titel und Nebenhandlungen.

Die Registerleiste trägt die obersten Bereiche. Seit System 26 schwebt sie auf Liquid Glass
über dem Inhalt, reagiert auf den Hintergrund und kann beim Scrollen einklappen, wenn ein
Zusatzelement wie der Mini-Abspieler daran hängt. Sie bleibt sichtbar, wenn der Nutzer tiefer
navigiert; nur ein modales Fenster darf sie verdecken. Registerkarten werden nicht abgeschaltet
und nicht versteckt, wenn ihr Inhalt gerade leer ist – dann erklärt ein Leerzustand, warum.

Ein Schubladenmenü hinter drei Strichen ist auf iOS falsch. Die Navigation verschwindet damit,
und mit ihr die Hälfte der App.

`NavigationStack` für Hierarchien, nicht `NavigationView`. Große Titel auf der obersten Ebene,
die beim Scrollen einlaufen. Die Wischgeste von der linken Kante gehört dem System; eine eigene
Geste, die dort greift, ist ein Fehler.

Sheets sind für abgeschlossene Nebenaufgaben da, mit sichtbarem Weg hinaus. Warnhinweise nur
für Entscheidungen, die der Nutzer wirklich treffen muss, mit zwei Knöpfen, höchstens drei.

Apple rät auf iOS ausdrücklich von Schaltflächen ab, die über die volle Breite laufen. Sie sollen
die Systemränder respektieren und zur Rundung der Gehäusekante passen.

Berechtigungen werden in dem Moment erfragt, in dem der Nutzer die Funktion auslöst, die sie
braucht, und vorher in einem eigenen Bildschirm erklärt. Der Systemdialog erscheint genau
einmal.

## iPadOS

Kein großes iPhone. Ein iPad wird im Querformat benutzt, oft mit Tastatur, fast immer neben
einer anderen App.

**Hier widersprechen sich die Quellen, und Apple hat sich geändert.** Der Skill
`ehmo/platform-design-skills` verlangt, die Registerleiste in regulärer Breite durch eine
Seitenleiste zu ersetzen, und führt Bodenleisten als Anti-Muster. Apples aktuelle Fassung sagt
etwas anderes: Das System zeigt die Registerleiste **oben**, und Apple empfiehlt sie als erste
Wahl für die Navigation. Für komplexere Apps kommt eine Schaltfläche dazu, die sie in eine
Seitenleiste verwandelt. Wer eine reine Seitenleiste ohne diese Umschaltung will, nimmt
`NavigationSplitView` statt einer Registeransicht.

In SwiftUI heißt das `TabView` mit `.tabViewStyle(.sidebarAdaptable)`. Wenn der Nutzer seine
Registerkarten selbst zusammenstellen darf, sollen es in der Voreinstellung fünf oder weniger
sein, damit der Übergang zwischen kompakter und regulärer Breite ruhig bleibt.

Fenster sind frei veränderbar, ähnlich wie auf dem Mac. Apple rät, so lange wie möglich beim
vollen Layout zu bleiben und erst dann auf die kompakte Fassung umzuschalten, wenn das volle
nicht mehr passt; bei mehrspaltigen Ansichten werden zuerst die hinteren Spalten wie der
Inspektor ausgeblendet. Zu prüfen sind die Größen, die die Fenstersteuerung anbietet: Hälften,
Drittel und Viertel des Bildschirms.

Zeiger und Tastatur sind keine Zugabe. Jedes bedienbare Element braucht einen Hover-Zustand,
jede häufige Handlung ein Tastenkürzel, und die Kürzel erscheinen in der Übersicht, die beim
Halten der Befehlstaste aufgeht. Ziehen und Ablegen zwischen Apps ist auf dem iPad ein
Grundverhalten, kein Extra.

Die Detailspalte bleibt nie leer. Ohne Auswahl steht dort ein Platzhalter, der sagt, was zu tun
ist.

## macOS

Der Mac gehört Nutzern, die die Tastatur benutzen und mehrere Fenster gleichzeitig offen haben.

Die Menüleiste ist Pflicht und die erste Stelle, an der jemand nach einer Funktion sucht. App,
Ablage, Bearbeiten, Darstellung, Fenster und Hilfe gehören immer dazu; Ablage entfällt nur bei
Apps ohne Dokumente. Menüeinträge ändern ihren Zustand mit dem Kontext: ausgegraut, wenn sie
nicht gehen, mit angepasstem Titel, wenn er präziser sein kann.

Jede Handlung, die mit der Maus erreichbar ist, ist auch mit der Tastatur erreichbar. Die
Standardkürzel bleiben, wo sie sind. Escape bricht ab, Return löst die hervorgehobene
Schaltfläche aus, Entfernen entfernt die Auswahl, Leertaste öffnet die Übersicht, und
Befehl-Z nimmt zurück – letzteres gilt für alles, was etwas verändert.

Fenster sind frei veränderbar mit sinnvoller Mindestgröße und ohne Höchstgröße. Position und
Größe überleben den Neustart. Die drei Fensterknöpfe bleiben oben links, sichtbar und
funktionsfähig, auch bei einer eigenen Titelleiste. Apple rät außerdem davon ab,
Bedienelemente an den unteren Fensterrand zu legen, weil Fenster oft so verschoben werden, dass
die Unterkante unter dem Bildschirmrand liegt.

Die Systemakzentfarbe wird respektiert. Der Nutzer hat sie eingestellt; Standardsteuerelemente
werden nicht mit einer Markenfarbe übermalt. Eine eigene Tönung ist für eigene Ansichten da, wo
sie etwas bedeutet.

Rechtsklick öffnet überall ein Kontextmenü. Ziehen und Ablegen funktioniert in die App hinein
und aus ihr heraus. Befehlstaste-Klick wählt einzeln, Umschalt-Klick wählt einen Bereich.

Steuerelemente sind kompakt, nicht fingergroß: 28 × 28 pt in der Vorgabe. Wer iOS-Maße
übernimmt, baut eine App, die wie ein Port aussieht.

## watchOS

Der Nutzer hebt das Handgelenk und lässt es wieder sinken. Wer in zwei Sekunden nicht erfasst
hat, worum es geht, hat die App verloren.

Das Wichtigste steht ohne Scrollen auf dem ersten Bild. Ein Wert pro Ansicht, groß und
kontrastreich. Apple rät, den Inhalt bis an die Ränder zu führen, weil die Gehäusefassung schon
als Rand wirkt, und höchstens drei Symbolschaltflächen oder zwei Textschaltflächen nebeneinander
zu setzen.

Die Digital Crown ist das eigentliche Eingabegerät für Scrollen und für genaue Werte, mit
haptischen Rastungen bei diskreten Schritten und ohne spürbare Verzögerung. Sie wird nicht
umgewidmet, wo das System sie schon benutzt.

Komplikationen sind die sichtbarste Fläche der App. Mehrere Familien unterstützen, in getönter
wie in farbiger Darstellung lesbar bleiben, über `TimelineProvider` aktuell halten, und beim
Antippen an die passende Stelle in der App führen, nicht auf den Startbildschirm.

Im Always-On-Zustand wird die Darstellung vereinfacht, Privates wird verdeckt, und es wird
höchstens einmal pro Minute aktualisiert. Der Übergang zwischen wach und gedimmt darf das
Layout nicht springen lassen.

Bei Trainings zählen große Zahlen und Haptik, weil niemand während der Bewegung liest.

## tvOS

Es gibt keinen Zeiger. Es gibt den Fokus, und der Fokus ist die gesamte Bedienung.

Jedes erreichbare Element hat einen unübersehbaren Fokuszustand, üblicherweise aus Vergrößerung,
Schatten und Helligkeit zusammen – nie nur aus Farbe. Der Fokus bewegt sich dorthin, wo das
Auge ihn erwartet; Lücken im Layout werden mit Fokus-Führungen überbrückt, damit niemand
hängenbleibt. Jeder Bildschirm hat von Anfang an ein fokussiertes Element, und beim Zurückkehren
steht der Fokus wieder da, wo er war.

Der Parallaxeffekt auf Karten und Symbolen entsteht aus geschichteten Bildern im LSR-Format,
die das System bei Fokuswechsel selbst animiert. `UIMotionEffect` ist dafür nicht zuständig; es
reagiert nur auf die feine Kreiselbewegung der Fernbedienung.

Die Menü-Taste führt immer zurück, die Wiedergabetaste steuert immer die Wiedergabe. Mehrfinger-
und Druckgesten gibt es auf der Fernbedienung nicht. Texteingabe über die Bildschirmtastatur ist
mühsam; Diktat, zuletzt Gesuchtes und automatisches Ausfüllen sind der eigentliche Weg.

Seit System 26 trägt auch tvOS Liquid Glass: in der Navigation, im Top Shelf und im
Kontrollzentrum, und Bildansichten wie Schaltflächen nehmen es an, sobald sie den Fokus
bekommen. Die tvOS-Regeln in `ehmo/platform-design-skills` stammen von davor und erwähnen es
nicht.

## visionOS

Fenster stehen im Raum des Nutzers. Der Blick zielt, das Fingertippen bestätigt.

Inhalt steht vor dem Nutzer auf Augenhöhe, in ein bis zwei Metern Abstand, nie hinter ihm und
nie näher als eine Armlänge. Fenster bleiben im Raum verankert und folgen nicht dem Kopf –
kopfgebundene Oberflächen machen unwohl und blockieren außerdem die Zeigersteuerung, die
Menschen benutzen, die nicht mit Blick und Hand arbeiten können.

Weil der Blick zielt, gibt es keinen Mauszeiger und damit keinen Ersatz für den Hover-Zustand:
Jedes bedienbare Element zeigt sichtbar, dass es gerade angesehen wird. Runde und
kapselförmige Formen sind leichter anzusehen als eckige, weil das Auge in Ecken gezogen wird.
Eigene Hover-Effekte lässt visionOS nicht zu.

Die Blickrichtung ist Systemsache. Sie wird nicht ausgewertet, um Inhalte zu ändern oder
Interesse abzuleiten; rohe Blickdaten bekommt eine App gar nicht erst.

Fenster benutzen das Systemglas, das sich an die Umgebungshelligkeit anpasst. Einen eigenen
Dunkelmodus gibt es auf visionOS nicht, weil das Glas diese Aufgabe übernimmt. Undurchsichtige
Flächen im geteilten Raum wirken wie Löcher in der Umgebung; sie sind der Wiedergabe von Fotos
und Video vorbehalten.

Steuerelemente hängen als Ornamente außen an den Fensterrändern, nicht im Inhaltsbereich: die
Navigation an der führenden Kante, die Hauptbedienung unten.

Apps starten im geteilten Raum. Mehr Immersion kommt schrittweise und nur auf Wunsch, mit
weichem Übergang und einem Weg zurück, der immer da ist.
