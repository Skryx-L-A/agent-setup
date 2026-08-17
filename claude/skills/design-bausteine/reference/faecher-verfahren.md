# Baustein: Faecher-Verfahren

## Was das ist

Kein One-Shot-Design. Breit anfangen, dann verengen: **fuenf Gestaltungsrichtungen parallel
bauen, nebeneinander ansehen, auf drei Varianten der gewaehlten Richtung verengen, eine waehlen
und feinjustieren.** Aus `BEFUND.md` Abschnitt 2.3 und `quellen/video-7FU98O0JLHs.md:40-55`,
dort woertlich als Bauablauf-Schritte 1-3 beschrieben.

Begruendung aus derselben Quelle: der erste Entwurf ist bei jedem Modell statistisch der
generische Durchschnitt (Beleg im Video: identischer Prompt an 100 Personen ergab fast
identische Ergebnisse, `quellen/video-y2n1NMrMNBo.md`). Fuenf Richtungen gleichzeitig zu sehen
macht sichtbar, was der generische Durchschnitt verdeckt — und kostet dank Parallelisierung nicht
fuenfmal so viel Zeit.

## Die drei Stufen

1. **Fuenf Fassungen in fuenf Stilen** gleichzeitig erzeugen, nebeneinander ansehen. Stile vorher
   benennen (nicht "fuenf Varianten", sondern fuenf **verschiedene** Aesthetiken aus dem
   `vier-bausteine-prompt.md`-Baustein — sonst variiert nur Zufallsrauschen, keine echte
   Richtung).
2. Eine Richtung waehlen, davon **drei Varianten** — vor allem Struktur/Body-Layout variieren,
   nicht die schon entschiedene Aesthetik.
3. Eine Variante waehlen, dann **einzelne Elemente gezielt nachschaerfen** (Hero-Bild, Farbwert,
   Motion-Detail) statt die ganze Seite neu zu bauen. Ein gezielter Nachschlag hebt die
   wahrgenommene Qualitaet staerker als ein weiterer kompletter Durchlauf
   (`BEFUND.md` Abschnitt 2.3, Punkt 2). Fuer Web-Projekte ist genau das die Aufgabe der
   **Tweaks-Bar** (eigenes Repo `<your-github-user>/tweaks-bar`, Vite-Plugin: Overlay-Panel am laufenden
   Dev-Server, tauscht Design-Tokens ueber CSS Custom Properties live aus) — visuell vergleichen
   statt fuer jede Nuance neu zu prompten. Bei Dokumenten entfaellt das Overlay; dort ist der
   Nachschlag ein gezielter Wert in `tokens.typ` plus Neu-Rendern.

## Zwei Betriebsarten

### A) Mit Workern (parallel, unser Grid)

Fuenf Gestaltungsrichtungen sind fuenf **unabhaengige** Teilaufgaben — passt exakt zum
Worker-Grid. Ablauf:

1. Orchestrator formuliert den `vier-bausteine-prompt.md`-Baustein einmal fuer den Auftrag,
   variiert darin **nur die Aesthetik-Zeile** in fuenf benannten Richtungen (z.B. editorial,
   brutalist, atmospheric, modern-minimal, playful) — Referenz/Intent/Guardrails bleiben fuer
   alle fuenf gleich, sonst vergleicht man Aepfel mit Birnen.
2. Fuenf Worker passender Groesse spawnen (right-sizing nach Umfang der Teilaufgabe — bei einer
   Seitenskizze reicht die mechanische/kurz-spezifiziert-Stufe, nicht die teuerste), jeder mit
   genau einer Aesthetik-Variante des Bausteins, exklusiv eigenes Ausgabeverzeichnis
   (`variante-1/` bis `variante-5/`), damit sich niemand in dieselbe Datei schreibt.
3. Auf alle fuenf Ergebnisse warten (mit Deadline, nicht unbegrenzt).
4. Orchestrator stellt die fuenf Ergebnisse **nebeneinander** dar (Screenshots einer Seite an
   Seite, oder bei Dokumenten die gerenderten Seiten nebeneinander) — nie nur als Text
   beschrieben, das Faecher-Verfahren lebt vom visuellen Vergleich.
5. Auswahl (durch den Auftraggeber oder nach klaren Kriterien aus den Guardrails) grenzt auf eine
   Richtung ein. Fuer Stufe 2 (drei Varianten) denselben Ablauf wiederholen, diesmal mit drei
   Workern, die nur das Body-Layout variieren.
6. Stufe 3 (Feinschliff) laeuft nicht mehr parallel — ein Worker/eine Sitzung schaerft die
   gewaehlte Variante gezielt nach.

### B) Ohne Worker (einzelne Sitzung)

Dieselbe Struktur, aber sequenziell statt parallel:

1. Fuenf Aesthetik-Varianten des Vier-Bausteine-Prompts vorbereiten wie oben.
2. Fuer jede Variante eine eigenstaendige Fassung bauen (z.B. fuenf HTML-Dateien oder fuenf
   Branches/Ordner), **ohne zwischendurch zu vermischen** — sonst verwaesert die Richtung.
