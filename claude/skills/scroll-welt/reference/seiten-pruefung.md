# Die Seite misst ihre eigene Lesbarkeit

Eine Scroll-Seite hat keinen Zustand, den man ansehen könnte. Jede Scrollposition ist ein
anderes Bild, und die Fehler sitzen zwischen den beiden Stellen, an denen man zufällig
hingesehen hat. Deshalb wird sie abgefahren statt betrachtet.

Das Verfahren stammt aus `nateherkai/scroll-craft` (MIT-Lizenz), aus `scripts/shoot.mjs` und
`references/verify.md`. Übernommen ist der Gedanke und die Mechanik der Kontrastmessung;
umgeschrieben ist alles, was mit unserer Engine zu tun hat. Wo unsere Fassung von der
fremden abweicht, steht der Grund dabei.

Das Werkzeug ist `engine/demo/tools/verify-page.mjs`. Es prüft eine **fertige Seite**.
`engine/demo/tools/verify-headless.mjs` daneben prüft die **Engine** – Three.js-Treiber,
Telefon-Härtung, Bildbudget. Die beiden lösen verschiedene Aufgaben und ersetzen einander
nicht.

## Der Lauf

```bash
python3 demo/tools/serve.py &                       # oder: python3 -m http.server im Projekt
node demo/tools/verify-page.mjs --url http://127.0.0.1:8731/demo/index.html --out demo/verify/seite
node demo/tools/verify-page.mjs --url … --out …/telefon    --width 390 --height 844 --dpr 3 --mobile
node demo/tools/verify-page.mjs --url … --out …/reduziert  --reduced-motion
```

Der Lauf braucht kein npm. Er hängt sich über `demo/tools/cdp.mjs` an ein Headless-Chromium,
dieselbe Verbindung, über die auch der Nahtexport läuft. Das ist der eine Punkt, an dem
unsere Fassung einfacher ist als die fremde: scroll-craft verlangt `npm i playwright-core` im
Bauprojekt, wir nicht.

Zwei Dinge, die sonst einen ganzen Durchgang kosten:

- **Die Seite muss ausgeliefert werden.** Über `file://` blockiert der Browser den
  Blob-Abruf, mit dem die Engine ihre Clips holt. Die Seite fällt still auf die Poster
  zurück und der Lauf beweist nichts.
- **Vorher nachsehen, wessen Seite auf dem Port liegt.** Hält schon etwas anderes den Port,
  scheitert der Server im Hintergrund, und der Prüflauf bekommt von dem, was dort läuft,
  eine tadellose 200 und schreibt einen sauberen Bericht über eine fremde Seite.
  `curl -s http://127.0.0.1:8731/… | grep -o "<title>.*</title>"` klärt das in einer Zeile.

## Was gemessen wird

**Toter Scroll.** Zwei benachbarte Positionen, an denen sich nichts geändert hat: kein Film
läuft weiter, keine Szene zeichnet ein neues Bild, keine Naht blendet, kein Textfenster
öffnet oder schließt. Der Leser dreht am Rad und bekommt nichts dafür. Gemeldet wird erst ab
einem Abstand von einem Viertel Viewport, weil zwei Positionen dicht beieinander gleich
aussehen sollen.

**Stehender Clip.** Ein Video-Segment ist zu sehen, der Leser scrollt, und der Abspielkopf
bewegt sich nicht. Der Befund fällt durch die Prüfung auf toten Scroll hindurch, weil die
Bühne selbst sich ja bewegt – ein Standbild fährt die Seite hoch, und das ist das
Hässlichste, was diese Bauart hervorbringen kann. Dazu der Sonderfall, dass ein Segment auf
seinem Poster hängen bleibt: ein nie geladener Clip sieht aus wie ein angehaltener Film und
besteht jede andere Prüfung.

**Segmente, die nie voll decken.** Erreicht ein Segment nirgends die volle Deckkraft, ist
seine Spanne kürzer als die Kreuzblende an seinen Enden. Der Leser sieht eine Dauerblende
zwischen den beiden Nachbarn und das Segment selbst nie.

**Copy, die nie ankommt.** Ein Textblock, dessen Deckkraft nirgends über 0,8 steigt. Als
Fehler ist das unsichtbar, weil der Text ja da ist – er wird nur nie ganz.

