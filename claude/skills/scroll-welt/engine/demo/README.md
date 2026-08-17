# Demo: eine Kette aus allen Treiberarten

Die Seite zeigt, was der Umbau können soll: eine Kette, in der eine Code-Szene, ein Videoclip,
eine echte 3D-Szene und ein Standbild hintereinander hängen, ohne dass man an den Übergängen
sieht, wo die eine Bewegungsquelle aufhört und die nächste anfängt.

```
hof (szene, 2.5D)  ->  hof-zur-werkstatt (video)  ->  werkstatt (szene, 2.5D)
                   ->  halle (szene, three.js)    ->  produkt (still)
```

Zwischen `werkstatt` und `halle` gibt es nichts zu bauen: zwei Code-Szenen brauchen keine Naht,
die Kamerabahn läuft einfach weiter.

Daneben liegen drei Seiten, die es nur gibt, damit man messen statt behaupten kann:

| Seite | wofür |
|---|---|
| `original.html` | eine unveränderte scroll-world-Konfiguration im alten Format |
| `original-upstream.html` | dieselbe Seite auf `scrub-engine.js`, als A/B-Referenz |
| `ohne-three.html` | dieselbe Kette ohne three.js, für den Ausfallweg des 3D-Treibers |

## Anschauen

```bash
python3 tools/serve.py            # http://127.0.0.1:8731/demo/index.html
```

Der Server liegt eine Ebene über `demo/`, damit die Seite `../scrub-welt.js` erreicht. Er nimmt
außerdem PUT entgegen, aber nur für PNG unter `demo/assets/seams/` und `demo/verify/`. Das ist
der Rückweg für die Bilder, die `exportFrame()` und der Prüflauf im Browser erzeugen.

## Prüfen

```bash
node tools/verify-headless.mjs    # 20 Prüfungen, Exitcode 0 nur wenn alle bestehen
```

Der Lauf startet für jede Prüfgruppe ein eigenes Headless-Chromium mit frischem Profil und
prüft den Three-Treiber gegen die echte Bibliothek sowie das Verhalten unter Telefon-Emulation
(Hochformat, Coarse-Pointer, 6-fach gedrosselte CPU). Zwei Dinge daran sind kein Zufall: das
frische Profil, weil Chrome kompilierte Shader im Profil behält und ein warmes Profil genau die
Kosten versteckt, die der erste Frame verursacht; und die Wahl des Browsers, denn
`chrome-headless-shell` hat keinen GPU-Pfad und rechnet WebGL in Software, wo jeder
three.js-Frame rund 16 ms kostet, egal was der Code tut. Der Lauf sagt selbst, auf welchem
Renderer er misst, und fällt durch, wenn es ein Software-Rasterizer ist.

## three.js

`vendor/three/` enthält die ESM-Bauten von three (MIT, Herkunft in `HERKUNFT.txt`), damit die
Demo ohne Installationsschritt läuft. `index.html` trägt eine `importmap`, die den nackten
Namen `three` dorthin auflöst – damit greift im Treiber genau der `import('three')`-Zweig, den
auch ein Projekt mit Bundler benutzen würde.

## Neu bauen

Die Assets liegen im Repo, der Weg dorthin geht in drei Schritten:

```bash
./tools/build-assets.sh                          # SVG -> PNG, rsvg-convert
node tools/export-seams-headless.mjs             # exportFrame() im Headless-Chromium
./tools/build-clip.sh                            # PNG-Paar -> mp4
```

Für den zweiten Schritt muss der Server laufen. Er nimmt das Chromium aus dem
Playwright-Cache, wenn eines da ist, sonst ein lokal installiertes Chrome, und lädt nichts nach.

## Die Naht

Der erste Frame des Clips ist `exportFrame('hof', 1)`, der letzte ist
`exportFrame('werkstatt', 0)`. Beide Bilder kommen aus genau den Szenen, die auf der Seite
laufen, nicht aus einem zweiten, ähnlich aussehenden Rendering. Deshalb steht der Clip an
beiden Enden auf einem Frame, den der Besucher unmittelbar davor oder danach ohnehin sieht.

Gemessen an dieser Fassung: 46,0 dB PSNR zwischen dem ersten Clip-Frame und dem exportierten
Szenenframe, 43,6 dB am anderen Ende. Zwei unverwandte Frames derselben Seite kommen auf
14,4 dB, das ist der Maßstab dafür, was die Zahl bedeutet.

Der Clip selbst ist eine ffmpeg-Blende zwischen den beiden Standbildern, kein Modellrender.
Er hält den Platz für einen echten Kameraflug frei und macht die Demo ohne Modell lauffähig.
In einem richtigen Bau gehen dieselben zwei PNG als Start- und Endbild an das Videomodell.

## Hochformat

Eine Code-Szene braucht keinen zweiten Satz Dateien, und das stimmt: dieselben vier Ebenen
füllen ein 9:16-Canvas lückenlos. Die Komposition überlebt den Wechsel allerdings **nicht von
selbst**. Ein Hochformat sieht nur noch etwa ein Fünftel der Breite; die Landschaftskamera
schob die Scheune damit halb aus dem Bild. Deshalb hat der Parallax-Treiber jetzt einen zweiten
Kamerablock:

```js
camera:         { pan: …, zoom: … },     // quer
cameraPortrait: { pan: …, zoom: …, anchorY: 0.52, overscan: 1.32 },
portraitBelowAspect: 0.95,               // ab wann der zweite gilt
```

Was der Portrait-Block auslässt, erbt er vom ersten. Achtung bei den Zahlen: `pan` zählt in
Canvas-Breiten, und ein schmales Canvas ist rund ein Fünftel so breit wie das Ebenenfeld –
eine Hochformat-Kamera braucht deshalb deutlich größere Werte als die quer.

Die Three.js-Szene braucht das nicht: eine echte 3D-Kamera hat ein vertikales Sichtfeld, ein
schmales Bild schneidet also seitlich ab, ohne dass das Motiv wegwandert.

## Was wo liegt

| Pfad | Inhalt |
|---|---|
| `scenes.js` | die beiden Parallax-Kameras (quer und hoch) und die Segmentkette |
| `szene-halle.js` | die 3D-Szene und ihr Segment |
| `assets/layers/src/*.svg` | die Ebenen von Hand als Vektor, Quelle für die PNG |
| `assets/seams/` | die exportierten Nahtframes |
| `assets/vid/` | der Platzhalterclip, Desktop und Mobile |
| `vendor/three/` | three.js als ESM, MIT, mit Herkunftsvermerk |
| `tools/cdp.mjs` | der kleine CDP-Client, den beide Node-Werkzeuge benutzen |
| `tools/verify-headless.mjs` | der Prüflauf |
| `tools/test-three.html` | Testharnisch für `treiber-three.js`, siehe unten |
| `verify/` | die Belegbilder aus den Prüfläufen |

`tools/test-three.html` prüft den Three.js-Treiber in zwei Fällen: ohne three (der Treiber muss
still auf das Standbild zurückfallen und eine verständliche Meldung hinterlassen) und mit einem
Stub anstelle von three (damit die Spline-Abtastung und der Blit auch ohne installierte
Abhängigkeit geprüft sind). Ein Stub prüft den Treiber, nicht three.js selbst – dafür ist der
Lauf in `verify-headless.mjs` da, der gegen die echte Bibliothek misst.
