// layout.typ — the MECHANICS of a multi-page document: baseline grid, running heads,
// folios, margin column, tables, figures. This file is meant to be read and changed.
// It is not a style: every visible value comes from `tokens.typ`.
//
// What is worth keeping across documents is in here (how a baseline grid is built in
// Typst, how a margin note is placed, how a table is stripped of its cage).
// What must be re-decided each time is in tokens.typ.

#import "tokens.typ" as t

// --- The gate ---------------------------------------------------------------
// A build with undecided tokens is a template that fills itself in — exactly what
// the house rule forbids. So it does not build.
#let _gate() = assert(
  t.design-decided,
  message: "Layout for this document has not been decided yet.\n"
    + "Open tokens.typ, replace every value with your own decision for THIS document,\n"
    + "write the reason on each `why:` line, then set design-decided = true.\n"
    + "Do not simply flip the flag: the shipped numbers are an example, not a house style.",
)

// The grid has two granularities: the text line (baseline to baseline) and a finer unit
// that vertical distances are built from. Headings need a line height that is NOT the
// body's, but every distance must still land on the same grid — so the unit divides both.
#let lines(n) = n * t.line-height
#let u(n) = n * t.unit

// --- Baseline grid ----------------------------------------------------------
// Typst's line height is ascender + descender of the font, which differs per family
// and breaks any grid. Pinning top-edge/bottom-edge to fixed em values makes the line
// box exactly 1em tall, so baseline distance = size + leading, and that is gridable.
#let metrics(size: t.body-size) = (
  size: size,
  top-edge: 0.75em,
  bottom-edge: -0.25em,
)

#let _leading-for(size) = t.line-height - size

// Debug overlay: a hairline on every baseline. Render, look, and confirm that the text
// actually sits on the grid instead of near it.
#let _baseline-overlay = if t.show-baseline-grid {
  for i in range(0, 46) {
    place(
      top + left,
      dy: t.line-height * i,
      line(length: t.text-width, stroke: 0.2pt + rgb("#d02020")),
    )
  }
} else { none }

// --- Margin column ----------------------------------------------------------
// A note, a caption or a source sits beside the text, not inside it. The zero-width box
// is the anchor: it sits inline where the note was called, so the note starts on the same
// line. A bare place() without it pins every note to the top of the page.
// CALL IT AT THE START OF THE PARAGRAPH IT BELONGS TO. That is a real constraint, not
// a style preference: `place` measures dx from the inline position of its anchor, and in
// JUSTIFIED text the position Typst reports mid-paragraph is not the position the glyph
// ends up at — a note called mid-sentence lands on top of the body text. Called first in
// the paragraph, the anchor sits exactly at the left edge of the column, so dx is a
// constant and the note aligns with the paragraph's first line. Measured, not assumed:
// both variants were rendered and looked at.
#let sidenote(body) = box(
  width: 0pt,
  place(
    top + left,
    dx: t.text-width + t.note-gutter,
    dy: 0pt,
    box(
      width: t.note-width,
      text(
        ..metrics(size: t.size.small),
        fill: t.ink.soft,
        font: t.font-display,
        par(leading: u(2) - t.size.small, justify: false, body),
      ),
    ),
  ),
)

// --- Tables -----------------------------------------------------------------
// A data table needs no cage. Rules run horizontally, in two weights: one under the
// head, one under the last row. Columns are separated by space, numbers by alignment.
#let dtable(columns: auto, align: auto, head: (), ..rows) = {
  set text(
    ..metrics(size: t.size.small),
    font: t.font-display,
    number-type: "lining",
    number-width: "tabular",
  )
  set par(leading: _leading-for(t.size.small), justify: false)
  // A table that breaks across pages loses its head or its bottom rule. Small tables
  // stay whole; a table long enough to need a break needs a repeated head instead.
  block(above: u(4), below: u(4), breakable: false)[
    #table(
      columns: columns,
      align: align,
      inset: (x: 0pt, y: 4pt),
      column-gutter: 6mm,
      stroke: none,
      table.hline(stroke: t.rule-weight + t.ink.text),
      table.header(..head.map(h => text(weight: 600, h))),
      table.hline(stroke: 0.3pt + t.ink.rule),
      ..rows.pos(),
      table.hline(stroke: t.rule-weight + t.ink.text),
    )
  ]
}

// --- Figures ----------------------------------------------------------------
// The caption belongs to the figure, is set in the other voice, and says what to see —
// it does not repeat the heading. Images may run into the margin column; that is what
// the wide outer margin is for.
#let dfigure(image-content, caption: none, wide: false, source: none) = {
  block(above: lines(2), below: lines(2), breakable: false)[
    #box(width: if wide { t.text-width + t.note-gutter + t.note-width } else { 100% }, image-content)
    #if caption != none {
      v(u(2))
      // The caption keeps the text measure even under a wide figure. A caption set
      // across 160 mm is 110 characters long and unreadable, however small it is.
      block(width: t.text-width)[
        #set text(..metrics(size: t.size.small), font: t.font-display, fill: t.ink.text)
        #set par(leading: _leading-for(t.size.small) - 3pt, justify: false)
        #caption
        #if source != none [ #text(fill: t.ink.soft)[ #source] ]
      ]
    }
  ]
}