**Kontrast, auf dem zusammengesetzten Bild.** Das ist die Prüfung, die kein statischer Audit
leisten kann und die unseren Skills bisher gefehlt hat: `design-critique` beurteilt, es
rechnet aber nichts aus. Der Lauf blendet den Text aus, fotografiert denselben Frame noch
einmal, reicht das Bild in die Seite zurück und tastet unter jeder Zeile den echten
Untergrund ab. Über einem scrubbenden Clip ist das der einzige ehrliche Weg, denn der Frame
unter einer Überschrift wechselt beim Scrollen: Eine Zeile kann auf dem Poster sieben zu eins
haben und dreihundert Pixel weiter durchfallen.

Dazu kommen Konsolenmeldungen aus Engine und Treibern sowie fehlgeschlagene Anfragen. Ein 404
auf einen Clip fällt lautlos auf das Poster zurück, was gut aussieht und keines ist.

## Vier Fallen in der Kontrastmessung

**Der Schleier darf nicht mit ausgeblendet werden.** `visibility: hidden` versteckt auch die
Pseudo-Elemente eines Elements. Unser Schleier ist `.sw-copylayer::before`, und die
Copy-Blöcke sind Kinder eben dieser Schicht. Wer `.sw-copylayer` ausblendet, blendet den
Schleier mit aus und misst jede Zeile gegen den nackten Film. Ausgeblendet wird darum nur
`.sw-copy` selbst. Fest stehende Elemente, die davor malen – Kopfleiste, Route, Hinweis,
Fortschrittsbalken –, verschwinden mit; Himmel, Bühne und Copy-Schicht bleiben, weil sie der
Untergrund sind.

Das Erkennungszeichen für diesen Fehler ist eindeutig: Man verstärkt den Schleier und die
gemeldeten Zahlen bewegen sich überhaupt nicht. Nicht ein bisschen, sondern auf zwei
Nachkommastellen identisch, weil das, was man geändert hat, nie in der Messung war.

Dagegen gibt es die Gegenprobe, und sie ist ein Argument, kein Ritual. `--css` spielt
zusätzliches CSS ein:

```bash
node demo/tools/verify-page.mjs --url … --out …/gegenprobe --css '.sw-copylayer::before{display:none}'
```

An der Referenz-Demo gemessen: mit Schleier zwei Zeilen unter 3:1, ohne Schleier acht Zeilen
unter 3:1 und siebzehn weitere im knappen Band. Damit ist belegt, dass der zusammengesetzte
Frame gemessen wird und nicht der Film darunter.

**Farben nie aus dem String lesen.** `getComputedStyle` liefert für alles, was aus
`color-mix()` kommt, die Form `color(srgb 0.29 0.41 0.28)` – Anteile von null bis eins.
Unsere Engine benutzt `color-mix` für Tags, Knöpfe und die weichen Ink-Töne. Eine Zahlensuche
mit `[\d.]+`, wie sie scroll-craft verwendet, liest daraus 0,29 als Rotwert, macht aus jeder
Farbe fast Schwarz, und Vordergrund wie Hintergrund landen beide dort: Jede Zeile meldet
saubere 1:1. Der Browser rechnet die Farbe selbst aus, wenn man sie ihm als `fillStyle` gibt,
und das ist der verlässliche Weg. Die fremde Fassung hat diesen Fehler noch; er trifft dort
jede Seite, die `color-mix` oder `color(srgb …)` benutzt.

**Zeilenkästen abtasten, nicht Elementkästen.** Eine Überschrift auf Blockebene ist so breit
wie ihre Spalte, ihre Buchstaben sind es nicht. Bei einer 460 Pixel breiten Spalte und einer
120 Pixel langen Zeile liegen drei Viertel des gemessenen Kastens rechts neben dem Text, und
ein dunkler Fleck dort zieht den Wert nach unten, obwohl unter keinem Buchstaben etwas
Dunkles liegt. Ein `Range` über den Textinhalt liefert je gerenderter Zeile einen Kasten, der
die Glyphen wirklich umschließt. An der Referenz-Demo hat der Wechsel die Werte zweier
Überschriften von 1,59:1 auf 2,65:1 und von 1,63:1 auf 3,56:1 gehoben – zwei Fehlalarme
weniger, ohne dass ein echter Befund verschwunden wäre. Nebenbei fällt damit die
Zeilentreue ab, die scroll-crafts Text verspricht und die dort nur näherungsweise vorliegt.

