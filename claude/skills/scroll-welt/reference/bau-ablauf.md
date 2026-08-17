# Bau-Ablauf je Weg

> Pfadbezug: Alle Pfade wie `engine/…` oder `reference/…` sind relativ zum
> Skill-Verzeichnis `~/.claude/skills/scroll-welt/` gemeint, nicht zum
> Arbeitsverzeichnis des Projekts.


Befehle und Reihenfolge. Alle Pfade unten sind auf diesem Rechner geprüft (2026-08-11) –
`~/.local/bin/bild` und `~/.local/bin/video` existieren und sind die von `regeln/medien.md`
vorgeschriebenen LOCAL-FIRST-Werkzeuge; `~/AI/ltx-2-mlx` ist das Repo dahinter. Wo im Text
"lokales Modell starten" stünde, ist das für den vorliegenden Skill-Bau-Lauf ausdrücklich
nicht ausgeführt worden – die Befehle sind dokumentiert, nicht getestet (Grund im
Ergebnisprotokoll dieses Laufs).

## Voraussetzungen, einmal je Maschine prüfen

**Gemma-Textencoder im Cache.** `video` und die rohe `ltx-2-mlx`-CLI setzen
`HF_HUB_OFFLINE=1` – ohne einen vorherigen Online-Download bricht das Laden ab, kein
automatischer Nachlade-Versuch. Prüfen:

```bash
ls ~/.cache/huggingface/hub | grep -i gemma-3-12b-it-4bit
```

Ein Snapshot-Ordner (nicht nur ein `.locks`-Eintrag) muss existieren. Fehlt er, muss das
Modell vor dem ersten lokalen Videobau einmal online geladen werden – das fällt unter
`regeln/lokale-modelle.md`, nicht unter diesen Skill. Auf dieser Maschine liegt der Snapshot
seit 2026-08-11 vollständig vor (`86cc6a8dedbc456dd0e4af01a9d09f396f77e558`, 7,5 GB); das
deckt nur die Cache-Voraussetzung ab, nicht den ersten echten Pipeline-Lauf – der ist erster
Schritt zusammen mit der Frame-Lock-Probe unten, nicht vorher als erledigt zu behandeln. Bei
einem größeren Download stand der Fortschritt bei 0 MB/min, solange das Xet-Backend aktiv war,
und lief mit `HF_HUB_DISABLE_XET=1` sofort mit rund 220 MB/min (Gesamtdauer 40:27) – bei jedem
künftigen Download derselben Größenordnung vorsorglich setzen.

**RAM frei.** `video` prüft selbst, ob ein großes Ollama-Modell (9b/30b/35b) geladen ist, und
bricht mit einer Warnung ab. Vorher `ollama stop <modell>`, falls nötig.

**Frame-Lock-Probe (Pflicht vor dem ersten echten Bau, siehe SKILL.md → QA).** Ein Testbild
mit `video --bild test.png "gentle forward glide"` animieren, Frame 0 extrahieren und per
PSNR gegen `test.png` prüfen. Erst ab ≥ 30 dB gilt der Weg als qualifiziert.

## Weg: Code, 2.5D-Parallaxe

1. Stills/Assets besorgen (Stilquelle aus dem Interview, eine Quelle für den ganzen Bau).
2. Bei freischwebenden Szenen: `python3 engine/knockout.py <still>.png <still>-frei.png`
   (Original-Werkzeug, randverbundene Flutfüllung – lässt Innenfarben wie Cremewände in Ruhe).
3. Kamerabahn festlegen: Ausgangspunkt bei `t=0`, Zielzustand bei `t=1`, dazwischen linear
   oder mit Easing interpoliert.
4. `render(t, ctx)` schreiben – `ctx = { canvas, ctx2d, width, height, dpr, segment,
   reducedMotion }` (`reference/api-vertrag.md`). `width`/`height` sind logische CSS-Pixel, die
   2D-Transformation ist schon mit `dpr` vorskaliert – in Gerätepixeln rechnen zeichnet auf
   einem Retina-Schirm doppelt so groß. Ebenen nach Tiefenwert zeichnen, Pan/Zoom/Parallaxe aus
   `t` ableiten. Reine Funktion von `t`, kein `Date.now()`, kein gespeicherter Zustand.
5. Ein `ready`-Versprechen anbieten, das auflöst, sobald alle Ebenen geladen **und** einmal
   nahe der Zielgröße vorgezeichnet sind (nicht nur dekodiert). Ohne den Vorzeichenschritt
   kostet der erste `render`-Aufruf einer großen Ebene rund 7,4 ms zusätzlich – gemessen an
   einer 2560×1440-Ebene, Budget ist 8 ms insgesamt. Die Engine und `exportFrame` warten auf
   dieses Versprechen; ohne es exportiert der Bauschritt einen halb geladenen Nahtframe.
