# Prompt-Vorlagen

> Pfadbezug: Alle Pfade wie `engine/…` oder `reference/…` sind relativ zum
> Skill-Verzeichnis `~/.claude/skills/scroll-welt/` gemeint, nicht zum
> Arbeitsverzeichnis des Projekts.


Alle Vorlagen sind Lückentexte. Die Stilpräambel bleibt über alle Stills eines Baus
byte-identisch – genau das macht die Welt zu einer Welt statt zu einer Bildersammlung. Die
Kamera-Grammatik (Architektur A/B, Mid-Leg-Bewegungen, Locked-Iso) ist unverändert aus
`engine/ORIGINAL-SKILL.md` übernommen, hier nur auf die lokalen Befehle umgeschrieben.

## Stilpräambel (Standard: Clay-Diorama)

Wortgleich in jedem Stills-Prompt eines Baus wiederverwenden, nur die Klammerwerte tauschen:

```
Isometric low-poly 3D diorama floating as a small rounded island on a plain solid
[BG_HEX] background with a soft contact shadow beneath it. Soft matte clay 3D render,
rounded toy-model shapes, gentle warm studio lighting, soft long shadows, tilt-shift
miniature look. Cohesive color palette of [PALETTE]. Highly detailed, centered
composition, absolutely no text, no letters, no numbers, no logos.
```

Alternative Richtungen (erste zwei Sätze tauschen, Palette/No-Text-Schluss behalten):

- **Flach-Papercraft:** "Isometric layered paper-craft diorama, matte cardstock, clean die-cut edges, subtle drop shadows between layers."
- **Glossy Toy:** "Isometric glossy vinyl-toy diorama, smooth plastic shading, soft rim light, collectible figurine look."
- **Claymation:** "Isometric stop-motion clay set, visible thumbprints, handmade plasticine texture, soft studio softbox light."
- **Neon-Nacht:** "Isometric miniature at night, warm interior glow and neon signage, moody rim light, wet reflective ground."
- **Photoreal-architektonisch** (Immobilien, Hospitality, Premium): "Ultra-photorealistic architectural photography of a single cohesive [subject], cinematic wide-angle, warm golden-hour light, natural materials, restrained designer furnishings, a breathtaking view, editorial magazine quality, shallow depth of field, no people." Bei dieser Richtung die Diorama-Insel-Rahmung und das Freistellen (`engine/knockout.py`) weglassen – die Szenen laufen randabfallend, ein dunkler Seitenhintergrund wirkt hier hochwertiger.

## Stills-Prompt

Für `bild`, Gamma `generate_image`, Canva oder Adobe Firefly – dieselbe Vorlage, unabhängig
von der gewählten Quelle:

```
[STILPRÄAMBEL]
Subject: [was in dieser Szene zu sehen ist – das Gebäude/der Raum, ein paar Figuren bei der
Arbeit, die Requisiten, die diese Station der Geschichte erkennbar machen].
```

- Konkrete Requisiten benennen (Tanks, Kessel, Förderband, Kisten, Markise, Lichterketten,
  Bänke) – sie verankern die Szene.
- Für das letzte, Hero-Produkt-Segment die Diorama-Rahmung weglassen: ein einzelnes,
  überdimensioniertes Produkt vor demselben Hintergrund, ein paar kleine umkreisende Requisiten.
- Zentral komponieren, etwas Kopffreiraum lassen – sowohl weil `object-fit: cover` den Rand
  beschneiden kann als auch weil eine zentrierte Komposition dieselbe Szene später als
  Parallax-Ebene oder als Videoszenen-Start brauchbar hält.
- Seitenverhältnis 3:2, höchste verfügbare Auflösung der gewählten Quelle.

## Code-Szenen-Bauauftrag (`szene`-Segment)

Kein Bildgenerator-Prompt, sondern die Spezifikation, die ein Entwickler oder Claude beim
Schreiben von `render(t, ctx)` braucht (Vertrag in `reference/api-vertrag.md`):

```
Segment: [id]. Kamerabahn: bei t=0 [Ausgangspunkt/-blickwinkel], bei t=0,5
[Zwischenzustand – z. B. Fokuspunkt erreicht], bei t=1 [Endzustand, der ins nächste Segment
übergeht]. Ebenen (bei 2.5D, mit Tiefenwert 0=Hintergrund…1=Vordergrund): [Liste der
PNG-Ebenen und ihrer Tiefe]. Fokuspunkt: [was im Bild die Aufmerksamkeit hält]. Farben:
[PALETTE]. Nahtanforderung: render(0) und render(1) müssen mit den exportierten Frames der
Nachbarsegmente übereinstimmen (siehe Nahtgesetz in SKILL.md).
```

