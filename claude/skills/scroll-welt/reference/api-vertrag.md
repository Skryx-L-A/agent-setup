# API-Vertrag: Segment-Treiber

> Pfadbezug: Alle Pfade wie `engine/…` oder `reference/…` sind relativ zum
> Skill-Verzeichnis `~/.claude/skills/scroll-welt/` gemeint, nicht zum
> Arbeitsverzeichnis des Projekts.


Verbindlich für Engine und Skill-Text. Wer hiervon abweicht, ändert diese Datei zuerst.

Herkunft: `engine/scrub-engine.js` stammt aus `oso95/scroll-world` (MIT, Commit 71cc36d),
Original-Anleitung in `engine/ORIGINAL-SKILL.md`, Lizenz in `engine/LICENSE-scroll-world`.
Der Umbau unten ist unsere Erweiterung, nicht deren Entwurf.

## Warum überhaupt umgebaut wird

Das Original kennt genau eine Bewegungsquelle: eine mp4-Datei, deren `currentTime` am Scroll
hängt. Damit ist jede Szene an ein Videomodell gebunden. Wir haben aber (Messung 2026-08-11)
kein vorhandenes Cloud-Modell, das einen frame-gelockten Kameraflug erzeugt — Gamma kann
Stills, Adobes `animate_design` ist ein Effektfilter auf ein Express-Dokument, `video_render`
ein Timeline-Assembler. Bleibt lokal LTX-2-MLX oder Code. Also muss die Kette beides tragen
können, gemischt.

## Begriffe

Eine Seite ist eine **Kette aus Segmenten**. Scroll erzeugt eine globale Position; jedes
Segment bekommt daraus sein lokales `t` zwischen 0 und 1. Was ein Segment mit `t` macht,
entscheidet sein **Treiber**.

| Treiber | Bewegung kommt aus | Naht | Kosten |
|---|---|---|---|
| `video` | vorgerendertes mp4, `currentTime = t × Dauer` | Frame-Übergabe nötig | Modell |
| `szene` | `render(t, ctx)` — Code, jeder Frame frisch gezeichnet | entsteht durch Konstruktion | keine |
| `still` | Standbild, `t` bewegt nur die Copy | trivial | keine |

## Konfiguration

```js
mountScrollWelt(document.getElementById('welt'), {
  brand: { name: 'Pearl & Co.' },
  segments: [
    { kind: 'szene', id: 'farm', scroll: 1.6, linger: 0.45,
      render: farmRender,          // (t, ctx) => void
      still: 'assets/farm.webp',   // Poster + reduced-motion-Rückfall
      eyebrow: '…', title: '…', body: '…', tags: ['…'], accent: '#8FB98A' },

    { kind: 'video', id: 'farm-zu-laden', scroll: 0.9,
      clip: 'assets/vid/c1.mp4', clipMobile: 'assets/vid/c1-m.mp4' },

    { kind: 'szene', id: 'laden', /* … */ },
  ],
});
```

**Rückwärtskompatibel:** eine Konfiguration im Original-Format (`sections` + `connectors`)
wird beim Mounten intern zu `segments` normalisiert — abwechselnd Dive und Connector, in
genau der Reihenfolge, die das Original erzeugt. Bestehende scroll-world-Konfigurationen
laufen dadurch unverändert weiter.

## Vertrag für `render(t, ctx)`

```
ctx = { canvas, ctx2d, width, height, dpr, segment, reducedMotion }
```

`width` und `height` sind **logische CSS-Pixel**. Die 2D-Transformation ist bereits mit `dpr`
vorskaliert und die Fläche vor jedem Aufruf geleert. Wer in Gerätepixeln rechnet, zeichnet auf
einem Retina-Schirm doppelt so groß.

Ein Treiber, der Bilder, Gewichte oder sonst etwas nachlädt, **muss ein `ready`-Versprechen
anbieten**, und in dieses `ready` gehört jede einmalige Vorarbeit, die sonst den ersten
sichtbaren Frame trifft. Engine und `exportFrame` warten darauf. Zwei gemessene Belege, warum
das kein Formalismus ist: ohne Aufwärmen kostete der erste skalierte `drawImage` einer
2560×1440-Ebene 7,4 ms, der erste Frame einer Parallax-Szene also 16 bis 19 ms statt 0,05 ms;
und three übersetzt seine Shader beim ersten Zeichnen eines Materials, was mit kaltem Profil
als **ein Frame von 167 bis 190 ms** landete, mehr als das Zwanzigfache des Budgets. Beides
gehört vor `ready`, wo kein Frame darauf wartet. Ohne das exportiert der Bauschritt außerdem
stillschweigend einen halb geladenen Nahtframe — und genau der wandert dann als Startbild in
ein Videomodell, wo er die ganze Kette verdirbt.

1. **Reine Funktion von `t`.** Kein `Date.now()`, kein Frame-Zähler, kein Zustand zwischen
   Aufrufen. Grund: Scroll ist ein Schrubber, es wird auch rückwärts gescrollt, und die
   Engine springt bei einem schnellen Wischen über Zwischenwerte. Eine Szene, die aus ihrem
   letzten Zustand fortschreibt, driftet dabei auseinander.
2. **`t = 0` und `t = 1` sind die Nahtframes.** Sie müssen exakt reproduzierbar sein, weil
   der Bauschritt sie als PNG exportiert und einem Videomodell als Start- oder Endbild
   vorlegt.
