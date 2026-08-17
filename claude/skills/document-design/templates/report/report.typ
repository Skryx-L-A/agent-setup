// report.typ — CONTENT ONLY. No sizes, no colours, no spacing here.
// Everything visual lives in tokens.typ (decisions) and layout.typ (mechanics).
// If you find yourself writing a `#text(size: …)` in this file, the decision belongs
// in tokens.typ instead.

#import "layout.typ": report, dtable, dfigure, sidenote

#show: report.with(
  title: "Titel des Dokuments",
  subtitle: "Untertitel, der sagt, worum es geht",
  running-head: "Kurzform für die Kopfzeile",
  meta: (
    ("Verfasst von", "…"),
    ("Für", "…"),
    ("Datum", "…"),
    ("Fassung", "…"),
  ),
)

= Erste Überschrift

#sidenote[Eine Randnotiz steht neben dem Absatz, zu dem sie gehört. Sie wird IMMER am
Anfang des Absatzes aufgerufen — die Begründung steht in layout.typ.]Fließtext. Ein
Absatz sagt einen Gedanken.

== Zwischenüberschrift

#dtable(
  columns: (1fr, auto, auto),
  align: (left, right, right),
  head: ([Sache], [Zahl], [Anteil]),
  [Erste Zeile], [1 240], [62 %],
  [Zweite Zeile], [760], [38 %],
)

// The build fails until this image exists. That is deliberate: generate a real one
// locally (`bild "..." -o bilder/beispiel.png --kein-open`) or delete the figure.
// A placeholder image in a document is a decision postponed, not a decision made.
#dfigure(
  image("bilder/beispiel.png", width: 100%),
  caption: [Was auf dem Bild zu sehen ist und warum es hier steht.],
  source: [Quelle: …],
)

=== Kleinste Ebene

Text.
