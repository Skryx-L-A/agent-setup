---
name: scroll-welt
description: >
  Baut eine scroll-gesteuerte Kameraflug-Landingpage: Scroll bewegt eine Kamera durch eine
  Kette von Szenen, ohne Schnitt, wie bei Apples Produktseiten. Angepasste Hausfassung von
  oso95/scroll-world – ohne Higgsfield/Monid, mit drei Bewegungsquellen statt einer: Code-
  Animation (2.5D-Parallaxe oder Three.js, kostenlos, minutenschnell), lokales Video über
  LTX-2-MLX (kostenlos, aber Nachtlauf), oder eine Mischung aus beidem. Auslöser: "Kameraflug",
  "Scroll-Website", "3D-Welt-Landingpage", "scrollytelling", "cinematic scroll",
  "scroll-scrubbed", "scroll-driven camera", "fly-through landing page", "immersive scroll
  page", "Welt zum Durchscrollen", "Diorama-Landingpage".
---

# scroll-welt

**Wo die Dateien liegen.** Dieser Skill wohnt in `~/.claude/skills/scroll-welt/`, gebaut wird
dagegen im Projektverzeichnis des Kunden. Jeder Pfad in diesem Text und in den
Referenzdateien ist relativ zum Skill-Verzeichnis gemeint, nicht zum aktuellen
Arbeitsverzeichnis. Aus einem Projekt heraus also `~/.claude/skills/scroll-welt/engine/…`
lesen und kopieren, nie `engine/…` — sonst greift der Pfad ins Leere. Der erste Bauschritt
jedes Weges ist deshalb, die gebrauchten Engine-Dateien einmal ins Projekt zu kopieren:

```bash
S=~/.claude/skills/scroll-welt
mkdir -p assets/js
cp "$S/engine/scrub-welt.js" "$S/engine/treiber-parallax.js" assets/js/
cp "$S/engine/treiber-three.js" assets/js/            # nur beim 3D-Weg
cp -R "$S/engine/demo" /tmp/scroll-welt-demo          # zum Nachschlagen, nicht ins Projekt
```

Eine Seite, bei der Scroll eine Kamera antreibt: Sie fliegt in eine Szene hinein, weiter zur
nächsten, ohne sichtbaren Schnitt. Die einzuhängende Engine liegt unter `engine/scrub-welt.js`
und implementiert `mountScrollWelt` aus `reference/api-vertrag.md` (`mountScrollWorld` bleibt
als Alias erhalten, damit eine bestehende Original-Konfiguration unverändert weiterläuft). Sie
baut auf `engine/scrub-engine.js` auf, das unverändert aus `oso95/scroll-world` stammt
(MIT-Lizenz, Commit 71cc36d, Original-Anleitung in `engine/ORIGINAL-SKILL.md`, Lizenztext in
`engine/LICENSE-scroll-world`) und liefert das Scrubbing, das Blob-Seeking, das iOS-Priming und
die anderen gehärteten Kleinigkeiten, die kein Neuerfinden brauchen. Die Rückwärtskompatibilität
ist gemessen, nicht behauptet: Dieselbe Konfiguration im Originalformat läuft einmal über den
`mountScrollWorld`-Alias auf `scrub-welt.js` und einmal auf `scrub-engine.js`, und an drei
Scrollpositionen (mitten im ersten Dive, mitten im Connector, mitten im zweiten Dive) ist die
PSNR zwischen beiden Seiten unendlich, die Bilder also pixelidentisch – unabhängig nachgerechnet,
Belegbilder in `engine/demo/verify/ab-*.png`. Umgebaut ist die Bewegungsquelle: Das Original
kennt nur eine mp4 pro Segment, an ein Bezahlmodell gebunden (Higgsfield/Monid, eine
Sechs-Szenen-Kette kostet dort rund 27 US-Dollar). Hier gibt es drei Quellen, gemischt in
derselben Kette, verbindlich festgelegt in `reference/api-vertrag.md`. Diese Datei ist
eingefroren – bei jedem Widerspruch zwischen ihr und diesem Text gilt sie.

## Wegwahl

