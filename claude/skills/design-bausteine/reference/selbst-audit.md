# Baustein: Selbst-Audit-Abschluss (gedeckelt)

## Abgrenzung zu `design-critique`

Dieser Baustein ist der **leichte** Abschluss: ein Modell-Selbstgespraech, keine erzwungene
zweite Perspektive, kein deterministischer Detektor. Fuer Arbeit, die nach aussen geht
(Kundendeliverable, oeffentliche Seite), gibt es die schwerere Variante im Skill
`design-critique`: zwei erzwungene, isolierte Bewertungspaesse
plus der mechanische Anti-Slop-Detektor `slop-detect` (23 Regeln, ohne Modell, ohne Netz). Die vier
Modi Persuade/Operate/Read/Experience, die dort die Bewertung einfaerben, werden HIER nicht
dupliziert — sie stehen in
`design-critique`s `reference/modes.md`,
die Qualitaetsuntergrenze daneben in `reference/craft-floor.md`.

Faustregel: internes Zwischenergebnis oder eigener Bau-Auftrag → dieser Baustein reicht.
Kundenfront, Launch, oeffentliche Praesentation → zusaetzlich `design-critique` laufen lassen.

## Was das ist

Letzter Schritt jedes Design-Auftrags: der Agent bewertet das eigene Ergebnis nach benannten
Kategorien mit einer Zahl 0-100, liefert eine konkrete Fixliste, bessert nach, und **hoert dann
auf**. Aus `BEFUND.md` Abschnitt 2.3 und 4, Massnahme 3: macht "fertig" pruefbar statt gefuehlt.

Zwei Quellen bestaetigen unabhaengig dasselbe Muster:
- `quellen/video-bkTY9gYkWis.md:37-40` — 8-Schritte-Website-Prozess, Selbst-Audit als letzter
  Schritt vor Launch. Im Video real durchgespielt: Score 67/100 beim ersten Durchlauf, danach
  Fixes, dann erneuter Audit. Faustregel der Autorin: unter 50 schlecht, ab 80 "amazing".
- `quellen/vid2-ergebnis.md:61-67` — woertliches Zitat: *"make claude code audit whatever it has
  done... judge itself... give itself a score and also suggest anything that needs to be
  improved."*

Kategorien in beiden Quellen praktisch deckungsgleich: **Hierarchie, Performance,
Zugaenglichkeit (Trust/Sicherheit), Motion, Gestaltung.** Fuer Websites zusaetzlich
Vertrauenswuerdigkeit (Trust) als eigene Achse — bei Dokumenten stattdessen Lesbarkeit/Struktur
verwenden (siehe Variante unten).

## Die entscheidende Ergaenzung: der Deckel

Ein Selbst-Audit ohne Grenze wird zur Endlosschleife — das Modell findet immer noch etwas.
impeccables eigener Skill formuliert die Grenze explizit (`BEFUND.md` Abschnitt 2.3, woertlich
aus `SKILL.src.md`):

> *"Build fully, inspect once with a batched round (desktop and mobile together), fix everything
> it shows in one batch, confirm with at most one more round, and stop polishing. Open-ended
> self-QA burns the user's money."*

Das heisst konkret: **maximal zwei Audit-Runden**, nicht "so lange bis 100/100". Diese Grenze ist
Teil des Bausteins, nicht optional — ohne sie frisst der letzte Schritt jedes Budget.

## Wann es greift

Am Ende jedes Design-Auftrags mit sichtbarem Ergebnis (Website-Sektion, ganze Seite, Dokument,
Praesentation), bevor an den Auftraggeber gemeldet oder ausgeliefert wird. Nicht bei
Zwischenschritten — der Deckel gilt gerade deshalb, weil dieser Schritt nur einmal (max. zweimal)
laeuft.

## Einsetzbarer Text

