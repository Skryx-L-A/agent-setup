# Typesetting — starting values you can work from

Numbers, not principles. Every value here is a defensible **starting point** for a first
render; the render then corrects it. Nothing here is a house style, and a document that
ships with all of these values unchanged has not been designed.

Measured facts about the tooling (Typst 0.15.1, verified in this project) are marked
**[verified]**.

---

## 0. Print is not screen — the seven differences that change the numbers

1. **The frame is fixed.** Nothing reflows. Overflow is not a scrollbar, it is a defect.
   The measure is not a preference, it is the design.
2. **No hover, no focus, no tooltip.** Every level of hierarchy has to be visible at
   once, statically.
3. **Higher resolution.** 0.3 pt hairlines, 8.5 pt captions, small caps and old-style
   figures work on paper and fall apart on a 96 dpi screen. Print can be finer.
4. **Reflected light, not emitted.** Grey body text does not look "soft", it looks thin.
   Dark backgrounds cost ink, curl the paper and lower legibility.
5. **Two sides and a gutter.** The unit of design is the spread, not the page; margins
   are asymmetric; the binding eats 5–10 mm.
6. **No responsive fallback, ever.** The line length you set is the line length every
   reader gets, forever.
7. **Rhythm replaces animation.** What holds a document together is repetition across
   pages: same grid, same positions, same distances.

---

## 1. Measure — characters per line

The single most consequential number. Target **60–72 characters** for continuous text,
**45–60** for a narrow column, **35–45** for a margin note.

Rough starting width for ~65 characters: `column width in mm ≈ point size × 9`.

| Body size | Column width | Expect roughly |
|---|---|---|
| 9 pt | 78–88 mm | 62–70 characters |
| 10 pt | 86–98 mm | 62–70 characters |
| 10.5 pt | 92–105 mm | 62–70 characters |
| 11 pt | 96–112 mm | 62–70 characters |
| 12 pt | 105–122 mm | 62–70 characters |

The factor depends on the alphabet width of the actual face, so **count in the render**:

```bash
pdftotext build/report.pdf - | awk 'length($0)>40 {n++; s+=length($0)} END {print s/n}'
```

Beware: `pdftotext` merges a body line and a margin note that share a baseline into one
line, which inflates the average. Check a page without notes, or read the number off a
page image.

A4 at 11 pt across the full width between 25 mm margins is **95–100 characters**. That
single decision is the most common reason a document looks machine-made.

## 2. Margins and the type area

Starting values for single-sided A4 (210 × 297 mm):

- top 22–28 mm, bottom 28–36 mm (**bottom larger than top**, or the block sags),
- left 22–28 mm, right whatever the measure leaves.

Double-sided: mirror them and add the binding allowance — inner 22–28 mm **plus** 5–10 mm
if it is stapled or perfect-bound, outer 25–45 mm.

Two useful shapes beyond the symmetric block:

- **Wide outer margin** (as in `templates/report`): text 105 mm, gutter 8 mm, note column
  42 mm. The margin becomes a working column for notes, captions and sources instead of
  dead space.
- **Sinkage:** chapter openings start 8–12 lines lower than an ordinary page. Costs one
  page per chapter, and is the cheapest way a document reads as typeset rather than
  generated.

Absolute floor for anything that will be printed: **15 mm on every side**, more on the
binding edge. Home and office printers clip below ~10 mm.

## 3. Vertical grid

- **Baseline distance** = body size × **1.35–1.45** for a serif text face in print
  (tighter than the 1.5–1.6 that is right on screen). 10.5 pt → 14–15 pt.
- Keep a **finer unit** that divides the line: line 15 pt = 3 × 5 pt. Headings then use
  4 units (20 pt) or 8 units, and the text after them still lands on the grid.
- Every vertical distance — space above/below headings, figure heights, table row
  heights, space before a list — is a whole multiple of the unit. Not "about".

**[verified]** Typst's default line height is ascender + descender of the *specific font*,
so a grid built on `leading` alone drifts as soon as the family changes. Pinning the line
box makes it deterministic:

```typst
#set text(size: 10.5pt, top-edge: 0.75em, bottom-edge: -0.25em)
#set par(leading: 15pt - 10.5pt)   // baseline distance = size + leading = 15pt
```

Check it by rendering with a hairline on every baseline (`show-baseline-grid` in the
report template) and looking at the page.

## 4. Size scale

Print scales are **tighter** than screen scales: ratio **1.20–1.28**, not 1.5.

Starting scale at 10.5 pt body: 8.5 / 10.5 / 13 / 17 / (30 on the title page).

Rules that matter more than the ratio:

- **At most three sizes inside the text area of one page.** The title page is a separate
  room and may hold a fourth.
- Separate levels by **weight, case, position and space** before reaching for size. A
  level-3 heading at body size in the other face, letterspaced, reads as a level without
  taking any room.