| Weg | Bewegungsquelle | Kosten | Wartezeit | Wofür |
|---|---|---|---|---|
| Code, 2.5D | `treiber-parallax.js` – PNG-Ebenen mit Tiefenwert auf Canvas2D | keine | Minuten pro Szene, Textänderung = Neurendern in Minuten | Standardweg: exakte Markenfarben, keine Nähte, sofortige Iteration; fürs Telefon keine zweite Datei nötig, aber ein zweiter, von Hand gesetzter Kamerablock (`cameraPortrait`, Abschnitt Telefon) |
| Code, 3D | `treiber-three.js` – echte Szene, Kamera folgt einer Spline | keine | Minuten pro Szene | wenn das Projekt `three` ohnehin einbindet oder echte Tiefe/Parallaxe bei Kopfdrehung gebraucht wird; fürs Telefon braucht die Kamera nichts Zusätzliches, ein vertikales Sichtfeld schneidet von selbst passend zu |
| Video lokal | LTX-2-MLX, `generate --image` (Legs) / `keyframe --start --end` (Connectors) | keine (Strom, kein Abo) | ~30 Minuten je 8-Sekunden-Clip bei 480p, grob hochgerechnet; eine Sechs-Szenen-Kette also rund 5,5 Stunden – ein Nachtlauf. 1080p ist 6,75-mal mehr Pixel als die 480p-Messung | organischer Kamera-Look, wenn Wartezeit kein Problem ist; für eine echte Mobilfassung eine eigene, nativ gerenderte 9:16-Kette nötig (Abschnitt Telefon) |
| Cloud-Stills | `bild` lokal, Gamma `generate_image`, Canva, Adobe Firefly | im laufenden Abo enthalten | ~10 Sekunden (`bild --schnell`, Z-Image-Turbo) bis ~1 Minute (`bild`, FLUX.2-klein-9B) je Bild | nur Standbilder – als Poster, als Ebenen für den Code-Weg, oder als `still`-Segment ohne Bewegung. Kein Cloud-Dienst hier erzeugt Bewegtbild |
| Gemischt | jede Kombination der obigen | Summe der beteiligten Wege | Summe der beteiligten Wege | wenn einzelne Szenen den organischen Video-Look brauchen und andere vom Code-Weg profitieren |

Der Befund, der den Umbau begründet (gemessen 2026-08-11, siehe `reference/api-vertrag.md`):
kein vorhandenes Cloud-Modell in diesem Haus erzeugt einen frame-gelockten Kameraflug. Gamma
`generate_image` liefert nur Standbilder. Adobes `animate_design` ist ein Effektfilter auf ein
fertiges Express-Dokument, kein Kameraflug durch eine Szene. `video_render` fügt vorhandene
Clips auf einer Timeline zusammen, erzeugt keine neuen. Wer Bewegung ohne ein neues
Bezahl-Abo will, hat also nur zwei Wege: lokal rechnen oder Code schreiben.

Der Code-Weg ist der eigentlich neue Punkt gegenüber dem Original, mit zwei Vorteilen. Er hat
kein Nahtproblem, weil eine durchgehende Kamerabahn keine Naht hat – nicht mal eine
unsichtbare. Und er braucht keinen zweiten Satz Dateien fürs Telefon: Dieselben Ebenen füllen,
gemessen, ein Hochformat-Canvas lückenlos, während ein Video-Segment für eine echte Mobilfassung
eine eigene, nativ gerenderte 9:16-Kette braucht (Abschnitt Telefon unten). Der Vorteil ist
kleiner, als er zunächst aussieht: Bei `treiber-parallax.js` richtet sich die Komposition nicht
von selbst am Hochformat aus, ein Hochformat sieht nur noch etwa ein Fünftel der Ebenenbreite,
und ohne einen eigens gesetzten zweiten Kamerablock steht das Motiv halb außerhalb des Bildes.
Kostenlos bleibt nur der zweite Assets-Satz, nicht die zweite Kamera. Bei `treiber-three.js`
stimmt der ursprüngliche Satz dagegen genau: eine Kamera mit vertikalem Sichtfeld schneidet
seitlich ab, ohne dass das Motiv wegwandert, ganz ohne Zutun. Dazu trifft der Code-Weg exakt
die Markenfarben statt der Modell-Lotterie eines Bildgenerators. Eine Textänderung bedeutet
Neurendern in Minuten, nicht einen neuen Videolauf über Stunden. Und weil kein Videomodell im
Spiel ist, gibt es auch kein Re-Roll-Budget für NSFW-Fehlalarme auf harmlosen Innenräumen –
ein Problem, das das Original bei Schlafzimmer-, Pool- und Spa-Szenen wiederholt traf
(`engine/ORIGINAL-SKILL.md`, Abschnitt Gotchas). Der Preis dafür: kein organischer KI-Look,
und jede Szene muss tatsächlich gebaut werden, nicht nur beschrieben.

## Zwei Hürden auf dem lokalen Videoweg – ungeschönt

**Tempo.** Gemessen in `~/AI/ltx-2-mlx/CLAUDE.md:676` (480×704 Pixel, 97 Frames = 4 Sekunden
bei 24 fps, MLX bf16 q8): 1374 Sekunden roh, 942 Sekunden mit TeaCache. Auf einen 8-Sekunden-
Clip bei 480p hochgerechnet sind das grob 30 Minuten – die Kette einer Sechs-Szenen-Seite
liegt damit bei rund 5,5 Stunden. 1080p ist 6,75-mal mehr Pixel als die gemessene Auflösung.
Das ist kein Feierabend-Lauf, das ist ein Nachtlauf, und er muss so geplant werden.

