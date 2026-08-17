# Anti-patterns — what gives a machine-made document away

29 rules. Each one is **checkable**: on the rendered page image, in the extracted text,
or with a number. Run them after the first render and again after the fix round.

How to read the columns: **Check** is what you measure or look for. **Fix** is the change,
not a discussion. Severity: `slop` = it makes the document look generated; `quality` = it
makes the document worse to read.

The idea of a numbered, machine-checkable catalogue is taken from `pbakaus/impeccable`
(Apache-2.0, 60 rules for screen UI). Nothing is copied: those rules are about hover
states, gradients, cards and motion. These are about a fixed page.

---

## Typography

| # | Rule | Check | Fix | Sev |
|---|---|---|---|---|
| T1 | `full-width-body` — body type across the full page width | characters per line > 78 | narrow the measure or raise the size (`typesetting.md` §1) | slop |
| T2 | `default-face` — the document is set in the system default (Calibri, Arial, Times, Helvetica) or in a fallback | **docrender** (font fallback/embedding, `high`); or `scripts/check-fonts.sh` | choose and self-host a face | slop |
| T3 | `size-only-hierarchy` — levels differ only by getting bigger | count distinct sizes in the text area of one page; > 3 | carry a level by weight, case, colour, position or space instead | slop |
| T4 | `grey-body` — body text lighter than ~#404040 | **docrender** (tile contrast vs `--min-contrast`); read the fill from the token file | near-black body; use grey only for subordinate text | quality |
| T5 | `everything-bold` — bold as the general emphasis tool | more than ~3 bold runs per page outside headings | italic for emphasis in running text; bold only for structure | quality |
| T6 | `underline-emphasis` — underlined words in body text | any underline that is not a link | italic or weight | slop |
| T7 | `twin-faces` — two faces of the same species (two humanist sans) | set both at 12 pt, same word: can you tell them apart in one look? | replace one, or drop to a single family with more weights | quality |
| T8 | `river-justify` — justified text below ~55 characters, or hyphenation off | measure + `lang` set? | ragged right, or widen the measure, or switch hyphenation on | quality |
| T9 | `hyphenated-title` — a title or heading broken across lines with a hyphen | look at the page | `hyphenate: false` on headings and titles | slop |
| T10 | `caps-abuse` — long stretches in capitals or letterspaced caps | > 5 words in caps outside a label | sentence case; caps only for short labels | quality |
| T11 | `size-drift` — one page whose body size differs from the rest of the document | **docrender** (font-size consistency). Judge it: the check counts text runs, not characters, so a page of body text can be flagged against pages full of table rows | set the deviating page back to the document's body size, or dismiss with a reason | quality |

## Page and grid

| # | Rule | Check | Fix | Sev |
|---|---|---|---|---|
| P1 | `off-grid-spacing` — vertical distances that are not multiples of the unit | switch on the baseline overlay and look | express every distance as `u(n)` | quality |
| P2 | `orphan-heading` — a heading in the bottom 15 % of a page | **docrender** (orphan headings) | `show heading: set block(sticky: true)` | quality |
| P3 | `stranded-line` — a single line of a paragraph alone on a page (widow/orphan) | look at page tops and bottoms — **[verified]** Typst 0.15 has no `orphans`/`widows` property to check for you, unlike CSS's `orphans: 3; widows: 3`; this row is the entire defence, not a backstop | `par(linebreaks: "optimized")`, or edit the sentence | quality |
| P4 | `identical-density` — every page filled to exactly the same depth, no breathing | flip through the page images | let sections open and close; use sinkage | quality |
| P5 | `no-folios` — a document of more than four pages without page numbers | **docrender** (footer/page-number consistency) catches pages that lost one; that none exist at all is your eye | add folios; running head for the section | quality |
| P6 | `logo-tax` — the logo repeated on every page | count | first page only | slop |
| P7 | `centre-everything` — headings, body and captions all centred | look | one alignment axis; centre only for genre 5 (Anlass) | slop |
| P8 | `edge-margins` — anything closer than 15 mm to the trim, or under 18 mm on a bound edge | **docrender** (`--min-margin-mm`, default 18; content touching the trim is `high`). Note it measures the whole content box: a running head raised into the top margin counts | widen the margin, or lower the header ascent | quality |
| P9 | `rule-clutter` — a horizontal rule between every section | count rules per page > 2 | space instead of lines | slop |

## Colour and ink