Für `treiber-three.js`-Szenen tritt an die Stelle der Ebenenliste eine kurze Beschreibung der
3D-Szene (Geometrie, Materialien, Lichter) und die Kamera folgt einer Spline statt Ebenen zu
verschieben – der Bauauftrag bleibt sonst gleich.

Zwei Vertragspunkte gehören in jeden Bauauftrag, unabhängig vom Treiber (voll ausformuliert in
SKILL.md, Abschnitt "Vertrag für render(t, ctx)"): `width`/`height` sind logische CSS-Pixel,
nicht Gerätepixel, die 2D-Transformation ist schon mit `dpr` vorskaliert. Und ein Treiber, der
Ebenen, Assets oder Shader nachlädt oder übersetzt, muss ein `ready`-Versprechen anbieten, das
die Engine und `exportFrame` abwarten – sonst exportiert der Bauschritt einen halb geladenen
Nahtframe.

Dieser zweite Punkt trägt auch das Render-Budget, aber unterschiedlich je Treiber. Bei
`treiber-parallax.js` ist der erste Frame teuer, wenn die Ebenen erst beim ersten
`render`-Aufruf skaliert gezeichnet werden (gemessen: 7,4 ms je 2560×1440-Ebene). Ebenen im
`ready`-Versprechen einmal nahe der Zielgröße vorzeichnen drückt das auf rund 0,9 ms; ein
Vorzeichnen bei kleiner Auflösung hilft dagegen kaum (6,0 ms bei 64 px). Bei `treiber-three.js`
liegt das Problem nicht bei den Ebenen. Es liegt bei den Shadern: three übersetzt Materialien
beim ersten Zeichnen, kalt gemessen als ein Frame von 167 bis 190 ms. Der Bauauftrag muss deshalb einen
Vorkompilierschritt verlangen (`compileAsync` plus ein Wegwerfframe, innerhalb von `ready`) –
danach kostet der erste echte Frame noch 1,1 bis 1,2 ms. Ins `ready`-Versprechen gehört also in
beiden Fällen ein Aufwärmlauf, nicht nur das Laden der Rohdaten.

**Mobilfassung, nur bei `treiber-parallax.js` ein eigener Auftragspunkt.** Die Komposition
richtet sich nicht von selbst am Hochformat aus: Ein 9:16-Canvas sieht nur noch etwa ein
Fünftel der Ebenenbreite, ohne einen zweiten Kamerablock steht das Motiv halb außerhalb des
Bildes. Der Bauauftrag muss also einen zweiten Kamerablock verlangen (`cameraPortrait`, greift
unterhalb von `portraitBelowAspect`, erbt jeden ausgelassenen Wert vom Querformat) – und dabei
angeben, dass `pan` in Canvas-Breiten zählt, nicht in Pixeln: Die Hochformat-Werte liegen um
ein Vielfaches höher als die des Querformats (gemessen: 0,34 gegen 0,055). Bei
`treiber-three.js` entfällt dieser Auftragspunkt: Eine Kamera mit vertikalem Sichtfeld
schneidet im Hochformat seitlich ab, ohne dass das Motiv wegwandert.

## Leg-Prompt – Architektur A, durchgehender Vorwärtsflug

`--image = letzter tatsächlicher Frame des vorherigen Legs` (Leg 0: das Still der ersten
Szene). Kein Endbild. Die fett markierten Klauseln sind der Übergabe-Vertrag zwischen zwei
Legs – wortgleich beibehalten, die Mid-Leg-Bewegung ist die einzige freie Stelle:

```
Single continuous cinematic camera move, no cuts. **Continue the same slow, steady
forward glide.** [MID-LEG-BEWEGUNG – optional, aus der Bibliothek unten]. The camera moves
into [SZENE i] toward [FOKUSPUNKT]. **In the final second, settle back into a slow,
steady forward glide toward [die Tür/Öffnung/Richtung der nächsten Szene].**
[STIL-Schluss + PALETTE]. Smooth, graceful, slow motion, subtle parallax. No text, no captions.
```

