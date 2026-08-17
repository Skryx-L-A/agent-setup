// tokens.typ — the design decisions for THIS document. Nothing else belongs here.
//
// House rule: a document gets its own layout every time. Content may be carried over
// from an earlier version or from a sample; the layout is decided anew. This file is
// where that decision happens, and `layout.typ` refuses to build until it has.
//
// How to use it: work top to bottom, replace every value, and write the reason on the
// `// why:` line. If you cannot write the reason, you have not decided anything —
// you have kept someone else's default. When every value is yours, set
// `design-decided: true` at the bottom.
//
// The numbers below are a WORKING EXAMPLE of a well-formed set, not a recommendation.
// A second document that ships with these values is a copy, and reads like one.

// --- 1. Page ---------------------------------------------------------------
// Decide from the delivery path: bound and read at a desk, or single sheets in a
// mail attachment, or printed double-sided? The binding edge needs the wider inner
// margin; the bottom margin is larger than the top or the block sinks optically.
#let paper = "a4" //                                why: <…>
#let margin = (
  left: 24mm, //                                    why: <…>
  right: 74mm, //                                   why: <…>  (wide outer column: notes, captions)
  top: 75pt, //                                     why: <…>  = 5 × line-height
  bottom: 91.89pt, //                               why: <…>  leaves exactly 45 lines of text
)

// --- 2. Vertical grid ------------------------------------------------------
// One unit governs every vertical distance in the document: leading, space around
// headings, figure heights, table rows. Everything is a whole multiple of it.
// `line-height` is the baseline-to-baseline distance; `body-size / line-height`
// between 1.35 and 1.45 is the print range for a text serif (tighter than on screen).
#let unit = 5pt //                                  why: <…>  the fine grid; every vertical distance is a multiple of it
#let line-height = 15pt //                          why: <…>  3 units
#let body-size = 10.5pt //                          why: <…>

// --- 3. Measure ------------------------------------------------------------
// Characters per line, counted in the render, not estimated: 60–72 for a text you
// read minute after minute. `left + text-width + right = page width`.
#let text-width = 112mm //                          why: <…>  ≈ 66 characters at 10.5pt
#let note-gutter = 8mm //                           why: <…>
#let note-width = 42mm //                           why: <…>

// --- 4. Fonts --------------------------------------------------------------
// Self-hosted, libre-licensed, license file in the project, `--font-path ./fonts`.
// The name must be exactly what `typst fonts --font-path ./fonts --variants` reports —
// families with an optical-size axis are often called e.g. "Newsreader 16pt".
// Two faces must differ in structure, not only in name. See reference/fonts.md.
#let font-text = "CHOOSE-ME" //                     why: <…>
#let font-display = "CHOOSE-ME" //                  why: <…>
#let font-mono = "CHOOSE-ME" //                     why: <…>

// --- 5. Size scale ---------------------------------------------------------
// Print scales are tighter than screen scales; the reader is 35 cm away, not 60.
// At most three sizes inside the text area of a page — separate the rest by weight,
// case, position and space.
#let size = (
  small: 8.5pt, //                                  why: <…>  captions, margin notes
  body: body-size, //                               why: <…>
  h3: 10.5pt, //                                    why: <…>  same size as body, other voice
  h2: 13pt, //                                      why: <…>
  h1: 17pt, //                                      why: <…>
  title: 30pt, //                                   why: <…>
)

// --- 6. Ink ----------------------------------------------------------------
// Colour on paper is ink, not light. One colour beyond black is enough, and it does
// exactly one job. Body text stays near-black — grey body text looks soft on a screen
// and thin on paper.
#let ink = (
  text: rgb("#1a1a1a"), //                          why: <…>
  soft: rgb("#6b6560"), //                          why: <…>  margin notes only
  rule: rgb("#c9c3ba"), //                          why: <…>  hairlines, table rules
  accent: rgb("#7a2f1e"), //                        why: <…>  ONE job: section numbers
)

// --- 7. Detail decisions ---------------------------------------------------
#let justify = true //                              why: <…>  only with hyphenation and ≥60 chars
#let lang = "de" //                                 why: <…>  drives hyphenation and quotes
#let first-line-indent = 0pt //                     why: <…>  indent OR space between paragraphs, never both
#let rule-weight = 0.5pt //                         why: <…>
#let heading-numbering = "1.1" //                   why: <…>  none for a document that is read, numbers for one that is referred to
#let show-baseline-grid = false //                  set true, render, and check that the baselines sit on it

// --- 8. Gate ---------------------------------------------------------------
// Set to true only after every value above is yours and every `why:` is filled in.
#let design-decided = false
