# Craft floor

Eine Seite Pflichtstandard fuer jede UI-Arbeit, bevor sie als fertig gilt. Destilliert aus
impeccables `craft-floor.md` (39 Zeilen) im A/B-Test — geprueft gegen das, was `project-kit:website`
und `frontend-design` bei uns schon verlangen (BITV/WCAG-AA, Responsive-Pflicht), und um das gekuerzt,
was dort bereits steht. Eigene Formulierung, kein Zitat.

## Gilt immer

- **Kontrast:** Fliesstext und Platzhaltertext ≥4.5:1, grosser Text ≥3:1 — mit `slop-detect`
  nachrechnen (`low-contrast`-Regel), nicht schaetzen. Sekundaertext auf farbigem Grund aus
  demselben Farbton abtoenen, nie neutrales Grau (`gray-on-color`-Regel).
- **Tiefe:** Schatten bekommen einen Versatz UND eine weiche Unschaerfe. Ein Schatten ohne Versatz
  ist Dekoration, kein Tiefensignal (`dark-glow-halo`-Regel).
- **Abstand:** enge Gruppen, grosszuegige Trennung dazwischen; mehr Raum ueber einer Ueberschrift
  als darunter. An den berechneten Werten pruefen, nicht am Gefuehl.
  Fliesstext bekommt eine Zeilenlaengen-Begrenzung (65-75 Zeichen, `line-length`-Regel).
- **Typografie:** eine erkennbare Skala mit klaren Gewicht-/Groessen-Stufen. Tracking-Boden
  -0,04em (`extreme-tracking`-Regel), keine Lauftext unter ~11px (`tiny-text`-Regel), kein
  Versalsatz fuer Fliesstext (`all-caps-body`-Regel). Echten Text bei jeder Breite testen, nicht
  Platzhaltertext.
- **Bewegung:** ein bewusst gesetzter Moment, nicht dieselbe Eintritts-Animation auf jeder Sektion.
  Exponentielles Ease-out ab einem bereits sichtbaren Zustand. `prefers-reduced-motion` respektieren
  — aber nicht als globaler `0.01ms`-Kill, der auch echtes Zustands-Feedback stumm schaltet.
- **Zustaende:** hover, disabled, loading, error, empty. Plus: echter Inhalt, funktionierende
  Bedienelemente, Tastaturfokus sichtbar (nicht nur vorhanden).
- **Text:** die Sprache des Produkts, nicht Marketing-Vokabular (`marketing-buzzword`-Regel).
  Bedienelemente benennen ihre Handlung; Fehlermeldungen benennen das Problem UND den Ausweg.
- **Vollstaendigkeit:** jede Anforderung des Auftrags ist vorhanden und in Sekunden auffindbar.

## Geht nie, ausser der Auftrag verlangt es woertlich

**Seitengeruest:**
- Gleich grosse Karten aus Icon+Ueberschrift+Text als Seitenstruktur; verschachtelte Karten sind
  immer falsch (`nested-cards`-Regel).
- Grosse Zahl + kleines Label + Stuetzstatistik + Farbverlauf als Hero-Schema.
- Ein getrackter Grossbuchstaben-Kicker ueber JEDER Sektion — ein benannter Kicker ist ein System,
  ueberall einer ist ungewaehlte Grammatik (`eyebrow-overuse`-Regel).
- 01/02/03-Nummerierung, wenn die Reihenfolge selbst keine Information traegt
  (`numbered-section-labels`-Regel).
- Ein Modal fuer eine Aufgabe, die weder Unterbrechung noch geschuetzten Fokus braucht.

**Oberflaechen-Angewohnheiten:**
- Farbverlauf-Text — Betonung kommt aus Gewicht oder Groesse, nicht aus einem Gradient
  (`gradient-text`-Regel).
- Glas/Blur als Dekoration statt als benannter Effekt.
- Ein farbiger `border-left`/`border-right` ueber 1px auf Karten, Listenpunkten oder Hinweisen —
  das erkennbarste KI-Merkmal ueberhaupt (`side-tab`-Regel).
- Icon-Kachel mit abgerundetem Farbhintergrund direkt vor jeder Sektionsueberschrift
  (`icon-tile-stack`-Regel).
- Warme Creme-Flaeche (~#F4F1EA) als Standard-Seitenhintergrund ohne Grund im Auftrag
  (`cliche-cream-palette`-Regel).
- "Inter" als einzige Schrift fuer Display UND Fliesstext (`overused-font`-Regel).
- Monospace als Kostuem fuer "technisch", ohne dass Code, Daten oder Messwerte davon profitieren.
- Hell oder dunkel nach Kategorie waehlen statt nach der physischen Nutzungssituation (wer, wo,
  unter welchem Licht).
- Pulsierender Status-Punkt, Blink-Cursor, Marquee-Lauftext, Bounce-Easing ohne ein reales
  Live-/Eingabe-/Lauftext-Konzept dahinter (`pulsing-dot`/`blinking-cursor`/`marquee`/
  `bounce-easing`-Regeln).
- Gedankenstrich-Haeufung als Satzbau-Tick (`em-dash-overuse`-Regel).

Der Boden regelt Mechanik, nie Richtung. Wenn alle Haken gruen sind, gehoert die restliche Seite
der gewaehlten Welt — und im Zweifel zwischen brav und committed: committed gewinnt.