Befehl: `video --bild <letzter-frame-oder-erstes-still>.png "<Prompt>"` (Schnell-Modus,
Z-Image/distilled) oder `video --hq --bild … "<Prompt>"` (Qualität, `--two-stages-hq`) – beide
Pfade sind laut `~/AI/ltx-2-mlx/docs/PIPELINE_MATURITY.md` als Stable eingestuft.

### Mid-Leg-Bewegungsbibliothek (nach Konzept wählen, für einen reinen Vorwärtsgleiter weglassen)

Richtungswechsel sind *innerhalb* eines Legs unbedenklich – das ist ein einzelner
durchgehender Render, es gibt dort keine Naht. Nur an einer Naht selbst darf sich die Richtung
nie umkehren.

**Locked-Iso-Klausel** (Kameraarchitektur "Feste isometrische Gleitfahrt"): die Bibliothek
unten überspringen und stattdessen diese Klausel wortgleich in jeden Leg-Prompt setzen:

```
The camera keeps exactly the same high isometric angle throughout — no rotation, no
orbit, no tilt. It only travels straight and level, the world sliding past beneath
the same view.
```

Die Übergabe-Klauseln drumherum bleiben unverändert. Beim Prüfen des letzten Frames zusätzlich
den Winkel kontrollieren – er kann bei langen Legs leicht driften; bei Drift den Leg neu
rendern.

- **Halb-Orbit** (Produkt, Luxus): "sweeping in a slow half-orbit around [das Hero-Objekt], keeping it centered, then continuing past it"
- **Kranfahrt aufwärts** (Weite, Atrien, Campus): "rising smoothly as the full scale of [der Raum] reveals below"
- **Niedrige Seitwärtsfahrt** (Fertigungslinien, Regale): "tracking low and level alongside [die Linie], foreground objects sliding past in parallax"
- **Heranfahrt + Rückzug** (Handwerk, Detail): "pushing in close to [der Handwerksmoment] until it nearly fills the frame, then easing gently back out"
- **Aufstieg und Schwenk** (Reise, im Freien): "climbing in a gentle arc over [das Gelände], then swooping down toward [der nächste Fokuspunkt]"

Nach jedem Leg den letzten Frame prüfen, bevor der nächste gerendert wird: er sollte wie ein
Frame aus einem ruhigen Vorwärtsgleiter aussehen. Wenn nicht, den Leg neu rendern – ein
schlechter Übergabe-Frame verdirbt jeden folgenden Leg.

## Connector-Prompt – Architektur B, Aufstieg und Überflug

`--start = letzter tatsächlicher Frame von Dive i`, `--end = erster tatsächlicher Frame von
Dive i+1` (beide aus den gerenderten Videos, nie aus den Stills):

```
Single continuous cinematic camera move, no cuts. The camera smoothly pulls up and back
out of [SZENE i], rising into the sky, then glides forward across the connected miniature
world and arrives above [SZENE i+1], beginning to descend toward it. One connected
miniature world, seamless flowing aerial transition. [STIL-Schluss + PALETTE]. Smooth
graceful slow motion. No text, no captions.
```

Für den letzten Connector vor einem Hero-Produkt-Finale: "…glides forward and the world
dissolves toward a single giant [PRODUKT] floating in soft [BG] space, arriving in front of it."

Befehl: `~/AI/ltx-2-mlx/.venv/bin/ltx-2-mlx keyframe --start letzter_i.png --end
erster_i+1.png --prompt "<Prompt>"` – direkt über die CLI, nicht über den `video`-Wrapper (der
kennt kein Zwei-Enden-Keyframing, siehe `reference/bau-ablauf.md`). Der `keyframe`-Subbefehl
ist laut `~/AI/ltx-2-mlx/docs/PIPELINE_MATURITY.md` ebenfalls als Stable eingestuft.

## Copy je Segment

Gilt für jedes Segment, unabhängig vom Weg:

- `eyebrow` – 2 bis 4 Wörter, ein Wertversprechen als Label.
- `title` – 3 bis 6 Wörter, die Überschrift der Station. Erstes Segment = Hero-Zeile der
  Seite; letztes = die Auflösung, trägt den Call-to-Action.
- `body` – ein Satz, aus der Sicht der besuchenden Person.
- `tags` – 0 bis 3 kurze Beleg-Chips (z. B. "Frisch zubereitet", "30-Minuten-Lieferung").