3. **Budget 8 ms.** Die Engine ruft `render` in ihrer rAF-Schleife auf. Wer teurer ist,
   ruckelt.
4. **`reducedMotion`** wird respektiert, und zwar in dieser Rangfolge: liegt ein `still` vor,
   gewinnt es und es entsteht gar kein Canvas; fehlt es, wird genau einmal bei `staticT`
   (Default 0) gezeichnet und danach nicht mehr.

## Die Nahtbrücke — das eigentlich Neue

Das Nahtgesetz des Originals lautet: Endpunkte eines Videoclips müssen die **tatsächlich
gerenderten** Frames der Nachbarn sein, nie ein frisch erzeugtes Still. Bei einer
Code-Szene kostet dieser Frame nichts — sie kann ihn jederzeit exakt liefern.

```
exportFrame(segmentId, t, opts?) -> Promise<Blob>   // PNG
```

Asynchron, nicht anders möglich: `canvas.toBlob` arbeitet mit Callback, und ein Videoframe
braucht einen abgewarteten Seek. Muss headless aufrufbar sein (Playwright), damit der
Bauschritt Folgendes tun kann:

- **Code → Video:** `exportFrame('farm', 1)` liefert das Startbild für den nächsten
  Videoclip. Der Videoclip beginnt damit garantiert auf dem Frame, auf dem die Code-Szene
  endet.
- **Video → Code:** letzter Frame des Clips per ffmpeg heraus, als Hintergrundebene der
  folgenden Code-Szene bei `t = 0` einsetzen.
- **Video → Video:** unverändert das Verfahren des Originals.
- **Code → Code:** keine Naht, die Kamerabahn läuft einfach durch.

Damit hat jede Mischung eine definierte Naht, statt nur die reine Videokette.

## Mitgelieferte Treiber

- `treiber-parallax.js` — 2.5D: mehrere PNG-Ebenen mit Tiefenwert, Canvas2D, keine
  Abhängigkeit. Kamerabahn aus Pan, Zoom und Parallaxe. Das ist der billige Weg zu echter
  Kamerabewegung aus Standbildern, die von `bild`, Gamma oder Canva kommen dürfen.
- `treiber-three.js` — optional, wird nur geladen, wenn das Projekt `three` ohnehin hat.
  Echte 3D-Szene, Kamera folgt einer Spline; Nähte existieren gar nicht. Three rendert nach
  WebGL und kann `ctx.ctx2d` deshalb nicht direkt bedienen: der Treiber zeichnet in sein
  eigenes Canvas und kopiert es einmal je Frame in den 2D-Kontext. Das kostet eine
  Vollbildkopie und hält dafür Vertrag, `exportFrame` und Reduced-Motion-Weg unverändert
  gültig. Fehlt `three`, fällt der Treiber sichtbar und mit genau einer Meldung aus, statt
  die Seite mitzureißen.

## Telefon

Die Härtung des Originals gilt für jedes Segment und ist nicht abschaltbar: Seek-Coalescing,
iOS-Priming, Poster bis der Clip malt, Safe-Area, kein Sprung beim Ein- und Ausfahren der
URL-Leiste. Das ist keine Mobilfassung, sondern die Seite, die auf einem Telefon nicht kaputt
geht.

Was darüber hinaus je Treiber gilt:

- `video`: braucht eine eigene Portrait-Kette, wenn eine gewünscht ist — `clipMobile` je
  Segment, nativ in 9:16 gerendert, 720 breit, GOP 4, dazu `stillMobile` als Poster. Ein
  mittiger Beschnitt der 16:9-Datei ist ausdrücklich der Notnagel, nicht die Mobilfassung, und
  wird als solcher benannt. Fehlt `clipMobile`, fällt die Engine auf den Desktop-Clip zurück.
- `szene`: braucht **keine zweite Datei, aber eine zweite Kamera**. Gemessen am 2026-08-11:
  dieselben vier Ebenen füllen ein 9:16-Canvas lückenlos, zu 100 Prozent gedeckt bis an alle
  Ränder — kein zweiter Satz Assets, keine doppelte Rechenzeit, das ist der Vorteil und er
  hält. Die Komposition richtet sich aber **nicht von selbst** aus: ein Hochformat sieht nur
  noch etwa ein Fünftel der Ebenenbreite, und mit der Querformat-Kamera stand die Scheune halb
  außerhalb des Bildes. Ein 2.5D-Treiber braucht deshalb einen zweiten Kamerablock
  (`cameraPortrait`, greift unterhalb von `portraitBelowAspect`, erbt jeden ausgelassenen
  Wert vom Querformat). Achtung dabei: **`pan` zählt in Canvas-Breiten**, und ein schmales
  Canvas ist rund ein Fünftel so breit wie das Ebenenfeld — die Hochformat-Werte liegen um ein
  Vielfaches höher als die des Querformats (in der Demo 0,34 gegen 0,055).
  Eine echte 3D-Szene braucht das nicht: eine Kamera mit vertikalem Sichtfeld schneidet
  seitlich ab, ohne dass das Motiv wegwandert.
- `still`: `stillMobile` optional, sonst dasselbe Bild.

## Was unangetastet bleibt

Blob-Seeking, Seek-Coalescing, iOS-Priming, Lazy-Prefetch, Naht-Crossfade, Route-Rail,
Copy-Overlay, Safe-Area, das Ignorieren reiner Höhen-Resizes. Das ist die gehärtete
Substanz des Originals und wird nicht neu erfunden — sie gilt künftig für `video`-Segmente
genauso wie vorher.