6. Nur falls eine Mobilfassung gebraucht wird: einen zweiten Kamerablock `cameraPortrait`
   setzen (greift unterhalb von `portraitBelowAspect`, erbt jeden ausgelassenen Wert vom
   Querformat-Block `camera`). Das ist kein Automatismus – ohne ihn sieht ein Hochformat nur
   noch etwa ein Fünftel der Ebenenbreite, und das Motiv steht halb außerhalb des Bildes.
   `pan` zählt dabei in Canvas-Breiten, nicht in Pixeln: Ein schmales Canvas ist rund ein
   Fünftel so breit wie das Ebenenfeld, die `pan`-Werte von `cameraPortrait` müssen deshalb um
   ein Vielfaches höher liegen als die des Querformats (gemessen in der Demo: 0,34 gegen
   0,055). Von Hand einstellen und an drei bis vier Scrollpositionen ansehen, es gibt dafür
   keine automatische Umrechnung.
7. Bei `reducedMotion`: einmal bei `staticT` (Default 0) zeichnen, danach nicht mehr animieren.
   Trägt das Segment ein `still`, entfällt dieser Schritt ganz – dann gewinnt das Standbild,
   und es entsteht gar kein Canvas.
8. Segment einhängen:
   ```js
   { kind: 'szene', id: 'farm', scroll: 1.6, linger: 0.45,
     render: farmRender, still: 'assets/farm.webp',
     eyebrow: '…', title: '…', body: '…', tags: ['…'], accent: '#8FB98A' }
   ```
9. Nahtframes prüfen: `await exportFrame('farm', 0)` und `await exportFrame('farm', 1)` gegen
   die Nachbarsegmente vergleichen (Nahtgesetz, SKILL.md). `exportFrame` ist asynchron – das
   Promise muss abgewartet werden, sonst liefert es einen leeren oder falschen Blob statt eines
   Fehlers. Lauffähiges Beispiel für den headless Aufruf:
   `engine/demo/tools/export-seams-headless.mjs` (Server dazu: `python3
   engine/demo/tools/serve.py`).

## Weg: Code, 3D (Three.js)

Wie oben, mit zwei Unterschieden: Schritt 3 wird eine Kamera-Spline statt einer
Ebenenbewegung, Schritt 4 baut eine `three`-Szene statt Canvas2D-Ebenen zu zeichnen. Nur
sinnvoll, wenn das Projekt `three` bereits einbindet (`treiber-three.js` lädt es nicht selbst
nach, laut `reference/api-vertrag.md`). Schritt 6 (`cameraPortrait`) entfällt komplett: Eine
Kamera mit vertikalem Sichtfeld schneidet im Hochformat seitlich ab, ohne dass das Motiv
wegwandert, ganz ohne zweiten Kamerablock. Dafür gehört in Schritt 5 (`ready`) zusätzlich ein
Shader-Vorkompilierschritt – `compileAsync` aufrufen und einen Wegwerfframe rendern, bevor
`ready` auflöst. Ohne ihn kostet der erste Frame, in dem das Segment auftaucht, 167 bis
190 ms (Shader-Übersetzung beim ersten Zeichnen eines Materials), mit ihm noch 1,1 bis 1,2 ms.

## Weg: Video lokal (LTX-2-MLX)

1. Voraussetzungen oben abgehakt.
2. Stills erzeugen (Stilquelle aus dem Interview).
3. **Legs** (Architektur A oder als Dive-in bei Architektur B), sequenziell – jeder Leg
   braucht den tatsächlichen letzten Frame des vorherigen:
   ```bash
   video --bild still_farm.png "$(cat leg_farm.txt)" -o dive_farm.mp4
   ffmpeg -sseof -0.15 -i dive_farm.mp4 -frames:v 1 -q:v 2 last_farm.png
   video --bild last_farm.png "$(cat leg_kitchen.txt)" -o dive_kitchen.mp4
   ```
   `--hq` vor `--bild` für den Qualitätsmodus (`--two-stages-hq`); ohne `--hq` läuft der
   Schnellmodus (`--distilled`). Beide sind laut `~/AI/ltx-2-mlx/docs/PIPELINE_MATURITY.md`
   als Stable eingestuft. Jeden letzten Frame vor dem nächsten Leg ansehen – ein schlechter
   Übergabe-Frame verdirbt die ganze restliche Kette.
4. **Connectors** (nur Architektur B) – der `video`-Wrapper kennt kein Zwei-Enden-Keyframing,
   also direkt die CLI:
   ```bash
   ffmpeg -ss 0 -i dive_kitchen.mp4 -frames:v 1 -q:v 2 first_kitchen.png
   ~/AI/ltx-2-mlx/.venv/bin/ltx-2-mlx keyframe \
     --start last_farm.png --end first_kitchen.png \
     --prompt "$(cat conn_1.txt)" -o conn_1.mp4
   ```