**Die Richtung gehört zur Zeile.** Helle Schrift auf dunklem Grund scheitert am hellsten
Fleck unter ihr, dunkle Schrift auf hellem Grund am dunkelsten. Immer gegen den hellsten zu
messen ist die nachsichtigste Lesart überhaupt, und eine hellgrundige Seite – unsere
Standardpalette ist eine – meldet dann sauber, während ihre Schrift durchfällt. Der Lauf
vergleicht die Schriftfarbe mit dem Mittelwert des Untergrunds und misst gegen das Extrem
auf der Seite der Schrift.

## Was der Lauf nicht kann

Der Kontaktbogen `bogen.png` ist kein Beiwerk. Er trägt genau die Befunde, die keine Messung
liefert, und er muss angesehen werden:

- **Ob die Komposition etwas taugt.** Copy, die auf der unruhigsten Stelle des Bildes landet.
  Ein Motiv, das an einer unglücklichen Stelle beschnitten ist. Ein Segment, dessen letztes
  Bild eine dunkle leere Ecke ist.
- **Ob die Bewegung gleichmäßig läuft.** Zusammenhängende Frames beweisen, dass sich etwas
  bewegt, nicht dass es sich gleichmäßig bewegt. Ein Schwenk, der ruckt, umkehrt oder in der
  Mitte stehen bleibt, steht auf dem Bogen und in keiner Zahl.
- **Ob die Seite etwas sagt.** Fünf Segmente, die einzeln funktionieren und zusammen nichts
  erzählen, sind der teuerste Fehler, den man hier machen kann.

Dazu die Durchgänge von Hand: mit der Tabulatortaste durchgehen (Fokusreihenfolge, sichtbarer
Fokusring auf jedem Grund, nichts Erreichbares bei Deckkraft null) und den
Reduced-Motion-Bogen darauf ansehen, ob die Seite ohne Bewegung noch verständlich ist statt
bloß nicht kaputt.

## Ein gewollter Halt wird erklärt

Ein Schluss, der bewusst steht, ist kein toter Scroll. Aber er muss ausgesprochen werden, und
zwar von der Seite, nicht vom Prüfwerkzeug: Das Attribut `data-sw-verify-hold="true"` auf
einem sichtbaren Element markiert den Halt, solange er läuft, und wird danach wieder
weggenommen. Wer es dauerhaft setzt, schaltet die Prüfung ab, statt sie zu bestehen – genau
die Selbsttäuschung, gegen die sie da ist.

Zwei Fehler dabei sind bereits gemessen, beide beim Bau der Beispielseite:

- **Aus den gerenderten Werten ableiten, nicht aus einer Zahl von Hand.** Der Halt war an
  `target > 0.45` gebunden, das Textfenster der Engine öffnet aber bei 0,4. Auf dem Telefon
  begann der Halt früher als die Zahl sagte, und die Prüfung meldete zu Recht toten Scroll in
  der Lücke dazwischen. Richtig ist die Bedingung, die abliest, was tatsächlich malt: Das
  Standbild deckt voll und seine Copy steht ganz offen.
- **Ein Bild später lesen, nicht im Scroll-Ereignis.** Die Engine rechnet ihre Deckkräfte in
  einer rAF-Schleife, die sie beim Scrollen einplant. Wer im Scroll-Handler misst, liest die
  Werte des vorigen Bildes. Gemessen bei y = 3292: Die Copy stand längst auf 1, der Halt
  wurde trotzdem mit `false` ausgezeichnet. `requestAnimationFrame(beginn)` im Handler
  behebt es, und die Reihenfolge stimmt von selbst, weil das rAF der Engine zuerst eingeplant
  ist.

## Was für unsere Engine anders ist als für die fremde

**Die Engine sagt selbst, was sie tut.** `window.scrollWelt.state()` liefert je Segment
Deckkraft, `t`, Zielwert, Abspielzeit und Ladezustand. scroll-craft muss diese Werte aus dem
DOM zusammensuchen und hat dafür eine Ersatzlogik für ältere Seiten. Der Prüflauf liest sie
hier einfach ab.

**Eine Code-Szene zeichnet auf ein Canvas, und das wird abgetastet.** Diese Prüfung kann es
dort nicht geben, weil dort keine Code-Szenen vorkommen. Sie deckt einen Fehler ab, der in
unserer eigenen Gotcha-Liste steht: Ein Treiber, der auf dem ersten Frame hängen bleibt,
meldet trotzdem brav ein wanderndes `t`. Ein Raster von acht mal fünf mittleren Helligkeiten
je Position unterscheidet Bewegung von Stillstand, ohne das ganze Bild zu vergleichen.