**Der Textencoder liegt im Cache – ungeprüft.** Jede LTX-Pipeline lädt standardmäßig
`mlx-community/gemma-3-12b-it-4bit` als Textencoder (verifiziert in
`~/AI/ltx-2-mlx/packages/ltx-pipelines-mlx/src/ltx_pipelines_mlx/_base.py:65`, für jede
Pipeline, nicht bloß für `--enhance-prompt`). Stand 2026-08-11 liegt das Modell vollständig im
HuggingFace-Cache dieser Maschine: Snapshot `86cc6a8dedbc456dd0e4af01a9d09f396f77e558`, 7,5 GB,
15 von 15 Dateien, beide safetensors-Shards, keine `.incomplete`-Reste. Damit ist die
Cache-Voraussetzung erfüllt – **der erste echte Lauf steht noch aus.** In dieser Session waren
Modelltests gesperrt, es hat also niemand gesehen, dass eine LTX-Pipeline mit diesem
Textencoder tatsächlich durchläuft. Das ist zusammen mit der Frame-Lock-Probe unten der erste
Schritt beim ersten lokalen Bau, nicht vorher als erledigt zu behandeln.

Nebenbefund vom Download, weil er beim nächsten großen Modell wieder zuschlägt: Solange das
Xet-Backend aktiv war, stand der Fortschritt bei 0 MB/min; mit `HF_HUB_DISABLE_XET=1` lief der
Download sofort mit rund 220 MB/min, Gesamtdauer 40:27. Das deckt sich mit
`~/Knowledge/10-global/hf-download-xet-stillstand.md` (07.08.2026, dort 0 MB/min gegen
423 MB/min bei einem anderen Modell) – bei jedem größeren Download vorsorglich
`HF_HUB_DISABLE_XET=1` setzen.

Eine dritte Sache ist offen, nicht gemessen: ob LTX' Frame 0 tatsächlich dem Eingabebild
entspricht (Frame-Lock, Zielschwelle des Originals ≥ 30 dB PSNR). Das Qualifikationsverfahren
dazu steht unten unter QA – es ist Pflicht vor dem ersten echten Bau, nicht optional.

## Interview

Wie im Original wird der Gegenstand offen erfragt, nie als Multiple-Choice-Liste vorgegeben –
eine erfundene Branchenliste unterstellt dem Nutzer ein Geschäft. Strukturierte Auswahl
(`AskUserQuestion`) bleibt den echt abzählbaren, folgenarmen Entscheidungen vorbehalten.

1. **Gegenstand** – offen: "Worum soll diese Welt gehen? Ein Wort oder ein Satz reicht."
   Branche/Produkt, ein Einzeiler, ein Markenname, falls vorhanden.
2. **Weg** – Code, Video lokal oder gemischt (Wegwahl-Tabelle oben zeigen, mit Kosten und
   Wartezeit). Bei gemischt: welche Segmente jeweils welchen Weg bekommen.
3. **Markenkit** – 4 bis 6 benannte Hex-Werte, ein Anzeigename, ein bis zwei Ton-Wörter. Vom
   Nutzer direkt, oder ein Vorschlag zur Freigabe.
4. **Art Direction** – Standard: mattes Clay-Diorama, isometrisch, Tilt-Shift-Miniatur, warmes
   Licht (Stilpräambel in `reference/prompt-vorlagen.md`). Alternativen dort ebenfalls
   hinterlegt (Flach-Papercraft, Glossy Toy, Claymation, Neon-Nacht, photoreal-architektonisch).