5. **Kodieren fürs Scrubbing** – aus dem Original übernommen, hier nicht neu vermessen: native
   Auflösung, kein Hochskalieren, kleine GOP statt All-Intra (blob-basiertes Seeking macht
   All-Intra unnötig):
   ```bash
   ffmpeg -i quelle.mp4 -an -vf "unsharp=5:5:0.8:5:5:0.0" \
     -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
     -g 8 -keyint_min 8 -sc_threshold 0 -movflags +faststart ziel.mp4
   ```
6. Segment einhängen:
   ```js
   { kind: 'video', id: 'kitchen', scroll: 0.9, clip: 'assets/vid/kitchen.mp4' }
   ```
   Nur bei gewünschter Mobilfassung zusätzlich `clipMobile`/`stillMobile` (Telefon-Abschnitt,
   SKILL.md): `clipMobile` muss eine eigene, nativ in 9:16 gerenderte Kette sein (720 breit,
   GOP 4), kein Beschnitt der 16:9-Datei. Ein Mittelbeschnitt ist nur als ausdrücklich
   benannter Notnagel zulässig.
7. Seam-QA (SKILL.md) an jeder Naht laufen lassen, nicht nur am Ende der Kette.

## Weg: Gemischt

Reihenfolge wie oben, je Segment der passende Weg. An jeder Übergangsstelle die passende
Nahtart aus dem Nahtgesetz (SKILL.md) anwenden. Reihenfolge in der Kette bauen, nicht Weg für
Weg getrennt: Ein Video-Leg, das auf eine noch nicht existierende Code-Szene zeigt, hat keinen
Frame, an dem es andocken kann.

**Code → Video:** den Austrittsframe der Code-Szene headless exportieren, dann als Startbild
an den Videobau übergeben:

```bash
node engine/demo/tools/export-seams-headless.mjs \
  --url http://127.0.0.1:8731/demo/index.html \
  --frames "farm@1:farm-t1.png"
video --bild farm-t1.png "$(cat leg_kitchen.txt)" -o dive_kitchen.mp4
```

`exportFrame` liefert ein `Promise<Blob>`, nie einen synchronen Wert – der Server aus
`export-seams-headless.mjs` muss vorher laufen (`python3 engine/demo/tools/serve.py`), und ein
Treiber ohne abgewartetes `ready`-Versprechen liefert an dieser Stelle einen halb geladenen
Frame, kein Fehler (SKILL.md, Gotchas).

**Video → Code:** letzten Frame des Clips per ffmpeg ziehen und als Hintergrundebene der
folgenden Code-Szene bei `t = 0` einsetzen:

```bash
ffmpeg -sseof -0.15 -i dive_kitchen.mp4 -frames:v 1 -q:v 2 kitchen-letzter.png
```

`kitchen-letzter.png` wird dann die unterste Ebene (Tiefenwert 0) der nächsten
`treiber-parallax.js`-Szene, sodass `render(0)` exakt darauf beginnt.

## Telefon prüfen

Vor dem Ausliefern, für jeden Weg mit `video`-Segmenten oder `cameraPortrait`:

```bash
python3 engine/demo/tools/serve.py &
node engine/demo/tools/verify-headless.mjs
```

Prüft unter emulierten Telefonbedingungen (Coarse-Pointer, Touch, gedrosselte CPU): ob
`clipMobile` tatsächlich geladen wird, ob das Wischen bei gedrosselter CPU nicht einfriert
(Seek-Coalescing), ob eine reine Höhenänderung des Viewports die Scrollposition unverändert
lässt, und – bei einer Three.js-Szene – ob die Shader-Vorkompilierung greift. **Was dieser Lauf
nicht zeigen kann: iOS-Priming.** Der `muted play → pause`-Kniff gegen WebKits Schwarzbild-
Verhalten lässt sich nur auf einem echten iPhone oder einem Safari-Simulator bestätigen oder
widerlegen – ein emuliertes Chromium hat das Verhalten nicht, gegen das der Kniff überhaupt
antritt.

## macOS-Falle

zsh (macOS-Standard-Interaktivshell) indiziert Arrays ab 1, bash ab 0. Jede array-getriebene
Schleife (`for n in $NAMES`, Legs/Connectors der Reihe nach durchgehen) als
`#!/bin/bash`-Skript schreiben und mit `bash skript.sh` ausführen, nicht inline in der
interaktiven Shell – sonst greift die Schleife auf die falsche Szene zu oder bricht auf einen
noch nicht existierenden Frame.
