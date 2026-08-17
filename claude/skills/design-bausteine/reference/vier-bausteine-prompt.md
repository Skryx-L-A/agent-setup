# Baustein: Vier-Bausteine-Prompt

## Was das ist

Ein Bau-Prompt fuer visuelles Design (Website, Seite, Dokument, Praesentation) besteht aus vier
Teilen, nicht aus einem Satz. Zwei unabhaengige Recherche-Kanaele in `BEFUND.md` (Abschnitt 2.3)
formulieren dasselbe Muster mit anderen Worten:

- Chase AI (`quellen/video-7FU98O0JLHs.md:57-64`): **Aesthetik · Referenz · Intent · Guardrails**
- Mikey Website (`quellen/video-y2n1NMrMNBo.md`): **Ziel · Layout · Content · Zielgruppe**

Beide sagen: ein Einzeiler ("baue eine Landingpage fuer X") laesst das Modell raten, und es raet
generisch. Die vier Teile zwingen zur Entscheidung, bevor der erste Pixel entsteht.

## Die vier Teile

1. **Aesthetik** — welche Gestaltungsfamilie. Nicht "modern und clean" (das ist keine Aussage,
   das ist die Abwesenheit einer Aussage) — ein benannter Stil oder eine Kombination:
   editorial, brutalist, atmospheric, modern-minimal, playful, dark-mode-technisch, etc.
2. **Referenz** — ein Screenshot oder eine echte URL. Wichtig, woertlich aus der Quelle:
   *Ziel ist das GEFUEHL, nicht das Kopieren von Inhalt oder Layout.* Referenzen gelten auch
   fuer den Body, nicht nur fuer den Hero — bei laengeren Seiten eigene Referenz je Abschnitt.
   Woher die Referenz kommt, ist nicht Teil dieses Bausteins: fuer Web-Inspiration den Skill
   `framer-inspiration` (liefert kuratierte Beispiel-URLs) oder `design-harvest` (erntet
   Tokens/Makrostrukturen von konkret genannten Seiten) laufen lassen — beide enden mit einem
   fertigen Referenz-Absatz fuer genau dieses Feld, nicht neu erfinden.
3. **Intent** — was wird gebaut, fuer wen, welche Handlung soll am Ende folgen (Demo buchen,
   Formular ausfuellen, lesen, kaufen). Bestimmt Struktur und Ton des Rests der Seite.
4. **Guardrails** — immer/nie-Listen. Woertlich aus der Quelle als Beispiel: *nie lila
   Farbverlaeufe, nie Inter als Standardgriff, keine 3D-SaaS-Blobs.* Guardrails sind projekt-
   oder auftragsspezifisch zu befuellen, nicht diese drei Beispiele blind zu kopieren — sie
   zeigen nur, wie konkret eine Guardrail sein muss, um zu wirken.

## Wann es greift

Bei jedem Bau- oder Redesign-Auftrag mit sichtbarem Ergebnis: Website, Landingpage, Dokument,
Praesentation, Deck, Poster. Nicht noetig fuer reine Funktionsaenderungen ohne visuelle
Entscheidung (Bugfix, Backend-Logik).

Reihenfolge-Hinweis aus derselben Quelle (`video-y2n1NMrMNBo.md`): erst grosse Struktur-
Entscheidungen treffen (Layout, Farbstimmung), danach erst einzelne Elemente feinjustieren —
sonst muss jeder kleine Fix nach jeder grossen Layout-Aenderung wiederholt werden.

## Einsetzbarer Text

Als Vorlage in einen Bau-Auftrag einsetzen (Platzhalter ausfuellen, keinen leer lassen):