**Runde 1 (Pflicht):**
```
Bewerte das gebaute Ergebnis in den Kategorien Hierarchie, Performance, Zugaenglichkeit,
Vertrauenswuerdigkeit, Motion, Gestaltung — je 0-100. Nenne fuer jede Kategorie unter 80 genau,
was fehlt (kein "koennte besser sein", sondern die konkrete Stelle und der konkrete Fix).
Liefere eine Fixliste, sortiert nach Wirkung.
```

**Wenn unter ~80 gesamt: genau EIN Fix-Batch, dann Runde 2 (optional, max. eine weitere):**
```
Behebe alle Punkte aus der Fixliste in einem Durchgang, nicht einzeln nacheinander. Danach
hoechstens noch einmal auditieren, um die Fixes zu bestaetigen. Kein drittes Audit — bei Bedarf
das Ergebnis mit offenen Punkten melden statt weiter zu polieren.
```

Fuer Dokumente/Praesentationen (statt Motion + Trust): Kategorien anpassen auf **Hierarchie,
Lesbarkeit/Typografie, Struktur (Ueberlaeufe, Waisen, Rand), Konsistenz, Gestaltung** — deckt sich
mit den Pruefpunkten aus `BEFUND.md` Abschnitt 3.2 (Raender ≥ 18 mm, keine Ueberlaeufe, keine
verwaiste Ueberschrift, konsistente Schriftgrade, 4,5:1 Kontrast).

## Durchgerechnetes Beispiel

Kaffee-Roasterei-Sektion aus `vier-bausteine-prompt.md` fertig gebaut. Audit-Runde 1:

```
Hierarchie: 72 — Headline und Sub-Headline haben fast dieselbe Schriftgroesse, Blick findet
  keinen klaren Einstiegspunkt. Fix: Headline auf min. 1.6x Sub-Headline-Groesse.
Performance: 85 — Hero-Bild ist unkomprimiert (2.4 MB). Fix: als WebP re-exportieren, Ziel <300 KB.
Zugaenglichkeit: 68 — Kontrast Fliesstext/Hintergrund liegt bei 3.8:1, unter dem 4.5:1-Guardrail.
  Fix: Textfarbe auf #2B1810 abdunkeln.
Vertrauenswuerdigkeit: 90 — echte Oeffnungszeiten und Adresse vorhanden, kein Slop-Trust-Badge.
Motion: 78 — Fade-in beim Scroll vorhanden, aber Timing identisch fuer alle Elemente, wirkt
  mechanisch. Fix: 80-120ms Versatz zwischen Elementen.
Gestaltung: 75 — Icon-Tile ueber der dritten Feature-Card ist rund mit Farbverlauf, exakt das
  Guardrail-Verbot aus dem Vier-Bausteine-Prompt. Fix: entfernen oder durch Liniensymbol ersetzen.

Gesamt: 78/100 — unter der 80er-Schwelle, ein Fix-Batch noetig.
```

Fixes werden in einem Durchgang behoben (Headline-Groesse, Bildkompression, Kontrast, Motion-
Versatz, Icon-Tile entfernt). Danach **eine** Bestaetigungsrunde:

```
Gesamt: 88/100 — ueber der Schwelle. Kein drittes Audit, Ergebnis wird gemeldet.
```

Ohne Deckel wuerde ein drittes und viertes Audit weitere Kleinigkeiten finden (leicht andere
Zeilenhoehe, ein zusaetzliches Hover-Detail) — Kosten ohne wahrnehmbaren Gewinn. Der Deckel ist
der Unterschied zwischen einem nuetzlichen Schlussschritt und einem Geldverbrenner.

## Quellen

Belege liegen im Recherche-Projekt `~/AI/design-research/` (Original in
`design-research/bausteine/selbst-audit.md`):

- `BEFUND.md` Abschnitte 2.3, 4 (Massnahme 3)
- `quellen/video-bkTY9gYkWis.md` Zeilen 37-40 (Score 67/100, Schwelle-Faustregel)
- `quellen/vid2-ergebnis.md` Zeilen 61-67, 92-95 (woertliches Zitat, Kategorien)
- impeccable `SKILL.src.md` Zitat, zitiert in `BEFUND.md` Abschnitt 2.3 (Deckel-Regel)