| # | Rule | Check | Fix | Sev |
|---|---|---|---|---|
| C1 | `gradient-cover` — the cover is a colour gradient with a centred title | look at page 1 | a cover carries a fact: an image, a number, a date, a mark | slop |
| C2 | `accent-everywhere` — the accent colour used for more than one job | list its uses; > 1 | give it exactly one job | slop |
| C3 | `colour-only-signal` — meaning carried by colour alone | convert a page to greyscale and read it | add a label, a weight or a position difference | quality |
| C4 | `dark-page` — a dark background on a document meant for paper | look | light background; keep dark for screen-only decks, and say so | quality |

## Tables and numbers

| # | Rule | Check | Fix | Sev |
|---|---|---|---|---|
| N1 | `table-cage` — vertical rules or a full grid | any vertical rule in a data table | horizontal rules only, head and foot | slop |
| N2 | `proportional-figures` — figures in a number column that do not align | look at the column edge | tabular lining figures | quality |
| N3 | `unit-per-cell` — the unit repeated in every cell | look | unit in the column head | quality |
| N4 | `table-overflow` — a table wider than the measure, or split across pages losing its head | **docrender `--vision`** only (deliberately not mechanical); otherwise the page image | narrow the columns, rotate, or repeat the head | quality |
| N5 | `unbreakable-table-past-one-page` — a table wrapped in `figure()` (or a `block(breakable: false)`, what `dtable()` uses) that turns out to need more than one page | **[verified]** neither construct can break across pages, and Typst does not warn: a 30-row table in `figure()` on a too-short page compiled at exit 0 with one page, rows silently gone past the edge — the page image is the only check | never wrap a table that could grow in `figure()`/an unbreakable block; build it as a bare `table(..., table.header(...))`, which breaks correctly and repeats the head (see `typesetting.md` §7) | slop |

## Content shape

| # | Rule | Check | Fix | Sev |
|---|---|---|---|---|
| S1 | `bullets-instead-of-sentences` — a list whose items are full sentences, or a list of two | items > 12 words, or item count ≤ 2 | write the paragraph | slop |
| S2 | `three-equal-boxes` — a row of three same-sized boxes with icon + heading + two lines | look | one shape carrying the actual difference in the content | slop |
| S3 | `caption-restates` — the caption repeats the heading or names the object | compare caption and nearest heading | say what to see and why it is here | quality |
| S4 | `stock-abstract` — an abstract or generic image standing in for a missing thought | look at every image and ask what it shows | generate a specific image locally (`bild`), or drop it | slop |
| S5 | `emoji-in-document` — emoji anywhere in a document that leaves the house | grep the source | typographic marks (● ✓ ✕) or a drawn icon | slop |

---

## Running the catalogue

**First, the tool.** `docrender` does the mechanical half deterministically and reports
`{page, severity, issue, source_location, exact_fix}`:

```bash
DR="$(command -v docrender)"   # or the checkout's .venv/bin/docrender
"$DR" review build/report.pdf --expected-fonts "Fam1,Fam2" --json-out build/review.json
# exit 0 = clean, 1 = findings, 2 = the tool failed (run "$DR" tools)
```

It covers T2, T4, T11, P2, P5 (partly), P8, plus every Typst compiler warning; with
`--vision` also N4. Judge each finding rather than obeying it — two false-positive shapes
are known on good documents: a **photograph** trips the contrast check, and the
**size-consistency check counts text runs, not characters**.

**Then, what the tool does not do.** These stay manual until it learns them:

```bash
# T1 measure — the single most consequential number, and not checked by docrender
pdftotext build/report.pdf - | awk 'length($0)>40 {n++;s+=length($0)} END {print s/n}'
# C3 colour as the only signal
magick build/pages/page-2.png -colorspace Gray /tmp/gray.png
# S5 emoji
grep -nP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' src/*.typ
# T9 a heading broken with a hyphen: look for "-" at a line end in a heading-size run
```

**Then look at every page image.** T3, T5, T7, P1, P3, P4, P6, P7, P9, C1, C2, C4, N1, N2,
N3, N5, S1–S4 have no mechanical check anywhere. They are also the ones that decide whether
the document looks made or generated. N5 is the sharpest of these: content missing past a
page edge produces no compiler warning and no docrender finding — only the render shows it.

### Known gaps in `docrender` (reported upstream, not worked around here)

| Rule | Why it is mechanically checkable |
|---|---|
| T1 `full-width-body` | characters per line from `pdftotext`, one line of code, and it is the highest-value rule in this file |
| T9 `hyphenated-title` | a heading-size run ending in `-` at a line break, from the same `pdftohtml -xml` the tool already parses |
| S5 `emoji-in-document` | a regex over the extracted text |
| P3 `stranded-line` | a single body line at the top or bottom of a page — the same shape as the orphan-heading check |
| P1 `off-grid-spacing` | baseline pitch from `pdftohtml -xml`: are the y-positions a constant multiple? |
