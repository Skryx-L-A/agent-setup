# Abnahme: woran man sieht, dass etwas nicht nach Apple aussieht

Diese Liste fragt nicht, ob eine App hübsch ist. Sie fragt, woran ein Apple-Nutzer nach zwanzig
Sekunden merken würde, dass sie es nicht ist. Sie wird durchgegangen, bevor etwas als fertig
gemeldet wird.

## Zuerst: ansehen

Eine Oberfläche, die niemand angesehen hat, ist nicht abgenommen. Ein Kompilat ist kein Beleg.

```sh
xcrun simctl io booted screenshot /tmp/abnahme.png
sips --resampleHeightWidthMax 1800 /tmp/abnahme.png
```

Der Durchgang läuft mindestens zweimal: einmal in der Vorgabegröße im hellen Erscheinungsbild,
einmal in der größten Barrierefreiheitsgröße im dunklen. Beide Bilder werden wirklich geöffnet
und angesehen.

**Der Simulator wird im Hintergrund gestartet, nie in Fenster des Nutzers und nie im Vordergrund**
(`~/.claude/regeln/tests-und-eingriffe.md`). Wer ihn selbst öffnen muss, nimmt `open -g`, damit
der Fokus dort bleibt, wo er ist.

## Die zwölf Merkmale einer nicht-nativen App

Jedes Merkmal hat eine Plattformregel dahinter, keine Geschmacksfrage.

1. **Feste Punktgrößen für Text.** Erkennbar daran, dass bei großer Schrift nichts wächst oder
   der Text abgeschnitten wird. Gegenprobe: die größte Barrierefreiheitsgröße einstellen.
2. **Feste Höhen an Textcontainern.** Gleiche Gegenprobe, anderes Symptom: Überlappung statt
   Umbruch.
3. **Fest verdrahtete Farben.** Erkennbar im dunklen Erscheinungsbild: weiße Flächen, die
   blenden, oder schwarzer Text, der verschwindet. Gegenprobe: umschalten.
4. **Schaltflächen ohne Beschriftung im Barrierefreiheitsbaum.** VoiceOver liest den Symbolnamen
   vor. Gegenprobe: Accessibility Inspector oder VoiceOver einschalten und einmal durchgehen.
5. **Farbe als einziges Signal.** Rot und Grün ohne Symbol oder Wort daneben.
6. **Zu kleine oder zu eng stehende Ziele.** Die Werte stehen in `zahlen.md`. Der Abstand zählt
   dabei so viel wie die Größe.
7. **Glas in der Inhaltsebene.** Karten und Listen mit `glassEffect`. Siehe `liquid-glass.md`.
8. **Eine iPhone-Oberfläche auf einem anderen Gerät.** Eine Bodenleiste auf dem Mac, eine
   einspaltige Ansicht über die volle Breite eines 13-Zoll-iPads, eine iPhone-Dichte auf der Uhr.
9. **Eine Systemgeste, die überschrieben wurde.** Der häufigste Fall ist eine eigene
   Wischgeste, die das Zurückwischen von der linken Kante blockiert.
10. **Ein Schubladenmenü hinter drei Strichen.** Auf iOS und auf dem Mac gleichermaßen falsch;
    auf dem Mac gibt es dafür die Menüleiste.
11. **Ein Mac ohne Tastaturbedienung.** Wenn eine häufige Handlung nur mit der Maus geht, fehlt
    das halbe Betriebssystem.
12. **Ein Ladezustand, der den ganzen Bildschirm blockiert.** Statt eines Vollbild-Rädchens
    gehören Platzhalter in der Form des kommenden Inhalts dorthin, und die Berührung wird sofort
    quittiert, auch wenn das Ergebnis dauert.

## Die Zustände, die meistens fehlen

Für jeden Bildschirm: leer, ladend, fehlerhaft, offline, und der Zustand mit sehr viel Inhalt.
Der Leerzustand erklärt, warum nichts da ist, und bietet den nächsten Schritt an. Die
Fehlermeldung sagt, was schiefging und wie es weitergeht, und macht niemandem einen Vorwurf.

Auf dem iPad kommt hinzu: die Detailspalte ohne Auswahl. Auf watchOS: der Always-On-Zustand.

## Was der Systemvorgabe fehlt

Die Punkte oben sind der Boden. Eine App, die alle einhält, hat keine Fehler – und noch keinen
Charakter. Apple sagt unter Craft und Delight selbst, dass die Systemvorgabe nicht die
Obergrenze ist.

Deshalb, wenn die App wirklich gestaltet werden soll, drei Fragen zum Schluss:

- Gibt es auf diesem Bildschirm ein Detail, an das sich jemand erinnern würde?
- Hat die App eine Farbentscheidung getroffen, oder ist alles im Systemblau geblieben?
- Fühlt sich die Bewegung nach etwas an, oder ist es überall dieselbe Überblendung?

Wo es dafür echten Spielraum gibt, gehört der Auftrag vorher durch `design-bausteine`. Wo die
App nach außen geht, kommt hinterher `design-critique`.

## Zwei Muster, die man einer erzeugten Oberfläche ansieht

Beide stammen aus Fremd-Skills, und beide halten der Nachprüfung stand, weil eine Plattformregel
dahintersteht.

**Emojis als Symbole.** SF Symbols sind da, skalieren mit der Schrift, tragen die richtige
Strichstärke und lassen sich beschriften. Ein Emoji tut nichts davon.

**Der Purpur-Indigo-Verlauf.** Er kostet nichts und sagt nichts. Wenn er die einzige
Farbentscheidung der App ist, ist keine getroffen worden.

Andere Verbote aus denselben Quellen halten der Nachprüfung nicht stand und werden hier nicht
übernommen. „Immer zuerst dunkel entwerfen" ist eine Vorliebe, keine Regel; „Serifenschrift für
Überschriften" passt zu manchen Apps und zu vielen nicht; „nie die Systemakzentfarbe" ist auf dem
Mac sogar falsch, weil der Nutzer sie dort selbst eingestellt hat.
