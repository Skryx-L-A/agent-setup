// tokens.typ — the design decisions for THIS deck. Nothing else belongs here.
//
// Before anything below: decide which of the two documents you are making. A deck read
// from a chair four metres away and a deck read alone in a mail attachment are not the
// same artefact, and no set of values serves both. Write the answer here:
//
//   Purpose: <talk support | leave-behind | both, and which one wins>
//
// Then work top to bottom, replace every value, write the reason on each `why:` line,
// and set `design-decided = true` at the bottom. The shipped numbers are a working
// example, not a house style — a second deck built on them is a copy and reads like one.

// --- 1. Surface ------------------------------------------------------------
#let aspect-ratio = "16-9" //                       why: <…>  4-3 still exists in lecture halls
#let margin = (x: 30mm, y: 22mm) //                 why: <…>  projector overscan eats the outer 3–5 %

// --- 2. Vertical grid ------------------------------------------------------
#let unit = 8pt //                                  why: <…>
#let line-height = 32pt //                          why: <…>  4 units

// --- 3. Type ---------------------------------------------------------------
// Projection is the opposite of print: the viewer is metres away, the surface is
// emissive, and the room may be lit. Body text below ~18pt on a 16-9 slide is unreadable
// from the back row; hairlines and 8pt captions from a report disappear entirely.
#let body-size = 22pt //                            why: <…>
#let size = (
  small: 15pt, //                                   why: <…>  sources, units, footnotes
  body: body-size, //                               why: <…>
  h2: 30pt, //                                      why: <…>  slide headline
  h1: 44pt, //                                      why: <…>  section opener
  title: 54pt, //                                   why: <…>
)

// --- 4. Fonts --------------------------------------------------------------
// Same rules as a printed document: self-hosted, libre-licensed, license file in the
// project, exact family name from `typst fonts --font-path ./fonts --variants`.
// One difference that matters: a face with delicate hairlines loses them on a projector.
#let font-text = "CHOOSE-ME" //                     why: <…>
#let font-display = "CHOOSE-ME" //                  why: <…>

// --- 5. Ink ----------------------------------------------------------------
// Light, not ink: a dark slide in a bright room fails, a bright slide in a dark room
// dazzles. Decide which room this deck runs in before choosing the background.
#let ink = (
  bg: rgb("#faf8f5"), //                            why: <…>
  text: rgb("#1a1a1a"), //                          why: <…>
  soft: rgb("#6b6560"), //                          why: <…>
  accent: rgb("#7a2f1e"), //                        why: <…>  ONE job
)

// --- 6. Furniture ----------------------------------------------------------
#let show-slide-numbers = true //                   why: <…>  needed for questions ("on slide 12 …")
#let show-running-title = false //                  why: <…>  a title on every slide is a watermark, not navigation
#let lang = "de" //                                 why: <…>

// --- 7. Gate ---------------------------------------------------------------
#let design-decided = false