```
Aesthetik: <benannte Design-Familie, z.B. "editorial, viel Weissraum, serifenbetonte
  Headlines, gedeckte Farben">
Referenz: <1-3 URLs oder Screenshot-Pfade> — GEFUEHL uebernehmen, nicht Inhalt oder Layout
  kopieren.
Intent: <was entsteht, fuer wen, welche Handlung am Ende folgen soll>
Guardrails:
  immer: <z.B. "Kontrast mind. 4,5:1", "Systemschriften oder self-hosted Variable Fonts">
  nie: <z.B. "keine lila-blauen Farbverlaeufe", "kein Inter als Standardgriff",
    "keine 3D-SaaS-Blobs", "keine erfundenen Kennzahlen wie '+47% Conversion'">
```

## Durchgerechnetes Beispiel

Aufgabe: "Baue eine Landingpage-Sektion fuer ein lokales Kaffee-Roasting-Studio."

**Einzeiler (Kontrolle, wie es ohne Baustein aussieht):**
> "Baue eine Landingpage fuer eine Kaffeeroesterei."

Ergebnis vorhersehbar: generischer Hero mit Stockfoto-Kaffeetasse, Inter-Schrift, blau-lila
Verlauf im CTA-Button, drei Feature-Cards mit rundem Icon-Tile ueber der Ueberschrift — alles
Muster, die impeccables Anti-Slop-Detektor als `slop` markiert (`BEFUND.md` 2.2).

**Mit Vier-Bausteine-Prompt:**
```
Aesthetik: atmospheric-editorial. Warme, gedaempfte Erdtoene (Rostbraun, Creme, tiefes
  Kaffeebraun), grosszuegiger Weissraum, eine kraeftige Serifen-Headline als Blickfang,
  Fliesstext in einer ruhigen Grotesk.

Referenz: https://example-roastery-1.framer.website (Foto-Fuehrung im Hero, Golden-Hour-Licht),
  https://example-roastery-2.framer.website (Body-Layout: alternierende Bild-Text-Zeilen).
  GEFUEHL uebernehmen — warm, handwerklich, langsam — nicht deren Text oder Sektionsreihenfolge
  kopieren.

Intent: Landingpage-Hero + erste Sektion fuer ein lokales Kaffee-Roasting-Studio. Zielgruppe:
  Menschen in der Nachbarschaft, die "besseren Kaffee als die Kette" suchen. Gewuenschte
  Handlung: in den Laden kommen und Bohnen kaufen — kein Online-Shop, kein Newsletter-CTA.

Guardrails:
  immer: ein starkes, warm beleuchtetes Foto im Hero statt reinem Text; Kontrast mind. 4,5:1
    zwischen Text und Hintergrund; self-hosted Variable Font statt CDN-Fallback.
  nie: keine lila-blauen Farbverlaeufe; nie Inter als Standardgriff (stattdessen z.B. eine
    warme Serif + eine ruhige Grotesk); keine rundstrahligen Icon-Tiles ueber Ueberschriften;
    keine erfundenen Kennzahlen ("500+ zufriedene Kunden").
```

Sichtbarer Unterschied: der Einzeiler laesst jede der vier Entscheidungen beim Modell — es
faellt auf die statistisch haeufigste (generische) Antwort zurueck. Der ausgefuellte Baustein
trifft alle vier Entscheidungen vorab; das Modell fuellt nur noch aus, was innerhalb der
Leitplanken frei bleibt (Bildkomposition, exakte Wortwahl, Feinabstimmung). Das ist der Punkt:
nicht mehr Text, sondern Text, der tatsaechlich Entscheidungen traegt.

## Quellen

Belege liegen im Recherche-Projekt `~/AI/design-research/`, das diesen Baustein hervorgebracht
hat (Original in `design-research/bausteine/vier-bausteine-prompt.md`):

- `BEFUND.md` Abschnitt 2.3
- `quellen/video-7FU98O0JLHs.md` Zeilen 57-67 (Aesthetik/Referenz/Intent/Guardrails, woertlich)
- `quellen/video-y2n1NMrMNBo.md` (Ziel/Layout/Content/Zielgruppe, Reihenfolge-Regel)