**Abgetastet wird je Segment, dazu beide Seiten jeder Naht.** Eine gleichmäßige Abtastung
über die Seite verschiebt jede Position, sobald sich irgendwo eine Höhe ändert; Befunde
tauchen dann auf und verschwinden mit Änderungen, die nichts damit zu tun haben. Die Naht ist
die Stelle, auf die diese Bauart beurteilt wird, sie ist etwa ein Zehntel Viewport breit, und
eine gleichmäßige Abtastung steigt mit hoher Wahrscheinlichkeit darüber hinweg.

**Zwei Segmentarten fahren nichts heran, und der Lauf darf nicht darauf warten.** Bei einem
`still` bleibt `t` bei null, während der Zielwert mit dem Scroll weiterwandert – so steht es
im API-Vertrag. Unter `prefers-reduced-motion` gilt dasselbe für jede Code-Szene, weil sie
einmal bei `staticT` zeichnet und dann stehen bleibt. Beides einmal übersehen heißt: an jeder
Position vier Sekunden vergeblich warten und Zwischenstände messen.

## Befunde an unseren eigenen Seiten

Der erste Lauf gegen die Referenz-Demo (`engine/demo/index.html`, 1440 × 900) hat zwei Dinge
gefunden, die vorher niemand gesehen hatte:

- **Die Eyebrow-Zeile fällt durch.** `.sw-copy__eyebrow` nimmt die Farbe `var(--sw-accent)`,
  gesetzt in 0,8 rem Versalien. Über dem hellen Schleier liegt sie bei 2,65:1 bis 2,83:1 und
  damit unter den 4,5:1, die kleiner Text braucht. Das ist keine Eigenheit der Demo, sondern
  die Voreinstellung: Ein heller Markenakzent auf hellem Grund landet dort immer. Der Weg aus
  der Sache führt über die Seite, nicht über die Engine – ein dunkler gewählter Akzent, oder
  eine Eyebrow-Zeile in `--sw-ink-soft`. An der Beispielseite hat das Nachdunkeln von
  `#5F7A33` auf `#46601F` und von `#8E6B22` auf `#6B4F14` gereicht: aus 3,91:1 und 3,69:1
  wurden Werte über der Schwelle, und alle 28 gemessenen Zeilen halten seither 4,5:1.
- **Der Schluss hält, ohne es zu sagen.** Die letzten 0,6 Viewporthöhen der Demo bewegen
  nichts mehr: Das Standbild steht, und die Copy des letzten Segments ist ausgeschrieben.
  Gewollt ist das vermutlich, erklärt ist es nicht. Mit `data-sw-verify-hold` wäre es
  erklärbar, ohne die Prüfung abzuschalten.

Auf dem Telefon kam ein dritter Wert dazu, gemessen an der Beispielseite: Der Zähler
`01 / 03` in `--sw-ink-soft` lag über dem Verlauf am unteren Rand bei 3,57:1. Nach dem
Nachdunkeln von `#6E6152` auf `#574B3E` hält er die Schwelle. Bemerkenswert daran ist, dass
scroll-craft denselben Zähler aus einem ganz anderen Grund verbietet – Reihenfolge sei hier
keine Information – und dabei auf dasselbe Element zeigt.

## Grenzen, die man kennen muss, bevor man einem grünen Lauf glaubt

- **Zeilen unter 0,85 Deckkraft werden übersprungen.** Eine Überschrift, die bei 0,6 über
  einem hellen Frame parkt, wird nie benotet. „Kontrast sauber" kann also ein
  Lesbarkeitsproblem verdecken; was ausgewaschen aussieht, findet sich auf dem Bogen.
- **Die Schwelle kennt keine Schriftgröße.** Unter 3:1 gilt als durchgefallen, 3:1 bis 4,5:1
  als knapp. Für große Displaytype sind 3:1 nach WCAG in Ordnung, für eine Bildunterschrift
  in 16 Pixeln nicht.
- **Zwei Zeilen mit demselben Wortlaut werden zu einer zusammengefasst,** und gemeldet wird
  der schlechtere der beiden Werte.
- **Was keine Copy trägt, wird nicht benotet.** Ein Segment ohne Textblock kommt in der
  Kontrastauswertung nicht vor.
- **Toter Scroll wird unter reduced motion nicht geprüft.** Dort steht jedes Segment
  absichtlich still, und eine Meldung darüber würde nur den einen Befund zudecken, für den
  dieser Durchgang da ist: ob die Geschichte ohne Bewegung noch trägt.