5. **Kameraarchitektur** – immer fragen, nie still entscheiden:
   - **"Durch die Welt fliegen"** – Kamera taucht in jede Szene ein, steigt wieder auf, springt
     zur nächsten. Richtungswechsel an jeder Naht; im Diorama wirkt das gewollt ("Zoom raus auf
     die Karte, weiter zur nächsten Insel"), bei erdverbundener Optik wie ein Ruckler.
     → Architektur B, Standard bei Diorama/Miniatur.
   - **"Ein durchgehender Rundgang"** – ein Flug, nur vorwärts, gleitet durch jede Szene direkt
     in die nächste. → Architektur A, Standard bei erdverbundener/fotorealer Optik.
   - **"Feste isometrische Gleitfahrt"** – ein fester Winkel für den ganzen Film, die Welt
     zieht vorbei. → Architektur A plus die Locked-Iso-Klausel (`reference/prompt-vorlagen.md`).
   Trade-off in einem Satz je Option nennen (siehe oben), dann entscheiden lassen.
6. **Die Reise (Segmente)** – die geordneten Stationen. Aus der Wertschöpfungskette des
   Gegenstands vorschlagen, vom Nutzer editieren lassen. 5 bis 7 Segmente. Jedes braucht: was
   im Bild ist, `eyebrow`, `title`, `body` (≤ 1 Satz), 0 bis 3 `tags`. Das letzte Segment trägt
   meist das Hero-Produkt und den Call-to-Action.
7. **Stills-Quelle** (nur relevant für Segmente, die ein Standbild brauchen – als Poster, als
   Parallax-Ebene, oder als eigenes `still`-Segment) – `bild` lokal, Gamma `generate_image`,
   Canva, oder Adobe Firefly. **Eine Quelle für alle Stills eines Baus** – das Original hält
   diese Regel aus gutem Grund fest (Abschnitt 1.7 in `engine/ORIGINAL-SKILL.md`): zwei Quellen
   im selben Bau lesen sich als Stilbruch, selbst bei identischer Stilpräambel.

## Vertrag für render(t, ctx)

Jeder `szene`-Treiber bekommt `ctx = { canvas, ctx2d, width, height, dpr, segment,
reducedMotion }` (`reference/api-vertrag.md`). Fünf Eigenschaften, die beim Schreiben eines
eigenen Treibers leicht übersehen werden:

- `width`/`height` sind **logische CSS-Pixel**, nicht Gerätepixel. Die 2D-Transformation ist
  bereits mit `dpr` vorskaliert, und die Fläche wird vor jedem Aufruf geleert. Wer zusätzlich
  mit `dpr` multipliziert oder `canvas.width` statt `width` liest, zeichnet auf einem
  Retina-Schirm doppelt so groß (Gotchas).
- `render` muss eine **reine Funktion von `t`** sein: kein `Date.now()`, kein Frame-Zähler,
  kein Zustand zwischen Aufrufen. Scroll ist ein Schrubber, es geht auch rückwärts, und ein
  schnelles Wischen überspringt Zwischenwerte.
- `t = 0` und `t = 1` sind die **Nahtframes** und müssen exakt reproduzierbar sein – der
  Bauschritt exportiert genau sie über `exportFrame` (nächster Abschnitt).
- Budget **8 ms** je Aufruf, die Engine ruft `render` in ihrer rAF-Schleife auf.
- `reducedMotion` hat eine **Rangfolge**: liegt ein `still` vor, gewinnt es, und es entsteht gar
  kein Canvas; fehlt es, wird genau einmal bei `staticT` (Default 0) gezeichnet und danach nicht
  mehr.

Lädt ein Treiber Bilder, Gewichte oder sonst etwas nach – jeder bildbasierte Treiber tut das –,
**muss er ein `ready`-Versprechen anbieten**, und in dieses `ready` gehört jede einmalige
Vorarbeit, die sonst den ersten sichtbaren Frame trifft. Engine und `exportFrame` warten darauf.
Zwei gemessene Belege, warum das kein Formalismus ist: Ohne Aufwärmen kostete der erste
skalierte `drawImage` einer 2560×1440-Ebene 7,4 ms, der erste Frame einer Parallax-Szene also
16 bis 19 ms statt 0,05 ms. Und `treiber-three.js` übersetzt seine Shader beim ersten Zeichnen
eines Materials, was mit kaltem Profil als **ein Frame von 167 bis 190 ms** landete, mehr als
das Zwanzigfache des Budgets – behoben, indem der Treiber `compileAsync` aufruft und einen
Wegwerfframe rendert, alles innerhalb von `ready`. Ohne das `ready`-Versprechen exportiert der
Bauschritt außerdem stillschweigend einen halb geladenen Nahtframe, und genau der wandert dann
als Startbild in ein Videomodell und verdirbt die ganze Kette. Das ist kein theoretisches
Risiko: Der erste dieser beiden Fehler ist beim Bau der Referenz-Engine selbst aufgetreten
(Engine-Ergebnisprotokoll, `~/.pi-workers/results/swelt-engine/latest.md`, Abschnitt "Zwei
Fehler") – die Szene blieb auf dem leeren ersten Frame stehen, weil vor dem Fertigladen der
Ebenen gezeichnet wurde und `t` sich danach nicht mehr bewegte.

## Bauschritte je Weg

Der volle Ablauf mit Befehlen steht in `reference/bau-ablauf.md`. Kurzfassung:

- **Code (2.5D/3D):** Stills/Assets besorgen (Stills-Quelle oben) → Kamerabahn und Ebenen
  festlegen → `render(t, ctx)` schreiben, reine Funktion von `t` → in `mountScrollWelt` als
  `{ kind: 'szene', render, still, … }` einhängen → Nahtframes bei `t=0`/`t=1` prüfen.
- **Video lokal:** Voraussetzungen prüfen (Gemma-Textencoder im Cache, Frame-Lock-Probe
  bestanden) → Stills erzeugen → Legs mit `video --bild <still> "<prompt>"` (nutzt intern
  `ltx-2-mlx generate --image`, siehe `regeln/medien.md`) → bei Architektur B zusätzlich
  Connectors mit `ltx-2-mlx keyframe --start <letzter Frame> --end <erster Frame der
  Nachbarszene>` direkt über die CLI (der `video`-Wrapper kennt kein Zwei-Enden-Keyframing) →
  für Scrubbing kodieren → als `{ kind: 'video', clip, … }` einhängen.
- **Gemischt:** wie oben, je Segment der passende Weg, verbunden über die Nahtbrücke (nächster
  Abschnitt).

## Das Nahtgesetz

Unverändert aus dem Original: Die Endpunkte eines Videoclips müssen die **tatsächlich
gerenderten** Frames der Nachbarn sein, nie ein frisch erzeugtes Standbild. Zwei
unterschiedliche Renderläufe derselben Szene sehen nie pixelgleich aus – wer stattdessen die
Ausgangs-Stills nimmt, bekommt einen sichtbaren Sprung an der Naht (das häufigste Original-
Gotcha, `engine/ORIGINAL-SKILL.md`).

Neu ist, dass eine Naht jetzt auch auf eine Code-Szene treffen kann. Der Vertrag dafür
(`reference/api-vertrag.md`) verlangt von jedem Segment eine `exportFrame(segmentId, t, opts?)
-> Promise<Blob>`-Funktion (PNG), headless aufrufbar (Playwright) – bei einer Code-Szene kostet
dieser Frame nichts, sie kann ihn jederzeit exakt liefern. Die Funktion ist **asynchron und
kann nicht anders sein**: `canvas.toBlob` arbeitet mit Callback, und ein Videoframe braucht
einen abgewarteten Seek. Wer sie synchron behandelt oder das Promise nicht abwartet, bekommt
keinen Fehler, sondern einen leeren oder falschen Blob – der Bauschritt muss `await
exportFrame(...)` schreiben, sonst fällt der Fehler erst am fertigen Videoclip auf. Eine
lauffähige Referenzimplementierung des headless Bauschritts liegt in
`engine/demo/tools/export-seams-headless.mjs`: sie steuert ein Headless-Chromium über CDP,
ganz ohne npm-Abhängigkeit, und ruft `exportFrame` für alle drei Segmentarten ab.

Das Verfahren ist an einer echten Kette belegt, nicht nur behauptet: In der Demo-Kette misst
der erste Frame des gerenderten Video-Clips gegen `exportFrame('hof', 1)` 46,0 dB PSNR – die
Naht sitzt. Die Gegenprobe, derselbe Clip-Frame gegen den falschen Nachbar-Frame, misst
14,4 dB – der Abstand ist groß genug, um eine schlechte Naht zuverlässig von einer guten zu
unterscheiden (Engine-Ergebnisprotokoll, `~/.pi-workers/results/swelt-engine/latest.md`).

Vier Nahtarten, vier Verfahren:

- **Code → Video:** `exportFrame('szene-id', 1)` liefert das Startbild für den nächsten Clip.
  Der Clip beginnt garantiert auf dem Frame, auf dem die Code-Szene endet.
- **Video → Code:** letzten Frame des Clips per ffmpeg ziehen (`ffmpeg -sseof -0.15 -i
  clip.mp4 -frames:v 1 -q:v 2 letzter.png`), als Hintergrundebene der folgenden Code-Szene bei
  `t = 0` einsetzen.
- **Video → Video:** unverändert das Verfahren des Originals – letzter Frame von Clip i wird
  Startbild (Architektur A) oder Start-Keyframe (Architektur B) von Clip i+1.
- **Code → Code:** keine Naht nötig, die Kamerabahn läuft in derselben Canvas-Session durch.

Architektur A und B (Kamera-Grammatik, Mid-Leg-Bewegungen, die Locked-Iso-Klausel) sind aus dem
Original unverändert übernommen – sie sind unabhängig von der Bewegungsquelle, gelten für
Code- und Video-Segmente gleichermaßen und stehen ausformuliert in
`reference/prompt-vorlagen.md`.

## Telefon

Die Härtung des Originals gilt für jedes Segment und ist nicht abschaltbar: Seek-Coalescing,
iOS-Priming, Poster bis der Clip malt, Safe-Area, kein Sprung beim Ein- und Ausfahren der
URL-Leiste. Das ist keine Mobilfassung. Es ist die Seite, die auf einem Telefon nicht kaputt
geht – sie gilt immer, unabhängig davon, ob im Interview eine Mobilfassung gewünscht wird.

Belegt unter emulierten Telefonbedingungen (390×844, dpr 3, Coarse-Pointer, Touch,
Prüfskript `engine/demo/tools/verify-headless.mjs`): Seek-Coalescing hält bei 6-fach
gedrosselter CPU – von 91 rAF-Ticks eines dreifachen Hin-und-Her-Wischens trafen 78 den Dekoder
besetzt an, nie mehr als ein Seek gleichzeitig offen, kein eingefrorener Frame. Eine reine
Höhenänderung des Viewports (844 auf 760) lässt die Scrollposition unverändert, gemessen an
einem konkreten Wert: 1857 bleibt 1857, kein Sprung. **Ungeprüft bleibt das iOS-Priming** – der
`muted play → pause`-Kniff existiert, weil WebKit auf iOS ein gesuchtes, nie abgespieltes Video
schwarz lässt, und dieses Verhalten hat ein emuliertes Chromium nicht. Nur ein echtes iPhone
oder ein Safari-Simulator kann das bestätigen oder widerlegen.

Je Treiber kommt Unterschiedliches hinzu, und der Unterschied kostet unterschiedlich viel:

- **`video`** braucht eine eigene Portrait-Kette, wenn eine echte Mobilfassung gewünscht ist:
  `clipMobile` je Segment, nativ in 9:16 gerendert, 720 breit, GOP 4, dazu `stillMobile` als
  Poster. Ein mittiger Beschnitt der 16:9-Datei ist ausdrücklich der Notnagel, nicht die
  Mobilfassung, und muss als solcher benannt werden. Fehlt `clipMobile`, fällt die Engine auf
  den Desktop-Clip zurück.
- **`szene` bei `treiber-parallax.js`** braucht keine zweite Datei, aber eine zweite Kamera.
  Gemessen: Dieselben Ebenen füllen ein 9:16-Canvas lückenlos, zu 100 Prozent gedeckt bis an
  alle Ränder – kein zweiter Satz Assets, keine doppelte Rechenzeit, das ist der Vorteil und er
  hält. Die Komposition richtet sich aber **nicht von selbst** aus: Ein Hochformat sieht nur
  noch etwa ein Fünftel der Ebenenbreite, und mit der Querformat-Kamera stand eine Beispielszene
  halb außerhalb des Bildes, eine andere war auf Details zusammengeschnitten. Ein
  2.5D-Treiber braucht deshalb einen zweiten, von Hand gesetzten Kamerablock (`cameraPortrait`,
  greift unterhalb von `portraitBelowAspect`, erbt jeden ausgelassenen Wert vom
  Querformat-Block). Gotcha dabei: `pan` zählt in Canvas-Breiten, und ein schmales Canvas ist
  rund ein Fünftel so breit wie das Ebenenfeld – die Hochformat-Pan-Werte liegen deshalb um ein
  Vielfaches höher als die des Querformats (in der Demo 0,34 gegen 0,055).
- **`szene` bei `treiber-three.js`** braucht das nicht: Eine Kamera mit vertikalem Sichtfeld
  schneidet seitlich ab, ohne dass das Motiv wegwandert, ganz ohne einen zweiten Kamerablock.
- **`still`**: `stillMobile` optional, sonst dasselbe Bild.

## QA

- **Frame-Lock-Probe, Pflicht vor dem ersten echten Bau, aktuell ungemessen:** einen Clip mit
  `video --bild still.png "<Leg-Prompt>"` rendern, Frame 0 extrahieren
  (`ffmpeg -ss 0 -i clip.mp4 -frames:v 1 -q:v 2 frame0.png`), gegen das Eingabebild per
  `ffmpeg -i frame0.png -i still.png -filter_complex psnr -f null -` prüfen. Zielschwelle wie
  im Original ≥ 30 dB. Erst danach zählt der Weg als qualifiziert für einen echten Bau.
- **`ready`-Versprechen prüfen, vor jedem Export.** Ein nachladender Treiber ohne `ready`
  liefert `exportFrame` einen halb geladenen Frame – kein Fehler, kein Absturz, nur ein
  falsches Bild, das dann als Startbild in ein Videomodell wandert und die ganze Kette
  verdirbt. Ein stiller Fehler mit teurer Folge: Er fällt erst am fertigen, falsch startenden
  Videoclip auf, Stunden nach dem eigentlichen Fehler. Vor jedem Bauschritt prüfen, dass der
  Treiber sein `ready` tatsächlich abwartet, nicht nur anbietet.
- **Seam-QA:** headless (Playwright, Referenzimplementierung
  `engine/demo/tools/export-seams-headless.mjs`) kurz vor und kurz nach jeder Naht
  screenshotten, beide Bilder müssen nahezu identisch sein. Ein Sprung heißt: Still statt
  echtem Frame benutzt, `ready` nicht abgewartet, oder die Crossfade-Bande der Engine ist zu
  kurz.
- **Render-Budget:** `render(t, ctx)` muss unter 8 ms bleiben (die Engine ruft es in ihrer
  rAF-Schleife auf); mit den Browser-Devtools messen, nicht schätzen. An der Referenz-Demo
  gemessen (Engine-Ergebnisprotokoll): Mittel 0,05–0,06 ms, Maximum 0,2–0,3 ms, keine
  Überschreitung – aber nur, weil der Parallax-Treiber seine Ebenen in `ready` aufwärmt. Ohne
  dieses Aufwärmen kostete der erste Frame jeder Szene 16 bis 19 ms (Gotchas).
- **Reinheit:** `render` darf nicht von `Date.now()`, einem Frame-Zähler oder gespeichertem
  Zustand abhängen – Scroll geht auch rückwärts, und ein schnelles Wischen überspringt
  Zwischenwerte. Eine Szene, die vom letzten Zustand aus weiterschreibt, driftet dabei
  auseinander.
- **Reduced Motion:** bei `prefers-reduced-motion` muss jedes Segment einmal bei `staticT`
  zeichnen und danach stillstehen – für Video-Segmente ist das ohnehin der Poster-Fallback,
  für Code-Szenen ist es explizit zu prüfen.
- **Konsole:** keine Fehler, `video.seekable.end(0) > 0` (Blob-Loading funktioniert).

## Gotchas

- **Naht-Sprung** → ein Endpunkt war ein frisch erzeugtes Still statt der tatsächlich
  gerenderte/exportierte Nachbar-Frame. Gilt für Video- und Code-Endpunkte gleichermaßen.
- **Naht-Ruckler ("Kamera springt rückwärts")** → auch bei frame-gelockten Nähten: wenn die
  Kamerarichtung an der Naht umkehrt (Vorwärts-Dive, dann ein Connector, der wieder
  rauszieht), liest sich das wie ein Rückspul-Effekt. Bei Architektur B ist das gewollt und
  passt zur Diorama-Optik; bei einer erdverbundenen Szene Architektur A nehmen.
- **Szene driftet nach schnellem Scrollen** → `render(t, ctx)` hält irgendwo eigenen Zustand
  oder rechnet mit Zeit statt mit `t`. Reine Funktion von `t` erzwingen.
- **Szene zu groß auf Retina-Schirmen** → `width`/`height` als Gerätepixel behandelt statt als
  logische CSS-Pixel. Die 2D-Transformation ist schon mit `dpr` vorskaliert; wer zusätzlich mit
  `dpr` multipliziert oder `canvas.width` direkt liest, zeichnet doppelt so groß.
- **Szene bleibt auf leerem oder halbfertigem ersten Frame stehen** → der Treiber lädt Bilder
  nach, hat aber kein `ready`-Versprechen angeboten oder es wurde nicht abgewartet. Genau dieser
  Fehler ist beim Bau der Referenz-Engine aufgetreten: Sie zeichnete einmal, bevor die Ebenen
  fertig dekodiert waren, `t` bewegte sich danach nicht mehr, also fragte niemand ein neues Bild
  an. Fix: die Engine (und jeder eigene Bauschritt) muss `ready` abwarten, bevor der erste
  `render`- oder `exportFrame`-Aufruf zählt.
- **Erster Frame jeder Szene kostet 16 bis 19 ms statt unter 8 ms** → das PNG-Dekodieren ist
  billig. Teuer ist der erste skaliert gezeichnete `drawImage` einer großen Ebene (gemessen:
  7,4 ms je Ebene bei 2560×1440). Ein Aufwärmen bei kleiner Auflösung hilft nichts (6,0 ms bei
  64 px); erst ein Aufwärmen nahe der Zielgröße (0,9 ms bei 1600 px) drückt die Kosten runter.
  Der Parallax-Treiber wärmt seine Ebenen deshalb in `ready` auf, bevor irgendein Frame darauf
  wartet – ein eigener Treiber muss dasselbe tun, sonst ruckelt exakt der erste Frame jeder Szene.
- **Erster Frame einer 3D-Szene kostet 167 bis 190 ms** → three.js übersetzt seine Shader beim
  ersten Zeichnen eines Materials, nicht beim Laden der Szene. `treiber-three.js` fängt das ab,
  indem er in `ready` `compileAsync` aufruft und einen Wegwerfframe rendert; danach kostet der
  erste echte Frame noch 1,1 bis 1,2 ms. Ein eigener Three-Treiber ohne diesen Schritt trifft
  genau diese Kosten beim ersten Auftauchen des Segments, nicht beim Bau der Szene.
- **`exportFrame` liefert einen leeren oder falschen Blob** → als synchrone Funktion behandelt,
  oder das zurückgegebene Promise nicht abgewartet. `canvas.toBlob` ist Callback-basiert, ein
  Videoframe braucht einen abgewarteten Seek – `await exportFrame(...)` ist Pflicht, kein Stil.
- **Portrait-Kamera einer Parallax-Szene wirkt kaputt (Motiv rast durchs Bild oder rührt sich
  kaum)** → `pan` zählt in Canvas-Breiten, nicht in Pixeln. Ein schmales Hochformat-Canvas ist
  rund ein Fünftel so breit wie das Ebenenfeld, deshalb liegen die `pan`-Werte von
  `cameraPortrait` um ein Vielfaches höher als die des Querformats (in der Demo 0,34 gegen
  0,055). Das ist kein Bug, das ist die Einheit – vor dem Debuggen erst den Faktor nachrechnen.
- **RAM-Konflikt beim lokalen Videolauf** → `video` braucht fast den ganzen Arbeitsspeicher und
  bricht mit einer Warnung ab, wenn ein großes Ollama-Modell (9b/30b/35b) noch geladen ist.
  Vorher `ollama stop <modell>`.
- **`video`-Lauf bricht beim Laden ab** → der Gemma-Textencoder fehlt im Cache (auf einer
  anderen Maschine, oder wenn der Cache geleert wurde) und `HF_HUB_OFFLINE=1` verhindert den
  Nachlade-Versuch. Erst mit Online-Zugriff einmal vorab laden, dann offline weiterarbeiten;
  Cache-Stand prüfen wie oben unter "Zwei Hürden" beschrieben.
- **Großer Modell-Download hängt bei wachsender CPU-Zeit, aber 0 MB/min** → das Xet-Backend von
  `hf_xet` steht gelegentlich still, obwohl der Prozess lebt und Verbindungen offen hält. Fix:
  `HF_HUB_DISABLE_XET=1` vor dem Download setzen (Beleg: siehe oben, Nebenbefund zum
  Textencoder-Download, und `~/Knowledge/10-global/hf-download-xet-stillstand.md`).
- **Connector fehlt / `video`-Wrapper kennt kein `--end`** → der `video`-Befehl deckt nur
  `generate --image` ab (ein Startbild, für Legs). Für Connectors mit zwei festen Enden direkt
  `~/AI/ltx-2-mlx/.venv/bin/ltx-2-mlx keyframe --start … --end …` aufrufen.
- **Weißer Kasten statt freischwebender Szene** → Stillquelle liefert einen soliden
  Hintergrund. Entweder Seitenhintergrund auf dieselbe Farbe setzen, oder mit
  `engine/knockout.py` freistellen (Original-Werkzeug, unverändert nutzbar).
- **Zwei Stilquellen im selben Bau** → liest sich als Stilbruch, auch bei identischer
  Stilpräambel. Eine Quelle je Bau, siehe Interview Punkt 7.
- **Zwei Modelle im selben lokalen Video-Weg** → jedes Modell hat seinen eigenen Bewegungs-
  und Rauschcharakter; ein Modellwechsel mitten in der Kette liest sich als Bruch, selbst bei
  frame-gelockter Naht. Ein Modell für die ganze Kette.

## Einhängen in design-bausteine

Dieser Skill ist der Bewegungszweig von `design-bausteine` Schritt 3 (Bauen), parallel zu
`frontend-design` und `document-design`. Welche Zeile dort ergänzt wird, steht im
Ergebnisprotokoll dieses Laufs – die Tabelle in `design-bausteine/SKILL.md` selbst wird von
diesem Skill nicht angefasst.

## Referenzen

| Datei | Inhalt |
|---|---|
| `reference/api-vertrag.md` | eingefroren, verbindlich – Segment-Schema, `render`-Vertrag, Nahtbrücke |
| `reference/prompt-vorlagen.md` | Stilpräambel, Stills-Prompt, Leg-/Connector-Prompts, Mid-Leg-Bibliothek, Locked-Iso-Klausel, Code-Szenen-Bauauftrag |
| `reference/bau-ablauf.md` | Befehle und Reihenfolge je Weg, Voraussetzungs-Check, Encode-Einstellungen |
| `engine/ORIGINAL-SKILL.md` | Original-Anleitung von oso95/scroll-world, für alles, was hier nicht wiederholt wird (Architektur-A/B-Grammatik im Volltext, sämtliche Original-Gotchas) |
| `engine/scrub-welt.js` | die einzuhängende Engine, implementiert `mountScrollWelt`/`segments` aus `reference/api-vertrag.md` |
| `engine/scrub-engine.js`, `engine/LICENSE-scroll-world` | die unveränderte Original-Engine samt Lizenz, Grundlage von `scrub-welt.js` |
| `engine/demo/` | lauffähige gemischte Kette (2.5D-Szene → Video → 2.5D-Szene → Three.js-Szene → Standbild) als Anschauungsbeispiel, dazu `original.html`/`original-upstream.html` als Rückwärtskompatibilitäts-Nachweis und `ohne-three.html` als Ausfallweg-Nachweis |
| `engine/demo/tools/export-seams-headless.mjs` | der echte headless Bauschritt für Nahtframes, ohne npm-Abhängigkeit (`node demo/tools/export-seams-headless.mjs`, Server dazu: `python3 demo/tools/serve.py`) |
| `engine/demo/tools/verify-headless.mjs` | der Prüflauf für Three.js-Treiber und Telefon-Emulation, 20 Prüfungen (`python3 demo/tools/serve.py &`, dann `node demo/tools/verify-headless.mjs`) |