// --- Title page -------------------------------------------------------------
// A title page carries the four facts a reader files the document by: what it is,
// what it is about, who is responsible, when it was written. Not three times the title.
#let titlepage(title: "", subtitle: none, meta: ()) = page(header: none, footer: none)[
  #v(lines(6))
  #line(length: t.text-width, stroke: 3pt + t.ink.accent)
  #v(lines(2))
  // A title is never hyphenated. It is the one line the reader photographs mentally.
  #text(
    ..metrics(size: t.size.title),
    font: t.font-display,
    weight: 600,
    hyphenate: false,
    par(leading: u(8) - t.size.title, justify: false, title),
  )
  #if subtitle != none {
    v(lines(1))
    text(
      ..metrics(size: t.size.h2),
      font: t.font-text,
      style: "italic",
      fill: t.ink.soft,
      hyphenate: false,
      // The subtitle is one or two lines, not a text block: justifying it opens word
      // gaps you can see from across the room. Seen in the render, not in the source.
      par(justify: false, subtitle),
    )
  }
  // The filing facts sit at the foot of the page, not floating in the middle of it.
  #v(1fr)
  #set text(..metrics(size: t.size.small), font: t.font-display)
  #set par(leading: _leading-for(t.size.small))
  #grid(
    columns: (32mm, auto),
    row-gutter: u(3),
    ..meta
      .map(((k, val)) => (text(fill: t.ink.soft)[#upper(k)], text(fill: t.ink.text)[#val]))
      .flatten()
  )
]

// --- The document -----------------------------------------------------------
#let report(
  title: "",
  subtitle: none,
  meta: (),
  running-head: none,
  body,
) = {
  _gate()

  set document(title: title)
  set page(
    paper: t.paper,
    margin: t.margin,
    header-ascent: lines(2),
    footer-descent: lines(2),
    header: context {
      if counter(page).get().first() > 1 {
        set text(..metrics(size: t.size.small), font: t.font-display, fill: t.ink.soft)
        box(width: t.text-width)[
          #if running-head != none { running-head } else { title }
          #h(1fr)
        ]
      }
    },
    footer: context {
      set text(..metrics(size: t.size.small), font: t.font-display, fill: t.ink.soft)
      box(width: t.text-width)[#h(1fr) #counter(page).display("1")]
    },
  )

  set text(
    ..metrics(),
    font: t.font-text,
    fill: t.ink.text,
    lang: t.lang,
    hyphenate: true,
    number-type: "old-style",
  )
  set heading(numbering: t.heading-numbering)
  set par(
    leading: _leading-for(t.body-size),
    spacing: lines(1),
    justify: t.justify,
    first-line-indent: t.first-line-indent,
  )

  // Headings: level is carried by weight, case, colour and space — not by size alone.
  // Heading leading is 4 units where the body is 3, so a two-line heading still lands
  // the following text on the grid. Headings are never hyphenated and never justified.
  show heading: set text(hyphenate: false)
  show heading.where(level: 1): it => block(above: u(9), below: u(3))[
    #set text(..metrics(size: t.size.h1), font: t.font-display, weight: 600)
    #set par(leading: u(4) - t.size.h1, justify: false)
    #if it.numbering != none [
      #text(fill: t.ink.accent)[#counter(heading).display()]
      #h(4mm)
    ]
    #it.body
  ]
  show heading.where(level: 2): it => block(above: u(6), below: u(3))[
    #set text(..metrics(size: t.size.h2), font: t.font-display, weight: 600)
    #set par(leading: u(4) - t.size.h2, justify: false)
    #it.body
  ]
  show heading.where(level: 3): it => block(above: u(3), below: u(0))[
    #set text(..metrics(size: t.size.h3), font: t.font-display, weight: 600, tracking: 0.04em)
    #upper(it.body)
  ]

  show raw: set text(font: t.font-mono, size: 9pt)
  show link: set text(fill: t.ink.accent)
  set list(marker: [–], indent: 0pt, body-indent: 5mm, spacing: lines(1))
  set enum(indent: 0pt, body-indent: 5mm, spacing: lines(1))

  // No heading in the last lines of a page, no single line of a paragraph left behind.
  show heading: set block(sticky: true)
  set par(linebreaks: "optimized")

  titlepage(title: title, subtitle: subtitle, meta: meta)

  _baseline-overlay
  body
}