- Nothing below **7.5 pt** on paper; 8.5–9 pt is the practical floor for captions.
- Projection is the opposite: **18 pt is the floor**, 22–28 pt is normal body size on a
  16:9 slide.

## 5. Type pairing

See `fonts.md` for licensing, fetching and the method. For the layout the relevant part
is: **the second face must differ in structure** (stress, aperture, skeleton), not only
in name, and one variable family with a wide weight/width range often beats two families.

## 6. Colour — ink, not light

- **One colour beyond black is enough**, and it does exactly **one job** (the section
  numbers, or the rules, or the folios — not all three). A colour with five jobs reads as
  decoration.
- Body text stays near-black: `#1a1a1a`, not `#555`. Grey body text is a screen habit.
- Rules and hairlines: 15–25 % grey. Table rules never at full strength except the head
  and foot rule.
- Fills behind table rows: max 6 % grey, and only above ~8 rows.
- Everything must survive **greyscale**: many documents are photocopied or printed on a
  mono printer. Convert and look: `magick page-1.png -colorspace Gray gray.png`.
- Contrast floor 4.5:1 for body text, 3:1 for large text — same numbers as the web, but
  measured against paper white, not screen white.

## 7. Tables

- **No vertical rules. No full grid.** Horizontal rules only: one above the head
  (0.5–1 pt), one hairline under the head (0.3 pt), one under the last row.
- Columns separated by **space** (5–8 mm), rows by **space** (3–5 pt inset), not by lines.
- Numbers right-aligned with **tabular lining figures**; text left-aligned; no centring
  of anything that is compared.
- Units in the **column head**, not repeated in every cell.
- Tables in the smaller size (8.5–9 pt) and in the display face — a table is scanned, not
  read.
- Never let a table split unless it is long enough to need a repeated head; keep small
  ones in an unbreakable block.

```typst
table(stroke: none, ..., table.hline(stroke: 0.5pt), table.header(...),
      table.hline(stroke: 0.3pt), ..rows, table.hline(stroke: 0.5pt))
```

**[verified, 2026-07-29]** This is not a style choice, it is the only safe option for a
table that might grow: `figure()` cannot break across pages, and neither can a
`block(breakable: false)` (what this skill's own `dtable()` uses for small tables).
A table long enough to need two pages does not error inside either — it silently
loses every row past the page edge, with `typst compile` exiting 0. Measured: a
30-row table wrapped in `figure()` on a page too short for it compiled clean at one
page, rows gone; the same rows as a bare `table(...)` with `table.header(...)`,
never wrapped in `figure()`, broke correctly across 5 pages with the head repeated.
Decide at the tokens stage whether a table could ever exceed one page — if yes, it
must be built breakable from the start; `reference/antipatterns.md` N4.

## 8. Figures

- Effective resolution ≥ **150 dpi at print size** (300 dpi for photographic work):
  `pixel width ≥ printed width in mm / 25.4 × 150`. A 1280 px image may be 216 mm wide at
  150 dpi and no wider.
- The **caption keeps the text measure** even under a wide figure. A caption across
  160 mm is 110 characters long, however small the type.
- A caption says **what to see and why it is here**. If it restates the heading, delete it.
- Sources belong in the caption or the margin, in the soft ink, never in the image.
- Figures are generated locally (`bild`) or drawn as SVG. No stock photography, no
  placeholders, and no "abstract technology" image standing in for a missing thought.

## 9. Paragraphs, hyphenation, justification

- **Either** an indent (4–6 mm) **or** a blank line between paragraphs. Never both.
- Justify only with hyphenation on **and** ≥ 60 characters; otherwise ragged right.
  Below 55 characters justification tears rivers.
- German needs `lang: "de"` for correct hyphenation and quotes; type straight `"` in the
  source and let the engine make „ … ".
- No heading in the **bottom 15 %** of a page (Typst: `show heading: set block(sticky: true)`).
- No single line of a paragraph alone on a page; `par(linebreaks: "optimized")` helps.
  **[verified, 2026-07-29]** Typst 0.15 has no `orphans`/`widows` property at all —
  unlike CSS's `orphans: 3; widows: 3`, there is no way to even declare the rule, so
  `linebreaks: "optimized"` plus looking at every page top/bottom is the whole
  defence, not a backstop to an engine feature; `reference/antipatterns.md` P3.
- Headings are never hyphenated and never justified.

## 10. Page furniture

- Folios where the thumb is: bottom outer or top outer. A folio in the middle of the
  bottom margin is fine and invisible; that is its job.
- Running heads carry the **section**, not the document title — the reader knows which
  document they are holding.
- No header on the title page and on chapter openings.
- A logo belongs on the first page, not on all of them.
- Documents that go outside the house carry date and version. A document without a date
  is unusable within a month.