3. Alle fuenf am Ende gemeinsam ansehen (nebeneinander im Browser, oder als Screenshot-Grid),
   nicht einzeln nacheinander bewerten und vergessen.
4. Auswahl, dann Stufe 2 mit drei Layout-Varianten derselben Richtung, dann Stufe 3 Feinschliff.
   Aufwand ist hier hoeher als bei Parallelisierung — bei sehr kleinen Auftraegen (eine Sektion,
   kein ganzer Seitenaufbau) genuegt es, Stufe 1 auf drei statt fuenf Richtungen zu verkuerzen.

## Wann es greift

Bei neuen visuellen Bauprojekten mit echtem Gestaltungsspielraum (neue Website, neues
Dokumenten-Layout, neue Praesentation). Nicht bei kleinen Iterationen an einem bereits
festgelegten Design — dort reicht der gezielte Nachschlag aus Stufe 3 direkt.

## Dokument-Zweig

Das durchgerechnete Beispiel unten ist Web (Stufe 1 sind Aesthetik-Varianten einer Website-
Sektion). Fuer Berichte, Angebote, CVs, Decks laeuft dasselbe 5→3→1-Verfahren, aber jede Fassung
ist eine eigene `tokens.typ`-Entscheidung im Skill `document-design`
(Skill `document-design`) statt einer HTML-Fassung: fuenf Layout-/Typografie-
Richtungen als fuenf Token-Saetze rendern (Regel 1 dort: "this document gets its own layout" —
passt exakt zum Faecher-Prinzip, keine der fuenf ist ein wiederverwendetes Template), als
Seiten-PNGs nebeneinanderlegen, verengen, dann in `document-design` Schritt 6 (Fix once, confirm
once, stop) feinjustieren.

## Durchgerechnetes Beispiel

Auftrag: Landingpage-Hero fuer die Kaffee-Roasterei aus `vier-bausteine-prompt.md`.

**Stufe 1 — fuenf Aesthetiken, Referenz/Intent/Guardrails aus dem Baustein-Beispiel bleiben
gleich:**
1. atmospheric-editorial (wie im Baustein-Beispiel: warme Erdtoene, Serifen-Headline)
2. brutalist-warm (grobe Raster, kraeftige Blocktypografie, keine Verlaeufe, roh statt poliert)
3. modern-minimal (viel Weiss, duennes Groteskschrift-System, ein Akzentton)
4. playful-handdrawn (organische Formen, handschriftliche Akzent-Headline, warme Illustration)
5. dark-atmospheric (dunkler Hintergrund, warmes Spot-Licht auf dem Produktfoto, Kontrastfokus)

Mit Workern: fuenf Worker passender Groesse, je einer Aesthetik, gleiche Referenz/Intent/
Guardrails, fuenf getrennte Ausgabeordner. Ergebnis nebeneinander angesehen: brutalist-warm
und modern-minimal fallen fuer eine Nachbarschafts-Roesterei durch (zu kalt/zu hart fuer
"handwerklich, warm"), playful-handdrawn wirkt zu unernst fuer den Intent "Vertrauen aufbauen,
Laufkundschaft anziehen". atmospheric-editorial und dark-atmospheric bleiben.

**Stufe 2 — drei Body-Layout-Varianten von atmospheric-editorial** (gewaehlt, weil es das
Guardrail "kein 3D-SaaS-Blob" am klarsten erfuellt und zum Tageslicht-Ladengeschaeft passt):
1. alternierende Bild-Text-Zeilen (Foto links/rechts im Wechsel)
2. Bento-Grid fuer Produktkategorien (Espresso, Filter, Bohnen-Abo)
3. lange vertikale Scroll-Erzaehlung mit vollflaechigen Fotos zwischen Textbloecken

Auswahl: alternierende Bild-Text-Zeilen — passt am besten zum Intent "in den Laden kommen", weil
sie Produkt und Ort abwechselnd zeigt statt nur Kategorien aufzulisten.

**Stufe 3 — Feinschliff:** Hero-Foto in vier Lichtvarianten generieren (dawn touch, golden hour,
alpenglow, duotone — Beispiel direkt aus der Quelle), eine waehlen, danach den Motion-Rhythmus
zwischen den Zeilen justieren.

Ergebnis nach drei Stufen: eine Richtung, die tatsaechlich gegen vier andere geprueft wurde,
statt die erste generische Antwort des Modells ungeprueft zu uebernehmen.

## Quellen

Belege liegen im Recherche-Projekt `~/AI/design-research/` (Original in
`design-research/bausteine/faecher-verfahren.md`):

- `BEFUND.md` Abschnitte 2.3, 4 (Massnahme 6)
- `quellen/video-7FU98O0JLHs.md` Zeilen 40-55 (Bauablauf woertlich, inkl. Lichtvarianten-Beispiel)
- `quellen/video-y2n1NMrMNBo.md` (Varianten-Vergleich vor Festlegung, Sicherungs-Prompt)
- `quellen/vid2-ergebnis.md` Zeile 138 (5→3→1-Kurzformel)
